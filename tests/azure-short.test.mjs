import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.mjs";
import { mockMeteredCall } from "./helpers/usage-meter.mjs";
// Replace the cached transpiled runtime before loading the STT dispatcher.
loadTs("src/server/usage/runtime.ts").runMeteredCall = mockMeteredCall;
const { azure, azureDisplayText, AZURE_TIMEOUT_MS } = loadTs("src/server/stt/azure.ts");
const { transcribe } = loadTs("src/server/stt/index.ts");
const { handleStt } = loadTs("src/server/stt/http.ts");
const { encodePcmWav } = loadTs("src/features/voice-input/pcm-wav.ts");
const audio = () => new File([encodePcmWav(new Float32Array(16000).fill(.1))], "sample.wav", { type: "audio/wav" });
function configure(t) {
  for (const [key, value] of Object.entries({ AZURE_SPEECH_REGION: "koreacentral", AZURE_SPEECH_KEY: "fake-private-value", STT_PROVIDER: "azure", NODE_ENV: "development" })) {
    const before = process.env[key]; process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
}
test("Azure Success supports simple DisplayText and detailed NBest.Display", () => {
  assert.equal(azureDisplayText({ RecognitionStatus: "Success", DisplayText: " 세종 " }), "세종");
  assert.equal(azureDisplayText({ RecognitionStatus: "Success", NBest: [{ Display: "훈민정음" }] }), "훈민정음");
});
for (const data of [{ RecognitionStatus: "NoMatch" }, { RecognitionStatus: "InitialSilenceTimeout" }, { RecognitionStatus: "Success", DisplayText: " " }, { RecognitionStatus: "Success", NBest: [] }]) {
  test(`Azure no transcript: ${JSON.stringify(data)}`, async (t) => {
    configure(t); t.mock.method(globalThis, "fetch", async () => Response.json(data));
    const result = await transcribe("azure", audio(), new AbortController().signal);
    assert.equal(result.success, false); assert.match(result.error, /인식된 문장이 없/);
  });
}
for (const status of [401, 403, 429, 500, 503]) {
  test(`Azure HTTP ${status} is a safe failure without raw upstream body`, async (t) => {
    configure(t); t.mock.method(globalThis, "fetch", async () => new Response("fake-private-value upstream details", { status }));
    const result = await transcribe("azure", audio(), new AbortController().signal);
    assert.equal(result.success, false); assert.match(result.error, new RegExp(`HTTP ${status}`)); assert.doesNotMatch(result.error, /fake-private|upstream details/);
  });
}
test("Azure request abort and exactly 20-second timeout reach fetch", async (t) => {
  configure(t); t.mock.timers.enable({ apis: ["setTimeout"] });
  let entered;
  let ready = new Promise((resolve) => { entered = resolve; });
  t.mock.method(globalThis, "fetch", (_url, { signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }); entered();
  }));
  const pending = azure(audio(), new AbortController().signal);
  const rejected = assert.rejects(pending, { name: "TimeoutError" });
  await ready; assert.equal(AZURE_TIMEOUT_MS, 20000); t.mock.timers.tick(20000); await rejected;
  const abort = new AbortController(); ready = new Promise((resolve) => { entered = resolve; });
  const cancel = azure(audio(), abort.signal); const cancelled = assert.rejects(cancel, { name: "AbortError" });
  await ready; abort.abort(); await cancelled;
});
test("Azure rejects non-PCM WAV, silence, empty and oversized data before fetch", async (t) => {
  configure(t); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({}); });
  for (const file of [new File([], "empty.wav"), new File(["fake wav"], "fake.wav"), new File([new Uint8Array(5_000_001)], "large.wav"), new File([encodePcmWav(new Float32Array(16000))], "silence.wav")]) {
    assert.equal((await transcribe("azure", file, new AbortController().signal)).success, false);
  }
  assert.equal(calls, 0);
});
test("Azure requestId duplicates reach the actual adapter only once", async (t) => {
  configure(t); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ RecognitionStatus: "Success", NBest: [{ Display: "세종" }] }); });
  const id = crypto.randomUUID();
  const request = () => { const form = new FormData(); form.set("requestId", id); form.set("audio", audio()); return new Request("http://localhost/api/transcriptions", { method: "POST", headers: { origin: "http://localhost", host: "localhost" }, body: form }); };
  const results = await Promise.all([handleStt(request()), handleStt(request())]);
  for (const result of results) assert.equal((await result.json()).text, "세종");
  assert.equal(calls, 1);
});
