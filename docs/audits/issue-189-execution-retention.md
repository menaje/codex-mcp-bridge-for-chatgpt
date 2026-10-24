# #189: 실행 보존 용량과 ACK 회귀

기준 커밋은 `62ab6b3` (#188)이다. `executionJournal.ts`와 해제 ACK 경로는
#185 / #187에서 도입됐다. 이번 수정은 관측 실패 때문에 정상 실행을 종료하지
않는 #185/#186 정책을 유지한다.

## 재현으로 확인한 결함

실제 Codex 실행 없이 `listTools`를 8개씩, 각 묶음의 응답을 모두 받은 뒤
다음 묶음을 보내도 `EXECUTION_RETENTION_CAPACITY`가 발생했다. 수정 전 별도
재현에서는 160회 중 57회 성공/103회 거부였고 종료 시 pending 요청은 0,
health는 `ready`였다. 정확한 성공 개수는 스케줄링에 따라 달라진다.
`test/executionRetention.test.ts`의 첫 시험도 수정 전 실패했다.

원인은 응답 Promise를 먼저 정산해 후속 요청을 허용하면서 기록 해제 ACK는
한 개씩 왕복하던 처리다. 실행 중 요청 수는 낮아도 완료된 조회의 미해제 기록이
30개 공용 슬롯을 채웠다. 정상 연결에서 ACK/ACK reply가 유실됐을 때도 다음
재접속 전에는 해제 대기열을 복구할 재시도가 없었다.

추가로 native runtime snapshot의 화면 대기 제한은 실제 조회를 끝내지 않는데
재호출마다 새 조회를 시작했다. 수정 전 구현은 80개 Agent를 반복 조회할 때
끝나지 않은 실제 요청을 쌓을 수 있었다. 공유 물리 슬롯을 유지하는 회귀 시험을
추가했다. 대시보드의 기존 `DisplayReadPool`과 같은 원칙이다.

운영 사례의 Session 79 / Activity 55 / Agent 80은 해당 대화의 보관 행 수였으며
journal 용량 판단값이 아니다. 당시 journal별 점유 기록이 없으므로 모든 운영
오류를 ACK 한 가지 원인으로 소급 확정하지 않는다. `REUSE_UNPROVEN`과 MLX
서버의 source/model revision 확인은 별개다.

## 수정과 자원 경계

| 구분 | 기록 한도 | 의미 |
| --- | ---: | --- |
| execution | 30 | 실제 turn과 저장 확인을 기다리는 결과 |
| inspection | 8 | thread probe와 background terminal 조회 |
| metadata | 8 | 모델·계정·도구 목록 및 실행 준비 등 |
| control | 6 | 질문 응답, steer, 취소 및 정리 |

각 한도는 독립적이다. 단순 조회가 실행 예약이나 제어 예약을 사용할 수 없다.
전체 기록은 52개로 유한하며 기존 기록당 결과 8 MiB + 사건 8 MiB 상한을 유지한다.
최대 예약 계산은 832 MiB이고 실제 메모리는 입력 크기대로 사용한다. 이 숫자는
프로세스 RSS 전체의 상한이 아니다. 기존 전송 프레임/바이트/부모 pending 상한도
유지한다. 한도를 제거하거나 시간만으로 실제 실행을 끝내지 않는다.

- 일반 RPC는 실제 응답을 받더라도 슬롯 해제가 확인된 뒤 호출자에게 반환한다.
  같은 8개 호출자가 해제 전 다음 8개를 계속 누적시키는 상황을 막는다.
  해제 대기 중에도 부모 요청 수·입력 바이트 예약을 유지하므로 별도 호출자가
  계속 유입돼도 기존 128개/32 MiB 상한과 제어 예약을 우회할 수 없다.
- durable Job은 기존대로 DB terminal commit 이후에만 ACK한다. 전달 콜백이나
  화면에 결과가 표시됐다는 사실로 저장 확인을 대체하지 않는다.
- ACK는 최대 16개를 동시에 확인하되 일반 응답·제어용 8자리를 확보한다. 저장 ACK가
  지연돼도 메타데이터/제어 응답 해제를 막지 않는다. 1초마다 **같은 기록 ID만** 재시도한다.
  원래 prompt/turn을 재전송하지 않는다. 연결 복구 시에도 동일한 해제 규칙을 쓴다.
- 이미 실제 terminal reply를 받은 일반 RPC의 반환만 ACK를 기다린다. 실제 owner
  종료나 명시적 detach/close는 이 반환을 마무리하며, 미확정 실행을 성공으로 바꾸지 않는다.
- native snapshot은 실제 background 조회 8개 슬롯을 공유한다. 화면 대기 종료는
  슬롯 반환이 아니며, 실제 Promise가 끝나야 반환한다.

`runtime.health.executionService.journal`은 종류별 `used`, `active`,
`awaitingAcknowledgement`, `awaitingCommitAcknowledgement`, 가장 오래된 ACK 대기
시간을 표시한다. 저장 ACK 대기는 DB가 아직 저장하지 않았다는 확정 판정이 아니다.
`pendingAcknowledgements`는 제어 측 해제 대기다. execution 기록이 포화되면
전역 실행 상태도 `capacity`가 되며 조회만의 포화는 전체 실행 접수를 막지 않는다.
측정 시각과 heartbeat 최신성은 함께 확인해야 한다.

## 관리 기능과 검증

Agent archive/restore는 제거된 기능이다. 기존 호출에는
`AGENT_ARCHIVE_REMOVED`와 복구 설명을 구조화해 반환한다. stale Activity version은
`STALE_ACTIVITY_VERSION`으로 반환하고 현재 버전 조회를 안내한다. 이 실패 응답은
아무 기록도 삭제하지 않는다. Activity complete/abandon을 실행 슬롯 정리로
사용하지 않는다.

`npm run test:issue-189-retention`은 실제 runtime factory, MCP, 임시 SQLite DB,
별도 executor 및 CLI fixture를 사용한다. `CODEX_TEST_BUNDLE_DIST`를 주면 해당
앱 번들의 실제 JS를 실행한다. 운영 연결을 가로채거나 운영 DB를 수정하지 않는다.

검증 항목:

- 8개씩 반복하는 metadata 160건과 후속 실행
- 실행 기록 30개를 채운 뒤 실제 완료 결과 보존 및 정확한 capacity 표시
- DB는 저장한 상태에서 저장 ACK를 보류하고 설정·Agent rename·Activity complete/
  abandon·결과 조회·steer가 유지되는지 확인
- 보류 해제 후 ACK 재시도로 자동 슬롯 반환, 총 120개 Job 완료와 중복 turn 0
- ACK와 ACK reply를 각각 유실시킨 뒤 연결/실행 세대를 바꾸지 않고 복구
- ACK reply 유실 후 재접속해도 완료된 turn을 재전송하지 않으며 부모 대기열 상한 유지
- 반복 native snapshot에서도 실제 조회 최대 8개, 완료 후 재사용
- 기존 관측 장애, DB commit 실패, 제어 재접속, 실제 worker/executor 손실 시험

최종 시험 수치와 앱 번들 식별자는 구현 PR과 이슈 완료 기록에 남긴다. 120개
fixture Job을 실제 사용자 장시간 부하나 물리적 잠자기/복귀 검증으로 확대 해석하지 않는다.
