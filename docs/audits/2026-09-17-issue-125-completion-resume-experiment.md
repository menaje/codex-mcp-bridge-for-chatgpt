# #125 실제 ChatGPT 완료 전달·재개 실험 — 2026-09-17

관련 이슈: [#125](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/125), [#124](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/124), [#108](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/108)

## 결론

실험·설계 작업은 완료했다. 다만 **응답이 끝난 원래 ChatGPT 대화를 신뢰성 있게 깨우는 제품 경로는 미선정**이다. 현재 환경에서 확인한 경로는 capability에 따라 나뉜다.

| 조건 | 판정 | 선정 경로 |
| --- | --- | --- |
| 원래 GPT 응답이 계속 실행 중 | 실제 종단 성공 | 정확한 Job을 `codex_status`로 제한 대기하고 terminal answer를 같은 응답에서 처리한다. Dashboard는 필요 없다. |
| 원래 GPT 응답 종료, 같은 대화의 UI 컴포넌트가 실제 실행 중 | 메커니즘 1회 종단 성공, 새 대화 반복 0/2 | `ui/message` 자체는 GPT를 깨울 수 있지만 job-scoped 자동 Dashboard metadata가 새 대화에서 재현되지 않아 제품 경로로 선정하지 않는다. |
| 원래 GPT 응답 종료, 카드 없음·명시적 teardown·다른 대화로 이동 | 자동 재개 경로 없음 | 결과는 #124의 SQLite 기록에 남지만, 현재 공개·발견된 계약에는 서버가 원래 ChatGPT 대화를 깨우는 API가 없다. |

따라서 현재 응답의 exact-status wait만 선정한다. live-card `ui/message`는 프로토콜 후보로 남기되 새 ChatGPT 대화에서 반복 가능해질 때까지 제품 경로로 선정하지 않는다. 카드 없는 종료 응답은 향후 **원래 대화를 대상으로 하는 정식 host wake/callback capability**가 확인되기 전까지 미지원으로 남긴다. macOS 알림, Dashboard 재열기, 사용자의 수동 조회는 자동 GPT 완료 메시지의 대체 성공으로 세지 않는다.

이번 실험에서는 기존 시험 대화의 live-card 최소 시제품이 한 번 종단 성공했지만, connector 새로 고침 뒤 만든 서로 다른 새 ChatGPT 대화 두 곳에서는 전달 metadata가 widget에 도달하지 않아 반복되지 않았다. 그 코드는 증거 수집용으로만 격리해 사용한 뒤 제거했다. 이 문서는 운영 배포 완료를 주장하지 않으며, 후보를 다시 열기 위한 lease·확인·중복 방지 설계를 아래에 확정한다.

## 실행 환경과 식별 경계

- 소스 기준 SHA: `c930445512ce076bed10a999e4ff7a5888af1614` 위의 #125 작업 트리. 최종 패치는 이 문서를 포함한 Git commit으로 추적한다.
- Bridge: `0.4.1`, MCP `2026-07-28`, `codex_task` contract v6, execution envelope `32b162…93006`.
- ChatGPT macOS 앱: `26.911.61220 (9647)`.
- 설치 Codex CLI: `0.155.0-alpha.2.6`.
- 시험 G: 실제 ChatGPT 대화. 제어 A: Codex 인앱 브라우저와 독립 local MCP client. 작업 B: Bridge가 시작한 실제 Codex App Server turn.
- 공개 기록에는 conversation, scope, Job, Activity, thread의 원시 UUID를 넣지 않는다. 아래 alias와 결과 SHA-256 앞 12자리만 기록한다. 원시 대응은 로컬 SQLite와 시험 대화에 남아 있다.

식별자는 다음처럼 분리했다.

| 식별자 | 용도 | 다른 식별자의 대체 여부 |
| --- | --- | --- |
| ChatGPT conversation | 원래 사용자 대화와 화면 전환 관찰 | Bridge scope나 Codex thread로 추측하지 않음 |
| Bridge scope | 도구 호출의 대화 격리 | `ui/message`가 만든 새 turn에는 자동 승계되지 않음을 실측 |
| Job / Activity | 실행과 결과 보존·완료 정책 | ChatGPT 메시지 주소가 아님 |
| Codex thread / active turn | App Server 실행과 `turn/steer` 대상 | 원래 ChatGPT 대화를 깨우는 API가 아님 |
| agent-tree id | A/B 실험 조율 | 독립 임의 Codex나 ChatGPT 대화에 대한 전송 권한이 아님 |

## 통신 사전 검증

같은 Codex agent tree 안의 A/B 통신을 `COMM-1`으로 검증했다. A가 run marker와 `seq=1` READY를 확인하고 정확한 대상 B에 `seq=2` RELEASE를 보냈으며, B가 같은 marker의 ACK를 반환했다. 이 통신은 같은 팀 트리의 권한 있는 대상에서 수신까지 확인했지만, 임의의 독립 Codex session ID에 대한 범용 메시지 API로 확대하지 않는다.

실제 작업 turn의 RELEASE는 별도 local MCP controller가 처리했다. controller는 다음 순서를 강제한다.

1. SQLite에서 정확한 scope·Job과 단 하나의 `READY <run-marker> seq=1` agent message를 확인한다.
2. `codex_status`에서 현재 Job version과 running 상태를 다시 읽는다.
3. exact Job에 `codex_steer`로 `RELEASE <run-marker> seq=2`를 보낸다.
4. 명시적 `STALE_JOB_VERSION`에만 bounded retry하고 다른 오류는 중단한다.
5. 같은 Job의 terminal answer를 다시 읽는다.

재현 도구는 [`scripts/issue-125-live-control.ts`](../../scripts/issue-125-live-control.ts)다. sleep 길이로 완료 시점을 추정하지 않고, marker·version·수신 결과를 대조한다. 이 제어 채널의 성공은 제품의 Codex→ChatGPT 전달 성공으로 계산하지 않았다.

## 실험 중 발견해 먼저 고친 전제 오류

첫 설치본 교체 뒤 새 App Server worker가 약 68ms 안에 `failed to load configuration: No such file or directory (os error 2)`로 실패했다. 장기 실행 helper가 교체로 unlink된 옛 Runtime 디렉터리를 cwd로 상속한 것이 원인이었다. App Server worker를 안정적인 home cwd에서 시작하도록 [`src/appServerUpstream.ts`](../../src/appServerUpstream.ts)를 고쳤고, fixture가 실제 cwd를 기록하는 회귀 테스트를 추가했다.

또한 Dashboard는 `ui/resource-teardown` 뒤 `pageshow`나 `visibilitychange`가 오면 다시 `mounted=true`가 될 수 있었다. 명시적 teardown을 되돌릴 수 없는 `tornDown` 상태로 바꾸고 생성 HTML을 검사하는 테스트를 추가했다. 최신 ChatGPT 호스트가 응답 종료 때 항상 teardown하지는 않았지만, host가 teardown을 보냈을 때 죽은 컴포넌트를 다시 활성화하면 안 된다.

실험 초기의 `UNAVAILABLE` 한 건은 admission 전에 끝나 SQLite Job이 없었다. 같은 `requestId`로 정확히 재시도해 Job 하나만 생겼다. 또한 현재 계약에서 제거된 `executionMode`를 보낸 첫 시도와 v5 캐시를 사용한 시도는 유효한 실험으로 세지 않았다.

## 실제 실행 결과

모든 시각은 UTC다. `PROBEVALUE`는 RELEASE 뒤 B가 처음 생성한 UUID이므로 초기 ChatGPT prompt가 알 수 없다.

| case | 관측 조건과 시각 | 결과 |
| --- | --- | --- |
| E1-A | active G + live Dashboard. 접수 `09:13:25`, READY `09:13:32`, RELEASE `09:15:32`, terminal `09:15:43` | 같은 응답의 exact-status wait가 terminal을 받았다. 최초 표식 이름이 보안 redaction과 충돌해 값 정확성 판정에서는 제외했다. |
| E1-B | active G + live Dashboard 반복. 접수 `09:17:16`, READY `09:17:27`, RELEASE `09:18:52`, terminal `09:19:25` | 성공. G가 미지 값 digest `53df1e8fab0c`를 최종 응답에 정확히 반영했다. G 응답은 RELEASE 전 1분 이상 살아 있었다. |
| E1-C | active G + 카드 없음. 접수 `09:30:19`, READY `09:30:32`, RELEASE `09:30:40`, terminal `09:31:06` | 성공. digest `68040816fb03`. Dashboard 없이 exact polling만으로 종단 완료했다. |
| E2 | G가 해당 Job을 조회하지 않고 120개 문장을 생성 중. 접수 `10:16:34`, READY `10:16:43`, RELEASE `10:16:51`, terminal `10:17:01` | terminal 뒤에도 G의 `답변 중지`가 보이는 active response였다. 미지 digest `63c514384cfe`는 응답에 나타나지 않았고 G는 지정한 일반 출력으로 끝났다. active라는 사실만으로 callback이 생기지 않는다. |
| E3-base | 접수 응답이 `E3_ARMED`로 끝난 뒤 같은 대화를 열어 둠. 접수 `09:21:13`, READY `09:21:22`, RELEASE `09:21:47`, terminal `09:22:29` | 90초 이상 추가 입력·재생성·카드 조작 없이 관찰했으나 자동 메시지는 없었다. digest `7c7e09c2353f`. 수동 Dashboard 새로고침은 결과를 보여 줬지만 GPT를 재개하지 않았다. |
| E4 | 접수 응답 종료 뒤 약 `09:26:37` 다른 대화로 이동. RELEASE `09:26:38`, terminal `09:27:26` | 60초 이상 다른 대화에 오배달이 없었다. 원래 대화를 수동으로 다시 열자 Dashboard만 복원됐다. digest `8593d35d9637`. |
| UI-1 | 응답 종료 + live card 후보의 첫 프로브 | connector가 캐시한 Dashboard v1이어서 probe code가 없었다. resource-cache 전제 실패이며 `ui/message` 판정에서 제외했다. |
| UI-2 | Dashboard v2, 표준 `ui/message`, terminal `09:59:17` | host가 메시지를 수락하고 사용자 입력 없이 같은 대화의 새 GPT turn을 시작했다. 그러나 생성 turn에는 원래 MCP scope metadata가 없어서 `codex_status`가 `INVALID_ARGUMENT`로 끝났다. host 수락·GPT 재개 성공과 결과 회수 실패를 분리했다. digest `a3c902fdabc6`. |
| UI-3 | Dashboard v3, 명시적 scope를 넣은 표준 `ui/message`. 접수 `10:10:49`, READY `10:11:00`, RELEASE `10:11:53`, terminal `10:12:06` | **종단 성공.** host accepted → 같은 대화의 GPT 자동 시작 → exact terminal 조회 → 최종 `EUI_SUCCESS`. digest `283001ba718e`. 자동 판정 구간에 브라우저 입력·재생성·계속 버튼 조작은 없었다. |
| FRESH-1 | connector 새로 고침 뒤 만든 별도 ChatGPT conversation·별도 Bridge scope. Dashboard v3. 접수 `10:22:18`, terminal `10:23:17` | v3 iframe은 실행됐지만 job-scoped probe metadata/state가 widget에 생기지 않아 `ui/message`가 전송되지 않았다. digest `5605e7c7ebf7`. |
| FRESH-2 | 다시 만든 두 번째 별도 conversation·scope. `codex_task.nextActions`의 exact `scope=conversation + jobId` 렌더를 명시. 접수 `10:25:16`, terminal `10:26:15` | v3 iframe은 실행됐지만 같은 precondition이 다시 성립하지 않았다. digest `f48dbfb2826e`. 성공 반복으로 세지 않는다. |

UI-2와 UI-3 사이의 차이는 follow-up prompt에 exact `scopeId`를 포함했는지뿐이다. 현재 host는 `ui/message`가 만든 사용자 메시지를 같은 conversation에 넣고 모델을 자동 실행하지만, 원래 MCP tool-call scope metadata까지 새 turn에 붙여 주지는 않는다.

사용자 검토 뒤 connector를 다시 확인했다. plugin 세부 화면의 **새로 고침**을 실행했고 contract v6와 `dashboard/v3.html` descriptor를 확인한 다음 FRESH-1/2를 만들었다. 두 탭은 UI-3과 다른 conversation URL이었고 서로 다른 Bridge scope를 받았다. 따라서 이 부정 결과는 오래된 connector schema나 같은 대화 재사용으로 설명하지 않는다. 관측 가능한 실패 경계는 v3 resource 로드 이후 widget에 job-scoped delivery metadata가 없었다는 지점이며, host가 노출하지 않은 내부 이유를 추측해 성공으로 바꾸지 않는다.

Dashboard v2/v3와 probe metadata는 실험 빌드에만 넣었다. 각 버전은 plugin 세부 화면의 **새로 고침** 뒤 실제 descriptor가 바뀐 것을 확인한 후 사용했다. 실행 결과를 확보한 뒤 probe, localStorage 임시 dedupe, scope 주입과 v2/v3 URI를 모두 제거하고 Dashboard URI를 v1로 되돌렸다.

## E1–E7 판정

| 시험군 | 판정 | 근거와 제한 |
| --- | --- | --- |
| E1 | PASS | live-card 2회와 cardless 1회. 현재 응답의 exact-status wait가 미지 terminal result를 처리했다. |
| E2 | CALLBACK 없음 | Job이 terminal인 동안 G가 다른 출력을 계속 생성했지만 완료값이나 별도 완료 사건은 모델 문맥에 들어오지 않았다. 응답을 살려 두려면 G가 명시적으로 exact wait를 해야 한다. |
| E3 | 메커니즘 PASS / 경로 미선정 | 기존 시험 대화의 임시 live-card 시제품은 표준 `ui/message`와 explicit scope로 1회 종단 성공했다. 새 conversation 반복은 0/2였으므로 재현 가능한 제품 경로로는 실패다. |
| E4 | 자동 전달 FAIL, 격리 PASS | 다른 대화로 이동한 동안 원래 대화 재개도 오배달도 없었다. 재열기는 수동 회수다. |
| E5 | 경계 분리 PASS | E2에서는 terminal과 active 응답 종료가 가까웠지만 결과가 임의 삽입되지 않았다. UI 시제품에서는 응답 종료 뒤 새 turn 하나가 생겼다. 자동 fallback 경쟁은 없었다. 운영 exactly-once는 아직 구현하지 않았다. |
| E6 | 부분 PASS / active restart 미지원 | admission 전 유실은 같은 requestId 재시도로 Job 하나만 생성했고, terminal Job·결과는 bridge/helper 재시작 뒤에도 exact 조회됐다. 강제 재시작 중 memory-only App Server context는 보장되지 않으며, restart 자체가 GPT를 깨우지 않는다. |
| E7 | 격리 PASS | 다른 대화·복수 Job에서 exact scope/Job만 조회했다. E4의 다른 대화에 오배달이 없었고, 후속 E2 turn에 오래된 결과가 자동 삽입되지 않았다. UI-3도 지정한 단일 Job 결과만 읽었다. |

### 카드 수명 분류

- **카드 없음:** E1-C의 active wait는 성공했다. 응답 종료 뒤에는 메시지를 보낼 component도 server→host wake API도 없다.
- **실행 중 카드:** 최신 host에서는 응답이 끝난 뒤에도 Dashboard iframe이 실행 가능했다. UI-3는 성공했지만 FRESH-1/2에서는 같은 v3 iframe에 job-scoped 전달 metadata가 도달하지 않아 실행 가능 카드만으로 충분하지 않았다.
- **teardown 카드:** #108 당시 실제 host는 응답 종료 때 `ui/resource-teardown`을 보냈고 전송이 불가능했다. 이번 최신 host의 수명 변화가 영구 보장이라고 볼 수 없으므로, 명시적 teardown 뒤에는 timer·tool call·`ui/message`를 모두 종료한다. 마지막 그림이 남아도 실행 가능 카드로 세지 않는다.
- **다른 대화/탭:** E4처럼 component가 원래 화면에 없으면 live-card route를 사용 가능으로 표시하지 않는다.

## 실제 capability와 소스 대조

| 후보 | 현재 확인 결과 |
| --- | --- |
| `codex_status` exact wait/read | 서버에 구현돼 있고 E1에서 실제 ChatGPT 종단 성공. 현재 실행 중 응답에만 결과를 돌려준다. |
| UI `ui/message` | 공식 JSON-RPC bridge로 host acceptance와 GPT 자동 시작을 실측. 명시적 scope를 넣은 UI-3에서 결과 회수까지 성공했으나, 새 conversation 2회의 job-scoped mount 전제가 재현되지 않아 제품 경로는 미선정. |
| `window.openai.sendFollowUpMessage` | 시험 widget에서 노출되지 않았다. 공식 문서의 component→host convenience API 존재와 현재 host의 노출을 동일시하지 않았다. |
| server→host completion push/callback | 현재 server tools, companion endpoint, 설치 descriptor에 원래 ChatGPT conversation을 깨우는 실행 가능한 dispatcher가 없다. 과거 문자열·localization 잔재는 capability가 아니다. |
| App Server `turn/steer` | exact Codex thread/active turn에 입력을 전달한다. B의 RELEASE에 사용 가능하지만 ChatGPT G를 깨우지 않는다. |
| completion outbox / native notification | durable event와 local macOS 소비자는 존재한다. generic OS 알림과 local Dashboard를 위한 것이며 ChatGPT 결과 메시지 경로가 아니다. |
| Dashboard 수동 새로고침 | retained result를 사람이 확인할 수 있다. GPT 자동 처리·재개 성공이 아니다. |

공식 App Server 문서는 `thread.sessionId`, thread, active turn 및 `turn/steer` 경계를 구분한다. 공식 Apps UI 문서는 `ui/message`/`sendFollowUpMessage`를 component→host 메시지로 정의한다. 어느 문서에도 이 MCP server가 카드 없이 원래 ChatGPT conversation을 임의로 깨우는 server push API는 없다.

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [ChatGPT UI bridge](https://developers.openai.com/plugins/build/chatgpt-ui)

## 선정 설계

### 1. 현재 응답이 살아 있는 경우

기존 exact Job wait를 기본으로 유지한다. G가 `codex_task` admission 뒤 exact Job을 보관하고, bounded `codex_status` wait를 반복해 input/terminal을 처리한다. 카드를 결과 전달 조건으로 만들지 않는다. host가 응답을 종료하거나 사용자가 Stop하면 다음 경로의 capability를 다시 판단하며, active wait가 살아 있다고 추측하지 않는다.

### 2. 응답 종료 뒤 live same-conversation UI가 있는 경우 — 미선정 후보

`ui/message` route는 작동 메커니즘이 확인된 후보로만 남긴다. 새 conversation의 automatic presentation이 exact Job metadata까지 반복적으로 widget에 전달되는 종단 계약부터 해결해야 한다. 그 뒤의 운영 구현도 임시 probe보다 강한 다음 계약이 필요하다.

1. #124의 terminal record에서 stable completion `eventId`, exact scope, Job, result version을 만든다.
2. server가 한 widget instance에만 bounded delivery lease를 준다. 여러 복원 카드가 localStorage만으로 경쟁하게 두지 않는다.
3. widget은 terminal을 확인한 뒤 `ui/message`를 한 번 보내며, 메시지는 결과 본문 대신 exact scoped receipt를 전달한다.
4. 새 GPT turn은 receipt로 exact terminal result를 조회한다. UI-2 때문에 scope가 자동 승계된다고 가정하지 않는다.
5. host acceptance, GPT result read, 최종 소비 확인을 서로 다른 상태로 보존한다. acceptance가 불명확하면 즉시 다른 카드나 macOS 경로로 중복 발사하지 않는다.
6. `ui/resource-teardown`, pagehide, 연결 유실 때 lease를 release하거나 uncertain으로 남긴다. teardown 뒤 component를 되살리지 않는다.
7. 새 사용자 turn이 이미 진행 중이면 오래된 완료 메시지가 그 지시를 덮지 않도록 host/capability 상태를 다시 확인하고, 결과는 retained 상태로 남긴다.

명시적 `scopeId`를 대화에 직접 넣은 것은 최소 시제품의 증거다. 제품 구현에서는 공개 식별자 노출과 stale replay를 줄이기 위해 scope-bound opaque receipt를 우선한다. receipt 검증은 결과 읽기 권한을 새로 넓히지 않아야 한다.

### 3. cardless·teardown·navigation 상태

경로 미선정이다. pending event와 result를 보존하고, 사용자가 다시 G를 실행했을 때 exact 조회할 수 있게 한다. 숨은 iframe 유지, 자동 카드 재열기, 무한 polling, 다른 Codex/API 대화에 메시지를 보내는 우회는 채택하지 않는다. 향후 host가 원래 conversation을 대상으로 한 authenticated wake/callback과 acceptance identity를 제공할 때 E3/E4/E6/E7을 다시 실행한다.

## #124 접점

#124는 다음 데이터와 독립 실행을 소유한다.

- requestId idempotency와 Job admission
- Codex 실행 수명
- terminal result/event의 SQLite 보존
- exact scope·Job 조회와 재시작 후 회수

#125의 후속 제품 구현은 그 terminal record를 입력으로 읽는 **전달 계층**만 추가해야 한다. 전송 실패 때문에 Codex Job을 재실행하거나 결과를 복제하지 않는다. GPT 상태를 Job 실행 지속 조건으로 되돌리지 않으며, ChatGPT 메시지 acceptance를 Job completion으로 쓰지 않는다.

## macOS 알림 결정

기존 generic macOS 완료 알림은 유지한다. 이유는 사용자에게 로컬 안전장치와 수동 복구 진입점을 제공하기 때문이다. 다만 다음 경계는 바꾸지 않는다.

- macOS notification delivery를 GPT 메시지 delivery 또는 result consumption으로 기록하지 않는다.
- native outbox consumer는 prompt/result/scope를 받지 않고 local Dashboard만 연다.
- live-card 경로를 제품화할 때 native와 UI가 같은 completion을 경쟁 발송하지 않도록 channel별 상태와 공통 event identity를 설계한다.
- 별도의 bridge 장애·보안 알림은 이 연구의 완료 전달과 무관하므로 제거하지 않는다.

## 재현·검증

live controller 예시에서 실제 UUID는 로컬 대응표의 값을 사용한다.

```sh
npx tsx scripts/issue-125-live-control.ts observe <scope-id> <job-id> <run-marker>
npx tsx scripts/issue-125-live-control.ts release <scope-id> <job-id> <run-marker>
npx tsx scripts/issue-125-live-control.ts terminal <scope-id> <job-id> <run-marker>
```

UI 실험은 다음을 별도로 기록했다.

1. connector descriptor의 contract v6와 exact Dashboard resource URI를 plugin 세부 화면에서 확인한다.
2. 응답 종료 뒤 nested widget frame이 실제로 실행 가능한지 확인한다.
3. terminal 전까지 사용자 입력·재생성·계속 조작을 하지 않는다.
4. `ui/message` JSON-RPC response, 새 user message, GPT 실행, exact result read, final text를 각각 관찰한다.
5. raw Job/result를 공개 문서에 복사하지 않고 digest만 대조한다.

영구 변경에 대한 검증 항목은 다음과 같다.

- TypeScript build/typecheck.
- App Server stable cwd fixture 및 기존 command/file/input/permission exact-ID 회귀.
- Dashboard teardown 불가역성 생성 HTML 회귀.
- 전체 Vitest와 App Server compatibility.
- macOS Swift 203 tests(2 opt-in live tests skipped)와 signed app bundle.
- release manifest, localization, generated UI resource synchronization.

실험 중 강제한 앱/helper 재시작은 사용자의 명시적 요청 아래 실행했다. SQLite Job/result는 유지됐고, 실행 중이던 memory-only 시험 context는 보존 대상으로 간주하지 않았다.

## 최종 판정

- 연구·실험·최소 시제품·제품 경계 설계: **완료**.
- active-response 경로: **선정**.
- live same-conversation card 경로: **메커니즘 1회 성공, 새 대화 반복 0/2로 미선정**.
- ended-response cardless 범용 자동 재개: **미선정 / host capability 필요**.
- macOS 알림: **유지하되 GPT 완료 메시지의 대체로 사용하지 않음**.

#125는 이 판정으로 닫을 수 있다. 닫힘은 카드 없는 자동 재개 제품이 완성됐다는 뜻이 아니라, 그 목표가 현재 host 계약으로는 충족되지 않는다는 종단 증거와 다음 구현 계약을 확정했다는 뜻이다.
