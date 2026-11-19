import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hash, makePlan } from '../evals/sejong/date-eval/core.mjs';
import { runPlan } from '../evals/sejong/date-eval/runner.mjs';
import { aiGrade } from '../evals/sejong/date-eval/grading.mjs';
import { interruptedAiCost } from '../evals/sejong/date-eval/costs.mjs';
import { validateAiProvenance } from '../evals/sejong/date-eval/ai-provenance.mjs';
import { main } from '../evals/sejong/date-eval/cli.mjs';

// Synthetic in-memory sources/values only; never read final dataset/gold files.
async function fixture({ failAll = false, repeats = 1 } = {}) {
  const cases = ['A', 'B', 'C'].map(id => ({ id, articleId: id, groupId: id, kind: 'event', type: 'synthetic',
    sourceText: `Synthetic ${id}: 2000년 1월 2일.`, question: `${id}의 날짜는?`, targets: [{ id: 'date', label: '사건' }] }));
  const dataset = { version: 'synthetic-provenance', split: 'pilot', cases };
  const gold = { version: 'synthetic-values', criteriaVersion: 'synthetic-provenance', reviewStatus: 'draft', reviewedBy: [],
    datasetHash: hash(dataset), rubric: {}, cases: cases.map(c => ({ id: c.id, events: [{ id: 'date',
      expected: { year: 2000, month: 1, day: 2, calendar: 'lunar' }, required: ['month', 'day'],
      allowedOmissions: ['year', 'calendar'], requiresUnknownDay: false,
      eligibility: { unsupportedDay: false, missingKnownDay: true, headerConfusion: true },
      evidence: [{ quote: c.sourceText, start: 0, end: c.sourceText.length }] }] })) };
  const plan = makePlan(dataset, gold, { model: 'synthetic-generator', options: {}, think: false,
    timeoutMs: 1000, repeats, retries: 0, seed: 62, runOrder: 'seeded', warmup: false,
    methods: [{ id: 'prompt-baseline', version: 'synthetic' }] });
  const run = await runPlan(plan, { environment: { synthetic: true }, generate: () => {
    if (failAll) throw new Error('synthetic generation failure');
    return { answer: JSON.stringify({ events: [{ id: 'date', date: { year: 2000, month: 1, day: 2, calendar: 'lunar' },
      unknownDay: false, evidence: [] }] }), inputTokens: 2, outputTokens: 3 };
  } });
  return { plan, run };
}
function judgment(input) {
  const proof = { answerQuote: { quote: input.rawAnswer, start: 0, end: input.rawAnswer.length },
    sourceQuote: { quote: input.sourceText, start: 0, end: input.sourceText.length },
    observedDate: { year: 2000, month: 1, day: 2, calendar: 'lunar' }, reason: 'Synthetic proof.' };
  return { date: 1, evidence: 1, reason: 'Synthetic judgment.', proofs: { date: proof, evidence: proof },
    events: input.gold.events.map(e => ({ id: e.id, date: 1, unsupportedDay: null, missingKnownDay: 0, headerConfusion: 0,
      reasons: { date: 'Synthetic', missingKnownDay: 'Synthetic', headerConfusion: 'Synthetic' },
      proofs: { date: proof, missingKnownDay: proof, headerConfusion: proof } })) };
}
function response(answer, inputTokens = 3, outputTokens = 2) {
  const raw = JSON.stringify({ done: true, response: answer, prompt_eval_count: inputTokens, eval_count: outputTokens });
  return { answer, raw, inputTokens, outputTokens };
}
async function bundle({ config = {}, transport = input => response(JSON.stringify(judgment(input))), failAll = false, repeats = 1 } = {}) {
  const { plan, run } = await fixture({ failAll, repeats });
  const judgeConfig = { model: 'synthetic-judge', options: { temperature: 0 }, think: false, ...config };
  const start = { schemaVersion: 1, planId: plan.id, criteriaHash: plan.criteriaHash, runHash: hash(run), judgeConfig,
    startedAt: '2026-10-15T00:00:00Z' };
  const entries = [];
  const ai = await aiGrade(plan, run, { judgeConfig, judge: async (input, context) => {
    const request = { model: context.judgeConfig.model, options: context.judgeConfig.options,
      think: context.judgeConfig.think, stage: 'judge', prompt: JSON.stringify(input) };
    const row = { file: `${String(entries.length + 1).padStart(4, '0')}.json`, entry: {
      planId: plan.id, runHash: hash(run), startHash: hash(start), request, state: 'in-flight' } };
    entries.push(row);
    const began = performance.now();
    try {
      const supplied = await transport(input, context);
      await delay(2);
      const result = { ...supplied, elapsedMs: performance.now() - began };
      row.entry = { ...row.entry, state: 'completed', result };
      return result;
    } catch (error) {
      await delay(2);
      error.elapsedMs = performance.now() - began;
      row.entry = { ...row.entry, state: 'failed', error: error.message, raw: error.raw ?? null,
        elapsedMs: error.elapsedMs ?? null, inputTokens: error.inputTokens ?? null, outputTokens: error.outputTokens ?? null };
      throw error;
    }
  } });
  return { plan, run, ai, start, entries };
}
const validate = b => validateAiProvenance(b.plan, b.run, b.ai, b.start, b.entries);

test('joins every artifact attempt to exact durable input/output and normalized start defaults without mutation', async () => {
  const b = await bundle({ repeats: 2 }), before = structuredClone(b), result = validate(b);
  assert.equal(b.start.judgeConfig.cancelGraceMs, undefined); assert.equal(b.ai.judgeConfig.cancelGraceMs, 100);
  assert.equal(b.ai.judgeConfig.timeoutMs, 30000); assert.equal(b.ai.judgeConfig.retries, 0);
  assert.equal(result.evidence.status, 'verified'); assert.equal(result.evidence.durableTransportJoined, true);
  assert.equal(result.evidence.independentExecutionProof, false); assert.equal(result.evidence.judgeModelCalled, true);
  assert.equal(result.evidence.aiHash, hash(b.ai)); assert.equal(result.evidence.startHash, hash(b.start));
  assert.equal(result.evidence.judgeConfigHash, b.ai.judgeConfigHash); assert.equal(result.evidence.promptHash, b.ai.promptHash);
  assert.equal(result.bindings.length, 6); assert.equal(result.evidence.bindingsHash, hash(result.bindings));
  assert.deepEqual(result.cost, b.ai.evaluationCost); assert.equal(result.execution.status, 'completed');
  for (const [i, binding] of result.bindings.entries()) {
    assert.equal(binding.entryHash, hash(b.entries[i].entry)); assert.equal(binding.requestHash, hash(b.entries[i].entry.request));
    assert.equal(binding.recordHash, hash(b.run.records.find(r => r.id === binding.recordId)));
    assert.equal(binding.rawOutputHash, hash(b.ai.items.find(r => r.recordId === binding.recordId).attempts[binding.attempt - 1].rawOutput));
  }
  assert.deepEqual(b, before);
});

test('rehashed never-called judge/config, prompt, input and copied output cannot pass count/token parity', async () => {
  const original = await bundle();
  for (const mutate of [
    b => { b.ai.judgeConfig.model = 'never-called'; b.ai.judgeConfigHash = hash(b.ai.judgeConfig); },
    b => { b.ai.judgeConfig.endpoint = 'http://never-called'; b.ai.judgeConfigHash = hash(b.ai.judgeConfig); },
    b => { b.ai.judgeConfig.options.temperature = 1; b.ai.judgeConfigHash = hash(b.ai.judgeConfig); },
    b => { b.ai.judgeConfig.think = true; b.ai.judgeConfigHash = hash(b.ai.judgeConfig); },
    b => { b.ai.judgeConfig.cancelGraceMs = 1; b.ai.judgeConfigHash = hash(b.ai.judgeConfig); },
    b => { b.ai.prompt += ' changed'; b.ai.promptHash = hash(b.ai.prompt); b.ai.items.forEach(i => { i.rawInput.instructions = b.ai.prompt; }); },
    b => { b.ai.items[0].rawInput.sourceText = 'different'; },
    b => { b.entries[0].entry.request.prompt = b.entries[1].entry.request.prompt; },
    b => { b.entries[0].entry.request.stage = 'answer'; },
    b => { b.entries[0].entry.result = b.entries[1].entry.result; },
    b => { b.ai.items[0].attempts[0].rawOutput += 'changed'; },
    b => { b.ai.items[0].attempts[0].judgmentOutput = '{}'; },
    b => { b.entries[0].entry.result.answer = '{}'; },
    b => { b.entries[0].entry.result.raw = JSON.stringify({ done: false, response: b.entries[0].entry.result.answer }); },
  ]) {
    const bad = structuredClone(original); mutate(bad); assert.throws(() => validate(bad));
  }
});

test('missing/extra/duplicate/stale rows, record IDs and costs are rejected', async () => {
  const original = await bundle();
  for (const mutate of [
    b => { b.start = null; }, b => { b.entries = []; }, b => { b.entries.pop(); },
    b => { b.entries.push({ file: '0004.json', entry: b.entries[0].entry }); },
    b => { b.entries[1].file = b.entries[0].file; }, b => { b.entries.reverse(); },
    b => { b.entries[0].entry.startHash = 'other'; }, b => { b.entries[0].entry.planId = 'other'; },
    b => { b.start.criteriaHash = 'other'; }, b => { b.start.runHash = 'other'; },
    b => { b.ai.items.pop(); }, b => { b.ai.items[0].recordId = 'other'; },
    b => { b.ai.items[1] = b.ai.items[0]; }, b => { b.ai.items[0].recordHash = 'other'; },
    b => { b.ai.items[0].attempts[0].attempt = 2; }, b => { b.ai.items[0].attempts = {}; },
    b => { b.ai.items[0].attempts[0].inputTokens = 9; },
    b => { b.ai.evaluationCost.inputTokens.partialKnownSum++; },
    b => { b.entries[0].entry.result.elapsedMs = -1; },
    b => { b.ai.items[0].attempts[0].elapsedMs = Infinity; },
  ]) { const bad = structuredClone(original); mutate(bad); assert.throws(() => validate(bad)); }
});

test('malformed output retries, but the first interpretable partial judgment cannot be relabelled/discarded', async () => {
  const b = await bundle({ config: { retries: 1 }, transport: (input, context) => response(context.attempt === 1 ? 'invalid JSON' : '{}') });
  assert.equal(validate(b).bindings.length, 6);
  assert.ok(b.ai.items.every(i => i.state === 'partial-failure' && i.attempts.length === 2));
  const firstRecord = b.ai.items.find(i => i.recordId === b.run.records[0].id);
  const forged = { ...response('{}'), elapsedMs: b.entries[0].entry.result.elapsedMs };
  b.entries[0].entry.result = forged;
  firstRecord.attempts[0].rawOutput = forged.raw; firstRecord.attempts[0].judgmentOutput = forged.answer;
  assert.throws(() => validate(b), /first-interpretable/);
  const partial = await bundle({ config: { retries: 2 }, transport: () => response('{}') });
  assert.ok(partial.ai.items.every(i => i.attempts.length === 1)); assert.equal(validate(partial).bindings.length, 3);
});

test('ordinary failed transport and genuine resolved/rejected-after-timeout keep distinct bindings', async () => {
  const failed = await bundle({ transport: () => { throw Object.assign(new Error('HTTP 500'), {
    raw: JSON.stringify({ error: 'HTTP 500', prompt_eval_count: 4 }), inputTokens: 4, outputTokens: null }); } });
  const failedResult = validate(failed);
  assert.ok(failedResult.bindings.every(b => b.transportState === 'failed' && b.gradingState === 'grading-failure' && !b.timedOut));
  for (const resolved of [true, false]) {
    const b = await bundle({ config: { timeoutMs: 5, cancelGraceMs: 100 }, transport: (input, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => setTimeout(() => resolved ? resolve(response(JSON.stringify(judgment(input))))
        : reject(Object.assign(new Error('cooperative abort'), {
          raw: JSON.stringify({ error: 'cooperative abort', prompt_eval_count: 4 }), inputTokens: 4, outputTokens: null })), 2), { once: true });
    }) });
    const result = validate(b);
    assert.ok(result.bindings.every(r => r.timedOut && r.transportState === (resolved ? 'completed' : 'failed')));
    assert.ok(b.ai.items.every(i => i.date === null && i.evidence === null && i.state === 'grading-failure'));
    const bad = structuredClone(b); bad.ai.items[0].attempts[0].transportSettlement = resolved ? 'rejected-after-timeout' : 'resolved-after-timeout';
    assert.throws(() => validate(bad), /timeout\/transport/);
  }
});

test('unsettled completed artifact fails closed while null-artifact interrupted partial costs survive exactly', async () => {
  const b = await bundle({ config: { timeoutMs: 5, cancelGraceMs: 1 }, transport: () => new Promise(() => {}) });
  assert.ok(b.entries.every(row => row.entry.state === 'in-flight'));
  assert.throws(() => validate(b), /terminal call count/);
  const partial = validateAiProvenance(b.plan, b.run, null, b.start, b.entries);
  const expected = interruptedAiCost(b.plan, b.run, b.start, b.entries);
  assert.deepEqual(partial.cost, expected.cost); assert.deepEqual(partial.execution, expected.execution);
  assert.equal(partial.cost.calls, null); assert.equal(partial.cost.inFlightCalls, 3);
  assert.equal(partial.evidence.status, 'interrupted'); assert.equal(partial.evidence.durableTransportJoined, false);
  assert.equal(validateAiProvenance(b.plan, b.run, null).execution.status, 'not-started');
});

test('all generation failures legitimately have zero AI attempts and no model-call claim', async () => {
  const b = await bundle({ failAll: true }), result = validate(b);
  assert.equal(b.ai.evaluationCost.calls, 0); assert.equal(result.bindings.length, 0);
  assert.equal(result.evidence.judgedRecords, 0); assert.equal(result.evidence.judgeModelCalled, false);
  assert.equal(result.evidence.status, 'verified'); assert.equal(result.cost.inputTokens.sum, 0);
});

test('actual CLI ai + automatic-report joins Ollama HTTP raw success, malformed retry, and transport-failure retry', async t => {
  const { plan, run } = await fixture(), dir = await mkdtemp(join(tmpdir(), 'date-ai-provenance-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'plan.json'), JSON.stringify(plan)); await writeFile(join(dir, 'run.json'), JSON.stringify(run));
  let calls = 0;
  const server = createServer((req, res) => {
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'synthetic-judge:latest', digest: 'synthetic-digest', details: {} }] }));
    let raw = ''; req.on('data', data => { raw += data; });
    req.on('end', () => {
      const request = JSON.parse(raw); calls++;
      assert.equal(request.model, 'synthetic-judge'); assert.equal(request.think, false);
      if (calls === 3) { res.writeHead(500); return res.end('synthetic HTTP failure'); }
      const input = JSON.parse(request.prompt);
      const answer = calls === 1 ? 'malformed judge JSON' : calls === 5 ? '{}' : JSON.stringify(judgment(input));
      res.end(JSON.stringify({ done: true, response: answer, prompt_eval_count: 3, eval_count: 2 }));
    });
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await main(['ai', '--dir', dir, '--model', 'synthetic-judge', '--endpoint', endpoint, '--timeout', '1000', '--retries', '1']);
  const read = async file => JSON.parse(await readFile(join(dir, file), 'utf8'));
  const ai = await read('ai.json'), start = await read('ai-start.json');
  const files = (await readdir(join(dir, 'ai-calls'))).sort();
  const entries = await Promise.all(files.map(async file => ({ file, entry: await read(`ai-calls/${file}`) })));
  const joined = validateAiProvenance(plan, run, ai, start, entries);
  assert.equal(calls, 5); assert.equal(joined.bindings.length, 5);
  assert.equal(ai.items[0].attempts[0].state, 'grading-failure');
  assert.equal(ai.items[0].attempts[1].state, 'preliminary');
  assert.equal(entries[2].entry.state, 'failed'); assert.equal(ai.items[1].attempts.length, 2);
  assert.equal(ai.items[2].state, 'partial-failure'); assert.equal(ai.items[2].attempts.length, 1);
  assert.equal(start.judgeConfig.cancelGraceMs, undefined); assert.equal(ai.judgeConfig.cancelGraceMs, 100);
  await main(['automatic-report', '--dir', dir]);
  const costs = await read('automatic-evaluation-cost.json');
  assert.equal(costs.aiProvenance.status, 'verified'); assert.equal(costs.aiProvenance.aiHash, hash(ai));
  assert.equal(costs.aiProvenance.bindingsHash, joined.evidence.bindingsHash);
  // A same-count/token copied artifact with a rehashed never-called model is denied
  // by provenance, before publication. Use a fresh analysis folder so an existing
  // report's no-clobber check cannot mask the provenance mismatch being tested.
  const badDir = await mkdtemp(join(tmpdir(), 'date-ai-provenance-forged-'));
  t.after(() => rm(badDir, { recursive: true, force: true }));
  await mkdir(join(badDir, 'ai-calls'));
  const originalFiles = ['plan.json', 'run.json', 'ai-start.json', 'ai.json', ...files.map(file => `ai-calls/${file}`)];
  const originals = await Promise.all(originalFiles.map(file => readFile(join(dir, file), 'utf8')));
  for (const [i, file] of originalFiles.entries()) await writeFile(join(badDir, file), originals[i]);
  const forged = structuredClone(ai);
  forged.judgeConfig.model = 'never-called'; forged.judgeConfigHash = hash(forged.judgeConfig);
  await writeFile(join(badDir, 'ai.json'), JSON.stringify(forged));
  await assert.rejects(main(['automatic-report', '--dir', badDir]), /judge config mismatch/);
  assert.equal(calls, 5);
  assert.deepEqual(await Promise.all(originalFiles.map(file => readFile(join(dir, file), 'utf8'))), originals);
  assert.deepEqual((await readdir(badDir)).sort(), ['ai-calls', 'ai-start.json', 'ai.json', 'plan.json', 'run.json']);
});
