import { createHash } from 'node:crypto';
import { DERIVED_METHODS, POSTPROCESS_VERSION, transformAnswer } from './postprocess.mjs';

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
  assert(Number.isInteger(plan.config.repeats) && plan.config.repeats > 0, '반복 횟수 오류');
  assert(Number.isInteger(plan.config.retries) && plan.config.retries >= 0 && plan.config.retries <= 5, '재시도 횟수는 0~5회');
  assert(Number.isFinite(plan.config.timeoutMs) && plan.config.timeoutMs > 0 && plan.config.timeoutMs <= 2147483647, '시간 제한 오류');
  assert(typeof plan.config.model === 'string' && plan.config.model.length > 0, '모델 누락');
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
    for (const k of ['inputTokens', 'outputTokens']) assert(r[k] == null || (Number.isInteger(r[k]) && r[k] >= 0), '토큰 수 오류');
  }
  validateDerivations(plan, run.records);
  return run;
}

export function executionPlan(plan) {
  validatePlan(plan);
  const { gold, ...publicPlan } = structuredClone(plan);
  return validateExecutionPlan({ ...publicPlan, executionOnly: true, goldReviewStatus: gold.reviewStatus });
}

/** Recompute deterministic outputs; matching IDs alone do not establish shared P provenance. */
export function validateDerivations(plan, records) {
  for (const r of records.filter(r => DERIVED_METHODS.includes(r.methodId))) {
    const parent = records.find(p => p.methodId === 'prompt-baseline' && p.caseId === r.caseId && p.repeat === r.repeat);
    assert(parent && r.derivation?.parentRecordId === parent.id && r.derivation.parentRecordHash === hash(parent)
      && r.derivation.parentAnswerHash === hash(parent.rawAnswer ?? '') && r.derivation.version === POSTPROCESS_VERSION, 'T·V 원본 P 연결/버전 불일치');
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
      parentRecordId: parent.id, parentRecordHash: hash(parent), version: POSTPROCESS_VERSION }];
    assert(hash(r.rawInput) === hash(expectedInput), 'T·V 실제 후처리 입력 불일치');
    if (parent.state !== 'completed') {
      assert(r.state === parent.state && r.rawAnswer === (parent.rawAnswer ?? '') && r.derivation.audit.status === 'parent-not-completed', 'P 실패·미확인 상태 전파 불일치');
    } else if (r.derivation.audit.status === 'postprocess-error') {
      assert(r.state === 'unknown' && r.rawAnswer === parent.rawAnswer && r.error?.type === 'postprocess-error', '후처리 오류를 완료/실패로 바꿀 수 없습니다');
    } else {
      const result = transformAnswer(c, parent.rawAnswer, r.methodId);
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
  for (const record of run.records) {
    if (record.state === 'unexecuted') continue;
    const c = plan.dataset.cases.find(c => c.id === record.caseId);
    assert(Array.isArray(record.rawInput) && record.rawInput.length > 0, '실제로 보낸 전체 자료·질문이 없습니다');
    if (DERIVED_METHODS.includes(record.methodId)) {
      validateDerivations(plan, run.records);
    } else if (record.methodId === 'rule-baseline') {
      assert(record.rawInput.length === 1 && record.rawInput[0].sourceText === c.sourceText
        && record.rawInput[0].question === c.question && hash(record.rawInput[0].targets) === hash(c.targets), '규칙 입력 자료·질문·대상 불일치');
    } else {
      const requests = [...record.rawInput, ...(record.attempts ?? []).map(attempt => attempt.request)];
      for (const request of requests) {
        assert(request?.model === plan.config.model && hash(request.options) === hash(plan.config.options), '실제 요청 모델·옵션이 고정 계획과 다릅니다');
        if (Object.hasOwn(plan.config, 'think')) assert(request.think === plan.config.think, '실제 요청 thinking 설정이 고정 계획과 다릅니다');
        assert(typeof request.prompt === 'string' && request.prompt.includes(c.sourceText)
          && request.prompt.includes(c.question), '실제로 보낸 전체 자료·질문이 없습니다');
      }
    }
  }
  return run;
}
