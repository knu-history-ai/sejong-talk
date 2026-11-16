import { randomUUID } from "node:crypto";

import type { Answer } from "../../contracts";
import type { SejongPromptInput } from "./prompt";

export type AnswerKind = Answer["kind"];

export interface AnswerDraft {
  kind: AnswerKind;
  text: string;
  factIds: string[];
}

export interface ValidateAnswerDraftOptions {
  answerId?: string;
  maxTextLength?: number;
}

const ANSWER_KINDS = new Set<AnswerKind>([
  "grounded",
  "conversation",
  "insufficient",
  "fallback",
]);

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const withoutOpeningFence = trimmed.replace(/^```(?:json)?\s*/i, "");
  return withoutOpeningFence.replace(/\s*```$/i, "").trim();
}

export function parseAnswerDraftFromText(text: string): AnswerDraft {
  const stripped = stripJsonFence(text);
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("LLM 응답에서 JSON 객체를 찾지 못했습니다.");
  }

  const parsed = JSON.parse(stripped.slice(start, end + 1)) as Partial<AnswerDraft>;
  if (
    !parsed.kind ||
    !ANSWER_KINDS.has(parsed.kind) ||
    typeof parsed.text !== "string" ||
    !Array.isArray(parsed.factIds) ||
    !parsed.factIds.every((factId) => typeof factId === "string")
  ) {
    throw new Error("LLM 응답 JSON이 답변 계약을 따르지 않습니다.");
  }

  return {
    kind: parsed.kind,
    text: parsed.text.trim(),
    factIds: [...new Set(parsed.factIds)],
  };
}

function fallbackAnswer(input: SejongPromptInput, answerId: string): Answer {
  return {
    answerId,
    kind: "fallback",
    text: "이번 답변은 확인을 마치지 못했구나. 준비된 자료로 확인할 수 있는 질문으로 다시 이야기해 보자.",
    factIds: [],
    sources: [],
    personaVersion: input.character.personaVersion,
    contentVersion: input.contentVersion,
  };
}

export function validateAnswerDraft(
  draft: AnswerDraft,
  input: SejongPromptInput,
  options: ValidateAnswerDraftOptions = {},
): Answer {
  const answerId = options.answerId ?? `answer_${randomUUID()}`;
  const maxTextLength = options.maxTextLength ?? 400;
  const approvedFactIds = new Set(input.reviewedFacts.map((fact) => fact.id));
  const validFactIds = draft.factIds.filter((factId) => approvedFactIds.has(factId));
  const linkedSources = input.sources.filter((source) =>
    input.reviewedFacts
      .filter((fact) => validFactIds.includes(fact.id))
      .some((fact) => fact.sourceIds.includes(source.id)),
  );

  if (!draft.text || draft.text.length > maxTextLength) {
    return fallbackAnswer(input, answerId);
  }

  if (draft.kind === "grounded") {
    if (validFactIds.length === 0 || linkedSources.length === 0) {
      return fallbackAnswer(input, answerId);
    }

    return {
      answerId,
      kind: "grounded",
      text: draft.text,
      factIds: validFactIds,
      sources: linkedSources,
      personaVersion: input.character.personaVersion,
      contentVersion: input.contentVersion,
    };
  }

  return {
    answerId,
    kind: draft.kind,
    text: draft.text,
    factIds: [],
    sources: [],
    personaVersion: input.character.personaVersion,
    contentVersion: input.contentVersion,
  };
}
