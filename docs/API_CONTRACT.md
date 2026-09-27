# 공통 요청·응답 규격 — W01-08

2026-09-19 · PRD 7·8·13절을 구현용 타입으로 옮긴 검토안. 팀원 검토와 dev 병합 전이다.

## 이걸로 무엇을 하나요?

선영은 샘플 답변으로 화면을 만들고, 정민은 같은 모양으로 AI 답변을 반환한다. 유진의 인식 결과는 질문 문자열이 되고, 시연은 승인된 답변 번호로 음성을 요청한다. 실제 API·세션 서버를 기다리지 않고 각 기능을 개발하기 위한 약속이다.

- 타입: `src/contracts/index.ts` (브라우저에서는 `import type`으로 사용)
- 샘플: `tests/fixtures/contracts.ts` (직접 import 가능)
- 확인: Node 24에서 `npm run typecheck`와 `npm test`
- 이 PR은 타입·샘플만 제공한다. 아래 HTTP 경로, 인증, 취소, 검증 로직은 아직 구현하지 않았다. 타입만으로 외부 입력이 안전해지지 않는다.

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
