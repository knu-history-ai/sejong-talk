import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, makePlan } from '../evals/sejong/date-eval/core.mjs';
import { runPlan, METHOD_VERSION } from '../evals/sejong/date-eval/runner.mjs';
import { aiGrade, codeGrade } from '../evals/sejong/date-eval/grading.mjs';
import { buildAutomaticReport, validateAutomaticReport, compareAutomaticMethods } from '../evals/sejong/date-eval/automatic.mjs';
import { resolveRunState } from '../evals/sejong/date-eval/state.mjs';

// Entirely synthetic dates, sources and judgments. No private dataset/gold files,
// fake human Finals, network calls, or assumptions about historical correctness.
const METHODS = ['rule-baseline', 'prompt-baseline', 'evidence-first', 'render-only', 'evidence-validated'];
const dates = {
  known: { year: 2000, month: 3, day: 10, calendar: 'lunar' },
  header: { year: 2000, month: 3, day: 20, calendar: 'lunar' },
  start: { year: 2001, month: 4, day: null, calendar: 'lunar' },
  end: { year: 2001, month: 5, day: 12, calendar: 'lunar' },
};
function fixture({ repeats = 2, methods = METHODS, warmup = false, retries = 0, changeGold } = {}) {
  const sourceA = '기사 표제 날짜: 2000년 3월 20일\n본문: 2000년 3월 10일에 공사를 시작하였다.';
  const sourceB = '기사 표제 날짜: 2001년 4월 28일\n본문: 2001년 4월에 공사를 시작하여 2001년 5월 12일에 끝마치었다.';
  const cases = [
    { id: 'known', articleId: 'A', kind: 'event', type: 'known-day', sourceText: sourceA, targets: [{ id: 'known', label: '공사 시작' }] },
    { id: 'control', articleId: 'A', kind: 'control', type: 'header-control', sourceText: sourceA, targets: [{ id: 'header', label: '기사 표제' }] },
    { id: 'unknown', articleId: 'B', kind: 'event', type: 'unknown-day', sourceText: sourceB, targets: [{ id: 'start', label: '공사 시작' }] },
    { id: 'mixed', articleId: 'B', kind: 'event', type: 'mixed-events', sourceText: sourceB,
      targets: [{ id: 'start', label: '공사 시작' }, { id: 'end', label: '공사 종료' }] },
  ].map(c => ({ ...c, groupId: c.articleId, question: c.kind === 'control' ? '기사 표제 날짜는?' : `${c.id} 사건의 날짜는?` }));
  const dataset = { version: 'synthetic-automatic-v1', split: 'pilot', cases };
  const gold = { version: 'synthetic-values-v1', criteriaVersion: 'synthetic-rubric-v1', reviewStatus: 'draft',
    reviewedBy: [], datasetHash: hash(dataset), rubric: { aliases: { calendar: ['음력'], regnalYear: { 1: 2000 } } },
    cases: cases.map(c => ({ id: c.id, events: c.targets.map(t => ({ id: t.id, expected: dates[t.id],
      required: ['month', 'day'], allowedOmissions: ['year', 'calendar'], requiresUnknownDay: dates[t.id].day === null,
      eligibility: { unsupportedDay: dates[t.id].day === null, missingKnownDay: c.kind === 'event' && dates[t.id].day !== null,
        headerConfusion: c.kind === 'event' }, evidence: [{ quote: c.sourceText, start: 0, end: c.sourceText.length }] })) })) };
  changeGold?.(gold);
  return makePlan(dataset, gold, { model: 'synthetic', options: { temperature: 0 }, think: false,
    timeoutMs: 1000, retries, repeats, seed: 62, runOrder: 'seeded', warmup,
    methods: methods.map(id => ({ id, version: METHOD_VERSION })) });
}
function answer(c) {
  return { answer: 'Synthetic answer; no human or historical validation.', events: c.targets.map(t => ({
    id: t.id, date: structuredClone(dates[t.id]), unknownDay: dates[t.id].day === null,
    evidence: [{ quote: c.sourceText, start: 0, end: c.sourceText.length }],
  })) };
}
async function execute(plan, { transform = a => JSON.stringify(a), fail = false, seen = [] } = {}) {
  return runPlan(plan, { environment: { synthetic: true }, generate: async (request, config, context) => {
    seen.push(context);
    if (context.stage === 'warmup') return { answer: 'ready', inputTokens: 100, outputTokens: 10, elapsedMs: 3 };
    const c = plan.dataset.cases.find(c => c.id === context.caseId);
    assert.ok(request.prompt.includes(c.sourceText)); assert.ok(request.prompt.includes(c.question));
    assert.ok(!request.prompt.includes('allowedOmissions')); // no reference leakage to generation
    if (fail) throw Object.assign(new Error('synthetic transport failure'), { inputTokens: 2, outputTokens: null, raw: 'partial' });
    return { answer: transform(answer(c), context), inputTokens: 7, outputTokens: 3, elapsedMs: 1 };
  } });
}
const method = (report, id = 'prompt-baseline') => report.methods.find(m => m.id === id);
const item = (report, caseId = 'known', id = 'prompt-baseline') => report.items.find(r => r.caseId === caseId && r.methodId === id);

function judgment(input, { date = 1, evidence = 1 } = {}) {
  const proof = observedDate => ({ answerQuote: { quote: input.rawAnswer, start: 0, end: input.rawAnswer.length },
    sourceQuote: { quote: input.sourceText, start: 0, end: input.sourceText.length },
    observedDate, reason: 'Synthetic item-specific proof.' });
  const parsed = JSON.parse(input.rawAnswer);
  return { date, evidence, reason: 'Synthetic preliminary judgment.',
    proofs: { date: proof(parsed.events[0].date), evidence: proof(parsed.events[0].date) },
    events: input.gold.events.map(e => {
      const fields = ['date', ...Object.keys(e.eligibility)];
      return { id: e.id, ...Object.fromEntries(fields.map(f => [f, f === 'date' ? date : e.eligibility[f] ? 0 : null])),
        reasons: Object.fromEntries(fields.map(f => [f, 'Synthetic reason.'])),
        proofs: Object.fromEntries(fields.map(f => [f, proof(parsed.events.find(s => s.id === e.id).date)])) };
    }) };
}
async function grade(plan, run, transform = value => value) {
  return aiGrade(plan, run, { judgeConfig: { model: 'synthetic-judge', retries: 0, timeoutMs: 1000, cancelGraceMs: 0 },
    judge: input => ({ answer: transform(judgment(input), input), inputTokens: 3, outputTokens: 2 }) });
}

test('actual five-method run: event-only primary, separate controls, article/type results, no human final', async () => {
  const plan = fixture(), seen = [], run = await execute(plan, { seen });
  const before = { plan: hash(plan), run: hash(run) };
  const report = buildAutomaticReport(plan, run);
  assert.equal(report.schemaVersion, 1); assert.equal(report.type, 'date-automatic-report');
  assert.equal(report.evaluationVersion, 'automatic-date-v1');
  assert.equal(report.metricDefinitions.primary.definition, 'structured date task success, event questions only, format/execution failures 0');
  assert.equal(report.planHash, hash(plan)); assert.equal(report.runHash, hash(run));
  assert.match(report.evaluatorHash, /^[a-f0-9]{64}$/);
  assert.equal(report.paperEligible, false); assert.equal(report.humanValidated, false);
  assert.equal(report.ai.status, 'not-run'); assert.equal(report.evaluationCosts.human, null);
  assert.equal(report.methods.length, 5); assert.equal(report.items.length, 40);
  assert.equal(report.access, 'maintainer-only'); assert.equal(report.inputSnapshots.access, 'maintainer-only');
  assert.equal(report.inputSnapshots.ai, null);
  assert.ok(!Object.hasOwn(report, 'finalHash')); assert.ok(!Object.hasOwn(report, 'agreement'));
  for (const m of report.methods) {
    assert.equal(m.primary.denominator, 6); assert.equal(m.controls.primary.denominator, 2);
    assert.equal(m.operational.primary.denominator, 8); assert.equal(m.byArticle.length, 2);
    assert.equal(m.byQuestionType.length, 4);
    assert.equal(m.byQuestionType.find(t => t.questionType === 'header-control').primary.denominator, 0);
    assert.deepEqual(m.event.completion, { numerator: 6, denominator: 6, value: 1 });
    assert.deepEqual(m.event.failure, { numerator: 0, denominator: 6, value: 0 });
    assert.equal(m.supplementary.articleEqualWeight.count, 2);
  }
  for (const r of report.items) {
    assert.equal(r.recordHash, hash(run.records.find(s => s.id === r.recordId)));
    assert.ok([0, 1].includes(r.dateScore)); assert.equal(r.outcome, 'structured');
    assert.equal(r.ai.date, null);
  }
  assert.deepEqual(method(report).primary, { numerator: 6, denominator: 6, value: 1 });
  assert.equal(seen.length, 24); assert.equal(report.generation.physicalBatch.calls, 24);
  assert.equal(report.generation.physicalBatch.inputTokens.sum, 168);
  assert.equal(validateAutomaticReport(plan, run, report), report);
  assert.deepEqual({ plan: hash(plan), run: hash(run) }, before);
});

test('all five methods failed: every event remains in the fixed denominator with task zero', async () => {
  const plan = fixture(), run = await execute(plan, { fail: true });
  // Rule failures cannot be induced by the mock model: emulate an imported rule exception.
  for (const r of run.records.filter(r => r.methodId === 'rule-baseline')) { r.state = 'failed'; r.rawAnswer = ''; }
  const report = buildAutomaticReport(plan, run);
  for (const m of report.methods) {
    assert.deepEqual(m.primary, { numerator: 0, denominator: 6, value: 0 });
    assert.equal(m.controls.primary.value, 0); assert.equal(m.event.executionFailures, 6);
    assert.equal(m.event.conditionalAccuracy.value, null); assert.equal(m.event.conditionalAccuracy.denominator, 0);
    assert.equal(m.event.completion.value, 0); assert.equal(m.event.failure.value, 1);
    assert.equal(m.generation.completedLatency.count, 0); assert.equal(m.generation.completedLatency.medianMs, null);
  }
  assert.ok(report.items.every(r => r.outcome === 'execution-failure' && r.dateScore === 0));
  assert.equal(report.generation.physicalBatch.failed, 40);
  assert.equal(report.generation.physicalBatch.calls, 16); // E extraction failures prevent answer calls
  assert.equal(report.generation.physicalBatch.inputTokens.sum, 32);
  assert.equal(report.generation.physicalBatch.outputTokens.sum, null);
  const comparison = compareAutomaticMethods(plan, run, report);
  for (const pair of comparison.pairs) { assert.equal(pair.both0, 6); assert.equal(pair.denominator, 6); }
});

test('malformed JSON and prose are format failures; transport errors remain execution failures', async () => {
  const plan = fixture({ repeats: 1, methods: ['prompt-baseline'] });
  for (const raw of ['plain prose: 2000년 3월 10일', 'prefix {"events":[]} suffix', '```json\n{"events":[],}\n```',
    'null', '[]', '{"events":{}}']) {
    const run = await execute(plan, { transform: () => raw });
    const report = buildAutomaticReport(plan, run);
    assert.ok(report.items.every(r => r.outcome === 'format-failure' && r.dateScore === 0), raw);
    assert.equal(method(report).event.executionFailures, 0);
    assert.equal(method(report).primary.denominator, 3);
    assert.equal(method(report).event.conditionalAccuracy.value, 0);
    assert.equal(method(report).event.completion.value, 1); // malformed completed outputs stay in completed denominator
  }
  const failed = buildAutomaticReport(plan, await execute(plan, { fail: true }));
  assert.ok(failed.items.every(r => r.outcome === 'execution-failure'));
  for (const transform of [a => JSON.stringify(a), a => `\`\`\`json\r\n${JSON.stringify(a)}\r\n\`\`\``,
    a => `\`\`\`\n${JSON.stringify(a)}\n\`\`\``]) {
    const report = buildAutomaticReport(plan, await execute(plan, { transform }));
    assert.equal(method(report).primary.value, 1);
  }
});

test('missing keys, wrong types, nonboolean unknownDay, duplicate events/JSON keys cannot succeed', async () => {
  const plan = fixture({ repeats: 1, methods: ['prompt-baseline'] });
  const changes = [
    a => { delete a.events[0].date.year; }, a => { delete a.events[0].date.calendar; },
    a => { a.events[0].date.year = '2000'; }, a => { a.events[0].date.day = false; },
    a => { a.events[0].date.month = 13; }, a => { a.events[0].date.day = 32; },
    a => { a.events[0].date.regnalYear = '1'; }, a => { a.events[0].date.calendar = []; },
    a => { a.events[0].unknownDay = 'false'; }, a => { delete a.events[0].unknownDay; },
    a => { a.events.push(a.events[0]); }, a => { a.events[0].evidence = 'quote'; },
  ];
  for (const change of changes) {
    const run = await execute(plan, { transform: a => { change(a); return JSON.stringify(a); } });
    const report = buildAutomaticReport(plan, run);
    assert.ok(report.items.every(r => r.outcome === 'format-failure' && r.dateScore === 0));
  }
  for (const transform of [
    a => JSON.stringify(a).replace('"year":', '"year":1999,"year":'),
    a => JSON.stringify(a).replace('"day":', '"d\\u0061y":1,"day":'),
    a => JSON.stringify(a).replace('"events":', '"events":[],"events":'),
    a => JSON.stringify(a).replace('"quote":', '"quote":"other","quote":'),
  ]) {
    const report = buildAutomaticReport(plan, await execute(plan, { transform }));
    assert.ok(report.items.every(r => r.outcome === 'format-failure'));
    assert.match(report.items[0].reason, /duplicate JSON key/);
  }
  const harmless = buildAutomaticReport(plan, await execute(plan, { transform: a => {
    a.answer = 'Literal text: {"year":1,"year":2} [ ] : \\"'; return JSON.stringify(a);
  } }));
  assert.equal(method(harmless).primary.value, 1); // scanner does not tokenize inside a string
});

test('unknown/missing events are structured task zero, never silently drop targets', async () => {
  const plan = fixture({ repeats: 1, methods: ['prompt-baseline'] });
  for (const change of [a => { a.events = []; }, a => { a.events[0].id = 'unknown'; },
    a => { a.events.push({ ...a.events[0], id: 'extra' }); }, a => { a.events.pop(); }]) {
    const report = buildAutomaticReport(plan, await execute(plan, { transform: a => { change(a); return JSON.stringify(a); } }));
    assert.ok(report.items.every(r => r.dateScore === 0 && r.outcome === 'structured'));
    assert.equal(method(report).primary.denominator, 3);
  }
});

test('allowedOmissions controls all nonrequired components; required overrides allowance; aliases retained', async () => {
  const mutate = a => { a.events.forEach(e => { e.date.year = null; e.date.calendar = null; }); return JSON.stringify(a); };
  const allowed = fixture({ repeats: 1, methods: ['prompt-baseline'] });
  assert.equal(method(buildAutomaticReport(allowed, await execute(allowed, { transform: mutate }))).primary.value, 1);
  const disallowed = fixture({ repeats: 1, methods: ['prompt-baseline'], changeGold: g => {
    g.cases.forEach(c => c.events.forEach(e => { e.allowedOmissions = []; }));
  } });
  const run = await execute(disallowed, { transform: mutate });
  assert.ok(codeGrade(disallowed, run).items.every(i => i.date === 1)); // legacy diagnostic is deliberately unchanged
  assert.equal(method(buildAutomaticReport(disallowed, run)).primary.value, 0);
  const required = fixture({ repeats: 1, methods: ['prompt-baseline'], changeGold: g => {
    g.cases.forEach(c => c.events.forEach(e => { e.required.push('year'); }));
  } });
  assert.equal(method(buildAutomaticReport(required, await execute(required, { transform: mutate }))).primary.value, 0);
  const alias = buildAutomaticReport(disallowed, await execute(disallowed, { transform: (a, context) => {
    if (context.caseId === 'known') { a.events[0].date.year = null; a.events[0].date.regnalYear = 1; a.events[0].date.calendar = '음력'; }
    return JSON.stringify(a);
  } }));
  assert.equal(item(alias).dateScore, 1);
});

test('contradictory prose/evidence semantics cannot change the structured primary', async () => {
  const plan = fixture({ repeats: 1, methods: ['prompt-baseline'] });
  const report = buildAutomaticReport(plan, await execute(plan, { transform: a => {
    a.answer = 'The event happened in 1999; deliberately contradicts the structured fields.';
    a.events.forEach(e => { e.evidence = []; }); return JSON.stringify(a);
  } }));
  assert.equal(method(report).primary.value, 1);
  assert.ok(report.items.every(r => r.codeDiagnostic.quoteExists === 0));
  assert.equal(report.metricDefinitions.primary.semanticProseCorrectnessIncluded, false);
});

test('unknown/unexecuted records and tampered actual requests block reports', async () => {
  const plan = fixture({ repeats: 1, methods: ['prompt-baseline'] }), run = await execute(plan);
  for (const state of ['unknown', 'unexecuted']) {
    const bad = structuredClone(run); bad.records[0].state = state;
    assert.throws(() => buildAutomaticReport(plan, bad), /unknown\/unexecuted/);
  }
  for (const mutate of [r => { r.rawInput = []; }, r => { r.rawInput[0].prompt = 'other source'; },
    r => { r.attempts[0].request.model = 'other-model'; }, r => { r.rawInput[0].think = true; }]) {
    const bad = structuredClone(run); mutate(bad.records[0]); assert.throws(() => buildAutomaticReport(plan, bad));
  }
  const unknown = await runPlan(fixture({ repeats: 1 }), { generate: async (request, config, context) => ({
    answer: JSON.stringify(answer(fixture().dataset.cases.find(c => c.id === context.caseId))), finishReason: 'length',
    inputTokens: 1, outputTokens: 1,
  }) });
  assert.throws(() => buildAutomaticReport(fixture({ repeats: 1 }), unknown), /unknown\/unexecuted/);
});

test('AI full counts/methods/types and partial failures stay supplemental with separate coverage', async () => {
  const plan = fixture(), run = await execute(plan);
  let count = 0;
  const ai = await grade(plan, run, value => {
    if (count++ % 2 === 0) { value.evidence = null; delete value.proofs.evidence; }
    return value;
  });
  const report = buildAutomaticReport(plan, run, ai), noAi = buildAutomaticReport(plan, run);
  assert.equal(report.ai.status, 'partial-failure'); assert.equal(report.ai.total, 40);
  assert.equal(report.ai.metrics.date.scored, 40); assert.equal(report.ai.metrics.evidence.scored, 20);
  assert.equal(report.ai.metrics.evidence.failures, 20);
  assert.equal(report.ai.metrics.evidence.score.denominator, 20);
  assert.equal(report.ai.metrics.evidence.score.value, 1); // failures are not 20 content zeros
  assert.equal(report.ai.byMethod.length, 5); assert.equal(report.ai.byQuestionType.length, 4);
  assert.equal(report.ai.byKind.length, 2); assert.equal(report.ai.failures.length, 20);
  assert.equal(report.aiHash, hash(ai)); assert.deepEqual(report.inputSnapshots.ai, ai);
  assert.match(report.inputSnapshots.disclosure, /frozen gold/);
  assert.equal(report.evaluationCosts.ai.calls, 40);
  assert.deepEqual(report.methods.map(m => m.primary), noAi.methods.map(m => m.primary));
  assert.equal(validateAutomaticReport(plan, run, report, ai), report);
  assert.equal(validateAutomaticReport(plan, run, report), report);
  const failures = await aiGrade(plan, run, { judge: () => { throw new Error('judge failure'); } });
  const failureReport = buildAutomaticReport(plan, run, failures);
  assert.equal(failureReport.ai.metrics.date.scored, 0); assert.equal(failureReport.ai.metrics.date.failures, 40);
  assert.equal(failureReport.ai.metrics.date.score.value, null);
  const zeros = buildAutomaticReport(plan, run, await grade(plan, run, (value, input) => judgment(input, { date: 0, evidence: 0 })));
  assert.equal(zeros.ai.metrics.date.score.value, 0); assert.equal(method(zeros).primary.value, 1);
});

test('failed generation is excluded from supplemental AI content coverage and costs', async () => {
  const plan = fixture(), run = await execute(plan, { fail: true }), ai = await grade(plan, run);
  const report = buildAutomaticReport(plan, run, ai);
  assert.equal(report.ai.eligible, 8); // only R completed
  assert.equal(report.ai.executionFailures, 32); assert.equal(report.ai.metrics.date.scored, 8);
  assert.equal(report.evaluationCosts.ai.calls, 8);
  assert.ok(report.items.filter(r => r.executionState === 'failed').every(r => r.ai.date === null && r.ai.evidence === null));
});

test('AI envelope/config/prompt/ID/input/raw-score and attempt-cost tampering is rejected', async () => {
  const plan = fixture({ repeats: 1, methods: ['prompt-baseline'] }), run = await execute(plan), ai = await grade(plan, run);
  for (const mutate of [
    a => { a.type = 'human-final'; }, a => { a.schemaVersion = 2; }, a => { a.planId = 'other'; },
    a => { a.criteriaHash = 'other'; }, a => { a.runHash = 'other'; },
    a => { a.judgeConfig.retries = 1; }, a => { a.prompt += ' changed'; },
    a => { a.items.pop(); }, a => { a.items.push(a.items[0]); },
    a => { a.items[0].recordHash = 'other'; }, a => { a.items[0].recordId = 'extra'; },
    a => { a.items[0].rawInput.rawAnswer += 'changed'; }, a => { a.items[0].date = 0; },
    a => { a.items[0].events[0].date = 0; a.items[0].date = 0; },
    a => { a.items[0].attempts[0].inputTokens = -1; }, a => { a.items[0].attempts[0].elapsedMs = -1; },
    a => { a.evaluationCost.elapsedMs = -1; }, a => { a.evaluationCost.inputTokens.partialKnownSum++; },
    a => { a.items[0].attempts[0].outputTokens++; }, a => { a.items[0].date = 2; },
  ]) {
    const bad = structuredClone(ai); mutate(bad); assert.throws(() => buildAutomaticReport(plan, run, bad));
  }
});

test('AI replay rejects edited normalized proofs, reasons and partial-field failure markers', async () => {
  const plan = fixture({ repeats: 1, methods: ['prompt-baseline'] }), run = await execute(plan);
  const ai = await grade(plan, run);
  for (const mutate of [
    i => { i.reason = 'Edited question reason.'; },
    i => { i.proofs.date.answerQuote.quote = 'Not in the answer.'; },
    i => { i.proofs.evidence.reason = 'Edited evidence proof.'; },
    i => { i.events[0].proofs.date.observedDate.year++; },
    i => { i.events[0].reasons.date = 'Edited event reason.'; },
    i => { i.events[0].reasons.missingKnownDay = 'Edited eligibility reason.'; },
    i => { i.failures.date = 'Invented field failure.'; },
  ]) {
    const bad = structuredClone(ai); mutate(bad.items[0]);
    assert.throws(() => buildAutomaticReport(plan, run, bad), /AI.*preserved/);
  }
  const partial = await grade(plan, run, value => {
    delete value.proofs.evidence;
    value.events[0].proofs.date.answerQuote.quote = 'Invalid preserved proof.';
    return value;
  });
  assert.equal(buildAutomaticReport(plan, run, partial).ai.metrics.evidence.failures, 4);
  for (const mutate of [
    i => { delete i.failures.evidence; },
    i => { i.failures.evidence = 'Edited field failure.'; },
    i => { i.events[0].reasons.date = 'Edited missing-proof reason.'; },
    i => { i.proofs.evidence = i.attempts[0].rawOutput.proofs.date; },
  ]) {
    const bad = structuredClone(partial); mutate(bad.items[0]);
    assert.throws(() => buildAutomaticReport(plan, run, bad), /AI.*preserved/);
  }
});

function markGradingFailure(item, error) {
  item.state = 'grading-failure'; item.date = null; item.evidence = null; item.reason = error;
  delete item.proofs; delete item.failures;
  item.events = item.events.map(e => ({ id: e.id, date: null,
    unsupportedDay: null, missingKnownDay: null, headerConfusion: null }));
  Object.assign(item.attempts.at(-1), { state: 'grading-failure', error });
}

test('interpretable preserved AI output cannot be relabeled as grading failure or skipped by a retry', async () => {
  const plan = fixture({ repeats: 1, methods: ['prompt-baseline'] }), run = await execute(plan), ai = await grade(plan, run);
  const failed = structuredClone(ai); markGradingFailure(failed.items[0], 'Fabricated failure.');
  assert.throws(() => buildAutomaticReport(plan, run, failed), /interpretable.*failure/);

  const retried = structuredClone(ai);
  retried.judgeConfig.retries = 1; retried.judgeConfigHash = hash(retried.judgeConfig);
  const skipped = structuredClone(retried.items[0]); markGradingFailure(skipped, 'Fabricated retry reason.');
  retried.items[0].attempts.unshift(skipped.attempts[0]); retried.items[0].attempts[1].attempt = 2;
  retried.evaluationCost.calls++;
  for (const [field, tokens] of [['inputTokens', 3], ['outputTokens', 2]]) {
    const cost = retried.evaluationCost[field]; cost.total++; cost.known++;
    cost.sum += tokens; cost.partialKnownSum += tokens;
  }
  assert.throws(() => buildAutomaticReport(plan, run, retried), /interpretable.*failure/);
});

test('valid AI output cannot acquire a fabricated timeout without its timing and settlement audit', async () => {
  const plan = fixture({ repeats: 1, methods: ['prompt-baseline'] }), run = await execute(plan), ai = await grade(plan, run);
  for (const mutate of [
    log => { log.timedOut = true; },
    log => { Object.assign(log, { timedOut: true, cancelGraceMs: 0, transportSettlement: 'resolved-after-timeout',
      transportRecordMissing: false, missingTransportFields: [] }); },
    log => { Object.assign(log, { timedOut: true, elapsedMs: 1000, cancelGraceMs: 0,
      transportSettlement: 'resolved-after-timeout', transportRecordMissing: false, missingTransportFields: [] }); },
  ]) {
    const bad = structuredClone(ai); markGradingFailure(bad.items[0], 'judge timeout');
    mutate(bad.items[0].attempts[0]);
    assert.throws(() => buildAutomaticReport(plan, run, bad), /timeout/);
  }
});

test('genuine transport, JSON and uninterpretable failures retain null scores and allow a later partial response', async () => {
  const plan = fixture({ repeats: 1, methods: ['prompt-baseline'] }), run = await execute(plan);
  for (const judge of [
    () => { throw new Error('Synthetic transport rejection.'); },
    () => { throw Object.assign(new Error('Synthetic server error.'), { raw: '{"error":"Synthetic server error."}' }); },
    () => ({ answer: '{invalid JSON', raw: '{invalid JSON', inputTokens: 3, outputTokens: 2 }),
    () => ({ answer: [], inputTokens: 3, outputTokens: 2 }),
  ]) {
    const ai = await aiGrade(plan, run, { judge });
    const report = buildAutomaticReport(plan, run, ai);
    assert.equal(report.ai.metrics.date.scored, 0); assert.equal(report.ai.metrics.date.failures, 4);
    assert.equal(report.ai.metrics.date.score.value, null);
  }
  const ai = await aiGrade(plan, run, { judgeConfig: { retries: 1 }, judge: (input, { attempt }) => {
    if (attempt === 1) throw new Error('Synthetic first-call rejection.');
    const value = judgment(input); delete value.proofs.evidence;
    return { answer: value, inputTokens: 3, outputTokens: 2 };
  } });
  const report = buildAutomaticReport(plan, run, ai);
  assert.equal(report.ai.metrics.date.scored, 4); assert.equal(report.ai.metrics.evidence.failures, 4);
  assert.equal(ai.evaluationCost.calls, 8); assert.ok(ai.items.every(i => i.attempts.length === 2));
});

test('genuine audited timeouts keep valid late raw replies unscored and preserve missing transport data', async () => {
  const plan = fixture({ repeats: 1, methods: ['prompt-baseline'] }), run = await execute(plan);
  for (const settlement of ['resolved', 'rejected', 'unsettled']) {
    const ai = await aiGrade(plan, run, { judgeConfig: { timeoutMs: 20, cancelGraceMs: 10 },
      judge: (input, { signal }) => new Promise((resolve, reject) => {
        if (settlement === 'unsettled') return;
        signal.addEventListener('abort', () => {
          const answer = JSON.stringify(judgment(input)), raw = JSON.stringify({ response: answer });
          if (settlement === 'resolved') resolve({ answer, raw, inputTokens: 3, outputTokens: 2 });
          else reject(Object.assign(new Error('Synthetic cancellation.'), { raw, inputTokens: 3, outputTokens: 2 }));
        }, { once: true });
      }) });
    const report = buildAutomaticReport(plan, run, ai);
    assert.equal(report.ai.metrics.date.scored, 0); assert.equal(report.ai.metrics.date.failures, 4);
    assert.ok(ai.items.every(i => i.attempts[0].timedOut === true));
    assert.equal(ai.evaluationCost.inputTokens.sum, settlement === 'unsettled' ? null : 12);
  }
});

test('an early timer wakeup is rearmed until the monotonic judge deadline before recording timeout', async t => {
  const plan = fixture({ repeats: 1, methods: ['prompt-baseline'] }), run = await execute(plan);
  const nativeTimer = globalThis.setTimeout;
  let earlyWakeups = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay === 25 && earlyWakeups === 0) {
      earlyWakeups++;
      return nativeTimer(callback, 0, ...args);
    }
    return nativeTimer(callback, delay, ...args);
  });
  const ai = await aiGrade(plan, run, { judgeConfig: { timeoutMs: 25, cancelGraceMs: 0 },
    judge: () => new Promise(() => {}) });
  assert.equal(earlyWakeups, 1);
  assert.ok(ai.items.every(i => i.attempts[0].timedOut && i.attempts[0].elapsedMs >= 25));
  const report = buildAutomaticReport(plan, run, ai);
  assert.equal(report.ai.metrics.date.scored, 0); assert.equal(report.ai.metrics.date.failures, 4);
});

test('explicit failed Ollama envelopes outrank an interpretable partial judgment without hiding valid completed output', async () => {
  const plan = fixture({ repeats: 1, methods: ['prompt-baseline'] }), run = await execute(plan);
  for (const mode of ['incomplete', 'error']) {
    const ai = await aiGrade(plan, run, { judge: input => {
      const error = mode === 'error' ? 'Synthetic server rejection.' : '응답이 정상 종료되지 않았습니다';
      const raw = JSON.stringify({ done: mode === 'error', response: JSON.stringify(judgment(input)),
        ...(mode === 'error' ? { error } : {}) });
      throw Object.assign(new Error(error), { raw, inputTokens: 3, outputTokens: 2 });
    } });
    const report = buildAutomaticReport(plan, run, ai);
    assert.equal(report.ai.metrics.date.failures, 4); assert.equal(report.ai.metrics.date.scored, 0);
    assert.equal(report.ai.metrics.date.score.value, null);
    const forged = structuredClone(ai);
    forged.items[0].attempts[0].rawOutput = JSON.stringify({ done: true,
      response: JSON.stringify(judgment(forged.items[0].rawInput)) });
    assert.throws(() => buildAutomaticReport(plan, run, forged), /interpretable.*failure/);
  }
});

test('standalone T/V includes P time/tokens/calls; physical batch counts P once; warmup separate/history explicit', async () => {
  const plan = fixture({ warmup: true }), run = await execute(plan), report = buildAutomaticReport(plan, run);
  const p = method(report);
  for (const id of ['render-only', 'evidence-validated']) {
    const derived = method(report, id);
    assert.equal(derived.generation.calls, p.generation.calls);
    assert.deepEqual(derived.generation.inputTokens, p.generation.inputTokens);
    assert.ok(derived.generation.itemElapsedMs >= p.generation.itemElapsedMs);
  }
  assert.equal(report.generation.physicalBatch.calls, 24);
  assert.equal(report.generation.warmup.calls, 1); assert.equal(report.generation.warmup.inputTokens.sum, 100);
  assert.equal(report.generation.warmup.elapsedMs, 3); assert.equal(report.generation.warmup.historyComplete, true);
  const resumed = await runPlan(plan, { existingRecords: run.records, existingWarmup: run.warmup,
    existingWarmupHistoryComplete: true, generate: () => { throw new Error('no new calls'); } });
  const resumedReport = buildAutomaticReport(plan, resumed);
  assert.equal(resumedReport.generation.batchWallComplete, false); assert.equal(resumedReport.generation.warmup.historyComplete, true);
  const lostHistory = await runPlan(plan, { existingRecords: run.records });
  const partial = buildAutomaticReport(plan, lostHistory);
  assert.equal(partial.generation.warmup.historyComplete, false); assert.match(partial.generation.warmup.scope, /partial/);
  const missingTime = structuredClone(run); delete missingTime.warmup[0].result.elapsedMs;
  assert.equal(buildAutomaticReport(plan, missingTime).generation.warmup.elapsedMs, null);
  assert.equal(buildAutomaticReport(plan, missingTime).generation.warmup.itemElapsedMs, null);
  assert.equal(buildAutomaticReport(plan, missingTime).generation.warmup.meanItemElapsedMs, null);
  assert.equal(buildAutomaticReport(plan, missingTime).generation.warmup.completedLatency.count, 0);
});

for (const failed of [false, true]) {
  test(`T/V inspections only increase physical cost, not first service time (${failed ? 'failed' : 'completed'})`, async () => {
    const plan = fixture({ repeats: 1, warmup: true }), run = await execute(plan, { fail: failed });
    const originalHashes = { plan: hash(plan), run: hash(run) };
    const baseline = buildAutomaticReport(plan, run), baselineHash = hash(baseline);
    for (const inspectionTimes of [[], [25], [25, 75]]) {
      const inspected = structuredClone(run);
      let extra = 0;
      for (const record of inspected.records.filter(r => ['render-only', 'evidence-validated'].includes(r.methodId))) {
        if (inspectionTimes.length === 0) continue;
        const parent = inspected.records.find(r => r.id === record.derivation.parentRecordId);
        // Synthetic audit history with real parent bindings; no model calls or source/gold changes.
        record.postprocessInspections = inspectionTimes.map(elapsedMs => ({
          sourceRecordHash: hash(record), previousParentHash: hash(parent), parentRecordHash: hash(parent), elapsedMs,
        }));
        extra += inspectionTimes.reduce((total, elapsedMs) => total + elapsedMs, 0);
      }
      const inspectedHash = hash(inspected), report = buildAutomaticReport(plan, inspected);
      for (const id of METHODS) {
        const actual = method(report, id), before = method(baseline, id);
        // Includes sum/mean, completed count, median/p95, calls and token coverage.
        assert.deepEqual(actual.generation, before.generation, `${id}: first service cost changed`);
        assert.deepEqual(actual.primary, before.primary); assert.deepEqual(actual.controls, before.controls);
      }
      if (failed) for (const id of ['render-only', 'evidence-validated']) {
        assert.equal(method(report, id).generation.completedLatency.count, 0);
        assert.equal(method(report, id).generation.completedLatency.p95Ms, null);
      }
      const physical = report.generation.physicalBatch, before = baseline.generation.physicalBatch;
      assert.ok(Math.abs(physical.itemElapsedMs - before.itemElapsedMs - extra) < 0.000001);
      assert.equal(physical.postprocessInspectionElapsedMs, extra);
      assert.equal(physical.calls, before.calls);
      assert.deepEqual(physical.inputTokens, before.inputTokens);
      assert.deepEqual(physical.outputTokens, before.outputTokens);
      assert.deepEqual(report.generation.warmup, baseline.generation.warmup);
      assert.equal(validateAutomaticReport(plan, inspected, report), report);
      compareAutomaticMethods(plan, inspected, report);
      for (const mutate of [
        r => { method(r, 'render-only').generation.itemElapsedMs++; },
        r => { r.generation.physicalBatch.postprocessInspectionElapsedMs++; },
      ]) {
        const forged = structuredClone(report); mutate(forged);
        assert.throws(() => validateAutomaticReport(plan, inspected, forged), /integrity/);
      }
      assert.equal(hash(inspected), inspectedHash);
      assert.equal(hash(baseline), baselineHash);
    }
    assert.deepEqual({ plan: hash(plan), run: hash(run) }, originalHashes);
  });
}

test('real status inspections preserve fixed first service costs across unknown, completed and failed states', async () => {
  const plan = fixture({ repeats: 1, methods: ['prompt-baseline', 'render-only', 'evidence-validated'] });
  const generated = await runPlan(plan, { generate: async (request, config, context) => ({
    answer: JSON.stringify(answer(plan.dataset.cases.find(c => c.id === context.caseId))),
    inputTokens: 7, outputTokens: 3, finishReason: 'length',
  }) });
  const parents = structuredClone(generated.records.filter(r => r.methodId === 'prompt-baseline'));
  parents.forEach(r => { r.elapsedMs = 100; }); // Fixed measured synthetic P cost, before deriving T/V.
  const original = await runPlan(plan, { existingRecords: parents,
    generate: () => { throw new Error('status inspection must not call a model'); } });
  for (const r of original.records.filter(r => r.derivation)) r.elapsedMs = r.methodId === 'render-only' ? 5 : 10;
  const originalHash = hash(original), planHash = hash(plan);
  assert.throws(() => buildAutomaticReport(plan, original), /unknown/);
  const decision = (record, state) => ({ recordId: record.id, originalRecordHash: hash(record),
    reviewerId: 'maintainer', state, reason: 'synthetic execution status check',
    evidence: 'synthetic transport inspection, not content grading' });
  const completed = resolveRunState(plan, original, parents.map(r => decision(r, 'completed')));
  const completedHash = hash(completed);
  const failed = resolveRunState(plan, completed, [decision(completed.records.find(r => r.methodId === 'prompt-baseline'), 'failed')]);
  for (const [run, count] of [[completed, 4], [failed, 3]]) {
    const runHash = hash(run), report = buildAutomaticReport(plan, run);
    for (const [id, firstMs] of [['render-only', 105], ['evidence-validated', 110]]) {
      const cost = method(report, id).generation;
      assert.equal(cost.itemElapsedMs, 4 * firstMs); assert.equal(cost.meanItemElapsedMs, firstMs);
      assert.equal(cost.completedLatency.count, count); assert.equal(cost.completedLatency.sumMs, count * firstMs);
      assert.equal(cost.completedLatency.medianMs, firstMs); assert.equal(cost.completedLatency.p95Ms, firstMs);
      assert.equal(cost.calls, 4); assert.equal(cost.inputTokens.sum, 28); assert.equal(cost.outputTokens.sum, 12);
    }
    const inspections = run.records.flatMap(r => r.postprocessInspections ?? []);
    assert.equal(inspections.length, count === 4 ? 8 : 10);
    const extra = inspections.reduce((total, i) => total + i.elapsedMs, 0);
    assert.ok(Math.abs(report.generation.physicalBatch.itemElapsedMs - (460 + extra)) < 0.000001);
    assert.equal(report.generation.physicalBatch.postprocessInspectionElapsedMs, extra);
    assert.equal(report.generation.physicalBatch.calls, 4);
    assert.equal(validateAutomaticReport(plan, run, report), report);
    compareAutomaticMethods(plan, run, report);
    assert.equal(hash(run), runHash);
  }
  assert.equal(hash(original), originalHash); assert.equal(hash(completed), completedHash); assert.equal(hash(plan), planHash);
});

test('partial attempt token parts include failed calls and unknown totals without double counting', async () => {
  const plan = fixture({ repeats: 1, methods: ['evidence-first'], retries: 1 });
  const run = await runPlan(plan, { generate: (request, config, context) => {
    if (context.stage === 'extract' && context.attempt === 0) throw Object.assign(new Error('retry'), { inputTokens: 5, outputTokens: null });
    return { answer: JSON.stringify(answer(plan.dataset.cases.find(c => c.id === context.caseId))), inputTokens: 7, outputTokens: 3 };
  } });
  const report = buildAutomaticReport(plan, run), cost = report.generation.physicalBatch;
  assert.equal(cost.calls, 12); assert.equal(cost.inputTokens.sum, 76);
  assert.equal(cost.outputTokens.sum, null); assert.equal(cost.outputTokens.partialKnownSum, 24);
  assert.equal(cost.outputTokens.attemptKnownSum, 24); assert.equal(cost.outputTokens.attemptCoverage.denominator, 12);
  const missingAttempt = structuredClone(run); missingAttempt.records[0].attempts.pop();
  missingAttempt.records[0].inputTokens = null;
  const partial = buildAutomaticReport(plan, missingAttempt).generation.physicalBatch.inputTokens;
  assert.equal(partial.sum, null); assert.equal(partial.partialKnownSum, 69);
  assert.equal(partial.missingAttemptRecords, 1);
});

test('generation arrays and all recorded cost numbers, negative/nonfinite values and totals validated', async () => {
  const plan = fixture({ repeats: 1, methods: ['prompt-baseline'], warmup: true }), run = await execute(plan);
  for (const mutate of [r => { r.records[0].attempts = {}; }, r => { r.warmup = {}; },
    r => { r.warmup[0].result = null; }, r => { r.records[0].attempts.push(r.records[0].attempts[0]); },
    r => { r.records[0].inputTokens++; }, r => { r.warmupHistoryComplete = 'true'; }]) {
    const bad = structuredClone(run); mutate(bad); assert.throws(() => buildAutomaticReport(plan, bad));
  }
  for (const value of [-1, Infinity, NaN, '1']) for (const mutate of [
    r => { r.batchElapsedMs = value; }, r => { r.records[0].attempts[0].elapsedMs = value; },
    r => { r.records[0].attempts[0].inputTokens = value; }, r => { r.warmup[0].result.outputTokens = value; },
    r => { r.warmup[0].result.elapsedMs = value; },
  ]) { const bad = structuredClone(run); mutate(bad); assert.throws(() => buildAutomaticReport(plan, bad)); }
});

test('deterministic live integrity rejects mutated reports; only codeCost.elapsedMs is ignored/optional', async () => {
  const plan = fixture(), run = await execute(plan), report = buildAutomaticReport(plan, run);
  for (const mutate of [r => { r.items[0].dateScore ^= 1; }, r => { r.items[0].recordHash = 'other'; },
    r => { r.items[0].outcome = 'format-failure'; }, r => { r.methods[0].primary.numerator++; },
    r => { r.methods.pop(); }, r => { r.items.pop(); }, r => { r.paperEligible = true; },
    r => { r.generation.physicalBatch.calls++; }, r => { r.inputSnapshots.access = 'public'; },
    r => { r.methods[0].primary.value = NaN; }, r => { r.extra = undefined; },
    r => { r.evaluatorHash = 'other'; },
  ]) {
    const bad = structuredClone(report); mutate(bad);
    assert.throws(() => validateAutomaticReport(plan, run, bad), /integrity/);
    assert.throws(() => compareAutomaticMethods(plan, run, bad), /integrity/);
  }
  const elapsed = structuredClone(report); elapsed.codeCost.elapsedMs += 10000;
  assert.equal(validateAutomaticReport(plan, run, elapsed), elapsed);
  delete elapsed.codeCost.elapsedMs; assert.equal(validateAutomaticReport(plan, run, elapsed), elapsed);
  elapsed.codeCost.elapsedMs = -1; assert.throws(() => validateAutomaticReport(plan, run, elapsed));
  const otherRun = await execute(plan, { transform: () => 'prose' });
  assert.throws(() => validateAutomaticReport(plan, otherRun, report), /integrity/);
  const ai = await grade(plan, run), withAi = buildAutomaticReport(plan, run, ai);
  const badAi = structuredClone(withAi); badAi.inputSnapshots.ai.items[0].date = 0;
  badAi.aiHash = hash(badAi.inputSnapshots.ai);
  assert.throws(() => validateAutomaticReport(plan, run, badAi), /AI/);
  const wrongAi = await grade(plan, run, (value, input) => judgment(input, { date: 0 }));
  assert.throws(() => validateAutomaticReport(plan, run, withAi, wrongAi), /supplied AI/);
});

test('every within-run method pair has fixed event/repeat denominator and descriptive article-unit net differences', async () => {
  const plan = fixture(), run = await execute(plan, { transform: (a, context) => {
    if (context.methodId === 'evidence-first' && context.caseId === 'known') a.events[0].date.day = 11;
    return JSON.stringify(a);
  } });
  const report = buildAutomaticReport(plan, run), compared = compareAutomaticMethods(plan, run, report);
  assert.equal(compared.pairs.length, 10); assert.equal(compared.significanceClaim, false);
  assert.equal(compared.repeatsIndependent, false); assert.match(compared.inference, /not 265 independent/);
  const pair = compared.pairs.find(p => p.leftMethodId === 'prompt-baseline' && p.rightMethodId === 'evidence-first');
  assert.equal(pair.denominator, 6); assert.equal(pair.regress, 2); assert.equal(pair.improve, 0);
  assert.equal(pair.both1, 4); assert.equal(pair.netDifference, -1 / 3);
  assert.equal(pair.articleUnit.count, 2); assert.equal(pair.articleUnit.meanNetDifference, -0.5);
  assert.equal(pair.byArticle.find(a => a.articleId === 'A').netDifference, -1);
  assert.equal(pair.byArticle.find(a => a.articleId === 'B').netDifference, 0);
  assert.equal(method(report, 'evidence-first').primary.value, 2 / 3);
  assert.equal(method(report, 'evidence-first').supplementary.articleEqualWeight.value, 0.5);
  for (const p of compared.pairs) {
    assert.equal(p.improve + p.regress + p.both0 + p.both1, 6);
    assert.equal(new Set(p.items.map(r => `${r.caseId}/${r.repeat}`)).size, 6);
    assert.ok(p.items.every(r => r.caseId !== 'control'));
  }
});

test('completed latency excludes timeout while failed-inclusive elapsed/mean retains it', async () => {
  const plan = fixture({ repeats: 1, methods: ['prompt-baseline'] }), run = await execute(plan);
  const elapsed = { known: 2000, control: 1000, unknown: 10000, mixed: 1000 };
  for (const record of run.records) {
    record.elapsedMs = elapsed[record.caseId];
    if (record.caseId === 'unknown') { record.state = 'failed'; record.rawAnswer = ''; }
  }
  const report = buildAutomaticReport(plan, run), cost = method(report).generation;
  assert.equal(cost.completedLatency.count, 3); assert.equal(cost.completedLatency.medianMs, 1000);
  assert.equal(cost.completedLatency.p95Ms, 2000); assert.equal(cost.completedLatency.sumMs, 4000);
  assert.equal(cost.itemElapsedMs, 14000); assert.equal(cost.meanItemElapsedMs, 3500);
  assert.equal(cost.failed, 1);
  const metrics = method(report).event;
  assert.deepEqual(metrics.primary, { numerator: 2, denominator: 3, value: 2 / 3 });
  assert.deepEqual(metrics.conditionalAccuracy, { numerator: 2, denominator: 2, value: 1 });
  assert.deepEqual(metrics.completion, { numerator: 2, denominator: 3, value: 2 / 3 });
  assert.deepEqual(metrics.failure, { numerator: 1, denominator: 3, value: 1 / 3 });
});

test('control-only population has N/A primary and trimmed gold categories override dataset types', async () => {
  const base = fixture({ repeats: 1, methods: ['prompt-baseline'], changeGold: g => {
    g.cases.find(c => c.id === 'control').category = '  reviewed-control  ';
  } });
  const dataset = { ...base.dataset, cases: base.dataset.cases.filter(c => c.kind === 'control') };
  const gold = { ...base.gold, datasetHash: hash(dataset), cases: base.gold.cases.filter(c => c.id === 'control') };
  const plan = makePlan(dataset, gold, base.config), report = buildAutomaticReport(plan, await execute(plan));
  assert.deepEqual(method(report).primary, { numerator: 0, denominator: 0, value: null });
  assert.equal(method(report).event.completion.value, null); assert.equal(method(report).event.failure.value, null);
  assert.equal(method(report).supplementary.articleEqualWeight.value, null);
  assert.equal(method(report).byQuestionType[0].questionType, 'reviewed-control');
  assert.equal(method(report).controls.primary.value, 1);
});
