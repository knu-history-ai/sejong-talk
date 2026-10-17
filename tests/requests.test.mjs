import test from "node:test";
import assert from "node:assert/strict";

import {
  RequestCoordinator,
  fingerprintJson,
} from "../src/server/requests/index.ts";

test("request coordinator reuses same requestId and fingerprint without duplicate work", async () => {
  const coordinator = new RequestCoordinator();
  let calls = 0;
  const work = async () => {
    calls += 1;
    return {
      requestId: "turn_request_01",
      operation: "turn",
      status: "approved",
      answer: {
        answerId: "answer_request_01",
        kind: "conversation",
        text: "반갑구나.",
        factIds: [],
        sources: [],
        personaVersion: "sejong-persona-v1",
        contentVersion: "sejong-content-v1",
      },
    };
  };

  const [first, second] = await Promise.all([
    coordinator.run(
      {
        requestId: "turn_request_01",
        operation: "turn",
        fingerprint: fingerprintJson({ text: "안녕" }),
        timeoutMs: 1000,
      },
      work,
    ),
    coordinator.run(
      {
        requestId: "turn_request_01",
        operation: "turn",
        fingerprint: fingerprintJson({ text: "안녕" }),
        timeoutMs: 1000,
      },
      work,
    ),
  ]);

  assert.equal(calls, 1);
  assert.equal(first.status, "approved");
  assert.equal(second.status, "approved");
});

test("request coordinator rejects same requestId with different input", async () => {
  const coordinator = new RequestCoordinator();
  await coordinator.run(
    {
      requestId: "turn_request_02",
      operation: "turn",
      fingerprint: fingerprintJson({ text: "첫 질문" }),
      timeoutMs: 1000,
    },
    async () => ({ requestId: "turn_request_02", operation: "turn", status: "processing" }),
  );

  const conflict = await coordinator.run(
    {
      requestId: "turn_request_02",
      operation: "turn",
      fingerprint: fingerprintJson({ text: "다른 질문" }),
      timeoutMs: 1000,
    },
    async () => {
      throw new Error("must not run");
    },
  );

  assert.equal(conflict.status, "failed");
  assert.equal(conflict.code, "REQUEST_CONFLICT");
});

test("request coordinator keeps cancelled state when a late response arrives", async () => {
  const coordinator = new RequestCoordinator();
  let resolveWork;
  const running = coordinator.run(
    {
      requestId: "turn_request_03",
      operation: "turn",
      fingerprint: fingerprintJson({ text: "늦은 질문" }),
      timeoutMs: 1000,
    },
    async () =>
      new Promise((resolve) => {
        resolveWork = resolve;
      }),
  );

  const cancelled = coordinator.cancel("turn_request_03");
  resolveWork({
    requestId: "turn_request_03",
    operation: "turn",
    status: "approved",
    answer: {
      answerId: "answer_late",
      kind: "conversation",
      text: "늦게 도착한 답변",
      factIds: [],
      sources: [],
      personaVersion: "sejong-persona-v1",
      contentVersion: "sejong-content-v1",
    },
  });

  const final = await running;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(final.status, "cancelled");
  assert.equal(coordinator.get("turn_request_03").status, "cancelled");
});

test("request coordinator turns timeout into retryable upstream failure", async () => {
  const coordinator = new RequestCoordinator();
  const result = await coordinator.run(
    {
      requestId: "turn_request_04",
      operation: "turn",
      fingerprint: fingerprintJson({ text: "타임아웃" }),
      timeoutMs: 1,
    },
    async (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.code, "UPSTREAM_TIMEOUT");
  assert.equal(result.retryable, true);
});

test("request coordinator forwards external cancellation to running work", async () => {
  const coordinator = new RequestCoordinator();
  const controller = new AbortController();
  const running = coordinator.run(
    {
      requestId: "turn_request_05",
      operation: "turn",
      fingerprint: fingerprintJson({ text: "취소" }),
      timeoutMs: 1000,
      signal: controller.signal,
    },
    async (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );

  controller.abort();
  const result = await running;

  assert.equal(result.status, "cancelled");
});

test("timeout settles even when the provider ignores abort and never resolves", async () => {
  const coordinator = new RequestCoordinator();
  let signal;
  const result = await coordinator.run(
    { requestId: "non_cooperative", operation: "turn", fingerprint: "test", timeoutMs: 10 },
    (workSignal) => { signal = workSignal; return new Promise(() => {}); },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.code, "UPSTREAM_TIMEOUT");
  assert.equal(signal.aborted, true);
});

test("an already aborted parent never starts provider work", async () => {
  const coordinator = new RequestCoordinator();
  const parent = new AbortController();
  parent.abort();
  let calls = 0;
  const result = await coordinator.run(
    { requestId: "pre_aborted", operation: "turn", fingerprint: "test", timeoutMs: 1000, signal: parent.signal },
    async () => { calls += 1; throw new Error("must not start"); },
  );
  assert.equal(result.status, "cancelled");
  assert.equal(calls, 0);
});

test("fingerprintJson sorts nested object keys without changing array order", () => {
  const left = fingerprintJson({
    request: { text: "안녕", requestId: "turn_request_06" },
    recentConversation: [
      {
        answer: { text: "답", factIds: [], kind: "conversation" },
        question: "질문",
      },
    ],
  });
  const right = fingerprintJson({
    recentConversation: [
      {
        question: "질문",
        answer: { kind: "conversation", factIds: [], text: "답" },
      },
    ],
    request: { requestId: "turn_request_06", text: "안녕" },
  });
  const differentOrder = fingerprintJson({
    request: { requestId: "turn_request_06", text: "안녕" },
    recentConversation: [
      {
        question: "다른 질문",
        answer: { kind: "conversation", factIds: [], text: "다른 답" },
      },
      {
        question: "질문",
        answer: { kind: "conversation", factIds: [], text: "답" },
      },
    ],
  });

  assert.equal(left, right);
  assert.notEqual(left, differentOrder);
});
