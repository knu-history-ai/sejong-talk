# 세종톡 PR 작성 규칙

- 사람과 AI가 만드는 모든 PR은 `.github/PULL_REQUEST_TEMPLATE.md`를 따른다. 웹, CLI, API로 만들거나 Draft로 여는 경우도 같다.
- PR 본문 최상단은 아래 형식으로 작성한다. `35`는 예시이며 반드시 이번 PR이 해결하는 실제 이슈 번호로 바꾼다.

```markdown
## 📌 관련된 이슈 (Issue Number)

- Resolves #35
```

- 여러 이슈를 해결하면 `- Resolves #번호`를 한 줄씩 적는다. 첫 섹션을 생략하거나 `Refs`, `Closes`, 단순 링크로 대체하지 않는다.
- 이슈가 없으면 작업 범위에 맞는 이슈를 먼저 만든다. 큰 이슈의 일부만 구현할 때는 이번 PR로 완료할 수 있는 별도 이슈를 연결해 미완료 작업이 닫히지 않도록 한다. 예시 번호나 무관한 이슈를 사용하지 않는다.
- 배포 PR도 같은 형식으로 배포 작업 이슈를 연결한다. 기본 브랜치 `dev`에서는 병합 시 자동 종료되지만 `main` 대상 PR은 자동 종료되지 않으므로 배포 확인 후 이슈를 별도로 정리한다.
- 이어지는 변경 내용·검증 결과는 실제 구현과 실행한 확인만 적는다. 기능 PR은 `dev`, 배포 PR은 `dev` → `main`이며, 자세한 규칙은 `CONTRIBUTING.md`를 따른다.
- PR 생성 후 본문과 이슈 번호를 다시 확인한다. 필수 검사 `pr-title-check`는 제목과 위 첫 섹션을 함께 검사하며, 실패하면 본문을 수정한다.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
