import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sync from '../.github/scripts/dependabot-metadata.cjs';

function harness() {
  const repo = { owner: 'knu-history-ai', repo: 'sejong-talk' };
  const full_name = 'knu-history-ai/sejong-talk';
  const pr = { number: 100, title: 'Bump next to a patched version', body: 'Release notes\n\nCompatibility details',
    state: 'open', merged: false, html_url: 'https://github.com/' + full_name + '/pull/100',
    user: { login: 'dependabot[bot]', type: 'Bot' },
    head: { repo: { full_name }, ref: 'dependabot/npm_and_yarn/npm-security' },
    base: { repo: { full_name }, ref: 'dev' }, requested_reviewers: [] };
  const issues = [], reviews = [], calls = [];
  const context = { repo, payload: { pull_request: structuredClone(pr) } };
  const github = { rest: {
    pulls: {
      get: async () => ({ data: structuredClone(pr) }),
      update: async params => { calls.push(['updatePR', params]); Object.assign(pr, params); },
      listReviews: async () => ({ data: reviews }),
      requestReviewers: async params => {
        calls.push(['review', params]);
        pr.requested_reviewers = params.reviewers.map(login => ({ login }));
      },
    },
    issues: {
      listForRepo: () => {},
      create: async params => {
        calls.push(['createIssue', params]);
        const issue = { ...params, number: 200 + issues.length, state: 'open', user: { login: 'github-actions[bot]' } };
        issues.push(issue); return { data: structuredClone(issue) };
      },
      update: async params => {
        calls.push(['updateIssue', params]);
        Object.assign(issues.find(issue => issue.number === params.issue_number), params);
      },
    },
  }, paginate: async () => structuredClone(issues) };
  return { pr, issues, calls, reviews, github, context, run: () => sync({ github, context }) };
}

test('creates a real tracking issue, prefixes the PR and keeps original release notes', async () => {
  const h = harness(); const original = h.pr.body;
  await h.run();
  assert.equal(h.issues.length, 1);
  assert.match(h.pr.body, /^## 📌 관련된 이슈 \(Issue Number\)\n\n- Resolves #200\n/);
  assert.ok(h.pr.body.endsWith(original));
  assert.equal(h.pr.title, 'chore: Bump next to a patched version');
  assert.match(h.issues[0].body, /dependabot-pr: knu-history-ai\/sejong-talk#100/);
  assert.deepEqual(h.pr.requested_reviewers, [{ login: 'minjun-ludigames2019' }]);
});

test('retries do not duplicate issues, body headers or review requests', async () => {
  const h = harness(); await h.run(); const body = h.pr.body;
  await h.run(); await h.run();
  assert.equal(h.issues.length, 1);
  assert.equal(h.pr.body, body);
  assert.equal(h.calls.filter(([kind]) => kind === 'updatePR').length, 1);
  assert.equal(h.calls.filter(([kind]) => kind === 'review').length, 1);
});

test('recovers after issue creation succeeded but the PR update failed', async () => {
  const h = harness(); const update = h.github.rest.pulls.update;
  h.github.rest.pulls.update = async () => { throw new Error('transient failure'); };
  await assert.rejects(h.run(), /transient failure/);
  assert.equal(h.issues.length, 1);
  h.github.rest.pulls.update = update;
  await h.run();
  assert.equal(h.issues.length, 1);
  assert.match(h.pr.body, /Resolves #200/);
});

test('a Dependabot rebase that replaces its body reuses the issue and preserves new notes', async () => {
  const h = harness(); await h.run();
  h.pr.body = 'Updated release notes';
  h.pr.title = 'chore: Bump the npm-compatible group';
  await h.run();
  assert.equal(h.issues.length, 1);
  assert.ok(h.pr.body.endsWith('Updated release notes'));
  assert.equal(h.pr.title, 'chore: Bump the npm-compatible group');
});

test('uses authoritative API metadata and never mutates human, fork or non-dev PRs', async () => {
  for (const change of [
    pr => { pr.user.login = 'human'; },
    pr => { pr.user.type = 'User'; },
    pr => { pr.head.repo.full_name = 'attacker/fork'; },
    pr => { pr.head.ref = 'feature/fake-bot'; },
    pr => { pr.base.ref = 'main'; },
    pr => { pr.base.repo.full_name = 'attacker/base'; },
  ]) {
    const h = harness(); change(h.pr); await h.run();
    assert.deepEqual(h.calls, []);
  }
});

test('text resembling executable code stays ordinary PR text', async () => {
  const h = harness();
  h.pr.body = '${{ secrets.TOKEN }}; throw new Error("not code"); $(do-not-execute)';
  const original = h.pr.body; await h.run();
  assert.ok(h.pr.body.endsWith(original));
});

test('only an issue created by the workflow with the exact marker is reused', async () => {
  const h = harness();
  h.issues.push({ number: 10, user: { login: 'human' }, body: '<!-- dependabot-pr: knu-history-ai/sejong-talk#100 -->' });
  await h.run();
  assert.equal(h.issues.length, 2);
  assert.match(h.pr.body, /Resolves #201/);
});

test('closing an unmerged bot PR cancels its managed issue; reopening reuses it', async () => {
  const h = harness(); await h.run(); h.pr.state = 'closed';
  await h.run();
  assert.equal(h.issues[0].state_reason, 'not_planned');
  h.pr.state = 'open'; await h.run();
  assert.equal(h.issues.length, 1);
  assert.equal(h.issues[0].state, 'open');
});

test('merged PRs leave issue completion to GitHub Resolves, never cancel it', async () => {
  const h = harness(); await h.run(); h.pr.state = 'closed'; h.pr.merged = true;
  const count = h.calls.length; await h.run();
  assert.equal(h.calls.length, count);
});

test('a reviewer who already reviewed is not requested again on synchronization', async () => {
  const h = harness(); h.reviews.push({ user: { login: 'minjun-ludigames2019' }, state: 'APPROVED' });
  await h.run();
  assert.equal(h.calls.filter(([kind]) => kind === 'review').length, 0);
});

// Exercise the actual CI script, including its asynchronous metadata hand-off.
const yaml = readFileSync(new URL('../.github/workflows/pr-title.yml', import.meta.url), 'utf8');
const source = yaml.split('          script: |\n').at(-1).split('\n').map(line => line.replace(/^ {12}/, '')).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function runCheck(h, get) {
  const failures = []; let now = 0;
  h.github.rest.pulls.get = get;
  await new AsyncFunction('github', 'context', 'core', 'setTimeout', 'Date', source)(
    h.github, h.context, { setFailed: message => failures.push(message) },
    (resolve, ms) => { now += ms; resolve(); }, { now: () => now },
  );
  return failures;
}

test('CI waits for the automatic issue link and checks the updated body instead of the event snapshot', async () => {
  const h = harness(); let reads = 0;
  const failures = await runCheck(h, async () => {
    reads++;
    return { data: { ...h.pr, title: 'chore: update', body: reads < 3 ? '' : '## 📌 관련된 이슈 (Issue Number)\n\n- Resolves #200\n\n## 변경\n업데이트' } };
  });
  assert.equal(reads, 3);
  assert.deepEqual(failures, []);
});

test('a failed automatic link still fails CI after a bounded wait', async () => {
  const h = harness(); let reads = 0;
  const failures = await runCheck(h, async () => { reads++; return { data: h.pr }; });
  assert.ok(failures.length > 0);
  assert.ok(reads <= 31);
});

test('human PRs retain the strict issue format and do not use bot automation', async () => {
  const h = harness(); h.context.payload.pull_request.user.login = 'human';
  h.context.payload.pull_request.title = 'fix: something';
  for (const body of ['## 관련 이슈\nRefs #200', '', '## 📌 관련된 이슈 (Issue Number)\n\n- Resolves #']) {
    h.context.payload.pull_request.body = body;
    assert.ok((await runCheck(h, () => { throw new Error('Unexpected API call'); })).length > 0);
  }
  h.context.payload.pull_request.body = '## 📌 관련된 이슈 (Issue Number)\n\n- Resolves #200';
  assert.deepEqual(await runCheck(h, () => { throw new Error('Unexpected API call'); }), []);
});
