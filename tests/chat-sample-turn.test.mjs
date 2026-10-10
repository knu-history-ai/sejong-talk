import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.mjs";

const { requestSampleTurn } = loadTs("src/features/chat/sample-turn.ts");

test("cancelled sample requests never return an approved answer", async () => {
  const controller = new AbortController();
  const result = requestSampleTurn({ requestId: "cancel-test", text: "질문" }, { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await result, { requestId: "cancel-test", operation: "turn", status: "cancelled" });
  assert.equal((await requestSampleTurn({ requestId: "already-cancelled", text: "질문" }, { signal: controller.signal })).status, "cancelled");
});

test("sample success and failure preserve request identity and shared response fields", async () => {
  const signal = new AbortController().signal;
  const success = await requestSampleTurn({ requestId: "success", text: "한글은 왜 만들었나요?" }, { signal });
  assert.equal(success.status, "approved");
  assert.equal(success.requestId, "success");
  assert.ok(success.answer.text.length > 0);
  assert.deepEqual(success.answer.sources, []);
  const failure = await requestSampleTurn({ requestId: "failure", text: "질문" }, { signal, fail: true });
  assert.equal(failure.status, "failed");
  assert.equal(failure.requestId, "failure");
  assert.equal(failure.retryable, true);
});
