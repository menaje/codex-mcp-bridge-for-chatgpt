# #247 구현 계획 — 최신 결정 반영

2026-10-13 [#247](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/247)의
W0~W5 계획과 사용자의 최신 수락 조건 변경을 반영한다. 이 문서는 자동
재개와 실사용 평가를 개발 완료 선행 조건으로 둔 이전 부분을 대체한다.

자동 재개 작동, 실제 A → GPT 검토 → B 실행, 원래 모델·추론 설정과
문맥·사용량 유지, 장시간 동작의 실사용 평가는 사용자가 담당한다. 이
평가의 미실행이나 결과는 개발 완료 선행 조건이 아니다. 개발 수락은
소스·계약 검토, 빌드, 결정적 기능 검사와 검토된 구현의 인계로 판정한다.
별도 장시간·지속시간·soak 및 시간/만료 축약 대체 시험은 계획하거나
실행하지 않는다. 평가 제외는 자동 재개가 구현·실증됐다는 뜻이 아니다.

## 기준선과 범위

구현 기준선은 `9b126dace7512113b2c50560fd162d5fd0756418`이다. 이전 bounded
W1 안내 정합화로, 독립 검사 57개 및 빌드 통과 후 dev에 통합됐다.

최종 구현은 [d231bd2b9f4d4b55cc1283b698c499828eff2d0f](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/commit/d231bd2b9f4d4b55cc1283b698c499828eff2d0f)이며
독립 검사 **86개와 빌드 통과**, dev/origin 반영, 앱 적용 및 일반 Chat의
기본 연결 확인을 완료했다. 이 기록은 이미 반영된 구현의 인계 근거다.
현재 문서 변경은 해당 코드를 다시 구현하거나 중복 통합하는 변경이 아니다.
세부 구현·검증 경계는 [최종 감사 기록](audits/2026-10-13-issue-247-lifecycle-recovery.md)을 따른다.

새 코드도 기존 State UoW/`bridge_meta`, Activity·Agent·Job, 원본 결과,
후행 receipt, `input/answer`, OAuth 및 native Events를 사용한다. 별도 DB,
그래프/판단 엔진, UI, host scope 별칭이나 일반 Chat용 가짜 재개 API를
추가하지 않는다. 일반 admission의 `direct-wait` 기본값과 task contract 6,
task output 4, 정확한 request 재시도는 유지한다.

## W0~W5

| 단계 | 이번 수행 내용 | 판정/담당 |
| --- | --- | --- |
| W0 | 최신 이슈·기존 계획·9b126dac 기준선·기존 전달/접수/입력/수명 계약 대조 | 매핑 완료; 기존 native 계약과 현재 지원/실제 작동 미확인인 일반 Chat 연결을 구분 |
| W1 | 기존 durable admission, 원래 scope 조회 및 optional receipt/ordinary continue 안내 재사용; lifecycle root 수신 계약 정의 | Bridge 측 등록/인계 구현. 현재 일반 Chat Pro 자동 재개 연결 지원과 실제 자동 재개 작동은 미확인 |
| W2 | 명시적 root lifecycle 구독을 같은 원래 Activity/Agent/project의 이후 Events Job에 연결; admission/input/terminal 트랜잭션에 전달 레코드 보존; late subscribe/refresh/startup 누락 대조 | 결정적 검사. canonical receipt와 동일 requestId는 그대로 사용; 다른 ID는 병합하지 않음 |
| W3 | 현재 input 사건 전달, 질문 갱신/해결 시 stale 사건 제거, 기존 answer uncertainty 보호, 수명/중단/최종 종료 처리 | 결정적 검사. host OAuth/구독 refresh와 Bridge delegation 재발급 책임 분리 |
| W4 | 고정 커밋의 diff·관련 검사·빌드·수락 매핑 독립 대조 | d231bd2b 독립 검사 86개 및 빌드 통과; 실사용 평가는 사용자 담당 |
| W5 | 검증 통과 커밋만 dev 통합·정상 푸시; 검토 tree 관계와 자료 보존 확인 | d231bd2b dev/origin 반영, 앱 적용 및 일반 Chat 기본 연결 확인 완료 |

## 구현 항목 매핑

| 요구 | 기존 구현 | 이번 보완 / 남은 실제 의존성 |
| --- | --- | --- |
| UI 없는 최초 인계 | 비동기 Job 접수와 `completionDelivery=events` 영속 intent, 정확한 admission/request 조회 | `codex_event_access event=codex.job.lifecycle`로 명시적 root 수신 동의. native subscribe는 기존 API. 일반 Chat Pro의 최초 응답 종료 후 원래 대화/도구 권한으로 재개되는 연결 지원과 실제 작동은 미확인 |
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

검토된 Bridge 구현은 위 개발 수락 근거로 완료 판정한다. 사용자 실사용
평가, 재확인 승인, 수동 호스트 체크리스트를 PR/개발 완료 조건으로 추가하지
않는다. 실제 자동 재개를 확인하지 않았다는 점은 그대로 남긴다.

현재 일반 Chat Pro 자동 재개 연결 지원과 실제 작동은 미확인이다. 이전의 “호스트
API가 없다”라는 단정은 충분한 근거가 없어 정정한다. 이 변경은 기존
native 계약을 사용하는 Bridge 기능이며, 일반 Chat Pro 전용 추가 호스트
바인딩이나 확장 API를 구현하지 않았다. 그런 추가 연결이 필요한지도 아직
확인되지 않았다. 추가 연결 코드 미구현과 실사용 평가 미실행을 구분하며,
어느 쪽도 확인된 자동 재개 성공으로 바꾸어 기록하지 않는다. Work/dot/API
관측은 원래 일반 Chat Pro의 동작·권한·모델 설정 유지 증거로 대체하지 않는다.
