import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.mjs";

const { voiceReducer, initialVoiceState } = loadTs("src/features/realtime-voice/voice-state.ts");
const { startSpeechEngineVoice, classifyMicError, fetchConversationToken, VoiceStartError } =
  loadTs("src/features/realtime-voice/speech-engine-client.ts");

const run = (events, from = initialVoiceState) => events.reduce(voiceReducer, from);
const live = run([
  { type: "start", at: 0 },
  { type: "micGranted" },
  { type: "connected", conversationId: "conv_1", at: 100 },
]);

test("start → mic → connected moves to listening and records connect time", () => {
  assert.equal(live.phase, "listening");
  assert.equal(live.conversationId, "conv_1");
  assert.equal(live.timing.connectedAt - live.timing.startedAt, 100);
});

test("user turn shows thinking, first audio shows speaking and measures latency once", () => {
  const s = run([
    { type: "userFinal", text: "훈민정음은 왜 만드셨나요?", at: 1000 },
    { type: "mode", mode: "listening", at: 1100 },
    { type: "mode", mode: "speaking", at: 1800 },
    { type: "mode", mode: "speaking", at: 2500 },
  ], live);
  assert.equal(s.phase, "speaking");
  assert.equal(s.timing.lastResponseLatencyMs, 800);
  assert.deepEqual(s.lines, [{ role: "user", text: "훈민정음은 왜 만드셨나요?" }]);
});

test("interruption during speaking returns to listening and counts it", () => {
  const speaking = run([{ type: "userFinal", text: "질문", at: 0 }, { type: "mode", mode: "speaking", at: 500 }], live);
  const s = run([{ type: "interruption", at: 900 }], speaking);
  assert.equal(s.phase, "listening");
  assert.equal(s.interruptions, 1);
  assert.equal(s.timing.lastInterruptionAt, 900);
  const next = run([{ type: "userFinal", text: "다른 질문", at: 1000 }], s);
  assert.equal(next.phase, "thinking");
  assert.equal(next.timing.lastResponseLatencyMs, null);
});

test("unexpected disconnect is an error, user stop is a clean end", () => {
  assert.deepEqual(
    [run([{ type: "disconnected", byUser: false }], live).phase, run([{ type: "disconnected", byUser: false }], live).error],
    ["error", "disconnected"],
  );
  const ended = run([{ type: "endRequested" }, { type: "disconnected", byUser: false }], live);
  assert.equal(ended.phase, "ended");
  assert.equal(ended.error, null);
});

test("late failure after the user pressed stop does not show an error", () => {
  const s = run([{ type: "endRequested" }, { type: "fail", code: "connectFailed" }], live);
  assert.equal(s.phase, "ending");
  assert.equal(s.error, null);
});

test("events while not live are ignored", () => {
  assert.equal(run([{ type: "mode", mode: "speaking", at: 1 }]).phase, "idle");
  assert.equal(run([{ type: "interruption", at: 1 }]).interruptions, 0);
});

test("microphone errors map to user-facing codes", () => {
  assert.equal(classifyMicError({ name: "NotAllowedError" }), "micDenied");
  assert.equal(classifyMicError({ name: "SecurityError" }), "micDenied");
  assert.equal(classifyMicError({ name: "NotFoundError" }), "micUnavailable");
  assert.equal(classifyMicError({ name: "NotReadableError" }), "micUnavailable");
});

test("token fetch posts same-origin and maps disabled/failed responses", async () => {
  const calls = [];
  const token = await fetchConversationToken(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ token: "tok_1" });
  });
  assert.equal(token, "tok_1");
  assert.equal(calls[0].url, "/api/realtime-poc/token");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "same-origin");
  await assert.rejects(
    fetchConversationToken(async () => Response.json({ code: "REALTIME_POC_DISABLED" }, { status: 503 })),
    (e) => e instanceof VoiceStartError && e.code === "pocDisabled",
  );
  await assert.rejects(
    fetchConversationToken(async () => Response.json({ code: "UPSTREAM_REJECTED" }, { status: 502 })),
    (e) => e.code === "tokenFailed",
  );
  await assert.rejects(fetchConversationToken(async () => { throw new TypeError("network"); }), (e) => e.code === "tokenFailed");
  await assert.rejects(fetchConversationToken(async () => Response.json({})), (e) => e.code === "tokenFailed");
});

function fakeStream() {
  const stopped = [];
  return { stopped, stream: { getTracks: () => [{ stop: () => stopped.push(true) }] } };
}

function harness({ mic, token = async () => Response.json({ token: "tok" }), secure = true } = {}) {
  const events = [];
  let callbacks = null;
  let ended = 0;
  const media = fakeStream();
  const deps = {
    isSecureContext: secure,
    getUserMedia: mic ?? (async () => media.stream),
    fetchImpl: token,
    now: () => events.length,
    startSession: async (options) => {
      callbacks = options;
      return { endSession: async () => { ended += 1; options.onDisconnect?.({ reason: "user" }); } };
    },
  };
  const state = () => events.reduce(voiceReducer, initialVoiceState);
  return { events, deps, state, media, get callbacks() { return callbacks; }, get ended() { return ended; } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("full session: mic released after check, WebRTC token passed, SDK events drive the state", async () => {
  const h = harness();
  const controller = startSpeechEngineVoice((e) => h.events.push(e), h.deps);
  await tick(); await tick();
  assert.equal(h.media.stopped.length, 1, "permission-check stream is released");
  assert.equal(h.callbacks.conversationToken, "tok");
  assert.equal(h.callbacks.connectionType, "webrtc");
  h.callbacks.onConnect({ conversationId: "conv_9" });
  h.callbacks.onMessage({ role: "user", message: "세종대왕님 안녕하세요" });
  h.callbacks.onModeChange({ mode: "speaking" });
  h.callbacks.onMessage({ role: "agent", source: "ai", message: "반갑구나." });
  h.callbacks.onInterruption({ event_id: 3 });
  assert.equal(h.state().phase, "listening");
  assert.equal(h.state().interruptions, 1);
  await controller.stop();
  await controller.stop();
  assert.equal(h.ended, 1, "endSession called exactly once");
  assert.equal(h.state().phase, "ended");
  assert.equal(h.state().error, null);
});

test("denied microphone stops before any token request", async () => {
  let tokenCalls = 0;
  const h = harness({
    mic: async () => { throw Object.assign(new Error("no"), { name: "NotAllowedError" }); },
    token: async () => { tokenCalls += 1; return Response.json({ token: "x" }); },
  });
  startSpeechEngineVoice((e) => h.events.push(e), h.deps);
  await tick(); await tick();
  assert.equal(tokenCalls, 0);
  assert.equal(h.state().phase, "error");
  assert.equal(h.state().error, "micDenied");
});

test("insecure page (http on a phone) reports insecureContext", async () => {
  const h = harness({ secure: false });
  startSpeechEngineVoice((e) => h.events.push(e), h.deps);
  await tick();
  assert.equal(h.state().error, "insecureContext");
});

test("SDK start failure shows connectFailed; stop during connect closes the late session", async () => {
  const h = harness();
  h.deps.startSession = async () => { throw new Error("webrtc failed"); };
  startSpeechEngineVoice((e) => h.events.push(e), h.deps);
  await tick(); await tick(); await tick();
  assert.equal(h.state().error, "connectFailed");

  const h2 = harness();
  let release;
  let ended = 0;
  h2.deps.startSession = () => new Promise((resolve) => { release = () => resolve({ endSession: async () => { ended += 1; } }); });
  const c = startSpeechEngineVoice((e) => h2.events.push(e), h2.deps);
  await tick(); await tick();
  const stopping = c.stop();
  release();
  await stopping;
  assert.equal(ended, 1);
  assert.equal(h2.state().phase, "ended");
});

test("dispose keeps the error screen while releasing the session", async () => {
  const h = harness();
  const c = startSpeechEngineVoice((e) => h.events.push(e), h.deps);
  await tick(); await tick();
  h.callbacks.onConnect({ conversationId: "c" });
  h.callbacks.onDisconnect({ reason: "error", message: "lost" });
  assert.equal(h.state().error, "disconnected");
  await c.dispose();
  assert.equal(h.ended, 1);
  assert.equal(h.state().phase, "error");
});
