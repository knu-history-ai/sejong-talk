import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import { loadTs } from "./helpers/load-ts.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { handleTurn, handleRequest } = loadTs("src/server/ai/http.ts");
const { getSessionStore } = loadTs("src/server/sessions/runtime.ts");
const { getUsageLedger } = loadTs("src/server/usage/runtime.ts");
test.beforeEach((t) => {
  const directory = mkdtempSync(join(tmpdir(), "sejong-chat-http-"));
  const settings = { USAGE_DB_PATH: join(directory, "test.sqlite"), USAGE_PROVIDER_PLANS: "{}", OLLAMA_MODEL: "qwen3.5:4b-q4_K_M", USAGE_SESSION_PER_MINUTE: "6" };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  const oldLedger = globalThis.sejongUsageLedger;
  delete globalThis.sejongUsageLedger;
  Object.assign(process.env, settings);
  t.after(() => {
    globalThis.sejongUsageLedger?.close();
    if (oldLedger) globalThis.sejongUsageLedger = oldLedger; else delete globalThis.sejongUsageLedger;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(directory, { recursive: true, force: true });
  });
});
const origin = "http://localhost:3000";
const request = (token, body, method = "POST") => new NextRequest(`${origin}/api/turns`, {
  method, headers: { origin, host: "localhost:3000", cookie: `sejong_session=${token}`, "content-type": "application/json" },
  ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
});

test("real generation pipeline returns grounded sources, carries history and meters each provider call", async (t) => {
  process.env.USAGE_PROVIDER_PLANS = JSON.stringify({ "ollama:llm_generation": { mode: "free", maxCostMicros: 0 }, "ollama:llm_verification": { mode: "free", maxCostMicros: 0 } });
  const prompts = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    prompts.push(JSON.parse(init.body).prompt);
    if (prompts.at(-1).startsWith("역사 답변 공개 전")) return Response.json({ response: JSON.stringify({ verdict: "supported", factIds: ["sejong_hunminjeongeum_purpose"] }), prompt_eval_count: 20, eval_count: 4 });
    return Response.json({ response: JSON.stringify({ kind: "grounded", text: "백성들이 쉽게 뜻을 적도록 새 글자를 만들었단다.", factIds: ["sejong_hunminjeongeum_purpose"] }), prompt_eval_count: 10, eval_count: 5 });
  });
  const { token } = getSessionStore().create();
  try {
    const first = { requestId: "grounded-first", text: "훈민정음은 왜 만들었나요?" };
    const response = await handleTurn(request(token, first));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, "approved");
    assert.equal(result.answer.kind, "grounded");
    assert.ok(result.answer.answerId);
    assert.ok(result.answer.sources[0].url.startsWith("https://"));
    await handleTurn(request(token, first));
    assert.equal(prompts.length, 2);
    await handleTurn(request(token, { requestId: "grounded-second", text: "훈민정음 창제 목적을 다시 알려주세요." }));
    assert.equal(prompts.length, 4);
    assert.ok(prompts[2].includes(first.text));
    assert.ok(!prompts[2].includes(result.answer.text));
    const calls = getUsageLedger().snapshot().calls;
    assert.equal(calls.length, 4);
    assert.equal(calls.filter((call) => call.stage === "llm_verification").length, 2);
    assert.ok(calls.filter((call) => call.stage === "llm_verification").every((call) => JSON.parse(call.units).totalTokens === 24));
    assert.equal(getSessionStore().authenticate(token, false).getRecentTurns().length, 2);
  } finally { getSessionStore().revoke(token); }
});

test("#74 real session follow-up preserves evidence; other/reset sessions clarify without provider calls", async (t) => {
  process.env.USAGE_PROVIDER_PLANS = JSON.stringify({ "ollama:llm_generation": { mode: "free", maxCostMicros: 0 }, "ollama:llm_verification": { mode: "free", maxCostMicros: 0 } });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    const prompt = JSON.parse(init.body).prompt;
    const response = prompt.startsWith("역사 답변 공개 전")
      ? { verdict: "supported", factIds: ["sejong_jiphyeonjeon_learning"] }
      : { kind: "grounded", text: "집현전에서는 학문을 연구하고 인재를 길렀단다.", factIds: ["sejong_jiphyeonjeon_learning"] };
    return Response.json({ response: JSON.stringify(response), prompt_eval_count: 10, eval_count: 5 });
  });
  const store = getSessionStore();
  const { token } = store.create();
  const { token: other } = store.create();
  let fresh;
  try {
    const first = await (await handleTurn(request(token, { requestId: "topic", text: "집현전은 어떤 곳이야?" }))).json();
    const next = await (await handleTurn(request(token, { requestId: "follow", text: "거기서는 뭘 했어?" }))).json();
    assert.equal(next.answer.kind, "grounded");
    assert.deepEqual(next.answer.factIds, first.answer.factIds);
    assert.deepEqual(next.answer.sources, first.answer.sources);
    assert.equal(calls, 4);
    const separate = await (await handleTurn(request(other, { requestId: "other", text: "거기서는 뭘 했어?" }))).json();
    assert.equal(separate.answer.kind, "insufficient");
    assert.match(separate.answer.text, /이름을 알려/);
    fresh = store.create(token).token;
    assert.equal((await handleTurn(request(token, { requestId: "expired", text: "거기서는 뭘 했어?" }))).status, 401);
    const reset = await (await handleTurn(request(fresh, { requestId: "fresh", text: "거기서는 뭘 했어?" }))).json();
    assert.equal(reset.answer.kind, "insufficient");
    assert.deepEqual(reset.answer.factIds, []);
    assert.equal(calls, 4);
  } finally { store.revoke(token); store.revoke(other); if (fresh) store.revoke(fresh); }
});

test("#75 missing verification permission and provider failure cannot publish generated text", async (t) => {
  const unsafeText = "백성을 위해 훈민정음을 만들었고 스마트폰도 만들었단다.";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    if (JSON.parse(init.body).prompt.startsWith("역사 답변 공개 전")) return new Response("private provider failure", { status: 500 });
    return Response.json({ response: JSON.stringify({ kind: "grounded", text: unsafeText, factIds: ["sejong_hunminjeongeum_purpose"] }) });
  });
  for (const permitted of [false, true]) {
    delete globalThis.sejongUsageLedger;
    process.env.USAGE_DB_PATH += permitted ? "-allowed" : "-denied";
    process.env.USAGE_PROVIDER_PLANS = JSON.stringify({ "ollama:llm_generation": { mode: "free", maxCostMicros: 0 },
      ...(permitted ? { "ollama:llm_verification": { mode: "free", maxCostMicros: 0 } } : {}) });
    const { token } = getSessionStore().create();
    try {
      const result = await (await handleTurn(request(token, { requestId: `verification-${permitted}`, text: "훈민정음은 왜 만들었어?" }))).json();
      assert.equal(result.answer.kind, "fallback");
      assert.notEqual(result.answer.text, unsafeText);
      assert.deepEqual(result.answer.factIds, []); assert.deepEqual(result.answer.sources, []);
      const records = getUsageLedger().snapshot().calls.filter((call) => call.stage === "llm_verification");
      assert.equal(records.length, permitted ? 1 : 0);
      if (permitted) assert.equal(records[0].status, "failed");
    } finally { getSessionStore().revoke(token); getUsageLedger().close(); delete globalThis.sejongUsageLedger; }
  }
  assert.equal(calls, 3); // generation twice; verification only when permitted, no retry
});

test("#75 cancellation while verifying aborts provider and stores no answer", async (t) => {
  process.env.USAGE_PROVIDER_PLANS = JSON.stringify({ "ollama:llm_generation": { mode: "free", maxCostMicros: 0 }, "ollama:llm_verification": { mode: "free", maxCostMicros: 0 } });
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let upstreamSignal;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (JSON.parse(init.body).prompt.startsWith("역사 답변 공개 전")) {
      upstreamSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
        started();
      });
    }
    return Response.json({ response: JSON.stringify({ kind: "grounded", text: "백성들을 위해 훈민정음을 만들었단다.", factIds: ["sejong_hunminjeongeum_purpose"] }) });
  });
  const { token } = getSessionStore().create();
  try {
    const running = handleTurn(request(token, { requestId: "cancel-verify", text: "훈민정음은 왜 만들었어?" }));
    await ready;
    handleRequest(request(token, null, "DELETE"), "cancel-verify", true);
    assert.equal((await (await running).json()).status, "cancelled");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(upstreamSignal.aborted, true);
    assert.equal(getSessionStore().authenticate(token, false).getRecentTurns().length, 0);
    assert.equal(getUsageLedger().snapshot().calls.find((call) => call.stage === "llm_verification").status, "cancelled");
  } finally { getSessionStore().revoke(token); }
});

test("per-session usage limit rejects the next turn without running generation", async () => {
  process.env.USAGE_SESSION_PER_MINUTE = "1";
  const { token } = getSessionStore().create();
  let calls = 0;
  const generate = async ({ request: turn }) => { calls++; return { requestId: turn.requestId, operation: "turn", status: "approved", answer }; };
  try {
    await handleTurn(request(token, { requestId: "limit-first", text: "질문" }), generate);
    const blocked = await handleTurn(request(token, { requestId: "limit-second", text: "다음 질문" }), generate);
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).code, "LIMIT_EXCEEDED");
    assert.equal(calls, 1);
  } finally { getSessionStore().revoke(token); }
});
const answer = { answerId: "answer-test", kind: "conversation", text: "테스트 답변", sources: [], factIds: [], personaVersion: "test", contentVersion: "test" };

test("turn API authenticates, stores history once and does not rerun duplicates", async () => {
  const { token } = getSessionStore().create();
  try {
    let calls = 0;
    const generate = async ({ request: turn, recentConversation }) => {
      calls++;
      assert.equal(recentConversation.length, 0);
      return { requestId: turn.requestId, operation: "turn", status: "approved", answer };
    };
    const body = { requestId: "same-id", text: "안녕" };
    assert.equal((await handleTurn(request(token, body), generate)).status, 200);
    assert.equal((await handleTurn(request(token, body), generate)).status, 200);
    assert.equal(calls, 1);
    assert.equal(getSessionStore().authenticate(token, false).getRecentTurns().length, 1);
    assert.equal((await handleTurn(request(token, { ...body, text: "다른 질문" }), generate)).status, 409);
    const { token: other } = getSessionStore().create();
    assert.equal(handleRequest(request(other, null, "GET"), "same-id").status, 404);
    getSessionStore().revoke(other);
  } finally { getSessionStore().revoke(token); }
});

test("cancellation rejects late approved answers and invalid requests never call generation", async () => {
  const { token } = getSessionStore().create();
  try {
    let finish;
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const running = handleTurn(request(token, { requestId: "cancel-id", text: "질문" }), async ({ request: turn }) => {
      started();
      return new Promise((resolve) => { finish = () => resolve({ requestId: turn.requestId, operation: "turn", status: "approved", answer }); });
    });
    await ready;
    assert.equal((await handleRequest(request(token, null, "DELETE"), "cancel-id", true).json()).status, "cancelled");
    assert.equal((await (await running).json()).status, "cancelled");
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getSessionStore().authenticate(token, false).getRecentTurns().length, 0);
    assert.equal((await handleTurn(request(token, { requestId: "bad", text: "질문", history: [] }), () => { throw new Error("Must not call"); })).status, 400);
    assert.equal((await handleTurn(request("invalid", { requestId: "bad", text: "질문" }))).status, 401);
    assert.equal((await handleTurn(request(token, { requestId: "blocked", text: "질문" }))).status, 503);
  } finally { getSessionStore().revoke(token); }
});
