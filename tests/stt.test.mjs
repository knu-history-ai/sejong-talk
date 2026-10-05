import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { loadTs } from "./helpers/load-ts.mjs";
const { evaluate, cer } = loadTs("src/features/voice-input/evaluation.ts");
const { compare, transcribe } = loadTs("src/server/stt/index.ts");
const { readAudio, handleStt } = loadTs("src/server/stt/http.ts");
const keys = ["AZURE_SPEECH_KEY", "CLOVA_SPEECH_SECRET_KEY", "DEEPGRAM_API_KEY", "GROQ_API_KEY", "ELEVENLABS_API_KEY"];
function config(t) {
  for (const key of [...keys, "AZURE_SPEECH_REGION", "CLOVA_SPEECH_INVOKE_URL", "NODE_ENV", "STT_PROVIDER"]) {
    const previous = process.env[key]; t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  keys.forEach((key) => process.env[key] = "secret-test-do-not-return");
  process.env.AZURE_SPEECH_REGION = "koreacentral";
  process.env.CLOVA_SPEECH_INVOKE_URL = "https://clovaspeech-gw.ncloud.com/external/v1/123/test";
  process.env.NODE_ENV = "development"; process.env.STT_PROVIDER = "groq";
}
function wav(size = 64) {
  const data = Buffer.alloc(size); data.write("RIFF"); data.writeUInt32LE(size - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(size - 44, 40); data.fill(20, 44);
  return new File([data], "test.wav", { type: "audio/wav" });
}
function request(audio = wav(), id = crypto.randomUUID(), origin = "http://localhost:3000") {
  const form = new FormData(); form.set("audio", audio); form.set("requestId", id);
  return new Request("http://localhost:3000/api/transcriptions", { method: "POST", headers: { origin, host: "localhost:3000" }, body: form });
}
test("Korean CER distinguishes spacing and edits; missing references and terms are N/A", () => {
  assert.equal(cer("가나", "가다"), .5); assert.equal(cer("가", "가나다"), 2);
  const result = evaluate("훈민정음 해례본", "훈민정음해례본");
  assert.ok(result.cer > 0); assert.equal(result.cerWithoutSpaces, 0); assert.equal(result.termAccuracy, 1);
  assert.equal(evaluate("", "문장").cer, null); assert.equal(evaluate("안녕", "안녕").termAccuracy, null);
});
test("all five adapters use Korean, same bytes, correct authentication and response parsing", async (t) => {
  config(t); const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    const audio = init.body instanceof FormData ? init.body.get("audio") || init.body.get("media") || init.body.get("file") : init.body;
    assert.deepEqual(Buffer.from(audio instanceof ArrayBuffer ? audio : await audio.arrayBuffer()), Buffer.from(await wav().arrayBuffer()));
    if (url.includes("microsoft")) {
      assert.equal(url, "https://koreacentral.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=ko-KR&format=detailed");
      assert.equal(init.headers["Content-Type"], "audio/wav; codecs=audio/pcm; samplerate=16000");
      assert.ok(init.headers["Ocp-Apim-Subscription-Key"]); return Response.json({ RecognitionStatus: "Success", NBest: [{ Display: "세종" }] });
    }
    if (url.includes("ncloud")) { assert.equal(JSON.parse(init.body.get("params")).language, "ko-KR"); assert.ok(init.headers["X-CLOVASPEECH-API-KEY"]); return Response.json({ result: "COMPLETED", text: "세종" }); }
    if (url.includes("deepgram")) { assert.match(url, /model=nova-3&language=ko/); assert.match(init.headers.Authorization, /^Token /); return Response.json({ results: { channels: [{ alternatives: [{ transcript: "세종" }] }] } }); }
    if (url.includes("groq")) { assert.equal(init.body.get("model"), "whisper-large-v3"); assert.equal(init.body.get("language"), "ko"); assert.match(init.headers.Authorization, /^Bearer /); }
    if (url.includes("elevenlabs")) { assert.equal(init.body.get("model_id"), "scribe_v2"); assert.equal(init.body.get("language_code"), "ko"); assert.ok(init.headers["xi-api-key"]); }
    return Response.json({ text: "세종" });
  });
  const results = await compare(wav(), new AbortController().signal);
  assert.equal(calls.length, 5); assert.ok(results.every((result) => result.success && result.text === "세종"));
});
test("one provider authentication failure retains other results and never exposes upstream secrets", async (t) => {
  config(t);
  t.mock.method(globalThis, "fetch", async (url) => url.includes("groq") ? new Response("secret-test-do-not-return", { status: 401 }) : Response.json({ text: "세종", result: "COMPLETED", RecognitionStatus: "Success", NBest: [{ Display: "세종" }], results: { channels: [{ alternatives: [{ transcript: "세종" }] }] } }));
  const results = await compare(wav(), new AbortController().signal);
  assert.equal(results.filter((r) => r.success).length, 4); assert.match(results[3].error, /HTTP 401/); assert.doesNotMatch(JSON.stringify(results), /secret-test/);
});

test("CLOVA short endpoint sends raw audio with Kor and reads text without COMPLETED status", async (t) => {
  config(t);
  process.env.CLOVA_SPEECH_INVOKE_URL = "https://clovaspeech-gw.ncloud.com/recog/v1/stt";
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://clovaspeech-gw.ncloud.com/recog/v1/stt?lang=Kor");
    assert.equal(init.headers["Content-Type"], "application/octet-stream");
    assert.equal(init.headers["X-CLOVASPEECH-API-KEY"], "secret-test-do-not-return");
    assert.ok(init.body instanceof File);
    assert.deepEqual(Buffer.from(await init.body.arrayBuffer()), Buffer.from(await wav().arrayBuffer()));
    return Response.json({ text: "훈민정음", quota: 15 });
  });
  const result = await transcribe("clova", wav(), new AbortController().signal);
  assert.equal(result.success, true); assert.equal(result.text, "훈민정음");
});

test("CLOVA credentials cannot be sent to another host or unrecognized endpoint", async (t) => {
  config(t); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ text: "wrong" }); });
  for (const url of ["https://example.com/recog/v1/stt", "https://clovaspeech-gw.ncloud.com/unknown"]) {
    process.env.CLOVA_SPEECH_INVOKE_URL = url;
    assert.equal((await transcribe("clova", wav(), new AbortController().signal)).success, false);
  }
  assert.equal(calls, 0);
});
test("empty transcript, missing configuration and network exceptions are safe failures", async (t) => {
  config(t); t.mock.method(globalThis, "fetch", async () => Response.json({ text: " " }));
  assert.match((await transcribe("groq", wav(), new AbortController().signal)).error, /문장이 없/);
  delete process.env.GROQ_API_KEY;
  assert.match((await transcribe("groq", wav(), new AbortController().signal)).error, /GROQ_API_KEY/);
  process.env.GROQ_API_KEY = "secret-test";
  t.mock.method(globalThis, "fetch", async () => { throw new Error("secret-test"); });
  assert.doesNotMatch((await transcribe("groq", wav(), new AbortController().signal)).error, /secret-test/);
});
test("server rejects empty, oversized, unsupported and damaged audio", async () => {
  await assert.rejects(readAudio(request(new File([], "empty.wav", { type: "audio/wav" }))), /내용이 없/);
  await assert.rejects(readAudio(request(wav(5_000_001))), /5 MB/);
  await assert.rejects(readAudio(request(new File(["test"], "test.txt", { type: "text/plain" }))), /지원하지/);
  await assert.rejects(readAudio(request(new File(["corrupted data here"], "test.wav", { type: "audio/wav" }))), /손상/);
  assert.equal((await readAudio(request(wav(5_000_000)))).audio.size, 5_000_000);
});
test("route enforces development and origin, deduplicates requests, detects conflicting input", async (t) => {
  config(t); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ text: "훈민정음" }); });
  process.env.NODE_ENV = "production"; assert.equal((await handleStt(request())).status, 404);
  process.env.NODE_ENV = "development"; assert.equal((await handleStt(request(wav(), crypto.randomUUID(), "https://other.example"))).status, 403);
  const id = crypto.randomUUID();
  const results = await Promise.all([handleStt(request(wav(), id)), handleStt(request(wav(), id))]);
  assert.equal(calls, 1); assert.equal((await results[0].json()).text, "훈민정음"); assert.equal((await results[1].json()).status, "completed");
  assert.equal((await handleStt(request(wav(100), id))).status, 409);
});
test("client source contains no secret env access or server imports; all adapters have server-only guards", () => {
  for (const file of readdirSync("src/features/voice-input").filter((f) => /\.tsx?$/.test(f))) {
    const text = readFileSync(`src/features/voice-input/${file}`, "utf8");
    assert.doesNotMatch(text.replaceAll("process.env.NODE_ENV", "BUILD_MODE"), /process\.env|@\/server|NEXT_PUBLIC_.*KEY/);
  }
  for (const file of readdirSync("src/server/stt").filter((f) => f.endsWith(".ts"))) assert.match(readFileSync(`src/server/stt/${file}`, "utf8"), /import "server-only"/);
});

