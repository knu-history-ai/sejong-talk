import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.mjs";

const { SessionStore, IDLE_TIMEOUT_MS } = loadTs("src/server/sessions/store.ts");
const { ApprovedSpeechStore } = loadTs("src/server/tts/approved-speech.ts");

function harness(t, synthesize) {
  let now = 1_800_000_000_000;
  const sessions = new SessionStore({ now: () => now });
  const tokens = [];
  t.after(() => tokens.forEach((token) => sessions.revoke(token)));
  return {
    sessions,
    speech: new ApprovedSpeechStore(synthesize),
    create() {
      const { token } = sessions.create();
      tokens.push(token);
      return { token, handle: sessions.authenticate(token) };
    },
    advance(ms) { now += ms; },
  };
}

function approve(handle, answerId = "answer-1", text = "반갑구나.") {
  handle.appendApprovedTurn({
    userText: "안녕하세요",
    answer: {
      answerId, text, kind: "conversation", factIds: [], sources: [],
      personaVersion: "test", contentVersion: "test",
    },
  });
}

function audio(answer) {
  return { answerId: answer.answerId, audio: Uint8Array.from([1, 2, 3]), mimeType: "audio/mpeg" };
}

test("synthesizes the stored approved text and reuses audio across session handles", async (t) => {
  const calls = [];
  const h = harness(t, async (answer, signal) => {
    calls.push({ answer, signal });
    return audio(answer);
  });
  const { token, handle } = h.create();
  approve(handle);

  assert.equal(h.speech.getAudio(handle, "answer-1"), undefined);
  const first = await h.speech.getOrCreate(handle, "answer-1");
  const second = await h.speech.getOrCreate(h.sessions.authenticate(token, false), "answer-1");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].answer.text, "반갑구나.");
  assert.equal(calls[0].signal, handle.signal);
  assert.equal(first, second);
  assert.equal(h.speech.getAudio(handle, "answer-1"), first);
});

test("unknown, unapproved and another session's answers never reach synthesis", async (t) => {
  let calls = 0;
  const h = harness(t, async (answer) => { calls += 1; return audio(answer); });
  const owner = h.create().handle;
  const other = h.create().handle;
  approve(owner);
  await h.speech.getOrCreate(owner, "answer-1");

  for (const [handle, id] of [[other, "answer-1"], [owner, "unknown"], [owner, "unapproved"]]) {
    await assert.rejects(h.speech.getOrCreate(handle, id), { code: "REQUEST_NOT_FOUND" });
    assert.throws(() => h.speech.getAudio(handle, id), { code: "REQUEST_NOT_FOUND" });
  }
  assert.equal(calls, 1);
});

test("the same answer ID in different sessions has independent audio", async (t) => {
  const texts = [];
  const h = harness(t, async (answer) => { texts.push(answer.text); return audio(answer); });
  const first = h.create().handle;
  const second = h.create().handle;
  approve(first, "shared-id", "첫 번째 답변.");
  approve(second, "shared-id", "두 번째 답변.");

  const firstAudio = await h.speech.getOrCreate(first, "shared-id");
  const secondAudio = await h.speech.getOrCreate(second, "shared-id");
  assert.deepEqual(texts, ["첫 번째 답변.", "두 번째 답변."]);
  assert.notEqual(firstAudio, secondAudio);
});

test("concurrent requests share pending synthesis and do not expose incomplete audio", async (t) => {
  let calls = 0;
  let release;
  const h = harness(t, (answer) => {
    calls += 1;
    return new Promise((resolve) => { release = () => resolve(audio(answer)); });
  });
  const { handle } = h.create();
  approve(handle);

  const first = h.speech.getOrCreate(handle, "answer-1");
  const second = h.speech.getOrCreate(handle, "answer-1");
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(h.speech.getAudio(handle, "answer-1"), undefined);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results[0], results[1]);
});

test("a synchronous provider failure is removed so the user can retry", async (t) => {
  let calls = 0;
  const h = harness(t, (answer) => {
    if (++calls === 1) throw new Error("Synthesis failed");
    return Promise.resolve(audio(answer));
  });
  const { handle } = h.create();
  approve(handle);

  await assert.rejects(h.speech.getOrCreate(handle, "answer-1"), /Synthesis failed/);
  assert.equal(h.speech.getAudio(handle, "answer-1"), undefined);
  assert.deepEqual((await h.speech.getOrCreate(handle, "answer-1")).audio, Uint8Array.from([1, 2, 3]));
  assert.equal(calls, 2);
});

test("reset aborts the provider signal and rejects its late result", async (t) => {
  let release;
  let providerSignal;
  const h = harness(t, (answer, signal) => {
    providerSignal = signal;
    return new Promise((resolve) => { release = () => resolve(audio(answer)); });
  });
  const { token, handle } = h.create();
  approve(handle);
  const pending = h.speech.getOrCreate(handle, "answer-1");
  const rejected = assert.rejects(pending, { code: "SESSION_EXPIRED" });
  await Promise.resolve();

  h.sessions.revoke(token);
  assert.equal(providerSignal.aborted, true);
  release(); // The mock deliberately ignores abort, like a late upstream response.
  await rejected;
  assert.throws(() => h.speech.getAudio(handle, "answer-1"), { code: "SESSION_EXPIRED" });
});

test("a provider abort caused by reset is reported as session expiry", async (t) => {
  const h = harness(t, (_answer, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  const { token, handle } = h.create();
  approve(handle);
  const pending = h.speech.getOrCreate(handle, "answer-1");
  const rejected = assert.rejects(pending, { code: "SESSION_EXPIRED" });
  await Promise.resolve();

  h.sessions.revoke(token);
  await rejected;
});

test("idle expiry prevents reading cached audio or starting another synthesis", async (t) => {
  let calls = 0;
  const h = harness(t, async (answer) => { calls += 1; return audio(answer); });
  const { handle } = h.create();
  approve(handle);
  await h.speech.getOrCreate(handle, "answer-1");

  h.advance(IDLE_TIMEOUT_MS);
  assert.throws(() => h.speech.getAudio(handle, "answer-1"), { code: "SESSION_EXPIRED" });
  await assert.rejects(h.speech.getOrCreate(handle, "answer-1"), { code: "SESSION_EXPIRED" });
  assert.equal(handle.signal.aborted, true);
  assert.equal(calls, 1);
});
