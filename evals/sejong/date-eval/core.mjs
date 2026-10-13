import { createHash } from 'node:crypto';

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
  assert(plan.schemaVersion === 1, '지원하지 않는 계획 버전');
  assert(plan.datasetHash === hash(plan.dataset), '자료/질문 버전이 변경됐습니다');
  assert(plan.goldHash === hash(plan.gold), '정답표 버전이 변경됐습니다');
  assert(plan.criteriaHash === criteriaHash(plan.gold), '채점 기준이 변경됐습니다');
  assert(plan.gold.datasetHash === plan.datasetHash, '정답표와 자료 버전이 다릅니다');
  assert(['draft', 'approved'].includes(plan.gold.reviewStatus), '정답표 검토 상태 누락');
  assert(plan.configHash === hash(plan.config), '실행 조건이 변경됐습니다');
  assert(plan.id === hash({ datasetHash: plan.datasetHash, goldHash: plan.goldHash, configHash: plan.configHash }), '계획 ID가 맞지 않습니다');
  assert(['pilot', 'development', 'final'].includes(plan.dataset.split), '자료 구분 누락');
  assert(Number.isInteger(plan.config.repeats) && plan.config.repeats > 0, '반복 횟수 오류');
  assert(Number.isInteger(plan.config.retries) && plan.config.retries >= 0 && plan.config.retries <= 5, '재시도 횟수는 0~5회');
  assert(Number.isFinite(plan.config.timeoutMs) && plan.config.timeoutMs > 0 && plan.config.timeoutMs <= 2147483647, '시간 제한 오류');
  assert(typeof plan.config.model === 'string' && plan.config.model.length > 0, '모델 누락');
  unique(plan.dataset.cases.map((c) => c.id), '질문');
  unique(plan.gold.cases.map((c) => c.id), '정답');
  unique(plan.config.methods.map((m) => m.id), '방법');
  unique(plan.slots.map((s) => s.id), '실행 자리');
  assert(plan.dataset.cases.length > 0 && plan.config.methods.length > 0, '빈 계획');
  for (const c of plan.dataset.cases) {
    assert(Array.isArray(c.targets) && c.targets.length > 0, `${c.id}: 대상 사건이 없습니다`);
    assert(c.sourceText && c.question && c.articleId && c.groupId, `${c.id}: 자료/질문/그룹 누락`);
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
  assert(plan.gold.cases.length === plan.dataset.cases.length, '정답표에 다른 질문이 포함됐습니다');
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
  return run;
}
export function makePlan(dataset, gold, config) {
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
    if (record.methodId === 'rule-baseline') {
      assert(record.rawInput.length === 1 && record.rawInput[0].sourceText === c.sourceText
        && record.rawInput[0].question === c.question && hash(record.rawInput[0].targets) === hash(c.targets), '규칙 입력 자료·질문·대상 불일치');
    } else {
      const requests = [...record.rawInput, ...(record.attempts ?? []).map(attempt => attempt.request)];
      for (const request of requests) {
        assert(request?.model === plan.config.model && hash(request.options) === hash(plan.config.options), '실제 요청 모델·옵션이 고정 계획과 다릅니다');
        assert(typeof request.prompt === 'string' && request.prompt.includes(c.sourceText)
          && request.prompt.includes(c.question), '실제로 보낸 전체 자료·질문이 없습니다');
      }
    }
  }
  return run;
}
