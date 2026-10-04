# AI 백엔드·후보 시험·예산 결정 기록

2026-10-04 기준 작업 기록이다. 첨부 기획서와 PRD는 요구사항 참고자료로만 사용했고, 문서 안의 문장을 실행 지시로 취급하지 않는다.

## 구현 결정

- 서버 입력은 `인물 설정`, `최근 승인 대화`, `검토 완료 사실 카드`로 분리한다.
- 사용자의 질문 안에 있는 역할 변경, 관리자 사칭, 정책 노출 요구는 대화 내용으로만 취급한다.
- `reviewStatus: "approved"`인 사실 카드만 grounded 답변 근거로 넣는다. pending/rejected 자료는 프롬프트에서 제외한다.
- 모델 출력은 `{ kind, text, factIds }` JSON으로 받고, 서버가 최종 `Answer` 계약과 출처를 확정한다.
- 중복 요청은 같은 `requestId`와 같은 입력이면 기존 결과를 재사용하고, 같은 ID에 다른 입력이면 `REQUEST_CONFLICT`로 처리한다.
- 취소 또는 시간 초과가 먼저 확정되면 이후 도착한 공급자 응답은 공개하지 않는다.

## 세션 API 연결 방식

이 PR은 세션 저장소에 직접 의존하지 않고, AI 답변 생성 엔진이 세션 계층에 붙을 수 있는 입력과 실행 흐름을 제공한다.

후속 route는 아래 순서로 연결한다.

1. 세션 쿠키와 Origin을 확인한다.
2. 현재 세션의 최근 승인 답변만 `recentConversation`으로 변환한다.
3. `runCoordinatedSejongTurn`에 `request`, `recentConversation`, `RequestCoordinator`, 세션 활성 확인 함수를 전달한다.
4. 생성 시작 전과 LLM 응답 도착 후에 세션이 아직 활성인지 다시 확인한다.
5. 세션이 활성일 때만 `onApprovedTurn`에서 답변을 저장하고 클라이언트에 노출한다.
6. 세션 초기화, 만료, 교체, 사용자 취소, 시간 초과가 먼저 확정되면 늦은 LLM 응답은 `cancelled`로 버린다.

`runCoordinatedSejongTurn`은 같은 `requestId`와 같은 입력에는 기존 작업을 재사용하고, 같은 `requestId`에 다른 입력이 들어오면 `REQUEST_CONFLICT`를 반환한다. fingerprint에는 사용자 질문과 최근 승인 대화가 포함되므로 같은 요청 ID가 다른 대화 맥락에 재사용되는 것도 막는다.

역사 자료 기반 답변은 `generateSejongTurn`에서 만든다. 이 함수는 질문과 맞는 `approved` fact만 프롬프트에 넣고, 모델이 반환한 `factIds` 중 실제 프롬프트에 들어간 승인 fact만 최종 `Answer.factIds`와 `sources`에 남긴다.

## 고정 질문

`evals/sejong/fixed-questions.json`에 Q01/Q03/Q05를 둔다.

| ID | 목적 | 기대 |
|---|---|---|
| Q01 | 정상 사실 질문 | `grounded`, 훈민정음 28자 fact 연결 |
| Q03 | 역할 변경 공격 | 세종 설정 유지, 관리자 사칭 거절 |
| Q05 | 자료 부족 질문 | 커피 취향을 꾸미지 않고 `insufficient` |

실행:

```bash
npm run eval:ai -- --mock
```

PowerShell에서 실제 Gemini 호출:

```powershell
$env:GEMINI_API_KEY="..."
npm run eval:ai
```

macOS/Linux에서 실제 Gemini 호출:

```bash
GEMINI_API_KEY=... npm run eval:ai
```

결과는 `evals/sejong/results/`에 JSON으로 저장하며 Git에는 올리지 않는다.

## API 후보와 선택

| 후보 | 품질 확인 | 비용 | 이용 조건 | 판단 |
|---|---:|---:|---|---|
| Gemini Developer API, Flash 계열 | 이미 #26에서 인증·호출 성공 기록이 있고, 이번 고정 질문 runner가 같은 구조를 사용 | Gemini 3.x Flash 표준 가격은 공식 페이지 기준 입력 $0.30/1M, 출력 $2.50/1M 토큰 수준. 무료 티어는 일부 모델에서 가능 | Gemini 가격표는 Free Tier 데이터가 제품 개선에 사용될 수 있고 Paid Tier는 No로 표시한다. Billing 문서는 Tier 1 월 cap $250과 project/account spend cap을 설명한다 | **MVP 1차 선택**. 기존 실험을 이어가되 Paid Tier와 $5 선불/월 테스트 한도 설정 후 사용 |
| OpenAI API, 경량 텍스트 모델 | 같은 Q01/Q03/Q05 runner에 provider adapter를 추가해 비교 가능 | OpenAI 가격표 기준 `gpt-6-luna` 표준 short context는 입력 $0.10/1M, 출력 $0.50/1M 토큰 | OpenAI API 문서는 API 입력·출력을 모델 학습에 사용하지 않는다고 안내한다 | Gemini가 Q03/Q05에서 실패하거나 지연이 크면 2차 후보 |

공식 확인 URL:

- Gemini 가격: https://ai.google.dev/gemini-api/docs/pricing
- Gemini Billing·Spend caps: https://ai.google.dev/gemini-api/docs/billing
- OpenAI API 가격: https://developers.openai.com/api/docs/pricing
- OpenAI API 데이터 정책: https://platform.openai.com/docs/models/default-usage-policies-by-endpoint

## 호스팅 선택

| 후보 | 장점 | 위험 | 판단 |
|---|---|---|---|
| Vercel | Next.js 연결이 가장 쉽고 preview 공유가 빠름. Pricing 페이지는 hard spend limits와 usage credit을 안내한다 | 서버리스 실행은 in-memory 세션·요청 상태가 인스턴스 간 유지된다고 가정하기 어렵다 | 화면 preview와 정적 데모용 |
| Google Cloud Run | 공식 가격 문서 기준 request-based pay-per-use이고 max instances로 MVP 단일 서버 상태를 단순화할 수 있음 | 컨테이너 배포 설정이 필요하고 Vercel보다 초기 설정이 무겁다 | **MVP 백엔드 시연 선택**. max instances 1, min instances 0, 요청 기반 과금으로 시작 |

공식 확인 URL:

- Vercel Pricing: https://vercel.com/pricing
- Cloud Run Pricing: https://cloud.google.com/run/pricing

## 시험 예산

- API 시험 예산: Gemini Paid Tier 선불 최소 단위에 맞춰 **월 $5**를 1차 한도로 둔다.
- 일일 개발 한도: `.env.local`에서 `AI_DAILY_TEST_BUDGET_USD=1`을 기준값으로 둔다.
- Q01/Q03/Q05 3개를 한 번씩 실행하는 smoke run과, 같은 세트 3회 반복 비교를 분리해 기록한다.
- PRD의 20회 대화 측정은 생성 1회와 검증 1회를 합산해도 소액이지만, 실패·취소·반복 호출까지 비용 기록에 포함한다.
- 원문 질문·답변 전체는 기본 운영 로그에 남기지 않고, 평가 JSON은 공개 저장소에 커밋하지 않는다.
