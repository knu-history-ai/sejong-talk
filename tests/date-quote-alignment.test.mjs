import test from 'node:test';
import assert from 'node:assert/strict';
import { POSTPROCESS_VERSION, LEGACY_POSTPROCESS_VERSION, methodPostprocessVersion,
  transformAnswer } from '../evals/sejong/date-eval/postprocess.mjs';

// Synthetic only: no gold, final data, loader, model, network or filesystem.
const T = 'render-only', V = 'evidence-validated';
const header = '가상왕 5년(1501년) 9월 19일';
function fixture(body = '이달에 기록을 편찬하였다.') {
  return { sourceText: `기사 표제 날짜: ${header}\r\n본문: ${body}`, question: '기록 편찬 날짜는?',
    kind: 'event', targets: [{ id: 'build', label: '기록 편찬' }] };
}
const q = (value, start = -1) => ({ quote: value, start, end: start + value.length });
function event(c, evidence = [q(header), q(c.sourceText.split('본문: ')[1])]) {
  return { id: 'build', date: { year: 1501, month: 9, day: 19, calendar: 'lunar' }, unknownDay: false, evidence };
}
const raw = e => JSON.stringify({ answer: '보존할 P 원설명', events: [e] });
function derive(c, e, method = V, version = POSTPROCESS_VERSION) {
  const original = raw(e), result = transformAnswer(c, original, method, { version });
  return { ...result, output: JSON.parse(result.answer), original };
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('v2 recovers unique exact quotes despite wrong coordinates without altering P or evidence', () => {
  const c = freeze(fixture()), e = freeze(event(c)), before = raw(e);
  const v = derive(c, e), t = derive(c, e, T), old = derive(c, e, V, LEGACY_POSTPROCESS_VERSION);
  assert.equal(v.audit.version, 'date-postprocess-v2');
  assert.equal(v.audit.events[0].status, 'precision-checked');
  assert.equal(v.output.events[0].date.day, null); assert.equal(v.output.events[0].unknownDay, true);
  assert.equal(t.output.events[0].date.day, 19); assert.equal(t.output.events[0].unknownDay, false);
  assert.equal(old.audit.events[0].status, 'unverified'); assert.equal(old.answer, t.answer);
  assert.deepEqual(v.output.events[0].evidence, e.evidence);
  assert.deepEqual(t.output.events, [e]); assert.equal(raw(e), before);
  for (const check of v.audit.events[0].quoteChecks) {
    assert.equal(check.originalPositionMatches, false); assert.equal(check.originalExists, true);
    assert.equal(check.positionMatches, true); assert.equal(check.alignment.status, 'exact-search');
    assert.equal(c.sourceText.slice(check.alignment.start, check.alignment.end), check.alignment.quote);
  }
});

for (const change of [
  value => value.replace(/(\d+)([년월일자])/g, '$1 $2'),
  value => value.replaceAll('(', ' ( ').replaceAll(')', ' ) '),
  value => value.replaceAll(' ', '\t\u00a0\u3000\r\n'),
  value => value.replace(/\s/g, ''),
]) test('only whitespace changes may be matched, but dates come from original source spans', () => {
  const c = fixture(), e = event(c, [q(change(header)), q(change('이달에 기록을 편찬하였다.'))]);
  const v = derive(c, e);
  assert.equal(v.audit.events[0].status, 'precision-checked');
  assert.deepEqual(v.audit.events[0].supportedDate, { year: 1501, month: 9, day: null });
  assert.equal(v.output.events[0].date.day, null);
  assert.deepEqual(v.output.events[0].evidence, e.evidence);
  assert.ok(v.audit.events[0].quoteChecks.some(check => check.alignment.status === 'whitespace-search'));
  for (const check of v.audit.events[0].quoteChecks) {
    const a = check.alignment;
    assert.equal(c.sourceText.slice(a.start, a.end), a.quote);
    assert.ok(!/\d+\s+[년월일]/.test(a.quote));
  }
});

test('matching UTF-16 spans with emoji, CRLF and source whitespace preserves exact original offsets', () => {
  const c = fixture('😀 이달에 문서 (文書) 28자(字)를 편찬하였다.');
  const e = event(c, [q(header.replaceAll('년', ' 년')),
    q('이달에 문서(文書) 28 자 (字) 를 편찬하였다.')]);
  const v = derive(c, e), check = v.audit.events[0].quoteChecks[1];
  assert.equal(v.audit.events[0].status, 'precision-checked');
  assert.equal(check.alignment.start, c.sourceText.indexOf('이달에'));
  assert.equal(check.alignment.quote, '이달에 문서 (文書) 28자(字)를 편찬하였다.');
  assert.equal(c.sourceText.slice(check.alignment.start, check.alignment.end), check.alignment.quote);
});

for (const body of ['9월 4일에 기록을 편찬하였다. 9월 4일에 기록을 편찬하였다.',
  '9월 4일에 기록을 편찬하였다. 9월  4일에 기록을 편찬하였다.']) {
  test('ambiguous exact/whitespace recovery never chooses the first candidate', () => {
    const c = fixture(body), e = event(c, [q(body.includes('  ') ? '9 월 4 일에 기록을 편찬하였다.' : '9월 4일에 기록을 편찬하였다.')]);
    const v = derive(c, e), check = v.audit.events[0].quoteChecks[0];
    assert.equal(check.alignment.status, 'ambiguous'); assert.equal(check.alignment.candidateCount, 2);
    assert.equal(check.positionMatches, false);
    assert.deepEqual(v.audit.events[0].reasons, ['ambiguous-quote-alignment']);
    assert.deepEqual(v.output.events, [e]); assert.equal(v.answer, derive(c, e, T).answer);
  });
}

test('a supplied exact valid position remains usable even when that quotation occurs twice', () => {
  const body = '9월 4일에 편찬하였다. 9월 4일에 편찬하였다.', c = fixture(body);
  const value = '9월 4일에 편찬하였다.', start = c.sourceText.lastIndexOf(value);
  const v = derive(c, event(c, [q(value, start)]));
  assert.equal(v.audit.events[0].status, 'precision-checked');
  assert.equal(v.audit.events[0].quoteChecks[0].alignment.status, 'provided-position');
  assert.equal(v.audit.events[0].quoteChecks[0].alignment.start, start);
});

for (const value of [header.replace('19일', '18일'), header.replace('년', '年'),
  header.replace('(', '[').replace(')', ']'), header.replace('가상왕', '다른왕'),
  header.replace('1501', '１５０１'), header.replace('9월', '9\u200b월'), '', '   ']) {
  test(`non-whitespace changes or empty evidence are not repaired: ${JSON.stringify(value)}`, () => {
    const c = fixture(), e = event(c, [q(value), q('이달에 기록을 편찬하였다.')]);
    const v = derive(c, e);
    assert.equal(v.audit.events[0].status, 'unverified');
    assert.equal(v.audit.events[0].quoteChecks[0].alignment.status, 'not-found');
    assert.deepEqual(v.output.events, [e]); assert.equal(v.answer, derive(c, e, T).answer);
  });
}

for (const [body, quotation, reason] of [
  ['9월 4일에 편찬한 것은 아니었다.', '9월 4일', 'unsupported-or-negated-context'],
  ['9월 4일부터 9월 8일까지 편찬하였다.', '9월 4일', 'unsupported-or-negated-context'],
  ['9월 4일 또는 9월 8일에 편찬하였다.', '9월 4일', 'unsupported-or-negated-context'],
  ['다음 달 4일에 편찬하였다.', '다음 달 4일', 'unsupported-or-negated-context'],
  ['8월 4일에 편찬하였다.', '8월', 'incomplete-date-quote'],
  ['9월 4일과 9월 8일에 편찬하였다.', '9월 4일과 9월 8일', 'multiple-dates-in-quote'],
]) test(`recovered spans retain conservative source/context checks: ${reason}`, () => {
  const c = fixture(body), e = event(c, [q(quotation.replace(/(\d+)([월일])/g, '$1 $2'))]);
  const v = derive(c, e);
  assert.equal(v.audit.events[0].status, 'unverified');
  assert.deepEqual(v.audit.events[0].reasons, [reason]);
  assert.equal(v.answer, derive(c, e, T).answer);
});

test('one recovered quote never hides another absent or ambiguous quote', () => {
  const c = fixture(), e = event(c, [q(header), q('자료에 없는 다른 인용문')]);
  const v = derive(c, e);
  assert.equal(v.audit.events[0].status, 'unverified');
  assert.equal(v.audit.events[0].quoteChecks[0].positionMatches, true);
  assert.equal(v.audit.events[0].quoteChecks[1].positionMatches, false);
  assert.deepEqual(v.output.events, [e]);
});

for (const quotation of ['9월', '9월 19', '9월 1', '501년) 9월 19일', '1501년) 9월']) {
  test(`clipped header dates cannot erase precision after quotation recovery: ${quotation}`, () => {
    const c = fixture('이날에 기록을 편찬하였다.'), e = event(c, [q(quotation), q('이날에 기록을 편찬하였다.')]);
    const v = derive(c, e);
    assert.equal(v.audit.events[0].status, 'unverified');
    assert.deepEqual(v.audit.events[0].reasons, ['incomplete-date-quote']);
    assert.equal(v.answer, derive(c, e, T).answer);
    const control = { ...c, kind: 'control', question: '기사 표제 날짜는?' };
    const ce = event(control, [q(quotation)]);
    assert.equal(derive(control, ce).answer, derive(control, ce, T).answer);
  });
}

for (const lineBreak of ['\n', '\r\n', '\r']) {
  for (const continuation of ['아니었다.', '또는 9월 8일에 편찬하였다.', '이후에 편찬하였다.']) {
    test(`line wraps cannot hide original negation, alternatives or relative qualifiers: ${JSON.stringify(lineBreak + continuation)}`, () => {
      const c = fixture(`9월 4일에 편찬한 것은${lineBreak}${continuation}`);
      const e = event(c, [q('9 월 4 일에 편찬한 것은')]);
      const v = derive(c, e);
      assert.deepEqual(v.audit.events[0].reasons, ['unsupported-or-negated-context']);
      assert.equal(v.answer, derive(c, e, T).answer);
      // This is a v2 policy correction; stored v1 plans keep their old window.
      const exact = { ...e, evidence: [{ quote: '9월 4일에 편찬한 것은', start: c.sourceText.indexOf('9월 4일에'),
        end: c.sourceText.indexOf('9월 4일에') + '9월 4일에 편찬한 것은'.length }] };
      assert.equal(derive(c, exact, V, LEGACY_POSTPROCESS_VERSION).audit.events[0].status, 'precision-checked');
    });
  }
}

test('line wrapping alone does not prevent a supported date, and header qualifiers are not clipped away', () => {
  const c = fixture('9월 4일에\n기록을 편찬하였다.'), e = event(c, [q('9 월 4 일에 기록을 편찬하였다.')]);
  assert.equal(derive(c, e).audit.events[0].status, 'precision-checked');
  const qualified = { ...fixture(), sourceText: fixture().sourceText.replace(header, header + ' 추정') };
  const v = derive(qualified, event(qualified));
  assert.deepEqual(v.audit.events[0].reasons, ['unsupported-header-expression']);
});

test('matching never upgrades the calendar or semantic link to historical correctness', () => {
  const c = fixture('양력 9월 4일에 편찬하였다.'), e = event(c, [q('양력 9 월 4 일에 편찬하였다.')]);
  const v = derive(c, e);
  assert.deepEqual(v.audit.events[0].reasons, ['calendar-conflict']);
  assert.equal(v.audit.events[0].semanticLink, 'unverified-without-gold');
  assert.deepEqual(v.output.events, [e]);
  assert.equal(Object.hasOwn(v.audit.events[0], 'score'), false);
});

test('v2 does not invent missing schema fields or repair malformed JSON', () => {
  const c = fixture(), e = event(c); delete e.evidence[0].start;
  for (const value of [raw(e), raw(event(c)) + ' trailing']) {
    const result = transformAnswer(c, value, V);
    assert.equal(result.audit.status, 'not-applied'); assert.equal(result.answer, value);
  }
});

test('old methods default to v1 and unknown policies cannot be silently accepted', () => {
  assert.equal(methodPostprocessVersion({ id: V }), LEGACY_POSTPROCESS_VERSION);
  assert.equal(methodPostprocessVersion({ id: T, postprocessVersion: POSTPROCESS_VERSION }), POSTPROCESS_VERSION);
  for (const postprocessVersion of ['future', null, undefined]) {
    assert.throws(() => methodPostprocessVersion({ id: V, postprocessVersion }), RangeError);
  }
  assert.throws(() => methodPostprocessVersion({ id: 'prompt-baseline' }), TypeError);
  const c = fixture();
  assert.throws(() => transformAnswer(c, raw(event(c)), V, { version: 'future' }), RangeError);
});
