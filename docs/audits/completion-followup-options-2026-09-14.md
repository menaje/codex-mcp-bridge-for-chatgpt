**카드와 독립된 완료 전달 검토 — 2026-09-14**

관련 이슈: [#108](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/108), #105, #106. 아래 초기 검토에는 card·host-event 전달을 후보로 둔 당시의 논의가 남아 있다. 실제 ChatGPT 수명 검증에서 어느 쪽도 원래 대화의 자동 재개를 제공하지 못했으므로, 현재 구현과 이슈의 최종 결정은 그 가정을 대체한다.

## 최종 결정 및 구현

`completionFollowUp`은 더 이상 ChatGPT 후속 응답을 뜻하지 않는다. 이를 켜면 새 one-job background Activity 중 명시적 completion 정책이 없는 경우에만 `notify`와 `sealed-jobs-terminal`을 적용하고, 성공적으로 완료된 Activity를 durable outbox에 기록한다. foreground, 기존/연결된 Activity, `none`·`verify` 등 명시 정책은 이 기본값으로 바꾸지 않는다.

로컬 macOS 메뉴 막대 앱은 private Unix socket의 `completion.claim`, `completion.delivered`, `completion.release`만 사용한다. claim 결과는 stable `eventId`와 `outboxId`뿐이며 task prompt, result, path, Activity ID, scope, ChatGPT conversation ID는 IPC와 macOS 알림 표면에 나오지 않는다. macOS가 generic notification을 수락한 뒤에만 exact outbox record를 acknowledge하고, 실패하면 lease를 release한다. 알림을 클릭하면 로컬 Dashboard가 열리며 ChatGPT 대화는 재개하거나 메시지를 추가하지 않는다. 이 세 메서드는 remote companion HTTPS allowlist에 포함하지 않는다.

Dashboard의 background-only 자동 표시는 별도 설정이다. 카드와 `ui/message`는 completion outbox를 claim·ack·전송하지 않는다. 앱이 꺼져 있거나 알림 권한이 없으면 outbox는 남아 있고, 중간 crash 후에는 stable event ID로 재시도될 수 있으므로 exactly-once visible delivery를 주장하지 않는다. 이 문서의 나머지는 이 결정을 내리기 전의 검토 기록이다.

## 초기 검토 기록 (대체됨)

**합의한 방향: 두 전달 경로와 카드 표시 설정**

카드 표시 여부에 따라 경로를 고정하면 카드가 닫힐 때 사용 가능한 호스트 경로를 놓칠 수 있다. 다음 두 설정과 내부 자동 선택을 적용하는 방향으로 합의했다.

- **백그라운드 작업 시 현황 카드 자동 표시**: 켬/끔. 켜면 background 작업에서만 작업을 시작한 대화의 `scope:conversation`으로 연다. foreground에는 자동 표시하지 않는다.
- 완료 후 자동 응답: 켬/끔. 기존 자동 전달 off 설정을 마이그레이션 중 임의로 켜지 않는다.
- 전달 방식은 내부에서 기능 지원과 현재 연결 상태로 선택한다. 일반 설정에 카드/호스트 선택을 추가하지 않는다. 필요한 진단용 override는 별도 검토한다.

background 작업에서 자동 응답이 켜져 있고 현재 응답이 종료된 경우의 선택 표다. 여기서 호스트 사용 가능은 단순 MCP 연결이나 resource 알림 수신이 아니라, 해당 원래 대화의 모델 재개를 검증했고 유효한 대상·구독 연결이 있는 상태를 뜻한다.

| 카드 자동 표시 | 호스트 자동 재개 사용 가능 | 표시 및 전달 |
| --- | --- | --- |
| 켬 | 예 | 현황 카드를 이 대화로 열고, 완료 전달은 호스트 이벤트 사용 |
| 켬 | 아니오/미확인 | 현황 카드를 이 대화로 열고, 실제로 실행 중인 카드의 메시지 전송 기능 사용 |
| 끔 | 예 | 자동 카드 없이 호스트 이벤트 사용 |
| 끔 | 아니오/미확인 | 종료 후 자동 응답을 제공할 수 없음을 표시. 미전달 결과를 보관하고 다음 대화·조회에서 회수 |

이 구조에서 현황 카드의 역할은 표시·제어와 필요한 경우의 얇은 메시지 전송이다. 서버의 완료 판정·전달 상태 관리까지 카드로 옮기지 않는다. 카드가 없거나 닫혀 있으면 카드 경로를 사용 가능으로 표시하지 않는다. 자동 표시 끔을 숨은 카드나 강제 재열기로 우회하지 않는다. 카드가 수동으로 열린 것만으로 자동 전달에 동의한 것으로 취급하지 않는다.

호스트 이벤트를 우선하는 이유는 카드의 렌더링·수명에 대한 의존을 줄이기 위해서다. 이는 호스트 경로의 원래 대화 재개와 재접속 동작이 실제로 검증된 환경에서의 설계 판단이다. 지금 두 경로가 같은 수준으로 동작한다고 확인한 것은 아니다. UI의 `ui/message`는 공식적으로 제공되는 경로이며, 새 UI는 이를 우선하고 필요한 경우 `sendFollowUpMessage` 호환 경로를 기능 검사 후 사용한다. [OpenAI UI 문서](https://developers.openai.com/plugins/build/chatgpt-ui#prefer-shared-fields-and-methods).

공통 전달부는 기존 outbox를 활용하되 다음을 보완한다.

- 동일 완료 사건에 고정된 event ID와 원래 scope를 부여한다. 카드와 호스트가 같은 사건을 동시에 보내지 않도록 공통 claim과 전송 상태를 사용한다. 복수 카드 중 전송 권한은 한 곳에만 부여한다.
- 전송 전 경로가 없거나 명확히 거절된 경우에는 다른 사용 가능한 경로를 선택할 수 있다. 이미 전송을 시작했고 수락 여부만 불명확하면 즉시 다른 경로로 다시 보내지 않는다. 먼저 같은 사건의 처리 상태를 확인하고, 확인 수단이 없으면 불확실 상태로 보관한다.
- 이벤트 발행, 호스트 수락, GPT의 결과 소비 확인을 구별한다. 동일 event ID의 중복 처리 방지는 호스트/소비 경계까지 필요하며 서버 lease만으로 사용자 메시지의 exactly-once를 보장한다고 표현하지 않는다.
- 현재 GPT 응답의 대기·최종 결과 처리와 뒤늦은 후속 알림도 같은 전달 상태로 조정한다. 단순 결과 조회를 전달 확인으로 기록하지 않는다.
- 카드가 전체 보기로 전환돼도 원래 전달 scope는 유지한다. 현재 Dashboard의 `auto`는 이 대화에 기록이 없으면 전체 보기를 선택하므로, 작업 시 자동 표시는 `conversation`을 명시하고 scope를 확인할 수 없을 때 다른 대화로 대체하지 않는다.
- Activity의 none/manual/notify/verify, 완료·검증 의미, 중단·실패 구분을 보존한다. 모든 Job 종료를 무조건 성공 메시지로 만들지 않는다.

현행 `never + auto-handoff` 금지, Activity presentation에 묶인 handoff endpoint, Dashboard의 자동 표시·전송 기능 부재는 구현 시 변경 대상이다. Activity 전용 도구는 폐기하되 공통 claim/ack 계약이 필요하면 독립된 write 계약을 설계한다. 15개 도구라는 목표 때문에 읽기 도구에 전달 mutation을 숨기지 않는다. [기존 설정 검증](../../src/userSettings.ts:403), [기존 outbox](../../src/stateStore.ts:2592), [현황 카드](../../src/dashboardCard.ts:178).

적용 순서는 공통 전달부 분리와 현황 카드 경로 구현·검증, 호스트 경로의 실제 ChatGPT 검증 및 지원 환경에서 활성화다. 두 경로의 인터페이스는 처음부터 설계하되, 미검증 호스트 경로를 완료된 기능으로 제공하지 않는다. 예약 실행은 두 경로 모두 사용할 수 없을 때 별도로 평가할 후보다. 이번 권장안의 필수 세 번째 경로로 추가하지 않는다.

**확정 표시 정책: 백그라운드에서만 현황 카드 자동 표시**

자동 표시를 background로 제한한다. foreground는 원래 도구 호출이 완료 결과를 반환하므로 자동 카드의 필요가 적고, 첫 카드가 결과 뒤에 렌더링되는 환경에서는 이미 끝난 작업의 화면이 추가된다. background는 작업 정보만 즉시 반환하므로 진행 상태·중단·입력 확인을 위한 현황 카드의 효용이 더 크다. 호스트 미지원 시의 카드 전달 경로도 이 경우에 유지할 수 있다. [실행 분기](../../src/tools.ts:9931), [기존 background-only 판정](../../src/tools.ts:2351).

| 상황 | 확정 표시 정책 |
| --- | --- |
| foreground 실행 | 새 현황 카드 자동 표시 없음. 원래 호출로 결과 처리 |
| background 실행 + 자동 표시 켬 | 이 대화의 현황 카드 자동 표시 |
| background 실행 + 자동 표시 끔 | 자동 표시 없음. 검증된 호스트 경로로 전달하거나 사용 불가·대기 상태 표시 |
| 사용자가 현황을 직접 요청 | 실행 모드와 무관하게 수동 카드 열기 허용 |

- 설정 이름은 **백그라운드 작업 시 현황 카드 자동 표시**로 구체화하고 값은 켬/끔으로 단순화한다. 기존 always/background-only는 켬, never는 끔으로 전환한다. 새 설정에는 always 선택지를 제공하지 않는다. 기존 자동 후속 응답 off는 그대로 보존한다.
- 판단 기준은 admission 후 확정된 Job의 executionMode다. 누락된 요청 인자나 GPT 응답의 진행/종료 상태를 실행 모드로 간주하지 않는다.
- 제한 대상은 새로운 카드의 자동 표시다. 이미 열린 현황 카드를 닫거나 foreground 작업·이력을 현황 데이터에서 숨기지 않는다. foreground/background가 섞인 대화도 현황 카드에서 함께 확인할 수 있다.
- 카드의 표시 조건은 후속 메시지 전송 권한과 분리한다. 자동 응답 off인 상태에서 카드를 열어도 자동 전송을 시작하지 않는다. foreground 결과가 현재 응답에서 이미 처리됐다는 확인이 있으면 동일 완료를 후속 메시지로 중복 전달하지 않는다.
- 정상 foreground 결과 전달에 카드가 필요 없다는 사실은 연결이 끊긴 원래 GPT 응답을 자동 복구한다는 뜻이 아니다. 원래 호출 수명·취소·결과 보관 계약을 유지한다.

이 표시 정책은 사용자 동의를 받은 확정 사항이다. 내부 스키마 필드 이름과 신규 설치 기본값은 구현 계약에서 정리하며, 기존 설정의 전환은 위 규칙을 따른다.

**기존 foreground / background 동작**

8월 23일 변경 `2f3fa0298b6277888ec4e1806eb8938786be4787`은 실행 방식과 카드 표시를 분리했다. 변경 전 `auto`는 25초 안에 끝나면 결과, 길어지면 Job을 반환하던 방식이었다. 그 변경에서 `auto`와 fast-return 임계값을 폐기하고 아래 두 모드로 정리했다. 현재 구현에도 같은 실행 분기가 남아 있다.

| 구분 | 도구 응답 | 카드의 역할 |
| --- | --- | --- |
| foreground | `codex_task`가 `job.promise`를 기다리고 최종 결과를 원래 호출에 반환 | 결과 전달 자체에는 불필요. 기존 카드가 있으면 진행 상태를 관측하며, 첫 카드는 호스트에 따라 결과 뒤에 표시 |
| background | Job을 등록하고 즉시 Job/Activity ID와 상태를 반환 | 이전 자동 표시 흐름은 반환 직후 카드를 열고 scope 변경을 관측. 조건을 충족한 완료 이벤트를 카드가 후속 메시지로 전송 |
| 카드 표시 설정 | `always / background-only / never` | 실행 모드를 변경하지 않음 |
| 자동 후속 전달 설정 | `off / auto-handoff` | 기본값 off. 기존 구현은 never + auto-handoff 조합을 거부 |

근거: [실행 분기](../../src/tools.ts:9931), [카드 표시·시점](../../src/tools.ts:2335), [기본 설정](../../src/userSettings.ts:115), [기존 카드 의존 검증](../../src/userSettings.ts:403).

자동 전달은 모든 백그라운드 Job 종료를 곧바로 알리는 기능이 아니었다. 기본 Activity는 `handoffPolicy=none`, `completionTrigger=manual`이므로 Job 종료만으로 완료 outbox를 만들지 않는다. `notify / verify` 정책과 명시적 완료 또는 sealed Activity의 자식 Job 완료 조건을 만족하면 이벤트가 생긴다. verify는 검증 요청이며 성공 보고가 아니다. 실패한 자식 Job은 성공 완료 이벤트로 바꾸지 않는다. [완료 판정](../../src/activity.ts:158), [outbox 기록](../../src/stateStore.ts:5235).

기존 카드는 자동 표시 권한을 검사하고 outbox를 claim한 뒤 `sendFollowUpMessage` 또는 `ui/message`를 실행했다. 카드가 닫히면 타이머와 관측도 중단됐다. 메시지가 호스트에 수락된 뒤 SQLite 전달 확인 전에 연결이 끊기면 중복 가능성이 있어, 기존 구현도 분산 exactly-once를 보장하지 않는다. [기존 전송부](../../src/activityCard.ts:404), [OpenAI 공식 UI 문서](https://developers.openai.com/plugins/build/chatgpt-ui#prefer-shared-fields-and-methods).

**실제로 확인한 카드 없는 경로**

| 경로 | 확인 결과 | 적용 범위 |
| --- | --- | --- |
| foreground 최종 도구 결과 | 격리된 실제 브리지 HTTP 호출에서 성공 | 원래 GPT 도구 호출이 계속 살아 있는 동안 |
| background + 정확한 Job 상태 대기 | 기존 thread를 가진 Agent에서 즉시 반환 후 terminal 대기로 최종 답변 수신 성공 | GPT가 현재 응답에서 도구 호출을 이어가는 동안 |
| background 결과 보관 + 나중에 조회 | 작업 호출이 끝난 뒤 결과 보관·정확한 Job 재조회 성공 | 사용자의 후속 입력이나 호스트 실행으로 GPT가 다시 실행된 뒤 |
| MCP 2026-07-28 resource subscription | SDK fixture에서 알림 수신, 다른 URI 필터링, 결과 재조회 성공 | 프로토콜 클라이언트까지의 전송. GPT 자동 재개는 미검증 |
| Codex app-server event stream | 로컬 CLI 0.153.3의 생성된 experimental 스키마에서 관련 요청·알림 확인 | Codex 호스트 연동 후보. 기존 ChatGPT 대화에 입력을 넣는 API로 간주하지 않음 |
| 원래 대화의 예약 실행 | 공식 문서에서 기존 문맥·분 단위 실행 지원 확인 | 해당 계정/호스트의 MCP 접근 및 동일 scope 유지 검증 필요 |

**유지할 경로: 독립 실행 + 현재 GPT 응답의 대기**

Codex 작업이 background라는 사실은 GPT 응답을 끝내야 한다는 뜻이 아니다. 실행 워커는 계속 일하고 GPT는 결과 또는 입력 이벤트를 기다릴 수 있다. 이 경우 새 사용자 메시지를 인위적으로 만들어 GPT를 깨울 필요가 없다.

1. `codex_task(executionMode:background)`로 실행하고 정확한 Job ID를 보관한다.
2. 현재 `codex_status(query.kind:input, jobId, afterCursor, waitMs)`로 입력 변화 또는 Job 종료를 제한된 시간 동안 기다린다. 현재 상한은 60초이며 보통 55초를 사용한다. 질문이 나오면 위임 범위에서 답하거나 사용자에게 일반 대화로 묻는다.
3. 실제 답변은 기존 `codex_answer`, 원래 승인 요청은 승인 경로로 처리한다. 카드 제거가 승인 자동 수락을 뜻하지 않는다.
4. Job이 terminal이면 `codex_status(query.kind:job, id)`로 최종 결과를 읽고 검증·보고한다.
5. 여러 Job을 다룰 때는 기존 scope 버전 알림 코어를 카드와 분리한 제한된 event-wait 분기를 검토한다. 예를 들어 `codex_status(query.kind:events, afterCursor, waitMs)`를 추가할 수 있지만 이것은 아직 제안 스키마다.

현재 `waitForScopeVersion`은 presentation·widget lease 검사를 포함하므로 그대로 재사용하면 카드 의존성이 남는다. scope version/listener/abort/timeout 코어를 추출하고 카드 presentation 검사는 카드 호출자에만 남겨야 한다. 카드를 제거한 뒤 단순히 이름을 바꾸는 방식으로 끝내지 않는다. [기존 scope 대기](../../src/tools.ts:3348), [입력·종료 대기](../../src/tools.ts:3988).

foreground는 단순 결과 대기에 적합하지만 원래 호출이 오래 유지되고, 도중 질문을 GPT가 다뤄야 할 때 운영이 어려울 수 있다. 질문이 있는 작업의 기본안은 background + 입력 대기다. 호스트가 응답을 끝내거나 사용자가 중단하면 이 경로는 자동 재개 기능을 제공하지 않는다. [원래 호출의 수명](../../src/originWait.ts:19).

**GPT 응답이 끝난 뒤: 호스트 이벤트 경로를 우선 검증**

브리지 완료 이벤트 → 독립 전달 워커 → 호스트 이벤트 구독 → 호스트가 원래 대화를 실행 → GPT가 정확한 Job 결과 조회라는 구조를 검증한다. 카드의 존재나 선택된 화면 필터는 이 구조의 입력이 아니다.

- 표준 `subscriptions/listen`은 tools/prompts/resources 목록 변경과 구독한 resource URI 변경 알림을 전달한다. 일반 ChatGPT 메시지 전송 메서드가 아니다. 공식 SDK는 multi-process bus 구현도 허용한다. 카드 없이 전달 가능한 통로임은 확인했으나, 수신 후 GPT 실행을 시작하는 정책은 호스트 책임이다. [MCP SDK listen](https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/client.html#listen).
- 현재 브리지는 `resources.subscribe`를 광고하지 않으며 fixture로 완료 URI를 구독했을 때 honored filter가 비어 있었다. 완료 리소스와 publisher도 구현되지 않았다. 표준 transport가 SDK에 있다는 사실만으로 지금 배포본이 완료 알림을 제공한다고 판단하지 않는다.
- 로컬 Codex 0.153.3에서 생성한 experimental JSON Schema에 `mcpServer/event/stream/start`, `mcpServer/event/stream/stop`, `mcpServer/event/stream/notification`이 존재했다. start 입력은 `threadId, subscriptionId, server, name, arguments`와 선택적 `_meta`를 받는다. 이 API는 **호스트 클라이언트 ↔ Codex app-server** 경로이고, 표준 `subscriptions/listen`과 동일한 계약도 아니다.
- OpenAI 공식 changelog에는 MCP event discovery/subscription 및 task unload 이후 유지에 관한 변경도 있다. 구독 관리 기능의 존재를 뒷받침하지만, 이 브리지의 사용자 정의 이벤트가 ChatGPT 기존 대화를 자동 재개한다는 보장은 제공하지 않는다. [OpenAI 공식 changelog](https://learn.chatgpt.com/docs/changelog).
- 실제 검증에는 ChatGPT developer-mode 커넥터와 Secure MCP Tunnel을 함께 사용해야 한다. 이벤트 등록/구독 발견, 원래 대화 식별, GPT 응답 종료 뒤에도 구독 유지, 완료 시 해당 대화의 모델 응답 시작, 재접속·중복 이벤트 처리를 차례로 확인한다. SDK 클라이언트 수신만 성공한 상태를 최종 통과로 처리하지 않는다.

호스트가 실행을 시작하지 않으면 앞의 현황 카드 경로를 사용 가능한 경우 선택한다. 두 경로 모두 사용할 수 없을 때 원래 대화의 예약 실행은 별도 확장 후보로 남긴다. 예약이 같은 문맥으로 돌아와 미전달 결과를 조회하는 방식이며 즉시 push가 아니다. 대화별 추적을 묶고 변화가 없으면 사용자 메시지를 남기지 않으며, 완료·실패·입력 필요 시에만 처리하고 추적 종료 후 예약을 해제하는 안이다. 실제 availability 및 MCP/scope 유지부터 검증한다. [OpenAI 공식 예약 실행 문서](https://learn.chatgpt.com/docs/automations#schedule-a-task-inside-a-chat).

MCP Tasks나 transport 진행 알림을 추가하는 것만으로 호스트의 대화 재개까지 해결됐다고 간주하지 않는다. Codex app-server의 thread/turn API와 OpenAI API의 별도 대화 역시 기존 ChatGPT 대화에 대한 전달 API와 동일시하지 않는다. OS 알림은 사용자에게 알려줄 수 있지만 GPT 응답 재개를 대신하지 않는다.

**독립 전달 구성 요소의 범위**

- 완료 판단과 outbox는 서버에 둔다. 정확한 `scopeId / activityId / completionVersion / channel`로 대상을 구분하고 Job 종료·검증 필요·검증 완료를 보존한다.
- 현재 대기 요청과 호스트의 나중 실행이 같은 결과를 중복 보고하지 않도록 조회/보고 시도/호스트 수락/소비 확인을 구분한다. 알림을 내보낸 시점에 사용자에게 전달됐다고 기록하지 않는다.
- 단순 조회 도구에 전달 확인 mutation을 숨기지 않는다. 추가 write 계약이 필요하면 #108의 15개 목표 수는 실제 설계에 맞춰 다시 산정한다. 카드 전용 handoff 도구를 유지하기 위해 16개로 고정하지 않는다.
- 별도 OS 프로세스로 운영할 경우 원래 Job의 실행 권한을 추가로 갖게 할 필요는 없다. durable outbox와 인증된 IPC/pub-sub를 통해 전달만 담당한다. 초기에는 브리지 내부의 독립 모듈/워커로 시작해도 카드와의 결합을 제거할 수 있다.
- 카드 닫힘·재열림은 작업이나 서버의 전달 추적을 취소하지 않는다. 다만 카드 경로의 사용 가능 상태는 바뀌며, 검증된 호스트 경로가 없으면 전달이 대기할 수 있다. 다른 대화 보기로 전환해도 대상 scope는 변경되지 않는다. host session의 UUID나 Dashboard 링크를 검증된 외부 메시지 전송 주소로 가정하지 않는다. [scope 처리](../../src/scopeResolver.ts:28).

**격리 검증과 발견한 초기 background 응답 문제**

[검증 JSON](cardless-delivery-probe-2026-09-14.json), [재현 스크립트](cardless-delivery-probe-2026-09-14.mts). 스크립트는 해당 날짜 계약의 관측 스냅샷이다. 임시 SQLite와 수동 완료 mock upstream을 사용했으며, 실제 Codex/model 호출·ChatGPT 메시지·카드·예약 실행은 만들지 않았다.

- 카드 없는 foreground 반환, 기존 Agent background + status wait, 종료 뒤 결과 조회, SDK resource update 전송 등 4개 경로 검증 통과.
- `test/originWait.test.ts` 및 `test/activityStore.test.ts`: 2개 파일, 15개 테스트 통과.
- 첫 테스트의 runtime 소스 기준은 `4f80c6d`이며 `d1627f5`까지 해당 runtime/검증 파일 변경이 없음을 확인했다. 재현 스크립트를 저장한 뒤 `a33ffd2`에서도 4개 경로와 초기 응답 문제를 다시 확인했다. 최종 실행 SHA는 JSON에 기록했다. 다른 작업의 변경은 수정하지 않았다.
- **신규 background + upstream thread 할당 전**: Job은 등록되고 실행도 시작되지만 현재 task 출력 검증은 admitted Job의 `threadId`를 필수로 요구해 오류 결과를 반환했다. mock에서 재현했고 초기 Job 생성·즉시 반환·출력 refine 코드를 대조했다. 기존 thread를 지정한 background 경로는 통과했다. 실제 App Server의 지연된 thread 배정도 포함해 #106의 초기 상태 계약을 검증·수정해야 한다. 이미 등록된 Job에 새 requestId로 자동 재실행하는 대응은 피한다. [초기 identity 검증](../../src/tools.ts:518), [Job 시작](../../src/tools.ts:3579), [background 즉시 반환](../../src/tools.ts:9931).

제품 구현은 아직 변경하지 않았다. 다음 구현에서는 초기 background 응답 계약을 먼저 정리하고, 기존 카드 없는 대기를 보존하면서 공통 전달부와 현황 카드 경로를 구현한다. 호스트 이벤트 경로는 실제 원래 대화 재개 검증을 통과한 환경에서 활성화한다.

## 실환경 보정 — inline Dashboard 수명

이 문서의 카드 보조 전달 가정은 2026-09-14 실제 ChatGPT 테스트에서 반증됐다. background 작업의 `codex_dashboard` 렌더는 원래 대화에 자동으로 표시됐지만, ChatGPT가 그 모델 응답을 끝낼 때 카드에 `ui/resource-teardown`을 전송했다. 화면에는 마지막 렌더가 남아도 카드의 타이머와 도구 호출은 중지되므로, 종료 뒤 `ui/message`로 완료 메시지를 보내는 전달 워커가 될 수 없다.

따라서 현재 구현은 카드를 표시·제어 전용으로 유지하고, 카드 기반 completion claim/ack 및 `ui/message` 전송을 제거했다. 이 보정 뒤 사용자와 합의한 대체안은 ChatGPT 재개가 아닌 **로컬 macOS 완료 알림**이다. eligible `notify` outbox는 메뉴 막대 앱이 private local socket에서 opaque receipt로 claim하고, generic notification을 macOS가 수락하면 acknowledge한다. 이 보정은 위의 초기 합의와 다르므로, 카드 전달 행과 그 구현 전제는 역사적 검토로만 읽는다.
