import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPilot } from '../evals/sejong/date-eval/pilot.mjs';
import { makePlan, hash } from '../evals/sejong/date-eval/core.mjs';
import { runPlan } from '../evals/sejong/date-eval/runner.mjs';
import { resolveRunState } from '../evals/sejong/date-eval/state.mjs';
import { createReviewPackets, finalizeReviews } from '../evals/sejong/date-eval/grading.mjs';
import { buildReport } from '../evals/sejong/date-eval/report.mjs';

test('length-limited output remains unknown until execution inspection; original preserved; pending blocks final', async () => {
  const { dataset, gold } = await loadPilot();
  const plan = makePlan(dataset, gold, { model: 'fixture', endpoint: 'http://127.0.0.1:11434', options: {}, timeoutMs: 100, retries: 0, repeats: 1, methods: [{ id: 'prompt-baseline', version: 'fixture' }] });
  const run = await runPlan(plan, { generate: async () => ({ answer: '길이 제한에 걸린 부분 답변', finishReason: 'length', inputTokens: 2, outputTokens: 10 }) });
  assert.ok(run.records.every((r) => r.state === 'unknown'));
  const bundle = createReviewPackets(plan, run), final = finalizeReviews(plan, run, bundle, []);
  assert.throws(() => buildReport(plan, run, final), /unknown/);
  const before = hash(run), r = run.records[0];
  const resolved = resolveRunState(plan, run, [{ recordId: r.id, originalRecordHash: hash(r), reviewerId: '담당자', state: 'failed', reason: '답변이 중간에 끊겨 읽을 수 없음', evidence: '원출력과 종료 사유 대조' }]);
  assert.equal(hash(run), before);
  assert.equal(resolved.records[0].state, 'failed');
  assert.equal(resolved.records[0].rawAnswer, r.rawAnswer);
  assert.equal(resolved.records[0].calls, 1);
  assert.equal(resolved.stateResolution.sourceRunHash, before);
  assert.throws(() => resolveRunState(plan, resolved, [{ recordId: r.id, originalRecordHash: hash(resolved.records[0]), reviewerId: '담당자', state: 'completed', reason: '부분 내용은 맞음', evidence: '부분 답변' }]), /부분 답변/);
});
