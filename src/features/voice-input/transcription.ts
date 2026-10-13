import type { CapturedPcm, Transcribe } from "./recorder";
import { encodePcmWav, PCM_MAX_SAMPLES, PCM_RATE } from "./pcm-wav";
import { normalizeAudio } from "./normalize-audio";

/** Error with the server's contract code (e.g. SESSION_EXPIRED) for the recorder and chat screen. */
export class TranscriptionError extends Error {
  constructor(message: string, readonly code: string, readonly retryable: boolean) { super(message); }
}

/** Resamples live-captured PCM to 16kHz mono PCM16 WAV. Undefined if too short, silent or unusable. */
export function capturedPcmToWav(pcm: CapturedPcm | undefined): Blob | undefined {
  if (!pcm || !pcm.samples.length || !(pcm.sampleRate >= PCM_RATE)) return undefined;
  const { samples, sampleRate } = pcm;
  const ratio = sampleRate / PCM_RATE;
  const length = Math.min(Math.floor(samples.length / ratio), PCM_MAX_SAMPLES);
  if (length < PCM_RATE / 4) return undefined;
  const output = new Float32Array(length);
  let energy = 0;
  for (let i = 0; i < length; i++) {
    // Average over the source window: simple anti-aliasing for 48k/44.1k -> 16k.
    const start = Math.floor(i * ratio), end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end && j < samples.length; j++) sum += samples[j];
    output[i] = sum / (end - start);
    energy += output[i] * output[i];
  }
  if (!Number.isFinite(energy) || Math.sqrt(energy / length) < 0.001) return undefined;
  try { return new Blob([encodePcmWav(output)], { type: "audio/wav" }); } catch { return undefined; }
}

export function audioForm(blob: Blob) {
  const form = new FormData();
  form.set("audio", blob, blob.type === "audio/wav" ? "recording.wav" : "recording");
  form.set("requestId", crypto.randomUUID());
  return form;
}

export const serverTranscribe: Transcribe = async (recording, signal) => {
  // Prefer PCM captured live; decoding the compressed blob is the fallback (and the path for uploaded files).
  const wav = capturedPcmToWav(recording.pcm) ?? await normalizeAudio(recording.blob, signal, recording.durationMs);
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
