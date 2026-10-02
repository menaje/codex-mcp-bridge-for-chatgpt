# #222 receiver 연구 결과 — 2026-10-02

이번 실행의 제한된 연구·시험 산출물을 확정한다. 일반 Chat의 R1(이탈 후 사용자 입력 없이 새 wake·원 대화 전달·exact 원본 검토)은 현재 증거로 채택하지 않는다. 권장 조합은 **direct-wait + 원 대화에서 명시적 수동 exact Job 복구**다. 진행 중 GPT turn의 지속과 종료된 turn의 새 wake는 다르며, 모델·추론·usage 연속성은 판정하지 않는다. 보편적 불가능이나 #222 전체 수락/폐쇄를 선언하지 않는다. 상위 ChatGPT가 독립 검토와 GitHub 정리를 맡는다.

## 기준과 범위

선택 프로젝트 브리지 revision4, 저장소 `menaje/codex-mcp-bridge-for-chatgpt`. T0의 #224 복구·등록 정상 증거를 재사용했다. root `dev`의 HEAD 및 읽힌 `origin/dev`: `30919ee1e1b9461216db289a5a69876079efb92e`; 현재 읽기로 재확인했으며 root clean. 원격 dev는 T0에서 같은 SHA를 관측한 값이고 이번 종료 시 새 원격 갱신을 주장하지 않는다. fetch/reset/checkout/운영 프로젝트 변경 없음.

감사 worktree `/private/tmp/bridge-222-receiver-research-20261002`, branch `codex/issue-222-receiver-research`, HEAD도 같은 SHA, 통합 대상 dev. AGENTS.md를 확인했다. 사용자의 commit/push/merge 금지가 우선하므로 docs는 미커밋 리뷰 산출물이다. 기존 `/tmp/bridge-222-t1-t2-20261002` 자산은 읽고 호출했으며 수정하지 않았다. 그 worktree의 과거 broad 회귀 실패/timeout 및 미통합 상태는 해결했다고 주장하지 않는다.

새 production receiver, #221 제품 구현, #223 control plane, DB/workflow engine을 만들지 않았다. operational DB/설정/서비스·scope 검사·subscriptionRef 권한은 변경하지 않았다. Overview/Activity summary 출력 검증 별개 버그는 추적/수정하지 않았다. 새 actual Codex fixture Job은 0개이며 parent 조사 실행과 합성 A를 구분한다.

## 실제 수행과 접근 경계

현재 callable browser/CUA/node_repl 없음. 설치된 Browser/CUA skill은 node_repl 경로를 요구한다. OS 읽기 probe System Events/Safari는 응답 없이 끝내지 못해 이번 소유 PID17917/17950만 종료했다. 별도 Swift preflight는 `accessibilityTrusted=false`, `screenCaptureAllowed=false`. 접근 권한을 승인/확대하거나 실제 브라우저 프로필·쿠키·숨은 제어 경로를 읽지 않았다. 이는 이번 agent의 제어 경계이며 ChatGPT host 기능의 전역 미지원 판정이 아니다.

독립 로그인 helper는 `CODEX_BRIDGE_TEST_CODEX_HOME`이 설정되지 않았다는 명시 오류(exit1)를 반환했다. 운영 인증을 복사하지 않았고, 실제 Codex + actual ChatGPT 새 A/B는 실행하지 못했다. 최소 모델을 사용했다고 꾸미지 않는다. 인증된 새 host 대화를 만들거나 실행 중 이탈을 직접 제어할 수 없으므로 그 경계는 재시도하지 않았다.

| 새 실행 | 결과 | 증거 범위 |
| --- | --- | --- |
| direct-result/direct-wait·자동 originating Dashboard 집중 Vitest | 6 passed / 0 failed / 79 skipped | 실제 Bridge 코드, fake upstream; 실제 host abort가 아닌 client abort 회귀 포함 |
| production Dashboard HTML + Playwright CLI 0.1.19 | 9/9 | fake host acceptance/rejection/timeout/teardown/dedup; actual GPT 수신 아님 |
| Swift completion notification 집중 | 3/3 | fake delivery와 private socket 계약, generic notification content; 새 actual OS banner 아님 |
| held A + standalone local browser 이동 | 1 synthetic A, B0, exact fixture match | 실제 isolated HTTP/SQLite handler + fake upstream; 실제 Codex/ChatGPT 아님 |
| owner-only Site save/deploy | saved version1 / succeeded | private publication metadata만; runtime·MCP 수신 성공 아님 |
| Site HTTP smoke 7회 | anonymous403; owner header GET/ingest401; MCP 4회404 | 제공된 정상 header 사용; owner 인증 수락·fixture 도달 미확인 |

각 invocation별 결과이며 서로 합산해 전체 suite PASS라고 표현하지 않는다. 자세한 명령·test names·시나리오·input SHA-256은 [machine-readable JSON](2026-10-02-issue-222-receiver-research.json)에 보관한다. raw session/scope/token/callback/계정정보 없음.

## A~I 판정

Observe는 완료 관측, Wake는 새 모델 실행이며 ongoing turn 지속과 별도다. 아래 actual은 지정한 기존 Work/로컬/site metadata에만 해당한다. 미검증은 unsupported나 PASS가 아니다.

| 후보 | disposition | Observe | 새 Wake | ongoing turn | 원래 Chat route | exact 원본 authority | 근거/공백 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A direct-wait | prior-actual-reused | 기존 actual Work 완료/원본 검토 | 새 wake 미검증 | 기존 actual Work 진행 중 turn 지속 | 기존 actual Work 원 대화 | 기존 actual Work exact 결과 | 현재 actual ChatGPT/Codex 신규 실행 없음. 합성 A 1개만. 일반 Chat 및 종료된 GPT turn의 새 wake 미검증. |
| B inline Dashboard | synthetic-only | 합성 live card; 기존 actual 표시 | 미검증 | 미검증 | 합성 originating connection | 합성 exact retained result | #108 actual teardown과 이번 fake host 9/9를 구분. 카드 표시 및 fake ACK는 actual GPT 수신 증거가 아님. |
| C PiP | blocked-with-evidence | 미검증 | 미검증 | 미검증 | 미검증 | 미검증 | 공식 surface 존재. 인증된 host controller 부재로 mount/이탈/완료 시험 불가. Bridge extension 부재로 host 전체 미지원 판정하지 않음. |
| D Sidebar / Conversation Panel | blocked-with-evidence | 미검증 | 미검증 | 미검증 | 미검증 | 미검증 | 공식 extension 계약만 확보. receiver mount, 원 대화 route, exact authority 실제 시험 미실행. |
| E scheduled monitor | actual-tested | parent 예약 metadata만 | last_run metadata; 새 GPT wake 미확인 | 미확인 | 미확인 | 미확인 | parent-host-reported actual scheduling metadata. Bridge 호출/원본 접근/응답 전달 미확인. root tools 미노출은 전역 미지원 아님. |
| F Work / dot Events | prior-actual-reused | 기존 actual Work completed event | 기존 actual Work event-triggered 재개 | direct-wait와 별개 | 같은 대화 설정 관측; 원본 scope 불일치 | 실패 HANDLE_UNAVAILABLE | Work actual, dot 공식 계약만. A 종료 후 이탈. same OAuth principal / 다른 scope, B0. 기존 구독 재개 없음. |
| G native notification + manual resume | prior-actual-reused | 기존 actual 로컬 notification 등록 | 자동 GPT wake 없음: 현재 계약 | 사용자 수동 입력 필요 | 사용자가 원 대화 선택 | 원 scope에서 수동 exact 조회 필요 | 새 3/3은 fake delivery/socket. actual OS banner 시험 아님. 알림 클릭은 local Dashboard를 열며 원 Chat 재개를 증명하지 않음. |
| H API background comparison | official-contract-only | API 공식 계약 | ChatGPT wake 미검증 | API 계약만 | ChatGPT route 미검증 | Bridge 권한 미검증 | 유료 API 시험/제품 전환 없음. API response 조회 계약을 ChatGPT receiver PASS로 확장하지 않음. |
| I Sites | actual-tested | private deploy metadata actual; runtime 수신 미확인 | 미검증 | 미검증 | 미검증 | 미검증 | owner-only 게시 성공. has_mcp=false는 자산의 MCP 선언 부족. owner header401/MCP404로 수신 미성립. MCP 설정 sample/설치 미확보. |

모든 후보의 모델·추론 연속성과 usage 귀속/누적은 미검증이다. API H 계약의 usage를 ChatGPT usage로 연결하지 않는다. UI lifetime: A는 살아 있는 GPT turn에 의존; B는 mounted/visible/not tornDown에 의존; C/D는 actual mount 자체 미확인; F/E의 backend 이벤트/예약 생존은 UI 생존 및 원본 scope와 별개; G는 로컬 알림, I는 hosted 배포 metadata만 생존 확인. 새 actual GPT latency는 측정하지 못했다.

## 재사용 증거와 최신 해석

- PR154: [#154 direct-result 실제 감사](2026-09-22-issue-154-direct-result-receiving.md). 9/23 후속 일반 요청·Work 데스크톱·대화 전환·짧은 잠금/sleep·Tunnel 저하 후 동일 Job 복구와 사전 승인 B를 재사용한다. ongoing turn 증거이며 일반 Chat 새 wake 또는 강제 종료 GPT의 지속 증거로 확대하지 않는다.
- PR213: [10/2 host-scope-gate](2026-10-02-issue-213-host-scope-gate.md) 및 [비식별 JSON](2026-10-02-issue-213-host-scope-gate.json). subscribe/callback/완료 webhook HTTP200/Work GPT 재개 관측. same OAuth principal, original scope 불일치, `HANDLE_UNAVAILABLE`, B0. A 완료 뒤 이탈이므로 실행 중 이탈 gate는 불충족. 문서의 역사적 “OPEN”과 T0에서 확보한 후속 closed/not_planned 상태를 구분한다. 기존 #213 Job/구독/서비스를 재개하지 않았다.
- PR108: [#108 actual Dashboard 수명/로컬 notification 감사](2026-09-14-issue-108-live-dashboard-lifecycle.md). 실제 UI teardown 뒤 카드 표시가 남아도 receiver가 살아 있지 않았음. macOS 앱 notification 등록/opaque acknowledgement actual은 배너 노출·ChatGPT wake 성공과 다르다. 현재 `src/dashboardCard.ts:completionCanRun`과 새 9/9를 함께 판독한다.

### E — 상위 host 전달 실측

출처는 **parent-host-reported actual scheduling metadata**이며 agent 직접 관측이 아니다. native `automations.create`의 “#222 단일 조회 시험” 1회성 생성 SUCCESS, 예정 `2026-10-02T10:43:59Z`, 완료 T0 exact Job 조회 1회만 지시. `automations.update`가 `last_run_time=2026-10-02T10:45:35.115578Z`를 반환했고 `2026-10-02T10:46:37.480301Z`에 `is_enabled=false`로 종료 정리했다.

이는 예약 실행 metadata만 입증한다. Bridge 도구 호출·원본 접근권한·응답 전달 성공은 미확인이다. root의 native automation 미노출과 모순되지 않으며 전역 미지원으로 쓰지 않는다. 보안 검토에서 차단된 예약 로그 요청은 parent가 재시도하지 않았다고 전달했다. 이번 agent도 추가 조회·로그 접근·재시도·새 예약을 하지 않았다.

## 짧은 합성 fast-gate의 시계·권한 한계

합성 exact A `bdb59eea-ccf7-4cf8-b57d-fa6390fb3c0c` 한 개. isolated bearer/scope, read-only fixture, fake upstream hold를 사용했다. local 브라우저 `/a`에서 `/b`로 실제 이동하고 title을 확인한 다음 explicit release했다. terminal exact HTTP response의 fixture/digest와 scope 일치 확인. 자동 GPT 수신은 주장하지 않는다.

| 필드 | 기록/정의 |
| --- | --- |
| admittedAt | null: persisted admission의 exact timestamp 미측정 |
| runStartedAtMs | 1790938056595: adapter run 시작 |
| departureConfirmedAt | 1790938060856: local browser 이동 확인, actual ChatGPT 이탈 아님 |
| terminalCommittedAt | null: SQLite 실제 commit의 exact timestamp 미측정 |
| terminalCommitObservedAtMs | 1790938061043: committed-state를 exact HTTP 응답에서 확인 |
| gptContinuedAt / exactReadAt | null / null: actual GPT 재개·조회 미측정 |
| localExactReadObservedAtMs | 1790938061043: 로컬 읽기/offer 관측 |
| sameOriginalScope / answerMatchesFixture | true / true: isolated synthetic 요청끼리만 |
| Job counts | 실행 전0 / 새 synthetic A1 / B0 / actual Codex 신규0 |

같은 기기 `Date.now` 밀리초로 이동 확인→committed-state 조회 관측 간격 187ms. GPT latency가 아니다. hold→이동 확인→release→committed-state의 인과 순서는 합성 upstream에서 확보했으나 실제 ChatGPT gate나 실제 SQLite commit 시각을 대신하지 않는다. 임시 `navigation-result.json`의 admittedAt/terminalCommittedAt/exactReadAt 명칭은 이보다 강한 의미라 최종 JSON에서 위와 같이 정규화했다. 원본 임시 파일은 해시와 함께 보존해 정정 경계가 검토 가능하다.

## Sites 최소 시험 및 SITE-1~12

같은 Site를 한 번만 생성, ID `appgprj_6abf89d2d04c8191a617d5193ef5471a`, version1. owner-only backend 검사 후 private deploy succeeded, `has_mcp=false`. normal get_site의 owner metadata는 custom audience/명시 viewer1/external0/groups없음. 이 소유자전용 게시 metadata는 **작성 Agent가 실제 도구 응답에서 관측하여 보고한 사실이며, 독립 원응답 검증은 미실시**다. JSON의 siteFixture는 보고 내용의 정리 위치로서 독립 source가 아니다. HTTP status와 worker digest는 별도로 검증된 범위를 유지한다. 별도 source repository는 무해한 고정 fixture만 담으며 Bridge 소스/프롬프트/결과/계정비밀을 업로드하지 않았다.

첫 save는 hosting.json extra inputs 오류, 둘째는 지원 Worker entrypoint 누락 오류. 마지막은 pushed source `77dff7da2988c5ca2ceed4a2f913a62424741e6c`의 worker bytes를 supported `index.mjs` build output으로 포장하여 save/deploy 성공했다. 소스 worker hash `91d012efd539e2cbf82cdeabe17c654fd0aef1c52ba7bebd5faed144aa0bb006`. internal provisioning의 별도 fixture 저장소에 **로컬 commit3 / push2**를 수행했고 마지막 로컬 commit은 미push 상태다. menaje Bridge 저장소 commit/push/merge는 0이다. 정상 provisioning 허용을 따라 진행했지만 사용자의 commit/push 금지와 혼동될 여지가 있어 별도 변경으로 명시하며 더 push하지 않는다.

### MCP 설정의 작은 추가 확인

호출 가능한 Sites 도구의 공식 schema를 확인했다. 이 schema/MCP 입력 미노출 및 MCP 조회 오류도 **작성 Agent가 실제 도구 응답에서 관측하여 보고한 사실이며, 독립 원응답 검증은 미실시**다. 독립 schema 스냅샷이 없으므로 아래 서술을 독립 원응답 증거로 취급하지 않는다. save_site_version 입력은 archive/commit_sha/project_id, private deploy는 project_id/version_id/(tunnel_bindings), get_site는 project_id/include_mcp_connection이다. create_site의 `enable_plugins`는 workspace connector/plugin **접근(BYOP)** 용이며 Site가 자기 MCP를 노출한다는 설정이 아니다. metadata/env/access update에 MCP 선언 입력이 없다. 배포 후 `get_site(include_mcp_connection=true)`는 **“The published Site does not declare an MCP server. Enable MCP and republish it.”** 오류였다.

[공식 Sites 문서](https://learn.chatgpt.com/docs/sites)는 저장/배포·storage·access 계약을 설명한다. [Site plugin 공식 안내](https://help.openai.com/en/articles/20001547-hosting-a-plugin-with-chatgpt-sites)는 MCP 추가 후 owner 게시, Install/Connect 절차를 안내하지만 확인한 페이지에는 Worker MCP 선언의 기술 설정/최소 샘플이 없다. 로컬 callable package에서도 Sites skill/샘플을 찾지 못했다. 이 작은 확인 범위에서 플랫폼 MCP 선언 방법을 확보하지 못했고 임의 schema를 만들어 재게시하지 않았다. 일반 HTTP/RPC fixture에는 tools/list/read_fixture 코드가 있지만 플랫폼 MCP 선언 부족을 보완한 자산은 아니다. **SITE-1 MCP/plugin 시험은 수행 완료가 아니며, 기술적 불가/host unsupported라고 판정하지 않는다.**

HTTP probe의 `ownerHeaderSupplied=true`는 인증값을 제공했다는 뜻이지 owner 인증을 수락받았다는 뜻이 아니다. 비인증403/owner header401/MCP404는 요청 제한을 관측했을 뿐 인증된 Local→Site push 가능성의 반증이 아니다. 새로운 token 발급·위조·로그 접근·인증 우회를 하지 않았다.

| 항목 | disposition | 결과/정확한 경계 |
| --- | --- | --- |
| SITE-1 MCP/plugin 설치·read-only 도구 | blocked-with-evidence | private 게시만 actual-tested. get_site(include_mcp_connection=true): "The published Site does not declare an MCP server. Enable MCP and republish it." 기존 RPC 코드와 플랫폼 MCP 선언은 다름. 확인한 save/deploy/update 도구에 선언 입력 없음; 공식 문서는 절차만, 기술 샘플 미확보. 자산 부족/확인한 계약 미노출이며 host 미지원 판정 아님. |
| SITE-2 host surface·기기 접근 | blocked-with-evidence | node_repl/browser/CUA callable 없음, AX/screen=false. 설치·Connect UI를 제어하지 못함. Web/desktop/mobile 지원 전반에 대한 부정 결론 아님. |
| SITE-3 UI lifetime·PiP/Panel | blocked-with-evidence | 자체 descriptor의 displayModes 선언은 host 수락 증거가 아님. 인증된 host mount/이탈/teardown 미실행. |
| SITE-4 storage·지속성 | actual-tested | read_database_overview: bindings=[], tables=[], selected=null. 이 fixture의 persistence 미구성만 확인. ingest 반환의 persisted:false는 실행된 결과가 아님. D1/R2 플랫폼 계약과 구분. |
| SITE-5 local → Site 수신 | blocked-with-evidence | 비인증 GET403, 공식 get_site 제공 owner header GET401/POST ingest401. owner 인증 수락이나 fixture 수신 성공 미확인. 인증된 push 가능성의 반증 아님. 임의 인증 우회/재발급 없음. |
| SITE-6 Site → local 명령 | dependency-not-applicable | 이번 자산은 Tunnel/local binding 없음. RPC local_command_probe는 무실행 설계이지만 원격404로 도구가 호출되지 않음. 명령 성공/안전한 실제 거부도 입증되지 않음. |
| SITE-7 Events·원 대화 wake | dependency-not-applicable | SITE-1 설치/호출 경로 미성립. 이벤트 구독·callback를 만들지 않음. 기존 Work Events와 Site receiver를 동일시하지 않음. |
| SITE-8 Site 일정·monitor | dependency-not-applicable | 도구 create_schedule은 있지만 원본 Bridge 호출 권한 경로 미성립. 일정을 만들지 않음. parent E 예약과 별개. |
| SITE-9 identity·original scope | actual-tested | owner role, custom audience, explicitly allowed viewer1, external visitor0, groups 없음 확인. 이 metadata는 Bridge 원본 scope 매핑/권한을 증명하지 않음. |
| SITE-10 security·비밀·접근 | actual-tested | owner-private publish succeeded; anonymous403. 무해한 fixture/metadata만 업로드. 제공 인증 header401은 인증 보호의 완전 검증이 아님. 정책 완화·public share·계정 key 생성 없음. |
| SITE-11 오프라인·재시작·sleep·장시간 | dependency-not-applicable | 핵심 receiver/authority gate 미성립. 공용 Bridge 재시작·기기 sleep·네트워크 차단은 사용자 경계상 미실행. #154 짧은 기존 증거 범위만 재사용. |
| SITE-12 통합 판정·운영 권고 | blocked-with-evidence | 연구 결과의 분리/판정 산출물 완성. end-to-end receiver PASS 아님. Site는 private metadata 게시 단계까지만 actual; R1 채택 근거 부족. |

## 공식 계약과 actual 경계

[Extensions](https://developers.openai.com/plugins/build/extensions)와 [UI guidelines](https://developers.openai.com/plugins/design/ui-guidelines)는 UI surface 비교용 공식 계약이며 actual receiver 판정이 아니다. [MCP Events](https://developers.openai.com/plugins/build/mcp-events)는 Work/dot 계약; 일반 Chat 자동 wake의 증거로 확대하지 않는다. [Automations](https://learn.chatgpt.com/docs/automations) 계약은 E parent metadata와 분리한다. [API background](https://developers.openai.com/api/docs/guides/background)는 H 비교만: 독립 API 실행/유료 호출 없음. 공식 존재와 이 계정의 현재 노출, 설치, 실제 원본 접근 성공은 각각 다르다.

## T1 최소 계측과 반복하지 않을 시험

새 production 계측은 필요하지 않다. 기존 T1 scorer/held HTTP adapter로 local negative/identity 검증은 가능하고 이번 실행도 재사용했다. 최소 보완이 필요하다면 task-only `scripts/issue-222-host-fast-gate.ts:createHeldHttpTrial/report`의 시각 이름을 `runStartedAtMs`/`terminalCommitObservedAtMs`로 좁히고, 실제 host collector가 있을 때 `observeHost`에 출처와 시계를 별도 첨부하는 정도다. 이번에는 기존 파일을 수정하지 않고 JSON에서 정정했다. fake fixture 지연을 바꾸는 것으로 actual model/host gate를 통과시키지 않는다.

핵심 gate 미성립 후보의 10/30/60분은 dependency-not-applicable. #154 짧은 direct-wait/잠금·sleep·재연결, #213 same-scope 실패, #108 teardown과 이번 6/9/3 회귀를 반복하지 않는다. original A 실제 조회·검토 gate 통과 후보가 없으므로 후속 B0. canProceed 데이터를 승인으로 삼지 않았고 approved followup/dedup 계약을 우회하지 않았다. 공용 재시작·전체 sleep·네트워크 차단 시험은 하지 않았다.

독립 Reviewer Job `012acd1c-8f39-4210-96a6-14bc48fdb7f3`가 사실관계와 기존 input hashes20/20·선별 6passed/79skipped·합성 browser9/9·Swift fixture3/3의 일치를 확인했다. 현재 다음 작업은 **reviewer의 exact committed bytes 재확인 후 상위의 결과 게시·#221 반영·통합 및 #222 연구 종료 판정**이며 아직 상위 수행대기다. 이후 별도 actual host 수락시험을 선택한다면 공식 controller/로그인된 시험 대화 및 독립 read-only Codex 로그인 필요. 사용자 동작은 A 실행 중 원 대화 이탈, 추가 메시지 없이 대기까지이며 원본 scope를 collector가 비식별 비교해야 한다. Install/Connect/권한승인 UI는 우회하지 않는다. 이번에는 추가 시험을 시작하지 않는다.

## #221/#223에 전달할 문안 (미게시)

#221: “receiver 기본권한·Job policy snapshot을 유지한다. direct-wait는 진행 중 GPT turn의 exact bounded 조회/결과 검토 경로로만 설명하고, 종료/이탈 후 자동 새 wake는 보장하지 않는다. 동일 원 대화에서 explicit manual exact Job 복구를 안내한다. inline/PiP/Panel/Events/monitor의 일반 Chat R1은 실제 origin route와 exact authority gate 통과 전 채택하지 않는다.”

#223: “owner-private Sites 생성·게시 metadata는 확인했으나 이번 fixture의 플랫폼 MCP 선언/설치·runtime 인증 수신·storage·Site→local 명령·original Chat wake·Bridge 원본 권한은 성립하지 않았다. 이 자산 부족과 agent 접근 제약을 플랫폼 미지원으로 일반화하지 않는다. Sites backend 생존을 UI receiver/영속 inbox/권한 연속성과 동일시하지 않으며 Tunnel/OAuth/scope 경계를 제거하지 않는다. control plane 구현을 이번 연구 범위에 포함하지 않는다.”

## 수락 기준·정리·검증

연구 종료 조건과 actual receiver 제품 채택 조건을 분리한다. **테스트 이슈의 연구 종료는 제품기능 성공을 뜻하지 않는다.** 원 #222의 연구 조건은 실제 사용가능 항목의 시험 또는 공식·기술적 실행불가 사유 기록이다. 이번 환경의 제어/인증 차단 및 확인한 문서계약 미노출은 그 환경·확인 범위의 기록이며 전역불가능의 증명이 아니다. reviewer는 아래 보완과 상위 결과 게시/#221 반영을 조건으로 연구 종료 가능하다고 판단했으며, 새 actual 시험을 요구하지 않았다. 원 이슈 본문/체크박스는 변경하지 않았다.

| 연구 종료 조건 | 상태 | 근거 |
| --- | --- | --- |
| 실제 사용가능 항목 시험 또는 공식·기술적 실행불가 사유 기록 | 연구 범위 기록 충족 | 가능한 짧은 회귀/HTTP 시험 수행, blocked/N/A의 환경·계약 경계 기록; 전역불가능 아님 |
| evidence층 분리 | 충족 | actual/재사용/합성/공식 계약/parent 보고/작성 Agent 보고 구분; 독립 원응답 미검증 명시 |
| Chat/Work/dot 구분 | 충족 | 일반 Chat 미검증, #154/#213 actual Work 재사용, dot은 공식 계약만 |
| A~I 및 SITE-1~12 비교표 | 충족 | 전 항목 disposition과 Observe/Wake/ongoing turn/route/authority 분리 |
| 권고 조합 1개 | 충족 | direct-wait + 원 대화에서 명시적 수동 exact Job 복구 |
| #221 반영 | 상위 수행대기 | 문안만 작성; 결과 게시/#221 반영은 아직 미실행. #223 경계 문안도 미게시 |
| 미래 재검토점 | 충족 | 공식 receiver/host 제어·원본 권한 계약 변화 시 재판정, 현재 제약 일반화 금지 |
| 결과 게시·이슈 종료·Git 통합 | 상위 수행대기 | reviewer의 exact committed bytes 재확인 후 상위 결정; 현재 완료 아님 |

| actual receiver 제품 채택 조건 | 상태 | 근거 |
| --- | --- | --- |
| strict actual general Chat: 실행 중 이탈→완료→추가 사용자 입력 없는 재개→exact 원본 A 검토 | 미충족 | host controller·독립 로그인 경계, actual 새 A0; 연구 종료와 독립 |
| 장시간/후속 B/전체 기기 장애 확장 | dependency-not-applicable | 첫 원본 조회 gate 미통과·서비스 방해 금지 |
| 원본 권한 및 모델·추론·usage 연속성 | 미검증 | scope 우회 없음; UI/backend 생존으로 추정하지 않음 |

독립 검토용 raw evidence는 task-owned local source/ignored output에 보존하며 원문 로그·민감정보는 commit하지 않는다. private Site는 아래의 정리 미완료 한계를 유지한다.

isolated HTTP/SQLite와 navigation 서버는 finally 종료·임시 상태 정리, 이번 Playwright session close, 무응답 AppleScript의 이번 소유 PID만 종료했다. 기존 서비스/작업은 중단하지 않았다. root 새 subscription/schedule0, parent E schedule은 parent 보고상 disabled. 정상 provisioning credential temporary config는 삭제, 감사/대화/commit에 비밀값 없음. 정상 제공값의 in-memory 복사도 제거했다.

Site는 owner-only 무해한 자산으로 **남아 있다**. 호출 가능한 Sites에 삭제/unpublish가 없어 cloud resource 정리는 미완료이며 public 공유로 전환하지 않았다. 리뷰 worktree 및 source/ignored output은 독립 검토를 위해 보존한다. 시험 단계의 Bridge Git 커밋/푸시/머지·GitHub 이슈 변경0, production 파일 변경0 기록은 유지한다. 이번 문서 보완 단계는 감사 두 파일의 연구 branch commit만 허용하며 merge/push/GitHub 이슈 변경은 하지 않는다. dev 통합과 branch/worktree 정리는 상위 수행대기다.

최종 JSON consistency/privacy/상대 링크/whitespace 검증 및 docs-only affected 검증 결과는 아래 검증 기록과 JSON validation에 반영한다. 기존 T1의 broad 실패나 다른 자산의 검증 성공을 이번 파일의 전체 제품 PASS로 대체하지 않는다.

### 최종 검증 기록

`npm run validate:affected -- --base 30919ee1e1b9461216db289a5a69876079efb92e` (task-local CLI0.153.3 PATH): exit0, 정확히 감사 2 paths, Node=false/macOS=false. localization/release manifest/release policy 및 App Server schema(416 JSON/827 TypeScript) 일치. 최종 문서 bytes에 다시 확인했다.

JSON/Markdown semantic 검사: 후보 A~I9, SITE1~1212, disposition enum, source 존재, actual/synthetic 분리, E 정확 시각·미확인 권한, Site401/404·MCP 자산 부족, navigation 시계 null 한계, 상대 링크, input hash, privacy patterns 및 whitespace 통과. Git 신규 파일 whitespace 검사 통과. 명령 exit와 검사 증명은 `output/issue-222-research/final-validation.json`/`docs-affected-final.log`에 보존한다. 파일 최종 SHA256/byte는 그 외부 검증 증명에 기록해 자기 해시 순환을 피한다.

### 독립 검토 지적 보완 검증

P2는 Site 게시 metadata와 MCP schema/오류를 작성 Agent 도구응답 관측 보고로 한정하고 독립 원응답 검증 미실시를 명시했다. P3는 연구 종료 조건과 제품 채택 조건을 분리했으며 게시/#221 반영/이슈 종료/통합은 상위 수행대기로 표시했다. 원 6passed/79skipped(선별실행), 합성 browser9/9, Swift fixture3/3, HTTP status와 worker digest는 변경하지 않았다. 새 시험·계정/로그/네트워크 조회 없이 감사 두 파일의 docs-only affected 및 일관성/링크/비밀 pattern/whitespace 검증을 수행한다. 최종 파일 SHA256/행수와 commit SHA는 커밋 후 handoff로 반환하며 이 문서에 자기 commit SHA를 삽입하지 않는다.
