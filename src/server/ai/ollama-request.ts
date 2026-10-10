import type { ErrorCode } from "../../contracts";
import { runMeteredCall } from "../usage/runtime.ts";

export const DEFAULT_OLLAMA_MODEL = "qwen3.5:4b-q4_K_M";
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_TIMEOUT_MS = 60_000;
export const DEFAULT_OLLAMA_MAX_ATTEMPTS = 1;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OllamaEnvironment {
  OLLAMA_BASE_URL?: string;
  OLLAMA_MODEL?: string;
  OLLAMA_TIMEOUT_MS?: string;
  OLLAMA_MAX_ATTEMPTS?: string;
}

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxAttempts: number;
  retryBaseDelayMs: number;
  usageStage?: "llm_generation" | "llm_verification";
}

export interface OllamaUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface OllamaCandidateResult {
  text: string;
  usage: OllamaUsage;
  attempts: number;
}

export class OllamaRequestError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, retryable: boolean) {
    super("AI 답변 생성 서비스를 사용할 수 없습니다.");
    this.name = "OllamaRequestError";
    this.code = code;
    this.retryable = retryable;
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readOllamaConfig(environment: OllamaEnvironment): OllamaConfig {
  return {
    baseUrl: environment.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL,
    model: environment.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL,
    timeoutMs: parsePositiveInteger(
      environment.OLLAMA_TIMEOUT_MS,
      DEFAULT_OLLAMA_TIMEOUT_MS,
    ),
    maxAttempts: parsePositiveInteger(
      environment.OLLAMA_MAX_ATTEMPTS,
      DEFAULT_OLLAMA_MAX_ATTEMPTS,
    ),
    retryBaseDelayMs: 250,
  };
}

export function buildOllamaRequestBody(prompt: string, model: string): unknown {
  return {
    model,
    prompt,
    stream: false,
    format: "json",
    options: {
      temperature: 0.2,
      top_p: 0.9,
      num_predict: 1000,
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function readUsage(responseBody: unknown): OllamaUsage {
  const body = asRecord(responseBody);
  const inputTokens = readNumber(body, "prompt_eval_count");
  const outputTokens = readNumber(body, "eval_count");
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens !== null && outputTokens !== null
        ? inputTokens + outputTokens
        : null,
  };
}

export function extractOllamaText(responseBody: unknown): string {
  const body = asRecord(responseBody);
  const response = body?.response;
  if (typeof response !== "string" || !response.trim()) {
    throw new OllamaRequestError("UNAVAILABLE", false);
  }

  return response.trim();
}

function errorFromStatus(response: Response): OllamaRequestError {
  if (response.status === 408 || response.status === 504) {
    return new OllamaRequestError("UPSTREAM_TIMEOUT", true);
  }
  if (response.status >= 500) {
    return new OllamaRequestError("UNAVAILABLE", true);
  }
  return new OllamaRequestError("UNAVAILABLE", false);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new OllamaRequestError("UPSTREAM_TIMEOUT", false));
  }
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new OllamaRequestError("UPSTREAM_TIMEOUT", false));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function requestOllamaCandidate(
  prompt: string,
  config: OllamaConfig,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
  meter: typeof runMeteredCall = runMeteredCall,
): Promise<OllamaCandidateResult> {
  const endpoint = new URL("/api/generate", config.baseUrl);

  let lastError: OllamaRequestError | null = null;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    const timed = withTimeout(signal, config.timeoutMs);
    try {
      return await meter(
        { stage: config.usageStage ?? "llm_generation", provider: "ollama", model: config.model },
        async (report) => {
          const response = await fetchImpl(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildOllamaRequestBody(prompt, config.model)),
            signal: timed.signal,
          });

          if (!response.ok) {
            throw errorFromStatus(response);
          }

          const responseBody = await response.json();
          const usage = readUsage(responseBody);
          report({
            ...(usage.inputTokens !== null ? { inputTokens: usage.inputTokens } : {}),
            ...(usage.outputTokens !== null ? { outputTokens: usage.outputTokens } : {}),
            ...(usage.totalTokens !== null ? { totalTokens: usage.totalTokens } : {}),
          });
          return { text: extractOllamaText(responseBody), usage, attempts: attempt };
        },
        timed.signal,
      );
    } catch (error) {
      if (!(error instanceof OllamaRequestError) && error && typeof error === "object" && "code" in error && ["LIMIT_EXCEEDED", "UNAVAILABLE"].includes(String(error.code))) {
        throw error;
      }
      lastError =
        error instanceof OllamaRequestError
          ? error
          : new OllamaRequestError(
              isAbortLike(error) ? "UPSTREAM_TIMEOUT" : "UNAVAILABLE",
              true,
            );

      if (signal?.aborted || !lastError.retryable || attempt >= config.maxAttempts) {
        throw lastError;
      }

      await sleep(config.retryBaseDelayMs * 2 ** (attempt - 1), signal);
    } finally {
      timed.cleanup();
    }
  }

  throw lastError ?? new OllamaRequestError("UNAVAILABLE", true);
}
