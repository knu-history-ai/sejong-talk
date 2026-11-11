import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../evals/sejong/date-eval/cli.mjs';
import { hash, validateGenerationProgress } from '../evals/sejong/date-eval/core.mjs';
import { ruleAnswer } from '../evals/sejong/date-eval/runner.mjs';

// Real temporary files and injected storage failures; no service or model calls.
const originalFs = Object.fromEntries(['writeFile', 'rename', 'link', 'unlink'].map(key => [key, fs[key]]));
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = async (file, value) => originalFs.writeFile(file, JSON.stringify(value));
const identity = { name: 'synthetic-storage', digest: 'synthetic-storage-fixed', details: {} };
async function fixture({ methods = 'prompt-baseline', warmup = false } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'date storage 한글 '));
  const sourceText = '기사 표제 날짜: 2000년 3월 20일\n본문: 2000년 3월 10일에 공사를 시작하였다.';
  const c = { id: 'start', articleId: 'A', groupId: 'A', kind: 'event', type: 'known-day', sourceText,
    question: '공사 시작 날짜는?', targets: [{ id: 'start', label: '공사 시작' }] };
  const dataset = { version: 'synthetic-storage-v1', split: 'pilot', cases: [c] };
  const gold = { version: 'synthetic-storage-gold', criteriaVersion: 'synthetic-storage-rubric',
    datasetHash: hash(dataset), reviewStatus: 'draft', reviewedBy: [], rubric: {}, cases: [{ id: c.id, events: [{
      id: 'start', expected: { year: 2000, month: 3, day: 10, calendar: 'lunar' }, required: ['month', 'day'],
      allowedOmissions: ['year', 'calendar'], requiresUnknownDay: false,
      eligibility: { unsupportedDay: false, missingKnownDay: true, headerConfusion: true },
      evidence: [{ quote: sourceText, start: 0, end: sourceText.length }],
    }] }] };
  for (const [name, value] of Object.entries({ dataset, gold, identity })) await write(join(root, name + '.json'), value);
  const dir = join(root, 'private'), out = join(root, 'operator');
  await main(['prepare', '--dir', dir, '--dataset', join(root, 'dataset.json'), '--gold', join(root, 'gold.json'),
    '--model', identity.name, '--model-identity', join(root, 'identity.json'), '--methods', methods, ...(warmup ? ['--warmup'] : [])]);
  await main(['export-operator', '--dir', dir, '--out', out]);
  const requests = { tags: 0, generate: 0 };
  const fetch = async (url, options) => {
    if (String(url).endsWith('/api/tags')) { requests.tags++; return Response.json({ models: [identity] }); }
    assert.ok(String(url).endsWith('/api/generate'), 'unexpected network request');
    requests.generate++;
    const request = JSON.parse(options.body);
    return Response.json({ done: true, done_reason: 'stop', response: request.stage === 'warmup' ? 'ready' : ruleAnswer(c),
      prompt_eval_count: 17, eval_count: 9 });
  };
  return { root, dir, out, requests, fetch, plan: await read(join(dir, 'plan.json')) };
}
async function withMocks(f, patches, callback) {
  const fetch = globalThis.fetch;
  Object.assign(fs, patches); syncBuiltinESMExports(); globalThis.fetch = f.fetch;
  try { return await callback(); }
  finally { Object.assign(fs, originalFs); syncBuiltinESMExports(); globalThis.fetch = fetch; }
}
function cutWrite(target) {
  let fired = false;
  return async (file, data, options) => {
    if (!fired && (String(file) === target || String(file).startsWith(target + '.pending-'))) {
      fired = true;
      await originalFs.writeFile(file, String(data).slice(0, 45), options);
      throw Object.assign(new Error('synthetic partial write'), { code: 'EIO' });
    }
    return originalFs.writeFile(file, data, options);
  };
}
async function snapshot(dir) {
  const files = {};
  async function walk(path, prefix = '') {
    for (const entry of await fs.readdir(path, { withFileTypes: true })) {
      const name = join(prefix, entry.name), full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full, name);
      else files[name] = (await fs.readFile(full)).toString('base64');
    }
  }
  await walk(dir); return files;
}

test('a partial final write preserves checkpoint/raw calls and resumes publication without generation replay', async () => {
  const f = await fixture();
  await withMocks(f, { writeFile: cutWrite(join(f.out, 'run.json')) }, async () => {
    await assert.rejects(main(['run', '--dir', f.out]), { code: 'EIO' });
  });
  await assert.rejects(read(join(f.out, 'run.json')), { code: 'ENOENT' });
  const progress = await read(join(f.out, 'progress.json'));
  const ledger = [await read(join(f.out, 'generation-calls/0001.json'))];
  validateGenerationProgress(f.plan, progress.records, ledger);
  assert.equal(progress.records[0].state, 'completed');
  const before = await snapshot(f.out), calls = f.requests.generate, diagnostic = join(f.root, 'diagnostic.json');
  await withMocks(f, {}, () => main(['inspect-interruption', '--dir', f.dir, '--folder', f.out, '--out', diagnostic]));
  const inspection = await read(diagnostic);
  assert.equal(inspection.records.length, 1); assert.equal(inspection.paperEligible, false);
  assert.ok(inspection.storageArtifacts.some(a => a.path.startsWith('run.json.pending-')));
  assert.deepEqual(await snapshot(f.out), before);
  await withMocks(f, {}, () => main(['run', '--dir', f.out]));
  assert.equal(f.requests.generate, calls);
  const run = await read(join(f.out, 'run.json'));
  assert.equal(run.resumed, true); assert.deepEqual(run.records, progress.records);
  for (const [file, bytes] of Object.entries(before).filter(([file]) => file !== 'progress.json')) assert.equal((await snapshot(f.out))[file], bytes);
  assert.deepEqual(run.environmentHistory.slice(0, -1), progress.environmentHistory);
  assert.deepEqual((await read(join(f.out, 'progress.json'))).records, progress.records);
});

test('a failed import leaves only staging evidence; retry imports without touching the source and then rejects duplicates', async () => {
  const f = await fixture();
  await withMocks(f, {}, () => main(['run', '--dir', f.out]));
  const source = await snapshot(f.out), args = ['import-run', '--dir', f.dir, '--file', join(f.out, 'run.json')];
  await withMocks(f, { writeFile: cutWrite(join(f.dir, 'run.json')) }, () => assert.rejects(main(args), { code: 'EIO' }));
  await assert.rejects(read(join(f.dir, 'run.json')), { code: 'ENOENT' });
  const staging = (await fs.readdir(f.dir)).find(n => n.startsWith('run.json.pending-'));
  const originalStaging = await fs.readFile(join(f.dir, staging), 'utf8');
  await withMocks(f, {}, () => main(args));
  assert.deepEqual(await snapshot(f.out), source);
  assert.equal(await fs.readFile(join(f.dir, staging), 'utf8'), originalStaging);
  const imported = await snapshot(f.dir);
  await assert.rejects(main(args), { code: 'EEXIST' });
  assert.deepEqual(await snapshot(f.dir), imported);
});

test('link publication cannot replace a racing result and a cleanup interruption is not a failed model call', async () => {
  for (const mode of ['race', 'cleanup']) {
    const f = await fixture(), path = join(f.dir, 'run.json');
    await withMocks(f, {}, () => main(['run', '--dir', f.out]));
    const patches = mode === 'race' ? { link: async (source, target) => {
      if (String(target) === path) await originalFs.writeFile(target, 'preserved competing result', { flag: 'wx' });
      return originalFs.link(source, target);
    } } : { unlink: async file => {
      if (String(file).startsWith(path + '.pending-')) throw Object.assign(new Error('synthetic cleanup failure'), { code: 'EIO' });
      return originalFs.unlink(file);
    } };
    await withMocks(f, patches, async () => {
      const args = ['import-run', '--dir', f.dir, '--file', join(f.out, 'run.json')];
      if (mode === 'race') await assert.rejects(main(args), { code: 'EEXIST' });
      else await main(args);
    });
    if (mode === 'race') assert.equal(await fs.readFile(path, 'utf8'), 'preserved competing result');
    else assert.deepEqual(await read(path), await read(join(f.out, 'run.json')));
  }
});

for (const mode of ['rename', 'partial-checkpoint', 'partial-call']) test(`initial ${mode} interruption is registered read-only and blocks requests on retry`, async () => {
  const f = await fixture({ warmup: true });
  const patches = mode === 'rename' ? { rename: async (source, target) => {
    if (String(target) === join(f.out, 'progress.json')) throw Object.assign(new Error('synthetic checkpoint interruption'), { code: 'EIO' });
    return originalFs.rename(source, target);
  } } : { writeFile: cutWrite(mode === 'partial-checkpoint' ? join(f.out, 'progress.json.tmp') : join(f.out, 'generation-calls/0001.json')) };
  await withMocks(f, patches, () => assert.rejects(main(['run', '--dir', f.out]), { code: 'EIO' }));
  assert.equal(f.requests.generate, 0);
  const before = await snapshot(f.out), requests = structuredClone(f.requests), diagnostic = join(f.root, 'initial.json');
  await withMocks(f, {}, async () => {
    await main(['inspect-interruption', '--dir', f.dir, '--folder', f.out, '--out', diagnostic]);
    await assert.rejects(main(['run', '--dir', f.out]), /저장 중단|진행 기록/);
  });
  assert.deepEqual(f.requests, requests); assert.deepEqual(await snapshot(f.out), before);
  const report = await read(diagnostic);
  assert.equal(report.progressStatus, mode === 'partial-call' ? 'committed' : 'missing'); assert.equal(report.records.length, 0);
  assert.equal(report.automaticResumeAllowed, false); assert.equal(report.blocksFinalReport, true);
  assert.equal(report.generationCost.calls, null); assert.equal(report.generationCost.inputTokens.sum, null);
  assert.ok(report.plannedSlots.every(row => row.state === 'unknown'));
  assert.ok(report.storageArtifacts.length >= (mode === 'partial-call' ? 1 : 2));
});

for (const file of ['run.json', 'progress.json']) test(`legacy unreadable ${file} can be diagnosed without modifying or certifying it`, async () => {
  const f = await fixture();
  await withMocks(f, {}, () => main(['run', '--dir', f.out]));
  if (file === 'progress.json') await fs.rename(join(f.out, 'run.json'), join(f.out, 'original-run.json'));
  await originalFs.writeFile(join(f.out, file), '{"schemaVersion":1,"incomplete":');
  const before = await snapshot(f.out), diagnostic = join(f.root, 'legacy.json');
  await main(['inspect-interruption', '--dir', f.dir, '--folder', f.out, '--out', diagnostic]);
  const report = await read(diagnostic);
  assert.equal(report.generationCost.inputTokens.partialKnownSum, 17);
  assert.ok(report.storageArtifacts.some(a => a.path === file));
  assert.equal(report.paperEligible, false); assert.deepEqual(await snapshot(f.out), before);
  assert.equal(report.sourceByteHashes[file].length, 64);
});

test('pending call replacement is preserved and diagnosed but is never accepted as a new zero-cost run', async () => {
  const f = await fixture();
  const target = join(f.out, 'generation-calls/0001.json.tmp');
  await withMocks(f, { writeFile: cutWrite(target) }, () => assert.rejects(main(['run', '--dir', f.out]), { code: 'EIO' }));
  const before = await snapshot(f.out), requests = structuredClone(f.requests), diagnostic = join(f.root, 'call.json');
  await main(['inspect-interruption', '--dir', f.dir, '--folder', f.out, '--out', diagnostic]);
  const report = await read(diagnostic);
  assert.deepEqual(report.unresolvedCalls, [1]);
  assert.equal(report.generationCost.inputTokens.sum, null);
  assert.ok(report.storageArtifacts.some(a => a.path.endsWith('0001.json.tmp')));
  await withMocks(f, {}, () => assert.rejects(main(['run', '--dir', f.out]), /끊긴 호출|저장 중단/));
  assert.deepEqual(f.requests, requests); assert.deepEqual(await snapshot(f.out), before);
});

test('leftover identical staging link does not hide a confirmed call or cause a replay', async () => {
  const f = await fixture();
  await withMocks(f, { unlink: async file => {
    if (String(file).includes('generation-calls')) throw Object.assign(new Error('synthetic cleanup interruption'), { code: 'EIO' });
    return originalFs.unlink(file);
  } }, () => main(['run', '--dir', f.out]));
  const calls = f.requests.generate;
  await main(['import-run', '--dir', f.dir, '--file', join(f.out, 'run.json')]);
  assert.equal(f.requests.generate, calls);
  assert.equal((await read(join(f.dir, 'run.json'))).generationLedger.length, 1);
});

test('automatic output group resumes without replacing a published report or its measured computation time', async () => {
  const f = await fixture();
  await withMocks(f, {}, () => main(['run', '--dir', f.out]));
  await main(['import-run', '--dir', f.dir, '--file', join(f.out, 'run.json')]);
  await withMocks(f, { writeFile: cutWrite(join(f.dir, 'automatic-comparison.json')) },
    () => assert.rejects(main(['automatic-report', '--dir', f.dir]), { code: 'EIO' }));
  const report = await fs.readFile(join(f.dir, 'automatic-report.json'), 'utf8');
  await assert.rejects(read(join(f.dir, 'automatic-comparison.json')), { code: 'ENOENT' });
  await main(['automatic-report', '--dir', f.dir]);
  assert.equal(await fs.readFile(join(f.dir, 'automatic-report.json'), 'utf8'), report);
  await read(join(f.dir, 'automatic-comparison.json')); await read(join(f.dir, 'automatic-evaluation-cost.json'));
  const before = await snapshot(f.dir);
  await assert.rejects(main(['automatic-report', '--dir', f.dir]), { code: 'EEXIST' });
  assert.deepEqual(await snapshot(f.dir), before);
});

test('a conflicting surviving output blocks the entire report group before filling missing files', async () => {
  const f = await fixture();
  await withMocks(f, {}, () => main(['run', '--dir', f.out]));
  await main(['import-run', '--dir', f.dir, '--file', join(f.out, 'run.json')]);
  await main(['automatic-report', '--dir', f.dir]);
  for (const name of ['automatic-report.json', 'automatic-evaluation-cost.json']) {
    await fs.rename(join(f.dir, name), join(f.dir, 'preserved-' + name));
  }
  const path = join(f.dir, 'automatic-comparison.json'), comparison = await read(path);
  comparison.conflictingSyntheticField = true;
  await write(path, comparison);
  const before = await snapshot(f.dir);
  await assert.rejects(main(['automatic-report', '--dir', f.dir]), /기존 보고서가 현재 원본과 다릅니다/);
  assert.deepEqual(await snapshot(f.dir), before);
});

for (const callId of [1, 2, 3]) test(`legacy truncated call ${callId} preserves the folder and only confirms the validated prefix`, async () => {
  const f = await fixture({ methods: 'prompt-baseline,evidence-first' });
  await withMocks(f, {}, () => main(['run', '--dir', f.out]));
  await fs.rename(join(f.out, 'run.json'), join(f.out, 'preserved-run.json'));
  const path = join('generation-calls', String(callId).padStart(4, '0') + '.json');
  const originalEntry = await read(join(f.out, path));
  await originalFs.writeFile(join(f.out, path), '{"schemaVersion":1,"incomplete":');
  if (callId === 2) {
    const progress = await read(join(f.out, 'progress.json'));
    progress.inFlight = { callFile: path, request: originalEntry.request,
      context: originalEntry.context, startedAt: originalEntry.startedAt };
    await write(join(f.out, 'progress.json'), progress);
  }
  const before = await snapshot(f.out), diagnostic = join(f.root, 'unreadable-call.json');
  await main(['inspect-interruption', '--dir', f.dir, '--folder', f.out, '--out', diagnostic]);
  const report = await read(diagnostic);
  assert.equal(report.ledgerValidationStatus, 'incomplete-unreadable-call');
  assert.equal(report.recordsValidated, false);
  assert.ok(report.storageArtifacts.some(a => a.path === path && a.callId === callId && a.sha256.length === 64));
  assert.deepEqual(report.unresolvedCalls, [callId]);
  assert.deepEqual(report.unvalidatedCalls, Array.from({ length: 4 - callId }, (_, i) => i + callId));
  assert.ok(report.plannedSlots.every(slot => slot.state === 'unknown'));
  assert.equal(report.generationCost.calls, null);
  assert.equal(report.generationCost.recordedCalls, 3);
  assert.equal(report.generationCost.confirmedCalls, callId - 1);
  assert.equal(report.generationCost.inputTokens.sum, null);
  assert.equal(report.generationCost.inputTokens.partialKnownSum, 17 * (callId - 1));
  const requests = structuredClone(f.requests);
  await withMocks(f, {}, () => assert.rejects(main(['run', '--dir', f.out])));
  assert.deepEqual(f.requests, requests);
  assert.deepEqual(await snapshot(f.out), before);
});
