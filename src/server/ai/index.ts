import "server-only";

import type { ApprovedTurn, FailedRequest, TurnRequest } from "../../contracts";
import { loadSejongKnowledgeBase } from "../content/sejong";
import { parseAnswerDraftFromText } from "./answer";
import { selectFactsForTurn } from "./followup";
import { serverAnswer, verifyForPublication } from "./publication";
import { requestOllamaCandidate, readOllamaConfig } from "./ollama-request";
import {
  buildSejongAnswerPrompt,
  buildSejongPromptInput,
  type RecentApprovedTurn,
} from "./prompt";
import {
  buildSejongTurnFingerprint,
  runCoordinatedSejongTurn as runCoordinatedSejongTurnWithGenerator,
  type RunCoordinatedSejongTurnOptions,
} from "./turn-runner";
import { getUsageLedger } from "../usage/runtime.ts";

export interface GenerateSejongTurnOptions {
  request: TurnRequest;
  recentConversation?: RecentApprovedTurn[];
  signal?: AbortSignal;
}

function failedTurn(requestId: string, error: unknown): FailedRequest {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error.code as FailedRequest["code"])
      : "UNAVAILABLE";
  const retryable =
    error && typeof error === "object" && "retryable" in error
      ? Boolean(error.retryable)
      : true;

  return {
    requestId,
    operation: "turn",
    status: "failed",
    code,
    message:
      code === "LIMIT_EXCEEDED"
        ? "AI 답변 생성 사용량이 많습니다. 잠시 뒤 다시 시도해 주세요."
        : "AI 답변 생성 서비스를 사용할 수 없습니다.",
    retryable,
  };
}

export async function generateSejongTurn({
  request,
  recentConversation = [],
  signal,
}: GenerateSejongTurnOptions): Promise<ApprovedTurn | FailedRequest> {
  try {
    const knowledgeBase = await loadSejongKnowledgeBase();
    const selection = selectFactsForTurn(
      knowledgeBase,
      request.text,
      recentConversation,
    );
    const promptInput = buildSejongPromptInput({
      knowledgeBase,
      request,
      reviewedFacts: selection.facts,
      recentConversation,
    });
    signal?.throwIfAborted();
    if (selection.needsClarification) {
      console.info("sejong_answer_validation", { reason: "clarification" });
      return { requestId: request.requestId, operation: "turn", status: "approved", answer: serverAnswer(promptInput, "insufficient", true) };
    }
    const prompt = buildSejongAnswerPrompt(promptInput);
    const config = readOllamaConfig({
      OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
      OLLAMA_MODEL: process.env.OLLAMA_MODEL,
      OLLAMA_TIMEOUT_MS: process.env.OLLAMA_TIMEOUT_MS,
      OLLAMA_MAX_ATTEMPTS: process.env.OLLAMA_MAX_ATTEMPTS,
    });
    const candidate = await requestOllamaCandidate(prompt, config, fetch, signal);
    const { answer, reason } = await verifyForPublication(
      parseAnswerDraftFromText(candidate.text),
      promptInput,
      {
        signal,
        verify: async (verificationPrompt, verificationSignal) => {
          const result = await requestOllamaCandidate(verificationPrompt,
            { ...config, usageStage: "llm_verification", timeoutMs: Math.min(config.timeoutMs, 5_000), maxAttempts: 1 },
            fetch, verificationSignal);
          return result.text;
        },
      },
    );
    // Log only a bounded reason code, never private questions or provider bodies.
    console.info("sejong_answer_validation", { reason });
    signal?.throwIfAborted();

    return { requestId: request.requestId, operation: "turn", status: "approved", answer };
  } catch (error) {
    return failedTurn(request.requestId, error);
  }
}

export { buildSejongTurnFingerprint };

export async function runCoordinatedSejongTurn({
  generateTurn = generateSejongTurn,
  sessionId,
  ...options
}: Omit<RunCoordinatedSejongTurnOptions, "generateTurn" | "usage"> & { sessionId: string } &
  Partial<Pick<RunCoordinatedSejongTurnOptions, "generateTurn">>) {
  return runCoordinatedSejongTurnWithGenerator({
    ...options,
    generateTurn,
    usage: { ledger: getUsageLedger(), sessionId },
  });
}
