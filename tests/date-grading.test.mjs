import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, makePlan } from '../evals/sejong/date-eval/core.mjs';
import { loadPilot } from '../evals/sejong/date-eval/pilot.mjs';
import { codeGrade, aiGrade, createReviewPackets, finalizeReviews, validateJudge, validateFinalAudit } from '../evals/sejong/date-eval/grading.mjs';
import { buildReport } from '../evals/sejong/date-eval/report.mjs';
import { runPlan } from '../evals/sejong/date-eval/runner.mjs';

const pilot = await loadPilot();
function fixture(ids = ['B01', 'B06', 'B08'], methods = ['strong', 'rule'], configure = () => {}) {
  const dataset = { ...structuredClone(pilot.dataset), cases: structuredClone(pilot.dataset.cases.filter(c => ids.includes(c.id))) };
  const gold = { ...structuredClone(pilot.gold), cases: structuredClone(pilot.gold.cases.filter(c => ids.includes(c.id))) };
  configure(dataset, gold);
  gold.datasetHash = hash(dataset);
  const plan = makePlan(dataset, gold, { model: 'secret-generation-model', endpoint: 'secret-endpoint',
    options: { secretOption: 'never-show-reviewers' }, timeoutMs: 1000, retries: 0,
    methods: methods.map(id => ({ id, version: '1' })), repeats: 1, seed: 7, runOrder: 'seeded', warmup: false });
  const run = { schemaVersion: 1, planId: plan.id, datasetHash: plan.datasetHash, goldHash: plan.goldHash,
    criteriaHash: plan.criteriaHash, configHash: plan.configHash, environment: { hardware: 'test' }, batchElapsedMs: 100,
    records: plan.slots.map(s => ({ ...s, state: 'completed', rawAnswer: '답변 원문. 표제는 30일, 사건 일자는 확인 불가.',
      rawInput: 'SECRET generation prompt', elapsedMs: 10, calls: 1, inputTokens: null, outputTokens: null, attempts: [] })) };
  return { plan, run };
}
function judgment(events, date = 1, evidence = 1) {
  return { date, evidence, reason: 'source and frozen gold compared', events: events.map(e => ({ id: e.id, date,
    ...Object.fromEntries(['unsupportedDay', 'missingKnownDay', 'headerConfusion'].map(f => [f, e.eligibility[f] ? 0 : null])),
    reasons: { date: 'event matches source', unsupportedDay: 'no unsupported assertion',
      missingKnownDay: 'required day retained', headerConfusion: 'header distinguished' } })) };
}
function aiJudgment(input, date = 1, evidence = 1) {
  const result = judgment(input.gold.events, date, evidence);
  const proof = event => ({ answerQuote: { quote: input.rawAnswer, start: 0, end: input.rawAnswer.length },
    sourceQuote: structuredClone(event.evidence.at(-1)),
    observedDate: { year: null, month: null, day: null, calendar: null },
    reason: 'answer wording and supplied source compared; observed date unknown in this synthetic response' });
  result.proofs = { date: proof(input.gold.events[0]), evidence: proof(input.gold.events[0]) };
  for (const [i, e] of result.events.entries()) {
    e.proofs = Object.fromEntries(['date', 'unsupportedDay', 'missingKnownDay', 'headerConfusion']
      .filter(f => f === 'date' || input.gold.events[i].eligibility[f]).map(f => [f, proof(input.gold.events[i])]));
  }
  return result;
}
function reviewSetup(plan, run) {
  const bundle = createReviewPackets(plan, run);
  const reviews = bundle.packets.flatMap(p => ['alice', 'bob'].map(reviewerId => ({
    packetId: p.id, packetHash: p.hash, reviewerId, independent: true, blind: true,
    ...judgment(p.input.gold.events) })));
  return { bundle, reviews };
}

test('AI validation reconstructs first interpretable scores from the preserved output', async () => {
  const { plan, run } = fixture(['B01'], ['strong']);
  const ai = await aiGrade(plan, run, { judge: input => aiJudgment(input, 0, 0) });
  const { bundle, reviews } = reviewSetup(plan, run), final = finalizeReviews(plan, run, bundle, reviews);
  assert.equal(validateJudge(plan, run, ai, final).metrics.date.matched, 0);
  const changed = structuredClone(ai);
  changed.items[0].date = 1; changed.items[0].evidence = 1; changed.items[0].events[0].date = 1;
  assert.throws(() => validateJudge(plan, run, changed, final), /preserved raw output/);
  const legacy = structuredClone(ai); delete legacy.items[0].attempts[0].judgmentOutput;
  assert.deepEqual(validateJudge(plan, run, legacy, final).metrics, validateJudge(plan, run, ai, final).metrics);
  const http = await aiGrade(plan, run, { judge: input => {
    const j = aiJudgment(input, 0, 0);
    return { answer: JSON.stringify(j), raw: JSON.stringify({ done: true, response: JSON.stringify(j) }) };
  } });
  assert.equal(validateJudge(plan, run, http, final).metrics.date.matched, 0);
  const copiesChanged = structuredClone(http), item = copiesChanged.items[0];
  item.date = 1; item.evidence = 1; item.events[0].date = 1;
  const copy = JSON.parse(item.attempts[0].judgmentOutput); copy.date = 1; copy.evidence = 1; copy.events[0].date = 1;
  item.attempts[0].judgmentOutput = JSON.stringify(copy);
  assert.throws(() => validateJudge(plan, run, copiesChanged, final), /transport raw output/);
});

test('AI audit storage failure stops immediately without converting it to a grading retry', async () => {
  const { plan, run } = fixture(['B01'], ['strong']); let calls = 0;
  await assert.rejects(aiGrade(plan, run, { judgeConfig: { retries: 2 }, judge: () => {
    calls++; const error = new Error('audit storage failed'); error.auditStorageFailure = true; throw error;
  } }), /audit storage/);
  assert.equal(calls, 1);
});

test('pilot gold snapshot preserves unknown days, allowed omissions and exact source quotes', () => {
  assert.deepEqual(pilot.gold.cases.map(c => c.events.map(e => e.expected.day)),
    [[null], [null], [30], [null], [null], [15], [15], [null, 15]]);
  for (const g of pilot.gold.cases) for (const e of g.events) {
    assert.deepEqual(e.allowedOmissions, ['year', 'calendar']);
    const source = pilot.dataset.cases.find(c => c.id === g.id).sourceText;
    for (const q of e.evidence) assert.equal(source.slice(q.start, q.end), q.quote);
  }
  assert.match(pilot.gold.rubric.date, /연도는 생략 가능/);
});

test('code grading compares structured values but never treats prose or quote existence as final evidence', () => {
  const { plan, run } = fixture(['B01', 'B06'], ['strong']);
  for (const r of run.records) {
    const g = plan.gold.cases.find(c => c.id === r.caseId);
    r.rawAnswer = JSON.stringify({ events: g.events.map(e => ({ id: e.id,
      date: { month: e.expected.month, day: e.expected.day }, unknownDay: e.requiresUnknownDay,
      evidence: e.evidence })) });
  }
  const graded = codeGrade(plan, run);
  assert.deepEqual(graded.items.map(i => [i.date, i.evidence, i.quoteExists]), [[1, null, 1], [1, null, 1]]);
  run.records[0].rawAnswer = '기사 표제는 30일이지만 정확한 창제일은 확인 불가합니다.';
  assert.equal(codeGrade(plan, run).items[0].date, null);
  assert.equal(run.records[0].state, 'completed');
  const data = JSON.parse(run.records[1].rawAnswer); data.events[0].date.day = null;
  run.records[1].rawAnswer = JSON.stringify(data);
  assert.equal(codeGrade(plan, run).items[1].date, 0);
  data.events.push(structuredClone(data.events[0])); run.records[1].rawAnswer = JSON.stringify(data);
  assert.match(codeGrade(plan, run).items[1].formatError, /duplicate/);
});

test('structured unsupported precision, missing targets, calendar aliases and bad quotes', () => {
  const { plan, run } = fixture(['B01', 'B08'], ['rule']);
  const e = plan.gold.cases[0].events[0];
  const answer = { events: [{ id: e.id, date: { month: 12, day: 30 }, unknownDay: true, evidence: e.evidence }] };
  run.records[0].rawAnswer = JSON.stringify(answer);
  assert.equal(codeGrade(plan, run).items[0].date, 0);
  answer.events[0].date = { month: 12, day: null, calendar: '음력' };
  answer.events[0].evidence = [{ quote: 'wrong quote', start: 0, end: 11 }];
  run.records[0].rawAnswer = JSON.stringify(answer);
  assert.deepEqual([codeGrade(plan, run).items[0].date, codeGrade(plan, run).items[0].quoteExists], [1, 0]);
  run.records[1].rawAnswer = JSON.stringify({ events: [] });
  const omitted = codeGrade(plan, run).items[1];
  assert.equal(omitted.date, 0); assert.equal(omitted.events.length, 2);
});

test('code grading accepts whole JSON fences without changing raw answers, quotes or scores', () => {
  const { plan, run } = fixture(['B01'], ['strong']);
  const event = plan.gold.cases[0].events[0];
  const answer = JSON.stringify({ events: [{ id: event.id, date: event.expected,
    unknownDay: true, evidence: event.evidence }] });
  run.records[0].rawAnswer = answer;
  const bare = codeGrade(plan, run).items[0];
  for (const wrap of [s => `\n\`\`\`json\n${s}\n\`\`\`\n`,
    s => `\uFEFF  \`\`\`JSON\t\r\n${s}\r\n\`\`\`  `, s => `\`\`\`\n${s}\n\`\`\``]) {
    run.records[0].rawAnswer = wrap(answer);
    const before = hash(run), item = codeGrade(plan, run).items[0];
    assert.equal(hash(run), before);
    assert.equal(item.recordHash, hash(run.records[0]));
    assert.deepEqual([item.date, item.quoteExists, item.evidence, item.events],
      [bare.date, bare.quoteExists, bare.evidence, bare.events]);
    assert.equal(item.formatError, undefined);
  }
  const wrong = JSON.parse(answer); wrong.events[0].date.day = 30;
  run.records[0].rawAnswer = `\`\`\`json\n${JSON.stringify(wrong)}\n\`\`\``;
  assert.equal(codeGrade(plan, run).items[0].date, 0);
});

test('code grading does not repair invalid JSON or extract it from prose or multiple fences', () => {
  const { plan, run } = fixture(['B01'], ['strong']);
  const valid = JSON.stringify({ events: [] });
  for (const raw of [
    `설명입니다.\n\`\`\`json\n${valid}\n\`\`\``,
    `\`\`\`json\n${valid}\n\`\`\`\n추가 설명`,
    `\`\`\`json\n${valid}\n\`\`\`\n\`\`\`json\n${valid}\n\`\`\``,
    `\`\`\`javascript\n${valid}\n\`\`\``, `\`\`\`json\n${valid}`,
    '\`\`\`json\n{"events": [],}\n\`\`\`',
  ]) {
    run.records[0].rawAnswer = raw;
    const before = hash(run), item = codeGrade(plan, run).items[0];
    assert.ok(item.formatError, raw);
    assert.equal(item.date, null);
    assert.equal(run.records[0].state, 'completed');
    assert.equal(hash(run), before);
  }
});

test('AI JSON fences survive transport audit replay while invalid outputs remain grading failures', async () => {
  const { plan, run } = fixture(['B01'], ['strong']);
  const { bundle, reviews } = reviewSetup(plan, run);
  const final = finalizeReviews(plan, run, bundle, reviews);
  for (const transport of [false, true]) {
    const ai = await aiGrade(plan, run, { judge: input => {
      const answer = `\`\`\`json\r\n${JSON.stringify(aiJudgment(input))}\r\n\`\`\``;
      return transport ? { answer, raw: JSON.stringify({ done: true, response: answer }), inputTokens: 5, outputTokens: 6 } : answer;
    } });
    assert.equal(ai.items[0].state, 'preliminary');
    assert.match(ai.items[0].attempts[0].judgmentOutput, /^```json/);
    assert.equal(validateJudge(plan, run, ai, final).metrics.date.matched, 1);
    const tampered = structuredClone(ai); tampered.items[0].date = 0;
    assert.throws(() => validateJudge(plan, run, tampered, final), /preserved raw output/);
  }
  for (const output of ['```json\n{"date":1,}\n```', '説明\n```json\n{}\n```']) {
    const ai = await aiGrade(plan, run, { judge: () => output });
    assert.equal(ai.items[0].state, 'grading-failure');
    assert.equal(ai.items[0].date, null);
    assert.equal(ai.items[0].attempts[0].rawOutput, output);
    assert.equal(run.records[0].state, 'completed');
  }
});

test('packets hide methods/options/rawInput and bind exact answers to records', () => {
  const { plan, run } = fixture(); const bundle = createReviewPackets(plan, run);
  const visible = JSON.stringify(bundle.packets);
  for (const secret of ['secret-generation-model', 'secret-endpoint', 'never-show-reviewers', 'SECRET generation prompt', 'methodId', 'configHash', 'recordId']) {
    assert.ok(!visible.includes(secret), secret);
  }
  assert.equal(new Set(bundle.packets.map(p => p.id)).size, run.records.length);
  assert.notDeepEqual(bundle.packets.map(p => p.id), createReviewPackets(plan, run).packets.map(p => p.id));
  bundle.packets[0].input.rawAnswer += 'tampered';
  assert.throws(() => finalizeReviews(plan, run, bundle, []), /input changed/);
});

test('two blind independent reviews finalize all completed records; failures are automatic zero without content review', () => {
  const { plan, run } = fixture(); run.records[0].state = 'failed'; run.records[0].error = 'generation timeout with partial answer';
  const original = hash(run); const { bundle, reviews } = reviewSetup(plan, run);
  assert.equal(bundle.packets.length, run.records.length - 1);
  const final = finalizeReviews(plan, run, bundle, reviews);
  assert.equal(hash(run), original);
  assert.equal(final.items[0].state, 'execution-failure'); assert.equal(final.items[0].date, 0);
  assert.equal(final.items[0].events[0].unsupportedDay, null);
  assert.ok(final.items.slice(1).every(i => i.state === 'final'));
  assert.equal(final.agreement.value, 1);
  assert.equal(buildReport(plan, run, final).methods[0].core.failed, 1);
});

test('single, duplicate, unblinded or stale first reviews cannot finalize', () => {
  const { plan, run } = fixture(['B01'], ['strong']); const { bundle, reviews } = reviewSetup(plan, run);
  assert.equal(finalizeReviews(plan, run, bundle, reviews.slice(0, 1)).items[0].state, 'pending');
  assert.throws(() => finalizeReviews(plan, run, bundle, [reviews[0], reviews[0]]), /distinct/);
  assert.throws(() => finalizeReviews(plan, run, bundle, [{ ...reviews[0], blind: false }]), /attestation/);
  assert.throws(() => finalizeReviews(plan, run, bundle, [{ ...reviews[0], packetHash: 'wrong' }]), /packet mismatch/);
  run.records[0].rawAnswer += 'changed';
  assert.throws(() => finalizeReviews(plan, run, bundle, reviews), /artifact mismatch/);
});

test('differences require reasoned reconciliation bound to both complete first reviews', () => {
  const { plan, run } = fixture(['B01'], ['strong']); const { bundle, reviews } = reviewSetup(plan, run);
  reviews[1].date = 0; reviews[1].events[0].date = 0;
  const unresolved = finalizeReviews(plan, run, bundle, reviews);
  assert.equal(unresolved.items[0].state, 'pending'); assert.equal(unresolved.agreement.details[0].differences.length, 2);
  assert.throws(() => buildReport(plan, run, unresolved), /pending/);
  const resolution = { packetId: reviews[0].packetId, packetHash: reviews[0].packetHash,
    reviewerIds: ['bob', 'alice'], firstReviewHashes: reviews.map(hash),
    ...judgment(bundle.packets[0].input.gold.events, 0), reason: 'both reviewers checked the actual source; month omitted' };
  const final = finalizeReviews(plan, run, bundle, reviews, [resolution]);
  assert.equal(final.items[0].date, 0); assert.equal(final.items[0].state, 'final');
  assert.deepEqual(final.agreement.details[0].firstReviews, reviews);
  assert.equal(final.agreement.numerator, final.agreement.denominator - 2);
  const wrong = { ...resolution, firstReviewHashes: ['bad', 'bad'] };
  assert.throws(() => finalizeReviews(plan, run, bundle, reviews, [wrong]), /first review mismatch/);
  assert.equal(finalizeReviews(plan, run, bundle, reviews, [{ ...resolution, evidence: null }]).items[0].state, 'pending');
});

test('eligible event omissions require review; ineligible control flags must remain null', () => {
  const { plan, run } = fixture(['B03', 'B08'], ['strong']); const { bundle, reviews } = reviewSetup(plan, run);
  const control = reviews.find(r => r.events[0].id === 'header');
  control.events[0].unsupportedDay = 0;
  assert.throws(() => finalizeReviews(plan, run, bundle, reviews), /ineligible/);
  control.events[0].unsupportedDay = null;
  const multi = reviews.find(r => r.events.length === 2); multi.events.pop();
  const pending = finalizeReviews(plan, run, bundle, reviews);
  assert.equal(pending.items.find(i => i.recordId === run.records[1].id).state, 'pending');
});

test('unexecuted and unknown stay pending, never zero; final reports are blocked', () => {
  for (const state of ['unexecuted', 'unknown']) {
    const { plan, run } = fixture(['B01'], ['strong']); run.records[0].state = state;
    const final = finalizeReviews(plan, run, createReviewPackets(plan, run), []);
    assert.equal(final.items[0].date, null); assert.equal(final.items[0].state, 'pending');
    assert.throws(() => buildReport(plan, run, final), /unexecuted or unknown/);
  }
});

test('AI input is restricted; partial failures preserve valid scores and do not retry', async () => {
  const { plan, run } = fixture(['B08'], ['strong']); let calls = 0;
  const original = hash(run);
  const ai = await aiGrade(plan, run, { judgeConfig: { model: 'judge', version: 'v1', retries: 2 },
    judge: (input, context) => {
      calls++; assert.equal(context.attempt, 1); assert.ok(context.signal instanceof AbortSignal);
      assert.ok(!JSON.stringify(input).includes('SECRET')); assert.ok(!JSON.stringify(input).includes('methodId'));
      const value = aiJudgment(input); delete value.evidence;
      value.events[1].missingKnownDay = null;
      return { answer: JSON.stringify(value), raw: 'transport response', inputTokens: 4, outputTokens: 5 };
    } });
  assert.equal(calls, 1); assert.equal(hash(run), original);
  assert.equal(ai.items[0].date, 1); assert.equal(ai.items[0].evidence, null);
  assert.equal(ai.items[0].events[0].date, 1); assert.equal(ai.items[0].events[1].missingKnownDay, null);
  assert.equal(ai.items[0].state, 'partial-failure'); assert.equal(ai.evaluationCost.inputTokens.sum, 4);
});

test('AI retries only whole failures and records malformed output; timeouts abort even an ignoring callback', async () => {
  const { plan, run } = fixture(['B06'], ['strong']);
  const ai = await aiGrade(plan, run, { judgeConfig: { retries: 1 }, judge: (input, { attempt }) =>
    attempt === 1 ? 'malformed JSON' : aiJudgment(input) });
  assert.equal(ai.items[0].attempts.length, 2); assert.equal(ai.items[0].attempts[0].rawOutput, 'malformed JSON');
  assert.equal(ai.items[0].state, 'preliminary');
  let signal;
  const timeout = await aiGrade(plan, run, { judgeConfig: { timeoutMs: 10 }, judge: (_, context) => {
    signal = context.signal; return new Promise(() => {});
  } });
  assert.equal(signal.aborted, true); assert.equal(timeout.items[0].state, 'grading-failure');
  assert.equal(timeout.items[0].date, null); assert.equal(timeout.items[0].events[0].date, null);
  assert.match(timeout.items[0].attempts[0].error, /timeout/);
});

test('AI judge failure does not prevent independent human finalization and failed generation is never judged', async () => {
  const { plan, run } = fixture(['B01', 'B06'], ['strong']); run.records[0].state = 'failed'; let calls = 0;
  const ai = await aiGrade(plan, run, { judge: () => { calls++; throw new Error('judge unavailable'); } });
  assert.equal(calls, 1); assert.equal(ai.items[0].state, 'execution-failure');
  const { bundle, reviews } = reviewSetup(plan, run); const final = finalizeReviews(plan, run, bundle, reviews);
  assert.equal(final.items[1].state, 'final');
  const validation = validateJudge(plan, run, ai, final);
  assert.equal(validation.metrics.date.total, 1); assert.equal(validation.metrics.date.failures, 1);
  assert.equal(validation.metrics.date.agreementWithFailures.value, 0);
  assert.equal(validation.metrics.date.validAgreement.value, null);
});

test('validation counts item-level 2x3 confusion with failures in denominator and excludes N/A', async () => {
  const { plan, run } = fixture(['B01', 'B06'], ['strong']);
  const ai = await aiGrade(plan, run, { judge: input => {
    const j = aiJudgment(input); if (j.events[0].id === 'creation') delete j.evidence;
    else { j.date = 0; j.events[0].date = 0; }
    return j;
  } });
  const { bundle, reviews } = reviewSetup(plan, run); const final = finalizeReviews(plan, run, bundle, reviews);
  const result = validateJudge(plan, run, ai, final);
  assert.deepEqual(result.metrics.date.matrix.human1, { ai0: 1, ai1: 1, failure: 0 });
  assert.deepEqual(result.metrics.evidence.matrix.human1, { ai0: 0, ai1: 1, failure: 1 });
  assert.equal(result.metrics.evidence.agreementWithFailures.value, .5);
  assert.equal(result.metrics.evidence.validAgreement.value, 1); assert.equal(result.metrics.evidence.completion.value, .5);
  assert.equal(result.metrics.unsupportedDay.total, 1); assert.equal(result.metrics.missingKnownDay.total, 1);
  assert.equal(result.metrics.headerConfusion.total, 2); assert.equal(result.metrics.eventDate.total, 2);
  assert.equal(result.byMethod.strong.date.total, 2); assert.equal(result.automaticFinalAllowed, false);
  assert.throws(() => validateJudge(plan, run, ai, final, { calibrationGroups: ['S1'], validationGroups: ['S1'] }), /overlap/);
  const heldout = validateJudge(plan, run, ai, final, { calibrationGroups: ['S1'], validationGroups: ['S3'] });
  assert.equal(heldout.metrics.date.total, 1);
  assert.throws(() => validateJudge(plan, run, ai, final, { validationGroups: ['missing'] }), /invalid/);
});

test('frozen gold categories split generic dataset types without entering generation or judge inputs', async () => {
  const categories = { B01: 'gold-only-unknown', B06: 'gold-only-known', B08: 'gold-only-mixed' };
  const { plan } = fixture(Object.keys(categories), ['prompt-baseline', 'rule-baseline', 'evidence-first'], (dataset, gold) => {
    for (const c of dataset.cases) c.type = 'generic-generation-type';
    for (const g of gold.cases) g.category = categories[g.id];
  });
  let generationCalls = 0;
  const run = await runPlan(plan, { generate: request => {
    generationCalls++;
    for (const category of Object.values(categories)) assert.ok(!JSON.stringify(request).includes(category));
    return { answer: '모의 답변: 확인 가능한 날짜와 근거.', raw: 'offline fixture', inputTokens: 0, outputTokens: 0 };
  } });
  assert.equal(generationCalls, 9);
  let judgeCalls = 0;
  const ai = await aiGrade(plan, run, { judge: input => {
    judgeCalls++;
    assert.equal(Object.hasOwn(input.gold, 'category'), false);
    for (const category of Object.values(categories)) assert.ok(!JSON.stringify(input).includes(category));
    return aiJudgment(input);
  } });
  assert.equal(judgeCalls, 9);
  const { bundle, reviews } = reviewSetup(plan, run);
  for (const category of Object.values(categories)) assert.ok(!JSON.stringify(bundle.packets).includes(category));
  const result = validateJudge(plan, run, ai, finalizeReviews(plan, run, bundle, reviews));
  assert.deepEqual(Object.keys(result.byQuestionType).sort(), Object.values(categories).sort());
  assert.ok(result.observations.every(r => r.questionType === categories[r.caseId]));
  for (const category of Object.values(categories)) assert.equal(result.byQuestionType[category].date.total, 3);
  assert.equal(result.byQuestionType[categories.B08].eventDate.total, 6);
  assert.equal(result.metrics.date.total, 9);
  assert.equal(result.metrics.eventDate.total, 12);
  for (const method of Object.values(result.byMethod)) assert.equal(method.date.total, 3);
});

test('legacy gold without category retains dataset type and unspecified fallback', async () => {
  const { plan, run } = fixture(['B01', 'B03', 'B06'], ['strong'], (dataset, gold) => {
    for (const g of gold.cases) delete g.category;
    delete dataset.cases.find(c => c.id === 'B03').type;
  });
  const ai = await aiGrade(plan, run, { judge: input => aiJudgment(input) });
  const { bundle, reviews } = reviewSetup(plan, run);
  const result = validateJudge(plan, run, ai, finalizeReviews(plan, run, bundle, reviews));
  assert.deepEqual(Object.keys(result.byQuestionType).sort(), ['known-day', 'unknown-day', 'unspecified']);
  for (const c of plan.dataset.cases) {
    assert.ok(result.observations.filter(r => r.caseId === c.id).every(r => r.questionType === (c.type ?? 'unspecified')));
    assert.equal(result.byQuestionType[c.type ?? 'unspecified'].date.total, 1);
  }
});

test('explicit gold categories reject empty or non-string values, including outside validation groups', async () => {
  for (const category of ['', ' \t\n ', null, undefined, 0, true, [], {}]) {
    const { plan, run } = fixture(['B01', 'B06'], ['strong'], (_, gold) => {
      gold.cases.find(g => g.id === 'B01').category = category;
    });
    const ai = await aiGrade(plan, run, { judge: input => aiJudgment(input) });
    const { bundle, reviews } = reviewSetup(plan, run);
    assert.throws(() => validateJudge(plan, run, ai, finalizeReviews(plan, run, bundle, reviews), {
      calibrationGroups: ['S1'], validationGroups: ['S3'],
    }), /B01.*category/);
  }
  const { plan, run } = fixture(['B01'], ['strong'], (_, gold) => { gold.cases[0].category = ' known-category '; });
  const ai = await aiGrade(plan, run, { judge: input => aiJudgment(input) });
  const { bundle, reviews } = reviewSetup(plan, run);
  const result = validateJudge(plan, run, ai, finalizeReviews(plan, run, bundle, reviews));
  assert.deepEqual(Object.keys(result.byQuestionType), ['known-category']);
  assert.ok(result.observations.every(r => r.questionType === 'known-category'));
  assert.equal(plan.gold.cases[0].category, ' known-category ');
});

test('gold categories preserve partial AI failures, held-out groups, N/A, control and two-person finals', async () => {
  const categories = { B01: 'unknown', B03: 'header-control', B04: 'calibration-only', B06: 'known', B07: 'failed-only', B08: 'mixed' };
  const { plan, run } = fixture(Object.keys(categories), ['strong'], (dataset, gold) => {
    for (const c of dataset.cases) c.type = 'generic-generation-type';
    for (const g of gold.cases) g.category = categories[g.id];
  });
  run.records.find(r => r.caseId === 'B07').state = 'failed';
  let calls = 0;
  const ai = await aiGrade(plan, run, { judge: input => {
    calls++;
    const j = aiJudgment(input);
    if (j.events.length === 2) { delete j.proofs.evidence; delete j.events[1].proofs.missingKnownDay; }
    return j;
  } });
  assert.equal(calls, 5);
  assert.equal(ai.items.find(i => i.recordId === run.records.find(r => r.caseId === 'B08').id).state, 'partial-failure');
  const { bundle, reviews } = reviewSetup(plan, run);
  assert.throws(() => validateJudge(plan, run, ai, finalizeReviews(plan, run, bundle, reviews.filter(r => r.reviewerId === 'alice'))), /pending/);
  const final = finalizeReviews(plan, run, bundle, reviews), finalHash = hash(final);
  assert.equal(final.items.filter(i => i.state === 'final').length, 5);
  assert.equal(final.items.filter(i => i.state === 'execution-failure').length, 1);
  assert.ok(final.agreement.details.every(d => d.firstReviews.length === 2));
  const options = { calibrationGroups: ['S2'], validationGroups: ['S1', 'S3'] };
  const result = validateJudge(plan, run, ai, final, options);
  assert.deepEqual(validateJudge(plan, run, ai, final, { calibrationGroups: ['S2'] }), result);
  assert.deepEqual(result.calibrationGroups, ['S2']);
  assert.deepEqual(result.validationGroups, ['S1', 'S3']);
  assert.deepEqual(Object.keys(result.byQuestionType).sort(), ['header-control', 'known', 'mixed', 'unknown']);
  assert.ok(result.observations.every(r => r.groupId !== 'S2' && r.caseId !== 'B07' && r.questionType === categories[r.caseId]));
  assert.equal(result.metrics.date.total, 4);
  assert.equal(result.metrics.evidence.total, 4);
  assert.equal(result.metrics.evidence.failures, 1);
  assert.equal(result.metrics.evidence.agreementWithFailures.value, .75);
  assert.equal(result.metrics.evidence.validAgreement.value, 1);
  assert.equal(result.metrics.evidence.completion.value, .75);
  assert.equal(result.metrics.eventDate.total, 5);
  assert.equal(result.metrics.unsupportedDay.total, 2);
  assert.equal(result.metrics.missingKnownDay.total, 2);
  assert.equal(result.metrics.headerConfusion.total, 4);
  assert.equal(result.byQuestionType.mixed.evidence.failures, 1);
  assert.deepEqual(result.byQuestionType.mixed.missingKnownDay.matrix.human0, { ai0: 0, ai1: 0, failure: 1 });
  assert.equal(result.byQuestionType.mixed.missingKnownDay.agreementWithFailures.value, 0);
  assert.equal(result.byQuestionType.mixed.missingKnownDay.validAgreement.value, null);
  assert.equal(result.byQuestionType.known.missingKnownDay.failures, 0);
  assert.equal(result.byKind.event.date.total, 3);
  assert.equal(result.byKind.control.date.total, 1);
  assert.deepEqual(result.byQuestionType['header-control'], result.byKind.control);
  for (const flag of ['unsupportedDay', 'missingKnownDay', 'headerConfusion']) {
    assert.equal(result.byKind.control[flag].total, 0);
    assert.equal(result.byKind.control[flag].agreementWithFailures.value, null);
  }
  assert.equal(result.automaticFinalAllowed, false);
  const report = buildReport(plan, run, final).methods[0];
  assert.equal(report.core.fixedTotal, 5); assert.equal(report.core.failed, 1);
  assert.equal(report.core.accuracy.value, .8);
  assert.equal(report.control.fixedTotal, 1); assert.equal(report.control.accuracy.value, 1);
  assert.equal(hash(final), finalHash);
});

test('AI N/A, missing reasons and omitted events produce local failures, preserving independent items', async () => {
  const { plan, run } = fixture(['B08'], ['strong']);
  const ai = await aiGrade(plan, run, { judge: input => {
    const j = aiJudgment(input); j.events.pop(); delete j.events[0].reasons.unsupportedDay; return j;
  } });
  assert.equal(ai.items[0].date, null); assert.equal(ai.items[0].events[0].unsupportedDay, null);
  const { bundle, reviews } = reviewSetup(plan, run);
  const result = validateJudge(plan, run, ai, finalizeReviews(plan, run, bundle, reviews));
  assert.equal(result.metrics.eventDate.total, 2); assert.equal(result.metrics.eventDate.failures, 1);
  assert.equal(result.metrics.missingKnownDay.failures, 1); assert.equal(result.metrics.unsupportedDay.failures, 1);
});

test('version hashes reject stale artifacts and validation requires complete humans', async () => {
  const { plan, run } = fixture(['B01'], ['strong']);
  const ai = await aiGrade(plan, run, { judge: input => aiJudgment(input) });
  const { bundle, reviews } = reviewSetup(plan, run);
  assert.throws(() => validateJudge(plan, run, ai, finalizeReviews(plan, run, bundle, [])), /pending/);
  const final = finalizeReviews(plan, run, bundle, reviews);
  ai.items[0].recordHash = 'wrong'; assert.throws(() => validateJudge(plan, run, ai, final), /record hash/);
  plan.gold.rubric.date += 'changed';
  assert.throws(() => codeGrade(plan, run), /변경/);
});

test('AI duplicated event fails only that event; transport failures preserve raw partials and tokens', async () => {
  const { plan, run } = fixture(['B08'], ['strong']);
  const ai = await aiGrade(plan, run, { judge: input => {
    const j = aiJudgment(input); j.events.push(structuredClone(j.events[0])); return j;
  } });
  assert.equal(ai.items[0].events[0].date, null); assert.equal(ai.items[0].events[1].date, 1);
  assert.equal(ai.items[0].date, null);
  const failed = await aiGrade(plan, run, { judge: () => {
    const error = new Error('transport timeout'); error.raw = 'readable partial judgment';
    error.inputTokens = 11; error.outputTokens = 2; throw error;
  } });
  assert.equal(failed.items[0].date, null);
  assert.equal(failed.items[0].attempts[0].rawOutput, 'readable partial judgment');
  assert.equal(failed.evaluationCost.inputTokens.sum, 11);
});

test('validation detects altered human scores/audit and counts false acceptance versus error flags', async () => {
  const { plan, run } = fixture(['B01'], ['strong']); const { bundle, reviews } = reviewSetup(plan, run);
  for (const r of reviews) { r.date = 0; r.events[0].date = 0; r.events[0].unsupportedDay = 1; }
  const final = finalizeReviews(plan, run, bundle, reviews);
  const ai = await aiGrade(plan, run, { judge: input => aiJudgment(input) });
  const result = validateJudge(plan, run, ai, final);
  assert.equal(result.metrics.date.falseAcceptance, 1);
  assert.equal(result.metrics.unsupportedDay.falseAcceptance, 1);
  assert.equal(result.metrics.unsupportedDay.positiveMeaning, 'error present');
  const tampered = structuredClone(final); tampered.items[0].date = 1;
  assert.throws(() => validateJudge(plan, run, ai, tampered), /review audit/);
  const aiOnly = structuredClone(final); aiOnly.agreement.details[0].firstReviews = [];
  assert.throws(() => validateJudge(plan, run, ai, aiOnly), /review audit/);
  assert.deepEqual(validateJudge(plan, run, JSON.parse(JSON.stringify(ai)), JSON.parse(JSON.stringify(final))).metrics, result.metrics);
});

test('month-only and year-only questions honor frozen required elements without extra unknown-day demands', () => {
  const { plan: initial } = fixture(['B01'], ['strong']);
  for (const mode of ['month', 'year']) {
    const dataset = structuredClone(initial.dataset), gold = structuredClone(initial.gold);
    const e = gold.cases[0].events[0]; e.required = [mode];
    e.eligibility = { unsupportedDay: true, missingKnownDay: false, headerConfusion: true };
    if (mode === 'year') e.expected = { year: 1443, month: null, day: null, calendar: 'lunar' };
    const plan = makePlan(dataset, gold, initial.config);
    const run = { schemaVersion: 1, planId: plan.id, datasetHash: plan.datasetHash, goldHash: plan.goldHash,
      criteriaHash: plan.criteriaHash, configHash: plan.configHash, batchElapsedMs: 1, environment: {},
      records: plan.slots.map(s => ({ ...s, state: 'completed', rawAnswer: JSON.stringify({ events: [{ id: e.id,
        date: { [mode]: e.expected[mode] }, evidence: e.evidence }] }), rawInput: '', elapsedMs: 1,
      calls: 0, inputTokens: 0, outputTokens: 0, attempts: [] })) };
    assert.equal(codeGrade(plan, run).items[0].date, 1);
    const answer = JSON.parse(run.records[0].rawAnswer); delete answer.events[0].date[mode];
    run.records[0].rawAnswer = JSON.stringify(answer);
    assert.equal(codeGrade(plan, run).items[0].date, 0);
  }
});

test('explicit configured regnalYear normalizes; numeric year25, unknown aliases and conflicting years fail', () => {
  const { plan, run } = fixture(['B01'], ['strong']);
  const check = date => {
    run.records[0].rawAnswer = JSON.stringify({ events: [{ id: 'creation',
      date: { month: 12, day: null, ...date }, unknownDay: true, evidence: [] }] });
    return codeGrade(plan, run).items[0].date;
  };
  assert.equal(check({ regnalYear: 25 }), 1);
  assert.equal(check({ year: 1443, regnalYear: 25 }), 1);
  assert.equal(check({ year: 25 }), 0);
  assert.equal(check({ year: 1445, regnalYear: 25 }), 0);
  assert.equal(check({ regnalYear: 26 }), 0);
  assert.equal(check({ regnalYear: '25' }), 0);
  const gold = structuredClone(plan.gold); delete gold.rubric.aliases.regnalYear;
  const noAliasPlan = makePlan(plan.dataset, gold, plan.config);
  const noAliasRun = { ...run, planId: noAliasPlan.id, goldHash: noAliasPlan.goldHash, criteriaHash: noAliasPlan.criteriaHash,
    records: [{ ...run.records[0], ...noAliasPlan.slots[0] }] };
  noAliasRun.records[0].rawAnswer = JSON.stringify({ events: [{ id: 'creation',
    date: { regnalYear: 25, month: 12, day: null }, unknownDay: true }] });
  assert.equal(codeGrade(noAliasPlan, noAliasRun).items[0].date, 0);
});

test('AI item-specific proofs verify exact answer/source spans and observed date; other valid items survive', async () => {
  const { plan, run } = fixture(['B08'], ['strong']);
  const badProofs = [
    p => { p.answerQuote.quote = 'invented answer quote'; },
    p => { p.answerQuote.start = 1; },
    p => { p.sourceQuote.end++; },
    p => { p.sourceQuote.quote = 'invented source quote'; },
    p => { p.sourceQuote.start = -1; },
    p => { delete p.observedDate; },
    p => { delete p.observedDate.day; },
    p => { p.observedDate.month = 13; },
    p => { p.observedDate.day = '15'; },
    p => { p.reason = ''; },
  ];
  for (const corrupt of badProofs) {
    const ai = await aiGrade(plan, run, { judge: input => {
      const j = aiJudgment(input); corrupt(j.proofs.evidence); return j;
    } });
    assert.equal(ai.items[0].date, 1); assert.equal(ai.items[0].evidence, null);
    assert.equal(ai.items[0].events[0].date, 1); assert.equal(ai.items[0].events[1].date, 1);
    assert.match(ai.items[0].failures.evidence, /proof/);
    assert.equal(ai.items[0].attempts.length, 1);
  }
  const local = await aiGrade(plan, run, { judge: input => {
    const j = aiJudgment(input); delete j.events[0].proofs.unsupportedDay; return j;
  } });
  assert.equal(local.items[0].events[0].unsupportedDay, null);
  assert.equal(local.items[0].events[0].headerConfusion, 0);
  assert.equal(local.items[0].events[1].missingKnownDay, 0);
  assert.equal(local.items[0].date, 1); assert.equal(local.items[0].evidence, 1);
  assert.ok(local.items[0].proofs.date.answerQuote);
  const { bundle, reviews } = reviewSetup(plan, run);
  const metrics = validateJudge(plan, run, local, finalizeReviews(plan, run, bundle, reviews)).metrics;
  assert.equal(metrics.unsupportedDay.failures, 1); assert.equal(metrics.headerConfusion.failures, 0);
  const reasonOnly = await aiGrade(plan, run, { judge: input => judgment(input.gold.events) });
  assert.equal(reasonOnly.items[0].date, null); assert.equal(reasonOnly.items[0].evidence, null);
  assert.ok(reasonOnly.items[0].events.every(e => e.date === null));
});

test('two uncertain immutable first reviews can reconcile without converting null to zero', () => {
  const { plan, run } = fixture(['B08'], ['strong']); const { bundle, reviews } = reviewSetup(plan, run);
  for (const r of reviews) { r.date = null; r.events[0].date = null; r.events[0].unsupportedDay = null; }
  const firstHashes = reviews.map(hash), original = structuredClone(reviews);
  const pending = finalizeReviews(plan, run, bundle, reviews);
  assert.equal(pending.items[0].date, null); assert.equal(pending.items[0].state, 'pending');
  assert.ok(pending.agreement.details[0].differences.some(d => d.left === null && d.right === null));
  assert.throws(() => validateFinalAudit(plan, run, pending), /pending/);
  const resolution = { packetId: reviews[0].packetId, packetHash: reviews[0].packetHash,
    reviewerIds: ['alice', 'bob'], firstReviewHashes: firstHashes,
    ...judgment(bundle.packets[0].input.gold.events), reason: 'both humans resolved uncertainty by comparing exact source clauses' };
  const final = finalizeReviews(plan, run, bundle, reviews, [resolution]);
  assert.equal(final.items[0].date, 1); assert.equal(final.items[0].state, 'final');
  assert.deepEqual(reviews, original); assert.deepEqual(reviews.map(hash), firstHashes);
  assert.deepEqual(final.agreement.details[0].firstReviews, original);
  assert.equal(final.agreement.details[0].firstReviews[0].date, null);
  assert.equal(final.agreement.details[0].adjudication.date, 1);
  assert.equal(validateFinalAudit(plan, run, final), final);
  assert.equal(buildReport(plan, run, final).methods[0].core.accuracy.value, 1);
  const unresolved = finalizeReviews(plan, run, bundle, reviews, [{ ...resolution, date: null }]);
  assert.equal(unresolved.items[0].date, null); assert.equal(unresolved.items[0].state, 'pending');
  assert.throws(() => finalizeReviews(plan, run, bundle, reviews.slice(0, 1), [resolution]), /two independent/);
});

test('question date must match all gold target dates; humans reject contradiction, AI fails only question date', async () => {
  const { plan, run } = fixture(['B08'], ['strong']); const { bundle, reviews } = reviewSetup(plan, run);
  reviews[0].events[1].date = 0;
  assert.throws(() => finalizeReviews(plan, run, bundle, reviews), /contradicts/);
  for (const [questionDate, eventDate] of [[1, 0], [0, 1]]) {
    const ai = await aiGrade(plan, run, { judge: input => {
      const j = aiJudgment(input); j.date = questionDate; j.events[1].date = eventDate; return j;
    } });
    assert.equal(ai.items[0].date, null); assert.equal(ai.items[0].evidence, 1);
    assert.equal(ai.items[0].events[1].date, eventDate);
    assert.equal(ai.items[0].events[0].date, 1); assert.equal(ai.items[0].events[0].headerConfusion, 0);
    assert.match(ai.items[0].failures.date, /consistent/);
  }
  const wrongZero = structuredClone(reviews); wrongZero[0].events[1].date = 1; wrongZero[0].date = 0;
  assert.throws(() => finalizeReviews(plan, run, bundle, wrongZero), /contradicts/);
});

test('standalone final audit gate rejects ad-hoc numeric finals and tampered first reviews/resolutions', () => {
  const { plan, run } = fixture(['B01'], ['strong']); const { bundle, reviews } = reviewSetup(plan, run);
  const final = finalizeReviews(plan, run, bundle, reviews);
  assert.equal(validateFinalAudit(plan, run, final), final);
  const numericOnly = { ...final, agreement: {} };
  assert.throws(() => validateFinalAudit(plan, run, numericOnly), /human review audit/);
  const changedScore = structuredClone(final); changedScore.items[0].evidence = 0;
  assert.throws(() => validateFinalAudit(plan, run, changedScore), /review audit/);
  const changedFirst = structuredClone(final); changedFirst.agreement.details[0].firstReviews[0].reason += 'edited';
  assert.throws(() => validateFinalAudit(plan, run, changedFirst), /review audit/);
  reviews[1].date = 0; reviews[1].events[0].date = 0;
  const resolution = { packetId: reviews[0].packetId, packetHash: reviews[0].packetHash,
    reviewerIds: ['alice', 'bob'], firstReviewHashes: reviews.map(hash),
    ...judgment(bundle.packets[0].input.gold.events), reason: 'joint source check resolved disagreement' };
  const resolved = finalizeReviews(plan, run, bundle, reviews, [resolution]);
  assert.equal(validateFinalAudit(plan, run, resolved), resolved);
  resolved.agreement.details[0].adjudication.evidence = 0;
  assert.throws(() => validateFinalAudit(plan, run, resolved), /review audit/);
});

test('AI timeout recovers cooperative post-abort rejection raw and 20 input tokens without grading', async () => {
  const { plan, run } = fixture(['B06'], ['strong']);
  const ai = await aiGrade(plan, run, { judgeConfig: { timeoutMs: 10, cancelGraceMs: 100 },
    judge: (_, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => setTimeout(() => {
        const error = new Error('transport aborted after receiving partial body');
        error.raw = 'partial transport body'; error.inputTokens = 20; error.outputTokens = 3;
        reject(error);
      }, 5), { once: true });
    }) });
  const item = ai.items[0], attempt = item.attempts[0];
  assert.equal(item.state, 'grading-failure'); assert.equal(item.date, null); assert.equal(item.evidence, null);
  assert.equal(item.events[0].date, null); assert.equal(item.events[0].missingKnownDay, null);
  assert.equal(attempt.error, 'judge timeout'); assert.equal(attempt.timedOut, true);
  assert.equal(attempt.rawOutput, 'partial transport body'); assert.equal(attempt.inputTokens, 20);
  assert.equal(attempt.outputTokens, 3); assert.match(attempt.transportError, /transport aborted/);
  assert.equal(attempt.transportSettlement, 'rejected-after-timeout');
  assert.equal(attempt.transportRecordMissing, false); assert.deepEqual(attempt.missingTransportFields, []);
  assert.equal(ai.evaluationCost.inputTokens.sum, 20); assert.equal(ai.evaluationCost.outputTokens.sum, 3);
});

test('late successful AI output preserves usage but timeout wins over valid item proofs', async () => {
  const { plan, run } = fixture(['B06'], ['strong']);
  const ai = await aiGrade(plan, run, { judgeConfig: { timeoutMs: 10, cancelGraceMs: 100 },
    judge: (input, { signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => setTimeout(() => resolve({ answer: aiJudgment(input),
        raw: 'late complete transport body', inputTokens: 20, outputTokens: 10 }), 5), { once: true });
    }) });
  const item = ai.items[0], attempt = item.attempts[0];
  assert.equal(item.state, 'grading-failure'); assert.equal(item.date, null); assert.equal(item.events[0].date, null);
  assert.equal(attempt.error, 'judge timeout'); assert.equal(attempt.transportSettlement, 'resolved-after-timeout');
  assert.equal(attempt.rawOutput, 'late complete transport body'); assert.equal(attempt.outputTokens, 10);
  assert.equal(ai.evaluationCost.inputTokens.sum, 20);
});

test('uncooperative AI callback is bounded and explicitly records missing transport data', async () => {
  const { plan, run } = fixture(['B06'], ['strong']);
  const began = performance.now();
  const ai = await aiGrade(plan, run, { judgeConfig: { timeoutMs: 10, cancelGraceMs: 15 },
    judge: () => new Promise(() => {}) });
  assert.ok(performance.now() - began < 1000, 'timeout/grace must not await callback indefinitely');
  const attempt = ai.items[0].attempts[0];
  assert.equal(attempt.transportSettlement, 'not-settled-within-grace');
  assert.equal(attempt.transportRecordMissing, true);
  assert.deepEqual(attempt.missingTransportFields, ['rawOutput', 'inputTokens', 'outputTokens']);
  assert.equal(ai.evaluationCost.inputTokens.sum, null); assert.equal(ai.evaluationCost.inputTokens.known, 0);
  for (const cancelGraceMs of [-1, 101, Infinity]) {
    await assert.rejects(aiGrade(plan, run, { judgeConfig: { cancelGraceMs }, judge: () => {} }), /cancelGraceMs/);
  }
});

test('late callback rejection beyond grace cannot rewrite returned timeout audit', async () => {
  const { plan, run } = fixture(['B06'], ['strong']); let rejectLate;
  const ai = await aiGrade(plan, run, { judgeConfig: { timeoutMs: 10, cancelGraceMs: 0 },
    judge: () => new Promise((resolve, reject) => { rejectLate = reject; }) });
  const before = hash(ai);
  const error = new Error('late rejection'); error.raw = 'body after grace'; error.inputTokens = 20;
  rejectLate(error); await new Promise(resolve => setImmediate(resolve));
  assert.equal(hash(ai), before); assert.equal(ai.items[0].attempts[0].transportRecordMissing, true);
});
