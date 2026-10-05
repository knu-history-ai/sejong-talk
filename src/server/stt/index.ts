import "server-only";
import { PROVIDERS, type SttProvider, type SttResult } from "@/features/voice-input/stt-types";
import { azure } from "./azure";
import { clova } from "./clova";
import { deepgram } from "./deepgram";
import { groq } from "./groq";
import { elevenlabs } from "./elevenlabs";
import { SttError } from "./common";
import { runMeteredCall } from "../usage/runtime.ts";
const adapters = { azure, clova, deepgram, groq, elevenlabs };
const models: Record<SttProvider, string> = {
  // These REST endpoints do not select or expose a named model version.
  azure: "provider-default",
  clova: "provider-default",
  deepgram: "nova-3",
  groq: "whisper-large-v3",
  elevenlabs: "scribe_v2",
};
type MeteredSttResult = SttResult & {
  code?: "LIMIT_EXCEEDED" | "UNAVAILABLE";
  retryable?: boolean;
};

async function audioMilliseconds(audio: File): Promise<number> {
  const fallback = 30_000;
  const buffer = await audio.arrayBuffer();
  if (buffer.byteLength < 44) return fallback;
  const view = new DataView(buffer);
  const ascii = (offset: number, length: number) => String.fromCharCode(...new Uint8Array(buffer, offset, length));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE" || view.getUint32(4, true) + 8 !== buffer.byteLength) return fallback;
  let byteRate = 0;
  let dataBytes = 0;
  for (let offset = 12; offset < buffer.byteLength;) {
    if (offset + 8 > buffer.byteLength) return fallback;
    const tag = ascii(offset, 4), size = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + size > buffer.byteLength) return fallback;
    if (tag === "fmt ") {
      if (byteRate || size < 16 || ![1, 3].includes(view.getUint16(start, true))) return fallback;
      const channels = view.getUint16(start + 2, true);
      const sampleRate = view.getUint32(start + 4, true);
      const blockAlign = view.getUint16(start + 12, true);
      const bitsPerSample = view.getUint16(start + 14, true);
      byteRate = view.getUint32(start + 8, true);
      if (!channels || !sampleRate || !bitsPerSample || blockAlign !== channels * bitsPerSample / 8 || byteRate !== sampleRate * blockAlign) return fallback;
    }
    if (tag === "data") {
      if (dataBytes || !size) return fallback;
      dataBytes = size;
    }
    offset = start + size + size % 2;
    if (offset > buffer.byteLength) return fallback;
  }
  return byteRate && dataBytes ? Math.ceil(dataBytes * 1000 / byteRate) : fallback;
}

export function selectedProvider(): SttProvider | undefined { return PROVIDERS.find((p) => p === process.env.STT_PROVIDER); }
export async function transcribe(provider: SttProvider, audio: File, signal: AbortSignal): Promise<MeteredSttResult> {
  const start = performance.now();
  try {
    signal.throwIfAborted();
    const duration = await audioMilliseconds(audio);
    const providerSignal = provider === "azure" ? signal : AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const text = await runMeteredCall(
      { stage: "stt", provider, model: models[provider], units: { audioMilliseconds: duration } },
      async () => {
        const transcript = await adapters[provider](audio, providerSignal);
        if (typeof transcript !== "string" || !transcript.trim()) throw new SttError("인식된 문장이 없어요. 무음 또는 음성 내용을 확인해 주세요.");
        return transcript.trim();
      },
      providerSignal,
    );
    return { provider, text, latencyMs: Math.round(performance.now() - start), success: true };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "LIMIT_EXCEEDED" || error.code === "UNAVAILABLE")) {
      return {
        provider, text: "", latencyMs: Math.round(performance.now() - start), success: false,
        code: error.code, retryable: "retryable" in error && error.retryable === true,
        error: error.code === "LIMIT_EXCEEDED" ? "음성 인식 사용 한도에 도달했어요. 사용량 설정을 확인해 주세요." : "음성 인식 사용량 정책을 확인해 주세요.",
      };
    }
    const message = error instanceof SttError ? error.message : error instanceof Error && /^설정 필요: [A-Z_]+$/.test(error.message) ? error.message : error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "요청이 취소되었거나 시간 제한을 넘었어요." : "음성 변환에 실패했어요. 네트워크와 공급자 설정을 확인해 주세요.";
    return { provider, text: "", latencyMs: Math.round(performance.now() - start), success: false, error: message };
  }
}
export async function compare(audio: File, signal: AbortSignal): Promise<MeteredSttResult[]> {
  const results = await Promise.allSettled(PROVIDERS.map((provider) => transcribe(provider, audio, signal)));
  return results.map((result, i) => result.status === "fulfilled" ? result.value : { provider: PROVIDERS[i], text: "", latencyMs: 0, success: false, error: "공급자 요청에 실패했어요." });
}
