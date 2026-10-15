import { assert, hash, validateRun, validateRecordedInputs, validateGenerationTimes } from './core.mjs';
import { codeGrade } from './grading.mjs';
import { bindCost } from './costs.mjs';
import { DERIVED_METHODS } from './postprocess.mjs';
import { isDeepStrictEqual } from 'node:util';
import { readFileSync } from 'node:fs';

const VERSION = 'automatic-date-v1';
const DEFINITION = 'structured date task success, event questions only, format/execution failures 0';
const FLAGS = ['unsupportedDay', 'missingKnownDay', 'headerConfusion'];
const FIELDS = ['year', 'month', 'day', 'calendar'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const bit = value => value === 0 || value === 1;
const copy = value => structuredClone(value);
const sum = values => values.reduce((a, b) => a + b, 0);
const ratio = (numerator, denominator) => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
const number = (value, label, integer = false) => assert(Number.isFinite(value) && value >= 0
  && (!integer || Number.isSafeInteger(value)), `${label}: invalid nonnegative cost`);
const optionalNumber = (value, label, integer = false) => { if (value != null) number(value, label, integer); };
const FRESH_BATCH_SCOPE = 'whole run; not allocated to methods';
const RESUMED_BATCH_SCOPE = 'current resumed segment only; earlier batch wall time unavailable';
const evaluatorHash = () => hash(['automatic.mjs', 'core.mjs', 'grading.mjs', 'costs.mjs', 'postprocess.mjs', 'runner.mjs']
  .map(name => [name, readFileSync(new URL(name, import.meta.url), 'utf8')]));

function index(rows, key, label) {
  assert(Array.isArray(rows), `${label}: expected array`);
  const map = new Map();
  for (const row of rows) {
    assert(plain(row) && text(row[key]) && !map.has(row[key]), `${label}: invalid/duplicate ${key}`);
    map.set(row[key], row);
  }
  return map;
}

// Scan only syntactically valid, whole JSON. Decoding keys detects escaped duplicates
// too; braces/colons inside strings never create object scopes or property names.
function parseWholeJson(raw) {
  assert(typeof raw === 'string', 'expected JSON text');
  const trimmed = raw.trim();
  const fence = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  const json = fence ? fence[1] : trimmed;
  const value = JSON.parse(json);
  const stack = [];
  for (const token of json.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]/g)) {
    const word = token[0];
    if (word === '{' || word === '[') stack.push(word === '{' ? new Set() : null);
    else if (word === '}' || word === ']') stack.pop();
    else if (stack.at(-1) instanceof Set && /^\s*:/.test(json.slice(token.index + word.length))) {
      const key = JSON.parse(word);
      assert(!stack.at(-1).has(key), `duplicate JSON key: ${key}`);
      stack.at(-1).add(key);
    }
  }
  return value;
}

function syntaxSafety(raw) {
  try {
    const answer = parseWholeJson(raw);
    assert(plain(answer) && Array.isArray(answer.events), 'missing structured events array');
    if (Object.hasOwn(answer, 'answer')) assert(typeof answer.answer === 'string', 'invalid answer type');
    const events = index(answer.events, 'id', 'answer events');
    for (const event of events.values()) {
      const date = event.date;
      assert(plain(date) && FIELDS.every(field => Object.hasOwn(date, field)), 'missing structured date keys');
      for (const field of ['year', 'month', 'day']) assert(date[field] === null
        || (Number.isSafeInteger(date[field]) && date[field] > 0), `invalid date.${field} type/range`);
      assert((date.month === null || date.month <= 12) && (date.day === null || date.day <= 31), 'invalid date range');
      assert(date.calendar === null || text(date.calendar), 'invalid date.calendar type');
      if (Object.hasOwn(date, 'regnalYear')) assert(Number.isSafeInteger(date.regnalYear)
        && date.regnalYear > 0, 'invalid regnalYear');
      assert(typeof event.unknownDay === 'boolean', 'unknownDay must be boolean');
      // Evidence support is not a primary metric. Only validate types if supplied.
      if (Object.hasOwn(event, 'evidence')) assert(Array.isArray(event.evidence)
        && event.evidence.every(q => plain(q) && typeof q.quote === 'string'
          && Number.isSafeInteger(q.start) && Number.isSafeInteger(q.end)), 'invalid evidence type');
    }
    return { valid: true, events, reason: null };
  } catch (error) {
    return { valid: false, reason: error.message };
  }
}

function validateAttempt(attempt, label) {
  assert(plain(attempt), `${label}: invalid attempt`);
  optionalNumber(attempt.elapsedMs, `${label}.elapsedMs`);
  for (const field of ['inputTokens', 'outputTokens']) optionalNumber(attempt[field], `${label}.${field}`, true);
}

function validateGenerationCosts(plan, run) {
  const strict = plan.config.generationAuditVersion === 1;
  validateGenerationTimes(plan, run);
  for (const [i, warmup] of (run.warmup ?? []).entries()) {
    validateAttempt(warmup.result, `warmup[${i}]`);
  }
  for (const record of run.records) {
    number(record.calls, `${record.id}.calls`, true);
    assert(Array.isArray(record.attempts) && record.attempts.length <= record.calls, 'invalid generation attempts array/count');
    for (const attempt of record.attempts) validateAttempt(attempt, record.id);
    for (const field of ['inputTokens', 'outputTokens']) {
      optionalNumber(record[field], `${record.id}.${field}`, true);
      const known = record.attempts.filter(a => a[field] != null);
      const subtotal = sum(known.map(a => a[field]));
      number(subtotal, `${record.id}.${field} attempt sum`, true);
      if (strict && known.length < record.calls) {
        assert(record[field] === null, 'unknown strict attempt tokens require a null record total');
      }
      if (record[field] != null) {
        assert(record[field] >= subtotal, 'record tokens smaller than known attempt parts');
        if (known.length === record.calls) assert(record[field] === subtotal, 'record/attempt token totals mismatch');
        if (record.calls === 0) assert(record[field] === 0, 'tokens without generation calls');
      }
    }
  }
}

// The same generation accounting contract as the legacy report, without manufacturing
// a human Final. Known record totals win over attempt parts, avoiding double counting.
function usage(rows, field) {
  const known = rows.filter(r => r[field] != null);
  const attempts = rows.flatMap(r => r.attempts);
  const knownAttempts = attempts.filter(a => a[field] != null);
  const calls = sum(rows.map(r => r.calls));
  const partialKnownSum = sum(rows.map(r => r[field] ?? sum(r.attempts.map(a => a[field] ?? 0))));
  number(partialKnownSum, `${field} aggregate`, true);
  return { sum: known.length === rows.length ? partialKnownSum : null, partialKnownSum,
    coverage: ratio(known.length, rows.length), attemptKnownSum: sum(knownAttempts.map(a => a[field])),
    attemptCoverage: ratio(knownAttempts.length, calls), recordedAttempts: attempts.length,
    missingAttemptRecords: calls - attempts.length,
    source: 'record totals when known; otherwise known attempt tokens without double counting',
    label: known.length === rows.length ? 'complete' : 'partial known sum; unknown usage excluded' };
}

function generationSummary(rows) {
  for (const row of rows) number(row.elapsedMs, 'generation row.elapsedMs');
  const calls = sum(rows.map(r => r.calls));
  const itemElapsedMs = sum(rows.map(r => r.elapsedMs));
  number(calls, 'generation calls', true); number(itemElapsedMs, 'generation elapsed sum');
  return { calls, inputTokens: usage(rows, 'inputTokens'), outputTokens: usage(rows, 'outputTokens'),
    itemElapsedMs, meanItemElapsedMs: rows.length ? itemElapsedMs / rows.length : null,
    completedLatency: latency(rows.filter(r => r.state === 'completed').map(r => r.elapsedMs)),
    records: rows.length, completed: rows.filter(r => r.state === 'completed').length,
    failed: rows.filter(r => r.state === 'failed').length, includesFailures: true };
}

function warmupSummary(plan, run) {
  const rows = (run.warmup ?? []).map(w => ({ ...w.result, calls: 1, attempts: [w.result],
    state: 'completed', elapsedMs: w.result.elapsedMs ?? 0 }));
  const summary = generationSummary(rows);
  const required = Boolean(plan.config.warmup) && plan.config.methods.some(m =>
    m.id !== 'rule-baseline' && !DERIVED_METHODS.includes(m.id));
  // Required calls need recorded history even with a true flag. Legacy fresh
  // histories may be complete; resumed histories require explicit confirmation.
  // An explicit false flag always preserves uncertainty, including known zeroes.
  const historyComplete = run.warmupHistoryComplete !== false && (rows.length > 0
    ? run.warmupHistoryComplete === true || !run.resumed : !required);
  const elapsedComplete = historyComplete && rows.every(r => r.attempts[0].elapsedMs != null);
  const tokens = field => historyComplete ? summary[field] : { ...summary[field], sum: null,
    label: 'partial known sum; unrecorded warmup calls and unknown usage excluded' };
  return { ...summary, historyComplete, calls: historyComplete ? summary.calls : null,
    partialKnownCalls: summary.calls, inputTokens: tokens('inputTokens'), outputTokens: tokens('outputTokens'),
    itemElapsedMs: elapsedComplete ? summary.itemElapsedMs : null,
    meanItemElapsedMs: elapsedComplete ? summary.meanItemElapsedMs : null,
    completedLatency: latency(rows.filter(r => r.attempts[0].elapsedMs != null).map(r => r.elapsedMs)),
    elapsedMs: elapsedComplete ? summary.itemElapsedMs : null,
    partialKnownElapsedMs: summary.itemElapsedMs,
    scope: historyComplete ? 'all recorded warmup calls, separate from generation'
      : 'known partial warmup history only; total cost unknown' };
}

function latency(values) {
  const sorted = [...values].sort((a, b) => a - b), count = sorted.length;
  const total = sum(sorted);
  return { count, sumMs: total, meanMs: count ? total / count : null,
    medianMs: count ? (sorted[Math.floor((count - 1) / 2)] + sorted[Math.floor(count / 2)]) / 2 : null,
    p95Ms: count ? sorted[Math.ceil(count * 0.95) - 1] : null,
    scope: 'completed records with measured latency only; failures excluded' };
}

function goldInput(plan, record, prompt) {
  const c = plan.dataset.cases.find(c => c.id === record.caseId);
  const g = plan.gold.cases.find(g => g.id === record.caseId);
  const fields = ['id', 'expected', 'required', 'allowedOmissions', 'requiresUnknownDay',
    'eligibility', 'evidence', 'allowedParaphrases', 'allowedExpressions', 'wrongExamples'];
  return { instructions: prompt, sourceText: c.sourceText, question: c.question,
    targets: c.targets.map(t => ({ id: t.id, label: t.label })),
    gold: { version: plan.gold.version, criteriaVersion: plan.gold.criteriaVersion,
      events: g.events.map(e => Object.fromEntries(fields.filter(f => e[f] !== undefined).map(f => [f, e[f]]))) },
    rubric: plan.gold.rubric ?? {}, rawAnswer: record.rawAnswer };
}

function validProof(proof, input) {
  const quote = (q, source) => plain(q) && text(q.quote) && Number.isInteger(q.start)
    && Number.isInteger(q.end) && q.start >= 0 && q.end > q.start && q.end <= source.length
    && source.slice(q.start, q.end) === q.quote;
  const date = proof?.observedDate;
  return plain(proof) && text(proof.reason) && quote(proof.answerQuote, input.rawAnswer)
    && quote(proof.sourceQuote, input.sourceText) && plain(date)
    && FIELDS.every(f => Object.hasOwn(date, f))
    && ['year', 'month', 'day'].every(f => date[f] === null || (Number.isInteger(date[f]) && date[f] > 0))
    && (date.month === null || date.month <= 12) && (date.day === null || date.day <= 31)
    && (date.calendar === null || text(date.calendar));
}

// Reproduce grading.mjs's AI normalization, including canonical failure/N/A reasons
// and only the accepted proofs. Structured-task syntaxSafety is a separate policy.
function normalizePreservedAiJudgment(raw, gold, input) {
  const result = { date: null, evidence: null,
    reason: text(raw.reason) ? raw.reason : 'missing judgment reason', events: [], proofs: {}, failures: {} };
  const valid = (value, reason, proof) => bit(value) && text(reason) && validProof(proof, input);
  const failure = 'grading failure: missing/undecidable score, reason or valid item-specific proof';
  for (const field of ['date', 'evidence']) {
    if (valid(raw[field], raw.reason, raw.proofs?.[field])) {
      result[field] = raw[field]; result.proofs[field] = copy(raw.proofs[field]);
    } else result.failures[field] = failure;
  }
  const events = new Map(), duplicate = new Set();
  for (const event of Array.isArray(raw.events) ? raw.events : []) {
    if (!gold.events.some(e => e.id === event?.id)) continue;
    if (events.has(event.id)) duplicate.add(event.id);
    events.set(event.id, event);
  }
  for (const id of duplicate) events.delete(id);
  result.events = gold.events.map(e => {
    const supplied = events.get(e.id);
    const event = { id: e.id, date: null, reasons: {}, proofs: {} };
    for (const field of ['date', ...FLAGS]) {
      if (field !== 'date' && !e.eligibility[field]) {
        event[field] = null; event.reasons[field] = 'N/A: not eligible in frozen gold';
      } else if (valid(supplied?.[field], supplied?.reasons?.[field], supplied?.proofs?.[field])) {
        event[field] = supplied[field]; event.reasons[field] = supplied.reasons[field];
        event.proofs[field] = copy(supplied.proofs[field]);
      } else { event[field] = null; event.reasons[field] = failure; }
    }
    return event;
  });
  const dates = result.events.map(e => e.date);
  if (bit(result.date) && ((result.date === 1 && !dates.every(d => d === 1))
    || (dates.every(bit) && result.date !== (dates.every(d => d === 1) ? 1 : 0)))) {
    result.date = null;
    result.failures.date = 'grading failure: question date requires consistent target event date scores';
  }
  return result;
}

function parseAiJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const fence = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  // Match the existing AI parser, which normalizes the parsed document. The
  // stricter duplicate-key contract applies to generated structured answers only.
  return JSON.parse(fence ? fence[1] : trimmed);
}
function inspectAiOutput(value, gold, input) {
  try {
    const envelope = parseAiJson(value);
    const raw = typeof envelope?.response === 'string' ? parseAiJson(envelope.response) : envelope;
    return { parsed: true, raw, envelope,
      judgment: plain(raw) ? normalizePreservedAiJudgment(raw, gold, input) : null };
  } catch { return { parsed: false, judgment: null }; }
}

function validateAiAttempt(attempt, gold, input, config) {
  const raw = inspectAiOutput(attempt.rawOutput, gold, input);
  if (attempt.timedOut === true) {
    // aiGrade never processes a timed-out reply, even when cancellation recovers
    // valid JSON. Keep that exception tied to its measured timeout audit.
    const unsettled = attempt.transportSettlement === 'not-settled-within-grace';
    assert(attempt.state === 'grading-failure' && attempt.error === 'judge timeout'
      && attempt.elapsedMs >= config.timeoutMs && !Object.hasOwn(attempt, 'judgmentOutput')
      && attempt.cancelGraceMs === (config.cancelGraceMs ?? 100)
      && ['resolved-after-timeout', 'rejected-after-timeout', 'not-settled-within-grace'].includes(attempt.transportSettlement)
      && attempt.transportRecordMissing === unsettled, 'AI timeout audit mismatch');
    const missing = [...(attempt.rawOutput == null ? ['rawOutput'] : []),
      ...['inputTokens', 'outputTokens'].filter(f => attempt[f] == null)];
    assert(isDeepStrictEqual(attempt.missingTransportFields, missing), 'AI timeout missing transport fields mismatch');
    if (unsettled) assert(attempt.rawOutput == null && attempt.inputTokens == null && attempt.outputTokens == null,
      'AI timeout has data despite unsettled transport');
    if (attempt.transportSettlement === 'rejected-after-timeout') {
      assert(typeof attempt.transportError === 'string', 'AI timeout rejection error missing');
    } else assert(!Object.hasOwn(attempt, 'transportError'), 'AI timeout settlement/error mismatch');
    return null;
  }
  if (Object.hasOwn(attempt, 'judgmentOutput')) {
    const copied = inspectAiOutput(attempt.judgmentOutput, gold, input);
    assert(raw.parsed === copied.parsed && (!raw.parsed || isDeepStrictEqual(raw.raw, copied.raw)),
      'AI judgment/transport raw mismatch');
  }
  // ollamaGenerate rejects non-2xx HTTP status before interpreting its body.
  // That body may look complete: only a returned judgment has judgmentOutput.
  // Keep the recorded rejection (joined to durable rows by CLI provenance) a
  // failure, without permitting successful/HTTP 2xx output to be relabelled.
  const transportError = !Object.hasOwn(attempt, 'judgmentOutput') && plain(raw.envelope)
    && (/^HTTP [1345]\d{2}$/.test(attempt.error)
      || (Boolean(raw.envelope.error) && attempt.error === String(raw.envelope.error))
      || (Object.hasOwn(raw.envelope, 'done') && raw.envelope.done !== true
        && attempt.error === '응답이 정상 종료되지 않았습니다'));
  if (attempt.state === 'grading-failure') {
    assert(typeof attempt.error === 'string', 'AI grading failure error missing');
    assert(!raw.judgment || transportError,
      'AI interpretable preserved output cannot be a grading failure or fabricated timeout');
    return null;
  }
  assert(raw.judgment && !Object.hasOwn(attempt, 'error'), 'AI interpreted attempt lacks preserved judgment');
  const scores = [raw.judgment.date, raw.judgment.evidence, ...gold.events.flatMap((e, i) =>
    ['date', ...FLAGS.filter(f => e.eligibility[f])].map(f => raw.judgment.events[i][f]))];
  assert(attempt.state === (scores.every(bit) ? 'preliminary' : 'partial-failure'), 'AI preserved judgment/state mismatch');
  return raw.judgment;
}

function validateAi(plan, run, ai) {
  bindCost(plan, run, ai, 'ai');
  assert(plain(ai.judgeConfig) && hash(ai.judgeConfig) === ai.judgeConfigHash
    && text(ai.prompt) && hash(ai.prompt) === ai.promptHash, 'AI config/prompt provenance mismatch');
  number(ai.judgeConfig.timeoutMs, 'AI timeoutMs');
  assert(ai.judgeConfig.timeoutMs > 0 && ai.judgeConfig.timeoutMs <= 2147483647, 'invalid AI timeoutMs');
  number(ai.judgeConfig.retries, 'AI retries', true);
  assert(ai.judgeConfig.retries <= 5, 'invalid AI retries');
  optionalNumber(ai.judgeConfig.cancelGraceMs, 'AI cancelGraceMs');
  assert(ai.judgeConfig.cancelGraceMs == null || ai.judgeConfig.cancelGraceMs <= 100, 'invalid AI cancelGraceMs');
  const items = index(ai.items, 'recordId', 'AI items');
  assert(items.size === run.records.length, 'missing/extra AI items');
  for (const record of run.records) {
    const item = items.get(record.id);
    assert(item?.recordHash === hash(record), 'AI record hash mismatch');
    const gold = plan.gold.cases.find(g => g.id === record.caseId);
    const events = index(item.events, 'id', 'AI events');
    assert(events.size === gold.events.length && gold.events.every(e => events.has(e.id)), 'missing/extra AI events');
    assert(Array.isArray(item.attempts), 'AI attempts: expected array');
    for (const field of ['date', 'evidence']) assert(bit(item[field]) || item[field] === null, `invalid AI ${field} score`);
    for (const event of gold.events) for (const field of ['date', ...FLAGS]) {
      const value = events.get(event.id)[field];
      assert(bit(value) || value === null, `invalid AI event ${field} score`);
      if (field !== 'date' && !event.eligibility[field]) assert(value === null, 'ineligible AI score');
    }
    if (record.state === 'failed') {
      assert(item.state === 'execution-failure' && item.date === 0 && item.evidence === 0
        && item.attempts.length === 0 && [...events.values()].every(e => ['date', ...FLAGS].every(f => e[f] === null)),
      'invalid AI execution-failure item');
      continue; // automatic zeros in aiGrade are NOT AI semantic observations.
    }
    assert(['preliminary', 'partial-failure', 'grading-failure'].includes(item.state), 'invalid AI grading state');
    assert(hash(item.rawInput) === hash(goldInput(plan, record, ai.prompt)), 'AI input provenance mismatch');
    assert(item.attempts.length > 0 && item.attempts.length <= ai.judgeConfig.retries + 1, 'missing/invalid AI attempts');
    let judgment;
    for (const [i, attempt] of item.attempts.entries()) {
      assert(attempt.attempt === i + 1 && (i === item.attempts.length - 1 || attempt.state === 'grading-failure'), 'AI retry audit mismatch');
      judgment = validateAiAttempt(attempt, gold, item.rawInput, ai.judgeConfig);
    }
    assert(item.attempts.at(-1).state === item.state, 'AI last attempt state mismatch');
    const scores = [item.date, item.evidence, ...gold.events.flatMap(e =>
      ['date', ...FLAGS.filter(f => e.eligibility[f])].map(f => events.get(e.id)[f]))];
    if (item.state === 'grading-failure') {
      assert(scores.every(s => s === null), 'failed AI grading contains content scores');
      const failed = { date: null, evidence: null, reason: item.attempts.at(-1).error,
        events: gold.events.map(e => ({ id: e.id, date: null, ...Object.fromEntries(FLAGS.map(f => [f, null])) })) };
      assert(!Object.hasOwn(item, 'proofs') && !Object.hasOwn(item, 'failures')
        && isDeepStrictEqual(Object.fromEntries(Object.keys(failed).map(key => [key, item[key]])), failed),
      'AI failure differs from preserved attempt');
    } else {
      assert(item.state === (scores.every(bit) ? 'preliminary' : 'partial-failure'), 'AI coverage/state mismatch');
      assert(isDeepStrictEqual(Object.fromEntries(Object.keys(judgment).map(key => [key, item[key]])), judgment),
        'AI judgment differs from preserved raw output/proofs/reasons');
    }
    const dates = [...events.values()].map(e => e.date);
    assert(!(item.date === 1 && !dates.every(d => d === 1))
      && !(bit(item.date) && dates.every(bit) && item.date !== (dates.every(d => d === 1) ? 1 : 0)), 'AI question/event scores contradict');
  }
  return items;
}

function summarize(rows) {
  const completed = rows.filter(r => r.executionState === 'completed').length;
  const executionFailures = rows.filter(r => r.outcome === 'execution-failure').length;
  const correct = sum(rows.map(r => r.dateScore));
  return { primary: ratio(correct, rows.length), conditionalAccuracy: ratio(correct, completed),
    completion: ratio(completed, rows.length), failure: ratio(executionFailures, rows.length), completed,
    total: rows.length, structured: rows.filter(r => r.outcome === 'structured').length,
    formatFailures: rows.filter(r => r.outcome === 'format-failure').length,
    executionFailures };
}

function grouped(rows, key, summarizeRows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row[key])) groups.set(row[key], []);
    groups.get(row[key]).push(row);
  }
  return [...groups].map(([id, entries]) => ({ [key]: id, ...summarizeRows(entries) }));
}

function questionTypeSummary(rows) {
  const event = summarize(rows.filter(r => r.kind === 'event'));
  return { primary: event.primary, event,
    controls: summarize(rows.filter(r => r.kind === 'control')), operational: summarize(rows) };
}

function aiSummary(rows, observations, ran) {
  const recordIds = new Set(rows.map(r => r.recordId));
  const selected = observations.filter(o => recordIds.has(o.recordId));
  const eligible = rows.filter(r => r.executionState === 'completed').length;
  const metrics = Object.fromEntries(['date', 'evidence', 'eventDate', ...FLAGS].map(field => {
    const all = selected.filter(o => o.metric === field);
    const scored = all.filter(o => bit(o.score));
    return [field, { eligible: all.length, scored: scored.length, failures: ran ? all.length - scored.length : 0,
      notRun: ran ? 0 : all.length, coverage: ratio(scored.length, all.length),
      score: ratio(sum(scored.map(o => o.score)), scored.length) }];
  }));
  const states = { preliminary: 0, 'partial-failure': 0, 'grading-failure': 0, 'execution-failure': 0, 'not-run': 0 };
  for (const row of rows) states[row.ai.state]++;
  return { status: !ran ? 'not-run' : states['partial-failure'] || states['grading-failure'] ? 'partial-failure' : 'completed',
    total: rows.length, eligible, executionFailures: rows.length - eligible, states, metrics,
    failures: selected.filter(o => ran && o.score === null) };
}

/** Maintainer report; no human Final, reviewer agreement or historical-truth claim. */
export function buildAutomaticReport(plan, run, ai = null) {
  const start = performance.now();
  validateRun(plan, run);
  validateRecordedInputs(plan, run);
  assert(run.records.every(r => ['completed', 'failed'].includes(r.state)), 'unknown/unexecuted record prevents automatic report');
  validateGenerationCosts(plan, run);
  const aiItems = ai === null ? null : validateAi(plan, run, ai);
  const diagnostic = codeGrade(plan, run);
  bindCost(plan, run, diagnostic, 'code');
  const diagnostics = index(diagnostic.items, 'recordId', 'code items');
  const records = index(run.records, 'id', 'records');
  const cases = index(plan.dataset.cases, 'id', 'cases');
  const observations = [];
  const items = plan.slots.map(slot => {
    const record = records.get(slot.id), c = cases.get(slot.caseId);
    const gold = plan.gold.cases.find(g => g.id === c.id);
    assert(['event', 'control'].includes(c.kind), 'invalid question kind');
    const questionType = Object.hasOwn(gold, 'category') ? gold.category : c.type ?? 'unspecified';
    assert(text(questionType), 'invalid question type');
    const code = diagnostics.get(record.id);
    const safe = record.state === 'completed' ? syntaxSafety(record.rawAnswer) : null;
    const targetSetMatches = safe?.valid && safe.events.size === c.targets.length && c.targets.every(t => safe.events.has(t.id));
    // codeGrade checks required fields but permits other nulls generally. Here an
    // omission must be explicitly allowed, including for nonrequired components.
    const omissionsAllowed = targetSetMatches && gold.events.every(expected => {
      const date = safe.events.get(expected.id).date;
      return FIELDS.every(field => date[field] !== null || expected.expected[field] == null
        || (field === 'year' && Object.hasOwn(date, 'regnalYear'))
        || (!expected.required.includes(field) && (expected.allowedOmissions ?? []).includes(field)));
    });
    const outcome = record.state === 'failed' ? 'execution-failure' : safe.valid ? 'structured' : 'format-failure';
    const dateScore = outcome === 'structured' && omissionsAllowed && code.date === 1 ? 1 : 0;
    const a = aiItems?.get(record.id);
    const supplement = { state: a?.state ?? 'not-run',
      date: record.state === 'completed' ? a?.date ?? null : null,
      evidence: record.state === 'completed' ? a?.evidence ?? null : null,
      reason: a?.reason ?? (ai === null ? 'AI grading not run' : 'generation failed; no semantic judgment'),
      failures: copy(a?.failures ?? {}), events: copy(a?.events ?? []), attempts: a?.attempts.length ?? 0 };
    if (record.state === 'completed') {
      for (const metric of ['date', 'evidence']) observations.push({ recordId: record.id, methodId: record.methodId,
        caseId: c.id, articleId: c.articleId, kind: c.kind, questionType: questionType.trim(),
        eventId: null, metric, score: supplement[metric], reason: a?.failures?.[metric] ?? supplement.reason });
      for (const event of gold.events) {
        const supplied = a?.events.find(e => e.id === event.id);
        for (const field of ['date', ...FLAGS.filter(f => event.eligibility[f])]) observations.push({
          recordId: record.id, methodId: record.methodId, caseId: c.id, articleId: c.articleId,
          kind: c.kind, questionType: questionType.trim(), eventId: event.id,
          metric: field === 'date' ? 'eventDate' : field, score: supplied?.[field] ?? null,
          reason: supplied?.reasons?.[field] ?? supplement.reason });
      }
    }
    return { recordId: record.id, recordHash: hash(record), caseId: c.id, articleId: c.articleId,
      groupId: c.groupId, methodId: record.methodId, repeat: record.repeat, kind: c.kind,
      questionType: questionType.trim(), executionState: record.state, outcome, dateScore,
      reason: outcome === 'execution-failure' ? 'generation failed; task score 0'
        : outcome === 'format-failure' ? safe.reason : !targetSetMatches ? 'missing or unknown target events; task score 0'
          : 'deterministic structured field comparison only',
      syntaxSafety: { valid: safe?.valid ?? null, reason: safe?.reason ?? null },
      codeDiagnostic: copy(code), ai: supplement };
  });
  const physicalRows = run.records.map(r => ({ ...r, elapsedMs: r.elapsedMs
    + sum((r.postprocessInspections ?? []).map(i => i.elapsedMs)) }));
  const methods = plan.config.methods.map(method => {
    const rows = items.filter(r => r.methodId === method.id);
    const events = rows.filter(r => r.kind === 'event');
    const byArticle = grouped(events, 'articleId', summarize);
    const serviceRows = run.records.filter(r => r.methodId === method.id).map(record => {
      if (!DERIVED_METHODS.includes(method.id)) return record;
      const parent = records.get(record.derivation.parentRecordId);
      // First service execution only. Reinspection is cumulative physical work below,
      // not part of the original response latency or its failed-inclusive total.
      return { ...record, calls: parent.calls, inputTokens: parent.inputTokens, outputTokens: parent.outputTokens,
        attempts: parent.attempts, elapsedMs: parent.elapsedMs + record.elapsedMs };
    });
    return { ...copy(method), primary: summarize(events).primary, event: summarize(events),
      controls: summarize(rows.filter(r => r.kind === 'control')), operational: summarize(rows),
      byArticle,
      supplementary: { articleEqualWeight: { count: byArticle.length,
        value: byArticle.length ? sum(byArticle.map(a => a.primary.value)) / byArticle.length : null,
        unit: 'article', weighting: 'equal mean of per-article event-question/repeat task success rates', repeatsIndependent: false } },
      byQuestionType: grouped(rows, 'questionType', questionTypeSummary),
      generation: { ...generationSummary(serviceRows),
        scope: 'first standalone service execution; T/V includes the same P generation plus original postprocessing, excludes inspections; do not sum methods' },
      ai: aiSummary(rows, observations, ai !== null) };
  });
  const report = { schemaVersion: 1, type: 'date-automatic-report', evaluationVersion: VERSION,
    planId: plan.id, planHash: hash(plan), evaluatorHash: evaluatorHash(), datasetHash: plan.datasetHash, goldHash: plan.goldHash,
    criteriaHash: plan.criteriaHash, configHash: plan.configHash, runHash: hash(run), aiHash: ai === null ? null : hash(ai),
    access: 'maintainer-only', paperEligible: false, humanValidated: false,
    interpretation: 'structured task measurements and supplemental AI estimates; not historical truth or human final scores',
    metricDefinitions: { primary: { definition: DEFINITION, source: 'items.dateScore',
      semanticProseCorrectnessIncluded: false, historicalTruthEstablished: false },
      controls: 'separate control questions; excluded from primary',
      ai: 'supplemental judgments only; null/failures affect coverage, never become content zero' },
    population: { articles: new Set(items.filter(r => r.kind === 'event').map(r => r.articleId)).size,
      questions: plan.dataset.cases.length, eventQuestions: plan.dataset.cases.filter(c => c.kind === 'event').length,
      controlQuestions: plan.dataset.cases.filter(c => c.kind === 'control').length, repeatsPerQuestion: plan.config.repeats,
      plannedPerMethod: plan.dataset.cases.length * plan.config.repeats },
    repeatsIndependent: false, methods, items,
    ai: { ...aiSummary(items, observations, ai !== null), observations,
      byMethod: methods.map(m => ({ methodId: m.id, ...m.ai })),
      byKind: ['event', 'control'].map(kind => ({ kind, ...aiSummary(items.filter(r => r.kind === kind), observations, ai !== null) })),
      byQuestionType: grouped(items, 'questionType', rows => aiSummary(rows, observations, ai !== null)) },
    codeCost: { elapsedMs: 0, scope: 'measured automatic report computation; excludes generation and AI calls' },
    evaluationCosts: { codeElapsedMsPath: 'codeCost.elapsedMs', ai: ai === null ? null : copy(ai.evaluationCost),
      human: null, scope: 'separate from generation; no human work measured or inferred' },
    generation: { physicalBatch: { ...generationSummary(physicalRows),
      postprocessInspectionElapsedMs: sum(run.records.flatMap(r => r.postprocessInspections ?? []).map(i => i.elapsedMs)),
      scope: 'full physical batch; P counted once, failures and postprocess inspections included; warmup/evaluation separate' },
      batchWallMs: run.batchElapsedMs, batchWallComplete: !run.resumed,
      batchWallScope: run.resumed ? RESUMED_BATCH_SCOPE : run.batchWallScope ?? FRESH_BATCH_SCOPE,
      warmup: warmupSummary(plan, run) },
    // No plan/gold/run copies are needed: validation uses the live inputs. AI includes
    // private judge inputs; never copy this snapshot to the operator bundle or packets.
    inputSnapshots: { access: 'maintainer-only', ai: ai === null ? null : copy(ai),
      disclosure: 'AI snapshot may contain frozen gold, source text and raw answers; do not distribute to operators/reviewers' } };
  report.codeCost.elapsedMs = performance.now() - start;
  return report;
}

/** Only codeCost.elapsedMs is volatile/optional; every other field is reproduced. */
export function validateAutomaticReport(plan, run, report, ai = null) {
  assert(plain(report), 'invalid automatic report');
  optionalNumber(report.codeCost?.elapsedMs, 'codeCost.elapsedMs');
  const boundAi = ai ?? report.inputSnapshots?.ai ?? null;
  if (ai !== null) assert(report.aiHash === hash(ai), 'supplied AI artifact mismatch');
  const expected = buildAutomaticReport(plan, run, boundAi);
  const withoutElapsed = value => {
    const result = copy(value);
    if (plain(result.codeCost)) delete result.codeCost.elapsedMs;
    return result;
  };
  assert(isDeepStrictEqual(withoutElapsed(report), withoutElapsed(expected)), 'automatic report integrity mismatch');
  return report;
}

/** Pair only methods in this frozen run. Repeats/questions are not independent units. */
export function compareAutomaticMethods(plan, run, report) {
  validateAutomaticReport(plan, run, report);
  const pairs = [];
  for (let i = 0; i < report.methods.length; i++) for (let j = i + 1; j < report.methods.length; j++) {
    const left = report.methods[i], right = report.methods[j];
    const leftRows = report.items.filter(r => r.methodId === left.id && r.kind === 'event');
    const rightRows = new Map(report.items.filter(r => r.methodId === right.id && r.kind === 'event')
      .map(r => [JSON.stringify([r.caseId, r.repeat]), r]));
    const items = leftRows.map(a => {
      const b = rightRows.get(JSON.stringify([a.caseId, a.repeat]));
      assert(b && a.articleId === b.articleId, 'unpaired method observations');
      return { caseId: a.caseId, articleId: a.articleId, questionType: a.questionType, repeat: a.repeat,
        leftRecordId: a.recordId, rightRecordId: b.recordId,
        leftRecordHash: a.recordHash, rightRecordHash: b.recordHash,
        left: a.dateScore, right: b.dateScore, difference: b.dateScore - a.dateScore,
        outcome: a.dateScore === b.dateScore ? a.dateScore === 1 ? 'both1' : 'both0'
          : b.dateScore === 1 ? 'improve' : 'regress' };
    });
    const counts = Object.fromEntries(['improve', 'regress', 'both0', 'both1']
      .map(outcome => [outcome, items.filter(r => r.outcome === outcome).length]));
    const byArticle = grouped(items, 'articleId', rows => {
      const leftMetric = ratio(sum(rows.map(r => r.left)), rows.length);
      const rightMetric = ratio(sum(rows.map(r => r.right)), rows.length);
      return { left: leftMetric, right: rightMetric, netCount: sum(rows.map(r => r.difference)),
        netDifference: rightMetric.value - leftMetric.value };
    });
    pairs.push({ leftMethodId: left.id, rightMethodId: right.id, direction: 'right minus left',
      denominator: items.length, ...counts, netCount: counts.improve - counts.regress,
      netDifference: items.length ? (counts.improve - counts.regress) / items.length : null,
      byArticle, articleUnit: { count: byArticle.length,
        meanNetDifference: byArticle.length ? sum(byArticle.map(a => a.netDifference)) / byArticle.length : null,
        unit: 'article', questionsAndRepeatsIndependent: false }, items });
  }
  return { schemaVersion: 1, type: 'date-automatic-method-comparison', evaluationVersion: VERSION,
    planId: plan.id, planHash: hash(plan), runHash: hash(run), reportHash: hash(report),
    scope: 'within-run methods; event question/repeat pairs with fixed denominator',
    inference: 'descriptive article-unit differences; not 265 independent observations; no significance claim',
    repeatsIndependent: false, paperEligible: false, significanceClaim: false, pairs };
}
