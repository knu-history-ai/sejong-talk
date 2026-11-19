import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { main } from '../evals/sejong/date-eval/cli.mjs';
import { hash, makePlan, validateExecutionPlan } from '../evals/sejong/date-eval/core.mjs';
import { ruleAnswer } from '../evals/sejong/date-eval/runner.mjs';
import { loadPilot } from '../evals/sejong/date-eval/pilot.mjs';
import { createSamplePackets } from '../evals/sejong/date-eval/sampling.mjs';

const read = async path => JSON.parse(await readFile(path, 'utf8'));
const write = async (path, value) => writeFile(path, JSON.stringify(value));
async function fixture(method = 'prompt-baseline') {
  const root = await mkdtemp(join(tmpdir(), 'date interruption 한글 '));
  const dir = join(root, 'private'), out = join(root, 'operator');
  const { dataset } = await loadPilot();
  const identity = { name: 'synthetic', digest: 'synthetic-interruption-only', details: {} };
  await write(join(root, 'identity.json'), identity);
  await main(['prepare', '--dir', dir, '--model', identity.name, '--model-identity', join(root, 'identity.json'), '--methods', method]);
  await main(['sample-freeze', '--dir', dir]);
  await main(['export-operator', '--dir', dir, '--out', out]);
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/tags')) return Response.json({ models: [identity] });
    const request = JSON.parse(options.body), c = dataset.cases.find(c => request.prompt.includes(c.question));
    return Response.json({ done: true, done_reason: 'stop', response: ruleAnswer(c), prompt_eval_count: 17, eval_count: 9 });
  };
  try { await main(['run', '--dir', out]); } finally { globalThis.fetch = original; }
  return { root, dir, out, plan: await read(join(dir, 'plan.json')), run: await read(join(out, 'run.json')) };
}
async function interrupted(f, { inFlight = true, orphan = false } = {}) {
  const dir = join(f.root, 'interrupted');
  await mkdir(join(dir, 'generation-calls'), { recursive: true });
  await writeFile(join(dir, 'plan.json'), await readFile(join(f.out, 'plan.json')));
  const records = structuredClone(f.run.records.slice(0, 3));
  const ledger = structuredClone(f.run.generationLedger.slice(0, inFlight ? 4 : 3));
  if (inFlight) { ledger.at(-1).state = 'in-flight'; delete ledger.at(-1).result; delete ledger.at(-1).endedAt; }
  for (const entry of ledger) await write(join(dir, 'generation-calls', String(entry.callId).padStart(4, '0') + '.json'), entry);
  const entry = ledger.at(-1);
  await write(join(dir, 'progress.json'), { planId: f.plan.id, records, warmupHistoryComplete: true,
    inFlight: inFlight && !orphan ? { request: entry.request, context: entry.context,
      callFile: join('generation-calls', String(entry.callId).padStart(4, '0') + '.json'), startedAt: entry.startedAt } : null });
  return { dir, records, ledger };
}
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

test('orphaned in-flight and unbound completed calls stop resume before any model request', async () => {
  for (const inFlight of [true, false]) {
    const f = await fixture(), stopped = await interrupted(f, { inFlight, orphan: true });
    if (!inFlight) {
      const progress = await read(join(stopped.dir, 'progress.json'));
      progress.records = []; await write(join(stopped.dir, 'progress.json'), progress);
    }
    const before = await snapshot(stopped.dir), oldFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('No request should occur before progress validation'); };
    try { await assert.rejects(main(['run', '--dir', stopped.dir]), /미확인 생성 호출|연결되지 않은 추가/); }
    finally { globalThis.fetch = oldFetch; }
    assert.equal(calls, 0);
    assert.deepEqual(await snapshot(stopped.dir), before);
  }
});

test('maintainer registers interrupted originals, known partial usage and every planned slot without promoting to a scored run', async () => {
  const f = await fixture(), stopped = await interrupted(f), before = await snapshot(stopped.dir);
  const out = join(f.root, 'interruption-inspection.json');
  await main(['inspect-interruption', '--dir', f.dir, '--folder', stopped.dir, '--out', out]);
  const report = await read(out);
  assert.equal(report.type, 'date-interruption-inspection');
  assert.equal(report.paperEligible, false); assert.equal(report.blocksFinalReport, true);
  assert.equal(report.automaticResumeAllowed, false);
  assert.equal(report.records.length, 3); assert.equal(report.plannedSlots.length, 8);
  assert.equal(report.plannedSlots.filter(r => r.state === 'unknown').length, 1);
  assert.equal(report.plannedSlots.filter(r => r.state === 'unexecuted').length, 4);
  assert.deepEqual(report.unresolvedCalls, [4]); assert.deepEqual(report.unboundCalls, [4]);
  assert.equal(report.generationCost.calls, null); assert.equal(report.generationCost.recordedCalls, 4);
  assert.equal(report.generationCost.inputTokens.sum, null);
  assert.equal(report.generationCost.inputTokens.partialKnownSum, 51);
  assert.equal(report.generationCost.outputTokens.partialKnownSum, 27);
  assert.match(report.next, /유진님은 실행·기록/);
  assert.deepEqual(await snapshot(stopped.dir), before);
  await assert.rejects(main(['import-run', '--dir', f.dir, '--file', out]), /실행 버전 불일치/);
  await assert.rejects(main(['inspect-interruption', '--dir', f.dir, '--folder', stopped.dir, '--out', out]), { code: 'EEXIST' });
  await assert.rejects(main(['inspect-interruption', '--dir', f.dir, '--folder', stopped.dir, '--out', join(stopped.dir, 'diagnostic.json')]), /원본 폴더 밖/);
  const alias = join(f.root, 'original-alias');
  await symlink(stopped.dir, alias, 'junction');
  await assert.rejects(main(['inspect-interruption', '--dir', f.dir, '--folder', stopped.dir,
    '--out', join(alias, 'new-subfolder/diagnostic.json')]), /원본 폴더 밖/);
  if (process.platform === 'win32') await assert.rejects(main(['inspect-interruption', '--dir', f.dir,
    '--folder', stopped.dir.toUpperCase(), '--out', join(stopped.dir, 'diagnostic.json')]), /원본 폴더 밖/);
  assert.deepEqual(await snapshot(stopped.dir), before);
});

test('returned interruption markers use either Windows or POSIX separators independently of the maintainer OS', async () => {
  const f = await fixture(), stopped = await interrupted(f);
  for (const pathApi of [win32, posix]) {
    const progress = await read(join(stopped.dir, 'progress.json'));
    progress.inFlight.callFile = pathApi.join('generation-calls', '0004.json');
    await write(join(stopped.dir, 'progress.json'), progress);
    const before = await snapshot(stopped.dir), out = join(f.root, pathApi === win32 ? 'windows.json' : 'posix.json');
    await main(['inspect-interruption', '--dir', f.dir, '--folder', stopped.dir, '--out', out]);
    assert.deepEqual((await read(out)).unresolvedCalls, [4]);
    assert.equal((await read(out)).generationCost.inputTokens.partialKnownSum, 51);
    assert.deepEqual(await snapshot(stopped.dir), before);
  }
});

test('terminal checkpoint interruption is inspectable; tampered records or wrong private plan are not', async () => {
  const f = await fixture(), stopped = await interrupted(f, { inFlight: false });
  const out = join(f.root, 'terminal-inspection.json');
  await main(['inspect-interruption', '--dir', f.dir, '--folder', stopped.dir, '--out', out]);
  assert.equal((await read(out)).generationCost.confirmedCalls, 3);
  const progress = await read(join(stopped.dir, 'progress.json'));
  progress.records[0].rawAnswer += 'changed';
  await write(join(stopped.dir, 'progress.json'), progress);
  await assert.rejects(main(['inspect-interruption', '--dir', f.dir, '--folder', stopped.dir,
    '--out', join(f.root, 'bad.json')]), /원답변/);
  await assert.rejects(readFile(join(f.root, 'bad.json')), { code: 'ENOENT' });
});

test('sample packet recovery reuses original private IDs, fills missing files and never overwrites edits', async () => {
  const f = await fixture('rule-baseline');
  await main(['import-run', '--dir', f.dir, '--file', join(f.out, 'run.json')]);
  const manifest = await read(join(f.dir, 'sample-manifest.json'));
  const bundle = createSamplePackets(f.plan, f.run, manifest);
  const privateFile = join(f.dir, 'sample-review-private.json');
  await write(privateFile, bundle); // durable private write followed by process interruption
  const before = await readFile(privateFile, 'utf8');
  await main(['sample-packets', '--dir', f.dir]);
  assert.equal(await readFile(privateFile, 'utf8'), before);
  assert.deepEqual(await read(join(f.dir, 'sample-review-share/packets.json')), bundle.packets);
  const snapshotBefore = await snapshot(f.dir);
  await main(['sample-packets', '--dir', f.dir]);
  assert.deepEqual(await snapshot(f.dir), snapshotBefore);
  const blankFile = join(f.dir, 'sample-review-share/blank-review.json');
  const blanks = await read(blankFile); blanks[0].reason = 'preserve submitted text';
  await write(blankFile, blanks);
  await assert.rejects(main(['sample-packets', '--dir', f.dir]), /기존 산출물/);
  assert.equal((await read(blankFile))[0].reason, 'preserve submitted text');
});

test('stale or corrupt private packet bundles cannot generate replacement public material', async () => {
  const f = await fixture('rule-baseline');
  await main(['import-run', '--dir', f.dir, '--file', join(f.out, 'run.json')]);
  const bundle = createSamplePackets(f.plan, f.run, await read(join(f.dir, 'sample-manifest.json')));
  bundle.packets[0].input.rawAnswer += 'different source';
  await write(join(f.dir, 'sample-review-private.json'), bundle);
  await assert.rejects(main(['sample-packets', '--dir', f.dir]));
  await assert.rejects(readFile(join(f.dir, 'sample-review-share/packets.json')), { code: 'ENOENT' });
});

test('all final preparation routes require real nonblank reviewer records before model lookup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'date final approval ')), { dataset: pilot, gold: oldGold } = await loadPilot();
  const dataset = { ...pilot, split: 'final' };
  for (const reviewedBy of [[], [''], ['valid', '  '], [null]]) {
    const gold = { ...oldGold, reviewStatus: 'approved', reviewedBy, datasetHash: hash(dataset) };
    await write(join(root, 'dataset.json'), dataset); await write(join(root, 'gold.json'), gold);
    let calls = 0; const old = globalThis.fetch;
    globalThis.fetch = async () => { calls++; throw new Error('No model lookup before review approval'); };
    try { await assert.rejects(main(['prepare', '--dir', join(root, 'private-' + hash(reviewedBy).slice(0, 8)),
      '--dataset', join(root, 'dataset.json'), '--gold', join(root, 'gold.json'), '--model', 'synthetic']), /검수자/); }
    finally { globalThis.fetch = old; }
    assert.equal(calls, 0);
    assert.throws(() => makePlan(dataset, gold, { generationAuditVersion: 1, model: 'synthetic', options: {},
      timeoutMs: 1000, retries: 0, repeats: 1, methods: [{ id: 'rule-baseline', version: 'synthetic' }] }), /검수자/);
    // Reading an old plan remains supported, but exporting it as a new final
    // operator folder must not bypass the same approval boundary.
    const legacy = makePlan(dataset, gold, { model: 'synthetic', options: {}, timeoutMs: 1000,
      retries: 0, repeats: 1, methods: [{ id: 'rule-baseline', version: 'synthetic' }] });
    const legacyDir = join(root, 'legacy-' + hash(reviewedBy).slice(0, 8));
    await mkdir(legacyDir); await write(join(legacyDir, 'plan.json'), legacy);
    await assert.rejects(main(['export-operator', '--dir', legacyDir, '--out', join(legacyDir, 'operator')]), /검수자/);
    await assert.rejects(readFile(join(legacyDir, 'operator/plan.json')), { code: 'ENOENT' });
  }
  const f = await fixture('rule-baseline'), publicPlan = await read(join(f.out, 'plan.json'));
  publicPlan.dataset.split = 'final'; // wrong hash/approval must never become a valid operator plan
  assert.throws(() => validateExecutionPlan(publicPlan));
});

test('real process interruption after three answers registers originals and partial costs without a fourth replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'date killed process 한글 '));
  const dir = join(root, 'private'), operator = join(root, 'operator');
  const { dataset } = await loadPilot();
  const identity = { name: 'synthetic', digest: 'synthetic-kill-only', details: {} };
  let calls = 0, tags = 0, beginFourth;
  const fourthStarted = new Promise(resolve => { beginFourth = resolve; });
  const server = createServer((request, response) => {
    if (request.url === '/api/tags') { tags++; return response.end(JSON.stringify({ models: [identity] })); }
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      calls++;
      if (calls === 4) {
        response.writeHead(200); response.write('{"response":"interrupted'); beginFourth();
      } else {
        const input = JSON.parse(body), c = dataset.cases.find(c => input.prompt.includes(c.question));
        response.end(JSON.stringify({ done: true, done_reason: 'stop', response: ruleAnswer(c),
          prompt_eval_count: 17, eval_count: 9 }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let child, exited, timer, output = '';
  try {
    const identityFile = join(root, 'identity.json'); await write(identityFile, identity);
    await main(['prepare', '--dir', dir, '--model', identity.name, '--model-identity', identityFile,
      '--endpoint', `http://127.0.0.1:${server.address().port}`, '--methods', 'prompt-baseline']);
    await main(['sample-freeze', '--dir', dir]);
    await main(['export-operator', '--dir', dir, '--out', operator]);
    child = spawn(process.execPath, [fileURLToPath(new URL('../evals/sejong/date-eval/cli.mjs', import.meta.url)),
      'run', '--dir', operator]);
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    exited = new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    await Promise.race([fourthStarted,
      exited.then(value => { throw new Error('process exited before fourth call: ' + JSON.stringify(value) + output); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fourth call did not start: ' + output)), 15000); })]);
    clearTimeout(timer); child.kill('SIGKILL'); assert.equal((await exited).signal, 'SIGKILL');
    const before = await snapshot(operator), tagCount = tags;
    await assert.rejects(main(['run', '--dir', operator]), /끊긴 호출/);
    const inspection = join(root, 'interruption.json');
    await main(['inspect-interruption', '--dir', dir, '--folder', operator, '--out', inspection]);
    const report = await read(inspection);
    assert.equal(report.records.length, 3); assert.deepEqual(report.unresolvedCalls, [4]);
    assert.equal(report.plannedSlots.filter(r => r.state === 'unknown').length, 1);
    assert.equal(report.plannedSlots.filter(r => r.state === 'unexecuted').length, 4);
    assert.equal(report.generationCost.inputTokens.partialKnownSum, 51);
    assert.equal(report.generationCost.outputTokens.partialKnownSum, 27);
    assert.equal(report.generationCost.inputTokens.sum, null); assert.equal(report.paperEligible, false);
    assert.equal(calls, 4); assert.equal(tags, tagCount);
    assert.deepEqual(await snapshot(operator), before);
    await assert.rejects(readFile(join(operator, 'run.json')), { code: 'ENOENT' });
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await exited; }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
