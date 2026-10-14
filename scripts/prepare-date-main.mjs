/** Maintainer-only: bind a reviewed final dataset without changing frozen methods.
 * Yujin receives only the exported operator folder and runs run-evaluation.mjs.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { assert } from '../evals/sejong/date-eval/core.mjs';
import { main } from '../evals/sejong/date-eval/cli.mjs';

export async function prepareMain(args) {
  assert(Number(process.versions.node.split('.')[0]) === 24, 'Node.js 24가 필요합니다');
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    assert(['--dataset', '--gold', '--private-dir', '--out', '--model-identity'].includes(key)
      && !Object.hasOwn(values, key) && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--'), '준비 인수 오류');
    values[key] = resolve(args[i + 1]);
  }
  for (const key of ['--dataset', '--gold', '--private-dir', '--out']) assert(values[key], `${key}가 필요합니다. 설정 담당자가 준비합니다`);
  const dataset = JSON.parse(await readFile(values['--dataset'], 'utf8'));
  const gold = JSON.parse(await readFile(values['--gold'], 'utf8'));
  assert(dataset.split === 'final' && gold.reviewStatus === 'approved', '검수 승인된 본실험 자료·정답표가 필요합니다. 임의로 승인 표시를 바꾸지 마세요');
  assert(Array.isArray(gold.reviewedBy) && gold.reviewedBy.some(id => typeof id === 'string' && id.trim()), '실제 검수자 기록이 필요합니다');
  const identityArgs = values['--model-identity'] ? ['--model-identity', values['--model-identity']] : [];
  if (identityArgs.length) {
    const identity = JSON.parse(await readFile(values['--model-identity'], 'utf8'));
    assert(identity.details?.quantization_level === 'Q4_K_M', '본실험은 지정한 Q4_K_M 모델을 사용합니다');
  }
  await main(['prepare', '--dir', values['--private-dir'], '--dataset', values['--dataset'], '--gold', values['--gold'],
    '--model', 'qwen3.5:4b', '--methods', 'rule-baseline,prompt-baseline,evidence-first,render-only,evidence-validated',
    '--repeats', '1', '--retries', '0', '--timeout', '120000', '--seed', '62', '--warmup', ...identityArgs]);
  const prepared = JSON.parse(await readFile(resolve(values['--private-dir'], 'plan.json'), 'utf8'));
  assert(prepared.config.modelIdentity.details?.quantization_level === 'Q4_K_M', '본실험은 지정한 Q4_K_M 모델을 사용합니다. 실행 폴더는 내보내지 않았습니다');
  // Freeze the maintainer-only audit selection before any operator execution.
  // The answer-free operator bundle does not expose the selected questions.
  await main(['sample-freeze', '--dir', values['--private-dir']]);
  await main(['export-operator', '--dir', values['--private-dir'], '--out', values['--out']]);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareMain(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
