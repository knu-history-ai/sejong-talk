import type { SpeechRequest, SpeechResponse } from "../../contracts";

export class SpeechPlaybackError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "SpeechPlaybackError";
  }
}

async function readJson(response: Response): Promise<SpeechResponse> {
  try {
    return await response.json();
  } catch {
    throw new SpeechPlaybackError("음성 응답을 확인하지 못했습니다. 다시 시도해 주세요.");
  }
}

async function throwApiError(response: Response): Promise<never> {
  const body = await readJson(response);
  if (body?.status === "failed" && typeof body.message === "string") {
    throw new SpeechPlaybackError(body.message, body.code);
  }
  throw new SpeechPlaybackError("음성을 가져오지 못했습니다. 다시 시도해 주세요.");
}

/** Only approved answer IDs leave the browser; API keys and answer text stay out. */
export async function fetchApprovedSpeech(
  input: SpeechRequest,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Blob> {
  signal.throwIfAborted();
  const response = await fetchImpl("/api/speech", {
    method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  if (!response.ok) return throwApiError(response);
  const result = await readJson(response);
  signal.throwIfAborted();
  if (response.status !== 200 || result?.status !== "completed" || result.operation !== "speech" ||
      result.requestId !== input.requestId || result.answerId !== input.answerId ||
      result.audio?.url !== `/api/speech/audio/${encodeURIComponent(input.answerId)}` ||
      typeof result.audio.mimeType !== "string" || !/^audio\/[a-z0-9.+-]+$/i.test(result.audio.mimeType)) {
    throw new SpeechPlaybackError("현재 답변의 음성 응답이 아닙니다. 다시 시도해 주세요.");
  }
  const audio = await fetchImpl(result.audio.url, {
    credentials: "same-origin", cache: "no-store", signal,
  });
  if (!audio.ok) return throwApiError(audio);
  if (audio.headers.get("content-type")?.split(";")[0].trim() !== result.audio.mimeType) {
    throw new SpeechPlaybackError("음원 형식을 확인하지 못했습니다.");
  }
  const blob = await audio.blob();
  signal.throwIfAborted();
  if (!blob.size) throw new SpeechPlaybackError("음원이 비어 있습니다. 다시 시도해 주세요.");
  return blob;
}
