import test from "node:test";
import assert from "node:assert/strict";
import { mockMeteredCall } from "./helpers/usage-meter.mjs";

import {
  extractOllamaText,
  readOllamaConfig,
  requestOllamaCandidate,
  OllamaRequestError,
} from "../src/server/ai/ollama-request.ts";

test("Ollama request sends Qwen JSON generation body and records local token usage", async () => {
  const config = {
    ...readOllamaConfig({
      OLLAMA_BASE_URL: "http://127.0.0.1:11434",
      OLLAMA_MODEL: "qwen3.5:4b-q4_K_M",
    }),
    retryBaseDelayMs: 0,
  };
  let seenBody;
  const fetchMock = async (url, init) => {
    assert.match(String(url), /\/api\/generate$/);
    seenBody = JSON.parse(init.body);
    return Response.json({
      response: '{"kind":"conversation","text":"반갑구나.","factIds":[]}',
      prompt_eval_count: 10,
      eval_count: 4,
    });
  };

  const result = await requestOllamaCandidate("prompt", config, fetchMock, undefined, mockMeteredCall);

  assert.deepEqual(seenBody, {
    model: "qwen3.5:4b-q4_K_M",
    prompt: "prompt",
    stream: false,
    format: "json",
    options: {
      temperature: 0.2,
      top_p: 0.9,
      num_predict: 1000,
    },
  });
  assert.equal(result.text, '{"kind":"conversation","text":"반갑구나.","factIds":[]}');
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 4, totalTokens: 14 });
  assert.equal(result.attempts, 1);
});

test("Ollama unavailable model maps to shared unavailable error without exposing response body", async () => {
  const config = {
    ...readOllamaConfig({ OLLAMA_MODEL: "qwen3.5:4b-q4_K_M" }),
    maxAttempts: 1,
    retryBaseDelayMs: 0,
  };

  await assert.rejects(
    requestOllamaCandidate(
      "prompt",
      config,
      async () => new Response("model secret: not found", { status: 404 }),
      undefined,
      mockMeteredCall,
    ),
    (error) => {
      assert.ok(error instanceof OllamaRequestError);
      assert.equal(error.code, "UNAVAILABLE");
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, /model secret/);
      return true;
    },
  );
});

test("Ollama empty response is rejected as invalid provider format", () => {
  assert.throws(
    () => extractOllamaText({ response: "" }),
    { code: "UNAVAILABLE", retryable: false },
  );
});
