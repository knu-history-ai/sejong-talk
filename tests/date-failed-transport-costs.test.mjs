import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, makePlan } from '../evals/sejong/date-eval/core.mjs';
import { loadPilot } from '../evals/sejong/date-eval/pilot.mjs';
import { ollamaGenerate, ruleAnswer, runPlan } from '../evals/sejong/date-eval/runner.mjs';

const request = { model: 'synthetic', prompt: 'synthetic input', options: {}, think: false };
const body = (extra = {}) => JSON.stringify({ done: true, done_reason: 'stop', response: '완료처럼 보이는 원답변',
  prompt_eval_count: 17, eval_count: 9, ...extra });

// No sockets or models: expose complete bytes first, then independently close,
// fail, or wait for cancellation. Bytewise delivery also exercises UTF-8 decoding.
function mockTransport(t, raw, { status = 200, ending = 'close', bytewise = false } = {}) {
  let reachedEnd;
  const end = new Promise(resolve => { reachedEnd = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    const bytes = new TextEncoder().encode(raw);
    const chunks = bytewise ? [...bytes].map(byte => Uint8Array.of(byte)) : [bytes];
    let index = 0, abort;
    const stream = new ReadableStream({
      start(controller) {
        abort = () => controller.error(new DOMException('synthetic body abort', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
      },
      pull(controller) {
        if (index < chunks.length) return controller.enqueue(chunks[index++]);
        reachedEnd();
        if (ending === 'wait') return;
        signal.removeEventListener('abort', abort);
        if (ending === 'error') controller.error(new Error('synthetic body reset'));
        else controller.close();
      },
      cancel() { signal.removeEventListener('abort', abort); },
    });
    return new Response(stream, { status });
  });
  return end;
}

async function failure(options = {}) {
  let error;
  await assert.rejects(ollamaGenerate(request, { timeoutMs: 5000, ...options }), cause => {
    error = cause;
    return true;
  });
  return error;
}

test('HTTP errors retain full raw usage without promoting a valid-looking answer to success', async t => {
  const raw = body();
  mockTransport(t, raw, { status: 503 });
  const error = await failure();
  assert.equal(error.type, 'call-failure');
  assert.equal(error.message, 'HTTP 503');
  assert.equal(error.raw, raw);
  assert.equal(error.inputTokens, 17);
  assert.equal(error.outputTokens, 9);
  assert.equal(Object.hasOwn(error, 'answer'), false);
});

test('complete JSON followed by a stream error retains raw, known usage and failure', async t => {
  const raw = body();
  mockTransport(t, raw, { ending: 'error', bytewise: true });
  const error = await failure();
  assert.equal(error.type, 'call-failure');
  assert.match(error.message, /synthetic body reset/);
  assert.equal(error.raw, raw);
  assert.equal(error.inputTokens, 17);
  assert.equal(error.outputTokens, 9);
});

test('complete JSON before body EOF timeout retains usage but never completes', async t => {
  const raw = body();
  mockTransport(t, raw, { ending: 'wait' });
  const error = await failure({ timeoutMs: 20 });
  assert.equal(error.type, 'timeout');
  assert.equal(error.message, '시간초과');
  assert.equal(error.raw, raw);
  assert.equal(error.inputTokens, 17);
  assert.equal(error.outputTokens, 9);
});

test('explicit abort after full JSON keeps cancellation priority even on HTTP errors', async t => {
  const raw = body();
  const reachedEnd = mockTransport(t, raw, { status: 503, ending: 'wait' });
  const controller = new AbortController();
  const pending = failure({ signal: controller.signal });
  await reachedEnd;
  controller.abort();
  const error = await pending;
  assert.equal(error.type, 'timeout');
  assert.equal(error.raw, raw);
  assert.equal(error.inputTokens, 17);
  assert.equal(error.outputTokens, 9);
});

test('only whole parseable raw JSON supplies usage; never recover from fragments or wrappers', async t => {
  const raws = [body().slice(0, -1), `${body()} trailing`, `${body()}\n${body()}`,
    `\`\`\`json\n${body()}\n\`\`\``, '{"prompt_eval_count":17,"eval_count":9,"response":"partial',
    'null', 'false', '[]', '"prompt_eval_count: 17"'];
  for (const [index, raw] of raws.entries()) await t.test(`malformed body ${index}`, async child => {
    mockTransport(child, raw, { ending: 'error' });
    const error = await failure();
    assert.equal(error.type, 'call-failure');
    assert.equal(error.raw, raw);
    assert.equal(error.inputTokens, null);
    assert.equal(error.outputTokens, null);
  });
});

test('missing, malformed and unsafe counts remain null independently; a known zero is not missing', async t => {
  const invalid = [undefined, null, -1, 1.5, '17', '', true, false, [], {}, Number.MAX_SAFE_INTEGER + 1];
  for (const status of [200, 503]) {
    for (const [index, value] of invalid.entries()) await t.test(`${status}: invalid count ${index}`, async child => {
      const raw = body({ prompt_eval_count: value, eval_count: 0 });
      mockTransport(child, raw, { status });
      const result = status === 200 ? await ollamaGenerate(request) : await failure();
      assert.equal(result.raw, raw);
      assert.equal(result.inputTokens, null);
      assert.equal(result.outputTokens, 0);
    });
    await t.test(`${status}: invalid output count`, async child => {
      mockTransport(child, body({ prompt_eval_count: 0, eval_count: -1 }), { status });
      const result = status === 200 ? await ollamaGenerate(request) : await failure();
      assert.equal(result.inputTokens, 0);
      assert.equal(result.outputTokens, null);
    });
    await t.test(`${status}: valid safe integer bounds`, async child => {
      mockTransport(child, body({ prompt_eval_count: 0, eval_count: Number.MAX_SAFE_INTEGER }), { status });
      const result = status === 200 ? await ollamaGenerate(request) : await failure();
      assert.equal(result.inputTokens, 0);
      assert.equal(result.outputTokens, Number.MAX_SAFE_INTEGER);
    });
    await t.test(`${status}: nonfinite JSON number`, async child => {
      mockTransport(child, '{"done":true,"response":"text","prompt_eval_count":1e400,"eval_count":9}', { status });
      const result = status === 200 ? await ollamaGenerate(request) : await failure();
      assert.equal(result.inputTokens, null);
      assert.equal(result.outputTokens, 9);
    });
  }
});

test('provider errors, nonterminal responses and empty answers retain usage without losing failure', async t => {
  for (const extra of [{ error: 'synthetic provider error' }, { done: false }, { response: ' ' }]) {
    await t.test(JSON.stringify(extra), async child => {
      const raw = body(extra);
      mockTransport(child, raw);
      const error = await failure();
      assert.equal(error.type, 'call-failure');
      assert.equal(error.raw, raw);
      assert.equal(error.inputTokens, 17);
      assert.equal(error.outputTokens, 9);
    });
  }
});

async function plan(retries) {
  const { dataset, gold } = await loadPilot();
  return makePlan(dataset, gold, { model: 'synthetic', options: {}, timeoutMs: 5000, retries,
    repeats: 1, seed: 62, warmup: false, runOrder: 'seeded',
    methods: [{ id: 'prompt-baseline', version: 'synthetic' }] });
}

test('exhausted retries retain every known failed cost and raw while the task stays failed', async t => {
  const raw = body();
  mockTransport(t, raw, { status: 503 });
  const run = await runPlan(await plan(1));
  for (const record of run.records) {
    assert.equal(record.state, 'failed');
    assert.equal(record.calls, 2);
    assert.equal(record.rawAnswer, '');
    assert.equal(record.error.partial, raw);
    assert.equal(record.inputTokens, 34);
    assert.equal(record.outputTokens, 18);
    assert.equal(record.attempts.length, 2);
    for (const attempt of record.attempts) {
      assert.equal(attempt.state, 'failed');
      assert.equal(attempt.raw, raw);
      assert.equal(attempt.inputTokens, 17);
      assert.equal(attempt.outputTokens, 9);
    }
  }
});

test('a recovered retry adds failed usage exactly once and uses only the successful answer', async t => {
  const failedRaw = body({ response: '실패 원문은 답변으로 쓰지 않음' });
  const completedRaw = body({ response: '실제 완료 답변', prompt_eval_count: 3, eval_count: 2 });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls % 2 === 1
    ? new Response(failedRaw, { status: 503 }) : new Response(completedRaw));
  const run = await runPlan(await plan(1));
  assert.equal(calls, run.records.length * 2);
  for (const record of run.records) {
    assert.equal(record.state, 'completed');
    assert.equal(record.rawAnswer, '실제 완료 답변');
    assert.equal(record.calls, 2);
    assert.equal(record.inputTokens, 20);
    assert.equal(record.outputTokens, 11);
    assert.equal(record.attempts[0].state, 'failed');
    assert.equal(record.attempts[0].raw, failedRaw);
    assert.equal(record.attempts[1].state, 'completed');
    assert.equal(record.attempts[1].raw, completedRaw);
  }
});

test('ruleAnswer is re-exported unchanged and fixed LF/CRLF inputs retain their original output bytes', async () => {
  const { ruleAnswer: movedRuleAnswer } = await import('../evals/sejong/date-eval/postprocess.mjs');
  assert.equal(ruleAnswer, movedRuleAnswer);
  const { dataset } = await loadPilot();
  // Markdown checkout line endings affect quote bytes and evidence offsets.
  // Control only these synthetic test copies, never normalize actual inputs,
  // answer keys, recorded outputs or hashes to make an experiment pass.
  for (const [eol, expected] of [
    ['\n', 'bcaa4d3bf17961d80dbf75ce858d94ab866b26c45c27fe1a52394a6ad133c936'],
    ['\r\n', '7f5d9c509b4c8b479a9431d2ff1fb072f56def49a97bc6727ef2c70da07093f2'],
  ]) {
    const cases = dataset.cases.map(c => ({ ...c, sourceText: c.sourceText.replace(/\r?\n/g, eol) }));
    assert.equal(hash(cases.map(ruleAnswer)), expected);
  }
});
