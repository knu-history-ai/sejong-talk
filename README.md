# 세종톡 · Sejong Talk

세종과 글과 음성으로 대화하는 교육용 웹 서비스입니다. 첫 MVP는 세종에 집중하고, 장영실·이순신은 후속 인물로 확장합니다.

현재 저장소는 공통 개발 환경과 협업 설정을 준비한 단계입니다. AI 대화·음성 인식·음성 합성은 아직 구현하지 않았습니다.

## 시작하기

Node.js **24.x**와 npm을 사용합니다. `node --version`이 `v24.`로 시작하는지 확인하세요. 다른 버전이면 먼저 Node 24로 전환합니다. nvm을 이미 사용하는 경우 `nvm install` 후 `nvm use`를 실행하면 `.nvmrc`의 버전이 적용됩니다.

### 처음 실행하기

```bash
git clone https://github.com/knu-history-ai/sejong-talk.git
cd sejong-talk
git switch dev
node --version
npm --version
npm ci
npm run dev
```

브라우저에서 http://localhost:3000 을 열어 **세종톡 / 공통 개발 환경** 문구가 보이는지 확인합니다. 현재는 초기 화면이며 대화 기능은 아직 없습니다. 종료는 터미널에서 `Ctrl+C`입니다.

현재 앱은 **API 키와 `.env.local` 없이 실행**됩니다. 공급자를 정한 후 필요한 서버용 변수 이름만 `.env.example`에 추가하고, 실제 키는 Git에서 제외된 `.env.local`에 저장합니다. 키나 개인 자료를 이슈에 붙이지 않습니다.

### 작업 전후 검사

프로젝트 폴더의 별도 터미널에서 실행합니다. CI도 같은 순서로 검사합니다.

```bash
npm run lint
npm run typecheck
npm run build
```

빌드 결과를 직접 실행하려면 개발 서버를 종료하고 `npm run start` 후 같은 주소를 엽니다. `npm run dev`와 `npm run build`는 동시에 실행하지 않습니다.

### 실행이 안 될 때

- `EBADENGINE`: `node --version`을 확인하고 Node 24로 전환한 뒤 `npm ci`를 다시 실행합니다.
- `package.json`을 찾지 못함: 터미널이 `sejong-talk` 폴더에 있는지 확인합니다.
- 3000 포트 사용 중: 기존 서버를 종료하거나 `npm run dev -- --port 3001`로 실행하고 http://localhost:3001 을 엽니다.
- 설치·검사 실패: 운영체제, Node/npm 버전, 실행한 명령과 오류를 [W01-01 이슈](https://github.com/knu-history-ai/sejong-talk/issues/9)에 남깁니다. 잠금 파일을 삭제하거나 임의로 패키지를 업그레이드하지 않습니다.

### 전원 실행 확인

각자 자신의 컴퓨터에서 확인한 뒤 [W01-01 이슈](https://github.com/knu-history-ai/sejong-talk/issues/9)에 아래 형식으로 댓글을 남깁니다. 아직 실행하지 않은 항목은 미확인으로 씁니다.

```text
이름 / 운영체제:
브랜치 / 커밋 (git branch --show-current / git rev-parse --short HEAD):
Node / npm 버전:
npm ci:
기본 화면 표시:
lint / typecheck / build:
막힌 점: 없음 또는 오류 내용
```

## 협업

- 기본 브랜치: `dev`
- 기능 작업: 작업 브랜치 → PR → `dev` (Squash)
- 배포: `dev` → PR → `main` (Merge commit)
- 리뷰 1명과 CI 통과 후 병합합니다.
- 이슈 종료는 dev 반영 완료를 뜻하며 실제 배포는 별도로 기록합니다.

[기획·요구사항 문서](proposal/README.md) · [협업 규칙](CONTRIBUTING.md) · [폴더 구조와 담당 경계](docs/ARCHITECTURE.md) · [개발 보드](https://github.com/orgs/knu-history-ai/projects/1)

## 담당

| 담당 | 역할 |
|---|---|
| 박민준 | PM, 공통 환경·규격, 통합·배포·비용 |
| 변선영 | 대화 화면과 UI 흐름 |
| 임정민 | AI 답변 생성·검증 |
| 이유진 | 음성 입력·STT |
| 김시연 | 음성 출력·TTS, 콘텐츠·평가 |

구체적 첫 작업과 기한은 Issues에서 관리합니다. API 키·개인 설문·메일·사용자 대화 원본은 저장소에 올리지 않습니다.
