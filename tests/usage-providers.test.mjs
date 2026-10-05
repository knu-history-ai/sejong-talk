import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { getUsageLedger } from "../src/server/usage/runtime.ts";
import { requestGeminiCandidate, readGeminiConfig } from "../src/server/ai/gemini-request.ts";
import { requestAzureSpeech, toSpeechErrorResponse, AZURE_TTS_VOICE } from "../src/server/tts/azure-request.ts";
import { encodePcmWav } from "../src/features/voice-input/pcm-wav.ts";
import { loadTs } from "./helpers/load-ts.mjs";

// These calls use the real guard and ledger. All network responses are mocked,
// and the explicit free plans apply only to a new temporary test database.
const { compare, transcribe } = loadTs("src/server/stt/index.ts");
const providers = ["azure", "clova", "deepgram", "groq", "elevenlabs"];
const freePlans = Object.fromEntries([
  "gemini:llm_generation", "azure:tts", ...providers.map((provider) => `${provider}:stt`),
].map((key) => [key, { mode: "free", maxCostMicros: 0 }]));
const speechConfig = { key: "test-key", region: "koreacentral" };
const geminiConfig = { ...readGeminiConfig({ GEMINI_API_KEY: "test-key" }), retryBaseDelayMs: 0 };

function fixture(t, { plans = freePlans, callsPerMinute = 60 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sejong-usage-providers-"));
  const environment = {
    USAGE_DB_PATH: join(directory, "ledger.sqlite"), USAGE_PROVIDER_PLANS: JSON.stringify(plans),
    USAGE_DAILY_BUDGET_MICROS: "0", USAGE_MONTHLY_BUDGET_MICROS: "0",
    USAGE_MAX_CONCURRENT: "5", USAGE_CALLS_PER_MINUTE: String(callsPerMinute),
    USAGE_SESSION_PER_MINUTE: "6", USAGE_COMPLETED_TURNS: "30",
    AZURE_SPEECH_KEY: "test-key", AZURE_SPEECH_REGION: "koreacentral",
    CLOVA_SPEECH_SECRET_KEY: "test-key", CLOVA_SPEECH_INVOKE_URL: "https://clovaspeech-gw.ncloud.com/external/v1/123/test",
    DEEPGRAM_API_KEY: "test-key", GROQ_API_KEY: "test-key", ELEVENLABS_API_KEY: "test-key",
  };
  const previousEnvironment = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  const previousLedger = globalThis.sejongUsageLedger;
  delete globalThis.sejongUsageLedger;
  Object.assign(process.env, environment);
  t.after(() => {
    globalThis.sejongUsageLedger?.close();
    if (previousLedger) globalThis.sejongUsageLedger = previousLedger;
    else delete globalThis.sejongUsageLedger;
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const ledger = getUsageLedger();
  assert.equal(ledger.path, environment.USAGE_DB_PATH);
  return ledger;
}
const rows = (ledger) => ledger.snapshot().calls.map((call) => ({ ...call, units: JSON.parse(call.units) }));
const wav = () => new File([encodePcmWav(new Float32Array(19_744).fill(0.1))], "test.wav", { type: "audio/wav" });
const geminiResponse = () => Response.json({
  candidates: [{ content: { parts: [{ text: "승인할 답변" }] } }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
});
const sttResponse = () => Response.json({
  text: "세종", result: "COMPLETED", RecognitionStatus: "Success", NBest: [{ Display: "세종" }],
  results: { channels: [{ alternatives: [{ transcript: "세종" }] }] },
});

test("unconfigured plans block every provider before network calls and preserve UNAVAILABLE", async (t) => {
  const ledger = fixture(t, { plans: {} });
  let calls = 0;
  const fetchMock = async () => { calls += 1; throw new Error("must not call provider"); };
  t.mock.method(globalThis, "fetch", fetchMock);
  await assert.rejects(requestGeminiCandidate("prompt", geminiConfig, fetchMock), { code: "UNAVAILABLE", retryable: false });
  await assert.rejects(requestAzureSpeech("답변", speechConfig, fetchMock), { code: "UNAVAILABLE", retryable: false });
  const results = await compare(wav(), new AbortController().signal);
  assert.equal(results.length, 5);
  assert.ok(results.every((result) => !result.success && result.code === "UNAVAILABLE" && result.retryable === false));
  assert.equal(calls, 0);
  assert.equal(rows(ledger).length, 0);
});

test("paid plans remain blocked even with a valid provider key", async (t) => {
  const ledger = fixture(t, { plans: { "gemini:llm_generation": { mode: "paid", maxCostMicros: 100 } } });
  let calls = 0;
  await assert.rejects(requestGeminiCandidate("prompt", geminiConfig, async () => { calls += 1; return geminiResponse(); }), { code: "UNAVAILABLE", retryable: false });
  assert.equal(calls, 0);
  assert.equal(rows(ledger).length, 0);
});

test("each Gemini retry has its own record and successful usage includes total tokens", async (t) => {
  const ledger = fixture(t);
  let calls = 0;
  const result = await requestGeminiCandidate("prompt", geminiConfig, async () => ++calls === 1 ? new Response("secret", { status: 503 }) : geminiResponse());
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
  const records = rows(ledger);
  assert.deepEqual(records.map((call) => call.status), ["failed", "completed"]);
  assert.ok(records.every((call) => call.stage === "llm_generation" && call.provider === "gemini" && call.model === geminiConfig.model));
  assert.deepEqual(records[1].units, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.equal(ledger.snapshot().dailyCostMicros, 0);
});

test("Gemini does not retry a denied usage reservation", async (t) => {
  const ledger = fixture(t, { callsPerMinute: 1 });
  let calls = 0;
  await assert.rejects(requestGeminiCandidate("prompt", geminiConfig, async () => {
    calls += 1; return new Response("secret", { status: 503 });
  }), { code: "LIMIT_EXCEEDED", retryable: false });
  assert.equal(calls, 1);
  assert.equal(rows(ledger).length, 1);
  assert.equal(rows(ledger)[0].status, "failed");
});

test("Gemini upstream quota failures do not trigger automatic retries", async (t) => {
  const ledger = fixture(t);
  let calls = 0;
  await assert.rejects(requestGeminiCandidate("prompt", geminiConfig, async () => {
    calls += 1; return new Response("secret", { status: 429, headers: { "retry-after": "30" } });
  }), { code: "LIMIT_EXCEEDED", retryAfterSeconds: 30 });
  assert.equal(calls, 1);
  assert.equal(rows(ledger)[0].status, "failed");
});

test("Gemini records reported tokens even when candidate extraction fails", async (t) => {
  const ledger = fixture(t);
  await assert.rejects(requestGeminiCandidate("prompt", { ...geminiConfig, maxAttempts: 1 }, async () => Response.json({
    candidates: [], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
  })), { code: "UNAVAILABLE" });
  assert.deepEqual(rows(ledger)[0].units, { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
  assert.equal(rows(ledger)[0].status, "failed");
});

test("Gemini cancellation settles once and does not start another attempt", async (t) => {
  const ledger = fixture(t);
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(requestGeminiCandidate("prompt", geminiConfig, async (_url, init) => {
    calls += 1; controller.abort(); throw init.signal.reason;
  }, controller.signal), { code: "UPSTREAM_TIMEOUT" });
  assert.equal(calls, 1);
  assert.deepEqual(rows(ledger).map((call) => call.status), ["cancelled"]);
});

test("all five STT adapters record actual WAV duration and configured model identity", async (t) => {
  const ledger = fixture(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; return sttResponse(); });
  const results = await compare(wav(), new AbortController().signal);
  assert.ok(results.every((result) => result.success && result.text === "세종"));
  assert.equal(calls, 5);
  const records = rows(ledger);
  assert.equal(records.length, 5);
  assert.ok(records.every((call) => call.stage === "stt" && call.status === "completed" && call.units.audioMilliseconds === 1234));
  assert.deepEqual(Object.fromEntries(records.map((call) => [call.provider, call.model])), {
    azure: "provider-default", clova: "provider-default", deepgram: "nova-3", groq: "whisper-large-v3", elevenlabs: "scribe_v2",
  });
});

test("STT reserves 30 seconds when container duration is unknown", async (t) => {
  const ledger = fixture(t);
  t.mock.method(globalThis, "fetch", async () => sttResponse());
  const result = await transcribe("groq", new File([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])], "test.webm", { type: "audio/webm" }), new AbortController().signal);
  assert.equal(result.success, true);
  assert.equal(rows(ledger)[0].units.audioMilliseconds, 30_000);
});

test("STT measures PCM WAV duration beyond the Azure-only sample format", async (t) => {
  const ledger = fixture(t);
  t.mock.method(globalThis, "fetch", async () => sttResponse());
  const data = Buffer.alloc(44 + 8000 * 2 * 2);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(data.length - 44, 40);
  const result = await transcribe("groq", new File([data], "test.wav", { type: "audio/wav" }), new AbortController().signal);
  assert.equal(result.success, true);
  assert.equal(rows(ledger)[0].units.audioMilliseconds, 1000);
});

test("STT preserves a guard limit code without calling the blocked adapter", async (t) => {
  const ledger = fixture(t, { callsPerMinute: 1 });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; return sttResponse(); });
  assert.equal((await transcribe("groq", wav(), new AbortController().signal)).success, true);
  const result = await transcribe("deepgram", wav(), new AbortController().signal);
  assert.equal(result.code, "LIMIT_EXCEEDED");
  assert.equal(result.retryable, false);
  assert.equal(calls, 1);
  assert.equal(rows(ledger).length, 1);
});

test("STT never completes a provider result that arrives after cancellation", async (t) => {
  const ledger = fixture(t);
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => { controller.abort(); return sttResponse(); });
  const result = await transcribe("groq", wav(), controller.signal);
  assert.equal(result.success, false);
  assert.equal(rows(ledger)[0].status, "cancelled");
});

test("TTS remains reserved through response body reading and counts original characters", async (t) => {
  const ledger = fixture(t);
  const text = "세종 & <훈민정음>";
  let release;
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  const running = requestAzureSpeech(text, speechConfig, async () => ({
    ok: true, status: 200,
    arrayBuffer: () => { started(); return new Promise((resolve) => { release = resolve; }); },
  }));
  await reading;
  assert.equal(rows(ledger)[0].status, "reserved");
  release(Uint8Array.from([1, 2, 3]).buffer);
  assert.equal((await running).audio.length, 3);
  const record = rows(ledger)[0];
  assert.equal(record.status, "completed");
  assert.equal(record.stage, "tts");
  assert.equal(record.model, AZURE_TTS_VOICE);
  assert.equal(record.units.characters, text.length);
});

test("TTS body errors settle the ledger as failed and hide exception details", async (t) => {
  const ledger = fixture(t);
  await assert.rejects(requestAzureSpeech("답변", speechConfig, async () => ({
    ok: true, status: 200, arrayBuffer: async () => { throw new Error("secret-body-error"); },
  })), (error) => error.code === "UNAVAILABLE" && !error.message.includes("secret"));
  assert.equal(rows(ledger)[0].status, "failed");
  assert.equal(rows(ledger)[0].units.characters, 2);
});

test("TTS exposes the original usage limit code in the shared response", async (t) => {
  const ledger = fixture(t, { callsPerMinute: 1 });
  let calls = 0;
  const fetchMock = async () => { calls += 1; return new Response(Uint8Array.from([1])); };
  await requestAzureSpeech("답변", speechConfig, fetchMock);
  await assert.rejects(requestAzureSpeech("답변", speechConfig, fetchMock), (error) => {
    assert.equal(error.code, "LIMIT_EXCEEDED");
    assert.equal(toSpeechErrorResponse(error, "limit-test").code, "LIMIT_EXCEEDED");
    assert.equal(toSpeechErrorResponse(error, "limit-test").retryable, false);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(rows(ledger).length, 1);
});

test("TTS records cancellation during body download without completing the call", async (t) => {
  const ledger = fixture(t);
  const controller = new AbortController();
  await assert.rejects(requestAzureSpeech("답변", speechConfig, async () => ({
    ok: true, status: 200, arrayBuffer: async () => { await nextTick(); controller.abort(); throw controller.signal.reason; },
  }), controller.signal), { code: "UPSTREAM_TIMEOUT" });
  assert.equal(rows(ledger)[0].status, "cancelled");
});

test("development STT HTTP returns quota errors as 429 instead of masking them", async (t) => {
  const ledger = fixture(t, { callsPerMinute: 1 });
  const { handleStt } = loadTs("src/server/stt/http.ts");
  const previous = { NODE_ENV: process.env.NODE_ENV, STT_PROVIDER: process.env.STT_PROVIDER };
  process.env.NODE_ENV = "development"; process.env.STT_PROVIDER = "groq";
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return sttResponse(); });
  const request = (id) => { const form = new FormData(); form.set("requestId", id); form.set("audio", wav());
    return new Request("http://localhost/api/transcriptions", { method: "POST", headers: { origin: "http://localhost", host: "localhost" }, body: form }); };
  assert.equal((await handleStt(request("usage-http-first"))).status, 200);
  const blocked = await handleStt(request("usage-http-second"));
  assert.equal(blocked.status, 429); assert.equal((await blocked.json()).code, "LIMIT_EXCEEDED");
  assert.equal(calls, 1); assert.equal(rows(ledger).length, 1);
});

test("verification calls record a separate stage with the same provider ledger", async (t) => {
  const ledger = fixture(t, { plans: { "gemini:llm_verification": { mode: "free", maxCostMicros: 0 } } });
  await requestGeminiCandidate("검증용 prompt", { ...geminiConfig, usageStage: "llm_verification" }, async () => geminiResponse());
  assert.equal(rows(ledger)[0].stage, "llm_verification");
});
