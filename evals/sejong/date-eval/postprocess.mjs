/**
 * Frozen, gold-free T/V policy. No I/O, clock, model call or core import.
 * Only whole JSON / one whole json or unlabelled fence is accepted. Schema
 * mismatches pass through verbatim; they are NOT generation failures or scores.
 *
 * V checks UTF-16, end-exclusive quotations, then Arabic-number Korean dates.
 * It uses only P's quoted spans, never a newly searched source date. A quoted
 * header may anchor a body quote starting with 이달[에] or 이날[에]. Only the
 * latter and a control question about 표제 can supply the header's day.
 * Explicit body month/day does not inherit an unquoted/implicit header year.
 * Negation, alternatives, ranges, other relatives, nonnumeric dates, multiple
 * dates in one quote and conflicting quotes stay unverified, retaining P values.
 * A month-only quote supports unknownDay, NOT absence of a day in the whole
 * historical source. Quote existence/precision NEVER certifies event semantics.
 * T/V share the renderer; P's original prose is preserved by the caller only.
 * Programmer errors (bad c / rawAnswer type / method) throw, not pass through.
 */
export const POSTPROCESS_VERSION = 'date-postprocess-v1';
export const DERIVED_METHODS = Object.freeze(['render-only', 'evidence-validated']);

const DATE_FIELDS = ['year', 'month', 'day', 'calendar'];
const SEMANTIC_LIMIT = 'unverified-without-gold';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const integer = value => Number.isSafeInteger(value);
const copy = value => JSON.parse(JSON.stringify(value));

function checkInput(c, rawAnswer, methodId) {
  if (!DERIVED_METHODS.includes(methodId)) throw new RangeError('Unknown derived method');
  if (typeof rawAnswer !== 'string') throw new TypeError('rawAnswer must be a string');
  if (!plain(c) || typeof c.sourceText !== 'string' || typeof c.question !== 'string'
    || !Array.isArray(c.targets) || c.targets.length === 0
    || !c.targets.every(t => plain(t) && text(t.id) && text(t.label))
    || new Set(c.targets.map(t => t.id)).size !== c.targets.length
    || !['control', 'event'].includes(c.kind)) throw new TypeError('Invalid postprocess input');
}

// JSON.parse alone silently overwrites duplicate object keys. Do not let that
// erase contradictory fields (including differently escaped copies of a key).
function duplicateKeys(json) {
  const stack = [];
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]/g;
  for (const token of json.matchAll(tokens)) {
    const value = token[0];
    if (value === '{' || value === '[') stack.push(value === '{' ? new Set() : null);
    else if (value === '}' || value === ']') stack.pop();
    else if (stack.at(-1) instanceof Set) {
      let after = token.index + value.length;
      while (/\s/.test(json[after] ?? '') && after < json.length) after++;
      if (json[after] !== ':') continue;
      const key = JSON.parse(value);
      if (stack.at(-1).has(key)) return true;
      stack.at(-1).add(key);
    }
  }
  return false;
}

function parse(raw, targets) {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  const json = fence ? fence[1] : trimmed;
  let value;
  try { value = JSON.parse(json); }
  catch { return { reason: 'invalid-whole-json' }; }
  if (duplicateKeys(json)) return { reason: 'duplicate-json-key' };
  if (!plain(value) || typeof value.answer !== 'string' || !Array.isArray(value.events)) {
    return { reason: 'schema-answer-or-events' };
  }
  if (value.events.length === 0) return { reason: 'schema-empty-events' };
  const ids = new Set();
  for (const e of value.events) {
    if (!plain(e) || !text(e.id)) return { reason: 'schema-event-id' };
    if (!targets.some(t => t.id === e.id)) return { reason: 'unknown-event-id' };
    if (ids.has(e.id)) return { reason: 'duplicate-event-id' };
    ids.add(e.id);
    if (!plain(e.date) || !DATE_FIELDS.every(f => Object.hasOwn(e.date, f))
      || !['year', 'month', 'day'].every(f => e.date[f] === null
        || (integer(e.date[f]) && e.date[f] > 0))
      || (e.date.month !== null && e.date.month > 12)
      || (e.date.day !== null && e.date.day > 31)
      || !(e.date.calendar === null || text(e.date.calendar))
      || typeof e.unknownDay !== 'boolean' || !Array.isArray(e.evidence)
      || !e.evidence.every(q => plain(q) && typeof q.quote === 'string'
        && integer(q.start) && integer(q.end))) return { reason: 'schema-event-fields' };
  }
  return { value, format: fence ? 'codefence' : 'bare-json' };
}

function layout(source) {
  const headers = [...source.matchAll(/^기사 표제 날짜:[^\r\n]*/gm)];
  const bodies = [...source.matchAll(/^본문:[\t ]*/gm)];
  return {
    headers: headers.map(m => ({ start: m.index, end: m.index + m[0].length })),
    // Without labels, an ordinary source is a body. With a labelled header,
    // require the body marker rather than treating intervening metadata as prose.
    bodyStart: bodies.length === 1 ? bodies[0].index + bodies[0][0].length
      : headers.length === 0 && bodies.length === 0 ? 0 : null,
    ambiguous: headers.length > 1 || bodies.length > 1,
  };
}

function quoteChecks(source, evidence) {
  return evidence.map((q, index) => ({ index,
    exists: q.quote.length > 0 && source.includes(q.quote),
    positionMatches: q.quote.length > 0 && q.start >= 0 && q.end > q.start
      && q.end <= source.length && source.slice(q.start, q.end) === q.quote,
  }));
}

// Include adjacent source words so a truncated quote cannot hide a negation,
// range or relative operator. Dates are still read ONLY from the quoted span.
function sentenceContext(source, q, bodyStart) {
  const boundary = /[.。!?！？;\r\n]/;
  let start = q.start, end = q.end;
  while (start > bodyStart && !boundary.test(source[start - 1])) start--;
  while (end < source.length && !boundary.test(source[end])) end++;
  return { text: source.slice(start, end), start };
}

const UNSUPPORTED = /아니|아닌|않|못|없|불명|미상|미확정|불확실|추정|가정|만약|여부|이전|이후|부터|까지|무렵|전후|또는|혹은|내지|초순|중순|하순|월말|월초|말일|초하루|보름|그믐|스무|닷새|첫날|마지막 날|[일이삼사오육칠팔구십백천]+[년월일]|윤달|윤\s*\d*월|그달|지난|다음|전달|익월|작년|올해|당년|전년|그해|지난해|익년|전날|이튿날|사흘|그날|오늘|당일|며칠|경(?:에|\s|$)|\d+\s*(?:일|달|개월|년)\s*(?:전|후|뒤)|[~〜∼?？–—-]/;

function numericDates(quote) {
  return [...quote.matchAll(/(?<!\d)(?:(\d{4})년\s*\)?\s*)?(\d{1,2})월(?:\s*(\d{1,2})일)?/g)];
}

function absolute(quote, header = false) {
  const matches = numericDates(quote);
  if (matches.length !== 1) return { reason: matches.length ? 'multiple-dates-in-quote' : 'no-supported-date' };
  const m = matches[0];
  const date = { year: m[1] ? Number(m[1]) : null, month: Number(m[2]), day: m[3] ? Number(m[3]) : null };
  if (date.year === 0 || date.month < 1 || date.month > 12 || (date.day !== null && (date.day < 1 || date.day > 31))) {
    return { reason: 'unsupported-date-range' };
  }
  const rest = quote.slice(0, m.index) + quote.slice(m.index + m[0].length);
  // In headers a numeric regnal year is allowed as text, but never converted.
  if ((header ? /\d+\s*[월일]/ : /\d+\s*[년월일]/).test(rest) || /이달|이날/.test(rest)) {
    return { reason: 'unsupported-date-expression' };
  }
  return { date, grammar: 'numeric-year-month-day' };
}

function calendarConflict(e, quotes) {
  const s = quotes.map(q => q.quote).join('\n');
  const lunar = /음력/.test(s), solar = /양력/.test(s);
  const aliases = { lunar: ['lunar', '음력', '실록 음력'], solar: ['solar', '양력'] };
  if (e.date.calendar !== null && !Object.values(aliases).flat().includes(e.date.calendar)) return 'unsupported-calendar';
  if ((lunar && solar) || (lunar && e.date.calendar !== null && !aliases.lunar.includes(e.date.calendar))
    || (solar && e.date.calendar !== null && !aliases.solar.includes(e.date.calendar))) return 'calendar-conflict';
  return null;
}

function validateEvent(c, e, regions, checks) {
  const no = reason => ({ status: 'unverified', reasons: [reason], checkedFields: [] });
  if (e.evidence.length === 0) return no('no-evidence');
  if (!checks.every(q => q.positionMatches)) return no('invalid-quote-position-or-text');
  if (regions.ambiguous) return no('ambiguous-source-layout');
  if (Object.keys(e.date).some(f => !DATE_FIELDS.includes(f))) return no('unsupported-date-fields');
  const calendarReason = calendarConflict(e, e.evidence);
  if (calendarReason) return no(calendarReason);
  const headerQuotes = [], bodyQuotes = [];
  for (const q of e.evidence) {
    if (regions.headers.some(h => q.start >= h.start && q.end <= h.end)) headerQuotes.push(q);
    else if (regions.bodyStart !== null && q.start >= regions.bodyStart) bodyQuotes.push(q);
    else return no('unsupported-quote-region');
  }
  const headerDates = [];
  for (const q of headerQuotes) {
    if (UNSUPPORTED.test(q.quote)) return no('unsupported-header-expression');
    const result = absolute(q.quote, true);
    if (!result.date) return no(result.reason);
    headerDates.push(result.date);
  }
  const same = dates => dates.every(d => ['year', 'month', 'day'].every(f => d[f] === dates[0][f]));
  if (headerDates.length && !same(headerDates)) return no('conflicting-header-quotes');
  const header = headerDates[0];
  const headerQuestion = c.kind === 'control' && /표제/.test(c.question);
  let candidates = [];
  if (headerQuestion) {
    if (!header || bodyQuotes.length) return no('header-question-needs-only-header-quotes');
    candidates = headerDates.map(date => ({ date, grammar: 'header-control' }));
  } else {
    if (bodyQuotes.length === 0) return no('header-without-explicit-body-link');
    for (const q of bodyQuotes) {
      const context = sentenceContext(c.sourceText, q, regions.bodyStart);
      if (UNSUPPORTED.test(context.text)) return no('unsupported-or-negated-context');
      // Inspect coverage, not a new date value: a clipped month/day token may
      // never turn a complete source date into a month-only assertion.
      const relativeTokens = [...context.text.matchAll(/(?:이달|이날)(?:에)?(?=\s|\d|$)(?:\s*\d{1,2}일)?/g)];
      if ([...numericDates(context.text), ...relativeTokens].some(m => {
        const start = context.start + m.index, end = start + m[0].length;
        return start < q.end && end > q.start && (start < q.start || end > q.end);
      })) return no('incomplete-date-quote');
      const relative = /^(이달|이날)(?:에)?(?=\s|\d|$)(?:\s*(\d{1,2})일)?/.exec(q.quote.trim());
      if (relative) {
        if (!header) return no('relative-without-quoted-header');
        const rest = q.quote.trim().slice(relative[0].length);
        if (/\d+\s*[년월일]|이달|이날/.test(rest)) return no('multiple-or-unsupported-relative-dates');
        const day = relative[1] === '이달' ? relative[2] ? Number(relative[2]) : null : header.day;
        if ((day !== null && (day < 1 || day > 31)) || (relative[1] === '이날' && relative[2])) {
          return no('unsupported-relative-date');
        }
        if (day === null && /\d+일/.test(context.text)) return no('month-only-with-day-in-context');
        candidates.push({ date: { year: header.year, month: header.month, day }, grammar: relative[1] === '이달' ? 'this-month' : 'this-day' });
      } else {
        const result = absolute(q.quote);
        if (!result.date) return no(result.reason);
        if (result.date.day === null && /\d+일/.test(context.text)) return no('month-only-with-day-in-context');
        candidates.push(result);
      }
    }
  }
  if (!same(candidates.map(r => r.date))) return no('conflicting-body-quotes');
  const supported = candidates[0].date;
  const date = { ...e.date, month: supported.month, day: supported.day };
  if (supported.year !== null) date.year = supported.year;
  return { status: 'precision-checked', reasons: ['quote-position-and-supported-grammar-only'],
    checkedFields: [...(supported.year !== null ? ['year'] : []), 'month', 'day'],
    grammars: candidates.map(r => r.grammar), supportedDate: supported,
    date, unknownDay: supported.day === null };
}

function dayState(e, validation) {
  if (validation.status === 'precision-checked') return e.date.day === null ? 'quoted-month-only' : 'quoted-day';
  if (e.date.day !== null) return e.unknownDay ? 'p-date-unknown-contradiction' : 'p-day';
  return e.unknownDay ? 'p-asserted-unknown' : 'null-without-reason';
}

// Value-only renderer: checker status/reasons must stay in audit. Equal output
// fields produce byte-identical T/V answers, including the common disclaimer.
function render(c, events, omitted) {
  const lines = events.map(e => {
    const date = ['year', 'month', 'day'].map((f, n) => e.date[f] === null ? '' : `${e.date[f]}${['년', '월', '일'][n]}`).filter(Boolean).join(' ');
    const calendar = e.date.calendar === null ? '달력 null(미출력)' : `달력: ${e.date.calendar}`;
    const day = e.date.day !== null
      ? e.unknownDay ? '일자 값과 unknownDay=true가 모순됩니다. 두 값을 함께 표시합니다.' : 'unknownDay=false.'
      : e.unknownDay ? '일자 미확정으로 표시되어 있습니다(unknownDay=true).'
        : '일자 null, unknownDay=false: 사유 미출력이며 사료상 미확정을 뜻하지 않습니다.';
    const nulls = ['year', 'month'].filter(f => e.date[f] === null).map(f => `${f}=null(값 미출력)`).join(', ');
    return `${c.targets.find(t => t.id === e.id).label}: ${date || '날짜 값 null(사유 미출력)'} (${calendar}). ${nulls ? `${nulls}. ` : ''}${day} 근거: ${JSON.stringify(e.evidence)}.`;
  });
  for (const id of omitted) lines.push(`${c.targets.find(t => t.id === id).label}: 대상 사건 미출력(일자 미확정과 구분).`);
  lines.push('날짜 필드와 인용문의 표시만으로 해당 사건과 근거의 의미상 연결이나 사료 전체의 일자 부재를 인증하지 않습니다.');
  return lines.join('\n');
}

export function transformAnswer(c, rawAnswer, methodId) {
  checkInput(c, rawAnswer, methodId);
  const parsed = parse(rawAnswer, c.targets);
  const base = { version: POSTPROCESS_VERSION, methodId, semanticLink: SEMANTIC_LIMIT,
    unverifiedPolicy: 'preserve-original-values' };
  if (!parsed.value) return { answer: rawAnswer, audit: { ...base, status: 'not-applied', applied: false, reason: parsed.reason } };
  const input = parsed.value;
  const regions = methodId === 'evidence-validated' ? layout(c.sourceText) : null;
  const events = [], audits = [];
  for (const original of input.events) {
    const e = copy(original);
    const checks = methodId === 'evidence-validated' ? quoteChecks(c.sourceText, e.evidence) : [];
    const validation = methodId === 'evidence-validated' ? validateEvent(c, e, regions, checks)
      : { status: 'not-checked', reasons: ['render-only'], checkedFields: [] };
    if (validation.status === 'precision-checked') {
      e.date = validation.date;
      e.unknownDay = validation.unknownDay;
    }
    audits.push({ id: e.id, status: validation.status, reasons: validation.reasons,
      semanticLink: SEMANTIC_LIMIT, quoteChecks: checks,
      checkedFields: validation.checkedFields, uncheckedFields: DATE_FIELDS.filter(f => !validation.checkedFields.includes(f)),
      ...(validation.grammars ? { grammars: validation.grammars, supportedDate: validation.supportedDate } : {}),
      originalDate: copy(original.date), outputDate: copy(e.date),
      originalUnknownDay: original.unknownDay, outputUnknownDay: e.unknownDay,
      dayState: dayState(e, validation),
      changed: JSON.stringify(original.date) !== JSON.stringify(e.date) || original.unknownDay !== e.unknownDay });
    events.push(e);
  }
  const omittedTargetIds = c.targets.filter(t => !events.some(e => e.id === t.id)).map(t => t.id);
  const answer = JSON.stringify({ ...input, answer: render(c, events, omittedTargetIds), events });
  return { answer, audit: { ...base, status: 'applied', applied: true,
    inputFormat: parsed.format, events: audits, omittedTargetIds } };
}
