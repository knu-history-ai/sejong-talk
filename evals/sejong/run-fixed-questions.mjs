import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import cases from "./fixed-questions.json" with { type: "json" };
import criteria from "../../scripts/service-evaluation-criteria.json" with { type: "json" };
import calibration from "../../tests/fixtures/service-judge-calibration.json" with { type: "json" };
import { parseAnswerDraftFromText, validateAnswerDraft } from "../../src/server/ai/answer.ts";
import { requestOllamaCandidate, readOllamaConfig, buildOllamaRequestBody } from "../../src/server/ai/ollama-request.ts";
import { buildSejongAnswerPrompt, buildSejongPromptInput } from "../../src/server/ai/prompt.ts";
import { loadSejongKnowledgeBase, selectReviewedFactsForQuestion } from "../../src/server/content/sejong.ts";
import { CRITERIA_VERSION, JUDGE_PROMPT_VERSION, buildJudgePrompt, checkPublicAnswer, compareRuns,
  hash, markdownReport, parseJudgments, summarize, ungraded } from "../../scripts/service-evaluation.mjs";

const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (option("before") || option("after")) {
  if (!option("before") || !option("after")) throw new Error("--before=파일 --after=파일이 모두 필요합니다.");
  const before = JSON.parse(await readFile(option("before"), "utf8"));
  const after = JSON.parse(await readFile(option("after"), "utf8"));
  console.log(JSON.stringify(compareRuns(before, after), null, 2));
} else {
  const useMock = !args.includes("--live");
  if (!useMock && args.includes("--mock")) throw new Error("--live와 --mock은 함께 사용할 수 없습니다.");
  const judgeMode = option("judge") ?? (useMock ? "mock" : "none");
  if (!["mock", "none", "ollama"].includes(judgeMode) || (useMock && judgeMode === "ollama") || (!useMock && judgeMode === "mock")) {
    throw new Error("모의 실행은 mock|none, 실제 실행은 ollama|none 채점기를 지정합니다.");
  }
  const knowledgeBase = await loadSejongKnowledgeBase();
  const config = readOllamaConfig(process.env);
  const judgeConfig = { ...config, model: process.env.EVAL_JUDGE_MODEL?.trim() || config.model, usageStage: "llm_verification" };
  const runId = `run_${new Date().toISOString().replaceAll(":", "-")}_${randomUUID().slice(0, 8)}`;
  const records = [];
  const preparedCases = (args.includes("--calibrate") ? calibration.cases.map((fixture) => ({
    ...cases.find((item) => item.id === fixture.questionId), id: fixture.id, questionId: fixture.questionId,
    fixtureAnswer: fixture.answer, calibrationExpected: fixture.expected,
  })) : cases).map((testCase) => {
    const rule = criteria.cases[testCase.questionId ?? testCase.id];
    if (!rule || !rule.aiItems?.length) throw new Error(`${testCase.id}: 평가 기준이 없습니다.`);
    return { ...testCase, ...rule, history: testCase.history ?? [] };
  });
  const approvedFacts = knowledgeBase.facts.filter((fact) => fact.reviewStatus === "approved");
  const conditions = {
    criteriaVersion: CRITERIA_VERSION, criteriaStatus: criteria.status,
    questionsHash: hash({ cases: preparedCases, criteria }),
    knowledgeHash: hash({ character: knowledgeBase.character, approvedFacts, sources: knowledgeBase.sources }),
    judgeConfigHash: hash({ mode: judgeMode, config: judgeConfig, promptVersion: JUDGE_PROMPT_VERSION,
      promptBuilder: buildJudgePrompt.toString(), parser: parseJudgments.toString() }),
    generationConfigHash: hash({ mode: useMock ? "mock" : "ollama", config, body: buildOllamaRequestBody("", config.model) }),
    evaluatorHash: hash({ checker: checkPublicAnswer.toString(), summary: summarize.toString(), version: CRITERIA_VERSION }),
    mode: `${useMock ? "mock" : "live"}${args.includes("--calibrate") ? "-calibration" : ""}`,
  };
  for (const testCase of preparedCases) {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const reviewedFacts = selectReviewedFactsForQuestion(knowledgeBase, testCase.input);
    const promptInput = buildSejongPromptInput({ knowledgeBase,
      request: { requestId: `${testCase.id}_${runId}`, text: testCase.input }, reviewedFacts, recentConversation: testCase.history });
    const prompt = buildSejongAnswerPrompt(promptInput);
    const record = { runId, caseId: testCase.id, category: testCase.category,
      provider: useMock ? "mock" : "ollama", model: useMock ? "fixture-v1" : config.model,
      status: "failed", startedAt, selectedFactIds: reviewedFacts.map((fact) => fact.id),
      selectedFactsHash: hash(reviewedFacts), expectedKind: testCase.expectedKind, expectedFacts: testCase.expectedFacts,
      history: testCase.history, candidate: null, answer: null, serverStatus: "failed", validationStatus: "not-run",
      calibrationExpected: testCase.calibrationExpected ?? null,
      blockReason: "미확인", usage: null, estimatedCostUsd: useMock ? 0 : null,
      judgeUsage: null, judgeEstimatedCostUsd: judgeMode === "mock" || judgeMode === "none" ? 0 : null,
      judgeStatus: "not-run", error: null };
    try {
      const result = useMock || testCase.fixtureAnswer ? { text: JSON.stringify(testCase.fixtureAnswer ?? { kind: testCase.expectedKind,
        text: testCase.allowedExample, factIds: testCase.expectedFacts }), usage: null, attempts: 0 }
        : await requestOllamaCandidate(prompt, config);
      record.candidate = result.text;
      record.usage = result.usage;
      record.attempts = result.attempts;
      record.status = useMock || testCase.fixtureAnswer ? "mocked" : "completed";
      if (testCase.fixtureAnswer) { record.provider = "calibration-fixture"; record.model = "fixture-v1"; record.estimatedCostUsd = 0; }
      try {
        record.answer = validateAnswerDraft(parseAnswerDraftFromText(result.text), promptInput, { answerId: `answer_${testCase.id}_${runId}` });
        record.validationStatus = "completed";
        record.serverStatus = record.answer.kind === "fallback" ? "blocked" : "approved";
        record.blockReason = record.serverStatus === "blocked" ? "미확인" : null;
      } catch {
        record.validationStatus = "failed";
        record.blockReason = "candidate_format_error";
      }
    } catch (error) {
      record.error = { code: error?.code ?? "UNAVAILABLE", name: error?.name ?? "Error" };
    }
    record.completedAt = new Date().toISOString();
    record.latencyMs = performance.now() - started;
    record.code = checkPublicAnswer(record, testCase, promptInput);
    record.ai = Object.fromEntries(testCase.aiItems.map((key) => [key, ungraded("채점 미실행 또는 공개 답변 없음")]));
    if (record.answer && judgeMode !== "none") {
      const judgeStarted = performance.now();
      record.judgeStartedAt = new Date().toISOString();
      try {
        if (judgeMode === "mock") {
          // These fixture labels exercise reporting only, not arbitrary answer semantics.
          record.ai = Object.fromEntries(testCase.aiItems.map((key) => [key, {
            verdict: testCase.calibrationExpected ? testCase.calibrationExpected[key] ?? "indeterminate"
              : record.serverStatus === "blocked" ? (key === "relevance" ? "fail" : "indeterminate") : "pass",
            reason: "고정 모의 정답 예시의 예정 판정. 실제 AI 평가가 아님.", evidence: [testCase.allowedExample],
          }]));
          record.judgeStatus = "mocked";
        } else {
          const judged = await requestOllamaCandidate(buildJudgePrompt(testCase, record.answer, promptInput), judgeConfig);
          record.judgeUsage = judged.usage;
          record.ai = parseJudgments(judged.text, testCase.aiItems);
          const missing = Object.values(record.ai).filter((item) => item.verdict === "ungraded").length;
          record.judgeStatus = missing === testCase.aiItems.length ? "failed" : missing ? "partial" : "completed";
        }
      } catch (error) {
        record.judgeStatus = "failed";
        record.judgeError = { code: error?.code ?? "UNAVAILABLE", name: error?.name ?? "Error" };
        record.ai = Object.fromEntries(testCase.aiItems.map((key) => [key, ungraded(record.judgeError.code)]));
      }
      record.judgeCompletedAt = new Date().toISOString();
      record.judgeLatencyMs = performance.now() - judgeStarted;
    }
    if (testCase.calibrationExpected) record.calibrationMismatches = Object.entries(testCase.calibrationExpected)
      .filter(([key, expected]) => record.ai[key]?.verdict !== expected).map(([key]) => key);
    records.push(record);
  }
  const git = (...command) => execFileSync("git", command, { encoding: "utf8" }).trim();
  const output = { schemaVersion: 1, runId, createdAt: new Date().toISOString(), conditions,
    generationConfig: { model: config.model, timeoutMs: config.timeoutMs, maxAttempts: config.maxAttempts,
      requestBody: buildOllamaRequestBody("", config.model) },
    judgeConfig: { mode: judgeMode, model: judgeConfig.model, timeoutMs: judgeConfig.timeoutMs,
      maxAttempts: judgeConfig.maxAttempts, promptVersion: JUDGE_PROMPT_VERSION },
    revision: git("rev-parse", "HEAD"), worktreeDiffHash: hash(git("diff", "HEAD")),
    serviceChange: option("change") ?? null, generationPromptHash: hash(buildSejongAnswerPrompt.toString()),
    judgeModel: judgeMode === "ollama" ? judgeConfig.model : judgeMode, records, summary: summarize(records),
    note: "모델 식별은 설정값 기준이며 실제 모델 가중치 동일성을 검증하지 않음. 실제 AI 채점 성능 미검증." };
  await mkdir(new URL("./results/", import.meta.url), { recursive: true });
  const outputPath = new URL(`./results/${runId}.json`, import.meta.url);
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(new URL(`./results/${runId}.md`, import.meta.url), markdownReport(output), { encoding: "utf8", flag: "wx" });
  console.log(`Wrote ${outputPath.pathname}`);
  console.log(markdownReport(output));
}
