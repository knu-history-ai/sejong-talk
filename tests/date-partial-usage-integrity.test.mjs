import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, makePlan, validateRecordedInputs } from '../evals/sejong/date-eval/core.mjs';
import { ollamaGenerate, ruleAnswer, runPlan } from '../evals/sejong/date-eval/runner.mjs';
import { buildAutomaticReport } from '../evals/sejong/date-eval/automatic.mjs';

// Entirely synthetic inputs and mocked fetch: no historical data, files, sockets,
// actual models, or paid calls are needed to verify token provenance and totals.
const c = { id: 'SYN01', articleId: 'synthetic-article', groupId: 'synthetic-group', kind: 'event', category: 'month',
  sourceText: '기사 표제 날짜: 세종 10년(1428년) 3월 7일\n본문: 이달에 공사를 착공하였다.',
  question: '공사를 착공한 시점은 언제인가?', targets: [{ id: 'start', label: '착공' }] };
const quote = '이달에 공사를 착공하였다.', start = c.sourceText.indexOf(quote);
const dataset = { split: 'pilot', cases: [c] };
const gold = { datasetHash: hash(dataset), criteriaVersion: 'synthetic-only-v1', version: 'synthetic',
  rubric: {}, reviewStatus: 'draft', cases: [{ id: c.id, events: [{ id: 'start',
    expected: { year: 1428, month: 3, day: null, calendar: 'lunar' },
    required: ['year', 'month', 'day', 'calendar'], requiresUnknownDay: true,
    eligibility: { unsupportedDay: true, missingKnownDay: false, headerConfusion: true },
    evidence: [{ quote, start, end: start + quote.length }] }] }] };
const identity = { name: 'synthetic', digest: 'synthetic-fixed-content', details: {} };
const partialRaw = '{"done":false,"prompt_eval_count":17,"eval_count":9';
const failed = (input = 17, output = 9) => ({ status: 503, raw: JSON.stringify({ error: 'synthetic failure',
  prompt_eval_count: input, eval_count: output }) });
const completed = (input = 3, output = 2) => ({ status: 200, raw: JSON.stringify({ done: true, done_reason: 'stop',
  response: ruleAnswer(c), prompt_eval_count: input, eval_count: output }) });
const costError = /토큰|tokens|미확인/;

async function fixture(t, replies, { strict = true } = {}) {
  const plan = makePlan(dataset, gold, { model: identity.name, modelIdentity: identity, options: {}, timeoutMs: 5000,
    retries: replies.length - 1, repeats: 1, seed: 62, warmup: false, runOrder: 'seeded',
    ...(strict ? { generationAuditVersion: 1 } : {}), methods: [{ id: 'prompt-baseline', version: 'synthetic' }] });
  const ledger = [];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const reply = replies[calls++];
    assert.ok(reply, 'unexpected synthetic call');
    return new Response(reply.raw, { status: reply.status });
  });
  const run = await runPlan(plan, { generate: async (request, config, context) => {
    const entry = { schemaVersion: 1, planId: plan.id, callId: ledger.length + 1,
      request: structuredClone(request), context };
    try {
      const result = await ollamaGenerate(request, config);
      Object.assign(entry, { state: 'completed', result: structuredClone(result) });
      return result;
    } catch (error) {
      Object.assign(entry, { state: 'failed', raw: error.raw, error: error.message, type: error.type,
        inputTokens: error.inputTokens, outputTokens: error.outputTokens, elapsedMs: error.elapsedMs });
      throw error;
    } finally { ledger.push(entry); }
  } });
  Object.assign(run, { generationLedger: ledger, modelVerification: { before: identity, after: identity } });
  assert.equal(calls, replies.length);
  validateRecordedInputs(plan, run);
  return { plan, run, originalHash: hash(run) };
}

const report = f => buildAutomaticReport(f.plan, f.run).generation.physicalBatch;
const assertPreserved = f => assert.equal(hash(f.run), f.originalHash);

test('strict unknown retries keep null totals and only confirmed attempt partial sums', async t => {
  const f = await fixture(t, [failed(), { status: 503, raw: partialRaw }]);
  const costs = report(f);
  assert.equal(f.run.records[0].state, 'failed');
  assert.equal(costs.calls, 2);
  for (const [field, known] of [['inputTokens', 17], ['outputTokens', 9]]) {
    assert.equal(f.run.records[0][field], null);
    assert.equal(costs[field].sum, null);
    assert.equal(costs[field].partialKnownSum, known);
    assert.equal(costs[field].attemptKnownSum, known);
    assert.equal(costs[field].attemptCoverage.value, 0.5);
    assert.notEqual(costs[field].label, 'complete');
    for (const value of [0, known, known + 100, undefined]) {
      const bad = structuredClone(f.run);
      bad.records[0][field] = value;
      assert.throws(() => buildAutomaticReport(f.plan, bad), costError);
    }
    const missing = structuredClone(f.run);
    delete missing.records[0][field];
    assert.throws(() => buildAutomaticReport(f.plan, missing), costError);
  }
  assertPreserved(f);
});

test('strict uncertainty is per token field and does not erase a fully known output total', async t => {
  const reply = { status: 503, raw: JSON.stringify({ error: 'synthetic failure', eval_count: 9 }) };
  const f = await fixture(t, [reply, completed(3, 2)]), costs = report(f);
  assert.equal(costs.inputTokens.sum, null);
  assert.equal(costs.inputTokens.partialKnownSum, 3);
  assert.equal(costs.outputTokens.sum, 11);
  const bad = structuredClone(f.run);
  bad.records[0].inputTokens = 3;
  assert.throws(() => buildAutomaticReport(f.plan, bad), costError);
  assertPreserved(f);
});

test('strict missing output usage preserves known input tokens and the output partial sum', async t => {
  const reply = { status: 503, raw: JSON.stringify({ error: 'synthetic failure', prompt_eval_count: 17 }) };
  const f = await fixture(t, [reply, completed(3, 2)]), costs = report(f);
  assert.equal(costs.inputTokens.sum, 20);
  assert.equal(costs.outputTokens.sum, null);
  assert.equal(costs.outputTokens.partialKnownSum, 2);
  const bad = structuredClone(f.run);
  bad.records[0].outputTokens = 2;
  assert.throws(() => buildAutomaticReport(f.plan, bad), costError);
  assertPreserved(f);
});

test('strict recovered retries retain unknown failed usage without hiding it behind the success cost', async t => {
  const f = await fixture(t, [{ status: 503, raw: partialRaw }, completed(3, 2)]), costs = report(f);
  assert.equal(f.run.records[0].state, 'completed');
  assert.equal(f.run.records[0].attempts[0].state, 'failed');
  assert.equal(f.run.records[0].attempts[0].raw, partialRaw);
  assert.equal(costs.calls, 2);
  for (const [field, known] of [['inputTokens', 3], ['outputTokens', 2]]) {
    assert.equal(costs[field].sum, null);
    assert.equal(costs[field].partialKnownSum, known);
    const bad = structuredClone(f.run);
    bad.records[0][field] = known;
    assert.throws(() => buildAutomaticReport(f.plan, bad), costError);
  }
  assertPreserved(f);
});

test('strict fully known retry totals remain exact, counted once and never mistaken for unknown zeroes', async t => {
  for (const zero of [false, true]) await t.test(`known zero ${zero}`, async child => {
    const f = await fixture(child, zero ? [failed(0, 0), completed(0, 0)] : [failed(), completed()]);
    const costs = report(f), expected = zero ? [0, 0] : [20, 11];
    assert.equal(costs.calls, 2);
    for (const [index, field] of ['inputTokens', 'outputTokens'].entries()) {
      assert.equal(costs[field].sum, expected[index]);
      assert.equal(costs[field].partialKnownSum, expected[index]);
      assert.equal(costs[field].attemptKnownSum, expected[index]);
      assert.equal(costs[field].attemptCoverage.value, 1);
      assert.equal(costs[field].label, 'complete');
      const bad = structuredClone(f.run);
      bad.records[0][field] = expected[index] + 1;
      assert.throws(() => buildAutomaticReport(f.plan, bad), costError);
    }
    assertPreserved(f);
  });
});

test('strict unparseable and nonobject failed raw cannot manufacture known zero token counts', async t => {
  const raws = [partialRaw, '', 'null', 'false', '[]', '"not an object"', `${failed().raw} trailing`];
  for (const [index, raw] of raws.entries()) await t.test(`untrusted raw ${index}`, async child => {
    const f = await fixture(child, [{ status: 503, raw }]), costs = report(f);
    assert.equal(costs.inputTokens.sum, null);
    assert.equal(costs.outputTokens.sum, null);
    assert.equal(costs.inputTokens.partialKnownSum, 0);
    for (const field of ['inputTokens', 'outputTokens']) {
      const bad = structuredClone(f.run);
      bad.records[0].attempts[0][field] = bad.generationLedger[0][field] = 0;
      // Keep the record total null so this specifically tests raw→attempt/ledger
      // validation in core, independently of automatic's record-total guard.
      assert.throws(() => validateRecordedInputs(f.plan, bad), costError);
      assert.throws(() => buildAutomaticReport(f.plan, bad), costError);
    }
    assertPreserved(f);
  });
});

test('legacy absent record totals still fall back to known attempt partials without guessing missing calls', async t => {
  const f = await fixture(t, [failed(), { status: 503, raw: partialRaw }], { strict: false });
  for (const missing of ['null', 'undefined', 'deleted', 'missing-attempt']) {
    const legacy = structuredClone(f.run);
    for (const field of ['inputTokens', 'outputTokens']) {
      if (missing === 'deleted') delete legacy.records[0][field];
      else legacy.records[0][field] = missing === 'undefined' ? undefined : null;
    }
    if (missing === 'missing-attempt') legacy.records[0].attempts.pop();
    const costs = buildAutomaticReport(f.plan, legacy).generation.physicalBatch;
    assert.equal(costs.calls, 2);
    assert.equal(costs.inputTokens.sum, null);
    assert.equal(costs.inputTokens.partialKnownSum, 17);
    assert.equal(costs.outputTokens.sum, null);
    assert.equal(costs.outputTokens.partialKnownSum, 9);
    assert.equal(costs.inputTokens.missingAttemptRecords, missing === 'missing-attempt' ? 1 : 0);
  }
  assertPreserved(f);
});

test('legacy supplied totals with partial attempt history retain the existing compatibility contract', async t => {
  const f = await fixture(t, [failed(), { status: 503, raw: partialRaw }], { strict: false });
  const legacy = structuredClone(f.run);
  legacy.records[0].inputTokens = 22;
  legacy.records[0].outputTokens = 13;
  const costs = buildAutomaticReport(f.plan, legacy).generation.physicalBatch;
  assert.equal(costs.inputTokens.sum, 22);
  assert.equal(costs.outputTokens.sum, 13);
  assert.equal(costs.inputTokens.attemptKnownSum, 17);
  assert.equal(costs.outputTokens.attemptKnownSum, 9);
  assertPreserved(f);
});
