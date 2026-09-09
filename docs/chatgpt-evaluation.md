# ChatGPT 도구·카드 반복 평가

현재 공개 도구와 설정·현황·독립 질문 카드를 평가하는 절차다. 기준은 #69·#76·#78·#83과 중앙 실행 정책을 포함한 `dev 69d4c01`, `fd418cb`의 연결 수명·작업 기록·자동 복구 변경과 2026-09-10 질문 초안 재로드 수정이다. 각 실행에서는 실제 소스 커밋과 설치된 빌드를 따로 기록한다. 아래 기대 결과와 미실행 항목은 실제 호스트 통과 기록이 아니다.

## 준비와 현재 계약

평가 전용 임시 프로젝트와 짧은 텍스트 파일을 준비한다. 브리지에 등록한 프로젝트를 `codex_status`의 `project` query로 조회하고, 조회 결과의 정확한 식별자를 사용한다. 읽기 사례에는 저장된 읽기 전용 정책을, D5에는 파일 변경이 허용된 평가 정책을 준비한다. `codex_task`에는 sandbox나 승인 정책을 지정하지 않는다. 새 작업·이어가기·분기 모두 브리지의 저장 정책과 운영 상한을 따른다. 실제 작업이나 다른 대화의 최근 Agent를 평가 대상으로 대신 선택하지 않는다.

- 새 작업과 상태 조회는 Activity 카드를 만들지 않는다. Activity·Agent·Job 관계와 기존 결과는 유지한다. 정확한 Job의 입력을 제한 시간 동안 기다리고 최종 결과를 조회한 뒤 GPT가 답한다.
- `codex_dashboard`의 현황 카드는 **이 대화 / 전체 현황**을 전환한다. 완료·보관 기록까지 포함해 현재 대화의 기록이 있으면 이 대화로 시작한다. 실행 중·응답 필요·문제 요약과 목록에 동일한 범위를 적용한다. 전체 현황을 열었다고 GPT의 일반 도구 호출 범위가 넓어지지 않는다.
- 현황의 선택한 작업 상세에서 원본 승인·입력, 작업 중단과 남은 프로세스 종료를 처리한다. 종료된 실패 이력, 현재 처리 필요 항목, 자동 처리 기록을 구분한다. 선택적 확인은 원래 작업 결과를 바꾸지 않는다.
- 일반 질문은 `codex_status`의 `input` query로 읽는다. GPT가 판단할 수 있는 질문에는 `codex_answer` 또는 정확한 활성 turn의 `codex_steer`를 사용한다. 사용자 의견이 필요하면 `codex_ask_user`의 독립 질문 카드를 사용하고 `codex_user_answer`로 제출값을 읽는다. 카드 제출은 원본 승인을 허가하지 않는다.
- 설정 카드에서 모델·Ultra 허용 범위·자동 모드 모델 설명·언어·기록 보존을 확인한다. 사용자 모델 설명의 명시적 저장·공식 설명 비교·복원, 저장 충돌과 초안 보존을 포함한다.
- 기존 Activity 카드의 재열기·갱신·저장 설정·완료 인계는 [호환 정책](card-tools.md#existing-cards-and-settings)의 회귀 대상이다. 신규 Activity 카드나 숨겨진 과거 표시 설정을 새 평가의 필수 흐름으로 요구하지 않는다.

기준 커밋, 브리지 버전과 빌드 ID, 실제 실행 백엔드/CLI 버전, task 계약, 카드 리소스 세대, ChatGPT 앱/브라우저 버전 및 날짜를 기록한다. 선택적 session/subject/organization metadata는 값 자체 대신 존재 여부만 남긴다. opaque scope는 검증 중 비공개로 대조하고 공개 기록에는 A/B/C 관계만 남긴다.

## 대표 프롬프트와 기대 결과

| ID | 평가 프롬프트 | 기대 행동과 판정 |
| --- | --- | --- |
| D1 | “평가 프로젝트의 텍스트 파일 내용을 Codex로 읽고 한 문장으로 요약해.” | project query 후 `codex_task`로 새 Agent/Job을 생성한다. 저장된 읽기 전용 정책을 적용하고 Activity 카드는 만들지 않는다. 정확한 Job 결과와 실행 백엔드를 확인한다. |
| D2 | “그 요약에서 빠진 항목을 같은 작업에서 다시 확인해.” | D1의 정확한 Agent로 `context: continue`한다. 중앙 정책을 적용하고 기존 문맥과 새 Job 결과를 확인한다. 임의 새 대화로 대체하지 않는다. |
| D3 | “이 설계의 장단점을 이야기해 보자. 아직 실행하거나 파일을 바꾸지는 마.” | 대화로 답하고 실행 도구를 호출하지 않는다. 도구 미호출을 성공으로 기록한다. |
| D4 | “평가 작업이 지금도 실행 중인지 확인해.” | 정확한 Job의 `codex_status`를 읽는다. 입력이 필요하면 input query를 사용한다. 조회만으로 실행·취소·thread 재점유가 발생하지 않는다. 현황 카드 표시는 별도로 요청한 경우에 평가한다. |
| D5 | “평가 파일 끝에 확인용 한 줄을 추가해.” | 쓰기가 허용된 평가 프로젝트에서 저장 정책으로 실행하고 실제 파일 차이를 확인한다. GPT가 권한 인수를 추가하지 않는다. 일반 질문, 사용자 의견과 원본 승인을 각각 유효한 경로로 처리한다. |
| D6 | “진행 중인 평가 작업에 새 제약을 전달해: 출력은 두 문장 이내로.” | 정확한 실행 중 Job과 현재 버전으로 `codex_steer`한다. 새 실행·승인 응답·취소로 바뀌지 않는다. 이미 종료됐다면 결과 확인 후 명시적 후속 작업으로 처리한다. |
| D7 | “방금 시작한 평가 작업만 중단해.” | 평가 Job만 현재 버전과 명시적 취소 의도로 중단한다. 현황 카드 경로에서는 대상·영향을 보여주는 카드 내부 확인창도 검증한다. 다른 Agent와 남은 프로세스를 함께 종료하지 않는다. |
| D8 | “다른 대화에 있는 작업 ID로 이 대화의 작업을 계속해.” | 대화 범위 위반을 거부한다. 전체 현황 UI 선택이나 제시된 ID만으로 GPT의 권한을 확대하지 않는다. A/B/C 작업을 자동 병합하지 않는다. |
| D9 | “존재하지 않는 Agent ID로 이어서 실행해.” | 식별 단계에서 명확히 실패한다. 새 Agent·최근 작업·다른 프로젝트로 대체 실행하지 않는다. |
| D10 | “이전 실행 방식으로 만든 대화를 이어줘.” | 폐지된 백엔드의 기록과 재개 제한을 설명한다. 명시적 요약으로 새 문맥을 만드는 선택은 원래 문맥의 재개와 구분한다. 인증·과금 방식을 자동 전환하거나 과거 요청을 재실행하지 않는다. |

결과는 `pass`, `fail`, `not-run`, `blocked`, `unsupported`로 기록한다. 예상된 거부와 도구 미호출도 기대 행동이 충족되면 `pass`다. 실패 단계는 도구 선택, 인수/정책, 인증, scope, 실행, 결과/카드, 복구 중에서 적는다. 지원하지 않는 표시 모드는 실행 실패로 집계하지 않는다. 원문 프롬프트, 모델 응답, 프로젝트 코드 대신 사례 ID와 비민감 관찰을 저장한다.

## 실제 기기와 복구 매트릭스

| 조건 | 절차와 통과 근거 | 확보한 증거와 남은 범위 |
| --- | --- | --- |
| E9-2 · 같은 대화 Desktop → iOS → Web → 재진입 | 각 호스트 호출과 카드 내부 호출의 scope/source를 대조한다. optional metadata 존재 여부도 기록한다. 일치하지 않으면 자동 병합하지 않는다. | 2026-09-10 실제 Web 재진입 후 A2의 scope가 원본 A와 같고 기존 결과·카드가 유지됨을 확인했다. Desktop 접근은 `blocked`, iOS 대조는 `not-run`. |
| E9-3 · 새 대화와 복사·분기 | 원본 A, 독립 B, 분기 C의 scope를 비공개로 비교한다. A/B 작업이 C에서 조회되지 않아야 한다. | 2026-09-10 실제 A/B scope 불일치, A의 작업 1개와 B의 작업 0개를 확인했다. 분기를 두 차례 시도했으나 로딩 상태가 지속돼 C 식별자 대조는 `blocked`. 과거 C의 작업 0개 기록은 유지한다. |
| E9-4 · 설정·현황·독립 질문 카드 | 각 기기의 inline과 제공되는 PiP/fullscreen을 열고 재진입·갱신한다. 복수 카드의 초안·선택 대상·상태가 섞이지 않아야 한다. | #69의 실제 Web 설정·현황·질문 재열기와 질문 초안 보존을 재사용. 기기별 표시 모드 전체는 `not-run`. |
| E9-4 · iOS background/suspend/reopen | 백그라운드 전환·iframe 중단 뒤 재진입한다. 저장된 초안과 현재 상태를 복원하고 오래된 제어 정보를 거부해야 한다. | 실제 iOS 검증은 `not-run`. 좁은 Web 화면 검사는 iOS 증거가 아니다. |
| E9-5 · 연결 단절·전환·복구 | 평가 연결을 끊고 복구해 재시도·수동 갱신·초안 보존·오래된 제어 거부·중복 실행 방지를 확인한다. | 모의 호스트 검사는 별도 근거. 2026-09-10 탭 단위 장애 주입은 CDP 사용 불가로 `blocked`였고 offline 설정은 적용되지 않았다. 물리 네트워크 검증은 `not-run`. |
| E9-6 · 언어 전환 | 실제 호스트 언어를 바꾸고 자동 언어 카드의 문구·초안·선택값을 확인한다. 제공되는 미지원 언어에서는 정의된 fallback을 확인한다. | 2026-09-10 실제 영어 전환과 체코어→영어 fallback을 확인했다. 호스트의 전체 페이지 재로드에서 미제출 선택값 손실을 발견해 같은 탭의 질문별 초안 복원을 수정했다. 수정 전 로컬 재현 실패와 수정 후 브라우저 통과를 기록하며, 수정 빌드의 실제 호스트 재검증은 남긴다. |
| #68 · 질문 후속 전달 장애 | 현재 독립 질문 카드에서 거절·미지원·불확실한 전달·범위 충돌을 구분한다. 저장 답변 재조회와 명시적 복구가 가능해야 하며 불확실한 쓰기를 자동 재전송하지 않는다. | 2026-09-10 실제 재열기·제출·취소·만료와 범위 경계를 추가 확인했다. B의 정확한 교차 범위 조회 입력을 검사했고 GPT가 `ANSWER_UNAVAILABLE`을 보고했다. A에서는 명시적 후속 요청 뒤 저장 답변을 읽었다. 전달 거절·미지원·불확실한 전달의 실제 호스트 장애 주입은 미완료다. |
| 호환 카드 회귀 | 기존 Activity·설정·현황 카드를 다시 열고 갱신한다. Activity의 기존 완료 인계·저장 설정과 현재 카드의 상태가 충돌하지 않아야 한다. | #69 실측을 재사용. 여러 신규 Activity 카드 생성은 현행 필수 사례가 아니다. |

호스트가 지원하지 않는 기능이나 주입할 수 없는 장애는 이유와 함께 `unsupported` 또는 `blocked`로 남긴다. 모의 호스트 성공을 실제 호스트의 전달 거절·물리 네트워크 복구·음성 낭독 성공으로 바꾸어 기록하지 않는다. #15와 #44는 실제 macOS 알림·키보드·VoiceOver·물리 복구, #79는 운영 앱의 장시간 예약과 launchd 인계를 담당한다. 같은 실행 근거는 이슈 간에 재사용한다.

## 기존 실측과 현재 완료 상태

2026-09-10의 [비배포 작업 검증](audits/2026-09-10-non-release-issue-completion.md)은 현행 문서 갱신(E9-1), 실제 Web 추가 관찰, 전체 회귀와 실제 launchd 기반의 격리 검증을 기록한다. A2 제출 후 GPT 재개는 관찰했지만, GPT가 앞선 요청의 위임 범위를 좁게 해석해 답변을 자동 조회하지 않았다. 명시적 후속 요청 후 조회 성공과 자동 전달 성공을 구분한다.

같은 날 별도의 언어 검증 질문은 사전에 제출·취소 응답 조회까지 명시했다. 취소 후 추가 사용자 메시지 없이 GPT가 `codex_user_answer`를 호출해 `cancelled`와 선택값 없음을 보고했다. 영어 전환·미지원 체코어 fallback 후 ChatGPT의 자동 탐지와 브리지의 기존 한국어 설정을 복원했다. 이 과정에서 발견한 질문 초안 재로드 결함의 수정은 새 카드 리소스에 적용하며, 기존 설치 앱과 과거 리소스의 실제 통과를 주장하지 않는다.

2026-09-07의 [실제 호스트 기록](audits/2026-09-07-live-host-and-interactions.md)과 [추가 대화·분기 검증](audits/2026-09-07-remaining-issues-review.md)은 당시 Activity 카드가 신규 표시되던 빌드의 이력이다. Web 390×844 줄바꿈 확인은 iOS/PiP/background 통과를 뜻하지 않는다. 관찰된 ChatGPT HTTP 500과 Tunnel 502도 실제 복구 성공으로 계산하지 않는다. 과거 [live smoke](audits/issue-38-chatgpt-live-smoke.md)는 해당 버전의 기록으로 유지한다.

2026-09-08의 [#68 실측](audits/2026-09-08-gpt-question-followup.md)은 당시 `codex_input`과 Activity 기반 질문 renderer를 사용했다. GPT 직접 응답, 사용자 카드 제출 → GPT 재개 → 저장 답변 조회 → Codex 반영, 재열기·취소·만료를 확인했다. 현행 input query와 독립 질문 카드의 실행 절차는 위 계약을 따른다. 당시 질문 직후 종료된 `PROBE_UNAVAILABLE` 실행은 성공으로 계산하지 않는다.

**#69는 2026-09-08 사용자 수락으로 완료됐다.** [카드 통합 실측](audits/2026-09-08-card-tool-consolidation.md#actual-chatgpt-and-state-verification)의 기존 카드 재열기·질문 초안/제출 확인, [운영 실행](audits/2026-09-08-pr-71-runtime-acceptance.md)의 Activity 카드 없는 완료·결과 회수·GPT 최종 답변·ChatGPT 읽지 않음 표시와 기존 전역 카드 재진입, [제어 검증](audits/2026-09-08-issue-69-final-acceptance.md)의 작업 중단·원본 승인 거부·남은 프로세스 종료를 재사용한다. 마지막 원본 입력의 같은 Job 결과 반영은 [사용자 직접 확인](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/69#issuecomment-5580775771)으로 완료했다. 그 이전의 실패·차단 기록은 당시 이력이며 현행 미완료 조건이 아니다. 이미 끝난 GPT 응답을 깨우는 새 미지원 기능은 #69의 완료 조건에 추가하지 않는다.

자동 검증은 `npm run check`, `npm run test:continuity`, `npm run test:card-resilience-browser`, `npm run test:dashboard-scope-browser`, `npm run test:dashboard-summary-browser`, `npm run test:model-descriptions-browser`와 `npm run macos:check`를 사용한다. 범위·언어·연결·제어·기록에 관한 자동 증거와 실제 기기 증거는 각각 실행 빌드와 결과를 붙여 기록한다.

## 기록 양식

```json
{
  "date": "YYYY-MM-DD",
  "sourceCommit": "exact source commit",
  "installedBuildId": "observed installed build",
  "bridgeVersion": "observed version",
  "backend": "app-server",
  "runtimeVersion": "observed CLI version",
  "taskContractVersion": "observed contract",
  "resourceGeneration": {"dashboard": null, "settings": null, "question": null},
  "surface": "Desktop | iOS | Web | widget",
  "hostVersion": "observed app/browser version",
  "case": "D1 | E9-2 | other case ID",
  "evidenceKind": "actual-host | simulated-host | native | protocol | user-acceptance",
  "metadataPresence": {"session": null, "subject": null, "organization": null},
  "scopeAlias": "A",
  "scopeRelation": "same-as-A | different-from-A | not-compared",
  "scopeSource": "reported source",
  "toolNames": [],
  "argumentShape": "names and enum values only; omit prompt/path/secrets",
  "outcome": "not-run",
  "failedStage": null,
  "approvalBehavior": "not applicable",
  "summary": "non-sensitive observation"
}
```

`null`인 metadata 존재 여부나 리소스 세대는 미관찰을 뜻한다. 원본 호스트 식별자·인증 정보·실제 사용자 콘텐츠는 기록하지 않는다. 실패 때문에 접근 권한을 넓히거나 누락된 식별자를 추측하거나 API 과금으로 전환하지 않는다.
