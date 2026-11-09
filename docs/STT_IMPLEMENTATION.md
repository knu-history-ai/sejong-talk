# W01-04 / W02-04 — Azure Speech Free(F0) 구현·검증 보고서

> 2026-10-01 갱신: 담당자(이유진)가 PC Chrome과 iPhone Safari 실기기에서 녹음 → STT → 수정 → 수동 전송을 확인했다. Android Chrome은 팀 결정으로 현재 시험 환경에서 제외했다. iPhone에서 버튼이 반응하지 않던 원인(dev 서버의 터널 Origin 차단)과 해결은 [녹음 진단 기록](VOICE_INPUT_IPHONE_DEBUG.md)에 있다. 아래 본문은 09-30 기준이며 "실기기 확인 필요" 표기와 시험 개수(현재 `npm test` 73개)는 그 시점 값이다.

2026-09-30. 최신 사용자 결정: STT 공급자는 Azure Speech, 개발/교내 시연은 Free(F0). 이 문서의 PASS는 명시된 자동 시험 또는 합성 음성 시험의 범위입니다. 실제 기기 호환 완료를 뜻하지 않습니다.

## 기술 결정과 기존 구조

- Next.js 16.3.5 App Router / React 19 / TypeScript / Node 24 구조와 기존 VoiceRecorder·VoiceInput을 유지했습니다.
- `STT_PROVIDER=azure`, `AZURE_SPEECH_REGION=koreacentral`. 키는 `.env.local`에만 있으며 Git 제외 상태입니다.
- **현재 Azure 방식: Azure Speech Free(F0) + Short Audio REST STT.** 기존 Fast Transcription 호출을 교체했습니다. 기본 경로·비교 화면 모두 Fast/Batch로 우회하지 않습니다.
- endpoint: `https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=ko-KR&format=detailed`
- 서버에서만 subscription key를 헤더로 보내며, 실제 WAV bytes를 요청 본문으로 보냅니다. Azure multipart 업로드는 사용하지 않습니다.
- 상세 응답은 `NBest[0].Display`, 단순 응답은 `DisplayText`를 사용합니다. 공통 계약은 그대로 `{requestId, operation:"transcription", status:"completed", text}`입니다.
- NoMatch / InitialSilenceTimeout / 빈 인식문은 기존 인식 결과 없음 안내로 처리합니다. HTTP 인증/한도/서버 오류는 안전한 안내로 변환하고 원본 오류 본문은 출력하지 않습니다.
- 서버 Azure 호출 timeout은 20초이며 AbortSignal을 전달합니다. 기존 UI의 전체 전사 대기 제한도 20초를 유지합니다. 변환/업로드 시간이 포함되므로 UI가 먼저 취소할 수 있습니다.
- 대화·LLM·TTS와 `src/contracts/index.ts`, `docs/API_CONTRACT.md`는 변경하지 않았습니다. 새로운 AI 서버는 만들지 않았습니다.

### F0 선택 이유

프로젝트 녹음은 최대 30초입니다. 공식 가격표의 F0 실시간 STT 무료량은 월 5 audio hours이므로 `5 × 3600 ÷ 30 = 600`, 최대 길이 녹음 약 600회/월에 해당합니다. 이는 모두 30초인 요청만 가정한 단순 환산이며 재시도·다른 STT 사용량도 같은 무료량을 소모합니다.

F0 실시간 STT 동시 요청은 1개이며 Fast Transcription/Batch는 F0에서 사용하지 않습니다. 개발·교내 시연에는 적합하지만 실제 다중 사용자 운영에서는 S0 또는 서버 대기열을 검토해야 합니다. 현재 앱은 사용자별 중복 클릭을 막지만 여러 탭/사용자/서버 인스턴스를 포괄하는 전역 대기열을 구현하지 않았습니다. 동시 호출 제한은 Azure 429 안내로 복구합니다.

이 작업은 F0 호환 API를 선택하고 호출을 검증했습니다. Azure 관리 API로 계정의 실제 가격 계층을 조회하거나 변경한 것은 아닙니다. 리소스가 F0인지 포털에서 확인하세요.

공식 근거: [Short Audio REST 규격](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text-short), [F0 가격·무료량](https://azure.microsoft.com/en-us/pricing/details/speech/), [동시 요청 및 Fast/Batch 제한](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits).

## 오디오 변환과 제한

`MediaRecorder WebM/Opus 또는 MP4/AAC → OfflineAudioContext.decodeAudioData → 16kHz resample → 채널 평균으로 mono → PCM signed 16-bit little-endian WAV → FormData audio → 서버 → Azure`

- 브라우저가 지원하는 원본 MIME을 감지하는 기존 코드를 유지합니다. 확장자만 바꾸지 않습니다.
- OfflineAudioContext의 sampleRate를 16000으로 지정하면 decode 과정에서 해당 sampleRate로 변환됩니다. 오프라인 처리이므로 마이크/스피커를 추가로 열지 않습니다.
- 원본 녹음 30초/5,000,000 bytes 제한을 유지합니다. 파일 업로드는 decode한 길이가 30초를 넘으면 거절합니다.
- 기존 녹음 controller가 허용하던 최대 250ms 종료/코덱 오차는 녹음 경로에서만 인정합니다. 변환 출력은 항상 480,000 samples 이하로 잘라 30초를 넘기지 않습니다. 업로드 파일에는 이 여유를 적용하지 않습니다.
- 30초 mono PCM16 16kHz WAV는 **960,044 bytes**입니다. 변환 후에도 5MB 한도를 검사합니다.
- 브라우저 decode 실패는 AUDIO_UNSUPPORTED, 무음은 AUDIO_SILENT로 복구합니다. 취소된 decode가 늦게 끝나도 업로드하거나 문장을 덮어쓰지 않습니다.
- 서버 Azure adapter는 실제 RIFF/fmt/data chunk, PCM format=1, channels=1, sampleRate=16000, bits=16, byteRate, blockAlign, payload 길이와 30초 한도를 확인합니다. 위장된 WAV·무음은 호출 전에 거절합니다.
- 원본/변환 음성은 메모리에서 처리하며 사용자 음성 파일이나 일반 로그를 만들지 않습니다. 저장소의 WAV fixture는 기존 합성 음성입니다.
- 비교 화면도 모든 공급자에 **동일하게 변환된 WAV**를 보냅니다. 원본 MIME/bytes와 전송 MIME/bytes를 기록합니다. 이는 원본 WebM/MP4를 각 공급자가 직접 받는지 시험하는 모드는 아닙니다.

## 1. 이번 단계에서 수정한 파일

| 파일 | 변경 |
| --- | --- |
| `.env.example`, `.env.local` | Azure 선택값 설정, 키는 비공개 유지 |
| `src/server/stt/azure.ts` | Fast 제거, Short Audio REST, 20초 timeout, WAV 검증, 상세/단순 응답 파싱 |
| `src/server/stt/common.ts` | 안전한 HTTP 상태 수집, 다른 어댑터 호환 유지 |
| `src/server/stt/index.ts` | Azure가 자체 20초 제한을 쓰도록 기존 15초 공통 제한 분리 |
| `src/features/voice-input/transcription.ts` | 실제 WAV 정규화 후 업로드 |
| `src/features/voice-input/recorder.ts` | 변환 실패 오류 코드 전달, 기존 상태/자원 관리 유지 |
| `src/features/voice-input/voice-input.tsx` | 원본 및 목표 전송 형식 메타데이터 안내 |
| `src/features/voice-input/stt-comparison.tsx` | 공통 정규화, 중복 decode 제거, 원본/전송 메타데이터 기록 |
| `tests/stt.test.mjs` | 새 Azure endpoint/원본 PCM bytes 검증, 기존 assertion 유지 |
| `tests/stt-live.mjs` | 기존 fixture를 실제 브라우저 변환 후 Azure Short REST만 시험 |
| `tests/e2e/voice-input.mjs` | WebM → WAV → 실제 HTTP handler/Azure adapter 경계 검증 |
| `tests/e2e/stt-comparison.mjs` | 비교 업로드의 실제 WAV 헤더 검증 |
| `docs/STT_SMOKE_RESULT.json` | 새 API의 실제 시험 결과 |
| `docs/STT_IMPLEMENTATION.md`, `docs/STT_W01_FEASIBILITY.md`, `docs/VOICE_INPUT_W02.md` | 현재 선택과 완료 범위 반영 |
| `docs/stt-comparison-preview.png` | 정규화 안내를 포함한 모의 비교 화면 캡처 |

위 목록은 이번 F0 전환 단계 기준입니다. 이전 단계에서 만든 기존 어댑터/비교 UI와 미커밋 변경을 유지했습니다.

## 2. 새로 만든 파일

| 파일 | 역할 |
| --- | --- |
| `src/features/voice-input/pcm-wav.ts` | PCM16 WAV encoder 및 실제 헤더/길이 검사 |
| `src/features/voice-input/normalize-audio.ts` | 브라우저 decode/resample/mono/WAV 변환과 취소 |
| `tests/audio-normalization.test.mjs` | 헤더·30초·무음·손상·취소·패딩 시험 |
| `tests/azure-short.test.mjs` | Success/NoMatch/401/403/429/5xx/20초 timeout/취소/멱등성 시험 |
| `tests/helpers/browser-audio.mjs` | 기존 Playwright로 실제 브라우저 정규화 코드를 실행 |
| `tests/e2e/azure-live.mjs` | 실제 Next 서버·Azure까지 연결한 합성 마이크 E2E |
| `docs/STT_BROWSER_RESULT.json` | 실제 Azure 브라우저 E2E 기록 |
| `docs/STT_COMPARISON_HISTORY.json` | 이전 Fast 기반 5종 비교 기록 보존; 현재 F0 근거로 사용하지 않음 |
| `docs/STT_DEVICE_TEST_CHECKLIST.md` | 사용자 실기기 체크리스트 |

## 3. 삭제한 파일

없음. 기존 테스트를 삭제하거나 assertion을 완화하지 않았습니다. 새 프레임워크·SDK·ffmpeg를 추가하지 않았습니다.

## 4. 이전 방식과의 차이

| 구분 | 이전 | 현재 |
| --- | --- | --- |
| Azure API | Fast Transcription, api-version=2025-10-15 | F0 호환 Short Audio REST, language=ko-KR&format=detailed |
| 입력 | multipart 원본 브라우저 파일 | 실제 PCM16/16kHz/mono WAV binary |
| 인식문 | combinedPhrases | NBest[0].Display 또는 DisplayText |
| Azure 대기 제한 | 공통 15초 | 서버 20초, 취소 신호 지원 |
| 형식 검증 | 컨테이너 시그니처 | Azure 호출 전 실제 PCM WAV 헤더/길이/무음 |
| 선택 상태 | 미선정 | STT_PROVIDER=azure |

## 5. 자동 검사 결과

2026-09-30 실행 결과:

- `npm test`: **54개 PASS**. 기존 Node module-type 경고는 남지만 실패 없음.
- `npm run lint`: **PASS**, 경고 없음.
- `npm run typecheck`: **PASS**.
- `npm run build`: **PASS**. 빌드 동안 프로젝트 개발 서버를 중지한 뒤 다시 실행했습니다.
- 실제 키 노출 검사: src/tests/docs/프로덕션 `.next/static` 78개 파일 **PASS**. `.env.local` Git 제외 및 공통 계약 무변경 확인.
- `tests/e2e/voice-input.mjs`: **PASS**. 실제 Chrome MediaRecorder WebM → 정규화 → 실제 HTTP handler → 실제 Azure adapter, 외부 Azure fetch만 모의. 수정/수동 전송/중복 클릭/인식 중 취소/초기화/권한 거절/실패 보존 회귀 시험 유지.
- `tests/e2e/stt-comparison.mjs`: **PASS**. 실제 업로드 decode/resample/헤더, 실패 행 격리, CER, JSON 내보내기, 손상 파일, 모바일 폭.
- `tests/e2e/azure-live.mjs`: **PASS**. 실제 실행 중인 Next 서버와 실제 Azure를 사용한 합성 마이크 E2E. 아래 기록 참조.

브라우저: Chrome 153.0.8010.53 headless. 첫 샌드박스 브라우저 실행은 오디오 처리 대기에서 실패했고, 허용된 외부 실행에서 두 회귀 시험이 통과했습니다. 이를 실제 PC 마이크나 Android/iPhone 시험으로 간주하지 않습니다.

## 6. 실제 Azure smoke test

`tests/fixtures/stt-korean-synthetic.wav` 원본은 22.05kHz입니다. 파일을 보존하고 production 브라우저 정규화 코드를 거쳐 메모리에서 16kHz WAV로 변환했습니다. Fast API는 사용하지 않았습니다.

| 항목 | 실제 값 |
| --- | --- |
| 연결 판정 | PASS |
| HTTP | 200 |
| RecognitionStatus | Success |
| 기준 문장 | 세종대왕은 왜 훈민정음을 만들었나요? |
| 인식 표시문 | 세종대왕은 외훈민 정음을 만들었나요? |
| 응답 시간 | 1321 ms |
| 원문 CER | 15% |
| 공백 제외 CER | 약 5.88% |
| 세종대왕 | 인식 |
| 훈민정음 | 공백 제외 기준 인식; 원문은 “훈민 정음” |
| 전송 WAV | 16kHz / mono / PCM16 / 117,766 bytes / 약 3.679초 |

상세: `docs/STT_SMOKE_RESULT.json`. 연결 PASS와 정확도는 구분합니다. 완전 일치가 아니며 합성 음성 1건으로 실제 아동 음성의 품질을 보장하지 않습니다. 환경변수가 없으면 스크립트는 NEEDS_ENV로 기록합니다.

실제 브라우저 E2E에서는 WebM/Opus 약 4.14초를 132,524 bytes PCM WAV로 변환해 Next → Azure HTTP 200을 확인했습니다. 인식문은 “세종대왕은 외 훈민정음을 만들었나요?세종.”이었습니다. 합성 입력 파일이 반복 재생되어 마지막 “세종”이 추가된 조건입니다. 이후 “훈민정음은 처음에 몇 글자였어요?”로 수정하고 전송을 연속 클릭했을 때 onConfirm은 수정 문장을 **1회만** 받았고, 전사 요청도 1회였습니다. 상세: `docs/STT_BROWSER_RESULT.json`.

## 7. W01-04 현재 상태

**구현·Azure 실제 호출 검증 PASS. 실기기 확인은 미완료입니다.**

| 항목 | 판정 |
| --- | --- |
| 공급자 결정: Azure Speech F0 + Short REST | PASS |
| 시작/종료/취소/시간 표시/30초/5MB/마이크 해제 | PASS — 단위·합성 마이크 자동 시험 |
| 권한 거절/무음/빈 파일/decode 실패/손상/timeout/인식 없음 | PASS — 자동 시험 |
| 한국어 실제 Azure 호출 | PASS — 합성 WAV, CER 15% 기록 |
| Chrome WebM → 실제 WAV → Azure | PASS — 합성 마이크 E2E |
| 비교 도구·CER·역사 용어·처리 시간·내보내기 | PASS — 자동 시험 및 과거 비교 기록 |
| PC 실제 마이크 | 사용자 실기기 확인 필요 |
| Android Chrome 실제 기기 | 사용자 실기기 확인 필요 |
| iPhone Safari 실제 기기/MP4 decode | 사용자 실기기 확인 필요 |

## 8. W02-04 현재 상태

**구현 완료 — 자동 시험 PASS.** 완료 경계는 “녹음 → Azure STT → 인식문 확인/수정 → 수동 전송 → onConfirm이 수정 문장을 1회 수신”입니다.

자동 전송하지 않음, 다시 녹음 전 교체 확인, 실패 시 기존 글 보존, 텍스트 fallback, 중복 클릭 방어, 취소/초기화 뒤 늦은 결과 무시를 유지했습니다. AI 답변 서버 연결은 후속 통합 범위이며 그것이 없다는 이유로 W02-04를 FAIL로 두지 않습니다. 실제 기기 사용성·호환 확인은 별도로 남아 있습니다.

## 9. 사용자가 직접 할 PC/Android/iPhone 시험

[실기기 체크리스트](STT_DEVICE_TEST_CHECKLIST.md)의 세 열을 실제 실행 후 표시하세요. HTTPS/localhost 보안 컨텍스트가 필요하며 휴대폰의 PC LAN HTTP 주소만으로 마이크 사용이 보장되지 않습니다. Safari MP4/AAC가 실제 PCM WAV로 decode되는지와 화면 잠금·복귀·마이크 해제를 특히 확인합니다.

로컬 실행:

1. Node 24에서 `npm run dev`를 실행합니다.
2. `.env.local`의 STT_PROVIDER=azure, AZURE_SPEECH_REGION과 AZURE_SPEECH_KEY 존재를 확인합니다. 키를 화면/이슈에 복사하지 않습니다.
3. `http://localhost:3000/voice-input-test`에서 녹음 → 문장 수정 → 수동 전송을 확인합니다.
4. `http://localhost:3000/dev/stt-test`에서는 같은 변환 WAV를 5곳에 보냅니다. 공급자 비교 버튼은 다른 API의 사용량도 소모합니다.
5. 단위 시험은 `npm test`. 브라우저 도구는 기존 Playwright 설치 경로를 PLAYWRIGHT_MODULE에 지정해 실행합니다. 새 패키지를 프로젝트에 추가하지 않았습니다.
6. `node tests/stt-live.mjs`는 실제 Azure smoke, `node tests/e2e/azure-live.mjs`는 실제 Azure 브라우저 시험입니다. 일반 npm test에는 실제 외부 호출을 넣지 않았습니다.

## 10. GitHub #13/#14 체크 가능한 항목

현재 GitHub 이슈 본문은 이 환경에서 gh 부재 및 웹 접근 실패로 다시 읽지 못했습니다. 아래는 사용자가 준 최신 완료 기준과 저장소 문서를 기준으로 한 판정이며, 실제 체크박스 변경은 하지 않았습니다.

- **#13 체크 가능:** Azure 최종 선정, F0 호환 Short REST 구현, 한국어 실제 호출, WAV 변환/검증, 30초·5MB 및 오류 처리 자동 시험, CER/용어/시간 기록.
- **#13 아직 체크 금지:** PC 실제 마이크·Android·iPhone 호환 완료, 실제 화자/환경 전체 정확도 검증, 모든 실기기 검증까지 포함한 전체 완료.
- **#14 체크 가능:** 녹음·확인·수정·수동 전송(onConfirm) 구현 완료, 중복 방지·마이크 해제·실패 보존 자동 시험. 실제 Azure 연결을 포함한 흐름도 확인했습니다.
- **#14 별도 확인:** 실기기 사용성/호환성을 요구하는 체크박스. AI 서버 연결은 후속 통합이며 이번 구현 완료를 막는 조건이 아닙니다.

Git push, PR merge, issue close 및 원격 체크박스 수정은 수행하지 않았습니다.

## 남은 통합 범위

운영 인증/세션 소유권, 분산 requestId 저장소/사용량 관리, F0 전역 대기열 또는 S0, 대화·TTS 담당자의 onConfirm/onBeforeRecording 연결은 후속입니다. 현재 API/시험 화면은 개발 모드에서만 열리며 요청 캐시는 단일 프로세스 60초/최대 100개입니다. 외부 공급자의 음성 보관 정책은 앱의 메모리 처리와 별개입니다. 사용자가 이전에 보고한 영어 인식 현상은 현재 한국어 실제 호출에서는 재현되지 않았습니다.
