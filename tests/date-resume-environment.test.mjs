import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { main } from '../evals/sejong/date-eval/cli.mjs';
import { hash, makePlan, executionPlan, validateRun, validateRecordedInputs } from '../evals/sejong/date-eval/core.mjs';
import { executionEnvironment, ruleAnswer, runPlan } from '../evals/sejong/date-eval/runner.mjs';

// Real temporary storage, entirely synthetic sources and intercepted fetch.
// No server, production answer key, model or external request is used.
const originalFs = Object.fromEntries(['writeFile', 'rename', 'link'].map(k => [k, fs[k]]));
const read = async path => JSON.parse(await fs.readFile(path, 'utf8'));
const write = async (path, value) => originalFs.writeFile(path, JSON.stringify(value));
const identity = { name: 'synthetic-environment', digest: 'synthetic-fixed-model', details: { quantization_level: 'Q4_K_M' } };
async function fixture({ methods = 'prompt-baseline', warmup = false } = {}) {
  const root = await fs.mkdtemp(join(os.tmpdir(), 'date resume 환경 '));
  const sourceText = '기사 표제 날짜: 2000년 3월 20일\n본문: 2000년 3월 10일에 공사를 시작하였다.';
  const dataset = { version: 'synthetic-environment', split: 'pilot', cases: ['A', 'B'].map(id => ({
    id, articleId: id, groupId: id, kind: 'event', type: 'known-day', sourceText,
    question: `${id} 공사 시작 날짜는?`, targets: [{ id: 'start', label: '공사 시작' }],
  })) };
  const gold = { version: 'synthetic-key', criteriaVersion: 'synthetic-rubric', datasetHash: hash(dataset),
    reviewStatus: 'draft', reviewedBy: [], rubric: {}, cases: dataset.cases.map(c => ({ id: c.id, events: [{
      id: 'start', expected: { year: 2000, month: 3, day: 10, calendar: 'lunar' }, required: ['month', 'day'],
      eligibility: { unsupportedDay: false, missingKnownDay: true, headerConfusion: true },
      evidence: [{ quote: sourceText, start: 0, end: sourceText.length }],
    }] })) };
  for (const [name, value] of Object.entries({ dataset, gold, identity })) await write(join(root, name + '.json'), value);
  const dir = join(root, 'private'), out = join(root, 'operator');
  await main(['prepare', '--dir', dir, '--dataset', join(root, 'dataset.json'), '--gold', join(root, 'gold.json'),
    '--model', identity.name, '--model-identity', join(root, 'identity.json'), '--methods', methods, ...(warmup ? ['--warmup'] : [])]);
  await main(['export-operator', '--dir', dir, '--out', out]);
  const requests = { tags: 0, generate: 0 };
  const f = { root, dir, out, requests, dataset, gold, plan: await read(join(dir, 'plan.json')) };
  f.fetch = async (url, options) => {
    if (String(url).endsWith('/api/tags')) { requests.tags++; return Response.json({ models: [identity] }); }
    assert.ok(String(url).endsWith('/api/generate'), 'unexpected intercepted URL');
    requests.generate++;
    const progress = await read(join(out, 'progress.json'));
    const segment = progress.environmentHistory.at(-1);
    assert.deepEqual(await read(join(out, 'environment-segments', String(segment.index).padStart(4, '0') + '.json')), segment);
    assert.equal(segment.modelBefore.digest, identity.digest);
    assert.equal(progress.inFlight.request.model, identity.name);
    const request = JSON.parse(options.body), c = dataset.cases.find(c => request.prompt.includes(c.question));
    return Response.json({ done: true, done_reason: 'stop', response: c ? ruleAnswer(c) : 'ready',
      prompt_eval_count: 17, eval_count: 9 });
  };
  return f;
}
async function withMocks(f, { fs: patches = {}, os: osPatches = {} } = {}, callback) {
  const oldFetch = globalThis.fetch, oldOs = Object.fromEntries(Object.keys(osPatches).map(k => [k, os[k]]));
  Object.assign(fs, patches); Object.assign(os, osPatches); syncBuiltinESMExports(); globalThis.fetch = f.fetch;
  try { return await callback(); }
  finally { globalThis.fetch = oldFetch; Object.assign(fs, originalFs); Object.assign(os, oldOs); syncBuiltinESMExports(); }
}
async function stopAfter(f, count = 1) {
  let stopped = false;
  await withMocks(f, { fs: { rename: async (source, target) => {
    await originalFs.rename(source, target);
    if (!stopped && String(target) === join(f.out, 'progress.json')) {
      const progress = await read(target);
      if (!progress.inFlight && progress.records.length === count) {
        stopped = true; throw Object.assign(new Error('synthetic safe stop'), { code: 'ESTOP' });
      }
    }
  } } }, () => assert.rejects(main(['run', '--dir', f.out]), { code: 'ESTOP' }));
  return read(join(f.out, 'progress.json'));
}
async function snapshot(dir) {
  const files = {};
  async function walk(folder, prefix = '') {
    for (const e of await fs.readdir(folder, { withFileTypes: true })) {
      const name = join(prefix, e.name), path = join(folder, e.name);
      if (e.isDirectory()) await walk(path, name);
      else files[name] = hash((await fs.readFile(path)).toString('base64'));
    }
  }
  await walk(dir); return files;
}
async function rejectedWithoutFetch(f, pattern = /환경/) {
  const oldFetch = globalThis.fetch, before = await snapshot(f.out); let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected fetch'); };
  try { await assert.rejects(main(['run', '--dir', f.out]), pattern); }
  finally { globalThis.fetch = oldFetch; }
  assert.equal(calls, 0); assert.deepEqual(await snapshot(f.out), before);
}

test('pre-call durable environment survives a clean checkpoint interruption and same-host resume without replay', async () => {
  const f = await fixture({ warmup: true }), progress = await stopAfter(f), before = await snapshot(f.out);
  assert.equal(f.plan.config.environmentAuditVersion, 1);
  assert.equal(progress.environmentHistory.length, 1); assert.equal(progress.records.length, 1);
  const generated = f.requests.generate;
  await withMocks(f, {}, () => main(['run', '--dir', f.out]));
  const run = await read(join(f.out, 'run.json'));
  assert.equal(f.requests.generate - generated, 2); // New warmup + remaining P only.
  assert.equal(run.resumed, true); assert.equal(run.environmentHistory.length, 2);
  assert.deepEqual(run.environmentHistory[0], progress.environmentHistory[0]);
  assert.deepEqual(run.environment, progress.environmentHistory[0].environment);
  assert.deepEqual(run.records.slice(0, progress.records.length), progress.records);
  for (const [file, value] of Object.entries(before)) if (file !== 'progress.json') assert.equal((await snapshot(f.out))[file], value);
  validateRecordedInputs(f.plan, run);
  await main(['import-run', '--dir', f.dir, '--file', join(f.out, 'run.json')]);
});

test('changed host environment is rejected before tags, warmup, generation or any file change', async () => {
  const f = await fixture(); await stopAfter(f);
  await withMocks(f, { os: { release: () => 'synthetic-changed-release' } }, () => rejectedWithoutFetch(f, /환경이 바뀌었/));
});

test('zero-record initial checkpoint preserves its first environment and can resume on the same host', async () => {
  const f = await fixture({ warmup: true }); await stopAfter(f, 0);
  assert.equal(f.requests.generate, 0);
  const first = await read(join(f.out, 'progress.json'));
  assert.equal(first.environmentHistory.length, 1); assert.equal(first.environmentHistory[0].callCount, 0);
  await withMocks(f, {}, () => main(['run', '--dir', f.out]));
  const run = await read(join(f.out, 'run.json'));
  assert.equal(run.resumed, true); assert.equal(run.environmentHistory.length, 2);
  assert.deepEqual(run.environmentHistory[0], first.environmentHistory[0]);
  assert.equal(run.batchWallScope, 'current resumed segment only; earlier batch wall time unavailable');
});

test('environment file published before initial checkpoint interruption remains diagnosable and cannot certify a retrospective freeze/export', async () => {
  const f = await fixture(), failure = Object.assign(new Error('synthetic initial checkpoint failure'), { code: 'EIO' });
  await withMocks(f, { fs: { rename: async (source, target) => {
    if (String(target) === join(f.out, 'progress.json')) throw failure;
    return originalFs.rename(source, target);
  } } }, () => assert.rejects(main(['run', '--dir', f.out]), { code: 'EIO' }));
  assert.equal(f.requests.generate, 0);
  const before = await snapshot(f.out), out = join(f.root, 'diagnostic.json');
  await main(['inspect-interruption', '--dir', f.dir, '--folder', f.out, '--out', out]);
  const inspection = await read(out);
  assert.equal(inspection.environmentHistory.length, 1); assert.equal(inspection.environmentHistoryStatus, 'unverified');
  assert.equal(inspection.paperEligible, false); assert.deepEqual(await snapshot(f.out), before);
  await rejectedWithoutFetch(f, /저장 중단/);
  // Reproduce an interrupted direct preparation: a durable environment file
  // exists but progress is absent. Neither route may call this pre-execution.
  await fs.mkdir(join(f.dir, 'environment-segments'));
  await fs.copyFile(join(f.out, 'environment-segments/0001.json'), join(f.dir, 'environment-segments/0001.json'));
  await assert.rejects(main(['sample-freeze', '--dir', f.dir]), /환경 기록/);
  await assert.rejects(main(['export-operator', '--dir', f.dir, '--out', join(f.root, 'late-export')]), /환경 기록/);
});

test('missing, edited or rehashed checkpoint history cannot resume without its immutable original', async () => {
  for (const edit of [p => { delete p.environmentHistory; }, p => { p.environmentHistory[0].environment.cpu += '-edited'; },
    p => { const s = p.environmentHistory[0]; s.modelBefore.digest = 'edited'; const body = { ...s }; delete body.segmentHash; s.segmentHash = hash(body); }]) {
    const f = await fixture(), progress = await stopAfter(f);
    edit(progress); await write(join(f.out, 'progress.json'), progress);
    await rejectedWithoutFetch(f);
  }
});

test('legacy progress without environment evidence is never backfilled, including zero prior records', async () => {
  for (const records of [[], null]) {
    const f = await fixture(), progress = records ? { planId: f.plan.id, records, warmupHistoryComplete: true } : await stopAfter(f);
    delete progress.environmentHistory; await write(join(f.out, 'progress.json'), progress);
    await rejectedWithoutFetch(f, /소급 인증/);
    assert.equal((await read(join(f.out, 'progress.json'))).environmentHistory, undefined);
  }
});

test('final import rejects changed or missing original environment files and edited/missing run history', async () => {
  const f = await fixture(); await withMocks(f, {}, () => main(['run', '--dir', f.out]));
  const path = join(f.out, 'run.json'), original = await read(path), sourceBefore = await snapshot(f.out);
  for (const edit of [r => { delete r.environmentHistory; }, r => { r.environment.cpu += '-edited'; },
    r => { r.environmentHistory[0].modelBefore.digest += '-edited'; },
    r => { delete r.generationLedger[0].environmentSegmentHash; }]) {
    const run = structuredClone(original); edit(run);
    assert.throws(() => validateRun(f.plan, run), /환경|구간/);
    await write(path, run);
    await assert.rejects(main(['import-run', '--dir', f.dir, '--file', path]), /환경|구간/);
  }
  await write(path, original);
  const segmentPath = join(f.out, 'environment-segments/0001.json'), segment = await read(segmentPath);
  await write(segmentPath, { ...segment, startedAt: '1999-01-01T00:00:00Z' });
  await assert.rejects(main(['import-run', '--dir', f.dir, '--file', path]), /원본 환경 이력/);
  await fs.rename(segmentPath, segmentPath + '.preserved');
  await assert.rejects(main(['import-run', '--dir', f.dir, '--file', path]), /원본 환경 이력/);
  assert.equal(hash(original.records), hash((await read(path)).records));
  assert.ok(Object.keys(sourceBefore).length > 0);
});

test('T/V-only pending work keeps all history and original P without new generation', async () => {
  const f = await fixture({ methods: 'prompt-baseline,render-only,evidence-validated', warmup: true });
  const progress = await stopAfter(f, 2), calls = f.requests.generate;
  await withMocks(f, {}, () => main(['run', '--dir', f.out]));
  const run = await read(join(f.out, 'run.json'));
  assert.equal(f.requests.generate, calls); assert.equal(run.records.length, 6);
  assert.deepEqual(run.records.slice(0, 2), progress.records); assert.equal(run.environmentHistory.length, 2);
  validateRun(f.plan, run); validateRecordedInputs(f.plan, run);
});

test('legacy completed runs remain readable without manufacturing environment audit evidence', async () => {
  const f = await fixture({ methods: 'rule-baseline' });
  const config = structuredClone(f.plan.config); delete config.environmentAuditVersion;
  const plan = makePlan(f.dataset, f.gold, config);
  const run = await runPlan(executionPlan(plan)); run.generationLedger = [];
  const before = hash(run);
  validateRun(plan, run); validateRecordedInputs(plan, run);
  assert.equal(run.environmentHistory, undefined); assert.equal(hash(run), before);
  assert.throws(() => makePlan(f.dataset, f.gold, { ...config, environmentAuditVersion: 1,
    generationCompletionVersion: 1, generationAuditVersion: undefined }), /원본 생성 감사/);
  const env = executionEnvironment(); assert.equal(env.node, process.version);
});
