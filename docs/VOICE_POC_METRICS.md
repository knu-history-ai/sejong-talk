# 한국어 음성 PoC 설정·계측 — #95

범위는 한국어 요청 설정과 지연·리전 기록이다. #93/PR #94는 샘플 UI이며 실제 음성 백엔드 연결이 없다. 이 변경은 해당 UI나 #65의 서비스 음성 경로를 수정하지 않고, PoC 담당자가 기존 백엔드 연결 지점에서 사용할 요청 함수와 계측 훅을 제공한다. 실시간 전송·전체 백엔드·새 공급자·배포·예산 정책은 구현하지 않는다.

## 한국어 설정

`src/server/tts/elevenlabs-poc.ts`의 `koreanPocSpeechRequest`는 기본 모델 `eleven_flash_v2_5`, `language_code: "ko"`와 MP3 스트리밍 응답을 사용한다. `ELEVENLABS_POC_TTS_MODEL=eleven_turbo_v2_5`도 허용한다. 공식 API 문서상 기존 `eleven_multilingual_v2`는 `language_code`를 지원하지 않으므로 이 PoC 전용 설정은 기존 후보 평가/서비스 설정과 분리했다.

음성은 기존 [`W01-05-TTS-실험.md`](W01-05-TTS-실험.md)의 Bill을 재사용한다. `ELEVENLABS_VOICE_ID` 미설정 시 Bill `pqHfZKP75CvOlQylNhV4`를 사용하며 명시한 값이 있으면 그 값을 우선한다. 기존 평가 스크립트의 설정도 그대로 요청에 담는다.

| 설정 | 값 |
|---|---|
| stability | 0.65 |
| similarity_boost | 0.75 |
| style | 0.15 |
| use_speaker_boost | true |
| speed | 0.95 |

이는 기존 음성·요청 설정의 재사용이다. PoC 모델과 한국어 고정 방식은 이전 평가와 다르므로 이전 음원과 동일한 소리·품질을 보장하거나 직접적인 지연 개선으로 기록하지 않는다.

기존 ElevenLabs STT 어댑터 `src/server/stt/elevenlabs.ts`는 이미 `language_code=ko`이므로 변경하지 않는다. ElevenAgents 에이전트 ID가 제공된 것은 아니므로 원격 에이전트 설정을 바꿨다고 기록하지 않는다.

API 키는 서버의 `.env.local`에 `ELEVENLABS_API_KEY`로 설정한다. 로컬 #95 작업 트리에는 사용자가 제공한 멘토 API 키와 기존 Bill 음성 ID, PoC 모델 설정을 준비했다. 키가 해당 멘토 워크스페이스에 속하는지와 유효성은 실제 API로 확인하지 않았다. 공개 변수로 넣지 않으며 계정/요금제는 변경하지 않는다.

사용자가 알려준 워크스페이스 ID는 로컬 `ELEVENLABS_WORKSPACE_ID`에 두고 결과의 `configuration.workspaceId`에만 기록한다. 이 값은 사용자 제공 식별 정보이며 API 키의 소속을 검증한 결과가 아니다. 음성 합성 인증은 API 키로 하며 워크스페이스 ID를 별도 인증 헤더나 Voice ID로 보내지 않는다.

## 측정값의 의미

`requestKoreanPocSpeech`는 `requestId`와 다음 값만 담은 `timing`을 반환한다. 실패는 `PocSpeechError.timing`으로 같은 정보를 제공한다.

| 필드 | 의미 |
|---|---|
| inputAt / outputAt | 설정 확인 후 서버 요청 구간 시작·종료 UTC 시각 |
| durationMs | 단조 시계로 측정한 전체 서버 요청 구간 |
| headersReceivedAt / headersLatencyMs | 서버에서 공급자 응답 헤더를 받은 시각·지연 |
| firstBodyByteAt / firstBodyByteLatencyMs | 첫 음원 바이트 수신 시각·지연 |
| bodyDownloadMs | 헤더 수신부터 본문 전체 수신 완료/실패까지 |
| xRegion / regionStatus | 실제 응답 헤더 값. 누락은 null/not-reported, 응답 전 실패는 no-response |
| httpStatus / status | HTTP 상태와 completed/failed/cancelled/timeout |

일반 fetch 호출에서 실제 소켓 송신 시각까지 알 수는 없다. `inputAt`은 설정 확인 이후, fetch에 요청을 넘기기 전 기준이며 본문 직렬화를 포함한다. 설정 누락·잘못된 모델은 호출 전 예외이며 네트워크 지연 결과로 기록하지 않는다. `x-region`을 AWS 도쿄 리전이나 한국어 설정에서 추정하지 않는다. HTTP 실패도 헤더를 받았다면 기록하며, 공급자 오류 본문과 인증 헤더는 로그로 반환하지 않는다.

`measurePocStage(requestId, stage, work, record)`는 기존 백엔드의 STT/LLM/검증 작업을 감싸 각 입력·출력 시각과 완료/실패를 기록하는 훅이다. `stage`는 stt/llm/validation/tts 중 하나다. 동일 requestId로 묶으며 입력·출력 원문은 기록하지 않는다. 기존 백엔드에 이 훅을 연결하기 전에는 해당 구간을 측정했다고 주장하지 않는다.

실제 소리 시작은 별도 브라우저 시계에서 기록해야 한다. 서버 시각과 브라우저 시각을 단순히 빼서 체감 지연으로 계산하지 않는다. 첫 음원 바이트 수신도 실제 재생 시작과 다르다.

## 공통 문장 수동 측정

`tests/fixtures/voice-poc-korean.json`의 자기소개·역사 용어/숫자·끼어들기용 긴 답변을 고정한다. 문장은 음성 설정 비교용이며 승인된 서비스 답변을 대체하는 앱 입력이 아니다.

Node 24와 개발 의존성이 필요하다. 아래 명령은 **실제 ElevenLabs 호출**이므로 계정·범위 확인 후 수동 실행한다. 키만 설정하면 자동으로 호출되지는 않는다.

```powershell
node --conditions=react-server --env-file-if-exists=.env.local scripts/voice-poc-korean.mjs --live --case=historical-numbers
```

`--case`를 빼면 고정 3문장만 순차 요청한다. 결과와 음원은 Git에서 제외되는 `private/voice-poc/<새 실행 ID>/`에 저장한다. 결과의 `configuration`에는 워크스페이스 ID·Voice ID·모델·한국어 설정·voice settings·출력 형식을 함께 남기며 키와 요청 원문은 넣지 않는다. 음질·끼어들기·재생 시작은 null로 남겨 직접 확인한 뒤 별도 기록한다. 사용량·실제 비용을 확인하지 못했으면 비용은 null이며 0달러로 취급하지 않는다. 이 도구는 고정 응답의 TTS 계측이므로 STT/LLM을 포함한 전체 대화 응답 시간은 측정하지 않는다.

## 확인 범위

Bill 기본값·명시한 음성 우선·기존 voice settings 보존, 한국어 요청 설정, 헤더 누락, 본문 지연/실패, HTTP 오류, 취소·시간 초과, 구간 실패의 모의 응답 테스트를 작성했다. 사용자 지침에 따라 테스트·모의/실제 API 실행과 음성 청취는 하지 않고 정적 검토·CPU 문법/타입 확인만 수행한다. 실제 음질·끼어들기·백엔드 통합은 미검증이며 게임 실행 및 CUDA/GPU 검증도 하지 않는다.

공식 참고: [TTS 스트리밍](https://elevenlabs.io/docs/api-reference/text-to-speech/stream), [TTS 언어 설정](https://elevenlabs.io/docs/api-reference/text-to-speech/convert), [STT 언어 설정](https://elevenlabs.io/docs/api-reference/speech-to-text/convert). `x-region`은 멘토가 요청한 응답 헤더를 관측하는 용도로만 저장한다.
