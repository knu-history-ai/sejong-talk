import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, assert, makePlan, validatePlan, validateRun, validateRecordedInputs, executionPlan, validateExecutionPlan, validateExecutionRun } from './core.mjs';
import { DERIVED_METHODS } from './postprocess.mjs';
import { runPlan, ollamaGenerate, localEndpoint, METHOD_VERSION, modelIdentity } from './runner.mjs';
import { codeGrade, aiGrade, createReviewPackets, finalizeReviews, validateJudge, validateFinalAudit } from './grading.mjs';
import { buildReport, compareReports } from './report.mjs';
import { resolveRunState } from './state.mjs';
import { bindCost, interruptedAiCost, humanCost } from './costs.mjs';

const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
async function save(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
async function prepareOperatorBundle(dir) {
  const modules = ['core.mjs', 'runner.mjs', 'postprocess.mjs', 'grading.mjs', 'report.mjs', 'state.mjs', 'costs.mjs', 'cli.mjs'];
  await mkdir(join(dir, 'execution-code'), { recursive: true });
  for (const name of modules) {
    await writeFile(join(dir, 'execution-code', name), await readFile(new URL(name, import.meta.url)), { flag: 'wx' });
  }
  // The entry point locates the transferred folder from its own URL, never a sender's path.
  const launcher = `import { fileURLToPath } from 'node:url';
import { main } from './execution-code/cli.mjs';
if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error('Node.js 24가 필요합니다. 설치·설정 담당자에게 오류를 전달하세요.');
  process.exitCode = 1;
} else if (process.argv.length !== 2) {
  console.error('추가 설정 없이 안내된 명령만 실행하세요.');
  process.exitCode = 1;
} else {
  main(['run', '--dir', fileURLToPath(new URL('.', import.meta.url))]).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
`;
  await writeFile(join(dir, 'run-evaluation.mjs'), launcher, { flag: 'wx' });
  await writeFile(join(dir, '실행안내.md'), `# 유진님 실행 안내

Node.js 24와 담당자가 지정한 Ollama 모델은 미리 준비되어 있어야 합니다.
이 폴더에서 터미널을 열고 아래 명령을 그대로 실행하세요. 폴더 이름이나 위치가 바뀌어도 명령은 같습니다.

\x60\x60\x60sh
node "./run-evaluation.mjs"
\x60\x60\x60

이 명령은 답변 생성·원문/환경/오류 기록만 수행합니다. 내용 채점은 하지 않습니다.
완료 후 이 폴더 전체를 담당자에게 전달하세요. 기록을 수정하거나 삭제하지 마세요.
오류가 나거나 실행이 중단되면 같은 폴더와 터미널 오류를 그대로 전달하세요. 미확인 호출을 임의로 재실행하지 마세요.
설치·설정·상태 확인·채점·집계는 담당자가 진행합니다.
`, { flag: 'wx' });
}
async function checkpoint(path, value) {
  const temporary = path + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, path);
}
async function maybe(path) {
  try { return await read(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function implementationHash() {
  return hash(await Promise.all(['core.mjs', 'runner.mjs', 'postprocess.mjs', 'grading.mjs', 'report.mjs', 'state.mjs', 'costs.mjs', 'cli.mjs'].map(async (name) => [name, await readFile(new URL(name, import.meta.url), 'utf8')])));
}
function parse(args) {
  const [command, ...rest] = args, flags = {};
  const accepted = {
    help: [], prepare: ['dir', 'model', 'model-identity', 'methods', 'dataset', 'gold', 'options', 'endpoint', 'timeout', 'retries', 'repeats', 'seed', 'warmup'],
    run: ['dir'], 'export-operator': ['dir', 'out'], 'import-run': ['dir', 'file'], code: ['dir', 'run'],
    ai: ['dir', 'run', 'model', 'endpoint', 'timeout', 'retries'], packets: ['dir', 'run'],
    'import-review': ['dir', 'run', 'file', 'reviewer'], finalize: ['dir', 'run', 'adjudications', 'out'],
    report: ['dir', 'run', 'final'], 'resolve-state': ['dir', 'run', 'file', 'out'],
    'validate-judge': ['dir', 'run', 'groups', 'final'], compare: ['before', 'after', 'out'],
  };
  assert(!command || Object.hasOwn(accepted, command), `알 수 없는 명령: ${command}`);
  for (let i = 0; i < rest.length; i++) {
    assert(rest[i].startsWith('--'), `알 수 없는 인수: ${rest[i]}`);
    const name = rest[i].slice(2);
    assert(accepted[command].includes(name) && !Object.hasOwn(flags, name), `알 수 없거나 중복된 옵션: --${name}`);
    const value = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i];
    assert(name === 'warmup' ? value === true : typeof value === 'string', `--${name} 옵션 값 오류`);
    flags[name] = value;
  }
  return { command, flags };
}
function requireFlag(flags, name) {
  assert(typeof flags[name] === 'string', `--${name} 값을 지정하세요`);
  return flags[name];
}
function blankJudgment(packet, reviewerId = '') {
  return { packetId: packet.id, packetHash: packet.hash, reviewerId, independent: false, blind: false,
    date: null, evidence: null, reason: '', elapsedMs: null, events: packet.input.gold.events.map((e) => ({
      id: e.id, date: null, unsupportedDay: null, missingKnownDay: null, headerConfusion: null,
      eligibility: e.eligibility, reasons: { date: '', unsupportedDay: '', missingKnownDay: '', headerConfusion: '' },
    })) };
}
async function reviewFiles(dir) {
  let names;
  try { names = await readdir(dir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = names.filter((f) => f.endsWith('.json'));
  return (await Promise.all(files.map((f) => read(join(dir, f))))).flat();
}
export async function main(args = process.argv.slice(2)) {
  const { command, flags } = parse(args);
  if (!command || command === 'help') {
    console.log('날짜 평가: prepare --dir 경로 --model 모델 | run --dir 경로 | packets --dir 경로 | code --dir 경로 | ai --dir 경로 --model 채점모델 | import-review --dir 경로 --file 판정.json --reviewer 이름 | finalize --dir 경로 [--adjudications 합의.json] | report --dir 경로 | validate-judge --dir 경로 --groups 구분.json | compare --before 결과.json --after 결과.json --out 비교.json');
    return;
  }
  if (command === 'compare') {
    await save(requireFlag(flags, 'out'), compareReports(await read(requireFlag(flags, 'before')), await read(requireFlag(flags, 'after'))));
    return;
  }
  const dir = resolve(requireFlag(flags, 'dir'));
  await mkdir(dir, { recursive: true });
  if (command === 'prepare') {
    assert(!(await maybe(join(dir, 'plan.json'))), '이미 준비된 계획은 덮어쓰지 않습니다. 새 폴더를 쓰세요');
    const { loadPilot } = await import('./pilot.mjs');
    const pilot = flags.dataset ? null : await loadPilot();
    const dataset = flags.dataset ? await read(flags.dataset) : pilot.dataset;
    const gold = flags.gold ? await read(flags.gold) : pilot.gold;
    assert(Boolean(flags.dataset) === Boolean(flags.gold), '자료와 정답표는 함께 지정하세요');
    assert(dataset.split !== 'final' || gold.reviewStatus === 'approved', '본실험은 원문·정답표 검수 승인 후 준비하세요');
    const methods = (typeof flags.methods === 'string' ? flags.methods : 'prompt-baseline,rule-baseline,evidence-first').split(',');
    assert(methods.every((id) => ['prompt-baseline','rule-baseline','evidence-first', ...DERIVED_METHODS].includes(id)), '방법 ID 오류');
    assert(!methods.some(id => DERIVED_METHODS.includes(id)) || methods.includes('prompt-baseline'), 'T·V는 같은 계획의 P가 필요합니다');
    const config = {
      model: requireFlag(flags, 'model'), endpoint: localEndpoint(flags.endpoint), think: false,
      options: flags.options ? await read(flags.options) : { temperature: 0, seed: 62, num_ctx: 8192, num_predict: 1024 },
      timeoutMs: Number(flags.timeout ?? 120000), retries: Number(flags.retries ?? 0),
      repeats: Number(flags.repeats ?? 1), seed: Number(flags.seed ?? 62), runOrder: 'seeded',
      warmup: flags.warmup === true,
      methods: methods.map((id) => ({ id, version: METHOD_VERSION, codeHash: null })),
    };
    const codeHash = await implementationHash();
    config.modelIdentity = methods.some((m) => m !== 'rule-baseline')
      ? flags['model-identity'] ? await read(flags['model-identity']) : await modelIdentity(config.model, config.endpoint) : null;
    if (config.modelIdentity) {
      assert(config.modelIdentity.name === config.model || config.modelIdentity.name === config.model + ':latest', '준비용 모델 이름이 지정 모델과 다릅니다');
      assert(typeof config.modelIdentity.digest === 'string' && config.modelIdentity.digest.trim(), '모델 파일 식별 정보가 없습니다');
    }
    config.methods.forEach((m) => { m.codeHash = codeHash; });
    const plan = makePlan(dataset, gold, config);
    await save(join(dir, 'plan.json'), plan);
    await prepareOperatorBundle(dir);
    await save(join(dir, 'operator.json'), {
      planId: plan.id, slots: plan.slots.length, model: config.model, dataset: dataset.version,
      split: dataset.split, goldReviewStatus: gold.reviewStatus,
      role: '유진: run 명령 실행·원문/환경/오류 기록·앱 동작 확인만. 자료·정답·채점 칸을 편집하지 않음.',
      generationOnly: true, next: 'node "./run-evaluation.mjs"',
      workingDirectory: '전달받은 이 평가 폴더에서 터미널을 여세요. 위치·이름이 바뀌어도 명령은 같습니다.',
      handoff: '완료·오류·중단 모두 이 폴더 전체와 터미널 오류를 담당자에게 전달. 채점·기록 수정·설정 변경은 하지 않음.',
    });
    console.log(`계획 고정: ${plan.slots.length}회 / ${dataset.split} / 정답 검토 ${gold.reviewStatus}. 유진님은 run만 실행하세요.`);
    return;
  }
  const plan = (command === 'run' ? validateExecutionPlan : validatePlan)(await read(join(dir, 'plan.json')));
  if (command === 'export-operator') {
    assert(plan.dataset.split !== 'final' || plan.gold.reviewStatus === 'approved', '검수 전 본실험 자료는 전달할 수 없습니다');
    const out = resolve(requireFlag(flags, 'out'));
    assert(out !== dir, '담당자 폴더와 실행 폴더는 분리하세요');
    assert(plan.config.methods.every(m => m.codeHash === plan.config.methods[0].codeHash)
      && plan.config.methods[0].codeHash === await implementationHash(), '준비 후 코드가 바뀌었습니다. 새 계획으로 실행 폴더를 준비하세요');
    let existing = [];
    try { existing = await readdir(out); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(existing.length === 0, '실행 폴더는 새 폴더 또는 빈 폴더여야 합니다. 기존 정답·결과와 섞지 않습니다');
    await save(join(out, 'plan.json'), executionPlan(plan));
    await prepareOperatorBundle(out);
    await save(join(out, 'operator.json'), { planId: plan.id, slots: plan.slots.length, generationOnly: true,
      next: 'node "./run-evaluation.mjs"', model: plan.config.model, split: plan.dataset.split,
      role: '유진: 실행·원문/환경/오류 기록·폴더 전달만. 검수·채점·설정 변경 없음.',
      answerKeyIncluded: false, privatePlanRequiredForGrading: true });
    console.log('정답표를 제외한 실행 전용 폴더를 만들었습니다. 담당자용 원본 계획은 보관하세요.');
    return;
  }
  if (command === 'import-run') {
    const run = validateRun(plan, await read(requireFlag(flags, 'file')));
    validateRecordedInputs(plan, run);
    await save(join(dir, 'run.json'), run);
    console.log('기존 원문 기록을 재사용합니다. 모델을 다시 실행하지 않았습니다.');
    return;
  }
  if (command === 'run') {
    const current = await maybe(join(dir, 'run.json'));
    assert(!current, '완료된 실행은 덮어쓰지 않습니다. 비교 실행은 새 폴더를 쓰세요');
    assert(plan.config.methods.every((m) => m.codeHash) && plan.config.methods.every((m) => m.codeHash === plan.config.methods[0].codeHash), '방법 코드 버전 누락/불일치');
    assert(await implementationHash() === plan.config.methods[0].codeHash, '실행 코드가 준비 후 바뀌었습니다. 새 계획을 준비하세요');
    if (plan.config.methods.some((m) => m.id !== 'rule-baseline')) {
      assert(hash(await modelIdentity(plan.config.model, plan.config.endpoint)) === hash(plan.config.modelIdentity), '모델 파일/양자화 정보가 준비 후 바뀌었습니다');
    }
    const progressPath = join(dir, 'progress.json');
    const progress = await maybe(progressPath);
    assert(!progress || progress.planId === plan.id, '다른 계획의 진행 기록');
    assert(!progress?.inFlight, '실행 중 끊긴 호출이 있습니다. 같은 자리를 자동 재실행하지 않습니다. 담당자가 실제 상태·비용을 확인한 뒤 새 계획 또는 기록을 확정하세요');
    const records = progress?.records ?? [];
    let files = [];
    try { files = await readdir(join(dir, 'generation-calls')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const callIds = files.filter(f => /^\d+\.json$/.test(f)).map(f => Number(f.slice(0, -5)));
    assert(!callIds.length || progress, '기존 호출 기록은 있지만 진행 기록이 없습니다. 확인 전 재실행하지 않습니다');
    const previousWarmup = [];
    for (const id of callIds.sort((a, b) => a - b)) {
      const entry = await read(join(dir, 'generation-calls', String(id).padStart(4, '0') + '.json'));
      assert(entry.planId === plan.id, '다른 계획의 호출 기록');
      if (entry.context?.stage === 'warmup') {
        assert(entry.state === 'completed' && entry.result, '이전 준비 호출 상태 확인이 필요합니다');
        previousWarmup.push({ request: entry.request, result: entry.result });
      }
    }
    // The CLI owns the durable, sequential call ledger. A nonempty array from
    // an arbitrary API caller alone is not evidence that earlier calls exist.
    const warmupHistoryComplete = progress?.warmupHistoryComplete
      ?? (!plan.config.warmup || records.length === 0
        || (previousWarmup.length > 0 && callIds.every((id, index) => id === index + 1)));
    assert(typeof warmupHistoryComplete === 'boolean', '준비 호출 이력 상태 오류');
    let callId = Math.max(0, ...callIds);
    let active = null;
    async function persist(write) {
      try { return await write(); } catch (error) {
        error.auditStorageFailure = true;
        error.message = '호출 기록 저장 실패. 자동 재시도를 중단합니다: ' + error.message;
        throw error;
      }
    }
    const generate = async (request, config, context) => {
      const id = ++callId;
      const file = join('generation-calls', String(id).padStart(4, '0') + '.json');
      const path = join(dir, file);
      const entry = { schemaVersion: 1, planId: plan.id, callId: id, context, request,
        startedAt: new Date().toISOString(), state: 'in-flight' };
      await persist(() => save(path, entry));
      await persist(() => checkpoint(progressPath, { planId: plan.id, records, warmupHistoryComplete,
        inFlight: { request, callFile: file, context, startedAt: entry.startedAt } }));
      active = request;
      let result;
      try { result = await ollamaGenerate(request, config); }
      catch (error) {
        await persist(() => checkpoint(path, { ...entry, state: 'failed', endedAt: new Date().toISOString(),
          error: error.message, type: error.type ?? 'call-failure', raw: error.raw ?? null,
          inputTokens: error.inputTokens ?? null, outputTokens: error.outputTokens ?? null,
          elapsedMs: error.elapsedMs ?? null }));
        throw error;
      }
      await persist(() => checkpoint(path, { ...entry, state: 'completed', endedAt: new Date().toISOString(), result }));
      return result;
    };
    const result = await runPlan(plan, { existingRecords: records, existingWarmup: previousWarmup,
      existingWarmupHistoryComplete: warmupHistoryComplete, generate,
      onRecord: async (record) => {
        records.push(record); active = null;
        await checkpoint(progressPath, { planId: plan.id, records, warmupHistoryComplete, inFlight: null });
        console.log(`${records.length}/${plan.slots.length}: ${record.caseId} ${record.methodId} ${record.state}`);
      } });
    assert(!active, '확인되지 않은 실행 상태');
    validateExecutionRun(plan, result);
    await save(join(dir, 'run.json'), result);
    console.log('실행·원문 기록 완료. 채점은 담당자가 진행합니다. 진행 기록은 삭제하지 마세요.');
    return;
  }
  const run = validateRun(plan, await read(flags.run ?? join(dir, 'run.json')));
  if (command === 'resolve-state') {
    await save(requireFlag(flags, 'out'), resolveRunState(plan, run, await read(requireFlag(flags, 'file'))));
    console.log('원본을 보존하고 실행 상태 확인본을 저장했습니다. 이후 채점에 --run 확인본을 지정하세요.');
    return;
  }
  if (command === 'code') await save(join(dir, 'code.json'), codeGrade(plan, run));
  else if (command === 'ai') {
    assert(!(await maybe(join(dir, 'ai.json'))), 'AI 원본이 이미 있습니다. 다시 호출하지 않습니다. 새 채점 버전은 별도 실행 폴더를 준비하세요');
    assert(!(await maybe(join(dir, 'ai-start.json'))), 'AI 실행을 시작한 기록이 있습니다. 중단된 호출·비용을 확인한 뒤 새 채점 폴더를 준비하세요');
    const model = requireFlag(flags, 'model');
    const judgeConfig = { model, endpoint: localEndpoint(flags.endpoint), think: false, options: { temperature: 0, seed: 62, num_ctx: 16384, num_predict: 4096 }, timeoutMs: Number(flags.timeout ?? 120000), retries: Number(flags.retries ?? 0), codeHash: hash(await readFile(new URL('grading.mjs', import.meta.url), 'utf8')) };
    assert(Number.isFinite(judgeConfig.timeoutMs) && judgeConfig.timeoutMs > 0 && judgeConfig.timeoutMs <= 2147483647, 'invalid judge timeoutMs');
    assert(Number.isInteger(judgeConfig.retries) && judgeConfig.retries >= 0 && judgeConfig.retries <= 5, 'invalid judge retries');
    judgeConfig.modelIdentity = await modelIdentity(model, judgeConfig.endpoint);
    const start = { schemaVersion: 1, planId: plan.id, criteriaHash: plan.criteriaHash,
      runHash: hash(run), judgeConfig, startedAt: new Date().toISOString() };
    await save(join(dir, 'ai-start.json'), start);
    async function persistAi(write) {
      try { return await write(); } catch (error) { error.auditStorageFailure = true; throw error; }
    }
    let call = 0;
    const ai = await aiGrade(plan, run, { judgeConfig, judge: async (input, { judgeConfig, signal }) => {
      const id = ++call, path = join(dir, 'ai-calls', String(id).padStart(4, '0') + '.json');
      const request = { model: judgeConfig.model, options: judgeConfig.options, think: judgeConfig.think, stage: 'judge', prompt: JSON.stringify(input) };
      const entry = { planId: plan.id, runHash: hash(run), startHash: hash(start),
        request, startedAt: new Date().toISOString(), state: 'in-flight' };
      await persistAi(() => save(path, entry));
      let result;
      try {
        result = await ollamaGenerate(request, { ...judgeConfig, signal });
      } catch (error) {
        await persistAi(() => checkpoint(path, { ...entry, state: 'failed', error: error.message, raw: error.raw ?? null,
          elapsedMs: error.elapsedMs ?? null, inputTokens: error.inputTokens ?? null, outputTokens: error.outputTokens ?? null }));
        throw error;
      }
      await persistAi(() => checkpoint(path, { ...entry, state: 'completed', result }));
      return result;
    } });
    await save(join(dir, 'ai.json'), ai);
    console.log('AI 예비 판정 저장. 최종 점수가 아닙니다. 사람 검토자에게 이 파일을 보여주지 마세요.');
  } else if (command === 'packets') {
    const bundle = createReviewPackets(plan, run);
    await save(join(dir, 'review-private.json'), bundle);
    await save(join(dir, 'review-share', 'packets.json'), bundle.packets);
    await save(join(dir, 'review-share', 'blank-review.json'), bundle.packets.map((p) => blankJudgment(p)));
    console.log(bundle.packets.length
      ? '검토자 두 명에게 review-share 폴더만 각각 전달하세요. 독립 판정 전 계획·AI 판정·다른 사람 판정은 공유하지 마세요.'
      : '사람 내용 채점 대상이 없습니다. 담당자가 finalize와 report를 진행하세요. 확정된 실행 실패만 자동 0점이며, 미확인 실행은 집계 전에 확인해야 합니다.');
  } else if (command === 'import-review') {
    const reviewer = requireFlag(flags, 'reviewer');
    assert(/^[a-zA-Z0-9가-힣_-]+$/.test(reviewer), '검토자 ID는 한글/영문/숫자/_/-만 허용');
    const reviews = await read(requireFlag(flags, 'file'));
    assert(Array.isArray(reviews) && reviews.length > 0 && reviews.every((r) => r.reviewerId === reviewer), '검토자 ID 불일치');
    const bundle = await read(join(dir, 'review-private.json'));
    const prior = await reviewFiles(join(dir, 'reviews'));
    const submitted = new Set(prior.filter(r => r.reviewerId === reviewer).map(r => r.packetId));
    assert(reviews.every(r => !submitted.has(r.packetId)), '이미 제출한 첫 판정은 덮어쓸 수 없습니다. 미제출 항목만 보내고 이견은 별도 합의 파일에 기록하세요');
    finalizeReviews(plan, run, bundle, [...prior, ...reviews]);
    // Keep every submission immutable, including legacy reviewer.json files.
    await save(join(dir, 'reviews', reviewer + '--' + hash(reviews) + '.json'), reviews);
    console.log('독립 첫 판정 원본 저장. 덮어쓰기 금지.');
  } else if (command === 'finalize') {
    const bundle = await read(join(dir, 'review-private.json'));
    const reviews = await reviewFiles(join(dir, 'reviews'));
    const adjudications = flags.adjudications ? await read(flags.adjudications) : [];
    const final = finalizeReviews(plan, run, bundle, reviews, adjudications);
    const output = flags.out ? resolve(flags.out) : join(dir, 'final.json');
    await save(output, final);
    console.log(`최종 미확정 ${final.items.filter((i) => i.state === 'pending').length}개. 합의 전 일치율도 기록했습니다.`);
  } else if (command === 'report') {
    validateRecordedInputs(plan, run);
    const final = await read(flags.final ?? join(dir, 'final.json'));
    validateFinalAudit(plan, run, final);
    const report = buildReport(plan, run, final);
    const costs = {};
    for (const kind of ['code', 'ai']) {
      const artifact = await maybe(join(dir, kind + '.json'));
      if (artifact !== null) bindCost(plan, run, artifact, kind);
      costs[kind] = artifact;
    }
    const start = await maybe(join(dir, 'ai-start.json'));
    let callFiles = [];
    try { callFiles = (await readdir(join(dir, 'ai-calls'))).filter(file => /^\d+\.json$/.test(file))
      .sort((left, right) => Number(left.slice(0, -5)) - Number(right.slice(0, -5))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(!callFiles.length || start, 'AI 호출 기록은 있지만 시작 기록이 없습니다. 담당자가 출처를 확인하세요');
    let partial = null;
    if (start) {
      partial = interruptedAiCost(plan, run, start,
        await Promise.all(callFiles.map(async file => ({ file, entry: await read(join(dir, 'ai-calls', file)) }))));
      if (costs.ai) assert(partial.cost.inFlightCalls === 0 && partial.cost.recordedAttempts === costs.ai.evaluationCost.calls,
        '완료 AI 비용과 호출 기록 수/상태 불일치');
      if (costs.ai) for (const field of ['inputTokens', 'outputTokens']) {
        assert(hash(partial.cost[field]) === hash(costs.ai.evaluationCost[field]), '완료 AI 토큰 비용과 호출 기록 불일치');
      }
    }
    const humanEntries = final.agreement.details.flatMap((d) => [...d.firstReviews, ...(d.adjudication ? [d.adjudication] : [])]);
    const human = humanCost(humanEntries);
    // Validate all cost provenance before creating any report output.
    await save(join(dir, 'report.json'), report);
    await save(join(dir, 'comparison.json'), compareReports(report, report));
    await save(join(dir, 'evaluation-cost.json'), {
      schemaVersion: 1, planId: plan.id, criteriaHash: plan.criteriaHash, runHash: hash(run),
      generationIncluded: false, code: costs.code?.elapsedMs ?? null,
      ai: costs.ai?.evaluationCost ?? partial?.cost ?? null,
      aiExecution: costs.ai ? { status: 'completed', interrupted: false,
        startHash: partial?.execution.startHash ?? null, ledgerHashes: partial?.execution.ledgerHashes ?? {} }
        : partial?.execution ?? { status: 'not-started', interrupted: false },
      artifacts: Object.fromEntries(['code', 'ai'].map(kind => [kind, costs[kind] ? hash(costs[kind]) : null])),
      human,
    });
    console.log('결과와 방법별 쌍 비교 저장. 예비시험은 논문 최종 결과가 아닙니다.');
  } else if (command === 'validate-judge') {
    const groups = await read(requireFlag(flags, 'groups'));
    await save(join(dir, 'judge-validation.json'), validateJudge(plan, run,
      await read(join(dir, 'ai.json')), await read(flags.final ?? join(dir, 'final.json')), groups));
    console.log('AI–사람 항목별 비교 저장. 채점기의 실험적 적합성 판단은 담당자가 합니다.');
  } else throw new Error(`알 수 없는 명령: ${command}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
