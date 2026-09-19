# #137 exact Job status wait 검증 — 2026-09-19

관련 이슈: [#137](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/137),
[#126](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/126),
[#28](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/28)

## 결론

exact Job의 `change`와 `terminal` 대기 신호를 분리했다. terminal wait는
`completed`, `failed`, `interrupted`, `cancelled` 전이에만 resolve하며 일반
progress/version 증가는 terminal listener를 호출하지 않는다. 대기 중 상태
확인은 in-memory Job map을 사용하므로 progress wake마다 `get() ->
pruneAndPersist() -> project identity refresh`를 반복하지 않는다.

model-visible exact status wait 기본값은 55초에서 20초로 줄였다. 60초 상한과
Codex Job 실행 수명은 바꾸지 않았다. timeout과 host abort는 read request만
끝내며 cancellation intent, `jobs.cancel`, upstream interrupt를 만들지 않는다.
Dashboard의 8초 watcher와 model-visible watcher는 동일한 lifecycle signal을
사용하되 각각의 bounded request와 delivery 계약을 유지한다.

운영 진단에는 다음 bounded 집계를 추가했다.

- exact status wait 총수, `change`/`terminal`, model/Dashboard/internal source
- waited latency, timeout, host abort와 durable `status-wait-aborted` 보존 수
- progress/terminal/state-change wake 수
- Job별 active waiter 및 model/Dashboard waiter 수
- `pruneAndPersist`와 public telemetry transaction latency

prompt, result, cwd 같은 민감 데이터는 계측하지 않는다.

## 결정적 고밀도 회귀

`npm run test:issue-137-status-wait`는 하나의 persistent Job에 model-visible
terminal waiter와 Dashboard terminal waiter를 동시에 연결한 뒤 public
progress event 100개를 기록한다. 2026-09-19 로컬 실행 결과는 다음과 같다.

| 관측 | 결과 |
| --- | ---: |
| public progress events | 100 |
| terminal waiters | 2 |
| progress-triggered terminal wakes | 0 |
| terminal-triggered wakes | 2 |
| progress 구간 project-identity reads | 0 |
| telemetry transactions | 100 |
| telemetry p50 / p95 / max | 0.317 / 0.521 / 1.161 ms |
| `pruneAndPersist` p50 / p95 / max | 0.022 / 0.051 / 0.051 ms |
| terminal 뒤 active waiters | 0 |

latency 수치는 해당 로컬 실행의 관측값이며 제품 threshold로 고정하지 않는다.
회귀의 필수 불변식은 progress wake 0, progress 구간 identity read 0, terminal
wake 2, 종료 뒤 active waiter 0이다.

## 단위·통합 경계

`test/jobRegistry.test.ts`가 다음을 고정한다.

- terminal waiter는 progress 100회에 깨어나지 않고 timeout 뒤 Job은 running이다.
- change waiter는 progress version 변화에 즉시 resolve한다.
- model-visible watcher와 Dashboard watcher는 progress 동안 각각 하나의 active
  waiter로 유지되고 terminal 전이에서 한 번씩 resolve한다.
- aborted exact wait는 `jobs.cancel`을 호출하지 않고 동일 Job이 이후 정상
  완료된다.
- public event 100회의 telemetry transaction 수와 maintenance latency가
  diagnostics에 나타난다.

`test/tools.test.ts`는 실제 Streamable HTTP 요청을 abort해 durable
`status-wait-aborted / host-aborted-read-wait` observation이 한 건 기록되고,
Job의 `status=running`, `cancelRequestedAt` 미설정 상태가 유지된 뒤 같은 Job이
정상 완료됨을 확인한다. 이 경로는 Issue #28의 transport abort와 cancellation
provenance 분리를 유지한다.

#126의 completion lease, receipt, result-offer 경계는 변경하지 않았다. 기존
live-card 브라우저 회귀를 함께 실행해 exactly-one card claim/send 계약을
재검증한다.

## 자동 검증

| 검사 | 결과 |
| --- | --- |
| `npm run check` | 88 files / 787 tests PASS |
| `npm run test:issue-137-status-wait` | 100 progress / 2 concurrent terminal waiters PASS |
| `npm run test:issue-126-live-card` | 8/8 browser scenarios PASS |
| `npm run app-server:compat:check` | CLI 0.153.3, 416 JSON / 827 TypeScript schema PASS |
| release/localization/build 검사 | PASS, active change fragment 12개 |

## 실제 host 검증 경계

사용자 지시에 따라 수정 빌드로 macOS 앱·Bridge·Tunnel을 재시작하거나
ChatGPT connector를 Refresh하지 않았다. 따라서 이 문서는 수정 코드에 대한
새 live-host acceptance를 주장하지 않는다. 이슈에 기록된 기존 실행 환경
관측(`0.155.0-alpha.9`, compatible)은 문제 재현의 기준일 뿐 이 변경의 배포
증거가 아니다.

20초 기본값은 제안 범위 15~25초 안에서 선택했고 기존 60초 host 경계와
충분한 여유를 둔다. 다음 실제 배포 시 progress-heavy Job, live Dashboard,
foreground/background, reconnect 조합의 host acceptance를 별도 기록해야 한다.
이 배포 검증 유보는 소스·테스트 완료와 구분한다.
