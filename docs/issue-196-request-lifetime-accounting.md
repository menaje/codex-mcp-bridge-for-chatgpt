# #196 요청 수명별 용량 회계

## 기준과 판정

PR #201 당시 검토 기준은 `origin/dev`의 `e068a45ab9f6`(state schema 29, package 0.4.1)이다. 아래 후속 보완은 #200 통합 커밋 `3555bd392d2c`를 기준으로 한다. 이 문서는 격리된 제품 경로와 기존 회귀로 확인한 사실만 기록한다. 운영 중인 앱이나 실제 ChatGPT 터널을 교체하거나 장애 주입하지 않았다.

실행 사실은 [#200 책임 계약](execution-authority-and-evidence.md)의 정확한 App Server 사건과 실행 소유자 근거를 따른다. 아래의 프로세스 로컬 카운터나 DB `running` 행은 실제 turn의 생존·종료를 판정하는 근거가 아니다. 이 문서의 범위는 그 실행을 둘러싼 자원 예약·반환과 필수 제어의 통로다. #200의 공통 inventory·표시 변경은 PR #202로 `dev`에 먼저 통합됐다.

| 경계 | 이미 충족된 부분 | 확인된 공백과 이번 보완 |
| --- | --- | --- |
| 정확한 Job 대기 | `CodexJobRegistry.wait()`/`waitForInput()`은 짧은 `get()` 뒤 메모리 listener/timer로 대기한다. 대기 중 DB 트랜잭션과 실행 RPC를 붙들지 않는다. #137 회귀가 진행 이벤트와 terminal wake의 차이를 검증한다. | stdio 경로에는 동시 listener 총량 한도가 없었다. change/terminal/input이 공유하는 128개 상한을 추가했다. 즉시 exact 조회에는 이 대기 슬롯을 쓰지 않는다. |
| HTTP/MCP ingress | 전체 128건, 기존 일반 프록시 112건, 본문 8 MiB, 프록시 본문 32 MiB, 요청 ID capture 40 MiB 상한과 종료 정리가 있다. | 기존 16건 잔여 슬롯은 MCP 필수 제어가 사용할 수 없었다. 완성된 작은 JSON-RPC 본문에서 허용된 실제 tool/method를 확인한 후 그 슬롯에 들인다. 일반 프록시 바이트를 24 MiB로 제한해 8 MiB를 필수 제어에 남긴다. |
| native companion | `ChangeSignal`은 변화 대기 listener 4개와 25초 상한을 유지하고, 소켓당 요청·응답 바이트를 제한한다. | 소켓 8개가 일반 처리로 점유되면 완료 전달 ACK도 접속할 수 있었다. 물리 소켓 16개 중 일반 실행은 8개로 제한해 완료 ACK·복구 제어의 접속 기회를 남긴다. |
| runtime native RPC | `pending → abandoned` 뒤에도 실제 하위 응답이나 프로세스 종료 전까지 전체 예약을 유지한다. | 일반 native 호출도 128개를 모두 점유할 수 있었다. 일반 요청은 120개에서 멈추고 8개를 기존 control 메서드와 검증되는 `retry-stop`에 남긴다. |
| read child | 요청 16건과 메시지 8 MiB 상한. 관측 deadline은 caller 결과만 종료하고 `abandoned` 항목은 물리 응답/child 종료까지 `pending`에 남는다. | 새 코드 변경 불필요. |
| execution owner | 요청 128건, control 16건, 요청 바이트 32 MiB 중 control 8 MiB를 예약한다. `pendingBytes`는 ACK 후 reply 해제 또는 owner 종료 때 반환한다. | 새 코드 변경 불필요. |
| 실행 결과·불확실성 | journal의 execution/inspection/metadata/control lane은 각각 30/8/8/6건. retained 결과는 DB terminal commit ACK 전 삭제하지 않고, 늦거나 중복된 ACK는 동일 request ID로 처리한다. owner 재시작 시 정확한 ID로 복구하며 새 실행을 만들지 않는다. | 새 코드 변경 불필요. |

## 자원 소유권과 반환 근거

| 소유자·단위 | 예약과 상태 전이 | 반환·재시작 근거 | 필수 제어 영향 |
| --- | --- | --- | --- |
| HTTP supervisor: 프록시 건수, request bytes, ID capture allocation | headers 수신 시 일반 요청을 예약한다. 일반 건수/바이트 한도에 닿거나 길이 미정 요청이 일반 바이트 경계 근처에 오면 후보를 먼저 전체 128건 안에 예약한다. 완전한 본문을 최대 1초/8 MiB/전역 capture 40 MiB 안에서 읽으며 수신 바이트도 32 MiB 프록시 예산에 포함한다. 우선 본문은 256 KiB 이하로 제한한다. | 비해당/불완전 본문은 후보 예약을 즉시 반환한다. 작은 일반 본문이 112건·24 MiB 안에 실제로 들어가면 그대로 한 번 전달하고, 우선 본문은 128건·32 MiB 안에서 한 번 전달한다. 전달된 요청의 프록시 예약은 응답 완료·caller disconnect·하위 소켓 종료 중 최초 사건에서만 반환한다. supervisor 재시작 시 소켓과 메모리 카운터가 함께 사라진다. 하위에서 이미 처리된 명령의 결과는 이 반환과 별개다. | `codex_answer`, `codex_cancel`, `codex_steer`, 앱의 interaction 응답과 `codex_ui_completion`의 `accepted/rejected/uncertain/release`, `codex_status`의 **무대기** exact job/request/completion/input만 예약 대상이다. `codex_ui_completion.wait`, 다른 long-poll·전체 목록·페이지·이력은 제외한다. SDK의 인증·scope·버전·현재 질문 검증이 그대로 뒤따른다. |
| Native companion: 물리 소켓 16, 일반 dispatch 8, 변화 listener 4 | 완전한 한 줄을 읽은 후 JSON-RPC method로 처리 등급을 정한다. `changes.wait`는 별도의 listener/timer 4개를 사용한다. | dispatch 실제 완료 때 일반 슬롯 반환. socket close는 변화 대기를 abort하지만 이미 전달된 다른 명령의 완료로 간주하지 않는다. 프로세스 재시작 시 소켓/메모리 관측은 닫히고 명령 결과는 state owner의 지속성 계약을 따른다. | completion claim/delivered/release, runtime health/drain, 확인된 retry-stop/인계 취소가 예약 처리된다. 단순 큰 snapshot·history는 일반 등급이다. |
| State owner: Job wait listener/timer 최대 128 | 짧은 `get()`과 scope 검증 후 대기 등록. change/terminal/input 모두 같은 카운터를 쓴다. | wake·timeout·AbortSignal 중 최초 사건에서 timer/listener/abort handler와 슬롯을 한 번만 반환한다. 재시작은 대기를 끝내지만 durable Job은 그대로다. | 정확한 무대기 결과 조회·질문 응답·취소는 이 listener 수에 묶이지 않는다. |
| Supervisor native RPC: pending/abandoned/HTTP 합계 최대 128 | IPC 전송 전에 request ID 예약; timeout은 pending에서 abandoned로 이전하며 총량은 변하지 않는다. 일반 native 120건 상한. | matching response 또는 runtime child exit 때 반환. restart 후 미확정 결과는 새 명령으로 재실행하지 않는다. | native control 8건을 보존한다. |
| Read child: pending 16 | snapshot SQL 요청을 IPC에 보낸 뒤 예약. caller deadline 후에도 abandoned로 유지. | 응답·child exit에서 반환. child 재시작은 이전 snapshot을 현재 결과로 단정하지 않는다. | 정확한 Job 상태 대기의 listener는 이 read child의 snapshot 슬롯이 아니다. |
| Execution parent/owner: pending 건수·바이트, journal receipt | 제어 reserve를 제외하고 IPC 요청을 예약. owner journal은 실행/검사/metadata/control lane에 물리 결과를 보존한다. | 일반 reply는 ACK 확인 후 parent reservation 해제, retained Job은 terminal DB commit 후 ACK. 중복 ACK는 추가 반환을 만들지 않는다. owner 교체 시 정확한 ID로 미확정 항목을 조회하고, owner 종료가 확인된 경우에만 물리 예약을 끝낸다. | 질문 응답·steer·worker 제어는 기존 execution control reserve를 쓴다. |

### 마지막 확인과 확인 불가 상태

| 자원과 사실의 근거 생산자 | 마지막 확인 상태·시각 | 현재 확인 가능성과 확정 반환 근거 |
| --- | --- | --- |
| HTTP supervisor의 소켓·프록시·ID capture 카운터 | 해당 프로세스의 예약·응답·close 콜백 시점에 갱신된다. `/healthz`의 heartbeat 시각은 하위 런타임의 별도 관측이다. | 살아 있는 supervisor 안에서만 현재 카운터를 확인할 수 있다. heartbeat 지연만으로 하위 실행 종료나 이미 전달된 명령의 취소를 추정하지 않는다. 위 표의 응답·disconnect·하위 소켓 종료 또는 supervisor 종료가 로컬 예약 반환 근거다. |
| Native companion의 접속 소켓·dispatch·change listener | 같은 프로세스의 connect·실제 dispatch 완료·wait 종료 콜백 시점에 확인된다. 접속별 영속 확인 시각은 없다. | 로컬 소켓/카운터의 현재 상태만 관측 가능하다. 호출자 close는 이미 시작한 명령의 완료 근거가 아니다. 실제 dispatch 완료 또는 프로세스 종료가 해당 처리 예약의 반환 근거다. |
| State owner의 Job wait listener와 read child의 snapshot RPC | waiter 등록·wake/abort/timeout 콜백, read child의 정확한 request ID 응답·exit 사건에서 확인된다. 별도 영속 waiter 시각은 없다. | 메모리 waiter와 pending ID는 각 소유 프로세스가 살아 있을 때 확인 가능하다. 대기 종료는 관측 자원만 반환하고 Job을 끝내지 않는다. read child caller timeout은 실제 처리 완료 근거가 아니므로 응답·exit까지 RPC 예약을 유지한다. |
| Supervisor의 native RPC와 execution parent의 IPC 요청 | request ID 예약, matching reply/ACK, 직접 소유한 child exit 시각의 사건으로 확인한다. 관측 시각은 프로세스 로컬이며 stale heartbeat는 대체 근거가 아니다. | `pending`에서 `abandoned`로 이동해도 미완료 총량에 남는다. 실제 reply 또는 확인된 해당 child 종료만 물리 예약을 반환한다. 실행 결과의 성공·실패는 별도 owner 사건으로 판정한다. |
| 실행 소유자의 원본 turn·결과와 state writer의 terminal commit/receipt | 원본 App Server thread/turn/request·세대 사건, owner journal의 결과, DB terminal commit/ACK가 각각 다른 확인 시각·단계다. | owner 연결이 살아 있으면 동일 ID로 재조회·회수한다. 연결이 불명확하면 현재 turn 생존도 결과 전달도 미확정으로 남긴다. terminal commit 전에는 원본 결과를 ACK·해제하지 않으며, commit 뒤에도 호스트 전달·Activity 완료를 자동으로 주장하지 않는다. |

이 표는 수집하지 않는 전역 `lastObservedAt`이나 운영 중 실시간 계측값을 있는 것처럼 제시하지 않는다. 프로세스가 사라진 뒤에는 그 로컬 카운터를 복원하거나 오래된 DB 상태로 역산할 수 없다. 확인 불가가 새 실행 허가 또는 기존 실행 강제 종료의 근거가 되지 않는다는 것이 #200과 공유하는 경계다.

`writeMcpUnavailable()`은 수신 본문 전체를 보고 원래 JSON-RPC ID를 확정한다. 우선 처리 후보에서도 같은 capture를 재사용하므로 숫자/UTF-8 분할, 큰 일반 본문의 뒤쪽 ID, 비정상 본문의 무근거 ID 추측 방지 계약을 유지한다. `critical` 같은 caller header는 분류에 사용하지 않는다. 실제 메서드·scope·버전·proof는 기존 SDK/도구 검증이 결정한다.

## 동일 부하 측정

`scripts/issue-196-ingress-measurement.ts`를 동일 호스트에서 기준 소스와 변경 소스에 각각 실행했다. 112개의 끝나지 않은 MCP POST가 각 1바이트를 보낸 상태에서, 424바이트 exact Job 조회 20건을 순차 수행했다. 각각 native settings 조회와 `/healthz` 20건도 측정했다. 별도로 8개의 native snapshot이 응답을 기다리는 동안 완료 전달 ACK 메서드를 한 번 요청했다. 해당 ACK handler는 측정용 대역이므로 표의 성공은 소켓·RPC 진입 성공이지 영구 저장 확인은 아니다. 수치는 한 번의 격리 실행이고 운영 지연 보장이 아니다.

| 항목 | 기준 `e068a45` | 이번 변경 |
| --- | ---: | ---: |
| exact 조회 HTTP 결과 | 20/20 `503` | 20/20 `200`(정확한 미존재 Job 오류를 도구가 반환) |
| exact 조회 p50/p95 | 0.34 / 0.80 ms (즉시 거절) | 16.99 / 27.87 ms (상태 owner까지 처리) |
| native settings p50/p95 | 21.55 / 30.77 ms | 19.55 / 39.86 ms |
| native 완료 ACK | 응답 없음, 1.35 ms에 소켓 종료 | 전달 확인, 0.61 ms |
| `/healthz` p50/p95 | 0.55 / 0.66 ms | 0.45 / 0.55 ms |
| 점유 건수, 측정 전/후 | 112 / 112 | 112 / 112 |

고정 입력의 프록시 본문 계정은 안정 시 112바이트이며, 각 1바이트 capture가 최소 1 KiB를 할당하므로 ID capture allocation은 112 KiB다. 한 번에 하나인 424바이트 조회가 처리되는 순간은 113 KiB다. 이는 입력과 allocator의 결정적 계산이며 프로세스 RSS 계측은 아니다. 두 버전 모두 32 MiB 프록시 본문·40 MiB ID capture 상한을 유지한다. 변경 버전의 일반 본문 예약은 24 MiB, 제어용 여유는 8 MiB다.

## 검증 경계

- 새 시험은 실제 격리 HTTP 프록시에서 건수/바이트 포화 중 exact 조회·질문·취소·steer, 부정확한 header 거절, 일반 조회 거절, 128건 물리 상한, disconnect 후 반환을 확인한다. Native 소켓 시험은 8개 일반 요청 대기 중 완료 전달 ACK를 확인한다. Registry 시험은 128개 listener 뒤 input wait 거절, Abort 후 재진입, terminal 반환을 확인한다.
- 기존 `runtimeProcess`, `executionServiceProcess`, `executionRetention`, `stateReadProcess`, `jobRegistry` 시험과 #137/#142/#185/#186/#189/#191/#193 회귀는 실제 미완료 RPC, ACK, owner 재시작, 저장 실패 및 하위 종료 계약의 근거다. 이번 변경은 그 저장·실행 프로토콜을 수정하지 않는다.
- 운영 앱/ChatGPT 터널 적용 효과는 별도다. 새 소스·격리 시험·번들 생성만 이번 검증의 범위다.

격리 검증 결과: Node 전체 957/957, MCP 2026-07-28 29/29, macOS 212개 중 2개 건너뜀·실패 0. CI 기준 Codex CLI 0.153.3으로 App Server schema lock(416 JSON, 827 TypeScript 파일)도 일치했다. #137/#142/#185/#186(90초 관측 장애)/#189의 소스 회귀는 모두 통과했다. 별도 경로에 생성해 서명·SQLite 모듈을 확인한 macOS 번들에서는 #185/#189와 #186(30초 관측 장애)을 다시 통과했다. 번들의 `sourceHash`는 `34bf40bdd0b991638bdfc29c0d39a938d323647d57dc8b684ccda19f88a977e8`이다. 이 번들을 운영 앱으로 교체하지 않았다.

## PR #201 후속 예약 경계 보완

위 수치와 번들 해시는 PR #201 당시의 기록이다. #200이 PR #202로 먼저
통합된 뒤, 같은 `dev`를 기준으로 다음 두 조건을 보완했다.

1. `codex_ui_completion.wait`는 Job의 종료를 최대 10초 기다릴 수 있으므로
   관측 대기 등급에 둔다. `accepted/rejected/uncertain/release`는 이미 있는
   전달 기록을 확정·해제하는 짧은 제어 동작으로 분류한다. 도구 이름만으로
   대기에 제어용 예약을 주지 않는다.
2. `Content-Length`가 없는 MCP POST가 일반 24 MiB 경계를 작은 본문으로
   넘을 수 있는 구간에서는, 원래 하위 요청을 보내기 전에 본문을 완성해
   분류한다. 일반 본문이 남은 일반 건수·바이트 안에 들어가면 일반 경로로,
   실제 우선 본문이면 예약 경로로 보낸다. 어느 경우든 하위로 한 번만
   전달하며, 큰 본문·불완전 본문·호출자 연결 종료는 유한한 예약을 반환한다.

격리 HTTP 회귀는 일반 112건 포화 중 카드 `wait` 16건이 제어용 슬롯을
점유하지 않는지, 카드 전달 결정이 기존 scope 검증까지 도달하는지,
24 MiB 직전과 정확한 경계에서 같은 조회의 선언 길이/청크 전송이 같은
정책을 따르는지 확인한다. 별도 실제 제품 경로 시험은 원본 질문이 있는
Job의 답변, 실제 실행 중인 Job의 명시 취소, 완료 Job의 정확한 결과와
유효한 live-card 수락 receipt를 포화 중 처리하고 슬롯 반환을 확인한다.
이 시험들은 격리된 소스 런타임과 가짜 App Server를 사용하므로 운영 앱,
실제 Codex 또는 ChatGPT 호스트 수락을 입증하지 않는다.

후속 검증에서는 Node 전체 960/960, MCP 규격 29/29가 통과했다. #185의
state owner 재시작·원본 결과/질문 회수와 #189의 16건 terminal commit ACK
지연·120건 완료 Job 회귀도 동일 소스에서 통과했으며, 두 시험 모두 중복 turn
0건과 격리 DB `quick_check=ok`를 보고했다. 이 후속 변경의 macOS 소스는
수정하지 않았고, 앞서 #200 통합 시 macOS 212개 중 2개 건너뜀·실패 0을
확인했다. 운영 설치본 교체 및 실제 호스트 왕복 검증은 수행하지 않았다.
