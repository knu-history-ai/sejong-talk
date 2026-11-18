# 실시간 음성 Bedrock 답변 (#104)

## 연결

PR97의 `answer({ transcript, signal })` 규격을 구현한다. STT는 Speech Engine이 처리하며 이 모듈은 인식된 질문을 받는다. 기본 `dev`에는 PR97 서버가 아직 없으므로 서버 실행에는 PR97 통합이 필요하다. 기존 Ollama HTTP 답변 경로는 바꾸지 않는다.

- 모듈: `scripts/realtime-poc/bedrock-answer.mjs`
- 공개 답변 생성/평가: `src/server/ai/bedrock-answer.ts`
- SDK 요청: `src/server/ai/bedrock-request.ts`
- 리전: `ap-northeast-1`; 모델: `jp.anthropic.claude-haiku-4-5-20251001-v1:0` (고정)

Node 24에서 `npm ci`. PR97과 통합한 저장소 루트의 서버 환경에 `REALTIME_POC_ANSWER_MODULE=scripts/realtime-poc/bedrock-answer.mjs`를 설정한다. 기존 ElevenLabs 환경 설정은 PR97 문서를 따른다. `server-only` 모듈을 별도 Node 프로세스에서 읽으므로 실행 명령은 다음과 같다.

```sh
node --conditions=react-server --env-file-if-exists=.env.local scripts/realtime-poc/speech-engine-server.mjs
```

Next 서버는 별도로 `npm run dev` 또는 기존 배포 방식으로 실행한다. 브라우저 `/realtime-voice-test`에서 대화한다. 운영 프로세스 관리자에도 위 Node 옵션과 모듈 경로를 적용해야 한다. 모듈을 비우면 PR97은 mock으로 돌아가므로 시작 설정을 확인한다.

## 인증·시간 제한·사용량

AWS SDK 기본 인증 체인을 사용한다. 기존 서버 IAM 역할을 권장한다. 필요한 경우 환경 변수 **이름**은 `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`이다. 값은 서버 비밀 설정에만 둔다. 이 추론 프로필과 관련 모델의 `bedrock:InvokeModel` 권한이 필요하다. 리전이나 새 모델을 만들지 않는다.

`BEDROCK_TIMEOUT_MS`는 기본 15000, 허용 1~60000 정수(ms)이다. SDK 재시도는 1회 시도로 제한한다. 호출에는 AbortSignal을 전달하고, 공급자가 취소를 무시해도 타이머/취소 경쟁으로 반환을 종료한다. 공개 직전에도 신호를 확인한다. 종료 시 PR97 서버가 신호를 abort해야 한다.

기존 앱 장부는 유료 호출을 막고 있어 변경하지 않았다. 이 모듈은 PR97 PoC처럼 기존 계정으로 직접 호출한다. 비용 한도 기능을 새로 제공하지 않는다. PR97 엔진 제한과 기존 AWS 운영 한도 안에서 실행해야 한다. `bedrock_call`에는 호출의 completed/failed/cancelled, 고정 오류 코드, 시간, 확인된 입력/출력/전체 토큰만 남긴다. 확인 불가능한 토큰은 null이며 0원 또는 무과금으로 해석하지 않는다. 취소도 이미 실행된 요청의 과금 취소를 보장하지 않는다.

`bedrock_publication`은 approved/blocked/failed/cancelled를 별도 기록한다. 모델 호출 성공이 답변 승인 성공을 의미하지 않는다. 공급자 오류 객체·응답 원문·프롬프트·키·대화 원문은 로그에 넣지 않는다. 실패/취소 답변을 정상 답변으로 저장하지 않는다. PR97 relay의 completed는 스트림 전달 완료일 뿐이므로 AI 성공률에는 publication 상태를 사용한다.

## 자료·검사·대화 문맥

기존 `loadSejongKnowledgeBase`, `selectReviewedFactsForQuestion`, `buildSejongPromptInput`, `buildSejongAnswerPrompt`, `parseAnswerDraftFromText`, `validateAnswerDraft`를 재사용한다. 미승인 사실 ID가 하나라도 있으면 차단한다. 형식/길이/출처 검사 후에만 공개한다. fallback/insufficient는 모델 본문 대신 서버 안내를 쓴다.

이번 버전은 Converse 전체 응답을 받은 다음 검사하고 **문자열 하나**를 yield한다. 검증 전 토큰/후보를 Speech Engine이나 화면에 보내지 않는다. 이 때문에 첫 답변은 모델 응답 전체와 검사 이후 시작된다.

transcript의 마지막 user가 현재 질문이다. 앞선 최대 20개 항목(각 4000자)은 JSON 대화 문맥으로 전달한다. SDK의 agent 문자열에는 승인 ID나 취소 여부가 없으므로 이를 `RecentApprovedTurn`이나 사실 근거로 승격하지 않는다. 서버 전역 대화 저장소는 없고 각 호출의 transcript만 사용한다. 이전의 중단된 발화가 transcript에 포함될 수 있는 한계가 있다. 유진과 확인할 사항: SDK transcript의 중단 발화 처리와, 향후 세션별 승인 답변 ID/출처를 전달하는 입력 확장. 현재 입력 규격 변경은 없다.

**검사 한계:** 현재 dev의 검사는 계약·승인 ID·출처 연결 검사이며 본문 의미의 사실성 보증이 아니다. PR99의 후속 질문·의미 검증은 아직 병합되지 않아 복사하거나 대체하지 않았다. 같은 모델이 역사 주장을 conversation으로 잘못 분류하는 문제도 기존 검사 한계에 포함된다. 실제 답변 품질은 별도 평가/리뷰가 필요하다.

## PR100 평가 연결 계약

`generateBedrockVoiceAnswer({ transcript, signal })`를 호출하면 다음 필드를 받는다.

| 필드 | 의미 |
| --- | --- |
| requestId | 이번 호출 식별자 |
| serverStatus | approved / blocked / failed / cancelled |
| validationStatus | completed / failed / not-run |
| blockReason | null 또는 INSUFFICIENT_EVIDENCE / VALIDATION_FAILED / UPSTREAM_TIMEOUT / FORBIDDEN / LIMIT_EXCEEDED / UNAVAILABLE / CANCELLED / INVALID_INPUT |
| answer | 최종 공개 Answer(출처·factIds·버전 포함), 실패·취소 시 null |
| usage | 관측한 토큰 또는 null; 비용은 계산하지 않음 |

시연의 평가기는 현재 질문과 고정 이력을 transcript로 변환하여 이 함수를 사용하고, `answer`만 공개 답변 평가 대상으로 삼는다. 모델 오류에는 voice generator가 서비스 안내를 전달하지만 평가 결과 answer는 null이며 성공으로 세지 않는다. blocked fallback은 정상 답변 성공이 아니다. 후보 원문은 결과에 없다. 이 함수는 평가 도구 전체 구현이나 담당자 검토를 대신하지 않는다. PR100 담당자와 실제 입력·출력 리뷰는 남아 있다.

## 확인 구분

모의: `node --conditions=react-server --test tests/bedrock-answer.test.mjs`. 정상 출처 보존, 중단/늦은 완료 차단, 시간 초과, 접근 거절, 오류 원문 비노출, 검사 실패와 자료 부족 분리, 대화 간 문맥 분리를 확인한다.

실제 서버 단건 호출과 실제 마이크 대화는 별도 확인해야 한다. 본 작업 환경에서 제공받은 서버의 SSH 22번 포트가 연결 시간 초과되어 실제 배포/호출을 확인하지 못했다. 키를 요구하거나 실제 결과를 모의 결과로 대체하지 않는다.

인수 확인: PR97 통합 → 기존 IAM/환경 설정 → 위 명령으로 WS 서버 실행 → 앱에서 새 질문과 연속 질문 → 답변 중 끼어들기 → 대화 종료. 각 경우에 publication 상태, 이전 답변 추가 전송 없음, 새 답변 수신을 확인한다. 로그만으로 실제 소리가 멈춘 시점을 입증할 수 없으므로 유진의 마이크 시험 결과도 별도로 남긴다.

SDK 참고: [AWS ConverseCommand](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/bedrock-runtime/command/ConverseCommand/).
