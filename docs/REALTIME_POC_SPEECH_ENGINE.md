# 실시간 음성 PoC: Speech Engine 음성 연결·마이크·끼어들기

담당: 이유진. 범위는 ElevenLabs Speech Engine 음성 연결, 마이크 입력, 끼어들었을 때 재생 멈춤입니다.
Bedrock 답변 생성은 정민님, 화면은 선영님(#93/PR #94), 한국어 설정과 지연 측정은 시연님(#95), AWS 서버·배포·통합은 민준님 담당입니다.

## 구조

```
브라우저 ──(WebRTC 음성)── ElevenLabs Speech Engine ──(WebSocket 글)── speech-engine-server.mjs ── 답변 생성기
  │  마이크 녹음·답변 재생                   STT·말 끝 감지·TTS·끼어들기 감지         사용자 말 → 답변 글 스트림        mock / Bedrock
  └─ POST /api/realtime-poc/token (Next) ── ElevenLabs 대화 토큰 발급 (API 키는 서버에만)
```

- **음성은 우리 서버를 지나지 않습니다.** 음성 인식·합성·재생은 ElevenLabs와 브라우저 SDK가 처리하고, 우리 서버는 글만 주고받습니다.
- **끼어들기:** 사용자가 답변 도중 말하면 ElevenLabs가 브라우저에 `interruption` 이벤트를 보냅니다. SDK는 이 이벤트를 받으면 재생을 멈추고(`output.interrupt()`) 듣는 중으로 돌아갑니다. 동시에 서버에는 새 `user_transcript`가 오고, SDK가 이전 답변의 `AbortSignal`을 abort해서 생성을 멈춥니다. 늦게 도착한 이전 답변 조각은 ElevenLabs가 버립니다(`event_id` 기준).
- 끼어들기 이벤트가 오려면 Speech Engine 설정의 `conversation.client_events`에 `interruption`과 `audio`가 있어야 합니다. `create-engine.mjs`가 이 값을 넣습니다.

## 파일

| 파일 | 역할 |
| --- | --- |
| `src/features/realtime-voice/voice-state.ts` | 화면 상태(`idle`·`listening`·`thinking`·`speaking`·`error` 등)와 오류 안내 문구. PR #94의 샘플 이벤트 이름에 맞춤 |
| `src/features/realtime-voice/speech-engine-client.ts` | 마이크 권한 확인 → 토큰 → SDK 연결. SDK 이벤트를 화면 상태로 바꾸고, 응답 지연과 끼어들기 시각을 기록 |
| `src/features/realtime-voice/use-speech-engine-voice.ts` | 화면용 React 훅 `{ state, start, stop }`. 화면을 벗어나면(`pagehide`) 연결을 끊음 |
| `src/app/realtime-voice-test/page.tsx` | 연결 확인용 시험 화면. `REALTIME_POC_ENABLED=1`일 때만 열림 |
| `src/server/realtime-poc/token.ts`, `src/app/api/realtime-poc/token/route.ts` | 대화 토큰 발급. 같은 출처 요청만 받고, 분당 발급 수를 제한함 |
| `scripts/realtime-poc/speech-engine-server.mjs` | Speech Engine이 접속하는 WS 서버. JWT를 검증하고 답변을 스트리밍함 |
| `scripts/realtime-poc/answer-relay.mjs` | 답변 생성기 연결부(기본은 mock). 끼어들면 생성기를 멈춤 |
| `scripts/realtime-poc/create-engine.mjs` | 한국어(`ko`) Speech Engine 생성·갱신. 기본은 미리보기만 함 |

## 환경 변수 (이름만. 값과 키는 `.env.local`에만 두고 커밋하지 않습니다)

| 이름 | 필수 | 용도 |
| --- | --- | --- |
| `REALTIME_POC_ENABLED` | 필수 | `1`일 때만 시험 화면과 토큰 발급이 열림 |
| `ELEVENLABS_API_KEY` | 필수 | 토큰 발급, 엔진 생성, WS 서버의 JWT 검증 |
| `ELEVENLABS_SPEECH_ENGINE_ID` | 필수 | 엔진 생성 뒤에 얻는 `seng_...`. 없으면 WS 서버가 시작하지 않음 |
| `ELEVENLABS_VOICE_ID` | 선택 | 엔진 생성 때 `tts.voiceId`로 명시 전달. 없으면 ElevenLabs 기본값. 기존 Bill 음성을 쓰려면 Bill의 Voice ID를 넣음 |
| `REALTIME_POC_TTS_MODEL` | 선택 | 기본 `eleven_flash_v2_5` |
| `REALTIME_POC_ANSWER_MODULE` | 선택 | 비우면 mock 답변. 정민님 모듈 경로를 넣으면 실제 생성기 |
| `REALTIME_POC_WS_PORT` / `REALTIME_POC_WS_PATH` / `REALTIME_POC_DEBUG` | 선택 | 기본 `3001` / `/ws` / 꺼짐 |
| `REALTIME_POC_TOKENS_PER_MINUTE`, `ELEVENLABS_API_BASE_URL` | 선택 | 토큰 발급 제한(기본 분당 6회), API 주소 변경 |

## 실행 순서

WS 서버는 `ELEVENLABS_SPEECH_ENGINE_ID`가 있어야 시작하므로, 엔진을 먼저 만들고 서버를 실행합니다.

### A. 키 없이 하는 확인 (mock, 비용 없음)

실제 ElevenLabs에는 연결하지 않습니다. 상태 전이, 토큰 오류, WS 서버의 끼어들기 취소 동작만 확인합니다.

```
npm ci
npm test                  # 단위 테스트
npm run build
npm run test:http         # WS 서버 통합 테스트 포함. ElevenLabs 역할을 흉내 냄
```

### B. 실제 엔진으로 하는 시험 (유료 계정, 실행 전 담당과 확인)

1. `.env.local`에 `REALTIME_POC_ENABLED=1`, `ELEVENLABS_API_KEY`를 넣습니다.
2. 외부 주소를 엽니다: `cloudflared tunnel --url http://localhost:3001` → 출력된 `https://xxx.trycloudflare.com`을 기록합니다. 민준님이 공개 `wss://` 주소를 주면 터널 대신 그 주소를 씁니다.
3. 엔진을 만듭니다(엔진 생성·갱신은 담당과 확인한 뒤에만 `--apply`).
   - 설정 미리보기: `npm run realtime-poc:engine -- --ws-url=wss://xxx.trycloudflare.com/ws`
   - 실제 생성: 위 명령 끝에 `--apply`를 붙입니다. 출력된 `seng_...`를 `.env.local`의 `ELEVENLABS_SPEECH_ENGINE_ID`에 넣습니다.
   - 터널 주소가 바뀌면 `--update=seng_... --apply`로 `ws_url`만 갱신합니다.
   - 미확인: 엔진 생성 시 ElevenLabs가 `ws_url`에 먼저 접속해 보는지는 확인하지 못했습니다. 생성이 서버 미실행으로 거절되면 서버를 임시 ID(`ELEVENLABS_SPEECH_ENGINE_ID=seng_placeholder`)로 먼저 띄운 뒤 다시 시도합니다.
4. WS 서버를 실행합니다: `npm run realtime-poc:server` (`REALTIME_POC_ANSWER_MODULE`이 비어 있으면 mock 답변)
   - 의존성 불러오기가 느린 PC에서는 "준비" 로그가 나오기까지 20초 넘게 걸릴 수 있습니다(Windows 11, Node 24.12.0에서 약 25초).
5. 다른 터미널에서 `npm run dev`를 실행하고 `http://localhost:3000/realtime-voice-test`에 접속합니다.
6. **대화 시작**을 누르고 마이크를 허용한 뒤 말합니다 → 답변을 듣습니다 → **답변 도중 다시 말합니다** → 재생이 멈추고 '듣는 중'으로 바뀌는지 확인합니다.
   - mock 답변은 끼어들기 시험을 하기 쉽도록 일부러 길게 만들었습니다.
   - 휴대폰에서 시험하려면 https가 필요합니다. 기존 안내처럼 Next에도 터널을 붙이고 `APP_ORIGIN=<터널 주소>`를 설정합니다.

## 측정값의 정의와 한계

- **`state.timing.lastResponseLatencyMs`:** 사용자 메시지(`user_transcript`) 이벤트가 온 시각부터 상태가 `speaking`으로 바뀐 이벤트까지입니다. 실제 말이 끝난 시각이나 첫 소리가 재생된 시각이 아닙니다. 말 끝 감지와 STT 지연, 오디오 재생 시작 지연은 포함되지 않았습니다.
- **끼어들기:** 기록하는 것은 `interruption` 이벤트가 도착한 시각입니다. 실제로 소리가 멈춘 시각은 측정하지 않았습니다. 이 둘은 같은 값이 아닙니다.
- **서버 기록:** WS 서버의 `event: "answer"` 기록은 서버 기준 첫 조각과 전체 시간입니다. 브라우저는 `state.conversationId`를 화면에 표시하지만, 서버 기록에 같은 값을 남기는 연결은 아직 없습니다.
- **`x-region`:** 이 Speech Engine 실시간 경로에서는 응답 헤더를 관측하거나 기록하지 않습니다. PR #101의 `x-region` 기록은 직접 HTTP TTS 요청에만 해당합니다. 엔진 연결에서 어느 요청의 헤더를 볼 수 있는지(토큰 발급 요청 응답, 엔진 생성 응답 등)와 대화 식별자(`conversation_id`) 연결은 아직 정하지 않았습니다.

## 다른 담당과 연결하는 지점

- **정민님(Bedrock):** 다음 형식의 모듈 하나만 만들면 됩니다. `REALTIME_POC_ANSWER_MODULE=<경로>`로 연결합니다.
  ```js
  export async function* answer({ transcript, signal }) {
    // transcript: [{ role: "user" | "agent", content }] — 마지막 항목이 이번 사용자 발화
    // signal: 사용자가 끼어들면 abort 됨 → Bedrock 스트림 요청에 그대로 전달
    for await (const text of bedrockStream(transcript, { signal })) yield text;
  }
  ```
  - 기존 답변 검증(출처·말투)은 이 함수 안에서 처리할지, 문장 단위로 처리할지 함께 정해야 합니다. 스트리밍 중 검증은 아직 정하지 않았습니다.
- **선영님(화면):** `useSpeechEngineVoice()`의 `state.phase`를 PR #94 상태에 그대로 연결합니다. `listening`→듣는 중, `thinking`→답변 준비 중, `speaking`→답변 중이고, `state.error`는 `VOICE_ERROR_MESSAGES`의 제목·안내에 맞춥니다. 대화 내용은 `state.lines`에 들어 있습니다.
- **시연님(#95):** 화면 기준 `사용자 메시지 이벤트 → 답변 상태 이벤트(ms)`(위 정의 참고, 실제 말 끝·첫 소리가 아님)와 끼어들기 횟수는 `state.timing`에, 서버 기준 첫 조각·전체 시간은 WS 서버의 JSON 기록(`event: "answer"`)에 남습니다. 두 기록 모두 원문과 키는 남기지 않습니다. 한국어 TTS 모델은 `REALTIME_POC_TTS_MODEL`로 바꿉니다.
- **민준님(AWS):** WS 서버는 Next와 별개인 Node 프로세스입니다. Next 라우트는 WebSocket 업그레이드를 받을 수 없습니다. 공개 `wss://` 주소와 `/ws` 경로를 열어 주고, 그 주소로 엔진의 `ws_url`을 갱신해야 합니다. 키는 서버 비밀 설정에만 둡니다.

## 안전 장치와 남은 일

- 토큰 발급은 `REALTIME_POC_ENABLED=1`일 때만 동작하고, 같은 출처 요청만 받으며, 분당 6회로 제한합니다(프로세스 단위).
- 엔진 설정은 대화 최대 300초, 동시 2개, 하루 50회, 음성 원본 비보관(`recordVoice: false`)입니다.
- WS 서버는 SDK의 `attach()`로 `X-Elevenlabs-Speech-Engine-Authorization` JWT를 검증합니다(`disableAuth` 사용 안 함).
- **미확인:** 다음 항목은 아직 실제 ElevenLabs 계정으로 시험하지 않았습니다. `language: "ko"` 수용 여부, `eleven_flash_v2_5` 한국어 음질, 실제 끼어들기 체감, iPhone Safari WebRTC.
- **남은 일:** SDK 2.75의 생성 요청에는 `auth.enable_auth` 항목이 없습니다. 엔진 ID만 아는 사람이 직접 대화를 시작하지 못하도록 대시보드에서 인증 필수를 켜야 하는지 확인이 필요합니다.
- 이 경로는 기존 사용량 장부(`USAGE_PROVIDER_PLANS`)를 거치지 않습니다. 비용은 엔진의 호출 제한과 ElevenLabs 콘솔에서 관리합니다. 정식 연결 때 장부 연동을 다시 검토합니다.

## 확인한 내용 (실제 키 없이)

- 단위 테스트: 상태 전이, 마이크 거부·장치 없음·http 접속, 토큰 오류 처리, 연결 중 종료, 오류 화면 유지, 토큰 발급 제한, 키 비노출.
- 통합 테스트(`tests/integration/realtime-poc-ws.test.mjs`): 실제 WS 서버를 띄우고 ElevenLabs 역할을 흉내 냈습니다. 서명 없는 접속과 다른 키로 서명한 접속은 거절됐고, ping/pong, 답변 스트리밍, **끼어들면 이전 답변이 멈추고 새 답변이 끝까지 오는 것**, 기록에 대화 원문·키가 없는 것을 확인했습니다.
