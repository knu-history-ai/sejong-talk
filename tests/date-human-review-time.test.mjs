import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, makePlan } from '../evals/sejong/date-eval/core.mjs';
import { createReviewPackets, finalizeReviews, validateFinalAudit } from '../evals/sejong/date-eval/grading.mjs';
import { createSampleManifest, createSamplePackets, validateSampleFinal } from '../evals/sejong/date-eval/sampling.mjs';
import { humanCost } from '../evals/sejong/date-eval/costs.mjs';
import { main } from '../evals/sejong/date-eval/cli.mjs';

// Synthetic sources, dates and judgments only; no pilot/final files or model calls.
function fixture(sample = false) {
  const cases = [1, 2].map(n => ({ id: `case-${n}`, articleId: `article-${n}`, groupId: `group-${n}`,
    kind: 'event', type: 'known-day', sourceText: '2000년 3월 10일에 모의 공사를 시작했다.',
    question: '모의 공사 시작 날짜는?', targets: [{ id: 'start', label: '모의 공사 시작' }] }));
  const dataset = { version: 'synthetic-review-time-v1', split: 'pilot', cases };
  const gold = { version: 'synthetic-v1', criteriaVersion: 'synthetic-v1', reviewStatus: 'draft',
    datasetHash: hash(dataset), cases: cases.map(c => ({ id: c.id, events: [{ id: 'start',
      expected: { year: 2000, month: 3, day: 10, calendar: 'lunar' }, required: ['month', 'day'],
      eligibility: { unsupportedDay: false, missingKnownDay: true, headerConfusion: true },
      evidence: [{ quote: c.sourceText, start: 0, end: c.sourceText.length }] }] })) };
  const plan = makePlan(dataset, gold, { model: 'synthetic', options: { temperature: 0 },
    timeoutMs: 1000, retries: 0, repeats: 1, seed: 62, warmup: false, runOrder: 'seeded',
    methods: [{ id: 'rule-baseline', version: 'synthetic-v1' }] });
  const run = { schemaVersion: 1, planId: plan.id, datasetHash: plan.datasetHash, goldHash: plan.goldHash,
    criteriaHash: plan.criteriaHash, configHash: plan.configHash, environment: { synthetic: true },
    records: plan.slots.map(slot => {
      const c = cases.find(c => c.id === slot.caseId);
      return { ...slot, state: 'completed', rawAnswer: '모의 공사는 3월 10일에 시작했다.',
        rawInput: [{ sourceText: c.sourceText, question: c.question, targets: c.targets }],
        elapsedMs: 1, calls: 0, inputTokens: 0, outputTokens: 0, attempts: [] };
    }) };
  const manifest = sample ? createSampleManifest(plan) : null;
  const bundle = sample ? createSamplePackets(plan, run, manifest) : createReviewPackets(plan, run);
  const reviews = bundle.packets.flatMap(p => ['A', 'B'].map(reviewerId => ({
    packetId: p.id, packetHash: p.hash, reviewerId, independent: true, blind: true,
    ...judgment(), ...(sample ? { structuredDate: 1, structuredReason: '합성 구조화 판정' } : {}),
  })));
  return { plan, run, bundle, manifest, reviews, sample };
}
function judgment(date = 1) {
  return { date, evidence: 1, reason: '합성 판정', events: [{ id: 'start', date,
    unsupportedDay: null, missingKnownDay: 0, headerConfusion: 0,
    reasons: { date: '합성 날짜 근거', missingKnownDay: '합성 일자 근거', headerConfusion: '합성 표제 근거' } }] };
}
function disagreement(f) {
  const reviews = structuredClone(f.reviews);
  const first = reviews.filter(r => r.packetId === reviews[0].packetId);
  Object.assign(first[1], judgment(0));
  const resolution = { packetId: first[0].packetId, packetHash: first[0].packetHash,
    reviewerIds: first.map(r => r.reviewerId), firstReviewHashes: first.map(hash), ...judgment(),
    ...(f.sample ? { structuredDate: 1, structuredReason: '합성 구조화 합의' } : {}) };
  return { reviews, resolution };
}
const invalidTimes = ['1000', '', -1, NaN, Infinity, -Infinity, true, false, {}, [], new Number(1), 1n];
const validTimes = [{}, { elapsedMs: undefined }, { elapsedMs: null }, { elapsedMs: 0 }, { elapsedMs: 1000.25 }];

for (const sample of [false, true]) {
  const scope = sample ? 'sample' : 'full';
  test(`${scope}: first and adjudicated reviews reject malformed elapsedMs before finalization`, () => {
    const f = fixture(sample), before = structuredClone(f);
    const { reviews, resolution } = disagreement(f);
    for (const elapsedMs of invalidTimes) {
      assert.throws(() => finalizeReviews(f.plan, f.run, f.bundle,
        [{ ...f.reviews[0], elapsedMs }, ...f.reviews.slice(1)]), /elapsedMs/);
      assert.throws(() => finalizeReviews(f.plan, f.run, f.bundle, reviews,
        [{ ...resolution, elapsedMs }]), /elapsedMs/);
    }
    assert.deepEqual(f, before);
  });

  test(`${scope}: legacy unmeasured and finite measured reviews retain scores, audits and cost semantics`, () => {
    const f = fixture(sample), original = structuredClone(f);
    const baseline = finalizeReviews(f.plan, f.run, f.bundle, f.reviews);
    const { reviews, resolution } = disagreement(f);
    for (const time of validTimes) {
      const entries = f.reviews.map(r => ({ ...r, ...time }));
      const final = finalizeReviews(f.plan, f.run, f.bundle, entries);
      assert.deepEqual(final.items, baseline.items);
      assert.deepEqual(final.agreement.details.flatMap(d => d.firstReviews),
        baseline.agreement.details.flatMap(d => d.firstReviews).map(r => ({ ...r, ...time })));
      const resolved = finalizeReviews(f.plan, f.run, f.bundle, reviews, [{ ...resolution, ...time }]);
      assert.ok(resolved.items.every(i => i.state === 'final'));
      if (sample) {
        validateSampleFinal(f.plan, f.run, f.manifest, final);
        validateSampleFinal(f.plan, f.run, f.manifest, resolved);
      } else {
        validateFinalAudit(f.plan, f.run, final);
        validateFinalAudit(f.plan, f.run, resolved);
      }
      const cost = humanCost([...entries, { ...resolution, ...time }]);
      assert.equal(cost.elapsedMs, time.elapsedMs == null ? null : time.elapsedMs * (entries.length + 1));
      assert.equal(cost.measured, time.elapsedMs == null ? 0 : entries.length + 1);
    }
    assert.deepEqual(humanCost([{ elapsedMs: 10 }, {}, { elapsedMs: null }]), {
      elapsedMs: null, partialKnownSumMs: 10, measured: 1, total: 3,
      status: '검토자별 실제 작업 시간 합계. 미기록은 0이 아님. 독립 판정과 합의 시간 별도 입력.',
    });
    assert.deepEqual(f, original);
  });
}

async function writeJson(path, value) { await writeFile(path, JSON.stringify(value)); }
async function snapshot(dir) {
  const contents = {};
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    contents[entry.name] = entry.isDirectory()
      ? await snapshot(join(dir, entry.name)) : (await readFile(join(dir, entry.name))).toString('base64');
  }
  return contents;
}
async function cliFixture(t, sample) {
  const f = fixture(sample);
  const dir = await mkdtemp(join(tmpdir(), 'date-human-review-time-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeJson(join(dir, 'plan.json'), f.plan);
  await writeJson(join(dir, 'run.json'), f.run);
  if (sample) await writeJson(join(dir, 'sample-manifest.json'), f.manifest);
  await writeJson(join(dir, sample ? 'sample-review-private.json' : 'review-private.json'), f.bundle);
  return { ...f, dir };
}

for (const sample of [false, true]) {
  const scope = sample ? 'sample' : 'full';
  const importCommand = sample ? 'import-sample-review' : 'import-review';
  const finalizeCommand = sample ? 'sample-finalize' : 'finalize';
  test(`${scope} CLI: invalid review batch saves no files and permits corrected first submission`, async t => {
    const f = await cliFixture(t, sample);
    const file = join(f.dir, 'incoming.json');
    const entries = f.reviews.filter(r => r.reviewerId === 'A');
    for (const elapsedMs of ['1000', -1, false, {}, []]) {
      // The first item is valid: rejection must not leave a partially saved batch.
      await writeJson(file, [entries[0], { ...entries[1], elapsedMs }]);
      const before = await snapshot(f.dir);
      await assert.rejects(main([importCommand, '--dir', f.dir, '--reviewer', 'A', '--file', file]), /elapsedMs/);
      assert.deepEqual(await snapshot(f.dir), before);
    }
    await writeJson(file, entries);
    await main([importCommand, '--dir', f.dir, '--reviewer', 'A', '--file', file]);
    const reviewDir = join(f.dir, sample ? 'sample-reviews' : 'reviews');
    const names = await readdir(reviewDir);
    assert.equal(names.length, 1);
    assert.deepEqual(JSON.parse(await readFile(join(reviewDir, names[0]), 'utf8')), entries);
    const before = await snapshot(f.dir);
    await assert.rejects(main([importCommand, '--dir', f.dir, '--reviewer', 'A', '--file', file]), /덮어쓸 수 없습니다/);
    assert.deepEqual(await snapshot(f.dir), before);
  });

  test(`${scope} CLI: invalid adjudication saves no files and preserves original reviews and run`, async t => {
    const f = await cliFixture(t, sample);
    const { reviews, resolution } = disagreement(f);
    for (const reviewer of ['A', 'B']) {
      const file = join(f.dir, `${reviewer}.json`);
      await writeJson(file, reviews.filter(r => r.reviewerId === reviewer));
      await main([importCommand, '--dir', f.dir, '--reviewer', reviewer, '--file', file]);
    }
    const file = join(f.dir, 'adjudications.json');
    for (const elapsedMs of ['1000', -1, false, {}, []]) {
      await writeJson(file, [{ ...resolution, elapsedMs }]);
      const before = await snapshot(f.dir);
      await assert.rejects(main([finalizeCommand, '--dir', f.dir, '--adjudications', file]), /elapsedMs/);
      assert.deepEqual(await snapshot(f.dir), before);
    }
    await writeJson(file, [{ ...resolution, elapsedMs: 0 }]);
    const originalRun = await readFile(join(f.dir, 'run.json'), 'utf8');
    const reviewDir = join(f.dir, sample ? 'sample-reviews' : 'reviews');
    const originalReviews = await snapshot(reviewDir);
    await main([finalizeCommand, '--dir', f.dir, '--adjudications', file]);
    const final = JSON.parse(await readFile(join(f.dir, sample ? 'sample-final.json' : 'final.json'), 'utf8'));
    assert.ok(final.items.every(i => i.state === 'final'));
    assert.equal(final.agreement.details.find(d => d.adjudication)?.adjudication.elapsedMs, 0);
    assert.equal(await readFile(join(f.dir, 'run.json'), 'utf8'), originalRun);
    assert.deepEqual(await snapshot(reviewDir), originalReviews);
  });
}
