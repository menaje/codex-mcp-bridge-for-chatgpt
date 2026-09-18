# #126 live-card 자동 완료 전달 검증 — 2026-09-18

관련 이슈: [#126](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/126), [선행 조사 #125](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/125), [독립 실행 #124](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/124)

선행 기록: [#125 R1 새 대화 Dashboard 전달·GPT 재개 검증](./2026-09-17-issue-125-r1-card-delivery.md)

## 결론

#126의 제품 경로와 완료조건을 검증했다.

- 새 `codex_task`는 사용자 설정과 관계없이 exact conversation·Job·`presentationRef` Dashboard render action을 반환한다.
- Settings 카드와 macOS 앱에서 Dashboard 생성 및 ChatGPT 완료 메시지 전달 토글을 제거했다. 두 화면은 이 동작이 기본 계약이며 live card가 현재 자동 전달의 전제라고 안내한다.
- terminal Job마다 stable opaque receipt와 서버 측 bounded lease를 만들고, 하나의 exact live Dashboard만 전송을 claim한다.
- 카드는 표준 `ui/message`의 host 수락·거절·불명확 상태를 구분한다. 수락이 불명확하면 자동 재전송하지 않는다.
- 자동 메시지로 재개된 GPT는 authenticated host scope에서 receipt를 사용해 exact retained result를 한 번 읽는다. receipt 자체와 explicit scope는 권한이 아니다.

동일 빌드로 앱·helper·runtime·Tunnel을 재시작하고 실제 ChatGPT connector를 Refresh했다. 서로 다른 새 대화 세 곳에서 사용자나 진단 버튼의 추가 입력 없이 **terminal event → 자동 `ui/message` → GPT 재개 → exact result → final message를 3/3 통과**했다. 이어서 실제 host에서 응답 경계, 수락 뒤 재연결, 새 사용자 turn, 복수 Job, foreign scope, stale ref, replay를 각각 실행했다.

cardless·teardown·navigation 뒤 원래 대화를 서버가 깨우는 경로는 구현하거나 지원한다고 표시하지 않는다. macOS generic 알림도 이 ChatGPT 경로의 대체 성공으로 계산하지 않는다.

## 기록 경계

- 아래 `LIVE-126-*`는 공개용 alias다. 원시 ChatGPT conversation, Bridge scope, Activity, Job, Codex thread UUID는 기록하지 않는다.
- opaque receipt 전체와 프로젝트 결과 본문은 보안·권한 증거가 아니므로 문서에 보존하지 않는다.
- 실제 검증은 등록된 읽기 전용 시험 프로젝트에서 수행했다. 정확하지 않은 프로젝트 이름 1건과 secret scan에 걸린 프로젝트 1건은 Job admission 이전에 끝났으므로 성공·실패 표본에서 제외했다.
- 수동 진단 버튼이나 임시 운영 probe는 사용하지 않았다. 영구 Dashboard generation 33의 자동 watcher만 사용했다.
- 브라우저 fixture는 실제 connector 결과를 대신하지 않는다. host rejection, timeout, teardown, mismatch, duplicate-card 같은 결정적 경계를 보강하는 회귀로만 기록한다.

## 배포·연결 계약 확인

실행 중 helper의 build ID가 새 bundle의 build ID와 일치하고, Bridge와 Tunnel이 연결됐으며 active Job과 pending admission이 0인 상태에서 connector를 Refresh했다.

Refresh 전후 ChatGPT 개발자 화면의 계약은 다음처럼 바뀌었다.

| 항목 | Refresh 전 | Refresh 후 |
| --- | --- | --- |
| Dashboard resource | `ui://codex-mcp-bridge/dashboard/v1.html` | `ui://codex-mcp-bridge/dashboard/v2.html` |
| Dashboard UI generation | 32 | 33 |
| Settings resource | `ui://codex-mcp-bridge/settings/v1.html` | `ui://codex-mcp-bridge/settings/v2.html` |
| Settings UI generation | 21 | 22 |
| task guidance | 선택 설정을 전제로 한 설명 | exact Dashboard 즉시 render와 always-on live-card 전달 계약 |

## 설정 화면 검증

### 실제 Settings 카드

`settings/v2` 카드를 실제 ChatGPT 대화에서 열어 다음을 확인했다.

- Dashboard 생성 체크박스 없음.
- ChatGPT 완료 메시지 전달 체크박스 없음.
- 저장 API가 수정할 수 있는 해당 필드 없음.
- 다음 의미의 안내가 표시됨: 모든 Job은 원래 대화에 exact Dashboard를 열고, live card가 있는 동안 terminal result가 대화를 자동 재개한다. 카드가 닫히거나 연결이 끊기면 Job과 결과는 유지되지만 자동 메시지는 보장하지 않는다.
- Codex 앱 스레드 보존, 모델, 접근, 언어, 보관, 동시 작업 설정은 독립적으로 유지됨.

### 실제 macOS 앱

새 bundle의 native Settings 창을 열어 같은 계약을 확인했다.

- Dashboard 생성과 ChatGPT 완료 메시지 전달 스위치 없음.
- General 화면의 Codex 앱 스레드 보존 안내에 현황 카드·완료 메시지가 항상 사용된다고 표시됨.
- 별도 macOS 운영·보안 알림 스위치는 유지되지만 ChatGPT 완료 전달 설정으로 표시되지 않음.

legacy `dashboardAutoOpen`, `completionFollowUp`, `activityCardVisibility`는 migration 입력에서만 허용하고 저장 결과, Settings UI, native 모델, mutation schema에서는 제거되는 회귀를 통과했다.

## 새 대화 자동 종단 3/3

세 대화는 모두 connector Refresh 뒤 새로 만들었고 최초 요청 한 번만 보냈다. Job 접수 뒤 사용자 메시지나 카드 진단 제어를 추가하지 않았다.

| alias | 읽기 전용 작업 | 실제 관측 | DB 종단 |
| --- | --- | --- | --- |
| `LIVE-126-A` | README 첫 제목 | exact Dashboard → 자동 completion 메시지 → exact 제목 final | `result-read`, attempt 1 |
| `LIVE-126-B` | 최상위 Markdown 파일명 | exact Dashboard → 자동 completion 메시지 → `README.md` final | `result-read`, attempt 1 |
| `LIVE-126-C` | 최상위 디렉터리 수와 이름 | exact Dashboard → 자동 completion 메시지 → 8개 exact result final | `result-read`, attempt 1 |

각 Job은 서로 다른 scope와 receipt를 가졌고 terminal origin은 `normal-completion`이었다. 세 delivery 모두 `host_accepted_at`과 `result_read_at`을 별도로 기록했으며, attempt가 1을 넘지 않았다.

## 실제 전송 경계

### 응답 진행 중과 자연 종료

- `LIVE-126-A`와 `LIVE-126-C`에서는 최초 Work 응답이 아직 `작업 중`인 화면에 automatic completion message가 도착했다. host는 메시지를 버리지 않았고 같은 응답 경계에서 exact status read와 final을 끝냈다.
- `LIVE-126-B`에서는 최초 응답이 “카드를 열고 기다린다”는 문장으로 자연 종료된 뒤 completion message가 새 turn을 만들었다.
- 두 경우 모두 Promise 반환이나 메시지 표시만으로 성공을 판정하지 않고 DB `result-read`와 사용자 final을 함께 확인했다.

### host 수락 뒤 연결 유실·재연결

지연 Job의 delivery state가 실제 DB에서 `host-accepted`가 된 직후 Safari 페이지를 reload해 live connection을 끊었다. 같은 conversation URL로 재연결한 뒤 exact final이 복구됐다.

- `host-accepted` 전에 결과 읽기를 성공으로 계산하지 않았다.
- 재연결 뒤 상태는 `result-read`였다.
- attempt는 1이었고 중복 메시지나 두 번째 Job은 없었다.

### 새 사용자 turn

30초 지연 Job의 exact Dashboard가 live인 동안 같은 대화에 별도 사용자 turn을 보냈다. 그 turn은 도구 없이 `USER-TURN-ACK`로 자연 종료됐다. 이후 automatic completion message가 도착해 원래 Job의 exact result를 읽었다.

- 새 사용자 turn이 새 Job을 만들지 않았다.
- 원래 completion은 다른 scope나 turn으로 오배달되지 않았다.
- delivery는 attempt 1, `result-read`로 끝났다.

### 복수 Job

한 새 대화에서 독립 Job A와 B를 시작하고 각 exact Dashboard를 렌더링했다. 두 카드가 동시에 live인 상태에서 서로 다른 completion message가 순서대로 도착했다.

| Job | 결과 | 전달 상태 |
| --- | --- | --- |
| A | README 첫 제목 | attempt 1, `result-read` |
| B | 최상위 Markdown 파일명 | attempt 1, `result-read` |

A 결과 처리 중 B receipt가 섞이지 않았고, A final 뒤 B가 별도 exact read를 수행했다. 두 Job은 같은 scope를 공유했지만 delivery receipt와 Job identity는 분리됐다.

### foreign scope

다른 새 대화에서 이전 대화의 consumed receipt를 `codex_status({query:{kind:"completion", ...}})`에 넣었다. explicit scope는 전달하지 않았다. 실제 connector 결과는 `HANDLE_UNAVAILABLE`였고 origin result는 노출되지 않았다.

### stale·mismatched presentation과 복구

새 Job의 `presentationRef` 마지막 문자를 바꾼 값으로 실제 `codex_dashboard`를 호출했다.

- 결과: `DASHBOARD_AUTOMATIC_PRESENTATION_UNAVAILABLE`.
- Job 완료 뒤 delivery는 `pending`, attempt 0이었다. 오류 카드가 보였다는 사실을 전송 성공으로 계산하지 않았다.
- 같은 Job의 exact deterministic ref로 올바른 Dashboard를 연 뒤에만 automatic message가 전송됐다.
- 복구 뒤 delivery는 attempt 1, `result-read`였으며 새 Job은 생기지 않았다.

### replay

위 Job이 `result-read`가 된 뒤 같은 ChatGPT conversation을 reload해 완료된 카드를 다시 마운트했다.

- 새 completion message 없음.
- attempt 1 유지.
- `host_accepted_at`, `result_read_at`, delivery `updated_at` 변화 없음.

즉 완료된 카드는 settled 상태를 관측할 뿐 delivery를 다시 claim하지 않았다.

## 서버 상태 모델

schema 21의 `job_completion_deliveries`는 terminal Job당 한 행을 보존한다.

| 상태 | 의미 |
| --- | --- |
| `pending` | terminal event는 있으나 live card가 아직 claim하지 않음 |
| `leased` | exact mounted card 하나가 bounded send lease를 소유 |
| `host-rejected` | host가 명시적으로 거절; bounded backoff 뒤에만 재시도 가능 |
| `host-accepted` | 표준 `ui/message` host 수락 확인 |
| `acceptance-unknown` | send 경계를 넘었지만 결과가 불명확; 자동 replay 금지 |
| `result-read` | authenticated same-conversation GPT가 exact retained result를 읽음 |

lease 만료는 `acceptance-unknown`으로 이동하며 pending으로 되돌리지 않는다. host rejection만 최대 3회 범위에서 재시도한다. 복수 카드가 동시에 있어도 서버의 conditional update가 한 카드만 claim하게 한다.

## 결정적 브라우저 회귀

[`scripts/issue-126-live-card-completion-regression.ts`](../../scripts/issue-126-live-card-completion-regression.ts)는 production Dashboard HTML을 실제 브라우저에서 실행해 다음 6개 경계를 검사한다.

| scenario | 결과 |
| --- | --- |
| host accept | PASS |
| explicit reject 뒤 bounded retry·accept | PASS |
| `ui/message` timeout → uncertain, no retry | PASS |
| teardown before terminal → no send | PASS |
| mismatched presentation ref → no claim/send | PASS |
| duplicate live cards → one send/ack | PASS |

#125의 tool input/result 순서 회귀도 6/6 재통과했다.

## 전체 검증

| 검사 | 결과 |
| --- | --- |
| `npm run check` | 85 files / 757 tests PASS |
| `npm run macos:check` | 202 tests PASS, opt-in live tests 2개 의도적 skip |
| `npm run app-server:compat:check` | CLI 0.153.3 기준 416 JSON / 827 TypeScript schema 일치 |
| `npm run test:issue-126-live-card` | 6/6 PASS |
| `npm run test:issue-125-r1-card` | 6/6 PASS |
| `npm run macos:bundle` | production app bundle 생성·서명 PASS |
| 실제 connector Refresh | Dashboard v2/gen 33, Settings v2/gen 22 확인 |
| 실제 새 대화 자동 종단 | 3/3 PASS |
| 실제 boundary·권한·replay | PASS |

## 지원 경계

- live originating Dashboard가 없거나 teardown된 뒤에는 자동 ChatGPT follow-up을 보장하지 않는다.
- pending terminal result는 수동 Dashboard 재열기나 exact status 조회를 위해 보존된다.
- 카드 없는 server→conversation wake, 숨은 카드 유지, 무한 polling, GPT 상태 추정 서비스는 추가하지 않았다.
- macOS 알림은 별도 보조 채널이며 ChatGPT delivery state를 소비하지 않는다.
- receipt와 presentation ref는 correlation 값이다. 현재 authenticated conversation과 exact retained Job 검증을 대체하지 않는다.
