# 세종톡 · Sejong Talk

세종과 글과 음성으로 대화하는 교육용 웹 서비스입니다. 첫 MVP는 세종에 집중하고, 장영실·이순신은 후속 인물로 확장합니다.

현재 저장소는 공통 개발 환경과 협업 설정을 준비한 단계입니다. AI 대화·음성 인식·음성 합성은 아직 구현하지 않았습니다.

## 시작하기

Node.js 24 LTS와 npm을 사용합니다.

```bash
npm ci
npm run dev
```

브라우저에서 http://localhost:3000 을 엽니다.

```bash
npm run lint
npm run typecheck
npm run build
```

실제 공급자 API는 선정 후 연결합니다. 필요한 환경 변수 이름은 `.env.example`에 기록하고 실제 키는 `.env.local`에 저장합니다.

## 협업

- 기본 브랜치: `dev`
- 기능 작업: 작업 브랜치 → PR → `dev` (Squash)
- 배포: `dev` → PR → `main` (Merge commit)
- 리뷰 1명과 CI 통과 후 병합합니다.
- 이슈 종료는 dev 반영 완료를 뜻하며 실제 배포는 별도로 기록합니다.

[협업 규칙](CONTRIBUTING.md) · [폴더 구조와 담당 경계](docs/ARCHITECTURE.md)

## 담당

| 담당 | 역할 |
|---|---|
| 박민준 | PM, 공통 환경·규격, 통합·배포·비용 |
| 변선영 | 대화 화면과 UI 흐름 |
| 임정민 | AI 답변 생성·검증 |
| 이유진 | 음성 입력·STT |
| 김시연 | 음성 출력·TTS, 콘텐츠·평가 |

구체적 첫 작업과 기한은 Issues에서 관리합니다. API 키·개인 설문·메일·사용자 대화 원본은 저장소에 올리지 않습니다.
