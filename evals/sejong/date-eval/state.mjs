import { hash, assert, validateRun, validateRecordedInputs } from './core.mjs';
import { DERIVED_METHODS, transformAnswer, methodPostprocessVersion } from './postprocess.mjs';

/** Execution-status inspection is not content grading. Preserve original data and audit. */
export function resolveRunState(plan, original, decisions) {
  validateRun(plan, original);
  assert(Array.isArray(decisions) && decisions.length > 0, '상태 확인 기록이 필요합니다');
  const run = structuredClone(original);
  assert(new Set(decisions.map((d) => d.recordId)).size === decisions.length, '중복 상태 확인');
  for (const d of decisions) {
    const record = run.records.find((r) => r.id === d.recordId);
    assert(!DERIVED_METHODS.includes(record?.methodId), 'T·V 상태는 원본 P를 확인한 뒤 자동으로 다시 연결합니다. 파생 답변만 임의로 확정할 수 없습니다');
    assert(record && d.originalRecordHash === hash(record), '상태 확인 원본 불일치');
    assert(d.reviewerId && typeof d.reason === 'string' && d.reason.trim() && typeof d.evidence === 'string' && d.evidence.trim(), '상태 확인 담당·근거·이유 누락');
    assert(['completed', 'failed', 'unexecuted'].includes(d.state), '상태 확인 값 오류');
    assert(record.state === 'unknown' || (record.state === 'completed' && d.state === 'failed'), '확정된 실패를 부분 답변으로 완료 처리할 수 없습니다');
    if (d.state === 'completed') assert(record.rawAnswer?.trim() && Number.isFinite(record.elapsedMs) && Number.isInteger(record.calls), '완료 원문/비용 누락');
    if (d.state === 'unexecuted') assert(record.calls === 0 && !record.rawAnswer?.trim(), '실제 호출·답변이 있는데 미실행 처리할 수 없습니다');
    const previousInspection = record.executionInspection;
    record.state = d.state;
    record.executionInspection = { ...d, beforeState: original.records.find((r) => r.id === d.recordId).state,
      ...(previousInspection ? { previousInspection } : {}) };
  }
  const rederived = [];
  for (const record of run.records.filter(r => DERIVED_METHODS.includes(r.methodId))) {
    const parent = run.records.find(p => p.id === record.derivation.parentRecordId);
    if (hash(parent) === record.derivation.parentRecordHash) continue;
    const beforeHash = hash(record), previousParentHash = record.derivation.parentRecordHash, began = performance.now();
    const c = plan.dataset.cases.find(c => c.id === record.caseId);
    record.state = parent.state; record.rawAnswer = parent.rawAnswer ?? ''; delete record.error;
    let audit = { status: 'parent-not-completed', parentState: parent.state };
    if (parent.state === 'completed') {
      try {
        const version = methodPostprocessVersion(plan.config.methods.find(m => m.id === record.methodId));
        const transformed = transformAnswer(c, parent.rawAnswer, record.methodId, { version });
        record.rawAnswer = transformed.answer; audit = transformed.audit;
      }
      catch (error) { record.state = 'unknown'; audit = { status: 'postprocess-error', message: error.message }; record.error = { type: 'postprocess-error', message: error.message }; }
    }
    // Keep the measured original service latency. Inspection/rederivation is
    // additional physical work, not a replacement for work already performed.
    record.postprocessInspections = [...(record.postprocessInspections ?? []), {
      sourceRecordHash: beforeHash, previousParentHash, parentRecordHash: hash(parent),
      elapsedMs: performance.now() - began,
    }];
    record.derivation = { ...record.derivation, parentRecordHash: hash(parent), parentAnswerHash: hash(parent.rawAnswer ?? ''), audit };
    record.rawInput[0].parentRecordHash = hash(parent);
    rederived.push({ recordId: record.id, originalRecordHash: beforeHash, recordHash: hash(record), reason: 'P execution status inspected; deterministic derivative rebuilt, original run retained' });
  }
  run.stateResolution = { auditVersion: 1, sourceRunHash: hash(original), decisions: structuredClone(decisions), rederived,
    derivedRecordHashes: Object.fromEntries(run.records.filter(r => DERIVED_METHODS.includes(r.methodId)).map(r => [r.id, hash(r)])) };
  return validateRecordedInputs(plan, validateRun(plan, run));
}
