import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.mjs";
import { hasUserText, mockAnswer, relayAnswer } from "../scripts/realtime-poc/answer-relay.mjs";
import { REQUIRED_CLIENT_EVENTS, buildEngineConfig } from "../scripts/realtime-poc/create-engine.mjs";

const { issueConversationToken, readTokenConfig, TokenRateLimit } = loadTs("src/server/realtime-poc/token.ts");

const enabled = readTokenConfig({
  REALTIME_POC_ENABLED: "1",
  ELEVENLABS_API_KEY: "test-key",
  ELEVENLABS_SPEECH_ENGINE_ID: "seng_abc123",
});

test("token route is off unless REALTIME_POC_ENABLED=1 and never calls upstream", async () => {
  let calls = 0;
  const result = await issueConversationToken(readTokenConfig({ ELEVENLABS_API_KEY: "k", ELEVENLABS_SPEECH_ENGINE_ID: "seng_1" }), new TokenRateLimit(5), async () => { calls += 1; });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "REALTIME_POC_DISABLED");
  assert.equal(calls, 0);
  const missing = await issueConversationToken(readTokenConfig({ REALTIME_POC_ENABLED: "1" }), new TokenRateLimit(5));
  assert.equal(missing.body.code, "REALTIME_POC_NOT_CONFIGURED");
});

test("token is requested with the server key and only the token is returned", async () => {
  const calls = [];
  const result = await issueConversationToken(enabled, new TokenRateLimit(5), async (url, init) => {
    calls.push({ url, init });
    return Response.json({ token: "conv_tok", conversation_id: "conv_1" });
  });
  assert.deepEqual(result, { ok: true, status: 200, body: { token: "conv_tok" } });
  assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=seng_abc123");
  assert.equal(calls[0].init.headers["xi-api-key"], "test-key");
  assert.ok(!JSON.stringify(result).includes("test-key"));
});

test("upstream errors are mapped without leaking the provider body", async () => {
  const rejected = await issueConversationToken(enabled, new TokenRateLimit(5), async () => new Response("secret account detail", { status: 401 }));
  assert.equal(rejected.status, 502);
  assert.ok(!rejected.body.message.includes("secret"));
  const down = await issueConversationToken(enabled, new TokenRateLimit(5), async () => { throw new TypeError("fetch failed"); });
  assert.equal(down.body.code, "UPSTREAM_UNAVAILABLE");
});

test("token issuing is rate limited per minute", async () => {
  let t = 0;
  const limit = new TokenRateLimit(2, () => t);
  const ok = async () => Response.json({ token: "x" });
  assert.equal((await issueConversationToken(enabled, limit, ok)).status, 200);
  assert.equal((await issueConversationToken(enabled, limit, ok)).status, 200);
  assert.equal((await issueConversationToken(enabled, limit, ok)).status, 429);
  t = 60_000;
  assert.equal((await issueConversationToken(enabled, limit, ok)).status, 200);
});

test("relay streams answer chunks and logs timing without transcript text", async () => {
  const logs = [];
  let t = 0;
  const out = [];
  const transcript = [{ role: "user", content: "비밀 질문 내용" }];
  for await (const piece of relayAnswer({
    transcript,
    signal: new AbortController().signal,
    answer: async function* () { t = 50; yield "가"; t = 80; yield "나"; },
    log: (r) => logs.push(r),
    now: () => t,
  })) out.push(piece);
  assert.deepEqual(out, ["가", "나"]);
  assert.equal(logs[0].outcome, "completed");
  assert.equal(logs[0].firstChunkMs, 50);
  assert.equal(logs[0].chars, 2);
  assert.ok(!JSON.stringify(logs).includes("비밀"));
});

test("barge-in aborts the generator: no more chunks and outcome=interrupted", async () => {
  const controller = new AbortController();
  const logs = [];
  const out = [];
  let generatorSawAbort = false;
  const answer = async function* ({ signal }) {
    yield "첫 조각";
    await new Promise((r) => setTimeout(r, 5));
    generatorSawAbort = signal.aborted;
    yield "끼어든 뒤 조각";
  };
  for await (const piece of relayAnswer({ transcript: [], signal: controller.signal, answer, log: (r) => logs.push(r) })) {
    out.push(piece);
    controller.abort();
  }
  assert.deepEqual(out, ["첫 조각"]);
  assert.equal(generatorSawAbort, true);
  assert.equal(logs[0].outcome, "interrupted");
});

test("generator errors are reported as failed, AbortError after barge-in as interrupted", async () => {
  const logs = [];
  await assert.rejects(async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _piece of relayAnswer({ transcript: [], signal: new AbortController().signal, answer: async function* () { throw new Error("bedrock down"); }, log: (r) => logs.push(r) }));
  }, /bedrock down/);
  assert.equal(logs[0].outcome, "failed");
  const c = new AbortController();
  c.abort();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _piece of relayAnswer({ transcript: [], signal: c.signal, answer: async function* () { throw Object.assign(new Error("x"), { name: "AbortError" }); }, log: (r) => logs.push(r) }));
  assert.equal(logs[1].outcome, "interrupted");
});

test("mock answer stops promptly when aborted", async () => {
  const c = new AbortController();
  const out = [];
  setTimeout(() => c.abort(), 15);
  for await (const piece of mockAnswer({ signal: c.signal, delayMs: 10 })) out.push(piece);
  assert.ok(out.length < 3);
});

test("only non-empty final user text triggers an answer", () => {
  assert.equal(hasUserText([{ role: "user", content: "안녕" }]), true);
  assert.equal(hasUserText([{ role: "user", content: "  " }]), false);
  assert.equal(hasUserText([{ role: "agent", content: "안녕" }]), false);
  assert.equal(hasUserText([]), false);
});

test("engine config is Korean, wss only, enables interruption events and no voice recording", () => {
  const config = buildEngineConfig({ wsUrl: "wss://example.trycloudflare.com/ws", env: {} });
  assert.equal(config.language, "ko");
  assert.equal(config.speechEngine.wsUrl, "wss://example.trycloudflare.com/ws");
  for (const name of ["interruption", "audio", "user_transcript", "agent_response"]) {
    assert.ok(config.conversation.clientEvents.includes(name), name);
  }
  assert.deepEqual(config.conversation.clientEvents, REQUIRED_CLIENT_EVENTS);
  assert.equal(config.privacy.recordVoice, false);
  assert.throws(() => buildEngineConfig({ wsUrl: "ws://localhost:3001/ws", env: {} }), /wss/);
});
