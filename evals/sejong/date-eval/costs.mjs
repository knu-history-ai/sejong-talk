import { assert, hash } from './core.mjs';
import { isDeepStrictEqual } from 'node:util';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const number = (value, label, integer = false) => assert(Number.isFinite(value) && value >= 0
  && (!integer || Number.isSafeInteger(value)), `${label}: 비용은 유효한 0 이상의 숫자여야 합니다`);
const optional = (value, label, integer = false) => { if (value != null) number(value, label, integer); };
export function bindCost(plan, run, artifact, kind) {
  const expected = { schemaVersion: 1, planId: plan.id, criteriaHash: plan.criteriaHash,
    runHash: hash(run), type: kind + '-preliminary' };
  for (const [key, value] of Object.entries(expected)) {
    assert(artifact?.[key] === value, `${kind}.json: ${key} 채점 비용 기록 불일치`);
  }
  if (kind === 'code') number(artifact.elapsedMs, 'code.elapsedMs');
  else {
    // Old cost summaries contain only this envelope and aggregate, with no
    // claim to preserved attempts. Never treat an item/config/prompt artifact
    // as such a summary just because its attempts were removed or malformed.
    const summaryKeys = [...Object.keys(expected), 'evaluationCost'];
    const legacyCostOnly = Object.keys(artifact).every(key => summaryKeys.includes(key));
    if (legacyCostOnly) validateAiCost(artifact.evaluationCost);
    else validateAiArtifactCost(artifact);
  }
}
export function validateAiCost(cost) {
  assert(object(cost), 'AI 평가 비용 누락');
  number(cost.calls, 'ai.calls', true); number(cost.elapsedMs, 'ai.elapsedMs');
  for (const field of ['inputTokens', 'outputTokens']) {
    const usage = cost[field];
    assert(object(usage), `ai.${field}: 토큰 집계 누락`);
    optional(usage.sum, `${field}.sum`, true);
    for (const key of ['partialKnownSum', 'known', 'total']) number(usage[key], `${field}.${key}`, true);
    assert(usage.total === cost.calls && usage.known <= usage.total, `${field}: 호출 수와 토큰 분모 불일치`);
    assert(usage.known === usage.total ? usage.sum === usage.partialKnownSum : usage.sum === null,
      `${field}: 미확인 토큰을 총합으로 확정할 수 없습니다`);
    assert(usage.known !== 0 || usage.partialKnownSum === 0, `${field}: 확인된 호출 없는 토큰 부분합`);
  }
  return cost;
}

const tokenFields = [['inputTokens', 'prompt_eval_count'], ['outputTokens', 'eval_count']];
function transportBody(raw) {
  if (typeof raw !== 'string') return null;
  try { const body = JSON.parse(raw); return object(body) ? body : null; }
  catch { return null; }
}
function validateRawUsage(cost, raw, label) {
  const body = transportBody(raw);
  for (const [field, wire] of tokenFields) {
    optional(cost[field], `${label}.${field}`, true);
    const expected = Number.isSafeInteger(body?.[wire]) && body[wire] >= 0 ? body[wire] : null;
    assert((cost[field] ?? null) === expected, `${label}: tokens differ from preserved whole HTTP JSON (${field})`);
  }
  return body;
}

/** Nested monotonic intervals; tolerate arithmetic noise, never measured zero
 * around positive work. AI attempts run serially, so their times must be summed. */
export function validateAiElapsed(outer, inner, label, parts = 1) {
  number(outer, `${label}.elapsedMs`); number(inner, `${label} elapsed sum`);
  const tolerance = 1e-6 + 8 * Number.EPSILON * Math.max(1, outer, inner) * parts;
  assert((outer !== 0 || inner === 0) && outer + tolerance >= inner,
    `${label}: elapsedMs smaller than measured inner work`);
}

/** Legacy cost-only interrupted rows have no HTTP body/answer or judge-stage
 * claim. They may retain known costs, but cannot certify a completed AI artifact. */
export function validateAiTransportCost(entry, { legacyCostOnly = false } = {}) {
  assert(object(entry) && ['completed', 'failed', 'in-flight'].includes(entry.state), 'AI 호출 상태 오류');
  if (entry.state === 'in-flight') {
    assert(['raw', 'result', 'inputTokens', 'outputTokens', 'elapsedMs'].every(field => entry[field] == null),
      'in-flight AI transport cannot contain terminal costs/output');
    return entry;
  }
  const cost = entry.state === 'completed' ? entry.result : entry;
  assert(object(cost), '완료 AI 호출의 비용 기록 누락');
  optional(cost.elapsedMs, 'AI transport.elapsedMs');
  if (legacyCostOnly && !Object.hasOwn(cost, 'raw') && !Object.hasOwn(cost, 'answer')) {
    for (const [field] of tokenFields) optional(cost[field], `AI transport.${field}`, true);
    return cost;
  }
  assert(cost.raw == null || typeof cost.raw === 'string', 'AI transport raw must be preserved HTTP text or null');
  const body = validateRawUsage(cost, cost.raw, 'AI transport');
  if (entry.state === 'completed') {
    assert(body && body.done === true && !body.error && typeof cost.answer === 'string'
      && cost.answer.trim().length > 0 && body.response === cost.answer,
    'completed AI transport answer differs from preserved whole HTTP JSON');
    number(cost.elapsedMs, 'AI transport.elapsedMs');
  }
  return cost;
}

function validateAiAttemptCost(attempt, transportRequired) {
  assert(object(attempt), 'AI attempt: invalid cost record');
  number(attempt.elapsedMs, 'AI attempt.elapsedMs');
  for (const [field] of tokenFields) optional(attempt[field], `AI attempt.${field}`, true);
  const raw = attempt.rawOutput;
  const body = typeof raw === 'string' ? transportBody(raw) : raw;
  const http = object(body) && ['done', 'response', 'error', 'prompt_eval_count', 'eval_count']
    .some(field => Object.hasOwn(body, field));
  // aiGrade also supports injected callbacks returning a direct judgment (or
  // malformed judgment text). Only that identical, non-HTTP output is legacy;
  // rejected calls, HTTP envelopes and CLI artifacts always bind usage to raw.
  const direct = !transportRequired && !http && Object.hasOwn(attempt, 'judgmentOutput')
    && isDeepStrictEqual(raw, attempt.judgmentOutput);
  if (!direct) {
    assert(raw == null || typeof raw === 'string', 'AI attempt transport raw must be preserved HTTP text or null');
    validateRawUsage(attempt, raw, 'AI attempt');
  }
}

/** Used by every artifact/report cost binding, including legacy report commands.
 * Validation never edits raw records or fills unknown usage with zero. */
export function validateAiArtifactCost(ai) {
  validateAiCost(ai.evaluationCost);
  assert(Array.isArray(ai.items), 'AI cost: missing items/attempt records');
  const attempts = ai.items.flatMap(item => {
    assert(object(item) && Array.isArray(item.attempts), 'AI cost: missing attempts array');
    return item.attempts;
  });
  for (const attempt of attempts) validateAiAttemptCost(attempt, Object.hasOwn(ai.judgeConfig ?? {}, 'endpoint'));
  assert(ai.evaluationCost.calls === attempts.length, 'AI cost/attempt calls mismatch');
  for (const [field] of tokenFields) {
    const known = attempts.filter(attempt => attempt[field] != null);
    const partialKnownSum = known.reduce((n, attempt) => n + attempt[field], 0);
    number(partialKnownSum, `AI ${field} attempt sum`, true);
    assert(isDeepStrictEqual(ai.evaluationCost[field], {
      sum: known.length === attempts.length ? partialKnownSum : null,
      partialKnownSum, known: known.length, total: attempts.length,
    }), 'AI cost/attempt tokens mismatch');
  }
  validateAiElapsed(ai.evaluationCost.elapsedMs, attempts.reduce((n, attempt) => n + attempt.elapsedMs, 0),
    'AI total/attempts', attempts.length);
  return ai.evaluationCost;
}

/** Transport ledger costs are independent of content scores and never change model state.
 * A surviving in-flight entry proves a recorded attempt, not its final cost or completion. */
export function interruptedAiCost(plan, run, start, entries) {
  assert(object(start) && start.runHash === hash(run), 'AI 시작 기록의 실행 해시 불일치');
  const legacyStart = start.schemaVersion === undefined && !Object.hasOwn(start, 'startedAt')
    && !Object.hasOwn(start.judgeConfig ?? {}, 'endpoint');
  if (!legacyStart) assert(start.schemaVersion === 1 && start.planId === plan.id
    && start.criteriaHash === plan.criteriaHash, 'AI 시작 기록의 버전/계획/기준 누락·불일치');
  if (start.planId !== undefined) assert(start.planId === plan.id, 'AI 시작 기록의 계획 불일치');
  if (start.criteriaHash !== undefined) assert(start.criteriaHash === plan.criteriaHash, 'AI 시작 기록의 기준 불일치');
  const ids = new Set();
  for (const [i, { file, entry }] of entries.entries()) {
    assert(/^\d+\.json$/.test(file) && Number(file.slice(0, -5)) === i + 1, 'AI 호출 기록 번호 누락/순서 불일치');
    assert(!ids.has(file), '중복 AI 호출 기록'); ids.add(file);
    assert(object(entry) && ['completed', 'failed', 'in-flight'].includes(entry.state), 'AI 호출 상태 오류');
    assert(entry.runHash === hash(run), 'AI 호출 실행 해시 누락/불일치');
    assert(entry.planId === plan.id, 'AI 호출 계획 해시 누락/불일치');
    assert(entry.startHash === hash(start), 'AI 호출 시작 기록 해시 누락/불일치');
    assert(entry.request?.model === start.judgeConfig?.model
      && hash(entry.request?.options) === hash(start.judgeConfig?.options), 'AI 호출 설정 불일치');
    if (Object.hasOwn(start.judgeConfig ?? {}, 'think')) assert(entry.request?.think === start.judgeConfig.think, 'AI 호출 thinking 설정 불일치');
    validateAiTransportCost(entry, { legacyCostOnly: legacyStart && entry.schemaVersion === undefined
      && !Object.hasOwn(entry, 'startedAt') && entry.request?.stage === undefined });
  }
  const terminal = entries.filter(({ entry }) => entry.state !== 'in-flight');
  const inFlight = entries.length - terminal.length;
  const usage = field => {
    const known = terminal.map(({ entry }) => entry.state === 'completed' ? entry.result[field] : entry[field])
      .filter(value => value != null);
    const partialKnownSum = known.reduce((n, value) => n + value, 0);
    number(partialKnownSum, `AI 부분합 ${field}`, true);
    return { sum: known.length === entries.length ? partialKnownSum : null,
      partialKnownSum, known: known.length, total: entries.length };
  };
  const times = terminal.map(({ entry }) => entry.state === 'completed' ? entry.result.elapsedMs : entry.elapsedMs)
    .filter(value => value != null);
  const partialKnownElapsedMs = times.reduce((n, value) => n + value, 0);
  number(partialKnownElapsedMs, 'AI 처리 시간 부분합');
  return {
    cost: { calls: inFlight ? null : terminal.length, recordedAttempts: entries.length,
      confirmedTerminalCalls: terminal.length, inFlightCalls: inFlight,
      elapsedMs: null, partialKnownElapsedMs, measuredCallTimes: times.length,
      elapsedScope: '확인된 호출 처리 시간 합계. 전체 AI 채점 작업의 경과 시간은 미확인.',
      inputTokens: usage('inputTokens'), outputTokens: usage('outputTokens') },
    execution: { status: 'interrupted', interrupted: true, startHash: hash(start),
      ledgerHashes: Object.fromEntries(entries.map(({ file, entry }) => [file, hash(entry)])) },
  };
}

export function humanCost(entries) {
  for (const entry of entries) optional(entry.elapsedMs, '사람 채점 elapsedMs');
  const measured = entries.filter(entry => entry.elapsedMs != null);
  const sum = measured.reduce((n, entry) => n + entry.elapsedMs, 0);
  number(sum, '사람 채점 시간 합계');
  return { elapsedMs: measured.length === entries.length ? sum : null,
    partialKnownSumMs: sum, measured: measured.length, total: entries.length,
    status: '검토자별 실제 작업 시간 합계. 미기록은 0이 아님. 독립 판정과 합의 시간 별도 입력.' };
}
