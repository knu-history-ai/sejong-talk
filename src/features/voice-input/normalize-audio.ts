import { encodePcmWav, PCM_MAX_SAMPLES, PCM_RATE } from "./pcm-wav";

type DecodedAudio = Pick<AudioBuffer, "sampleRate" | "length" | "numberOfChannels" | "getChannelData">;
type Decode = (data: ArrayBuffer) => Promise<DecodedAudio>;
const decodeAudio: Decode = (data) => new OfflineAudioContext(1, 1, PCM_RATE).decodeAudioData(data);
export class AudioInputError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new DOMException("Cancelled", "AbortError"));
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

/** OfflineAudioContext decodes AND resamples to its 16kHz context rate. No microphone/speaker access. */
export async function normalizeAudio(blob: Blob, signal: AbortSignal, recordedDurationMs?: number, decode: Decode = decodeAudio): Promise<Blob> {
  signal.throwIfAborted();
  if (!blob.size) throw new AudioInputError("AUDIO_EMPTY", "녹음된 내용이 없어요. 다시 녹음해 주세요.");
  if (blob.size > 5_000_000) throw new AudioInputError("AUDIO_TOO_LARGE", "음성 파일은 최대 5 MB까지 사용할 수 있어요.");
  let audio: DecodedAudio;
  try { const bytes = await blob.arrayBuffer(); signal.throwIfAborted(); audio = await abortable(decode(bytes), signal); }
  catch (error) {
    signal.throwIfAborted();
    if (error instanceof AudioInputError) throw error;
    throw new AudioInputError("AUDIO_UNSUPPORTED", "파일이 손상되었거나 이 브라우저에서 읽을 수 없는 형식이에요.");
  }
  signal.throwIfAborted();
  if (audio.sampleRate !== PCM_RATE || !audio.length || !audio.numberOfChannels) throw new AudioInputError("AUDIO_UNSUPPORTED", "음성 형식을 변환하지 못했어요. 다시 녹음하거나 글로 질문해 주세요.");
  // Only recorder timer/codec padding is tolerated; uploaded files must be <=30s.
  // Output is always bounded to 30 seconds, including auto-stop recordings.
  const recorderPadding = recordedDurationMs !== undefined && recordedDurationMs > 0 && recordedDurationMs <= 30_250 && audio.length <= PCM_MAX_SAMPLES + PCM_RATE / 4;
  if (audio.length > PCM_MAX_SAMPLES && !recorderPadding) throw new AudioInputError("AUDIO_TOO_LONG", "30초 이내의 음성 파일을 선택해 주세요.");
  const mono = new Float32Array(Math.min(audio.length, PCM_MAX_SAMPLES));
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const samples = audio.getChannelData(channel);
    for (let i = 0; i < mono.length; i++) mono[i] += samples[i] / audio.numberOfChannels;
  }
  let energy = 0;
  for (const sample of mono) energy += sample * sample;
  if (!Number.isFinite(energy) || Math.sqrt(energy / mono.length) < 0.001) throw new AudioInputError("AUDIO_SILENT", "소리가 충분히 들리지 않았어요. 다시 녹음하거나 글로 질문해 주세요.");
  signal.throwIfAborted();
  const wav = new Blob([encodePcmWav(mono)], { type: "audio/wav" });
  if (wav.size > 5_000_000) throw new AudioInputError("AUDIO_TOO_LARGE", "변환된 음성이 5 MB를 넘었어요.");
  return wav;
}
