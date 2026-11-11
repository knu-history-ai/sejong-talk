import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, makePlan, validateRun, validateRecordedInputs, validateGenerationProgress } from '../evals/sejong/date-eval/core.mjs';
import { runPlan, ruleAnswer } from '../evals/sejong/date-eval/runner.mjs';
import { loadPilot } from '../evals/sejong/date-eval/pilot.mjs';
import { resolveRunState } from '../evals/sejong/date-eval/state.mjs';
import { buildAutomaticReport } from '../evals/sejong/date-eval/automatic.mjs';
import { createReviewPackets, finalizeReviews } from '../evals/sejong/date-eval/grading.mjs';
import { buildReport } from '../evals/sejong/date-eval/report.mjs';
import { LEGACY_POSTPROCESS_VERSION, POSTPROCESS_VERSION, transformAnswer } from '../evals/sejong/date-eval/postprocess.mjs';

const identity = { name: 'synthetic-only', digest: 'synthetic-only-digest', details: {} };
const method = (id, postprocessVersion) => ({ id, version: 'synthetic-only',
  ...(postprocessVersion === undefined ? {} : { postprocessVersion }) });

async function fixture({ legacy = false, ...overrides } = {}) {
  const pilot = await loadPilot();
  const dataset = { ...pilot.dataset, cases: pilot.dataset.cases.slice(0, 1) };
  const gold = { ...pilot.gold, datasetHash: hash(dataset), cases: pilot.gold.cases.slice(0, 1) };
  const config = { model: identity.name, modelIdentity: identity, options: {}, timeoutMs: 100,
    repeats: 1, retries: 0, warmup: false, generationAuditVersion: 1, generationCompletionVersion: 2,
    methods: [method('evidence-first')], ...overrides };
  if (legacy) delete config.generationCompletionVersion;
  return makePlan(dataset, gold, config);
}

// In-memory transports and ledgers only: these tests never invoke fetch or a model.
async function execute(plan, respond = () => ({})) {
  const ledger = [];
  const run = await runPlan(plan, { generate: async (request, config, context) => {
    const entry = { schemaVersion: 1, planId: plan.id, callId: ledger.length + 1,
      context: structuredClone(context), request: structuredClone(request) };
    try {
      const supplied = await respond(request, context);
      const answer = supplied.answer ?? (context.stage === 'warmup' ? 'ready'
        : context.stage === 'extract' ? '추출 원문\n일자는 미확정'
          : ruleAnswer(plan.dataset.cases.find(c => c.id === context.caseId)));
      const result = { answer, finishReason: 'stop', inputTokens: 7, outputTokens: 3, elapsedMs: 0, ...supplied };
      result.raw ??= JSON.stringify({ done: true, done_reason: result.finishReason, response: answer,
        prompt_eval_count: result.inputTokens, eval_count: result.outputTokens });
      ledger.push({ ...entry, state: 'completed', result: structuredClone(result) });
      return result;
    } catch (error) {
      ledger.push({ ...entry, state: 'failed', error: error.message, type: error.type ?? 'call-failure',
        raw: error.raw ?? '', inputTokens: error.inputTokens ?? null, outputTokens: error.outputTokens ?? null, elapsedMs: 0 });
      throw error;
    }
  } });
  run.generationLedger = ledger;
  run.modelVerification = { before: structuredClone(identity), after: structuredClone(identity) };
  return run;
}

function failedAttempt(type, { unknownUsage = false } = {}) {
  return Object.assign(new Error('synthetic failed transport'), { type, finishReason: 'length',
    raw: unknownUsage ? 'partial transport' : JSON.stringify({ done: true, done_reason: 'length',
      response: 'failed transport text', prompt_eval_count: 7, eval_count: 3 }),
    inputTokens: unknownUsage ? null : 7, outputTokens: unknownUsage ? null : 3 });
}

function decision(record, state = 'completed') {
  return { recordId: record.id, originalRecordHash: hash(record), state, reviewerId: 'synthetic-maintainer',
    reason: 'synthetic execution status inspection', evidence: 'original extraction, final answer and call ledger inspected' };
}

test('completed extract length followed by answer stop is unknown; full final answer, attempts and costs survive', async () => {
  const plan = await fixture({ retries: 2 }), planHash = hash(plan);
  const finalAnswer = ` \n${ruleAnswer(plan.dataset.cases[0])}\n `;
  const run = await execute(plan, (request, context) => context.stage === 'extract'
    ? { finishReason: 'length' } : { answer: finalAnswer });
  const record = run.records[0];
  assert.equal(record.state, 'unknown');
  assert.equal(record.error.type, 'readability-unconfirmed');
  assert.equal(record.rawAnswer, finalAnswer);
  assert.deepEqual(record.attempts.map(a => [a.stage, a.attempt, a.state, a.finishReason]),
    [['extract', 0, 'completed', 'length'], ['answer', 0, 'completed', 'stop']]);
  assert.equal(record.calls, 2); // A completed length result is neither retried nor an early abort.
  assert.equal(record.inputTokens, 14);
  assert.equal(record.outputTokens, 6);
  assert.ok(record.rawInput[1].prompt.includes(record.attempts[0].answer));
  assert.equal(record.attempts[1].raw, run.generationLedger[1].result.raw);
  assert.equal(JSON.parse(record.attempts[1].raw).response, finalAnswer);
  validateRecordedInputs(plan, validateRun(plan, run));
  validateGenerationProgress(plan, run.records, run.generationLedger);
  assert.throws(() => buildAutomaticReport(plan, run), /unknown/);
  const final = finalizeReviews(plan, run, createReviewPackets(plan, run), []);
  assert.throws(() => buildReport(plan, run, final), /unknown/);
  assert.equal(hash(plan), planHash);
});

test('only completed attempts affect completion: failed length transports may retry in either stage', async t => {
  for (const stage of ['extract', 'answer']) for (const type of ['timeout', 'call-failure']) {
    await t.test(`${stage}/${type}`, async () => {
      const plan = await fixture({ retries: 1 });
      const run = await execute(plan, (request, context) => {
        if (context.stage === stage && context.attempt === 0) throw failedAttempt(type);
        return {};
      });
      const record = run.records[0];
      assert.equal(record.state, 'completed');
      assert.equal(record.calls, 3);
      assert.equal(record.inputTokens, 21);
      assert.equal(record.outputTokens, 9);
      assert.equal(record.attempts.find(a => a.state === 'failed').type, type);
      assert.equal(record.rawAnswer, record.attempts.at(-1).answer);
      validateRecordedInputs(plan, validateRun(plan, run));
      assert.equal(buildAutomaticReport(plan, run).generation.physicalBatch.calls, 3);
    });
  }
});

test('a failed retry with unknown usage stays null when extraction later hits length', async () => {
  const plan = await fixture({ retries: 1 });
  const run = await execute(plan, (request, context) => {
    if (context.stage === 'extract' && context.attempt === 0) throw failedAttempt('timeout', { unknownUsage: true });
    return { finishReason: context.stage === 'extract' ? 'length' : 'stop' };
  });
  const record = run.records[0];
  assert.equal(record.state, 'unknown');
  assert.equal(record.calls, 3);
  assert.equal(record.inputTokens, null);
  assert.equal(record.outputTokens, null);
  assert.equal(record.attempts[0].raw, 'partial transport');
  assert.equal(record.rawAnswer, record.attempts.at(-1).answer);
  validateRecordedInputs(plan, validateRun(plan, run));
});

test('exhausted failures keep precedence and all retry costs even after completed extract length', async t => {
  for (const stage of ['extract', 'answer']) await t.test(stage, async () => {
    const plan = await fixture({ retries: 1 });
    const run = await execute(plan, (request, context) => {
      if (context.stage === stage) throw failedAttempt('call-failure');
      return { finishReason: 'length' };
    });
    const record = run.records[0], calls = stage === 'extract' ? 2 : 3;
    assert.equal(record.state, 'failed');
    assert.equal(record.error.type, 'call-failure');
    assert.equal(record.calls, calls);
    assert.equal(record.inputTokens, calls * 7);
    assert.equal(record.outputTokens, calls * 3);
    assert.equal(record.rawAnswer, '');
    assert.equal(record.attempts.at(-1).state, 'failed');
    validateRecordedInputs(plan, validateRun(plan, run));
    assert.equal(buildAutomaticReport(plan, run).items[0].dateScore, 0);
  });
});

test('source-linked maintainer inspection resolves extraction length without rewriting raw data or costs', async () => {
  const plan = await fixture();
  const original = await execute(plan, (request, context) => ({ finishReason: context.stage === 'extract' ? 'length' : 'stop' }));
  const before = hash(original), record = original.records[0];
  const resolved = resolveRunState(plan, original, [decision(record)]);
  const { state, executionInspection, ...preserved } = resolved.records[0];
  const { state: originalState, ...originalFields } = record;
  assert.equal(originalState, 'unknown');
  assert.equal(state, 'completed');
  assert.equal(executionInspection.originalRecordHash, hash(record));
  assert.deepEqual(preserved, originalFields);
  assert.deepEqual(resolved.generationLedger, original.generationLedger);
  assert.equal(resolved.stateResolution.sourceRunHash, before);
  validateRecordedInputs(plan, resolved);
  const report = buildAutomaticReport(plan, resolved);
  assert.equal(report.items.length, 1);
  assert.equal(report.generation.physicalBatch.calls, 2);
  assert.equal(report.generation.physicalBatch.inputTokens.sum, 14);
  assert.equal(report.generation.physicalBatch.outputTokens.sum, 6);
  for (const run of [resolveRunState(plan, original, [decision(record, 'failed')]),
    resolveRunState(plan, resolved, [decision(resolved.records[0], 'failed')])]) {
    validateRecordedInputs(plan, run);
    assert.equal(buildAutomaticReport(plan, run).items[0].dateScore, 0);
    assert.equal(run.records[0].rawAnswer, record.rawAnswer);
    assert.deepEqual(run.generationLedger, original.generationLedger);
  }
  assert.equal(hash(original), before);
});

test('v2 rejects forged completed extraction-length records and invalid source-linked inspections', async () => {
  const plan = await fixture();
  const original = await execute(plan, (request, context) => ({ finishReason: context.stage === 'extract' ? 'length' : 'stop' }));
  const forged = structuredClone(original);
  forged.records[0].state = 'completed';
  assert.throws(() => validateRecordedInputs(plan, forged), /길이 제한/);
  assert.throws(() => buildAutomaticReport(plan, forged), /길이 제한/);
  assert.throws(() => validateGenerationProgress(plan, forged.records, forged.generationLedger), /길이 제한/);
  const resolved = resolveRunState(plan, original, [decision(original.records[0])]);
  for (const mutate of [r => { r.executionInspection.originalRecordHash = '0'.repeat(64); },
    r => { r.executionInspection.recordId = 'another-record'; }, r => { r.executionInspection.reason = ''; },
    r => { r.executionInspection.evidence = ''; }, r => { r.executionInspection.reviewerId = ''; },
    r => { r.executionInspection.beforeState = 'completed'; }, r => { r.attempts[0].answer += 'changed'; }]) {
    const changed = structuredClone(resolved);
    mutate(changed.records[0]);
    assert.throws(() => validateRecordedInputs(plan, changed));
    assert.throws(() => buildAutomaticReport(plan, changed));
  }
});

test('old absent/v1 policies read their original completed extraction-length results without changing flags or pins', async t => {
  for (const config of [{ legacy: true }, { generationCompletionVersion: 1 }]) await t.test(JSON.stringify(config), async () => {
    const plan = await fixture(config), planHash = hash(plan);
    const fresh = await execute(plan, (request, context) => ({ finishReason: context.stage === 'extract' ? 'length' : 'stop' }));
    assert.equal(fresh.records[0].state, 'unknown'); // Newly executed calls use the corrected runner.
    const old = structuredClone(fresh);
    old.records[0].state = 'completed';
    delete old.records[0].error; // Reconstruct the original last-call-only record shape.
    const originalHash = hash(old);
    validateRecordedInputs(plan, validateRun(plan, old));
    buildAutomaticReport(plan, old);
    const resumed = await runPlan(plan, { existingRecords: old.records,
      generate: async () => assert.fail('old completed records must not be executed again') });
    assert.deepEqual(resumed.records, old.records);
    assert.equal(hash(old), originalHash);
    assert.equal(hash(plan), planHash);
    assert.equal(Object.hasOwn(plan.config, 'generationCompletionVersion'), !config.legacy);
  });
});

test('final answer length keeps the inspection requirement under old and v2 policies', async t => {
  for (const config of [{ legacy: true }, { generationCompletionVersion: 1 }, { generationCompletionVersion: 2 }]) {
    for (const id of ['prompt-baseline', 'evidence-first']) await t.test(`${JSON.stringify(config)}/${id}`, async () => {
      const plan = await fixture({ ...config, methods: [method(id)] });
      const run = await execute(plan, (request, context) => ({ finishReason: context.stage === 'answer' ? 'length' : 'stop' }));
      assert.equal(run.records[0].state, 'unknown');
      validateRecordedInputs(plan, validateRun(plan, run));
      const changed = structuredClone(run);
      changed.records[0].state = 'completed';
      assert.throws(() => validateRecordedInputs(plan, changed), /길이 제한/);
    });
  }
});

test('length during warmup alone does not taint completed task generation', async () => {
  const plan = await fixture({ warmup: true });
  const run = await execute(plan, (request, context) => ({ finishReason: context.stage === 'warmup' ? 'length' : 'stop' }));
  assert.equal(run.records[0].state, 'completed');
  assert.equal(run.records[0].calls, 2);
  assert.equal(run.generationLedger.length, 3);
  validateRecordedInputs(plan, validateRun(plan, run));
});

test('unsupported completion policies are rejected instead of falling back to legacy', async () => {
  const plan = await fixture(), run = await execute(plan);
  for (const version of [0, 3, '2', null, undefined]) {
    await assert.rejects(fixture({ generationCompletionVersion: version }), /생성 완료 판정 버전/);
    const changed = structuredClone(plan);
    changed.config.generationCompletionVersion = version;
    assert.throws(() => validateRecordedInputs(changed, run), /생성 완료 판정 버전/);
  }
});

test('completion v2 cannot disable raw audit and bypass length inspection through a partial legacy trace', async () => {
  for (const generationAuditVersion of [undefined, null, 0, 2, '1']) {
    await assert.rejects(fixture({ generationAuditVersion }), /원본 감사/);
  }
  const plan = await fixture();
  const run = await execute(plan, (request, context) => ({ finishReason: context.stage === 'extract' ? 'length' : 'stop' }));
  const changed = structuredClone(plan);
  delete changed.config.generationAuditVersion;
  const forged = structuredClone(run);
  forged.records[0].state = 'completed';
  // New policy plus an omitted audit flag is invalid even if all plan/run hashes
  // are rebuilt coherently. It must not enter the permissive legacy trace path.
  changed.configHash = hash(changed.config);
  changed.id = hash({ datasetHash: changed.datasetHash, goldHash: changed.goldHash, configHash: changed.configHash });
  forged.configHash = changed.configHash; forged.planId = changed.id;
  for (const record of [forged.records[0], { ...forged.records[0], attempts: [] }]) {
    forged.records[0] = record;
    assert.throws(() => validateRecordedInputs(changed, forged), /원본 감사/);
    assert.throws(() => buildAutomaticReport(changed, forged), /원본 감사/);
  }
});

test('runner and core pin each derived method separately, including missing legacy fields', async () => {
  const plan = await fixture({ methods: [method('prompt-baseline'), method('render-only'),
    method('evidence-validated', POSTPROCESS_VERSION)] });
  const before = hash(plan), run = await execute(plan), parent = run.records.find(r => r.methodId === 'prompt-baseline');
  for (const [id, version] of [['render-only', LEGACY_POSTPROCESS_VERSION], ['evidence-validated', POSTPROCESS_VERSION]]) {
    const record = run.records.find(r => r.methodId === id);
    const expected = transformAnswer(plan.dataset.cases[0], parent.rawAnswer, id, { version });
    assert.equal(record.derivation.version, version);
    assert.equal(record.rawInput[0].version, version);
    assert.equal(record.derivation.audit.version, version);
    assert.equal(record.rawAnswer, expected.answer);
    assert.deepEqual(record.derivation.audit, expected.audit);
    assert.equal(record.calls, 0);
    assert.deepEqual(record.attempts, []);
    const other = version === POSTPROCESS_VERSION ? LEGACY_POSTPROCESS_VERSION : POSTPROCESS_VERSION;
    for (const mutate of [r => { r.derivation.version = other; r.rawInput[0].version = other; r.derivation.audit.version = other; },
      r => { r.rawInput[0].version = other; }, r => { r.derivation.audit.version = other; }]) {
      const forged = structuredClone(run);
      mutate(forged.records.find(r => r.methodId === id));
      assert.throws(() => validateRun(plan, forged), /T·V/);
    }
  }
  validateRecordedInputs(plan, validateRun(plan, run));
  assert.equal(hash(plan), before);
  assert.equal(Object.hasOwn(plan.config.methods.find(m => m.id === 'render-only'), 'postprocessVersion'), false);
});

test('pinned postprocess versions survive parent unknown propagation and source-linked reinspection', async () => {
  const plan = await fixture({ methods: [method('prompt-baseline'), method('render-only', POSTPROCESS_VERSION),
    method('evidence-validated', LEGACY_POSTPROCESS_VERSION)] });
  const run = await execute(plan, () => ({ finishReason: 'length' }));
  validateRecordedInputs(plan, validateRun(plan, run));
  const parent = run.records.find(r => r.methodId === 'prompt-baseline');
  for (const record of run.records.filter(r => r.derivation)) {
    const version = plan.config.methods.find(m => m.id === record.methodId).postprocessVersion;
    assert.equal(record.state, 'unknown');
    assert.equal(record.rawAnswer, parent.rawAnswer);
    assert.equal(record.derivation.version, version);
    assert.equal(record.rawInput[0].version, version);
    assert.equal(record.derivation.audit.status, 'parent-not-completed');
  }
  const resolved = resolveRunState(plan, run, [decision(parent)]);
  validateRecordedInputs(plan, validateRun(plan, resolved));
  for (const record of resolved.records.filter(r => r.derivation)) {
    assert.equal(record.state, 'completed');
    assert.equal(record.derivation.audit.version, plan.config.methods.find(m => m.id === record.methodId).postprocessVersion);
  }
});

test('unsupported method postprocess versions cannot be silently executed', async () => {
  await assert.rejects(fixture({ methods: [method('prompt-baseline'), method('render-only', 'date-postprocess-v999')] }),
    /postprocess version/);
});
