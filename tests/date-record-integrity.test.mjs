import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../evals/sejong/date-eval/cli.mjs';
import { hash, validateRecordedInputs } from '../evals/sejong/date-eval/core.mjs';
import { loadPilot } from '../evals/sejong/date-eval/pilot.mjs';
import { ruleAnswer } from '../evals/sejong/date-eval/runner.mjs';
import { resolveRunState } from '../evals/sejong/date-eval/state.mjs';
import { buildAutomaticReport } from '../evals/sejong/date-eval/automatic.mjs';

const read = async file => JSON.parse(await readFile(file, 'utf8'));
const write = async (file, value) => writeFile(file, JSON.stringify(value));
async function fixture({ method = 'prompt-baseline', length = false, fail = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'date integrity 한글 '));
  const privateDir = join(root, 'private'), operatorDir = join(root, 'operator');
  const { dataset } = await loadPilot();
  const identity = { name: 'synthetic', digest: 'synthetic-only', details: {} };
  await write(join(root, 'identity.json'), identity);
  await main(['prepare', '--dir', privateDir, '--model', identity.name, '--model-identity', join(root, 'identity.json'),
    '--methods', method, '--retries', '1']);
  await main(['export-operator', '--dir', privateDir, '--out', operatorDir]);
  const oldFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/tags')) return Response.json({ models: [identity] });
    modelCalls++;
    const request = JSON.parse(options.body), c = dataset.cases.find(c => request.prompt.includes(c.question));
    return Response.json({ done: !fail, done_reason: length ? 'length' : 'stop', response: ruleAnswer(c),
      prompt_eval_count: 17, eval_count: 9 });
  };
  try { await main(['run', '--dir', operatorDir]); } finally { globalThis.fetch = oldFetch; }
  return { root, privateDir, operatorDir, modelCalls, plan: await read(join(privateDir, 'plan.json')),
    run: await read(join(operatorDir, 'run.json')) };
}

test('length-cut state changes require a hash-bound inspection, including successive decisions', async () => {
  const f = await fixture({ length: true }), before = hash(f.run);
  const bad = structuredClone(f.run);
  bad.records.forEach(r => { r.state = 'completed'; });
  assert.throws(() => validateRecordedInputs(f.plan, bad), /길이 제한/);
  await write(join(f.operatorDir, 'bad-run.json'), bad);
  await assert.rejects(main(['import-run', '--dir', f.privateDir, '--file', join(f.operatorDir, 'bad-run.json')]), /길이 제한/);
  const completed = resolveRunState(f.plan, f.run, f.run.records.map(r => ({ recordId: r.id, originalRecordHash: hash(r),
    state: 'completed', reviewerId: 'synthetic-inspector', reason: 'synthetic readability check', evidence: 'whole original' })));
  validateRecordedInputs(f.plan, completed);
  assert.equal(buildAutomaticReport(f.plan, completed).items.length, 8);
  const first = completed.records[0];
  const failed = resolveRunState(f.plan, completed, [{ recordId: first.id, originalRecordHash: hash(first),
    state: 'failed', reviewerId: 'synthetic-inspector', reason: 'synthetic inspection correction', evidence: 'original body' }]);
  validateRecordedInputs(f.plan, failed);
  assert.ok(failed.records[0].executionInspection.previousInspection);
  for (const mutate of [r => { r.executionInspection.originalRecordHash = '0'.repeat(64); },
    r => { r.executionInspection.reason = ''; }, r => { r.rawAnswer += 'changed'; }]) {
    const changed = structuredClone(completed); mutate(changed.records[0]);
    assert.throws(() => validateRecordedInputs(f.plan, changed));
  }
  assert.equal(hash(f.run), before);
});

test('strict R results are recomputed, have zero model usage, and cannot silently become failures', async () => {
  const f = await fixture({ method: 'rule-baseline' }), before = hash(f.run);
  validateRecordedInputs(f.plan, f.run);
  for (const mutate of [r => { r.rawAnswer += 'changed'; }, r => { r.calls = 1; },
    r => { r.inputTokens = 1; }, r => { r.attempts = [{}]; },
    r => { r.state = 'failed'; r.rawAnswer = ''; }]) {
    const bad = structuredClone(f.run); mutate(bad.records[0]);
    assert.throws(() => validateRecordedInputs(f.plan, bad), /규칙/);
  }
  const bad = structuredClone(f.run); bad.records[0].rawAnswer += 'changed';
  await write(join(f.operatorDir, 'bad-rule.json'), bad);
  await assert.rejects(main(['import-run', '--dir', f.privateDir, '--file', join(f.operatorDir, 'bad-rule.json')]), /규칙/);
  assert.equal(f.modelCalls, 0); assert.equal(hash(f.run), before);
});

test('failed JSON token counts are checked against original raw, not only copied totals', async () => {
  const f = await fixture({ fail: true }), before = hash(f.run);
  const normal = buildAutomaticReport(f.plan, f.run);
  assert.equal(normal.generation.physicalBatch.inputTokens.sum, 8 * 2 * 17);
  const bad = structuredClone(f.run);
  for (const r of bad.records) {
    r.inputTokens = r.outputTokens = 0;
    for (const a of r.attempts) a.inputTokens = a.outputTokens = 0;
  }
  for (const entry of bad.generationLedger) entry.inputTokens = entry.outputTokens = 0;
  assert.throws(() => validateRecordedInputs(f.plan, bad), /실패 원응답과 토큰/);
  assert.throws(() => buildAutomaticReport(f.plan, bad), /실패 원응답과 토큰/);
  assert.equal(hash(f.run), before);
});

test('state inspections bind all T/V original timings even after an unrelated later decision', async () => {
  const f = await fixture({ method: 'prompt-baseline,render-only,evidence-validated', length: true });
  const original = hash(f.run), parents = f.run.records.filter(r => r.methodId === 'prompt-baseline');
  const decisions = parents.map(r => ({ recordId: r.id, originalRecordHash: hash(r), state: 'completed',
    reviewerId: 'synthetic', reason: 'synthetic inspection', evidence: 'original body and termination' }));
  const resolved = resolveRunState(f.plan, f.run, decisions);
  buildAutomaticReport(f.plan, resolved);
  for (const run of [resolved, resolveRunState(f.plan, resolved, [{ ...decisions[0],
    originalRecordHash: hash(resolved.records.find(r => r.id === parents[0].id)), state: 'failed' }])]) {
    for (const target of run.records.filter(r => r.derivation)) {
      const bad = structuredClone(run), r = bad.records.find(r => r.id === target.id);
      r.elapsedMs = target.elapsedMs === 0 ? 1 : 0;
      assert.throws(() => validateRecordedInputs(f.plan, bad), /T·V 재검사/);
      assert.throws(() => buildAutomaticReport(f.plan, bad), /T·V 재검사/);
    }
    const bad = structuredClone(run); bad.stateResolution.derivedRecordHashes = {};
    assert.throws(() => buildAutomaticReport(f.plan, bad), /T·V 재검사/);
  }
  assert.equal(hash(f.run), original);
});
