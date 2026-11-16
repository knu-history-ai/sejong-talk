import "server-only";
import { requestJsonResponse, setting, SttError } from "./common";
import { inspectPcmWav } from "@/features/voice-input/pcm-wav";

export const AZURE_TIMEOUT_MS = 20_000;
export const NO_TRANSCRIPT = "인식된 문장이 없어요. 무음 또는 음성 내용을 확인해 주세요.";
export function azureDisplayText(data: { RecognitionStatus?: string; DisplayText?: unknown; NBest?: { Display?: unknown }[] }): string {
  if (["NoMatch", "InitialSilenceTimeout", "BabbleTimeout"].includes(data.RecognitionStatus ?? "")) throw new SttError(NO_TRANSCRIPT);
  if (data.RecognitionStatus !== "Success") throw new SttError("Azure 음성 인식에 실패했어요. 다시 녹음하거나 글로 질문해 주세요.");
  const text = data.DisplayText !== undefined ? data.DisplayText : data.NBest?.[0]?.Display;
  if (typeof text !== "string" || !text.trim()) throw new SttError(NO_TRANSCRIPT);
  return text.trim();
}

/** Short Audio REST is the F0-compatible real-time STT path. No Fast/Batch fallback. */
export async function recognizeAzure(audio: File, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!audio.size || audio.size > 5_000_000) throw new SttError("음성 파일은 0바이트보다 크고 5 MB 이하여야 해요.");
  const bytes = await audio.arrayBuffer();
  let metadata: ReturnType<typeof inspectPcmWav>;
  try { metadata = inspectPcmWav(bytes); }
  catch { throw new SttError("Azure에는 30초 이하 16kHz 모노 PCM16 WAV 음성이 필요해요. 다시 녹음해 주세요."); }
  const pcm = new DataView(bytes); let energy = 0;
  for (let offset = metadata.dataOffset; offset < metadata.dataOffset + metadata.dataBytes; offset += 2) energy += (pcm.getInt16(offset, true) / 32768) ** 2;
  if (Math.sqrt(energy / (metadata.dataBytes / 2)) < 0.001) throw new SttError(NO_TRANSCRIPT);
  const region = setting("AZURE_SPEECH_REGION");
  if (!/^[a-z0-9]+$/.test(region)) throw new SttError("AZURE_SPEECH_REGION 설정을 확인해 주세요.");
  const timeout = new AbortController();
  const deadline = setTimeout(() => timeout.abort(new DOMException("Timed out", "TimeoutError")), AZURE_TIMEOUT_MS);
  try {
    const { status, data } = await requestJsonResponse(`https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=ko-KR&format=detailed`, {
      method: "POST", headers: { "Ocp-Apim-Subscription-Key": setting("AZURE_SPEECH_KEY"), "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000", Accept: "application/json" },
      body: bytes, signal: AbortSignal.any([signal, timeout.signal]),
    });
    signal.throwIfAborted(); timeout.signal.throwIfAborted();
    return { text: azureDisplayText(data), recognitionStatus: "Success", httpStatus: status };
  } finally { clearTimeout(deadline); }
}
export async function azure(audio: File, signal: AbortSignal): Promise<string> { return (await recognizeAzure(audio, signal)).text; }
