# 세종 프로젝트 개발 폴더 구조

2026-09-18 정리. 현재 기획의 Next.js·TypeScript 단일 앱과 확정된 역할분담에 맞춘 구현 구조 제안이다. API 공급자는 이 구조와 별개로 선택한다. 공통 앱과 기능별 빈 폴더를 생성했으며, API 경로와 각 기능 파일은 구현할 때 추가한다.

## 현재 만들어진 것과 앞으로 만들 것

- 실제 존재: Next.js 초기 화면, CI, `features`의 3개 기능 폴더, `server`의 6개 담당 폴더, `contracts`, `components/ui`, 인물 자료·샘플·평가 폴더.
- 기능 폴더는 대부분 `.gitkeep`만 있는 작업 공간이다. 폴더가 있다는 것은 기능이 구현됐다는 뜻이 아니다.
- 이번 추가: `proposal/README.md`. 기획서 원문은 아직 개발 저장소에 복사하지 않았다.
- 아래 트리의 API route, 공통 타입, 인물 JSON과 테스트 하위 폴더는 목표 구조다. 해당 작업을 시작할 때 만든다.
- 공통 샘플은 `tests/fixtures/`를 사용한다. 같은 데이터를 담는 최상위 `mock/`를 따로 만들지 않는다. 브라우저용 가짜 데이터만 두고 실제 사용자 자료·서버 비밀 설정은 넣지 않는다.

## 1 운영 폴더와 개발 폴더

```text
프로젝트를 보관할 상위 폴더/
  AWS-Capstone/       현재 운영 문서·메일·회의·개인 원본 자료
  sejong-talk/        새 GitHub 저장소와 연결할 개발 코드
```

두 폴더는 각각의 목적에 맞게 관리한다. 기존 AWS-Capstone 전체를 새 코드 저장소에 복사하지 않는다. 개발 폴더 이름과 실제 상위 경로는 프로젝트를 만들 때 정한다.

GitHub 브랜치는 같은 개발 폴더 안에서 git switch로 전환한다. dev-folder/main-folder를 따로 만들거나 폴더를 복사해 버전을 관리하지 않는다. 팀원들은 같은 저장소를 자기 컴퓨터에 clone한다.

## 2 저장소 구조

폴더는 책임 위치를 보여주는 설계다. 실제 내용이 생길 때 필요한 것부터 만든다. 별도 frontend/backend 프로젝트와 여러 package.json은 현재 필요하지 않다.

```text
sejong-talk/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── task.yml
│   │   └── bug.yml
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── workflows/
│       ├── ci.yml
│       ├── pr-title.yml
│       └── branch-policy.yml
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   ├── globals.css
│   │   └── api/
│   │       ├── sessions/
│   │       │   ├── route.ts
│   │       │   └── current/route.ts
│   │       ├── transcriptions/route.ts
│   │       ├── turns/route.ts
│   │       ├── requests/[id]/route.ts
│   │       └── speech/route.ts
│   ├── features/
│   │   ├── chat/                대화 화면·메시지·출처·입력 상태
│   │   ├── voice-input/         녹음·마이크 권한·인식문 수정
│   │   └── voice-output/        재생·정지·속도·브라우저 음원 정리
│   ├── components/
│   │   └── ui/                 여러 기능이 함께 쓰는 버튼·안내
│   ├── contracts/              브라우저와 서버의 공통 데이터 형식
│   │   ├── conversation.ts
│   │   ├── speech.ts
│   │   └── errors.ts
│   └── server/                 서버에서만 실행할 코드
│       ├── ai/                 답변 생성·인물 설정·답변 검증
│       ├── stt/                전사 API 연결
│       ├── tts/                합성 API 연결
│       ├── content/            검토 자료 로딩·출처 조회
│       ├── sessions/           세션 소유권·최근 대화·만료
│       └── requests/           요청 상태·취소·중복 방지·사용량
├── data/
│   └── characters/
│       └── sejong/
│           ├── character.json
│           ├── facts.json
│           ├── sources.json
│           └── examples.json
├── tests/
│   ├── fixtures/               가상 세션·샘플 답변·허용된 시험 음원
│   ├── unit/                   핵심 함수 동작 시험
│   ├── integration/            API·모듈 연결 시험
│   └── e2e/                    실제 화면 흐름 시험
├── evals/
│   └── sejong/                 사실성·말투·우회 요청 평가 사례
├── public/
│   └── images/                 공개해도 되는 이미지
├── proposal/                 팀 공유용 기획·요구사항·수행계획
│   └── README.md              문서 보관 기준 (본문 파일은 검토 후 추가)
├── docs/                     개발자가 따라야 할 연결·구조 규칙
│   ├── ARCHITECTURE.md
│   └── API_CONTRACT.md        W01-08에서 작성
├── .env.example                변수 이름과 빈 값
├── .gitignore
├── .nvmrc
├── CONTRIBUTING.md
├── README.md
├── package.json
└── package-lock.json
```

app의 page.tsx는 화면을, api/*/route.ts는 서버 요청의 입구를 정의한다. 나머지 features/server/contracts 구분은 이번 팀이 역할과 의존성을 관리하기 위한 선택이다. [Next.js 프로젝트 구조](https://nextjs.org/docs/app/getting-started/project-structure)

## 3 담당자별 작업 위치

| 담당 | 우선 수정할 위치 | 연결하는 사람 |
|---|---|---|
| 민준 | .github, 공통 환경, contracts, server/sessions, server/requests, 배포 | 전원 |
| 선영 | features/chat, components/ui, app/page.tsx·layout.tsx·globals.css | 유진·시연의 음성 UI와 연결 |
| 정민 | server/ai, app/api/turns/route.ts | 공통 세션·자료 조회·음성 출력 |
| 유진 | features/voice-input, server/stt, app/api/transcriptions/route.ts | 선영의 입력창과 연결 |
| 시연 | features/voice-output, server/tts, app/api/speech/route.ts | 정민의 승인된 답변과 연결 |
| 시연, 민준 지원 | data/characters/sejong, evals/sejong | 정민의 근거·출처 검사와 연결 |

server/content의 데이터 로딩은 민준이 공통 형식에 맞춰 준비하고 정민·시연과 확인하는 안이다. 공유 영역은 민준 혼자 모든 로직을 작성해야 한다는 뜻은 아니며 책임과 연결 창구를 정한 것이다. 구현 상세와 기한은 팀에서 합의한다.

package.json, 공통 타입, app/page.tsx처럼 여러 명이 건드릴 파일은 변경 전 공유한다. 선영은 화면에 각 음성 컴포넌트를 배치하고, 유진·시연은 각자의 features 폴더 안에서 기능을 구현하면 동일 파일 충돌을 줄일 수 있다.

## 4 코드가 연결되는 방식

```text
화면 기능(features)
  → /api/... 요청
  → app/api/.../route.ts에서 입력·세션 확인
  → server/...의 기능 호출
  → contracts 형식으로 응답
  → 화면 갱신
```

예를 들어 음성 입력은 voice-input이 녹음을 담당하고 /api/transcriptions를 호출한다. 해당 route.ts가 요청을 확인한 뒤 server/stt의 transcribe 함수를 호출한다. 결과를 수정한 다음 대화 요청은 별도로 /api/turns에 보낸다.

route.ts 안에 모든 공급자 SDK·프롬프트·자료 검색을 넣지 않고, 실제 처리는 server의 해당 기능에 둔다. MVP에서 여러 공급자를 동시에 구현할 필요는 없다. 공급자 연결 파일을 분리해 교체 범위를 줄이면 된다.

## 5 공통 형식을 먼저 맞출 항목

민준이 docs/API_CONTRACT.md와 src/contracts에 초안을 만들고 담당자들이 확인한다. 기존 PRD 7·8장의 기준안을 사용한다.

- 전사: requestId, text, 처리 상태.
- 답변: requestId와 answerId, kind, text, factIds, sources 등.
- 음성 합성: requestId와 서버에 등록된 answerId를 보내고 처리 상태 또는 음원을 받음.
- 오류: code, message, retryable, requestId 등.
- 취소·초기화: 어떤 요청을 중단하고 이전 결과를 어떻게 무시할지.

STT/TTS를 각자 구현해도 요청 ID·오류·취소 규격이 다르면 연결할 때 다시 고쳐야 한다. 처음에는 이 데이터 형식과 샘플부터 정하고 실제 API 구현을 병렬로 진행한다.

각 기능의 컴포넌트 입력·출력도 짧게 맞춘다. 예: 음성 입력은 확인한 문자열을 전달하고, 음성 출력은 answerId와 재생 상태를 사용한다. 구체적 함수 이름까지 미리 과하게 정할 필요는 없다.

## 6 서버 전용 코드와 공개 파일 구분

- features와 브라우저 컴포넌트는 src/server를 직접 import하지 않고 API로 요청한다.
- server 경로는 이름만으로 접근 제한이 생기지 않는다. 구현 때 server-only 패키지와 import를 적용해 클라이언트 import 실수를 빌드에서 잡는다.
- contracts는 데이터 형식만 공유한다. API 키·공급자 클라이언트·서버 저장소를 넣지 않는다.
- data/characters의 내부 인물 설정·검토 자료는 서버 로더에서 읽고, 화면에는 필요한 답변·출처만 전달한다.
- public에 넣은 파일은 웹에서 직접 접근 가능하다. 원본 녹음·사용자 대화·키·내부 자료를 넣지 않는다.
- NEXT_PUBLIC_ 변수는 브라우저에 노출될 수 있으므로 API 키에는 사용하지 않는다.
- JSON 인물 데이터와 런타임 세션 저장소를 구분한다. 사용자 대화와 음성을 Git 파일로 누적하지 않는다.

[Next.js 서버·클라이언트 경계](https://nextjs.org/docs/app/getting-started/server-and-client-components), [환경 변수](https://nextjs.org/docs/app/guides/environment-variables)

## 7 테스트와 확장

tests의 하위 폴더와 테스트 도구는 실제 검증할 기능이 생길 때 추가한다. 초기 CI의 lint·타입·빌드가 기능 테스트를 대신하는 것은 아니다. 요청 취소, 출처 검사, 음원 재사용 같은 핵심 동작부터 자동화한다.

evals에는 인사, 역사 질문, 자료 부족, 페르소나 변경 요청 등 대표 사례를 둔다. 실제 유료 API 평가는 기본 PR CI와 구분하고, 원문 대화나 개인정보를 공개 결과에 넣지 않는다.

장영실·이순신을 추가할 때 data/characters/jang-yeongsil, data/characters/yi-sun-sin처럼 자료를 늘릴 수 있다. characterId를 공통 규격에 유지하고 사람마다 화면·서버 전체를 복사하지 않는다. MVP 화면은 세종 한 명에 집중하며 다중 인물 선택 UI를 지금 구현할 필요는 없다.

## 8 충돌을 줄이는 수정 규칙

폴더 담당자는 우선 조율 창구다. 다른 사람이 수정할 수 없다는 의미는 아니다.

| 공통으로 바뀌기 쉬운 곳 | 변경 방식 |
|---|---|
| `src/contracts/`, `docs/API_CONTRACT.md`, `tests/fixtures/` | 민준이 W01-08 초안을 작성하고 각 기능 담당자와 확인. 형식 변경 시 타입·문서·샘플을 같은 PR에서 수정 |
| `src/app/page.tsx`, `layout.tsx`, `globals.css` | 선영이 화면 조립. 유진·시연은 자기 기능 컴포넌트와 사용 방법을 전달 |
| `package.json`, `package-lock.json`, 설정·CI | 필요한 패키지와 이유를 이슈에 먼저 공유. 잠금 파일은 npm으로 갱신하고 수동 병합하지 않음 |
| `data/characters/`, `evals/` | 시연이 형식·결과 취합, 내용 조사·검토는 전원. 정민과 답변 생성·평가 입력 형식을 맞춤 |
| `proposal/` | 민준이 승인된 문서의 반영을 조율. 역할·일정 변경을 파일만 바꿔 확정하지 않음 |

각 작업은 최신 dev에서 별도 브랜치로 시작한다. 같은 파일을 동시에 수정할 일이 생기면 이슈에서 범위를 먼저 나누고, 공통 형식을 바꾸는 PR을 먼저 합친 뒤 나머지 브랜치에 반영한다. 폴더 구분만으로 충돌이 없어지는 것은 아니다.

현재 MVP에는 별도 Spring/Python 프로젝트, Docker, DB 초기화 스크립트를 구조만 맞추기 위해 추가하지 않는다. 실제 배포·저장 방식에서 필요해지면 담당 작업의 PR로 추가한다.

## W03-02 사용량·비용·요청 한도 (2026-10-06)

`src/server/usage`는 Node 24의 기본 SQLite로 공급자별 호출 단계·모델·토큰·오디오 길이·문자 수·지연·성공/실패/취소를 기록한다. 질문·답변 원문, 음성 파일과 API 키는 원장에 넣지 않는다. 기본 파일은 Git에서 제외되는 `private/usage/ledger.sqlite`다. 일·월 비용 합계는 한국 시간 기준이며 새 세션과 서버 재시작으로 초기화되지 않는다.

현재 멘토 방침에 따라 유료 호출은 허용하지 않는다. `.env.local`의 `USAGE_PROVIDER_PLANS`에 **공급자 콘솔에서 무료 계정·리소스임을 확인한 항목만** 추가한다. 설정은 계정 확인을 대신하지 않으므로 카드·결제 연결 여부는 콘솔에서 확인해야 한다. 모델 가격이나 무료량을 코드에서 자동 추정하지 않는다. 설정을 바꾸면 서버를 다시 시작한다. 미설정 공급자, `paid` 설정, 원장 읽기·쓰기 실패는 외부 호출 전에 차단한다.

```dotenv
# 아래 예시는 실제 계정 확인 후 필요한 항목만 사용한다.
USAGE_PROVIDER_PLANS='{"gemini:llm_generation":{"mode":"free","maxCostMicros":0},"azure:stt":{"mode":"free","maxCostMicros":0},"azure:tts":{"mode":"free","maxCostMicros":0}}'
USAGE_DB_PATH=private/usage/ledger.sqlite
```

기본 동시 호출 한도는 단계별 5개, 분당 60개다. 세션 요청은 작업별(글 대화/음성 인식/음성 합성) 동시 1개·분당 6개, 완료 글 질문은 30회다. 원장의 SQLite 트랜잭션에서 한도를 확인하고 슬롯·비용을 먼저 예약하므로 같은 호스트의 여러 프로세스가 마지막 잔액을 중복 소비하지 않는다. 중복 `requestId`는 먼저 공통 RequestCoordinator에서 재사용하고, 같은 작업을 원장에 다시 등록하지 않는다. 비용·한도를 회피하기 위해 원장 파일을 지우거나 매번 임시 경로를 만들면 안 된다.

Gemini의 각 재시도, STT의 각 비교 후보, Azure TTS의 본문 수신까지 실제 공급자 호출에 원장을 연결했다. 의미 검증 자체는 W03-09 범위다. 검증에서 같은 Gemini 함수를 사용할 때는 `usageStage: "llm_verification"`으로 설정하고 해당 무료 plan도 확인한다. 실패·취소가 공급자 미청구를 뜻하지 않으므로, 불확실한 비용은 호출 상한만큼 보수적으로 남긴다. 비용 상한·단가가 있는 내부 원장은 일·월 예약 예산 초과를 차단하지만, 현재 서비스에서는 `paid`를 활성화할 수 없다. 실제 청구서와의 정산 확인은 별도다. `MICROS`는 USD의 백만분의 1이며 학교의 50만원을 임의로 환산한 예산이 아니다.

### 선영·시연·유진의 연결 방법

글 대화 route는 먼저 세션 소유권을 확인한 뒤 공개 진입점 `server/ai`의 `runCoordinatedSejongTurn`에 **인증한 세션의 ID**를 전달한다. 이 함수가 세션 한도와 중복·취소를 함께 적용한다. 클라이언트가 보낸 sessionId나 인증 토큰을 그대로 전달하지 않는다.

```ts
const snapshot = session.assertActive();
const result = await runCoordinatedSejongTurn({
  sessionId: snapshot.sessionId,
  coordinator,
  request: input,
  signal: session.signal,
  isSessionActive: () => { session.assertActive(); return true; },
  onApprovedTurn: (turn) => session.appendApprovedTurn({ userText: input.text, answer: turn.answer }),
});
```

STT·TTS의 실제 API 연결에서도 인증·RequestCoordinator 안에서 `getUsageLedger().beginSession(sessionId, "transcription" | "speech", requestId)`를 호출하고, 실제 작업이 끝나는 `finally`에서 `finishSession(id, 성공 여부)`를 호출한다. 공급자 호출의 전체 한도·사용량 기록은 서버 어댑터가 자동 적용한다. 클라이언트 취소 응답만으로 슬롯을 먼저 반환하지 않는다. 예외의 `LIMIT_EXCEEDED`는 HTTP 429, 원장/정책의 `UNAVAILABLE`은 503으로 반환한다. 개발 전용 STT 비교 route는 이 작업에서 운영 공개하지 않았다. 음성 세션 연결·답변 음원 캐시·UI 실제 통합은 각각의 후속 작업에서 확인한다.

원장은 **단일 호스트의 영구 로컬 디스크**용이다. 여러 서버가 서로 다른 파일을 쓰거나 서버리스 임시 디스크를 쓰는 배포는 지원하지 않는다. 그런 배포 전에는 공통 영구 DB로 옮겨야 한다. 재시작/장애 복구 시 죽은 프로세스의 동시 슬롯만 정리하며 불확실한 비용은 보존한다. 사용 중인 DB와 `-wal`/`-shm` 파일을 함부로 삭제하거나 복사하지 않는다.
