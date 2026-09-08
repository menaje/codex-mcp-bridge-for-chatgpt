# GPT가 처리하는 Codex 질문

GPT는 위임 범위 안의 일반 작업 질문에 기본적으로 답한다. 사용자 의견이
필요하면 GPT가 `codex_ask_user`로 질문과 선택지를 작성한다. 카드 제출은
GPT가 읽을 답변을 저장하며, Codex에 직접 응답하지 않는다.

실제 CLI 3종에서 공개 메시지형 질문의 `codex_steer` 응답과 네이티브 서버형
질문의 `codex_answer` 응답을 검증했다. 서버형 일반 질문은 로드된 스레드에서
앱 승인이 별도 MCP elicitation 경로를 사용한다는 근거를 확인한 경우에만 연다.
동일한 세 CLI에서 실제 승인 요청이 별도 경로로 전달되고 공개 `codex_answer`로는
응답할 수 없는 것도 확인했다. 이 검사는 실제 CLI와 제품 MCP를 사용하지만
상위 ChatGPT의 도구 선택·카드 후속 실행 검증과는 구분한다.

이전 #68 빌드의 실제 ChatGPT에서도 `gpt-6-astra / low`가 보낸 일반 메시지 질문을 GPT가
당시의 `codex_input`으로 읽고 카드 없이 `codex_steer`로 답해 같은 턴의 결과에
반영되는 것을 확인했다. 대기를 사용할 수 없어 질문 직후 종료된 실행도
관찰했다. 모델·기능 설정에 따라 질문 후 계속 실행할 수 있는지는 달라지므로
메시지가 있다는 이유만으로 현재 턴에 답할 수 있다고 가정하지 않는다.

도구 구성이 바뀐 빌드를 설치하면 ChatGPT의 브리지 플러그인에서 **Refresh(새로고침)**가
필요하다. #69의 새 구성은 공개 12개와 카드 전용 5개다. 호환 기간에는 기존 카드용
앱 전용 12개도 등록해 실제 목록은 29개이며, GPT 공개 도구는 12개다. 이전 `codex_input`은
`codex_status`의 `input` 조회로 통합했다. 서버의 도구 목록에 있어도 ChatGPT에
노출되지 않을 수 있다. 새로고침 후에도 기존
대화가 이전 목록을 유지하면 새 대화에서 확인한다.
[공식 메타데이터 갱신 안내](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).

## 실행 흐름

1. `codex_status({query: {kind: "input", jobId}})`로 일반 질문과 공개 중간 메시지를 읽는다.
2. 구조화된 일반 질문은 `codex_answer({requestId, jobId, questionRef, answers})`로
   답한다. 질문 ID와 선택지를 그대로 사용한다. 작업의 다른 진행 이벤트로
   Job 버전이 바뀌어도 같은 질문의 답변은 유효하다.
3. 해결할 서버 요청이 없는 메시지형 질문에는 현재 Job 버전으로
   `codex_steer`를 호출한다. 실제 승인·구조화된 질문을 steer로 해결하지 않는다.
4. 사용자 의견이 필요하면 `codex_ask_user({requestId, title, questions})`를 호출한다.
   카드에는 최대 3개 질문과 질문별 선택지 또는 자유 입력을 사용할 수 있다.
5. 카드가 알린 `responseRef`를 `codex_user_answer`로 읽고 GPT가 다음 행동을
   결정한다. 원래 Codex 요청이 종료됐다면 현재 결과를 확인한 뒤 명시적으로
   이어간다. 사용자 질문은 Codex 요청과 별도의 수명을 가진다.

새 입력을 기다릴 때는 `codex_status`의 `input` query에 마지막 `afterCursor`와 최대 60초의
`waitMs`를 보낸다. 명령 실행·진행률만 바뀐 경우에는 대기를 끝내지 않는다.
이 경로는 Activity 카드의 자동 표시 설정과 독립적이다. `codex_status`의
정확한 Job 조회에는 입력 cursor와 일반 질문·승인 요청 수, 조회 도구가 포함된다.

입력 조회는 한 번에 현재 일반 질문 요청 1개(그 안의 질문 최대 3개), 최근 공개
메시지 최대 12개를 반환한다. `hasMoreQuestions`가 참이면 해당 요청 처리 뒤
다시 조회한다. 메시지는 길이가 제한된 공개 이력이며 전체 대화 기록이 아니다.
메시지의 `final_answer` phase는 턴 완료 근거가 아니다. 정확한 Job의 terminal
결과를 확인한다.

## 카드와 후속 처리

질문 카드는 독립된 `question` 리소스를 사용한다. `codex_ui_read`의
`view: "question"`으로 처음 읽거나 새로고침하고, `codex_question_action`의
`submit`·`claim`·`ack`로 각각 답변 저장과 후속 메시지 전달 상태를 처리한다.
각 응답에 최신 비공개 카드 상태를 포함해 제출 직후 추가 조회를 하지 않는다.
Activity 감시 lease나 완료 인계 소유권을 가져오지 않는다. 실제 Codex 승인과
입력은 전역 현황의 작업 상세에서 원본 요청으로 처리하고, 일반 질문에는
GPT가 처리한다는 표시만 보여준다. [호환 및 완료 알림 이전](card-tools.md)을 참고한다.

카드 전용 호출에서 호스트가 대화 메타데이터를 생략하면 비공개 카드 정보의
대화 식별자와 정확한 질문·revision·presentationToken으로 접근을 검증한다.
호스트가 제공한 대화 정보가 있으면 항상 그것을 우선한다. 이 호환 처리는
카드 전용 도구에만 적용하며 GPT의 공개 답변 조회 범위를 넓히지 않는다.

카드 응답은 다음 상태를 구분한다.

| 상태 | 의미 |
| --- | --- |
| 저장됨 | 답변 또는 취소가 브리지에 기록됨 |
| 후속 처리 요청됨 | 호스트가 후속 메시지 요청에 응답함 |
| 전달 불확실 | 전송 중 오류가 발생해 호스트 수신 여부를 확인할 수 없음 |
| GPT 확인 | GPT가 해당 `responseRef`의 내용을 조회함 |

표준 MCP Apps의 `ui/message`를 우선하고, 초기화가 지원되지 않을 때는 사용
가능한 `sendFollowUpMessage` 확장을 사용한다. 이미 전송한 요청이 실패했다고
다른 채널로 자동 재전송하지 않는다. 확실한 거절 후에는 사용자가 같은 저장
답변의 후속 처리를 재요청할 수 있다. 불확실한 경우에는 대화에서 GPT에게
계속 진행을 요청한다. GPT는 `codex_user_answer({})`로 읽지 않은 응답 식별자를
복구할 수 있으며, 목록 조회 자체는 답변을 읽은 것으로 표시하지 않는다.

카드 내부 `tools/call`이나 호스트의 메시지 접수만으로 GPT의 새 실행을 보장하지
않는다. 닫힌 대화·해제된 카드에서 항상 GPT가 실행된다는 보장도 없다.
2026-09-08 #68 빌드의 실제 ChatGPT 기존 대화에서 플러그인 새로고침 후 카드 제출 →
GPT 재개 → 답변 조회 → Codex 반영을 확인했다. 카드에만 입력한 한글 포함
임의 문자열을 GPT가 읽은 뒤 Codex 작업을 만들었고 출력이 정확히 일치했다.
완료 카드 재열기, 실제 취소와 1분 만료도 확인했다. 거절·미지원·전달 불확실
경로의 검사는 모의 호스트에서 수행했다. 이 결과는 이전 Activity 기반 질문
렌더러의 근거이며, #69의 독립 질문 렌더러와 통합 호출은 별도로 검증한다.
[검증 상세](audits/2026-09-08-gpt-question-followup.md).

## 보관과 권한

사용자 질문과 답변은 SQLite schema 13의 `user_questions`에 저장한다. 기본
보관 기한은 생성 후 24시간이며 `expiresInMinutes`로 1–1440분을 지정할 수 있다.
그 기한은 제출로 연장되지 않는다. 만료된 레코드는 다음 질문 관련 작업 또는
브리지 재시작 때 삭제된다. 기존 백업이나 SQLite 파일의 물리적 소거를 보장하는
정책은 아니다. 일반 질문 카드로 인증 비밀을 요청하지 않는다.

Codex에 보내는 일반 질문 답변의 전송 기록에는 식별자·해시·상태만 저장한다.
성공 기록은 7일 뒤 정리할 수 있지만, 불확실한 전송 기록은 자동 재전송을 막기
위해 유지한다. 질문·worker·turn 교체, 해결, 취소, 다른 대화 범위의 접근은
거부한다. 원래 답변의 정확한 재시도와 다른 답변의 충돌을 구분하며 분산
exactly-once 전달을 주장하지 않는다.

`requestUserInput`은 이전 앱 승인 경로에도 쓰인다. 브리지는 App Server 시작 시
`features.tool_call_mcp_elicitation=true`를 전달하고, 매 턴 전에 로드된
`threadId`로 `experimentalFeature/list`를 조회해 해당 기능이 `stable`이며
활성화됐는지 확인한다. 이 설정은 승인 요청의 전달 형식만 선택하며 저장된
권한, 승인 판단 또는 sandbox 설정을 변경하지 않는다. 버전 번호만으로 지원을
추정하지 않으며 조회 실패·미지원·비활성화 시 일반 질문 경로를 열지 않는다.
별도 도구 항목과 연결된 요청 및 기존 앱 승인 질문 ID도 보수적으로 제외한다.
`dynamicToolCall`의 이름이 질문 도구와 같아도 일반 질문의 근거가 되지 않는다.
앱 호출, 비밀 입력, 출처가 확인되지 않은 요청은 기존 승인 경로에 남는다. 모델별
비동기 질문 capability는 카탈로그의 활성화·미표시·미확인을 구분하고 실제
런타임 검증 필요성을 함께 표시한다.

공식 CLI의 [`request_user_input_async` 구현](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input_async.rs)은
질문을 포함한 비동기 `agentMessage`를 만들고 바로 반환한다. 이를 해결되지 않은
서버 입력 요청과 동일하게 취급하지 않는다. 반면
[`request_user_input` 구현](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input.rs)은
응답을 기다리는 입력 요청을 만든다. [MCP 앱 승인 구현](https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_call.rs)은
`tool_call_mcp_elicitation`이 활성화되면 앱 승인을 MCP elicitation으로 전달하고,
그렇지 않으면 기존 입력 요청으로 전달한다. 브리지는 이 기능 분리와 로드된
스레드의 활성화 상태를 함께 사용한다. 실제 기본 모드 서버형 질문 검사에서는
격리된 임시 home에만 `default_mode_request_user_input=true`를 설정했다.
운영 브리지는 이 실험 기능을 켜거나 모델의 질문 도구 선택을 강제하지 않는다.

공식 계약: [MCP Apps UI와 후속 메시지](https://developers.openai.com/plugins/build/chatgpt-ui#prefer-shared-fields-and-methods),
[입력 요청을 통한 앱 승인](https://learn.chatgpt.com/docs/app-server#mcp-tool-call-approvals-apps).

## 검증

```sh
npx vitest run test/questionOrchestration.test.ts test/questionStore.test.ts --exclude 'output/**'
npm run build
npx tsx scripts/question-card-browser-regression.ts --built
npx tsx scripts/check-live-gpt-questions.ts --run-authenticated source=/absolute/path/to/codex
npx tsx scripts/check-live-gpt-questions.ts --run-authenticated --native-input source=/absolute/path/to/codex
npx tsx scripts/check-live-gpt-questions.ts --run-authenticated --approval-probe source=/absolute/path/to/codex
```

브라우저 검사는 제품 MCP 처리·SQLite·renderer를 사용하며 호스트만 모의
구현한다. 실제 CLI 검사는 격리된 읽기 전용 프로젝트와 임시 인증 home에서
실행하고 정리한다. 어느 검사도 실제 상위 ChatGPT 모델 실행의 증거로 세지 않는다.
