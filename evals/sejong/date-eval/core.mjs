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
      validateGenerationTrace(plan, record);
    }
  }
  if (plan.config.generationAuditVersion === 1) validateGenerationLedger(plan, run);
  return run;
}

function validateGenerationTrace(plan, record) {
  const strict = plan.config.generationAuditVersion === 1;
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
    }
    last = group.at(-1);
    if (last.state === 'failed') {
      assert(group.length === plan.config.retries + 1, '허용된 생성 재시도를 끝내기 전에 종료됐습니다');
      break;
    }
  }
  assert(cursor === record.attempts.length && inputs === record.rawInput.length, '생성 단계 순서·추가 호출이 고정 계획과 다릅니다');
  const answered = last?.stage === 'answer' && last.state === 'completed';
  if (record.state === 'completed' || record.rawAnswer?.trim()) {
    assert(answered && record.rawAnswer === last.answer, '집계 답변이 마지막 생성 원답변과 다릅니다');
  }
  if (record.state === 'completed') assert(answered, '완료된 최종 답변 호출이 없습니다');
  if (strict && record.state === 'failed') assert(last.state === 'failed'
    || (record.executionInspection?.state === 'failed' && record.executionInspection.originalRecordHash
      && record.executionInspection.reviewerId && record.executionInspection.reason && record.executionInspection.evidence),
  '생성 성공 기록을 확인 근거 없이 실패로 바꿀 수 없습니다');
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
    const expected = Number.isInteger(output[wire]) && output[wire] >= 0 ? output[wire] : null;
    if (strict || Object.hasOwn(output, wire)) assert((attempt[field] ?? null) === expected, '생성 원응답과 토큰 기록이 다릅니다');
  }
}

/** New operator runs embed the original ledger; import also checks its files. */
function validateGenerationLedger(plan, run) {
  const ledger = run.generationLedger;
  assert(Array.isArray(ledger), '원본 생성 호출 명세가 없습니다');
  const hasGeneration = plan.config.methods.some(m => !DERIVED_METHODS.includes(m.id) && m.id !== 'rule-baseline');
  if (hasGeneration) {
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
    assert(['completed', 'failed'].includes(entry.state), '미확인 생성 호출은 확정할 수 없습니다');
    if (entry.context?.stage === 'warmup') {
      assert(entry.context.recordId === null && entry.context.attempt === 0 && entry.state === 'completed', '준비 호출 명세가 잘못됐습니다');
      assert(plan.config.warmup && entry.request?.stage === 'warmup' && entry.request.model === plan.config.model
        && entry.request.think === plan.config.think && hash(entry.request.options) === hash(plan.config.options),
      '준비 호출 조건이 고정 계획과 다릅니다');
      validateWireAnswer(entry.result, true);
      warmups.push({ request: entry.request, result: entry.result });
    } else {
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
  assert(calls.size === 0, '실행에 연결되지 않은 추가 생성 호출이 있습니다');
}
