import type { ErrorResponse, RequestId } from "../../contracts";

export const AZURE_TTS_VOICE = "ko-KR-InJoonNeural";
export const AZURE_TTS_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
export const AZURE_TTS_MIME_TYPE = "audio/mpeg";

type AzureSpeechErrorCode =
  | "LIMIT_EXCEEDED"
  | "UPSTREAM_TIMEOUT"
  | "UNAVAILABLE";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface AzureSpeechConfig {
  key: string;
  region: string;
}

export interface AzureSpeechEnvironment {
  AZURE_SPEECH_KEY?: string;
  AZURE_SPEECH_REGION?: string;
}

export interface SynthesizedSpeech {
  audio: Uint8Array;
  mimeType: typeof AZURE_TTS_MIME_TYPE;
}

export class AzureSpeechError extends Error {
  readonly code: AzureSpeechErrorCode;
  readonly retryable: boolean;

  constructor(
    code: AzureSpeechErrorCode,
    retryable: boolean,
  ) {
    super("음성 합성 서비스를 사용할 수 없습니다.");
    this.name = "AzureSpeechError";
    this.code = code;
    this.retryable = retryable;
  }
}

function escapeSsml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildAzureSpeechSsml(text: string): string {
  if (!text.trim()) {
    throw new Error("합성할 답변이 비어 있습니다.");
  }

  return `<speak version="1.0" xml:lang="ko-KR"><voice name="${AZURE_TTS_VOICE}"><prosody rate="-5%">${escapeSsml(text)}</prosody></voice></speak>`;
}

export function readAzureSpeechConfig(
  environment: AzureSpeechEnvironment,
): AzureSpeechConfig {
  const key = environment.AZURE_SPEECH_KEY?.trim() ?? "";
  const region = environment.AZURE_SPEECH_REGION?.trim().toLowerCase() ?? "";
  if (!key || !/^[a-z0-9-]+$/.test(region)) {
    throw new AzureSpeechError("UNAVAILABLE", false);
  }
  return { key, region };
}

export async function requestAzureSpeech(
  text: string,
  config: AzureSpeechConfig,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<SynthesizedSpeech> {
  const { key, region } = readAzureSpeechConfig({
    AZURE_SPEECH_KEY: config.key,
    AZURE_SPEECH_REGION: config.region,
  });

  let response: Response;
  try {
    response = await fetchImpl(
      `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": AZURE_TTS_OUTPUT_FORMAT,
          "User-Agent": "SejongTalk-TTS",
        },
        body: buildAzureSpeechSsml(text),
        signal,
      },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new AzureSpeechError("UPSTREAM_TIMEOUT", true);
    }
    throw new AzureSpeechError("UNAVAILABLE", true);
  }

  if (!response.ok) {
    if (response.status === 429) {
      throw new AzureSpeechError("LIMIT_EXCEEDED", true);
    }
    if (response.status === 408 || response.status === 504) {
      throw new AzureSpeechError("UPSTREAM_TIMEOUT", true);
    }
    throw new AzureSpeechError("UNAVAILABLE", response.status >= 500);
  }

  const audio = new Uint8Array(await response.arrayBuffer());
  if (audio.byteLength === 0) {
    throw new AzureSpeechError("UNAVAILABLE", true);
  }

  return { audio, mimeType: AZURE_TTS_MIME_TYPE };
}

export function toSpeechErrorResponse(
  error: unknown,
  requestId: RequestId,
): ErrorResponse {
  const speechError =
    error instanceof AzureSpeechError
      ? error
      : new AzureSpeechError("UNAVAILABLE", true);
  const messages: Record<AzureSpeechErrorCode, string> = {
    LIMIT_EXCEEDED: "음성 합성 사용량이 많습니다. 잠시 뒤 다시 시도해 주세요.",
    UPSTREAM_TIMEOUT: "음성 생성이 늦어지고 있습니다. 다시 시도해 주세요.",
    UNAVAILABLE: "음성 합성 서비스를 사용할 수 없습니다.",
  };

  return {
    status: "failed",
    requestId,
    code: speechError.code,
    message: messages[speechError.code],
    retryable: speechError.retryable,
  };
}
