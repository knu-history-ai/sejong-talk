import { readFile } from 'node:fs/promises';
import { hash } from './core.mjs';

const labels = {
  creation: '훈민정음 창제', header: '훈민정음 창제 기록의 기사 표제',
  completion: '치평요람 완성', dispatch: '정이한 파견', start: '의주 읍성 공사 시작', end: '의주 읍성 공사 종료',
};
const specs = [
  ['S1', ['creation']], ['S1', ['creation']], ['S1', ['header']],
  ['S2', ['completion']], ['S3', ['dispatch']], ['S3', ['start']],
  ['S3', ['end']], ['S3', ['dispatch', 'start']],
];
const dates = {
  creation: [1443, 12, null], header: [1443, 12, 30], completion: [1445, 3, null],
  dispatch: [1448, 1, null], start: [1448, 2, 15], end: [1448, 3, 15],
};
const quotations = {
  creation: ['세종 25년(1443년) 12월 30일', '이달에 임금이 친히 언문(諺文) 28자(字)를 지었는데,'],
  header: ['기사 표제 날짜: 세종 25년(1443년) 12월 30일'],
  completion: ['세종 27년(1445년) 3월 30일', '이달에 《치평요람(治平要覽)》이 이루어졌다.'],
  dispatch: ['세종 30년(1448년) 1월 28일', '이달에 지병조사(知兵曹事) 정이한(鄭而漢)을 평안도 에 보내어'],
  start: ['세종 30년(1448년) 1월 28일', '2월 15일에 공사를 시작하여'],
  end: ['세종 30년(1448년) 1월 28일', '3월 15일에 끝마치었다.'],
};
export async function loadPilot({ docsText, questionsText } = {}) {
  // Canonicalize fresh source material before extracting spans/hashing. Stored
  // plans, answers and results are never loaded or rewritten by this helper.
  const docs = (docsText ?? await readFile(new URL('../../../docs/date-pilot-v1/model-inputs.md', import.meta.url), 'utf8'))
    .replace(/\r\n?/g, '\n');
  const questions = JSON.parse(questionsText ?? await readFile(new URL('../date-questions.json', import.meta.url), 'utf8'));
  const fences = [...docs.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  const sources = Object.fromEntries(fences.filter((text) => text.startsWith('[자료]')).map((text) => [text.match(/사료 ID: (S\d+)/)[1], text]));
  const cases = questions.map((q, i) => {
    const [sourceId, ids] = specs[i];
    return { id: q.id, articleId: sourceId, groupId: sourceId, sourceId, sourceText: sources[sourceId],
      question: q.input, kind: q.id === 'B03' ? 'control' : 'event',
      type: q.id === 'B03' ? 'header-control' : q.id === 'B08' ? 'mixed-events' : q.id === 'B02' ? 'false-date-premise' : ['B06', 'B07'].includes(q.id) ? 'known-day' : 'unknown-day',
      targets: ids.map((id) => ({ id, label: labels[id] })) };
  });
  const dataset = { version: 'date-pilot-v1', split: 'pilot', cases };
  const gold = {
    version: 'date-pilot-gold-v1', criteriaVersion: 'issue62-date-v1', datasetHash: hash(dataset),
    reviewStatus: 'draft', reviewedBy: [],
    rubric: {
      date: '모든 질문 대상 사건에 대해 질문이 요구하는 확인 가능한 월·일을 답해야 1점. 확인할 수 없는 일을 만들거나 근거 없이 특정 일을 부정하면 0점. 연도는 생략 가능하나 적으면 정확해야 함. 일자를 묻고 본문에 일자가 없으면 월을 답하고 일자는 확인 불가라고 밝혀야 함. 표제 날짜 언급 자체는 오류가 아님. 월 초·말 추정과 양력 환산은 허용하지 않음.',
      evidence: '모든 대상 사건에 대해 자료 안의 인용 또는 허용된 바꿔 쓰기가 실제 답변을 뒷받침해야 1점. 인용 존재 여부만으로 의미상 지지를 판정하지 않음. 날짜 1점이라도 근거가 틀리거나 없으면 근거 0점.',
      aliases: { calendar: ['음력', '실록 음력', 'lunar'], regnalYear: { 25: 1443, 27: 1445, 30: 1448 } },
      unknownDay: '날짜 불명은 일자에만 적용. 확인 가능한 연·월까지 모른다고 답하면 날짜 0점.',
    },
    cases: cases.map((c, i) => ({ id: c.id, wrongExamples: questions[i].failureConditions, events: c.targets.map(({ id }) => {
      const [year, month, day] = dates[id];
      return { id, expected: { year, month, day, calendar: 'lunar' }, required: ['month', 'day'],
        allowedOmissions: ['year', 'calendar'], requiresUnknownDay: day === null,
        unknownScope: day === null ? ['day'] : [],
        wrongExamples: questions[i].failureConditions,
        allowedExpressions: day === null ? ['확인 가능한 월 + 정확한 일자는 이 자료로 확인 불가', '표제일을 사건일로 확정할 수 없음'] : ['자료에 명시된 월·일 유지'],
        eligibility: { unsupportedDay: day === null, missingKnownDay: day !== null && c.kind === 'event', headerConfusion: c.kind === 'event' },
        evidence: quotations[id].map((quote) => {
          const start = c.sourceText.indexOf(quote);
          return { quote, start, end: start + quote.length };
        }),
        allowedParaphrases: ['이달은 기사 표제의 연·월을 가리킴. 사건의 일자가 본문에 없으면 일자는 확인 불가.'],
      };
    }) })),
  };
  return { dataset, gold };
}
