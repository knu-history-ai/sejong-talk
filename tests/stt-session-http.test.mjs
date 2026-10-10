import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server.js";
import { loadTs } from "./helpers/load-ts.mjs";
import { mockMeteredCall } from "./helpers/usage-meter.mjs";

loadTs("src/server/usage/runtime.ts").runMeteredCall = mockMeteredCall;
const { SessionStore } = loadTs("src/server/sessions/store.ts");
const { TranscriptionHttp } = loadTs("src/server/stt/session-http.ts");
const origin = "https://sejong.example";

function wav(size = 64, fill = 20) {
  const data = Buffer.alloc(size); data.write("RIFF"); data.writeUInt32LE(size - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(size - 44, 40); data.fill(fill, 44);
  return new File([data], "recording.wav", { type: "audio/wav" });
}

function request(cookie, { audio = wav(), id = "stt-request-1", from = origin, signal } = {}) {
  const form = new FormData(); form.set("audio", audio); form.set("requestId", id);
  return new NextRequest(origin + "/api/transcriptions", {
    method: "POST", body: form, signal,
    headers: { origin: from, ...(cookie ? { cookie } : {}) },
  });
}

function harness(t, run = async (provider) => ({ provider, text: "세종대왕은 왜 훈민정음을 만들었나요?", latencyMs: 1, success: true })) {
  const saved = { APP_ORIGIN: process.env.APP_ORIGIN, STT_PROVIDER: process.env.STT_PROVIDER };
  process.env.APP_ORIGIN = origin;
  process.env.STT_PROVIDER = "azure";
  const sessions = new SessionStore();
  const tokens = [];
  t.after(() => {
    tokens.forEach((token) => sessions.revoke(token));
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  const calls = [];
  const http = new TranscriptionHttp(sessions, async (provider, audio, signal) => { calls.push({ provider, audio, signal }); return run(provider, audio, signal); });
  return {
    sessions, http, calls,
    create() { const { token } = sessions.create(); tokens.push(token); return { token, cookie: `__Host-sejong_session=${token}` }; },
  };
}

test("session-owned transcription returns the contract without audio, private and uncached", async (t) => {
  const h = harness(t);
  const owner = h.create();
  const response = await h.http.post(request(owner.cookie));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), {
    requestId: "stt-request-1", operation: "transcription", status: "completed", text: "세종대왕은 왜 훈민정음을 만들었나요?",
  });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].provider, "azure");
  assert.equal(h.calls[0].audio.type, "audio/wav");
});

test("missing session, foreign origin and missing provider are rejected before calling STT", async (t) => {
  const h = harness(t);
  const missing = await h.http.post(request(undefined));
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).code, "SESSION_EXPIRED");
  const owner = h.create();
  assert.equal((await h.http.post(request(owner.cookie, { from: "https://evil.example" }))).status, 403);
  delete process.env.STT_PROVIDER;
  const unavailable = await h.http.post(request(owner.cookie));
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, "UNAVAILABLE");
  assert.equal(h.calls.length, 0);
});

test("invalid audio maps to contract codes", async (t) => {
  const h = harness(t);
  const owner = h.create();
  const unsupported = await h.http.post(request(owner.cookie, { audio: new File(["text"], "a.txt", { type: "text/plain" }) }));
  assert.equal(unsupported.status, 415);
  assert.equal((await unsupported.json()).code, "AUDIO_UNSUPPORTED");
  const damaged = await h.http.post(request(owner.cookie, { audio: new File(["corrupted data here"], "a.wav", { type: "audio/wav" }) }));
  assert.equal(damaged.status, 400);
  assert.equal((await damaged.json()).code, "INVALID_INPUT");
  assert.equal(h.calls.length, 0);
});

test("duplicate request IDs share one call; different audio under the same ID conflicts", async (t) => {
  const h = harness(t);
  const owner = h.create();
  const [first, second] = await Promise.all([h.http.post(request(owner.cookie)), h.http.post(request(owner.cookie))]);
  assert.equal(h.calls.length, 1);
  assert.equal((await first.json()).status, "completed");
  assert.equal((await second.json()).status, "completed");
  const conflict = await h.http.post(request(owner.cookie, { audio: wav(100, 7) }));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "REQUEST_CONFLICT");
});

test("request IDs are scoped per session", async (t) => {
  const h = harness(t);
  const a = h.create(); const b = h.create();
  assert.equal((await h.http.post(request(a.cookie))).status, 200);
  assert.equal((await h.http.post(request(b.cookie, { audio: wav(100, 7) }))).status, 200);
  assert.equal(h.calls.length, 2);
});

test("session reset aborts the provider call and discards the late transcript", async (t) => {
  let release;
  const h = harness(t, (provider, _audio, signal) => new Promise((resolve) => {
    release = () => resolve({ provider, text: "늦게 도착한 인식문", latencyMs: 1, success: true });
    signal.addEventListener("abort", () => resolve({ provider, text: "", latencyMs: 1, success: false, error: "취소" }), { once: true });
  }));
  const owner = h.create();
  const pending = h.http.post(request(owner.cookie));
  while (!h.calls.length) await new Promise((resolve) => setImmediate(resolve));
  h.sessions.revoke(owner.token);
  assert.equal(h.calls[0].signal.aborted, true);
  release();
  const response = await pending;
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.code, "SESSION_EXPIRED");
  assert.ok(!JSON.stringify(body).includes("늦게"));
});

test("client abort cancels the provider call", async (t) => {
  const h = harness(t, (provider, _audio, signal) => new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ provider, text: "", latencyMs: 1, success: false, error: "취소" }), { once: true });
  }));
  const owner = h.create();
  const controller = new AbortController();
  const pending = h.http.post(request(owner.cookie, { signal: controller.signal }));
  while (!h.calls.length) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const body = await (await pending).json();
  assert.equal(body.status, "cancelled");
  assert.equal(body.operation, "transcription");
});

test("provider limit and failure keep raw provider details out of the response", async (t) => {
  const h = harness(t, async (provider) => ({ provider, text: "", latencyMs: 1, success: false, code: "LIMIT_EXCEEDED", retryable: false, error: "음성 인식 사용 한도에 도달했어요." }));
  const owner = h.create();
  const limited = await h.http.post(request(owner.cookie));
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { status: "failed", code: "LIMIT_EXCEEDED", message: "음성 인식 사용 한도에 도달했어요.", retryable: false, requestId: "stt-request-1" });
  const crash = harness(t, async () => { throw new Error("secret upstream detail"); });
  const other = crash.create();
  const failed = await crash.http.post(request(other.cookie, { id: "stt-request-2" }));
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /secret upstream/);
});

test("raw audio is never persisted: no file-system writes, no audio in the job registry", () => {
  const source = readFileSync("src/server/stt/session-http.ts", "utf8") + readFileSync("src/server/stt/http.ts", "utf8");
  assert.doesNotMatch(source, /node:fs|writeFile|createWriteStream|console\.(log|info|debug)/);
  const job = source.match(/interface TranscriptionJob \{([^}]*)\}/)?.[1] ?? "";
  assert.match(job, /hash/);
  assert.doesNotMatch(job, /audio|File|Buffer/);
  assert.match(source, /audio = undefined/);
});
