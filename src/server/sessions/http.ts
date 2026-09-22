import "server-only";
import { NextRequest, NextResponse } from "next/server.js";
import type { CreateSessionResponse, DeleteSessionResponse, ErrorResponse } from "../../contracts/index.ts";
import { SessionError, isSessionError, type SessionStore, type SessionHandle } from "./store.ts";

export interface SessionHttpConfig {
  origin: string;
  cookieName: string;
  secure: boolean;
}

function isLoopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function getSessionHttpConfig(request: Request): SessionHttpConfig {
  const configured = process.env.APP_ORIGIN;
  let url: URL;
  try {
    if (configured) {
      url = new URL(configured);
      if (configured !== url.origin) throw new Error("Use an origin without a path");
    } else {
      url = new URL(request.url);
      if (process.env.NODE_ENV === "production" || !isLoopback(url)) {
        throw new Error("APP_ORIGIN required");
      }
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
      throw new Error("HTTPS required outside localhost");
    }
  } catch {
    throw new SessionError("UNAVAILABLE", 503, "서버의 접속 주소 설정을 확인하고 있습니다. 잠시 후 다시 시도해 주세요.");
  }
  return {
    origin: url.origin,
    secure: url.protocol === "https:",
    cookieName: url.protocol === "https:" ? "__Host-sejong_session" : "sejong_session",
  };
}

export function checkSessionOrigin(request: Request, config: SessionHttpConfig): void {
  const origin = request.headers.get("origin");
  const isRead = request.method === "GET" || request.method === "HEAD";
  const fetchSite = request.headers.get("sec-fetch-site");
  if ((fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") ||
      (!isRead && origin !== config.origin) ||
      (isRead && origin !== null && origin !== config.origin)) {
    throw new SessionError("FORBIDDEN", 403, "허용된 서비스 화면에서 다시 시도해 주세요.");
  }
}

function readToken(request: NextRequest, config: SessionHttpConfig): string | undefined {
  return request.cookies.get(config.cookieName)?.value;
}

/** Reuse in AI/STT/TTS handlers. Polling and audio reads should pass touch: false. */
export function requireSession(
  request: NextRequest, store: SessionStore, config: SessionHttpConfig,
  { touch = true }: { touch?: boolean } = {},
) {
  checkSessionOrigin(request, config);
  return store.authenticate(readToken(request, config), touch);
}

export function sessionErrorResponse(error: unknown, requestId: string | null = null): NextResponse<ErrorResponse> {
  if (!isSessionError(error)) throw error;
  return NextResponse.json({
    status: "failed", code: error.code, message: error.message,
    retryable: error.code === "UNAVAILABLE", requestId,
  }, { status: error.httpStatus, headers: { "Cache-Control": "no-store" } });
}

function setCookie(
  response: NextResponse, config: SessionHttpConfig, token: string, clear = false,
): void {
  response.cookies.set(config.cookieName, token, {
    httpOnly: true, secure: config.secure, sameSite: "strict", path: "/",
    ...(clear ? { maxAge: 0, expires: new Date(0) } : {}),
  });
}

async function readCreationBody(request: Request): Promise<void> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new SessionError("INVALID_INPUT", 400, "JSON 형식의 시작 요청이 필요합니다.");
  }
  // Do not buffer an arbitrarily large or unbounded chunked request.
  const reader = request.body?.getReader();
  if (!reader) throw new SessionError("INVALID_INPUT", 400, "대화할 인물을 선택해 주세요.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) {
        void reader.cancel().catch(() => {});
        throw new Error("Body too large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !("characterId" in body) || body.characterId !== "sejong") {
      throw new Error("Only characterId: sejong is supported");
    }
  } catch {
    throw new SessionError("INVALID_INPUT", 400, "현재는 세종과의 대화만 시작할 수 있습니다. 요청 내용을 확인해 주세요.");
  } finally {
    reader.releaseLock();
  }
}

export async function createSessionResponse(
  request: NextRequest, store: SessionStore, config: SessionHttpConfig,
): Promise<NextResponse<CreateSessionResponse | ErrorResponse>> {
  try {
    checkSessionOrigin(request, config);
    const previousToken = readToken(request, config);
    let previousSession: SessionHandle | undefined;
    if (previousToken) {
      try {
        previousSession = store.authenticate(previousToken, false);
      } catch (error) {
        // A cookie that was already expired at arrival may start a fresh session.
        if (!isSessionError(error) || error.code !== "SESSION_EXPIRED") throw error;
      }
    }
    await readCreationBody(request);
    // Reading a streamed body yields. A concurrent reset/replacement must win
    // over this older request; do not resurrect it with a late Set-Cookie.
    previousSession?.assertActive();
    const { token, session } = store.create(previousToken);
    const response = NextResponse.json<CreateSessionResponse>({
      status: "created", sessionId: session.sessionId, characterId: session.characterId,
      expiresAt: new Date(session.expiresAt).toISOString(),
      intro: "반갑구나. 나 세종에게 궁금한 것을 물어보거라.",
      suggestedQuestions: ["훈민정음은 왜 만들었나요?", "백성을 위해 어떤 일을 했나요?"],
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
    setCookie(response, config, token);
    return response;
  } catch (error) {
    return sessionErrorResponse(error);
  }
}

export function deleteSessionResponse(
  request: NextRequest, store: SessionStore, config: SessionHttpConfig,
): NextResponse<DeleteSessionResponse | ErrorResponse> {
  try {
    checkSessionOrigin(request, config);
    // Idempotent reset: missing/expired cookies are already deleted.
    store.revoke(readToken(request, config));
    const response = NextResponse.json<DeleteSessionResponse>(
      { status: "deleted" }, { headers: { "Cache-Control": "no-store" } },
    );
    setCookie(response, config, "", true);
    return response;
  } catch (error) {
    return sessionErrorResponse(error);
  }
}
