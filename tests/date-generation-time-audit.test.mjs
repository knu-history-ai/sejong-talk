import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, makePlan, validateGenerationProgress, validateGenerationTimes } from '../evals/sejong/date-eval/core.mjs';
import { buildAutomaticReport } from '../evals/sejong/date-eval/automatic.mjs';
import { main } from '../evals/sejong/date-eval/cli.mjs';
import { METHOD_VERSION, ruleAnswer, runPlan } from '../evals/sejong/date-eval/runner.mjs';
import { resolveRunState } from '../evals/sejong/date-eval/state.mjs';

// Synthetic sources and measured offline transport only. No private results,
// model server, paid API, or edited generation implementation is used here.
const METHODS = ['rule-baseline', 'prompt-baseline', 'evidence-first', 'render-only', 'evidence-validated'];
const identity = { name: 'synthetic-time', digest: 'synthetic-time-fixed', details: { quantization_level: 'Q4_K_M' } };
const FRESH_SCOPE = 'whole run; not allocated to methods';
const RESUMED_SCOPE = 'current resumed segment only; earlier batch wall time unavailable';
const total = rows => rows.reduce((sum, value) => sum + value, 0);
const clone = value => structuredClone(value);
function planFor({ strict = true, methods = ['prompt-baseline'], retries = 0, warmup = false } = {}) {
  const sourceText = '기사 표제 날짜: 2000년 3월 20일\n본문: 2000년 3월 10일에 공사를 시작하였다.';
  const dataset = { version: 'synthetic-time-v1', split: 'pilot', cases: [{ id: 'start',
    articleId: 'A', groupId: 'A', kind: 'event', type: 'known-day', sourceText,
    question: '공사 시작 날짜는?', targets: [{ id: 'start', label: '공사 시작' }] }] };
  const gold = { version: 'synthetic-time-values-v1', criteriaVersion: 'synthetic-time-rubric-v1',
    datasetHash: hash(dataset), reviewStatus: 'draft', reviewedBy: [], rubric: {}, cases: [{ id: 'start', events: [{
      id: 'start', expected: { year: 2000, month: 3, day: 10, calendar: 'lunar' },
      required: ['month', 'day'], allowedOmissions: ['year', 'calendar'], requiresUnknownDay: false,
      eligibility: { unsupportedDay: false, missingKnownDay: true, headerConfusion: true },
      evidence: [{ quote: sourceText, start: 0, end: sourceText.length }],
    }] }] };
  return makePlan(dataset, gold, { model: identity.name, modelIdentity: identity,
    ...(strict ? { generationAuditVersion: 1 } : {}),
    options: { temperature: 0 }, think: false, timeoutMs: 1000, retries, repeats: 1,
    seed: 62, runOrder: 'fixed', warmup, methods: methods.map(id => ({ id, version: METHOD_VERSION })) });
}
async function execute(plan, { mode = 'completed', existingRecords = [], existingWarmup,
  existingLedger = [], existingWarmupHistoryComplete } = {}) {
  const ledger = clone(existingLedger);
  const run = await runPlan(plan, { existingRecords, existingWarmup, existingWarmupHistoryComplete,
    environment: { synthetic: true }, generate: async (request, _config, context) => {
      const began = performance.now(), startedAt = new Date().toISOString();
      await new Promise(resolve => setTimeout(resolve, 2));
      const failed = context.stage !== 'warmup' && (mode === 'failed' || mode === 'retry' && context.attempt === 0);
      const c = plan.dataset.cases.find(c => c.id === context.caseId);
      const answer = context.stage === 'warmup' ? 'ready' : ruleAnswer(c);
      const raw = JSON.stringify({ done: !failed, done_reason: mode === 'length' ? 'length' : 'stop',
        response: answer, ...(failed ? { error: 'synthetic transport failure' } : {}),
        prompt_eval_count: 17, eval_count: 9 });
      const usage = { raw, inputTokens: 17, outputTokens: 9, elapsedMs: performance.now() - began };
      const entry = { schemaVersion: 1, planId: plan.id, callId: ledger.length + 1,
        context: clone(context), request: clone(request), startedAt, endedAt: new Date().toISOString() };
      if (failed) {
        const error = Object.assign(new Error('synthetic transport failure'), { ...usage, type: 'call-failure' });
        ledger.push({ ...entry, state: 'failed', ...usage, error: error.message, type: error.type });
        throw error;
      }
      const result = { ...usage, answer, finishReason: mode === 'length' ? 'length' : 'stop' };
      ledger.push({ ...entry, state: 'completed', result: clone(result) });
      return result;
    } });
  run.generationLedger = ledger;
  run.modelVerification = { before: clone(identity), after: clone(identity) };
  return run;
}
async function fixture(options = {}) {
  const plan = planFor(options), run = await execute(plan, options);
  return { plan, run };
}
function entryFor(run, record, attempt) {
  return run.generationLedger.find(e => e.context.recordId === record.id
    && e.context.stage === attempt.stage && e.context.attempt === attempt.attempt);
}
function transportFor(run, record, attempt) {
  const entry = entryFor(run, record, attempt);
  return entry.state === 'completed' ? entry.result : entry;
}
const method = (report, id) => report.methods.find(m => m.id === id).generation;
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const write = async (path, value) => writeFile(path, JSON.stringify(value));
async function snapshot(dir) {
  const files = {};
  async function walk(path, relative = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = join(relative, entry.name), file = join(path, entry.name);
      if (entry.isDirectory()) await walk(file, name);
      else files[name] = (await readFile(file)).toString('base64');
    }
  }
  await walk(dir);
  return files;
}

async function checkpointFixture() {
  const root = await mkdtemp(join(tmpdir(), 'date time resume 한글 '));
  const dir = join(root, 'private'), out = join(root, 'operator');
  const { dataset, gold } = planFor({ methods: ['prompt-baseline', 'evidence-first'], warmup: true });
  for (const [name, value] of Object.entries({ dataset, gold, identity })) await write(join(root, name + '.json'), value);
  await main(['prepare', '--dir', dir, '--dataset', join(root, 'dataset.json'), '--gold', join(root, 'gold.json'),
    '--model', identity.name, '--model-identity', join(root, 'identity.json'),
    '--methods', 'prompt-baseline,evidence-first', '--warmup']);
  await main(['export-operator', '--dir', dir, '--out', out]);
  const requests = { tags: 0, generation: 0 };
  const fetch = async (url, options) => {
    if (String(url).endsWith('/api/tags')) {
      requests.tags++; return Response.json({ models: [identity] });
    }
    assert.ok(String(url).endsWith('/api/generate'));
    requests.generation++;
    const request = JSON.parse(options.body), c = dataset.cases.find(c => request.prompt.includes(c.question));
    await new Promise(resolve => setTimeout(resolve, 2));
    return Response.json({ done: true, done_reason: 'stop', response: c ? ruleAnswer(c) : 'ready',
      prompt_eval_count: 17, eval_count: 9 });
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  try { await main(['run', '--dir', out]); } finally { globalThis.fetch = previousFetch; }
  const plan = await read(join(dir, 'plan.json')), run = await read(join(out, 'run.json'));
  const first = run.records[0];
  const records = clone([first]), ledger = clone(run.generationLedger.filter(e =>
    e.context.stage === 'warmup' || e.context.recordId === first.id));
  assert.deepEqual(ledger.map(e => e.callId), ledger.map((_, i) => i + 1));
  async function checkpoint(name, mutate = () => {}) {
    const folder = join(root, name), progress = { planId: plan.id, records: clone(records),
      warmupHistoryComplete: true, inFlight: null, environmentHistory: clone(run.environmentHistory) }, calls = clone(ledger);
    mutate(progress, calls);
    await mkdir(join(folder, 'generation-calls'), { recursive: true });
    await mkdir(join(folder, 'environment-segments'));
    await writeFile(join(folder, 'environment-segments/0001.json'), await readFile(join(out, 'environment-segments/0001.json')));
    await writeFile(join(folder, 'plan.json'), await readFile(join(out, 'plan.json')));
    await write(join(folder, 'progress.json'), progress);
    for (const entry of calls) await write(join(folder, 'generation-calls', String(entry.callId).padStart(4, '0') + '.json'), entry);
    return folder;
  }
  return { root, plan, run, records, ledger, requests, fetch, checkpoint };
}

test('shared time validator is pure; partial checkpoints validate known work without invented batch scope/time', async () => {
  const { plan, run } = await fixture({ warmup: true });
  const original = { plan: hash(plan), run: hash(run) };
  assert.equal(validateGenerationTimes(plan, run), run);
  const partial = { records: clone(run.records), generationLedger: clone(run.generationLedger), warmup: clone(run.warmup) };
  const before = hash(partial);
  assert.equal(validateGenerationTimes(plan, partial, { partial: true }), partial);
  validateGenerationProgress(plan, partial.records, partial.generationLedger);
  assert.throws(() => validateGenerationTimes(plan, partial), /batchElapsedMs/);
  assert.equal(hash(partial), before);
  assert.deepEqual({ plan: hash(plan), run: hash(run) }, original);
});

test('legacy partial checkpoints keep absent transport timings readable but reject known record/attempt contradictions', async () => {
  const { plan, run } = await fixture({ strict: false });
  const partial = { records: clone(run.records) };
  for (const attempt of partial.records[0].attempts) delete attempt.elapsedMs;
  validateGenerationTimes(plan, partial, { partial: true });
  validateGenerationProgress(plan, partial.records, []);
  const bad = clone(partial); bad.records[0].attempts[0].elapsedMs = 1; bad.records[0].elapsedMs = 0;
  assert.throws(() => validateGenerationTimes(plan, bad, { partial: true }), /record\/attempt.*smaller/);
  assert.throws(() => validateGenerationProgress(plan, bad.records, []), /record\/attempt.*smaller/);
});

test('resume rejects old zero/contradictory/unmeasured generation times before any tag lookup or additional call, preserving files', async () => {
  const f = await checkpointFixture(), previousFetch = globalThis.fetch;
  const corruptions = [
    ['zero-record', progress => { progress.records[0].elapsedMs = 0; }, /record\/attempt.*smaller/],
    ['zero-attempt', progress => { progress.records[0].attempts[0].elapsedMs = 0; }, /attempt\/transport.*smaller/],
    ['unmeasured-transport', (progress, calls) => {
      const attempt = progress.records[0].attempts[0];
      calls.find(e => e.context.recordId === progress.records[0].id && e.context.stage === attempt.stage
        && e.context.attempt === attempt.attempt).result.elapsedMs = null;
    }, /transport\.elapsedMs.*invalid/],
  ];
  try {
    for (const [name, corrupt, error] of corruptions) {
      const dir = await f.checkpoint(name, corrupt), before = await snapshot(dir);
      let calls = 0;
      globalThis.fetch = async () => { calls++; throw new Error('No fetch is allowed before checkpoint timing validation'); };
      await assert.rejects(main(['run', '--dir', dir]), error);
      assert.equal(calls, 0, 'Neither model tags, warmup, nor generation may run');
      assert.deepEqual(await snapshot(dir), before);
    }
    const dir = await f.checkpoint('valid-resume'), before = await snapshot(dir);
    f.requests.tags = 0; f.requests.generation = 0; globalThis.fetch = f.fetch;
    await main(['run', '--dir', dir]);
    const resumed = await read(join(dir, 'run.json')), after = await snapshot(dir);
    assert.equal(f.requests.tags, 2);
    assert.equal(f.requests.generation, 1 + total(f.run.records.map(r => r.calls)) - f.records[0].calls); // New warmup + the other method only.
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.batchWallScope, RESUMED_SCOPE);
    assert.equal(hash(resumed.records.find(r => r.id === f.records[0].id)), hash(f.records[0]));
    for (const [file, bytes] of Object.entries(before).filter(([file]) => file !== 'progress.json')) assert.equal(after[file], bytes);
    assert.equal(buildAutomaticReport(f.plan, resumed).generation.batchWallComplete, false);
  } finally { globalThis.fetch = previousFetch; }
});

test('strict measured successful five-method/warmup timing is nested, P is counted once, inputs stay unchanged', async () => {
  const { plan, run } = await fixture({ methods: METHODS, warmup: true });
  const original = { plan: hash(plan), run: hash(run) }, report = buildAutomaticReport(plan, run);
  assert.equal(report.generation.physicalBatch.calls, 3);
  assert.equal(report.generation.warmup.calls, 1);
  assert.ok(report.generation.warmup.elapsedMs > 0);
  assert.equal(report.generation.batchWallComplete, true);
  assert.equal(report.generation.batchWallScope, FRESH_SCOPE);
  assert.ok(run.batchElapsedMs >= total(run.records.map(r => r.elapsedMs)) + run.warmup[0].result.elapsedMs);
  assert.ok(method(report, 'render-only').itemElapsedMs >= method(report, 'prompt-baseline').itemElapsedMs);
  for (const r of run.records) for (const a of r.attempts) assert.ok(a.elapsedMs >= transportFor(run, r, a).elapsedMs);
  assert.deepEqual({ plan: hash(plan), run: hash(run) }, original);
});

for (const mode of ['completed', 'failed', 'retry']) {
  test(`strict ${mode}: record zero and below-attempt sums cannot erase measured time`, async () => {
    const { plan, run } = await fixture({ mode, retries: mode === 'completed' ? 0 : 1 });
    const original = hash(run), report = buildAutomaticReport(plan, run), r = run.records[0];
    assert.equal(r.state, mode === 'failed' ? 'failed' : 'completed');
    assert.equal(report.generation.physicalBatch.calls, r.attempts.length);
    if (mode === 'failed') {
      assert.equal(report.methods[0].primary.value, 0);
      assert.equal(report.methods[0].generation.completedLatency.count, 0);
    }
    for (const elapsedMs of [0, total(r.attempts.map(a => a.elapsedMs)) / 2]) {
      const bad = clone(run); bad.records[0].elapsedMs = elapsedMs;
      assert.throws(() => buildAutomaticReport(plan, bad), /record\/attempt.*smaller/);
    }
    assert.equal(hash(run), original);
  });

  test(`strict ${mode}: attempt wrappers cannot undercut original transport, including failed attempts`, async () => {
    const { plan, run } = await fixture({ mode, retries: mode === 'completed' ? 0 : 1 });
    for (let i = 0; i < run.records[0].attempts.length; i++) {
      for (const fraction of [0, 0.5]) {
        const bad = clone(run), record = bad.records[0], attempt = record.attempts[i];
        attempt.elapsedMs = transportFor(bad, record, attempt).elapsedMs * fraction;
        assert.throws(() => buildAutomaticReport(plan, bad), /attempt\/transport.*smaller/);
      }
    }
  });

  test(`strict ${mode}: unmeasured, negative, nonnumeric and nonfinite attempt/transport costs are rejected`, async () => {
    const { plan, run } = await fixture({ mode, retries: mode === 'completed' ? 0 : 1 });
    for (const value of [undefined, null, -1, '2', NaN, Infinity]) for (const target of ['attempt', 'transport']) {
      const bad = clone(run), record = bad.records[0], attempt = record.attempts[0];
      (target === 'attempt' ? attempt : transportFor(bad, record, attempt)).elapsedMs = value;
      assert.throws(() => buildAutomaticReport(plan, bad), /elapsedMs.*invalid/);
    }
  });
}

test('strict retry elapsed includes every failed/successful attempt, not just the maximum or final attempt', async () => {
  const { plan, run } = await fixture({ methods: ['evidence-first'], mode: 'retry', retries: 1 });
  const record = run.records[0], attempts = record.attempts.map(a => a.elapsedMs);
  assert.equal(record.state, 'completed'); assert.equal(record.calls, 4);
  assert.deepEqual(record.attempts.map(a => a.state), ['failed', 'completed', 'failed', 'completed']);
  const report = buildAutomaticReport(plan, run);
  assert.equal(report.generation.physicalBatch.inputTokens.sum, 68);
  assert.equal(report.generation.physicalBatch.outputTokens.sum, 36);
  const bad = clone(run); bad.records[0].elapsedMs = Math.max(...attempts);
  assert.throws(() => buildAutomaticReport(plan, bad), /record\/attempt.*smaller/);
});

test('strict fresh batch must contain measured records plus warmup but not later inspections', async () => {
  const { plan, run } = await fixture({ warmup: true });
  const original = hash(run), measuredRecords = total(run.records.map(r => r.elapsedMs));
  for (const batchElapsedMs of [0, measuredRecords]) {
    const bad = clone(run); bad.batchElapsedMs = batchElapsedMs;
    assert.throws(() => buildAutomaticReport(plan, bad), /fresh batch\/records\+warmup.*smaller/);
  }
  for (const value of [undefined, null, -1, NaN, Infinity, '2']) {
    const bad = clone(run);
    bad.warmup[0].result.elapsedMs = value;
    bad.generationLedger[0].result.elapsedMs = value;
    assert.throws(() => buildAutomaticReport(plan, bad), /warmup.*elapsedMs.*invalid/);
  }
  assert.equal(hash(run), original);
});

test('all measured zeroes are valid, but a positive original transport can never fit inside a zero wrapper', async () => {
  const { plan, run } = await fixture({ warmup: true });
  const zero = clone(run);
  for (const record of zero.records) {
    record.elapsedMs = 0;
    for (const attempt of record.attempts) {
      attempt.elapsedMs = 0; transportFor(zero, record, attempt).elapsedMs = 0;
    }
  }
  zero.warmup[0].result.elapsedMs = 0;
  zero.generationLedger[0].result.elapsedMs = 0;
  zero.batchElapsedMs = 0;
  const report = buildAutomaticReport(plan, zero);
  assert.equal(report.generation.physicalBatch.itemElapsedMs, 0);
  assert.equal(report.generation.warmup.elapsedMs, 0);
  const positive = clone(zero);
  transportFor(positive, positive.records[0], positive.records[0].attempts[0]).elapsedMs = 1e-12;
  assert.throws(() => buildAutomaticReport(plan, positive), /attempt\/transport.*smaller/);
  const positiveRecord = clone(zero);
  positiveRecord.records[0].attempts[0].elapsedMs = 1e-12;
  assert.throws(() => buildAutomaticReport(plan, positiveRecord), /record\/attempt.*smaller/);
});

test('only tiny monotonic floating noise is tolerated; nested timings need not be equal', async () => {
  const { plan, run } = await fixture();
  const rounded = clone(run), record = rounded.records[0], attempt = record.attempts[0];
  transportFor(rounded, record, attempt).elapsedMs = 20;
  attempt.elapsedMs = 20 - 5e-7;
  record.elapsedMs = attempt.elapsedMs - 5e-7;
  rounded.batchElapsedMs = record.elapsedMs - 5e-7;
  buildAutomaticReport(plan, rounded);
  const tooSmall = clone(rounded); tooSmall.records[0].attempts[0].elapsedMs = 20 - 1e-4;
  assert.throws(() => buildAutomaticReport(plan, tooSmall), /attempt\/transport.*smaller/);
  const overhead = clone(run), r = overhead.records[0], a = r.attempts[0];
  transportFor(overhead, r, a).elapsedMs = 2; a.elapsedMs = 4; r.elapsedMs = 8; overhead.batchElapsedMs = 12;
  assert.equal(buildAutomaticReport(plan, overhead).generation.physicalBatch.itemElapsedMs, 8);
});

test('strict complete resume keeps old item/transport time separate from current segment wall time', async () => {
  const { plan, run } = await fixture({ warmup: true });
  const before = hash(run), resumed = await execute(plan, { existingRecords: run.records,
    existingWarmup: run.warmup, existingLedger: run.generationLedger, existingWarmupHistoryComplete: true });
  resumed.batchElapsedMs = 0; // No generation or original item execution in this new segment.
  const report = buildAutomaticReport(plan, resumed);
  assert.equal(resumed.resumed, true);
  assert.equal(report.generation.batchWallComplete, false);
  assert.equal(report.generation.batchWallMs, 0);
  assert.equal(report.generation.batchWallScope, RESUMED_SCOPE);
  assert.equal(report.generation.physicalBatch.itemElapsedMs, run.records[0].elapsedMs);
  assert.equal(report.generation.warmup.elapsedMs, run.warmup[0].result.elapsedMs);
  assert.equal(hash(resumed.generationLedger), hash(run.generationLedger));
  assert.equal(hash(run), before);
  const contradictoryOldRow = clone(resumed); contradictoryOldRow.records[0].elapsedMs = 0;
  assert.throws(() => buildAutomaticReport(plan, contradictoryOldRow), /record\/attempt.*smaller/);
});

test('strict partial resume validates new and historical attempts, without inventing earlier wall time', async () => {
  const { plan, run } = await fixture({ methods: ['prompt-baseline', 'evidence-first'], warmup: true });
  const previous = run.records.filter(r => r.methodId === 'prompt-baseline');
  const ledger = run.generationLedger.filter(e => e.context.stage === 'warmup' || e.context.recordId === previous[0].id);
  const resumed = await execute(plan, { existingRecords: previous, existingWarmup: run.warmup,
    existingLedger: ledger, existingWarmupHistoryComplete: true });
  const report = buildAutomaticReport(plan, resumed);
  assert.equal(report.generation.batchWallComplete, false);
  assert.equal(report.generation.batchWallScope, RESUMED_SCOPE);
  assert.equal(report.generation.batchWallMs, resumed.batchElapsedMs);
  assert.equal(report.generation.warmup.calls, 2);
  assert.equal(report.generation.physicalBatch.calls, 3);
  for (const r of resumed.records) {
    const bad = clone(resumed); bad.records.find(b => b.id === r.id).elapsedMs = 0;
    assert.throws(() => buildAutomaticReport(plan, bad), /record\/attempt.*smaller/);
  }
});

test('strict scopes require a boolean resume flag and the documented fresh/current-segment distinction', async () => {
  const { plan, run } = await fixture();
  for (const resumed of [false, true]) for (const batchWallScope of [undefined, '', 'all earlier segments summed']) {
    const bad = clone(run); Object.assign(bad, { resumed, batchWallScope });
    assert.throws(() => buildAutomaticReport(plan, bad), /batchWallScope/);
  }
  const wrong = clone(run); wrong.resumed = true;
  assert.throws(() => buildAutomaticReport(plan, wrong), /batchWallScope/);
  for (const resumed of [undefined, null, 'true']) {
    const bad = clone(run); bad.resumed = resumed;
    assert.throws(() => buildAutomaticReport(plan, bad), /batch scope|resumed flag/);
  }
});

test('legacy absent transport/attempt timings stay readable, and resumed reports never imply whole-run wall time', async () => {
  const { plan, run } = await fixture({ strict: false });
  delete run.generationLedger;
  for (const record of run.records) for (const attempt of record.attempts) delete attempt.elapsedMs;
  const before = hash(run), report = buildAutomaticReport(plan, run);
  assert.equal(report.generation.physicalBatch.itemElapsedMs, run.records[0].elapsedMs);
  assert.equal(hash(run), before);
  for (const batchWallScope of [undefined, FRESH_SCOPE]) {
    const resumed = clone(run); Object.assign(resumed, { resumed: true, batchElapsedMs: 0, batchWallScope });
    const result = buildAutomaticReport(plan, resumed);
    assert.equal(result.generation.batchWallComplete, false);
    assert.equal(result.generation.batchWallScope, RESUMED_SCOPE);
  }
});

test('legacy own-record elapsed contradictions still fail without retroactively imposing synthetic transport/warmup clocks', async () => {
  const { plan, run } = await fixture({ strict: false, warmup: true });
  delete run.generationLedger;
  const bad = clone(run); bad.records[0].elapsedMs = 0;
  assert.throws(() => buildAutomaticReport(plan, bad), /record\/attempt.*smaller/);
  const zeroBatch = clone(run); zeroBatch.batchElapsedMs = 0;
  assert.throws(() => buildAutomaticReport(plan, zeroBatch), /fresh batch\/records\+warmup.*smaller/);
  const loose = clone(run);
  loose.warmup[0].result.elapsedMs = loose.batchElapsedMs + 100;
  assert.equal(buildAutomaticReport(plan, loose).generation.warmup.elapsedMs, loose.warmup[0].result.elapsedMs);
});

test('unknown executions block scoring; T/V status reinspection adds physical cost only, never original latency/batch', async () => {
  const { plan, run } = await fixture({ methods: ['prompt-baseline', 'render-only', 'evidence-validated'],
    mode: 'length', warmup: true });
  const original = { plan: hash(plan), run: hash(run), ledger: hash(run.generationLedger) };
  assert.throws(() => buildAutomaticReport(plan, run), /unknown/);
  const parent = run.records.find(r => r.methodId === 'prompt-baseline');
  const decision = (record, state) => ({ recordId: record.id, originalRecordHash: hash(record), state,
    reviewerId: 'synthetic-maintainer', reason: 'synthetic execution-status inspection',
    evidence: 'original transport response inspected, not content grading' });
  const completed = resolveRunState(plan, run, [decision(parent, 'completed')]);
  const baseline = buildAutomaticReport(plan, completed), completedHash = hash(completed);
  const failed = resolveRunState(plan, completed, [decision(completed.records.find(r => r.id === parent.id), 'failed')]);
  const failedReport = buildAutomaticReport(plan, failed);
  const extra = total(failed.records.filter(r => r.derivation).map(r => r.postprocessInspections.at(-1).elapsedMs));
  assert.equal(total(completed.records.map(r => r.postprocessInspections?.length ?? 0)), 2);
  assert.equal(total(failed.records.map(r => r.postprocessInspections?.length ?? 0)), 4);
  assert.ok(Math.abs(failedReport.generation.physicalBatch.itemElapsedMs - baseline.generation.physicalBatch.itemElapsedMs - extra) < 1e-6);
  assert.ok(Math.abs(failedReport.generation.physicalBatch.postprocessInspectionElapsedMs
    - baseline.generation.physicalBatch.postprocessInspectionElapsedMs - extra) < 1e-6);
  assert.equal(failedReport.generation.batchWallMs, run.batchElapsedMs);
  assert.equal(hash(failed.generationLedger), original.ledger);
  assert.equal(hash(completed), completedHash);
  for (const record of failed.records) assert.equal(record.elapsedMs, run.records.find(r => r.id === record.id).elapsedMs);
  for (const id of ['prompt-baseline', 'render-only', 'evidence-validated']) {
    assert.equal(method(failedReport, id).itemElapsedMs, method(baseline, id).itemElapsedMs);
    assert.equal(method(failedReport, id).completedLatency.count, 0);
  }
  assert.deepEqual({ plan: hash(plan), run: hash(run), ledger: hash(run.generationLedger) }, original);
});
