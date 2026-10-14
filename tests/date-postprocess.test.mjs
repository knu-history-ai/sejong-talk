import test from 'node:test';
import assert from 'node:assert/strict';
import { POSTPROCESS_VERSION, DERIVED_METHODS, transformAnswer } from '../evals/sejong/date-eval/postprocess.mjs';

// Synthetic only. No loader, final dataset, gold, core, model, network or clock.
const T = 'render-only', V = 'evidence-validated';
function fixture(body = '이달에 기록을 편찬하였다.', targets = [{ id: 'build', label: '기록 편찬' }]) {
  return { sourceText: `기사 표제 날짜: 가상왕 9년(1451년) 7월 19일\n본문: ${body}`,
    question: '기록을 편찬한 날짜는 언제인가?', targets, kind: 'event' };
}
function quote(c, value, start = c.sourceText.indexOf(value)) {
  assert.notEqual(start, -1, `synthetic quote missing: ${value}`);
  return { quote: value, start, end: start + value.length };
}
function event(c, overrides = {}) {
  return { id: c.targets[0].id, date: { year: 1451, month: 7, day: 19, calendar: 'lunar' },
    unknownDay: false, evidence: [quote(c, '가상왕 9년(1451년) 7월 19일'),
      quote(c, c.sourceText.split('본문: ')[1])], ...overrides };
}
function raw(events, extra = {}) {
  return JSON.stringify({ answer: '원래의 설명: 19일이 아니며 월말이라고 주장했다.', events, ...extra });
}
function derive(c, events, method = V) {
  const result = transformAnswer(c, raw(events), method);
  assert.equal(result.audit.applied, true);
  assert.doesNotThrow(() => JSON.stringify(result.audit));
  return { ...result, output: JSON.parse(result.answer) };
}
function unverified(c, e, reason) {
  const result = derive(c, [e]);
  assert.deepEqual(result.output.events, [e]);
  assert.equal(result.audit.events[0].status, 'unverified');
  if (reason) assert.deepEqual(result.audit.events[0].reasons, [reason]);
  assert.equal(result.audit.events[0].changed, false);
  // Failed validation must not leak a method or a failure reason into the answer.
  assert.equal(result.answer, derive(c, [e], T).answer);
  return result;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('exports are fixed and supported methods cannot be mutated by callers', () => {
  assert.equal(POSTPROCESS_VERSION, 'date-postprocess-v1');
  assert.deepEqual(DERIVED_METHODS, [T, V]);
  assert.throws(() => DERIVED_METHODS.push('other'), TypeError);
});

test('T preserves all structured values, evidence, ordering and extra fields', () => {
  const c = fixture('8월 4일에 작업을 마쳤다.', [{ id: 'start', label: '시작' }, { id: 'end', label: '완료' }]);
  const evidence = [quote(c, '8월 4일에 작업을 마쳤다.')];
  const events = [
    { id: 'end', date: { year: 1450, month: 2, day: 3, calendar: '음력', regnalYear: 8 }, unknownDay: true, evidence, note: '보존' },
    { id: 'start', date: { year: null, month: null, day: null, calendar: null }, unknownDay: false, evidence: [] },
  ];
  const input = raw(events, { retained: { text: '추가 필드' } });
  const result = transformAnswer(c, input, T);
  const output = JSON.parse(result.answer);
  assert.deepEqual(output.events, events);
  assert.deepEqual(output.retained, { text: '추가 필드' });
  assert.notEqual(output.answer, JSON.parse(input).answer);
  assert.equal(result.audit.events.every(e => e.status === 'not-checked' && !e.changed), true);
  assert.deepEqual(result.audit.events[0].quoteChecks, []);
});

for (const [name, wrap] of [
  ['bare', s => s], ['whitespace', s => `\uFEFF \r\n${s}\r\n`],
  ['json fence', s => `\n\`\`\`json\n${s}\n\`\`\`\n`],
  ['CRLF uppercase fence', s => ` \`\`\`JSON\t\r\n${s}\r\n\`\`\` `],
  ['unlabelled CRLF fence', s => `\`\`\`\r\n${s}\r\n\`\`\``],
]) test(`whole JSON accepted: ${name}`, () => {
  const c = fixture(), input = raw([event(c)]);
  for (const method of DERIVED_METHODS) {
    const result = transformAnswer(c, wrap(input), method);
    assert.equal(result.audit.applied, true);
    assert.equal(result.answer, transformAnswer(c, input, method).answer);
  }
});

test('format fallbacks preserve raw bytes and distinguish not-applied from generation failure', () => {
  const c = fixture(), valid = raw([event(c)]);
  const malformed = [
    '', '일자는 확인하지 못했습니다.', 'null', '[]', '{', `설명\n${valid}`, `${valid}\n설명`,
    `${valid}\n${valid}`, `\`\`\`json\n${valid}\n\`\`\`\n설명`,
    `설명\n\`\`\`json\n${valid}\n\`\`\``,
    `\`\`\`json\n${valid}\n\`\`\`\n\`\`\`json\n${valid}\n\`\`\``,
    `\`\`\`javascript\n${valid}\n\`\`\``, `\`\`\`json\n${valid}\n`,
    '{"answer":"설명","events":[],}',
  ];
  for (const input of malformed) {
    const results = DERIVED_METHODS.map(m => transformAnswer(c, input, m));
    for (const result of results) {
      assert.equal(result.answer, input);
      assert.equal(result.audit.status, 'not-applied');
      assert.equal(result.audit.applied, false);
      assert.equal(Object.hasOwn(result.audit, 'state'), false);
      assert.equal(Object.hasOwn(result.audit, 'score'), false);
      assert.ok(result.audit.reason);
    }
    assert.equal(results[0].audit.reason, results[1].audit.reason);
  }
});

test('schema mismatches, unknown IDs, duplicate IDs and empty events pass through for both methods', () => {
  const c = fixture(), e = event(c);
  const samples = [
    { events: [e] }, { answer: 1, events: [e] }, { answer: '', events: [] },
    { answer: '', events: {} }, { answer: '', events: [null] },
    { answer: '', events: [{ ...e, id: 'foreign' }] }, { answer: '', events: [e, e] },
    { answer: '', events: [{ ...e, date: null }] },
    { answer: '', events: [{ ...e, date: [] }] },
    { answer: '', events: [{ ...e, date: { month: 7, day: 19 } }] },
    { answer: '', events: [{ ...e, date: { ...e.date, day: '19' } }] },
    { answer: '', events: [{ ...e, date: { ...e.date, month: 13 } }] },
    { answer: '', events: [{ ...e, date: { ...e.date, day: 0 } }] },
    { answer: '', events: [{ ...e, date: { ...e.date, calendar: 1 } }] },
    { answer: '', events: [{ ...e, unknownDay: null }] },
    { answer: '', events: [{ ...e, evidence: [{ quote: '구절' }] }] },
    { answer: '', events: [{ ...e, evidence: [{ quote: '구절', start: 0.5, end: 3 }] }] },
  ];
  for (const field of ['id', 'date', 'unknownDay', 'evidence']) {
    const incomplete = structuredClone(e); delete incomplete[field];
    samples.push({ answer: '', events: [incomplete] });
  }
  for (const field of ['year', 'month', 'day', 'calendar']) {
    const incomplete = structuredClone(e); delete incomplete.date[field];
    samples.push({ answer: '', events: [incomplete] });
  }
  for (const sample of samples) {
    const input = ` \r\n${JSON.stringify(sample)} \r\n`;
    for (const method of DERIVED_METHODS) {
      const result = transformAnswer(c, input, method);
      assert.equal(result.answer, input);
      assert.equal(result.audit.status, 'not-applied');
      assert.ok(result.audit.reason);
    }
  }
});

test('duplicate JSON object keys are not silently overwritten, including escaped aliases', () => {
  const c = fixture(), input = raw([event(c)]);
  for (const duplicate of [input.replace('"events":', '"answer":"contradiction","events":'),
    input.replace('"day":19', '"day":3,"d\\u0061y":19')]) {
    for (const method of DERIVED_METHODS) {
      const result = transformAnswer(c, duplicate, method);
      assert.equal(result.answer, duplicate);
      assert.equal(result.audit.reason, 'duplicate-json-key');
    }
  }
});

test('V this-month retains known month/year and removes unsupported header day', () => {
  const c = fixture(), e = event(c), result = derive(c, [e]);
  assert.deepEqual(result.output.events[0].date, { year: 1451, month: 7, day: null, calendar: 'lunar' });
  assert.equal(result.output.events[0].unknownDay, true);
  assert.deepEqual(result.output.events[0].evidence, e.evidence);
  assert.equal(result.audit.events[0].dayState, 'quoted-month-only');
  assert.equal(result.audit.events[0].semanticLink, 'unverified-without-gold');
  assert.doesNotMatch(result.output.answer, /월말|19일이 아니/);
  assert.match(result.output.answer, /사료 전체의 일자 부재를 인증하지/);
});

test('V numeric month-only retains month and never adds a day or implicit year', () => {
  const c = fixture('9월에 문서를 편찬하였다.');
  const e = event(c, { evidence: [quote(c, '9월에 문서를 편찬하였다.')] });
  e.date.year = null;
  const result = derive(c, [e]);
  assert.deepEqual(result.output.events[0].date, { year: null, month: 9, day: null, calendar: 'lunar' });
  assert.equal(result.output.events[0].unknownDay, true);
  assert.deepEqual(result.audit.events[0].checkedFields, ['month', 'day']);
  assert.deepEqual(result.audit.events[0].uncheckedFields, ['year', 'calendar']);
});

test('V preserves exact known month/day and can restore omitted numeric components from the same quotation', () => {
  const c = fixture('1451년 9월 4일에 문서를 편찬하였다.');
  for (const date of [{ year: 1451, month: 9, day: 4, calendar: 'lunar' },
    { year: null, month: null, day: null, calendar: null },
    { year: 1450, month: 7, day: 19, calendar: 'lunar' }]) {
    const e = event(c, { date, unknownDay: true, evidence: [quote(c, '1451년 9월 4일에 문서를 편찬하였다.')] });
    const result = derive(c, [e]);
    assert.deepEqual(result.output.events[0].date, { year: 1451, month: 9, day: 4, calendar: date.calendar });
    assert.equal(result.output.events[0].unknownDay, false);
    assert.equal(result.audit.events[0].status, 'precision-checked');
  }
});

test('numeric body month/day does not borrow the header year or day', () => {
  const c = fixture('9월 4일에 문서를 편찬하였다.');
  const e = event(c, { date: { year: null, month: 9, day: 4, calendar: 'lunar' } });
  const result = derive(c, [e]);
  assert.equal(result.output.events[0].date.year, null);
  assert.equal(result.output.events[0].date.month, 9);
  assert.equal(result.output.events[0].date.day, 4);
});

test('header alone does not become an event date, even when question mentions header confusion', () => {
  const c = fixture(); c.question = '표제일 19일에 편찬했다고 볼 수 있는가?';
  unverified(c, event(c, { evidence: [event(c).evidence[0]] }), 'header-without-explicit-body-link');
});

test('only a header control question or supported explicit this-day body link permits the header day', () => {
  const c = fixture(); c.kind = 'control'; c.question = '기사 표제 날짜는 언제인가?';
  const e = event(c, { evidence: [event(c).evidence[0]] });
  const control = derive(c, [e]);
  assert.equal(control.output.events[0].date.day, 19);
  assert.deepEqual(control.audit.events[0].grammars, ['header-control']);
  c.question = '기록 편찬 날짜는 언제인가?';
  unverified(c, e, 'header-without-explicit-body-link');
  const linked = fixture('이날에 기록을 편찬하였다.');
  const result = derive(linked, [event(linked)]);
  assert.equal(result.output.events[0].date.day, 19);
  assert.deepEqual(result.audit.events[0].grammars, ['this-day']);
});

test('this-month with numeric day preserves that day, not the header day', () => {
  const c = fixture('이달 4일에 기록을 편찬하였다.');
  const result = derive(c, [event(c)]);
  assert.deepEqual(result.output.events[0].date, { year: 1451, month: 7, day: 4, calendar: 'lunar' });
});

test('relative dates cannot acquire an anchor from unquoted source text', () => {
  const c = fixture(), e = event(c); e.evidence.shift();
  unverified(c, e, 'relative-without-quoted-header');
});

test('negation, alternatives, unsupported relatives, ranges and nonnumeric days preserve original values', () => {
  for (const body of ['다음달에 기록을 편찬하였다.', '그달에 기록을 편찬하였다.',
    '7월 4일이 아니라 5일에 편찬하였다.', '7월에 편찬하지 않았다.',
    '7월 4일부터 8일까지 편찬하였다.', '7월 4일 또는 5일에 편찬하였다.',
    '7월 초순에 편찬하였다.', '7월 보름에 편찬하였다.', '7월 삼일에 편찬하였다.',
    '7월 4일~5일에 편찬하였다.', '7월 4일-5일에 편찬하였다.',
    '윤7월 4일에 편찬하였다.', '7월 4일 2일 뒤에 편찬하였다.',
    '이달에 편찬했는지는 알 수 없다.']) {
    const c = fixture(body); unverified(c, event(c));
  }
});

test('a clipped quote cannot hide an adjacent negation', () => {
  const c = fixture('6월 15일에 공사를 시작하지 않았다.');
  const e = event(c, { evidence: [quote(c, '6월 15일')] });
  unverified(c, e, 'unsupported-or-negated-context');
});

test('clipped month, day, year and number tokens cannot erase the full date in source', () => {
  const c = fixture('1451년 6월 15일에 공사를 시작했다.');
  for (const value of ['6월', '6월 ', '6월 1', '6월 15', '15일', '5일', '1451년 6월']) {
    const e = event(c, { date: { year: 1451, month: 6, day: 15, calendar: 'lunar' },
      evidence: [quote(c, value)] });
    const result = unverified(c, e, 'incomplete-date-quote');
    assert.equal(result.output.events[0].date.day, 15);
    assert.equal(result.output.events[0].unknownDay, false);
  }
  const simple = { sourceText: '본문: 6월 15일에 공사를 시작했다.', question: '공사 시작일은?',
    targets: [{ id: 'start', label: '공사 시작' }], kind: 'event' };
  const e = { id: 'start', date: { year: null, month: 6, day: 15, calendar: null },
    unknownDay: false, evidence: [quote(simple, '6월')] };
  unverified(simple, e, 'incomplete-date-quote');
});

test('separately cited events preserve their own dates and order', () => {
  const c = fixture('6월 15일에 공사를 시작하여 8월 4일에 마쳤다.',
    [{ id: 'start', label: '공사 시작' }, { id: 'end', label: '공사 종료' }]);
  const start = event(c, { evidence: [quote(c, '6월 15일에 공사를 시작하여')] });
  const end = event(c, { id: 'end', evidence: [quote(c, '8월 4일에 마쳤다.')] });
  const result = derive(c, [end, start]);
  assert.deepEqual(result.output.events.map(e => [e.id, e.date.month, e.date.day]),
    [['end', 8, 4], ['start', 6, 15]]);
  assert.equal(result.audit.events.every(e => e.status === 'precision-checked'), true);
  unverified(c, event(c, { evidence: [quote(c, '6월 15일에 공사를 시작하여 8월 4일에 마쳤다.')] }), 'multiple-dates-in-quote');
});

test('clipped this-month day tokens cannot erase a known day', () => {
  const c = fixture('이달 4일에 기록을 편찬하였다.');
  for (const value of ['이달', '이달 ', '이달 4']) {
    const e = event(c, { date: { year: 1451, month: 7, day: 4, calendar: 'lunar' },
      evidence: [event(c).evidence[0], quote(c, value)] });
    unverified(c, e, 'incomplete-date-quote');
  }
});

test('month-only quotation with an unquoted day in the same sentence stays unverified', () => {
  for (const body of ['6월의 15일에 공사를 시작했다.', '이달에 공사를 시작한 때는 15일이다.']) {
    const c = fixture(body), value = body.startsWith('6월') ? '6월' : '이달에 공사를 시작한';
    const e = event(c, { date: { year: 1451, month: 6, day: 15, calendar: 'lunar' },
      evidence: [event(c).evidence[0], quote(c, value)] });
    unverified(c, e, 'month-only-with-day-in-context');
  }
});

test('conflicting body quotations or precision never select a convenient date', () => {
  const c = fixture('6월 15일에 시작했다. 8월 4일에 마쳤다. 6월에 기록을 편찬했다.');
  unverified(c, event(c, { evidence: [quote(c, '6월 15일에 시작했다.'), quote(c, '8월 4일에 마쳤다.')] }), 'conflicting-body-quotes');
  unverified(c, event(c, { evidence: [quote(c, '6월 15일에 시작했다.'), quote(c, '6월에 기록을 편찬했다.')] }), 'conflicting-body-quotes');
});

test('invalid quote presence, offsets, empty quotes and missing evidence stay unverified', () => {
  const c = fixture(), e = event(c);
  for (const bad of [
    { quote: '존재하지 않는 날짜', start: 0, end: 12 },
    { ...e.evidence[1], start: 0 }, { ...e.evidence[1], end: c.sourceText.length + 1 },
    { ...e.evidence[1], start: -1 }, { ...e.evidence[1], quote: '' },
  ]) {
    const result = unverified(c, { ...e, evidence: [bad] }, 'invalid-quote-position-or-text');
    assert.equal(result.audit.events[0].quoteChecks[0].positionMatches, false);
  }
  unverified(c, { ...e, evidence: [] }, 'no-evidence');
});

test('exact quotations use UTF-16 offsets and do not repair a wrong occurrence', () => {
  const c = fixture('📚 9월 4일에 기록을 편찬하였다.');
  const q = quote(c, '9월 4일에 기록을 편찬하였다.');
  const e = event(c, { evidence: [q] });
  assert.equal(derive(c, [e]).audit.events[0].quoteChecks[0].positionMatches, true);
  unverified(c, { ...e, evidence: [{ ...q, start: q.start - 1, end: q.end - 1 }] }, 'invalid-quote-position-or-text');
  const repeated = fixture('9월 4일에 편찬하지 않았다. 9월 4일에 편찬하였다.');
  const other = event(repeated, { evidence: [quote(repeated, '9월 4일', repeated.sourceText.lastIndexOf('9월 4일'))] });
  assert.equal(derive(repeated, [other]).audit.events[0].status, 'precision-checked');
});

test('null without reason, asserted unknown, inconsistent flags, omitted event and interpretation failure are distinct', () => {
  const c = fixture('날짜 표현을 해석할 단서가 부족하다.',
    [{ id: 'build', label: '기록 편찬' }, { id: 'other', label: '다른 작업' }]);
  const base = event(c, { evidence: [quote(c, '날짜 표현을 해석할 단서가 부족하다.')] });
  const seen = [];
  for (const [day, unknownDay, state] of [[null, false, 'null-without-reason'],
    [null, true, 'p-asserted-unknown'], [19, true, 'p-date-unknown-contradiction']]) {
    const e = { ...base, date: { ...base.date, day }, unknownDay };
    const result = derive(c, [e]);
    assert.equal(result.audit.events[0].dayState, state);
    assert.equal(result.audit.events[0].status, 'unverified');
    assert.deepEqual(result.audit.events[0].reasons, ['no-supported-date']);
    assert.deepEqual(result.audit.omittedTargetIds, ['other']);
    assert.equal(result.output.events.length, 1);
    assert.match(result.output.answer, /다른 작업: 대상 사건 미출력/);
    seen.push(result.answer);
  }
  assert.equal(new Set(seen).size, 3);
  assert.match(JSON.parse(seen[0]).answer, /사유 미출력이며 사료상 미확정을 뜻하지/);
  assert.match(JSON.parse(seen[2]).answer, /모순/);
});

test('unsupported calendar/regnal fields and source layout remain unverified', () => {
  const c = fixture('음력 9월 4일에 기록을 편찬하였다.');
  const e = event(c, { evidence: [quote(c, '음력 9월 4일에 기록을 편찬하였다.')] });
  unverified(c, { ...e, date: { ...e.date, calendar: 'solar' } }, 'calendar-conflict');
  unverified(c, { ...e, date: { ...e.date, calendar: 'other' } }, 'unsupported-calendar');
  unverified(c, { ...e, date: { ...e.date, regnalYear: 9 } }, 'unsupported-date-fields');
  const repeated = { ...c, sourceText: c.sourceText + '\n기사 표제 날짜: 1452년 8월 1일' };
  unverified(repeated, e, 'ambiguous-source-layout');
});

test('plain body text supports explicit dates without a source envelope', () => {
  const c = { sourceText: '1451년 9월 4일에 기록을 편찬하였다.', question: '편찬일은?',
    targets: [{ id: 'build', label: '기록 편찬' }], kind: 'event' };
  const e = { id: 'build', date: { year: null, month: null, day: null, calendar: null },
    unknownDay: false, evidence: [quote(c, c.sourceText)] };
  const result = derive(c, [e]);
  assert.deepEqual(result.output.events[0].date, { year: 1451, month: 9, day: 4, calendar: null });
});

test('renderer is method-neutral: equal output fields imply byte-identical final T/V answers', () => {
  for (const [body, date, unknownDay] of [
    ['9월 4일에 기록을 편찬하였다.', { year: 1451, month: 9, day: 4, calendar: 'lunar' }, false],
    ['이달에 기록을 편찬하였다.', { year: 1451, month: 7, day: null, calendar: 'lunar' }, true],
    ['그달에 기록을 편찬하였다.', { year: null, month: 9, day: null, calendar: null }, false],
  ]) {
    const c = fixture(body), input = raw([event(c, { date, unknownDay })]);
    const t = transformAnswer(c, input, T), v = transformAnswer(c, input, V);
    assert.deepEqual(JSON.parse(t.answer).events, JSON.parse(v.answer).events);
    assert.equal(t.answer, v.answer);
    assert.notDeepEqual(t.audit.events[0], v.audit.events[0]);
    for (const result of [t, v]) {
      assert.doesNotMatch(result.answer, /\bP\b|\bT\b|\bV\b|render-only|evidence-validated|표시 전용|검사:|미검증|정밀도|precision-checked|unsupported-/);
    }
  }
});

test('checker reasons stay in audit even when V changes values; re-rendering values with T is identical', () => {
  const c = fixture(), v = derive(c, [event(c)]);
  const t = transformAnswer(c, raw(v.output.events), T);
  assert.equal(t.answer, v.answer);
  assert.notDeepEqual(t.audit, v.audit);
  assert.doesNotMatch(v.output.answer, /P|미검증|검사|표시 전용|정밀도|원래 값/);
});

test('semantically wrong event quotation is not certified by quote existence', () => {
  const c = fixture('9월 4일에 별개의 행사를 열었다.');
  const result = derive(c, [event(c, { evidence: [quote(c, '9월 4일에 별개의 행사를 열었다.')] })]);
  assert.equal(result.audit.events[0].status, 'precision-checked');
  assert.equal(result.audit.events[0].semanticLink, 'unverified-without-gold');
  assert.match(result.output.answer, /해당 사건과 근거의 의미상 연결.*인증하지/);
});

test('pure deterministic transformation never reads gold/type/category or mutates caller objects', () => {
  const c = fixture(), events = [event(c)], original = structuredClone({ c, events });
  for (const key of ['gold', 'type', 'category']) Object.defineProperty(c, key, { get() { throw new Error(`Forbidden: ${key}`); } });
  freeze(c); freeze(events);
  const input = raw(events);
  for (const method of DERIVED_METHODS) {
    const first = transformAnswer(c, input, method), second = transformAnswer(c, input, method);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(JSON.stringify(c), JSON.stringify(original.c));
    assert.deepEqual(events, original.events);
    const serialized = JSON.stringify(first);
    JSON.parse(first.answer).events[0].date.month = 12;
    first.audit.events[0].outputDate.month = 12;
    assert.equal(JSON.stringify(transformAnswer(c, input, method)), serialized);
  }
});

test('programmer errors propagate rather than becoming normal not-applied or unknown dates', () => {
  const c = fixture(), input = raw([event(c)]);
  assert.throws(() => transformAnswer(c, input, 'other'), RangeError);
  assert.throws(() => transformAnswer(c, {}, V), TypeError);
  assert.throws(() => transformAnswer({ ...c, targets: [] }, input, V), TypeError);
  assert.throws(() => transformAnswer({ ...c, targets: [c.targets[0], c.targets[0]] }, input, V), TypeError);
});
