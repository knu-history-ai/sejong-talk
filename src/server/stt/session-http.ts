import "server-only";

import type { NextRequest } from "next/server";
import type { CancelledResponse, CompletedTranscription, ErrorResponse } from "../../contracts";
import { getSessionHttpConfig, requireSession, sessionErrorResponse } from "../sessions/http";
import { isSessionError, SessionError, type SessionHandle, type SessionStore } from "../sessions/store";
import { readAudio } from "./http";
import { selectedProvider, transcribe } from "./index";

const MAX_SESSION_REQUESTS = 30;
const JOB_TTL_MS = 60_000;
const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "private, no-store" },
});
const failed = (requestId: string | null, code: ErrorResponse["code"], message: string, retryable: boolean, status: number) =>
  json({ status: "failed", code, message, retryable, requestId } satisfies ErrorResponse, status);

/** Only the audio hash and the final text response are retained. Never the audio. */
interface TranscriptionJob {
  hash: string;
  expires: number;
  response: Promise<Response>;
}

export type TranscribeFn = typeof transcribe;

/**
 * W03-04: session-owned STT for the service screen.
 * - Requires the same session cookie and origin as turns/speech.
 * - Session reset/expiry aborts the provider call and discards late results.
 * - Raw audio lives only in this request's memory and is never written to disk,
 *   logs, the job registry or the response.
 */
export class TranscriptionHttp {
  private readonly jobs = new WeakMap<AbortSignal, Map<string, TranscriptionJob>>();

  constructor(
    private readonly sessions: SessionStore,
    private readonly run: TranscribeFn = transcribe,
  ) {}

  async post(request: NextRequest): Promise<Response> {
    let requestId: string | null = null;
    try {
      const session = requireSession(request, this.sessions, getSessionHttpConfig(request));
      const provider = selectedProvider();
      if (!provider) return failed(null, "UNAVAILABLE", "음성 인식 설정을 확인하고 있어요. 지금은 글로 질문해 주세요.", false, 503);
      let input: Awaited<ReturnType<typeof readAudio>>;
      try { input = await readAudio(request); }
      catch (error) {
        // readAudio messages are fixed Korean strings written for users; no upstream detail.
        const message = error instanceof Error ? error.message : "올바른 음성 업로드 요청이 아니에요.";
        const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 400;
        return failed(null, status === 415 ? "AUDIO_UNSUPPORTED" : "INVALID_INPUT", message, false, status);
      }
      requestId = input.requestId;
      session.assertActive();
      const jobs = this.sessionJobs(session);
      const now = Date.now();
      for (const [key, job] of jobs) if (job.expires < now) jobs.delete(key);
      const prior = jobs.get(input.requestId);
      if (prior) {
        if (prior.hash !== input.hash) throw new SessionError("REQUEST_CONFLICT", 409, "같은 요청 번호에 다른 음성이 들어왔어요.");
        const response = await prior.response;
        session.assertActive();
        return response.clone();
      }
      if (jobs.size >= MAX_SESSION_REQUESTS) throw new SessionError("LIMIT_EXCEEDED", 429, "음성 질문 요청이 많아요. 잠시 후 다시 시도해 주세요.");
      // The closure owns the only server reference to the audio; it is released when the call settles.
      let audio: File | undefined = input.audio;
      const signal = AbortSignal.any([request.signal, session.signal]);
      const response = (async () => {
        try {
          const result = await this.run(provider, audio!, signal);
          session.assertActive();
          if (result.success) {
            return json({ requestId: input.requestId, operation: "transcription", status: "completed", text: result.text } satisfies CompletedTranscription);
          }
          if (signal.aborted) return json({ requestId: input.requestId, operation: "transcription", status: "cancelled" } satisfies CancelledResponse<"transcription">);
          const code = result.code ?? "UNAVAILABLE";
          return failed(input.requestId, code, result.error ?? "음성을 글로 바꾸지 못했어요.", result.retryable ?? code !== "LIMIT_EXCEEDED",
            code === "LIMIT_EXCEEDED" ? 429 : result.code === "UNAVAILABLE" ? 503 : 502);
        } catch (error) {
          if (isSessionError(error)) return sessionErrorResponse(error, input.requestId);
          return failed(input.requestId, "UNAVAILABLE", "음성을 글로 바꾸지 못했어요. 다시 녹음하거나 글로 질문해 주세요.", true, 502);
        } finally {
          audio = undefined;
        }
      })();
      jobs.set(input.requestId, { hash: input.hash, expires: now + JOB_TTL_MS, response });
      const result = await response;
      session.assertActive();
      return result.clone();
    } catch (error) {
      if (isSessionError(error)) return sessionErrorResponse(error, requestId);
      return failed(requestId, "UNAVAILABLE", "요청을 처리하지 못했어요.", true, 500);
    }
  }

  private sessionJobs(session: SessionHandle): Map<string, TranscriptionJob> {
    let jobs = this.jobs.get(session.signal);
    if (!jobs) {
      const created = new Map<string, TranscriptionJob>();
      jobs = created;
      this.jobs.set(session.signal, created);
      session.signal.addEventListener("abort", () => {
        created.clear();
        this.jobs.delete(session.signal);
      }, { once: true });
    }
    return jobs;
  }
}
