# #125 R1 새 대화 Dashboard 전달·GPT 재개 검증 — 2026-09-17

관련 이슈: [#125](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/125), [후속 제품화 #126](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/126), [#124](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/124)

선행 기록: [1차 완료 전달·재개 실험](./2026-09-17-issue-125-completion-resume-experiment.md)

## 결론

R1 연구와 원인 수정은 완료했다. 1차 FRESH-1/2의 최초 실패 지점은 **새 카드에 Job별 입력·결과가 없는 것이 아니라, 카드가 초기 `window.openai` 값을 한 번 읽은 뒤 늦게 도착한 표준 입력·결과 알림을 받지 않은 것**으로 좁혀졌다. Dashboard를 다음과 같이 고쳤다.

- host가 제공하는 초기 호환 값을 계속 지원한다.
- handshake 전에 `ui/notifications/tool-input`과 `ui/notifications/tool-result` 수신기를 등록한다.
- 늦은 `openai:set_globals`의 `toolInput`, `toolOutput`, `toolResponseMetadata`도 적용한다.
- 서버가 exact scope·Job에서 만든 비권한성 `presentationRef`로 tool input과 private result metadata를 상관시킨다.
- `presentationRef`가 맞더라도 현재 host scope와 exact Job 소유권 검증을 통과해야 Dashboard가 열린다.

실제 connector를 새로 고친 뒤 새 ChatGPT 대화에서 카드 연결과 표준 결과 수신을 확인했다. 그 다음 임시 진단 버튼으로 `ui/message`의 각 단계를 검사했고, 서로 다른 새 대화 세 곳에서 **수동 진단 트리거 3/3**이 exact 결과까지 성공했다. 응답 진행 중에 보낸 추가 사례도 host가 수락하고, 원래 응답의 자연 종료 뒤 메시지를 순서대로 처리해 exact 결과까지 반환했다.

이 결과는 **live-card transport가 현재 host에서 작동한다**는 증거다. 그러나 영구 코드에는 terminal event를 claim하는 UI delivery lease와 자동 전송 trigger가 없다. 따라서 새 대화 세 곳의 결과를 “자동 제품 경로 3/3”으로 바꾸지 않는다. 자동 완료 전달의 첫 미구현 단계는 **durable completion event → single live card lease → automatic send**다. 이 제품화는 [#126](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/126)에서 추적한다.

최종 선정은 다음과 같다.

| 경로 | R1 판정 | 제품 지원 판정 |
| --- | --- | --- |
| 현재 GPT 응답의 exact Job wait/read | 기존 선정 유지 | 지원 |
| same-conversation live card의 표준 `ui/message` transport | 새 대화에서 반복 검증 | **조건부 구현 후보**; 자동 lease/trigger 미구현 |
| cardless·teardown·navigation 뒤 원래 대화 wake | 검증된 server→host capability 없음 | 미선정 |
| macOS 알림·수동 Dashboard 조회 | 별도 사용자 복구 경로 | GPT 완료 메시지의 대체가 아님 |

## 기록 경계

- 1차 감사 문서, #125의 기존 종료 댓글, R1 재개 댓글과 안정화 커밋 `135dd247e42d16c18315dfb7d7f640e5ce1b3f8a`를 수정하지 않았다.
- 아래 `LIVE-*`는 공개용 alias다. ChatGPT conversation, Bridge scope, Activity, Job, Codex thread의 원시 UUID와 결과 원문은 이 문서에 기록하지 않는다.
- 임시 generation 33 probe와 브라우저 자동화는 진단 자료다. 영구 Dashboard는 generation 32이며 `ui/message` 발신 코드가 없다.
- 합성 host-order fixture 성공은 실제 Codex 실행 성공으로 세지 않았다. 실제 host의 수동 진단 성공도 자동 제품 성공으로 세지 않았다.
- 외부 OpenAI 저장소·커뮤니티 사례는 사용자 보고다. 이번 브리지와 같은 원인 또는 OpenAI가 확정한 결함으로 표시하지 않는다.

## R1-0 — 1차 자료 보존과 재구성 경계

### 확보한 자료

- 1차 기준 커밋: `135dd247e42d16c18315dfb7d7f640e5ce1b3f8a`.
- 제거 전 Dashboard 계열로 확인한 unreachable Git blob: `3694906fdd97f086722b4fd56bdd43b4338341db`.
- 그 blob의 SHA-256: `26f93b890381d82a0f9eb9452511b9fa6f4e99bf193914a198a9ea2c387e8880`.
- blob은 generation 31이며 과거 `presentationToken`, completion claim, `ui/message` 계열 코드를 포함한다.

### 한계

해당 blob이 1차 UI-3의 exact explicit-scope 시제품과 byte-for-byte 동일하다는 증거는 없다. 따라서 원본 UI-3 패치로 표시하지 않았다. 오래된 completion claim과 token 코드를 복원해 해결책으로 채택하지도 않았다.

이번 R1 자료는 다음처럼 명시적으로 **재구성본**으로 관리한다.

- [`scripts/issue-125-r1-card-delivery-regression.ts`](../../scripts/issue-125-r1-card-delivery-regression.ts): 공식 입력·결과 알림, 초기 호환 값, 늦은 globals, 순서 역전과 mismatch 회복을 재현하는 실행형 fixture.
- [`2026-09-17-issue-125-r1-message-probe.patch`](./fixtures/2026-09-17-issue-125-r1-message-probe.patch): 실제 host에서만 사용한 generation 33 `ui/message` 진단 control의 exact source patch. 최종 운영 코드에는 적용하지 않는다.

`git apply --check`로 진단 patch가 최종 generation 32 소스에 적용 가능한 것을 확인했다. 이 보존은 재현 자료를 남기기 위한 것이며, 과거 UI-3와 동일하다는 주장이 아니다.

## R1-1 — 새 카드의 exact Job 연결

### 영구 계약

`codex_task`의 Dashboard render action은 다음 세 값을 한 묶음으로 반환한다.

1. `scope="conversation"`
2. exact `jobId`
3. SHA-256 형식의 `presentationRef`

서버는 `jobId`와 `presentationRef`가 항상 함께 오도록 schema에서 검증한다. `presentationRef`는 scope와 Job을 입력으로 만든 deterministic correlation digest다. 이것만으로 읽기 권한을 주지 않으며, Dashboard handler는 먼저 host metadata로 현재 scope를 해석하고 그 scope가 exact Job을 소유하는지 확인한 뒤 digest를 비교한다.

결과 metadata의 `codex/dashboardOpen@1`에는 correlation ref만 넣는다. 원시 Job·scope와 과거 `presentationToken`은 넣지 않는다. 카드 DOM 진단값에도 원시 Job과 ref를 쓰지 않고 `received`, `ready`, `mismatch` 같은 상태와 source 이름만 기록한다.

카드는 handshake 전부터 다음 수신 경로를 설치한다.

- 초기 호환: `window.openai.toolInput`, `toolOutput`, `toolResponseMetadata`.
- 표준: `ui/notifications/tool-input`, `ui/notifications/tool-result`.
- 늦은 호환 갱신: `openai:set_globals`의 `toolInput`, `toolOutput`, `toolResponseMetadata`.

입력 ref와 result metadata ref가 일치해야 `dashboardPresentation=ready`가 된다. 빈 초기 globals가 나중의 유효한 ready 상태를 지우지 않는다.

### 재구성 host-order 회귀

동일한 generation 32 카드에 대해 여섯 순서를 실행했다.

| scenario | 검사한 경계 | 결과 |
| --- | --- | --- |
| `standard-before-init` | initialize 응답 전에 표준 input/result 도착 | PASS |
| `result-before-input` | result 선도착 뒤 늦은 input | PASS |
| `mismatch-then-recover` | 다른 ref result 뒤 정확한 result | PASS |
| `late-compatibility` | 초기 null 뒤 globals event | PASS |
| `initial-compatibility` | 카드 생성 시 이미 준비된 호환 값 | PASS |
| `empty-after-ready` | ready 뒤 빈 globals event | PASS |

각 사례에서 input/result/output가 모두 `received`, 최종 presentation이 `ready`, script error가 0임을 확인했다. dataset 문자열에 raw Job ID나 correlation ref가 없는 것도 검사했다.

### 실제 새 대화

`LIVE-B`는 실제 connector refresh 뒤 생성한 새 ChatGPT 대화다. exact render action으로 연 카드에서 다음을 확인했다.

- presentation: `ready`
- input: `received`, source `initial-compatibility`
- output: `received`, source `standard`
- result: `received`, source `initial-compatibility`
- MCP Apps handshake: `initialized`

카드 진단 문자열에는 원시 UUID나 64자리 ref가 없었다. `코니` 프로젝트로 시작한 한 시도는 secret scan이 admission 전에 거절해 Job 자체가 없었으므로 R1-1 표본에서 제외했다.

**최초 차이 판정:** FRESH-1/2의 one-shot globals 의존을 제거하자 새 대화의 standard output과 늦은/초기 input·result를 함께 상관시킬 수 있었다. 서버가 Job을 만들지 않았거나 host가 카드 자체를 열지 않은 문제가 아니었다.

## R1-2 — 전송부터 최종 결과까지 단계별 검증

영구 코드에 자동 sender를 넣기 전에 generation 33 진단 patch를 잠시 적용했다. 카드가 `ready`가 된 뒤에만 exact Job을 closure에 보관하고, 사용자가 아닌 시험 제어가 버튼을 한 번 작동시켜 표준 `ui/message`를 보냈다. 결과 본문이나 explicit scope를 메시지에 넣지 않았고, 재개된 GPT가 현재 host metadata로 exact Job을 조회하게 했다.

### `LIVE-C` 종단 단계

| 단계 | 관측 |
| --- | --- |
| Job admission | 실제 비동기 Job 하나, prompt가 알 수 없는 결과 표식 생성 |
| 원래 응답 | `R1_2_ARMED`로 자연 종료 |
| 카드 준비 | input/result/output 상관 완료, probe enabled |
| 전송 시도 | 실제 표준 `ui/message` 요청 |
| host 응답 | `host-accepted`, response type `object` |
| 메시지 표시 | 사용자가 입력하지 않은 probe user message 표시 |
| GPT 실행 | 같은 ChatGPT 대화에서 자동 재개 |
| 도구 호출 | exact Job에 `codex_status` 1회, explicit scope 없음 |
| 결과 회수 | 최초 prompt에 없던 exact 결과와 일치 |
| 최종 메시지 | 지정한 `R1_2_RESULT` 형식으로 완료 |

1차 UI-2와 달리 이번 재개 turn에서는 실제 host metadata로 원래 scope가 해석됐다. explicit scope를 prompt에 넣어 권한을 복원한 성공으로 세지 않았다.

### 새 대화 반복

| alias | 조건 | 결과 |
| --- | --- | --- |
| `LIVE-C` | 단일 Job, 원래 응답 자연 종료 뒤 수동 진단 trigger | exact result PASS |
| `LIVE-MULTI` | 같은 Activity의 서로 다른 Job 2개, 카드가 Job A를 가리킴 | Job A exact result PASS, Job B 혼입 없음 |
| `LIVE-REPEAT` | 별도 새 대화·별도 단일 Job | exact result PASS |

따라서 같은 빌드와 실제 connector refresh 뒤 **서로 다른 새 대화의 수동 진단 transport는 3/3**이다. 세 사례 모두 host acceptance, user message, GPT 실행, tool call, result read, final text를 확인했다. 버튼을 누른 사실 때문에 전체 자동 경로 3/3으로 계산하지 않는다.

두 차례의 별도 boundary 준비 시도는 exact project selector를 확보하지 못해 `PROJECT_REQUIRED` 단계에서 끝났다. Job admission과 `ui/message`가 모두 없으므로 전송 실패나 성공 표본에서 제외했다.

## R1-3 — 재개 후 범위·권한·replay

### 실제 host 범위

`LIVE-X-SCOPE`에서는 origin 대화의 Job ID와 scope ID를 모두 알고 있는 상태로 별도의 새 ChatGPT 대화에서 조회를 시도했다. 새 대화가 제공한 authoritative host metadata가 explicit compatibility scope보다 우선했고, 결과는 `INVALID_ARGUMENT`로 거절됐다. origin result는 노출되지 않았다.

즉 식별자를 아는 사실은 권한이 아니다. 동일 사용자의 다른 대화라는 이유도 scope 우회를 허용하지 않는다.

### 서버 회귀

- 같은 현재 conversation metadata와 같은 exact Job/ref의 Dashboard render를 반복하면 동일하게 성공한다. 읽기 render의 의도된 idempotency다.
- 유효한 ref를 다른 Job ID와 조합하면 거절한다.
- origin scope를 explicit fallback으로 넣어도 foreign `openai/session` metadata가 있으면 foreign scope로 해석되어 거절한다.
- 잘못된 ref는 거절한다.
- 성공 result metadata에는 원시 `jobId`, `scopeId`, `presentationToken`이 없다.

`presentationRef`에는 별도 expiry를 부여하지 않았다. 이 값은 credential이 아니며, current host scope와 exact retained Job 검사가 항상 선행하기 때문이다. 같은 conversation과 exact Job에서의 재사용은 idempotent read로 허용하고, 다른 Job·scope replay는 거절한다.

## R1-4 — 새 대화 반복과 E5–E7

### 자동 경로의 첫 blocked 단계

R1-1~3은 “정확한 카드가 준비된 뒤 host transport가 동작하는가”를 해결했다. 그러나 영구 generation 32 카드에는 다음 구성요소가 없다.

1. #124 terminal record에서 UI delivery event를 발행·claim하는 durable identity.
2. 여러 live card 중 하나만 선택하는 bounded server lease.
3. terminal event를 받아 자동으로 `ui/message`를 한 번 보내는 trigger.
4. acceptance-unknown, reconnect, consumption을 보존하는 delivery state machine.

따라서 자동 경로는 전송 전 제품화 단계에서 blocked다. 임의 sleep, 무한 polling, 숨은 카드 유지, macOS 알림 전환으로 이를 통과했다고 표시하지 않는다. 구현·종단 기준은 #126으로 넘겼다.

### E5 — 응답 진행 경계

실제 새 대화 `LIVE-BOUNDARY`에서 원래 GPT가 800개 marker를 스트리밍하는 중, `답변 중지`가 보이는 순간 probe를 실행했다.

- 호출 시점: 원래 GPT 응답 진행 중.
- JSON-RPC: `host-accepted`, response type `object`.
- 즉시 상태: probe user message는 아직 보이지 않고 원래 응답이 계속 진행.
- 원래 응답: 001~800 marker를 모두 생성해 자연 종료.
- 그 뒤: probe user message 표시 → GPT 자동 재개 → exact Job 조회 → 알 수 없던 결과와 일치하는 final.

현재 host의 표준 `ui/message`는 이 사례에서 진행 중 요청을 조용히 버리지 않고 자연 종료 뒤 순서대로 처리했다. 이는 외부 #126의 구형 `sendFollowUpMessage` 보고를 현재 표준 경로의 확정 결함으로 일반화하지 않아야 한다는 근거다. 한 번의 host behavior를 장기 호환성 보장으로 확대하지 않는다.

### E6 — 연결 유실·재시작

판정: **부분 검증 / post-send loss 미실행**.

- active Job 0개를 확인한 뒤 앱·helper·runtime을 재빌드·재시작했다.
- retained terminal Job은 재시작 뒤 exact 조회됐고, connector refresh 뒤 새 live flow도 성공했다.
- 그러나 실제 `ui/message` 전송 직후 연결 유실, host acceptance 뒤 확인 유실, lease 재claim과 duplicate suppression은 실행하지 않았다.

영구 automatic sender와 lease가 없으므로 후자의 시험을 PASS로 만들 수 없다. #126에서 delivery state machine을 구현한 뒤 실행한다.

### E7 — 격리·복수 Job·새 사용자 turn

판정: **부분 검증**.

- actual delivery가 있는 `LIVE-MULTI`에서 같은 Activity의 두 Job 중 카드가 지정한 Job A만 조회했고 Job B가 섞이지 않았다.
- actual tool delivery가 있는 foreign conversation에서 origin Job/scope 지식만으로 결과를 읽지 못했다.
- 각 수동 사례는 하나의 follow-up message와 하나의 final을 만들었다.
- 자동 sender가 없는 상태에서 새 사용자 turn과 terminal event가 동시에 경쟁하는 시험은 실행하지 않았다.

따라서 “전송 0회에서 오배달 0회”를 PASS로 재사용하지 않았다. 실행한 두 격리 경계만 PASS이고, user-turn collision과 자동 duplicate 경쟁은 #126의 완료조건이다.

## R1-5 — 카드 없는 후보와 capability 경계

| 후보 | 공식/실제 계약 | R1 결과 | 판정 |
| --- | --- | --- | --- |
| standard tool input/result notifications | 공식 MCP Apps component 수신 경로 | fixture 6/6, 실제 새 대화 ready | 채택 |
| component → host `ui/message` | 공식 UI bridge의 host message 요청 | 새 대화 수동 3/3 + active-response boundary 성공 | live-card 제품 후보 |
| 일회성 `window.openai` globals | 호환 경로이며 값이 늦을 수 있음 | one-shot 의존이 FRESH 실패 원인 | 단독 authority로 사용하지 않음 |
| server → 원래 ChatGPT conversation wake/callback | 이번 조사에서 호출 가능한 공식 계약을 확인하지 못함 | cardless 종단 경로 없음 | 미선정 |
| Codex App Server `turn/steer` | Codex thread의 active turn 대상 | ChatGPT conversation wake가 아님 | 대체 불가 |
| ChatGPT Tasks/예약 실행 | 사용자 예약 실행 계약 | exact terminal event가 원래 conversation을 재개한다는 계약·실측 없음 | 대체 불가 |
| macOS notification/native outbox | 로컬 사용자 알림 | GPT turn을 만들지 않음 | 유지하되 대체 성공 아님 |
| 수동 Dashboard 재열기·새로고침 | retained result 조회 | GPT 자동 재개 아님 | 복구 경로만 |

공식 점검 기준:

- [OpenAI UI 공식 지침](https://developers.openai.com/plugins/build/chatgpt-ui)
- [OpenAI tool results와 `_meta` 참조](https://developers.openai.com/plugins/reference#tool-results)
- [OpenAI 인증 경계](https://developers.openai.com/plugins/build/auth)
- [MCP Apps `App` SDK](https://apps.extensions.modelcontextprotocol.io/api/classes/app.App.html)

외부 비교 보고:

- [OpenAI examples #179](https://github.com/openai/openai-apps-sdk-examples/issues/179): 서버 data와 card globals 누락을 분리한 사용자 보고.
- [OpenAI Developer Community toolOutput null](https://community.openai.com/t/widget-receives-tooloutput-null-despite-tool-returning-valid-structuredcontent-model-sees-data-widget-doesnt/1371668): actual data readiness를 기다렸다는 개인 사례.
- [OpenAI examples #126](https://github.com/openai/openai-apps-sdk-examples/issues/126): 응답 진행 중 구형 follow-up API 사용자 보고.
- [OpenAI examples #227](https://github.com/openai/openai-apps-sdk-examples/issues/227): host response·message 표시와 후속 tool flow를 분리해야 하는 사용자 보고.

이 자료는 검사 방향을 보강했지만 원인을 대신 확정하지 않았다. R1의 원인 판정은 이 저장소의 회귀와 실제 host 관측에서 도출했다.

## 영구 변경

- `src/nextActions.ts`: Dashboard action의 `jobId`와 `presentationRef` pair 계약.
- `src/tools.ts`: exact scope·Job 소유권과 deterministic ref 검증, private opener metadata 최소화.
- `src/dashboardCard.ts`: generation 32, 표준 input/result 알림과 늦은 compatibility globals 처리, source/ready 진단.
- `scripts/issue-125-r1-card-delivery-regression.ts`: 여섯 host-order 재구성 회귀.
- tool guidance, tool contract, generated HTML/manifest 회귀.

영구 코드에는 다음이 없다.

- `ui/message` sender 또는 `R1-2 probe`.
- completion claim/lease.
- 과거 `presentationToken`.
- raw Job/scope/ref DOM 노출.
- 무한 polling, 숨은 card 유지, teardown 뒤 재활성화.

## 검증

| 검사 | 결과 |
| --- | --- |
| R1 대상 Vitest | 3 files / 41 tests PASS |
| 재구성 browser host-order | 6/6 PASS |
| 전체 Vitest | 85 files / 755 tests PASS |
| App Server schema compatibility | CLI 0.153.3 기준 416 JSON / 827 TypeScript schema 일치 |
| release manifest/generated UI sync | PASS |
| TypeScript build | PASS |
| macOS Swift tests·signed bundle | 203 tests PASS, opt-in live 2 skipped; production app 서명 PASS |
| actual connector | generation 33 refresh·live 진단 뒤 최종 generation 32로 다시 refresh; 새 schema 설명의 `scope, jobId, and presentationRef`까지 화면 확인 |

## R1 완료조건 매핑

| 완료조건 | 판정 |
| --- | --- |
| UI-3/FRESH 자료 연결과 원본/재구성 구분 | 완료. blob은 증거, 새 fixture/probe는 재구성으로 표시 |
| 서버→host→card 최초 누락 지점 | 완료. one-shot globals 이후 늦은 표준/호환 값 미수신 |
| handler 선등록·표준 알림·data readiness | 완료. 여섯 순서와 실제 새 대화 검증 |
| 카드 연결과 전송/GPT/result 단계 분리 | 완료. `LIVE-C` 단계표 |
| 범위·인증·대상·replay | 완료. actual cross-scope deny와 서버 회귀 |
| 새 대화 최소 3개 전체 자동 또는 정확한 blocked 단계 | 완료. 수동 3/3은 별도; 자동은 durable lease/trigger 부재에서 blocked |
| E5/E6/E7 실제 전달 조건 재분류 | 완료. E5 PASS, E6 부분, E7 부분 |
| cardless 후보와 capability 경계 | 완료. 검증된 wake API 없음, 미선정 |
| 기존 판정 보존과 보완 감사 | 완료. 선행 문서는 유지하고 이 addendum 추가 |
| 지원 범위와 남은 목표 추적 | 완료. 지원표와 #126 |

## 최종 판정

- FRESH 카드 연결 결함: **원인 확인·수정·회귀 완료**.
- 표준 live-card host transport: **새 대화 반복 검증 완료**.
- 재개 turn의 exact 결과 권한: **same-conversation 성공, foreign conversation 거부 확인**.
- live-card 자동 완료 전달 제품: **미구현**. durable event lease/automatic trigger가 첫 단계이며 #126으로 추적.
- cardless/teardown/navigation wake: **미선정**.
- #124 독립 실행과 macOS 안전장치: **유지**.

#125는 연구 이슈로서 닫을 수 있다. 이 종료는 자동 재개 제품이 완성됐다는 뜻이 아니다. 새 대화에서 실패하던 카드 수신 원인을 수정하고, host transport와 권한 경계를 실제로 검증했으며, 남은 제품 구현을 별도 이슈의 실행 가능한 완료조건으로 고정했다는 뜻이다.
