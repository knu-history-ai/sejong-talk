import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, makePlan } from '../evals/sejong/date-eval/core.mjs';
import { runPlan, METHOD_VERSION } from '../evals/sejong/date-eval/runner.mjs';
import { POSTPROCESS_VERSION, LEGACY_POSTPROCESS_VERSION, DERIVED_METHODS } from '../evals/sejong/date-eval/postprocess.mjs';
import { buildAutomaticReport, validateAutomaticReport, buildVtDiagnostics } from '../evals/sejong/date-eval/automatic.mjs';

// Synthetic plumbing only: no historical, semantic, human-review or independence claims.
const body = '2000년 3월 10일에 공사를 시작하였다.';
const month = '2001년 4월에 기록하였다.';
const end = '2002년 5월 12일에 끝마치었다.';
const repeated = '2003년 6월 13일에 옮겼다.';
const sourceText = `기사 표제 날짜: 2000년 3월 20일\n본문: ${body}\n${month}\n${end}\n${repeated} ${repeated}`;
const expected = {
  provided: [2000, 3, 10], exact: [2000, 3, 10], whitespace: [2002, 5, 12], month: [2001, 4, null],
  ambiguous: [2003, 6, 13], missing: [2009, 9, 9], noEvidence: [2000, 3, 10], omitted: [2000, 3, 10],
};
const date = ([year, month, day]) => ({ year, month, day, calendar: 'lunar' });
function fixture({ repeats = 2, methods = ['prompt-baseline', ...DERIVED_METHODS], legacy = false } = {}) {
  const c = { id: 'synthetic', articleId: 'A', groupId: 'A', kind: 'event', type: 'mixed-events', sourceText,
    question: '각 사건의 날짜는?', targets: Object.keys(expected).map(id => ({ id, label: id })) };
  const dataset = { version: 'synthetic-vt-diagnostics', split: 'pilot', cases: [c] };
  const gold = { version: 'synthetic-gold', criteriaVersion: 'synthetic-criteria', reviewStatus: 'draft',
    reviewedBy: [], datasetHash: hash(dataset), cases: [{ id: c.id, events: c.targets.map(t => ({
      id: t.id, expected: date(expected[t.id]), required: ['month', 'day'], allowedOmissions: ['year', 'calendar'],
      requiresUnknownDay: t.id === 'month', eligibility: { unsupportedDay: t.id === 'month',
        missingKnownDay: t.id !== 'month', headerConfusion: true },
      evidence: [{ quote: sourceText, start: 0, end: sourceText.length }],
    })) }] };
  return makePlan(dataset, gold, { model: 'synthetic', options: {}, timeoutMs: 1000, retries: 0, repeats,
    seed: 62, warmup: false,
    methods: methods.map(id => ({ id, version: METHOD_VERSION, ...(DERIVED_METHODS.includes(id)
      ? legacy ? {} : { postprocessVersion: POSTPROCESS_VERSION } : {}) })) });
}
function answer(repeat) {
  const quote = (text, validPosition = true) => {
    const start = validPosition ? sourceText.indexOf(text) : 0;
    return { quote: text, start, end: start + text.length };
  };
  const evidence = { provided: [quote(body)], exact: [quote(body, false)],
    whitespace: [quote(end.replaceAll(' ', ''), false)], month: [quote(month)],
    ambiguous: [quote(repeated, false)], missing: [quote('2009년 9월 9일에 사라졌다.', false)], noEvidence: [] };
  const events = Object.entries(evidence).map(([id, quotes]) => ({ id, date: date(expected[id]),
    unknownDay: id === 'month', evidence: quotes }));
  if (repeat === 2) {
    events[0].date = date([1999, 1, 1]); events[0].unknownDay = true;
    events[1].date.year = 1999;
    events[3].date.day = 28; events[3].unknownDay = false;
  }
  return JSON.stringify({ answer: 'Synthetic only.', events });
}
const execute = (plan, generate = context => answer(context.repeat)) => runPlan(plan, {
  generate: async (request, config, context) => ({ answer: generate(context), inputTokens: 1, outputTokens: 1 }),
});

test('pinned v2 reports non-scoring V coverage, changes, alignment, omissions and paired raw equality', async () => {
  const plan = fixture(), run = await execute(plan), before = [hash(plan), hash(run)];
  const report = buildAutomaticReport(plan, run), d = report.vtDiagnostics, v = d.vApplication, t = d.tvEquality;
  assert.equal(d.scoring, false); assert.equal(d.repeatsIndependent, false); assert.match(d.interpretation, /NON-SCORING/);
  assert.deepEqual(v.records, { planned: 2, completed: 2, failed: 0, unknown: 0, unexecuted: 0, missing: 0 });
  assert.deepEqual(v.audits, { applied: 2, notApplied: 0, unavailable: 0, other: 0 });
  assert.equal(v.eligibleEmittedEvents, 14); assert.equal(v.precisionCheckedEvents, 8); assert.equal(v.unverifiedEvents, 6);
  assert.deepEqual(v.coverage, { numerator: 8, denominator: 14, value: 8 / 14 });
  assert.equal(v.omittedTargetEvents, 2); assert.equal(v.changedEvents, 3);
  assert.deepEqual(v.fieldChangedCounts, { year: 2, month: 1, day: 2, calendar: 0, unknownDay: 2 });
  assert.equal(v.fieldChangeUnavailableEvents, 0);
  assert.deepEqual(v.unverifiedReasons, { 'ambiguous-quote-alignment': 2, 'invalid-quote-position-or-text': 2, 'no-evidence': 2 });
  assert.equal(v.alignment.quoteChecks, 12);
  assert.deepEqual(v.alignment.statusCounts, { 'provided-position': 4, 'exact-search': 2, 'whitespace-search': 2,
    ambiguous: 2, 'not-found': 2, unavailable: 0, other: 0 });
  assert.deepEqual(v.alignment.originalExists, { true: 8, false: 4, unavailable: 0 });
  assert.deepEqual(v.alignment.originalPositionMatches, { true: 4, false: 8, unavailable: 0 });
  assert.deepEqual(v.alignment.exists, { true: 8, false: 4, unavailable: 0 });
  assert.deepEqual(v.alignment.positionMatches, v.alignment.exists);
  assert.equal(t.plannedPairs, 2); assert.equal(t.pairStates.completed, 2);
  assert.equal(t.same, 1); assert.equal(t.different, 1);
  assert.deepEqual(t.sameRate, { numerator: 1, denominator: 2, value: 0.5 });
  assert.deepEqual(t.coverage, { numerator: 2, denominator: 2, value: 1 });
  assert.equal(validateAutomaticReport(plan, run, report), report);
  assert.deepEqual([hash(plan), hash(run)], before);
  assert.equal(report.generation.physicalBatch.calls, 2);
  for (const r of run.records.filter(r => DERIVED_METHODS.includes(r.methodId))) {
    assert.equal(r.derivation.version, POSTPROCESS_VERSION); assert.equal(r.calls, 0);
  }
});

test('v2 quote recovery alone leaves preserved evidence and raw T/V answers identical', async () => {
  const plan = fixture({ repeats: 1 }), run = await execute(plan);
  const p = JSON.parse(run.records.find(r => r.methodId === 'prompt-baseline').rawAnswer);
  for (const r of run.records.filter(r => DERIVED_METHODS.includes(r.methodId))) {
    assert.deepEqual(JSON.parse(r.rawAnswer).events.map(e => e.evidence), p.events.map(e => e.evidence));
  }
  const d = buildAutomaticReport(plan, run).vtDiagnostics;
  assert.equal(d.vApplication.precisionCheckedEvents, 4); assert.equal(d.vApplication.changedEvents, 0);
  assert.equal(d.vApplication.alignment.statusCounts['exact-search'], 1);
  assert.equal(d.vApplication.alignment.statusCounts['whitespace-search'], 1);
  assert.equal(d.tvEquality.same, 1); assert.equal(d.tvEquality.different, 0);
});

test('legacy unpinned v1 audits retain unavailable alignment/original fields', async () => {
  const plan = fixture({ legacy: true }), run = await execute(plan), d = buildAutomaticReport(plan, run).vtDiagnostics;
  assert.ok(run.records.filter(r => r.derivation).every(r => r.derivation.version === LEGACY_POSTPROCESS_VERSION));
  assert.equal(d.vApplication.precisionCheckedEvents, 4);
  assert.equal(d.vApplication.alignment.statusCounts.unavailable, 12);
  assert.deepEqual(d.vApplication.alignment.originalExists, { true: 0, false: 0, unavailable: 12 });
  assert.deepEqual(d.vApplication.alignment.originalPositionMatches, { true: 0, false: 0, unavailable: 12 });
});

test('no V, no T, malformed and failed generations have explicit exclusions and null zero-denominator rates', async () => {
  for (const methods of [['prompt-baseline'], ['prompt-baseline', 'render-only'], ['prompt-baseline', 'evidence-validated']]) {
    const plan = fixture({ methods }), run = await execute(plan), d = buildAutomaticReport(plan, run).vtDiagnostics;
    assert.equal(d.vApplication.available, methods.includes('evidence-validated'));
    assert.deepEqual(d.tvEquality.absentMethods, DERIVED_METHODS.filter(id => !methods.includes(id)));
    assert.equal(d.tvEquality.pairStates.absent, 2); assert.equal(d.tvEquality.plannedPairs, 0);
    assert.equal(d.tvEquality.sameRate.value, null); assert.equal(d.tvEquality.coverage.value, null);
    if (!methods.includes('evidence-validated')) assert.deepEqual(d.vApplication.coverage, { numerator: 0, denominator: 0, value: null });
  }
  const plan = fixture(), malformed = buildAutomaticReport(plan, await execute(plan, () => 'Unstructured prose.')).vtDiagnostics;
  assert.equal(malformed.vApplication.audits.notApplied, 2);
  assert.deepEqual(malformed.vApplication.notAppliedReasons, { 'invalid-whole-json': 2 });
  assert.deepEqual(malformed.vApplication.coverage, { numerator: 0, denominator: 0, value: null });
  assert.equal(malformed.tvEquality.same, 2); // Completed pass-through is a raw comparison, never accuracy.
  const failed = buildAutomaticReport(plan, await execute(plan, () => { throw new Error('synthetic failure'); })).vtDiagnostics;
  assert.equal(failed.vApplication.records.failed, 2); assert.equal(failed.vApplication.eligibleEmittedEvents, 0);
  assert.equal(failed.tvEquality.pairStates.failed, 2); assert.equal(failed.tvEquality.pairStates.completed, 0);
  assert.deepEqual(failed.tvEquality.sameRate, { numerator: 0, denominator: 0, value: null });
  assert.deepEqual(failed.tvEquality.coverage, { numerator: 0, denominator: 2, value: 0 });
});

test('partial helper separates missing, unknown, unexecuted and failed records without making a report', async () => {
  const plan = fixture({ repeats: 8 }), run = await execute(plan);
  const get = (method, repeat) => run.records.find(r => r.methodId === method && r.repeat === repeat);
  run.records = run.records.filter(r => !(r.methodId === 'evidence-validated' && r.repeat === 1)
    && !(r.methodId === 'render-only' && r.repeat === 8));
  get('evidence-validated', 2).state = 'unknown'; get('render-only', 3).state = 'failed';
  get('render-only', 4).state = 'unexecuted';
  get('render-only', 5).rawAnswer = get('evidence-validated', 5).rawAnswer = 'same';
  get('render-only', 6).rawAnswer = 'left'; get('evidence-validated', 6).rawAnswer = 'right';
  get('render-only', 7).state = 'failed'; get('evidence-validated', 7).state = 'unknown';
  get('evidence-validated', 8).state = 'failed';
  const d = buildVtDiagnostics(plan, run);
  assert.deepEqual(d.tvEquality.pairStates, { absent: 0, missing: 2, failed: 2, unknown: 1, unexecuted: 1, completed: 2 });
  assert.deepEqual(d.vApplication.records, { planned: 8, completed: 4, failed: 1, unknown: 2, unexecuted: 0, missing: 1 });
  assert.equal(d.tvEquality.same, 1); assert.equal(d.tvEquality.different, 1);
  assert.deepEqual(d.tvEquality.coverage, { numerator: 2, denominator: 8, value: 0.25 });
  assert.throws(() => buildAutomaticReport(plan, run));
});

test('minimal old audits and missing event detail remain unknown, never inferred as checked or changed', () => {
  const plan = fixture({ repeats: 1 });
  const record = { methodId: 'evidence-validated', caseId: 'synthetic', repeat: 1, state: 'completed', rawAnswer: 'x' };
  const d = buildVtDiagnostics(plan, { records: [record] });
  assert.equal(d.vApplication.audits.unavailable, 1); assert.equal(d.vApplication.coverage.value, null);
  record.derivation = { audit: { status: 'applied', events: [{ id: 'provided', status: 'unverified' }] } };
  const minimal = buildVtDiagnostics(plan, { records: [record] }).vApplication;
  assert.equal(minimal.eligibleEmittedEvents, 1); assert.equal(minimal.unverifiedEvents, 1);
  assert.deepEqual(minimal.unverifiedReasons, { unspecified: 1 });
  assert.equal(minimal.fieldChangeUnavailableEvents, 1); assert.equal(minimal.changedEvents, 0);
  record.derivation.audit = { status: 'applied' };
  assert.equal(buildVtDiagnostics(plan, { records: [record] }).vApplication.audits.unavailable, 1);
});

test('raw pairing uses both caseId and repeat, never a matching answer from another slot', () => {
  const methods = ['render-only', 'evidence-validated'];
  const cases = [{ id: 'a' }, { id: 'b' }], records = [], slots = [];
  for (const methodId of methods) for (const c of cases) for (const repeat of [1, 2]) {
    slots.push({ methodId, caseId: c.id, repeat });
    records.push({ methodId, caseId: c.id, repeat, state: 'completed',
      rawAnswer: `${methodId === 'render-only' ? c.id : c.id === 'a' ? 'b' : 'a'}/${methodId === 'render-only' ? repeat : 3 - repeat}` });
  }
  const d = buildVtDiagnostics({ config: { repeats: 2, methods: methods.map(id => ({ id })) }, dataset: { cases }, slots }, { records });
  assert.equal(d.tvEquality.same, 0); assert.equal(d.tvEquality.different, 4);
});

test('legacy report shape remains readable; present diagnostics and existing snapshots reject tampering', async () => {
  const plan = fixture(), run = await execute(plan), report = buildAutomaticReport(plan, run);
  const legacy = structuredClone(report); delete legacy.vtDiagnostics;
  const bytes = JSON.stringify(legacy);
  assert.equal(validateAutomaticReport(plan, run, legacy), legacy); assert.equal(JSON.stringify(legacy), bytes);
  for (const mutate of [r => { r.vtDiagnostics.vApplication.precisionCheckedEvents++; },
    r => { r.vtDiagnostics.vApplication.coverage.numerator++; },
    r => { r.vtDiagnostics.vApplication.alignment.statusCounts['exact-search']++; },
    r => { r.vtDiagnostics.tvEquality.same++; }, r => { r.vtDiagnostics.scoring = true; },
    r => { r.vtDiagnostics = undefined; }, r => { delete r.vtDiagnostics.vApplication.fieldChangedCounts; }]) {
    const forged = structuredClone(report); mutate(forged);
    assert.throws(() => validateAutomaticReport(plan, run, forged), /integrity/);
  }
  for (const mutate of [r => { r.methods[0].primary.numerator++; }, r => { r.items[0].recordHash = 'other'; },
    r => { r.evaluatorHash = 'other'; }, r => { r.inputSnapshots.access = 'public'; }]) {
    const forged = structuredClone(legacy); mutate(forged);
    assert.throws(() => validateAutomaticReport(plan, run, forged), /integrity/);
  }
});
