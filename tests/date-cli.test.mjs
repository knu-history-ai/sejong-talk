import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
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
