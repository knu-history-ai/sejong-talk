import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import { loadTs } from "./helpers/load-ts.mjs";

const { handleTurn, handleRequest } = loadTs("src/server/ai/http.ts");
const { getSessionStore } = loadTs("src/server/sessions/runtime.ts");
const origin = "http://localhost:3000";
const request = (token, body, method = "POST") => new NextRequest(`${origin}/api/turns`, {
  method, headers: { origin, host: "localhost:3000", cookie: `sejong_session=${token}`, "content-type": "application/json" },
  ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
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
