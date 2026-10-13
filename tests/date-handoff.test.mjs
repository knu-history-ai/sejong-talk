import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { main } from '../evals/sejong/date-eval/cli.mjs';
import { ruleAnswer } from '../evals/sejong/date-eval/runner.mjs';
import { loadPilot } from '../evals/sejong/date-eval/pilot.mjs';

const read = async path => JSON.parse(await readFile(path, 'utf8'));
async function copyPaste(dir) {
  const { next } = await read(join(dir, 'operator.json'));
  const child = spawn('/bin/sh', ['-c', next], { cwd: dir,
    env: { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH } });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  return { code, stdout, stderr };
}
async function moveBundle(source) {
  const recipient = await mkdtemp(join(tmpdir(), 'date-recipient-'));
  const moved = join(recipient, '유진 컴퓨터', '평가 자료 $ & " 한글');
  await mkdir(dirname(moved), { recursive: true });
  await rename(source, moved);
  return moved;
}

test('operator command survives spaces, shell characters and relocation without a repository or npm', async () => {
  const sender = await mkdtemp(join(tmpdir(), 'date-sender-'));
  const source = join(sender, "준비한 사람 ' 평가 폴더");
  await main(['prepare', '--dir', source, '--model', 'fixture', '--methods', 'rule-baseline']);
  const before = await readFile(join(source, 'plan.json'), 'utf8');
  const operator = await read(join(source, 'operator.json'));
  assert.equal(operator.next, 'node "./run-evaluation.mjs"');
  assert.equal(JSON.stringify(operator).includes(sender), false);
  const moved = await moveBundle(source);
  await assert.rejects(readFile(join(moved, 'package.json')), { code: 'ENOENT' });
  const result = await copyPaste(moved);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(await readFile(join(moved, 'plan.json'), 'utf8'), before);
  const run = await read(join(moved, 'run.json'));
  assert.equal(run.records.length, 8); assert.equal(run.records.every(row => row.state === 'completed'), true);
  assert.equal(run.records.every(row => row.calls === 0), true);
  assert.equal(operator.generationOnly, true); assert.match(operator.role, /실행·원문\/환경\/오류 기록/);
  for (const file of ['code.json', 'ai.json', 'final.json', 'report.json']) await assert.rejects(readFile(join(moved, file)), { code: 'ENOENT' });
  const bytes = await readFile(join(moved, 'run.json'), 'utf8');
  const duplicate = await copyPaste(moved);
  assert.equal(duplicate.code, 1); assert.match(duplicate.stderr, /완료된 실행/);
  assert.equal(await readFile(join(moved, 'run.json'), 'utf8'), bytes);
});

test('transferred bundle runs all three methods through actual local HTTP and retains raw call records', async () => {
  const { dataset } = await loadPilot(); let calls = 0;
  const server = createServer((req, res) => {
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fixture:latest', digest: 'frozen-q4', details: { quantization_level: 'Q4' } }] }));
    let raw = ''; req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      calls++;
      const request = JSON.parse(raw), question = dataset.cases.find(c => request.prompt.includes(c.question));
      res.end(JSON.stringify({ done: true, response: ruleAnswer(question), prompt_eval_count: 20, eval_count: 7 }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  try {
    const sender = await mkdtemp(join(tmpdir(), 'date-sender-http-')), source = join(sender, '준비 평가');
    await main(['prepare', '--dir', source, '--model', 'fixture', '--endpoint', endpoint]);
    const moved = await moveBundle(source), result = await copyPaste(moved);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const run = await read(join(moved, 'run.json'));
    assert.equal(run.records.length, 24); assert.equal(calls, 24);
    assert.equal(run.records.every(row => row.state === 'completed'), true);
    assert.equal(run.records.reduce((sum, row) => sum + row.calls, 0), calls);
    assert.equal(run.records.reduce((sum, row) => sum + row.inputTokens, 0), 480);
    assert.equal(run.records.reduce((sum, row) => sum + row.outputTokens, 0), 168);
    const ledger = await read(join(moved, 'generation-calls/0001.json'));
    assert.equal(ledger.state, 'completed'); assert.equal(ledger.result.inputTokens, 20);
    assert.equal((await read(join(moved, 'progress.json'))).inFlight, null);
    await assert.rejects(readFile(join(moved, 'final.json')), { code: 'ENOENT' });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
