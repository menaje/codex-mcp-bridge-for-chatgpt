# #221 direct-wait 기본화 및 카드 송신 제거 — 2026-10-03

일반 Chat의 새 Job은 `direct-wait`로 접수하고, 현황카드는 사용자의 명시적 표시 요청에만 연다. 카드의 완료 감시·채팅 송신·전용 claim/ACK/retry 실행을 제거했다. 기존 Job 정책·원본 결과·후속 승인 식별자는 보존한다. 이 감사는 구현, 로컬/합성 회귀, 실제 설치 및 실제 ChatGPT 관측을 구별한다. 기계 판독 결과와 로컬 증거의 SHA-256 목록은 [대응 JSON](2026-10-03-issue-221-direct-wait.json)에 있다.

## 기준선과 구현

착수 시 root/dev/origin/dev는 `4fc1619b07a50c4454daa6c079cbd495ba7d02b4`였고 clean이었다. 별도 수동 worktree와 `codex/issue-221-direct-wait`에서 작업했다. 설치된 이전 앱은 이 Git 기준선보다 앞선 `30919ee1e1b9461216db289a5a69876079efb92e`였다. 두 기준을 혼동하거나 과거 SHA로 운영 데이터를 되돌리지 않았다.

실제 기준선의 Node 요구는 `>=22`, package manager는 npm 10.9.3, ipaddr.js는 이미 직접 의존성 `^2.5.0` 및 lockfile 2.5.0이다. 전달받은 `>=24 <25`/직접 의존성 없음 보고와 달랐다. Node 24.11.1에서 lockfile 기준 `npm ci`로 설치 손상을 복원했다. 의존성을 추가하거나 lockfile을 재생성하지 않았다. 초기 `ERR_MODULE_NOT_FOUND`는 환경 실패로 보존하고, 복원 후 변경 전 6개 suite/161개 시험 통과와 요약 오류 재현을 별도로 기록했다.

| commit | 결과 |
| --- | --- |
| `fa50976` / `4c04f8c` | 요약 조회 동작 구조 비교와 유효한 regression fixture |
| `00c751d` | 구현 전 기존 Job/후속 승인 전환표와 red tests 고정 |
| `8450a17` | 공통 승인/Events 분리, 기본 정책·설정 이전·카드 송신 제거·v4 리소스 통합 |
| `9f4a3da63bf9f3dc27a41aac1d6d4719e2b65078` | 이미 접수한 구형 B의 동일 selector 재전송을 기존 B로 수렴 |
| `1d9ea4a51615bbe60d73339116296e84be888725` | 실제 취소 시험에서 발견한 exact/summary terminal error 의미 일치 |

최종 제품 코드는 `1d9ea4a51615bbe60d73339116296e84be888725`에서 전체 검증 후 dev에 fast-forward 통합하고 non-force push했다. 이 감사 문서의 후속 commit은 **docs-only**다. 설치 앱의 producer를 감사 commit으로 소급 바꾸지 않는다. 0.4.1/development이며 공개 RC·stable release를 발행하지 않았다.

## 전환 계약과 제거 범위

[구현 전 확정한 전환표](../issue-221-delivery-transition.md)를 유지한다. 새 일반 Job은 기존 설정 true/false/누락과 무관하게 direct-wait다. 완료·실행 중인 기존 live-card Job은 같은 exact Job을 조회/대기하며 취소·재접수하지 않는다. 미실행 구형 followup은 `FOLLOWUP_DELIVERY_RETIRED`로 거부하고, 원래 Activity/Agent에서 새 논리 요청과 fresh requestId로 명시적 재승인하도록 안내한다. 기존 승인 영수증을 변조하거나 자동 이전하지 않는다.

이미 접수한 B는 원래 principal/scope·prompt digest·canonical requestId·reviewedVersion 및 context를 검증한 뒤 폐기 모드의 신규 접수 거부 **전에** 같은 B를 반환한다. 구형 delivery selector의 재전송도 원 승인과 완전히 일치하는 admitted B에 한해서 인정한다. 결과 만료는 만료 오류이며 다른 B를 만들지 않는다. 과거 Events 기록은 읽기/보존하되 새 일반 실행 권한으로 소비하지 않는다.

요약의 동작은 kind=tool-call, tool, query kind, exact Job ID로 검증한다. 새 객체/JSON roundtrip을 인정하며 다른 도구·조회 종류·Job ID·누락·다른 Job의 동작을 거부한다. overview/page/activity/thread에는 원문을 넣지 않고 exact 조회에서만 제공한다. 취소·중단·terminal commit 실패의 error code도 exact와 요약에서 일치한다.

일반 초기화는 McpEventsController 및 Events 전용 issuer/verifier/services를 만들지 않는다. 실험은 `EXPERIMENTAL_PROFILE=events`와 enable flag를 함께 지정해야 한다. 공통 원본 검토·사전 승인·canonical followup/dedup·질문/승인/취소 지침은 일반 프로필에 남겼다. 동일 principal hash prefix, Tunnel과 기본 인증, native notification outbox/ACK, 보존 로직과 역사적 parser/receipt는 유지했다.

카드 sender mutator와 완료 watcher·ui/message/follow-up 송신·자동 Dashboard 연결·전송 retry는 제거했다. HTTP와 stdio의 구형 완료 호출은 `CARD_DELIVERY_RETIRED`, 신규 live-card 선택은 `COMPLETION_DELIVERY_RETIRED`, 일반 프로필의 신규 Events 요청은 `EVENTS_DELIVERY_UNAVAILABLE`로 거부한다. 정상 Job을 실패/취소시키지 않는다. Settings의 실험 UI를 제거했고, 구형 boolean은 true로 정규화한다. `ordinary_delivery_transition_v2` 기록은 재실행 안전하며 무관한 설정을 바꾸지 않는다.

## 회귀 검증과 출처

| 증거 | 판정·한계 |
| --- | --- |
| 요약 red/green | 유효한 변경 전 15개 중 5개 실패로 객체 참조 결함 재현; 수정 후 통과. 최초 잘못된 결과-offer fixture는 별도 보정 기록 |
| 전환·selector red/green | pending 거부, admitted canonical replay, original-scope/context 오류, expiry, legacy running same-Job, OAuth 재시작 integration 통과 |
| 최종 `npm run check` | producer 1d9ea4a, 120개 파일 **1,303/1,303 통과**, 187.10초 |
| strict macOS bundle | Swift **218개 실행, 선택 시험 2개 skipped, 실패 0**; 서명·9개 언어 1,394개 문자열 검증 |
| 설치된 Native Companion | 최종 실제 bridge.sock의 dashboard/settings 계약 **1개 통과**. 추가 remote pairing 없이 수행 |
| MCP 2026-07-28 적합성 | 최종 producer **29/29, failed 0, warnings 0**; 로컬 적합성 runner |
| App Server 계약 | pin된 Codex 0.153.3의 JSON 416개/TypeScript 827개 일치. ambient alpha CLI 불일치는 환경 실패로 분리 |
| Chromium 카드 | 합성 호스트+실제 브라우저 6/6 조건 통과. 구형 in-flight 메시지 1회는 아래 한계의 재현이며 무송신 성공 아님 |
| 영향 회귀 | Dashboard scope 7/7, stale card, Native DTO, #137 bounded wait, #138 read-only state access, #185 recovery, #186 observation, #189 retention 통과 |
| 질문·승인·보존/native 알림 | 전체 Node/Swift의 실제 계약 및 로컬 fixture/integration 검증. 새 실제 ChatGPT 질문/승인 대화가 발생했다는 주장 아님 |
| 독립 CI | 해당 dev producer의 GitHub Actions run 없음. 로컬 검증을 독립 CI로 표현하지 않음 |

#185/#186/#189의 처음 실패는 새 sandbox fixture의 합성 auth seed 누락이었다. disposable runtime 전용 helper로 복원했고 실제 credentials를 읽거나 복사하지 않았다. 생산 인증은 변경하지 않았다. 실제 취소 C의 요약 `JOB_FAILED`/exact `JOB_CANCELLED` 차이는 제품 결함으로 기록했다. 유효한 terminal-origin/cancellation-intent fixture에서 4개 중 3개 red, 수정 후 관련 48개 green 및 최종 전체 검증을 마쳤다.

## 실제 설치와 제공 리소스

각 교체 전에 active/pending Job·미처리 interaction·보호 상태·확인 불가 background process가 없음을 확인했다. Helper의 graceful lifecycle shutdown을 사용하고 모든 SQLite owner가 종료된 뒤 consistent backup/integrity/FK 검증을 했다. 기존 explicit stable state profile과 runtime.env를 유지했다. DB reset·직접 삭제·강제 종료·권한 완화는 없었다. 0700 recovery directory와 0600 SQLite/env snapshot 및 이전 앱을 로컬에 보존한다. credentials/DB/개인 payload는 이 감사에 넣지 않는다.

첫 교체는 9f4a3da/build 2026100301이었다. 실제 취소 의미 오류 수정 후 **두 번째 최종 교체**는 다음과 같다.

- producer: `1d9ea4a51615bbe60d73339116296e84be888725`, dirty=false
- sourceHash: `b1705b4fc77657e72b017831619ee61f0be1d23d36136ff0a01e27a52705cd8d`
- buildId: `1d9ea4a51615:b1705b4fc776`, CFBundleVersion: `2026100302`
- 앱/Helper/Bridge buildId 일치, running, Bridge/Tunnel connected
- 교체 직후 이전 1,051개 Job raw payload와 2개 followup receipt 그대로, env digest 동일, integrity/FK 정상

플러그인 도구 discovery를 실제 ChatGPT에서 갱신했다. 최종 서버 16개 도구에는 Events access/완료 sender가 없고 task schema에도 completionDelivery/eventSubscription이 없다. 공통 승인 지침은 남고 Events 지침은 없다. 배포된 resource bytes는 설치 bundle과 일치한다.

| 전후 표면 | 기준선 4fc1619 source/회귀 | 최종 설치 서버/회귀 |
| --- | --- | --- |
| tool/input | completion sender, 신규 delivery 선택 입력 존재 | 일반 16개 도구, sender·Events access 및 신규 delivery 선택 입력 없음 |
| capability/초기화 | controller 먼저 생성 후 Events 활성 여부에 따라 등록 | 일반 capability는 resources/tools listChanged뿐, Events service 생성 없음 |
| instructions/nextActions | Events 절차 혼재, 자동 card/완료 전달 동작 | 공통 승인 유지, same exact wait/input/result와 명시적 Dashboard만 안내 |
| 카드 리소스 | Dashboard v3/37, Settings v3/24 | Dashboard v4/38, Settings v4/25, packaged HTML와 제공 bytes 일치 |

변경 전 표면은 보존된 Git 기준선과 red/회귀 fixture에서 확인한 값이며, 최종 표면은 실제 설치 서버 응답이다. 초기 설치판 30919ee의 플러그인 화면에서도 write11/read6→갱신 후 write10/read6 변화가 보였지만 이를 4fc1619 서버의 독립 runtime capture라고 표현하지 않는다.

| 리소스 | generation | 제공 HTML SHA-256 |
| --- | --- | --- |
| `ui://codex-mcp-bridge/dashboard/v4.html` | 38 | `69e2fedcfa9f7aa13a925b98937e8c7506ac9a56c6c547ae78225fe85d7ccfff` |
| `ui://codex-mcp-bridge/settings/v4.html` | 25 | `38b7034832995013bc249ad2222289b21c8339528ccd90c43207ffa31d3d1cda` |

catalog/manifest digest `f5ceac2b092e876a40cd4850caf26d77cc90015e0c822c912c9cde034a501836`도 일치한다. 최종 설치 서버의 retired wait/accepted/rejected/uncertain/release 5개 요청은 식별 가능한 오류이고 Job count를 바꾸지 않았다. status completion 및 자동 카드의 구형 요청도 앞선 실제 설치 서버 시험에서 거부됐다.

## 실제 ChatGPT 수락

시험은 로그인된 웹 ChatGPT의 일반 Chat과 기존 연결된 Bridge에서 UI를 통해 수행했다. 부모 ChatGPT 모델/추론/usage는 공개 계측값이 없어 확인 불가이며 Codex 실행값으로 대체하지 않는다. Codex 작업은 등록된 기존 실행 정책에서 gpt-6-luna/low/priority로 실행한 읽기 전용 시험 프롬프트다. OS sandbox를 새로 read-only로 설정했다는 뜻이 아니다.

첫 설치판 9f4a3da에서 카드 없이 A 결과 원문 검토→시스템 승인 B→B 원문 검토→동일 B replay를 완료했고 iframe count는 0이었다. A/B의 Git HEAD 및 README digest가 전후 동일했다. 명시적으로 연 v4 카드에서 refresh·history toggle/expand를 확인했다. 카드가 열린 상태에서 C 실행 중 ChatGPT 응답 중지는 Job을 취소하지 않았고, 별도 명시적 사용자 취소 요청으로만 C가 cancelled됐다. D 완료 후에도 카드가 자동 메시지/후속 실행을 만들지 않았다. refresh 전후 사용자6/assistant5/iframe1이 그대로였다. Home 이탈은 iframe0, 원 대화 복귀 시 새 v4 초기화로 표시됐다. 복귀 화면의 오래된 대화 pagination은 message count 비교에 포함하지 않았다.

| 시험 | exact Job |
| --- | --- |
| 첫 A | `5402c4dc-04e8-4bde-800a-0caf47e34b32` |
| 첫 B | `32974224-bb71-4f65-8b67-a3ca8fdaf3bc` |
| 명시적 취소 C | `dc67583d-ff0b-499a-a1d5-ad1789b5e1fb` |
| 카드가 열린 상태에서 완료 D | `af1d791d-976a-4464-b7fc-52cbafbf328c` |

최종 1d9ea4a 설치와 Helper 재시작 후 원 대화에서 C의 exact 및 overview/page/activity/thread를 다시 읽었다. 모두 cancelled / `JOB_CANCELLED` / unavailable이며 summary에 answer 원문은 없다. 기존 B의 원래 prompt·canonical requestId·followupId·reviewedVersion18을 다시 보냈고 replay=true, 동일 `32974224-…`로 돌아왔다. 기존 Activity의 Job 수는 4개 그대로였다. 이 actual은 direct-wait B의 업그레이드 재전송이며, 구형 live-card/Events selector 호환은 별도 fixture/OAuth integration 근거다.

최종 producer의 새 일반 Chat에서도 다음을 새로 수행했다. A 원본의 `aValue=221`, B의 `reviewedA=221,bValue=222`, 양쪽 `unchanged=true`와 HEAD 1d9ea4a 및 README SHA `46ac6ef68529c14d21a0e87db537a5cb6f423f70c280d39d5ed7e5983f8c50dd`를 실제 읽고 검토했다.

| 최종 실제 시험 | 값 |
| --- | --- |
| A exact Job | `3e9405b1-391b-4b02-b16c-889998361c06` |
| B exact Job | `a270c9d2-339c-45b9-b74b-950a61ab589e` |
| Activity / Agent | `6d165d12-5ace-4eed-908a-c2fe1428d0d1` / `152a89cd-812f-4e32-baa6-f2ad2c30bf32` |
| thread | `01a0ffdc-e6b8-7f63-82ac-5c8110c277b1` |
| B canonical requestId | `33d3b5c5-26e0-52ef-b90a-a031f81cc573` |
| A reviewedVersion / B replay | 19 / replay=true, 동일 B 및 version17·원문 그대로 |
| 카드 없는 결과 검토 / 요약 | A→B 완료, iframe0; overview/page/activity/thread 모두 원문 없이 own exact action, exact 조회에서만 두 원문 |

그 뒤 **명시적으로** v4 현황카드를 열고 이력 필터·이력 펼치기·새로고침을 수행했다. 실제 mount JavaScript는 191,869 bytes, SHA `07dd1f5df94005bbd00f22dbc8da610f437f0a136052355e36a6c50e4d446400`으로 최종 bundle과 일치하고 sender가 없다. 이때 로드된 부모 메시지 heading 수는 user1/assistant2/iframe1로 갱신 전후 동일했다. 처음 긴 사용자 prompt가 렌더되지 않은 view의 수이며 전체 대화 수라고 표현하지 않는다. 재접속 후 전체 2개 사용자 요청/2개 답변이 다시 로드됐고, 새 initId의 v4 카드가 표시됐다. 새 메시지/Job 없이 기존 승인·결과는 그대로다.

SPA Home 클릭 직후에는 iframe1이 남아 있는 순간이 관측됐다. **전체 document navigation으로 Home을 로드하고 안정화된 화면에서는 iframe0**을 확인했다. 다시 원 대화로 들어가 v4 재초기화를 확인했다. 화면 이동만으로 기존 iframe이 즉시 파괴됐다고 가정하지 않는다. 실제 카드의 safe background 검사에서 순간적으로 unknown-agent 안내가 있었고 이후 해소됐다. 최종 runtime snapshot은 active/pending/interaction/background/unknown 모두0, background state confirmed였다. 추가 권한이나 새 Agent 생성으로 검사를 우회하지 않았다.

최종 readonly DB 대조에서 새 Job은 승인한 **A/B/C/D와 최종 A/B 총6개**뿐이고 총1,053개다. 최초 1,047개는 ID·requestId·scope·Activity/Agent/thread·상태·terminal version·생성/갱신 시각 모두 보존됐다. 1,040개 raw payload는 동일하다. **7개 raw payload는 기존 retention이 만료 처리했으므로 전체 1,047개 payload가 불변이라는 주장은 하지 않는다.** 이미 원문이 없던 30일 이력 2개와, 원래 6시간 TTL을 지나 `retention-pruned` 이벤트가 기록된 완료 결과 5개다. 해당 처리 함수는 Git 기준선과 exact bytes가 같고 TTL 21,600,000ms/history30일 및 env를 변경하지 않았다. 만료된 실행의 identity와 기존 followup receipt는 남고 새 실행은 발생하지 않았다. 교체 전에 보존한 private backup도 그대로다.

두 번째 최종 교체 직전의 1,051개 payload와 2개 receipt는 최종 actual 시험 이후에도 **전부 동일**하다. 최초 receipt1개, 무관한 settings/project registry/projects/env도 그대로이며 구형 boolean만 true로 정규화됐다. SQLite quick check/FK 정상이다. 보존·만료·신규 접수를 서로 다른 판정으로 기록한다.

## 구형 iframe의 확인된 한계와 전환 절차

이전 **실제 설치 앱**의 v3/generation37 JavaScript는 200,148 bytes, SHA-256 `8577930e81331f8e91c5bc1e4deec3a82c58fc3d8e1c3ab5c580dcaa93a03d75`이며 [회귀 fixture](../../test/fixtures/issue221-dashboard-v3.js.txt)와 exact bytes가 같다. 수정한 새 카드를 구형이라고 대신 시험하지 않았다.

구형 카드의 server-dependent wait/claim은 거부된다. 그러나 결과를 이미 받은 구형 iframe에서는 서버 accepted API 거부 전에 호스트 ui/message **1회가 가능**했다. host-rejected 뒤 재시도는 retired wait에서 멈췄으며 최초 호스트 시도와 재시도를 구별한다. 서버가 이미 열린 코드나 진행 중인 호스트 호출을 소급 철회할 수 없다는 실제 브라우저 재현이다. 모든 과거 mount를 무송신 확인했다는 선언은 하지 않는다. 공식 [UI 계약](https://developers.openai.com/plugins/build/chatgpt-ui#prefer-shared-fields-and-methods)도 메시지 송신과 초기화/표시/도구 호출을 구별한다.

업그레이드 시 기존 카드가 있는 화면은 전체 페이지 재로드/종료로 mount를 해제하고, 플러그인 도구를 갱신하며, 새 대화에서 일반 direct-wait를 사용한다. 같은 과거 대화에서 host가 v3 bytes를 다시 mount할 수 있으므로 새 대화의 명시적 요청에서 v4를 표시하는 것이 전환 절차다. 기존 Job은 원 대화의 exact 권한으로 복구한다. 이번 actual 시험은 구형 카드가 없는 새 대화에서 시작했고, 명시적 v4의 전체 document teardown/remount와 bundle script digest를 확인했다.

## 장시간 근거 재사용과 범위

최종 diff는 일반 bounded wait 수명·HTTP 연결/대기 transport·결과 retention을 바꾸지 않았다. runtime 변경은 폐기한 카드 송신을 위한 priority reservation 제거다. 관련 timeout·연결·보존 회귀가 통과했고 #222의 actual 30분/60분 **1800.086446041초 / 3600.075175209초**를 재사용했다. 장시간 시험을 다시 실행하거나 새 성공으로 집계하지 않았다. 화면 이탈/앱 종료 뒤 GPT 재개는 기존 user-confirmed actual 출처를 그대로 유지한다. 모든 host의 자동 wake 보장이나 불가능으로 바꾸지 않는다.

Sites/예약/TinyFish/새 monitoring/remote routing 및 광범위 auth/orphan 수정은 추가하지 않았다. #222/#223의 코드·이슈는 변경하지 않았다. 다른 기존 worktree와 모든 Codex/ChatGPT 대화는 정리 대상이 아니다. 코드 통합과 이슈 종료 후 수동 task worktree/branch만 clean·통합·사용 프로세스 여부를 확인하여 강제 삭제 없이 정리한다. 로컬 증거는 주 checkout의 ignored output에 보존한다.
