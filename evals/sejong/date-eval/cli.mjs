import { readFile, writeFile, mkdir, readdir, rename, realpath, link, unlink, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, assert, makePlan, validatePlan, validateRun, validateRecordedInputs, validateGenerationProgress, validateEnvironmentHistory, executionPlan, validateExecutionPlan, validateExecutionRun } from './core.mjs';
import { DERIVED_METHODS, POSTPROCESS_VERSION } from './postprocess.mjs';
import { runPlan, ollamaGenerate, localEndpoint, METHOD_VERSION, modelIdentity, sameModelIdentity, executionEnvironment } from './runner.mjs';
import { codeGrade, aiGrade, createReviewPackets, finalizeReviews, validateJudge, validateFinalAudit } from './grading.mjs';
import { buildReport, compareReports } from './report.mjs';
import { resolveRunState } from './state.mjs';
import { bindCost, interruptedAiCost, humanCost } from './costs.mjs';

const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
async function saveText(path, text) {
  await mkdir(resolve(path, '..'), { recursive: true });
  try {
    await lstat(path);
    throw Object.assign(new Error('기존 파일은 덮어쓰지 않습니다: ' + path), { code: 'EEXIST' });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Publish only a fully written/flushed file. link is atomic and, unlike
  // rename, cannot replace an existing result (including a concurrent writer).
  // An interrupted write remains a separate, immutable diagnostic artifact.
  const temporary = path + '.pending-' + randomUUID();
  await writeFile(temporary, text, { flag: 'wx', flush: true });
  await link(temporary, path);
  // Publication has succeeded. A leftover extra link is harmless evidence,
  // not a failed model call and must not trigger a replay or retry.
  await unlink(temporary).catch(() => {});
}
async function save(path, value) {
  await saveText(path, JSON.stringify(value, null, 2) + '\n');
}
async function canonicalDestination(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await canonicalDestination(dirname(path)), basename(path));
  }
}
async function prepareOperatorBundle(dir) {
  const modules = ['core.mjs', 'runner.mjs', 'postprocess.mjs', 'grading.mjs', 'report.mjs', 'state.mjs', 'costs.mjs', 'cli.mjs'];
  await mkdir(join(dir, 'execution-code'), { recursive: true });
  for (const name of modules) {
    await saveText(join(dir, 'execution-code', name), await readFile(new URL(name, import.meta.url)));
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
  await saveText(join(dir, 'run-evaluation.mjs'), launcher);
  await saveText(join(dir, '실행안내.md'), `# 유진님 실행 안내

Node.js 24와 담당자가 지정한 Ollama 모델은 미리 준비되어 있어야 합니다.
이 폴더에서 터미널을 열고 아래 명령을 그대로 실행하세요. 폴더 이름이나 위치가 바뀌어도 명령은 같습니다.

\x60\x60\x60sh
node "./run-evaluation.mjs"
\x60\x60\x60

이 명령은 답변 생성·원문/환경/오류 기록만 수행합니다. 내용 채점은 하지 않습니다.
완료 후 이 폴더 전체를 담당자에게 전달하세요. 기록을 수정하거나 삭제하지 마세요.
오류가 나거나 실행이 중단되면 같은 폴더와 터미널 오류를 그대로 전달하세요. 미확인 호출을 임의로 재실행하지 마세요.
설치·설정·상태 확인·채점·집계는 담당자가 진행합니다.
`);
}
async function checkpoint(path, value) {
  const temporary = path + '.tmp';
  // Never overwrite an earlier interrupted checkpoint before inspection.
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', flush: true });
  await rename(temporary, path);
}
async function maybe(path) {
  try { return await read(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function saveMatching(path, value) {
  const existing = await maybe(path);
  if (existing !== null) {
    assert(hash(existing) === hash(value), '기존 산출물이 현재 원본과 다릅니다. 덮어쓰지 않고 확인을 중단합니다: ' + path);
    return;
  }
  await save(path, value);
}
async function saveReportGroup(entries) {
  const existing = await Promise.all(entries.map(async ([path]) => maybe(path)));
  // Validate the whole surviving group before filling any missing output.
  for (const [i, [path, value]] of entries.entries()) if (existing[i] !== null) {
    assert(hash(existing[i]) === hash(value), '기존 보고서가 현재 원본과 다릅니다. 새 분석 폴더를 사용하세요: ' + path);
  }
  if (existing.every(value => value !== null)) throw Object.assign(new Error('이미 완료된 보고서는 덮어쓰지 않습니다'), { code: 'EEXIST' });
  for (const [i, [path, value]] of entries.entries()) if (existing[i] === null) await save(path, value);
}
async function generationLedger(dir) {
  let names = [];
  try { names = await readdir(join(dir, 'generation-calls')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of names.filter(name => /^\d+\.json(?:\.tmp|\.pending-.+)$/.test(name))) {
    const final = name.replace(/(?:\.tmp|\.pending-.+)$/, '');
    // Cleanup may have been interrupted just after an atomic link publication.
    // Only the same published call is safe; all other remnants block execution/
    // import before model access rather than hide a possible call.
    let published;
    try { published = await readFile(join(dir, 'generation-calls', final)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let committed = false;
    if (name.includes('.pending-') && published) {
      const staging = await readFile(join(dir, 'generation-calls', name));
      committed = published.equals(staging);
      if (!committed) {
        // The first in-flight entry was published, its cleanup was interrupted,
        // and a later terminal checkpoint replaced that final path. Its original
        // link remains valid only if it is exactly the same call's start record.
        try {
          const terminal = JSON.parse(published.toString('utf8'));
          const original = Object.fromEntries(['schemaVersion', 'planId', 'callId', 'context', 'request', 'startedAt',
            ...(terminal.environmentSegmentHash ? ['environmentSegmentHash'] : [])]
            .map(key => [key, terminal[key]]));
          committed = ['completed', 'failed'].includes(terminal.state)
            && hash(JSON.parse(staging.toString('utf8'))) === hash({ ...original, state: 'in-flight' });
        } catch { /* A partial or unrelated staging file cannot certify a call. */ }
      }
    }
    assert(committed,
    '호출 기록의 저장 중단 흔적이 있습니다. 원본 폴더를 담당자에게 전달하세요');
  }
  return Promise.all(names.filter(name => /^\d+\.json$/.test(name))
    .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)))
    .map(name => read(join(dir, 'generation-calls', name))));
}
async function environmentSegments(dir) {
  const folder = join(dir, 'environment-segments');
  let names;
  try { names = await readdir(folder); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  for (const name of names.filter(n => /^\d+\.json\.pending-.+$/.test(n))) {
    const target = join(folder, name.replace(/\.pending-.+$/, ''));
    let published;
    try { published = await readFile(target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(published && published.equals(await readFile(join(folder, name))),
      '실행 환경 기록의 저장 중단 흔적이 있습니다. 진행 기록과 원본을 담당자에게 전달하세요');
  }
  const files = names.filter(n => /^\d+\.json$/.test(n)).sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
  return Promise.all(files.map(async (name, index) => {
    assert(Number(name.slice(0, -5)) === index + 1, '실행 환경 원본 구간이 누락됐습니다');
    return read(join(folder, name));
  }));
}
export async function implementationHash() {
  return hash(await Promise.all(['core.mjs', 'runner.mjs', 'postprocess.mjs', 'grading.mjs', 'report.mjs', 'state.mjs', 'costs.mjs', 'cli.mjs'].map(async (name) => [name, await readFile(new URL(name, import.meta.url), 'utf8')])));
}
function parse(args) {
  const [command, ...rest] = args, flags = {};
  const accepted = {
    help: [], prepare: ['dir', 'model', 'model-identity', 'methods', 'dataset', 'gold', 'options', 'endpoint', 'timeout', 'retries', 'repeats', 'seed', 'warmup'],
    run: ['dir'], 'export-operator': ['dir', 'out'], 'import-run': ['dir', 'file'],
    'inspect-interruption': ['dir', 'folder', 'out'], code: ['dir', 'run'],
    ai: ['dir', 'run', 'model', 'endpoint', 'timeout', 'retries'], packets: ['dir', 'run'],
    'import-review': ['dir', 'run', 'file', 'reviewer'], finalize: ['dir', 'run', 'adjudications', 'out'],
    report: ['dir', 'run', 'final'], 'resolve-state': ['dir', 'run', 'file', 'out'],
    'validate-judge': ['dir', 'run', 'groups', 'final'], compare: ['before', 'after', 'out'],
    'sample-freeze': ['dir'], 'sample-packets': ['dir', 'run'],
    'import-sample-review': ['dir', 'run', 'file', 'reviewer'],
    'sample-finalize': ['dir', 'run', 'adjudications', 'out'],
    'automatic-report': ['dir', 'run'], 'sample-report': ['dir', 'run', 'final'],
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
async function evaluationCosts(dir, plan, run, humanEntries = null) {
  const costs = {};
  for (const kind of ['code', 'ai']) {
    const artifact = await maybe(join(dir, kind + '.json'));
    if (artifact !== null) bindCost(plan, run, artifact, kind);
    costs[kind] = artifact;
  }
  const start = await maybe(join(dir, 'ai-start.json'));
  let files = [];
  try { files = (await readdir(join(dir, 'ai-calls'))).filter(file => /^\d+\.json$/.test(file))
    .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert(!files.length || start, 'AI 호출 기록은 있지만 시작 기록이 없습니다. 담당자가 출처를 확인하세요');
  const entries = await Promise.all(files.map(async file => ({ file, entry: await read(join(dir, 'ai-calls', file)) })));
  const partial = start ? interruptedAiCost(plan, run, start, entries) : null;
  const provenance = costs.ai
    ? (await import('./ai-provenance.mjs')).validateAiProvenance(plan, run, costs.ai, start, entries) : null;
  if (costs.ai && partial) {
    assert(partial.cost.inFlightCalls === 0 && partial.cost.recordedAttempts === costs.ai.evaluationCost.calls,
      '완료 AI 비용과 호출 기록 수/상태 불일치');
    for (const field of ['inputTokens', 'outputTokens']) {
      assert(hash(partial.cost[field]) === hash(costs.ai.evaluationCost[field]), '완료 AI 토큰 비용과 호출 기록 불일치');
    }
  }
  return { schemaVersion: 1, planId: plan.id, criteriaHash: plan.criteriaHash, runHash: hash(run),
    generationIncluded: false, code: costs.code?.elapsedMs ?? null,
    ai: costs.ai?.evaluationCost ?? partial?.cost ?? null,
    aiExecution: costs.ai ? { status: 'completed', interrupted: false,
      startHash: partial?.execution.startHash ?? null, ledgerHashes: partial?.execution.ledgerHashes ?? {} }
      : partial?.execution ?? { status: 'not-started', interrupted: false },
    artifacts: Object.fromEntries(['code', 'ai'].map(kind => [kind, costs[kind] ? hash(costs[kind]) : null])),
    aiProvenance: provenance?.evidence ?? null,
    human: humanEntries === null ? null : humanCost(humanEntries),
    humanScope: humanEntries === null ? 'not assessed by automatic report; see separate sample report' : 'recorded human reviews only',
  };
}
export async function main(args = process.argv.slice(2)) {
  const { command, flags } = parse(args);
  if (!command || command === 'help') {
    console.log('날짜 평가: prepare --dir 경로 --model 모델 | run --dir 경로 | sample-freeze --dir 경로 (실행 전) | 담당자 중단 확인: inspect-interruption --dir 담당자폴더 --folder 반환폴더 --out 원본밖의진단.json | automatic-report --dir 경로 | sample-packets --dir 경로 | import-sample-review --dir 경로 --file 판정.json --reviewer 이름 | sample-finalize --dir 경로 | sample-report --dir 경로 | 기존 전수 채점: packets / import-review / finalize / report / validate-judge | compare --before 결과.json --after 결과.json --out 비교.json');
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
    if (dataset.split === 'final') assert(Array.isArray(gold.reviewedBy) && gold.reviewedBy.length > 0
      && gold.reviewedBy.every(id => typeof id === 'string' && id.trim()), '본실험은 실제 검수자 기록이 필요합니다');
    const methods = (typeof flags.methods === 'string' ? flags.methods : 'prompt-baseline,rule-baseline,evidence-first').split(',');
    assert(methods.every((id) => ['prompt-baseline','rule-baseline','evidence-first', ...DERIVED_METHODS].includes(id)), '방법 ID 오류');
    assert(!methods.some(id => DERIVED_METHODS.includes(id)) || methods.includes('prompt-baseline'), 'T·V는 같은 계획의 P가 필요합니다');
    const config = {
      model: requireFlag(flags, 'model'), endpoint: localEndpoint(flags.endpoint), think: false,
      options: flags.options ? await read(flags.options) : { temperature: 0, seed: 62, num_ctx: 8192, num_predict: 1024 },
      timeoutMs: Number(flags.timeout ?? 120000), retries: Number(flags.retries ?? 0),
      repeats: Number(flags.repeats ?? 1), seed: Number(flags.seed ?? 62), runOrder: 'seeded',
      warmup: flags.warmup === true,
      generationAuditVersion: 1,
      generationCompletionVersion: 2,
      environmentAuditVersion: 1,
      methods: methods.map((id) => ({ id, version: METHOD_VERSION, codeHash: null,
        ...(DERIVED_METHODS.includes(id) ? { postprocessVersion: POSTPROCESS_VERSION } : {}) })),
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
  if (command === 'sample-freeze') {
    let environmentFiles = [];
    try { environmentFiles = await readdir(join(dir, 'environment-segments')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(environmentFiles.length === 0, '실행 환경 기록이 생긴 뒤 표본을 사전 고정할 수 없습니다');
    assert(!(await maybe(join(dir, 'operator-export.json'))),
      '실행 폴더를 전달한 뒤 표본을 사전 고정할 수 없습니다. 새 계획에서 표본을 먼저 고정하세요');
    assert(!(await maybe(join(dir, 'run.json'))) && !(await maybe(join(dir, 'progress.json'))),
      '표본은 실행 결과·진행 기록이 생기기 전에 고정하세요. 기존 실행에 사전 고정했다고 표시하지 않습니다');
    let calls = [];
    try { calls = await readdir(join(dir, 'generation-calls')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(calls.length === 0, '호출 기록이 생긴 뒤 표본을 사전 고정할 수 없습니다');
    const { createSampleManifest } = await import('./sampling.mjs');
    const manifest = createSampleManifest(plan, { seed: 62 });
    await save(join(dir, 'sample-manifest.json'), manifest);
    console.log(`날짜 유형을 균형 있게 선정한 ${manifest.caseIds.length}문항·${manifest.plannedOutputs}개 예정 출력의 검증 표본을 고정했습니다. 담당자 전용 기록이며 유진님은 실행만 합니다.`);
    return;
  }
  if (command === 'export-operator') {
    let environmentFiles = [];
    try { environmentFiles = await readdir(join(dir, 'environment-segments')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(environmentFiles.length === 0, '실행 환경 기록이 있는 계획은 새 실행 폴더로 전달할 수 없습니다. 시작 전 계획을 준비하세요');
    assert(plan.dataset.split !== 'final' || plan.gold.reviewStatus === 'approved', '검수 전 본실험 자료는 전달할 수 없습니다');
    if (plan.dataset.split === 'final') assert(Array.isArray(plan.gold.reviewedBy) && plan.gold.reviewedBy.length > 0
      && plan.gold.reviewedBy.every(id => typeof id === 'string' && id.trim()), '본실험은 실제 검수자 기록이 필요합니다');
    const out = resolve(requireFlag(flags, 'out'));
    assert(out !== dir, '담당자 폴더와 실행 폴더는 분리하세요');
    assert(plan.config.methods.every(m => m.codeHash === plan.config.methods[0].codeHash)
      && plan.config.methods[0].codeHash === await implementationHash(), '준비 후 코드가 바뀌었습니다. 새 계획으로 실행 폴더를 준비하세요');
    let existing = [];
    try { existing = await readdir(out); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(existing.length === 0, '실행 폴더는 새 폴더 또는 빈 폴더여야 합니다. 기존 정답·결과와 섞지 않습니다');
    const manifest = await maybe(join(dir, 'sample-manifest.json'));
    if (manifest) {
      (await import('./sampling.mjs')).validateSampleManifest(plan, manifest);
      assert(manifest.seed === 62, '이번 표본 검증은 실행 전 고정한 seed 62를 사용합니다');
    }
    const exportBinding = { schemaVersion: 1, planId: plan.id, planHash: hash(plan),
      mode: manifest ? 'automatic-sample' : 'legacy-full-human', manifestHash: manifest?.manifestHash ?? null };
    const previousExport = await maybe(join(dir, 'operator-export.json'));
    assert(!previousExport || hash(previousExport) === hash(exportBinding), '이전 전달 기록과 표본·계획이 다릅니다');
    // Record the private binding before publishing executable files, including on partial I/O failure.
    if (!previousExport) await save(join(dir, 'operator-export.json'), exportBinding);
    await save(join(out, 'plan.json'), executionPlan(plan));
    await prepareOperatorBundle(out);
    await save(join(out, 'operator.json'), { planId: plan.id, slots: plan.slots.length, generationOnly: true,
      next: 'node "./run-evaluation.mjs"', model: plan.config.model, split: plan.dataset.split,
      role: '유진: 실행·원문/환경/오류 기록·폴더 전달만. 검수·채점·설정 변경 없음.',
      evaluationMode: exportBinding.mode, sampleManifestHash: exportBinding.manifestHash,
      answerKeyIncluded: false, privatePlanRequiredForGrading: true });
    console.log('정답표를 제외한 실행 전용 폴더를 만들었습니다. 담당자용 원본 계획은 보관하세요.');
    return;
  }
  if (command === 'import-run') {
    const run = validateRun(plan, await read(requireFlag(flags, 'file')));
    validateRecordedInputs(plan, run);
    if (plan.config.generationAuditVersion === 1) assert(hash(await generationLedger(dirname(resolve(flags.file)))) === hash(run.generationLedger),
      '반환 폴더의 원본 생성 호출 파일과 실행 명세가 다릅니다. 전체 폴더를 보존해 전달하세요');
    if (plan.config.environmentAuditVersion === 1 || run.environmentHistory) assert(
      hash(await environmentSegments(dirname(resolve(flags.file)))) === hash(run.environmentHistory),
      '반환 폴더의 원본 환경 이력과 실행 기록이 다릅니다. 전체 폴더를 보존해 전달하세요');
    await save(join(dir, 'run.json'), run);
    console.log('기존 원문 기록을 재사용합니다. 모델을 다시 실행하지 않았습니다.');
    return;
  }
  if (command === 'inspect-interruption') {
    const folder = resolve(requireFlag(flags, 'folder')), out = resolve(requireFlag(flags, 'out'));
    const location = relative(await realpath(folder), await canonicalDestination(out));
    assert(location && (isAbsolute(location) || location === '..' || location.startsWith('..' + sep)),
      '중단 진단은 반환 원본 폴더 밖의 새 파일에 저장하세요');
    const { inspectInterruption } = await import('./interruption.mjs');
    await save(out, await inspectInterruption(plan, folder));
    console.log('중단 원본의 상태·확인된 비용·미확인 범위를 별도 등록했습니다. 최종 점수·재실행 승인이 아닙니다. 유진님은 추가 작업 없이 폴더만 전달합니다.');
    return;
  }
  if (command === 'run') {
    const current = await maybe(join(dir, 'run.json'));
    assert(!current, '완료된 실행은 덮어쓰지 않습니다. 비교 실행은 새 폴더를 쓰세요');
    assert(plan.config.methods.every((m) => m.codeHash) && plan.config.methods.every((m) => m.codeHash === plan.config.methods[0].codeHash), '방법 코드 버전 누락/불일치');
    assert(await implementationHash() === plan.config.methods[0].codeHash, '실행 코드가 준비 후 바뀌었습니다. 새 계획을 준비하세요');
    const hasGeneration = plan.config.methods.some((m) => m.id !== 'rule-baseline');
    const progressPath = join(dir, 'progress.json');
    try {
      await lstat(progressPath + '.tmp');
      assert(false, '진행 기록의 저장 중단 흔적이 있습니다. 같은 폴더를 임의 재실행하지 말고 담당자에게 전달하세요');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const progress = await maybe(progressPath);
    assert(!progress || progress.planId === plan.id, '다른 계획의 진행 기록');
    assert(!progress?.modelVerificationIssue, '이전에 실행 후 모델 변경 또는 확인 실패가 기록됐습니다. 같은 폴더를 재실행해 기존 결과를 확정할 수 없습니다. 원본과 오류를 담당자에게 전달하세요');
    assert(!progress?.inFlight, '실행 중 끊긴 호출이 있습니다. 같은 자리를 자동 재실행하지 않습니다. 담당자가 실제 상태·비용을 확인한 뒤 새 계획 또는 기록을 확정하세요');
    const records = progress?.records ?? [];
    // This also checks unpublished sidecars before any tag/model request.
    const previousLedger = await generationLedger(dir);
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
    validateGenerationProgress(plan, records, previousLedger);
    const previousEnvironment = await environmentSegments(dir);
    const environment = executionEnvironment();
    if (progress) {
      assert(Array.isArray(progress.environmentHistory) && progress.environmentHistory.length > 0,
        '과거 진행 기록에 실행 환경 이력이 없습니다. 현재 환경으로 소급 인증하지 않고 재개를 중단합니다');
      assert(hash(previousEnvironment) === hash(progress.environmentHistory), '진행 기록과 원본 실행 환경 이력이 다릅니다');
      validateEnvironmentHistory(plan, { records, generationLedger: previousLedger,
        environmentHistory: progress.environmentHistory }, { partial: true });
      assert(hash(environment) === hash(previousEnvironment[0].environment),
        '재개 전 실행 환경이 바뀌었습니다. 같은 실행으로 합칠 수 없습니다. 원본 폴더를 담당자에게 전달하세요');
    } else assert(previousEnvironment.length === 0, '환경 원본은 있지만 진행 기록이 없습니다. 확인 전 재실행하지 않습니다');
    const modelBefore = hasGeneration ? await modelIdentity(plan.config.model, plan.config.endpoint) : null;
    if (hasGeneration) assert(sameModelIdentity(plan.config.modelIdentity, modelBefore), '모델 파일/양자화 정보가 준비 후 바뀌었습니다');
    const body = { schemaVersion: 1, planId: plan.id, index: previousEnvironment.length + 1,
      previousHash: previousEnvironment.at(-1)?.segmentHash ?? null, environment, modelBefore,
      startedAt: new Date().toISOString(), callCount: previousLedger.length,
      ledgerPrefixHash: hash(previousLedger), recordIds: records.map(r => r.id) };
    const segment = { ...body, segmentHash: hash(body) };
    await save(join(dir, 'environment-segments', String(segment.index).padStart(4, '0') + '.json'), segment);
    const environmentHistory = [...previousEnvironment, segment];
    // The CLI owns the durable, sequential call ledger. A nonempty array from
    // an arbitrary API caller alone is not evidence that earlier calls exist.
    const warmupHistoryComplete = progress?.warmupHistoryComplete
      ?? (!plan.config.warmup || records.length === 0
        || (previousWarmup.length > 0 && callIds.every((id, index) => id === index + 1)));
    assert(typeof warmupHistoryComplete === 'boolean', '준비 호출 이력 상태 오류');
    // Flush the environment and pre-call model identity before any warmup,
    // generation or zero-call rule/postprocess work can start.
    const progressValue = extra => ({ planId: plan.id, records, warmupHistoryComplete, environmentHistory, ...extra });
    await checkpoint(progressPath, progressValue({ inFlight: null }));
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
        environmentSegmentHash: segment.segmentHash,
        startedAt: new Date().toISOString(), state: 'in-flight' };
      await persist(() => save(path, entry));
      await persist(() => checkpoint(progressPath, progressValue({
        inFlight: { request, callFile: file, context, startedAt: entry.startedAt } })));
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
      environment: environmentHistory[0].environment, environmentHistory,
      onRecord: async (record) => {
        records.push(record); active = null;
        await checkpoint(progressPath, progressValue({ inFlight: null }));
        console.log(`${records.length}/${plan.slots.length}: ${record.caseId} ${record.methodId} ${record.state}`);
      } });
    assert(!active, '확인되지 않은 실행 상태');
    if (hasGeneration) {
      let modelAfter;
      try {
        modelAfter = await modelIdentity(plan.config.model, plan.config.endpoint);
        assert(sameModelIdentity(modelBefore, modelAfter), '실행 중 모델 파일/양자화 정보가 바뀌었습니다. 결과를 확정하지 않고 원본 폴더를 보존합니다');
      } catch (error) {
        await checkpoint(progressPath, progressValue({ inFlight: null,
          modelVerificationIssue: { before: modelBefore, after: modelAfter ?? null, error: error.message,
            recordedAt: new Date().toISOString() } }));
        throw error;
      }
      result.modelVerification = { before: environmentHistory[0].modelBefore, after: modelAfter, scope: 'tag identity checked before each segment and after final batch; not per-response digest attestation' };
    }
    if (plan.config.generationAuditVersion === 1) result.generationLedger = await generationLedger(dir);
    validateExecutionRun(plan, result);
    validateRecordedInputs(plan, result);
    await save(join(dir, 'run.json'), result);
    console.log('실행·원문 기록 완료. 채점은 담당자가 진행합니다. 진행 기록은 삭제하지 마세요.');
    return;
  }
  const run = validateRun(plan, await read(flags.run ?? join(dir, 'run.json')));
  if (['sample-packets', 'import-sample-review', 'sample-finalize', 'sample-report', 'automatic-report'].includes(command)) {
    validateRecordedInputs(plan, run);
    if (command === 'automatic-report') {
      const { buildAutomaticReport, compareAutomaticMethods, validateAutomaticReport } = await import('./automatic.mjs');
      const ai = await maybe(join(dir, 'ai.json'));
      const prior = await maybe(join(dir, 'automatic-report.json'));
      // Resume a partially published group using the original measured code
      // time, rather than recomputing it and replacing the existing report.
      if (prior) {
        assert(prior.aiHash === (ai === null ? null : hash(ai)), '기존 보고서와 AI 원본이 다릅니다. 새 분석 폴더를 사용하세요');
        validateAutomaticReport(plan, run, prior, ai);
      }
      const report = prior ?? buildAutomaticReport(plan, run, ai);
      const comparison = compareAutomaticMethods(plan, run, report, ai);
      const costs = await evaluationCosts(dir, plan, run);
      costs.automaticCode = { elapsedMs: report.codeCost.elapsedMs,
        scope: report.codeCost.scope, artifactHash: hash(report) };
      await saveReportGroup([[join(dir, 'automatic-report.json'), report],
        [join(dir, 'automatic-comparison.json'), comparison], [join(dir, 'automatic-evaluation-cost.json'), costs]]);
      console.log('구조화 날짜 자동 점수와 AI 보조 점수를 분리해 저장했습니다. 사람 표본 검증 완료나 전체 내용 정답을 뜻하지 않습니다.');
      return;
    }
    const { createSamplePackets, validateSampleManifest, validateSampleFinal } = await import('./sampling.mjs');
    const manifest = await read(join(dir, 'sample-manifest.json'));
    validateSampleManifest(plan, manifest);
    const exported = await maybe(join(dir, 'operator-export.json'));
    assert(!exported || hash(exported) === hash({ schemaVersion: 1, planId: plan.id, planHash: hash(plan),
      mode: 'automatic-sample', manifestHash: manifest.manifestHash }), '전달 전에 고정한 계획·표본과 현재 매니페스트가 다릅니다');
    assert(manifest.seed === 62, '이번 표본 검증은 실행 전 고정한 seed 62를 사용합니다');
    if (command === 'sample-packets') {
      const privateFile = join(dir, 'sample-review-private.json');
      const existing = await maybe(privateFile);
      const bundle = existing ?? createSamplePackets(plan, run, manifest);
      assert(bundle.type === 'sample-review-packets' && hash(bundle.caseIds) === hash(manifest.caseIds),
        '기존 표본 검토 묶음이 사전 고정한 문항과 다릅니다');
      finalizeReviews(plan, run, bundle, []); // validate original packet IDs/bindings before any recovery write.
      await saveMatching(privateFile, bundle);
      await saveMatching(join(dir, 'sample-review-share', 'packets.json'), bundle.packets);
      await saveMatching(join(dir, 'sample-review-share', 'blank-review.json'), bundle.packets.map(p => ({
        ...blankJudgment(p), structuredDate: null, structuredReason: '',
      })));
      console.log('sample-review-share만 검토자 두 명에게 각각 전달하세요. 표본 대응표·방법·자동 점수·상대 판정은 가립니다.');
      return;
    }
    if (command === 'sample-report') {
      const { buildSampleReport } = await import('./sample-report.mjs');
      const final = await read(flags.final ?? join(dir, 'sample-final.json'));
      validateSampleFinal(plan, run, manifest, final);
      const automatic = await read(join(dir, 'automatic-report.json'));
      const ai = await maybe(join(dir, 'ai.json'));
      assert(!automatic.aiHash || ai, 'AI를 사용한 표본 보고서는 원본 ai.json과 호출 기록을 함께 보존해야 합니다');
      // Recheck the local durable evidence, not only an embedded AI snapshot.
      await evaluationCosts(dir, plan, run);
      const report = buildSampleReport(plan, run, manifest, final, automatic, ai);
      await save(join(dir, 'sample-report.json'), report);
      console.log('사람 표본 판정·자동 평가와의 대조를 저장했습니다. 표본 결과를 전체 사람 정답률로 확대하지 않습니다.');
      return;
    }
    const bundle = await read(join(dir, 'sample-review-private.json'));
    assert(bundle.type === 'sample-review-packets' && hash(bundle.caseIds) === hash(manifest.caseIds),
      '표본 검토 묶음이 사전 고정한 문항과 다릅니다');
    const reviewsDir = join(dir, 'sample-reviews');
    const prior = await reviewFiles(reviewsDir);
    if (command === 'import-sample-review') {
      const reviewer = requireFlag(flags, 'reviewer');
      assert(/^[a-zA-Z0-9가-힣_-]+$/.test(reviewer), '검토자 ID는 한글/영문/숫자/_/-만 허용');
      const reviews = await read(requireFlag(flags, 'file'));
      assert(Array.isArray(reviews) && reviews.length > 0 && reviews.every(r => r.reviewerId === reviewer), '검토자 ID 불일치');
      const submitted = new Set(prior.filter(r => r.reviewerId === reviewer).map(r => r.packetId));
      assert(reviews.every(r => !submitted.has(r.packetId)), '이미 제출한 첫 판정은 덮어쓸 수 없습니다');
      finalizeReviews(plan, run, bundle, [...prior, ...reviews]);
      await save(join(reviewsDir, reviewer + '--' + hash(reviews) + '.json'), reviews);
      console.log('표본 독립 첫 판정 원본 저장. 기존 전수 채점 파일과 분리했습니다.');
      return;
    }
    const adjudications = flags.adjudications ? await read(flags.adjudications) : [];
    const final = finalizeReviews(plan, run, bundle, prior, adjudications);
    await save(flags.out ? resolve(flags.out) : join(dir, 'sample-final.json'), final);
    console.log(`표본 판정 저장. 미확정 ${final.items.filter(i => i.state === 'pending').length}개. 미확정이 있으면 표본 검증 보고서를 만들지 않습니다.`);
    return;
  }
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
    const evaluationCost = {
      schemaVersion: 1, planId: plan.id, criteriaHash: plan.criteriaHash, runHash: hash(run),
      generationIncluded: false, code: costs.code?.elapsedMs ?? null,
      ai: costs.ai?.evaluationCost ?? partial?.cost ?? null,
      aiExecution: costs.ai ? { status: 'completed', interrupted: false,
        startHash: partial?.execution.startHash ?? null, ledgerHashes: partial?.execution.ledgerHashes ?? {} }
        : partial?.execution ?? { status: 'not-started', interrupted: false },
      artifacts: Object.fromEntries(['code', 'ai'].map(kind => [kind, costs[kind] ? hash(costs[kind]) : null])),
      human,
    };
    await saveReportGroup([[join(dir, 'report.json'), report], [join(dir, 'comparison.json'), compareReports(report, report)],
      [join(dir, 'evaluation-cost.json'), evaluationCost]]);
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
