# #247 구현 계획 — 최신 결정 반영

> Historical decision/transition record. #261 supersedes ordinary direct-wait-only
> delivery and the no-card constraint with the [automatic blank goal relay](relay-delivery.md).
> Existing ownership, receipt, stop and historical-data protections remain.

> **현행 해석(2026-10-16):** 아래에 남은 “일반 Chat Pro 재개 API가 없다/제공되지 않는다”는 당시의 미확인 판단이지 공식 API 부재에 대한 검증된 단정이 아니다. 일반 Chat의 호스트 재개·권한·모델/문맥/사용량 연속성은 입증되지 않았으며, 현재 기본 중계 설계와 구현은 [#261](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/261)의 비표시 Relay를 따른다. 이 #247 계획의 W0~W5·과거 상태는 역사적 기록으로 보존한다.

2026-10-13 최신 [#247 본문](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/247)과
원래 W0~W5 첨부 `libfile_8c6be77f227081919b3cc07364012ad9`를 기준으로 한다.
이 문서는 이전 계획의 실제 재개 시험을 선행 조건으로 둔 부분을 대체한다.

실제 GPT 재개, 실제 A → GPT 검토 → B 실행, 장시간·지속시간·soak 및 시간
축약 대체 시험은 수행하지 않는다. 그 미실행과 사용자 실사용 관찰은 코드
완료를 막는 조건이 아니다. 소스·계약·빌드와 결정적 기능 검사로 구현을
판정한다. 실제 API 부재로 연결을 구현할 수 없는 항목은 별도로 남기며,
없는 API나 권한을 가정해 완료로 표시하지 않는다.

## 기준선과 범위

기준선은 `dev == origin/dev == 9b126dace7512113b2c50560fd162d5fd0756418`이다.
이 커밋은 이전 bounded W1 안내 정합화로, 독립 검사 57개 및 빌드 통과 후
fast-forward 통합·정상 푸시됐다. 원본 저장소는
`/Volumes/Data/Dev/codex-mcp-bridge`, 이번 작업 브랜치는
`codex/issue-247-recovery-lifecycle`이다. 기존 작업 worktree와 자료를 보존한다.

새 코드도 기존 State UoW/`bridge_meta`, Activity·Agent·Job, 원본 결과,
후행 receipt, `input/answer`, OAuth 및 native Events를 사용한다. 별도 DB,
그래프/판단 엔진, UI, host scope 별칭이나 일반 Chat용 가짜 재개 API를
추가하지 않는다. 일반 admission의 `direct-wait` 기본값과 task contract 6,
task output 4, 정확한 request 재시도는 유지한다.

## W0~W5

| 단계 | 이번 수행 내용 | 판정/담당 |
| --- | --- | --- |
| W0 | 최신 이슈·기존 계획·9b126dac 기준선·기존 전달/접수/입력/수명 계약 대조 | Worker 매핑 완료; 현재 native API와 없는 일반 Chat 호스트 API 구분 |
| W1 | 기존 durable admission, 원래 scope 조회 및 optional receipt/ordinary continue 안내 재사용; lifecycle root 수신 계약 정의 | Bridge 측 등록/인계 구현. 실제 일반 Chat Pro 재개 호출은 제공 API 부재 |
| W2 | 명시적 root lifecycle 구독을 같은 원래 Activity/Agent/project의 이후 Events Job에 연결; admission/input/terminal 트랜잭션에 전달 레코드 보존; late subscribe/refresh/startup 누락 대조 | 결정적 검사. canonical receipt와 동일 requestId는 그대로 사용; 다른 ID는 병합하지 않음 |
| W3 | 현재 input 사건 전달, 질문 갱신/해결 시 stale 사건 제거, 기존 answer uncertainty 보호, 수명/중단/최종 종료 처리 | 결정적 검사. host OAuth/구독 refresh와 Bridge delegation 재발급 책임 분리 |
| W4 | 고정 커밋의 diff·관련 검사·빌드·수락 매핑 독립 대조 | 부모가 새 Verifier 배정; 실환경 재개/지속시간 검사 제외 |
| W5 | 검증 통과 커밋만 dev 통합·정상 푸시; 검토 tree 관계와 자료 보존 확인 | 이번 새 변경은 아직 통합/푸시하지 않음; 운영 설치·재시작 없음 |

## 구현 항목 매핑

| 요구 | 기존 구현 | 이번 보완 / 남은 실제 의존성 |
| --- | --- | --- |
| UI 없는 최초 인계 | 비동기 Job 접수와 `completionDelivery=events` 영속 intent, 정확한 admission/request 조회 | `codex_event_access event=codex.job.lifecycle`로 명시적 root 수신 동의. native subscribe는 기존 API. 일반 Chat Pro에서 응답 종료 후 추론을 실행하는 공식 대상/호출 API는 제공되지 않음 |
| 원래 권한으로 원본/후행 처리 | ScopeResolver, OAuth principal, Activity/Agent/project, exact result offer와 reviewedVersion, payload hash | lifecycle 수신도 동일 principal/scope/Activity/Agent/project로 제한. Root ref는 ordinary 도구 scope나 B의 exact terminal ref가 아님 |
| A 이후 B 연결 | canonical receipt atomic admission, ordinary request replay, exact late terminal backfill | root receiver의 B waiting 레코드를 Job admission과 같은 UoW에서 보존. B grant/실행은 생성하지 않음. B가 먼저 완료돼도 retained source로 회수 |
| 동적 후행 | original Activity/Agent `continue`, 같은 requestId와 payload 재시도 | 명시적 Events B는 root 수신에 자동 연결. 서로 다른 requestId/Agent/Activity는 유사성으로 합치지 않음. 다른 Agent에는 별도의 원래-scope root 동의가 필요 |
| 중간 질문 | 현재 질문 상태/참조, 원래 실행 소유자 확인, answer delivery journal | input intent를 질문 상태와 함께 커밋. callback에는 현재 input query만 포함; 텍스트/답변/승인·비밀은 포함하지 않음. 해소/교체된 input과 늦은 ACK는 검토 근거가 아님 |
| 실패·불확실 전송 | terminal 실패 원본 보존, ACK/offer/검토 구분, answer `uncertain` 재전송 금지 | lifecycle terminal/input마다 stable event ID와 제한된 retry. Capacity 실패는 Job 결과를 롤백하지 않고 recovery 상태로 기록 |
| 수명/복구 | finite subscription/token/delegation expiry, callback challenge/key rotation, 원장 재시도 | root native refresh가 child 전달 레코드의 검증된 receiver·expiry를 원자적으로 갱신. startup/late registration는 indexed result-free source와 대조 |
| 중단·전체 완료 | host observation abort와 실제 cancel 분리, Activity lifecycle/verification | root unsubscribe/revoke는 child intent에 전파. exact B monitoring revoke는 B만 차단. complete/verification-passed/cancel/abandon은 해당 목표의 receiver를 닫고 늦은 ACK를 버림 |
| 비용/격리 | #242의 전용 native completion signal, indexed reads, bounded journals | 새 MCP event-ready signal은 실제 intent 커밋 뒤에만 발행. 일반 progress/빈 조회에 새 주기적 full-state 조회나 쓰기를 추가하지 않음 |
| 모델/사용량 | 실행 Codex 지표와 부모 GPT 지표의 구분 | 원래 일반 Chat Pro 모델/추론/문맥/사용량 호스트 계약은 미확인. Work/dot/API 또는 Codex 지표로 대체하지 않음 |

## 수명 책임

호스트는 native 구독의 `refreshBefore`와 OAuth access token 갱신을 담당한다.
Bridge는 callback 재검증, 기존 root reference의 binding/revision, 검증된 key
rotation, finite expiry와 retry/복구를 처리한다. Bridge delegation은 기존
`codex_event_access`를 원래 인증된 ordinary tool scope에서 호출해 회수/
재발급한다. Bridge가 호스트의 OAuth token이나 원래 대화 실행 권한을
스스로 생성하지 않는다. Root가 더 이상 retained 상태가 아니면 정확한 live
Job을 조회한 뒤 새로운 root를 명시적으로 선택하며, 기존 Job을 재실행하지 않는다.

수신은 root와 같은 Activity/Agent/project 및 원래 scope/principal의 이후
Events Job에만 적용된다. 부모 수신의 finite expiry를 넘겨 child 권한을
연장하지 않는다. native refresh의 race에서는 현재 revision/event ID를
대조해 이전 전송 ACK가 새 질문·terminal 사건 또는 중단 상태를 덮어쓰지
못하게 한다. 결과 offer나 callback ACK는 GPT 검토나 전체 완료가 아니다.

## 검증과 완료 경계

검사는 가짜 upstream/receiver/verified-auth context, 격리 SQLite 및 실제
OAuth HTTP fixture와 명시적 사건·Promise 장벽으로 수행한다. 시간 경과를
기다리거나 clock/expiry를 축약하지 않는다. 광범위 suite의 지속시간/만료
가속 사례는 실행 목록에 포함하지 않는다. 과거 기록은 역사적 증거로 보존한다.

코드로 구현 가능한 Bridge 기능은 호스트 시험을 기다리지 않고 완료한다.
일반 Chat Pro의 UI 없는 실행 재개·원래 MCP scope를 이어 주는 실제 API가
없다는 점은 구현 의존성이다. 이와 실환경 시험을 수행하지 않았다는 사실을
구분한다. 실제 호스트 동작은 사용자가 일상 사용에서 확인하며 별도 승인
대기, 수동 체크리스트나 시험 절차를 요구하지 않는다.
