import test from "node:test";
import assert from "node:assert/strict";
import {
  AZURE_TTS_MIME_TYPE,
  AZURE_TTS_OUTPUT_FORMAT,
  AZURE_TTS_VOICE,
  AzureSpeechError,
  buildAzureSpeechSsml,
  readAzureSpeechConfig,
  requestAzureSpeech,
  toSpeechErrorResponse,
} from "../src/server/tts/azure-request.ts";

test("Azure SSML uses the selected Korean voice, slower rate, and default pitch", () => {
  const ssml = buildAzureSpeechSsml("훈민정음은 <스물여덟> 글자였단다.");

  assert.match(ssml, new RegExp(`voice name="${AZURE_TTS_VOICE}"`));
  assert.match(ssml, /prosody rate="-5%"/);
  assert.doesNotMatch(ssml, /pitch=/);
  assert.match(ssml, /&lt;스물여덟&gt;/);
});

test("Azure SSML rejects an empty approved answer", () => {
  assert.throws(
    () => buildAzureSpeechSsml("   "),
    /합성할 답변이 비어 있습니다/,
  );
});

test("Azure request sends SSML with server credentials and returns MP3 bytes", async () => {
  let capturedUrl;
  let capturedInit;
  const fetchMock = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(Uint8Array.from([1, 2, 3]), { status: 200 });
  };

  const result = await requestAzureSpeech(
    "훈민정음은 스물여덟 글자였단다.",
    { key: "test-secret", region: "koreacentral" },
    fetchMock,
  );

  assert.equal(
    capturedUrl,
    "https://koreacentral.tts.speech.microsoft.com/cognitiveservices/v1",
  );
  assert.equal(capturedInit.method, "POST");
  assert.equal(capturedInit.headers["Ocp-Apim-Subscription-Key"], "test-secret");
  assert.equal(
    capturedInit.headers["X-Microsoft-OutputFormat"],
    AZURE_TTS_OUTPUT_FORMAT,
  );
  assert.match(capturedInit.body, /prosody rate="-5%"/);
  assert.deepEqual(result.audio, Uint8Array.from([1, 2, 3]));
  assert.equal(result.mimeType, AZURE_TTS_MIME_TYPE);
});

test("Azure request maps provider failures without exposing the response body", async () => {
  const fetchMock = async () =>
    new Response("provider-secret-error", { status: 429 });

  await assert.rejects(
    requestAzureSpeech(
      "승인된 답변",
      { key: "test-secret", region: "koreacentral" },
      fetchMock,
    ),
    (error) => {
      assert.ok(error instanceof AzureSpeechError);
      assert.equal(error.code, "LIMIT_EXCEEDED");
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /provider-secret-error|test-secret/);
      return true;
    },
  );
});

test("Azure configuration reads only the server key and region", () => {
  assert.deepEqual(
    readAzureSpeechConfig({
      AZURE_SPEECH_KEY: " test-secret ",
      AZURE_SPEECH_REGION: " KoreaCentral ",
    }),
    { key: "test-secret", region: "koreacentral" },
  );

  assert.throws(
    () => readAzureSpeechConfig({ AZURE_SPEECH_REGION: "koreacentral" }),
    (error) => {
      assert.ok(error instanceof AzureSpeechError);
      assert.equal(error.code, "UNAVAILABLE");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("Azure failures use the shared error response shape", () => {
  assert.deepEqual(
    toSpeechErrorResponse(
      new AzureSpeechError("UPSTREAM_TIMEOUT", true),
      "speech_fixture_01",
    ),
    {
      status: "failed",
      requestId: "speech_fixture_01",
      code: "UPSTREAM_TIMEOUT",
      message: "음성 생성이 늦어지고 있습니다. 다시 시도해 주세요.",
      retryable: true,
    },
  );
});
