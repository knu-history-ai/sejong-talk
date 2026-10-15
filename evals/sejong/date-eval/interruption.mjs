/** Maintainer-only, read-only registration of an interrupted operator folder.
 * This is deliberately NOT run.json: unknown calls never become failures/zeros
 * and this artifact cannot be imported as a completed scored experiment. */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assert, hash, validatePlan, validateExecutionPlan, executionPlan, validateGenerationProgress } from './core.mjs';

export async function inspectInterruption(plan, folder) {
  validatePlan(plan);
  const sourceFiles = {};
  async function read(name) {
    const value = JSON.parse(await readFile(join(folder, name), 'utf8'));
    sourceFiles[name] = hash(value);
    return value;
  }
  const operator = validateExecutionPlan(await read('plan.json'));
  assert(hash(operator) === hash(executionPlan(plan)), '중단 폴더의 실행 계획이 담당자 원본과 다릅니다');
  let hasRun = false;
  try { await read('run.json'); hasRun = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert(!hasRun, '완료 run.json이 있습니다. 중단 진단 대신 원본 import-run 검증을 사용하세요');
  const progress = await read('progress.json');
  assert(progress.planId === plan.id && Array.isArray(progress.records), '중단 진행 기록이 실행 계획과 다릅니다');
  let names = [];
  try { names = (await readdir(join(folder, 'generation-calls'))).filter(n => /^\d+\.json$/.test(n))
    .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const ledger = await Promise.all(names.map(name => read(join('generation-calls', name))));
  validateGenerationProgress(plan, progress.records, ledger, { inspection: true });
  if (progress.inFlight) {
    const entry = ledger.find(e => hash(e.request) === hash(progress.inFlight.request)
      && hash(e.context) === hash(progress.inFlight.context)
      && typeof progress.inFlight.callFile === 'string'
      && 'generation-calls/' + String(e.callId).padStart(4, '0') + '.json' === progress.inFlight.callFile.replaceAll('\\', '/'));
    assert(entry, '진행 중 표시와 원본 호출 파일의 연결이 다릅니다');
  }
  const terminal = ledger.filter(e => e.state !== 'in-flight');
  const result = entry => entry.state === 'completed' ? entry.result : entry;
  const known = field => terminal.map(e => result(e)?.[field]).filter(v => v != null);
  for (const entry of terminal) {
    const value = result(entry);
    for (const field of ['inputTokens', 'outputTokens', 'elapsedMs']) assert(value?.[field] == null
      || (Number.isFinite(value[field]) && value[field] >= 0
        && (field === 'elapsedMs' || Number.isSafeInteger(value[field]))), '중단 원본의 비용 값이 잘못됐습니다');
  }
  const cost = field => ({ sum: null, partialKnownSum: known(field).reduce((a, b) => a + b, 0),
    confirmedKnownCalls: known(field).length, recordedCalls: ledger.length,
    scope: 'confirmed recorded calls only; interrupted full-batch total is unknown' });
  const recorded = new Map(progress.records.map(r => [r.id, r]));
  const slots = plan.slots.map(slot => {
    const record = recorded.get(slot.id), calls = ledger.filter(e => e.context?.recordId === slot.id);
    return { ...slot, state: record?.state ?? (calls.length ? 'unknown' : 'unexecuted'),
      recordHash: record ? hash(record) : null, recordedCalls: calls.map(e => e.callId) };
  });
  return { schemaVersion: 1, type: 'date-interruption-inspection', planId: plan.id,
    planHash: hash(plan), sourceFiles, sourceManifestHash: hash(sourceFiles),
    paperEligible: false, blocksFinalReport: true, automaticResumeAllowed: false,
    records: structuredClone(progress.records), generationLedger: ledger, plannedSlots: slots,
    unresolvedCalls: ledger.filter(e => e.state === 'in-flight').map(e => e.callId),
    unboundCalls: ledger.filter(e => e.context?.recordId && !recorded.has(e.context.recordId)).map(e => e.callId),
    generationCost: { calls: null, recordedCalls: ledger.length, confirmedCalls: terminal.length,
      inputTokens: cost('inputTokens'), outputTokens: cost('outputTokens'), elapsedMs: cost('elapsedMs') },
    modelVerificationIssue: progress.modelVerificationIssue ?? null,
    warmupHistoryComplete: progress.warmupHistoryComplete ?? null,
    next: '담당자가 원본 호출·종료/시간초과·미확인 비용을 확인합니다. 원본을 고쳐 맞추거나 같은 자리를 임의 재실행하지 않습니다. 계속 확인 불가하면 이 중단 기록을 별도 보존하고 승인 자료·조건·사전 표본으로 새 실행 폴더를 준비합니다. 유진님은 실행·기록·전체 폴더 전달만 맡습니다.' };
}
