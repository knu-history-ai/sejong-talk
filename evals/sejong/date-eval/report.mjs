import { assert, hash, validatePlan, validateRun } from './core.mjs';
import { DERIVED_METHODS } from './postprocess.mjs';

const FLAGS = ['unsupportedDay', 'missingKnownDay', 'headerConfusion'];
const sum = values => values.reduce((a, b) => a + b, 0);
const average = values => values.length ? sum(values) / values.length : null;
const ratio = (numerator, denominator, reason = 'no eligible observations') => ({
  value: denominator ? numerator / denominator : null, numerator, denominator,
  reason: denominator ? null : reason,
});
const unique = (items, key, label) => {
  const map = new Map();
  for (const item of items) {
    assert(!map.has(item[key]), `duplicate ${label}: ${item[key]}`);
    map.set(item[key], item);
  }
  return map;
};
function latency(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    count: n, sum: sum(sorted), mean: average(sorted),
    median: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
    p95: n ? sorted[Math.ceil(n * 0.95) - 1] : null,
    reason: n ? null : 'no completed records',
  };
}
function usage(entries, field) {
  const isKnown = value => Number.isInteger(value) && value >= 0;
  const known = entries.filter(entry => isKnown(entry[field]));
  const attempts = entries.flatMap(entry => entry.attempts);
  const knownAttempts = attempts.filter(attempt => isKnown(attempt[field]));
  const calls = sum(entries.map(entry => entry.calls));
  const partialKnownSum = sum(entries.map(entry => isKnown(entry[field]) ? entry[field]
    : sum(entry.attempts.filter(attempt => isKnown(attempt[field])).map(attempt => attempt[field]))));
  return {
    sum: known.length === entries.length ? sum(known.map(entry => entry[field])) : null,
    partialKnownSum,
    coverage: ratio(known.length, entries.length, 'no operational records'),
    attemptKnownSum: sum(knownAttempts.map(attempt => attempt[field])),
    attemptCoverage: ratio(knownAttempts.length, calls, 'no model calls'),
    recordedAttempts: attempts.length,
    missingAttemptRecords: calls - attempts.length,
    source: 'record totals when known; otherwise known attempt tokens without double counting',
    label: known.length === entries.length ? 'complete' : 'partial known sum; unknown usage excluded',
  };
}
function aggregate(entries) {
  const completed = entries.filter(entry => entry.state === 'completed');
  const failed = entries.filter(entry => entry.state === 'failed');
  const correct = sum(entries.map(entry => entry.date));
  const evidenceCorrect = sum(completed.map(entry => entry.evidence));
  const conditional = ratio(correct, completed.length, 'no completed questions');
  const completion = ratio(completed.length, entries.length, 'no planned questions');
  const events = completed.flatMap(entry => entry.events);
  const eventRates = {};
  for (const flag of FLAGS) {
    const eligible = events.filter(event => event.eligibility[flag]);
    eventRates[flag] = ratio(sum(eligible.map(event => event[flag])), eligible.length,
      `no completed eligible ${flag} targets`);
  }
  return {
    fixedTotal: entries.length, completed: completed.length, failed: failed.length,
    accuracy: ratio(correct, entries.length, 'no planned questions'), conditionalAccuracy: conditional,
    completion, failure: ratio(failed.length, entries.length, 'no planned questions'),
    dateOverall: ratio(correct, entries.length, 'no planned questions'),
    conditionalTimesCompletion: conditional.value === null || completion.value === null
      ? null : conditional.value * completion.value,
    evidence: ratio(evidenceCorrect, entries.length, 'no planned questions'),
    conditionalEvidence: ratio(evidenceCorrect, completed.length, 'no completed questions'),
    eventRates,
  };
}
function articleWeighted(entries) {
  const questions = new Map();
  for (const entry of entries) {
    if (!questions.has(entry.caseId)) questions.set(entry.caseId, []);
    questions.get(entry.caseId).push(entry);
  }
  const questionMeans = [...questions].map(([caseId, rows]) => ({
    caseId, articleId: rows[0].articleId, repeats: rows.length, value: average(rows.map(row => row.date)),
  }));
  const articles = new Map();
  for (const question of questionMeans) {
    if (!articles.has(question.articleId)) articles.set(question.articleId, []);
    articles.get(question.articleId).push(question.value);
  }
  const articleMeans = [...articles].map(([articleId, values]) => ({
    articleId, questions: values.length, value: average(values),
  }));
  return {
    value: average(articleMeans.map(article => article.value)),
    reason: articleMeans.length ? null : 'no core articles', questionMeans, articleMeans,
    weighting: 'mean repeats per question; mean questions per article; equal article weight',
    repeatsIndependent: false,
  };
}

/** Consume the final artifact from the blind review/reconciliation stage.
 * This module checks integrity and completeness, not reviewer independence.
 * The shared Final contract contains no first-review identities or ballots.
 */
export function buildReport(plan, run, final) {
  validatePlan(plan);
  validateRun(plan, run);
  assert(plan.schemaVersion === 1 && run.schemaVersion === 1 && final?.schemaVersion === 1,
    'unsupported schema version');
  assert(final.planId === plan.id, 'final plan mismatch');
  assert(final.criteriaHash === plan.criteriaHash, 'different criteria hash');
  assert(final.runHash === hash(run), 'final run hash mismatch');
  assert(plan.datasetHash === hash(plan.dataset), 'dataset hash mismatch');
  assert(plan.goldHash === hash(plan.gold), 'gold hash mismatch');
  assert(plan.configHash === hash(plan.config), 'config hash mismatch');
  assert(plan.gold.datasetHash === plan.datasetHash, 'gold dataset hash mismatch');
  assert(['draft', 'approved'].includes(plan.gold.reviewStatus), 'invalid gold review status');
  const cases = unique(plan.dataset.cases, 'id', 'dataset case');
  const goldCases = unique(plan.gold.cases, 'id', 'gold case');
  const slots = unique(plan.slots, 'id', 'slot');
  const records = unique(run.records, 'id', 'record');
  const items = unique(final.items, 'recordId', 'final item');
  const methods = unique(plan.config.methods, 'id', 'method');
  assert(cases.size === goldCases.size, 'missing or extra gold cases');
  assert(records.size === slots.size && items.size === slots.size, 'missing or extra records/final items');
  const population = new Set();
  const entries = [];
  for (const slot of plan.slots) {
    const key = JSON.stringify([slot.caseId, slot.repeat, slot.methodId]);
    assert(!population.has(key), 'duplicate question/repeat/method slot');
    population.add(key);
    const question = cases.get(slot.caseId);
    const gold = goldCases.get(slot.caseId);
    assert(question && gold && methods.has(slot.methodId), 'missing case, gold or method');
    assert(['event', 'control'].includes(question.kind), 'invalid question kind');
    assert(typeof question.articleId === 'string' && question.articleId.length, 'missing articleId');
    const targets = unique(question.targets, 'id', 'target');
    const goldEvents = unique(gold.events, 'id', 'gold event');
    assert(targets.size === goldEvents.size && [...targets.keys()].every(id => goldEvents.has(id)),
      'missing or extra gold events');
    for (const event of gold.events) {
      assert(typeof event.requiresUnknownDay === 'boolean', 'missing requiresUnknownDay');
      for (const flag of FLAGS) assert(typeof event.eligibility?.[flag] === 'boolean',
        `missing eligibility flag: ${flag}`);
    }
    const record = records.get(slot.id);
    const item = items.get(slot.id);
    assert(record && item, 'missing record or final item');
    assert(record.caseId === slot.caseId && record.repeat === slot.repeat && record.methodId === slot.methodId,
      'record slot mismatch');
    assert(['completed', 'failed'].includes(record.state), 'unexecuted or unknown record prevents final report');
    assert(item.recordHash === hash(record), 'record hash mismatch');
    assert(item.state === (record.state === 'failed' ? 'execution-failure' : 'final'),
      'pending human review or invalid final state');
    assert([0, 1].includes(item.date) && [0, 1].includes(item.evidence), 'missing final score');
    if (record.state === 'failed') assert(item.date === 0 && item.evidence === 0,
      'failed records must be automatically scored zero');
    const judged = unique(item.events, 'id', 'final event');
    assert([...judged.keys()].every(id => goldEvents.has(id)), 'extra final event');
    for (const event of judged.values()) for (const flag of FLAGS) {
      assert([0, 1, null].includes(event[flag]), `invalid final event score: ${flag}`);
    }
    const events = gold.events.map(event => {
      const result = judged.get(event.id);
      // Iterate gold targets, never the output events: skipped targets retain their denominator.
      const output = { id: event.id, date: record.state === 'failed' ? null : (result?.date ?? null), eligibility: { ...event.eligibility } };
      for (const flag of FLAGS) {
        if (record.state === 'completed' && event.eligibility[flag]) {
          assert(result && [0, 1].includes(result[flag]), `missing eligible final event score: ${flag}`);
        }
        output[flag] = record.state === 'failed' ? null : (result?.[flag] ?? null);
      }
      return output;
    });
    assert(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0, 'invalid elapsedMs');
    assert(Number.isInteger(record.calls) && record.calls >= 0, 'invalid calls');
    assert(Array.isArray(record.attempts) && record.attempts.length <= record.calls, 'invalid attempts');
    assert(record.attempts.every(attempt => attempt && typeof attempt === 'object'), 'invalid attempt');
    for (const field of ['inputTokens', 'outputTokens']) assert(record[field] === null
      || (Number.isInteger(record[field]) && record[field] >= 0), `invalid ${field}`);
    entries.push({
      caseId: slot.caseId, repeat: slot.repeat, methodId: slot.methodId, recordId: record.id,
      recordHash: item.recordHash, articleId: question.articleId, kind: question.kind,
      state: record.state, date: item.date, evidence: item.evidence, events,
      elapsedMs: record.elapsedMs, calls: record.calls,
      inputTokens: record.inputTokens, outputTokens: record.outputTokens,
      attempts: structuredClone(record.attempts),
    });
    if (DERIVED_METHODS.includes(record.methodId)) {
      const parent = records.get(record.derivation.parentRecordId);
      Object.assign(entries.at(-1), {
        elapsedMs: parent.elapsedMs + record.elapsedMs, calls: parent.calls,
        inputTokens: parent.inputTokens, outputTokens: parent.outputTokens,
        attempts: structuredClone(parent.attempts),
        sharedGeneration: { parentRecordId: parent.id, parentRecordHash: hash(parent),
          incrementalElapsedMs: record.elapsedMs, physicalCalls: 0,
          inspectionElapsedMs: sum((record.postprocessInspections ?? []).map(i => i.elapsedMs)),
          source: 'same P generation plus measured deterministic postprocessing; not a fresh model call' },
      });
    }
  }
  assert(Number.isInteger(plan.config.repeats) && plan.config.repeats > 0, 'invalid repeats');
  assert(population.size === cases.size * methods.size * plan.config.repeats,
    'missing fixed question/repeat/method population');
  // Do not infer whether repeat numbering is zero- or one-based; require the same repeats everywhere.
  const repeatPopulation = new Map();
  for (const entry of entries) {
    const key = JSON.stringify([entry.caseId, entry.methodId]);
    if (!repeatPopulation.has(key)) repeatPopulation.set(key, []);
    repeatPopulation.get(key).push(entry.repeat);
  }
  const repeatSets = [...repeatPopulation.values()].map(values => JSON.stringify(values.sort((a, b) => a - b)));
  assert(repeatSets.every(value => value === repeatSets[0])
    && [...repeatPopulation.values()].every(values => values.length === plan.config.repeats),
  'different repeat populations');
  assert(Number.isFinite(run.batchElapsedMs) && run.batchElapsedMs >= 0, 'invalid batch wall time');
  const methodReports = plan.config.methods.map(method => {
    const rows = entries.filter(entry => entry.methodId === method.id);
    const core = rows.filter(entry => entry.kind === 'event');
    const control = rows.filter(entry => entry.kind === 'control');
    const completed = rows.filter(entry => entry.state === 'completed');
    const modelUsed = rows.some(entry => entry.calls > 0);
    return {
      ...structuredClone(method),
      model: modelUsed ? plan.config.model : null,
      modelReason: modelUsed ? null : 'N/A: no model calls (rule baseline)',
      core: aggregate(core), control: aggregate(control), operational: aggregate(rows),
      primary: articleWeighted(core),
      timing: { completion: latency(completed.map(entry => entry.elapsedMs)),
        totalItemElapsed: { sum: sum(rows.map(entry => entry.elapsedMs)),
          mean: average(rows.map(entry => entry.elapsedMs)), count: rows.length, includesFailures: true } },
      usage: { calls: sum(rows.map(entry => entry.calls)), inputTokens: usage(rows, 'inputTokens'),
        outputTokens: usage(rows, 'outputTokens'), evaluationCostsIncluded: false,
        scope: 'standalone service cost; shared P generation included in each T/V; do not sum methods' },
    };
  });
  return {
    schemaVersion: 1, type: 'date-evaluation-report', planId: plan.id,
    datasetHash: plan.datasetHash, goldHash: plan.goldHash, criteriaHash: plan.criteriaHash,
    configHash: plan.configHash, runHash: final.runHash, finalHash: hash(final),
    datasetVersion: plan.dataset.version, criteriaVersion: plan.gold.criteriaVersion,
    datasetSnapshot: structuredClone(plan.dataset),
    reviewStatus: plan.gold.reviewStatus,
    pilot: plan.dataset.split !== 'final' || plan.gold.reviewStatus !== 'approved',
    datasetEligible: plan.dataset.split === 'final' && plan.gold.reviewStatus === 'approved',
    paperEligible: false, paperReadiness: 'not-established-by-tool', unresolved: [],
    reviewProtocol: 'two independent blind first reviews; reconcile differences upstream',
    agreement: structuredClone(final.agreement), config: structuredClone(plan.config), environment: structuredClone(run.environment),
    batchWallMs: run.batchElapsedMs, batchWallScope: run.batchWallScope ?? 'whole run; not allocated to methods',
    batchWallComplete: !run.resumed,
    physicalBatchUsage: {
      calls: sum(run.records.map(r => r.calls)), inputTokens: usage(run.records, 'inputTokens'),
      outputTokens: usage(run.records, 'outputTokens'),
      itemElapsedMs: sum(run.records.map(r => r.elapsedMs + sum((r.postprocessInspections ?? []).map(i => i.elapsedMs)))),
      postprocessInspectionElapsedMs: sum(run.records.flatMap(r => r.postprocessInspections ?? []).map(i => i.elapsedMs)),
      warmup: structuredClone(run.warmup ?? []),
      warmupHistoryComplete: run.warmupHistoryComplete ?? !run.resumed,
      warmupCostScope: (run.warmupHistoryComplete ?? !run.resumed) ? 'all recorded warmup calls retained separately'
        : 'earlier warmup history unavailable; listed warmup is only a known partial history, not total cost',
      scope: 'actual generation counted once; original item work and extra status-inspection postprocessing retained; warmup separate; AI/human grading excluded',
    },
    methods: methodReports, entries,
    population: {
      articles: new Set(plan.dataset.cases.map(c => c.articleId)).size,
      eventGroups: new Set(plan.dataset.cases.map(c => c.groupId)).size,
      questions: plan.dataset.cases.length, repeatsPerQuestion: plan.config.repeats,
      plannedPerMethod: plan.dataset.cases.length * plan.config.repeats,
      coreQuestions: plan.dataset.cases.filter(c => c.kind === 'event').length,
      controlQuestions: plan.dataset.cases.filter(c => c.kind === 'control').length,
    },
    repeatsIndependent: false,
  };
}

function paired(rows) {
  const counts = { improve: 0, regress: 0, both1: 0, both0: 0 };
  for (const row of rows) counts[row.leftDate ? (row.rightDate ? 'both1' : 'regress')
    : (row.rightDate ? 'improve' : 'both0')]++;
  return { ...counts, total: rows.length, netChange: ratio(counts.improve - counts.regress, rows.length), rows };
}
function criticalEnvironment(environment) {
  // Support the runner's default host fingerprint as well as explicitly supplied identities.
  const hostFields = ['platform', 'release', 'cpu', 'cpus', 'memoryBytes', 'node'];
  if (hostFields.every(field => environment?.[field] !== undefined && environment[field] !== null)) {
    return Object.fromEntries([...hostFields, 'concurrency'].filter(field => environment[field] !== undefined)
      .map(field => [field, environment[field]]));
  }
  if (environment?.critical && Object.keys(environment.critical).length) return environment.critical;
  return environment?.hardware && (environment.runtime ?? environment.nodeVersion) ? {
    hardware: environment.hardware, runtime: environment.runtime ?? environment.nodeVersion ?? null,
    concurrency: environment.concurrency ?? null,
  } : null;
}
function validateReport(report) {
  assert(report?.schemaVersion === 1 && report.type === 'date-evaluation-report', 'unsupported report version');
  assert(Array.isArray(report.unresolved) && report.unresolved.length === 0, 'unresolved report');
  assert(hash(report.config) === report.configHash, 'report config hash mismatch');
  assert(report.datasetSnapshot && hash(report.datasetSnapshot) === report.datasetHash,
    'incompatible dataset snapshot; regenerate older reports from original records');
  assert(report.datasetSnapshot.version === report.datasetVersion, 'incompatible dataset version');
  const cases = unique(report.datasetSnapshot.cases, 'id', 'frozen question');
  assert(cases.size > 0 && Number.isInteger(report.config.repeats) && report.config.repeats > 0,
    'invalid fixed population');
  const methods = unique(report.methods, 'id', 'report method');
  const definitions = unique(report.config.methods, 'id', 'configured method');
  assert(methods.size === definitions.size, 'report method population mismatch');
  for (const method of methods.values()) {
    const definition = definitions.get(method.id);
    assert(typeof method.version === 'string' && method.version.length && definition
      && method.version === definition.version && method.codeHash === definition.codeHash,
    'report method version/code hash mismatch');
  }
  const keys = new Set();
  const expected = new Set();
  for (const method of methods.values()) for (const question of cases.values()) {
    for (let repeat = 1; repeat <= report.config.repeats; repeat++) {
      expected.add(JSON.stringify([question.id, repeat, method.id]));
    }
  }
  for (const entry of report.entries) {
    const key = JSON.stringify([entry.caseId, entry.repeat, entry.methodId]);
    assert(!keys.has(key), 'duplicate report population');
    keys.add(key);
    const question = cases.get(entry.caseId);
    assert(expected.has(key) && question && entry.articleId === question.articleId && entry.kind === question.kind,
      'different fixed question/repeat/method population');
    assert(methods.has(entry.methodId), 'unknown report method');
    assert(['completed', 'failed'].includes(entry.state) && [0, 1].includes(entry.date), 'unresolved report entry');
    assert(entry.state !== 'failed' || entry.date === 0, 'failed report entry must score zero');
    if (DERIVED_METHODS.includes(entry.methodId)) {
      const parent = report.entries.find(p => p.recordId === entry.sharedGeneration?.parentRecordId);
      assert(parent?.methodId === 'prompt-baseline' && parent.caseId === entry.caseId && parent.repeat === entry.repeat
        && entry.sharedGeneration.parentRecordHash === parent.recordHash, 'report shared P provenance mismatch');
      assert(Number.isFinite(entry.sharedGeneration.incrementalElapsedMs) && entry.sharedGeneration.incrementalElapsedMs >= 0
        && Number.isFinite(entry.sharedGeneration.inspectionElapsedMs) && entry.sharedGeneration.inspectionElapsedMs >= 0
        && entry.sharedGeneration.physicalCalls === 0, 'report postprocess cost mismatch');
      assert(entry.elapsedMs === parent.elapsedMs + entry.sharedGeneration.incrementalElapsedMs
        && ['calls', 'inputTokens', 'outputTokens', 'attempts'].every(field => hash(entry[field]) === hash(parent[field])), 'report shared generation cost mismatch');
    }
  }
  assert(keys.size === expected.size && [...expected].every(key => keys.has(key)),
    'missing fixed question/repeat/method population');
  for (const method of methods.values()) {
    const rows = report.entries.filter(entry => entry.methodId === method.id);
    for (const [name, selected] of [
      ['core', rows.filter(entry => entry.kind === 'event')],
      ['control', rows.filter(entry => entry.kind === 'control')],
      ['operational', rows],
    ]) {
      assert(hash(method[name]) === hash(aggregate(selected)), 'report aggregate differs from fixed population');
    }
    assert(hash(method.primary) === hash(articleWeighted(rows.filter(entry => entry.kind === 'event'))),
      'article weighting differs from fixed population');
    assert(method.usage.calls === sum(rows.map(row => row.calls))
      && hash(method.usage.inputTokens) === hash(usage(rows, 'inputTokens'))
      && hash(method.usage.outputTokens) === hash(usage(rows, 'outputTokens')), 'report usage differs from records');
  }
  if (report.physicalBatchUsage) {
    const physical = report.entries.map(entry => entry.sharedGeneration ? { ...entry, calls: 0,
      inputTokens: 0, outputTokens: 0, attempts: [],
      elapsedMs: entry.sharedGeneration.incrementalElapsedMs + entry.sharedGeneration.inspectionElapsedMs } : entry);
    assert(report.physicalBatchUsage.calls === sum(physical.map(entry => entry.calls))
      && hash(report.physicalBatchUsage.inputTokens) === hash(usage(physical, 'inputTokens'))
      && hash(report.physicalBatchUsage.outputTokens) === hash(usage(physical, 'outputTokens'))
      && report.physicalBatchUsage.postprocessInspectionElapsedMs === sum(report.entries.map(e => e.sharedGeneration?.inspectionElapsedMs ?? 0))
      && Math.abs(report.physicalBatchUsage.itemElapsedMs - sum(physical.map(entry => entry.elapsedMs))) < 0.000001,
    'report physical batch cost mismatch');
  } else assert(!report.entries.some(entry => entry.sharedGeneration), 'report physical batch costs missing for T/V');
}
export function compareReports(left, right) {
  validateReport(left);
  validateReport(right);
  for (const field of ['datasetHash', 'goldHash', 'criteriaHash', 'datasetVersion', 'criteriaVersion']) {
    assert(left[field] === right[field], `incompatible ${field}; frozen full hashes required`);
  }
  const modelOptions = report => ({ model: report.config.model, endpoint: report.config.endpoint,
    options: report.config.options });
  assert(hash(modelOptions(left)) === hash(modelOptions(right)), 'incompatible model/options');
  const executionOptions = report => {
    return Object.fromEntries(Object.entries(report.config).filter(([key]) => key !== 'methods'));
  };
  assert(hash(executionOptions(left)) === hash(executionOptions(right)),
    'incompatible execution conditions');
  const leftEnvironment = criticalEnvironment(left.environment);
  const rightEnvironment = criticalEnvironment(right.environment);
  const timeComparable = left.batchWallComplete !== false && right.batchWallComplete !== false && leftEnvironment !== null && rightEnvironment !== null
    && hash(leftEnvironment) === hash(rightEnvironment)
    && hash(left.config) === hash({ ...right.config, methods: left.config.methods });
  const comparisons = [];
  for (const before of left.methods) for (const after of right.methods) {
    if (before.id === after.id && before.version === after.version) {
      assert(before.codeHash === after.codeHash, 'same method version has different code hash');
    }
    const l = left.entries.filter(entry => entry.methodId === before.id);
    const r = right.entries.filter(entry => entry.methodId === after.id);
    const key = entry => JSON.stringify([entry.caseId, entry.repeat]);
    const rMap = new Map(r.map(entry => [key(entry), entry]));
    assert(l.length === r.length && l.length > 0, 'missing or different stable question population');
    const rows = l.map(entry => {
      const other = rMap.get(key(entry));
      assert(other && entry.articleId === other.articleId && entry.kind === other.kind,
        'different stable question population');
      return { caseId: entry.caseId, repeat: entry.repeat, articleId: entry.articleId, kind: entry.kind,
        leftDate: entry.date, rightDate: other.date, leftState: entry.state, rightState: other.state,
        leftRecordHash: entry.recordHash, rightRecordHash: other.recordHash };
    });
    comparisons.push({
      before: { ...left.config.methods.find(method => method.id === before.id) },
      after: { ...right.config.methods.find(method => method.id === after.id) },
      core: paired(rows.filter(row => row.kind === 'event')),
      control: paired(rows.filter(row => row.kind === 'control')), operational: paired(rows),
      completedOnlySupplement: paired(rows.filter(row => row.leftState === 'completed' && row.rightState === 'completed')),
      timeComparable, timingReason: timeComparable ? null : 'critical hardware/runtime or execution options missing/different; no efficiency conclusion',
    });
  }
  return {
    schemaVersion: 1, type: 'paired-date-evaluation-report',
    datasetHash: left.datasetHash, goldHash: left.goldHash, criteriaHash: left.criteriaHash,
    leftReportHash: hash(left), rightReportHash: hash(right),
    pilot: left.pilot || right.pilot,
    datasetEligible: left.datasetEligible && right.datasetEligible,
    paperEligible: false, paperReadiness: 'not-established-by-tool',
    repeatsIndependent: false, timeComparable, comparisons,
  };
}
