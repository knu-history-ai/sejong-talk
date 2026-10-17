import "server-only";

import type { NextRequest } from "next/server";
import type { CompletedSpeech, ErrorResponse, SpeechRequest } from "../../contracts";
import {
  getSessionHttpConfig,
  requireSession,
  sessionErrorResponse,
} from "../sessions/http";
import { isSessionError, SessionError, type SessionHandle, type SessionStore } from "../sessions/store";
import { ApprovedSpeechNotFoundError, ApprovedSpeechStore } from "./approved-speech";
import { toSpeechErrorResponse } from "./azure-request";

const MAX_BODY_BYTES = 1024;
const MAX_SESSION_REQUESTS = 100;
const VALID_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "private, no-store" },
});

async function readSpeechRequest(request: Request): Promise<SpeechRequest> {
  const invalid = () => new SessionError("INVALID_INPUT", 400, "음성 요청의 답변 번호와 요청 번호를 확인해 주세요.");
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw invalid();
  }
  const reader = request.body?.getReader();
  if (!reader) throw invalid();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw invalid();
      }
      chunks.push(value);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).length !== 2 ||
        typeof input.requestId !== "string" || !VALID_ID.test(input.requestId) ||
        typeof input.answerId !== "string" || !VALID_ID.test(input.answerId)) {
      throw invalid();
    }
    return { requestId: input.requestId, answerId: input.answerId };
  } catch {
    throw invalid();
  } finally {
    reader.releaseLock();
  }
}

function errorResponse(error: unknown, requestId: string | null): Response {
  if (isSessionError(error)) return sessionErrorResponse(error, requestId);
  if (error instanceof ApprovedSpeechNotFoundError) {
    return json({ status: "failed", code: error.code, message: error.message,
      retryable: false, requestId } satisfies ErrorResponse, 404);
  }
  const body = { ...toSpeechErrorResponse(error, requestId ?? ""), requestId };
  const status = { LIMIT_EXCEEDED: 429, UPSTREAM_TIMEOUT: 504, UNAVAILABLE: 503 };
  return json(body, status[body.code as keyof typeof status] ?? 503);
}

interface SpeechJob {
  answerId: string;
  response: Promise<Response>;
}

/** Immediate completion API; shared request-status/cancellation integration is separate. */
export class SpeechHttp {
  private readonly jobs = new WeakMap<AbortSignal, Map<string, SpeechJob>>();

  constructor(
    private readonly sessions: SessionStore,
    private readonly speech = new ApprovedSpeechStore(),
  ) {}

  async post(request: NextRequest): Promise<Response> {
    let requestId: string | null = null;
    try {
      const session = requireSession(request, this.sessions, getSessionHttpConfig(request));
      const input = await readSpeechRequest(request);
      requestId = input.requestId;
      session.assertActive();
      let jobs = this.jobs.get(session.signal);
      if (!jobs) {
        jobs = new Map();
        const sessionJobs = jobs;
        this.jobs.set(session.signal, jobs);
        session.signal.addEventListener("abort", () => {
          sessionJobs.clear();
          this.jobs.delete(session.signal);
        }, { once: true });
      }
      let job = jobs.get(requestId);
      if (job && job.answerId !== input.answerId) {
        throw new SessionError("REQUEST_CONFLICT", 409, "같은 요청 번호로 다른 답변의 음성을 생성할 수 없습니다.");
      }
      if (!job) {
        if (jobs.size >= MAX_SESSION_REQUESTS) {
          throw new SessionError("LIMIT_EXCEEDED", 429, "현재 대화의 음성 요청 한도에 도달했습니다.");
        }
        job = {
          answerId: input.answerId,
          response: this.complete(session, input).catch((error) => errorResponse(error, requestId)),
        };
        jobs.set(requestId, job);
      }
      const response = await job.response;
      session.assertActive();
      return response.clone();
    } catch (error) {
      return errorResponse(error, requestId);
    }
  }

  private async complete(session: SessionHandle, input: SpeechRequest): Promise<Response> {
    const audio = await this.speech.getOrCreate(session, input.answerId);
    const snapshot = session.assertActive();
    return json({
      requestId: input.requestId, operation: "speech", status: "completed",
      answerId: input.answerId,
      audio: {
        url: `/api/speech/audio/${encodeURIComponent(input.answerId)}`,
        mimeType: audio.mimeType,
        expiresAt: new Date(snapshot.expiresAt).toISOString(),
      },
    } satisfies CompletedSpeech);
  }

  getAudio(request: NextRequest, answerId: string): Response {
    try {
      const session = requireSession(request, this.sessions, getSessionHttpConfig(request), { touch: false });
      if (!VALID_ID.test(answerId)) throw new ApprovedSpeechNotFoundError();
      const audio = this.speech.getAudio(session, answerId);
      if (!audio) throw new ApprovedSpeechNotFoundError();
      session.assertActive();
      return new Response(Buffer.from(audio.audio), {
        headers: { "Content-Type": audio.mimeType, "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff" },
      });
    } catch (error) {
      return errorResponse(error, null);
    }
  }
}
