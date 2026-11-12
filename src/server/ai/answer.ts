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
const SELF_REFERENCE_NAME = String.raw`세종(?:\s*(?:대왕|임금))?(?:\s*님)?`;
const SELF_REFERENCE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(${SELF_REFERENCE_NAME})(?:\s*(?:에게는|에겐|에게|께서는|께서|께도|께만|께|이야말로|이야(?=\s|[,.!?]|$)|만이|만|은|는|가|도|의|을|를|이(?=\s|[,.!?]|$))|\s*,\s*그분(?:은|이|도))`,
  "gu",
);
const QUOTE_PAIRS: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’" };

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

function isAttributedQuote(text: string, start: number, end: number): boolean {
  const before = text.slice(0, start).split(/[.!?\n]/).at(-1) ?? "";
  const after = text.slice(end + 1);
  const quoted = text.slice(start + 1, end).trim();
  const question = /(?:네가|네\s*질문(?:은|에는)?|너의\s*질문(?:은|에는)?)\s*$/.test(before);
  const source = /(?:자료|기록|사료|사실\s*카드)(?:의\s*문장)?(?:에는|에|는|은)\s*$/.test(before);
  const reported = /^\s*(?:이라고|라고|고)\s*(?:물었|질문했|말했|하였|했|적었|기록했|썼|적혀|기록되어|쓰여|나와|되어|있)/.test(after);
  const identified = /^\s*(?:이었|였|이란다|란다)/.test(after);
  const term = /^\s*(?:이라는|라는)\s*(?:표현|단어|이름|말)/.test(after);
  const spelling = /^(?:세종|세종대왕)$/.test(quoted) &&
    /^\s*(?:은|는)\s*(?:한|두|세|네|다섯|여섯|\d+)\s*글자(?:로\s*적은)?\s*이름/.test(after);
  return ((question || source) && (reported || identified)) || term || spelling;
}

function maskAttributedQuotes(text: string): string {
  const chars = text.split("");
  const stack: { start: number; close: string }[] = [];
  // Only complete, correctly paired spans can be omitted; intervening prose stays visible.
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const top = stack.at(-1);
    if (top && char === top.close) {
      stack.pop();
      if (stack.length === 0 && isAttributedQuote(text, top.start, index)) {
        chars.fill(" ", top.start, index + 1);
      }
    } else if (QUOTE_PAIRS[char]) {
      stack.push({ start: index, close: QUOTE_PAIRS[char] });
    } else if (char === "”" || char === "’") {
      stack.length = 0;
    }
  }
  return chars.join("");
}

function hasThirdPersonSelfReference(text: string): boolean {
  const answerText = maskAttributedQuotes(text)
    .replace(/(?:\(\s*世宗\s*\)|\[\s*世宗\s*\])/g, "")
    .replace(/~~/g, "")
    .replace(/[\\*_`\[\]"'“”‘’]/g, "");
  for (const match of answerText.matchAll(SELF_REFERENCE)) {
    const before = answerText.slice(0, match.index);
    const clause = before.split(/[.!?\n]/).at(-1) ?? "";
    // Exceptions apply to this occurrence, never to the rest of the answer.
    const selfIntroduction = /(?:^|\s)(?:나|나는|내가|저|저는|제가)\s*,?\s*(?:(?:조선의\s*)?임금\s*)?$/.test(clause);
    const nameParticle = match[0].slice(match[1].length).trim();
    // A topic apposition (나, 세종은) identifies the speaker; a separate
    // subject (나는 세종이 ... 했다고) still describes Sejong in third person.
    if (selfIntroduction && /^(?:은|는)$/.test(nameParticle)) continue;
    if (match[1] === "세종" && /(?:네|너의)\s*(?:친구\s*)?이름이\s*세종이라면\s*,?\s*$/.test(clause)) continue;
    return true;
  }
  return false;
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

  if (hasThirdPersonSelfReference(draft.text)) {
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
