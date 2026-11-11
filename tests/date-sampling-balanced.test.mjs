import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, makePlan, executionPlan } from '../evals/sejong/date-eval/core.mjs';
import { createSampleManifest, validateSampleManifest, createSamplePackets } from '../evals/sejong/date-eval/sampling.mjs';
import { runPlan } from '../evals/sejong/date-eval/runner.mjs';

const VERSION = 'type-balanced-twelve-v2';
const METHODS = ['rule-baseline', 'prompt-baseline', 'evidence-first', 'render-only', 'evidence-validated'];
const SOURCE = '기사 표제 날짜: 1448년 1월 28일\n본문: 2월 15일에 공사를 시작하였다.';
const QUOTE = '2월 15일에 공사를 시작하였다.';
// Synthetic capacities/answers only. These tests establish sampling plumbing,
// not historical correctness, independent human judgment or real model quality.
function fixture({ counts = [14, 13, 11, 10, 5], articleCount = 20, repeats = 1, methods = METHODS } = {}) {
  let index = 0;
  const cases = counts.flatMap((count, type) => Array.from({ length: count }, () => {
    const id = `Q${String(++index).padStart(3, '0')}`;
    const articleId = `A${String((index - 1) % articleCount + 1).padStart(2, '0')}`;
    return { id, articleId, groupId: articleId, sourceText: SOURCE, question: `합성 ${id}: 공사 시작 날짜는?`,
      kind: type === 4 ? 'control' : 'event', type: `type-${type + 1}`,
      targets: [{ id: 'start', label: '공사 시작' }] };
  }));
  const dataset = { version: 'synthetic-20-articles-53-questions', split: 'final', cases };
  const gold = { version: 'synthetic-balanced-gold', criteriaVersion: 'synthetic-balanced-criteria',
    datasetHash: hash(dataset), reviewStatus: 'approved', reviewedBy: ['synthetic-reviewer'],
    rubric: { date: 'Synthetic rubric', evidence: 'Synthetic rubric' },
    cases: cases.map(c => ({ id: c.id, category: c.type, events: [{ id: 'start',
      expected: { year: 1448, month: 2, day: 15, calendar: 'lunar' }, required: ['month', 'day'],
      allowedOmissions: ['year', 'calendar'], requiresUnknownDay: false,
      eligibility: { unsupportedDay: false, missingKnownDay: true, headerConfusion: true },
      evidence: [{ quote: QUOTE, start: SOURCE.indexOf(QUOTE), end: SOURCE.length }] }] })) };
  return makePlan(dataset, gold, { model: 'synthetic-no-network', options: {}, timeoutMs: 1000,
    retries: 0, repeats, warmup: false, seed: 62, runOrder: 'seeded',
    methods: methods.map(id => ({ id, version: 'synthetic' })) });
}
function rebuild(plan, edit) {
  const dataset = structuredClone(plan.dataset), gold = structuredClone(plan.gold), config = structuredClone(plan.config);
  edit({ dataset, gold, config });
  gold.datasetHash = hash(dataset);
  return makePlan(dataset, gold, config);
}
function rehash(manifest) {
  const payload = { ...manifest };
  delete payload.manifestHash;
  return { ...payload, manifestHash: hash(payload) };
}
function assertCoverage(plan, manifest) {
  const counts = Object.fromEntries(Object.keys(manifest.questionTypes.available).map(type => [type, 0]));
  const articles = new Set();
  for (const id of manifest.caseIds) {
    const c = plan.dataset.cases.find(c => c.id === id), g = plan.gold.cases.find(g => g.id === id);
    counts[(g.category ?? c.type ?? 'unspecified').trim()]++;
    articles.add(c.articleId);
  }
  assert.deepEqual(manifest.questionTypes.selected, counts);
  assert.deepEqual(manifest.questionTypes.quotas, counts);
  assert.equal(manifest.selectedArticleCount, articles.size);
  assert.equal(new Set(manifest.caseIds).size, manifest.caseIds.length);
  assert.deepEqual(manifest.caseIds, [...manifest.caseIds].sort());
  assert.equal(manifest.plannedOutputs, manifest.caseIds.length * plan.config.methods.length * plan.config.repeats);
  assert.deepEqual(manifest.methodOutputCounts, Object.fromEntries(plan.config.methods.map(m =>
    [m.id, manifest.caseIds.length * plan.config.repeats]).sort(([a], [b]) => a.localeCompare(b))));
}
const answer = JSON.stringify({ answer: '공사는 2월 15일에 시작하였다.', events: [{ id: 'start',
  date: { year: 1448, month: 2, day: 15, calendar: 'lunar' }, unknownDay: false,
  evidence: [{ quote: QUOTE, start: SOURCE.indexOf(QUOTE), end: SOURCE.length }] }] });

test('default v2 fixes 12 balanced questions and 60 outputs from 20 articles/53 questions/five methods', () => {
  const plan = fixture(), before = JSON.stringify(plan), manifest = createSampleManifest(plan);
  assert.equal(plan.dataset.cases.length, 53);
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.seed, 62);
  assert.equal(manifest.questionBudget, 12);
  assert.equal(manifest.articleCount, 20);
  assert.equal(manifest.caseIds.length, 12);
  assert.equal(manifest.plannedOutputs, 60);
  assert.equal(manifest.selectedArticleCount, 12);
  assert.deepEqual(manifest.candidateIds, plan.dataset.cases.map(c => c.id).sort());
  assert.deepEqual(manifest.questionTypes.available, { 'type-1': 14, 'type-2': 13, 'type-3': 11, 'type-4': 10, 'type-5': 5 });
  // seed 62 SHA-256 type ranks give the two extra seats to type-3 and type-1.
  assert.deepEqual(manifest.questionTypes.quotas, { 'type-1': 3, 'type-2': 2, 'type-3': 3, 'type-4': 2, 'type-5': 2 });
  assert.ok(Object.values(manifest.questionTypes.selected).every(n => n === 2 || n === 3));
  assertCoverage(plan, manifest);
  const { manifestHash, ...payload } = manifest;
  assert.equal(manifestHash, hash(payload));
  for (const value of [manifest, manifest.caseIds, manifest.candidateIds, manifest.eligibility,
    manifest.eligibility.kinds, manifest.questionTypes, manifest.questionTypes.available,
    manifest.questionTypes.selected, manifest.questionTypes.quotas, manifest.methodOutputCounts]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => { manifest.questionTypes.quotas['type-1'] = 0; }, TypeError);
  assert.throws(() => { manifest.methodOutputCounts['rule-baseline'] = 0; }, TypeError);
  assert.equal(JSON.stringify(plan), before);
  assert.equal(validateSampleManifest(plan, manifest), manifest);
  const disk = JSON.parse(JSON.stringify(manifest));
  assert.equal(validateSampleManifest(plan, disk), disk);
  assert.deepEqual(createSampleManifest(plan, { version: VERSION, seed: 62 }), manifest);
  assert.throws(() => createSampleManifest(executionPlan(plan)), /담당자용 계획/);
});

test('v2 is deterministic under reordered questions, gold, methods and execution slots, with exact plan bindings', () => {
  const plan = fixture(), manifest = createSampleManifest(plan);
  assert.deepEqual(createSampleManifest(plan), manifest);
  const slots = structuredClone(plan); slots.slots.reverse();
  assert.deepEqual(createSampleManifest(slots), manifest);
  const reordered = rebuild(plan, ({ dataset, gold, config }) => {
    dataset.cases.reverse(); gold.cases.reverse(); config.methods.reverse();
  });
  const other = createSampleManifest(reordered);
  assert.deepEqual(other.caseIds, manifest.caseIds);
  assert.deepEqual(other.questionTypes, manifest.questionTypes);
  assert.deepEqual(other.methodOutputCounts, manifest.methodOutputCounts);
  assert.equal(other.selectedArticleCount, manifest.selectedArticleCount);
  assert.notEqual(other.planId, manifest.planId);
  assert.throws(() => validateSampleManifest(reordered, manifest), /manifest/);
  const alternate = createSampleManifest(plan, { seed: 63 });
  assert.notDeepEqual(alternate.caseIds, manifest.caseIds);
  assert.equal(validateSampleManifest(plan, alternate), alternate);
});

test('water-fill includes singleton and scarce types and redistributes unavailable quota seats', () => {
  for (const [capacities, quotas] of [
    [[1, 1, 20, 20, 20], [1, 1, 4, 3, 3]],
    [[1, 2, 20, 20, 20], [1, 2, 3, 3, 3]],
    [[1, 1, 1, 1, 20], [1, 1, 1, 1, 8]],
  ]) {
    const plan = fixture({ counts: capacities }), manifest = createSampleManifest(plan);
    assert.deepEqual(manifest.questionTypes.quotas, Object.fromEntries(quotas.map((n, i) => [`type-${i + 1}`, n])));
    assert.equal(manifest.caseIds.length, 12);
    assertCoverage(plan, manifest);
    for (const c of plan.dataset.cases.filter(c => capacities[Number(c.type.slice(5)) - 1] === 1)) {
      assert.ok(manifest.caseIds.includes(c.id), `${c.type} singleton omitted`);
    }
  }
});

test('selection prefers least-used articles within a type before the seeded case hash', () => {
  const plan = rebuild(fixture({ counts: [20] }), ({ dataset }) => {
    dataset.cases.forEach((c, i) => { c.articleId = i < 17 ? 'A' : ['B', 'C', 'D'][i - 17]; c.groupId = c.articleId; });
  });
  const manifest = createSampleManifest(plan);
  const crowded = plan.dataset.cases.filter(c => c.articleId === 'A').sort((a, b) =>
    hash({ seed: 62, articleId: 'A', caseId: a.id }).localeCompare(hash({ seed: 62, articleId: 'A', caseId: b.id })));
  const expected = [...crowded.slice(0, 9), ...plan.dataset.cases.filter(c => c.articleId !== 'A')].map(c => c.id).sort();
  assert.deepEqual(manifest.caseIds, expected);
  assert.equal(manifest.articleCount, 4);
  assert.equal(manifest.selectedArticleCount, 4);
  assertCoverage(plan, manifest);
  const uniqueArticles = fixture({ counts: [20] }), ranked = createSampleManifest(uniqueArticles);
  assert.deepEqual(ranked.caseIds, uniqueArticles.dataset.cases.slice().sort((a, b) =>
    hash({ seed: 62, articleId: a.articleId, caseId: a.id }).localeCompare(hash({ seed: 62, articleId: b.articleId, caseId: b.id })))
    .slice(0, 12).map(c => c.id).sort());
  assert.equal(ranked.selectedArticleCount, 12);
});

test('gold category overrides dataset type and preserves trimming, null fallback and unspecified coverage', () => {
  const plan = rebuild(fixture({ counts: [2, 1, 1, 1, 1] }), ({ dataset, gold }) => {
    gold.cases[0].category = '  authoritative-category  '; dataset.cases[0].type = 'ignored';
    delete gold.cases[1].category; dataset.cases[1].type = '  fallback-category  ';
    gold.cases[2].category = null; delete dataset.cases[2].type;
  });
  const manifest = createSampleManifest(plan);
  assert.equal(manifest.questionTypes.available['authoritative-category'], 1);
  assert.equal(manifest.questionTypes.available['fallback-category'], 1);
  assert.equal(manifest.questionTypes.available.unspecified, 1);
  assert.equal(Object.hasOwn(manifest.questionTypes.available, 'ignored'), false);
  assert.equal(manifest.caseIds.length, 6);
  assertCoverage(plan, manifest);
  for (const category of ['', '   ', 3]) {
    const invalid = rebuild(plan, ({ gold }) => { gold.cases[0].category = category; });
    assert.throws(() => createSampleManifest(invalid), /question type/);
  }
});

test('short datasets select every question and all methods/repeats, including multiple questions from one article', async () => {
  const plan = fixture({ counts: [2, 1, 2, 1, 2], articleCount: 1, repeats: 3 }), manifest = createSampleManifest(plan);
  assert.equal(manifest.questionBudget, 12);
  assert.equal(manifest.caseIds.length, 8);
  assert.deepEqual(manifest.caseIds, plan.dataset.cases.map(c => c.id).sort());
  assert.equal(manifest.articleCount, 1); assert.equal(manifest.selectedArticleCount, 1);
  assert.equal(manifest.plannedOutputs, 120);
  assertCoverage(plan, manifest);
  let calls = 0;
  const run = await runPlan(plan, { generate: async () => { calls++; return { answer }; } });
  const before = calls, bundle = createSamplePackets(plan, run, manifest);
  assert.equal(bundle.packets.length, 120);
  assert.equal(calls, before);
  assert.equal(new Set(bundle.bindings.map(b => b.recordId)).size, 120);
  assert.deepEqual(bundle.bindings.map(b => b.recordId).sort(), run.records.map(r => r.id).sort());
  for (const method of METHODS) assert.equal(manifest.methodOutputCounts[method], 24);
});

test('all five methods/repeats follow the same outcome-free v2 sample without model calls during sampling', async () => {
  const plan = fixture({ repeats: 2 }), manifest = createSampleManifest(plan);
  let calls = 0;
  const run = await runPlan(plan, { generate: async () => { calls++; return { answer }; } });
  const before = calls;
  assert.equal(manifest.plannedOutputs, 120);
  assertCoverage(plan, manifest);
  const bundle = createSamplePackets(plan, run, manifest);
  assert.equal(bundle.packets.length, 120);
  const expectedIds = run.records.filter(r => manifest.caseIds.includes(r.caseId)).map(r => r.id).sort();
  assert.deepEqual(bundle.bindings.map(b => b.recordId).sort(), expectedIds);
  const reverse = structuredClone(run); reverse.records.reverse();
  assert.deepEqual(createSamplePackets(plan, reverse, manifest).bindings.map(b => b.recordId).sort(), expectedIds);
  const failed = await runPlan(plan, { generate: async () => { throw new Error('synthetic complete failure'); } });
  const failures = createSamplePackets(plan, failed, manifest);
  assert.equal(failures.packets.length, 24); // Only the two rule outputs per selected question complete.
  assert.deepEqual(failures.caseIds, bundle.caseIds);
  assert.equal(calls, before);
  assert.deepEqual(createSampleManifest(plan), manifest);
});

test('more question types than the fixed budget blocks explicitly, while exactly twelve types fit', () => {
  const twelve = fixture({ counts: Array(12).fill(1) }), manifest = createSampleManifest(twelve);
  assert.equal(manifest.caseIds.length, 12);
  assert.ok(Object.values(manifest.questionTypes.quotas).every(n => n === 1));
  const thirteen = fixture({ counts: Array(13).fill(1) });
  assert.throws(() => createSampleManifest(thirteen), /budget.*type|type.*budget/);
  const legacy = createSampleManifest(thirteen, { version: 'article-one-v1' });
  assert.equal(legacy.caseIds.length, 13);
  assert.equal(validateSampleManifest(thirteen, legacy), legacy);
});

test('v2 validator rejects rehashed selection, budget, quota, method counts, binding and version tampering', () => {
  const plan = fixture(), manifest = createSampleManifest(plan);
  const unselected = plan.dataset.cases.find(c => !manifest.caseIds.includes(c.id));
  const selectedType = plan.gold.cases.find(g => g.id === unselected.id).category;
  const selected = manifest.caseIds.find(id => plan.gold.cases.find(g => g.id === id).category === selectedType);
  const edits = [
    m => { m.caseIds = m.caseIds.filter(id => id !== selected).concat(unselected.id).sort(); },
    m => { m.caseIds.pop(); }, m => { m.caseIds[0] = m.caseIds[1]; },
    m => { m.caseIds.reverse(); }, m => { m.candidateIds.pop(); },
    m => { m.questionBudget = 13; }, m => { m.questionBudget = 11; },
    m => { delete m.questionBudget; }, m => { m.selectedArticleCount++; }, m => { m.articleCount--; },
    m => { m.plannedOutputs = 59; }, m => { m.methodOutputCounts['rule-baseline']--; },
    m => { m.methodOutputCounts['prompt-baseline']--; m.methodOutputCounts['evidence-first']++; },
    m => { delete m.methodOutputCounts['render-only']; }, m => { m.methodOutputCounts.extra = 0; },
    m => { m.questionTypes.quotas['type-1']--; m.questionTypes.quotas['type-2']++; },
    m => { m.questionTypes.selected['type-1']--; m.questionTypes.selected['type-2']++; },
    m => { m.questionTypes.available['type-1']++; }, m => { delete m.questionTypes.quotas; },
    m => { m.questionTypes.quotas.extra = undefined; }, m => { m.outcomes = { accepted: true }; },
    m => { m.selectionRule = 'outcome-ranked'; }, m => { m.eligibility.kinds = ['event']; },
    m => { m.planId = 'forged'; }, m => { m.datasetHash = 'forged'; }, m => { m.goldHash = 'forged'; },
    m => { m.criteriaHash = 'forged'; }, m => { m.configHash = 'forged'; }, m => { m.schemaVersion = 2; },
    m => { m.seed = 63; }, m => { m.version = 'unknown-version'; }, m => { m.version = 'article-one-v1'; },
    m => { delete m.version; },
  ];
  for (const edit of edits) {
    const altered = structuredClone(manifest); edit(altered);
    assert.throws(() => validateSampleManifest(plan, rehash(altered)), /manifest|version/);
  }
  assert.throws(() => validateSampleManifest(plan, { ...manifest, manifestHash: 'forged' }), /manifest/);
  for (const value of [null, [], 'manifest']) assert.throws(() => validateSampleManifest(plan, value), /manifest/);
  for (const version of ['', 'type-balanced-twelve-v3', null, 2]) {
    assert.throws(() => createSampleManifest(plan, { version }), /version/);
  }
  for (const seed of [-1, 1.5, NaN, Infinity, '62', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createSampleManifest(plan, { seed }), /seed/);
  }
});
