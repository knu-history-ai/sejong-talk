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
  const settings = { USAGE_DB_PATH: join(directory, "test.sqlite"), USAGE_PROVIDER_PLANS: "{}", GEMINI_API_KEY: "test-key", USAGE_SESSION_PER_MINUTE: "6" };
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
  process.env.USAGE_PROVIDER_PLANS = JSON.stringify({ "gemini:llm_generation": { mode: "free", maxCostMicros: 0 } });
  const prompts = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    prompts.push(JSON.parse(init.body).contents[0].parts[0].text);
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ kind: "grounded", text: "백성들이 쉽게 뜻을 적도록 새 글자를 만들었단다.", factIds: ["sejong_hunminjeongeum_purpose"] }) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } });
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
    assert.equal(prompts.length, 1);
    await handleTurn(request(token, { requestId: "grounded-second", text: "훈민정음 창제 목적을 다시 알려주세요." }));
    assert.equal(prompts.length, 2);
    assert.ok(prompts[1].includes(result.answer.text));
    assert.equal(getUsageLedger().snapshot().calls.length, 2);
    assert.equal(getSessionStore().authenticate(token, false).getRecentTurns().length, 2);
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
