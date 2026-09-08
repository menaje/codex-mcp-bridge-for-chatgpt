# 브리지 도구 설명·입출력 스키마 검토

후속 코드 분석으로 일부 제안을 조정했다. 적용 판단은 [코드 적합성 재검토](/Volumes/Data/Dev/codex-mcp-bridge/docs/audits/2026-09-08-tool-guidance-code-fit.md)를 우선한다. F02·F03·F06은 구현 방식을 수정했고, F07의 최근 100개 제한에 따른 유효 과거 응답 누락 우려는 철회했다.

검토일: 2026-09-08. 대상: HEAD 54296e0f0010 위의 현재 작업 디렉터리. 이 문서는 검토와 변경 제안이며 운영 도구 수정·배포 결과가 아니다.

검토한 도구는 총 30개다. GPT 공개 도구 15개와 카드·앱 전용 비공개 도구 15개의 설명, 입력·출력 스키마, 공개 범위, 카드 연결 정보를 확인했다. 격리된 실제 MCP 서버에 17개 조회·입력 검사를 수행했고 Codex 실행 요청은 0회였다.

가장 먼저 고칠 항목은 **사용자가 지정한 프로젝트가 접근 불가일 때 다른 프로젝트로 재실행하라는 복구 안내**다. 그다음으로 오류의 다음 행동을 구조화하고, 프로젝트 조회를 정상적인 조회 결과로 반환해야 한다. 이 작업과 함께 설명을 줄여야 하며, 문구만 축약하면 현재의 모호함이 남는다.

## 1. 적용할 기준

| 위치 | 담을 내용 | 옮길 내용 |
| --- | --- | --- |
| 도구 설명 | 무엇을 하는지, 대상 범위, 호출의 중요한 효과 | 반환 필드 나열, 내부 구현, 오래된 호환 이력, 개별 오류별 복구 순서 |
| 입력 스키마 | 필드 의미, 형식·범위, 기본값, 모드별 필수·금지 입력, 동일 요청 재시도 규칙 | 다른 도구를 차례로 호출하라는 장황한 절차 |
| 출력·오류 응답 | 실제 현재 상태, 전달·실행 여부, 문제가 된 대상, 실행 가능한 다음 단계와 정확한 인자 | 상황과 무관한 설정 카드 열기, 새 작업 생성, 다른 프로젝트 선택 |
| 공통 지침 | GPT의 판단 책임, 사용자 위임 범위, 질문·권한 승인 구분, 표시 정책, 중복 실행 방지 | 각 도구 설명과 반복되는 상세 사용 설명, 마이그레이션 가이드 |
| 개발 문서 | 구현 방식, 호환성 이력, 예시, 운영·복구 상세 절차 | 매 호출 시 GPT에게 계속 보여줄 필요 없는 내용 |

사용자가 제안한 “설정할 수 있는 도구” 수준의 설명은 설정 카드에 적합하다. 다만 모든 제약을 없애지는 않는다. 취소의 영향 범위, 질문 도구로 권한을 승인할 수 없다는 경계, 전달 여부가 불확실할 때 자동 재전송하지 않는 규칙은 의미 있는 계약이다.

현재 공통 지침은 영어 공백 단위 1,681단어, 공개 도구 설명 합계는 1,323단어다. codex_task 하나가 351단어다. 이는 토큰 수나 절감 효과를 측정한 수치가 아니다. 길이보다 중복과 서로 다른 안내가 생기는 것이 문제다.

## 2. 우선 수정할 사항

### F01 · P1 · 요청한 프로젝트 대신 다른 프로젝트를 재시도 대상으로 제시

**재현:** Alpha와 Beta를 등록한 뒤 Alpha 폴더를 사용할 수 없게 했다. projectLookup.name=Alpha의 결과는 PROJECT_UNAVAILABLE이었지만 nextActions는 Beta의 정확한 selector를 넣어 codex_task를 재시도하라고 안내했다.

**원인:** projectLookupResult가 복구 함수에 요청한 프로젝트를 전달하지 않는다. 복구 함수는 선택 가능한 프로젝트가 하나이면 그것을 사용한다.

**영향:** GPT가 안내를 따르면 사용자가 지정하지 않은 프로젝트에서 새 작업을 실행할 수 있다. 이번 검사에서 실제 새 작업을 실행하거나 사용자 파일을 변경하지는 않았다.

**수정:** 복구 안내에도 원래 요청의 프로젝트 식별자를 유지한다. 해당 프로젝트를 복구하거나, 사용자의 요청·대화 맥락에 따라 GPT가 새 대상을 결정하는 별도 단계로 연결한다. 유일하게 남은 프로젝트를 자동 대체 대상으로 제시하지 않는다.

근거: [조회 결과 생성](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:16883), [복구 대상 선택](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:16909), [프로젝트 자동 대체 금지 공통 지침](/Volumes/Data/Dev/codex-mcp-bridge/src/server.ts:47). 검사: requested-folder-unavailable-with-another-project.

### F02 · P2 · 오류 응답으로 옮겨야 할 도구 이름·인자를 실제로 버리고 있음

PROJECT_SETUP_REQUIRED는 내부에서 nextAction에 tool=codex_settings, arguments={}, 사용자 안내문을 만든다. 공개 응답을 만들 때 사용자 안내문만 선택하므로 GPT가 받는 nextActions에는 “Open settings and register…”만 남는다. 다른 경로에서도 대상 ID를 괄호로 붙인 문자열로 축약한다.

따라서 현재 구조에서 설정 도구 설명의 복구 안내를 삭제하기만 하면, 정확한 도구 호출 정보가 더 부족해진다.

**수정:** 다음 행동에 도구 이름과 검증된 인자를 보존한다. 자유 형식 arguments 객체 대신 도구별 제한된 분기를 사용한다. 사용자 설명은 별도 message/reason으로 둔다. 복구 안내는 허용된 다음 선택지를 설명하며 사용자 위임이나 저장된 접근 정책을 확대하지 않는다.

17개 검사 중 오류 16개에서 8개는 구조화된 결과가 있고, 8개는 문자열 오류만 반환했다. 이는 선정한 표본의 결과이며 전체 오류 경로의 비율은 아니다. codex_input, codex_user_answer, 질문 ID 중복, 카드 입력 오류도 동일한 오류 구조로 다룰 필요가 있다.

근거: [문자열 nextActions 스키마](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:373), [공개 응답 투영](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:16510), [설정 필요 오류](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:16961). 검사: no-registered-project 및 content-only 오류 8건.

### F03 · P2 · 프로젝트 조회가 실행 도구에 섞이고 조회 성공도 실패로 표시됨

존재하는 Alpha를 조회해도 isError=true, state=failed, terminal=true, error.code=PROJECT_SELECTION_REQUIRED가 반환된다. 성공한 조회의 selector는 typed project 필드가 아닌 영어 재시도 문장 안에 JSON으로 들어 있다. 조회만 하더라도 실행용 prompt가 필수라서 이를 생략하면 입력 검증 오류가 난다.

**수정:** 카드 없는 프로젝트 조회 도구를 두는 방안을 우선 권한다. 이름 목록·사용 가능 상태·정확한 selector를 정상 성공 결과로 제공하고, 실행용 prompt나 requestId는 요구하지 않는다. 도구 수를 유지해야 한다면 명시적인 lookup/run 분기와 별도 성공 결과를 둔다. 어느 경우든 조회 성공을 실패로 전달하지 않는다.

codex_task의 annotation은 실행 가능한 운영자 상한을 나타낸다. 그 도구에 읽기 조회를 넣으면 조회에도 실행용 annotation이 적용된다. 현재 격리 검사는 읽기 전용 상한이므로 실제 서비스의 파괴적 실행 annotation을 검증한 것으로 해석하지 않는다.

근거: [조회 입력과 필수 prompt](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:13830), [조회 성공을 사전 오류로 반환](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:16900). 검사: lookup-without-execution-prompt, lookup-existing-project.

### F04 · P2 · 상태 조회 실패가 새 작업 생성으로 이어지는 안내

존재하지 않는 작업 ID를 codex_status로 조회하면 “Unknown Codex job id. Start a job through codex_task first.”가 반환된다. 기존 결과를 복구하려던 GPT에게 새 작업 실행을 권한다. 보관된 답변을 되찾기 위해 새 작업을 시작하지 말라는 공통 지침과도 맞지 않는다.

**수정:** 현재 대화의 작업 목록이나 확인된 ID를 조회하도록 안내한다. 해당 작업이 이 대화에서 조회되지 않는다는 사실을 전달하고, 다른 대화의 존재나 내용을 노출하지 않는다. 새 작업 생성은 별도의 사용자 의도에 따라 결정한다.

근거: [작업 ID 미존재 처리](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:5071), [결과 복구 공통 지침](/Volumes/Data/Dev/codex-mcp-bridge/src/server.ts:56). 검사: unknown-job-status.

### F05 · P2 · 등록 없음·보관됨·접근 불가·미선택을 충분히 구분하지 못함

현재 resolve는 등록 전체가 아닌 보관되지 않은 항목 수로 PROJECT_SETUP_REQUIRED를 결정한다. 실제로 등록된 두 프로젝트를 모두 보관하면 “프로젝트를 등록하라”는 같은 메시지가 나온다. 보관 해제 가능성을 알려주지 않는다.

보관되지 않은 두 프로젝트의 폴더가 모두 접근 불가인 경우에는 PROJECT_REQUIRED와 “복구 또는 등록”이라는 합쳐진 안내가 나온다. 어떤 기존 항목에 문제가 있는지와 등록 자체가 필요한지가 분리되지 않는다.

또한 모델과 프로젝트를 모두 생략하면 현재는 MODEL_SELECTION_REQUIRED부터 나온다. 그러므로 공통 설명에서 “새 작업이면 항상 먼저 설정 카드를 연다” 같은 절차를 만들지 말고, 실제 응답의 현재 상태를 따라야 한다.

**수정:** 아래 상태를 구분해 전달한다. 명시적으로 요청한 프로젝트의 이름·참조는 복구 과정에서도 유지한다.

| 현재 상태 | 다음 안내 |
| --- | --- |
| 등록 항목 자체가 0개 | codex_settings로 등록 UI 열기 |
| 등록 항목이 모두 보관됨 | 기존 항목 확인 후 필요한 보관 해제 |
| 요청한 프로젝트 폴더가 접근 불가 | 해당 프로젝트 복구 안내 |
| 사용 가능한 프로젝트가 있으나 미선택 | 카드 없는 조회로 목록·selector 확인 후 요청에 맞게 선택 |
| selector만 오래됨 | 같은 프로젝트의 최신 selector 재조회 |
| 요청한 이름이 없음 | 조회 결과에 없음을 알리고 대상 확인; 다른 프로젝트를 자동 선택하지 않기 |

근거: [등록 상태 판정](/Volumes/Data/Dev/codex-mcp-bridge/src/projectRegistry.ts:259), [통합 복구 문구](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:16920). 검사: no-registered-project, registered-but-all-archived, registered-but-all-folders-unavailable, project-not-selected, model-and-project-both-unspecified.

### F06 · P2 · 작업 카드의 모드별 입력 계약과 표시 안내가 불일치

codex_activity의 공개 스키마는 mode, presentationId, activityId를 모두 선택 입력으로 둔다. compact-monitor에서 presentationId가 필수이고 full-history에서는 금지라는 관계는 설명·실행 시 검사에만 있다. compact-monitor만 보내면 공개 스키마가 표현하지 못한 필수 조건 때문에 실행 시 오류가 난다.

도구 설명과 mode 필드는 작업 실행 후 compact-monitor를 호출하라고 반복하지만, 공통 지침은 저장된 always/background-only/never 정책을 적용한다. 서버는 never를 실제로 거부하므로 정책 우회가 재현된 것은 아니다. 불필요한 호출과 오류를 유도할 수 있는 설명 충돌이다.

**수정:** 두 모드를 구분하는 입력 분기를 만들고 기존 생략=full-history 호환성을 보존한다. 설명은 카드 목적에 집중한다. 자동 표시 필요 여부는 작업 결과와 공통 표시 정책에서 결정한다. compact 카드의 감시·완료 알림 소유권이라는 중요한 효과는 유지한다.

근거: [공개 스키마](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:5471), [모드·표시 정책 실행 시 검증](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:5504). 검사: compact-card-without-presentation-id.

### F07 · P2 · 사용자 답변 목록과 실제 답변 읽기의 의미가 흐림

codex_user_answer에서 responseRef를 생략하면 읽지 않은 참조 목록 최대 20개를 반환한다. 답변 본문은 없고 읽음 처리도 하지 않는다. 특정 responseRef를 보내면 본문을 반환하고 읽음 처리한다. 하지만 설명의 “Reading marks the response as seen”은 두 동작을 구분하지 않고, 출력도 같은 responses 배열에 선택적 질문·답변 필드만 둔다.

**수정:** 같은 도구 안에서 discover/read 역할을 필드 설명과 결과 형태로 분명히 한다. 목록에는 항목 수·추가 항목 여부를, 상세에는 실제 읽음 여부를 나타내는 명확한 필드를 검토한다. 현재 “최근 100개를 조회한 뒤 미확인 20개 선별” 방식에는 커서가 없으므로 복구 목록의 완전성을 보장한다고 설명하지 않는다. 별도의 재현 없이 모든 과거 답변이 누락된다는 결론을 내리지는 않는다.

읽음 기록이 있다는 이유만으로 조회 도구의 readOnlyHint를 잘못됐다고 판정하지 않는다. 다만 그 효과와 “목록 조회만으로 GPT가 답변을 읽은 것은 아님”은 계약에 드러나야 한다.

근거: [도구와 결과 구성](/Volumes/Data/Dev/codex-mcp-bridge/src/questionTools.ts:129), [읽음 처리](/Volumes/Data/Dev/codex-mcp-bridge/src/questionStore.ts:109).

### F08 · P3 · 설명 중복과 카드 없는 설정 판단 정보의 부족

codex_task는 실행·프로젝트 조회·모델 선택·이전 백엔드 이전·설명 갱신·결과 읽기·카드 표시까지 설명한다. codex_settings는 카드 열기와 상세 설정 조회를 함께 강조한다. codex_models는 사용 가능한 모델·추론 조합을 주지만 현재 모델 정책이 fixed인지 automatic인지는 반환하지 않는다. 이 모드에 따라 codex_task.selection의 사용법이 달라진다.

**수정:** 설정 카드 설명은 목적 한 문장으로 줄인다. GPT에게 실제로 필요한 정책 모드는 카드 없는 적절한 조회 결과나 구체적인 정책 오류에서 전달한다. 이를 위해 앱 전용 설정 변경 도구를 공개하거나 전체 내부 설정을 노출할 필요는 없다. 실행 스키마의 안정된 contract/envelope 값과 런타임 정책 검증은 보존한다.

이전 실제 브라우저 검토에서는 한 색상 시험 구간에서 동일한 설정 카드가 5회 열렸고 설정 revision은 같았다. codex_settings 호출에는 카드 UI가 연결되어 있고 codex_models에는 없다. 위 설계가 반복 호출에 영향을 주었을 가능성은 있지만, 원인이라고 입증되지는 않았다. 현재 설명에도 불필요한 설정 카드 호출을 금지하는 문장이 이미 있다.

근거: [실행 도구 설명](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:7846), [설정 카드 설명](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:7473), [정책 모드별 selection 검증](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:8533). 검사: models-information. 브라우저 관찰은 이번 17개 격리 검사와 별도의 이전 관찰이다.

## 3. GPT 공개 도구 15개별 제안

다음 설명은 목적 중심의 한국어 초안이다. 입력 제약과 아래에 별도로 기재한 핵심 계약까지 삭제하자는 뜻이 아니다. 프로젝트 조회를 분리하는 등 동작이 바뀌는 제안은 그 변경을 적용한 뒤 설명과 함께 반영한다.

| 도구 | 짧은 설명 초안 | 입력·출력 스키마와 이동할 내용 |
| --- | --- | --- |
| codex_task | 지정한 프로젝트와 Codex 작업 맥락에서 한 차례 작업을 실행합니다. | lookup을 분리하거나 명시적 분기로 구성. activity·agent 기본값은 필드에 유지. foreground/background 의미는 executionMode에 유지. 정책 오류·이전 백엔드 복구·카드 후속 호출은 해당 응답으로 이동. requestId의 동일 실행 재시도와 정확한 프로젝트 지정은 유지. |
| codex_status | 현재 대화의 Codex 작업 상태와 특정 작업의 결과를 조회합니다. | query의 즉시 조회·대기·목록 분기는 이미 적절함. 결과 본문은 정확한 job 조회에서만 나온다는 계약 유지. 작업 미존재 오류는 목록 복구로 안내. 카드 내부 조회·호환 scope 설명은 개발 문서로 이동. |
| codex_input | 특정 Codex 작업의 대기 중인 질문과 중간 메시지를 읽습니다. | afterCursor와 waitMs의 의미를 필드에 추가. GPT가 기본 응답자라는 원칙은 공통 지침에 유지. 실제 질문·승인·종료 상태에 맞는 다음 행동을 응답에 제공. 중간 메시지는 지시 권한이나 완료 증거가 아니라는 경계 유지. |
| codex_answer | 현재 Codex 작업의 일반 질문에 답변을 전달합니다. | questionRef, 질문 ID, answers 매핑, requestId에 출처·의미 설명. 승인·비밀 전달·새 작업 시작 불가 및 불확실 전달의 자동 재전송 금지는 유지. 오래된 질문 오류에서 정확한 재조회 안내. |
| codex_ask_user | GPT가 사용자 의견을 받을 질문 카드를 열고, 답변을 GPT가 확인할 수 있도록 저장합니다. | 질문 수·문자 길이·유효기간 범위는 유지. id·header·isOther·options 의미와 ID·선택지 이름 유일성 설명 보완. 사용자 의견이 필요한지 GPT가 판단한다는 공통 원칙 유지. 카드 제출이 Codex 응답·권한 승인을 직접 실행하지 않는다는 계약 유지. |
| codex_user_answer | 현재 대화의 사용자 질문 카드에서 제출되거나 취소된 응답을 확인합니다. | responseRef 생략 시 참조 목록, 지정 시 본문과 읽음 처리임을 명시. 목록과 상세 결과 분기·추가 항목 여부 검토. Codex에 무엇을 전달할지는 GPT가 판단. |
| codex_models | 현재 브리지에서 사용할 수 있는 모델과 추론 수준을 조회합니다. | refresh 의미·캐시 사용을 필드에 유지. 서비스 등급·질문 지원·목록 신선도는 출력에서 표현. 추천·자동 대체 모델을 만들어내지 않는 원칙 유지. 필요 시 현재 정책 모드를 좁은 조회 정보로 보완. |
| codex_settings | 사용자가 브리지를 설정할 수 있는 대화형 설정 카드를 엽니다. | refreshModels는 해당 필드에만 설명. 반환 필드 목록과 PROJECT_SETUP_REQUIRED 등 조건별 호출 지시 삭제. 실제 복구 응답에 정확한 도구·인자를 보존한 뒤 적용. |
| codex_activity | 현재 대화의 Codex 작업 현황을 카드로 보여줍니다. | compact-monitor/full-history 입력 분리. 표시 정책과 작업별 다음 행동에 따라 호출. 자동 감시·완료 알림 소유권은 모드 효과로 유지. |
| codex_dashboard | 브리지에 보관된 여러 대화의 Codex 작업 현황을 카드로 보여줍니다. | 입력 없음 유지. 현재 대화용 activity/status와 범위 차이는 설명에 유지. 상세 상태 출처·내부 조회 방법은 출력·문서로 이동. 실제 Codex 상태와 GPT 검증 판단 구분은 유지. |
| codex_agent | 현재 대화의 Codex 에이전트를 보관·복원하거나 표시 이름을 바꿉니다. | operation 분기와 rename.name 필수 관계는 이미 적절함. 요청 ID와 불변 agentId의 의미 유지. 비공개 복구·프로세스 제어 도구 안내는 제거. |
| codex_steer | 실행 중인 특정 Codex 작업에 추가 지침이나 일반 메시지 질문의 답변을 전달합니다. | 정확한 현재 버전·현재 턴 한정·새 턴을 만들지 않는 계약 유지. 구조화 질문·권한 승인 처리와 구분. 종료 상태의 다음 작업 생성 절차는 해당 오류로 이동. 불확실 전달 자동 재전송 금지는 유지. |
| codex_cancel | 특정 Codex 작업을 중단합니다. 이미 변경한 파일은 되돌리지 않습니다. | 버전·이유·동일 요청 재시도·공유 작업자 영향 확인 필드는 유지. 취소 의도 기록·내부 프로세스 종료 절차는 문서로 이동. 확인된 실제 중단과 중단 요청 접수는 출력에서 구분. |
| codex_activity_update | 작업 묶음의 진행·검증 상태나 정책을 변경합니다. | 구분된 operation과 검증 근거 입력 유지. set-policy는 이미 최소 한 항목을 요구함. 현재 상태에서 가능한 전환은 오류 응답에 제공. Codex 출력 자체는 상태 변경 권한이 아니라는 공통 경계 유지. |
| codex_activity_cancel | 작업 묶음에 속한 실행 중인 Codex 작업을 모두 중단합니다. 이미 변경한 파일은 되돌리지 않습니다. | 작업 묶음 버전·이유·공유 작업자의 정확한 영향 범위 확인은 유지. codex_cancel과 대상 범위가 다르므로 별도 도구 유지. |

질문 도구 네 개에는 현재 입력 필드 description이 하나도 없다. 길이·형식 제한은 존재하지만 requestId, questionRef, responseRef 등의 의미를 루트 설명에 의존한다. 특히 카드 질문의 id와 Codex 질문의 id를 혼동하지 않도록 출처를 필드에 적는 것이 좋다. 단순 uniqueItems만으로 객체 배열의 특정 id 중복을 막을 수 없으므로 서버의 유일성 검증도 유지한다.

## 4. 카드·앱 전용 도구 15개

이 도구들은 model 공개 설명과 구분해야 한다. 현재 app/private 표시를 유지하고, GPT가 도구를 고르기 쉽게 만들기 위한 정리와 카드 내부 계약 변경을 분리한다. 모르는 비공개 도구를 GPT가 직접 호출하라는 후속 안내를 만들지 않는다.

| 도구 | 검토 결과와 제안 |
| --- | --- |
| codex_question_card | 목적 설명이 이미 짧음. questionId·revision·presentationToken 검증 유지. 복원은 질문 카드 상태 조회이며 작업 감시 소유권을 얻지 않음. |
| codex_question_submit | 답변 저장과 취소가 구분된 입력이 적절함. 제출 불변성과 “GPT용 저장, Codex 직접 응답 아님”을 유지. |
| codex_question_notify | 알림 요청과 확인 분기가 적절함. notification acknowledgment와 실제 GPT 읽음을 구분하는 계약 유지. |
| codex_dashboard_snapshot | 카드 데이터 조회 목적만 설명에 남기고 단계적 보강·구버전 기본값을 enrich 필드와 호환 문서로 이동. 범위 검증·페이지 경계 유지. |
| codex_diagnostics | 진단 목적 설명으로 줄이고 반환 세부 항목은 출력 스키마로 이동. 운영자 전용 범위와 “도구 목록 재조회가 GPT 적용의 증거는 아님”을 유지. |
| codex_activity_rehydrate | 사라진 카드 정보를 재구성하는 목적에 집중. 조회 근거가 job/request인지 full-history인지 입력 분기 검토. 복구만으로 감시·완료 알림 소유권을 얻지 않는 제한 유지. |
| codex_activity_snapshot | 카드 상태 조회·대기 및 감시 세션 갱신 효과 유지. enrich 생략의 기존 의미와 현재 카드의 명시적 false/true 사용을 정확히 구분. |
| codex_activity_handoff | 설명이 이미 짧음. 현재 자동 카드의 소유권·outbox 대상·claim/ack 의미 유지. |
| codex_agent_recovery_detach | 복구 전용이며 기본 비활성화라는 제한 유지. 현재 유휴 상태·정확한 버전 검사는 설명을 줄여도 제거하지 않음. |
| codex_background_process_terminate | 대상 프로세스와 현재 카드·에이전트 근거 유지. 파일 변경을 되돌리지 않는 효과 유지. 내부 검증 순서는 문서로 이동 가능. |
| codex_activity_job_cancel | 카드에서 선택한 작업 취소라는 목적에 집중. 현재 카드·버전·작업 범위·중복 요청 검증 유지. |
| codex_interaction_respond | 일반 질문용 공개 codex_answer와 구별되는 앱의 실제 상호작용 경로 유지. response 종류별 입력과 현재 요청 검증·비저장 계약 보존. |
| codex_job_steer | 카드에서 현재 턴에 추가 지침을 보내는 목적에 집중. 현재 카드·작업 버전 검증 유지. |
| codex_settings_snapshot | 설정 카드 데이터 조회 목적에 집중. 카드 초기 표시 절차는 구현 문서로 이동. 모델 강제 갱신 의미는 refreshModels에 유지. |
| codex_update_settings | 설정 변경·초기화 목적과 주요 효과 유지. 설정 revision과 registry revision의 별도 충돌 검증 보존. 변경 종류별 필수 revision을 스키마에 더 표현할지 검토. 등록 삭제는 폴더 삭제가 아니며 초기화는 프로젝트 목록을 유지한다는 효과 명시. |

앱 전용 스키마 변경은 이미 배포된 변경 불가능한 과거 카드의 입력과 함께 검토해야 한다. 새 설명에 맞춘다는 이유로 기존 runtime 호환 입력을 즉시 삭제하면 안 된다.

## 5. 유지할 좋은 구조와 경계

- 조사한 입력·출력 스키마의 객체는 닫힌 객체이거나 값 타입이 지정된 dictionary다. 임의 속성을 무제한 허용하는 객체는 발견하지 않았다.
- codex_status의 기다림 분기는 waitMs를 쓸 때 waitFor를 필수로 표현한다. 이 도구에 관계 조건이 없다고 지적하면 잘못이다.
- codex_activity_update의 set-policy.policy에는 이미 minProperties=1이 있다. runtime 오류가 있었다는 이유로 공개 스키마에 제한이 없다고 판단하지 않는다.
- 공개 GPT 입력에는 카드 증명이나 운영자 복구용 scope를 끌어올리지 않는다.
- 안정된 task 계약과 실행 상한, 저장된 정책의 실행 시 검증, 원래 프로젝트에 고정된 작업 맥락을 보존한다. 표시용 스키마를 매 설정 변경마다 다시 만들어야 하는 구조로 되돌리지 않는다.
- requestId, 정확한 버전·대상, 불확실 전달 처리, 일반 질문과 권한 승인 구분은 설명 축약 대상과 별개다.

## 6. 오류 응답 형식 제안

아래는 **제안하는 필드 일부**이며 현재 응답이나 완성된 전체 스키마가 아니다.

~~~json
{
  "state": "setup-required",
  "error": {
    "code": "PROJECT_SETUP_REQUIRED",
    "message": "등록된 프로젝트가 없습니다."
  },
  "projectAvailability": {
    "registered": 0,
    "selectable": 0
  },
  "nextActions": [
    {
      "kind": "tool",
      "tool": "codex_settings",
      "arguments": {},
      "reason": "사용자가 작업할 프로젝트를 등록할 수 있도록 설정 카드를 엽니다."
    }
  ]
}
~~~

각 nextAction은 실행 가능한 정확한 도구·인자 또는 필요한 사용자 결정을 나타내야 한다. 도구별 arguments를 제한하고, 요청한 프로젝트나 유지해야 할 sandbox를 조용히 바꾸는 복구안을 생성하지 않는다. 새 requestId가 필요한 사전 검증 수정과 동일 requestId로 조회할 수 있는 이미 접수된 실행 재시도를 구분한다.

정상 프로젝트 조회는 error 없이 matched/missing/unavailable 등의 명시적 결과와 공개 selector를 반환한다. 조회 도구의 후보 이름으로 codex_projects를 생각할 수 있지만 **현재 존재하는 도구가 아니라 신규 제안**이다.

기존 문자열 nextActions를 구조화 객체로 바꾸는 것은 출력 계약 변경이다. 호스트·오래된 도구 목록·기존 검증 fixture와의 호환 계획을 세우고 새 버전 또는 점진적 필드 추가로 처리한다.

## 7. 적용 순서와 검증

1. 잘못된 프로젝트 재시도, 상태 조회 실패의 새 작업 지시, 등록·보관·접근 불가 안내를 고친다.
2. 오류와 다음 행동의 구조를 통일하고 정확한 호출 정보를 보존한다.
3. 프로젝트 조회 역할, 카드의 모드별 입력, 사용자 답변 목록·상세 구분을 정리한다.
4. 공개 도구 설명을 위 목적 문장 중심으로 줄이고 공통 지침·필드 설명·오류 응답 사이의 중복을 제거한다.
5. 변경한 계약과 구버전 호환을 검증한 뒤 실제 ChatGPT에서 설정·작업·질문 카드 호출을 확인한다.

후속 구현의 필수 확인 항목은 요청 프로젝트 접근 불가 시 다른 프로젝트로 넘어가지 않는지, 등록 없는 경우와 모두 보관된 경우의 안내가 다른지, 조회 성공을 실패로 표시하지 않는지, 조회 실패만으로 새 작업을 실행하지 않는지, 저장된 never 정책에서 자동 카드 안내가 나오지 않는지다. 질문 답변과 권한 승인의 분리 및 불확실 전달의 중복 방지는 기존 회귀 검사를 유지한다.

## 8. 이번 검토의 검증 범위

[격리 검사 스크립트](/Volumes/Data/Dev/codex-mcp-bridge/scripts/audit-tool-guidance.ts)는 실제 createBridgeMcpServer를 메모리 저장소·임시 Alpha/Beta 프로젝트·가짜 모델 목록과 연결한다. SDK tools/list를 읽고 실제 tools/call 경로로 검사한다. upstream.callTool은 요청이 생기면 실패하도록 막았으며 호출 수 0을 확인했다.

17개 검사는 모델·프로젝트 입력 누락, 등록 없음, 미선택, 실행 prompt 없는 조회, 정상·미존재 프로젝트 조회, 모델 목록, 미존재 작업 상태·질문 조회, 잘못된 기다림 입력, 미존재 사용자 답변, 중복 질문 ID, 빈 정책 변경, 카드 ID 누락, 요청 폴더 접근 불가, 모든 폴더 접근 불가, 모두 보관된 프로젝트를 포함한다. 정상 모델 조회 1건, 오류 응답 16건이다. 정상 프로젝트 조회가 오류로 반환되는 사례는 발견 사항으로 기록했다.

감사 스크립트의 TypeScript 검사를 통과했다. 실제 ChatGPT 모델의 도구 선택을 새로 시험하거나 운영 서비스를 다시 시작하지 않았다. 운영 기능 테스트의 통과나 이후 수정의 해결 증거로 이 검토를 사용하지 않는다.

[기계 판독용 검토 근거](/Volumes/Data/Dev/codex-mcp-bridge/docs/audits/2026-09-08-tool-guidance-review.json)에 도구별 현재 설명·스키마 요약·검사 결과를 보존한다. 전체 raw tools/list는 재현 스크립트가 output/tool-guidance-audit에 생성한다.
