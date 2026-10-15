import { createHash } from 'node:crypto';
import { DERIVED_METHODS, methodPostprocessVersion, transformAnswer, ruleAnswer } from './postprocess.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
export function hash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function unique(values, label) {
  assert(new Set(values).size === values.length, `${label}: 중복 ID`);
}
function generationCompletionVersion(config) {
  const version = Object.hasOwn(config, 'generationCompletionVersion') ? config.generationCompletionVersion : 1;
  assert([1, 2].includes(version), '지원하지 않는 생성 완료 판정 버전');
  assert(version !== 2 || config.generationAuditVersion === 1, '생성 완료 판정 v2는 원본 감사 버전 1이 필요합니다');
  return version;
}
export function criteriaHash(gold) {
  return hash({ criteriaVersion: gold.criteriaVersion, rubric: gold.rubric, cases: gold.cases });
}
export function validatePlan(plan) {
  assert(plan.gold && !plan.executionOnly, '정답표가 있는 담당자용 계획이 필요합니다');
  return validateExecutionPlan(plan);
}
/** Operator plans retain frozen hashes and inputs, but never contain the answer key. */
export function validateExecutionPlan(plan) {
  assert(plan.schemaVersion === 1, '지원하지 않는 계획 버전');
  assert(plan.datasetHash === hash(plan.dataset), '자료/질문 버전이 변경됐습니다');
  if (plan.executionOnly) {
    assert(!Object.hasOwn(plan, 'gold'), '실행용 계획에 정답표를 넣을 수 없습니다');
    assert(['draft', 'approved'].includes(plan.goldReviewStatus), '정답표 검토 상태 누락');
    assert(plan.config.datasetApproval?.goldReviewStatus === plan.goldReviewStatus, '실행용 검수 승인 상태가 고정 설정과 다릅니다');
    for (const field of ['goldHash', 'criteriaHash']) assert(/^[a-f0-9]{64}$/.test(plan[field]), '비공개 계획 연결 해시 누락');
  } else {
    assert(plan.goldHash === hash(plan.gold), '정답표 버전이 변경됐습니다');
    assert(plan.criteriaHash === criteriaHash(plan.gold), '채점 기준이 변경됐습니다');
    assert(plan.gold.datasetHash === plan.datasetHash, '정답표와 자료 버전이 다릅니다');
    assert(['draft', 'approved'].includes(plan.gold.reviewStatus), '정답표 검토 상태 누락');
    if (plan.config.datasetApproval) assert(hash(plan.config.datasetApproval) === hash({ goldReviewStatus: plan.gold.reviewStatus,
      reviewedBy: plan.gold.reviewedBy ?? [] }), '검수 승인 기록이 고정 설정과 다릅니다');
  }
  assert(plan.configHash === hash(plan.config), '실행 조건이 변경됐습니다');
  assert(plan.id === hash({ datasetHash: plan.datasetHash, goldHash: plan.goldHash, configHash: plan.configHash }), '계획 ID가 맞지 않습니다');
  assert(['pilot', 'development', 'final'].includes(plan.dataset.split), '자료 구분 누락');
  if (plan.dataset.split === 'final' && plan.config.generationAuditVersion === 1) {
    const approval = plan.config.datasetApproval;
    assert(approval?.goldReviewStatus === 'approved' && Array.isArray(approval.reviewedBy)
      && approval.reviewedBy.length > 0 && approval.reviewedBy.every(id => typeof id === 'string' && id.trim()),
    '본실험은 실제 검수자 기록과 승인된 정답표가 필요합니다');
  }
  assert(Number.isInteger(plan.config.repeats) && plan.config.repeats > 0, '반복 횟수 오류');
  assert(Number.isInteger(plan.config.retries) && plan.config.retries >= 0 && plan.config.retries <= 5, '재시도 횟수는 0~5회');
  assert(Number.isFinite(plan.config.timeoutMs) && plan.config.timeoutMs > 0 && plan.config.timeoutMs <= 2147483647, '시간 제한 오류');
  assert(typeof plan.config.model === 'string' && plan.config.model.length > 0, '모델 누락');
  generationCompletionVersion(plan.config);
  assert(plan.config.environmentAuditVersion === undefined || plan.config.environmentAuditVersion === 1,
    '지원하지 않는 실행 환경 감사 버전');
  assert(plan.config.environmentAuditVersion !== 1 || plan.config.generationAuditVersion === 1,
    '실행 환경 감사 v1은 원본 생성 감사 버전 1이 필요합니다');
  if (Object.hasOwn(plan.config, 'think')) assert(typeof plan.config.think === 'boolean', 'thinking 설정은 boolean이어야 합니다');
  unique(plan.dataset.cases.map((c) => c.id), '질문');
  if (plan.gold) unique(plan.gold.cases.map((c) => c.id), '정답');
  unique(plan.config.methods.map((m) => m.id), '방법');
  unique(plan.slots.map((s) => s.id), '실행 자리');
  assert(plan.dataset.cases.length > 0 && plan.config.methods.length > 0, '빈 계획');
  for (const c of plan.dataset.cases) {
    assert(Array.isArray(c.targets) && c.targets.length > 0, `${c.id}: 대상 사건이 없습니다`);
    assert(c.sourceText && c.question && c.articleId && c.groupId, `${c.id}: 자료/질문/그룹 누락`);
    unique(c.targets.map((t) => t.id), `${c.id} 사건`);
    if (!plan.gold) continue;
    const key = plan.gold.cases.find((g) => g.id === c.id);
    assert(key && key.events.length === c.targets.length, `${c.id}: 정답 사건 수 불일치`);
    unique(c.targets.map((t) => t.id), `${c.id} 사건`);
    for (const target of c.targets) {
      const event = key.events.find((e) => e.id === target.id);
      assert(event && event.expected && Array.isArray(event.required), `${c.id}/${target.id}: 정답 누락`);
      for (const flag of ['unsupportedDay', 'missingKnownDay', 'headerConfusion']) {
        assert(typeof event.eligibility?.[flag] === 'boolean', `${c.id}: 지표 적용 범위 누락`);
      }
      assert(event.evidence?.length > 0, `${c.id}: 인용 근거 누락`);
      for (const e of event.evidence) {
        assert(Number.isInteger(e.start) && Number.isInteger(e.end) && e.start >= 0 && e.end > e.start && e.end <= c.sourceText.length, `${c.id}: 근거 인용 위치 누락`);
        assert(c.sourceText.slice(e.start, e.end) === e.quote, `${c.id}: 근거 인용 위치 불일치`);
      }
    }
  }
  if (plan.gold) assert(plan.gold.cases.length === plan.dataset.cases.length, '정답표에 다른 질문이 포함됐습니다');
  if (plan.config.methods.some(m => DERIVED_METHODS.includes(m.id))) {
    assert(plan.config.methods.some(m => m.id === 'prompt-baseline'), 'T·V는 같은 계획의 P 원본이 필요합니다');
  }
  const expected = [];
  for (const m of plan.config.methods) {
    assert(m.version, '방법 버전 누락');
    if (DERIVED_METHODS.includes(m.id)) methodPostprocessVersion(m);
    for (const c of plan.dataset.cases) {
      for (let repeat = 1; repeat <= plan.config.repeats; repeat++) expected.push(`${m.id}/${c.id}/${repeat}`);
    }
  }
  assert(plan.slots.length === expected.length, '실행 자리 수 불일치');
  unique(plan.slots.map((s) => `${s.methodId}/${s.caseId}/${s.repeat}`), '실행 조합');
  for (const s of plan.slots) assert(expected.includes(`${s.methodId}/${s.caseId}/${s.repeat}`), '계획 밖 실행 자리');
  return plan;
}
export function validateRun(plan, run) {
  validatePlan(plan);
  return validateExecutionRun(plan, run);
}
export function validateExecutionRun(plan, run) {
  validateExecutionPlan(plan);
  for (const field of ['datasetHash', 'goldHash', 'criteriaHash', 'configHash']) {
    assert(run[field] === plan[field], `${field}: 실행 버전 불일치`);
  }
  assert(run.schemaVersion === 1 && run.planId === plan.id, '실행 계획 불일치');
  unique(run.records.map((r) => r.id), '결과');
  assert(run.records.length === plan.slots.length, '빠진 결과가 있습니다. 미실행도 기록해야 합니다');
  for (const r of run.records) {
    const slot = plan.slots.find((s) => s.id === r.id);
    assert(slot && ['caseId', 'repeat', 'methodId'].every((k) => slot[k] === r[k]), '계획 밖 결과');
    assert(['completed', 'failed', 'unexecuted', 'unknown'].includes(r.state), '실행 상태 오류');
    if (r.state === 'completed') assert(typeof r.rawAnswer === 'string' && r.rawAnswer.trim(), '완료 답변 누락');
    if (r.state === 'completed' || r.state === 'failed') {
      assert(Number.isFinite(r.elapsedMs) && r.elapsedMs >= 0, '처리 시간 누락');
      assert(Number.isInteger(r.calls) && r.calls >= 0, '호출 수 누락');
    }
    for (const k of ['inputTokens', 'outputTokens']) assert(r[k] == null || (Number.isSafeInteger(r[k]) && r[k] >= 0), '토큰 수 오류');
  }
  validateDerivations(plan, run.records);
  validateDerivedInspectionAudit(plan, run);
  validateEnvironmentHistory(plan, run);
  return run;
}

/** New plans pin this contract. Legacy completed runs remain readable without
 * inventing a historical environment; checkpoints without it cannot resume. */
export function validateEnvironmentHistory(plan, run, { partial = false } = {}) {
  const history = run.environmentHistory;
  if (!history && plan.config.environmentAuditVersion !== 1) return;
  assert(Array.isArray(history) && history.length > 0, '실행 환경 이력이 없습니다. 과거 환경을 소급 인증할 수 없습니다');
  const ledger = run.generationLedger ?? [], records = run.records ?? [];
  const identity = value => ({ name: value?.name, digest: value?.digest,
    quantization: value?.details?.quantization_level ?? null });
  const generated = plan.config.methods.some(m => m.id !== 'rule-baseline' && !DERIVED_METHODS.includes(m.id));
  const first = history[0];
  for (const [index, segment] of history.entries()) {
    assert(segment && typeof segment === 'object' && !Array.isArray(segment), '실행 환경 구간 형식 오류');
    const { segmentHash, ...body } = segment;
    assert(segment.schemaVersion === 1 && segment.planId === plan.id && segment.index === index + 1
      && segment.previousHash === (history[index - 1]?.segmentHash ?? null)
      && segmentHash === hash(body), '실행 환경 이력의 연결·해시가 다릅니다');
    const env = segment.environment;
    assert(env && ['platform', 'release', 'arch', 'hostHash', 'cpu', 'node'].every(k => typeof env[k] === 'string' && env[k].trim())
      && /^[a-f0-9]{64}$/.test(env.hostHash) && Number.isSafeInteger(env.cpus) && env.cpus > 0
      && Number.isSafeInteger(env.memoryBytes) && env.memoryBytes > 0, '실행 환경 기록이 불완전합니다');
    assert(hash(env) === hash(first.environment), '재개 전 실행 환경이 바뀌었습니다. 같은 실행으로 합칠 수 없습니다');
    assert(typeof segment.startedAt === 'string' && Number.isFinite(Date.parse(segment.startedAt))
      && (!index || Date.parse(segment.startedAt) >= Date.parse(history[index - 1].startedAt)), '환경 구간 시작 시각 오류');
    assert(Number.isSafeInteger(segment.callCount) && segment.callCount >= 0 && segment.callCount <= ledger.length
      && Array.isArray(segment.recordIds) && segment.recordIds.length <= records.length
      && hash(segment.recordIds) === hash(records.slice(0, segment.recordIds.length).map(r => r.id))
      && segment.ledgerPrefixHash === hash(ledger.slice(0, segment.callCount)), '환경 구간의 이전 결과·호출 연결이 다릅니다');
    assert(index ? segment.callCount >= history[index - 1].callCount
      && segment.recordIds.length >= history[index - 1].recordIds.length
      : segment.callCount === 0 && segment.recordIds.length === 0, '최초 실행 또는 재개 구간이 누락됐습니다');
    assert(generated ? segment.modelBefore?.name && segment.modelBefore?.digest
      && hash(identity(segment.modelBefore)) === hash(identity(plan.config.modelIdentity))
      : segment.modelBefore === null, '환경 구간의 실행 전 모델 확인 기록이 고정 계획과 다릅니다');
    const end = history[index + 1]?.callCount ?? ledger.length;
    assert(ledger.slice(segment.callCount, end).every(entry => entry.environmentSegmentHash === segmentHash),
      '생성 호출의 환경 구간 연결이 다릅니다');
  }
  if (!partial) {
    assert(hash(run.environment) === hash(first.environment), '최종 환경이 최초 실행 환경과 다릅니다');
    assert(history.length <= 1 || run.resumed === true, '재개 구간이 있는 실행을 새 실행으로 표시할 수 없습니다');
    if (generated) assert(hash(run.modelVerification?.before) === hash(first.modelBefore),
      '최종 실행 전 모델 확인값이 최초 구간과 다릅니다');
  }
}

export function executionPlan(plan) {
  validatePlan(plan);
  const { gold, ...publicPlan } = structuredClone(plan);
  return validateExecutionPlan({ ...publicPlan, executionOnly: true, goldReviewStatus: gold.reviewStatus });
}

/** Recompute deterministic outputs; matching IDs alone do not establish shared P provenance. */
export function validateDerivations(plan, records) {
  for (const r of records.filter(r => DERIVED_METHODS.includes(r.methodId))) {
    const version = methodPostprocessVersion(plan.config.methods.find(m => m.id === r.methodId));
    const parent = records.find(p => p.methodId === 'prompt-baseline' && p.caseId === r.caseId && p.repeat === r.repeat);
    assert(parent && r.derivation?.parentRecordId === parent.id && r.derivation.parentRecordHash === hash(parent)
      && r.derivation.parentAnswerHash === hash(parent.rawAnswer ?? '') && r.derivation.version === version, 'T·V 원본 P 연결/버전 불일치');
    assert(r.calls === 0 && r.inputTokens === 0 && r.outputTokens === 0 && Array.isArray(r.attempts) && r.attempts.length === 0, 'T·V 추가 모델 호출/토큰은 0이어야 합니다');
    assert(Number.isFinite(r.elapsedMs) && r.elapsedMs >= 0, 'T·V 후처리 시간 오류');
    if (r.postprocessInspections !== undefined) {
      assert(Array.isArray(r.postprocessInspections) && r.postprocessInspections.length > 0
        && r.postprocessInspections.every(i => Number.isFinite(i.elapsedMs) && i.elapsedMs >= 0
          && ['sourceRecordHash', 'previousParentHash', 'parentRecordHash'].every(f => typeof i[f] === 'string' && /^[a-f0-9]{64}$/.test(i[f])))
        && r.postprocessInspections.at(-1).parentRecordHash === hash(parent), 'T·V 상태 정정 비용/연결 오류');
    }
    const c = plan.dataset.cases.find(c => c.id === r.caseId);
    const expectedInput = [{ stage: 'postprocess', sourceText: c.sourceText, question: c.question, targets: c.targets,
      parentRecordId: parent.id, parentRecordHash: hash(parent), version }];
    assert(hash(r.rawInput) === hash(expectedInput), 'T·V 실제 후처리 입력 불일치');
    if (parent.state !== 'completed') {
      assert(r.state === parent.state && r.rawAnswer === (parent.rawAnswer ?? '') && r.derivation.audit.status === 'parent-not-completed', 'P 실패·미확인 상태 전파 불일치');
    } else if (r.derivation.audit.status === 'postprocess-error') {
      assert(r.state === 'unknown' && r.rawAnswer === parent.rawAnswer && r.error?.type === 'postprocess-error', '후처리 오류를 완료/실패로 바꿀 수 없습니다');
    } else {
      const result = transformAnswer(c, parent.rawAnswer, r.methodId, { version });
      assert(r.state === 'completed' && r.rawAnswer === result.answer && hash(r.derivation.audit) === hash(result.audit), 'T·V 결과/감사 기록이 고정 변환과 다릅니다');
    }
  }
}
export function makePlan(dataset, gold, config) {
  config = { think: false, ...config, datasetApproval: { goldReviewStatus: gold.reviewStatus, reviewedBy: gold.reviewedBy ?? [] } };
  const datasetHash = hash(dataset);
  const goldHash = hash(gold);
  const configHash = hash(config);
  const plan = { schemaVersion: 1, dataset, gold, config, datasetHash, goldHash, criteriaHash: criteriaHash(gold), configHash };
  plan.id = hash({ datasetHash, goldHash, configHash });
  plan.slots = config.methods.flatMap((m) => dataset.cases.flatMap((c) =>
    Array.from({ length: config.repeats }, (_, i) => ({
      id: hash({ planId: plan.id, methodId: m.id, caseId: c.id, repeat: i + 1 }).slice(0, 24),
      methodId: m.id, caseId: c.id, repeat: i + 1,
    }))));
  return validatePlan(plan);
}

/** Imported or status-confirmed runs must retain actual requests, not just copied plan hashes. */
export function validateRecordedInputs(plan, run) {
  validateEnvironmentHistory(plan, run);
  validateRecordedRecords(plan, run.records);
  validateDerivedInspectionAudit(plan, run);
  if (plan.config.generationAuditVersion === 1) {
    validateGenerationLedger(plan, run);
    validateGenerationTimes(plan, run);
  }
  return run;
}

function validateDerivedInspectionAudit(plan, run) {
  const derived = run.records.filter(r => DERIVED_METHODS.includes(r.methodId));
  if (!derived.some(r => r.postprocessInspections?.length)) return;
  const audit = run.stateResolution;
  // Old synthetic/partial histories predate the resolution snapshot. Keep them
  // readable without certifying them as fully audited new executions.
  if (!audit && plan.config.generationAuditVersion !== 1) return;
  assert(audit && Array.isArray(audit.rederived), 'T·V 재검사의 상태 확인 감사 기록이 없습니다');
  // Older resolutions retained hashes only for the latest changed subset.
  // New resolutions snapshot every derived record so unrelated later state
  // decisions cannot silently drop protection of earlier original timings.
  for (const entry of audit.rederived) {
    const record = derived.find(r => r.id === entry.recordId);
    assert(record && entry.recordHash === hash(record), 'T·V 재검사 이후 원기록·시간이 변경됐습니다');
  }
  if (audit.auditVersion === 1) {
    assert(audit.derivedRecordHashes && !Array.isArray(audit.derivedRecordHashes)
      && hash(audit.derivedRecordHashes) === hash(Object.fromEntries(derived.map(r => [r.id, hash(r)]))),
    'T·V 재검사 원기록·시간 해시가 다릅니다');
  }
}

function validateRecordedRecords(plan, records) {
  for (const record of records) {
    if (record.state === 'unexecuted') {
      assert((record.calls ?? 0) === 0 && !record.rawAnswer?.trim()
        && (record.attempts === undefined || (Array.isArray(record.attempts) && record.attempts.length === 0))
        && ['inputTokens', 'outputTokens'].every(field => record[field] == null || record[field] === 0),
      '실제 호출·답변·비용이 있는데 미실행으로 처리할 수 없습니다');
      continue;
    }
    const c = plan.dataset.cases.find(c => c.id === record.caseId);
    assert(Array.isArray(record.rawInput) && record.rawInput.length > 0, '실제로 보낸 전체 자료·질문이 없습니다');
    if (DERIVED_METHODS.includes(record.methodId)) {
      validateDerivations(plan, records);
    } else if (record.methodId === 'rule-baseline') {
      assert(record.rawInput.length === 1 && record.rawInput[0].sourceText === c.sourceText
        && record.rawInput[0].question === c.question && hash(record.rawInput[0].targets) === hash(c.targets), '규칙 입력 자료·질문·대상 불일치');
      if (plan.config.generationAuditVersion === 1) {
        assert(record.calls === 0 && record.inputTokens === 0 && record.outputTokens === 0
          && Array.isArray(record.attempts) && record.attempts.length === 0, '규칙 방식의 모델 호출·시도·토큰은 0이어야 합니다');
        if (record.state === 'completed') assert(record.rawAnswer === ruleAnswer(c), '규칙 원답변이 고정된 계산 결과와 다릅니다');
        if (record.state === 'failed') {
          let ruleError;
          try { ruleAnswer(c); } catch (error) { ruleError = error; }
          assert((ruleError && record.error?.message === ruleError.message && !record.rawAnswer?.trim())
            || validInspection(record, 'failed'), '규칙 실패의 실행 오류 또는 상태 확인 근거가 없습니다');
        }
      }
    } else {
      const requests = [...record.rawInput, ...(record.attempts ?? []).map(attempt => attempt.request)];
      for (const request of requests) {
        assert(request?.model === plan.config.model && hash(request.options) === hash(plan.config.options), '실제 요청 모델·옵션이 고정 계획과 다릅니다');
        if (Object.hasOwn(plan.config, 'think')) assert(request.think === plan.config.think, '실제 요청 thinking 설정이 고정 계획과 다릅니다');
        assert(typeof request.prompt === 'string' && request.prompt.includes(c.sourceText)
          && request.prompt.includes(c.question), '실제로 보낸 전체 자료·질문이 없습니다');
      }
      validateGenerationTrace(plan, record);
    }
  }
}

/** A partial checkpoint is not a scored run. Resume must prove all old calls
 * are bound before issuing even one new request; inspection may retain orphans. */
export function validateGenerationProgress(plan, records, ledger, { inspection = false } = {}) {
  assert(Array.isArray(records) && Array.isArray(ledger), '진행 기록·호출 명세가 없습니다');
  unique(records.map(r => r.id), '진행 결과');
  for (const record of records) assert(plan.slots.some(s => s.id === record.id
    && ['caseId', 'repeat', 'methodId'].every(k => s[k] === record[k])), '계획 밖 진행 기록');
  for (const record of records) {
    assert(['completed', 'failed', 'unknown', 'unexecuted'].includes(record.state), '진행 기록 실행 상태 오류');
    assert(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0
      && Number.isInteger(record.calls) && record.calls >= 0, '진행 기록 시간·호출 오류');
    for (const field of ['inputTokens', 'outputTokens']) assert(record[field] == null
      || (Number.isSafeInteger(record[field]) && record[field] >= 0), '진행 기록 토큰 오류');
    if (record.state === 'completed') assert(typeof record.rawAnswer === 'string' && record.rawAnswer.trim(), '완료 진행 원답변 누락');
  }
  validateRecordedRecords(plan, records);
  if (plan.config.generationAuditVersion === 1) {
    const warmup = ledger.filter(e => e.context?.stage === 'warmup' && e.state === 'completed')
      .map(e => ({ request: e.request, result: e.result }));
    validateGenerationLedger(plan, { records, generationLedger: ledger, warmup },
      { verifyModel: false, inspection });
  }
  validateGenerationTimes(plan, { records, generationLedger: ledger,
    warmup: ledger.filter(e => e.context?.stage === 'warmup' && e.state === 'completed')
      .map(e => ({ request: e.request, result: e.result })) }, { partial: true });
}

function validInspection(record, state) {
  const inspection = record.executionInspection;
  if (!inspection || inspection.recordId !== record.id || inspection.state !== state
    || !['unknown', 'completed'].includes(inspection.beforeState)
    || (inspection.beforeState === 'completed' && state !== 'failed')
    || !['reviewerId', 'reason', 'evidence'].every(k => typeof inspection[k] === 'string' && inspection[k].trim())) return false;
  const original = { ...record, state: inspection.beforeState };
  if (inspection.previousInspection) original.executionInspection = inspection.previousInspection;
  else delete original.executionInspection;
  return /^[a-f0-9]{64}$/.test(inspection.originalRecordHash ?? '')
    && hash(original) === inspection.originalRecordHash;
}

function validateGenerationTrace(plan, record) {
  const strict = plan.config.generationAuditVersion === 1;
  const completionVersion = generationCompletionVersion(plan.config);
  assert(Array.isArray(record.attempts), '생성 시도 기록이 없습니다');
  const full = record.attempts.length === record.calls;
  assert(!strict || full, '생성 호출 수와 시도 기록이 다릅니다');
  // Older partial-cost analyses remain readable, but are not certified as a
  // complete new execution. Newly prepared plans require the full call ledger.
  if (!full) return;
  const stages = record.methodId === 'evidence-first' ? ['extract', 'answer'] : ['answer'];
  let cursor = 0, inputs = 0, last;
  for (const stage of stages) {
    const group = [];
    while (record.attempts[cursor]?.stage === stage) group.push(record.attempts[cursor++]);
    assert(group.length > 0 && group.length <= plan.config.retries + 1, '생성 단계·재시도 횟수가 고정 계획과 다릅니다');
    const request = record.rawInput[inputs++];
    for (const [index, attempt] of group.entries()) {
      assert(attempt.attempt === index && ['completed', 'failed'].includes(attempt.state)
        && (index === group.length - 1 || attempt.state === 'failed'), '생성 시도 순서·상태가 잘못됐습니다');
      assert(request?.stage === stage && hash(attempt.request) === hash(request), '생성 시도와 단계별 실제 요청이 다릅니다');
      if (attempt.state === 'completed') validateWireAnswer(attempt, strict);
      else if (strict) validateFailureUsage(attempt);
    }
    last = group.at(-1);
    if (last.state === 'failed') {
      assert(group.length === plan.config.retries + 1, '허용된 생성 재시도를 끝내기 전에 종료됐습니다');
      break;
    }
  }
  assert(cursor === record.attempts.length && inputs === record.rawInput.length, '생성 단계 순서·추가 호출이 고정 계획과 다릅니다');
  if (strict) for (const field of ['inputTokens', 'outputTokens']) {
    const values = record.attempts.map(attempt => attempt[field]);
    const expected = values.some(value => value == null) ? null : values.reduce((a, b) => a + b, 0);
    assert(record[field] === expected, '생성 시도 토큰의 합계·미확인 범위가 기록과 다릅니다');
  }
  const answered = last?.stage === 'answer' && last.state === 'completed';
  if (record.state === 'completed' || record.rawAnswer?.trim()) {
    assert(answered && record.rawAnswer === last.answer, '집계 답변이 마지막 생성 원답변과 다릅니다');
  }
  if (record.state === 'completed') assert(answered, '완료된 최종 답변 호출이 없습니다');
  // Missing/v1 pins retain the historical last-call policy when reading old
  // runs. V2 also requires inspection of truncated successful extractions.
  const lengthLimited = completionVersion === 2
    ? record.attempts.some(attempt => attempt.state === 'completed' && attempt.finishReason === 'length')
    : last?.state === 'completed' && last.finishReason === 'length';
  if (strict && record.state === 'completed' && lengthLimited) {
    assert(validInspection(record, 'completed'), '길이 제한 원답변은 원기록에 연결된 담당자 상태 확인이 필요합니다');
  }
  if (strict && record.executionInspection) assert(validInspection(record, record.state), '실행 상태 확인의 원기록·담당·근거 연결이 다릅니다');
  if (strict && record.state === 'failed') assert(last.state === 'failed' || validInspection(record, 'failed'),
  '생성 성공 기록을 확인 근거 없이 실패로 바꿀 수 없습니다');
}

function validateFailureUsage(attempt) {
  let output;
  try { output = JSON.parse(attempt.raw); } catch { /* Unparseable transport has no confirmed usage. */ }
  if (!output || typeof output !== 'object' || Array.isArray(output)) output = {};
  for (const [field, wire] of [['inputTokens', 'prompt_eval_count'], ['outputTokens', 'eval_count']]) {
    const expected = Number.isSafeInteger(output[wire]) && output[wire] >= 0 ? output[wire] : null;
    assert((attempt[field] ?? null) === expected, '실패 원응답과 토큰 기록이 다릅니다');
  }
}

function validateWireAnswer(attempt, strict) {
  let output;
  try { output = JSON.parse(attempt.raw); } catch { /* Legacy injected generators can lack a transport body. */ }
  assert(!strict || (output && typeof output === 'object' && !Array.isArray(output)), '생성 원응답 JSON이 없습니다');
  if (!output || !Object.hasOwn(output, 'response')) {
    assert(!strict, '생성 원응답에 답변이 없습니다');
    return;
  }
  assert(output.done === true && !output.error && typeof output.response === 'string'
    && output.response === attempt.answer, '생성 원응답과 해석한 답변이 다릅니다');
  if (strict || Object.hasOwn(output, 'done_reason')) assert((output.done_reason ?? null) === (attempt.finishReason ?? null), '생성 원응답의 종료 사유가 다릅니다');
  for (const [field, wire] of [['inputTokens', 'prompt_eval_count'], ['outputTokens', 'eval_count']]) {
    const expected = Number.isSafeInteger(output[wire]) && output[wire] >= 0 ? output[wire] : null;
    if (strict || Object.hasOwn(output, wire)) assert((attempt[field] ?? null) === expected, '생성 원응답과 토큰 기록이 다릅니다');
  }
}

/** New operator runs embed the original ledger; import also checks its files. */
function validateGenerationLedger(plan, run, { verifyModel = true, inspection = false } = {}) {
  const ledger = run.generationLedger;
  assert(Array.isArray(ledger), '원본 생성 호출 명세가 없습니다');
  const hasGeneration = plan.config.methods.some(m => !DERIVED_METHODS.includes(m.id) && m.id !== 'rule-baseline');
  if (hasGeneration && verifyModel) {
    const identity = value => ({ name: value?.name, digest: value?.digest,
      quantization: value?.details?.quantization_level ?? null });
    const expected = identity(plan.config.modelIdentity);
    assert(expected.name && expected.digest && run.modelVerification?.before && run.modelVerification?.after
      && ['before', 'after'].every(key => hash(identity(run.modelVerification[key])) === hash(expected)),
    '실행 전후 모델 파일·양자화 확인 기록이 고정 계획과 다릅니다');
  }
  unique(ledger.map(e => e.callId), '생성 호출');
  const calls = new Map();
  const warmups = [];
  for (const [index, entry] of ledger.entries()) {
    assert(entry.schemaVersion === 1 && entry.planId === plan.id && entry.callId === index + 1,
      '생성 호출 명세의 계획·번호·누락이 잘못됐습니다');
    assert(['completed', 'failed', ...(inspection ? ['in-flight'] : [])].includes(entry.state), '미확인 생성 호출은 확정할 수 없습니다');
    assert(entry.request?.model === plan.config.model && entry.request.think === plan.config.think
      && hash(entry.request.options) === hash(plan.config.options), '호출 원본의 모델·옵션이 계획과 다릅니다');
    if (entry.state === 'failed') validateFailureUsage(entry);
    if (entry.context?.stage === 'warmup') {
      assert(entry.context.recordId === null && entry.context.attempt === 0
        && (entry.state === 'completed' || inspection), '준비 호출 명세가 잘못됐습니다');
      assert(plan.config.warmup && entry.request?.stage === 'warmup' && entry.request.model === plan.config.model
        && entry.request.think === plan.config.think && hash(entry.request.options) === hash(plan.config.options),
      '준비 호출 조건이 고정 계획과 다릅니다');
      if (entry.state === 'completed') {
        validateWireAnswer(entry.result, true);
        warmups.push({ request: entry.request, result: entry.result });
      }
    } else {
      const slot = plan.slots.find(s => s.id === entry.context?.recordId);
      assert(slot && !DERIVED_METHODS.includes(slot.methodId) && slot.methodId !== 'rule-baseline'
        && ['caseId', 'methodId', 'repeat'].every(k => entry.context[k] === slot[k])
        && ['answer', ...(slot.methodId === 'evidence-first' ? ['extract'] : [])].includes(entry.context.stage)
        && entry.request.stage === entry.context.stage && Number.isInteger(entry.context.attempt)
        && entry.context.attempt >= 0 && entry.context.attempt <= plan.config.retries, '호출 원본의 실행 자리·단계·재시도가 다릅니다');
      const c = plan.dataset.cases.find(c => c.id === slot.caseId);
      assert(typeof entry.request.prompt === 'string' && entry.request.prompt.includes(c.sourceText)
        && entry.request.prompt.includes(c.question), '호출 원본의 자료·질문이 없습니다');
      if (entry.state === 'completed') validateWireAnswer(entry.result, true);
      const key = JSON.stringify([entry.context?.recordId, entry.context?.stage, entry.context?.attempt]);
      assert(!calls.has(key), '중복 생성 단계·시도 명세');
      calls.set(key, entry);
    }
  }
  assert(!plan.config.warmup || calls.size === 0 || warmups.length > 0, '계획에 있는 준비 호출 원본이 없습니다');
  assert(hash(warmups) === hash(run.warmup ?? []), '준비 호출 원본 명세와 실행 기록이 다릅니다');
  for (const record of run.records.filter(r => !DERIVED_METHODS.includes(r.methodId) && r.methodId !== 'rule-baseline')) {
    for (const attempt of record.attempts ?? []) {
      const key = JSON.stringify([record.id, attempt.stage, attempt.attempt]), entry = calls.get(key);
      assert(entry && entry.context.caseId === record.caseId && entry.context.methodId === record.methodId
        && entry.context.repeat === record.repeat && hash(entry.request) === hash(attempt.request)
        && entry.state === attempt.state, '생성 호출 원본 명세와 시도 기록이 다릅니다');
      const result = entry.state === 'completed' ? entry.result : entry;
      for (const field of ['raw', 'inputTokens', 'outputTokens', ...(entry.state === 'completed' ? ['answer', 'finishReason'] : ['error', 'type'])]) {
        assert((result?.[field] ?? (field === 'raw' ? '' : null)) === (attempt[field] ?? (field === 'raw' ? '' : null)),
          '생성 호출 원본 명세와 답변·오류·비용이 다릅니다');
      }
      calls.delete(key);
    }
  }
  assert(inspection || calls.size === 0, '실행에 연결되지 않은 추가 생성 호출이 있습니다');
}

/** Pure timing validation shared by final reports and pre-call checkpoints.
 * A partial checkpoint has no measured batch wall interval: validate its known
 * records/transport, never infer a full or resumed batch total from them. */
export function validateGenerationTimes(plan, run, { partial = false } = {}) {
  const strict = plan.config.generationAuditVersion === 1;
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const sum = values => values.reduce((a, b) => a + b, 0);
  const number = (value, label) => assert(Number.isFinite(value) && value >= 0,
    `${label}: invalid nonnegative cost`);
  const optionalNumber = (value, label) => { if (value != null) number(value, label); };
  const containsElapsed = (outer, inner, label, parts = 1) => {
    number(inner, `${label} elapsed sum`);
    // One monotonic clock, nested intervals: allow 1ns plus floating arithmetic
    // noise, not a timer tick or percentage. A measured zero never covers work.
    const tolerance = 1e-6 + 8 * Number.EPSILON * Math.max(1, outer, inner) * parts;
    assert((outer !== 0 || inner === 0) && outer + tolerance >= inner,
      `${label}: elapsedMs smaller than measured inner work`);
  };
  if (!partial) {
    number(run.batchElapsedMs, 'batchElapsedMs');
    assert(run.resumed === undefined || typeof run.resumed === 'boolean', 'invalid resumed flag');
    if (strict) {
      assert(typeof run.resumed === 'boolean', 'strict generation requires a measured batch scope');
      assert(run.batchWallScope === (run.resumed
        ? 'current resumed segment only; earlier batch wall time unavailable' : 'whole run; not allocated to methods'),
      'batchWallScope must document fresh or current resumed segment timing');
    }
  }
  assert(run.warmupHistoryComplete === undefined || typeof run.warmupHistoryComplete === 'boolean', 'invalid warmup history flag');
  assert(run.warmup === undefined || Array.isArray(run.warmup), 'warmup: expected array');
  for (const [i, warmup] of (run.warmup ?? []).entries()) {
    assert(plain(warmup) && plain(warmup.result), 'invalid warmup result');
    if (strict) number(warmup.result.elapsedMs, `warmup[${i}].elapsedMs`);
    else optionalNumber(warmup.result.elapsedMs, `warmup[${i}].elapsedMs`);
  }
  assert(Array.isArray(run.records), 'generation times: expected records array');
  assert(!strict || Array.isArray(run.generationLedger), '원본 생성 호출 명세가 없습니다');
  const ledger = strict ? new Map(run.generationLedger.filter(e => e.context?.stage !== 'warmup')
    .map(e => [JSON.stringify([e.context?.recordId, e.context?.stage, e.context?.attempt]), e])) : null;
  for (const record of run.records) {
    number(record.elapsedMs, `${record.id}.elapsedMs`);
    assert(Array.isArray(record.attempts), 'invalid generation attempts array/count');
    for (const attempt of record.attempts) {
      assert(plain(attempt), `${record.id}: invalid attempt`);
      if (strict) {
        number(attempt.elapsedMs, `${record.id} attempt.elapsedMs`);
        const entry = ledger.get(JSON.stringify([record.id, attempt.stage, attempt.attempt]));
        assert(entry, `${record.id}: original generation time record missing`);
        const transport = entry.state === 'completed' ? entry.result : entry;
        number(transport?.elapsedMs, `${record.id} transport.elapsedMs`);
        containsElapsed(attempt.elapsedMs, transport.elapsedMs, `${record.id} attempt/transport`);
      } else optionalNumber(attempt.elapsedMs, `${record.id}.elapsedMs`);
    }
    const measuredAttempts = record.attempts.filter(a => a.elapsedMs != null);
    containsElapsed(record.elapsedMs, sum(measuredAttempts.map(a => a.elapsedMs)),
      `${record.id} record/attempt`, measuredAttempts.length);
    if (record.postprocessInspections !== undefined) {
      assert(Array.isArray(record.postprocessInspections), 'invalid postprocess inspection array');
      for (const inspection of record.postprocessInspections) number(inspection.elapsedMs, 'inspection elapsedMs');
    }
  }
  if (!partial && !run.resumed) {
    // Inspections occur later: exclude them from original response/batch time.
    const originalTimes = run.records.map(r => r.elapsedMs);
    const warmupTimes = (run.warmup ?? []).flatMap(w => w.result.elapsedMs == null ? [] : [w.result.elapsedMs]);
    const knownElapsed = sum([...originalTimes, ...warmupTimes]);
    number(knownElapsed, 'fresh batch elapsed sum');
    // Legacy injected fixtures used loose warmup/batch clocks. Keep readability
    // while still rejecting clear measured-zero/positive-work contradictions.
    if (strict || run.batchElapsedMs === 0) containsElapsed(run.batchElapsedMs, knownElapsed,
      'fresh batch/records+warmup', originalTimes.length + warmupTimes.length);
  }
  return run;
}
