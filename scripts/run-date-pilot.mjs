import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../evals/sejong/date-eval/cli.mjs';
import { modelIdentity } from '../evals/sejong/date-eval/runner.mjs';
import { assert } from '../evals/sejong/date-eval/core.mjs';

// Fixed pilot conditions: the operator runs this command, not edits a plan or scores.
export async function runPilot({ root = fileURLToPath(new URL('../', import.meta.url)), endpoint = 'http://127.0.0.1:11434' } = {}) {
  assert(Number(process.versions.node.split('.')[0]) === 24, 'Node.js 24가 필요합니다. 담당자에게 오류를 전달하세요.');
  const dir = join(root, 'evals', 'sejong', 'date-eval', 'results', 'yujin-pilot');
  let exists = false;
  try { await access(dir); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert(!exists, '기존 평가 폴더가 있습니다. 재실행·삭제하지 말고 폴더와 오류를 담당자에게 전달하세요: ' + dir);
  const model = 'qwen3.5:4b';
  const identity = await modelIdentity(model, endpoint);
  assert(identity.details?.quantization_level === 'Q4_K_M', 'qwen3.5:4b의 Q4_K_M 모델이 필요합니다. 모델 목록과 오류를 담당자에게 전달하세요.');
  console.log('날짜 예비시험: 기본·규칙·근거 우선 방식 각 8문항. 실행·기록만 진행하며 내용 채점은 하지 않습니다.');
  await main(['prepare', '--dir', dir, '--model', model, '--endpoint', endpoint, '--repeats', '1', '--warmup']);
  console.log('완료·오류·중단 모두 다음 폴더 전체와 터미널 오류를 전달하세요: ' + dir);
  await main(['run', '--dir', dir]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 2) { console.error('추가 옵션 없이 안내된 명령만 실행하세요.'); process.exitCode = 1; }
  else await runPilot().catch(error => { console.error(error.message); process.exitCode = 1; });
}
