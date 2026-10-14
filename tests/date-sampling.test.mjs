import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, makePlan, executionPlan } from '../evals/sejong/date-eval/core.mjs';
import { createReviewPackets, finalizeReviews, validateFinalAudit } from '../evals/sejong/date-eval/grading.mjs';
import { createSampleManifest, validateSampleManifest, createSamplePackets, validateSampleFinal } from '../evals/sejong/date-eval/sampling.mjs';
import { runPlan } from '../evals/sejong/date-eval/runner.mjs';

// Entirely synthetic: reviewer labels test plumbing, never historical correctness
// or real human independence. No private dataset/gold files or model calls.
function fixture({ onePerArticle = false, repeats = 2, methods = ['strong', 'rule'] } = {}) {
  const sourceText = '기사 표제 날짜: 1448년 1월 28일\n본문: 2월 15일에 공사를 시작하였다.';
  const quote = '2월 15일에 공사를 시작하였다.';
  const cases = ['A', 'B', 'C'].flatMap((articleId, article) =>
    Array.from({ length: onePerArticle ? 1 : [3, 4, 1][article] }, (_, i) => ({
      id: `${articleId}${i + 1}`, articleId, groupId: articleId, sourceText,
      question: `합성 질문 ${articleId}${i + 1}: 공사 시작 날짜는?`, kind: 'event',
      type: ['known-day', 'false-date-premise', 'mixed-events', 'unknown-day'][i],
      targets: [{ id: 'start', label: '공사 시작' }], privateCase: 'SECRET case metadata',
    })));
  const dataset = { version: 'synthetic-sample', split: 'pilot', cases };
  const gold = { version: 'synthetic-gold', criteriaVersion: 'synthetic-criteria', datasetHash: hash(dataset),
    reviewStatus: 'draft', reviewedBy: [], rubric: { date: 'Synthetic date rubric', evidence: 'Synthetic evidence rubric' },
    cases: cases.map(c => ({ id: c.id, category: c.type, privateCaseGold: 'SECRET case gold metadata', events: [{
      id: 'start', expected: { year: 1448, month: 2, day: 15, calendar: 'lunar' },
      required: ['month', 'day'], allowedOmissions: ['year', 'calendar'], requiresUnknownDay: false,
      eligibility: { unsupportedDay: false, missingKnownDay: true, headerConfusion: true },
      evidence: [{ quote, start: sourceText.indexOf(quote), end: sourceText.length }],
      privateGold: 'SECRET gold metadata',
    }] })) };
  const plan = makePlan(dataset, gold, { model: 'SECRET model', endpoint: 'SECRET endpoint',
    options: { temperature: 0, privateOption: 'SECRET option' }, timeoutMs: 1000, retries: 0,
    repeats, warmup: false, seed: 62, runOrder: 'seeded', methods: methods.map(id => ({ id, version: 'synthetic' })) });
  const run = { schemaVersion: 1, planId: plan.id, datasetHash: plan.datasetHash, goldHash: plan.goldHash,
    criteriaHash: plan.criteriaHash, configHash: plan.configHash, environment: { hardware: 'synthetic' },
    records: plan.slots.map(s => ({ ...s, state: 'completed',
      rawAnswer: '공사는 2월 15일에 시작하였다. 근거: 2월 15일에 공사를 시작하였다.',
      rawInput: 'SECRET prompt', aiJudgment: 'SECRET AI judgment', elapsedMs: 1, calls: 1,
      inputTokens: null, outputTokens: null, attempts: [] })) };
  return { plan, run };
}
function judgment(events, { structuredDate = 1, date = 1, evidence = 1 } = {}) {
  return { structuredDate, structuredReason: 'Independently compared JSON date fields to frozen gold',
    date, evidence, reason: 'Independently compared answer meaning and evidence to synthetic source',
    events: events.map(e => ({ id: e.id, date,
      ...Object.fromEntries(Object.entries(e.eligibility).map(([f, eligible]) => [f, eligible ? 0 : null])),
      reasons: { date: 'Date meaning matches', unsupportedDay: 'No unsupported day',
        missingKnownDay: 'Required day retained', headerConfusion: 'Header distinguished' } })) };
}
function setup(plan, run, manifest = createSampleManifest(plan), options) {
  const bundle = createSamplePackets(plan, run, manifest);
  const reviews = bundle.packets.flatMap(p => ['alice', 'bob'].map(reviewerId => ({
    packetId: p.id, packetHash: p.hash, reviewerId, independent: true, blind: true,
    ...judgment(p.input.gold.events, options) })));
  return { manifest, bundle, reviews };
}
function resolution(bundle, reviews, options) {
  const packet = bundle.packets[0];
  const first = reviews.filter(r => r.packetId === packet.id);
  return { packetId: packet.id, packetHash: packet.hash, reviewerIds: first.map(r => r.reviewerId),
    firstReviewHashes: first.map(hash), ...judgment(packet.input.gold.events, options),
    reason: 'Both reviewers rechecked the semantic and structured scores independently' };
}

test('manifest uses sorted seeded article hash ranks, reports coverage and deeply freezes JSON', () => {
  const { plan } = fixture(), before = JSON.stringify(plan);
  const manifest = createSampleManifest(plan);
  const expected = ['A', 'B', 'C'].map(articleId => plan.dataset.cases.filter(c => c.articleId === articleId)
    .sort((a, b) => hash({ seed: 62, articleId, caseId: a.id }).localeCompare(hash({ seed: 62, articleId, caseId: b.id })))[0].id).sort();
  assert.deepEqual(manifest.caseIds, expected);
  assert.equal(manifest.articleCount, 3);
  assert.equal(manifest.plannedOutputs, 12);
  assert.equal(manifest.version, 'article-one-v1');
  assert.equal(manifest.type, 'date-sample-manifest');
  assert.deepEqual(manifest.questionTypes.available, { 'false-date-premise': 2, 'known-day': 3, 'mixed-events': 2, 'unknown-day': 1 });
  assert.equal(Object.values(manifest.questionTypes.selected).reduce((n, v) => n + v, 0), 3);
  assert.deepEqual(Object.keys(manifest.questionTypes.available), Object.keys(manifest.questionTypes.selected));
  assert.deepEqual(createSampleManifest(plan), manifest);
  assert.equal(validateSampleManifest(plan, manifest), manifest);
  assert.throws(() => createSampleManifest(executionPlan(plan)), /담당자용 계획/);
  assert.deepEqual(manifest.candidateIds, plan.dataset.cases.map(c => c.id).sort());
  assert.deepEqual(manifest.eligibility, { kinds: ['control', 'event'], rule: 'all-questions-no-outcomes' });
  const { manifestHash, ...payload } = manifest;
  assert.equal(manifestHash, hash(payload));
  for (const value of [manifest, manifest.caseIds, manifest.candidateIds, manifest.eligibility, manifest.eligibility.kinds,
    manifest.questionTypes, manifest.questionTypes.available, manifest.questionTypes.selected]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => manifest.caseIds.push('A2'), TypeError);
  assert.equal(JSON.stringify(plan), before);
  assert.ok(!JSON.stringify(manifest).includes('SECRET'));
  assert.equal(validateSampleManifest(plan, JSON.parse(JSON.stringify(manifest))).type, 'date-sample-manifest');
});

test('selection survives reordered cases/methods/slots while preserving each exact plan binding', () => {
  const { plan } = fixture(), manifest = createSampleManifest(plan);
  const shuffledSlots = structuredClone(plan); shuffledSlots.slots.reverse();
  assert.deepEqual(createSampleManifest(shuffledSlots), manifest);
  const dataset = structuredClone(plan.dataset), gold = structuredClone(plan.gold), config = structuredClone(plan.config);
  dataset.cases.reverse(); gold.cases.reverse(); config.methods.reverse(); gold.datasetHash = hash(dataset);
  const reordered = makePlan(dataset, gold, config), other = createSampleManifest(reordered);
  assert.deepEqual(other.caseIds, manifest.caseIds);
  assert.deepEqual(other.questionTypes, manifest.questionTypes);
  assert.equal(other.plannedOutputs, manifest.plannedOutputs);
  assert.notEqual(other.planId, manifest.planId);
  assert.throws(() => validateSampleManifest(reordered, manifest), /manifest/);
});

test('manifest validator rejects altered deterministic fields, bindings, extra outcomes and invalid seeds', () => {
  const { plan } = fixture(), manifest = createSampleManifest(plan);
  for (const [field, value] of Object.entries({ schemaVersion: 2, type: 'other', planId: 'bad',
    datasetHash: 'bad', goldHash: 'bad', criteriaHash: 'bad', configHash: 'bad', version: 'other',
    caseIds: [], articleCount: 4, candidateIds: [], eligibility: {}, selectionRule: 'other',
    questionTypes: {}, plannedOutputs: 1, outcomes: [1], manifestHash: 'bad' })) {
    assert.throws(() => validateSampleManifest(plan, { ...structuredClone(manifest), [field]: value }), /manifest/);
  }
  const unselected = plan.dataset.cases.find(c => !manifest.caseIds.includes(c.id));
  const changed = structuredClone(manifest);
  changed.caseIds = [...manifest.caseIds.filter(id => !id.startsWith(unselected.articleId)), unselected.id].sort();
  assert.throws(() => validateSampleManifest(plan, changed), /manifest/);
  const extraUndefined = structuredClone(manifest); extraUndefined.questionTypes.selected.extra = undefined;
  assert.throws(() => validateSampleManifest(plan, extraUndefined), /manifest/);
  for (const seed of [-1, 1.5, NaN, Infinity, '62', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createSampleManifest(plan, { seed }), /seed/);
  }
  let seed = 63;
  while (hash(createSampleManifest(plan, { seed }).caseIds) === hash(manifest.caseIds)) seed++;
  assert.throws(() => validateSampleManifest(plan, { ...manifest, seed }), /manifest/);
});

test('private manifest coverage follows trimmed gold categories, then dataset types and unspecified', () => {
  const { plan } = fixture(), dataset = structuredClone(plan.dataset), gold = structuredClone(plan.gold);
  gold.cases[0].category = '  gold-known-day  ';
  delete gold.cases[1].category;
  gold.cases[2].category = null; delete dataset.cases[2].type;
  dataset.cases[2].kind = 'control'; gold.datasetHash = hash(dataset);
  const modified = makePlan(dataset, gold, plan.config), manifest = createSampleManifest(modified);
  assert.equal(manifest.questionTypes.available['gold-known-day'], 1);
  assert.equal(manifest.questionTypes.available['false-date-premise'], 2);
  assert.equal(manifest.questionTypes.available.unspecified, 1);
  assert.ok(manifest.candidateIds.includes(dataset.cases[2].id));
  for (const category of ['', '   ', 3]) {
    const invalidGold = structuredClone(gold); invalidGold.cases[0].category = category;
    assert.throws(() => createSampleManifest(makePlan(dataset, invalidGold, plan.config)), /question type/);
  }
  const all = fixture({ onePerArticle: true }).plan, original = createSampleManifest(all);
  // Even an unchanged one-question-per-article selection binds its original seed.
  assert.throws(() => validateSampleManifest(all, { ...original, seed: 63 }), /manifest/);
  const changed = structuredClone(manifest); changed.candidateIds.reverse();
  const payload = structuredClone(changed); delete payload.manifestHash; changed.manifestHash = hash(payload);
  assert.throws(() => validateSampleManifest(modified, changed), /manifest/);
});

test('scoped packets retain every method/repeat and validate nonempty unique existing case IDs', () => {
  const { plan, run } = fixture(), { manifest, bundle, reviews } = setup(plan, run);
  assert.equal(bundle.type, 'sample-review-packets');
  assert.deepEqual(bundle.caseIds, manifest.caseIds);
  assert.equal(bundle.packets.length, manifest.plannedOutputs);
  const final = finalizeReviews(plan, run, bundle, reviews);
  assert.equal(final.type, 'sample-human-final');
  assert.deepEqual(final.caseIds, manifest.caseIds);
  assert.equal(final.items.length, manifest.plannedOutputs);
  assert.equal(final.agreement.details.length, manifest.plannedOutputs);
  assert.equal(validateSampleFinal(plan, run, manifest, final), final);
  for (const caseId of manifest.caseIds) {
    const ids = new Set(final.items.map(i => i.recordId));
    assert.equal(run.records.filter(r => r.caseId === caseId && ids.has(r.id)).length, 4);
  }
  const unsorted = [...manifest.caseIds].reverse();
  assert.deepEqual(createReviewPackets(plan, run, { caseIds: unsorted }).caseIds, manifest.caseIds);
  assert.deepEqual(unsorted, [...manifest.caseIds].reverse());
  for (const caseIds of [[], ['A1', 'A1'], ['missing'], null, 'A1']) {
    assert.throws(() => createReviewPackets(plan, run, { caseIds }), /caseIds/);
  }
});

test('paired P/T/V records and all repeats follow the same sampled questions without extra model calls', async () => {
  const { plan } = fixture({ methods: ['prompt-baseline', 'render-only', 'evidence-validated', 'rule-baseline', 'evidence-first'] });
  let calls = 0;
  const run = await runPlan(plan, { generate: async () => {
    calls++; return { answer: '공사는 2월 15일에 시작하였다. 근거: 2월 15일에 공사를 시작하였다.', inputTokens: 2, outputTokens: 3 };
  } });
  const beforeCalls = calls, { manifest, bundle, reviews } = setup(plan, run);
  assert.equal(manifest.plannedOutputs, 30);
  const final = finalizeReviews(plan, run, bundle, reviews);
  validateSampleFinal(plan, run, manifest, final);
  assert.equal(calls, beforeCalls);
  for (const caseId of manifest.caseIds) for (let repeat = 1; repeat <= 2; repeat++) {
    const selected = run.records.filter(r => r.caseId === caseId && r.repeat === repeat);
    assert.equal(selected.length, 5);
    assert.ok(selected.every(r => final.items.some(i => i.recordId === r.id)));
    const parent = selected.find(r => r.methodId === 'prompt-baseline');
    for (const derived of selected.filter(r => r.derivation)) assert.equal(derived.derivation.parentRecordId, parent.id);
  }
});

test('selected failures have automatic zero on both tracks and receive no human packet', () => {
  const { plan, run } = fixture(), manifest = createSampleManifest(plan);
  const failed = run.records.find(r => manifest.caseIds.includes(r.caseId)); failed.state = 'failed';
  failed.error = 'synthetic failure with partial text';
  const { bundle, reviews } = setup(plan, run, manifest);
  assert.equal(bundle.packets.length, manifest.plannedOutputs - 1);
  assert.ok(!bundle.bindings.some(b => b.recordId === failed.id));
  const final = finalizeReviews(plan, run, bundle, reviews), item = final.items.find(i => i.recordId === failed.id);
  assert.deepEqual([item.state, item.date, item.evidence, item.structuredDate], ['execution-failure', 0, 0, 0]);
  assert.equal(item.events[0].missingKnownDay, null);
  assert.ok(!final.agreement.details.some(d => d.recordId === failed.id));
  assert.equal(validateSampleFinal(plan, run, manifest, final), final);
});

test('all selected failures honestly have zero reviewers and legacy all-failed audit still passes', () => {
  const { plan, run } = fixture(), manifest = createSampleManifest(plan);
  for (const record of run.records) record.state = 'failed';
  const { bundle, reviews } = setup(plan, run, manifest);
  assert.deepEqual(bundle.packets, []); assert.deepEqual(reviews, []);
  const sample = finalizeReviews(plan, run, bundle, reviews);
  assert.deepEqual(sample.agreement.details, []);
  assert.equal(sample.agreement.value, null);
  assert.equal(validateSampleFinal(plan, run, manifest, sample), sample);
  assert.throws(() => validateFinalAudit(plan, run, sample), /sample/);
  const full = finalizeReviews(plan, run, createReviewPackets(plan, run), []);
  assert.equal(validateFinalAudit(plan, run, full), full);
  assert.ok(!Object.hasOwn(full, 'type') && !Object.hasOwn(full, 'caseIds'));
  assert.ok(full.items.every(i => !Object.hasOwn(i, 'structuredDate')));
});

test('unselected unresolved slots are excluded but selected unknown/unexecuted slots block sample audit', () => {
  for (const state of ['unknown', 'unexecuted']) {
    const { plan, run } = fixture(), manifest = createSampleManifest(plan);
    const outside = run.records.find(r => !manifest.caseIds.includes(r.caseId)); outside.state = state;
    const { bundle, reviews } = setup(plan, run, manifest);
    const final = finalizeReviews(plan, run, bundle, reviews);
    assert.ok(!final.items.some(i => i.recordId === outside.id));
    assert.equal(validateSampleFinal(plan, run, manifest, final), final);
    const inside = run.records.find(r => manifest.caseIds.includes(r.caseId)); inside.state = state;
    const pending = setup(plan, run, manifest), partial = finalizeReviews(plan, run, pending.bundle, pending.reviews);
    const item = partial.items.find(i => i.recordId === inside.id);
    assert.deepEqual([item.date, item.structuredDate, item.state], [null, null, 'pending']);
    assert.throws(() => validateSampleFinal(plan, run, manifest, partial), /unexecuted\/unknown/);
  }
});

test('missing, duplicate, inconsistent, unblinded or non-independent reviewers cannot pass sample audit', () => {
  const { plan, run } = fixture(), { manifest, bundle, reviews } = setup(plan, run);
  const missing = finalizeReviews(plan, run, bundle, reviews.slice(1));
  assert.throws(() => validateSampleFinal(plan, run, manifest, missing), /two distinct/);
  assert.throws(() => finalizeReviews(plan, run, bundle, [...reviews, reviews[0]]), /two distinct/);
  for (const attestation of ['blind', 'independent']) {
    assert.throws(() => finalizeReviews(plan, run, bundle, [{ ...reviews[0], [attestation]: false }, ...reviews.slice(1)]), /attestation/);
  }
  const different = structuredClone(reviews); different[0].reviewerId = 'carol';
  const inconsistent = finalizeReviews(plan, run, bundle, different);
  assert.throws(() => validateSampleFinal(plan, run, manifest, inconsistent), /same two/);
});

test('readable prose can earn semantic grades while failing the structured primary without a grading error', () => {
  const { plan, run } = fixture(), { manifest, bundle, reviews } = setup(plan, run, undefined, { structuredDate: 0 });
  const final = finalizeReviews(plan, run, bundle, reviews);
  assert.ok(final.items.every(i => i.state === 'final' && i.date === 1 && i.evidence === 1 && i.structuredDate === 0));
  assert.equal(final.agreement.value, 1);
  assert.equal(validateSampleFinal(plan, run, manifest, final), final);
});

test('structured disagreement is audited separately and requires a reasoned two-track reconciliation', () => {
  const { plan, run } = fixture(), { manifest, bundle, reviews } = setup(plan, run);
  reviews[1].structuredDate = 0; reviews[1].structuredReason = 'Invalid JSON despite readable correct prose';
  const pending = finalizeReviews(plan, run, bundle, reviews);
  const detail = pending.agreement.details.find(d => d.packetId === bundle.packets[0].id);
  assert.deepEqual(detail.differences, [{ item: 'structuredDate', left: 1, right: 0 }]);
  assert.equal(pending.agreement.numerator, pending.agreement.denominator - 1);
  assert.throws(() => validateSampleFinal(plan, run, manifest, pending), /pending/);
  const resolved = resolution(bundle, reviews, { structuredDate: 0 });
  const final = finalizeReviews(plan, run, bundle, reviews, [resolved]);
  assert.equal(final.items.find(i => i.recordId === detail.recordId).structuredDate, 0);
  assert.equal(validateSampleFinal(plan, run, manifest, final), final);
  const missing = structuredClone(resolved); delete missing.structuredDate; delete missing.structuredReason;
  assert.throws(() => validateSampleFinal(plan, run, manifest, finalizeReviews(plan, run, bundle, reviews, [missing])), /pending/);
  assert.throws(() => finalizeReviews(plan, run, bundle, reviews, [{ ...resolved, structuredReason: '' }]), /structuredReason/);
  assert.throws(() => finalizeReviews(plan, run, bundle, reviews, [{ ...resolved, firstReviewHashes: ['bad', 'bad'] }]), /first review mismatch/);
});

test('null structured first labels remain unresolved and can only finalize with a complete reconciliation', () => {
  const { plan, run } = fixture(), { manifest, bundle, reviews } = setup(plan, run);
  for (const review of reviews.slice(0, 2)) { review.structuredDate = null; review.structuredReason = ''; }
  const pending = finalizeReviews(plan, run, bundle, reviews);
  const detail = pending.agreement.details.find(d => d.packetId === bundle.packets[0].id);
  assert.deepEqual(detail.differences, [{ item: 'structuredDate', left: null, right: null }]);
  assert.throws(() => validateSampleFinal(plan, run, manifest, pending), /pending/);
  const final = finalizeReviews(plan, run, bundle, reviews, [resolution(bundle, reviews)]);
  assert.equal(validateSampleFinal(plan, run, manifest, final), final);
  for (const bad of [{ structuredDate: 2 }, { structuredReason: '' }]) {
    const changed = setup(plan, run, manifest); Object.assign(changed.reviews[0], bad);
    assert.throws(() => finalizeReviews(plan, run, changed.bundle, changed.reviews), /structured/);
  }
});

test('semantic disagreements still require resolution regardless of agreement on structured labels', () => {
  const { plan, run } = fixture(), { manifest, bundle, reviews } = setup(plan, run);
  reviews[1].date = 0; reviews[1].events[0].date = 0;
  const pending = finalizeReviews(plan, run, bundle, reviews);
  assert.throws(() => validateSampleFinal(plan, run, manifest, pending), /pending/);
  const final = finalizeReviews(plan, run, bundle, reviews, [resolution(bundle, reviews, { date: 0 })]);
  const item = final.items.find(i => i.recordId === bundle.bindings.find(b => b.packetId === bundle.packets[0].id).recordId);
  assert.deepEqual([item.date, item.structuredDate], [0, 1]);
  assert.equal(validateSampleFinal(plan, run, manifest, final), final);
});

test('scoped packets are blinded whitelist inputs and reject recomputed-hash leakage/forgery', () => {
  const { plan, run } = fixture(), { manifest, bundle, reviews } = setup(plan, run);
  const visible = JSON.stringify(bundle.packets);
  for (const secret of ['SECRET', 'methodId', 'recordId', 'configHash', 'rawInput', 'aiJudgment', 'privateGold', 'privateCase', 'category']) assert.ok(!visible.includes(secret), secret);
  for (const change of [
    b => { b.packets[0].input.rawAnswer += 'tampered'; },
    b => { b.packets[0].input.methodId = 'leaked'; b.packets[0].hash = hash({ id: b.packets[0].id, input: b.packets[0].input }); b.bindings.find(x => x.packetId === b.packets[0].id).packetHash = b.packets[0].hash; },
    b => { b.packets[0].aiJudgment = 'leaked'; },
    b => { b.bindings[0].config = plan.config; },
    b => { b.judgeConfig = {}; },
    b => { b.packets.pop(); },
    b => { b.bindings.push(b.bindings[0]); },
    b => { b.caseIds.reverse(); },
    b => { delete b.type; },
    b => { delete b.caseIds; },
  ]) {
    const changed = structuredClone(bundle); change(changed);
    assert.throws(() => finalizeReviews(plan, run, changed, reviews));
  }
  const full = createReviewPackets(plan, run), extra = structuredClone(bundle);
  const binding = full.bindings.find(b => !bundle.bindings.some(s => s.recordId === b.recordId));
  extra.bindings.push(binding); extra.packets.push(full.packets.find(p => p.id === binding.packetId));
  assert.throws(() => finalizeReviews(plan, run, extra, reviews), /missing\/extra/);
  assert.throws(() => createSamplePackets(plan, run, { ...manifest, plannedOutputs: 0 }), /manifest/);
});

test('sample final audit rejects forged scores, structured reasons, audits, IDs and stale full run bindings', () => {
  const { plan, run } = fixture(), { manifest, bundle, reviews } = setup(plan, run);
  const final = finalizeReviews(plan, run, bundle, reviews);
  for (const change of [
    f => { f.items[0].date = 0; }, f => { f.items[0].structuredDate = 0; },
    f => { f.items[0].structuredReason = 'forged'; }, f => { f.items[0].recordHash = 'bad'; },
    f => { f.items.push(f.items[0]); }, f => { f.agreement.details.pop(); },
    f => { f.agreement.details[0].firstReviewHashes[0] = 'bad'; },
    f => { f.agreement.details[0].firstReviews[0].blind = false; },
    f => { f.agreement.details[1].packetId = f.agreement.details[0].packetId; },
    f => { f.agreement.details[1].recordId = f.agreement.details[0].recordId; },
    f => { f.caseIds.reverse(); }, f => { f.type = 'full-human-final'; },
  ]) {
    const changed = structuredClone(final); change(changed);
    assert.throws(() => validateSampleFinal(plan, run, manifest, changed));
  }
  const alteredRun = structuredClone(run);
  alteredRun.records.find(r => !manifest.caseIds.includes(r.caseId)).rawAnswer += 'changed outside sample';
  assert.throws(() => validateSampleFinal(plan, alteredRun, manifest, final), /artifact mismatch/);
});

test('even full-case sampling cannot pass legacy full-human gate, while old two-human schemas remain unchanged', () => {
  const { plan, run } = fixture({ onePerArticle: true }), { manifest, bundle, reviews } = setup(plan, run);
  assert.equal(manifest.caseIds.length, plan.dataset.cases.length);
  const sample = finalizeReviews(plan, run, bundle, reviews);
  assert.throws(() => validateFinalAudit(plan, run, sample), /sample/);
  const disguised = structuredClone(sample); delete disguised.type;
  assert.throws(() => validateFinalAudit(plan, run, disguised), /sample/);
  const fullBundle = createReviewPackets(plan, run);
  const oldReviews = fullBundle.packets.flatMap(p => ['alice', 'bob'].map(reviewerId => {
    const legacy = judgment(p.input.gold.events); delete legacy.structuredDate; delete legacy.structuredReason;
    return { packetId: p.id, packetHash: p.hash, reviewerId, independent: true, blind: true, ...legacy };
  }));
  const full = finalizeReviews(plan, run, fullBundle, oldReviews);
  assert.equal(validateFinalAudit(plan, run, full), full);
  assert.deepEqual(Object.keys(fullBundle).sort(), ['bindings', 'criteriaHash', 'packets', 'planId', 'runHash', 'schemaVersion']);
  assert.deepEqual(Object.keys(full).sort(), ['agreement', 'criteriaHash', 'items', 'planId', 'runHash', 'schemaVersion']);
  assert.ok(full.items.every(i => !Object.hasOwn(i, 'structuredDate') && !Object.hasOwn(i, 'structuredReason')));
});

test('manifest/packet/final/audit APIs leave caller-owned plan, run, reviews and manifest unchanged', () => {
  const { plan, run } = fixture(), planBefore = JSON.stringify(plan), runBefore = JSON.stringify(run);
  const { manifest, bundle, reviews } = setup(plan, run);
  const bundleBefore = JSON.stringify(bundle), reviewsBefore = JSON.stringify(reviews), manifestBefore = JSON.stringify(manifest);
  const final = finalizeReviews(plan, run, bundle, reviews), finalBefore = JSON.stringify(final);
  validateSampleManifest(plan, manifest); validateSampleFinal(plan, run, manifest, final);
  assert.equal(JSON.stringify(plan), planBefore); assert.equal(JSON.stringify(run), runBefore);
  assert.equal(JSON.stringify(bundle), bundleBefore); assert.equal(JSON.stringify(reviews), reviewsBefore);
  assert.equal(JSON.stringify(manifest), manifestBefore); assert.equal(JSON.stringify(final), finalBefore);
});
