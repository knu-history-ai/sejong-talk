import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { SessionStore, IDLE_TIMEOUT_MS, ABSOLUTE_TIMEOUT_MS } from "../src/server/sessions/store.ts";

function harness(t, options = {}) {
  let now = 1_800_000_000_000;
  const store = new SessionStore({ now: () => now, ...options });
  const tokens = [];
  t.after(() => tokens.forEach(token => store.revoke(token)));
  return {
    store,
    create(previous) { const result = store.create(previous); tokens.push(result.token); return result; },
    advance(ms) { now += ms; },
  };
}
const expired = { code: "SESSION_EXPIRED", httpStatus: 401 };
function turn(id, userText = "한글은 왜 만들었나요?") {
  return { userText, answer: {
    answerId: id, kind: "conversation", text: "함께 알아보자.",
    factIds: [], sources: [], personaVersion: "test", contentVersion: "test",
  } };
}

test("each browser gets distinct public IDs and independent secret tokens", t => {
  const h = harness(t);
  const a = h.create(), b = h.create();
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.session.sessionId, b.session.sessionId);
  assert.notEqual(a.token, a.session.sessionId);
  for (const token of [undefined, "", a.session.sessionId, "A".repeat(43)]) {
    assert.throws(() => h.store.authenticate(token), expired);
  }
  assert.equal(h.store.authenticate(a.token).assertActive().sessionId, a.session.sessionId);
});

test("history and approved answers stay with their owner and return defensive copies", t => {
  const h = harness(t);
  const a = h.store.authenticate(h.create().token), b = h.store.authenticate(h.create().token);
  const input = turn("answer-a");
  a.appendApprovedTurn(input);
  input.answer.text = "mutated";
  assert.equal(a.getAnswer("answer-a").text, "함께 알아보자.");
  assert.equal(b.getAnswer("answer-a"), undefined);
  assert.deepEqual(b.getRecentTurns(), []);
  const copy = a.getRecentTurns(); copy[0].answer.text = "also mutated";
  assert.equal(a.getAnswer("answer-a").text, "함께 알아보자.");
  assert.throws(() => a.appendApprovedTurn(turn("answer-a")), { code: "REQUEST_CONFLICT" });
});

test("idle expiry is exactly 30 minutes and authenticated activity renews it", t => {
  const h = harness(t); const { token } = h.create();
  h.advance(IDLE_TIMEOUT_MS - 1);
  h.store.authenticate(token);
  h.advance(IDLE_TIMEOUT_MS - 1);
  assert.ok(h.store.authenticate(token, false));
  h.advance(1);
  assert.throws(() => h.store.authenticate(token), expired);
});

test("polling does not extend idle expiry and an expired token cannot be revived", t => {
  const h = harness(t); const { token } = h.create();
  h.advance(IDLE_TIMEOUT_MS - 1);
  h.store.authenticate(token, false);
  h.advance(1);
  assert.throws(() => h.store.authenticate(token), expired);
  assert.throws(() => h.store.authenticate(token), expired);
});

test("ongoing activity cannot extend the absolute four-hour lifetime", t => {
  const h = harness(t); const { token, session } = h.create();
  for (let elapsed = 20 * 60_000; elapsed < ABSOLUTE_TIMEOUT_MS; elapsed += 20 * 60_000) {
    h.advance(20 * 60_000);
    assert.ok(h.store.authenticate(token).assertActive().expiresAt <= session.createdAt + ABSOLUTE_TIMEOUT_MS);
  }
  h.advance(20 * 60_000);
  assert.throws(() => h.store.authenticate(token), expired);
});

test("reset aborts in-flight work and a retained handle cannot read or publish late results", async t => {
  const h = harness(t); const { token } = h.create();
  const handle = h.store.authenticate(token);
  handle.appendApprovedTurn(turn("before"));
  const lateResult = Promise.resolve(turn("late"));
  h.store.revoke(token);
  assert.equal(handle.signal.aborted, true);
  assert.throws(() => handle.getRecentTurns(), expired);
  assert.throws(() => handle.getAnswer("before"), expired);
  const result = await lateResult;
  assert.throws(() => handle.appendApprovedTurn(result), expired);
  assert.throws(() => handle.assertActive(), expired);
  assert.doesNotThrow(() => h.store.revoke(token));
});

test("replacement invalidates the old session at capacity without affecting other users", t => {
  const h = harness(t, { maxSessions: 2 });
  const a = h.create(), b = h.create();
  const old = h.store.authenticate(a.token);
  const fresh = h.create(a.token);
  assert.equal(old.signal.aborted, true);
  assert.throws(() => h.store.authenticate(a.token), expired);
  assert.deepEqual(h.store.authenticate(fresh.token).getRecentTurns(), []);
  assert.equal(h.store.authenticate(b.token).assertActive().sessionId, b.session.sessionId);
});

test("capacity does not evict active users; deletion and expiry free slots", t => {
  const h = harness(t, { maxSessions: 1 });
  const first = h.create();
  assert.throws(() => h.create(), { code: "UNAVAILABLE", httpStatus: 503 });
  assert.throws(() => h.create("A".repeat(43)), { code: "UNAVAILABLE" });
  assert.ok(h.store.authenticate(first.token));
  h.advance(IDLE_TIMEOUT_MS);
  const second = h.create();
  h.store.revoke(second.token);
  assert.ok(h.create());
});

test("expiry frees private data and aborts work even without a later HTTP request", async t => {
  const h = harness(t, { now: Date.now, idleTimeoutMs: 25 });
  const { token } = h.create();
  const handle = h.store.authenticate(token);
  await delay(60);
  assert.equal(handle.signal.aborted, true);
  assert.throws(() => handle.getRecentTurns(), expired);
});

test("a fresh store after restart rejects previously issued credentials", t => {
  const h = harness(t); const { token } = h.create();
  const restarted = new SessionStore();
  assert.throws(() => restarted.authenticate(token), expired);
});

test("conversation storage is bounded and old answers remain available within the session", t => {
  const h = harness(t); const handle = h.store.authenticate(h.create().token);
  for (let i = 0; i < 30; i++) handle.appendApprovedTurn(turn("answer-" + i));
  assert.equal(handle.getRecentTurns().length, 10);
  assert.equal(handle.getRecentTurns()[0].answer.answerId, "answer-20");
  assert.equal(handle.getAnswer("answer-0").answerId, "answer-0");
  assert.throws(() => handle.appendApprovedTurn(turn("answer-30")), { code: "LIMIT_EXCEEDED" });
});

test("oversized stored inputs and answer metadata cannot exhaust unbounded memory", t => {
  const h = harness(t); const handle = h.store.authenticate(h.create().token);
  const oversizedAnswer = turn("long");
  oversizedAnswer.answer.text = "x".repeat(401);
  const oversizedMetadata = turn("metadata");
  oversizedMetadata.answer.sources = [{ id: "x".repeat(16_000) }];
  for (const input of [turn("empty", " "), turn("long-question", "x".repeat(501)), oversizedAnswer, oversizedMetadata]) {
    assert.throws(() => handle.appendApprovedTurn(input), { code: "INVALID_INPUT" });
  }
  assert.deepEqual(handle.getRecentTurns(), []);
});
