import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadPilot } from '../evals/sejong/date-eval/pilot.mjs';
import { makePlan, hash, validateRun } from '../evals/sejong/date-eval/core.mjs';
import { runPlan, ruleAnswer, ollamaGenerate, localEndpoint } from '../evals/sejong/date-eval/runner.mjs';

async function plan(methods = ['prompt-baseline', 'rule-baseline', 'evidence-first'], retries = 0) {
  const { dataset, gold } = await loadPilot();
  return makePlan(dataset, gold, { model: 'fixture-model', endpoint: 'http://127.0.0.1:11434', options: { temperature: 0, num_ctx: 4096 }, timeoutMs: 100, retries, repeats: 1, seed: 62, warmup: false, runOrder: 'seeded', methods: methods.map((id) => ({ id, version: 'fixture' })) });
}
test('pilot preserves B01–B08 and precise citation offsets; criterion hash detects rubric drift', async () => {
  const p = await plan();
  assert.deepEqual(p.dataset.cases.map((c) => c.id), ['B01','B02','B03','B04','B05','B06','B07','B08']);
  assert.equal(p.gold.cases[7].events.length, 2);
  p.gold.rubric.date += 'changed';
  assert.throws(() => validateRun(p, {}), /정답표/);
});
test('three methods use no gold, all stages and usage logged; deterministic order', async () => {
  const p = await plan();
  const prompts = [], checkpoints = [];
  const generate = async (request) => {
    prompts.push(request);
    assert.equal(Object.hasOwn(request, 'gold'), false);
    assert.equal(request.prompt.includes('issue62-date-v1'), false);
    assert.equal(request.prompt.includes('allowedOmissions'), false);
    if (request.stage === 'answer') {
      assert.equal(request.prompt.includes('반드시 JSON 객체 하나로'), true);
      assert.equal(request.prompt.includes('가능하면 JSON'), false);
    }
    return { answer: '확인 가능한 월과 근거를 답합니다.', raw: '{"fixture":true}', inputTokens: 5, outputTokens: 2 };
  };
  const run = await runPlan(p, { generate, onRecord: async (r) => checkpoints.push(r) });
  validateRun(p, run);
  assert.equal(run.records.length, 24);
  assert.equal(prompts.length, 24);
  assert.equal(checkpoints.length, 24);
  assert.equal(run.records.filter((r) => r.methodId === 'rule-baseline').every((r) => r.calls === 0 && r.inputTokens === 0), true);
  const again = await runPlan(p, { generate });
  assert.deepEqual(run.records.map((r) => r.id), again.records.map((r) => r.id));
  assert.equal(hash(p), hash(await plan()));
});
test('fixed retry counts failures, recovered output completes; exhausted timeout cannot grade partial', async () => {
  const p = await plan(['prompt-baseline'], 1);
  let n = 0;
  const run = await runPlan(p, { generate: async () => {
    if (n++ % 2 === 0) throw Object.assign(new Error('timeout'), { type: 'timeout', raw: '부분 답변' });
    return { answer: '정상 답변', inputTokens: 3, outputTokens: 4 };
  } });
  assert.equal(run.records.every((r) => r.state === 'completed' && r.calls === 2 && r.inputTokens === null), true);
  const fail = await runPlan(p, { generate: async () => { throw Object.assign(new Error('timeout'), { type: 'timeout', raw: '맞는 것 같은 부분 답변' }); } });
  assert.equal(fail.records.every((r) => r.state === 'failed' && r.calls === 2 && r.rawAnswer === '' && r.error.partial), true);
});
test('month rule does not erase explicit start/end day; fresh independent questions', async () => {
  const p = await plan();
  for (const [id, event, month, day] of [['B01','creation',12,null],['B05','dispatch',1,null],['B06','start',2,15],['B07','end',3,15]]) {
    const answer = JSON.parse(ruleAnswer(p.dataset.cases.find((c) => c.id === id)));
    const e = answer.events.find((e) => e.id === event);
    assert.equal(e.date.month, month);
    assert.equal(e.date.day, day);
  }
  const b08 = JSON.parse(ruleAnswer(p.dataset.cases[7]));
  assert.equal(b08.events.length, 2);
  assert.equal(b08.events[1].date.day, 15);
});
test('local provider rejects external endpoints', () => {
  assert.throws(() => localEndpoint('https://api.example.com'), /로컬/);
});

test('audit storage failure stops generation without pretending it was a model failure or retrying', async () => {
  const p = await plan(['prompt-baseline'], 3);
  let calls = 0, terminalRecords = 0;
  await assert.rejects(runPlan(p, {
    generate: async () => {
      calls++;
      throw Object.assign(new Error('audit cannot persist'), { auditStorageFailure: true });
    },
    onRecord: async () => { terminalRecords++; },
  }), /audit cannot persist/);
  assert.equal(calls, 1);
  assert.equal(terminalRecords, 0);
});
test('actual HTTP transport records raw output, timeout priority and malformed/empty/nonterminal failures', async () => {
  let notifyPartial;
  const server = createServer((req, res) => {
    let input = '';
    req.on('data', (chunk) => { input += chunk; });
    req.on('end', () => {
      const prompt = JSON.parse(input).prompt;
      if (prompt === 'timeout') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"response":"partial"', () => notifyPartial?.());
        return;
      }
      res.end(prompt === 'bad' ? 'invalid' : JSON.stringify({ done: prompt !== 'truncated', response: prompt === 'empty' ? '' : '형식이 잘못돼도 읽을 수 있는 답변', prompt_eval_count: 8, eval_count: 4 }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await ollamaGenerate({ model: 'fixture', prompt: 'okay', options: {} }, { endpoint, timeoutMs: 500 });
    assert.equal(result.inputTokens, 8);
    assert.match(result.raw, /response/);
    for (const prompt of ['bad','empty','truncated']) await assert.rejects(ollamaGenerate({ model: 'fixture', prompt }, { endpoint, timeoutMs: 500 }),
      (error) => prompt !== 'truncated' || (error.inputTokens === 8 && error.outputTokens === 4 && error.raw.includes('response')));
    // This verifies preserved partial transport, not 30ms localhost scheduling under a busy full suite.
    await assert.rejects(ollamaGenerate({ model: 'fixture', prompt: 'timeout' }, { endpoint, timeoutMs: 500 }), (error) => error.type === 'timeout' && error.raw.includes('partial'));
    const controller = new AbortController();
    const partialSent = new Promise(resolve => { notifyPartial = resolve; });
    const pending = ollamaGenerate({ model: 'fixture', prompt: 'timeout' }, { endpoint, timeoutMs: 5000, signal: controller.signal });
    await partialSent;
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, (error) => error.type === 'timeout' && error.raw.includes('partial'));
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
