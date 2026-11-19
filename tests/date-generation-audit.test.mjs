import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../evals/sejong/date-eval/cli.mjs';
import { hash, validateRecordedInputs } from '../evals/sejong/date-eval/core.mjs';
import { ruleAnswer, sameModelIdentity, ollamaGenerate } from '../evals/sejong/date-eval/runner.mjs';
import { loadPilot } from '../evals/sejong/date-eval/pilot.mjs';
import { buildAutomaticReport } from '../evals/sejong/date-eval/automatic.mjs';
import { resolveRunState } from '../evals/sejong/date-eval/state.mjs';

const read = async path => JSON.parse(await readFile(path, 'utf8'));
async function fixture({ drift = false, retryAfterDrift = false, fail = false, length = false, retries = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'date audit 한글 '));
  const privateDir = join(root, '담당자 전용'), operatorDir = join(root, '유진 실행 폴더');
  const { dataset } = await loadPilot();
  const identity = { name: 'fixture', digest: 'synthetic-digest', details: { quantization_level: 'Q4_K_M' } };
  await writeFile(join(root, 'identity.json'), JSON.stringify(identity));
  let digest = identity.digest, calls = 0;
  const server = createServer((req, res) => {
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ ...identity, digest, size: 1234 }] }));
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body);
      calls++;
      if (drift && calls === 1) digest = 'changed-during-warmup';
      const c = dataset.cases.find(c => request.prompt.includes(c.question));
      if (fail && c) { res.statusCode = 503; return res.end(JSON.stringify({ error: 'synthetic failure' })); }
      res.end(JSON.stringify({ done: true, done_reason: length && c ? 'length' : 'stop', response: c ? ruleAnswer(c) : 'ready',
        prompt_eval_count: 7, eval_count: 3 }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await main(['prepare', '--dir', privateDir, '--model', identity.name,
      '--model-identity', join(root, 'identity.json'), '--endpoint', `http://127.0.0.1:${server.address().port}`,
      '--methods', 'rule-baseline,prompt-baseline,evidence-first,render-only,evidence-validated', '--retries', String(retries), '--warmup']);
    await main(['export-operator', '--dir', privateDir, '--out', operatorDir]);
    let error;
    try { await main(['run', '--dir', operatorDir]); } catch (e) { error = e; }
    let resumeError;
    if (retryAfterDrift) {
      digest = identity.digest;
      try { await main(['run', '--dir', operatorDir]); } catch (e) { resumeError = e; }
    }
    return { root, privateDir, operatorDir, error, resumeError, calls, plan: await read(join(privateDir, 'plan.json')),
      run: error ? null : await read(join(operatorDir, 'run.json')) };
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('strict operator execution binds raw responses, attempts and all original call files; import does not call a model', async () => {
  const f = await fixture();
  assert.equal(f.error, undefined);
  assert.equal(f.plan.config.generationAuditVersion, 1);
  assert.equal(f.plan.config.generationCompletionVersion, 2);
  for (const method of f.plan.config.methods.filter(m => ['render-only', 'evidence-validated'].includes(m.id))) {
    assert.equal(method.postprocessVersion, 'date-postprocess-v2');
    assert.ok(f.run.records.filter(r => r.methodId === method.id)
      .every(r => r.derivation.version === method.postprocessVersion));
  }
  assert.equal(f.run.records.length, 40);
  assert.equal(f.calls, 25);
  assert.equal(f.run.generationLedger.length, 25);
  assert.equal(f.run.modelVerification.before.digest, f.run.modelVerification.after.digest);
  assert.equal(f.plan.config.modelIdentity.size, undefined); // optional metadata is not model identity
  assert.equal(f.run.modelVerification.before.size, 1234);
  validateRecordedInputs(f.plan, f.run);
  const before = hash(f.run);
  await main(['import-run', '--dir', f.privateDir, '--file', join(f.operatorDir, 'run.json')]);
  await main(['automatic-report', '--dir', f.privateDir]);
  assert.equal((await read(join(f.privateDir, 'automatic-report.json'))).items.length, 40);
  assert.equal(hash(await read(join(f.operatorDir, 'run.json'))), before);
});

test('raw answer, transport decoding, fixed retries, stage order and missing traces cannot change strict scores', async () => {
  const f = await fixture();
  assert.equal(f.error, undefined);
  const original = hash(f.run);
  const changes = [
    r => { r.rawAnswer += 'different'; },
    r => { r.attempts.at(-1).answer += 'different'; r.rawAnswer = r.attempts.at(-1).answer; },
    r => { r.attempts.at(-1).raw = '{"done":true,"response":"another answer"}'; },
    r => { r.attempts.at(-1).finishReason = 'length'; },
    r => { r.attempts.at(-1).inputTokens++; r.inputTokens++; },
    r => { r.attempts.at(-1).attempt = 1; },
    r => { r.attempts.reverse(); },
    r => { r.attempts.pop(); },
    r => { r.state = 'unexecuted'; r.rawAnswer = 'changed'; },
    r => { r.state = 'unexecuted'; delete r.rawInput; },
    r => {
      r.attempts.splice(1, 0, { ...r.attempts[1], state: 'failed', type: 'timeout', error: 'synthetic timeout' });
      r.attempts.at(-1).attempt = 1; r.calls = 3; r.inputTokens = 21; r.outputTokens = 9;
    },
  ];
  for (const mutate of changes) {
    const bad = structuredClone(f.run);
    mutate(bad.records.find(r => r.methodId === 'evidence-first'));
    assert.throws(() => validateRecordedInputs(f.plan, bad));
    assert.throws(() => buildAutomaticReport(f.plan, bad));
  }
  const consistentButNotOriginal = structuredClone(f.run);
  const r = consistentButNotOriginal.records.find(r => r.methodId === 'evidence-first'), a = r.attempts.at(-1);
  a.answer = r.rawAnswer = 'synthetic replacement';
  a.raw = JSON.stringify({ done: true, done_reason: 'stop', response: a.answer, prompt_eval_count: 7, eval_count: 3 });
  assert.throws(() => validateRecordedInputs(f.plan, consistentButNotOriginal), /원본 명세/);
  assert.equal(hash(f.run), original);
});

test('missing, duplicate, unbound and extra call ledgers cannot certify a strict operator run', async () => {
  const f = await fixture();
  for (const mutate of [r => { delete r.generationLedger; }, r => { r.generationLedger.pop(); },
    r => { r.generationLedger.push(r.generationLedger[0]); },
    r => { r.generationLedger[1].context.recordId = 'not-the-original-record'; },
    r => { r.generationLedger[1].result.inputTokens++; },
    r => { r.generationLedger[0].result.answer = 'changed warmup'; },
    r => { r.warmup = []; r.generationLedger.shift(); r.generationLedger.forEach((e, i) => { e.callId = i + 1; }); },
    r => { delete r.modelVerification; },
    r => { r.modelVerification.after.digest = 'changed'; }]) {
    const bad = structuredClone(f.run); mutate(bad);
    assert.throws(() => validateRecordedInputs(f.plan, bad));
  }
});

test('import verifies the actual returned call files before persisting the private run', async () => {
  const f = await fixture();
  const file = join(f.operatorDir, 'generation-calls/0002.json'), entry = await read(file);
  entry.result.answer = 'changed original sidecar';
  await writeFile(file, JSON.stringify(entry));
  await assert.rejects(main(['import-run', '--dir', f.privateDir, '--file', join(f.operatorDir, 'run.json')]), /원본 생성 호출 파일/);
  await assert.rejects(readFile(join(f.privateDir, 'run.json')), { code: 'ENOENT' });
});

test('model drift after warmup preserves ledger/progress but prevents final run acceptance', async () => {
  const f = await fixture({ drift: true, retryAfterDrift: true });
  assert.match(f.error?.message ?? '', /실행 중 모델/);
  assert.match(f.resumeError?.message ?? '', /이전에 실행 후 모델/);
  await assert.rejects(readFile(join(f.operatorDir, 'run.json')), { code: 'ENOENT' });
  assert.equal((await readdir(join(f.operatorDir, 'generation-calls'))).length, 25);
  const progress = await read(join(f.operatorDir, 'progress.json'));
  assert.equal(progress.records.length, 40);
  assert.equal(progress.modelVerificationIssue.after.digest, 'changed-during-warmup');
  assert.equal(f.calls, 25); // restoring the tag must not auto-certify the preserved batch or add calls.
});

test('identity ignores optional size but rejects changed name, content digest or quantization', () => {
  const a = { name: 'qwen:4b', digest: 'fixed', details: { quantization_level: 'Q4_K_M' } };
  assert.equal(sameModelIdentity(a, { ...a, size: 123 }), true);
  for (const b of [{ ...a, name: 'other' }, { ...a, digest: 'other' },
    { ...a, details: { quantization_level: 'Q8_0' } }]) assert.equal(sameModelIdentity(a, b), false);
});

test('strict failed generations retain exhausted fixed retries and import as zero task scores', async () => {
  const f = await fixture({ fail: true, retries: 1 });
  assert.equal(f.error, undefined);
  assert.equal(f.calls, 33); // warmup once; eight P + eight E-extract stages each exhaust two attempts.
  assert.ok(f.run.records.filter(r => r.methodId !== 'rule-baseline').every(r => r.state === 'failed'));
  await main(['import-run', '--dir', f.privateDir, '--file', join(f.operatorDir, 'run.json')]);
  const report = buildAutomaticReport(f.plan, f.run);
  assert.ok(report.items.filter(r => r.methodId !== 'rule-baseline').every(r => r.dateScore === 0));
});

test('strict length-limited originals support documented status inspection without rewriting call files', async () => {
  const f = await fixture({ length: true });
  assert.equal(f.error, undefined);
  const before = hash(f.run), record = f.run.records.find(r => r.methodId === 'prompt-baseline');
  assert.equal(record.state, 'unknown');
  const complete = resolveRunState(f.plan, f.run, [{ recordId: record.id, originalRecordHash: hash(record),
    state: 'completed', reviewerId: 'synthetic-inspector', reason: 'synthetic readable body inspection', evidence: 'synthetic original body' }]);
  const inspected = complete.records.find(r => r.id === record.id);
  const failed = resolveRunState(f.plan, complete, [{ recordId: record.id, originalRecordHash: hash(inspected),
    state: 'failed', reviewerId: 'synthetic-inspector', reason: 'synthetic later failure confirmation', evidence: 'synthetic original body' }]);
  for (const run of [complete, failed]) {
    validateRecordedInputs(f.plan, run);
    assert.equal(hash(run.generationLedger), hash(f.run.generationLedger));
  }
  assert.equal(hash(f.run), before);
});

test('monotonic call deadline outranks a completed body when timer delivery is delayed', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    const until = performance.now() + 20;
    while (performance.now() < until) { /* intentionally block timer delivery */ }
    return Response.json({ done: true, response: 'late', prompt_eval_count: 7, eval_count: 3 });
  };
  try {
    await assert.rejects(ollamaGenerate({ model: 'synthetic', prompt: 'synthetic' }, { timeoutMs: 1 }),
      e => e.type === 'timeout' && e.elapsedMs >= 1 && e.raw.includes('late') && e.inputTokens === 7);
  } finally { globalThis.fetch = original; }
});

test('monotonic call deadline also outranks invalid JSON or HTTP failures arriving after the limit', async () => {
  const original = globalThis.fetch;
  try {
    for (const response of [new Response('invalid JSON'), new Response('server error', { status: 503 })]) {
      globalThis.fetch = async () => {
        const until = performance.now() + 20;
        while (performance.now() < until) { /* intentionally block timer delivery */ }
        return response;
      };
      await assert.rejects(ollamaGenerate({ model: 'synthetic', prompt: 'synthetic' }, { timeoutMs: 1 }),
        e => e.type === 'timeout' && e.elapsedMs >= 1 && e.raw.length > 0);
    }
  } finally { globalThis.fetch = original; }
});
