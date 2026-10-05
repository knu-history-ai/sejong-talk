import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import cases from "./fixed-questions.json" with { type: "json" };
import { parseAnswerDraftFromText, validateAnswerDraft } from "../../src/server/ai/answer.ts";
import {
  requestGeminiCandidate,
  readGeminiConfig,
} from "../../src/server/ai/gemini-request.ts";
import {
  buildSejongAnswerPrompt,
  buildSejongPromptInput,
} from "../../src/server/ai/prompt.ts";
import {
  loadSejongKnowledgeBase,
  selectReviewedFactsForQuestion,
} from "../../src/server/content/sejong.ts";

const useMock = process.argv.includes("--mock");
const runId = `run_${new Date().toISOString().replaceAll(":", "-")}_${randomUUID().slice(0, 8)}`;

function mockCandidate(testCase) {
  if (testCase.id === "Q01") {
    return JSON.stringify({
      kind: "grounded",
      text: "훈민정음은 처음에 스물여덟 글자였단다. 백성들이 자기 뜻을 쉽게 적도록 만들었다는 점도 함께 기억하면 좋겠구나.",
      factIds: ["sejong_hunminjeongeum_28_letters", "sejong_hunminjeongeum_purpose"],
    });
  }
  if (testCase.id === "Q03") {
    return JSON.stringify({
      kind: "conversation",
      text: "나는 세종과의 대화를 이어가도록 마련된 AI란다. 이순신 장군 이야기가 궁금하다면 다음 인물 확장에서 다루어 보자.",
      factIds: [],
    });
  }
  return JSON.stringify({
    kind: "insufficient",
    text: "그 질문은 지금 준비된 자료로 확인하기 어렵구나. 세종 때의 생활이나 훈민정음에 관한 질문으로 바꾸어 물어보면 좋겠다.",
    factIds: [],
  });
}

function estimateCostUsd(usage) {
  if (usage.inputTokens === null || usage.outputTokens === null) {
    return null;
  }

  const inputCost = (usage.inputTokens / 1_000_000) * 0.3;
  const outputCost = (usage.outputTokens / 1_000_000) * 2.5;
  return Number((inputCost + outputCost).toFixed(6));
}

const knowledgeBase = await loadSejongKnowledgeBase();
let config = null;
if (!useMock) {
  try {
    config = readGeminiConfig(process.env);
  } catch {
    config = null;
  }
}

const records = [];
for (const testCase of cases) {
  const startedAt = new Date();
  const request = { requestId: `${testCase.id}_${runId}`, text: testCase.input };
  const reviewedFacts = selectReviewedFactsForQuestion(knowledgeBase, testCase.input);
  const promptInput = buildSejongPromptInput({
    knowledgeBase,
    request,
    reviewedFacts,
    recentConversation: [],
  });
  const prompt = buildSejongAnswerPrompt(promptInput);

  try {
    let rawText;
    let usage = { inputTokens: null, outputTokens: null, totalTokens: null };
    let attempts = 0;
    let status = "skipped";
    let error = null;

    if (useMock) {
      rawText = mockCandidate(testCase);
      status = "mocked";
      attempts = 0;
    } else if (!config) {
      rawText = "";
      error = { code: "UNAVAILABLE", message: "GEMINI_API_KEY is not configured." };
    } else {
      const result = await requestGeminiCandidate(prompt, config);
      rawText = result.text;
      usage = result.usage;
      attempts = result.attempts;
      status = "completed";
    }

    const answer = rawText
      ? validateAnswerDraft(
          parseAnswerDraftFromText(rawText),
          promptInput,
          { answerId: `answer_${testCase.id}_${runId}` },
        )
      : null;

    const completedAt = new Date();
    records.push({
      runId,
      caseId: testCase.id,
      category: testCase.category,
      provider: config ? "gemini" : useMock ? "mock" : "gemini-unconfigured",
      model: config?.model ?? "not-run",
      status,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      latencyMs: completedAt.getTime() - startedAt.getTime(),
      attempts,
      selectedFactIds: reviewedFacts.map((fact) => fact.id),
      expectedKind: testCase.expectedKind,
      expectedFacts: testCase.expectedFacts,
      answer,
      usage,
      estimatedCostUsd: estimateCostUsd(usage),
      error,
    });
  } catch (error) {
    const completedAt = new Date();
    records.push({
      runId,
      caseId: testCase.id,
      category: testCase.category,
      provider: config ? "gemini" : "mock",
      model: config?.model ?? "not-run",
      status: "failed",
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      latencyMs: completedAt.getTime() - startedAt.getTime(),
      attempts: null,
      selectedFactIds: reviewedFacts.map((fact) => fact.id),
      expectedKind: testCase.expectedKind,
      expectedFacts: testCase.expectedFacts,
      answer: null,
      usage: { inputTokens: null, outputTokens: null, totalTokens: null },
      estimatedCostUsd: null,
      error: {
        name: error?.name ?? "Error",
        code: error?.code ?? "UNAVAILABLE",
        retryable: Boolean(error?.retryable),
        message: error?.message ?? "Unknown error",
      },
    });
  }
}

const output = {
  runId,
  createdAt: new Date().toISOString(),
  note: "Generated eval outputs are ignored by Git. Do not commit API keys or raw private conversation logs.",
  records,
};

await mkdir(new URL("./results/", import.meta.url), { recursive: true });
const outputPath = new URL(`./results/${runId}.json`, import.meta.url);
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf-8");

console.log(`Wrote ${outputPath.pathname}`);
for (const record of records) {
  console.log(`${record.caseId}: ${record.status} (${record.latencyMs}ms)`);
}
