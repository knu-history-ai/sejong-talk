/** Maintainer-only, read-only registration of an interrupted operator folder.
 * This is deliberately NOT run.json: unknown calls never become failures/zeros
 * and this artifact cannot be imported as a completed scored experiment. */
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { assert, hash, validatePlan, validateExecutionPlan, executionPlan, validateGenerationProgress } from './core.mjs';

export async function inspectInterruption(plan, folder) {
  validatePlan(plan);
  const sourceFiles = {}, sourceByteHashes = {}, storageArtifacts = [];
  async function bytes(name) {
    const value = await readFile(join(folder, name));
    sourceByteHashes[name] = createHash('sha256').update(value).digest('hex');
    return value;
  }
  async function read(name) {
    const value = JSON.parse((await bytes(name)).toString('utf8'));
    sourceFiles[name] = hash(value);
    return value;
  }
  const operator = validateExecutionPlan(await read('plan.json'));
  assert(hash(operator) === hash(executionPlan(plan)), '중단 폴더의 실행 계획이 담당자 원본과 다릅니다');
  let hasRun = false;
  try { await read('run.json'); hasRun = true; }
  catch (error) {
    if (error instanceof SyntaxError) storageArtifacts.push({ path: 'run.json', state: 'unreadable-final', sha256: sourceByteHashes['run.json'] });
    else if (error.code !== 'ENOENT') throw error;
  }
  assert(!hasRun, '완료 run.json이 있습니다. 중단 진단 대신 원본 import-run 검증을 사용하세요');
  let progress, progressStatus = 'committed';
  try { progress = await read('progress.json'); }
  catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    progressStatus = error.code === 'ENOENT' ? 'missing' : 'unreadable';
    storageArtifacts.push({ path: 'progress.json', state: progressStatus,
      sha256: sourceByteHashes['progress.json'] ?? null });
    // A temporary checkpoint is evidence, not an approved completion record.
    progress = { planId: plan.id, records: [] };
  }
  assert(progress?.planId === plan.id && Array.isArray(progress.records), '중단 진행 기록이 실행 계획과 다릅니다');
  const rootNames = await readdir(folder);
  let callNames = [];
  try { callNames = await readdir(join(folder, 'generation-calls')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pending = [
    ...rootNames.filter(n => /^(?:progress\.json\.tmp|run\.json\.pending-.+)$/.test(n)),
    ...callNames.filter(n => /^\d+\.json(?:\.tmp|\.pending-.+)$/.test(n)).map(n => join('generation-calls', n)),
  ].sort();
  for (const name of pending) {
    await bytes(name);
    storageArtifacts.push({ path: name, state: 'uncommitted-storage-artifact', sha256: sourceByteHashes[name] });
  }
  let names = [];
  names = callNames.filter(n => /^\d+\.json$/.test(n))
    .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
  const ledger = [], unreadableCalls = [];
  for (const name of names) {
    const path = join('generation-calls', name);
    try { ledger.push(await read(path)); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const callId = Number(name.slice(0, -5));
      unreadableCalls.push(callId);
      storageArtifacts.push({ path, callId, state: 'unreadable-call', sha256: sourceByteHashes[path] });
    }
  }
  // A legacy truncated canonical file cannot prove its request, result or cost.
  // Validate only the uninterrupted prefix; retain later readable originals as
  // unvalidated evidence, never manufacture a replacement call to fill the gap.
  const validatedLedger = unreadableCalls.length ? ledger.filter(e => e.callId < Math.min(...unreadableCalls)) : ledger;
  validateGenerationProgress(plan, unreadableCalls.length ? [] : progress.records, validatedLedger, { inspection: true });
  if (progress.inFlight) {
    const entry = ledger.find(e => hash(e.request) === hash(progress.inFlight.request)
      && hash(e.context) === hash(progress.inFlight.context)
      && typeof progress.inFlight.callFile === 'string'
      && 'generation-calls/' + String(e.callId).padStart(4, '0') + '.json' === progress.inFlight.callFile.replaceAll('\\', '/'));
    const unreadableMarker = unreadableCalls.some(callId => 'generation-calls/' + String(callId).padStart(4, '0') + '.json'
      === progress.inFlight.callFile?.replaceAll('\\', '/'));
    assert(entry || unreadableMarker, '진행 중 표시와 원본 호출 파일의 연결이 다릅니다');
  }
  const terminal = validatedLedger.filter(e => e.state !== 'in-flight');
  const result = entry => entry.state === 'completed' ? entry.result : entry;
  const known = field => terminal.map(e => result(e)?.[field]).filter(v => v != null);
  for (const entry of terminal) {
    const value = result(entry);
    for (const field of ['inputTokens', 'outputTokens', 'elapsedMs']) assert(value?.[field] == null
      || (Number.isFinite(value[field]) && value[field] >= 0
        && (field === 'elapsedMs' || Number.isSafeInteger(value[field]))), '중단 원본의 비용 값이 잘못됐습니다');
  }
  const cost = field => ({ sum: null, partialKnownSum: known(field).reduce((a, b) => a + b, 0),
    confirmedKnownCalls: known(field).length, recordedCalls: names.length,
    scope: 'validated uninterrupted ledger prefix only; interrupted full-batch total is unknown' });
  const recorded = new Map(progress.records.map(r => [r.id, r]));
  const checkpointUncertain = progressStatus !== 'committed' || pending.some(n => n === 'progress.json.tmp');
  const stagedCalls = pending.some(n => n.startsWith('generation-calls'));
  const slots = plan.slots.map(slot => {
    const record = recorded.get(slot.id), calls = ledger.filter(e => e.context?.recordId === slot.id);
    // Lost/uncommitted checkpoints can contain zero-call R/T/V work. Do not
    // certify those slots as never executed, nor promote temporary records.
    return { ...slot, state: unreadableCalls.length ? 'unknown'
      : record?.state ?? (calls.length || checkpointUncertain || stagedCalls ? 'unknown' : 'unexecuted'),
      recordHash: record ? hash(record) : null, recordedCalls: calls.map(e => e.callId) };
  });
  return { schemaVersion: 1, type: 'date-interruption-inspection', planId: plan.id,
    planHash: hash(plan), sourceFiles, sourceManifestHash: hash(sourceFiles),
    sourceByteHashes, sourceByteManifestHash: hash(sourceByteHashes), storageArtifacts, progressStatus,
    paperEligible: false, blocksFinalReport: true, automaticResumeAllowed: false,
    records: structuredClone(progress.records), generationLedger: ledger, plannedSlots: slots,
    ledgerValidationStatus: unreadableCalls.length ? 'incomplete-unreadable-call' : 'validated',
    recordsValidated: unreadableCalls.length === 0,
    unvalidatedCalls: unreadableCalls.length ? [...new Set([...unreadableCalls,
      ...ledger.filter(e => !validatedLedger.includes(e)).map(e => e.callId)])].sort((a, b) => a - b) : [],
    unresolvedCalls: [...new Set([...unreadableCalls, ...ledger.filter(e => e.state === 'in-flight').map(e => e.callId)])].sort((a, b) => a - b),
    unboundCalls: ledger.filter(e => e.context?.recordId && !recorded.has(e.context.recordId)).map(e => e.callId),
    generationCost: { calls: null, recordedCalls: names.length, readableRecordedCalls: ledger.length, confirmedCalls: terminal.length,
      inputTokens: cost('inputTokens'), outputTokens: cost('outputTokens'), elapsedMs: cost('elapsedMs') },
    modelVerificationIssue: progress.modelVerificationIssue ?? null,
    warmupHistoryComplete: progress.warmupHistoryComplete ?? null,
    next: '담당자가 원본 호출·종료/시간초과·미확인 비용을 확인합니다. 원본을 고쳐 맞추거나 같은 자리를 임의 재실행하지 않습니다. 계속 확인 불가하면 이 중단 기록을 별도 보존하고 승인 자료·조건·사전 표본으로 새 실행 폴더를 준비합니다. 유진님은 실행·기록·전체 폴더 전달만 맡습니다.' };
}
