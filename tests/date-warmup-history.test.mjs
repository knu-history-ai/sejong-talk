import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, makePlan } from '../evals/sejong/date-eval/core.mjs';
import { runPlan, METHOD_VERSION } from '../evals/sejong/date-eval/runner.mjs';
import { buildAutomaticReport, validateAutomaticReport } from '../evals/sejong/date-eval/automatic.mjs';

// Synthetic in-memory inputs only. Every execution injects its generator;
// no private source/gold files, model services, or network calls are used.
const METHODS = ['rule-baseline', 'prompt-baseline', 'evidence-first', 'render-only', 'evidence-validated'];
const DATE = { year: 2000, month: 3, day: 10, calendar: 'lunar' };
const WARMUP = { answer: 'ready', elapsedMs: 4, inputTokens: 11, outputTokens: 2 };
function fixture({ warmup = true, methods = ['prompt-baseline'] } = {}) {
  const sourceText = '기사 표제 날짜: 2000년 3월 20일\n본문: 2000년 3월 10일에 공사를 시작하였다.';
  const evidence = [{ quote: sourceText, start: 0, end: sourceText.length }];
  const dataset = { version: 'synthetic-warmup-v1', split: 'pilot', cases: [{
    id: 'start', articleId: 'A', groupId: 'A', kind: 'event', type: 'known-day',
    sourceText, question: '공사 시작 날짜는?', targets: [{ id: 'start', label: '공사 시작' }],
  }] };
  const gold = { version: 'synthetic-values-v1', criteriaVersion: 'synthetic-rubric-v1',
    reviewStatus: 'draft', reviewedBy: [], datasetHash: hash(dataset), rubric: {},
    cases: [{ id: 'start', events: [{ id: 'start', expected: DATE, required: ['month', 'day'],
      allowedOmissions: ['year', 'calendar'], requiresUnknownDay: false, evidence,
      eligibility: { unsupportedDay: false, missingKnownDay: true, headerConfusion: true },
    }] }] };
  return makePlan(dataset, gold, { model: 'synthetic', options: { temperature: 0 }, think: false,
    timeoutMs: 1000, retries: 0, repeats: 1, seed: 62, runOrder: 'seeded', warmup,
    methods: methods.map(id => ({ id, version: METHOD_VERSION })) });
}
async function execute(plan, options = {}) {
  return runPlan(plan, { environment: { synthetic: true }, ...options,
    generate: async (_request, _config, context) => {
      if (context.stage === 'warmup') return structuredClone(WARMUP);
      const c = plan.dataset.cases.find(c => c.id === context.caseId);
      return { answer: JSON.stringify({ answer: '합성 답변: 2000년 3월 10일.', events: [{
        id: 'start', date: DATE, unknownDay: false,
        evidence: [{ quote: c.sourceText, start: 0, end: c.sourceText.length }],
      }] }), inputTokens: 7, outputTokens: 3 };
    } });
}
function assertIncomplete(cost, { calls = 0, elapsedMs = 0, inputTokens = 0, outputTokens = 0 } = {}) {
  assert.equal(cost.historyComplete, false);
  for (const field of ['calls', 'elapsedMs', 'itemElapsedMs', 'meanItemElapsedMs']) {
    assert.equal(cost[field], null, `${field}: incomplete history must not become a total`);
  }
  assert.equal(cost.partialKnownCalls, calls);
  assert.equal(cost.partialKnownElapsedMs, elapsedMs);
  for (const [field, subtotal] of Object.entries({ inputTokens, outputTokens })) {
    assert.equal(cost[field].sum, null, `${field}: incomplete history must not become a total`);
    assert.equal(cost[field].partialKnownSum, subtotal);
    assert.match(cost[field].label, /partial/);
  }
  assert.match(cost.scope, /partial.*total cost unknown/);
}
function assertComplete(cost, { calls = 1, elapsedMs = 4, inputTokens = 11, outputTokens = 2 } = {}) {
  assert.equal(cost.historyComplete, true);
  assert.equal(cost.calls, calls); assert.equal(cost.partialKnownCalls, calls);
  assert.equal(cost.elapsedMs, elapsedMs); assert.equal(cost.itemElapsedMs, elapsedMs);
  assert.equal(cost.partialKnownElapsedMs, elapsedMs);
  assert.equal(cost.meanItemElapsedMs, calls ? elapsedMs / calls : null);
  for (const [field, total] of Object.entries({ inputTokens, outputTokens })) {
    assert.equal(cost[field].sum, total); assert.equal(cost[field].partialKnownSum, total);
    assert.equal(cost[field].label, 'complete');
  }
}

test('warmup: complete fresh and legacy recorded histories retain valid totals and inputs', async () => {
  const plan = fixture(), run = await execute(plan);
  const before = { plan: hash(plan), run: hash(run) };
  const report = buildAutomaticReport(plan, run);
  assertComplete(report.generation.warmup);
  assert.equal(validateAutomaticReport(plan, run, report), report);
  for (const resumed of [false, undefined]) {
    const legacy = structuredClone(run);
    delete legacy.warmupHistoryComplete;
    if (resumed === undefined) delete legacy.resumed;
    else legacy.resumed = resumed;
    assert.deepEqual(buildAutomaticReport(plan, legacy).generation.warmup, report.generation.warmup);
  }
  assert.deepEqual({ plan: hash(plan), run: hash(run) }, before);
});

test('warmup: missing required history stays N/A even in fresh runs or with a true flag', async () => {
  const plan = fixture(), run = await execute(plan);
  for (const resumed of [false, undefined]) for (const flag of [undefined, true]) {
    const missing = structuredClone(run);
    delete missing.warmup;
    if (flag === undefined) delete missing.warmupHistoryComplete;
    else missing.warmupHistoryComplete = flag;
    if (resumed === undefined) delete missing.resumed;
    else missing.resumed = resumed;
    const report = buildAutomaticReport(plan, missing);
    assertIncomplete(report.generation.warmup);
    assert.equal(validateAutomaticReport(plan, missing, report), report);
  }
});

test('warmup: an empty required history cannot establish a complete zero-call total', async () => {
  const plan = fixture(), run = await execute(plan);
  for (const flag of [undefined, true, false]) {
    const empty = structuredClone(run); empty.warmup = [];
    if (flag === undefined) delete empty.warmupHistoryComplete;
    else empty.warmupHistoryComplete = flag;
    assertIncomplete(buildAutomaticReport(plan, empty).generation.warmup);
  }
});

test('warmup: an explicit false flag keeps known fresh calls, time and tokens as partial sums', async () => {
  const plan = fixture(), run = await execute(plan);
  run.warmupHistoryComplete = false;
  assertIncomplete(buildAutomaticReport(plan, run).generation.warmup,
    { calls: 1, elapsedMs: 4, inputTokens: 11, outputTokens: 2 });
  run.warmup[0].result = { answer: 'ready', elapsedMs: 0, inputTokens: 0, outputTokens: 0 };
  assertIncomplete(buildAutomaticReport(plan, run).generation.warmup, { calls: 1 });
});

test('warmup: resumed complete history retains totals; legacy or explicitly partial history does not', async () => {
  const plan = fixture(), initial = await execute(plan);
  const resumed = await runPlan(plan, { existingRecords: initial.records, existingWarmup: initial.warmup,
    existingWarmupHistoryComplete: true, generate: () => assert.fail('completed resume must not call a model') });
  assert.equal(resumed.resumed, true);
  const report = buildAutomaticReport(plan, resumed);
  assertComplete(report.generation.warmup);
  assert.equal(report.generation.batchWallComplete, false);
  for (const flag of [undefined, false]) {
    const partial = structuredClone(resumed);
    if (flag === undefined) delete partial.warmupHistoryComplete;
    else partial.warmupHistoryComplete = flag;
    assertIncomplete(buildAutomaticReport(plan, partial).generation.warmup,
      { calls: 1, elapsedMs: 4, inputTokens: 11, outputTokens: 2 });
  }
});

test('warmup: lost history on completed resume exposes unknown totals instead of zero cost', async () => {
  const plan = fixture(), initial = await execute(plan);
  const resumed = await runPlan(plan, { existingRecords: initial.records,
    generate: () => assert.fail('completed resume must not call a model') });
  assert.equal(resumed.warmupHistoryComplete, false); assert.deepEqual(resumed.warmup, []);
  assertIncomplete(buildAutomaticReport(plan, resumed).generation.warmup);
});

test('warmup: a new preparation call on resume cannot complete an earlier partial history', async () => {
  const plan = fixture({ methods: ['prompt-baseline', 'evidence-first'] }), initial = await execute(plan);
  const existingRecords = initial.records.filter(r => r.methodId === 'prompt-baseline');
  for (const existingWarmup of [undefined, initial.warmup]) {
    const resumed = await execute(plan, { existingRecords, existingWarmup,
      existingWarmupHistoryComplete: false });
    const calls = existingWarmup ? 2 : 1;
    assertIncomplete(buildAutomaticReport(plan, resumed).generation.warmup,
      { calls, elapsedMs: calls * 4, inputTokens: calls * 11, outputTokens: calls * 2 });
  }
});

test('warmup-only recovery is a resumed segment even before any question is recorded', async () => {
  const plan = fixture();
  for (const complete of [undefined, true, false]) {
    const run = await execute(plan, { existingWarmup: [{ result: structuredClone(WARMUP) }],
      existingWarmupHistoryComplete: complete });
    assert.equal(run.resumed, true);
    assert.equal(run.batchWallScope, 'current resumed segment only; earlier batch wall time unavailable');
    const report = buildAutomaticReport(plan, run);
    assert.equal(report.generation.batchWallComplete, false);
    if (complete === true) assertComplete(report.generation.warmup, { calls: 2, elapsedMs: 8, inputTokens: 22, outputTokens: 4 });
    else assertIncomplete(report.generation.warmup, { calls: 2, elapsedMs: 8, inputTokens: 22, outputTokens: 4 });
  }
});

test('warmup: disabled or rule-only plans have provably complete zero-call histories', async () => {
  for (const config of [{ warmup: false }, { warmup: true, methods: ['rule-baseline'] }]) {
    const plan = fixture(config), run = await execute(plan);
    assert.deepEqual(run.warmup, []);
    assertComplete(buildAutomaticReport(plan, run).generation.warmup,
      { calls: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0 });
    for (const resumed of [false, true]) for (const omitHistory of [false, true]) {
      const legacy = structuredClone(run); legacy.resumed = resumed;
      delete legacy.warmupHistoryComplete;
      if (omitHistory) delete legacy.warmup;
      assertComplete(buildAutomaticReport(plan, legacy).generation.warmup,
        { calls: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0 });
    }
    run.warmupHistoryComplete = false;
    assertIncomplete(buildAutomaticReport(plan, run).generation.warmup);
  }
});

test('warmup: history completeness and per-field usage/latency coverage are independent', async () => {
  const plan = fixture(), run = await execute(plan);
  const entry = result => ({ request: run.warmup[0].request, result: { answer: 'ready', ...result } });
  run.warmup = [entry({ elapsedMs: 4, inputTokens: 11, outputTokens: null }),
    entry({ elapsedMs: null, inputTokens: null, outputTokens: 2 }),
    entry({ elapsedMs: 0, inputTokens: 0, outputTokens: 0 })];
  for (const complete of [true, false]) {
    run.warmupHistoryComplete = complete;
    const cost = buildAutomaticReport(plan, run).generation.warmup;
    assert.equal(cost.historyComplete, complete);
    assert.equal(cost.calls, complete ? 3 : null); assert.equal(cost.partialKnownCalls, 3);
    for (const field of ['elapsedMs', 'itemElapsedMs', 'meanItemElapsedMs']) assert.equal(cost[field], null);
    assert.equal(cost.partialKnownElapsedMs, 4);
    assert.equal(cost.completedLatency.count, 2); assert.equal(cost.completedLatency.sumMs, 4);
    for (const [field, subtotal] of Object.entries({ inputTokens: 11, outputTokens: 2 })) {
      assert.equal(cost[field].sum, null); assert.equal(cost[field].partialKnownSum, subtotal);
      assert.equal(cost[field].attemptKnownSum, subtotal);
      assert.deepEqual(cost[field].coverage, { numerator: 2, denominator: 3, value: 2 / 3 });
      assert.deepEqual(cost[field].attemptCoverage, { numerator: 2, denominator: 3, value: 2 / 3 });
      assert.match(cost[field].label, /partial/);
    }
  }
});

test('warmup: recorded zero measurements are valid totals when history is complete', async () => {
  const plan = fixture(), run = await execute(plan);
  run.warmup[0].result = { answer: 'ready', elapsedMs: 0, inputTokens: 0, outputTokens: 0 };
  assertComplete(buildAutomaticReport(plan, run).generation.warmup,
    { calls: 1, elapsedMs: 0, inputTokens: 0, outputTokens: 0 });
});

test('warmup: incomplete-history reporting preserves existing five-method results and physical/service costs', async () => {
  const plan = fixture({ methods: METHODS }), run = await execute(plan);
  const before = { plan: hash(plan), run: hash(run) }, baseline = buildAutomaticReport(plan, run);
  for (const mutate of [
    r => { r.warmupHistoryComplete = false; },
    r => { delete r.warmup; delete r.warmupHistoryComplete; },
  ]) {
    const partial = structuredClone(run); mutate(partial);
    const partialHash = hash(partial), report = buildAutomaticReport(plan, partial);
    assert.equal(report.generation.warmup.historyComplete, false);
    assert.deepEqual(report.methods, baseline.methods); assert.deepEqual(report.items, baseline.items);
    assert.deepEqual(report.generation.physicalBatch, baseline.generation.physicalBatch);
    assert.equal(report.generation.batchWallMs, baseline.generation.batchWallMs);
    assert.deepEqual(report.evaluationCosts, baseline.evaluationCosts);
    assert.equal(validateAutomaticReport(plan, partial, report), report);
    for (const forge of [
      r => { r.generation.warmup.calls = 0; },
      r => { r.generation.warmup.inputTokens.sum = 0; },
      r => { r.generation.warmup.elapsedMs = 0; },
      r => { r.generation.warmup.partialKnownCalls++; },
    ]) {
      const forged = structuredClone(report); forge(forged);
      assert.throws(() => validateAutomaticReport(plan, partial, forged), /integrity/);
    }
    assert.equal(hash(partial), partialHash);
  }
  assert.deepEqual({ plan: hash(plan), run: hash(run) }, before);
});
