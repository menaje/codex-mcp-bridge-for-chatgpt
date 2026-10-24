# #108 실환경 Dashboard 수명 검증 — 2026-09-14

실제 ChatGPT 대화에서 notify/sealed completion 정책을 가진 background 작업을 시작하고, 작업 결과의 `codex_dashboard(scope: "conversation", backgroundJobId)` render action을 원래 응답이 끝나기 전에 실행했다.

자동 Dashboard 표시는 통과했다. 카드는 원래 대화의 Dashboard 리소스로 열렸고, 작업과 Activity가 정상 종료되면서 durable completion outbox가 생성됐다.

그러나 ChatGPT가 모델 응답을 끝낼 때 카드에 `ui/resource-teardown`을 전송했다. 카드는 마지막 HTML을 화면에 남겨도 수명 종료 상태가 되어 refresh timer, `tools/call`, `ui/message`를 더 실행할 수 없었다. outbox의 attempt count는 0으로 남았다. 따라서 inline Dashboard가 완료 메시지를 자동 전달한다고 표시할 수 없다.

이 결과에 따라 Dashboard는 background 작업의 자동 표시와 제어만 담당한다. 완료 이벤트는 카드와 분리해 durable outbox에 보관한다. 이 검증은 Dashboard 자동 표시의 실증이지만, ChatGPT host-event completion delivery의 실증은 아니다.

## 설치 런타임 재검증

수명주기 보정이 반영된 설치 런타임을 Codex 인앱 브라우저의 같은 실제 ChatGPT 대화에서 다시 실행했다. 등록 프로젝트 `메모리`에 파일·네트워크 변경이 없는 background Job을 만들고, `notify`와 `sealed-jobs-terminal` 정책 및 반환된 scoped Dashboard render action을 적용했다.

- Dashboard가 원래 대화의 **이 대화** 범위로 자동 표시됐고, 실행 중 집계가 `1`로 보였다.
- Job과 Activity가 `completed`로 끝난 뒤 모델의 일반 응답 `LIVE-PENDING-108`만 표시됐다. 이후 20초 동안 대화에 추가 자동 메시지는 없었다.
- 상태 데이터베이스의 최신 outbox는 `pending`, `attempt_count = 0`이었다. 따라서 Dashboard 표시가 완료 전달 claim 또는 acknowledgement를 만들지 않는다.
- 응답 종료 뒤 새 Dashboard iframe은 브라우저 frame locator로 더 이상 접근할 수 없었다. 정적 카드 표면이 남아 있어도 Apps 수명주기는 이미 종료된 상태임을 다시 확인했다.

공개 Apps UI 문서는 `ui/message`/`sendFollowUpMessage`를 **컴포넌트가 host에 보내는** 메시지 API로만 정의하며, 별도의 server-to-host 원래 대화 재개 API를 정의하지 않는다. MCP Apps 명세도 `ui/resource-teardown` 뒤 iframe과 listener를 정리하도록 규정한다. 따라서 이 환경에서 host-event dispatcher를 활성화하거나 outbox를 전달 완료로 표기할 근거는 없다.

여기서 `ui/message`는 질문 카드나 사용자 답변 카드가 아니다. 살아 있는 UI 컴포넌트가 host에 후속 대화를 요청하는 저수준 bridge 메서드다. 현재 제품은 질문 카드와 Activity 카드를 모두 폐기했고, Settings·Dashboard도 이 메서드를 호출하지 않는다. 호출처가 없던 과거 공용 카드 runtime과 그 `followUp()` helper도 제거했다.

## 채택한 대체 전달 경로

ChatGPT 원래 대화를 재개하는 host-event dispatcher는 이 환경에서 제공·검증되지 않았으므로 채택하지 않았다. 대신 `completionFollowUp` 설정은 **이 Mac의 메뉴 막대 앱이 보내는 generic macOS 완료 알림**을 뜻한다.

- 새 one-job background Activity에 명시 completion policy가 없고 설정이 켜진 경우에만 bridge가 `notify`/`sealed-jobs-terminal`을 적용한다. 성공 completion만 outbox에 기록한다.
- local menu-bar app은 private Unix socket의 `completion.claim`, `completion.delivered`, `completion.release`로 stable `eventId`와 `outboxId`만 받는다. remote client API에는 이 메서드가 없다.
- macOS가 알림을 수락한 뒤 outbox를 acknowledge하며, 표시 실패는 lease를 release한다. 표시와 acknowledgement 사이 crash 뒤 재시도될 수 있으므로 exactly-once visible delivery를 주장하지 않는다.
- 알림과 IPC에는 prompt, result, path, Activity ID, scope, ChatGPT conversation ID가 없고, 클릭은 local Dashboard만 연다. ChatGPT 메시지를 보내거나 재개하지 않는다.

따라서 이 실환경 검증은 카드와 ChatGPT host-event 전달을 거부한 근거로 유지하고, native notification 경로의 단위·socket·Swift 전달 검증은 별도 코드 검증으로 기록한다.

## 로컬 macOS 앱 격리 전달 검증

새 macOS 번들을 일회성 private Unix-socket fixture에 연결해 실제 메뉴 막대 앱의 전달 루프를 실행했다. fixture는 eligible outbox 하나에 대해 opaque `eventId`와 `outboxId`만 반환했고, 앱은 `completion.claim` 뒤 macOS notification request를 성공적으로 등록한 뒤에만 같은 `outboxId`를 `completion.delivered`로 확인했다. 다음 claim은 비어 있었다.

이는 카드나 ChatGPT 메시지 경로 없이 실제 macOS 앱이 local completion RPC를 소비하고 acknowledgement까지 수행한 검증이다. 시스템의 배너 표시 여부는 사용자의 Focus와 notification 표시 설정에 좌우되므로 이 검증으로 화면 노출을 보장한다고 주장하지 않는다. 앱의 response handler는 `notificationKind: "completion"`에만 반응해 local Dashboard를 열도록 구현·Swift 테스트로 검증했다. 실제 설치 런타임은 교체하지 않았고, 검증 뒤 기존 앱과 기존 helper/runtime을 다시 실행했다.
