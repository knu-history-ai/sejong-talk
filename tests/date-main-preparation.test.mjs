import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPilot } from '../evals/sejong/date-eval/pilot.mjs';
import { hash } from '../evals/sejong/date-eval/core.mjs';
import { prepareMain } from '../scripts/prepare-date-main.mjs';

async function fixture(status = 'approved', reviewers = ['synthetic-reviewer'], questionCount = 12) {
  const dir = await mkdtemp(join(tmpdir(), 'date-main-prep-'));
  const pilot = await loadPilot();
  const cases = Array.from({ length: questionCount }, (_, i) => ({
    ...pilot.dataset.cases[i % pilot.dataset.cases.length], id: `synthetic-${i}`,
  }));
  const dataset = { ...pilot.dataset, version: 'synthetic-final-not-historical-evaluation', split: 'final', cases };
  const gold = { ...pilot.gold, datasetHash: hash(dataset), reviewStatus: status, reviewedBy: reviewers,
    cases: cases.map((c, i) => ({ ...pilot.gold.cases.find(g => g.id === pilot.dataset.cases[i % pilot.dataset.cases.length].id), id: c.id })) };
  await writeFile(join(dir, 'input.json'), JSON.stringify(dataset));
  await writeFile(join(dir, 'gold.json'), JSON.stringify(gold));
  await writeFile(join(dir, 'identity.json'), JSON.stringify({ name: 'qwen3.5:4b', digest: 'synthetic-q4', details: { quantization_level: 'Q4_K_M' } }));
  return { dir, args: ['--dataset', join(dir, 'input.json'), '--gold', join(dir, 'gold.json'),
    '--private-dir', join(dir, 'private'), '--out', join(dir, 'operator'), '--model-identity', join(dir, 'identity.json')] };
}
test('main preparation fixes all five methods/nonthinking/retries; exports only operator inputs, not gold', async () => {
  const { dir, args } = await fixture();
  await prepareMain(args);
  const privatePlan = JSON.parse(await readFile(join(dir, 'private/plan.json')));
  const publicPlan = JSON.parse(await readFile(join(dir, 'operator/plan.json')));
  assert.equal(privatePlan.slots.length, 60); assert.equal(publicPlan.id, privatePlan.id);
  const manifest = JSON.parse(await readFile(join(dir, 'private/sample-manifest.json')));
  assert.equal(manifest.articleCount, 3); assert.equal(manifest.plannedOutputs, 60);
  assert.equal(manifest.version, 'type-balanced-twelve-v2');
  assert.equal(manifest.caseIds.length, 12);
  assert.deepEqual(Object.values(manifest.methodOutputCounts), [12, 12, 12, 12, 12]);
  await assert.rejects(readFile(join(dir, 'operator/sample-manifest.json')), { code: 'ENOENT' });
  assert.equal(Object.hasOwn(publicPlan, 'gold'), false);
  assert.equal(privatePlan.config.think, false); assert.equal(privatePlan.config.retries, 0);
  assert.equal(privatePlan.config.warmup, true); assert.equal(privatePlan.config.repeats, 1);
  assert.equal(privatePlan.config.generationAuditVersion, 1);
  assert.equal(privatePlan.config.generationCompletionVersion, 2);
  assert.deepEqual(privatePlan.config, publicPlan.config);
  for (const method of privatePlan.config.methods.filter(m => ['render-only', 'evidence-validated'].includes(m.id))) {
    assert.equal(method.postprocessVersion, 'date-postprocess-v2');
  }
  assert.deepEqual(privatePlan.config.methods.map(m => m.id), ['rule-baseline', 'prompt-baseline', 'evidence-first', 'render-only', 'evidence-validated']);
  await assert.rejects(prepareMain(args), /덮어쓰지/);
});
test('insufficient main questions cannot silently export fewer than 60 sampled outputs', async () => {
  const { dir, args } = await fixture('approved', ['synthetic-reviewer'], 8);
  await assert.rejects(prepareMain(args), /12문항.*60개/);
  await assert.rejects(readFile(join(dir, 'operator/plan.json')), { code: 'ENOENT' });
  const sample = JSON.parse(await readFile(join(dir, 'private/sample-manifest.json')));
  assert.equal(sample.plannedOutputs, 40);
});
test('main export requires all five date types, not only 60 total outputs', async () => {
  const { dir, args } = await fixture();
  const path = join(dir, 'gold.json');
  const gold = JSON.parse(await readFile(path));
  for (const c of gold.cases) c.category = 'known-day';
  await writeFile(path, JSON.stringify(gold));
  await assert.rejects(prepareMain(args), /5날짜유형/);
  await assert.rejects(readFile(join(dir, 'operator/plan.json')), { code: 'ENOENT' });
});
test('draft, missing review, missing flags or wrong model quantization cannot be released as main experiment', async () => {
  for (const [status, reviewers] of [['draft', ['synthetic']], ['approved', []]]) {
    const { dir, args } = await fixture(status, reviewers);
    await assert.rejects(prepareMain(args), /검수/);
    await assert.rejects(readFile(join(dir, 'operator/plan.json')), { code: 'ENOENT' });
  }
  const { dir, args } = await fixture();
  await writeFile(join(dir, 'identity.json'), JSON.stringify({ name: 'qwen3.5:4b', digest: 'synthetic-q8', details: { quantization_level: 'Q8_0' } }));
  await assert.rejects(prepareMain(args), /Q4_K_M/);
  await assert.rejects(prepareMain(args.slice(0, 6)), /--out/);
});
