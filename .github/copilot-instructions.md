# 세종톡 저장소 지침

루트 `AGENTS.md`, `CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE.md`를 읽고 따른다.

모든 PR 본문은 아래 섹션으로 시작한다. `35`는 예시이므로 이번 PR이 해결하는 실제 이슈 번호로 바꾼다.

```markdown
## 📌 관련된 이슈 (Issue Number)

- Resolves #35
```

여러 이슈는 한 줄에 하나씩 적는다. `Refs`나 단순 링크로 대체하지 않는다. 미완료 상위 이슈를 닫지 않도록 PR의 완료 범위에 맞는 이슈를 사용한다. CLI/API로 생성하는 PR도 같은 템플릿을 사용하고, 생성 후 본문과 `pr-title-check` 결과를 확인한다.
