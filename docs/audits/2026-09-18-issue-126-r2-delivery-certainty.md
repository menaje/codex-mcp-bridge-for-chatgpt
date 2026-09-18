# #126 R2 전달 확실성 및 #128 재시작 보존 — 2026-09-18

관련 이슈: [#126](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/126), [#128](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/128)

## 결론

schema 22의 정상 자동 전달은 유지하되, 서버가 도구 결과를 만들었다는 사실을
GPT 수신 확인으로 취급하던 계약을 제거했다. schema 23은 completion receipt
응답과 authenticated direct Job/request 응답의 **server offer** 시각을 별도로
기록한다. 어느 offer도 completion delivery state나 card lease를 소비하지 않는다.

따라서 직접 조회 응답이 반환 경계에서 유실되어도 pending 또는 retry 가능한
`host-rejected` 사건은 live Dashboard가 계속 claim할 수 있다. 반대로 직접
응답이 실제로 도착한 뒤 card 메시지도 도착할 수 있으므로 두 경로 사이의
exactly-once를 주장하지 않는다. 현재 host 계약에 GPT 도구 결과 수신을 증명하는
후속 acknowledgement가 없기 때문에, 확인할 수 없는 성공으로 결과를 유실하는
것보다 보수적인 회수를 우선한다.

## 전송 오류 분류

MCP Apps의 `ui/message` 결과와 request 예외를 다음처럼 분리한다.

| 관측 | 저장 결과 | 자동 재시도 |
| --- | --- | --- |
| resolved result의 `isError` 또는 명시적 JSON-RPC error response | `host-rejected` | bounded retry |
| timeout, teardown, connection loss, 그 밖의 throw | `acceptance-unknown` | 금지 |
| resolved success | `host-accepted` | 금지 |

공식 SDK 문서는 `sendMessage()`의 optional `isError` 결과와 timeout/connection
loss throw를 별도 경계로 정의한다. 이 구분만 사용하며 오류 문자열을 추측해
거절로 분류하지 않는다.

- https://apps.extensions.modelcontextprotocol.io/api/classes/app.App.html
- https://apps.extensions.modelcontextprotocol.io/api/interfaces/app.McpUiMessageResult.html

## 상태 및 이관 계약

- schema 23의 `completion_result_offered_at`은 authenticated completion receipt에
  대한 exact result 응답을 서버가 구성한 최초 시각이다.
- `direct_result_offered_at`은 authenticated same-conversation Job/request 조회가
  retained result를 응답에 포함한 최초 시각이다.
- 두 열은 `pending`, `leased`, `host-rejected`, `host-accepted`,
  `acceptance-unknown`을 바꾸지 않는다.
- schema 22의 `result-read`와 `result_read_source`는 과거 호환 기록으로 보존하고,
  해당 시각을 대응 offer 열로 이관한다. 실제 수신 여부를 역추론해 자동 replay하지
  않는다.
- completion receipt offer 뒤에는 기존 result retention 정책을 적용할 수 있지만,
  정확한 Job 결과는 보존 기간 동안 같은 conversation 권한으로 다시 조회할 수 있다.

## #128 결합 경계

완료된 discardable memory-only Codex context는 runtime 종료를 막지 않는다.
ChatGPT completion delivery와 retained Job result는 SQLite가 소유하므로 runtime
context 폐기 여부와 분리한다.

결정적 결합 검사에서는 실제 SQLite 파일에 acceptance-unknown completion과
retained exact result를 기록하고 store를 닫은 뒤, macOS helper가 실제 child
process를 안전 재시작하도록 했다. 재시작 뒤 같은 파일을 다시 열어 다음을
확인했다.

- receipt, attempt, acceptance-unknown 상태 보존
- exact retained result 보존
- Job 수 1 유지 및 새 Job 미생성
- direct result offer 기록 뒤에도 acceptance-unknown 상태 유지
- protected memory-only context 0, discardable context 1일 때 안전 재시작 완료

위 결정적 검사는 실제 App Server와 운영 DB를 사용한 사용자 환경 재현이
아니다. 이어지는 production 실환경 결과와 별도 증거로 구분한다.

## production 앱·helper 실환경 확인

결정적 검사와 별도로, 사용자 Mac의 실제 앱·helper·App Server·운영 SQLite로
다음 경계를 확인했다.

1. 교체 전 구 runtime은 원래 #128 장애와 같은 완료 memory-only context 8개를
   보유했다. 이때 active Job, pending admission/interaction, blocking interaction,
   pending cancellation, background process는 모두 0이었다.
2. 커밋된 production 앱(`09c58504f7c6:65c323c21ddc`)으로 교체한 뒤 운영 DB가
   schema 21에서 23으로 이관됐다. 이관 전후 Job 749개, retained result 8개,
   completion delivery 8개가 유지됐다.
3. 실제 bridge를 통해 파일·명령 실행을 금지한 짧은 validation Job 하나를
   memory-only App Server context로 완료했다. runtime snapshot은
   `memoryOnlyThreads=1`, `protectedMemoryOnlyThreads=0`,
   `discardableMemoryOnlyThreads=1`을 반환했고 completion delivery는
   `pending`, attempt 0으로 저장됐다.
4. 같은 앱에서 force 없는 runtime restart가 완료되어 runtime PID가 바뀌었다.
   재시작 뒤 memory-only count는 0이 되었지만 Job 수는 750개로 유지됐고,
   receipt·pending delivery·retained exact result를 새 Job 생성 없이 다시
   조회했다.

따라서 완료 context 폐기 허용과 SQLite 결과 보존을 실제 운영 조합에서도
확인했다. 이 검사는 ChatGPT 카드의 `ui/message` 수신을 포함하지 않으므로
schema 23 connector 종단 증거로 계산하지 않는다.

## 결정적 검증

| 검사 | 결과 |
| --- | --- |
| 상태 저장소·Dashboard 분류·release 계약 | PASS |
| `codex_status` exact Job/receipt 통합 | PASS |
| schema 3~22 → 23 및 복구 경계 | PASS |
| helper child-process 안전 재시작 + 실제 SQLite 보존 | PASS |
| production Dashboard 브라우저 경계 | 8/8 PASS |
| `npm run build` 및 release manifest | PASS |
| 전체 `npm run check` | 86 files / 764 tests PASS |
| 전체 `npm run macos:check` | 202 tests PASS, opt-in live 2개 의도적 skip |
| App Server schema 호환 | CLI 0.153.3, 416 JSON / 827 TypeScript PASS |
| #125 수신 순서 회귀 | 6/6 PASS |
| production 앱 bundle/codesign | 별도 staging 경로 build/sign/strict verify PASS |
| production 앱/helper의 discardable context 안전 재시작 | PASS (force 없음, PID 변경, exact result 보존) |
| schema 23 실제 connector 새 대화 | 미실행 |

브라우저 경계에는 host accept, 명시적 reject 뒤 retry, timeout uncertainty,
send 중 teardown uncertainty, legacy result-read settled 호환, terminal 전 teardown,
presentation mismatch, duplicate cards가 포함된다. fixture 결과를 실제 ChatGPT
host 성공으로 계산하지 않는다.

## 남는 한계

- live originating Dashboard가 없거나 teardown·navigation 뒤인 대화를 서버가
  깨우는 기능은 추가하지 않았다.
- `host-accepted`는 host 수락이고, result offer는 서버 응답 구성이다. 둘 다 GPT의
  최종 사용자 보고를 단독으로 증명하지 않는다.
- transport outcome이 불명확하면 자동 replay하지 않는다. 사용자는 같은 Job을
  다시 실행하지 않고 exact status 조회로 저장 결과를 회수할 수 있다.
- schema 23의 실제 connector 종단 검증 전에는 기존 schema 22의 3/3 실환경
  기록을 최종 빌드의 3/3으로 다시 계산하지 않는다.
