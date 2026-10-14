import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../evals/sejong/date-eval/core.mjs';
import { buildReport, compareReports } from '../evals/sejong/date-eval/report.mjs';

// Fixtures use only the shared contracts, with no model calls or review heuristics.
function fixture({ core = 4, controls = 0, repeats = 1, methods = ['a'],
  articles = [], targets = 1, split = 'final', reviewStatus = 'approved',
  outcome = () => ({}), config = {}, environment = {
    critical: { hardware: 'fixture-cpu', runtime: 'node24', concurrency: 1 },
  } } = {}) {
  const dataset = { version: 'fixture-v1', split, cases: Array.from({ length: core + controls }, (_, i) => ({
    id: `q${i}`, articleId: articles[i] ?? `article${i}`, groupId: `group${i}`,
    sourceId: `source${i}`, sourceText: 'A date with evidence.', question: `When ${i}?`,
    kind: i < core ? 'event' : 'control',
    targets: Array.from({ length: targets }, (_, j) => ({ id: `e${j}`, label: `Event ${j}` })),
  })) };
  const datasetHash = hash(dataset);
  const gold = { version: 'gold-v1', criteriaVersion: 'criteria-v1', datasetHash, reviewStatus,
    cases: dataset.cases.map(c => ({ id: c.id, events: c.targets.map(t => ({
      id: t.id, expected: { year: 1443, month: 12, day: null, calendar: 'lunar' },
      required: ['month', 'day'], requiresUnknownDay: true,
      eligibility: { unsupportedDay: true, missingKnownDay: false, headerConfusion: true },
      evidence: [{ quote: 'date', start: 2, end: 6 }],
    })) })) };
  const conditions = { model: 'fixture-model', endpoint: 'fixture-endpoint', options: { temperature: 0 }, think: false,
    timeoutMs: 30000, retries: 0, methods: methods.map(id => ({ id, version: 'v1' })),
    repeats, seed: 1, runOrder: 'seeded', warmup: 0, ...config };
  const goldHash = hash(gold);
  const configHash = hash(conditions);
  const criteriaHash = hash({ criteriaVersion: gold.criteriaVersion, cases: gold.cases });
  const id = hash({ datasetHash, goldHash, configHash });
  const slots = methods.flatMap(methodId => dataset.cases.flatMap(c =>
    Array.from({ length: repeats }, (_, i) => ({ id: `${methodId}/${c.id}/${i + 1}`,
      caseId: c.id, repeat: i + 1, methodId }))));
  const plan = { schemaVersion: 1, id, dataset, datasetHash, gold, goldHash,
    criteriaHash, config: conditions, configHash, slots };
  const scores = slots.map(s => outcome(Number(s.caseId.slice(1)), s.repeat, s.methodId));
  const records = slots.map((s, i) => {
    const o = scores[i];
    return { ...s, state: o.state ?? 'completed', rawAnswer: 'Answer', rawInput: 'Question',
      elapsedMs: o.elapsedMs ?? 2000, calls: o.calls ?? 1,
      inputTokens: Object.hasOwn(o, 'inputTokens') ? o.inputTokens : 10,
      outputTokens: Object.hasOwn(o, 'outputTokens') ? o.outputTokens : 5, attempts: o.attempts ?? [],
      ...(o.state === 'failed' ? { error: 'timeout' } : {}) };
  });
  const run = { schemaVersion: 1, planId: id, datasetHash, goldHash, criteriaHash, configHash,
    records, environment, batchElapsedMs: 12000 };
  const final = { schemaVersion: 1, planId: id, criteriaHash, runHash: hash(run),
    items: records.map((r, i) => ({ recordId: r.id, recordHash: hash(r),
      date: r.state === 'failed' ? 0 : scores[i].date ?? 1,
      evidence: r.state === 'failed' ? 0 : scores[i].evidence ?? 1,
      events: r.state === 'failed' ? [] : dataset.cases.find(c => c.id === r.caseId).targets.map(t => ({
        id: t.id, unsupportedDay: 0, missingKnownDay: null, headerConfusion: 0,
        ...scores[i].flags,
      })), state: r.state === 'failed' ? 'execution-failure' : 'final', reason: 'reviewed upstream' })),
    agreement: { source: 'two blind first reviews and reconciliation upstream' } };
  return { plan, run, final };
}
const report = f => buildReport(f.plan, f.run, f.final);
function refresh(f) {
  f.final.runHash = hash(f.run);
  for (const item of f.final.items) {
    const record = f.run.records.find(r => r.id === item.recordId);
    if (record) item.recordHash = hash(record);
  }
}
function regold(f) {
  f.plan.goldHash = hash(f.plan.gold);
  f.plan.criteriaHash = hash({ criteriaVersion: f.plan.gold.criteriaVersion, cases: f.plan.gold.cases });
  f.plan.id = hash({ datasetHash: f.plan.datasetHash, goldHash: f.plan.goldHash, configHash: f.plan.configHash });
  Object.assign(f.run, { planId: f.plan.id, goldHash: f.plan.goldHash, criteriaHash: f.plan.criteriaHash });
  Object.assign(f.final, { planId: f.plan.id, criteriaHash: f.plan.criteriaHash });
  refresh(f);
}

test('10 core questions: five failures and five correct => .5 / 1 / .5', () => {
  const r = report(fixture({ core: 10, outcome: i => i < 5 ? { state: 'failed' } : {} }));
  const m = r.methods[0];
  assert.equal(m.core.fixedTotal, 10);
  assert.equal(m.core.accuracy.value, .5);
  assert.equal(m.core.conditionalAccuracy.value, 1);
  assert.equal(m.core.completion.value, .5);
  assert.equal(m.core.conditionalTimesCompletion, .5);
  assert.equal(m.core.evidence.value, .5);
  assert.equal(m.core.conditionalEvidence.value, 1);
  assert.equal(m.primary.value, .5);
});

test('core and control denominators stay separate; all operational includes control failure', () => {
  const m = report(fixture({ controls: 1, outcome: i =>
    i >= 3 ? { state: 'failed' } : { date: i < 2 ? 1 : 0 } })).methods[0];
  assert.equal(m.core.accuracy.value, .5);
  assert.equal(m.core.conditionalAccuracy.value, 2 / 3);
  assert.equal(m.core.completion.value, .75);
  assert.equal(m.core.conditionalTimesCompletion, .5);
  assert.equal(m.control.fixedTotal, 1);
  assert.equal(m.control.accuracy.value, 0);
  assert.equal(m.control.conditionalAccuracy.value, null);
  assert.equal(m.operational.accuracy.value, .4);
  assert.equal(m.operational.completion.value, .6);
  assert.equal(m.primary.value, .5);
});

test('question scores are not event averages; event rates use each gold eligible target', () => {
  const f = fixture({ core: 1, targets: 3, outcome: () => ({ date: 0, evidence: 1 }) });
  const gold = f.plan.gold.cases[0].events;
  gold[1].eligibility = { unsupportedDay: false, missingKnownDay: true, headerConfusion: true };
  gold[1].expected.day = 15;
  gold[1].requiresUnknownDay = false;
  gold[2].eligibility.headerConfusion = false;
  f.final.items[0].events = [
    { id: 'e0', unsupportedDay: 1, missingKnownDay: null, headerConfusion: 1 },
    { id: 'e1', unsupportedDay: null, missingKnownDay: 1, headerConfusion: 0 },
    { id: 'e2', unsupportedDay: 0, missingKnownDay: null, headerConfusion: null },
  ];
  regold(f);
  const m = report(f).methods[0];
  assert.equal(m.core.accuracy.denominator, 1);
  assert.equal(m.core.accuracy.value, 0);
  assert.equal(m.core.evidence.value, 1);
  assert.equal(m.core.eventRates.unsupportedDay.denominator, 2);
  assert.equal(m.core.eventRates.unsupportedDay.value, .5);
  assert.equal(m.core.eventRates.missingKnownDay.value, 1);
  assert.equal(m.core.eventRates.headerConfusion.value, .5);
  f.final.items[0].events.pop();
  assert.throws(() => report(f), /missing eligible final event score/);
});

test('event diagnostics exclude execution failures; failure content is never graded', () => {
  const f = fixture({ core: 2, outcome: i => i ? { state: 'failed' } : { flags: { unsupportedDay: 1 } } });
  const m = report(f).methods[0];
  assert.equal(m.core.eventRates.unsupportedDay.denominator, 1);
  assert.equal(m.core.eventRates.unsupportedDay.value, 1);
  assert.equal(m.core.eventRates.missingKnownDay.value, null);
  assert.match(m.core.eventRates.missingKnownDay.reason, /no completed eligible/);
  f.final.items[1].date = 1;
  assert.throws(() => report(f), /automatically scored zero/);
});

test('primary is fixed core question accuracy; article-equal weighting is supplementary', () => {
  const r = report(fixture({ core: 3, controls: 1, repeats: 2, articles: ['A', 'A', 'B', 'C'],
    outcome: (i, repeat) => ({ date: i === 0 || (i === 1 && repeat === 1) ? 1 : 0 }) }));
  const m = r.methods[0];
  assert.equal(m.core.accuracy.value, .5);
  assert.deepEqual(m.primary, m.core.accuracy);
  assert.equal(m.primary.value, .5);
  assert.equal(m.primary.numerator, 3); assert.equal(m.primary.denominator, 6);
  const articleEqual = m.supplementary.articleEqualWeight;
  assert.equal(articleEqual.value, .375); // A=(1+.5)/2=.75, B=0 => .375
  assert.deepEqual(articleEqual.questionMeans.map(q => q.value), [1, .5, 0]);
  assert.deepEqual(articleEqual.articleMeans.map(a => a.value), [.75, 0]);
  assert.equal(articleEqual.repeatsIndependent, false);
  assert.equal(r.metricVersion, 2);
  assert.equal(r.metricDefinitions.primary.source, 'core.accuracy');
  assert.equal(r.metricDefinitions.primary.label, '전체 사건 문항 최종 정답률');
  assert.equal(r.metricDefinitions.supplementary.articleEqualWeight.label, '기사 동일 가중 평균');
  assert.equal(r.repeatsIndependent, false);
});

test('legacy article-weighted reports compare with new reports without rewriting original results', () => {
  const current = report(fixture({ core: 3, articles: ['A', 'A', 'B'], outcome: i => ({ date: i < 2 ? 1 : 0 }) }));
  const legacy = structuredClone(current);
  delete legacy.metricVersion; delete legacy.metricDefinitions;
  for (const method of legacy.methods) {
    method.primary = method.supplementary.articleEqualWeight; delete method.supplementary;
  }
  const original = JSON.stringify(legacy), currentBytes = JSON.stringify(current);
  assert.equal(legacy.methods[0].primary.value, .5);
  assert.equal(current.methods[0].primary.value, 2 / 3);
  const forward = compareReports(legacy, current), backward = compareReports(current, legacy);
  assert.deepEqual(forward.sourceMetricVersions, { left: 1, right: 2 });
  assert.deepEqual(backward.sourceMetricVersions, { left: 2, right: 1 });
  assert.equal(forward.comparisons[0].core.netChange.value, 0);
  assert.equal(forward.leftReportHash, hash(legacy));
  assert.equal(JSON.stringify(legacy), original);
  assert.equal(JSON.stringify(current), currentBytes);
  legacy.methods[0].primary.value = 2 / 3;
  assert.throws(() => compareReports(legacy, current), /legacy article weighting/);
});

test('changed metric labels, swapped values, missing versions and unknown versions cannot silently change meaning', () => {
  const current = report(fixture({ core: 3, articles: ['A', 'A', 'B'], outcome: i => ({ date: i < 2 ? 1 : 0 }) }));
  for (const mutate of [
    r => { r.methods[0].primary = r.methods[0].supplementary.articleEqualWeight; },
    r => { r.methods[0].supplementary.articleEqualWeight.value = 2 / 3; },
    r => { r.metricDefinitions.primary.source = 'supplementary.articleEqualWeight'; },
    r => { delete r.metricVersion; },
    r => { r.metricVersion = 999; },
  ]) {
    const changed = structuredClone(current); mutate(changed);
    assert.throws(() => compareReports(changed, current), /metric definitions|primary accuracy|supplementary article weighting/);
  }
});

test('representative and supplementary scores preserve failure zero and explicit empty-core N/A', () => {
  const failed = report(fixture({ core: 2, controls: 1, articles: ['A', 'A', 'B'], outcome: i => i < 2 ? { state: 'failed' } : {} }));
  assert.equal(failed.methods[0].primary.value, 0);
  assert.equal(failed.methods[0].primary.denominator, 2);
  assert.equal(failed.methods[0].supplementary.articleEqualWeight.value, 0);
  const controlOnly = report(fixture({ core: 0, controls: 1 }));
  assert.equal(controlOnly.methods[0].primary.value, null);
  assert.equal(controlOnly.methods[0].primary.denominator, 0);
  assert.equal(controlOnly.methods[0].supplementary.articleEqualWeight.value, null);
  compareReports(failed, failed); compareReports(controlOnly, controlOnly);
});

test('completed latency differs from total operational time and costs', () => {
  const left = report(fixture({ core: 2 }));
  const right = report(fixture({ core: 2, methods: ['b'], outcome: i => i ? {
    state: 'failed', elapsedMs: 10000, calls: 3, inputTokens: null, outputTokens: null,
  } : { elapsedMs: 1000 } }));
  const a = left.methods[0], b = right.methods[0];
  assert.equal(a.timing.totalItemElapsed.sum, 4000);
  assert.equal(b.timing.totalItemElapsed.sum, 11000);
  assert.equal(a.timing.completion.median, 2000);
  assert.equal(b.timing.completion.median, 1000);
  assert.equal(b.timing.completion.count, 1);
  assert.equal(b.usage.calls, 4);
  assert.equal(b.usage.inputTokens.sum, null);
  assert.equal(b.usage.inputTokens.partialKnownSum, 10);
  assert.equal(b.usage.inputTokens.coverage.value, .5);
  assert.equal(b.usage.outputTokens.partialKnownSum, 5);
  assert.equal(b.usage.evaluationCostsIncluded, false);
  assert.equal(right.batchWallMs, 12000);
  assert.equal(compareReports(left, right).timeComparable, true);
});

test('all failures and no controls have explicit undefined conditional metrics', () => {
  const m = report(fixture({ core: 2, outcome: () => ({ state: 'failed', inputTokens: null }) })).methods[0];
  assert.equal(m.core.accuracy.value, 0);
  assert.equal(m.core.evidence.value, 0);
  assert.equal(m.core.conditionalAccuracy.value, null);
  assert.equal(m.core.conditionalTimesCompletion, null);
  assert.equal(m.timing.completion.median, null);
  assert.equal(m.timing.completion.sum, 0);
  assert.equal(m.control.accuracy.value, null);
  assert.equal(m.control.accuracy.denominator, 0);
  assert.equal(m.usage.inputTokens.coverage.value, 0);
  assert.equal(m.usage.inputTokens.sum, null);
});

test('paired both0 preserves execution failure versus completed wrong answer', () => {
  const left = report(fixture({ core: 4, repeats: 2, outcome: i =>
    i === 0 ? { state: 'failed' } : { date: i === 1 || i === 2 ? 1 : 0 } }));
  const right = report(fixture({ core: 4, repeats: 2, methods: ['b'], outcome: i =>
    ({ date: i === 1 || i === 3 ? 1 : 0 }) }));
  const comparison = compareReports(left, right);
  const c = comparison.comparisons[0];
  assert.deepEqual(Object.fromEntries(['improve', 'regress', 'both1', 'both0', 'total'].map(k => [k, c.core[k]])),
    { improve: 2, regress: 2, both1: 2, both0: 2, total: 8 });
  assert.equal(c.core.netChange.value, 0);
  assert.equal(c.core.rows[0].leftState, 'failed');
  assert.equal(c.core.rows[0].rightState, 'completed');
  assert.equal(c.completedOnlySupplement.total, 6);
  assert.equal(comparison.repeatsIndependent, false);
});

test('each method has its own fixed denominator and all method pairs are compared', () => {
  const r = report(fixture({ core: 2, methods: ['a', 'b'], outcome: (_i, _r, method) =>
    method === 'b' ? { state: 'failed' } : {} }));
  assert.deepEqual(r.methods.map(m => m.core.fixedTotal), [2, 2]);
  assert.deepEqual(r.methods.map(m => m.core.accuracy.value), [1, 0]);
  assert.equal(compareReports(r, r).comparisons.length, 4);
});

test('missing, pending, unknown and unexecuted records cannot produce a final report', () => {
  for (const state of ['unknown', 'unexecuted']) {
    const f = fixture();
    f.run.records[0].state = state;
    refresh(f);
    assert.throws(() => report(f), /unexecuted or unknown/);
  }
  const mutations = [
    f => { f.final.items[0].state = 'pending'; },
    f => { f.final.items[0].date = null; },
    f => { f.final.items.pop(); },
    f => { f.run.records.pop(); refresh(f); },
    f => { f.final.items.push(f.final.items[0]); },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    assert.throws(() => report(f));
  }
});

test('frozen hashes catch stale run, record and configuration artifacts', () => {
  for (const mutate of [
    f => { f.run.records[0].rawAnswer = 'Changed answer'; },
    f => { f.final.items[0].recordHash = 'stale'; },
    f => { f.final.runHash = 'stale'; },
    f => { f.final.criteriaHash = 'stale'; },
    f => { f.plan.config.options.temperature = 1; },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => report(f));
  }
});

test('comparison rejects full data, gold, criteria and execution condition mismatches', () => {
  const left = report(fixture());
  for (const field of ['datasetHash', 'goldHash', 'criteriaHash', 'datasetVersion', 'criteriaVersion']) {
    const right = structuredClone(left);
    right[field] = 'other';
    assert.throws(() => compareReports(left, right), /incompatible/);
  }
  for (const config of [{ model: 'other' }, { endpoint: 'other' }, { options: { temperature: 1 } },
    { retries: 1 }, { timeoutMs: 1000 }, { seed: 2 }, { warmup: 1 }, { runOrder: 'reverse' }, { think: true }]) {
    assert.throws(() => compareReports(left, report(fixture({ config }))), /incompatible/);
  }
  const missing = structuredClone(left);
  missing.entries.pop();
  assert.throws(() => compareReports(left, missing), /population/);
  const tampered = structuredClone(left);
  tampered.config.seed = 10;
  assert.throws(() => compareReports(left, tampered), /config hash mismatch/);
});

test('environment mismatch or unknown environment bars timing conclusions', () => {
  const left = report(fixture());
  for (const environment of [{}, { critical: { hardware: 'other', runtime: 'node24', concurrency: 1 } }]) {
    const c = compareReports(left, report(fixture({ environment })));
    assert.equal(c.timeComparable, false);
    assert.match(c.comparisons[0].timingReason, /no efficiency conclusion/);
  }
});

test('draft gold and nonfinal splits retain pilot status; outputs do not alias inputs', () => {
  for (const opts of [{ reviewStatus: 'draft' }, { split: 'pilot' }, { split: 'development' }]) {
    const r = report(fixture(opts));
    assert.equal(r.pilot, true);
    assert.equal(r.paperEligible, false);
    assert.equal(r.datasetEligible, false);
    assert.equal(r.paperReadiness, 'not-established-by-tool');
  }
  const f = fixture({ outcome: () => ({ calls: 0, inputTokens: 0, outputTokens: 0 }) });
  const r = report(f);
  assert.equal(r.datasetEligible, true);
  assert.equal(r.paperEligible, false);
  assert.equal(r.paperReadiness, 'not-established-by-tool');
  assert.equal(r.methods[0].model, null);
  assert.equal(r.methods[0].usage.inputTokens.sum, 0);
  r.config.options.temperature = 1;
  r.agreement.source = 'changed';
  r.environment.critical.hardware = 'changed';
  assert.equal(f.plan.config.options.temperature, 0);
  assert.match(f.final.agreement.source, /two blind/);
  assert.equal(f.run.environment.critical.hardware, 'fixture-cpu');
});

test('partial retry tokens survive unknown record totals without double counting', () => {
  const f = fixture({ core: 3, outcome: i => i === 0 ? {
    calls: 3, inputTokens: null, outputTokens: null, state: 'failed', attempts: [
      { state: 'completed', inputTokens: 12, outputTokens: 6 },
      { state: 'failed', inputTokens: null, outputTokens: null },
      { state: 'failed', extraUnknownField: 100000 },
    ],
  } : i === 1 ? {
    calls: 2, inputTokens: 30, outputTokens: 8, attempts: [
      { inputTokens: 10, outputTokens: 3 }, { inputTokens: 20, outputTokens: 5 },
    ],
  } : { calls: 1, inputTokens: null, outputTokens: null } });
  const u = report(f).methods[0].usage;
  assert.equal(u.calls, 6);
  assert.equal(u.inputTokens.sum, null);
  assert.equal(u.inputTokens.partialKnownSum, 42);
  assert.equal(u.outputTokens.partialKnownSum, 14);
  assert.equal(u.inputTokens.coverage.value, 1 / 3);
  assert.equal(u.inputTokens.attemptCoverage.numerator, 3);
  assert.equal(u.inputTokens.attemptCoverage.denominator, 6);
  assert.equal(u.inputTokens.attemptCoverage.value, .5);
  assert.equal(u.inputTokens.attemptKnownSum, 42);
  assert.equal(u.inputTokens.recordedAttempts, 5);
  assert.equal(u.inputTokens.missingAttemptRecords, 1);
  assert.equal(Number.isNaN(u.inputTokens.partialKnownSum), false);
});

test('default runner host fields permit timing comparison, each critical field matters', () => {
  const environment = { platform: 'fixture', release: '1', cpu: 'CPU', cpus: 4,
    memoryBytes: 1024, node: 'v24.19.0' };
  const a = report(fixture({ environment }));
  const b = report(fixture({ methods: ['b'], environment: { ...environment, irrelevant: 'ignored' } }));
  assert.equal(compareReports(a, b).timeComparable, true);
  for (const field of Object.keys(environment)) {
    const changed = { ...environment, [field]: typeof environment[field] === 'number' ? 2 : 'other' };
    assert.equal(compareReports(a, report(fixture({ environment: changed }))).timeComparable, false);
  }
  const missing = { ...environment };
  delete missing.cpu;
  assert.equal(compareReports(a, report(fixture({ environment: missing }))).timeComparable, false);
});

test('within-report comparison supports methods with stable version and optional code hashes', () => {
  const methods = [{ id: 'a', version: 'v1', codeHash: hash('a source') },
    { id: 'b', version: 'v1', codeHash: hash('b source') }];
  const r = report(fixture({ methods: ['a', 'b'], config: { methods },
    outcome: (_i, _repeat, method) => ({ date: method === 'a' ? 0 : 1 }) }));
  const paired = compareReports(r, r);
  const aToB = paired.comparisons.find(c => c.before.id === 'a' && c.after.id === 'b');
  assert.equal(aToB.core.improve, 4);
  assert.equal(aToB.before.codeHash, methods[0].codeHash);
  assert.equal(aToB.after.codeHash, methods[1].codeHash);
  assert.equal(paired.datasetEligible, true);
  assert.equal(paired.paperEligible, false);
  assert.equal(paired.paperReadiness, 'not-established-by-tool');
  const changedSource = report(fixture({ config: { methods: [
    { id: 'a', version: 'v1', codeHash: hash('changed source') },
  ] } }));
  assert.throws(() => compareReports(r, changedSource), /same method version.*code hash/);
  const tampered = structuredClone(r);
  tampered.methods[0].codeHash = 'changed';
  assert.throws(() => compareReports(r, tampered), /method version\/code hash/);
});

test('both reports losing the same question, repeat or whole method cannot shrink the frozen denominator', () => {
  for (const remove of [
    entry => entry.caseId === 'q1',
    entry => entry.repeat === 2,
    entry => entry.methodId === 'b',
  ]) {
    const broken = report(fixture({ core: 4, controls: 1, repeats: 2, methods: ['a', 'b'] }));
    broken.entries = broken.entries.filter(entry => !remove(entry));
    assert.throws(() => compareReports(broken, structuredClone(broken)), /fixed.*population/);
  }
});

test('comparison binds the original dataset and recomputes fixed aggregates, not just matching two files', () => {
  const valid = report(fixture());
  for (const mutate of [
    r => { r.entries[0].caseId = 'not-planned'; },
    r => { r.entries[0].repeat = 100; },
    r => { r.entries[0].articleId = 'other-article'; },
    r => { r.entries[0].kind = 'control'; },
    r => { r.entries.push(structuredClone(r.entries[0])); },
    r => { r.methods[0].core.accuracy.value = 0; },
    r => { r.entries[0].date = 0; },
    r => { r.datasetSnapshot.cases.pop(); },
    r => { delete r.datasetSnapshot; },
  ]) {
    const broken = structuredClone(valid);
    mutate(broken);
    assert.throws(() => compareReports(broken, structuredClone(broken)));
  }
  assert.equal(compareReports(valid, valid).comparisons[0].core.total, 4);
});
