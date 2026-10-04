import test from "node:test";
import assert from "node:assert/strict";

import {
  parseAnswerDraftFromText,
  validateAnswerDraft,
} from "../src/server/ai/answer.ts";
import {
  extractGeminiText,
  readGeminiConfig,
  requestGeminiCandidate,
  GeminiRequestError,
} from "../src/server/ai/gemini-request.ts";
import {
  buildSejongAnswerPrompt,
  buildSejongPromptInput,
} from "../src/server/ai/prompt.ts";
import {
  buildSejongTurnFingerprint,
  runCoordinatedSejongTurn,
} from "../src/server/ai/turn-runner.ts";
import {
  loadSejongKnowledgeBase,
  selectReviewedFactsForQuestion,
} from "../src/server/content/sejong.ts";
import { RequestCoordinator } from "../src/server/requests/index.ts";

test("Sejong prompt input separates character, recent turns, and approved facts", async () => {
  const knowledgeBase = await loadSejongKnowledgeBase();
  const request = {
    requestId: "turn_test_01",
    text: "훈민정음은 처음에 몇 글자였어요?",
  };
  const reviewedFacts = selectReviewedFactsForQuestion(
    knowledgeBase,
    request.text,
  );
  const promptInput = buildSejongPromptInput({
    knowledgeBase,
    request,
    reviewedFacts,
    recentConversation: [
      {
        question: "왜 만들었어요?",
        answer: {
          kind: "grounded",
          text: "백성들이 쉽게 글을 쓰도록 만들었단다.",
          factIds: ["sejong_hunminjeongeum_purpose"],
        },
      },
    ],
  });
  const prompt = buildSejongAnswerPrompt(promptInput);

  assert.equal(promptInput.character.id, "sejong");
  assert.deepEqual(
    promptInput.reviewedFacts.map((fact) => fact.reviewStatus),
    ["approved"],
  );
  assert.ok(
    promptInput.reviewedFacts.some(
      (fact) => fact.id === "sejong_hunminjeongeum_28_letters",
    ),
  );
  assert.doesNotMatch(prompt, /sejong_private_feeling_pending/);
  assert.match(prompt, /\[서버 인물 설정\]/);
  assert.match(prompt, /\[최근 승인 대화\]/);
  assert.match(prompt, /\[검토 완료 사실 카드\]/);
  assert.match(prompt, /\[사용자 질문\]/);
});

test("answer validation only exposes server-approved fact IDs and sources", async () => {
  const knowledgeBase = await loadSejongKnowledgeBase();
  const request = {
    requestId: "turn_test_02",
    text: "훈민정음은 처음에 몇 글자였어요?",
  };
  const promptInput = buildSejongPromptInput({
    knowledgeBase,
    request,
    reviewedFacts: selectReviewedFactsForQuestion(knowledgeBase, request.text),
  });

  const answer = validateAnswerDraft(
    {
      kind: "grounded",
      text: "훈민정음은 처음에 스물여덟 글자였단다.",
      factIds: [
        "sejong_hunminjeongeum_28_letters",
        "sejong_private_feeling_pending",
      ],
    },
    promptInput,
    { answerId: "answer_test_02" },
  );

  assert.equal(answer.kind, "grounded");
  assert.deepEqual(answer.factIds, ["sejong_hunminjeongeum_28_letters"]);
  assert.equal(answer.sources.length, 1);
  assert.equal(answer.sources[0].id, "source_urihistory_hunminjeongeum");
});

test("invalid grounded draft becomes fallback instead of exposing unverified text", async () => {
  const knowledgeBase = await loadSejongKnowledgeBase();
  const request = { requestId: "turn_test_03", text: "세종은 커피를 마셨나요?" };
  const promptInput = buildSejongPromptInput({
    knowledgeBase,
    request,
    reviewedFacts: selectReviewedFactsForQuestion(knowledgeBase, request.text),
  });

  const answer = validateAnswerDraft(
    {
      kind: "grounded",
      text: "세종은 커피를 좋아했단다.",
      factIds: ["sejong_private_feeling_pending"],
    },
    promptInput,
    { answerId: "answer_test_03" },
  );

  assert.equal(answer.kind, "fallback");
  assert.deepEqual(answer.factIds, []);
  assert.deepEqual(answer.sources, []);
});

test("Gemini text extraction ignores thought parts and parses JSON fences", () => {
  const text = extractGeminiText({
    candidates: [
      {
        content: {
          parts: [
            { thought: true, text: "내부 추론" },
            {
              text: '```json\n{"kind":"conversation","text":"반갑구나.","factIds":[]}\n```',
            },
          ],
        },
      },
    ],
  });
  const draft = parseAnswerDraftFromText(text);

  assert.deepEqual(draft, {
    kind: "conversation",
    text: "반갑구나.",
    factIds: [],
  });
});

test("Gemini request retries retryable provider failures without exposing body", async () => {
  let calls = 0;
  const fetchMock = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("provider-secret-error", { status: 503 });
    }
    return Response.json({
      candidates: [{ content: { parts: [{ text: '{"kind":"conversation","text":"좋다.","factIds":[]}' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    });
  };
  const config = {
    ...readGeminiConfig({ GEMINI_API_KEY: "test-key" }),
    retryBaseDelayMs: 0,
  };

  const result = await requestGeminiCandidate("prompt", config, fetchMock);

  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.usage.totalTokens, 15);
  assert.doesNotMatch(result.text, /provider-secret-error|test-key/);
});

test("Gemini request maps rate limits to shared error code", async () => {
  const fetchMock = async () =>
    new Response("quota secret", { status: 429, headers: { "retry-after": "30" } });
  const config = {
    ...readGeminiConfig({ GEMINI_API_KEY: "test-key" }),
    retryBaseDelayMs: 0,
    maxAttempts: 1,
  };

  await assert.rejects(
    requestGeminiCandidate("prompt", config, fetchMock),
    (error) => {
      assert.ok(error instanceof GeminiRequestError);
      assert.equal(error.code, "LIMIT_EXCEEDED");
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterSeconds, 30);
      assert.doesNotMatch(error.message, /quota secret|test-key/);
      return true;
    },
  );
});

test("coordinated Sejong turn passes session recent conversation and stores approved answer", async () => {
  const coordinator = new RequestCoordinator();
  const recentConversation = [
    {
      question: "훈민정음은 왜 만들었어요?",
      answer: {
        kind: "grounded",
        text: "백성들이 쉽게 글을 쓰도록 만들었단다.",
        factIds: ["sejong_hunminjeongeum_purpose"],
      },
    },
  ];
  let seenRecentConversation;
  let savedTurn;

  const result = await runCoordinatedSejongTurn({
    coordinator,
    request: {
      requestId: "turn_runner_01",
      text: "훈민정음은 처음에 몇 글자였어요?",
    },
    recentConversation,
    timeoutMs: 1000,
    generateTurn: async ({ recentConversation: generatedRecent }) => {
      seenRecentConversation = generatedRecent;
      return {
        requestId: "turn_runner_01",
        operation: "turn",
        status: "approved",
        answer: {
          answerId: "answer_runner_01",
          kind: "grounded",
          text: "훈민정음은 처음에 스물여덟 글자였단다.",
          factIds: ["sejong_hunminjeongeum_28_letters"],
          sources: [],
          personaVersion: "sejong-persona-v1",
          contentVersion: "sejong-content-v1",
        },
      };
    },
    onApprovedTurn: async (turn) => {
      savedTurn = turn;
    },
  });

  assert.equal(result.status, "approved");
  assert.deepEqual(seenRecentConversation, recentConversation);
  assert.equal(savedTurn.answer.factIds[0], "sejong_hunminjeongeum_28_letters");
});

test("coordinated Sejong turn discards late answer after session becomes inactive", async () => {
  const coordinator = new RequestCoordinator();
  let active = true;
  let saveCalls = 0;

  const result = await runCoordinatedSejongTurn({
    coordinator,
    request: { requestId: "turn_runner_02", text: "세종은 누구예요?" },
    timeoutMs: 1000,
    isSessionActive: () => active,
    generateTurn: async () => {
      active = false;
      return {
        requestId: "turn_runner_02",
        operation: "turn",
        status: "approved",
        answer: {
          answerId: "answer_runner_late",
          kind: "conversation",
          text: "늦게 도착한 답변",
          factIds: [],
          sources: [],
          personaVersion: "sejong-persona-v1",
          contentVersion: "sejong-content-v1",
        },
      };
    },
    onApprovedTurn: async () => {
      saveCalls += 1;
    },
  });

  assert.equal(result.status, "cancelled");
  assert.equal(saveCalls, 0);
});

test("coordinated Sejong turn rejects expired session before LLM call", async () => {
  const coordinator = new RequestCoordinator();
  let calls = 0;

  const result = await runCoordinatedSejongTurn({
    coordinator,
    request: { requestId: "turn_runner_03", text: "안녕" },
    isSessionActive: () => false,
    generateTurn: async () => {
      calls += 1;
      throw new Error("must not run");
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.code, "SESSION_EXPIRED");
  assert.equal(calls, 0);
});

test("Sejong turn fingerprint is stable for nested recent conversation keys", () => {
  const first = buildSejongTurnFingerprint({
    request: { requestId: "turn_runner_04", text: "안녕" },
    recentConversation: [
      {
        question: "이전 질문",
        answer: { kind: "conversation", text: "이전 답", factIds: [] },
      },
    ],
  });
  const second = buildSejongTurnFingerprint({
    recentConversation: [
      {
        answer: { factIds: [], text: "이전 답", kind: "conversation" },
        question: "이전 질문",
      },
    ],
    request: { text: "안녕", requestId: "turn_runner_04" },
  });

  assert.equal(first, second);
});
