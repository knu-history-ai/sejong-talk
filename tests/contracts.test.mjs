import test from "node:test";
import assert from "node:assert/strict";
import { answers, character, fact, source, responses, errors, turnRequest, speechRequest, sessionCreated, evalCase, evalResult, createPlaybackFixture } from "./fixtures/contracts.ts";

test("sample IDs connect question, transcription, answer, source and speech", () => {
  assert.equal(responses.transcription.text, turnRequest.text);
  assert.equal(responses.grounded.requestId, turnRequest.requestId);
  assert.equal(responses.grounded.answer.answerId, speechRequest.answerId);
  assert.equal(responses.speech.answerId, speechRequest.answerId);
  assert.equal(sessionCreated.characterId, character.id);
  assert.equal(fact.characterId, character.id);
  assert.deepEqual(answers.grounded.factIds, [fact.id]);
  assert.deepEqual(fact.sourceIds, [source.id]);
  assert.equal(answers.grounded.sources[0].id, source.id);
  assert.deepEqual(evalCase.expectedFacts, [fact.id]);
  assert.equal(evalResult.caseId, evalCase.id);
});
test("all answer kinds and asynchronous request states can be developed independently", () => {
  assert.deepEqual(new Set(Object.values(answers).map(a => a.kind)), new Set(["grounded", "conversation", "insufficient", "fallback"]));
  assert.deepEqual(new Set(Object.values(responses).map(r => r.status)), new Set(["queued", "processing", "approved", "completed", "cancelled", "failed"]));
  for (const r of Object.values(responses)) {
    if (r.status !== "approved") assert.equal("answer" in r, false);
  }
  assert.equal(responses.fallback.status, "approved");
  assert.equal(errors.expired.retryable, false);
  assert.equal(responses.timeout.retryable, true);
  assert.ok(errors.limit.retryAfterSeconds > 0);
});
test("public samples expose no server policy, credentials or unapproved model draft", () => {
  const forbidden = new Set(["token", "apiKey", "system", "rawAnswer", "policy", "reviewStatus", "checkedAt"]);
  const visit = obj => {
    if (!obj || typeof obj !== "object") return;
    for (const [key, value] of Object.entries(obj)) { assert.ok(!forbidden.has(key), key); visit(value); }
  };
  visit(responses); visit(sessionCreated);
  assert.deepEqual(Object.keys(speechRequest).sort(), ["answerId", "requestId"]);
  assert.equal(fact.reviewStatus, "pending");
  assert.equal(source.checkedAt, null);
});
test("playback fixture is self-contained valid mono PCM WAV", async () => {
  const blob = createPlaybackFixture();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  assert.equal(blob.type, "audio/wav");
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
  assert.equal(view.getUint32(4, true) + 8, bytes.length);
  assert.equal(view.getUint32(40, true), bytes.length - 44);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 8000);
});
