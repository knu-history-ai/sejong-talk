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
function syntheticInputs() {
  const sourceText = '기사 표제 날짜: 1448년 1월 28일\n본문: 2월 15일에 공사를 시작하였다.';
  const quote = '2월 15일에 공사를 시작하였다.';
  let index = 0;
  const cases = [14, 13, 11, 10, 5].flatMap((count, type) => Array.from({ length: count }, () => {
    const id = `Q${String(++index).padStart(3, '0')}`, articleId = `A${String((index - 1) % 20 + 1).padStart(2, '0')}`;
    return { id, articleId, groupId: articleId, sourceText, question: `합성 ${id}: 공사 시작 날짜는?`,
      kind: type === 4 ? 'control' : 'event', type: `type-${type + 1}`, targets: [{ id: 'start', label: '공사 시작' }] };
  }));
  const dataset = { version: 'synthetic-cli-balanced-53', split: 'final', cases };
  const gold = { version: 'synthetic-cli-gold', criteriaVersion: 'synthetic-cli-rubric', datasetHash: hash(dataset),
    reviewStatus: 'approved', reviewedBy: ['synthetic-reviewer'], rubric: { date: 'synthetic', evidence: 'synthetic' },
    cases: cases.map(c => ({ id: c.id, category: c.type, events: [{ id: 'start',
      expected: { year: 1448, month: 2, day: 15, calendar: 'lunar' }, required: ['month', 'day'],
      allowedOmissions: ['year', 'calendar'], requiresUnknownDay: false,
      eligibility: { unsupportedDay: false, missingKnownDay: true, headerConfusion: true },
      evidence: [{ quote, start: sourceText.indexOf(quote), end: sourceText.length }] }] })) };
  const answer = JSON.stringify({ answer: '공사는 2월 15일에 시작하였다.', events: [{ id: 'start',
    date: { year: 1448, month: 2, day: 15, calendar: 'lunar' }, unknownDay: false,
    evidence: [{ quote, start: sourceText.indexOf(quote), end: sourceText.length }] }] });
  return { dataset, gold, answer };
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
  assert.equal(packets.length, 8);
  const manifest = JSON.parse(frozen);
  assert.equal(manifest.version, 'type-balanced-twelve-v2');
  assert.equal(manifest.seed, 62);
  assert.equal(manifest.questionBudget, 12);
  assert.equal(manifest.selectedArticleCount, 3);
  assert.deepEqual(manifest.methodOutputCounts, { 'rule-baseline': 8 });
  assert.deepEqual(manifest.questionTypes.quotas, manifest.questionTypes.available);
  const blanks = await read(join(dir, 'sample-review-share/blank-review.json'));
  assert.equal(blanks[0].structuredDate, null);
  for (const reviewer of ['시연', '선영']) {
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
  assert.equal(sample.scope.selectedQuestions, 8); assert.equal(sample.scope.populationQuestions, 8);
  assert.equal(sample.scope.articleCount, 3); assert.equal(sample.scope.populationArticleCount, 3);
  assert.equal(sample.scope.questionBudget, 12);
  assert.deepEqual(sample.scope.methodOutputCounts, { 'rule-baseline': 8 });
  assert.equal(sample.evaluationVersion, 'sample-audit-v2');
  assert.equal(sample.humanValidationComplete, true); assert.equal(sample.paperEligible, false);
  assert.equal(sample.evaluationCost.total.elapsedMs, 80);
  assert.equal(sample.graderValidation.codeVsHumanStructured.eligible, 8);
  assert.equal(sample.graderValidation.aiVsHumanSemantic, null);
  assert.equal(sample.firstHumanAgreement.byField.date.value, 1);
  await assert.rejects(main(['report', '--dir', dir, '--final', join(dir, 'sample-final.json')]), /sample human/);
  await main(['sample-packets', '--dir', dir]); // identical packet material is safely resumable
  for (const command of ['automatic-report', 'sample-finalize', 'sample-report']) {
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
test('synthetic CLI freezes 60 outputs, exports blind inputs and audits every sampled method without external models', async () => {
  const root = await mkdtemp(join(tmpdir(), 'synthetic balanced cli ')), dir = join(root, 'private'), out = join(root, 'operator');
  const { dataset, gold, answer } = syntheticInputs();
  const methods = ['rule-baseline', 'prompt-baseline', 'evidence-first', 'render-only', 'evidence-validated'];
  await writeFile(join(root, 'dataset.json'), JSON.stringify(dataset));
  await writeFile(join(root, 'gold.json'), JSON.stringify(gold));
  await writeFile(join(root, 'identity.json'), JSON.stringify({ name: 'fixture', digest: 'synthetic-no-model' }));
  await main(['prepare', '--dir', dir, '--dataset', join(root, 'dataset.json'), '--gold', join(root, 'gold.json'),
    '--model', 'fixture', '--model-identity', join(root, 'identity.json'), '--methods', methods.join(',')]);
  for (const [flag, value] of [['--version', 'article-one-v1'], ['--seed', '63']]) {
    await assert.rejects(main(['sample-freeze', '--dir', dir, flag, value]), /알 수 없거나 중복된 옵션/);
  }
  await main(['sample-freeze', '--dir', dir]);
  const frozen = await readFile(join(dir, 'sample-manifest.json'), 'utf8'), manifest = JSON.parse(frozen);
  assert.equal(manifest.version, 'type-balanced-twelve-v2'); assert.equal(manifest.seed, 62);
  assert.equal(manifest.caseIds.length, 12); assert.equal(manifest.plannedOutputs, 60);
  assert.equal(manifest.articleCount, 20); assert.equal(manifest.selectedArticleCount, 12);
  assert.deepEqual(Object.values(manifest.questionTypes.quotas).sort(), [2, 2, 2, 3, 3]);
  assert.ok(Object.values(manifest.methodOutputCounts).every(n => n === 12));
  await assert.rejects(main(['sample-freeze', '--dir', dir]), { code: 'EEXIST' });
  assert.equal(await readFile(join(dir, 'sample-manifest.json'), 'utf8'), frozen);
  await main(['export-operator', '--dir', dir, '--out', out]);
  const publicPlan = await read(join(out, 'plan.json'));
  assert.equal(publicPlan.executionOnly, true); assert.equal(Object.hasOwn(publicPlan, 'gold'), false);
  assert.equal(publicPlan.slots.length, 265);
  assert.equal((await read(join(out, 'operator.json'))).sampleManifestHash, manifest.manifestHash);
  await assert.rejects(readFile(join(out, 'sample-manifest.json')), { code: 'ENOENT' });
  await assert.rejects(main(['sample-freeze', '--dir', dir]), /전달한 뒤/);
  // Inject the generator directly into runPlan; CLI import/audit paths use the
  // real exported plan and recorded prompts, with no fetch/model invocation.
  let calls = 0;
  const ledger = [];
  await mkdir(join(out, 'generation-calls'));
  const run = await runPlan(publicPlan, { generate: async (request, _config, context) => {
    const result = { answer, inputTokens: 2, outputTokens: 3, finishReason: 'stop', elapsedMs: 0,
      raw: JSON.stringify({ done: true, done_reason: 'stop', response: answer, prompt_eval_count: 2, eval_count: 3 }) };
    const entry = { schemaVersion: 1, planId: publicPlan.id, callId: ++calls, context, request, state: 'completed', result };
    ledger.push(entry);
    await writeFile(join(out, 'generation-calls', String(calls).padStart(4, '0') + '.json'), JSON.stringify(entry));
    return result;
  } });
  run.generationLedger = ledger;
  run.modelVerification = { before: publicPlan.config.modelIdentity, after: publicPlan.config.modelIdentity };
  assert.equal(run.records.length, 265); assert.ok(run.records.every(r => r.state === 'completed'));
  assert.equal(calls, 159); // P once and E twice per population question; R/T/V make no calls.
  await writeFile(join(out, 'run.json'), JSON.stringify(run));
  await main(['import-run', '--dir', dir, '--file', join(out, 'run.json')]);
  const original = await readFile(join(dir, 'run.json'), 'utf8'), beforeCalls = calls;
  await main(['automatic-report', '--dir', dir]);
  assert.equal((await read(join(dir, 'automatic-report.json'))).items.length, 265);
  await main(['sample-packets', '--dir', dir]);
  const packets = await read(join(dir, 'sample-review-share/packets.json'));
  assert.equal(packets.length, 60);
  const visible = JSON.stringify(packets);
  for (const secret of ['methodId', 'recordId', 'category', 'configHash']) assert.ok(!visible.includes(secret), secret);
  const bundle = await read(join(dir, 'sample-review-private.json'));
  assert.deepEqual(bundle.caseIds, manifest.caseIds);
  assert.deepEqual(bundle.bindings.map(b => b.recordId).sort(),
    run.records.filter(r => manifest.caseIds.includes(r.caseId)).map(r => r.id).sort());
  for (const reviewer of ['syntheticA', 'syntheticB']) {
    const file = join(root, `${reviewer}.json`);
    await writeFile(file, JSON.stringify(packets.map(p => review(p, reviewer))));
    await main(['import-sample-review', '--dir', dir, '--file', file, '--reviewer', reviewer]);
  }
  await main(['sample-finalize', '--dir', dir]);
  assert.equal((await read(join(dir, 'sample-final.json'))).items.length, 60);
  await main(['sample-report', '--dir', dir]);
  const report = await read(join(dir, 'sample-report.json'));
  assert.equal(report.scope.selectedQuestions, 12); assert.equal(report.scope.selectedPlannedOutputs, 60);
  assert.equal(report.scope.populationQuestions, 53); assert.equal(report.scope.populationPlannedOutputs, 265);
  assert.equal(report.scope.articleCount, 12); assert.equal(report.scope.populationArticleCount, 20);
  assert.equal(report.scope.questionBudget, 12);
  assert.deepEqual(report.scope.methodOutputCounts, manifest.methodOutputCounts);
  assert.deepEqual(report.scope.questionTypes, manifest.questionTypes);
  assert.equal(report.manifestHash, manifest.manifestHash); assert.equal(report.manifestDocumentHash, hash(manifest));
  assert.equal(report.evaluationVersion, 'sample-audit-v2'); assert.equal(report.paperEligible, false);
  assert.equal(report.humanValidationComplete, true);
  assert.equal(report.graderValidation.codeVsHumanStructured.eligible, 60);
  assert.equal(report.evaluationCost.total.elapsedMs, 600);
  for (const method of report.methods) {
    assert.equal(method.event.planned + method.control.planned, 12);
    for (const [type, quota] of Object.entries(manifest.questionTypes.quotas)) {
      assert.equal(method.byQuestionType[type].event.planned + method.byQuestionType[type].control.planned, quota);
    }
  }
  await main(['sample-packets', '--dir', dir]);
  for (const command of ['automatic-report', 'sample-finalize', 'sample-report']) {
    await assert.rejects(main([command, '--dir', dir]), { code: 'EEXIST' });
  }
  assert.equal(calls, beforeCalls);
  assert.equal(await readFile(join(dir, 'run.json'), 'utf8'), original);
  assert.equal(await readFile(join(dir, 'sample-manifest.json'), 'utf8'), frozen);
});
test('existing v1 manifest bytes survive export, imported execution and all later sample audits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'legacy sample cli ')), out = await mkdtemp(join(tmpdir(), 'legacy operator '));
  await main(['prepare', '--dir', dir, '--model', 'fixture', '--methods', 'rule-baseline']);
  const manifest = createSampleManifest(await read(join(dir, 'plan.json')), { version: 'article-one-v1' });
  const frozen = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(join(dir, 'sample-manifest.json'), frozen);
  await assert.rejects(main(['sample-freeze', '--dir', dir]), { code: 'EEXIST' });
  await main(['export-operator', '--dir', dir, '--out', out]);
  await main(['run', '--dir', out]);
  await main(['import-run', '--dir', dir, '--file', join(out, 'run.json')]);
  await main(['automatic-report', '--dir', dir]);
  await main(['sample-packets', '--dir', dir]);
  const packets = await read(join(dir, 'sample-review-share/packets.json'));
  assert.equal(packets.length, 3);
  for (const reviewer of ['legacyA', 'legacyB']) {
    const file = join(dir, `${reviewer}.json`);
    await writeFile(file, JSON.stringify(packets.map(p => review(p, reviewer))));
    await main(['import-sample-review', '--dir', dir, '--file', file, '--reviewer', reviewer]);
  }
  await main(['sample-finalize', '--dir', dir]);
  await main(['sample-report', '--dir', dir]);
  const report = await read(join(dir, 'sample-report.json'));
  assert.equal(report.evaluationVersion, 'sample-audit-v1'); assert.equal(report.scope.selectionVersion, 'article-one-v1');
  assert.equal(report.scope.selectedQuestions, 3); assert.equal(report.scope.selectedPlannedOutputs, 3);
  assert.equal(report.scope.articleCount, 3); assert.equal(report.scope.populationArticleCount, 3);
  assert.equal(Object.hasOwn(report.scope, 'questionBudget'), false);
  assert.equal(Object.hasOwn(report.scope, 'methodOutputCounts'), false);
  assert.equal(await readFile(join(dir, 'sample-manifest.json'), 'utf8'), frozen);
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
  assert.equal(sample.graderValidation.aiVsHumanSemantic.date.failed, 8);
  assert.equal(sample.graderValidation.aiVsHumanSemantic.date.counts.human1.failure, 8);
  assert.equal(sample.graderValidation.aiVsHumanSemantic.date.counts.human1.automatic0, 0);
  assert.equal(sample.graderValidation.aiVsHumanSemantic.date.validAgreement.value, null);
  assert.equal(sample.graderValidation.aiVsHumanEventDate.failed, 9);
  const altered = structuredClone(final); altered.items[0].structuredDate = 1;
  assert.throws(() => buildSampleReport(plan, run, manifest, altered, automatic), /differs/);
  const changed = structuredClone(automatic); changed.items[0].dateScore ^= 1;
  assert.throws(() => buildSampleReport(plan, run, manifest, final, changed), /integrity/);
});
