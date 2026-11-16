import "server-only";
import { randomUUID } from "node:crypto";

export interface PocTiming {
  requestId: string;
  stage: "stt" | "llm" | "validation" | "tts";
  status: "completed" | "failed" | "cancelled" | "timeout";
  inputAt: string;
  outputAt: string | null;
  durationMs: number | null;
  headersReceivedAt?: string | null;
  firstBodyByteAt?: string | null;
  headersLatencyMs?: number | null;
  firstBodyByteLatencyMs?: number | null;
  bodyDownloadMs?: number | null;
  httpStatus?: number | null;
  xRegion?: string | null;
  regionStatus?: "reported" | "not-reported" | "no-response";
}

export interface PocClock { iso(): string; monotonic(): number }
const clock: PocClock = { iso: () => new Date().toISOString(), monotonic: () => performance.now() };
const BILL_VOICE_ID = "pqHfZKP75CvOlQylNhV4";

// The caller can use the same requestId for existing STT/LLM/validation stages.
// Only timestamps and stage/status are collected; inputs and outputs are never logged.
export async function measurePocStage<T>(
  requestId: string, stage: PocTiming["stage"], work: () => Promise<T>,
  record: (timing: PocTiming) => void, timer: PocClock = clock,
): Promise<T> {
  const started = timer.monotonic();
  const timing: PocTiming = { requestId, stage, status: "failed", inputAt: timer.iso(), outputAt: null, durationMs: null };
  try {
    const result = await work();
    timing.status = "completed";
    return result;
  } catch (error) {
    timing.status = error instanceof Error && error.name === "AbortError" ? "cancelled"
      : error instanceof Error && error.name === "TimeoutError" ? "timeout" : "failed";
    throw error;
  } finally {
    timing.outputAt = timer.iso();
    timing.durationMs = timer.monotonic() - started;
    record(timing);
  }
}

export function koreanPocSpeechRequest(text: string, env: NodeJS.ProcessEnv = process.env) {
  const key = env.ELEVENLABS_API_KEY?.trim();
  const voiceId = env.ELEVENLABS_VOICE_ID?.trim() || BILL_VOICE_ID;
  if (!key) throw new Error("ELEVENLABS_API_KEY 설정이 필요합니다.");
  // multilingual_v2 does not support language_code; use a Korean-capable model that does.
  const model = env.ELEVENLABS_POC_TTS_MODEL?.trim() || "eleven_flash_v2_5";
  if (!["eleven_flash_v2_5", "eleven_turbo_v2_5"].includes(model)) {
    throw new Error("PoC 한국어 고정은 eleven_flash_v2_5 또는 eleven_turbo_v2_5를 사용합니다.");
  }
  if (!text.trim() || text.length > 400) throw new Error("PoC 문장은 1~400자로 지정합니다.");
  return {
    url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`,
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: { text, model_id: model, language_code: "ko", voice_settings: {
      stability: 0.65, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true, speed: 0.95,
    } },
    model,
    voiceId,
  };
}

export class PocSpeechError extends Error {
  readonly timing: PocTiming;

  constructor(timing: PocTiming) {
    super("PoC 음성 요청에 실패했습니다. timing의 상태·HTTP 코드를 확인해 주세요.");
    this.name = "PocSpeechError";
    this.timing = timing;
  }
}

export async function requestKoreanPocSpeech(text: string, options: {
  env?: NodeJS.ProcessEnv; requestId?: string; signal?: AbortSignal;
  fetchImpl?: typeof fetch; timer?: PocClock;
} = {}) {
  const request = koreanPocSpeechRequest(text, options.env);
  const timer = options.timer ?? clock;
  const started = timer.monotonic();
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const timing: PocTiming = { requestId: options.requestId ?? randomUUID(), stage: "tts", status: "failed",
    inputAt: timer.iso(), outputAt: null, durationMs: null,
    headersReceivedAt: null, firstBodyByteAt: null, headersLatencyMs: null,
    firstBodyByteLatencyMs: null, bodyDownloadMs: null, httpStatus: null, xRegion: null, regionStatus: "no-response" };
  let headersAt: number | null = null;
  try {
    signal.throwIfAborted();
    const response = await (options.fetchImpl ?? fetch)(request.url, {
      method: "POST", headers: request.headers, body: JSON.stringify(request.body),
      signal, redirect: "error", cache: "no-store",
    });
    headersAt = timer.monotonic();
    timing.headersReceivedAt = timer.iso();
    timing.headersLatencyMs = headersAt - started;
    timing.httpStatus = response.status;
    timing.xRegion = response.headers.get("x-region")?.trim() || null;
    timing.regionStatus = timing.xRegion ? "reported" : "not-reported";
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("upstream-failed");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        if (!value.byteLength) continue;
        if (timing.firstBodyByteLatencyMs === null) {
          timing.firstBodyByteAt = timer.iso();
          timing.firstBodyByteLatencyMs = timer.monotonic() - started;
        }
        bytes += value.byteLength;
        if (bytes > 10_000_000) { await reader.cancel(); throw new Error("audio-too-large"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    signal.throwIfAborted();
    if (!bytes) throw new Error("empty-audio");
    timing.status = "completed";
    return { audio: Buffer.concat(chunks), mimeType: "audio/mpeg", model: request.model, timing };
  } catch {
    timing.status = signal.aborted ? signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled" : "failed";
    throw new PocSpeechError(timing);
  } finally {
    const ended = timer.monotonic();
    timing.outputAt = timer.iso();
    timing.durationMs = ended - started;
    timing.bodyDownloadMs = headersAt === null ? null : ended - headersAt;
  }
}
