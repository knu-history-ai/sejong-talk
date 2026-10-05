import "server-only";

import type { ApprovedTurn, FailedRequest, TurnRequest } from "../../contracts";
import { loadSejongKnowledgeBase, selectReviewedFactsForQuestion } from "../content/sejong";
import { parseAnswerDraftFromText, validateAnswerDraft } from "./answer";
import { requestGeminiCandidate, readGeminiConfig } from "./gemini-request";
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
    const reviewedFacts = selectReviewedFactsForQuestion(
      knowledgeBase,
      request.text,
    );
    const promptInput = buildSejongPromptInput({
      knowledgeBase,
      request,
      reviewedFacts,
      recentConversation,
    });
    const prompt = buildSejongAnswerPrompt(promptInput);
    const config = readGeminiConfig({
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GEMINI_MODEL: process.env.GEMINI_MODEL,
      GEMINI_TIMEOUT_MS: process.env.GEMINI_TIMEOUT_MS,
      GEMINI_MAX_ATTEMPTS: process.env.GEMINI_MAX_ATTEMPTS,
      GEMINI_API_BASE_URL: process.env.GEMINI_API_BASE_URL,
    });
    const candidate = await requestGeminiCandidate(prompt, config, fetch, signal);
    const answer = validateAnswerDraft(
      parseAnswerDraftFromText(candidate.text),
      promptInput,
    );

    return { requestId: request.requestId, operation: "turn", status: "approved", answer };
  } catch (error) {
    return failedTurn(request.requestId, error);
  }
}

export { buildSejongTurnFingerprint };

export async function runCoordinatedSejongTurn({
  generateTurn = generateSejongTurn,
  ...options
}: Omit<RunCoordinatedSejongTurnOptions, "generateTurn"> &
  Partial<Pick<RunCoordinatedSejongTurnOptions, "generateTurn">>) {
  return runCoordinatedSejongTurnWithGenerator({
    ...options,
    generateTurn,
  });
}
