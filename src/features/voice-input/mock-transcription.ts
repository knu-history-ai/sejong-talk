import type { Transcribe } from "./recorder";

export const SAMPLE_TRANSCRIPT = "세종대왕은 왜 훈민정음을 만들었어요?";

// No upload, file persistence, object URL or logging of original audio.
export const mockTranscribe: Transcribe = (_recording, signal) => new Promise((resolve, reject) => {
  const cancel = () => { clearTimeout(timer); reject(new DOMException("Cancelled", "AbortError")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(SAMPLE_TRANSCRIPT); }, 700);
  if (signal.aborted) { cancel(); return; }
  signal.addEventListener("abort", cancel, { once: true });
});
