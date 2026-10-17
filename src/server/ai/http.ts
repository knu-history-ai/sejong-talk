import "server-only";
import { NextRequest, NextResponse } from "next/server";
import type { ApprovedTurn, FailedRequest, RequestState, TurnRequest } from "../../contracts";
import { RequestCoordinator } from "../requests/index";
import { getSessionStore } from "../sessions/runtime";
import { getSessionHttpConfig, requireSession, sessionErrorResponse } from "../sessions/http";
import { SessionError, isSessionError, type SessionHandle } from "../sessions/store";
import { runCoordinatedSejongTurn, type GenerateSejongTurnOptions } from "./index";
import { isUsageError } from "../usage/ledger";

type Generate = (options: GenerateSejongTurnOptions) => Promise<ApprovedTurn | FailedRequest>;
type Entry = { coordinator: RequestCoordinator; busy: boolean; count: number };
const processState = globalThis as typeof globalThis & { sejongTurnRequests?: Map<string, Entry> };

function entryFor(session: SessionHandle): Entry {
  const entries = processState.sejongTurnRequests ??= new Map();
  const id = session.assertActive().sessionId;
  let entry = entries.get(id);
  if (!entry) {
    entry = { coordinator: new RequestCoordinator(), busy: false, count: 0 };
    entries.set(id, entry);
    session.signal.addEventListener("abort", () => entries.delete(id), { once: true });
  }
  return entry;
}

function json(state: RequestState) {
  const statuses = { INVALID_INPUT: 400, SESSION_EXPIRED: 401, FORBIDDEN: 403, REQUEST_NOT_FOUND: 404, REQUEST_CONFLICT: 409, LIMIT_EXCEEDED: 429, UPSTREAM_TIMEOUT: 504, UNAVAILABLE: 503, AUDIO_UNSUPPORTED: 415 };
  return NextResponse.json(state, { status: state.status === "failed" ? statuses[state.code] : 200, headers: { "Cache-Control": "no-store" } });
}

async function readTurn(request: Request): Promise<TurnRequest> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new SessionError("INVALID_INPUT", 400, "JSON 질문이 필요합니다.");
  const reader = request.body?.getReader();
  if (!reader) throw new SessionError("INVALID_INPUT", 400, "질문을 입력해 주세요.");
  let text = "";
  let size = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { void reader.cancel(); throw new Error(); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const body = JSON.parse(text);
    if (!body || Object.keys(body).sort().join(",") !== "requestId,text" ||
      typeof body.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.requestId) ||
      typeof body.text !== "string" || !body.text.trim() || body.text.length > 500) throw new Error();
    return { requestId: body.requestId, text: body.text.trim() };
  } catch {
    throw new SessionError("INVALID_INPUT", 400, "질문은 500자 이내로 입력해 주세요.");
  } finally { reader.releaseLock(); }
}

export async function handleTurn(request: NextRequest, generate?: Generate) {
  let requestId: string | null = null;
  try {
    const session = requireSession(request, getSessionStore(), getSessionHttpConfig(request));
    const turn = await readTurn(request);
    requestId = turn.requestId;
    session.assertActive();
    const entry = entryFor(session);
    if (!entry.coordinator.get(requestId)) {
      if (entry.count >= 100) return json({ requestId, operation: "turn", status: "failed", code: "LIMIT_EXCEEDED", message: "새 대화를 시작해 주세요.", retryable: false });
      entry.count++;
    }
    // Fingerprint only caller input: later history changes must not rerun duplicates.
    return json(await entry.coordinator.run({ requestId, operation: "turn", fingerprint: JSON.stringify(turn), timeoutMs: 25_000, signal: AbortSignal.any([session.signal, request.signal]) }, async (signal) => {
      if (entry.busy) return { requestId: turn.requestId, operation: "turn", status: "failed", code: "LIMIT_EXCEEDED", message: "진행 중인 답변이 끝난 뒤 다시 시도해 주세요.", retryable: true };
      entry.busy = true;
      try {
        const inner = new RequestCoordinator();
        return await runCoordinatedSejongTurn({
          coordinator: inner, request: turn, signal, generateTurn: generate,
          sessionId: session.assertActive().sessionId,
          recentConversation: session.getRecentTurns().map(({ userText, answer }) => ({ question: userText, answer })),
          isSessionActive: () => { try { session.assertActive(); return true; } catch { return false; } },
          onApprovedTurn: ({ answer }) => session.appendApprovedTurn({ userText: turn.text, answer }),
        });
      } finally { entry.busy = false; }
    }));
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error, requestId);
    if (isUsageError(error)) return NextResponse.json({ status: "failed", requestId, code: error.code, message: error.message, retryable: error.retryable }, { status: error.httpStatus, headers: { "Cache-Control": "no-store" } });
    return NextResponse.json({ status: "failed", requestId, code: "UNAVAILABLE", message: "답변 서비스를 사용할 수 없습니다. 잠시 뒤 다시 시도해 주세요.", retryable: true }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export function handleRequest(request: NextRequest, id: string, cancel = false) {
  try {
    const session = requireSession(request, getSessionStore(), getSessionHttpConfig(request), { touch: false });
    const entry = entryFor(session);
    const state = cancel ? entry.coordinator.cancel(id) : entry.coordinator.get(id);
    if (!state) return json({ requestId: id, operation: "turn", status: "failed", code: "REQUEST_NOT_FOUND", message: "요청을 찾을 수 없습니다.", retryable: false });
    return json(state);
  } catch (error) { return sessionErrorResponse(error, id); }
}
