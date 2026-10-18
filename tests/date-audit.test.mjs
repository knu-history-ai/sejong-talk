import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPilot } from '../evals/sejong/date-eval/pilot.mjs';
import { makePlan, hash, validateRecordedInputs } from '../evals/sejong/date-eval/core.mjs';
import { runPlan } from '../evals/sejong/date-eval/runner.mjs';
import { resolveRunState } from '../evals/sejong/date-eval/state.mjs';
import { main } from '../evals/sejong/date-eval/cli.mjs';

async function fixture() {
  const { dataset, gold } = await loadPilot();
  const plan = makePlan(dataset, gold, { model: 'fixture', endpoint: 'http://127.0.0.1:11434',
    options: { temperature: 0 }, repeats: 1, retries: 0, timeoutMs: 100,
    methods: [{ id: 'prompt-baseline', version: 'fixture' }] });
  const run = await runPlan(plan, { generate: async () => ({ answer: '진단용 모의 답변', inputTokens: 2, outputTokens: 3 }) });
  return { plan, run };
}

test('mistyped, duplicated and valueless experiment flags fail instead of silently changing the plan', async () => {
  for (const args of [
    ['prepare', '--dir', '/unused', '--model', 'fixture', '--repeat', '5'],
    ['prepare', '--dir', '/unused', '--dir', '/other'],
    ['prepare', '--dir', '/unused', '--repeats'],
    ['prepare', '--dir', '/unused', '--warmup', 'true'],
    ['help', '--unknown'],
  ]) await assert.rejects(main(args), /옵션/);
});

test('actual import rejects model/option mismatches in raw inputs and individual attempts', async () => {
  const { plan, run } = await fixture();
  assert.equal(validateRecordedInputs(plan, run), run);
  for (const location of ['rawInput', 'attempts']) for (const field of ['model', 'options', 'think']) {
    const bad = structuredClone(run);
    const request = location === 'rawInput' ? bad.records[0].rawInput[0] : bad.records[0].attempts[0].request;
    request[field] = field === 'model' ? 'different-model' : field === 'think' ? true : { temperature: 1 };
    const dir = await mkdtemp(join(tmpdir(), 'date-import-audit-')), file = join(dir, 'input.json');
    await writeFile(join(dir, 'plan.json'), JSON.stringify(plan)); await writeFile(file, JSON.stringify(bad));
    await assert.rejects(main(['import-run', '--dir', dir, '--file', file]), field === 'think' ? /thinking/ : /모델·옵션/);
    await assert.rejects(readFile(join(dir, 'run.json')), { code: 'ENOENT' });
  }
});

test('unknown inputs cannot bypass import or become confirmed completed without real requests', async () => {
  const { plan, run } = await fixture();
  run.records[0].state = 'unknown'; delete run.records[0].rawInput;
  const dir = await mkdtemp(join(tmpdir(), 'date-unknown-audit-')), file = join(dir, 'input.json');
  await writeFile(join(dir, 'plan.json'), JSON.stringify(plan)); await writeFile(file, JSON.stringify(run));
  await assert.rejects(main(['import-run', '--dir', dir, '--file', file]), /전체 자료·질문/);
  assert.throws(() => resolveRunState(plan, run, [{ recordId: run.records[0].id,
    originalRecordHash: hash(run.records[0]), reviewerId: '담당자', state: 'completed',
    reason: '모의 확인', evidence: '모의 원문' }]), /전체 자료·질문/);
});

test('empty target and gold event lists cannot create an apparently valid perfect-score question', async () => {
  const { plan } = await fixture();
  const dataset = structuredClone(plan.dataset), gold = structuredClone(plan.gold);
  dataset.cases[0].targets = []; gold.cases[0].events = []; gold.datasetHash = hash(dataset);
  assert.throws(() => makePlan(dataset, gold, plan.config), /대상 사건이 없습니다/);
});
