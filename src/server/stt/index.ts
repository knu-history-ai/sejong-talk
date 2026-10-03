import "server-only";
import { PROVIDERS, type SttProvider, type SttResult } from "@/features/voice-input/stt-types";
import { azure } from "./azure";
import { clova } from "./clova";
import { deepgram } from "./deepgram";
import { groq } from "./groq";
import { elevenlabs } from "./elevenlabs";
import { SttError } from "./common";
const adapters = { azure, clova, deepgram, groq, elevenlabs };
export function selectedProvider(): SttProvider | undefined { return PROVIDERS.find((p) => p === process.env.STT_PROVIDER); }
export async function transcribe(provider: SttProvider, audio: File, signal: AbortSignal): Promise<SttResult> {
  const start = performance.now();
  try {
    const text = await adapters[provider](audio, provider === "azure" ? signal : AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
    if (typeof text !== "string" || !text.trim()) throw new SttError("인식된 문장이 없어요. 무음 또는 음성 내용을 확인해 주세요.");
    return { provider, text: text.trim(), latencyMs: Math.round(performance.now() - start), success: true };
  } catch (error) {
    const message = error instanceof SttError ? error.message : error instanceof Error && /^설정 필요: [A-Z_]+$/.test(error.message) ? error.message : error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "요청이 취소되었거나 시간 제한을 넘었어요." : "음성 변환에 실패했어요. 네트워크와 공급자 설정을 확인해 주세요.";
    return { provider, text: "", latencyMs: Math.round(performance.now() - start), success: false, error: message };
  }
}
export async function compare(audio: File, signal: AbortSignal): Promise<SttResult[]> {
  const results = await Promise.allSettled(PROVIDERS.map((provider) => transcribe(provider, audio, signal)));
  return results.map((result, i) => result.status === "fulfilled" ? result.value : { provider: PROVIDERS[i], text: "", latencyMs: 0, success: false, error: "공급자 요청에 실패했어요." });
}
