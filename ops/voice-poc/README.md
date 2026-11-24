# #8 통합 후보 빌드·배포 인수

이 폴더는 운영 서버에서 수집한 Dockerfile을 보존하고 PR97·PR106 통합에 필요한 voice 소스/자료 복사와 Node 실행 조건을 추가한 것이다. 운영 실행 구성을 변경하거나 배포한 결과물이 아니다. 11/24에 별도 백업 파일을 생성한 결과는 아래에 구분해 기록했다. 현재 단계는 #8 PR 검토이며 **승인 전 아래 배포·엔진 갱신 명령을 실행하지 않는다**.

## 보존한 운영 변경

`operating-source-lock.json`은 브라우저 SSH로 수집한 11개 운영 소스의 정규화된 SHA-256과 기준 커밋을 기록한다. 운영 Git의 미커밋 보완과 미추적 실제 음성 화면·훅 경합 검사를 가져왔으며, PR97의 준비 신호 대기/ASR 키워드와 함께 유지한다. 비밀 설정·인증서·개인키·대화 로그는 수집하거나 Git에 추가하지 않았다.

실제 이미지와 소스 파일의 완전한 일치는 아직 확인하지 못했다. 운영 서버 밖 보완본이 별도로 있는지도 미확인이다. 이 목록이 서버 전체 백업을 대신하지 않는다.

## 통합 변경

- Docker web: 운영의 Node 24.22.3, standalone 출력, 정적 파일 복사와 2GB 서버의 빌드 메모리/worker 제한을 유지한다.
- Docker voice: PR106이 읽는 `src`·`data`를 복사하고 `--conditions=react-server`로 실행한다. 모델이나 답변 검사 로직은 PR106 그대로다.
- `compose.integration.yaml`: 기존 `sejong-poc` 프로젝트의 web·voice만 새 이미지로 교체하는 추가 파일이다. 기존 Compose·gateway·TLS/WSS·JWT·엔진·볼륨·네트워크는 다시 만들지 않는다.
- voice의 기존 ElevenLabs 설정은 기본 Compose가 사용하던 `private/voice.env`에서 유지한다. 기존 `/opt/sejong-voice-poc/.env.runtime`을 추가해 `AWS_BEARER_TOKEN_BEDROCK`을 서버에서 주입한다. 값을 이미지·Git·브라우저에 넣지 않는다.
- web의 `REALTIME_POC_ANSWER_MODE=bedrock`은 배포자가 지정하는 시험 표시다. 모델 호출 성공을 자동 감지한 값이 아니므로 voice 모듈·실제 상태와 함께 확인해야 한다. 미설정이면 기존 고정 답변 표시다.

현재 SDK 3.1171.0의 bearer 지원은 설치된 SDK 소스에서 정적으로 확인했다. AWS도 JavaScript SDK의 API 키 지원과 `AWS_BEARER_TOKEN_BEDROCK` 사용을 안내한다([지원 SDK](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-supported.html), [API 키 사용](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-use.html)). 기존 키의 유효성·권한·실제 모델 호출 성공은 확인하지 않았으며 새 키를 발급하지 않는다.

## 11/24 백업과 복구 준비 결과

기존 운영본의 백업을 만들고 아카이브 무결성·접근 권한과 복구 구성의 정적 결합을 확인했다. 백업 전후 컨테이너의 이미지·시작 시각·재시작 횟수·실행 상태가 같았다. 내부 보관 위치와 상세 복구 기록은 비공개 운영 자료로 관리한다.

같은 서버에서 만든 실행 중 백업이므로 전체 디스크 스냅샷이나 서버 소실 대비 외부 백업이 아니다. 실제 복원과 음성 재시험은 수행하지 않았다. 배포 전에 백업의 유효성과 당시 엔진 설정을 다시 확인해야 한다. 이번 작업에서 배포·컨테이너 재생성·재시작·엔진 변경은 하지 않았다.

## 배포 승인 후 확인할 것

### Haiku 5.5 통합 준비 (11/24)

PR106 `49a1066`의 모델·추론 설정 변경을 기능 커밋 `1f77eb4`로 반영했다. 해당 커밋의 원격 CI 전체 통과 후 운영 서버에서 web·voice 이미지를 기존 태그와 분리해 빌드했으며, 이미지의 소스 커밋 라벨과 식별자를 확인했다. 기존 이미지는 덮어쓰지 않았다.

실제 운영 base Compose와 통합 추가 파일의 결합을 확인했다. 기존 음성 인증·엔진 ID·APP_ORIGIN과 네트워크·포트·마운트는 유지되고, AWS 인증 변수의 설정 유무·답변 모듈·Node 실행 조건·Haiku 화면 표시 설정이 전달되는 것을 비밀값 출력 없이 정적으로 대조했다. 이 확인은 인증의 유효성이나 모델 호출 성공을 보장하지 않는다.

기존 백업의 SHA-256을 재검증했고, 이미지 빌드 전후 운영 컨테이너 ID·이미지·시작 시각·재시작 횟수가 같았다. 현재는 **배포 전 준비 완료**이며 서버 전환·엔진 변경·실제 모델/마이크 호출은 하지 않았다. 사용자가 선택한 절차는 PR107 최신 커밋 재승인 → dev 병합 → dev에서 main으로 배포 PR → 승인·CI 확인 → 서버 전환이다. main 반영 후 실제 배포 커밋과 이미지의 코드 일치를 다시 확인한다.

1. 배포할 #8 PR·커밋과 기존 미병합 PR97·PR106을 함께 검토한다. 기능 담당자의 리뷰 없이 원래 PR을 완료 처리하지 않는다.
2. 기존 실행 이미지의 **전체 ID**를 다시 확인하고, 이전 이미지를 별도 rollback 태그 또는 안전한 아카이브로 보존한다. 새 빌드에는 고유 태그를 써서 `20261113`·`20261114` 태그를 덮어쓰지 않는다. image/volume prune은 하지 않는다.
3. 기본 Compose, 현재 환경 파일, 인증·인증서·라우팅 파일을 서버의 권한 제한된 백업 경로에 보존한다. 현재 파일만 남겨두고 백업이 있다고 처리하지 않는다. 비밀값을 PR·보고서·터미널 출력에 붙이지 않는다.
4. 기존 `sejong-poc` 프로젝트, 작업 디렉터리 `/opt/sejong-poc-ops`, 서비스 이름 web·voice와 별도 프로젝트 `sejong-poc-public`을 유지한다. web·voice 재생성은 진행 중 대화를 끊을 수 있으므로 유진·선영과 시험 시점을 맞춘다.

## 빌드와 적용 명령 형식

아래는 **실행하지 않은 명령 형식**이다. 실제 서버 릴리스 경로·검토 커밋·이미지 보존을 확인한 뒤 사용한다. 기존 폴더 위에 덮어쓰지 말고 승인된 코드를 새 릴리스 경로에 준비한다. Docker build context는 비밀 파일이 제외된 저장소 루트다.

```sh
# 승인된 새 릴리스의 저장소 루트에서 실행. 두 변수는 고유한 검토 버전 태그여야 한다.
export POC_WEB_IMAGE='sejong-poc-web:<reviewed-version>'
export POC_VOICE_IMAGE='sejong-poc-voice:<reviewed-version>'
sudo docker build --target web -f ops/voice-poc/Dockerfile -t "$POC_WEB_IMAGE" .
sudo docker build --target voice -f ops/voice-poc/Dockerfile -t "$POC_VOICE_IMAGE" .

# sudo에 이미지 선택 변수만 전달한다. 인증 비밀값을 명령줄에 넣지 않는다.
sudo env POC_WEB_IMAGE="$POC_WEB_IMAGE" POC_VOICE_IMAGE="$POC_VOICE_IMAGE" \
  docker compose -p sejong-poc \
  -f /opt/sejong-poc-ops/voice-compose.yaml \
  -f "$PWD/ops/voice-poc/compose.integration.yaml" config --quiet
```

`config --quiet`가 성공하고 승인된 설정·복구 이미지가 확인된 후에만 위와 같은 파일·변수·프로젝트로 `up -d --no-build --pull never web voice`를 실행한다. 기본 파일의 서비스가 없거나 이미지·환경 경로가 달라지면 자동으로 새 구성을 추정하지 말고 인수 문서를 갱신한다.

## 상태 확인과 되돌리기

- 기존 gateway를 경유한 `/realtime-poc` HTTPS 표시와 voice `/healthz`를 확인한다. voice 포트를 외부에 새로 열지 않는다. `answer: module`은 사용자 모듈을 읽었다는 표시이며 실제 Haiku 호출 성공을 뜻하지 않는다.
- 두 컨테이너의 실제 이미지 ID와 voice의 모듈 지정, AWS 변수의 **이름/설정 유무**만 확인한다. 환경 변수 값이나 전체 `docker inspect`를 게시하지 않는다.
- 기존 base 파일을 변경하지 않고 추가 파일로만 적용했다면, 보존한 기존 이미지·base 파일·환경 설정을 확인한 뒤 아래 형식으로 web·voice를 복구할 수 있다. base 파일이 변경됐다면 백업 구성을 먼저 복원해야 한다.

```sh
# 승인 후 실제 배포를 되돌릴 때만 사용. 현재 이 명령을 실행하지 않았다.
sudo docker compose -p sejong-poc \
  -f /opt/sejong-poc-ops/voice-compose.yaml \
  up -d --no-build --pull never web voice
```

복구 후 기존 고정 답변 표시와 상태를 다시 확인한다. DB·볼륨·인증서·사용량 기록을 삭제하지 않는다. 엔진 설정까지 변경했다면 이미지 복구만으로 원복되지 않으므로 엔진의 변경 전 설정을 별도로 보존·복원해야 한다.

## 엔진과 실제 재시험

PR97의 ASR 키워드는 코드 배포와 별개다. 기존 엔진 설정의 인증·Bill 음성·한국어·기존 WSS 주소·보관 정책·호출 제한을 먼저 확인하고, 갱신 전 사본을 서버 내부에 보존한다. `realtime-poc:engine --update=... --apply`는 전체 설정을 전달하므로 키워드만 바뀐다고 가정하지 않는다. 이번 PR에서 엔진 API를 호출하거나 갱신하지 않았다.

배포 버전·주소·고정 답변/Haiku 모드를 공유한 뒤 유진이 PC에서 실제 마이크·끼어들기·스피커/이어폰·종료를, 선영이 모바일 시작·종료를 확인한다. 효과가 확인되기 전에는 앞부분 잘림 해결이나 PoC 완료를 선언하지 않는다. #89 평가는 이 결과와 분리해 기존 10문항으로 진행한다.
