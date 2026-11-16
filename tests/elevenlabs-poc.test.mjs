import test from "node:test";
import assert from "node:assert/strict";
import { koreanPocSpeechRequest, measurePocStage, PocSpeechError, requestKoreanPocSpeech } from "../src/server/tts/elevenlabs-poc.ts";

const env = { ELEVENLABS_API_KEY: "fixture-key", ELEVENLABS_VOICE_ID: "fixture-voice" };
function timer() {
  let elapsed = 0;
  return { monotonic: () => elapsed, iso: () => new Date(elapsed).toISOString(), advance: (ms) => { elapsed += ms; } };
}

test("Korean PoC uses a language-code capable model and leaves old TTS configuration alone", () => {
  const request = koreanPocSpeechRequest("반갑구나.", { ...env, ELEVENLABS_TTS_MODEL: "eleven_multilingual_v2" });
  assert.equal(request.body.language_code, "ko");
  assert.equal(request.body.model_id, "eleven_flash_v2_5");
  assert.deepEqual(request.body.voice_settings, {
    stability: 0.65, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true, speed: 0.95,
  });
  assert.throws(() => koreanPocSpeechRequest("반갑구나.", { ...env, ELEVENLABS_POC_TTS_MODEL: "eleven_multilingual_v2" }));
});

test("PoC reuses Bill by default while respecting an explicit voice ID", () => {
  const request = koreanPocSpeechRequest("반갑구나.", { ELEVENLABS_API_KEY: "fixture-key" });
  assert.equal(request.voiceId, "pqHfZKP75CvOlQylNhV4");
  assert.match(request.url, /\/pqHfZKP75CvOlQylNhV4\/stream\?/);
  assert.equal(koreanPocSpeechRequest("반갑구나.", env).voiceId, "fixture-voice");
  assert.throws(() => koreanPocSpeechRequest("반갑구나.", {}), /ELEVENLABS_API_KEY/);
});

test("headers, first bytes and delayed body completion have separate timings", async () => {
  const clock = timer();
  let pull = 0;
  const result = await requestKoreanPocSpeech("반갑구나.", { env, timer: clock, fetchImpl: async () => {
    clock.advance(10);
    return new Response(new ReadableStream({ pull(controller) {
      if (pull++ === 0) { clock.advance(20); controller.enqueue(new Uint8Array([1])); }
      else { clock.advance(50); controller.close(); }
    } }, { highWaterMark: 0 }), { headers: { "x-region": "test-region" } });
  } });
  assert.equal(result.timing.headersLatencyMs, 10);
  assert.equal(result.timing.firstBodyByteLatencyMs, 30);
  assert.equal(result.timing.durationMs, 80);
  assert.equal(result.timing.bodyDownloadMs, 70);
  assert.equal(result.timing.xRegion, "test-region");
  assert.equal(result.timing.status, "completed");
  assert.ok(!JSON.stringify(result.timing).includes("fixture-key"));
  assert.ok(!JSON.stringify(result.timing).includes("반갑구나"));
});

test("missing region is not inferred from AWS region or the requested language", async () => {
  const result = await requestKoreanPocSpeech("반갑구나.", { env, fetchImpl: async () => new Response(new Uint8Array([1])) });
  assert.equal(result.timing.xRegion, null);
  assert.equal(result.timing.regionStatus, "not-reported");
});

test("HTTP failure records region and status without exposing upstream response content", async () => {
  await assert.rejects(requestKoreanPocSpeech("반갑구나.", { env,
    fetchImpl: async () => new Response("secret upstream detail", { status: 429, headers: { "x-region": "test" } }),
  }), (error) => error instanceof PocSpeechError && error.timing.httpStatus === 429
    && error.timing.xRegion === "test" && error.timing.status === "failed"
    && error.timing.outputAt !== null && !error.message.includes("secret"));
});

test("cancelled input does not call ElevenLabs", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestKoreanPocSpeech("반갑구나.", { env, signal: controller.signal,
    fetchImpl: async () => { assert.fail("network call after cancellation"); },
  }), (error) => error instanceof PocSpeechError && error.timing.status === "cancelled"
    && error.timing.regionStatus === "no-response");
});

test("backend stage hook records both sides of a failed stage without its payload", async () => {
  const records = [], clock = timer();
  await assert.rejects(measurePocStage("request", "llm", async () => { clock.advance(7); throw new Error("secret"); }, (record) => records.push(record), clock));
  assert.equal(records[0].durationMs, 7);
  assert.equal(records[0].status, "failed");
  assert.ok(!JSON.stringify(records).includes("secret"));
});

test("a body read failure keeps the received region and first-byte timing", async () => {
  const clock = timer();
  let pull = 0;
  await assert.rejects(requestKoreanPocSpeech("반갑구나.", { env, timer: clock, fetchImpl: async () => {
    clock.advance(10);
    return new Response(new ReadableStream({ pull(controller) {
      clock.advance(20);
      if (pull++ === 0) controller.enqueue(new Uint8Array([1]));
      else controller.error(new Error("private upstream detail"));
    } }, { highWaterMark: 0 }), { headers: { "x-region": "test" } });
  } }), (error) => error instanceof PocSpeechError && error.timing.status === "failed"
    && error.timing.xRegion === "test" && error.timing.firstBodyByteLatencyMs === 30
    && error.timing.durationMs === 50 && !error.message.includes("private"));
});

test("timeout remains distinguishable from user cancellation", async () => {
  const signal = AbortSignal.abort(new DOMException("timeout", "TimeoutError"));
  await assert.rejects(requestKoreanPocSpeech("반갑구나.", { env, signal,
    fetchImpl: async () => { assert.fail("network call after timeout"); },
  }), (error) => error instanceof PocSpeechError && error.timing.status === "timeout");
});
