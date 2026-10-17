# W01-04 iPhone Safari recording diagnostics

실기기 상태(2026-10-01): 담당자(이유진)가 PC Chrome과 iPhone Safari 실기기에서 녹음 → STT → 인식문 수정 → 수동 전송을 직접 확인했다. 기기·OS 버전과 측정값(MIME, 인식문)은 이슈 #13·#14 코멘트에 기록한다. Android Chrome은 팀 결정으로 현재 시험 환경에서 제외했고 후속 보완 대상이다. 아래의 자동 실행 기록은 실기기 결과와 구분한다.

## 2026-10-01 "버튼을 눌러도 반응 없음" 원인

확인된 사실 (PC Chrome 154 자동 실행, 실제 사람 목소리·iPhone 시험 아님):

- Next.js 16 dev 서버는 허용되지 않은 호스트의 `/_next/hmr` WebSocket을
  `node_modules/next/dist/server/lib/router-utils/block-cross-site-dev.js`에서 거절한다.
  WebSocket 소켓에는 상태 줄 없이 `Unauthorized` 12바이트만 쓰므로 cloudflared가
  `malformed HTTP response "Unauthorized"`로 기록한다. 앱의 인증/proxy/middleware는 없다.
- 이 거절이 일어난 페이지는 HTML만 보이고 JavaScript가 실행되지 않는다(진단 패널
  `pageScriptRunning=false`). 그래서 녹음 시작 버튼이 아무 반응도 하지 않는다.
- 기본 허용은 `localhost`뿐이다. `http://127.0.0.1:3000`, `http://172.x.x.x:3000`(Network 주소),
  `*.trycloudflare.com` 모두 같은 증상이 재현되었다.
- `next.config.ts`의 `allowedDevOrigins`에 `*.trycloudflare.com`, `127.0.0.1`을 development에서만
  추가한 뒤 두 호스트 모두 HMR 101, 버튼 동작, 녹음 시작까지 확인했다.
- `POST /api/transcriptions`는 이 보호 대상이 아니며 터널 Origin/Host로도 handler까지 도달한다.

판별 순서: `pageScriptRunning=false` → 주소/HMR 차단. `recordButtonClicked=false` → 버튼/UI.
`getUserMediaRequested=false` → 클릭 이후 로직(`clickResult`, `stage` 확인).
`getUserMediaSucceeded=false` → 권한/마이크(`error.name`). `mediaRecorderCreated=false` → MIME/생성자.
`mediaRecorderStarted=false` → `recorder.start()`.

## 확인한 경로와 변경 범위

`/voice-input-test` → `VoiceInputDemo` → `VoiceInput` 클릭 → `VoiceRecorder.start()`.
기존 글이 있으면 `바꾸고 녹음`을 직접 눌렀을 때 시작한다.
AudioContext 생성/resume, getUserMedia 호출은 첫 await 이전 클릭 호출 스택에 있다.
MIME 우선순위, 크기/시간 제한, STT 전송, 텍스트 보존 동작은 유지한다.
webkitAudioContext 대체 생성자를 지원한다.

NODE_ENV가 정확히 development일 때만 패널을 표시하고 진단을 수집한다.
클릭 후 기능 검사, MIME 지원, selectedMime/actualMime, 마지막 stage,
getUserMediaRequested/Succeeded, mediaRecorderCreated/Started, resume 상태,
streamTrack 개수/readyState/enabled/muted, dataavailable 횟수, blob.type/size, durationMs,
errorStage/error.name/error.message를 표시한다. false는 미도달도 포함한다.
클릭 전에도 pageScriptRunning, recordButtonClicked, buttonDisabled와 기능 검사 결과를 표시한다.
진단은 녹음 API 예외만 취급한다. 서버 응답/환경변수/키/헤더/기기 이름/
음성/인식문을 수집하지 않으며 예외의 URL 및 credential 패턴을 마스킹한다.

## MIME

후보 순서는 audio/webm;codecs=opus → audio/mp4 → audio/ogg;codecs=opus.
isTypeSupported가 true인 첫 후보만 생성자에 전달한다.
WebM false, MP4 true이면 audio/mp4가 선택된다. WebM도 true이면 기존대로 WebM이다.
모두 false이면 AUDIO_UNSUPPORTED이며 강제 MIME 생성은 없다.
실제 iPhone의 selectedMime과 생성 후 actualMime은 패널로 확인해야 한다.

## 원인 판별

- capability check: secure context와 API 존재 여부 확인. 기존 코드는 webkitAudioContext만 있는 환경을 차단했다.
- MIME negotiation: 지원 후보가 없는지 확인.
- getUserMedia 요청 후 성공 false: 권한 대기 또는 error.name 확인.
- NotAllowedError: 마이크 권한 거부/정책 차단 가능. 사이트 권한 확인.
- NotFoundError: 마이크 없음. NotReadableError: 장치 접근 실패/다른 앱 사용 가능.
- await AudioContext.resume(): resume이 pending인지 rejected인지, context 상태 확인.
- MediaRecorder constructor 또는 recorder.start(): error.name/message 확인.
- 페이지가 idle로 돌아가고 취소 메시지가 있으면 기존 pagehide/visibilitychange 취소 경로도 확인.

## iPhone 재시험 순서

1. PC 저장소에서 npm run dev 실행. 이미 실행 중이면 해당 서버를 유지한다.
2. Cloudflare Tunnel이 그 개발 서버 포트로 연결되었는지 확인한다.
3. iPhone Safari에서 Tunnel HTTPS 주소의 /voice-input-test를 열고 새로고침한다.
4. development 진단 패널이 보이는지 확인한다. 안 보이면 개발 서버 연결/새로고침부터 확인한다.
5. 질문 입력란을 비우고 녹음 시작을 직접 탭한다. 권한 창이 뜨면 허용한다.
6. 3~5초 말한다. 화면을 켜 두고 Safari를 앞에 유지한다. 녹음 중 문구/타이머를 확인한다.
7. 녹음 종료 후 인식문을 확인한다. 시작 성공과 STT 성공을 따로 기록한다.
8. 실패하면 새로고침/재시도 전에 패널 전체를 캡처한다. iOS 버전과 마지막 stage,
   errorStage/error.name/error.message, MIME 지원/selectedMime/actualMime을 기록한다.
9. 권한 거부 시 오류가 표시되는지 확인하고 질문 입력란에 글을 입력해 전송한다.
10. Safari의 해당 사이트 마이크 권한을 허용/묻기로 되돌린 후 새로고침하고 재시험한다.
11. 권한 대기/resume 대기가 지속되면 녹음·인식 취소로 글 입력으로 복귀한다.

## 자동 검증

- npm test: 67개 통과 (MP4, 동기 권한 요청, 예외 단계, 오류 이름별 코드, track/blob 진단, production 진단 미수집 포함).
- npm run lint 및 tsc --noEmit --incremental false 통과.
- PC Chrome 154 headless: 합성 마이크 WebM → WAV → 실제 HTTP handler/adapter,
  외부 Azure 응답만 mock. 취소, 권한 거부, 텍스트 입력/전송, 360px 레이아웃 통과.
- 위 자동 검증은 사람 목소리·iPhone 시험이 아니다. 실기기 결과는 문서 첫머리의 담당자 확인과 이슈 코멘트를 따른다.
