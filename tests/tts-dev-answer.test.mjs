import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import { loadTs } from "./helpers/load-ts.mjs";

const { SessionStore } = loadTs("src/server/sessions/store.ts");
const { prepareTtsTestAnswer } = loadTs("src/server/tts/dev-answer.ts");
const origin = "https://sejong.example";

function harness(t) {
  const saved = { NODE_ENV: process.env.NODE_ENV, APP_ORIGIN: process.env.APP_ORIGIN };
  process.env.NODE_ENV = "development";
  process.env.APP_ORIGIN = origin;
  const store = new SessionStore();
  const { token } = store.create();
  t.after(() => {
    store.revoke(token);
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return {
    store, token,
    request(options = {}) {
      return new NextRequest(origin + "/api/dev/tts-answer", {
        method: "POST", ...options,
        headers: { origin, cookie: `__Host-sejong_session=${token}`, ...options.headers },
      });
    },
  };
}

test("a fixed greeting is stored in the authenticated session, once only", async (t) => {
  const h = harness(t);
  const response = await prepareTtsTestAnswer(h.request(), h.store);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.sessionId, h.store.authenticate(h.token).assertActive().sessionId);
  assert.equal(body.answer.text, "반갑구나. 무엇이 궁금하니?");
  assert.equal(body.answer.kind, "conversation");
  assert.deepEqual(h.store.authenticate(h.token).getAnswer(body.answer.answerId), body.answer);
  assert.equal((await prepareTtsTestAnswer(h.request({ body: "" }), h.store)).status, 200);
  assert.equal(h.store.authenticate(h.token).getRecentTurns().length, 1);
});

test("production/test modes cannot register any answer", async (t) => {
  const h = harness(t);
  for (const mode of ["production", "test"]) {
    process.env.NODE_ENV = mode;
    assert.equal((await prepareTtsTestAnswer(h.request(), h.store)).status, 404);
  }
  assert.equal(h.store.authenticate(h.token).getRecentTurns().length, 0);
});

test("client text, foreign origins and missing credentials cannot register answers", async (t) => {
  const h = harness(t);
  for (const [options, status] of [
    [{ body: '{"text":"unreviewed text"}' }, 400],
    [{ headers: { origin: "https://foreign.example" } }, 403],
    [{ headers: { cookie: "" } }, 401],
  ]) {
    assert.equal((await prepareTtsTestAnswer(h.request(options), h.store)).status, status);
  }
  assert.equal(h.store.authenticate(h.token).getRecentTurns().length, 0);
});

test("reset while an empty request is streaming cannot register a late answer", async (t) => {
  const h = harness(t);
  let controller;
  const req = h.request({ duplex: "half", body: new ReadableStream({ start(stream) { controller = stream; } }) });
  const pending = prepareTtsTestAnswer(req, h.store);
  h.store.revoke(h.token);
  controller.close();
  assert.equal((await pending).status, 401);
});
