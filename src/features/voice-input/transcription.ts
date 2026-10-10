import type { Transcribe } from "./recorder";
import { normalizeAudio } from "./normalize-audio";

/** Error with the server's contract code (e.g. SESSION_EXPIRED) for the recorder and chat screen. */
export class TranscriptionError extends Error {
  constructor(message: string, readonly code: string, readonly retryable: boolean) { super(message); }
}

export function audioForm(blob: Blob) {
  const form = new FormData();
  form.set("audio", blob, blob.type === "audio/wav" ? "recording.wav" : "recording");
  form.set("requestId", crypto.randomUUID());
  return form;
}

export const serverTranscribe: Transcribe = async (recording, signal) => {
  const wav = await normalizeAudio(recording.blob, signal, recording.durationMs);
  signal.throwIfAborted();
  // Same-origin request: the session cookie is sent automatically. Do not set Content-Type.
  const response = await fetch("/api/transcriptions", { method: "POST", body: audioForm(wav), signal, credentials: "same-origin" });
  let result: { status?: string; text?: unknown; code?: unknown; message?: unknown; retryable?: unknown } = {};
  try { result = await response.json(); } catch { /* Fall through to a generic error. */ }
  if (response.ok && result.status === "completed" && typeof result.text === "string") return result.text;
  if (result.status === "cancelled") throw new TranscriptionError("음성 인식을 취소했어요.", "CANCELLED", true);
  const code = typeof result.code === "string" ? result.code : "TRANSCRIPTION_FAILED";
  const message = code === "SESSION_EXPIRED" ? "대화가 만료되었어요. 새 대화를 시작한 뒤 다시 녹음해 주세요."
    : typeof result.message === "string" ? result.message : "음성을 인식하지 못했어요.";
  throw new TranscriptionError(message, code, result.retryable === true);
};
