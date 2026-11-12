import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.mjs";

const { loadSejongKnowledgeBase } = loadTs("src/server/content/sejong.ts");
const { selectFactsForTurn } = loadTs("src/server/ai/followup.ts");
const { buildSejongPromptInput, buildSejongAnswerPrompt } = loadTs("src/server/ai/prompt.ts");
const { verifyForPublication, buildVerificationPrompt } = loadTs("src/server/ai/publication.ts");
const purpose = "sejong_hunminjeongeum_purpose";
const jiphyeon = "sejong_jiphyeonjeon_learning";
const previous = (question = "집현전은 어떤 곳이야?", factIds = [jiphyeon]) => ({ question,
  answer: { kind: "grounded", text: "집현전에서는 우주선을 만들었단다.", factIds } });
const verdict = (value, factIds = []) => async () => JSON.stringify({ verdict: value, factIds });
async function inputFor(text = "훈민정음은 왜 만들었어요?", history = [], kb) {
  kb ??= await loadSejongKnowledgeBase();
  const selection = selectFactsForTurn(kb, text, history);
  return buildSejongPromptInput({ knowledgeBase: kb, request: { requestId: "regression", text },
    reviewedFacts: selection.facts, recentConversation: history });
}
function hidden(result, original) {
  assert.equal(result.answer.kind, "fallback");
  assert.notEqual(result.answer.text, original);
  assert.deepEqual(result.answer.factIds, []);
  assert.deepEqual(result.answer.sources, []);
}

test("#74 short follow-up selects current approved evidence, not prior model text", async () => {
  const kb = await loadSejongKnowledgeBase();
  const history = [previous()];
  const selection = selectFactsForTurn(kb, "거기서는 뭘 했어?", history);
  assert.equal(selection.needsClarification, false);
  assert.deepEqual(selection.facts.map((fact) => fact.id), [jiphyeon]);
  const input = await inputFor("거기서는 뭘 했어?", history, kb);
  assert.doesNotMatch(buildSejongAnswerPrompt(input), /우주선/);
  const text = "집현전에서는 학문을 연구하고 인재를 길렀단다.";
  const result = await verifyForPublication({ kind: "grounded", text, factIds: [jiphyeon] }, input,
    { verify: verdict("supported", [jiphyeon]) });
  assert.equal(result.answer.kind, "grounded");
  assert.equal(result.answer.text, text);
  assert.deepEqual(result.answer.factIds, [jiphyeon]);
  assert.ok(result.answer.sources.length > 0);
});

test("#74 missing, ambiguous and interrupted context asks for clarification", async () => {
  const kb = await loadSejongKnowledgeBase();
  for (const history of [[], [previous("집현전과 훈민정음에 대해 알려줘", [jiphyeon, purpose])],
    [previous(), { question: "안녕", answer: { kind: "conversation", text: "안녕", factIds: [] } }],
    [previous("스마트폰은 뭐야?", [jiphyeon])], [previous("거기서는 뭘 했어?")]]) {
    assert.deepEqual(selectFactsForTurn(kb, "거기서는 뭘 했어?", history), { facts: [], needsClarification: true });
  }
  assert.equal(selectFactsForTurn(kb, "거기랑 스마트폰은 어떻게 달라?", [previous()]).needsClarification, true);
  assert.equal(selectFactsForTurn(kb, "거기서는 학문을 연구했어?", []).needsClarification, true);
});

test("#74 explicit topic switches and repeated follow-ups stay bounded", async () => {
  const kb = await loadSejongKnowledgeBase();
  const changed = selectFactsForTurn(kb, "훈민정음은 왜 만들었어요?", [previous()]);
  assert.ok(changed.facts.some((fact) => fact.id === purpose));
  assert.ok(changed.facts.every((fact) => fact.id !== jiphyeon));
  const history = [previous(), previous("거기서는 뭘 했어?")];
  assert.deepEqual(selectFactsForTurn(kb, "그곳에서는 뭘 했나요?", history).facts.map((fact) => fact.id), [jiphyeon]);
  assert.equal(selectFactsForTurn(kb, "거기서는 뭘 했어?", [previous(), ...Array.from({ length: 10 }, () => previous("거기서는 뭘 했어?"))]).needsClarification, true);
});

test("#74 revoked, deleted, foreign-character or source-less evidence is never reused", async () => {
  for (const mutate of [
    (kb) => { kb.facts.find((fact) => fact.id === jiphyeon).reviewStatus = "pending"; },
    (kb) => { kb.facts = kb.facts.filter((fact) => fact.id !== jiphyeon); },
    (kb) => { kb.facts.find((fact) => fact.id === jiphyeon).characterId = "other"; },
    (kb) => { kb.sources = []; },
  ]) {
    const kb = await loadSejongKnowledgeBase(); mutate(kb);
    assert.equal(selectFactsForTurn(kb, "거기서는 뭘 했어?", [previous()]).needsClarification, true);
  }
});

test("#75 historical falsehood cannot escape via any non-grounded kind", async () => {
  const input = await inputFor("안녕");
  const text = "훈민정음은 처음부터 24글자였단다.";
  for (const kind of ["conversation", "insufficient", "fallback"]) {
    const result = await verifyForPublication({ kind, text, factIds: [] }, input, { verify: verdict("unsupported") });
    assert.notEqual(result.answer.text, text);
    assert.deepEqual(result.answer.factIds, []);
    assert.deepEqual(result.answer.sources, []);
  }
});

test("#75 valid greetings and historical answers preserve text and sources", async () => {
  const input = await inputFor();
  for (const text of ["반갑구나. 오늘은 어떤 이야기를 할까?", "속상했겠구나. 천천히 이야기해 보렴."]) {
    const result = await verifyForPublication({ kind: "conversation", text, factIds: [] }, input, { verify: verdict("non_historical") });
    assert.equal(result.answer.kind, "conversation"); assert.equal(result.answer.text, text);
  }
  const text = "나는 백성들이 쉽게 뜻을 적도록 훈민정음을 만들었단다.";
  const result = await verifyForPublication({ kind: "grounded", text, factIds: [purpose] }, input, { verify: verdict("supported", [purpose]) });
  assert.equal(result.answer.text, text); assert.deepEqual(result.answer.factIds, [purpose]);
  assert.ok(result.answer.sources.length > 0);
});

test("#75 correct IDs do not approve extra claims; wrong IDs fail before verification", async () => {
  const input = await inputFor();
  const draft = { kind: "grounded", text: "백성을 위해 훈민정음을 만들었고 스마트폰도 만들었단다.", factIds: [purpose] };
  const rejected = await verifyForPublication(draft, input, { verify: verdict("unsupported") });
  hidden(rejected, draft.text); assert.equal(rejected.reason, "unsupported");
  const wrong = await verifyForPublication({ ...draft, factIds: ["unknown"] }, input, { verify: () => assert.fail("must not call verifier") });
  hidden(wrong, draft.text); assert.equal(wrong.reason, "invalid_facts");
  assert.match(buildVerificationPrompt(draft, input), /본문 전체/);
  assert.match(buildVerificationPrompt(draft, input), /자기 뜻/);
  assert.doesNotMatch(buildVerificationPrompt(draft, input), /우주선/);
});

test("#75 errors, malformed/incomplete verdicts and uncertainty fail closed", async () => {
  const input = await inputFor();
  const draft = { kind: "grounded", text: "나는 훈민정음을 만들었단다.", factIds: [purpose] };
  for (const verify of [async () => { throw new Error("private provider response"); }, async () => "not JSON",
    async () => '{"verdict":"supported"}', verdict("supported", ["unknown"]), verdict("supported", []), verdict("uncertain"), verdict("non_historical")]) {
    const result = await verifyForPublication(draft, input, { verify }); hidden(result, draft.text);
    assert.doesNotMatch(JSON.stringify(result), /private provider/);
  }
});

test("#75 verification deadline and cancellation cannot publish even if verifier ignores abort", async () => {
  const input = await inputFor();
  const draft = { kind: "grounded", text: "나는 훈민정음을 만들었단다.", factIds: [purpose] };
  let verificationSignal;
  const timeout = await verifyForPublication(draft, input, { timeoutMs: 10, verify: async (_prompt, signal) => {
    verificationSignal = signal; return new Promise(() => {});
  } });
  hidden(timeout, draft.text); assert.equal(timeout.reason, "verification_timeout"); assert.equal(verificationSignal.aborted, true);
  const controller = new AbortController();
  const pending = verifyForPublication(draft, input, { signal: controller.signal, verify: async () => new Promise(() => {}) });
  controller.abort();
  const cancelled = await pending; hidden(cancelled, draft.text); assert.equal(cancelled.reason, "cancelled");
});
