# 날짜 평가도구 사용 안내

관련 이슈: [#62](https://github.com/knu-history-ai/sejong-talk/issues/62).
이 도구는 MODEL 경로에서 자료와 질문을 직접 넣는 예비시험·비교 실험용입니다.
앱의 사료 등록·출처 표시와 음성 인식률을 시험하는 도구는 아닙니다.
#56 앱 통합시험과 #57 자료·앱 연결 업무는 그대로 진행합니다.

## 역할을 먼저 구분해 주세요

- 유진님: 준비된 실행 명령을 실행하고 답변 원문·환경·오류 기록을 전달합니다. 앱 동작 확인은 #56대로 별도로 합니다. 자료·설정·정답표를 편집하거나 내용 점수를 매기지 않습니다.
- 구현·채점 담당: 계획과 기준을 준비하고 코드 검사·AI 예비 채점·사람 채점·집계를 진행합니다.
- 최종 채점자 두 명: 다른 사람이나 AI의 판정을 보기 전에 각자 판정합니다. 차이가 나면 원문과 고정 정답표를 보고 이유를 남겨 확정합니다. 실제 담당자는 별도로 협의해야 합니다.

현재 기본 자료는 시연님이 준비한 S1~S3와 B01~B08입니다. 질문 원문을 바꾸지 않았습니다.
정답표는 기존 답안 기준을 구조화한 초안이며, 기본 상태는 `pilot / draft`입니다.
코드 검증을 통과했다고 사료 독립 검토·실제 오류 확인·AI 채점기 검증·논문 실험이 끝난 것은 아닙니다.

## 유진님이 할 일

Node.js 24와 준비된 Ollama 모델이 있는 컴퓨터에서 저장소 폴더를 열어 실행합니다.
담당자가 준비한 평가 폴더를 받으면 아래 명령만 실행해 주세요.

```sh
npm run eval:date -- run --dir evals/sejong/date-eval/results/pilot-before
```

실행이 끝나면 해당 폴더의 `run.json`, `progress.json`, `operator.json`을 담당자에게 전달합니다.
`run.json`에는 전체 실제 입력·답변, 단계별 호출·오류·재시도·시간·토큰, 컴퓨터 환경이 남습니다.
채점 칸을 작성할 필요는 없습니다. 모델 설치·설정 문제가 있으면 오류를 그대로 전달합니다.
실행 중 프로그램이 끊겨 실제 호출 상태를 확인할 수 없으면 자동 재실행하지 않고 담당자 확인을 요구합니다.
이미 완료된 실행은 덮어쓰지 않습니다.

## 담당자가 먼저 준비할 것

아래의 모델 이름은 예시입니다. 실제 설치된 Qwen3.5 4B Q4 모델 태그와 양자화 정보를 확인해 사용합니다.
유료 API는 사용하지 않으며, 로컬 Ollama 주소만 허용합니다.

```sh
npm run eval:date -- prepare --dir evals/sejong/date-eval/results/pilot-before --model qwen3.5:4b --repeats 1 --warmup
```

준비 시 자료·질문·정답·채점 기준·방법 구현·모델 옵션을 해시로 고정합니다.
모델을 호출하는 계획은 준비할 때부터 Ollama가 실행 중이어야 합니다. 설치된 모델의 파일 해시와 양자화 정보를 함께 고정하고 실행 전에 다시 확인합니다.
세 방법을 같은 질문·반복 횟수로 실행합니다.

| 방법 | 처리 |
|---|---|
| prompt-baseline | 날짜 구분·날짜 보존·근거 요구를 포함한 강화 프롬프트, 모델 1회 |
| rule-baseline | 대상 사건과 본문 구절의 날짜를 찾는 규칙 방식, 모델 호출 없음 |
| evidence-first | 같은 모델로 사건별 시간 근거를 먼저 추출하고, 그 결과를 원문과 대조해 정밀도를 제한하는 답변 프롬프트, 모델 2회 |

규칙이나 AI가 정답표를 보고 답을 생성하지 않습니다. 정답표는 채점 단계에만 들어갑니다.
규칙 방식도 틀릴 수 있으며, 본문의 새로운 사건 표현을 모두 이해하는 완성된 날짜 해석기가 아닙니다.
evidence-first도 답변의 정확성을 보장하지 않습니다. 추가 호출을 포함한 방법 전체의 정확도·비용을 비교합니다.
모델을 사용하는 방법의 생성 옵션·문맥 길이는 같습니다. 각 문항은 대화 이력 없이 새로 실행합니다.
`--timeout 120000 --retries 0`이 기본입니다. 재시도 횟수는 결과를 보기 전에 고정합니다.

별도 옵션은 JSON 파일을 `--options 옵션.json`으로 넣습니다. 기본값은 temperature 0, seed 62, num_ctx 8192, num_predict 1024입니다.
준비 후 코드를 바꾸면 기존 계획으로 새 호출을 실행할 수 없습니다. 새 폴더에 새 계획을 준비합니다.
준비용 호출은 본 비교 시간·토큰과 분리됩니다. 배치 실행 순서는 seed로 고정됩니다.
중간에 멈췄다가 완료된 항목을 건너뛰어 재개한 경우도 표시합니다. 재개 시 준비 호출은 다시 하며, 실제 경과 시간은 이번 구간만 남으므로 완전한 배치 시간이나 효율 개선으로 해석하지 않습니다.

최종 자료로 확대할 때는 담당자가 `--dataset 자료.json --gold 정답.json`을 함께 지정합니다.
기사·사건 묶음으로 개발/최종 자료를 분리하고, 정답표의 날짜 정밀도·생략 허용 범위·근거 위치·지표 적용 여부를 독립 검토해야 합니다.
기본 3기사·8질문만으로 일반적인 개선 효과를 주장하면 안 됩니다.

## 채점 순서

### 1. 코드 검사

```sh
npm run eval:date -- code --dir evals/sejong/date-eval/results/pilot-before
```

`code.json`은 구조화된 날짜 값·필수 요소·인용 위치를 검사합니다.
자연어 답변을 숫자만 보고 최종 정답으로 판정하지 않습니다.
정확한 위치에 있는 인용도 답의 의미를 뒷받침하는지는 사람이 판단합니다.
형식 검사 실패는 모델 실행 실패나 최종 내용 0점으로 바꾸지 않습니다.

### 2. AI 예비 채점

```sh
npm run eval:date -- ai --dir evals/sejong/date-eval/results/pilot-before --model 설치된-로컬-채점모델
```

`ai.json`에 입력·원출력·채점기 모델/옵션/프롬프트 해시·재시도·별도 비용이 남습니다.
`ai-calls`에도 호출 전 입력과 종료/실패 원문을 바로 저장합니다. AI 채점 중 끊기면 실행 시작 기록을 보존하며 같은 폴더에서 무작정 다시 호출하지 않습니다.
한 답변씩 원문·질문·고정 정답표와 비교하며 생성 방법·생성 옵션은 숨깁니다.
유효한 날짜 판정과 실패한 근거 판정은 분리합니다.
전체 호출 실패·시간초과·전체 해석 불가이면 해당 출력의 모든 대상 판정을 실패로 둡니다.
AI 예비 판정은 최종 점수가 아니며 사람 검토자에게 먼저 보여주지 않습니다.

### 3. 두 사람의 독립 최종 채점

```sh
npm run eval:date -- packets --dir evals/sejong/date-eval/results/pilot-before
```

검토자에게 `review-share` 폴더만 따로 전달합니다.
`review-private.json`, `plan.json`, `code.json`, `ai.json`, 다른 검토자의 판정은 전달하지 않습니다.
익명·무작위 순서의 질문·자료·정답 기준·실제 답변과 빈 판정 양식이 제공됩니다.

각자 `blank-review.json`을 복사해 다음을 채웁니다.

- `reviewerId`: 두 사람의 서로 다른 ID
- `independent / blind`: 독립·익명 검토를 실제로 했으면 true
- 문항 `date / evidence`: 날짜·근거 각각 0 또는 1, 판단 못 했으면 null
- 사건별 `date`: 각 사건의 날짜 점수
- 사건별 오류: `unsupportedDay` 일자 단정, `missingKnownDay` 알려진 일자 누락, `headerConfusion` 표제일 혼동. 오류 있으면 1, 없으면 0. 적용 대상이 아닌 항목은 null
- `reason`과 사건별 `reasons`: 실제 답변·원문을 보고 판정한 이유
- `elapsedMs`: 선택 입력. 해당 항목의 실제 검토 시간. 없으면 null이며 0초로 계산하지 않음

`eligibility`를 보고 적용 대상을 확인합니다. 필수 사건을 답변이 빠뜨렸어도 그 사건의 채점 칸을 삭제하지 않습니다.
질문 날짜 점수는 모든 필수 사건을 맞혀야 1입니다. 날짜가 맞아도 근거가 빠지거나 틀리면 근거 0입니다.
부정 전제 거절과 근거 없는 날짜 부정은 정답 기준대로 구분합니다.

```sh
npm run eval:date -- import-review --dir evals/sejong/date-eval/results/pilot-before --file 검토A.json --reviewer 검토A
npm run eval:date -- import-review --dir evals/sejong/date-eval/results/pilot-before --file 검토B.json --reviewer 검토B
npm run eval:date -- finalize --dir evals/sejong/date-eval/results/pilot-before
```

첫 판정 파일은 덮어쓰지 못합니다. 두 사람의 첫 점수·합의 전 일치 수/전체 수·이견을 보존합니다.
이견이나 보류가 있으면 `final.json`의 `agreement.details`를 보고 별도 합의 JSON 배열을 준비합니다.
각 합의에는 packetId, packetHash, 두 reviewerIds, 원래 firstReviewHashes, 확정 점수·사건별 판정·이유를 넣습니다.
필요하면 합의 시간 elapsedMs도 남깁니다. 원래 첫 판정은 바꾸지 않습니다.

```sh
npm run eval:date -- finalize --dir evals/sejong/date-eval/results/pilot-before --adjudications 합의.json --out evals/sejong/date-eval/results/pilot-before/final-resolved.json
npm run eval:date -- report --dir evals/sejong/date-eval/results/pilot-before --final evals/sejong/date-eval/results/pilot-before/final-resolved.json
```

미실행·상태 미확인·미채점·미해결 이견은 0점으로 메우거나 버리지 않고 최종 집계를 막습니다.
생성 실패는 최종 0점이지만, 시간초과 부분 답변을 사람이 내용 채점하지 않습니다.
잘못된 답변·의미 있는 답변 거절·읽을 수 있는 형식 오류는 완료 답변으로 채점합니다.
길이 제한에 걸린 답변은 먼저 상태 미확인으로 남깁니다. 도구는 자연어의 읽을 수 있는 정도를 완벽하게 자동 판정하지 않습니다.
담당자가 중단 여부와 원출력을 확인해 완료/실패를 확정합니다. 시간초과로 확정된 실패는 부분 내용이 맞아도 완료로 바꿀 수 없습니다.
정상 종료했어도 의미 없는 중단 답변으로 확인되면 내용 채점 전에 실패로 정리합니다.

상태 확인 JSON은 `[{"recordId":"원본 ID","originalRecordHash":"원본 기록의 SHA256","reviewerId":"담당자","state":"failed","reason":"중단 답변이라 읽을 수 없음","evidence":"원문과 종료 로그 대조"}]` 형식입니다.
담당자가 도구의 canonical SHA256 `hash(record)`로 원본 해시를 확인합니다.

```sh
npm run eval:date -- resolve-state --dir evals/sejong/date-eval/results/pilot-before --file 상태확인.json --out evals/sejong/date-eval/results/pilot-before/run-resolved.json
```

원본 `run.json`은 보존됩니다. 이후 code·ai·packets·import-review·finalize·report·validate-judge 명령에 `--run evals/sejong/date-eval/results/pilot-before/run-resolved.json`을 똑같이 붙입니다.
기존 채점 파일을 만든 뒤 상태를 변경했다면 이전 결과는 덮어쓰지 말고 새 폴더에서 확인본을 가져와 다시 채점합니다.

## AI 채점기 검증

AI를 조정하는 기사·사건 묶음과 검증하는 묶음을 분리한 JSON 파일을 준비합니다.
예: `{"calibrationGroups":["S1"],"validationGroups":["S2","S3"]}`.
현재 자료만으로 충분한 검증 표본이 되는 것은 아닙니다. 모든 방법·오류 유형을 포함한 실제 답변을 추가해야 합니다.
고친 채점기를 이전에 검증에 쓴 자료만으로 재검증하지 않습니다.

```sh
npm run eval:date -- validate-judge --dir evals/sejong/date-eval/results/pilot-before --groups 검증그룹.json --final evals/sejong/date-eval/results/pilot-before/final-resolved.json
```

`judge-validation.json`에는 날짜·근거·사건 오류별 사람 0/1 × AI 0/1/실패 표와 방법별·유형별 결과가 나옵니다.
전체 일치율에는 AI 실패를 포함하고, 유효 판정 내 일치율과 채점 완료율을 따로 냅니다.
AI를 신뢰해도 모든 완료 답변의 사람 최종 채점은 생략하지 않습니다.

## 개선 전후 비교

개선 후에는 새 폴더를 사용하되 동일한 자료·정답·기준·모델 옵션·실행 조건을 사용합니다.
방법 구현을 고칠 경우 버전과 코드 해시가 달라지는 것을 남깁니다.
방법을 수정하면 `runner.mjs`의 `METHOD_VERSION`도 올립니다. 같은 버전 이름에 다른 구현을 숨기면 전후 비교를 거절합니다.
채점 기준을 바꿨다면 전후 답변을 새 기준으로 모두 다시 채점해야 합니다.

```sh
npm run eval:date -- compare --before evals/sejong/date-eval/results/pilot-before/report.json --after evals/sejong/date-eval/results/pilot-after/report.json --out evals/sejong/date-eval/results/before-after.json
```

각 `report.json`에서 방법별 결과를 보고, `comparison.json`에서 한 실행 안의 세 방법을 비교합니다.
전후 보고서는 질문·반복 단위로 개선, 새 오답, 둘 다 정답, 둘 다 0점을 비교합니다.
‘둘 다 0점’에는 생성 실패와 완료 오답도 포함됩니다. 둘 다 완료한 경우만 따로 보는 보조 결과도 있습니다.
반복 실행은 독립 질문 수로 세지 않습니다. 질문 평균 → 기사 평균 → 기사 동일 가중 평균을 제공합니다.

핵심 사건 질문과 표제일 대조 질문, 전체 실행의 분모를 분리합니다.
정답률·조건부 정답률·완료율·오류율은 분자·분모와 함께 저장됩니다.
완료 답변의 중앙값/p95와 실패·재시도를 포함한 전체 처리 비용을 구분합니다.
모델 호출·토큰 누락은 N/A와 확인된 부분합으로 남기며, 코드·AI·사람 채점 비용은 `evaluation-cost.json`으로 분리합니다.
다른 모델/옵션을 섞은 전후 보고서는 기본 비교에서 거절합니다. 모델 자체를 바꾸는 실험은 별도 비교 조건을 먼저 설계해야 합니다.

#56 기존 기록을 재사용하려면 담당자가 같은 자료·조건·전체 원문을 갖췄는지 확인해 이 도구의 Run 형식으로 연결합니다.
`import-run --dir 준비폴더 --file 기존-run.json`은 고정 ID·버전·전체 입력을 검사하며 모델을 재호출하지 않습니다.
예전 기록에 없던 입력·시간·비용을 추측해서 보충하지 않습니다.

## 구현 검증과 남은 확인

```sh
npm run test:date
```

모의 생성·모의 사람 판정과 로컬 HTTP 모의 서버로 상태·산술·전체 명령 흐름을 검증합니다.
실제 Qwen 답변·실제 AI 판정 정확도·사람 검토자의 독립성은 자동 테스트가 증명하지 않습니다.
도구는 `paperEligible: false`로 두며, 데이터 검토 상태와 논문 준비 완료를 혼동하지 않습니다.
실제 오류 확인, 연구 진행 판단, 독립 사료 검토, 개발/최종 자료 확보, 채점 담당 확정, 실제 채점기 검증은 별도로 남겨야 합니다.
