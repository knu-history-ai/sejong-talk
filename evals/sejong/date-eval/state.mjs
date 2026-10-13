import { hash, assert, validateRun, validateRecordedInputs } from './core.mjs';

/** Execution-status inspection is not content grading. Preserve original data and audit. */
export function resolveRunState(plan, original, decisions) {
  validateRun(plan, original);
  assert(Array.isArray(decisions) && decisions.length > 0, '상태 확인 기록이 필요합니다');
  const run = structuredClone(original);
  assert(new Set(decisions.map((d) => d.recordId)).size === decisions.length, '중복 상태 확인');
  for (const d of decisions) {
    const record = run.records.find((r) => r.id === d.recordId);
    assert(record && d.originalRecordHash === hash(record), '상태 확인 원본 불일치');
    assert(d.reviewerId && typeof d.reason === 'string' && d.reason.trim() && typeof d.evidence === 'string' && d.evidence.trim(), '상태 확인 담당·근거·이유 누락');
    assert(['completed', 'failed', 'unexecuted'].includes(d.state), '상태 확인 값 오류');
    assert(record.state === 'unknown' || (record.state === 'completed' && d.state === 'failed'), '확정된 실패를 부분 답변으로 완료 처리할 수 없습니다');
    if (d.state === 'completed') assert(record.rawAnswer?.trim() && Number.isFinite(record.elapsedMs) && Number.isInteger(record.calls), '완료 원문/비용 누락');
    if (d.state === 'unexecuted') assert(record.calls === 0 && !record.rawAnswer?.trim(), '실제 호출·답변이 있는데 미실행 처리할 수 없습니다');
    record.state = d.state;
    record.executionInspection = { ...d, beforeState: original.records.find((r) => r.id === d.recordId).state };
  }
  run.stateResolution = { sourceRunHash: hash(original), decisions: structuredClone(decisions) };
  return validateRecordedInputs(plan, validateRun(plan, run));
}
