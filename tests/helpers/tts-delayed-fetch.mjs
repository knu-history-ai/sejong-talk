import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

// Preload in the CLI subprocess: every fetch is handled here, without a network fallback.
const provider = process.env.TTS_TEST_PROVIDER;
const expectedUrls = {
  azure: "https://koreacentral.tts.speech.microsoft.com/cognitiveservices/v1",
  elevenlabs: "https://api.elevenlabs.io/v1/text-to-speech/test-voice?output_format=mp3_44100_128",
  typecast: "https://api.typecast.ai/v1/text-to-speech",
};
let calls = 0;

globalThis.fetch = async (url, init) => {
  assert.equal(url, expectedUrls[provider]);
  assert.equal(init.method, "POST");
  assert.equal(++calls, 1, "the CLI must synthesize only the selected fixture");
  if (provider === "azure") {
    assert.match(init.body, /voice name="ko-KR-InJoonNeural"/);
    assert.match(init.body, /prosody rate="-5%"/);
    assert.doesNotMatch(init.body, /pitch=/);
  }

  const headersReceivedAt = performance.now();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from([73, 68, 51]));
      setTimeout(() => {
        controller.enqueue(Uint8Array.from([1, 2, 3, 4, 5]));
        controller.close();
        writeFileSync(
          process.env.TTS_TEST_RECEIPT,
          JSON.stringify({
            calls,
            bodyLatencyMs: performance.now() - headersReceivedAt,
          }),
        );
      }, 200);
    },
  });
  return new Response(body, { headers: { "Content-Type": "audio/mpeg" } });
};
