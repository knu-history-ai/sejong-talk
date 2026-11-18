import test from "node:test";
import assert from "node:assert/strict";
import { requestBedrockCandidate, BEDROCK_MODEL, BEDROCK_REGION } from "../src/server/ai/bedrock-request.ts";
import { createBedrockAnswer, generateBedrockVoiceAnswer } from "../src/server/ai/bedrock-answer.ts";

const usage = { inputTokens: 20, outputTokens: 10, totalTokens: 30 };
const input = (text = "훈민정음은 몇 글자야?") => ({ transcript: [{ role: "user", content: text }], signal: new AbortController().signal });
const grounded = { kind: "grounded", text: "훈민정음은 처음에 스물여덟 글자였단다.", factIds: ["sejong_hunminjeongeum_28_letters"] };
const candidate = (draft) => async () => ({ text: typeof draft === "string" ? draft : JSON.stringify(draft), usage });
const response = (text) => ({ output: { message: { role: "assistant", content: [{ text }] } }, stopReason: "end_turn", usage, $metadata: {} });
const collect = async (generator) => { const pieces = []; for await (const piece of generator) pieces.push(piece); return pieces; };

test("Tokyo Haiku request uses SDK cancellation, bounded output and observed usage", async () => {
  const metrics = [];
  const result = await requestBedrockCandidate("private-question", { send: async (command, options) => {
    assert.equal(BEDROCK_REGION, "ap-northeast-1");
    assert.equal(command.input.modelId, BEDROCK_MODEL);
    assert.equal(command.input.inferenceConfig.maxTokens, 1000);
    assert.ok(options.abortSignal instanceof AbortSignal);
    return response("private-answer");
  }, log: (event) => metrics.push(event) });
  assert.deepEqual(result.usage, usage);
  assert.equal(metrics[0].status, "completed");
  assert.doesNotMatch(JSON.stringify(metrics), /private-question|private-answer/);
});

for (const [name, code] of [["AccessDeniedException", "FORBIDDEN"], ["CredentialsProviderError", "FORBIDDEN"], ["ThrottlingException", "LIMIT_EXCEEDED"], ["ModelTimeoutException", "UPSTREAM_TIMEOUT"], ["Error", "UNAVAILABLE"]]) {
  test(`provider ${name} is sanitized and classified as ${code}`, async () => {
    const metrics = [];
    await assert.rejects(requestBedrockCandidate("question", { send: async () => { throw Object.assign(new Error("SECRET raw response"), { name }); }, log: (event) => metrics.push(event) }), (error) => error.code === code && !error.message.includes("SECRET") && !error.cause);
    assert.equal(metrics[0].status, "failed");
    assert.doesNotMatch(JSON.stringify(metrics), /SECRET/);
  });
}

test("pre-abort never calls model", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestBedrockCandidate("q", { signal: controller.signal, send: async () => { assert.fail("must not call"); } }), { code: "CANCELLED" });
});

for (const mode of ["cancel", "timeout"]) {
  test(`${mode} returns promptly and excludes late model completion`, async () => {
    const controller = new AbortController();
    let release, providerSignal;
    const metrics = [];
    const running = requestBedrockCandidate("q", { signal: controller.signal, timeoutMs: mode === "timeout" ? 10 : 1000,
      send: (_command, options) => { providerSignal = options.abortSignal; return new Promise((resolve) => { release = resolve; }); }, log: (event) => metrics.push(event) });
    if (mode === "cancel") controller.abort();
    await assert.rejects(running, { code: mode === "cancel" ? "CANCELLED" : "UPSTREAM_TIMEOUT" });
    assert.equal(providerSignal.aborted, true);
    release(response("late-secret"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].status, mode === "cancel" ? "cancelled" : "failed");
  });
}

test("truncated/empty provider responses are not accepted", async () => {
  for (const output of [{ ...response("text"), stopReason: "max_tokens" }, response("")]) {
    await assert.rejects(requestBedrockCandidate("q", { send: async () => output }), { code: "UNAVAILABLE" });
  }
});

test("approved answer retains sources and is published once after validation", async () => {
  const result = await generateBedrockVoiceAnswer(input(), { candidate: candidate(grounded) });
  assert.equal(result.serverStatus, "approved");
  assert.ok(result.answer.sources.length > 0);
  assert.deepEqual(result.answer.factIds, grounded.factIds);
  const log = [];
  const answer = createBedrockAnswer({ candidate: candidate(grounded), log: (event) => log.push(event) });
  assert.deepEqual(await collect(answer(input())), [grounded.text]);
  assert.equal(log[0].status, "approved");
  assert.doesNotMatch(JSON.stringify(log), /스물여덟/);
});

for (const draft of ["broken SECRET", { ...grounded, factIds: ["unknown"] }, { ...grounded, factIds: [...grounded.factIds, "unknown"] }, { ...grounded, text: "x".repeat(401) }, { kind: "fallback", text: "SECRET", factIds: [] }]) {
  test(`invalid candidate ${JSON.stringify(draft).slice(0, 60)} only publishes fixed fallback`, async () => {
    const result = await generateBedrockVoiceAnswer(input(), { candidate: candidate(draft) });
    assert.equal(result.serverStatus, "blocked");
    assert.equal(result.blockReason, "VALIDATION_FAILED");
    assert.equal(result.answer.kind, "fallback");
    assert.doesNotMatch(result.answer.text, /SECRET/);
    assert.deepEqual(result.answer.sources, []);
  });
}

test("insufficient evidence is distinct from validation/model failure and uses fixed guidance", async () => {
  const result = await generateBedrockVoiceAnswer(input(), { candidate: candidate({ kind: "insufficient", text: "SECRET", factIds: [] }) });
  assert.equal(result.blockReason, "INSUFFICIENT_EVIDENCE");
  assert.equal(result.validationStatus, "completed");
  assert.doesNotMatch(result.answer.text, /SECRET/);
});

test("cancelled late candidate is never published or logged as approved", async () => {
  const controller = new AbortController();
  let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  const logs = [];
  const answer = createBedrockAnswer({ candidate: () => { started(); return new Promise((resolve) => { release = resolve; }); }, log: (event) => logs.push(event) });
  const running = collect(answer({ ...input(), signal: controller.signal }));
  await ready; controller.abort(); release({ text: JSON.stringify(grounded), usage });
  assert.deepEqual(await running, []);
  assert.equal(logs[0].status, "cancelled");
});

test("history is request-local bounded context, never approved evidence", async () => {
  const prompts = [];
  const answer = createBedrockAnswer({ candidate: async (prompt) => { prompts.push(prompt); return candidate({ kind: "conversation", text: "반갑구나.", factIds: [] })(); } });
  await collect(answer({ ...input("안녕"), transcript: [{ role: "user", content: "prior-question" }, { role: "agent", content: "prior-answer" }, { role: "user", content: "안녕" }] }));
  await collect(answer(input("안녕")));
  assert.match(prompts[0], /prior-question/);
  assert.match(prompts[0], /최근 승인 대화\]\n- 최근 승인 대화 없음/);
  assert.doesNotMatch(prompts[1], /prior-question|prior-answer/);
});

test("empty transcript and cancelled-before-start produce no output or call", async () => {
  const answer = createBedrockAnswer({ candidate: async () => assert.fail("no call") });
  assert.deepEqual(await collect(answer({ ...input(), transcript: [] })), []);
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await collect(answer({ ...input(), signal: controller.signal })), []);
});
