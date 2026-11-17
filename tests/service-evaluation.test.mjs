import test from "node:test";
import assert from "node:assert/strict";
import { checkPublicAnswer, compareRuns, markdownReport, parseJudgments, summarize } from "../scripts/service-evaluation.mjs";

const source = { id: "source", title: "자료", institution: "기관", url: "https://example.org/source" };
const promptInput = { reviewedFacts: [{ id: "fact", sourceIds: ["source"] }], sources: [source] };
const testCase = { expectedKind: "grounded", expectedFacts: ["fact"] };
const answer = { answerId: "answer", kind: "grounded", text: "승인된 답변", factIds: ["fact"], sources: [source], personaVersion: "v1", contentVersion: "v1" };
const record = { caseId: "Q1", status: "mocked", serverStatus: "approved", validationStatus: "completed", answer };

test("valid source IDs cannot hide a changed source URL or an unapproved fact", () => {
  assert.equal(checkPublicAnswer(record, testCase, promptInput).sources.verdict, "pass");
  const altered = { ...record, answer: { ...answer, sources: [{ ...source, url: "https://example.org/wrong" }] } };
  assert.equal(checkPublicAnswer(altered, testCase, promptInput).sources.verdict, "fail");
  assert.equal(checkPublicAnswer({ ...record, answer: { ...answer, factIds: ["pending-fact"] } }, testCase, promptInput).factIds.verdict, "fail");
});

test("a fluent fallback is a wrong refusal for an answerable question", () => {
  const blocked = { ...record, serverStatus: "blocked", answer: { ...answer, kind: "fallback", factIds: [], sources: [] } };
  assert.equal(checkPublicAnswer(blocked, testCase, promptInput).expectedBehavior.verdict, "fail");
});

test("malformed judge items retain other independently valid judgments", () => {
  const parsed = parseJudgments(JSON.stringify({ persona: { verdict: "pass", reason: "1인칭", evidence: ["나는"] }, relevance: { verdict: "pass" } }), ["persona", "relevance"]);
  assert.equal(parsed.persona.verdict, "pass");
  assert.equal(parsed.relevance.verdict, "ungraded");
  assert.equal(parseJudgments("broken", ["grounding"]).grounding.verdict, "ungraded");
});

test("indeterminate and judge errors do not enter the pass-rate denominator", () => {
  const records = ["pass", "fail", "indeterminate", "ungraded"].map((verdict) => ({ ai: { persona: { verdict } } }));
  const summary = summarize(records).ai.persona;
  assert.equal(summary.denominator, 2);
  assert.equal(summary.passRate, 0.5);
  assert.equal(summary.coverage, 0.5);
  assert.equal(summarize([{ ai: { persona: { verdict: "ungraded" } } }]).ai.persona.passRate, null);
});

test("comparison rejects changed questions, missing cases and changed selected evidence", () => {
  const before = { runId: "before", conditions: { questionsHash: "q", knowledgeHash: "k", judgeConfigHash: "j", generationConfigHash: "g", evaluatorHash: "e", mode: "mock" }, records: [{ ...record, selectedFactsHash: "f" }] };
  const after = { ...before, runId: "after", serviceChange: "생성 프롬프트 수정" };
  assert.equal(compareRuns(before, after).comparable, true);
  assert.equal(compareRuns(before, { ...after, records: [] }).comparable, false);
  assert.equal(compareRuns(before, { ...after, conditions: { ...after.conditions, questionsHash: "changed" } }).comparable, false);
  assert.equal(compareRuns(before, { ...after, records: [{ ...record, selectedFactsHash: "changed" }] }).comparable, false);
});

test("report distinguishes execution errors, partial judgments and unknown cost from zero", () => {
  const run = { runId: "report-fixture", conditions: { mode: "mock", criteriaStatus: "초안" }, records: [
    { caseId: "Q1", status: "failed", validationStatus: "not-run", serverStatus: "failed",
      error: { code: "UPSTREAM_TIMEOUT" }, judgeStatus: "not-run", estimatedCostUsd: null,
      judgeEstimatedCostUsd: 0, ai: { persona: { verdict: "ungraded", reason: "생성 오류", evidence: [] } } },
    { ...record, caseId: "Q2", judgeStatus: "partial", ai: {
      persona: { verdict: "pass", reason: "1인칭", evidence: [] },
      relevance: { verdict: "ungraded", reason: "judge_item_format_error|추가\n설명", evidence: [] },
    }, calibrationExpected: { persona: "pass", relevance: "fail" } },
  ] };
  const report = markdownReport(run);
  assert.match(report, /generation: UPSTREAM_TIMEOUT/);
  assert.match(report, /ai\.relevance=ungraded: judge_item_format_error\\\|추가 설명/);
  assert.ok(report.includes("| Q1 | 미확인 | 미확인 | 미확인 | 0 |"));
  assert.ok(report.includes("| Q2 | persona | pass | pass | 일치 |"));
  assert.ok(report.includes("| Q2 | relevance | fail | ungraded | 불일치 |"));
  assert.match(report, /생성·검증 구간/);
  assert.match(report, /실제 발화 끝→첫 소리/);
});
