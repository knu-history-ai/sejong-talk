import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadPilot } from '../evals/sejong/date-eval/pilot.mjs';
import { hash, makePlan, validatePlan } from '../evals/sejong/date-eval/core.mjs';
import { buildAutomaticReport, validateAutomaticReport } from '../evals/sejong/date-eval/automatic.mjs';
import { runPlan } from '../evals/sejong/date-eval/runner.mjs';

const root = new URL('../', import.meta.url);
const docs = await readFile(new URL('docs/date-pilot-v1/model-inputs.md', root), 'utf8');
const questions = await readFile(new URL('evals/sejong/date-questions.json', root), 'utf8');

test('fresh LF, CRLF and lone-CR pilot material has identical datasets, gold and quote spans', async () => {
  const lf = await loadPilot({ docsText: docs.replace(/\r\n?/g, '\n'), questionsText: questions });
  for (const eol of ['\r\n', '\r']) {
    const material = await loadPilot({ docsText: docs.replace(/\r\n?/g, '\n').replaceAll('\n', eol),
      questionsText: questions.replace(/\r\n?/g, '\n').replaceAll('\n', eol) });
    assert.deepEqual(material, lf);
    assert.equal(hash(material.dataset), hash(lf.dataset));
    assert.equal(hash(material.gold), hash(lf.gold));
  }
  assert.deepEqual(await loadPilot(), lf);
  for (const c of lf.dataset.cases) {
    assert.equal(c.sourceText.includes('\r'), false);
    for (const event of lf.gold.cases.find(g => g.id === c.id).events) for (const q of event.evidence) {
      assert.equal(c.sourceText.slice(q.start, q.end), q.quote);
    }
  }
  assert.match(lf.dataset.cases.find(c => c.sourceId === 'S3').sourceText, /평안도 에/);
});

test('stored CRLF plans, raw answers and report bytes stay unchanged while new pilot material uses LF', async t => {
  const material = await loadPilot();
  // Reconstruct a previously frozen CRLF plan, retaining its original offsets.
  for (const c of material.dataset.cases) {
    c.sourceText = c.sourceText.replaceAll('\n', '\r\n');
    for (const e of material.gold.cases.find(g => g.id === c.id).events) for (const q of e.evidence) {
      q.start = c.sourceText.indexOf(q.quote); q.end = q.start + q.quote.length;
    }
  }
  material.gold.datasetHash = hash(material.dataset);
  const plan = makePlan(material.dataset, material.gold, { model: 'synthetic', options: {}, timeoutMs: 1000, retries: 0,
    repeats: 1, warmup: false, methods: [{ id: 'prompt-baseline', version: 'synthetic-line-endings' }] });
  const raw = 'Preserved answer\r\nwith original line endings.\r';
  const run = await runPlan(plan, { generate: async () => ({ answer: raw, inputTokens: 1, outputTokens: 1 }) });
  const report = buildAutomaticReport(plan, run);
  const dir = await mkdtemp(join(tmpdir(), 'date-pilot-line-endings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const snapshots = new Map([['plan.json', JSON.stringify(plan, null, 2).replaceAll('\n', '\r\n')],
    ['raw-answer.txt', raw], ['results.json', JSON.stringify(run, null, 2).replaceAll('\n', '\r\n')],
    ['automatic-report.json', JSON.stringify(report, null, 2).replaceAll('\n', '\r\n')]]);
  for (const [name, bytes] of snapshots) await writeFile(join(dir, name), bytes);
  const storedPlan = JSON.parse(await readFile(join(dir, 'plan.json'), 'utf8'));
  const storedRun = JSON.parse(await readFile(join(dir, 'results.json'), 'utf8'));
  const storedReport = JSON.parse(await readFile(join(dir, 'automatic-report.json'), 'utf8'));
  const fresh = await loadPilot({ docsText: docs.replace(/\r\n?/g, '\n').replaceAll('\n', '\r\n'), questionsText: questions });
  validatePlan(storedPlan); validateAutomaticReport(storedPlan, storedRun, storedReport);
  assert.notEqual(hash(fresh.dataset), storedPlan.datasetHash);
  assert.ok(storedPlan.dataset.cases.every(c => c.sourceText.includes('\r\n')));
  assert.ok(storedRun.records.every(r => r.rawAnswer === raw));
  for (const [name, bytes] of snapshots) assert.deepEqual(await readFile(join(dir, name)), Buffer.from(bytes));
});

test('autocrlf=true attributes pin only fresh pilot/evaluation inputs, not stored results', () => {
  const paths = ['docs/date-pilot-v1/model-inputs.md', 'docs/date-pilot-v1/answer-key.md',
    'evals/sejong/date-questions.json', 'evals/sejong/fixed-questions.json',
    'evals/sejong/date-eval/results/plan.json', 'evals/sejong/date-eval/results/raw-answer.txt',
    'evals/sejong/date-eval/results/automatic-report.json'];
  const lines = execFileSync('git', ['-c', 'core.autocrlf=true', 'check-attr', 'eol', '--', ...paths],
    { cwd: fileURLToPath(root), encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.equal(lines.length, paths.length);
  lines.forEach((line, i) => assert.equal(line, `${paths[i]}: eol: ${i < 4 ? 'lf' : 'unspecified'}`));
});
