# 공통 요청·응답 규격 — W01-08 / W02-01

2026-09-23 · PRD 7·8·13절을 바탕으로 작성했다. W01-08 공통 규격은 PR #12로 dev에 병합됐으며, W02-01 세션 구현은 PR #17에서 검토 중이다.

## 이걸로 무엇을 하나요?

선영은 샘플 답변으로 화면을 만들고, 정민은 같은 모양으로 AI 답변을 반환한다. 유진의 인식 결과는 질문 문자열이 되고, 시연은 승인된 답변 번호로 음성을 요청한다. 실제 API·세션 서버를 기다리지 않고 각 기능을 개발하기 위한 약속이다.

- 타입: `src/contracts/index.ts` (브라우저에서는 `import type`으로 사용)
- 샘플: `tests/fixtures/contracts.ts` (직접 import 가능)
- 확인: Node 24에서 `npm run typecheck`와 `npm test`
- W02-01 브랜치에는 세션 생성·삭제 API와 공통 세션 확인 함수가 구현되어 있다. 대화·전사·합성·요청 상태 경로와 프론트 연결은 후속 작업이다. 타입만으로 외부 입력이 안전해지지 않는다.

## 담당자별 시작 예시

```ts
import type { TurnResponse } from "@/contracts";
import { responses } from "../../tests/fixtures/contracts"; // 현재 파일 위치에 맞게 조정

const response: TurnResponse = responses.grounded;
if (response.status === "approved") {
  console.log(response.answer.text, response.answer.sources);
}
```

| 담당 | 가져올 샘플 | 하는 일 |
|---|---|---|
| 선영 | responses.grounded/conversation/insufficient/fallback, processing, cancelled, errors | 메시지·출처·대기·오류 화면 표시 |
| 정민 | turnRequest, groundedAnswer, character/fact/source, evalCase/evalResult | AI 입력·출력 연결 준비. 샘플 사실 카드는 실제 답변 근거로 사용하지 않음 |
| 유진 | responses.transcription, turnRequest | 전사 결과 수정 후 TurnRequest.text로 전달 |
| 시연 | speechRequest, responses.speech, createPlaybackFixture() | 승인 답변 ID 전달, 재생·정지·객체 URL 해제 |
| 민준 | sessionRequest/sessionCreated, 모든 요청 상태 | 세션·소유권·취소·중복 방지 구현 기준 |

`createPlaybackFixture()`는 외부 다운로드가 필요 없는 0.1초 무음 WAV Blob을 만든다. `URL.createObjectURL(blob)`으로 재생 연결을 시험하고 사용 후 `URL.revokeObjectURL(url)`로 해제한다. 자연스러운 목소리를 평가하는 자료는 아니다. `responses.speech.audio.url`은 아직 없는 서버 경로의 모양만 보여준다.

## ID와 인증

- sessionId: 현재 대화를 구분하는 서버 발급 ID. 이것만으로 접근 권한을 주지 않는다.
- requestId: 클라이언트가 작업마다 새로 생성하는 불투명 ID (`crypto.randomUUID()` 권장). 전사·대화·합성은 각각 다른 ID를 쓴다.
- answerId: 검사를 마친 답변에 서버가 발급하는 ID. 음성 합성은 이 ID만 받아 서버의 승인된 원문을 찾는다.
- 권한은 서버 발급 세션 토큰 쿠키로 확인한다. 요청 본문에 토큰·API 키·system 역할·페르소나·과거 대화 배열을 받지 않는다. 배포 시 HttpOnly/Secure/SameSite와 Origin 검사를 적용한다. HTTP localhost 개발은 Secure 쿠키 설정을 별도로 처리해야 한다.
- 서버는 세션 소유권과 ID를 함께 확인한다. 같은 requestId·같은 입력 재전송은 기존 상태를 반환하며 추가 과금을 만들지 않는다. 같은 ID·다른 입력/작업은 REQUEST_CONFLICT다.

## HTTP 약속

| 요청 | 입력 | 성공 출력·HTTP |
|---|---|---|
| POST /api/sessions | JSON CreateSessionRequest (`characterId: "sejong"`) | 201 CreateSessionResponse + 세션 쿠키 |
| DELETE /api/sessions/current | 본문 없음, 세션 쿠키 | 200 `{status:"deleted"}` + 쿠키 해제 |
| POST /api/transcriptions | multipart/form-data: requestId + audio 파일 | 200 CompletedTranscription 또는 202 PendingResponse |
| POST /api/turns | JSON TurnRequest | 200 ApprovedTurn 또는 202 PendingResponse |
| POST /api/speech | JSON SpeechRequest | 200 CompletedSpeech 또는 202 PendingResponse |
| GET /api/requests/{id} | 본문 없음, 세션 쿠키 | 200 RequestState |
| DELETE /api/requests/{id} | 본문 없음, 세션 쿠키 | 200 CancelledResponse 또는 이미 확정된 종료 상태 |
| GET /api/speech/audio/{answerId} | 세션 쿠키 | 200 audio/* 바이트 (후속 TTS 구현에서 추가) |

성공 JSON은 표의 객체를 그대로 반환한다. 추가 `data` 래퍼는 없다. 전사에서 FormData를 보낼 때 Content-Type을 직접 지정하지 않아야 브라우저가 boundary를 붙인다. 지원 녹음 MIME 목록은 유진의 브라우저 시험 후 확정하며 서버에서 실제 파일 형식도 검사한다.

음성은 인증된 같은 출처 URL 방식으로 통일한다. 음원 응답은 `Cache-Control: private, no-store`, 세션 만료·초기화 뒤 접근 차단이 필요하다. 공급자 URL이나 공개 저장소 URL을 그대로 전달하지 않는다. 재생 시 같은 answerId의 서버 음원을 재사용하고 새 합성을 반복하지 않는다.

## W02-01 세션 API 사용법

**구현:** `POST /api/sessions`, `DELETE /api/sessions/current`. PR #12가 병합된 최신 dev를 이 브랜치에 반영했다. 세션 구현 자체는 PR #17의 dev 병합 전이며, 브라우저 화면의 시작/초기화 버튼 연결은 선영의 후속 작업이다.

### 선영: 시작과 초기화

같은 사이트에서 아래 요청을 보낸다. 브라우저가 Origin과 쿠키를 자동으로 처리하므로 토큰을 직접 읽거나 localStorage에 저장하지 않는다.

```ts
const response = await fetch("/api/sessions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  credentials: "same-origin",
  body: JSON.stringify({ characterId: "sejong" }),
});
const result = await response.json();
if (!response.ok) {
  // result.message 표시. 자동으로 무한 재시도하지 않는다.
} else {
  // result.sessionId를 현재 화면의 대화 식별자로 보관한다.
  // result.intro, result.suggestedQuestions를 표시한다.
}
```

- 시작 요청은 세종만 허용한다. 인물 외의 필드(토큰·대화 기록·system 등)는 400이다.
- 같은 쿠키로 다시 시작하면 기존 세션을 없애고 새 ID와 쿠키를 발급한다. 시작 버튼의 연속 클릭은 처리 중 비활성화한다.
- 기존 세션의 교체 요청을 처리하는 동안 다른 요청이 초기화/교체를 완료하면, 늦은 요청은 401 SESSION_EXPIRED로 끝나며 쿠키를 발급하거나 지우지 않는다. 접수 시점에 이미 만료된 쿠키로 다시 시작하는 요청은 허용한다. 쿠키가 없는 최초 시작의 중복 클릭은 화면에서 직렬화한다.
- 초기화 확인 후 로컬 진행 요청·녹음·재생을 중단하고 `DELETE /api/sessions/current`를 보낸다. 성공 후 화면 기록을 지운다. 계속 대화하려면 POST로 새 세션을 시작한다. DELETE는 이미 만료되었거나 쿠키가 없어도 200이다.
- UI는 작업 시작 시점의 sessionId와 requestId를 보관하고, 완료 시 현재 화면과 다른 결과를 버려야 한다. 서버 차단만으로 이미 내려간 응답이나 브라우저 음원이 자동으로 지워지지는 않는다.
- 쿠키는 **같은 브라우저 프로필의 탭끼리 공유**한다. 독립 브라우저/시크릿 프로필의 세션은 분리된다. 여러 탭에서 각각 독립 대화를 제공하는 기능은 이번 구현에 없다. 후속 화면 통합에서 새 대화/초기화를 다른 탭에도 알리고 오래된 화면의 전송을 막아야 한다.
- `expiresAt`은 생성 시점의 유휴 만료 예정 시각이다. 사용자 활동으로 연장될 수 있으므로 이 최초 값만으로 화면을 강제 종료하지 않는다. 서버의 SESSION_EXPIRED 응답이 기준이다.

### 정민·유진·시연: 서버에서 사용할 공통 함수

`src/server/sessions/http.ts`의 `requireSession(request, store, config)`로 쿠키와 허용 Origin을 확인한다. store는 `getSessionStore()`, config는 `getSessionHttpConfig(request)`로 가져온다. 승인/등록되지 않은 본문이나 query의 sessionId로 세션을 찾는 경로는 제공하지 않는다.

1. 사용자 요청 접수 시 `requireSession`으로 핸들을 얻는다.
2. 외부 호출이 지원하면 핸들의 `signal`을 전달한다. 초기화·만료 시 abort된다.
3. 비동기 처리가 끝난 뒤 **저장/응답 직전** `handle.assertActive()`를 호출한다. 만료되었으면 SESSION_EXPIRED로 종료한다. 확인과 저장 사이에 다시 await를 넣지 않는다.
4. 답변 검증을 마친 결과만 `handle.appendApprovedTurn({ userText, answer })`으로 저장한다. 이 함수도 세션 유효성을 다시 검사한다. 답변의 역사적 정확성이나 공개 가능 여부를 검사하는 함수는 아니다.
5. LLM에는 `handle.getRecentTurns()`로 최근 최대 10개 완결 대화를 전달한다. TTS는 `handle.getAnswer(answerId)`로 현재 세션의 승인 답변만 가져온다. 다른 세션 번호는 undefined이며 존재 정보를 공개하지 않는다.
6. 상태 폴링·음원 조회에는 `requireSession(..., { touch: false })`를 사용한다. 백그라운드 조회로 유휴 시간을 무한 연장하지 않는다.
7. 세션 오류는 `sessionErrorResponse(error, requestId)`로 계약에 맞게 반환할 수 있다. 세션 생성/삭제에는 requestId가 없어 null이다. 요청별 저장 상태·중복 방지·취소 판정·외부 호출 전 사용량 검사는 W03-01에서 연결한다.

### 만료·보관·실행 조건

| 항목 | 현재 동작 |
|---|---|
| 인증 | 공개 sessionId와 별개인 무작위 256비트 토큰. 서버에는 토큰 해시만 보관 |
| 쿠키 | HTTPS: __Host-sejong_session, HttpOnly·Secure·SameSite=Strict·Path=/, Domain 없음. HTTP localhost만 sejong_session/Secure 예외 |
| 유효 기간 | 유휴 30분, 활동 중이어도 생성 후 최대 4시간. 타이머와 요청 시점 모두 검사 |
| 초기화 | 이전 토큰 무효화, 저장한 대화 제거, 기존 핸들 abort 및 읽기/저장 차단 |
| 저장 상한 | 초기 단일 프로세스 시험은 활성 세션 5개. 포화 시 503, 기존 사용자 강제 퇴장 없음 |
| 대화 상한 | 세션당 완결 대화 30개, 각 기록 최대 16,000자 직렬화 크기. 질문 500자·답변 400자. 전체 30개 답변은 현재 세션에서 다시 조회 가능 |
| 비용 제한 | 저장 시 30개 상한은 비용 차단을 대신하지 않음. 유료 호출 전/전체 예산 검사는 후속 W03 작업 |
| 재시작 | 세션 소멸. 이전 토큰으로 복구하지 않음 |
| 응답 | 성공·처리한 오류 모두 Cache-Control: no-store. 토큰은 JSON에 포함하지 않음 |

`.env.local`의 `APP_ORIGIN`은 `https://도메인`처럼 끝의 / 없이 입력한다. 배포 실행에서 누락/잘못된 값은 503으로 차단한다. 사용자 요청의 Host나 X-Forwarded-Host를 허용 목록으로 채택하지 않는다. 로컬 `npm run dev`만 loopback 주소를 자동 인식하며, `npm start`로 로컬 시험할 때도 명시해야 한다.

이 저장소는 **하나의 상시 실행 Node 프로세스**가 전제다. 여러 인스턴스·서버리스 환경은 서로 메모리를 공유하지 않는다. 공유 저장소와 원자적 취소/한도 관리 없이 확장하지 않는다. 음원 캐시·요청 상태를 추가하는 담당자는 세션 signal에 맞춰 해당 데이터도 정리해야 한다.

## 상태와 답변 종류

queued → processing → approved(대화) / completed(전사·합성) / failed / cancelled.
즉시 완료되는 작업은 queued/processing을 생략할 수 있다. operation으로 turn/transcription/speech를 구분한다.

- approved: 서버가 공개 가능하다고 판단한 답변. kind는 grounded, conversation, insufficient, fallback 중 하나다.
- grounded: 검토 완료 사실 ID와 서버가 조회한 출처가 각각 하나 이상 있어야 한다. 이 조건과 본문 검사는 후속 AI 검증 작업에서 구현한다.
- conversation: 사실 주장을 추가하지 않는 인사·일반 대화.
- insufficient: 자료가 부족하다는 정상 답변. fallback: 검사 실패나 정책에 따라 제공하는 안전한 정상 안내. 둘 다 통신 오류와 다르다.
- pending/cancelled/failed에는 미검증 답변이나 부분 생성 원문을 넣지 않는다.
- DELETE 요청이 먼저 확정되면 이후 도착한 결과를 공개하지 않는다. 완료가 먼저 확정되면 기존 완료 상태를 반환한다. 취소가 이미 발생한 공급자 요금까지 되돌리지는 않는다.
- 클라이언트는 현재 세션·활성 requestId와 맞는 응답만 표시한다. 초기화 시 녹음·재생·진행 요청을 종료하고 이전 응답을 무시한다.
- 현재는 polling 기준이다. 202 뒤 GET 상태 조회를 사용하며 간격·횟수 제한은 연결 구현 시 정한다. 실시간 음성/SSE는 이번 규격에 포함하지 않는다.

## 오류와 재시도

오류 필드는 최상위 `status:"failed", code, message, retryable, requestId, retryAfterSeconds?`다. 요청 ID가 없거나 잘못된 입력은 requestId:null. 처리 중 발생한 실패 상태는 operation과 유효한 requestId를 포함한다.

| code | HTTP | 처리 |
|---|---|---|
| INVALID_INPUT | 400 | 입력 수정 |
| AUDIO_UNSUPPORTED | 415 | 다른 녹음 형식 또는 글 입력 |
| SESSION_EXPIRED | 401 | 새 대화 시작, 기존 대화 자동 복원 없음 |
| FORBIDDEN | 403 | 접근 불가 안내 |
| REQUEST_NOT_FOUND | 404 | 현재 세션에서 찾을 수 없는 요청, 타 세션 존재 정보 미노출 |
| REQUEST_CONFLICT | 409 | 기존 ID·입력 확인 |
| LIMIT_EXCEEDED | 429 | 일시 제한은 retryAfterSeconds, 전체 예산 소진은 retryable:false |
| UPSTREAM_TIMEOUT | 504 | 상태 확인 후 사용자 재시도 |
| UNAVAILABLE | 503 | 사용자용 장애 안내 |

POST 자체 실패는 위 HTTP 상태를 사용한다. GET 상태 조회가 정상 처리되어 저장된 failed 작업을 돌려주는 경우 HTTP 200이며 본문 code가 원인을 설명한다. 조회 자체의 인증·권한·없는 요청 오류는 401/403/404다.

응답 유실로 결과를 모르면 같은 ID로 조회/재전송한다. 실패 확정 후 새 작업을 시작하려면 사용자 동작으로 새 ID를 만든다. retryable:true는 자동 무한 재시도 지시가 아니다. 제공업체 원본 오류·키는 사용자용 message에 넣지 않는다.

## 자료와 샘플의 한계

Character·Fact·Source·PromptExample·EvalCase·EvalResult는 내부 자료 형식이다. 화면용 SourceView에는 제목·기관·URL만 포함하고 검토 상태·내부 정책은 보내지 않는다. 날짜는 UTC ISO 8601, 미검토 출처 checkedAt은 null이다. 사실 카드의 pending/rejected는 실제 grounded 생성에서 제외한다.

샘플 URL은 example.org, 검토 상태는 pending이다. grounded 샘플은 **화면용 응답 모양만 재현**하며 실제 역사 검증을 통과했다는 뜻이 아니다. 실제 서비스용 데이터는 data/characters에 별도 검토 후 등록한다. 평가 샘플 역시 실제 측정 결과가 아니다.

## 팀 검토 후 확정할 항목

1. 선영: 화면에 필요한 상태·출처·오류 필드가 충분한가?
2. 정민: 답변 종류·사실 ID·출처 구조로 생성/검사 결과를 전달할 수 있는가?
3. 유진: FormData 음성 입력과 인식문 수정 흐름이 가능한가? 지원 MIME 목록은 무엇인가?
4. 시연: 승인 답변 ID와 인증된 음원 URL로 재생 기능을 연결할 수 있는가?

필드 변경은 이슈 #2에서 공유하고 타입·샘플·문서를 한 PR에서 함께 수정한다. 기존 PRD 대비 구체화한 결정은 operation 필드, 생성 시 characterId, 음원 URL 방식과 상태 조회 방식이다. 실제 담당자 합의로 바뀔 수 있으며 공급자 선정은 이 규격과 별개다.
