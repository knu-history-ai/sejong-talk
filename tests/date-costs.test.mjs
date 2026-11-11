import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../evals/sejong/date-eval/core.mjs';
import { bindCost, validateAiCost, interruptedAiCost, humanCost } from '../evals/sejong/date-eval/costs.mjs';

const plan = { id: 'plan', criteriaHash: 'criteria' }, run = { records: [] };
const start = { planId: plan.id, criteriaHash: plan.criteriaHash, runHash: hash(run),
  judgeConfig: { model: 'fixture', options: { temperature: 0 }, think: false } };
const entry = (state, cost = {}) => ({ request: { ...start.judgeConfig }, runHash: hash(run),
  planId: plan.id, startHash: hash(start), state,
  ...(state === 'completed' ? { result: cost } : cost) });
const valid = () => ({ calls: 2, elapsedMs: 100,
  inputTokens: { sum: 30, partialKnownSum: 30, known: 2, total: 2 },
  outputTokens: { sum: null, partialKnownSum: 5, known: 1, total: 2 } });

test('costs reject negative, nonnumeric, nonfinite, fractional counts and inconsistent coverage', () => {
  for (const value of [-1, '1', NaN, Infinity, null, undefined]) {
    assert.throws(() => bindCost(plan, run, { schemaVersion: 1, planId: plan.id,
      criteriaHash: plan.criteriaHash, runHash: hash(run), type: 'code-preliminary', elapsedMs: value }, 'code'));
    assert.throws(() => validateAiCost({ ...valid(), elapsedMs: value }));
  }
  for (const value of [-1, 1.5, '2', Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateAiCost({ ...valid(), calls: value }));
  for (const change of [{ known: 3 }, { total: 1 }, { sum: 10 }, { partialKnownSum: -1 },
    { known: 0, sum: null }, { partialKnownSum: '30' }]) {
    const cost = valid(); Object.assign(cost.inputTokens, change); assert.throws(() => validateAiCost(cost));
  }
  assert.deepEqual(validateAiCost(valid()), valid());
});

test('interrupted AI retains completed and failed known usage, leaves in-flight totals unknown', () => {
  const entries = [
    { file: '0001.json', entry: entry('completed', { inputTokens: 20, outputTokens: 7, elapsedMs: 100 }) },
    { file: '0002.json', entry: entry('failed', { inputTokens: 3, outputTokens: null, elapsedMs: 50 }) },
    { file: '0003.json', entry: entry('in-flight') },
  ];
  const result = interruptedAiCost(plan, run, start, entries);
  assert.equal(result.execution.status, 'interrupted');
  assert.equal(result.cost.calls, null); assert.equal(result.cost.recordedAttempts, 3);
  assert.equal(result.cost.confirmedTerminalCalls, 2); assert.equal(result.cost.inFlightCalls, 1);
  assert.equal(result.cost.elapsedMs, null); assert.equal(result.cost.partialKnownElapsedMs, 150);
  assert.deepEqual(result.cost.inputTokens, { sum: null, partialKnownSum: 23, known: 2, total: 3 });
  assert.deepEqual(result.cost.outputTokens, { sum: null, partialKnownSum: 7, known: 1, total: 3 });
  assert.equal(Object.keys(result.execution.ledgerHashes).length, 3);
});

test('interruption before first call or after last call does not fabricate wall time or zero tokens', () => {
  const before = interruptedAiCost(plan, run, start, []);
  assert.equal(before.cost.recordedAttempts, 0); assert.equal(before.execution.interrupted, true);
  const after = interruptedAiCost(plan, run, start, [
    { file: '0001.json', entry: entry('completed', { inputTokens: 0, outputTokens: 0, elapsedMs: 0 }) },
  ]);
  assert.equal(after.cost.calls, 1); assert.equal(after.cost.inputTokens.sum, 0);
  assert.equal(after.cost.elapsedMs, null); assert.equal(after.execution.interrupted, true);
});

test('AI ledger provenance, state and damaged costs cannot enter partial totals', () => {
  const good = { file: '0001.json', entry: entry('completed', { inputTokens: 20, outputTokens: 7, elapsedMs: 100 }) };
  for (const value of [true, undefined]) {
    const bad = structuredClone(good); bad.entry.request.think = value;
    assert.throws(() => interruptedAiCost(plan, run, start, [bad]), /thinking/);
  }
  for (const field of ['runHash', 'planId', 'startHash', 'state']) {
    const bad = structuredClone(good); bad.entry[field] = 'wrong';
    assert.throws(() => interruptedAiCost(plan, run, start, [bad]));
  }
  for (const field of ['runHash', 'planId', 'startHash']) {
    const bad = structuredClone(good); delete bad.entry[field];
    assert.throws(() => interruptedAiCost(plan, run, start, [bad]), /해시 누락/);
  }
  for (const field of ['inputTokens', 'outputTokens', 'elapsedMs']) {
    const bad = structuredClone(good); bad.entry.result[field] = -1;
    assert.throws(() => interruptedAiCost(plan, run, start, [bad]));
  }
  assert.throws(() => interruptedAiCost(plan, run, { ...start, runHash: 'wrong' }, [good]));
  assert.throws(() => interruptedAiCost(plan, run, start, [good, good]));
  assert.throws(() => interruptedAiCost(plan, run, start, [{ ...good, file: '0002.json' }]), /번호 누락/);
});

test('human elapsed times are validated and unknown times retain partial sums', () => {
  for (const value of [-1, '20', Infinity, NaN]) assert.throws(() => humanCost([{ elapsedMs: value }]));
  const cost = humanCost([{ elapsedMs: 20 }, { elapsedMs: null }, {}]);
  assert.equal(cost.elapsedMs, null); assert.equal(cost.partialKnownSumMs, 20);
  assert.equal(cost.measured, 1); assert.equal(cost.total, 3);
});
