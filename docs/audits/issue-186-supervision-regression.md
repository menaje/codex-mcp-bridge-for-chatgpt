# #186: 감독 정책 회귀와 설치 번들 검증

검토 기준은 `dev`의 PR #187 병합 커밋
`bd3621e38ae8d7bc0785c972238ccf7afe51620a`이다. #185 구현이 먼저 병합되어
#186의 실행 정책 수정도 이미 포함됐다. 이 작업은 그 수정을 유지하고,
변경 이력·관측 오류 분류·장시간 장애·실제 worker 손실·설치 번들의 증거를
추가한다. 새로운 감독 서비스나 운영 장애 주입 스위치를 추가하지 않는다.

## 1. 실제 코드로 확인한 변경 이력

| 기준 | 실행/감독 구조 | 종료 및 정리 판단 |
| --- | --- | --- |
| #150 직전 `3d660b3d5aa9a6717eac2b098e96872e96c0a158` | `executionRuntime.ts`가 state 프로세스 안에서 `CodexAppServerUpstreamPool`을 직접 생성. 별도 `executionServiceProcess.ts` 없음 | 현재의 공유 executor 관측 실패 → 종료 경로가 아직 없음. 프로세스 격리가 없었던 것이 바람직하다는 뜻은 아님 |
| #150 `ab760afab04e639c43baff09d021bb2217b8ec23` | 별도 executor, bounded IPC, heartbeat 250ms, state/DB와 실행 분리 | heartbeat가 10초 이상 오래되면 watchdog이 executor에 SIGKILL. startup 20초에도 종료 경로 존재. child IPC disconnect는 pool close로 연결 |
| #152 `8fa48c28ec39acbd43fd3c5d9b98b3ec75be9003` | 직접 생성한 worker PID/PGID를 등록, executor 손실 후 잔존 worker 정리 | `onExit → queueWorkerCleanup → cleanupRegisteredWorkers → scheduleRestart`. 정리 확인 전 executor 교체를 보류하지만 별도 그룹의 descendant 보장이 부족 |
| #155 `50b115c24bd4c254609ee6c6ff959a44710b9821` | 부모·자식 process-tree ledger와 250ms 관측, progress/명령 시작 시 추가 관측, 등록/정리 ACK | 부모 관측 실패는 executor SIGKILL, 자식 주기 관측 실패는 `process.exit(1)`. 관측 불확실성을 실행 중단으로 바꾼 직접 회귀 지점 |
| #184 `cb052932c5813b1b313077d54b323225889010b3` | ps 상한 3초, 일시 오류 재시도와 pause 보완 | 일시 실패의 즉시 종료는 완화. 관측/정리 전역 접수 제한, heartbeat와 일부 오류의 전체 종료 경로는 남음 |
| #185/#187 `bd3621e38ae8d7bc0785c972238ccf7afe51620a` | 단일 2초 보조 관측, 실행/관측/연결 상태 분리, 재접속 가능한 기존 실행 소유자 | 관측 실패·heartbeat 누락에 종료 권한 없음. 불확실한 정리는 해당 worker 슬롯을 예약. 확정 exit와 명시적 취소는 원래 범위에서 처리 |

확인에 사용한 원본:

- [#150 직전 실행 생성](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/blob/3d660b3d5aa9a6717eac2b098e96872e96c0a158/src/executionRuntime.ts)
- [#150 실행 서비스](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/blob/ab760afab04e639c43baff09d021bb2217b8ec23/src/executionServiceProcess.ts)
- [#152 worker 정리](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/blob/8fa48c28ec39acbd43fd3c5d9b98b3ec75be9003/src/executionServiceProcess.ts)
- [#155 부모 관측 실패](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/blob/50b115c24bd4c254609ee6c6ff959a44710b9821/src/executionServiceProcess.ts#L980), [자식 관측 실패](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/blob/50b115c24bd4c254609ee6c6ff959a44710b9821/src/executionServiceProcess.ts#L1232)
- [#184 보완](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/blob/cb052932c5813b1b313077d54b323225889010b3/src/executionServiceProcess.ts)
- [현재 종료 권한 및 자원 상한](issue-185-execution-lifetime.md)

운영 장애의 촉발 요인은 `ps` 지연, 중단 결정의 원인은 관측 실패를 종료 권한으로
사용한 정책, 피해 확대의 원인은 공유 executor 전체 종료로 구분한다.
#182의 2026-09-26 13:03:17 KST 사례가 그 경로의 운영 근거다. #159나 DB 병목이
모든 과거 손실의 원인이라고 추가로 추정하지 않는다.

## 2. 현재 권한과 범위

- `processTreeSupervisor.ts`의 3초 제한은 보조 **ps 프로브 자체**의 자원 상한이다.
  프로브를 끝내는 SIGKILL과 Codex executor를 종료하는 신호를 혼동하지 않는다.
- `executionServiceProcess.ts`의 관측 catch는 진단 사건만 갱신한다. 재시도 횟수나
  경과 시간에 따라 나중에 공유 executor를 종료하는 분기가 없다.
- heartbeat 최신성은 별도 `heartbeatStatus`, 관측은 `observationStatus`, 연결은
  `connectionStatus`로 표시한다. `ready`는 접수 상태이며 현재 Job 성공이나
  실행 생존의 확정 증거가 아니다. `inFlight`도 요청 수이지 장애 판정이 아니다.
- 실제 worker 손실은 그 worker의 turn만 정산한다. 정리 중인 슬롯은 교체하지 않고
  정상 worker와 확인된 별도 용량은 처리한다. 기존 thread/Agent/workspace 충돌 및
  admission 정책과 bounded request/receipt 한도는 유지한다.
- 실제 executor 손실 뒤에는 잔존 트리를 정리한 후 replacement한다. 명시적 앱 종료의
  종료 절차는 유지한다. 프로토콜 결과 없이 Job 성공을 만들어 내지 않는다.
- PID/PGID와 시작 시각으로 정리 대상을 확인한다. 관측 전 분리·재부모화된 임의의
  자식까지 모두 추적하거나 커널 수준의 원자적 PID 재사용 방지를 보장하지 않는다.

## 3. 재현 가능한 검증

| 종류 | 실행 명령/대상 | 검증 내용 |
| --- | --- | --- |
| 관측 오류 분류 | `test/executionRecovery.test.ts` | ps timeout, spawn ENOENT, 비정상 exit, 출력 상한, 잘못된 테이블, 잘못된 UTF-8 각각 진단 분류 확인. 장애가 유지되는 동안 기존 turn과 독립 신규 turn 완료 및 steer 가능 |
| heartbeat만 누락 | 같은 테스트의 heartbeat case | 프로토콜은 정상인 채 이전 10초 기준을 넘겨 heartbeat만 누락. 동일 executor, 기존/신규 결과 유지 |
| 실제 worker 하나 종료 | `test/executionServiceProcess.test.ts` | worker A SIGKILL, 관측된 detached descendant 정리, worker B 및 독립 작업 완료. 정리 후 A 세대 교체, 같은 실행 자동 재시작 없음 |
| 등록/정리 불확실 | `test/workerIsolation.test.ts` | A 등록 실패와 정리 보류 중 B 질문 처리, 여유 C 접수, A 슬롯 예약 유지 |
| 실제 executor 종료 | 기존 `test/executionServiceProcess.test.ts` 및 `test:issue-142-state-execution-isolation` | 실제 손실 처리, descendant 정리 후 교체, 중복 실행 0, state/DB 경계 보존 |
| 장시간 관측 장애와 복구 | `npm run test:issue-186-observation` | 기본 90초 동안 연속 child ps timeout. 3 workers/7 Jobs, 질문·steer·명시 취소·신규 독립 접수를 장애 도중 검증. 같은 Job/thread/turn/generation으로 관측 회복 후 완료 |
| 부모 주기 관측 제거 | 위 통합 시험 | 부모와 자식 모두 계측. parent만 실패하도록 설정한 구간을 포함해 정상 실행 중 부모 process-table probe가 0회임을 검증. 제거된 경로를 실제 실패시켰다고 보고하지 않음 |
| 재시도 자원 | 위 통합 시험 | 동시 process-table probe 1개, 2초 주기 대비 유한한 시작 횟수, 실행 소유자의 CPU/RSS 표본과 증가량. 일반 진행 중 무한 큐·busy loop·프로브 프로세스 누적 없음 |

장시간 시험은 시작부터 끝까지 기존 Job 하나를 유지한다. 그동안 다른 기존 Job의
질문 응답과 steer 결과를 회수하고, 새 Job 두 개를 독립 접수·완료한다. 별도 Job의
명시적 취소는 정확한 turn만 중단한다. 관측 복구 후 마지막 원래 Job을 완료한다.
모든 request에 대해 DB Job 수와 fixture의 실제 `turn/start` 수를 대조한다.

```sh
# Source: 기본 장애 구간 90초
npm run test:issue-186-observation

# /Applications에 설치된 실제 JS 모듈, 별도 임시 DB/CLI fixture
CODEX_TEST_BUNDLE_DIST='/Applications/Codex MCP Bridge for ChatGPT.app/Contents/Resources/Runtime/dist' \
  npm run test:issue-186-observation
```

`CODEX_TEST_OBSERVATION_OUTAGE_MS`는 재현 시간을 30초~10분으로 조절하는 테스트 전용
옵션이다. 완료 증거에는 실제 사용한 시간을 기록한다. 짧은 smoke 실행을 기본
90초 시험으로 기록하지 않는다. `execution-faults.mjs`는 테스트에서만 preload하며
설치 파일이나 운영 환경 변수에 장애 옵션을 저장하지 않는다.

최종 수치와 설치 빌드 식별자는 #186/구현 PR의 완료 기록에 남긴다. 유한한 90초
주입과 코드상 종료 분기 부재를 함께 근거로 사용한다. 장시간 실제 사용자 부하나
물리적 잠자기/복귀를 검증했다고 주장하지 않으며 운영 Job에는 장애를 주입하지 않는다.
