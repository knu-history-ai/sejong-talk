import "server-only";
import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";

export const BEDROCK_MODEL = "jp.anthropic.claude-haiku-4-5-20251001-v1:0";
export const BEDROCK_REGION = "ap-northeast-1";
export type BedrockFailure = "CANCELLED" | "UPSTREAM_TIMEOUT" | "FORBIDDEN" | "LIMIT_EXCEEDED" | "UNAVAILABLE";
export class BedrockError extends Error {
  readonly code: BedrockFailure;
  constructor(code: BedrockFailure) { super(code); this.name = "BedrockError"; this.code = code; }
}
export type BedrockSend = (command: ConverseCommand, options: { abortSignal: AbortSignal }) => Promise<ConverseCommandOutput>;
export interface BedrockUsage { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }
export interface BedrockMetric { event: "bedrock_call"; status: "completed" | "failed" | "cancelled"; code?: BedrockFailure; model: string; durationMs: number; usage: BedrockUsage }
let client: BedrockRuntimeClient | undefined;
const send: BedrockSend = (command, options) => {
  client ??= new BedrockRuntimeClient({ region: BEDROCK_REGION, maxAttempts: 1 });
  return client.send(command, options);
};
const token = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

// Transport success is distinct from publication approval. Never log SDK errors or candidate text.
export async function requestBedrockCandidate(prompt: string, options: {
  signal?: AbortSignal; timeoutMs?: number; send?: BedrockSend; log?: (metric: BedrockMetric) => void;
} = {}) {
  const timeoutMs = options.timeoutMs ?? Number(process.env.BEDROCK_TIMEOUT_MS || 15000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new BedrockError("UNAVAILABLE");
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const started = performance.now();
  let status: BedrockMetric["status"] = "failed";
  let code: BedrockFailure | undefined;
  let usage: BedrockUsage = { inputTokens: null, outputTokens: null, totalTokens: null };
  let rejectAbort: () => void = () => {};
  try {
    if (controller.signal.aborted) throw new BedrockError("CANCELLED");
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new BedrockError(timedOut ? "UPSTREAM_TIMEOUT" : "CANCELLED"));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const response = await Promise.race([
      (options.send ?? send)(new ConverseCommand({
        modelId: BEDROCK_MODEL,
        messages: [{ role: "user", content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: 1000, temperature: 0.2 },
      }), { abortSignal: controller.signal }), aborted,
    ]);
    if (controller.signal.aborted) throw new BedrockError(timedOut ? "UPSTREAM_TIMEOUT" : "CANCELLED");
    usage = { inputTokens: token(response.usage?.inputTokens), outputTokens: token(response.usage?.outputTokens), totalTokens: token(response.usage?.totalTokens) };
    const text = response.output?.message?.content?.map((part) => part.text ?? "").join("").trim();
    if (!text || response.stopReason !== "end_turn") throw new BedrockError("UNAVAILABLE");
    status = "completed";
    return { text, usage };
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error ? error.name : "";
    code = options.signal?.aborted ? "CANCELLED" : timedOut ? "UPSTREAM_TIMEOUT"
      : error instanceof BedrockError ? error.code
      : ["AccessDeniedException", "UnrecognizedClientException", "CredentialsProviderError", "ExpiredTokenException"].includes(String(name)) ? "FORBIDDEN"
      : name === "ThrottlingException" ? "LIMIT_EXCEEDED"
      : name === "ModelTimeoutException" ? "UPSTREAM_TIMEOUT" : "UNAVAILABLE";
    status = code === "CANCELLED" ? "cancelled" : "failed";
    throw new BedrockError(code);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectAbort);
    try { options.log?.({ event: "bedrock_call", status, ...(code ? { code } : {}), model: BEDROCK_MODEL, durationMs: Math.round(performance.now() - started), usage }); } catch { /* telemetry cannot change publication */ }
  }
}
