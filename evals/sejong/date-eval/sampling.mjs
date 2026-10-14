import { isDeepStrictEqual } from 'node:util';
import { assert, hash, validatePlan, validateRun } from './core.mjs';
import { createReviewPackets, finalizeReviews } from './grading.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function questionType(plan, c) {
  const type = plan.gold.cases.find(g => g.id === c.id).category ?? c.type ?? 'unspecified';
  assert(text(type), `${c.id}: invalid sample question type`);
  return type.trim();
}
function typeCounts(plan, cases) {
  const types = cases.map(c => questionType(plan, c));
  return Object.fromEntries([...new Set(types)].sort().map(type =>
    [type, types.filter(t => t === type).length]));
}

/** Outcome-free selection: lowest SHA-256 rank within each article. All method/repeat
 * slots follow the selected question. This JSON cannot prove when it was frozen;
 * the CLI must persist it before executing any slots and refuse replacement. */
export function createSampleManifest(plan, { seed = 62 } = {}) {
  validatePlan(plan);
  assert(Number.isSafeInteger(seed) && seed >= 0, 'sample seed must be a nonnegative safe integer');
  const articles = new Map();
  for (const c of plan.dataset.cases) {
    assert(text(c.id) && text(c.articleId) && ['event', 'control'].includes(c.kind), 'invalid sample article/case/kind');
    const rows = articles.get(c.articleId) ?? [];
    rows.push({ caseId: c.id, rank: hash({ seed, articleId: c.articleId, caseId: c.id }) });
    articles.set(c.articleId, rows);
  }
  const caseIds = [...articles.values()].map(rows => rows.sort((a, b) =>
    compare(a.rank, b.rank) || compare(a.caseId, b.caseId))[0].caseId).sort();
  const selected = plan.dataset.cases.filter(c => caseIds.includes(c.id));
  const available = typeCounts(plan, plan.dataset.cases);
  const selectedCounts = typeCounts(plan, selected);
  const payload = { schemaVersion: 1, type: 'date-sample-manifest', planId: plan.id,
    datasetHash: plan.datasetHash, goldHash: plan.goldHash, criteriaHash: plan.criteriaHash,
    configHash: plan.configHash, seed, version: 'article-one-v1', caseIds,
    articleCount: articles.size, candidateIds: plan.dataset.cases.map(c => c.id).sort(),
    eligibility: { kinds: ['control', 'event'], rule: 'all-questions-no-outcomes' },
    selectionRule: 'lowest-sha256(seed,articleId,caseId)-per-article;caseId-tiebreak;all-methods-and-repeats',
    questionTypes: { available, selected: Object.fromEntries(Object.keys(available).map(type => [type, selectedCounts[type] ?? 0])) },
    plannedOutputs: plan.slots.filter(s => caseIds.includes(s.caseId)).length };
  return freeze({ ...payload, manifestHash: hash(payload) });
}

export function validateSampleManifest(plan, manifest) {
  assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'invalid sample manifest');
  const expected = createSampleManifest(plan, { seed: manifest.seed });
  assert(isDeepStrictEqual(manifest, expected), 'sample manifest differs from deterministic selection/binding');
  return manifest;
}

export function createSamplePackets(plan, run, manifest) {
  validateSampleManifest(plan, manifest);
  return createReviewPackets(plan, run, { caseIds: manifest.caseIds });
}

/** Replay both semantic and structured human scores through the existing restricted
 * packet inputs. Attestations are preserved/validated, not independently proven.
 * No completed selected slots means zero human reviews, not two invented reviewers. */
export function validateSampleFinal(plan, run, manifest, final) {
  validateSampleManifest(plan, manifest);
  validateRun(plan, run);
  assert(final?.type === 'sample-human-final' && isDeepStrictEqual(final.caseIds, manifest.caseIds), 'sample final type/caseIds mismatch');
  const bundle = createSamplePackets(plan, run, manifest);
  for (const key of ['schemaVersion', 'planId', 'criteriaHash', 'runHash']) {
    assert(final[key] === bundle[key], `${key}: sample final artifact mismatch`);
  }
  const details = final.agreement?.details;
  assert(Array.isArray(details) && details.length === bundle.bindings.length, 'missing/extra sample human review audit');
  const byRecord = new Map();
  for (const detail of details) {
    assert(detail && text(detail.recordId) && !byRecord.has(detail.recordId), 'invalid/duplicate sample human review audit');
    byRecord.set(detail.recordId, detail);
  }
  const inputs = new Map(bundle.packets.map(p => [p.id, p.input]));
  bundle.packets = [];
  const reviews = [], adjudications = [];
  let reviewers;
  for (const binding of bundle.bindings) {
    const detail = byRecord.get(binding.recordId);
    assert(detail && text(detail.packetId) && Array.isArray(detail.firstReviews), 'invalid sample human review audit');
    const ids = detail.firstReviews.map(r => r?.reviewerId).sort();
    assert(ids.length === 2 && ids.every(text) && ids[0] !== ids[1], 'exactly two distinct sample reviewers required');
    if (reviewers) assert(isDeepStrictEqual(ids, reviewers), 'same two sample reviewers required across completed selected records');
    else reviewers = ids;
    const input = inputs.get(binding.packetId);
    const packetHash = hash({ id: detail.packetId, input });
    bundle.packets.push({ id: detail.packetId, hash: packetHash, input });
    Object.assign(binding, { packetId: detail.packetId, packetHash });
    reviews.push(...detail.firstReviews);
    if (detail.adjudication) adjudications.push(detail.adjudication);
  }
  const reproduced = finalizeReviews(plan, run, bundle, reviews, adjudications);
  assert(hash(reproduced) === hash(final), 'sample human final differs from independent review audit');
  const selected = run.records.filter(r => manifest.caseIds.includes(r.caseId));
  assert(selected.every(r => ['completed', 'failed'].includes(r.state)), 'unexecuted/unknown prevents sample final audit');
  assert(reproduced.items.every(i => ['final', 'execution-failure'].includes(i.state)), 'pending human review prevents sample final audit');
  return final;
}
