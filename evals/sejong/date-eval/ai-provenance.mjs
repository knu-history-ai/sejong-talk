import { isDeepStrictEqual } from 'node:util';
import { assert, hash, validateRun } from './core.mjs';
import { bindCost, interruptedAiCost } from './costs.mjs';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const number = (value, label, integer = false) => assert(Number.isFinite(value) && value >= 0
  && (!integer || Number.isSafeInteger(value)), `${label}: invalid nonnegative cost`);
const normalizedConfig = config => ({ ...config, timeoutMs: config.timeoutMs ?? 30000,
  retries: config.retries ?? 0, cancelGraceMs: config.cancelGraceMs ?? 100 });

function expectedInput(plan, record, prompt) {
  const c = plan.dataset.cases.find(c => c.id === record.caseId);
  const gold = plan.gold.cases.find(c => c.id === record.caseId);
  const fields = ['id', 'expected', 'required', 'allowedOmissions', 'requiresUnknownDay',
    'eligibility', 'evidence', 'allowedParaphrases', 'allowedExpressions', 'wrongExamples'];
  return { instructions: prompt, sourceText: c.sourceText, question: c.question,
    targets: c.targets.map(t => ({ id: t.id, label: t.label })),
    gold: { version: plan.gold.version, criteriaVersion: plan.gold.criteriaVersion,
      events: gold.events.map(e => Object.fromEntries(fields.filter(f => e[f] !== undefined).map(f => [f, e[f]]))) },
    rubric: plan.gold.rubric ?? {}, rawAnswer: record.rawAnswer };
}

function validateStart(plan, run, start) {
  assert(plain(start) && start.schemaVersion === 1 && start.planId === plan.id
    && start.criteriaHash === plan.criteriaHash && start.runHash === hash(run), 'AI start envelope mismatch/missing');
  assert(plain(start.judgeConfig) && text(start.judgeConfig.model), 'AI start judge config/model missing');
  const config = normalizedConfig(start.judgeConfig);
  number(config.timeoutMs, 'AI timeoutMs');
  assert(config.timeoutMs > 0 && config.timeoutMs <= 2147483647, 'invalid AI timeoutMs');
  number(config.retries, 'AI retries', true); assert(config.retries <= 5, 'invalid AI retries');
  number(config.cancelGraceMs, 'AI cancelGraceMs'); assert(config.cancelGraceMs <= 100, 'invalid AI cancelGraceMs');
  if (Object.hasOwn(config, 'think')) assert(typeof config.think === 'boolean', 'invalid AI think');
  return config;
}

function interpretable(answer) {
  const trimmed = answer.trim();
  const fence = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  try { return plain(JSON.parse(fence ? fence[1] : trimmed)); }
  catch { return false; }
}

function terminalBinding(record, item, attempt, row) {
  const { file, entry } = row;
  assert(entry.state !== 'in-flight', 'AI artifact has an unresolved durable transport attempt');
  const timedOut = attempt.timedOut === true;
  assert(attempt.timedOut === undefined || typeof attempt.timedOut === 'boolean', 'invalid AI timeout marker');
  if (timedOut) assert(attempt.state === 'grading-failure' && attempt.error === 'judge timeout', 'AI timeout cannot contain interpreted scores');
  const cost = entry.state === 'completed' ? entry.result : entry;
  assert(isDeepStrictEqual(attempt.rawOutput, cost.raw ?? null), 'AI preserved output differs from durable transport raw');
  for (const field of ['inputTokens', 'outputTokens']) {
    assert(isDeepStrictEqual(attempt[field], cost[field] ?? null), `AI attempt/durable transport ${field} mismatch`);
  }
  number(attempt.elapsedMs, 'AI attempt.elapsedMs');
  if (entry.state === 'completed') {
    assert(text(cost.answer) && typeof cost.raw === 'string', 'completed AI transport answer/raw missing');
    let body;
    try { body = JSON.parse(cost.raw); }
    catch { assert(false, 'completed AI transport raw is not the preserved whole HTTP JSON'); }
    assert(plain(body) && body.done === true && !body.error && body.response === cost.answer,
      'AI durable transport answer differs from raw response');
    for (const [field, wireField] of [['inputTokens', 'prompt_eval_count'], ['outputTokens', 'eval_count']]) {
      const count = Number.isSafeInteger(body[wireField]) && body[wireField] >= 0 ? body[wireField] : null;
      assert((cost[field] ?? null) === count, 'AI durable transport tokens differ from raw response');
    }
    if (timedOut) {
      assert(attempt.transportSettlement === 'resolved-after-timeout' && attempt.transportRecordMissing === false,
        'AI timeout/transport resolution mismatch');
      assert(!Object.hasOwn(attempt, 'judgmentOutput'), 'timed-out transport cannot have an interpreted judgment');
    } else {
      assert(Object.hasOwn(attempt, 'judgmentOutput') && isDeepStrictEqual(attempt.judgmentOutput, cost.answer),
        'AI judgment output differs from durable transport answer');
      assert(!Object.hasOwn(attempt, 'transportSettlement') && !attempt.transportRecordMissing, 'unexpected AI timeout transport markers');
      assert(interpretable(cost.answer) === (attempt.state !== 'grading-failure'), 'AI first-interpretable output was relabelled or discarded');
      // A completed transport can still contain malformed grading JSON. Its attempt
      // remains grading-failure, preserving the raw body and allowing the next retry.
    }
  } else {
    assert(attempt.state === 'grading-failure' && !Object.hasOwn(attempt, 'judgmentOutput') && text(entry.error),
      'failed durable transport cannot have an interpreted judgment');
    if (timedOut) assert(attempt.transportSettlement === 'rejected-after-timeout'
      && attempt.transportRecordMissing === false && attempt.transportError === entry.error, 'AI timeout/transport rejection mismatch');
    else assert(attempt.error === entry.error && !Object.hasOwn(attempt, 'transportSettlement')
      && !attempt.transportRecordMissing, 'AI failure differs from durable transport error');
  }
  return { recordId: record.id, recordHash: hash(record), attempt: attempt.attempt, file,
    entryHash: hash(entry), requestHash: hash(entry.request), inputHash: hash(item.rawInput),
    rawOutputHash: hash(attempt.rawOutput), judgmentOutputHash: Object.hasOwn(attempt, 'judgmentOutput') ? hash(attempt.judgmentOutput) : null,
    transportState: entry.state, gradingState: attempt.state, timedOut };
}

/** Pure join for CLI ai.json + ai-start.json + ordered [{file, entry}] ai-calls.
 * Durable rows are supplied by the caller; no filesystem/network or score grading.
 * This proves consistency with those rows, not independent authenticity of all files.
 * A null artifact retains interruptedAiCost's unknown/partial history semantics.
 */
export function validateAiProvenance(plan, run, ai, start = null, entries = []) {
  validateRun(plan, run);
  assert(Array.isArray(entries) && entries.every(row => plain(row) && text(row.file) && plain(row.entry)), 'AI ledger: expected file/entry array');
  if (ai === null) {
    assert(start !== null || entries.length === 0, 'AI ledger without start record');
    if (start === null) return { cost: null, execution: { status: 'not-started', interrupted: false }, bindings: [],
      evidence: { status: 'not-started', durableTransportJoined: false } };
    const partial = interruptedAiCost(plan, run, start, entries);
    return { ...partial, bindings: [], evidence: { status: 'interrupted', aiHash: null,
      startHash: hash(start), ledgerHashes: partial.execution.ledgerHashes, durableTransportJoined: false } };
  }
  bindCost(plan, run, ai, 'ai');
  const config = validateStart(plan, run, start);
  assert(isDeepStrictEqual(ai.judgeConfig, config) && ai.judgeConfigHash === hash(config), 'AI artifact/start judge config mismatch');
  assert(text(ai.prompt) && ai.promptHash === hash(ai.prompt), 'AI prompt hash mismatch');
  const partial = interruptedAiCost(plan, run, start, entries);
  assert(partial.cost.inFlightCalls === 0 && entries.length === ai.evaluationCost.calls, 'AI artifact/durable terminal call count mismatch');
  for (const field of ['inputTokens', 'outputTokens']) {
    assert(isDeepStrictEqual(partial.cost[field], ai.evaluationCost[field]), 'AI artifact/durable aggregate tokens mismatch');
  }
  assert(Array.isArray(ai.items) && ai.items.length === run.records.length, 'missing/extra AI items');
  const items = new Map();
  for (const item of ai.items) {
    assert(plain(item) && text(item.recordId) && !items.has(item.recordId), 'invalid/duplicate AI record ID');
    items.set(item.recordId, item);
  }
  const bindings = [];
  // aiGrade calls records serially in run.records order, with retries local to each
  // record. Ledger rows lack record IDs; exact request input plus that fixed order
  // joins each row once, including equal-answer repeats and failed grading retries.
  for (const record of run.records) {
    const item = items.get(record.id);
    assert(item?.recordHash === hash(record), 'AI record ID/hash mismatch');
    assert(Array.isArray(item.attempts), 'AI attempts: expected array');
    if (record.state === 'failed') {
      assert(item.state === 'execution-failure' && item.attempts.length === 0, 'generation failure cannot contain AI attempts');
      continue;
    }
    assert(record.state === 'completed', 'unresolved generation cannot bind an AI artifact');
    assert(isDeepStrictEqual(item.rawInput, expectedInput(plan, record, ai.prompt)), 'AI grading input/prompt differs from frozen record');
    assert(item.attempts.length > 0 && item.attempts.length <= config.retries + 1, 'missing/invalid AI record attempt count');
    assert(['preliminary', 'partial-failure', 'grading-failure'].includes(item.state), 'invalid AI item state');
    if (item.state === 'grading-failure') assert(item.attempts.length === config.retries + 1, 'AI failure stopped before the fixed retry limit');
    for (const [i, attempt] of item.attempts.entries()) {
      assert(plain(attempt) && attempt.attempt === i + 1
        && ['preliminary', 'partial-failure', 'grading-failure'].includes(attempt.state)
        && (i === item.attempts.length - 1 || attempt.state === 'grading-failure'), 'AI first-interpretable/retry audit mismatch');
      const row = entries[bindings.length];
      assert(row, 'missing durable row for AI attempt');
      const request = row.entry.request;
      assert(plain(request) && request.model === config.model && isDeepStrictEqual(request.options, config.options)
        && request.think === config.think && request.stage === 'judge', 'AI attempt/durable request config mismatch');
      assert(request.prompt === JSON.stringify(item.rawInput), 'AI attempt/durable request prompt mismatch');
      bindings.push(terminalBinding(record, item, attempt, row));
    }
    assert(item.attempts.at(-1).state === item.state, 'AI item state differs from last preserved attempt');
  }
  assert(bindings.length === entries.length, 'extra/unbound AI durable transport rows');
  const ledgerHashes = partial.execution.ledgerHashes;
  return { cost: structuredClone(ai.evaluationCost), execution: { status: 'completed', interrupted: false,
    startHash: hash(start), ledgerHashes }, bindings,
    evidence: { schemaVersion: 1, type: 'date-ai-provenance', status: 'verified', planId: plan.id,
      criteriaHash: plan.criteriaHash, runHash: hash(run), aiHash: hash(ai), startHash: hash(start),
      judgeConfigHash: hash(config), promptHash: ai.promptHash, ledgerHashes, bindingsHash: hash(bindings),
      recordedAttempts: bindings.length, judgedRecords: run.records.filter(r => r.state === 'completed').length,
      judgeModelCalled: bindings.length > 0, durableTransportJoined: true, independentExecutionProof: false } };
}
