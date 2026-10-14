import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../evals/sejong/date-eval/cli.mjs';
import { loadPilot } from '../evals/sejong/date-eval/pilot.mjs';
import { hash, makePlan } from '../evals/sejong/date-eval/core.mjs';
import { runPlan } from '../evals/sejong/date-eval/runner.mjs';
import { buildSampleReport } from '../evals/sejong/date-eval/sample-report.mjs';
import { buildAutomaticReport } from '../evals/sejong/date-eval/automatic.mjs';
import { aiGrade, finalizeReviews } from '../evals/sejong/date-eval/grading.mjs';
import { createSampleManifest, createSamplePackets } from '../evals/sejong/date-eval/sampling.mjs';
const read = async path => JSON.parse(await readFile(path, 'utf8'));
function review(p, reviewerId, structuredDate = 1) {
  return { packetId: p.id, packetHash: p.hash, reviewerId, independent: true, blind: true,
    structuredDate, structuredReason: 'synthetic independent structured comparison',
    date: 1, evidence: 1, reason: 'synthetic semantic judgment, not real human validation', elapsedMs: 5,
    events: p.input.gold.events.map(e => ({ id: e.id, date: 1,
      ...Object.fromEntries(Object.entries(e.eligibility).map(([k, eligible]) => [k, eligible ? 0 : null])),
      reasons: { date: 'synthetic date reason', unsupportedDay: 'synthetic reason',
        missingKnownDay: 'synthetic reason', headerConfusion: 'synthetic reason' } })) };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'date auto 표본 '));
  await main(['prepare', '--dir', dir, '--model', 'fixture', '--methods', 'rule-baseline']);
  await main(['sample-freeze', '--dir', dir]);
  await main(['run', '--dir', dir]);
  return dir;
}
test('CLI preserves originals and separates full automatic, sampled humans and legacy final gates', async () => {
  const dir = await fixture();
  const original = await readFile(join(dir, 'run.json'), 'utf8');
  const frozen = await readFile(join(dir, 'sample-manifest.json'), 'utf8');
  await assert.rejects(main(['sample-freeze', '--dir', dir]), /실행 결과/);
  await main(['automatic-report', '--dir', dir]);
  const automatic = await read(join(dir, 'automatic-report.json'));
  assert.equal(automatic.items.length, 8); assert.equal(automatic.humanValidated, false);
  const cost = await read(join(dir, 'automatic-evaluation-cost.json'));
  assert.equal(cost.generationIncluded, false); assert.equal(cost.human, null);
  assert.equal(cost.automaticCode.artifactHash, hash(automatic));
  await main(['sample-packets', '--dir', dir]);
  const packets = await read(join(dir, 'sample-review-share/packets.json'));
  assert.equal(packets.length, 3);
  const blanks = await read(join(dir, 'sample-review-share/blank-review.json'));
  assert.equal(blanks[0].structuredDate, null);
  for (const reviewer of ['민준', '시연']) {
    const file = join(dir, `${reviewer}.json`);
    await writeFile(file, JSON.stringify(packets.map(p => review(p, reviewer))));
    await main(['import-sample-review', '--dir', dir, '--file', file, '--reviewer', reviewer]);
    await assert.rejects(main(['import-sample-review', '--dir', dir, '--file', file, '--reviewer', reviewer]), /덮어쓸/);
  }
  await main(['sample-finalize', '--dir', dir]);
  await main(['sample-report', '--dir', dir]);
  const sample = await read(join(dir, 'sample-report.json'));
  assert.equal(sample.manifestHash, JSON.parse(frozen).manifestHash);
  assert.equal(sample.manifestDocumentHash, hash(JSON.parse(frozen)));
  assert.equal(sample.scope.selectedQuestions, 3); assert.equal(sample.scope.populationQuestions, 8);
  assert.equal(sample.humanValidationComplete, true); assert.equal(sample.paperEligible, false);
  assert.equal(sample.evaluationCost.total.elapsedMs, 30);
  assert.equal(sample.graderValidation.codeVsHumanStructured.eligible, 3);
  assert.equal(sample.graderValidation.aiVsHumanSemantic, null);
  assert.equal(sample.firstHumanAgreement.byField.date.value, 1);
  await assert.rejects(main(['report', '--dir', dir, '--final', join(dir, 'sample-final.json')]), /sample human/);
  for (const command of ['automatic-report', 'sample-packets', 'sample-finalize', 'sample-report']) {
    await assert.rejects(main([command, '--dir', dir]), { code: 'EEXIST' });
  }
  assert.equal(await readFile(join(dir, 'run.json'), 'utf8'), original);
  assert.equal(await readFile(join(dir, 'sample-manifest.json'), 'utf8'), frozen);
});
test('operator export records the pre-generation sample binding and prevents retrospective freezing', async () => {
  const privateDir = await mkdtemp(join(tmpdir(), 'private export '));
  const out = await mkdtemp(join(tmpdir(), 'operator export '));
  await main(['prepare', '--dir', privateDir, '--model', 'fixture', '--methods', 'rule-baseline']);
  await main(['export-operator', '--dir', privateDir, '--out', out]);
  await main(['run', '--dir', out]);
  await assert.rejects(main(['sample-freeze', '--dir', privateDir]), /전달한 뒤/);
  await main(['import-run', '--dir', privateDir, '--file', join(out, 'run.json')]);
  await assert.rejects(main(['sample-packets', '--dir', privateDir]), { code: 'ENOENT' });
  const sampled = await mkdtemp(join(tmpdir(), 'sampled export '));
  const sampledOut = await mkdtemp(join(tmpdir(), 'sampled operator '));
  await main(['prepare', '--dir', sampled, '--model', 'fixture', '--methods', 'rule-baseline']);
  await main(['sample-freeze', '--dir', sampled]);
  await main(['export-operator', '--dir', sampled, '--out', sampledOut]);
  const manifest = await read(join(sampled, 'sample-manifest.json'));
  const exported = await read(join(sampled, 'operator-export.json'));
  assert.equal(exported.mode, 'automatic-sample');
  assert.equal(exported.manifestHash, manifest.manifestHash);
  assert.equal((await read(join(sampledOut, 'operator.json'))).sampleManifestHash, manifest.manifestHash);
  await assert.rejects(readFile(join(sampledOut, 'sample-manifest.json')), { code: 'ENOENT' });
  await main(['run', '--dir', sampledOut]);
  await main(['import-run', '--dir', sampled, '--file', join(sampledOut, 'run.json')]);
  const replacement = createSampleManifest(await read(join(sampled, 'plan.json')), { seed: 63 });
  await writeFile(join(sampled, 'sample-manifest.json'), JSON.stringify(replacement));
  for (const command of ['sample-packets', 'sample-finalize', 'sample-report', 'import-sample-review']) {
    await assert.rejects(main([command, '--dir', sampled]), /고정한 계획·표본/);
  }
  await writeFile(join(sampled, 'sample-manifest.json'), JSON.stringify(manifest));
  await main(['sample-packets', '--dir', sampled]);
  const altered = structuredClone(manifest); altered.manifestHash = 'tampered';
  await writeFile(join(sampled, 'sample-manifest.json'), JSON.stringify(altered));
  await assert.rejects(main(['export-operator', '--dir', sampled, '--out', await mkdtemp(join(tmpdir(), 'tampered export '))]), /manifest/);
});
test('pending structured human score blocks only the sample report, not the automatic report', async () => {
  const dir = await fixture();
  await main(['automatic-report', '--dir', dir]);
  await main(['sample-packets', '--dir', dir]);
  await main(['sample-finalize', '--dir', dir]);
  await assert.rejects(main(['sample-report', '--dir', dir]), /two distinct|pending/);
  assert.equal((await read(join(dir, 'automatic-report.json'))).items.length, 8);
  await assert.rejects(readFile(join(dir, 'sample-report.json')), { code: 'ENOENT' });
});
test('bad evaluation costs reject before any automatic report writes', async () => {
  const dir = await fixture();
  const plan = await read(join(dir, 'plan.json')), run = await read(join(dir, 'run.json'));
  await writeFile(join(dir, 'code.json'), JSON.stringify({ schemaVersion: 1, type: 'code-preliminary',
    planId: plan.id, runHash: hash(run), criteriaHash: plan.criteriaHash, elapsedMs: -1 }));
  await assert.rejects(main(['automatic-report', '--dir', dir]), /비용/);
  await assert.rejects(readFile(join(dir, 'automatic-report.json')), { code: 'ENOENT' });
});
test('automatic path preserves interrupted AI ledger partial sums without inventing completed scores', async () => {
  const dir = await fixture(), plan = await read(join(dir, 'plan.json')), run = await read(join(dir, 'run.json'));
  const judgeConfig = { model: 'synthetic', options: { temperature: 0 }, think: false };
  const start = { schemaVersion: 1, planId: plan.id, criteriaHash: plan.criteriaHash,
    runHash: hash(run), judgeConfig, startedAt: '2026-10-15T00:00:00Z' };
  await writeFile(join(dir, 'ai-start.json'), JSON.stringify(start));
  await mkdir(join(dir, 'ai-calls'));
  const entry = { planId: plan.id, runHash: hash(run), startHash: hash(start),
    request: { model: judgeConfig.model, options: judgeConfig.options, think: false } };
  await writeFile(join(dir, 'ai-calls/0001.json'), JSON.stringify({ ...entry, state: 'completed',
    result: { elapsedMs: 20, inputTokens: 100, outputTokens: 2 } }));
  await writeFile(join(dir, 'ai-calls/0002.json'), JSON.stringify({ ...entry, state: 'in-flight' }));
  await main(['automatic-report', '--dir', dir]);
  const cost = await read(join(dir, 'automatic-evaluation-cost.json'));
  assert.equal(cost.aiExecution.interrupted, true); assert.equal(cost.ai.calls, null);
  assert.equal(cost.ai.inputTokens.sum, null); assert.equal(cost.ai.inputTokens.partialKnownSum, 100);
  assert.equal(cost.ai.inFlightCalls, 1);
  assert.equal((await read(join(dir, 'automatic-report.json'))).ai.status, 'not-run');
});
test('all generation failures have automatic task zero and no invented human validation judgments', async () => {
  const { dataset, gold } = await loadPilot();
  const plan = makePlan(dataset, gold, { model: 'fixture', options: {}, timeoutMs: 10, retries: 0,
    seed: 62, repeats: 1, runOrder: 'seeded', methods: [{ id: 'prompt-baseline', version: 'fixture' }] });
  const manifest = createSampleManifest(plan);
  const run = await runPlan(plan, { generate: async () => { throw new Error('synthetic timeout'); } });
  const bundle = createSamplePackets(plan, run, manifest);
  const final = finalizeReviews(plan, run, bundle, []);
  const automatic = buildAutomaticReport(plan, run);
  const sample = buildSampleReport(plan, run, manifest, final, automatic);
  assert.equal(automatic.methods[0].primary.value, 0);
  assert.equal(sample.methods[0].event.humanSemanticDate.value, 0);
  assert.equal(sample.graderValidation.codeVsHumanStructured.eligible, 0);
  assert.equal(sample.firstHumanAgreement.byField.date.value, null);
  assert.equal(sample.humanValidationComplete, false);
  assert.equal(sample.humanValidationStatus, 'not-assessable-no-completed-sample');
});
test('AI partial failures stay null with field-level coverage in human sample comparisons', async () => {
  const dir = await fixture(), plan = await read(join(dir, 'plan.json')), run = await read(join(dir, 'run.json'));
  const manifest = await read(join(dir, 'sample-manifest.json'));
  const ai = await aiGrade(plan, run, { judge: async () => ({ date: null, evidence: null, reason: 'synthetic undecidable', events: [] }) });
  const bundle = createSamplePackets(plan, run, manifest);
  const final = finalizeReviews(plan, run, bundle, bundle.packets.flatMap(p => ['A','B'].map(id => review(p, id, 0))));
  const automatic = buildAutomaticReport(plan, run, ai);
  const sample = buildSampleReport(plan, run, manifest, final, automatic);
  assert.equal(sample.graderValidation.aiVsHumanSemantic.date.failed, 3);
  assert.equal(sample.graderValidation.aiVsHumanSemantic.date.counts.human1.failure, 3);
  assert.equal(sample.graderValidation.aiVsHumanSemantic.date.counts.human1.automatic0, 0);
  assert.equal(sample.graderValidation.aiVsHumanSemantic.date.validAgreement.value, null);
  assert.ok(sample.graderValidation.aiVsHumanEventDate.failed >= 3);
  const altered = structuredClone(final); altered.items[0].structuredDate = 1;
  assert.throws(() => buildSampleReport(plan, run, manifest, altered, automatic), /differs/);
  const changed = structuredClone(automatic); changed.items[0].dateScore ^= 1;
  assert.throws(() => buildSampleReport(plan, run, manifest, final, changed), /integrity/);
});
