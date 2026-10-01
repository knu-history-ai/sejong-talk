import type { Transcribe } from "./recorder";
import { normalizeAudio } from "./normalize-audio";
export function audioForm(blob: Blob) {
  const form = new FormData();
  form.set("audio", blob, blob.type === "audio/wav" ? "recording.wav" : "recording");
  form.set("requestId", crypto.randomUUID());
  return form;
}
export const serverTranscribe: Transcribe = async (recording, signal) => {
  const wav = await normalizeAudio(recording.blob, signal, recording.durationMs);
  signal.throwIfAborted();
  const response = await fetch("/api/transcriptions", { method: "POST", body: audioForm(wav), signal });
  const result = await response.json();
  if (!response.ok || result.status !== "completed") throw new Error(result.message || "음성을 인식하지 못했어요.");
  return result.text;
};
