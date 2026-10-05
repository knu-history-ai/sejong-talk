import { readFile } from "node:fs/promises";

import type { Character, Fact, PromptExample, Source, SourceView } from "../../contracts";

export interface SejongKnowledgeBase {
  character: Character;
  facts: Fact[];
  sources: Source[];
  promptExamples: PromptExample[];
  contentVersion: string;
}

const DATA_DIR = new URL("../../../data/characters/sejong/", import.meta.url);
const DEFAULT_CONTENT_VERSION = "sejong-content-v1";

async function readJson<T>(path: string): Promise<T> {
  const contents = await readFile(new URL(path, DATA_DIR), "utf-8");
  return JSON.parse(contents) as T;
}

export async function loadSejongKnowledgeBase(): Promise<SejongKnowledgeBase> {
  const [character, facts, sources, promptExamples] = await Promise.all([
    readJson<Character>("character.json"),
    readJson<Fact[]>("facts.json"),
    readJson<Source[]>("sources.json"),
    readJson<PromptExample[]>("examples.json"),
  ]);

  return {
    character,
    facts,
    sources,
    promptExamples,
    contentVersion: DEFAULT_CONTENT_VERSION,
  };
}

function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^0-9a-z가-힣]+/u)
    .map((token) => token.replace(/(?:에서는|에서도|에게서|으로부터|으로는|에서|으로|에게|부터|까지|은|는|이|가|을|를|의|에|와|과|도|만)$/u, ""))
    .filter((token) => token.length >= 2);
  // Normalize only known topic aliases and question cues; keep unrelated words intact.
  if (tokens.includes("한글")) tokens.push("훈민정음");
  if (tokens.includes("훈민정음")) tokens.push("한글");
  if (/(?:왜|이유|목적)/u.test(text)) tokens.push("목적");
  return [...new Set(tokens)];
}

function scoreFact(questionTokens: string[], fact: Fact): number {
  const haystack = `${fact.topic} ${fact.text}`.toLowerCase();
  return questionTokens.reduce(
    (score, token) => score + (haystack.includes(token) ? 1 : 0),
    0,
  );
}

export function selectReviewedFactsForQuestion(
  knowledgeBase: SejongKnowledgeBase,
  question: string,
  maxFacts = 6,
): Fact[] {
  const questionTokens = tokenize(question);
  if (questionTokens.length === 0) {
    return [];
  }

  return knowledgeBase.facts
    .filter(
      (fact) =>
        fact.characterId === knowledgeBase.character.id &&
        fact.reviewStatus === "approved",
    )
    .map((fact) => ({ fact, score: scoreFact(questionTokens, fact) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.fact.id.localeCompare(b.fact.id))
    .slice(0, maxFacts)
    .map(({ fact }) => fact);
}

export function findSourceViewsForFacts(
  knowledgeBase: SejongKnowledgeBase,
  facts: Pick<Fact, "sourceIds">[],
): SourceView[] {
  const sourceIds = new Set(facts.flatMap((fact) => fact.sourceIds));
  return knowledgeBase.sources
    .filter((source) => sourceIds.has(source.id))
    .map(({ id, title, institution, url }) => ({ id, title, institution, url }));
}

export function findFactsById(
  knowledgeBase: SejongKnowledgeBase,
  factIds: string[],
): Fact[] {
  const requested = new Set(factIds);
  return knowledgeBase.facts.filter((fact) => requested.has(fact.id));
}
