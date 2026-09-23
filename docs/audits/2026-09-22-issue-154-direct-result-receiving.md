# #154 직접 결과 수신 실험 검증 — 2026-09-22

관련 이슈: [#154](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/154),
[#126](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/126),
[#137](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/137),
[#143](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/143)

## 결론

기본 completion 경로는 기존 `live-card`로 유지하고, 두 Settings 표면의
off-by-default 실험 스위치를 켠 뒤 새로 접수한 Job만 `direct-wait`를
admission-time 정책으로 고정한다. `codex_task` 자체는 계속 durable async이고,
현재 GPT 실행이 exact Job의 bounded terminal wait를 반복해 결과를 검토한 뒤
사용자가 이미 승인한 작업만 이어간다. timeout이나 host abort는 읽기만 끝내며
Job을 취소하거나 대체 Job을 만들지 않는다.

각 비종단 반환 뒤에는 exact Job의 input action을 확인한다. approval 또는
user-input 경계에서는 자동 진행을 중단한다. terminal 결과를 받은 뒤에도 새
권한이나 새 사용자 결정이 필요한 작업은 시작하지 않는다.

실제 ChatGPT web host에서 다음 핵심 성공 조건을 확인했다.

> 사용자가 원 대화에 다시 들어오거나 새 메시지를 보내지 않아도 GPT가 Job 1
> 결과를 직접 받고 검토한 뒤, 사전 승인된 Job 2를 시작하고 그 결과까지 받는다.

동일 대화, 대화 전환, 숨긴 브라우저, 테스트 탭 연결 유실·복구, terminal 결과
중복 조회를 통과했다. 최초 2026-09-22 시험에서는 사용자 인증이 필요한 실제
macOS 화면 잠금을 실행하지 않았다. **2026-09-23 추가 시험에서는 사용자와
함께 화면 잠금 및 짧은 Clamshell Sleep을 구분해 통과했고, 별도 데스크톱
Work task에서는 Finder가 최전면일 때의 연속 실행 및 Tunnel 저하·복구를
관측했다.** 결과와 한계는 문서 끝의 시간순 원증거를 따른다. GPT 실행 자체의
종료나 Mac 전체 네트워크 단절까지 보장하지 않는다.

**2026-09-23 후속 검토:** 아래 기존 host 시험 요청문은 exact wait와 카드 금지를
명시했다. 그 시험만으로는 설정을 켠 평소 요청의 동작이나 Job 2의 원 대화
복귀 전 접수 시각을 독립적으로 입증할 수 없었다. 문서 끝의 별도 일반 요청
재시험에서 두 조건을 확인했다. native 앱 background/화면 잠금은 여전히 이
일반 요청 재시험 범위 밖이었으며, 화면 잠금은 아래 별도 시험에서 확인했다.

## 제품 계약

- Settings schema는 7이다. 이전 schema 6은 실험값 `false`로 이관된다.
- ChatGPT Settings card generation은 24, Dashboard generation은 35다.
- local companion protocol은 12, remote companion protocol은 10이다.
- task output contract는 4이며 nullable `completionDeliveryPolicy`를 포함한다.
- `live-card | direct-wait`는 Job payload에 한 번 저장되고 이후 Settings 변경으로
  바뀌지 않는다. legacy Job은 `live-card`로 읽는다.
- direct Job의 active projection은 exact `codex_status` terminal wait
  (`waitMs=60000`)와 exact input wait를 제공하고 Dashboard render action을
  제공하지 않는다.
- direct Job은 `job_completion_deliveries` 감사 행을 보존하지만 live-card lease를
  claim할 수 없다. `codex_ui_completion`도 즉시 `settled`를 반환한다.
- Dashboard production HTML은 `completionDeliveryRoute=direct-wait`에서 watcher를
  시작하지 않는다. 서버 lease 조건이 두 번째 방어선이다.
- exact terminal result offer는 GPT 수신 증명이 아니다. 실제 GPT final과 다음
  Job admission을 host 수신·검토 증거로 사용한다.

## 실제 ChatGPT 검증 환경

검증은 운영 `stable` DB와 분리한 `development` state profile에서 수행했다.
설치본 helper를 idle 상태에서 정상 drain 정지한 뒤 checkout build를 같은 Secure
MCP Tunnel에 연결하고 ChatGPT developer-mode connection을 Refresh했다. 실제
Settings card에서 시험 프로젝트와 실험 스위치를 저장한 뒤 새 대화를 사용했다.

원시 conversation, scope, Activity, Agent, Job UUID와 프로젝트 경로는 이 문서에
기록하지 않는다. 아래 alias는 공개용이며 marker만 결과 정확성에 사용한다.
모든 Job은 read-only였고 파일 변경, approval, ordinary question은 없었다.

| 시나리오 | 실제 조작 | 관측 결과 | 판정 |
| --- | --- | --- | --- |
| `LIVE-154-SAME` | 한 사용자 메시지로 Job A/B 사전 승인 | A `ISSUE154_STAGE1=codex-mcp-bridge-for-chatgpt` 직접 수신 후 같은 응답에서 B 시작, B `ISSUE154_STAGE2=0.4.1` 직접 수신 | PASS |
| `LIVE-154-SWITCH` | 20초 지연 A가 running일 때 다른 ChatGPT 대화로 이동 | 원 대화를 다시 열기 전에 A completed, B admitted/completed; 돌아온 뒤 두 marker final 확인 | PASS |
| `LIVE-154-HIDDEN` | 60초 지연 A가 running일 때 IAB visibility를 hidden으로 유지 | 첫 bounded wait 만료 뒤 같은 A 재대기, hidden 상태에서 B admitted/completed, 이후 final 동기화 | PASS, ChatGPT web/IAB 경계 |
| `LIVE-154-DISCONNECT` | A가 running일 때 테스트 탭만 CDP offline, 시스템 네트워크는 유지 | offline 상태에서 A completed와 B admitted/completed; online 복구 뒤 두 marker final 동기화 | PASS, client-tab 연결 경계 |
| `LIVE-154-DUPLICATE` | A terminal을 총 3회, B terminal을 총 2회 exact 조회 | 모든 결과 동일·`changed=false`; DB Job 수는 정확히 2개만 증가, 후속 B는 한 번만 생성 | PASS |
| 실제 macOS 화면 잠금 | 최초 시험에서는 미실행 | 사용자 인증이 필요해 사용자 참여 세션으로 분리함. 2026-09-23 후속 결과는 문서 끝 참조 | 당시 NOT RUN |

`LIVE-154-HIDDEN`은 브라우저 visibility를 실제로 숨긴 web-host 검증이다. native
ChatGPT 데스크톱 앱을 별도로 전면/백그라운드 전환한 증거로 확대 해석하지
않는다. `LIVE-154-DISCONNECT`도 해당 ChatGPT 탭의 client connection 유실
검증이며 Mac 전체 네트워크 장애나 Tunnel control-plane 단절을 주장하지 않는다.

각 direct Job의 completion audit 행은 `attempt_count=0`을 유지했고
`direct_result_offered_at`만 기록됐다. live-card message/lease가 없었다는 증거다.
그 행의 `result_read_at`이 비어 있는 것은 의도된 계약이다. 서버 offer만으로
수신을 추정하지 않고, 실제 ChatGPT final과 사전 승인된 다음 Job admission을
함께 확인했다.

## 기본 경로와 회귀

default Settings에서 새 Job은 계속 `live-card`를 snapshot하고 exact Dashboard
render action을 반환한다. 실험값을 running Job 도중 끈 통합 회귀에서 기존 Job은
`direct-wait`를 유지하고 다음 Job만 `live-card`가 됐다. request replay는 같은 Job과
같은 upstream execution을 반환했다.

production Dashboard 브라우저 회귀는 host accept, explicit reject retry,
timeout uncertainty, direct result read, teardown, mismatch, duplicate cards와 새
`direct-wait-route`를 검사한다. direct route는 completion wait와 `ui/message`를
각각 0회 실행한다.

상태 저장소 회귀는 direct policy 변경을 거절하고 legacy payload를 `live-card`로
읽으며, direct terminal row를 live-card claim query에서 제외한다. macOS 설정
draft, save/rebase/equality와 9개 locale 생성물도 같은 필드를 고정한다.

## 자동 검증

최종 checkout에서 다음 검사를 실행했다. 이 결과는 실제 host 관측을 대체하지
않고 deterministic 경계를 보강한다.

| 검사 | 결과 |
| --- | --- |
| `npm run check` | 98 files / 876 tests PASS |
| `npm run macos:check` | 206 tests PASS, opt-in live 2 tests 의도적 skip; 1,323 strings / 9 locales PASS |
| `npm run test:issue-154-direct-result` | selected 3 tests PASS + production Dashboard browser 9/9 PASS |
| `npm run test:issue-137-status-wait` | 100 progress / 2 terminal waiters / progress wake 0 / terminal wake 2 / identity read 0 / active waiter 0 PASS; persisted 36, bounded-drop 64 |
| `npm run test:continuity` | 3 stages, 1 + 4 + 4 tests PASS |
| `npm run app-server:compat:check` | CLI 0.153.3, 416 JSON / 827 TypeScript schema PASS |
| `npm run test:issue-143-card-stale` | Dashboard, Settings, Decision stale-preservation PASS |
| `npm run test:issue-143-native-companion` | real companion socket + production Swift client 1/1 PASS |
| `npm run test:issue-143-connection-reliability` | disposable schema-25 fault matrix and 30-second production ingress stall PASS |
| `npm run release:check` | release/localization/UI manifest PASS, active fragments 15 |

## 복구와 남은 수동 항목

검증 뒤 checkout runtime을 정상 종료하고 설치본 helper와
`codex-mcp-bridge-macos` Tunnel을 다시 시작해 connected 상태를 확인했다.
ChatGPT connector도 설치본 Dashboard 34 / Settings 23 metadata로 다시 Refresh해
운영 build와 descriptor를 일치시켰다. 시험 Job과 설정은 분리된 development DB에만
남고 운영 `stable` Job/Settings 데이터에는 사용하지 않았다. 시험용 Tunnel profile과
그 managed metadata는 설치본 복구를 확인한 뒤 제거했다.

최초 시험 시점에는 화면 잠금 행렬을 완료하려면 사용자가 잠금·해제를 수행할 수 있는 세션에서
지연 Job A를 시작하고, A가 running인 동안 Mac을 잠근 뒤 충분한 시간이 지나
해제한다. 원 대화에 들어가기 전에 development DB에서 B admission을 확인하고,
이후 실제 final을 확인해야 한다. 단순히 A가 completed인 것만으로 성공을
판정하지 않는다. 이 절차는 아래 2026-09-23 후속 시험에서 수행했다.

## 2026-09-23 후속 원자료 대조와 미충족 조건

서명된 ChatGPT 계정에서 기존 `LIVE-154-SWITCH` 원대화를 직접 확인했다. 사용자
요청문에는 다음 지시가 있었다.

> Job 1의 정확한 Job ID를 bounded terminal wait로 기다려 direct-wait 결과를
> 직접 검토한 즉시, 사용자 입력 없이 Job 2를 자동 시작하세요. Dashboard/live-card는
> 사용하지 마세요.

따라서 기존 시험은 **설정만 켠 일반 요청** 시험으로 분류하지 않는다. 원대화에
보이는 한 번의 GPT 응답은 Job 1·2의 `direct-wait` 결과를 모두 보고했다. 분리된
development DB를 read-only로 조회해 같은 두 Job의 원행을 대조한 값은 다음과
같다. UTC 시각이며 공개 문서에는 Job ID 접두부만 적는다.

| Job 별칭 | 접수 UTC | 완료 UTC | 정책 | 완료 전달 행 |
| --- | --- | --- | --- | --- |
| `65690a5c…` | 2026-09-22 14:08:33 | 14:09:07 | `direct-wait` | `pending`, attempt 0, direct offer 있음 |
| `b6058c2d…` | 2026-09-22 14:09:22 | 14:09:34 | `direct-wait` | `pending`, attempt 0, direct offer 있음 |

두 Job의 `scope_id`는 동일하며 그 scope의 Job 총수도 2개다. 이로써 결과
재조회와 별개로 이 시나리오에서 후속 Job이 한 개만 접수된 것은 확인된다.
반면 당시 **사용자의 원대화 복귀 UTC 시각은 기록되지 않았다.** 따라서 본문의
`LIVE-154-SWITCH`의 복귀 전 성공 표기는 당시 운영자 관찰로 남겨두고, 제3자가
시각을 재구성해 독립 승인한 결과로 표현하지 않는다.

후속 코드 회귀에는 설정 ON 상태의 `codex_task` 도구 설명과 반환 본문의
모델 안내가 direct wait를 가리키는지, 설정 OFF 후 새 Job은 live-card인지,
Job 정책·lease 부재가 Bridge 재시작 뒤에도 유지되는지를 추가했다.

2026-09-23 08:23 KST에 확인한 실제 설치본 Runtime `dist/build-info.json`의
commit은 `50b115c24bd4c254609ee6c6ff959a44710b9821`이다. #154 변경이 없는
당시 빌드이므로 **그 시점에는 설치본에서 실험 기능을 쓸 수 없었다.** 이후
설치 전환과 연결 재확인 결과는 문서 끝에 별도로 기록했다.

후속 변경본에서 실행한 검사는 다음과 같다.

| 검사 | 2026-09-23 결과 |
| --- | --- |
| #154 집중 회귀 | 3/3 selected tests 및 production Dashboard browser 9/9 통과 |
| 전체 TypeScript/build/release | 98 files, 876/876 tests 통과 |
| macOS 및 9개 언어 | 206 tests 통과, 환경 의존 live 2건 skip; 1,323 strings 검증 |
| MCP 2026-07-28 conformance | 29/29 통과 |
| App Server schema | CLI 0.153.3, JSON 416개·TypeScript 827개 일치 |
| 연속성·bounded wait·#143 카드/companion/연결 회귀 | 모두 통과 |

처음 TypeScript 전체 시험을 macOS 전체 빌드와 동시에 실행했을 때, 기존
`executionServiceProcess`의 steer 타이밍 시험 1건이 active turn 종료 경합으로
실패했다. 같은 시험 단독 재실행과 macOS 빌드가 끝난 후 TypeScript 전체
재실행은 모두 통과했다. 이 현상을 #154 기능 결함이나 첫 실행의 통과로
치환하지 않는다.

## 2026-09-23 서명 빌드 설치 및 재연결

사용자가 메뉴바 앱을 정상 종료한 뒤 메뉴바 앱, helper, Bridge, Tunnel 프로세스가
모두 내려간 것을 확인했다. 교체 전 설치본, LaunchAgent, 운영·진단 DB의
복구용 사본을 별도 보관했고 앱 서명과 두 SQLite 백업의 `quick_check`, 운영 DB
`foreign_key_check`를 확인했다. 종료 전 `runtime.snapshot`에서 active Job,
pending admission/interaction, memory-only thread, background process는 모두
0이었다.

깨끗한 `dev` 커밋 `c5b08a0e452c4d544b9088aa4dca26208244e527`의 서명
번들 `c5b08a0e452c:238e6deb0e3f`을 `/Applications`에 설치했다. 설치 경로의
서명 검증과 `dist/build-info.json`의 정확한 빌드 ID 대조를 통과했다. 재기동 후
launcher 상태는 같은 빌드 ID에 `running`, Tunnel은 `connected`와
`doctorPassed=true`를 보고했다. helper도 `running`/Tunnel `connected`였고,
Bridge `runtime.snapshot`은 `acceptingNewJobs=true`, active Job 및 pending
admission/interaction 0, background process `confirmed`/0을 보고했다.
재기동된 운영·진단 DB의 read-only `quick_check`도 모두 `ok`였고 운영 DB
`foreign_key_check`에서 위반 행은 없었다.

운영 Settings는 schema 7로 이관됐고 실험 스위치는 기본값 `false`를 유지했다.
따라서 **새 기능이 현재 설치본에 포함되고 연결된 것**까지 확인했다. 이 설치
검증만으로 설정 ON 상태의 실제 ChatGPT 수신, native background 또는 화면 잠금
행렬을 통과했다고 주장하지 않는다.

## 2026-09-23 일반 요청·복귀 전 후속 Job 재시험

설치된 동일 빌드 `c5b08a0e452c:238e6deb0e3f`을 사용하되 운영 DB와 분리한
`development` profile에서 실험 스위치를 켰다. 전환 전 운영 runtime에는 active
Job/admission/interaction/background process가 모두 0이었고, 안전 종료 뒤
development DB를 연 단일 상태 소유자와 연결된 Tunnel을 확인했다. 시험 대화는
ChatGPT Work에서 Bridge connector가 선택된 기존 대화였다. 공개 감사 문서에
대화 URL·scope ID·전체 Job ID는 남기지 않는다.

사용자는 먼저 “두 단계 읽기 전용 점검”을 요청했다. 첫 응답은 등록 프로젝트의
정확한 이름을 물었으며 Job을 만들지 않았다. 사용자가 승인한 다음 한 문장으로
프로젝트 이름 `issue154-live`만 보충하고 앞선 두 점검을 그대로 진행하도록 했다.
어느 사용자 메시지에도 exact wait 반복, `direct-wait` 선택, 카드 금지 같은
기술적 지시는 없었다. 이 후속 메시지는 2026-09-23 01:02:23 UTC에 전송됐다.

| 관측 | UTC 시각 | 원증거 |
| --- | --- | --- |
| Job A 접수 | 01:02:44 | development DB `513c57f3…`, `direct-wait` |
| Job A 완료·직접 결과 offer | 01:02:56 | 같은 Job의 terminal 및 delivery audit |
| 원 대화 이탈 시작 | 01:03:02 이후 | 다른 ChatGPT 페이지로 이동하기 직전 시계 기록 |
| Job B 접수 | 01:03:08 | development DB `877049f2…`, A와 같은 scope, `direct-wait` |
| 다른 페이지 표시 확인 | 01:03:09 | 원 대화가 아닌 새 채팅 화면 관측 |
| Job B 완료·직접 결과 offer | 01:03:16 | 같은 Job의 terminal 및 delivery audit |
| 원 대화 복귀 | 01:04:09 | 대화 재진입 직후 시계 기록 및 GPT final 관측 |

따라서 **Job B가 사용자의 원 대화 복귀보다 약 1분 먼저 접수·완료된 것**은
시각으로 확인된다. 다만 Job B 접수는 이탈 탐색이 완료되기 약 1초 전이므로,
“다른 화면에 완전히 도착한 뒤 Job B가 시작됐다”는 더 강한 문장은 이 자료로
주장하지 않는다. GPT final은 Job A 결과를 먼저 검토한 뒤 별도 Job B의 결과를
보고했다. A에서는 `package.json`의 `name`과 README 제목이 같은 프로젝트를
가리키는지, B에서는 `package.json`과 `release-manifest.json`의 제품 버전이
모두 `0.4.1`인지 읽기 전용으로 확인했다. 두 Job은 같은 대화 scope에만 있고
시험 전후 Job 수 증가가 정확히 2개라 후속 Job은 1개다. 각 delivery audit은
`attempt_count=0`, direct offer 있음, live-card lease 없음이었다. 이 관측은
설정 ON 상태의 일반 요청에서 직접 경로가 선택되고 GPT가 후속 작업을 수행한
실제 host 수락 증거다.

시험 뒤 두 Job이 terminal임을 확인하고 development runtime을 drain 종료했다.
설치 앱을 다시 시작하자 상태 소유자는 운영 `state.sqlite`를 열었고 helper
`running`, Tunnel `connected`, Bridge `connected`를 확인했다. 운영 Settings의
실험 스위치는 여전히 `false`이고 운영 DB에는 이 시험 시각의 신규 Job이 0개다.
현재 설치본에는 실험 기능이 있으나 일상 사용에서는 기본 경로가 유지된다.

이 재시험은 ChatGPT Work의 브라우저 대화 전환을 검증한다. native ChatGPT 앱의
foreground/background 전환과 실제 macOS 화면 잠금은 검증하지 않았으므로 해당
지원 범위와 #154의 전체 수락 여부는 별도로 남는다.

## 2026-09-23 잠금 시험 중 시스템 잠자기·실행기 중단

같은 설치 빌드와 분리된 development profile에서 첫 Job이 실제 셸 `sleep 75`를
수행한 뒤 이름을 비교하고, 그 결과를 검토한 다음 별도 Job으로 버전을 비교하도록
요청했다. 사용자에게는 다른 앱으로 전환한 뒤 Mac 화면만 잠그고, 덮개는 닫지
않은 채 약 90초 후 직접 해제하도록 안내했다. 시험 전 development DB의 Job은
14건, 실험 스위치는 ON이었고 진행 중 Job은 없었다.

| 관측 | UTC 시각 | 원증거 |
| --- | --- | --- |
| 첫 이름 점검 Job 접수 | 01:17:40 | DB `0db16815…`, `direct-wait` |
| 실제 `sleep 75` 시작 | 01:17:48 | 해당 Job의 `app-command-started` |
| Mac 화면 꺼짐 | 01:18:19 | `pmset -g log` |
| `Clamshell Sleep` 진입 | 01:18:24 | `pmset -g log`, 약 31초 |
| `DarkWake` 및 첫 Job 중단 | 01:18:55 | 전원 기록 및 DB `worker-loss`; 저장 오류에 `signal=SIGKILL` |
| 두 번째 버전 점검 Job 접수·완료 | 01:19:12 / 01:19:22 | DB `626d2eb4…`, `direct-wait` |
| 이름 점검 재시도 Job 접수·완료 | 01:19:33 / 01:21:02 | DB `f1e17b42…`, `direct-wait` |

전원 기록의 잠자기는 **화면 잠금만의 효과와 구분해야 한다.** `SIGKILL`이
잠자기 복귀와 같은 초에 발생한 사실은 확인했지만, 기존 빌드에서 정확히 어느
감독 분기가 신호를 보냈는지는 기록되지 않았다. 코드에는 실행기 심박이 10초
이상 오래됐으면 `SIGKILL`하는 경로와, 주기적인 `/bin/ps` 관측 실패 시
실행기를 종료하는 경로가 모두 있다. 두 경로의 벽시계 타이머가 잠자기 동안
만료된 것처럼 보일 수 있으므로, 어느 하나를 단독 원인으로 확정하지 않는다.

GPT는 첫 Job의 중단을 확인했지만 원래 요구한 “첫 결과 검토 후 두 번째 Job”
순서와 달리 버전 점검을 먼저 시작했다. 그 뒤 이름 점검을 세 번째 Job으로
재시도했고, 최종 답변도 실제 Job 3건과 원래 수락시험의 순서 조건 미충족을
명시했다. 재시도 Job의 `sleep 75`는 75.0157초로 완료됐고 두 읽기 전용 결과는
얻었지만, **이 시험을 #154의 잠금·연속 오케스트레이션 성공으로 표시하지
않는다.** 세 Job 모두 `direct-wait`였고 live-card 시도는 0회였다.

세 Job이 terminal임을 확인한 뒤 development runtime을 drain 종료했다.
설치 앱은 운영 `state.sqlite`의 단일 소유자로 복귀했고 helper `running`, Tunnel과
Bridge `connected`, 운영 실험 스위치 OFF, 운영 DB의 시험 Job 0건을 확인했다.

잠자기 복귀의 오인 종료를 막는 후보 수정은 실행기 watchdog의 지연된 timer
tick에 10초 복귀 유예를 주고, 잠자기 동안 멈춘 `/bin/ps` 관측에도 제한된
재개 시간을 주는 것이다. 실행기 종료 오류에는 감독자가 직접 보낸 `SIGKILL`의
사유를 남겨 재현 시 원인을 구분한다. 실제 설치본 검증 전에는 해결로 승인하지 않는다.
관련 회귀 12개는 통과했다. 첫 `npm run check`의 병렬 실행에서는 기존 steer
타이밍 시험 1건이 active turn 종료 경합으로 실패했고 같은 시험 단독 재실행은
통과했다. 이후 빌드와 전체 TypeScript 시험을 낮은 병렬도로 다시 실행해
99개 파일, 878개 시험을 모두 통과했다. macOS 앱 검사도 206개 통과,
선택형 2개 건너뜀으로 끝났고 App Server 호환성, #142 실행 분리 및 #143
연결 안정성 전용 시험도 통과했다. #154 직접 수신 전용 3개 시험과 #126
live-card 브라우저 시나리오 9개도 통과했다. 이 결과는 코드와 격리 시험의 회귀 확인이며,
후보 수정이 설치 앱의 실제 잠자기 복귀를 통과했다는 뜻은 아니다. 이 첫 시험
직후 사용 중이던 안정 설치본은 후보 수정 이전 빌드였다.

## 2026-09-23 수정 빌드의 화면 잠금·실제 잠자기 재시험

작업·대기 요청이 모두 0건임을 재확인하고 기존 앱과 운영·진단 DB를 별도 백업했다.
앱 서명, 백업 DB의 `quick_check` 및 운영 DB의 `foreign_key_check`를 확인한 뒤
서명 빌드 `dc7c70ac0167:226fc3c1ab70`을 `/Applications`에 설치했다. 설치
경로의 서명과 빌드 식별자를 대조했고 운영 프로필에서 Bridge/Tunnel 연결 및
기본 OFF 설정을 확인했다. 실제 ChatGPT 시험은 운영 DB가 아닌 기존
`development` 프로필(실험 설정 ON)에서 진행했다.

먼저 **순수 화면 잠금**을 분리하기 위해 임시 `caffeinate -i`로 유휴 시스템
잠자기만 막고, 사용자에게 다른 앱으로 전환하여 화면만 잠근 뒤 덮개를 열어
두도록 요청했다. 사용자는 잠금·해제 완료를 보고했다.

| 관측 | UTC 시각 | 근거 |
| --- | --- | --- |
| 첫 Job 접수 및 실제 `sleep 60` 시작 | 02:02:05 / 02:02:14 | DB Job `4c27bfcc…`, `app-command-started` |
| 화면 꺼짐 | 02:03:08 | `pmset -g log` |
| 첫 Job 정상 완료 및 직접 결과 offer | 02:03:21 / 02:03:26 | DB `normal-completion`, delivery |
| 두 번째 Job 접수·정상 완료 | 02:03:45 / 02:03:52 | DB Job `091f2ba4…` |
| 화면 켜짐 | 02:04:45 | `pmset -g log` |

이 구간 전원 기록에 시스템 Sleep은 없다. 두 Job 모두 `direct-wait`, 해당
completion의 live-card 시도는 0회이고, 시간 구간의 신규 Job은 정확히 2건이다.
원래 GPT의 최종 응답에는 첫 비교 결과를 검토한 뒤 두 번째 비교를 수행한
두 Job ID와 결과가 순서대로 있었다. 두 번째 Job의 접수·완료가 화면이 다시
켜지기 전이므로, 이 장비·빌드에서 **화면 잠금 중 후속 Job 시작**은 확인된다.

그다음 임시 잠자기 방지를 끝내고 사용자가 덮개를 닫아 **실제 시스템 잠자기**를
유도했다. 사용자에게 원래 ChatGPT 대화로 돌아가지 말고 이 작업에서 복귀를
알려 달라고 요청했고, 사용자는 잠자기 복귀 완료를 보고했다.

| 관측 | UTC 시각 | 근거 |
| --- | --- | --- |
| 첫 Job 접수 및 실제 `sleep 90` 시작 | 02:06:32 / 02:06:42 | DB Job `29b68f37…`, `app-command-started` |
| `Clamshell Sleep` 진입 | 02:07:29 | `pmset -g log` |
| DarkWake, Maintenance Sleep, 화면 켜짐 | 02:08:00 / 02:08:45 / 02:08:55 | `pmset -g log` |
| 첫 Job 정상 완료 및 직접 결과 offer | 02:09:03 | DB `normal-completion`, delivery |
| 두 번째 Job 접수·정상 완료 | 02:09:12 / 02:09:20 | DB Job `988efb49…` |

첫 Job이 `worker-loss` 없이 정상 완료됐고, 원래 GPT의 최종 응답은 첫 결과를
검토한 다음 두 번째 Job을 시작한 사실과 두 결과를 보고했다. 신규 Job은 정확히
2건, 두 정책 모두 `direct-wait`, live-card 시도는 0회였다. 따라서 앞선 빌드의
잠자기 복귀 `SIGKILL`은 이 동일 장비의 수정 빌드 재시험에서는 재발하지 않았다.
이는 **짧은 Clamshell Sleep 한 번의 성공 근거**이지, 모든 절전 길이·호스트
종료·연결 유실 조건의 보증은 아니다. 첫 Job의 실제 하위 프로세스 PID가 잠자기
전후 동일했는지는 별도로 계측하지 않았으므로 그렇게 주장하지 않는다.

두 시험 Job이 모두 terminal이고 운영 영향 지표가 0임을 확인한 뒤 시험용
runtime을 drain 종료했다. 설치 앱의 운영 DB 단일 소유자를 복원했으며
helper `running`, Bridge/Tunnel `connected`, 운영 실험 설정 OFF, 운영
active Job·대기 요청·백그라운드 프로세스 0건을 확인했다. 수정 빌드는 현재
설치돼 있으나 실험 기능은 운영 프로필에서 여전히 기본 OFF다.

## 2026-09-23 사용자 선택 경계 추가 시도 — 판정 보류

PR #161 병합 뒤 승인·질문 경계를 별도로 확인하려고 다시 분리된 development
프로필을 연결했다. 같은 ChatGPT Work 대화에 첫 읽기 전용 Job만 승인하고,
결과를 본 뒤 사용자가 A/B 중 다음 검사를 선택할 때까지 두 번째 Job을 만들지
말라는 요청을 전송했다. GPT 화면에는 “첫 Job만 실행하고 A/B를 묻겠다”는
진행 문구가 나타났으나 **첫 Job 자체가 접수되지 않았다.** 해당 시험 시각 이후
development DB의 새 Job은 0건이었다.

브라우저 진단에는 02:18:45 UTC에 `The conversation is stale, please reload
and try again` 오류가 있었다. 대화를 새로고침해도 진행 문구만 남고 Job 접수나
최종 질문은 관측되지 않았다. 그러므로 “두 번째 Job을 만들지 않았다”는 사실을
사용자 경계 준수의 성공으로 계산할 수 없다. #154의 승인·질문 경계 완료 항목은
열린 상태로 둔다. 시험 runtime은 active Job·대기 요청·백그라운드 프로세스가
모두 0건임을 확인한 뒤 drain 종료했으며, 설치 앱은 운영 DB 단일 소유자,
기본 OFF, helper `running`, Bridge/Tunnel `connected` 상태로 복원했다.

## 2026-09-23 새 대화의 사용자 선택 경계 재시험

앞선 stale conversation을 재사용하지 않고 새 ChatGPT Work 대화에서 브리지
플러그인을 선택했다. 설치된 서명 빌드 `dc7c70ac0167:226fc3c1ab70`과 운영 DB에서
분리된 development profile(실험 설정 ON)을 사용했다. 시험 요청은 첫 번째 읽기 전용
Job만 승인하고, 결과를 검토한 뒤 A(버전 비교) 또는 B(release notes 제목 수 확인)를
질문하되 답변 전에는 두 번째 Job을 만들지 말라고 요청했다.

| 관측 | UTC 시각 | 근거 |
| --- | --- | --- |
| 첫 Job 접수 | 02:35:02 | DB `5bde4b42-1aa9-4e93-82b4-6cc78f567ed3`, `direct-wait` |
| 첫 Job 정상 완료 및 직접 결과 offer | 02:35:15 | DB `normal-completion`, delivery `direct_result_offered_at` |
| GPT의 결과 검토와 A/B 질문 | 완료 후 | 원래 ChatGPT Work 대화의 최종 응답: package name과 README 제목을 비교하고 선택을 요청 |
| 같은 시험 구간의 두 번째 Job | 없음 | 02:34 UTC 이후 development DB 신규 Job 정확히 1건 |

해당 completion의 live-card 전달 시도는 0회였다. GPT는 첫 Job ID와 결과를
최종 응답에 제시했고 “두 번째 Job은 만들지 않았다”고 밝힌 뒤 A/B를 물었다.
DB에서도 신규 Job이 1건뿐임을 독립적으로 확인했다. 따라서 **새 후속 작업을
사용자가 아직 선택하지 않은 질문 경계**에서는 자동 진행하지 않는 동작을 이
호스트·빌드에서 확인했다. 이 시험은 실제 Codex의 특권 승인 프롬프트나 모든
사용자 입력 유형까지 검증한 것은 아니므로 그 범위로 확대하지 않는다.

첫 Job 종료 뒤 runtime snapshot에서 active Job, pending admission, pending
interaction, background process가 모두 0건임을 확인하고 development runtime을
drain 종료했다. 운영 프로필 앱과 기본 OFF 설정의 복원 결과는 별도로 확인한다.

## 2026-09-23 데스크톱 앱 백그라운드와 연결 저하 재시험

같은 서명 설치 빌드 `dc7c70ac0167:226fc3c1ab70`을 운영 DB와 분리된
development profile(실험 설정 ON)에 다시 연결했다. 전환 전후 active Job,
pending admission/interaction, background process는 모두 0이었다. 기존
ChatGPT Work 대화에 앱의 task 전송 경로로 읽기 전용 요청을 보냈다. 시험 중
Finder 창을 최전면에 두고 원 대화를 다시 열지 않았으며, Finder의 최전면
상태를 접근성 상태로 확인했다. 이 방식은 **이 Mac의 ChatGPT 데스크톱 호스트가
다른 앱 뒤에 있을 때 실행한 local Work task**의 증거다. 네이티브 대화 창을
직접 조작해 화면 표시 자체를 검증한 시험은 아니다.

첫 요청은 실제 셸 `sleep 75` 뒤 이름을 비교하고, 결과 검토 후 별도 Job으로
버전을 비교하는 두 단계를 미리 승인했다. 요청에는 direct-wait/exact wait/카드
금지 지시가 없었다.

| 관측 | UTC 시각 | 원증거 |
| --- | --- | --- |
| Job A 접수·실제 `sleep 75` 시작 | 03:46:02 / 03:46:08 | DB `f0b90759…`, `app-command-started` |
| Job A 정상 완료·직접 결과 offer | 03:47:30 | DB `normal-completion`, delivery |
| Job B 접수·정상 완료 | 03:47:44 / 03:47:50 | DB `5772321b…`, delivery |
| 원 GPT의 응답 완료 | Job B 완료 후 | 같은 Work 대화의 최종 응답에 두 Job ID와 순서대로 검토한 결과 |

두 Job은 `direct-wait`, 완료 전달 시도 0회, live-card lease 없음이었다.
시험 전후 신규 Job도 정확히 두 건이다. 따라서 **설정만 켠 일반 요청에서,
데스크톱 앱이 Finder 뒤에 있는 동안 첫 결과를 받아 후속 Job을 한 번 시작한
것**을 확인했다. 다만 GPT 응답 자체가 호스트에 의해 종료되는 조건까지
이 시험으로 보장하지 않는다.

별도 연결 저하 시험은 실제 셸 `sleep 120`을 수행하는 Job A가 실행 중일 때
설치본의 시험용 Tunnel client 프로세스 하나만 70초간 일시 정지한 뒤 자동
재개했다. 정지 중 helper는 Bridge `connected=true`, Tunnel
`phase=degraded`/`connected=false`와 readiness probe 실패를 보고했고,
Job A는 계속 `running`이었다. Tunnel 재개 후 `connected=true`로 돌아왔다.

| 관측 | UTC 시각 | 원증거 |
| --- | --- | --- |
| Job A 접수·실제 `sleep 120` 시작 | 03:49:46 / 03:49:52 | DB `3be281e9…`, `app-command-started` |
| 시험 Tunnel 정지·재개 | 03:50:24 / 03:51:34 | 대상 PID에 `SIGSTOP`/`SIGCONT`, helper degraded 후 connected |
| Job A 정상 완료·직접 결과 offer | 03:51:57 | DB `normal-completion`, delivery |
| Job B 접수·정상 완료 | 03:52:07 / 03:52:12 | DB `90fae988…`, delivery |
| 원 GPT의 응답 완료 | Job B 완료 후 | 상태 조회 1회 timeout 뒤 **같은 Job ID** 재조회, 결과 검토 후 Job B 시작 보고 |

이 두 Job도 `direct-wait`, 완료 전달 시도 0회, live-card lease 없음이고 시험
구간의 Job 증가가 정확히 두 건이었다. 이는 **Tunnel 연결 저하 중 실행 생존과
재연결 뒤 원 GPT의 동일 Job 복구·후속 실행**을 보여준다. 그러나 이 시간대
`transport_observations`에 `status-wait-aborted` 행은 없었다. 따라서 원 GPT가
보고한 timeout을 실제 진행 중 MCP 호출의 host abort로 바꾸어 표현하지 않는다.
Mac 전체 네트워크를 차단하거나 GPT 실행 자체를 강제 종료한 시험도 아니다.

별도의 직접 수신 회귀에서는 실행 중 Job에 대한 status read의 client
`AbortController`를 실제로 발동하고 `status-wait-aborted` 관측 기록을 확인한
뒤, 동일 Job identity로 재조회해 원래 Job의 계속 실행·정상 완료와 신규 Job
미생성을 확인한다. 이 회귀는 실제 ChatGPT host가 abort를 일으켰다는 원증거가
아니라, 관측 가능한 abort 경계의 결정적 보강 시험이다. 사용자 선택 경계는
위 실제 Work 시험이, 특권 명령 승인 경계는 별도의 합성 pending-approval
회귀가 각각 담당한다. 합성 시험은 실제 특권 승인 팝업의 종단 시험으로
확대하지 않는다.

시험 종료 시 네 Job이 모두 terminal이고 `runtime.snapshot`의 active Job,
pending admission/interaction, background process가 각각 0임을 확인했다.
development runtime을 drain 종료하고 시험용 helper를 내린 뒤 설치 메뉴바
앱을 다시 시작했다. 설치 파일의 빌드 ID는 여전히
`dc7c70ac0167:226fc3c1ab70`이고 상태 조회 프로세스는 운영
`state.sqlite`를 열었다. 운영 DB `quick_check=ok`, 실험 설정 OFF,
helper `running`, Bridge/Tunnel `connected`, `doctorPassed=true`, 운영
`runtime.snapshot`의 위 네 카운터 0을 확인했다. Finder 시험 창도 닫았다.

후속 회귀 변경본에서 TypeScript 전체 99개 파일·880개 시험을 낮은 병렬도에서
통과했고, #154 집중 회귀는 선택된 5개와 #126 production Dashboard 브라우저
9개 시나리오를 통과했다. `npm run build`는 localization·release 검사와
TypeScript 컴파일까지 통과했고, `npm run macos:check`는 9개 언어의 1,323개
문자열 검사 및 Swift 206개 시험 통과(환경 의존 선택형 2개 건너뜀)로 끝났다.
