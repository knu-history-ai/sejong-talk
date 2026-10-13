import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../evals/sejong/date-eval/cli.mjs';
import { loadPilot } from '../evals/sejong/date-eval/pilot.mjs';
import { ruleAnswer } from '../evals/sejong/date-eval/runner.mjs';

const read = async (p) => JSON.parse(await readFile(p, 'utf8'));
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
    assert.equal(firstCall.state, 'completed');
    assert.equal(firstCall.result.inputTokens, 12);
    assert.equal(firstCall.result.outputTokens, 9);
    assert.equal(firstCall.result.raw.includes('response'), true);
    assert.equal(run.records.some(r => r.id === firstCall.context.recordId), true);
    await main(['ai', '--dir', dir, '--model', 'fixture', '--endpoint', endpoint]);
    assert.equal(calls, 48);
    const ai = await read(join(dir, 'ai.json'));
    assert.equal(ai.items.every((i) => i.state === 'partial-failure' && i.date === null), true);
    assert.equal(ai.evaluationCost.calls, 24);
    assert.equal((await read(join(dir, 'ai-calls/0001.json'))).state, 'completed');
    await assert.rejects(main(['ai', '--dir', dir, '--model', 'fixture', '--endpoint', endpoint]), /이미 있습니다/);
    assert.equal(calls, 48);
    assert.equal((await read(join(dir, 'run.json'))).records.every((r) => r.state === 'completed'), true);
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
    assert.equal(progress.inFlight.callFile, 'generation-calls/0002.json');
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
