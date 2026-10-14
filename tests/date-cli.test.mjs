import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../evals/sejong/date-eval/cli.mjs';
import { loadPilot } from '../evals/sejong/date-eval/pilot.mjs';
import { ruleAnswer, runPlan } from '../evals/sejong/date-eval/runner.mjs';
import { hash, makePlan } from '../evals/sejong/date-eval/core.mjs';

const read = async (p) => JSON.parse(await readFile(p, 'utf8'));
const mockAiCost = () => ({ calls: 8, elapsedMs: 123,
  inputTokens: { sum: 80, partialKnownSum: 80, known: 8, total: 8 },
  outputTokens: { sum: null, partialKnownSum: 0, known: 0, total: 8 } });
const mockReview = (packet, reviewerId) => ({
  packetId: packet.id, packetHash: packet.hash, reviewerId, independent: true, blind: true,
  date: 1, evidence: 1, reason: '테스트 전용 모의 판정. 실제 사람 채점 아님.',
  events: packet.input.gold.events.map(e => ({ id: e.id, date: 1,
    ...Object.fromEntries(Object.entries(e.eligibility).map(([key, eligible]) => [key, eligible ? 0 : null])),
    reasons: { date: '모의 근거', unsupportedDay: '모의 근거', missingKnownDay: '모의 근거', headerConfusion: '모의 근거' },
  })),
});
async function offlineFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'date-eval-regression-'));
  await main(['prepare', '--dir', dir, '--model', 'fixture', '--methods', 'rule-baseline']);
  await main(['run', '--dir', dir]);
  return dir;
}
test('CLI resume preserves an explicit partial warmup ledger instead of inferring completeness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'date-warmup-resume-'));
  await main(['prepare', '--dir', dir, '--model', 'fixture', '--methods', 'rule-baseline', '--warmup']);
  await main(['run', '--dir', dir]);
  await rename(join(dir, 'run.json'), join(dir, 'original-run.json'));
  const progress = await read(join(dir, 'progress.json'));
  await writeFile(join(dir, 'progress.json'), JSON.stringify({ ...progress, warmupHistoryComplete: false }));
  await main(['run', '--dir', dir]);
  assert.equal((await read(join(dir, 'run.json'))).warmupHistoryComplete, false);
  assert.equal((await read(join(dir, 'progress.json'))).warmupHistoryComplete, false);
});
async function submit(dir, reviews, reviewer, runArgs = []) {
  const file = join(dir, 'submission.json');
  await writeFile(file, JSON.stringify(reviews));
  return main(['import-review', '--dir', dir, '--file', file, '--reviewer', reviewer, ...runArgs]);
}
async function finalFixture(dir, runArgs = []) {
  await main(['packets', '--dir', dir, ...runArgs]);
  const packets = await read(join(dir, 'review-share/packets.json'));
  for (const reviewer of ['A', 'B']) await submit(dir, packets.map(p => mockReview(p, reviewer)), reviewer, runArgs);
  await main(['finalize', '--dir', dir, ...runArgs]);
}

async function failedFixture(mixed = false) {
  const dir = await mkdtemp(join(tmpdir(), 'date-all-failed-'));
  const { dataset, gold } = await loadPilot();
  const plan = makePlan(dataset, gold, { model: 'fixture', endpoint: 'http://127.0.0.1:11434',
    options: { temperature: 0 }, timeoutMs: 100, retries: 0, repeats: 1, seed: 62,
    warmup: false, runOrder: 'seeded', methods: [{ id: 'prompt-baseline', version: 'fixture' }] });
  let calls = 0;
  const run = await runPlan(plan, { generate: async () => {
    if (mixed && calls++ === 0) return { answer: '완료된 모의 답변', raw: '{"fixture":true}', inputTokens: 10, outputTokens: 3 };
    throw Object.assign(new Error('timeout'), { type: 'timeout', raw: '시간초과 부분 답변' });
  } });
  await writeFile(join(dir, 'plan.json'), JSON.stringify(plan));
  await writeFile(join(dir, 'source-run.json'), JSON.stringify(run));
  await main(['import-run', '--dir', dir, '--file', join(dir, 'source-run.json')]);
  await main(['packets', '--dir', dir]);
  return dir;
}

test('all failed questions finalize and report zero without any human submissions', async () => {
  const dir = await failedFixture();
  const original = await readFile(join(dir, 'run.json'), 'utf8');
  assert.deepEqual(await read(join(dir, 'review-share/packets.json')), []);
  await assert.rejects(readdir(join(dir, 'reviews')), { code: 'ENOENT' });
  await main(['finalize', '--dir', dir]);
  const final = await read(join(dir, 'final.json'));
  assert.equal(final.items.length, 8);
  assert.ok(final.items.every(i => i.state === 'execution-failure' && i.date === 0 && i.evidence === 0));
  assert.deepEqual(final.agreement.details, []);
  await main(['report', '--dir', dir]);
  const report = await read(join(dir, 'report.json'));
  const metrics = report.methods[0].operational;
  assert.equal(metrics.fixedTotal, 8); assert.equal(metrics.failed, 8);
  assert.equal(metrics.accuracy.value, 0); assert.equal(metrics.evidence.value, 0);
  assert.equal(metrics.completion.value, 0); assert.equal(metrics.conditionalAccuracy.value, null);
  await read(join(dir, 'comparison.json')); await read(join(dir, 'evaluation-cost.json'));
  assert.equal(await readFile(join(dir, 'run.json'), 'utf8'), original);
  await assert.rejects(readdir(join(dir, 'reviews')), { code: 'ENOENT' });
});

test('missing human submissions do not turn completed answers into automatic zero scores', async () => {
  const dir = await failedFixture(true);
  await main(['finalize', '--dir', dir]);
  const final = await read(join(dir, 'final.json'));
  assert.equal(final.items.filter(i => i.state === 'execution-failure').length, 7);
  const pending = final.items.filter(i => i.state === 'pending');
  assert.equal(pending.length, 1); assert.equal(pending[0].date, null);
  await assert.rejects(main(['report', '--dir', dir]), /pending/);
  await assert.rejects(readFile(join(dir, 'report.json')), { code: 'ENOENT' });
});

test('malformed review files are not treated as absent submissions', async () => {
  const dir = await offlineFixture();
  await main(['packets', '--dir', dir]);
  const packets = await read(join(dir, 'review-share/packets.json'));
  await submit(dir, [mockReview(packets[0], 'A')], 'A');
  const [file] = await readdir(join(dir, 'reviews'));
  await writeFile(join(dir, 'reviews', file), '{broken');
  await assert.rejects(main(['finalize', '--dir', dir]), SyntaxError);
  await assert.rejects(readFile(join(dir, 'final.json')), { code: 'ENOENT' });
});

test('invalid code and AI cost values reject all report outputs, not just mismatched hashes', async () => {
  const dir = await offlineFixture(); await finalFixture(dir); await main(['code', '--dir', dir]);
  const code = await read(join(dir, 'code.json'));
  for (const badTime of [-1, '100', null]) {
    await writeFile(join(dir, 'code.json'), JSON.stringify({ ...code, elapsedMs: badTime }));
    await assert.rejects(main(['report', '--dir', dir]), /code.elapsedMs/);
    await assert.rejects(readFile(join(dir, 'report.json')), { code: 'ENOENT' });
  }
  await writeFile(join(dir, 'code.json'), JSON.stringify(code));
  const ai = { schemaVersion: 1, planId: code.planId, criteriaHash: code.criteriaHash,
    runHash: code.runHash, type: 'ai-preliminary', evaluationCost: mockAiCost() };
  for (const change of [{ calls: -2 }, { elapsedMs: '비용 아님' }, { inputTokens: { sum: -1 } }]) {
    await writeFile(join(dir, 'ai.json'), JSON.stringify({ ...ai, evaluationCost: { ...mockAiCost(), ...change } }));
    await assert.rejects(main(['report', '--dir', dir]));
    for (const file of ['report.json', 'comparison.json', 'evaluation-cost.json']) {
      await assert.rejects(readFile(join(dir, file)), { code: 'ENOENT' });
    }
  }
});

test('SIGKILL during AI grading reports interruption and known partial transport costs without resuming calls', async () => {
  const dir = await offlineFixture(); await finalFixture(dir);
  const originalRun = await read(join(dir, 'run.json'));
  let calls = 0, beginSecond;
  const secondStarted = new Promise(resolve => { beginSecond = resolve; });
  const server = createServer((req, res) => {
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fixture:latest', digest: 'fixed', details: {} }] }));
    req.resume();
    req.on('end', () => {
      calls++;
      if (calls === 1) res.end(JSON.stringify({ done: true, response: '{"date":null}', prompt_eval_count: 20, eval_count: 7 }));
      else { res.writeHead(200); res.write('{"response":"중단된 출력'); beginSecond(); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  let child, exited, timer;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL('../evals/sejong/date-eval/cli.mjs', import.meta.url)),
      'ai', '--dir', dir, '--model', 'fixture', '--endpoint', endpoint]);
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    await Promise.race([secondStarted, exited.then(value => { throw new Error('AI ended before second call: ' + JSON.stringify(value) + output); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('AI second call not started: ' + output)), 5000); })]);
    clearTimeout(timer); child.kill('SIGKILL'); assert.equal((await exited).signal, 'SIGKILL');
    await assert.rejects(readFile(join(dir, 'ai.json')), { code: 'ENOENT' });
    await main(['report', '--dir', dir]);
    const cost = await read(join(dir, 'evaluation-cost.json'));
    assert.equal(cost.aiExecution.status, 'interrupted'); assert.equal(cost.aiExecution.interrupted, true);
    assert.equal(cost.ai.calls, null); assert.equal(cost.ai.recordedAttempts, 2);
    assert.equal(cost.ai.confirmedTerminalCalls, 1); assert.equal(cost.ai.inFlightCalls, 1);
    assert.equal(cost.ai.elapsedMs, null); assert.ok(cost.ai.partialKnownElapsedMs >= 0);
    assert.deepEqual(cost.ai.inputTokens, { sum: null, partialKnownSum: 20, known: 1, total: 2 });
    assert.deepEqual(cost.ai.outputTokens, { sum: null, partialKnownSum: 7, known: 1, total: 2 });
    assert.equal(Object.keys(cost.aiExecution.ledgerHashes).length, 2);
    assert.deepEqual(await read(join(dir, 'run.json')), originalRun);
    await assert.rejects(main(['ai', '--dir', dir, '--model', 'fixture', '--endpoint', endpoint]), /시작한 기록/);
    assert.equal(calls, 2);
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await exited; }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('partial human submissions append only new packets and preserve legacy first-review bytes', async () => {
  const dir = await offlineFixture();
  await main(['packets', '--dir', dir]);
  const packets = await read(join(dir, 'review-share/packets.json'));
  await submit(dir, [mockReview(packets[0], 'A')], 'A');
  const [firstFile] = await readdir(join(dir, 'reviews'));
  const legacyPath = join(dir, 'reviews/A.json');
  await rename(join(dir, 'reviews', firstFile), legacyPath);
  const originalBytes = await readFile(legacyPath, 'utf8');
  await assert.rejects(submit(dir, [mockReview(packets[0], 'A'), mockReview(packets[1], 'A')], 'A'), /덮어/);
  assert.equal((await readdir(join(dir, 'reviews'))).length, 1);
  await submit(dir, packets.slice(1).map(p => mockReview(p, 'A')), 'A');
  assert.equal(await readFile(legacyPath, 'utf8'), originalBytes);
  const files = await readdir(join(dir, 'reviews'));
  assert.equal(files.length, 2);
  const before = await Promise.all(files.map(file => readFile(join(dir, 'reviews', file), 'utf8')));
  const changed = mockReview(packets[0], 'A'); changed.reason = '원본을 바꾸려는 요청';
  await assert.rejects(submit(dir, [changed], 'A'), /덮어/);
  assert.deepEqual(await Promise.all(files.map(file => readFile(join(dir, 'reviews', file), 'utf8'))), before);
  await submit(dir, packets.map(p => mockReview(p, 'B')), 'B');
  await main(['finalize', '--dir', dir]);
  const final = await read(join(dir, 'final.json'));
  assert.equal(final.items.every(item => item.state === 'final'), true);
  assert.equal(final.agreement.details.every(detail => detail.firstReviews.length === 2), true);
  await main(['report', '--dir', dir]);
});

test('matching and absent grading costs retain run provenance without assuming absent costs are zero', async () => {
  for (const present of [false, true]) {
    const dir = await offlineFixture();
    await finalFixture(dir);
    let code, ai;
    if (present) {
      await main(['code', '--dir', dir]);
      code = await read(join(dir, 'code.json'));
      ai = { schemaVersion: 1, planId: code.planId, criteriaHash: code.criteriaHash,
        runHash: code.runHash, type: 'ai-preliminary', evaluationCost: mockAiCost() };
      await writeFile(join(dir, 'ai.json'), JSON.stringify(ai));
    }
    await main(['report', '--dir', dir]);
    const cost = await read(join(dir, 'evaluation-cost.json'));
    assert.equal(cost.runHash, hash(await read(join(dir, 'run.json'))));
    assert.equal(cost.code, present ? code.elapsedMs : null);
    assert.deepEqual(cost.ai, present ? ai.evaluationCost : null);
    assert.equal(cost.artifacts.code, present ? hash(code) : null);
    assert.equal(cost.artifacts.ai, present ? hash(ai) : null);
  }
});

test('mismatched code or AI cost provenance rejects reporting before writing any output', async () => {
  const dir = await offlineFixture();
  await finalFixture(dir);
  await main(['code', '--dir', dir]);
  const code = await read(join(dir, 'code.json'));
  const ai = { schemaVersion: 1, planId: code.planId, criteriaHash: code.criteriaHash,
    runHash: code.runHash, type: 'ai-preliminary', evaluationCost: mockAiCost() };
  for (const kind of ['code', 'ai']) for (const field of ['schemaVersion', 'planId', 'criteriaHash', 'runHash', 'type']) {
    await writeFile(join(dir, 'code.json'), JSON.stringify(code));
    await writeFile(join(dir, 'ai.json'), JSON.stringify(ai));
    const bad = structuredClone(kind === 'code' ? code : ai);
    bad[field] = field === 'schemaVersion' ? 2 : 'different-version';
    await writeFile(join(dir, kind + '.json'), JSON.stringify(bad));
    await assert.rejects(main(['report', '--dir', dir]), new RegExp(kind + '\\.json: ' + field));
    for (const name of ['report.json', 'comparison.json', 'evaluation-cost.json']) {
      await assert.rejects(readFile(join(dir, name)), { code: 'ENOENT' });
    }
  }
});

test('state-confirmed run cannot use the original run grading costs', async () => {
  const dir = await offlineFixture();
  await main(['code', '--dir', dir]);
  const run = await read(join(dir, 'run.json'));
  const decisions = join(dir, 'decisions.json'), confirmed = join(dir, 'run-confirmed.json');
  await writeFile(decisions, JSON.stringify([{ recordId: run.records[0].id,
    originalRecordHash: hash(run.records[0]), reviewerId: '담당자', state: 'failed',
    reason: '진단용 상태 확인', evidence: '진단용 원문 확인' }]));
  await main(['resolve-state', '--dir', dir, '--file', decisions, '--out', confirmed]);
  await finalFixture(dir, ['--run', confirmed]);
  await assert.rejects(main(['report', '--dir', dir, '--run', confirmed]), /code.json: runHash/);
  await assert.rejects(readFile(join(dir, 'report.json')), { code: 'ENOENT' });
  assert.deepEqual(await read(join(dir, 'run.json')), run);
});
test('offline CLI rule run → separate packets → two reviews → report and immutable first reviews', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'date-eval-cli-'));
  await main(['prepare', '--dir', dir, '--model', 'fixture-no-model-call', '--methods', 'rule-baseline']);
  await main(['run', '--dir', dir]);
  const run = await read(join(dir, 'run.json'));
  assert.equal(run.records.length, 8);
  assert.equal(run.records.every((r) => r.calls === 0), true);
  await main(['code', '--dir', dir]);
  await main(['packets', '--dir', dir]);
  const packets = await read(join(dir, 'review-share/packets.json'));
  assert.equal(packets.length, 8);
  assert.equal(JSON.stringify(packets).includes('rule-baseline'), false);
  const judge = (p, reviewerId) => ({
    packetId: p.id, packetHash: p.hash, reviewerId, independent: true, blind: true,
    date: 1, evidence: 1, reason: '테스트 전용 사람 판정 모의 자료. 실제 채점 아님.',
    events: p.input.gold.events.map((e) => ({
      id: e.id, date: 1, ...Object.fromEntries(Object.entries(e.eligibility).map(([k, v]) => [k, v ? 0 : null])),
      reasons: { date: '모의 근거', unsupportedDay: '모의 근거', missingKnownDay: '모의 근거', headerConfusion: '모의 근거' },
    })),
  });
  for (const reviewer of ['fixture-A', 'fixture-B']) {
    const file = join(dir, reviewer + '-input.json');
    await writeFile(file, JSON.stringify(packets.map((p) => judge(p, reviewer))));
    await main(['import-review', '--dir', dir, '--file', file, '--reviewer', reviewer]);
    await assert.rejects(main(['import-review', '--dir', dir, '--file', file, '--reviewer', reviewer]), /덮어/);
  }
  await main(['finalize', '--dir', dir]);
  await main(['report', '--dir', dir]);
  const report = await read(join(dir, 'report.json'));
  assert.equal(report.paperEligible, false);
  assert.equal(report.methods[0].core.completion.value, 1);
  assert.equal((await read(join(dir, 'comparison.json'))).comparisons[0].core.both1, 7);
  await assert.rejects(main(['run', '--dir', dir]), /덮어/);
  await assert.rejects(main(['prepare', '--dir', dir, '--model', 'other']), /덮어/);
  await writeFile(join(dir, 'ai.json'), '{}');
  await assert.rejects(main(['ai', '--dir', dir, '--model', 'unavailable-model']), /이미 있습니다/);
});

test('real HTTP CLI locks model digest, records three methods and separate AI attempts without final promotion', async () => {
  const { dataset } = await loadPilot();
  let calls = 0, digest = 'fixture-digest-Q4';
  const server = createServer((req, res) => {
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fixture:latest', digest, details: { quantization_level: 'Q4_K_M' }, size: 10 }] }));
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls++;
      const input = JSON.parse(raw);
      assert.equal(input.think, false);
      const c = dataset.cases.find((c) => input.prompt.includes(c.question));
      const answer = input.prompt.startsWith('{"instructions"') ? JSON.stringify({ date: 1, reason: 'missing proofs: intentionally invalid AI fixture' })
        : c ? ruleAnswer(c) : '준비';
      res.end(JSON.stringify({ done: true, done_reason: 'stop', response: answer, prompt_eval_count: 12, eval_count: 9 }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const dir = await mkdtemp(join(tmpdir(), 'date-eval-cli-http-'));
  try {
    await main(['prepare', '--dir', dir, '--model', 'fixture', '--endpoint', endpoint]);
    digest = 'changed';
    await assert.rejects(main(['run', '--dir', dir]), /모델 파일/);
    assert.equal(calls, 0);
    digest = 'fixture-digest-Q4';
    await main(['run', '--dir', dir]);
    assert.equal(calls, 24);
    const run = await read(join(dir, 'run.json'));
    assert.equal(run.records.length, 24);
    assert.equal(run.records.reduce((n, r) => n + r.calls, 0), 24);
    const logs = await readdir(join(dir, 'generation-calls'));
    assert.equal(logs.filter(f => f.endsWith('.json')).length, 24);
    const firstCall = await read(join(dir, 'generation-calls', '0001.json'));
    assert.equal(firstCall.request.think, false);
    assert.equal(firstCall.state, 'completed');
    assert.equal(firstCall.result.inputTokens, 12);
    assert.equal(firstCall.result.outputTokens, 9);
    assert.equal(firstCall.result.raw.includes('response'), true);
    assert.equal(run.records.some(r => r.id === firstCall.context.recordId), true);
    await main(['ai', '--dir', dir, '--model', 'fixture', '--endpoint', endpoint]);
    assert.equal(calls, 48);
    const ai = await read(join(dir, 'ai.json'));
    assert.equal((await read(join(dir, 'ai-start.json'))).judgeConfig.think, false);
    assert.equal((await read(join(dir, 'ai-calls/0001.json'))).request.think, false);
    assert.equal(ai.items.every((i) => i.state === 'partial-failure' && i.date === null), true);
    assert.equal(ai.evaluationCost.calls, 24);
    assert.equal((await read(join(dir, 'ai-calls/0001.json'))).state, 'completed');
    await assert.rejects(main(['ai', '--dir', dir, '--model', 'fixture', '--endpoint', endpoint]), /이미 있습니다/);
    assert.equal(calls, 48);
    assert.equal((await read(join(dir, 'run.json'))).records.every((r) => r.state === 'completed'), true);
    await finalFixture(dir);
    await main(['report', '--dir', dir]);
    const cost = await read(join(dir, 'evaluation-cost.json'));
    assert.deepEqual(cost.ai, ai.evaluationCost);
    assert.equal(cost.aiExecution.status, 'completed');
    assert.equal(Object.keys(cost.aiExecution.ledgerHashes).length, 24);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('abrupt process termination during final answer preserves the completed extraction and its usage', async () => {
  let beginFinal;
  const finalStarted = new Promise(resolve => { beginFinal = resolve; });
  let calls = 0;
  const server = createServer((req, res) => {
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fixture:latest', digest: 'fixed', details: {} }] }));
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      calls++;
      const input = JSON.parse(raw);
      if (input.prompt.includes('<예비추출-검증되지-않은-자료>')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"response":"미완료 부분');
        beginFinal();
      } else res.end(JSON.stringify({ done: true, response: '먼저 추출한 원문 근거', prompt_eval_count: 20, eval_count: 7 }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(join(tmpdir(), 'date-eval-cli-interrupted-'));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  let child, exited, timer;
  try {
    await main(['prepare', '--dir', dir, '--model', 'fixture', '--endpoint', endpoint, '--methods', 'evidence-first']);
    child = spawn(process.execPath, [fileURLToPath(new URL('../evals/sejong/date-eval/cli.mjs', import.meta.url)), 'run', '--dir', dir]);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    await Promise.race([finalStarted, exited.then(result => { throw new Error('child process ended before final call: ' + JSON.stringify(result) + output); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('final call not started: ' + output)), 5000); })]);
    clearTimeout(timer);
    child.kill('SIGKILL');
    assert.equal((await exited).signal, 'SIGKILL');
    const first = await read(join(dir, 'generation-calls/0001.json'));
    const second = await read(join(dir, 'generation-calls/0002.json'));
    assert.equal(first.state, 'completed');
    assert.equal(first.context.stage, 'extract');
    assert.equal(first.result.answer, '먼저 추출한 원문 근거');
    assert.equal(first.result.inputTokens, 20);
    assert.equal(first.result.outputTokens, 7);
    assert.match(first.result.raw, /먼저 추출한 원문 근거/);
    assert.equal(second.state, 'in-flight');
    assert.equal(second.context.stage, 'answer');
    assert.equal(second.context.recordId, first.context.recordId);
    const progress = await read(join(dir, 'progress.json'));
    assert.equal(progress.inFlight.callFile, join('generation-calls', '0002.json'));
    assert.equal(progress.records.length, 0);
    await assert.rejects(main(['run', '--dir', dir]), /끊긴 호출/);
    assert.equal(calls, 2, 'unknown interrupted call must not be replayed');
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await exited; }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('failed attempts and configured retries each retain their original usage and raw error', async () => {
  const counters = new Map();
  const server = createServer((req, res) => {
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fixture:latest', digest: 'fixed', details: {} }] }));
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const { prompt } = JSON.parse(raw);
      const n = (counters.get(prompt) ?? 0) + 1;
      counters.set(prompt, n);
      res.end(JSON.stringify({ done: n === 2, response: n === 2 ? '정상 완료 답변' : '읽히지만 미완료 부분 답변',
        prompt_eval_count: n === 2 ? 12 : 20, eval_count: n === 2 ? 3 : 7 }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(join(tmpdir(), 'date-eval-cli-retries-'));
  try {
    await main(['prepare', '--dir', dir, '--model', 'fixture', '--endpoint', `http://127.0.0.1:${server.address().port}`, '--methods', 'prompt-baseline', '--retries', '1']);
    await main(['run', '--dir', dir]);
    const first = await read(join(dir, 'generation-calls/0001.json'));
    const second = await read(join(dir, 'generation-calls/0002.json'));
    assert.equal(first.state, 'failed');
    assert.match(first.raw, /미완료 부분 답변/);
    assert.equal(first.inputTokens, 20);
    assert.equal(first.outputTokens, 7);
    assert.equal(first.context.attempt, 0);
    assert.equal(second.state, 'completed');
    assert.equal(second.context.attempt, 1);
    assert.equal(first.context.recordId, second.context.recordId);
    const run = await read(join(dir, 'run.json'));
    assert.equal(run.records.every(r => r.state === 'completed' && r.calls === 2 && r.inputTokens === 32 && r.outputTokens === 10), true);
    assert.equal((await readdir(join(dir, 'generation-calls'))).filter(f => f.endsWith('.json')).length, 16);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('CLI rejects incomplete first-review final reporting and preserves original run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'date-eval-cli-pending-'));
  await main(['prepare', '--dir', dir, '--model', 'fixture', '--methods', 'rule-baseline']);
  await main(['run', '--dir', dir]);
  await main(['packets', '--dir', dir]);
  const original = await readFile(join(dir, 'run.json'), 'utf8');
  const packets = await read(join(dir, 'review-share/packets.json'));
  const empty = await read(join(dir, 'review-share/blank-review.json'));
  assert.equal(empty[0].date, null);
  assert.equal(empty[0].independent, false);
  assert.equal(packets[0].input.rawAnswer.length > 0, true);
  await assert.rejects(main(['report', '--dir', dir]), /ENOENT/);
  assert.equal(await readFile(join(dir, 'run.json'), 'utf8'), original);
});
