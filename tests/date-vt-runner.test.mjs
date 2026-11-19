import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPilot } from '../evals/sejong/date-eval/pilot.mjs';
import { makePlan, hash, validateRun, validateRecordedInputs, executionPlan, validateExecutionPlan } from '../evals/sejong/date-eval/core.mjs';
import { runPlan, ruleAnswer } from '../evals/sejong/date-eval/runner.mjs';
import { codeGrade, createReviewPackets, finalizeReviews } from '../evals/sejong/date-eval/grading.mjs';
import { buildReport, compareReports } from '../evals/sejong/date-eval/report.mjs';
import { resolveRunState } from '../evals/sejong/date-eval/state.mjs';

const methods = ['evidence-validated', 'render-only', 'evidence-first', 'rule-baseline', 'prompt-baseline'];
async function fixture(repeats = 1) {
  const { dataset, gold } = await loadPilot();
  return makePlan(dataset, gold, { model: 'synthetic', endpoint: 'http://127.0.0.1:11434', think: false,
    options: { temperature: 0, seed: 62 }, timeoutMs: 100, retries: 0, repeats,
    seed: 62, runOrder: 'seeded', warmup: false, methods: methods.map(id => ({ id, version: 'synthetic-vt' })) });
}
function generator(p, seen = []) {
  return async (request, config, context) => {
    seen.push(context);
    assert.equal(request.prompt.includes('wrongExamples'), false);
    assert.equal(request.prompt.includes('requiresUnknownDay'), false);
    return { answer: ruleAnswer(p.dataset.cases.find(c => c.id === context.caseId)), inputTokens: 7, outputTokens: 3 };
  };
}
// Synthetic reviewer decisions test plumbing only, never historical correctness or real independence.
function mockFinal(p, run) {
  return { schemaVersion: 1, planId: p.id, criteriaHash: p.criteriaHash, runHash: hash(run), items: run.records.map(r => ({
    recordId: r.id, recordHash: hash(r), state: r.state === 'failed' ? 'execution-failure' : 'final',
    date: r.state === 'failed' ? 0 : 1, evidence: r.state === 'failed' ? 0 : 1,
    events: r.state === 'failed' ? [] : p.gold.cases.find(c => c.id === r.caseId).events.map(e => ({ id: e.id, date: 1,
      ...Object.fromEntries(Object.entries(e.eligibility).map(([k, v]) => [k, v ? 0 : null])) })),
  })), agreement: { fixture: true } };
}
test('five methods reuse exactly one P per question/repeat; zero additional T/V calls, resumable lineage', async () => {
  const p = await fixture(2), seen = [], pBytes = JSON.stringify(p);
  const run = await runPlan(p, { generate: generator(p, seen) });
  validateRecordedInputs(p, validateRun(p, run));
  assert.equal(run.records.length, 80); assert.equal(seen.length, 48);
  assert.equal(seen.filter(c => c.methodId === 'prompt-baseline').length, 16);
  assert.equal(seen.some(c => ['render-only', 'evidence-validated'].includes(c.methodId)), false);
  for (const r of run.records.filter(r => r.derivation)) {
    const parent = run.records.find(p => p.id === r.derivation.parentRecordId);
    assert.equal(parent.methodId, 'prompt-baseline'); assert.equal(parent.repeat, r.repeat);
    assert.equal(r.derivation.parentRecordHash, hash(parent)); assert.equal(r.calls, 0);
    assert.ok(run.records.indexOf(parent) < run.records.indexOf(r));
  }
  const complete = run.records.filter(r => r.methodId === 'prompt-baseline');
  const resumedSeen = [], resumed = await runPlan(p, { existingRecords: complete, generate: generator(p, resumedSeen) });
  validateRun(p, resumed);
  assert.equal(resumedSeen.filter(c => c.methodId === 'prompt-baseline').length, 0);
  assert.equal(JSON.stringify(p), pBytes);
});
test('T/V bind full P record and deterministic output; swapped parents, modified output, forged costs rejected', async () => {
  const p = await fixture(), run = await runPlan(p, { generate: generator(p) });
  for (const mutate of [
    r => { r.derivation.parentRecordHash = 'other'; }, r => { r.rawAnswer += ' changed'; },
    r => { r.calls = 1; }, r => { r.derivation.audit.extra = true; },
    r => { r.rawInput[0].sourceText += ' changed'; },
  ]) {
    const changed = structuredClone(run); mutate(changed.records.find(r => r.derivation));
    assert.throws(() => validateRun(p, changed), /T·V/);
  }
  assert.equal(hash(run), hash(structuredClone(run)));
});
test('all failures propagate P state and finalize as zero without Yujin grading; no denominator removed', async () => {
  const p0 = await fixture(), p = makePlan(p0.dataset, p0.gold, { ...p0.config,
    methods: p0.config.methods.filter(m => m.id !== 'rule-baseline') });
  const run = await runPlan(p, { generate: async () => { throw Object.assign(new Error('timeout'), { type: 'timeout', raw: 'partial' }); } });
  validateRun(p, run);
  assert.ok(run.records.every(r => r.state === 'failed'));
  const final = finalizeReviews(p, run, createReviewPackets(p, run), []);
  const report = buildReport(p, run, final);
  for (const m of report.methods) { assert.equal(m.operational.accuracy.value, 0); assert.equal(m.operational.fixedTotal, 8); }
  assert.equal(report.physicalBatchUsage.calls, 16); // failed E extraction prevents its second call
});
test('length-unknown P blocks all finals; inspecting P regenerates dependent states and preserves original', async () => {
  const p = await fixture(), run = await runPlan(p, { generate: async (...args) => ({ ...await generator(p)(...args), finishReason: 'length' }) });
  const originalHash = hash(run), parent = run.records.find(r => r.methodId === 'prompt-baseline');
  assert.equal(run.records.filter(r => r.derivation).every(r => r.state === 'unknown'), true);
  const resolved = resolveRunState(p, run, [{ recordId: parent.id, originalRecordHash: hash(parent), reviewerId: 'operator-maintainer', state: 'completed', reason: 'synthetic readable JSON checked', evidence: 'synthetic completed transport and full answer' }]);
  const derived = resolved.records.filter(r => r.derivation?.parentRecordId === parent.id);
  assert.equal(derived.length, 2); assert.ok(derived.every(r => r.state === 'completed'));
  validateRun(p, resolved); assert.equal(hash(run), originalHash);
  assert.throws(() => buildReport(p, run, mockFinal(p, run)), /unknown/);
});
test('malformed completed P is preserved in both T/V, graded as format failure not execution failure', async () => {
  const p = await fixture(), run = await runPlan(p, { generate: async () => ({ answer: '월만 알 수 있는 일반 문장', inputTokens: 2, outputTokens: 3 }) });
  validateRun(p, run);
  assert.ok(run.records.filter(r => r.derivation).every(r => r.state === 'completed' && r.rawAnswer === '월만 알 수 있는 일반 문장'));
  const code = codeGrade(p, run);
  assert.ok(code.items.filter(i => run.records.find(r => r.id === i.recordId)?.derivation).every(i => i.formatError));
  const pending = finalizeReviews(p, run, createReviewPackets(p, run), []);
  assert.ok(pending.items.some(i => i.state === 'pending'));
});
test('service cost includes same P plus postprocess; physical batch counts P only once; compare checks lineage', async () => {
  const p = await fixture(), run = await runPlan(p, { generate: generator(p) });
  const report = buildReport(p, run, mockFinal(p, run)), parent = report.methods.find(m => m.id === 'prompt-baseline');
  assert.equal(report.physicalBatchUsage.calls, 24); assert.equal(report.physicalBatchUsage.inputTokens.sum, 168);
  for (const id of ['render-only', 'evidence-validated']) {
    const derived = report.methods.find(m => m.id === id);
    assert.equal(derived.usage.calls, parent.usage.calls);
    assert.equal(derived.usage.inputTokens.sum, parent.usage.inputTokens.sum);
    assert.ok(derived.timing.totalItemElapsed.sum >= parent.timing.totalItemElapsed.sum);
  }
  compareReports(report, report);
  const changed = structuredClone(report); changed.entries.find(e => e.sharedGeneration).calls++;
  assert.throws(() => compareReports(changed, report), /shared generation/);
});
test('execution-only projection excludes gold, can run five methods and joins private grading plan', async () => {
  const p = await fixture(), publicPlan = executionPlan(p);
  assert.equal(Object.hasOwn(publicPlan, 'gold'), false);
  assert.equal(JSON.stringify(publicPlan).includes('wrongExamples'), false);
  const run = await runPlan(publicPlan, { generate: generator(p) });
  validateRecordedInputs(p, validateRun(p, run));
  assert.equal(codeGrade(p, run).items.length, 40);
  const altered = structuredClone(publicPlan); altered.gold = p.gold;
  assert.throws(() => validateExecutionPlan(altered), /정답표/);
  const forgedApproval = structuredClone(publicPlan); forgedApproval.goldReviewStatus = 'approved';
  assert.throws(() => validateExecutionPlan(forgedApproval), /승인 상태/);
  const final = makePlan({ ...p.dataset, split: 'final' }, { ...p.gold, datasetHash: hash({ ...p.dataset, split: 'final' }) }, p.config);
  await assert.rejects(runPlan(final, { generate: generator(p) }), /검수 승인/);
});
test('T/V-only resume makes no warmup calls and retains previous warmup costs; missing history is explicit', async () => {
  const base = await fixture(), p = makePlan(base.dataset, base.gold, { ...base.config, warmup: true,
    methods: base.config.methods.filter(m => m.id !== 'rule-baseline' && m.id !== 'evidence-first') });
  const seen = [];
  const generate = async (request, config, context) => {
    if (context.stage === 'warmup') { seen.push(context); return { answer: 'ready', inputTokens: 100, outputTokens: 10 }; }
    return generator(p, seen)(request, config, context);
  };
  const full = await runPlan(p, { generate }), parents = full.records.filter(r => r.methodId === 'prompt-baseline');
  assert.equal(seen.length, 9); const resumedCalls = [];
  const resumed = await runPlan(p, { existingRecords: parents, existingWarmup: full.warmup,
    existingWarmupHistoryComplete: full.warmupHistoryComplete,
    generate: async (...args) => { resumedCalls.push(args); throw new Error('must not call model'); } });
  validateRun(p, resumed); assert.equal(resumedCalls.length, 0);
  assert.equal(resumed.warmup.length, 1); assert.equal(resumed.warmup[0].result.inputTokens, 100);
  const report = buildReport(p, resumed, mockFinal(p, resumed));
  assert.equal(report.physicalBatchUsage.warmupHistoryComplete, true);
  assert.equal(report.batchWallComplete, false);
  const withoutHistory = await runPlan(p, { existingRecords: parents, generate: async () => { throw new Error('must not call'); } });
  const partial = buildReport(p, withoutHistory, mockFinal(p, withoutHistory));
  assert.equal(partial.physicalBatchUsage.warmupHistoryComplete, false);
  assert.match(partial.physicalBatchUsage.warmupCostScope, /partial/);
});
test('shared P unknown usage remains unknown for T/V and known partial attempts count once physically', async () => {
  const base = await fixture(), p = makePlan(base.dataset, base.gold, { ...base.config, retries: 1 });
  const run = await runPlan(p, { generate: async (request, config, context) => {
    if (context.methodId === 'prompt-baseline' && context.attempt === 0) {
      throw Object.assign(new Error('synthetic retry'), { inputTokens: 5, outputTokens: null });
    }
    return generator(p)(request, config, context);
  } });
  const report = buildReport(p, run, mockFinal(p, run));
  for (const id of ['prompt-baseline', 'render-only', 'evidence-validated']) {
    const m = report.methods.find(m => m.id === id);
    assert.equal(m.usage.calls, 16); assert.equal(m.usage.inputTokens.sum, 96);
    assert.equal(m.usage.outputTokens.sum, null); assert.equal(m.usage.outputTokens.partialKnownSum, 24);
  }
  assert.equal(report.physicalBatchUsage.calls, 32);
  assert.equal(report.physicalBatchUsage.inputTokens.sum, 208);
  assert.equal(report.physicalBatchUsage.outputTokens.sum, null);
  assert.equal(report.physicalBatchUsage.outputTokens.partialKnownSum, 72);
  const changed = structuredClone(report); changed.physicalBatchUsage.calls++;
  assert.throws(() => compareReports(changed, report), /physical batch cost/);
});

test('warmup history remains partial across repeated resumes, even after a new recorded warmup', async () => {
  const base = await fixture(), p = makePlan(base.dataset, base.gold, { ...base.config, warmup: true });
  const generate = async (request, config, context) => context.stage === 'warmup'
    ? { answer: 'ready', inputTokens: 100, outputTokens: 10 } : generator(p)(request, config, context);
  const full = await runPlan(p, { generate });
  const skipped = full.records.find(r => r.methodId === 'prompt-baseline').id;
  const first = await runPlan(p, { existingRecords: full.records.filter(r => !r.derivation && r.id !== skipped), generate });
  assert.equal(first.warmupHistoryComplete, false); assert.equal(first.warmup.length, 1);
  const second = await runPlan(p, { existingRecords: first.records, existingWarmup: first.warmup,
    existingWarmupHistoryComplete: first.warmupHistoryComplete, generate: async () => assert.fail('unexpected call') });
  const report = buildReport(p, second, mockFinal(p, second));
  assert.equal(report.physicalBatchUsage.warmupHistoryComplete, false);
  assert.match(report.physicalBatchUsage.warmupCostScope, /partial/);
  const omittedFlag = await runPlan(p, { existingRecords: first.records, existingWarmup: first.warmup });
  assert.equal(omittedFlag.warmupHistoryComplete, false);
  const empty = await runPlan(p, { existingRecords: full.records });
  const again = await runPlan(p, { existingRecords: empty.records, existingWarmup: empty.warmup });
  assert.equal(again.warmupHistoryComplete, false);
  await assert.rejects(runPlan(p, { existingWarmupHistoryComplete: 'true' }), /이력 상태/);
});

test('status inspection preserves original postprocess latency and adds extra physical work separately', async () => {
  const p = await fixture(), run = await runPlan(p, { generate: generator(p) });
  const parent = run.records.find(r => r.methodId === 'prompt-baseline');
  const oldDerived = run.records.filter(r => r.derivation?.parentRecordId === parent.id);
  oldDerived.forEach(r => { r.elapsedMs = 100; }); // fixed measured synthetic cost
  const originalHash = hash(run), before = buildReport(p, run, mockFinal(p, run));
  const resolved = resolveRunState(p, run, [{ recordId: parent.id, originalRecordHash: hash(parent),
    reviewerId: 'maintainer', state: 'failed', reason: 'synthetic unreadable transport',
    evidence: 'synthetic status correction, not content grading' }]);
  assert.equal(hash(run), originalHash);
  let extra = 0;
  for (const old of oldDerived) {
    const current = resolved.records.find(r => r.id === old.id);
    assert.equal(current.elapsedMs, old.elapsedMs); assert.equal(current.postprocessInspections.length, 1);
    assert.equal(current.postprocessInspections[0].sourceRecordHash, hash(old));
    extra += current.postprocessInspections[0].elapsedMs;
  }
  const after = buildReport(p, resolved, mockFinal(p, resolved));
  assert.ok(Math.abs(after.physicalBatchUsage.itemElapsedMs - before.physicalBatchUsage.itemElapsedMs - extra) < 0.000001);
  assert.equal(after.physicalBatchUsage.postprocessInspectionElapsedMs, extra);
  for (const id of ['render-only', 'evidence-validated']) {
    assert.equal(after.methods.find(m => m.id === id).timing.totalItemElapsed.sum,
      before.methods.find(m => m.id === id).timing.totalItemElapsed.sum);
  }
  compareReports(after, after);
  const bad = structuredClone(resolved);
  bad.records.find(r => r.postprocessInspections).postprocessInspections[0].elapsedMs = -1;
  assert.throws(() => validateRun(p, bad), /상태 정정 비용/);
  const forged = structuredClone(after); forged.physicalBatchUsage.postprocessInspectionElapsedMs++;
  assert.throws(() => compareReports(forged, after), /physical batch cost/);
});
