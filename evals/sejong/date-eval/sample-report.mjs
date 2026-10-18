import { assert, hash } from './core.mjs';
import { validateSampleFinal } from './sampling.mjs';
import { validateAutomaticReport } from './automatic.mjs';
import { humanCost } from './costs.mjs';
import { readFileSync } from 'node:fs';

const FLAGS = ['unsupportedDay', 'missingKnownDay', 'headerConfusion'];
const bit = x => x === 0 || x === 1;
const sum = xs => xs.reduce((a, b) => a + b, 0);
const ratio = (n, d) => ({ numerator: n, denominator: d, value: d ? n / d : null,
  reason: d ? null : 'N/A: no eligible observations' });
function matrix(rows, error = false) {
  const counts = { human0: { automatic0: 0, automatic1: 0, failure: 0 },
    human1: { automatic0: 0, automatic1: 0, failure: 0 } };
  for (const r of rows) counts[`human${r.human}`][bit(r.automatic) ? `automatic${r.automatic}` : 'failure']++;
  const matched = counts.human0.automatic0 + counts.human1.automatic1;
  const failed = counts.human0.failure + counts.human1.failure;
  return { counts, eligible: rows.length, valid: rows.length - failed, failed,
    validAgreement: ratio(matched, rows.length - failed),
    agreementIncludingFailures: ratio(matched, rows.length), completion: ratio(rows.length - failed, rows.length),
    falseAcceptance: error ? counts.human1.automatic0 : counts.human0.automatic1,
    falseRejection: error ? counts.human0.automatic1 : counts.human1.automatic0,
    positiveMeaning: error ? 'error present' : 'correct' };
}
function aggregate(rows) {
  const completed = rows.filter(r => r.state === 'completed');
  return { planned: rows.length, completed: completed.length, failed: rows.length - completed.length,
    humanStructuredDate: ratio(sum(rows.map(r => r.human.structuredDate)), rows.length),
    humanSemanticDate: ratio(sum(rows.map(r => r.human.date)), rows.length),
    conditionalSemanticDate: ratio(sum(completed.map(r => r.human.date)), completed.length),
    completion: ratio(completed.length, rows.length),
    conditionalEvidence: ratio(sum(completed.map(r => r.human.evidence)), completed.length),
    semanticErrorRates: Object.fromEntries(FLAGS.map(flag => {
      const eligible = completed.flatMap(r => r.human.events.filter(e =>
        r.gold.events.find(g => g.id === e.id).eligibility[flag]));
      return [flag, ratio(sum(eligible.map(e => e[flag])), eligible.length)];
    })) };
}
function comparisons(rows, hasAi) {
  const completed = rows.filter(r => r.state === 'completed');
  return { scope: 'completed selected outputs only; generation failures excluded from grader agreement',
    codeVsHumanStructured: matrix(completed.map(r => ({ human: r.human.structuredDate, automatic: r.code.dateScore }))),
    // This is a semantic gap diagnostic, not an agreement test between identical constructs.
    structuredVsSemanticGap: { codePassButSemanticFail: completed.filter(r => r.code.dateScore === 1 && r.human.date === 0).length,
      codeFailButSemanticPass: completed.filter(r => r.code.dateScore === 0 && r.human.date === 1).length,
      evaluated: completed.length },
    aiVsHumanSemantic: hasAi ? Object.fromEntries(['date', 'evidence'].map(field => [field,
      matrix(completed.map(r => ({ human: r.human[field], automatic: r.ai?.[field] ?? null })))])) : null,
    aiVsHumanEventDate: hasAi ? matrix(completed.flatMap(r => r.gold.events.map(e => ({
      human: r.human.events.find(x => x.id === e.id).date,
      automatic: r.ai?.events?.find(x => x.id === e.id)?.date ?? null })))) : null,
    aiVsHumanErrors: hasAi ? Object.fromEntries(FLAGS.map(flag => [flag, matrix(completed.flatMap(r =>
      r.gold.events.filter(e => e.eligibility[flag]).map(e => ({ human: r.human.events.find(x => x.id === e.id)[flag],
        automatic: r.ai?.events?.find(x => x.id === e.id)?.[flag] ?? null }))), true)])) : null };
}

/** A sample audit never supplies human truth for unreviewed outputs. All scores are
 * replay-validated independently of the full-human legacy gate. */
export function buildSampleReport(plan, run, manifest, final, automatic, ai = null) {
  validateSampleFinal(plan, run, manifest, final);
  validateAutomaticReport(plan, run, automatic, ai);
  const code = new Map(automatic.items.map(i => [i.recordId, i]));
  const humans = new Map(final.items.map(i => [i.recordId, i]));
  const boundAi = ai ?? automatic.inputSnapshots?.ai ?? null;
  const ais = new Map((boundAi?.items ?? []).map(i => [i.recordId, i]));
  const rows = run.records.filter(r => manifest.caseIds.includes(r.caseId)).map(r => {
    const c = plan.dataset.cases.find(c => c.id === r.caseId);
    const human = humans.get(r.id);
    assert(human && code.has(r.id), 'missing selected audit score');
    return { ...r, articleId: c.articleId, questionType: code.get(r.id).questionType, kind: c.kind,
      human, code: code.get(r.id), ai: ais.get(r.id), gold: plan.gold.cases.find(g => g.id === r.caseId) };
  });
  const details = final.agreement.details;
  const firsts = details.flatMap(d => d.firstReviews);
  const resolutions = details.flatMap(d => d.adjudication ? [d.adjudication] : []);
  const group = subset => ({ event: aggregate(subset.filter(r => r.kind === 'event')),
    control: aggregate(subset.filter(r => r.kind === 'control')), graderValidation: comparisons(subset, boundAi !== null) });
  const questionTypes = Object.keys(manifest.questionTypes.available).sort();
  return { schemaVersion: 1, type: 'date-sample-report', evaluationVersion: manifest.version === 'article-one-v1'
    ? 'sample-audit-v1' : 'sample-audit-v2',
    evaluatorHash: hash(['sample-report.mjs', 'sampling.mjs', 'automatic.mjs', 'core.mjs', 'grading.mjs', 'costs.mjs']
      .map(name => [name, readFileSync(new URL(name, import.meta.url), 'utf8')])),
    planId: plan.id, datasetHash: plan.datasetHash, goldHash: plan.goldHash, criteriaHash: plan.criteriaHash,
    runHash: hash(run), manifestHash: manifest.manifestHash, manifestDocumentHash: hash(manifest),
    finalHash: hash(final), automaticHash: hash(automatic),
    aiHash: boundAi ? hash(boundAi) : null, auditComplete: true,
    humanValidationComplete: rows.some(r => r.state === 'completed'),
    humanValidationStatus: rows.some(r => r.state === 'completed') ? 'completed-sample-only' : 'not-assessable-no-completed-sample',
    paperEligible: false,
    scope: { articleCount: manifest.selectedArticleCount ?? manifest.articleCount,
      populationArticleCount: manifest.articleCount, selectedQuestions: manifest.caseIds.length,
      selectedPlannedOutputs: rows.length, populationQuestions: plan.dataset.cases.length,
      populationPlannedOutputs: run.records.length, independentUnit: 'article, not method outputs or repeats',
      questionTypes: manifest.questionTypes, selectionVersion: manifest.version, seed: manifest.seed,
      ...(manifest.version === 'article-one-v1' ? {} : {
        questionBudget: manifest.questionBudget, methodOutputCounts: manifest.methodOutputCounts }) },
    methods: plan.config.methods.map(m => { const selected = rows.filter(r => r.methodId === m.id);
      return { id: m.id, ...group(selected), byQuestionType: Object.fromEntries(questionTypes.map(type =>
        [type, group(selected.filter(r => r.questionType === type))])),
      byArticle: Object.fromEntries([...new Set(selected.map(r => r.articleId))].sort().map(articleId =>
        [articleId, group(selected.filter(r => r.articleId === articleId))])) };
    }),
    graderValidation: comparisons(rows, boundAi !== null),
    firstHumanAgreement: { numerator: final.agreement.numerator, denominator: final.agreement.denominator,
      value: final.agreement.value, reason: final.agreement.reason, scope: final.agreement.scope,
      byField: Object.fromEntries(['structuredDate', 'date', 'evidence'].map(field => [field,
        ratio(details.filter(d => d.firstReviews.every(r => bit(r[field]))
          && d.firstReviews[0][field] === d.firstReviews[1][field]).length, details.length)])),
      structuredDate: (() => {
        const valid = details.filter(d => d.firstReviews.every(r => bit(r.structuredDate)));
        return ratio(valid.filter(d => d.firstReviews[0].structuredDate === d.firstReviews[1].structuredDate).length, details.length);
      })(), pendingOrDisagreementBeforeReconciliation: details.filter(d => d.differences.length > 0).length },
    evaluationCost: { generationIncluded: false, independentFirstReviews: humanCost(firsts),
      reconciliations: humanCost(resolutions), total: humanCost([...firsts, ...resolutions]) },
    limitations: [
      'Human semantic results and grader confusion matrices apply only to the frozen sample, not the unreviewed population.',
      manifest.version === 'article-one-v1'
        ? 'One question per article can omit rare types; coverage is reported, not guaranteed.'
        : 'At most 12 type-balanced questions retain every method/repeat. Type presence does not guarantee rare-error coverage or statistical sufficiency; article spread is preferred, not guaranteed.',
      'No pass threshold, population debiasing/PPI, confidence interval or publication approval is inferred.',
      'Inspect false acceptances and method-specific errors. If conclusions depend on disagreements or small differences, expand validation or narrow claims.',
      'R/P/E/T/V from the same question and repeated outputs are correlated, not independent samples.',
      'Full automatic structured-date scores do not certify semantic correctness of prose or evidential support.',
    ] };
}
