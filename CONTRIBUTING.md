# 협업 규칙

브랜치 흐름은 작업 브랜치 → dev → main이다. 기본 브랜치는 dev, 배포 브랜치는 main이다. 폴더별 코드는 역할 담당자가 우선 관리하며 공통 규격 변경은 연결 담당자와 함께 확인한다.

1. 이슈에 목표·범위·완료 기준·담당자 1명을 적고 기한은 합의한 값만 기록한다.
2. 최신 dev에서 feat/12-voice-input, fix/18-audio-stop, docs/20-readme처럼 작업 브랜치를 만든다.
3. 기능 PR의 대상은 dev다. 변경 동작·실제 확인 결과를 적고 다른 학생 1명에게 리뷰를 요청한다.
4. 승인과 app-check, pr-title-check, branch-policy-check 통과 후 Squash and merge한다. 병합한 작업 브랜치는 재사용하지 않는다.
5. 이슈를 전부 해결하면 Closes #번호, 일부면 Refs #번호를 쓴다. 이슈 종료는 기본 브랜치 dev에 반영됐다는 뜻이며 실제 배포 완료와 구분한다.
6. 통합 확인 후 dev → main 배포 PR을 연다. 제목 예: chore: v0.1.0 배포 준비. 리뷰·CI 통과 후 Create a merge commit으로 병합한다. dev → main에 Squash/Rebase를 사용하지 않는다.
7. dev와 main은 삭제하지 않으며 직접 push하거나 force push하지 않는다. 첫 공통 앱 초기화만 보호 규칙 생성 전에 진행한다.
8. 배포 PR 검토 중에는 dev에 추가 기능 병합을 잠시 멈춘다. main CI와 실제 배포 동작 확인 후 버전을 기록한다.
9. UI·AI·STT·TTS는 공통 타입과 샘플로 각각 시작한다. 실제 통합에는 공통 요청·응답 규격, 세션·취소 처리와 검토 자료가 필요하다.
10. API 키는 서버 환경 변수로 관리한다. PR CI는 유료 API를 호출하지 않는다. src/server와 내부 인물 데이터는 클라이언트에서 import하지 않는다.
11. 초기 CI는 lint·타입·빌드다. 기능이 생기면 핵심 동작의 자동 테스트를 추가하고 AI 사실성·음성 품질은 별도 시험 결과를 기록한다.

개발 중 확인:

```bash
npm run lint
npm run typecheck
npm run build
```

폴더 담당과 첫 공통 규격은 개발 폴더 구조 안내를 참고해 저장소 docs에 정리한다. main 배포 PR은 같은 저장소의 dev에서만 보낸다. 긴급 수정도 초기에는 fix 브랜치 → dev → main으로 진행한다.
