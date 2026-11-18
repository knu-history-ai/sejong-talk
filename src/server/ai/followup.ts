import type { Fact } from "../../contracts";
import { selectReviewedFactsForQuestion, type SejongKnowledgeBase } from "../content/sejong.ts";
import type { RecentApprovedTurn } from "./prompt";

export interface FactSelection {
  facts: Fact[];
  needsClarification: boolean;
}

const REFERENCE = /(?:거기|그곳|그것|그거|그때|그 사람|그분)/u;
// Only carry a topic for bounded, standalone follow-ups. Mixed/new subjects
// must not be silently interpreted as the previous subject.
const SHORT_FOLLOWUP = /^(?:(?:그러면|그럼)\s*)?(?:거기|그곳|그것|그거|그때|그 사람|그분)(?:에서는|서는|에서|에는|에|은|는|이|가|을|를)?\s*(?:(?:뭘|무엇을|무슨 일(?:을)?|어떤 일(?:을)?)\s*(?:했어|했나요|했어요|하는 곳이야)|(?:왜|어떻게|언제)\s*(?:만들었어|만들었나요|생겼어|그랬어)|(?:더|조금 더)\s*(?:알려줘|설명해줘)|(?:뭐야|무엇인가요))[?.!\s]*$/u;

function topicAnchors(fact: Fact): string[] {
  return fact.topic.split(/\s+/u).filter((word) => word.length >= 2 &&
    !["세종", "학문", "연구", "인재", "양성", "목적", "창제", "처음", "글자", "날짜"].includes(word));
}

function usableFacts(kb: SejongKnowledgeBase): Fact[] {
  const sources = new Set(kb.sources.map((source) => source.id));
  return kb.facts.filter((fact) => fact.characterId === kb.character.id &&
    fact.reviewStatus === "approved" && fact.sourceIds.length > 0 &&
    fact.sourceIds.every((id) => sources.has(id)));
}

export function selectFactsForTurn(
  knowledgeBase: SejongKnowledgeBase,
  question: string,
  recentConversation: RecentApprovedTurn[] = [],
): FactSelection {
  const kb = { ...knowledgeBase, facts: usableFacts(knowledgeBase) };
  const direct = selectReviewedFactsForQuestion(kb, question, 6);
  if (!REFERENCE.test(question)) return { facts: direct, needsClarification: false };
  // An explicit new topic wins; no previous fact IDs are appended.
  if (direct.some((fact) => topicAnchors(fact).some((word) => question.includes(word))) && !SHORT_FOLLOWUP.test(question.trim())) {
    return { facts: direct, needsClarification: false };
  }
  const unclear = { facts: [], needsClarification: true };
  if (!SHORT_FOLLOWUP.test(question.trim())) return unclear;

  const history = recentConversation.slice(-10);
  const latest = history.at(-1);
  if (!latest || latest.answer.kind !== "grounded") return unclear;
  const ids = new Set(latest.answer.factIds);
  const facts = kb.facts.filter((fact) => ids.has(fact.id));
  // Revocation/deletion or incomplete sources invalidate the context entirely.
  if (facts.length === 0 || facts.length !== ids.size || facts.length > 6) return unclear;
  // Find a recent explicit question through an uninterrupted chain of the same
  // grounded topic. Never inspect the previous model's answer text as evidence.
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    if (turn.answer.kind !== "grounded" || turn.answer.factIds.length !== ids.size ||
        !turn.answer.factIds.every((id) => ids.has(id))) return unclear;
    if (SHORT_FOLLOWUP.test(turn.question.trim())) continue;
    const selected = selectReviewedFactsForQuestion(kb, turn.question);
    if (!facts.every((fact) => selected.some((item) => item.id === fact.id))) return unclear;
    // A common named topic must occur in both the question and every cited card.
    // Multi-topic questions without such an anchor are deliberately clarified.
    const anchors = topicAnchors(facts[0]);
    const topicQuestion = turn.question.replace(/한글/gu, "훈민정음");
    const sameTopic = anchors.some((word) => topicQuestion.includes(word) &&
      // A reply citing just one of several topics does not disambiguate "there".
      selected.every((fact) => fact.topic.split(/\s+/u).includes(word)));
    return sameTopic ? { facts, needsClarification: false } : unclear;
  }
  return unclear;
}
