# 협업 규칙

브랜치 흐름은 작업 브랜치 → dev → main이다. 기본 브랜치는 dev, 배포 브랜치는 main이다. 폴더별 코드는 역할 담당자가 우선 관리하며 공통 규격 변경은 연결 담당자와 함께 확인한다.

1. 이슈에 목표·범위·완료 기준·담당자 1명을 적고 기한은 합의한 값만 기록한다.
2. 최신 dev에서 feat/12-voice-input, fix/18-audio-stop, docs/20-readme처럼 작업 브랜치를 만든다.
3. 기능 PR의 대상은 dev다. 변경 동작·실제 확인 결과를 적고 다른 학생 1명에게 리뷰를 요청한다.
4. 승인과 app-check, pr-title-check, branch-policy-check 통과 후 Squash and merge한다. pr-title-check는 제목과 PR 최상단의 이슈 형식을 함께 검사한다. 병합한 작업 브랜치는 재사용하지 않는다.
5. 모든 PR은 아래 관련 이슈 섹션으로 시작한다. 실제 해결하는 이슈 번호를 쓰고, 일부 작업만 완료한다면 이번 PR 범위의 별도 이슈를 연결한다. 이슈 종료는 기본 브랜치 dev에 반영됐다는 뜻이며 실제 배포 완료와 구분한다.
6. 통합 확인 후 dev → main 배포 PR을 연다. 제목 예: chore: v0.1.0 배포 준비. 리뷰·CI 통과 후 Create a merge commit으로 병합한다. dev → main에 Squash/Rebase를 사용하지 않는다.
7. dev와 main은 삭제하지 않으며 직접 push하거나 force push하지 않는다. 첫 공통 앱 초기화만 보호 규칙 생성 전에 진행한다.
8. 배포 PR 검토 중에는 dev에 추가 기능 병합을 잠시 멈춘다. main CI와 실제 배포 동작 확인 후 버전을 기록한다.
9. UI·AI·STT·TTS는 공통 타입과 샘플로 각각 시작한다. 실제 통합에는 공통 요청·응답 규격, 세션·취소 처리와 검토 자료가 필요하다.
10. API 키는 서버 환경 변수로 관리한다. PR CI는 유료 API를 호출하지 않는다. src/server와 내부 인물 데이터는 클라이언트에서 import하지 않는다.
11. 초기 CI는 lint·타입·빌드다. 기능이 생기면 핵심 동작의 자동 테스트를 추가하고 AI 사실성·음성 품질은 별도 시험 결과를 기록한다.

## PR 본문 시작 형식

웹·CLI·API·AI 에이전트로 작성하는 모든 PR과 Draft·배포 PR에 적용한다. `.github/PULL_REQUEST_TEMPLATE.md`를 사용한다.

```markdown
## 📌 관련된 이슈 (Issue Number)

- Resolves #35
```

`35`는 예시다. 실제 이슈가 없으면 작업 범위에 맞게 먼저 만들고 그 번호를 쓴다. 여러 이슈는 `- Resolves #번호`를 한 줄씩 적으며, 이 섹션에는 이슈 목록만 둔다. `Refs`, `Closes`, 단순 링크로 대체하지 않는다. 배포 PR은 배포 작업 이슈를 연결하며, 기본 브랜치가 아닌 `main` 병합에서는 자동 종료되지 않으므로 배포 확인 후 이슈를 정리한다.

AI 공통 규칙은 루트 `AGENTS.md`에 있다. `CLAUDE.md`는 이를 불러오며, Copilot은 `.github/copilot-instructions.md`에서도 같은 규칙을 안내받는다. 지침을 지원하지 않는 도구로 작성하더라도 GitHub 필수 검사에서 본문 형식을 확인한다.

개발 중 확인:

```bash
npm run lint
npm run typecheck
npm run build
```

폴더 담당과 첫 공통 규격은 개발 폴더 구조 안내를 참고해 저장소 docs에 정리한다. main 배포 PR은 같은 저장소의 dev에서만 보낸다. 긴급 수정도 초기에는 fix 브랜치 → dev → main으로 진행한다.
