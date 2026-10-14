import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPilot } from '../evals/sejong/date-eval/pilot.mjs';
import { hash } from '../evals/sejong/date-eval/core.mjs';
import { prepareMain } from '../scripts/prepare-date-main.mjs';

async function fixture(status = 'approved', reviewers = ['synthetic-reviewer']) {
  const dir = await mkdtemp(join(tmpdir(), 'date-main-prep-'));
  const pilot = await loadPilot();
  const dataset = { ...pilot.dataset, version: 'synthetic-final-not-historical-evaluation', split: 'final' };
  const gold = { ...pilot.gold, datasetHash: hash(dataset), reviewStatus: status, reviewedBy: reviewers };
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
  assert.equal(privatePlan.slots.length, 40); assert.equal(publicPlan.id, privatePlan.id);
  const manifest = JSON.parse(await readFile(join(dir, 'private/sample-manifest.json')));
  assert.equal(manifest.articleCount, 3); assert.equal(manifest.plannedOutputs, 15);
  await assert.rejects(readFile(join(dir, 'operator/sample-manifest.json')), { code: 'ENOENT' });
  assert.equal(Object.hasOwn(publicPlan, 'gold'), false);
  assert.equal(privatePlan.config.think, false); assert.equal(privatePlan.config.retries, 0);
  assert.equal(privatePlan.config.warmup, true); assert.equal(privatePlan.config.repeats, 1);
  assert.deepEqual(privatePlan.config.methods.map(m => m.id), ['rule-baseline', 'prompt-baseline', 'evidence-first', 'render-only', 'evidence-validated']);
  await assert.rejects(prepareMain(args), /덮어쓰지/);
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
