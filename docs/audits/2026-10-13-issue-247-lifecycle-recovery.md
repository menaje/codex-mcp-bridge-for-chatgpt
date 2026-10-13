# #247 W2/W3 Worker 인계 — lifecycle 수신·복구

최신 #247 본문의 실제 재개·A→검토→B 실환경 확인 제외 결정과
[갱신한 W0~W5 계획](../issue-247-implementation-plan.md)을 적용했다.
그 시험과 모든 지속시간/soak/축약 대체 시험은 수행하지 않았고 완료 대기
조건으로 두지 않는다. 이전 9b126dac의 안내 보완에서 더 나아가 Bridge의
수신 연결·input 전달·복구·중단·수명 코드와 결정적 검사를 구현했다.

## 식별과 작업 상태

- 원본: `/Volumes/Data/Dev/codex-mcp-bridge`
- 작업 worktree: `/Users/seongsik/Documents/Codex/2026-10-13/task/codex-mcp-bridge-issue-247-w1`
- 브랜치: `codex/issue-247-recovery-lifecycle`
- 기준선: `9b126dace7512113b2c50560fd162d5fd0756418` (`dev == origin/dev` 재확인)
- Node: `v24.11.1`, Vitest: `4.1.11`
- 이번 고정 커밋의 SHA는 최종 인계와 `git rev-parse HEAD`로 확인한다.
- 이번 새 변경의 dev 통합/푸시는 하지 않는다. 부모가 고정 SHA의 독립
  검토 후 통합 여부를 결정한다. 기존 worktree/브랜치/독립 검증 자료를 보존한다.

## 실제 변경과 재사용

새 OAuth opt-in 서버 사건 `codex.job.lifecycle`를 기존 native Events API와
`codex_event_access`에 추가했다. 별도 호스트 API나 대화 scope를 만든 것이
아니다. exact root Events Job의 원래 OAuth principal/scope/Activity/Agent/
project와 이후 같은 소유 범위의 Events Job에 수신을 제한한다. 기본
terminal-only reference는 기존 범위를 유지하고 lifecycle reference로
사용할 수 없다. 이 명시적 consent는 monitoring만 허용한다.

`src/mcpEventStore.ts`와 기존 `bridge_meta` 전달 원장을 사용해 B waiting
레코드, input/terminal event ID 및 복구 상태를 저장한다. B 접수와 수신
레코드는 같은 Job UoW에 포함된다. root의 검증된 callback과 finite expiry를
재사용하며 B grant/Job/실행을 새로 생성하지 않는다. late subscribe와 native
refresh 및 startup는 indexed result-free source snapshots에서 누락을 회수한다.
서로 다른 requestId는 합치지 않고 canonical receipt/exact retry를 유지한다.

input intent는 현재 질문 상태와 함께 커밋하고 질문 텍스트/답변/승인/비밀을
callback에 넣지 않는다. 같은 질문의 progress-only version 변경은 중복
사건이 아니며, 해소/교체된 질문과 같은 트랜잭션에서 해소된 intent는
재전송/준비 신호를 만들지 않는다. 원본 DB 커밋보다 앞선 registry 관측으로
새 intent를 만들지 않는다. 기존 current questionRef/owner/uncertain answer
보호 코드는 그대로 사용한다.

native subscription/key refresh는 root/derived 레코드를 같은 UoW에서 갱신해
이전 ACK가 새로운 사건이나 중단 상태를 덮어쓰지 못하게 한다. root revoke/
unsubscribe는 파생 전달을 차단하고 exact child revoke는 해당 child만
차단한다. Activity complete/verification-passed/cancel/abandon은 그 목표의
receiver를 닫는다. 개별 Job 종료나 callback ACK는 목표 완료가 아니다.

기존 subscription capacity를 유지한다. capacity로 새 child intent를 저장할
수 없으면 실제 Job/result를 롤백하지 않고 `recoveryPending` /
`delivery_capacity`를 남긴다. 복구 marker는 최신 root 레코드를 사용해
이미 저장된 사건을 덮어쓰지 않는다. 새로운 MCP event-ready 알림은 실제
pending intent의 outer commit 뒤에만 발생하며 rollback/해소/중단은 제외한다.

`src/mcpEventAccess.ts`, `src/mcpEvents.ts`, `src/nextActions.ts`,
`src/server.ts`, `src/tools.ts`의 계약·권한·설명을 갱신했고
`src/stateStore.ts`에 indexed result-free reads와 commit/종료 hook을 추가했다.
task input 6/output 4, SQL schema/migration, ordinary direct-wait 기본값,
scope resolver, execution admission 및 question answer journal은 변경하지 않는다.

## 수락 매핑

| 최신 구현 항목 | 결과/근거 | 제한 |
| --- | --- | --- |
| UI 없는 최초 등록/인계 | 기존 durable admission + 명시적 lifecycle root native API | 일반 Chat Pro를 실제 실행하는 호스트 API는 제공되지 않음 |
| 원래 도구 권한·원본·후행 접수 | 기존 scope/principal/result offer/reviewedVersion/payload 및 receipt 검사 유지 | monitoring ref는 ordinary read/task/answer 권한이 아님 |
| A 이후 B 수신 연결·응답 유실 | Job과 waiting receiver 같은 UoW, canonical/ordinary 두 OAuth HTTP 검사 통과 | 같은 Activity/Agent/project의 Events opt-in chain; 다른 Agent에는 별도 consent |
| 등록 전 완료·restart 누락 회수 | retained indexed source에서 stable event/receiver 복구 | bounded 기존 journal capacity와 finite retention 적용 |
| 중간 input·불확실 answer | source/input intent 원자성, exact query, stale/해소 사건 제거; 기존 answer 보호 검사 통과 | actual host resume/질문 처리 관측을 주장하지 않음 |
| 구독·위임·인증 수명 | native refresh/root revision/key propagation, original-scope delegation 회수/재발급 | OAuth token/native refresh는 호스트 책임; Bridge가 계정 권한을 만들지 않음 |
| 중단·전체 종료 | goal closure 및 root/child revoke/unsubscribe, 늦은 ACK 차단 | explicit final-review decision의 Activity API 사용; ACK 자체는 검토 아님 |
| #242 비용/격리 | dedicated commit-ready signal, result-free indexed reads, 다른 consent 보존 검사 | full-state progress polling이나 새로운 범용 엔진 없음 |
| 모델/문맥/사용량 | 미확인 호스트 지원 범위를 계획에 기록 | Codex/Work/dot/API로 일반 Chat Pro 조건을 대체하지 않음 |
| W4/W5 | 고정 커밋 독립 검토용 인계 | 새 변경 dev 통합/푸시는 부모 승인 전 대기 |

## 실제 검사 결과

총 81개 서로 다른 기능/회귀 검사 통과 및 `npm run build` exit 0이다.
source-only guard 보완 이후 영향받는 14개 lifecycle module 및 2개 OAuth
HTTP 검사는 다시 통과했다. 광범위 suite, 실환경 GPT 재개/후행 시험,
duration/soak/clock acceleration/expiry 축약 시험은 실행하지 않았다.

| 검사 | 결과 | 로그 (`output/issue-247-recovery/`) |
| --- | --- | --- |
| 새 lifecycle module | 14 passed | `lifecycle-tests-final.txt` |
| output/guidance/ordinary profile/summary | 43 passed | `contracts-unit-tests.txt` (그 실행에는 당시 lifecycle 13개도 포함) |
| 기존 exact followup/input | 10 passed | `followup-input-regression.txt` |
| OAuth HTTP lifecycle 2 + 기존 권한/ACK/출력 3 | 5 passed, 41 skipped | `oauth-regression.txt`; 영향 검사 재실행은 `lifecycle-http-tests-final.txt` |
| 기존 terminal UoW/race | 4 passed, 45 skipped | `terminal-regression.txt` |
| #242 commit-ready/empty-writer/bounded-drain | 4 passed, 1 skipped | `ready-signal-regression.txt` |
| pre-send/restart answer | 1 passed, 2 skipped | `presend-regression.txt` |
| build | exit 0 | `build.txt` |
| output JSON schema budget | 54,658 bytes; largest 16,732 | 64,000/18,000 제한 및 관련 검사 통과 |
| diff check | exit 0 | 최종 Git 확인 |

초기 검사에서 fixture 완료 저장의 projectName 누락과 재시작 전 writer
lease 미종료를 수정했다. HTTP 검사에서 발견한 B의 첫 사건 이전 waiting
receiver 누락도 admission UoW에서 보완했다. 최종 검사 실패는 없다. 초기
실패 로그는 작업 output에 보존했다. 실제 계정 grant나 운영 DB를 사용한
검사가 아니다.

## 독립 검증 명령

아래는 이 작업 worktree에서 실행한다. HTTP fixture/tsx는 이 실행기의
sandbox에서 로컬 socket 허용이 필요했다. npm의 광범위 `test/check`는
지속시간 사례를 포함하므로 사용하지 않는다.

```sh
cd /Users/seongsik/Documents/Codex/2026-10-13/task/codex-mcp-bridge-issue-247-w1
export PATH=/Users/seongsik/.nvm/versions/node/v24.11.1/bin:/usr/bin:/bin
git rev-parse HEAD
git diff 9b126dace7512113b2c50560fd162d5fd0756418..HEAD --check
npm run build
node node_modules/vitest/vitest.mjs run test/issue247Lifecycle.test.ts test/outputContracts.test.ts test/toolGuidance.test.ts test/issue221Profiles.test.ts test/issue221Summary.test.ts --maxWorkers=1 --reporter=verbose
node node_modules/vitest/vitest.mjs run test/issue247Followups.test.ts test/questionOrchestration.test.ts --maxWorkers=1 --reporter=verbose
node node_modules/vitest/vitest.mjs run test/mcpEventDelegation.test.ts -t '#247 lifecycle|delivers exact A then exactly one preapproved B without Dashboard or ui/message|cannot authorize ordinary result reads, tasks or configuration through a subscriptionRef|never treats fixture canProceed output as a followup approval' --maxWorkers=1 --reporter=verbose
node node_modules/vitest/vitest.mjs run test/mcpEvents.test.ts -t 'subscribes before completion and commits result plus delivery intent atomically|rolls back a terminal result and its delivery intent together after a storage failure|preserves unsubscribe while another webhook is in flight|preserves delivery progress during subscription verification' --maxWorkers=1 --reporter=verbose
node node_modules/vitest/vitest.mjs run test/issue242Completion.test.ts -t 'emits readiness only after the outer durable commit|has zero empty writer transactions|drains 25 durable completions|carries epoch and per-topic revision' --maxWorkers=1 --reporter=verbose
node node_modules/vitest/vitest.mjs run test/questionStore.test.ts -t 'persists proven pre-send rejection and retries only the identical request after restart' --maxWorkers=1 --reporter=verbose
```

## 남은 실제 의존성과 보존

원래 일반 Chat Pro 대화를 최초 응답 종료 후 추론/도구 실행으로 재개하고
원래 MCP scope·모델/추론/문맥·사용량을 이어 주는 공식 API/대상 참조가
현재 제공되지 않았다. 그 호스트 연결은 구현하지 못했으며 가짜 API,
scope 별칭이나 권한 완화로 채우지 않았다. 이는 실환경 시험을 실행하지
않은 것과 구분되는 실제 API 의존성이다. Bridge의 독립 기능은 그 시험을
기다리지 않고 구현·검사했으며 사용자 실사용 확인을 대기 조건으로 두지 않는다.

운영 앱/설치본/DB/설정/실제 자격증명을 변경하지 않았고 Bridge 도구나
새 Job, 추가 에이전트, 이슈 게시/상태 변경, 새 dev 통합/푸시, 영구 삭제는
수행하지 않았다. root consent는 코드 계약과 fixture에서만 생성했다.
작업 브랜치·worktree·기존 9b126dac 자료와 새 build/검사 output을 보존한다.
