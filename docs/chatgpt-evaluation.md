# ChatGPT 도구·UI 반복 평가

현재 공개 도구와 Settings·Dashboard를 평가하는 절차다. 기준은 중앙 실행 정책과
현재 15개 도구 계약이다. 각 실행에서는 실제 소스 커밋과 설치된 빌드를 따로
기록한다. 아래 기대 결과와 미실행 항목은 실제 호스트 통과 기록이 아니다.

## 준비와 현재 계약

평가 전용 임시 프로젝트와 짧은 텍스트 파일을 준비한다. 브리지에 등록한 프로젝트를 `codex_status`의 `project` query로 조회하고, 조회 결과의 정확한 식별자를 사용한다. 읽기 사례에는 저장된 읽기 전용 정책을, D5에는 파일 변경이 허용된 평가 정책을 준비한다. `codex_task`에는 sandbox나 승인 정책을 지정하지 않는다. 새 작업·이어가기·분기 모두 브리지의 저장 정책과 운영 상한을 따른다. 실제 작업이나 다른 대화의 최근 Agent를 평가 대상으로 대신 선택하지 않는다.

- 새 작업과 상태 조회는 별도 Activity UI를 만들지 않는다. Activity·Agent·Job 관계와 기존 결과는 유지한다. 정확한 Job의 입력을 제한 시간 동안 기다리고 최종 결과를 조회한 뒤 GPT가 답한다.
- `codex_dashboard`의 현황 카드는 **이 대화 / 전체 현황**을 전환한다. 완료·보관 기록까지 포함해 현재 대화의 기록이 있으면 이 대화로 시작한다. 실행 중·응답 필요·문제 요약과 목록에 동일한 범위를 적용한다. 전체 현황을 열었다고 GPT의 일반 도구 호출 범위가 넓어지지 않는다.
- 현황의 선택한 작업 상세에서 원본 승인·입력, 작업 중단과 남은 프로세스 종료를 처리한다. 종료된 실패 이력, 현재 처리 필요 항목, 자동 처리 기록을 구분한다. 선택적 확인은 원래 작업 결과를 바꾸지 않는다.
- 일반 질문은 `codex_status`의 `input` query로 읽는다. GPT가 판단할 수 있는 질문에는 `codex_answer` 또는 정확한 활성 turn의 `codex_steer`를 사용한다. 사용자 의견이 필요하면 현재 ChatGPT 대화에서 묻고, 답을 받은 뒤 유효한 정확한 질문에만 `codex_answer`를 호출한다. 이는 원본 승인을 허가하지 않는다.
- Settings에서 모델·Ultra 허용 범위·자동 모드 모델 설명·언어·기록 보존과 기본값이 꺼진 실험적 직접 결과 수신을 확인한다. 기본 `live-card` Job은 exact Dashboard → terminal event → 자동 `ui/message` → exact result → final message를 검증한다. 실험을 켠 뒤 접수한 `direct-wait` Job은 같은 exact Job의 bounded terminal wait → GPT 결과 검토 → 이미 승인된 후속 작업을 검증하고, Dashboard 완료 watcher와 중복되지 않아야 한다. 설정 변경은 이후 Job에만 적용한다. generic macOS 알림은 명시적 Activity 정책의 독립 보조 채널로만 기록하며 ChatGPT 전달 성공으로 계산하지 않는다. 사용자 모델 설명의 명시적 저장·공식 설명 비교·복원, 저장 충돌과 초안 보존을 포함한다.
- 현재 리소스는 Settings와 Dashboard뿐이다. 이전 Activity·Question 리소스와 그 카드 전용 설정은 새 평가의 필수 흐름으로 요구하지 않는다.

기준 커밋, 브리지 버전과 빌드 ID, 실제 실행 백엔드/CLI 버전, task 계약, 카드 리소스 세대, ChatGPT 앱/브라우저 버전 및 날짜를 기록한다. 선택적 session/subject/organization metadata는 값 자체 대신 존재 여부만 남긴다. opaque scope는 검증 중 비공개로 대조하고 공개 기록에는 A/B/C 관계만 남긴다.

## 대표 프롬프트와 기대 결과

| ID | 평가 프롬프트 | 기대 행동과 판정 |
| --- | --- | --- |
| D1 | “평가 프로젝트의 텍스트 파일 내용을 Codex로 읽고 한 문장으로 요약해.” | project query 후 `codex_task`로 새 Agent/Job을 생성한다. 저장된 읽기 전용 정책을 적용하고 별도 Activity UI는 만들지 않는다. 정확한 Job 결과와 실행 백엔드를 확인한다. |
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

## Web·macOS 회귀 검증 매트릭스

2026-09-10 사용자 범위 정정으로 iOS는 평가 대상에서 제외했다. #9는 별도 기기별 완료 관문을 없애고 `not planned`로 종료했다. 아래 E9 식별자는 기존 검증 기록과의 연결을 위한 사례명이며 모든 호스트·표시 모드 조합의 검증을 요구하는 열린 이슈가 아니다.

| 조건 | 절차와 통과 근거 | 확보한 증거와 남은 범위 |
| --- | --- | --- |
| E9-2 · 같은 대화 Web → 재진입 / macOS Desktop | 각 호스트 호출과 카드 내부 호출의 scope/source를 대조한다. optional metadata 존재 여부도 기록한다. 일치하지 않으면 자동 병합하지 않는다. | 2026-09-10 실제 Web 재진입 후 A2의 scope가 원본 A와 같고 기존 결과·카드가 유지됨을 확인했다. macOS Desktop 접근은 `blocked`. iOS는 대상에서 제외했다. |
| E9-3 · 새 대화와 복사·분기 | 원본 A, 독립 B, 분기 C의 scope를 비공개로 비교한다. A/B 작업이 C에서 조회되지 않아야 한다. | 2026-09-10 실제 A/B scope 불일치, A의 작업 1개와 B의 작업 0개를 확인했다. 분기를 두 차례 시도했으나 로딩 상태가 지속돼 C 식별자 대조는 `blocked`. 과거 C의 작업 0개 기록은 유지한다. |
| E9-4 · Settings·Dashboard | 각 기기의 inline과 제공되는 PiP/fullscreen을 열고 재진입·갱신한다. Dashboard의 대화 범위, 작업 상세, 중단 확인과 Settings의 저장값이 섞이지 않아야 한다. | 구형 Question·Activity 카드 실측은 역사적 기록으로만 보관한다. 현재 기기별 표시 모드 전체는 `not-run`. |
| E9-5 · 연결 단절·전환·복구 | 평가 연결을 끊고 복구해 재시도·수동 갱신·초안 보존·오래된 제어 거부·중복 실행 방지를 확인한다. | 모의 호스트 검사는 별도 근거. 2026-09-10 탭 단위 장애 주입은 CDP 사용 불가로 `blocked`였고 offline 설정은 적용되지 않았다. 같은 날 실제 Wi-Fi 단절과 인터넷 경로 소실·복구를 확인했고, 정상으로 남는 상태 표시를 수정했다. 제품 네이티브 코드의 실제 네트워크 상태 전환과 기존 설치 helper의 관찰은 [직접 검증 기록](audits/2026-09-10-direct-acceptance.md)에서 구분한다. |
| E9-6 · 언어 전환 | 실제 호스트 언어를 바꾸고 Settings와 Dashboard의 문구·선택값을 확인한다. 제공되는 미지원 언어에서는 정의된 fallback을 확인한다. | 이전 Question-card 초안 검증은 역사적 기록이다. 현재 리소스의 실제 ChatGPT 재검증은 남긴다. |
| 일반 질문 전달 | `codex_status` input query에서 정확한 질문을 읽고, 현재 대화에서 받은 답을 `codex_answer`로 보낸다. stale 질문·다른 scope·불확실한 전달은 거부하거나 보류하며 새 request ID나 다른 채널로 자동 재전송하지 않는다. | 카드 기반 #68 검증은 역사적 기록이다. 현재 ChatGPT에서의 직접 대화·전달 재검증은 남긴다. |
| 현재 리소스·알림 회귀 | Settings와 Dashboard를 다시 열고 갱신한다. Dashboard 자동 표시, 작업 상세, 카드와 독립된 native completion outbox 전달, 설정이 충돌하지 않아야 한다. Dashboard 또는 `ui/message`가 outbox를 claim하지 않는지도 확인한다. | 구형 Activity/Question 리소스를 다시 열어야 한다는 요구는 없다. |
| 실험적 직접 결과 연속 오케스트레이션 | 실험을 켠 뒤 새 Job을 시작하고 같은 대화, 다른 대화로 이동, 앱 백그라운드, 화면 잠금, 연결 유실·복구를 각각 별도 실행한다. 성공은 원래 대화에 사용자가 다시 들어오지 않아도 GPT가 정확한 종료 결과를 받고 검토한 뒤 승인 범위 안의 다음 Job까지 시작한 경우다. 새 승인·입력이 필요하면 중단해야 한다. | 자동화된 브리지·카드 검사는 정책 스냅샷, bounded wait, 중복 방지만 증명한다. 각 호스트 상태는 실제 ChatGPT에서 관찰한 경우에만 `pass`로 기록하고, host가 run을 중단하면 Codex 지속성과 GPT 자동 연속 실행을 별도 판정한다. |

직접 수신 수락시험에는 두 종류의 프롬프트를 분리한다. 경로 진단용에는 exact wait
지시를 넣어도 되지만, **설정 단독 효과** 시험에는 사용자가 평소처럼 읽기 전용
2단계 작업만 요청하고 `direct-wait`, `codex_status`, Dashboard 금지 등의 구현
지시를 넣지 않는다. 다른 대화 이동 시험은 원대화를 떠난 UTC 시각과 다시 연 UTC
시각, Job 1 완료, 원래 GPT의 exact result 응답, Job 2 접수 시각을 각각 기록한다.
`Job 2 접수 < 원대화 복귀`가 원자료로 확인되어야 복귀 전 연속 실행을 통과로
표시한다. 같은 Job의 결과 재조회 일관성과 해당 scope의 후속 Job 수가 정확히
1개라는 사실도 별도 증거로 기록한다. 원대화 GPT 실행 자체가 끝난 사례는
자동 연속 실행 실패/미지원과 Job의 지속·수동 회수를 구분해 판정한다.

호스트가 지원하지 않는 기능이나 주입할 수 없는 장애는 이유와 함께 `unsupported` 또는 `blocked`로 남긴다. 모의 호스트 성공을 실제 호스트의 전달 거절·물리 네트워크 복구·음성 낭독 성공으로 바꾸어 기록하지 않는다. #15는 macOS 운영 알림(VoiceOver 제외), #44는 네이티브 화면·런타임 복구, #79는 운영 앱의 장시간 예약과 launchd 인계를 담당한다. 같은 실행 근거는 이슈 간에 재사용한다.

## 기존 실측과 현재 완료 상태

[직접 검증과 후속 수정](audits/2026-09-10-direct-acceptance.md)은 실제 장시간 작업·네이티브 예약과 취소·helper 비정상 종료·Wi-Fi 복구, 알림 권한·앱 재실행·질문 초안·점유 기록 경합의 수정을 기록한다. #9 종료와 #15 VoiceOver 제외는 사용자 범위 정정이다.

2026-09-10의 [비배포 작업 검증](audits/2026-09-10-non-release-issue-completion.md)은 현행 문서 갱신(E9-1), 실제 Web 추가 관찰, 전체 회귀와 실제 launchd 기반의 격리 검증을 기록한다. A2 제출 후 GPT 재개는 관찰했지만, GPT가 앞선 요청의 위임 범위를 좁게 해석해 답변을 자동 조회하지 않았다. 명시적 후속 요청 후 조회 성공과 자동 전달 성공을 구분한다.

같은 날 별도의 언어 검증 질문과 카드 제출 검증은 이전 계약의 기록이다. 영어 전환·미지원 체코어 fallback 관찰은 남기되, 질문 카드 초안 보존은 현재 리소스의 요구사항이 아니다.

2026-09-07의 [실제 호스트 기록](audits/2026-09-07-live-host-and-interactions.md)과 [추가 대화·분기 검증](audits/2026-09-07-remaining-issues-review.md)은 당시 Activity 카드가 신규 표시되던 빌드의 이력이다. Web 390×844 줄바꿈 확인은 iOS/PiP/background 통과를 뜻하지 않는다. 관찰된 ChatGPT HTTP 500과 Tunnel 502도 실제 복구 성공으로 계산하지 않는다. 과거 [live smoke](audits/issue-38-chatgpt-live-smoke.md)는 해당 버전의 기록으로 유지한다.

2026-09-08의 [#68 실측](audits/2026-09-08-gpt-question-followup.md)은 당시의 입력·질문 카드 계약을 사용한 역사적 기록이다. 현재 input query와 현재 대화 기반 질문 흐름의 실행 근거로 사용하지 않는다. 당시 질문 직후 종료된 `PROBE_UNAVAILABLE` 실행은 성공으로 계산하지 않는다.

**#69는 2026-09-08 사용자 수락으로 완료됐다.** [카드 통합 실측](audits/2026-09-08-card-tool-consolidation.md#actual-chatgpt-and-state-verification)의 기존 카드 재열기·질문 초안/제출 확인, [운영 실행](audits/2026-09-08-pr-71-runtime-acceptance.md)의 Activity 카드 없는 완료·결과 회수·GPT 최종 답변·ChatGPT 읽지 않음 표시와 기존 전역 카드 재진입, [제어 검증](audits/2026-09-08-issue-69-final-acceptance.md)의 작업 중단·원본 승인 거부·남은 프로세스 종료를 재사용한다. 마지막 원본 입력의 같은 Job 결과 반영은 [사용자 직접 확인](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/69#issuecomment-5580775771)으로 완료했다. 그 이전의 실패·차단 기록은 당시 이력이며 현행 미완료 조건이 아니다. 이미 끝난 GPT 응답을 깨우는 새 미지원 기능은 #69의 완료 조건에 추가하지 않는다.

자동 검증은 `npm run check`, `npm run test:issue-154-direct-result`, `npm run test:continuity`, `npm run test:dashboard-scope-browser`, `npm run test:dashboard-summary-browser`, `npm run test:model-descriptions-browser`와 `npm run macos:check`를 사용한다. 범위·언어·연결·응답 요청·기록에 관한 자동 증거와 실제 기기 증거는 각각 실행 빌드와 결과를 붙여 기록한다. 자동 검증을 대화 이동·백그라운드·화면 잠금·연결 유실 상태의 실제 ChatGPT 통과로 기록하지 않는다.

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
  "resourceGeneration": {"dashboard": null, "settings": null},
  "surface": "macOS Desktop | Web | widget",
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
