// Called only from a trusted base checkout. PR text is data, never executable code.
module.exports = async function syncDependabotMetadata({ github, context }) {
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const pull_number = context.payload.pull_request.number;
  const params = { ...context.repo, pull_number };
  let { data: pr } = await github.rest.pulls.get(params);
  if (pr.user.login !== 'dependabot[bot]' || pr.user.type !== 'Bot' ||
      pr.head.repo?.full_name !== repository || !pr.head.ref.startsWith('dependabot/') ||
      pr.base.ref !== 'dev' || pr.base.repo?.full_name !== repository) return;

  const marker = `<!-- dependabot-pr: ${repository}#${pull_number} -->`;
  // REST listing avoids the search index delay after an issue was just created.
  // Re-runs recover the same issue even if the previous PR-body update failed.
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...context.repo, state: 'all', creator: 'github-actions[bot]', per_page: 100,
  });
  let issue = issues.find(item => !item.pull_request &&
    item.user?.login === 'github-actions[bot]' && item.body?.split('\n').includes(marker));

  if (pr.state !== 'open') {
    // Merged PRs close their issue through Resolves. Superseded/cancelled
    // Dependabot PRs should not leave an orphaned automatic task behind.
    if (!pr.merged && issue?.state === 'open') {
      await github.rest.issues.update({ ...context.repo, issue_number: issue.number,
        state: 'closed', state_reason: 'not_planned' });
    }
    return;
  }
  if (!issue) {
    ({ data: issue } = await github.rest.issues.create({
      ...context.repo,
      title: `chore: 의존성 업데이트 검토 (PR #${pull_number})`,
      body: `${marker}\n\nDependabot이 제안한 [PR #${pull_number}](${pr.html_url})의 의존성 변경을 검토합니다.\n\n- 변경 이유와 호환성 확인\n- CI 검사 통과 및 필요한 동작 확인\n- 팀원 리뷰 후 dev 병합\n\nPR 병합 시 이 이슈가 자동 종료됩니다. 자동 병합은 사용하지 않습니다.`,
      assignees: ['minjun-ludigames2019'], labels: ['task', '🐳 infra'],
    }));
  } else if (issue.state === 'closed' && issue.state_reason === 'not_planned') {
    await github.rest.issues.update({ ...context.repo, issue_number: issue.number,
      state: 'open', state_reason: 'reopened' });
  }

  // Read again to preserve any Dependabot release notes updated during the run.
  ({ data: pr } = await github.rest.pulls.get(params));
  if (pr.state !== 'open') return;
  const oldPrefix = /^## 📌 관련된 이슈 \(Issue Number\)\n\n- Resolves #\d+\n\n## 의존성 업데이트\n\n<!-- dependabot-managed-issue: \d+ -->\n\n/;
  const original = (pr.body ?? '').replace(/\r\n?/g, '\n').replace(oldPrefix, '');
  const body = `## 📌 관련된 이슈 (Issue Number)\n\n- Resolves #${issue.number}\n\n## 의존성 업데이트\n\n<!-- dependabot-managed-issue: ${issue.number} -->\n\n${original}`;
  const title = /^(feat|fix|docs|chore|test|refactor):\s+\S/.test(pr.title)
    ? pr.title : `chore: ${pr.title}`;
  if (body !== pr.body || title !== pr.title) {
    await github.rest.pulls.update({ ...params, title, body });
  }
  // Dependabot PRs can be reviewed by the PM; no review request on every rebase.
  const { data: reviews } = await github.rest.pulls.listReviews({ ...params, per_page: 100 });
  if (!reviews.some(review => review.user?.login === 'minjun-ludigames2019') &&
      !pr.requested_reviewers?.some(user => user.login === 'minjun-ludigames2019')) {
    await github.rest.pulls.requestReviewers({ ...params, reviewers: ['minjun-ludigames2019'] });
  }
};
