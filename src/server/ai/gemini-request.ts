import type { ErrorCode } from "../../contracts";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
export const DEFAULT_GEMINI_TIMEOUT_MS = 20_000;
export const DEFAULT_GEMINI_MAX_ATTEMPTS = 4;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GeminiEnvironment {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_TIMEOUT_MS?: string;
  GEMINI_MAX_ATTEMPTS?: string;
  GEMINI_API_BASE_URL?: string;
}

export interface GeminiConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxAttempts: number;
  apiBaseUrl: string;
  retryBaseDelayMs: number;
}

export interface GeminiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface GeminiCandidateResult {
  text: string;
  usage: GeminiUsage;
  attempts: number;
}

export class GeminiRequestError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, retryable: boolean, retryAfterSeconds?: number) {
    super("AI 답변 생성 서비스를 사용할 수 없습니다.");
    this.name = "GeminiRequestError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readGeminiConfig(environment: GeminiEnvironment): GeminiConfig {
  const apiKey = environment.GEMINI_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new GeminiRequestError("UNAVAILABLE", false);
  }

  return {
    apiKey,
    model: environment.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
    timeoutMs: parsePositiveInteger(
      environment.GEMINI_TIMEOUT_MS,
      DEFAULT_GEMINI_TIMEOUT_MS,
    ),
    maxAttempts: parsePositiveInteger(
      environment.GEMINI_MAX_ATTEMPTS,
      DEFAULT_GEMINI_MAX_ATTEMPTS,
    ),
    apiBaseUrl:
      environment.GEMINI_API_BASE_URL?.trim() ||
      "https://generativelanguage.googleapis.com/v1beta",
    retryBaseDelayMs: 250,
  };
}

export function buildGeminiRequestBody(prompt: string): unknown {
  return {
    systemInstruction: {
      parts: [
        {
          text: "너는 세종톡 서버의 답변 생성기다. 서버가 제공한 사실 카드와 정책을 우선하고 JSON만 반환한다.",
        },
      ],
    },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 1000,
      responseMimeType: "application/json",
    },
  };
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromParent = () => controller.abort(signal?.reason);

  if (signal?.aborted) {
    abortFromParent();
  } else {
    signal?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function isAbortLike(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function errorFromStatus(response: Response): GeminiRequestError {
  if (response.status === 429) {
    return new GeminiRequestError(
      "LIMIT_EXCEEDED",
      true,
      retryAfterSeconds(response),
    );
  }
  if (response.status === 408 || response.status === 504) {
    return new GeminiRequestError("UPSTREAM_TIMEOUT", true);
  }
  if (response.status >= 500) {
    return new GeminiRequestError("UNAVAILABLE", true);
  }
  return new GeminiRequestError("UNAVAILABLE", false);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function isVisibleTextPart(
  part: Record<string, unknown> | null,
): part is { text: string } {
  return part?.thought !== true && typeof part?.text === "string";
}

function readUsage(responseBody: unknown): GeminiUsage {
  const body = asRecord(responseBody);
  const usage = asRecord(body?.usageMetadata) ?? {};
  return {
    inputTokens:
      typeof usage.promptTokenCount === "number" ? usage.promptTokenCount : null,
    outputTokens:
      typeof usage.candidatesTokenCount === "number"
        ? usage.candidatesTokenCount
        : null,
    totalTokens:
      typeof usage.totalTokenCount === "number" ? usage.totalTokenCount : null,
  };
}

export function extractGeminiText(responseBody: unknown): string {
  const body = asRecord(responseBody);
  const candidates = body?.candidates;
  const firstCandidate = Array.isArray(candidates)
    ? asRecord(candidates[0])
    : null;
  const content = asRecord(firstCandidate?.content);
  const parts = content?.parts;
  if (!Array.isArray(parts)) {
    throw new GeminiRequestError("UNAVAILABLE", true);
  }

  const text = parts
    .map((part) => asRecord(part))
    .filter(isVisibleTextPart)
    .map((part) => part.text)
    .join("")
    .trim();

  if (!text) {
    throw new GeminiRequestError("UNAVAILABLE", true);
  }

  return text;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new GeminiRequestError("UPSTREAM_TIMEOUT", true));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function requestGeminiCandidate(
  prompt: string,
  config: GeminiConfig,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<GeminiCandidateResult> {
  const endpoint = new URL(
    `${config.apiBaseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(config.model)}:generateContent`,
  );
  endpoint.searchParams.set("key", config.apiKey);

  let lastError: GeminiRequestError | null = null;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    const timed = withTimeout(signal, config.timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGeminiRequestBody(prompt)),
        signal: timed.signal,
      });

      if (!response.ok) {
        throw errorFromStatus(response);
      }

      const responseBody = await response.json();
      return {
        text: extractGeminiText(responseBody),
        usage: readUsage(responseBody),
        attempts: attempt,
      };
    } catch (error) {
      lastError =
        error instanceof GeminiRequestError
          ? error
          : new GeminiRequestError(
              isAbortLike(error) ? "UPSTREAM_TIMEOUT" : "UNAVAILABLE",
              true,
            );

      if (!lastError.retryable || attempt >= config.maxAttempts) {
        throw lastError;
      }

      await sleep(config.retryBaseDelayMs * 2 ** (attempt - 1), signal);
    } finally {
      timed.cleanup();
    }
  }

  throw lastError ?? new GeminiRequestError("UNAVAILABLE", true);
}
