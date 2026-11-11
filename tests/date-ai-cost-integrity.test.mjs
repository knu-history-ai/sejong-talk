import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hash, makePlan } from '../evals/sejong/date-eval/core.mjs';
import { ollamaGenerate, ruleAnswer, runPlan } from '../evals/sejong/date-eval/runner.mjs';
import { aiGrade, createReviewPackets, finalizeReviews } from '../evals/sejong/date-eval/grading.mjs';
import { bindCost, interruptedAiCost } from '../evals/sejong/date-eval/costs.mjs';
import { validateAiProvenance } from '../evals/sejong/date-eval/ai-provenance.mjs';
import { buildAutomaticReport, validateAutomaticReport } from '../evals/sejong/date-eval/automatic.mjs';
import { main } from '../evals/sejong/date-eval/cli.mjs';

// Synthetic sources, values and mocked fetch only. No dataset/gold file is read;
// generation receives the public case, never the frozen reference values.
const clone = value => structuredClone(value);
const c = { id: 'synthetic', articleId: 'A', groupId: 'A', kind: 'event', type: 'known-day',
  sourceText: '기사 표제 날짜: 2000년 3월 20일\n본문: 2000년 3월 10일 공사 시작.',
  question: '공사 시작 날짜는?', targets: [{ id: 'start', label: '공사 시작' }] };
const dataset = { split: 'pilot', cases: [c] };
const gold = { datasetHash: hash(dataset), version: 'synthetic-v1', criteriaVersion: 'synthetic-v1',
  reviewStatus: 'draft', reviewedBy: [], rubric: {}, cases: [{ id: c.id, events: [{ id: 'start',
    expected: { year: 2000, month: 3, day: 10, calendar: 'lunar' }, required: ['month', 'day'],
    allowedOmissions: ['year', 'calendar'], requiresUnknownDay: false,
    eligibility: { unsupportedDay: false, missingKnownDay: true, headerConfusion: true },
    evidence: [{ quote: c.sourceText, start: 0, end: c.sourceText.length }],
  }] }] };
const identity = { name: 'synthetic-generator', digest: 'synthetic-generator-bytes', details: {} };
const completed = (input = 17, output = 9, answer = '{}') => ({ status: 200,
  raw: JSON.stringify({ done: true, done_reason: 'stop', response: answer, prompt_eval_count: input, eval_count: output }) });
const failed = (input = 17, output = 9) => ({ status: 503,
  raw: JSON.stringify({ error: 'HTTP 503', prompt_eval_count: input, eval_count: output }) });
const costError = /tokens|토큰|비용|cost|elapsedMs|transport raw|whole HTTP/;

async function generation({ fail = false } = {}) {
  const plan = makePlan(dataset, gold, { model: identity.name, modelIdentity: identity, generationAuditVersion: 1,
    options: {}, think: false, timeoutMs: 1000, retries: 0, repeats: 1, seed: 62, runOrder: 'fixed', warmup: false,
    methods: [{ id: 'prompt-baseline', version: 'synthetic' }] });
  const ledger = [];
  const run = await runPlan(plan, { environment: { synthetic: true }, generate: async (request, _config, context) => {
    assert.ok(!request.prompt.includes('allowedOmissions'));
    const began = performance.now();
    await delay(2);
    const row = { schemaVersion: 1, planId: plan.id, callId: ledger.length + 1, request: clone(request), context: clone(context) };
    if (fail) {
      const error = Object.assign(new Error('synthetic generation failure'), { raw: 'partial',
        type: 'call-failure', inputTokens: null, outputTokens: null, elapsedMs: performance.now() - began });
      ledger.push({ ...row, state: 'failed', error: error.message, raw: error.raw, type: error.type,
        inputTokens: null, outputTokens: null, elapsedMs: error.elapsedMs });
      throw error;
    }
    const answer = ruleAnswer(c);
    const result = { answer, raw: completed(2, 3, answer).raw, finishReason: 'stop',
      inputTokens: 2, outputTokens: 3, elapsedMs: performance.now() - began };
    ledger.push({ ...row, state: 'completed', result: clone(result) });
    return result;
  } });
  Object.assign(run, { generationLedger: ledger, modelVerification: { before: identity, after: identity } });
  return { plan, run };
}

function mockHttp(t, replies) {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(String(url), /^http:\/\/127\.0\.0\.1:1\/api\/(tags|generate)$/);
    if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [
      { name: 'synthetic-judge:latest', digest: 'synthetic-judge-bytes', details: {} },
    ] }));
    assert.equal(JSON.parse(options.body).model, 'synthetic-judge');
    const supplied = replies[calls++];
    assert.ok(supplied, 'unexpected synthetic HTTP call');
    const reply = typeof supplied === 'function' ? supplied(JSON.parse(JSON.parse(options.body).prompt)) : supplied;
    await delay(2); // Measured transport time is genuinely inside the attempt.
    return new Response(reply.raw, { status: reply.status });
  });
  return () => calls;
}

async function bundle(t, replies = [failed()]) {
  const b = await generation();
  const judgeConfig = { model: 'synthetic-judge', endpoint: 'http://127.0.0.1:1', options: {}, think: false,
    timeoutMs: 1000, retries: replies.length - 1, cancelGraceMs: 0 };
  const start = { schemaVersion: 1, planId: b.plan.id, criteriaHash: b.plan.criteriaHash, runHash: hash(b.run), judgeConfig };
  const entries = [], calls = mockHttp(t, replies);
  const ai = await aiGrade(b.plan, b.run, { judgeConfig, judge: async (input, context) => {
    const request = { model: judgeConfig.model, options: judgeConfig.options, think: false,
      stage: 'judge', prompt: JSON.stringify(input) };
    const row = { file: `${String(entries.length + 1).padStart(4, '0')}.json`, entry: {
      planId: b.plan.id, runHash: hash(b.run), startHash: hash(start), request, state: 'in-flight' } };
    entries.push(row);
    try {
      const result = await ollamaGenerate(request, { ...judgeConfig, signal: context.signal });
      Object.assign(row.entry, { state: 'completed', result: clone(result) });
      return result;
    } catch (error) {
      Object.assign(row.entry, { state: 'failed', error: error.message, raw: error.raw,
        inputTokens: error.inputTokens, outputTokens: error.outputTokens, elapsedMs: error.elapsedMs });
      throw error;
    }
  } });
  assert.equal(calls(), replies.length);
  return { ...b, ai, start, entries };
}

const joinProvenance = b => validateAiProvenance(b.plan, b.run, b.ai, b.start, b.entries);
const partialCost = b => interruptedAiCost(b.plan, b.run, b.start, b.entries);
const report = b => buildAutomaticReport(b.plan, b.run, b.ai);
function aggregate(ai) {
  const attempts = ai.items.flatMap(item => item.attempts);
  ai.evaluationCost.calls = attempts.length;
  for (const field of ['inputTokens', 'outputTokens']) {
    const known = attempts.filter(a => a[field] != null), partialKnownSum = known.reduce((n, a) => n + a[field], 0);
    ai.evaluationCost[field] = { sum: known.length === attempts.length ? partialKnownSum : null,
      partialKnownSum, known: known.length, total: attempts.length };
  }
}
function rejectsArtifact(b, pattern = costError) {
  assert.throws(() => bindCost(b.plan, b.run, b.ai, 'ai'), pattern);
  assert.throws(() => joinProvenance(b), pattern);
  assert.throws(() => report(b), pattern);
}

test('failed whole HTTP JSON known usage cannot become zero/null/missing in any cost or report path', async t => {
  const original = await bundle(t), before = clone(original), validReport = report(original);
  assert.equal(partialCost(original).cost.inputTokens.sum, 17);
  assert.equal(joinProvenance(original).cost.outputTokens.sum, 9);
  validateAutomaticReport(original.plan, original.run, validReport);
  for (const field of ['inputTokens', 'outputTokens']) for (const value of [0, null, undefined]) {
    const bad = clone(original), attempt = bad.ai.items[0].attempts[0];
    attempt[field] = bad.entries[0].entry[field] = value;
    aggregate(bad.ai); // Same-count, self-consistent copies must still fail against raw.
    assert.throws(() => partialCost(bad), /tokens/);
    rejectsArtifact(bad, /tokens/);
    const snapshot = clone(validReport);
    snapshot.inputSnapshots.ai = clone(bad.ai); snapshot.aiHash = hash(bad.ai);
    snapshot.evaluationCosts.ai = clone(bad.ai.evaluationCost);
    assert.throws(() => validateAutomaticReport(bad.plan, bad.run, snapshot), /tokens/);
  }
  assert.deepEqual(original, before);
});

function judgment(input, score = 1) {
  const proof = { answerQuote: { quote: input.rawAnswer, start: 0, end: input.rawAnswer.length },
    sourceQuote: { quote: input.sourceText, start: 0, end: input.sourceText.length },
    observedDate: { year: 2000, month: 3, day: 10, calendar: 'lunar' }, reason: 'Synthetic proof.' };
  return { date: score, evidence: score, reason: 'Synthetic judgment.', proofs: { date: proof, evidence: proof },
    events: [{ id: 'start', date: score, unsupportedDay: null, missingKnownDay: 0, headerConfusion: 0,
      reasons: { date: 'synthetic', missingKnownDay: 'synthetic', headerConfusion: 'synthetic' },
      proofs: { date: proof, missingKnownDay: proof, headerConfusion: proof } }] };
}

test('HTTP 503 complete-looking whole JSON remains failed, keeps usage, and never becomes interpreted scores', async t => {
  for (const completeJudgment of [false, true]) await t.test(`complete judgment ${completeJudgment}`, async child => {
    const b = await bundle(child, [input => ({ status: 503,
      raw: completed(17, 9, completeJudgment ? JSON.stringify(judgment(input)) : '{}').raw })]);
    const before = clone(b), joined = joinProvenance(b), actual = report(b), attempt = b.ai.items[0].attempts[0];
    assert.equal(b.entries[0].entry.state, 'failed'); assert.equal(attempt.error, 'HTTP 503');
    assert.equal(attempt.state, 'grading-failure'); assert.equal(Object.hasOwn(attempt, 'judgmentOutput'), false);
    assert.equal(joined.bindings[0].transportState, 'failed'); assert.equal(joined.bindings[0].gradingState, 'grading-failure');
    assert.equal(actual.ai.metrics.date.scored, 0); assert.equal(actual.ai.metrics.date.failures, 1);
    assert.equal(actual.items[0].ai.date, null); assert.equal(actual.items[0].ai.evidence, null);
    assert.equal(actual.evaluationCosts.ai.inputTokens.sum, 17); assert.equal(partialCost(b).cost.outputTokens.sum, 9);
    assert.deepEqual(actual.methods[0].primary, buildAutomaticReport(b.plan, b.run).methods[0].primary);
    validateAutomaticReport(b.plan, b.run, actual);
    for (const error of ['HTTP 200', 'fabricated rejection']) {
      const forged = clone(b);
      forged.ai.items[0].attempts[0].error = forged.ai.items[0].reason = error;
      assert.throws(() => report(forged), /interpretable.*failure/);
    }
    const returned = clone(b);
    returned.ai.items[0].attempts[0].judgmentOutput = JSON.parse(attempt.rawOutput).response;
    assert.throws(() => report(returned), /interpretable.*failure/);
    assert.deepEqual(b, before);
  });
  await t.test('retry uses only the later returned judgment, with both transport costs', async child => {
    const b = await bundle(child, [input => ({ status: 503, raw: completed(17, 9, JSON.stringify(judgment(input, 0))).raw }),
      input => completed(3, 2, JSON.stringify(judgment(input, 1)))]);
    const actual = report(b);
    assert.equal(joinProvenance(b).bindings.length, 2);
    assert.deepEqual(b.ai.items[0].attempts.map(a => a.state), ['grading-failure', 'preliminary']);
    assert.equal(actual.items[0].ai.date, 1); assert.equal(actual.items[0].ai.evidence, 1);
    assert.equal(actual.ai.metrics.date.scored, 1);
    assert.equal(actual.evaluationCosts.ai.inputTokens.sum, 20); assert.equal(actual.evaluationCosts.ai.outputTokens.sum, 11);
  });
});

test('completed transport, failed retry and independent missing-token totals share raw validation', async t => {
  const b = await bundle(t, [failed(null, 0), completed(3, 2)]);
  assert.equal(joinProvenance(b).bindings.length, 2);
  assert.equal(b.ai.evaluationCost.outputTokens.sum, 2);
  for (const index of [0, 1]) {
    const bad = clone(b), entry = bad.entries[index].entry;
    const cost = entry.state === 'completed' ? entry.result : entry;
    bad.ai.items[0].attempts[index].outputTokens = cost.outputTokens = null;
    aggregate(bad.ai);
    assert.throws(() => partialCost(bad), /tokens/);
    rejectsArtifact(bad, /tokens/);
  }
});

test('missing/invalid wire counts stay null per field while known zero remains confirmed', async t => {
  for (const value of [null, -1, 1.5, '17', true, {}, Number.MAX_SAFE_INTEGER + 1]) {
    await t.test(JSON.stringify(value), async child => {
      const b = await bundle(child, [failed(value, 0), completed(3, 2)]), before = clone(b);
      for (const cost of [partialCost(b).cost, joinProvenance(b).cost, report(b).evaluationCosts.ai]) {
        assert.deepEqual(cost.inputTokens, { sum: null, partialKnownSum: 3, known: 1, total: 2 });
        assert.deepEqual(cost.outputTokens, { sum: 2, partialKnownSum: 2, known: 2, total: 2 });
      }
      const bad = clone(b);
      bad.entries[0].entry.inputTokens = bad.ai.items[0].attempts[0].inputTokens = 0;
      aggregate(bad.ai);
      assert.throws(() => partialCost(bad), /tokens/); rejectsArtifact(bad, /tokens/);
      assert.deepEqual(b, before);
    });
  }
  await t.test('absent wire field is unknown', async child => {
    const b = await bundle(child, [{ status: 503, raw: JSON.stringify({ error: 'HTTP 503', eval_count: 0 }) }]);
    assert.equal(joinProvenance(b).cost.inputTokens.sum, null);
    assert.equal(report(b).evaluationCosts.ai.outputTokens.sum, 0);
  });
  await t.test('missing output usage preserves confirmed input zero', async child => {
    const b = await bundle(child, [failed(0, null), completed(2, 3)]);
    assert.deepEqual(joinProvenance(b).cost.inputTokens, { sum: 2, partialKnownSum: 2, known: 2, total: 2 });
    assert.deepEqual(report(b).evaluationCosts.ai.outputTokens, { sum: null, partialKnownSum: 3, known: 1, total: 2 });
    assert.equal(partialCost(b).cost.outputTokens.sum, null);
  });
  await t.test('whole raw known zeros are complete usage', async child => {
    const b = await bundle(child, [failed(0, 0), completed(0, 0)]);
    assert.equal(joinProvenance(b).cost.inputTokens.sum, 0);
    assert.equal(report(b).evaluationCosts.ai.outputTokens.known, 2);
  });
});

test('fragments, fenced/concatenated JSON, nonobjects and missing raw cannot manufacture known usage', async t => {
  const raw = failed().raw;
  for (const invalid of [raw.slice(0, -1), raw + ' trailing', raw + '\n' + raw,
    '```json\n' + raw + '\n```', 'null', 'false', '[]', '"text"', '']) {
    await t.test(JSON.stringify(invalid), async child => {
      const b = await bundle(child, [{ status: 503, raw: invalid }]);
      assert.equal(partialCost(b).cost.inputTokens.sum, null);
      assert.equal(joinProvenance(b).cost.outputTokens.sum, null);
      assert.equal(report(b).evaluationCosts.ai.inputTokens.partialKnownSum, 0);
      for (const field of ['inputTokens', 'outputTokens']) {
        const bad = clone(b);
        bad.entries[0].entry[field] = bad.ai.items[0].attempts[0][field] = 0;
        aggregate(bad.ai);
        assert.throws(() => partialCost(bad), /tokens/); rejectsArtifact(bad, /tokens/);
      }
    });
  }
  await t.test('new ledger cannot fall back to cost-only compatibility', async child => {
    const b = await bundle(child), bad = clone(b);
    delete bad.entries[0].entry.raw; delete bad.entries[0].entry.request.stage;
    delete bad.start.judgeConfig.endpoint;
    bad.entries[0].entry.startHash = hash(bad.start);
    assert.throws(() => partialCost(bad), /tokens/);
  });
  await t.test('modern interrupted start requires its complete plan/criteria envelope', async child => {
    const b = await bundle(child);
    for (const field of ['planId', 'criteriaHash', 'schemaVersion']) {
      const bad = clone(b); delete bad.start[field];
      bad.entries[0].entry.startHash = hash(bad.start);
      assert.throws(() => partialCost(bad), /시작 기록/);
    }
  });
  for (const state of ['completed', 'failed']) await t.test(`legacy ${state} still checks supplied whole raw`, async child => {
    const b = await bundle(child, [state === 'completed' ? completed() : failed()]);
    delete b.start.schemaVersion; delete b.start.judgeConfig.endpoint;
    delete b.entries[0].entry.request.stage; b.entries[0].entry.startHash = hash(b.start);
    assert.equal(partialCost(b).cost.inputTokens.sum, 17);
    const cost = state === 'completed' ? b.entries[0].entry.result : b.entries[0].entry;
    cost.inputTokens = 0;
    assert.throws(() => partialCost(b), /tokens/);
  });
});

test('in-flight attempts retain unknown totals and reject terminal usage/time/output', async t => {
  const b = await bundle(t), before = clone(b);
  b.entries.push({ file: '0002.json', entry: { ...clone(b.entries[0].entry), state: 'in-flight' } });
  for (const field of ['raw', 'error', 'elapsedMs', 'inputTokens', 'outputTokens']) delete b.entries[1].entry[field];
  const result = validateAiProvenance(b.plan, b.run, null, b.start, b.entries);
  assert.equal(result.cost.calls, null); assert.equal(result.cost.elapsedMs, null);
  assert.equal(result.cost.partialKnownElapsedMs, b.entries[0].entry.elapsedMs);
  assert.deepEqual(result.cost.inputTokens, { sum: null, partialKnownSum: 17, known: 1, total: 2 });
  for (const [field, value] of [['inputTokens', 0], ['outputTokens', 9], ['elapsedMs', 0], ['raw', failed().raw], ['result', {}]]) {
    const bad = clone(b); bad.entries[1].entry[field] = value;
    assert.throws(() => partialCost(bad), /in-flight/);
  }
  assert.deepEqual(b.ai, before.ai); assert.deepEqual(b.run, before.run);
});

test('time hierarchy is transport <= attempt and sum of serial attempts <= AI total, never zero over positive work', async t => {
  const b = await bundle(t, [failed(), completed()]), before = clone(b);
  joinProvenance(b); report(b);
  const attempts = b.ai.items[0].attempts, sum = attempts.reduce((n, a) => n + a.elapsedMs, 0);
  assert.ok(attempts.every(a => a.elapsedMs > 0));
  for (const time of [0, Math.max(...attempts.map(a => a.elapsedMs)), sum - 0.01]) {
    const bad = clone(b); bad.ai.evaluationCost.elapsedMs = time;
    rejectsArtifact(bad, /AI total\/attempts.*elapsedMs/);
  }
  for (const index of [0, 1]) {
    const bad = clone(b), entry = bad.entries[index].entry;
    const cost = entry.state === 'completed' ? entry.result : entry;
    cost.elapsedMs = bad.ai.items[0].attempts[index].elapsedMs + 1;
    assert.throws(() => joinProvenance(bad), /AI attempt\/transport.*elapsedMs/);
  }
  assert.deepEqual(b, before);
});

test('completed ledger needs whole successful raw; typed costs and known counts cannot hide behind legacy paths', async t => {
  const b = await bundle(t, [completed()]);
  for (const raw of [null, '{}', '[]', 'malformed', completed().raw + ' trailing']) {
    const bad = clone(b); bad.entries[0].entry.result.raw = raw;
    assert.throws(() => partialCost(bad), /whole HTTP/);
  }
  for (const value of [-1, '17', true, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = clone(b);
    bad.entries[0].entry.result.inputTokens = bad.ai.items[0].attempts[0].inputTokens = value;
    assert.throws(() => partialCost(bad)); rejectsArtifact(bad);
  }
  for (const value of [-1, '1', Infinity, NaN]) {
    const bad = clone(b); bad.ai.items[0].attempts[0].elapsedMs = bad.entries[0].entry.result.elapsedMs = value;
    assert.throws(() => partialCost(bad)); rejectsArtifact(bad);
  }
  const direct = clone(b);
  direct.ai.items[0].attempts[0].rawOutput = direct.ai.items[0].attempts[0].judgmentOutput;
  rejectsArtifact(direct, /tokens/); // A modern CLI artifact cannot claim legacy direct-output costs.
});

test('legacy cost-only summaries/direct callbacks remain distinct from actual artifact attempt validation', async () => {
  const b = await generation();
  const ai = await aiGrade(b.plan, b.run, { judge: () => ({ answer: {}, inputTokens: 3, outputTokens: 0 }) });
  bindCost(b.plan, b.run, ai, 'ai'); buildAutomaticReport(b.plan, b.run, ai);
  const summary = { schemaVersion: 1, planId: b.plan.id, criteriaHash: b.plan.criteriaHash,
    runHash: hash(b.run), type: 'ai-preliminary', evaluationCost: clone(ai.evaluationCost) };
  bindCost(b.plan, b.run, summary, 'ai');
  for (const items of [[], null, [{}]]) {
    assert.throws(() => bindCost(b.plan, b.run, { ...summary, items }, 'ai'));
  }
  const missing = clone(ai); delete missing.items;
  assert.throws(() => bindCost(b.plan, b.run, missing, 'ai'), /missing items/);
  const bad = clone(ai); bad.evaluationCost.elapsedMs = 0;
  assert.throws(() => bindCost(b.plan, b.run, bad, 'ai'), /AI total\/attempts/);
});

test('zero AI wall time is valid when generation failures genuinely cause zero AI attempts', async () => {
  const b = await generation({ fail: true });
  const judgeConfig = { model: 'synthetic-judge', options: {}, think: false, timeoutMs: 1000, retries: 0, cancelGraceMs: 0 };
  const ai = await aiGrade(b.plan, b.run, { judgeConfig, judge: () => assert.fail('must not call judge') });
  ai.evaluationCost.elapsedMs = 0;
  const start = { schemaVersion: 1, planId: b.plan.id, criteriaHash: b.plan.criteriaHash, runHash: hash(b.run), judgeConfig };
  assert.equal(validateAiProvenance(b.plan, b.run, ai, start, []).cost.calls, 0);
  assert.equal(buildAutomaticReport(b.plan, b.run, ai).evaluationCosts.ai.inputTokens.sum, 0);
});

async function saveBundle(t, b, { ai = b.ai, final = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'date-ai-cost-integrity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [file, value] of [['plan.json', b.plan], ['run.json', b.run], ['ai-start.json', b.start], ['ai.json', ai]]) {
    if (value != null) await writeFile(join(dir, file), JSON.stringify(value));
  }
  await mkdir(join(dir, 'ai-calls'));
  for (const row of b.entries ?? []) await writeFile(join(dir, 'ai-calls', row.file), JSON.stringify(row.entry));
  if (final) {
    const packets = createReviewPackets(b.plan, b.run);
    const reviews = packets.packets.flatMap(packet => ['synthetic-A', 'synthetic-B'].map(reviewerId => ({
      packetId: packet.id, packetHash: packet.hash, reviewerId, independent: true, blind: true,
      date: 1, evidence: 1, reason: 'Synthetic review, not real human validation.',
      events: packet.input.gold.events.map(e => ({ id: e.id, date: 1, unsupportedDay: null, missingKnownDay: 0, headerConfusion: 0,
        reasons: { date: 'synthetic', missingKnownDay: 'synthetic', headerConfusion: 'synthetic' } })),
    })));
    await writeFile(join(dir, 'final.json'), JSON.stringify(finalizeReviews(b.plan, b.run, packets, reviews)));
  }
  return dir;
}

test('actual CLI ai and automatic-report accept known failed costs; legacy report and all report paths reject forged copies before output', async t => {
  const b = await generation(), dir = await mkdtemp(join(tmpdir(), 'date-ai-cost-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'plan.json'), JSON.stringify(b.plan));
  await writeFile(join(dir, 'run.json'), JSON.stringify(b.run));
  const calls = mockHttp(t, [{ status: 503, raw: completed().raw }]);
  await main(['ai', '--dir', dir, '--model', 'synthetic-judge', '--endpoint', 'http://127.0.0.1:1', '--timeout', '1000']);
  const read = async file => JSON.parse(await readFile(join(dir, file), 'utf8'));
  Object.assign(b, { ai: await read('ai.json'), start: await read('ai-start.json'),
    entries: [{ file: '0001.json', entry: await read('ai-calls/0001.json') }] });
  assert.equal(calls(), 1); joinProvenance(b);
  assert.equal(b.entries[0].entry.state, 'failed'); assert.equal(b.ai.items[0].attempts[0].state, 'grading-failure');
  assert.equal(b.ai.items[0].date, null); assert.equal(b.ai.items[0].evidence, null);
  await main(['automatic-report', '--dir', dir]);
  const costs = await read('automatic-evaluation-cost.json');
  assert.equal(costs.ai.inputTokens.sum, 17); assert.equal(costs.ai.outputTokens.sum, 9);
  assert.equal(costs.aiProvenance.independentExecutionProof, false);
  const legacyDir = await saveBundle(t, b, { final: true });
  await main(['report', '--dir', legacyDir]);
  const legacyCost = JSON.parse(await readFile(join(legacyDir, 'evaluation-cost.json'), 'utf8'));
  assert.deepEqual(legacyCost.ai, b.ai.evaluationCost);
  const before = clone(b);
  for (const command of ['automatic-report', 'report']) for (const mutation of ['zero-tokens', 'null-tokens', 'zero-time']) {
    const bad = clone(b);
    if (mutation === 'zero-time') bad.ai.evaluationCost.elapsedMs = 0;
    else {
      for (const field of ['inputTokens', 'outputTokens']) {
        bad.entries[0].entry[field] = bad.ai.items[0].attempts[0][field] = mutation === 'zero-tokens' ? 0 : null;
      }
      aggregate(bad.ai);
    }
    const badDir = await saveBundle(t, bad, { final: command === 'report' });
    await assert.rejects(main([command, '--dir', badDir]), costError);
    for (const file of command === 'report' ? ['report.json', 'comparison.json', 'evaluation-cost.json']
      : ['automatic-report.json', 'automatic-comparison.json', 'automatic-evaluation-cost.json']) {
      await assert.rejects(readFile(join(badDir, file)), { code: 'ENOENT' });
    }
  }
  const interrupted = clone(b); interrupted.entries[0].entry.inputTokens = 0;
  const partialDir = await saveBundle(t, interrupted, { ai: null });
  await assert.rejects(main(['automatic-report', '--dir', partialDir]), /tokens/);
  await assert.rejects(readFile(join(partialDir, 'automatic-report.json')), { code: 'ENOENT' });
  assert.equal(calls(), 1); assert.deepEqual(b, before);
  assert.deepEqual(await read('run.json'), b.run);
  assert.deepEqual(await read('ai-calls/0001.json'), b.entries[0].entry);
});
