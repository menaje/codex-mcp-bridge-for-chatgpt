# 도구 설명·스키마 제안의 코드 적합성 재검토

이 문서와 같은 이름의 JSON은 #69·#70 통합 전의 분석 기록이다. 최종 반영은
[구현 기록](2026-09-08-tool-guidance-implementation.md)과
[후속 검토](2026-09-08-tool-guidance-completion-review.md)를 따른다.
아래 새 프로젝트 도구 제안은 기존 `codex_status`의 프로젝트 조회로 대체됐고,
신규 Activity 카드의 모드 개선 제안은 해당 화면 제거로 대체됐다.

검토일: 2026-09-08. 대상: HEAD 54296e0f0010 및 현재 미커밋 작업 디렉터리. 설치된 MCP SDK 1.29.0, Zod 4.4.3을 기준으로 확인했다.

[이전 검토](/Volumes/Data/Dev/codex-mcp-bridge/docs/audits/2026-09-08-tool-guidance-review.md)의 8개 제안은 **4개 유지, 3개 구현 방식 수정, 1개 일부 철회**로 정리한다. 설명을 목적 중심으로 줄이는 방향은 적합하다. 하지만 출력 스키마와 공통 응답 코드를 일괄 변경하는 방식은 현재 구현에 맞지 않는다.

30개 도구 등록 함수에서 입력 검증·업무 처리·저장·출력 변환을 추적하고, 공통 실행 경로 및 카드·SDK·네이티브 설정 클라이언트의 소비 경로를 확인했다. 별도의 격리 검사에서 23개 관찰 결과를 기록했다. 현재 코드의 관련 검사 6개 파일, 235개 테스트는 통과했다. 운영 도구 수정·배포나 실제 Codex 실행은 하지 않았다.

## 1. 제안별 최종 판단

| 이전 항목 | 판단 | 코드 분석으로 확정한 변경 방향 |
| --- | --- | --- |
| F01 다른 프로젝트 재시도 안내 | 유지 | 실행 대상 검증은 이미 올바르게 차단한다. 고칠 곳은 요청 대상을 잃어버리는 조회 복구 안내다. resolver의 프로젝트 고정·버전 검증은 유지한다. |
| F02 다음 행동과 오류 구조화 | 구현 방식 수정 | 기존 문자열 계약 안에서 도구·필요 인자를 정확히 안내하는 수정부터 한다. 공통 객체 응답을 모든 도구에 바로 도입하지 않는다. 새 출력 계약, 구형 클라이언트, 크기 제한, 불완전한 내부 action을 함께 다뤄야 한다. |
| F03 조회·실행 분리 | 구현 방식 수정 | 새로운 카드 없는 프로젝트 조회 도구가 더 적합하다. 기존 codex_task v2에 최상위 lookup/run union을 바로 넣거나 lookup 성공 응답을 교체하지 않는다. 기존 조회 경로는 구형 호출 호환용으로 남긴다. |
| F04 조회 실패의 새 작업 지시 | 유지·범위 확대 | codex_status뿐 아니라 codex_cancel에도 같은 메시지가 있다. 둘 다 현재 대화의 대상 확인·조회로 안내해야 한다. |
| F05 등록·보관·접근 불가 구분 | 유지 | 신규 프로젝트 선택을 위한 안내에서 상태를 구분한다. 이미 실행한 작업의 고정된 폴더·프로젝트나 정확한 재시도 경로에는 새 등록 상태를 덮어씌우지 않는다. |
| F06 카드 모드별 입력 | 구현 방식 수정 | 공개 JSON Schema는 객체 루트를 유지하면서 조건을 표현한다. 현재 runtime 객체와 모드 검사·생략 기본값을 보존한다. 최상위 Zod union은 사용하지 않는다. |
| F07 사용자 답변 조회 구분 | 일부 철회 | 필드 설명 보완은 적합하다. 최근 100개 제한에 따른 유효 과거 답변 누락 우려는 현재 정상 경로에 해당하지 않는다. 신규 operation·커서를 우선 도입할 근거도 부족하다. |
| F08 설명 중복·정책 정보 부족 | 유지 | 설정 카드 설명은 바로 줄일 수 있다. 모델 정책 모드의 정보 공백은 실제로 재현됐다. 카드 없는 좁은 정책 조회 정보를 제공하되, 출력 변경은 새 계약 전환 절차를 따른다. |

## 2. 실제 계약은 다섯 경계로 나뉨

| 경계 | 실제 코드 | 제안에 미치는 영향 |
| --- | --- | --- |
| GPT가 읽는 tools/list | SDK가 등록된 Zod 객체를 JSON Schema로 변환. withJsonSchemaProjection은 공개 모양만 교체 | 공개 스키마를 바꿔도 runtime 입력 허용 범위가 저절로 바뀌지 않는다. |
| tools/call 입력 검증 | SDK validateToolInput → runtime Zod safeParseAsync | 문법·필수 필드 오류는 도구 handler에 들어오기 전에 발생한다. handler의 catch만 통일해서는 모든 오류를 바꿀 수 없다. |
| 업무 검증·저장·전달 | 도구 handler → scope·정책·버전 검증 → 저장소/상위 Codex | 서버 상태에 따른 조건은 JSON Schema만으로 표현할 수 없다. 이미 전송했는지도 여기서 구분된다. |
| 공개 응답 변환 | projectToolResult → 도구별 outputSchema.parse·크기 제한 → SDK | 공통 객체를 반환하는 helper 하나만 바꾸면 각 도구의 닫힌 스키마가 거부한다. |
| 실제 소비자 | SDK 클라이언트의 캐시된 validator, GPT structuredContent, 카드의 _meta·structuredContent·text, 네이티브 설정 서비스 | 서버 내부 검증 통과만으로 호환성을 보장할 수 없다. 카드 전용 결과와 GPT 공개 결과도 구분해야 한다. |

근거: [공개 스키마 투영](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:13945), [자체 결과 검증](/Volumes/Data/Dev/codex-mcp-bridge/src/toolResultContracts.ts:120), [SDK 입력·출력 검증](/Volumes/Data/Dev/codex-mcp-bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:166), [클라이언트 캐시 검증](/Volumes/Data/Dev/codex-mcp-bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js:496).

**정적인 입력 관계**와 **현재 서버 상태에 따른 조건**을 분리해야 한다. compact-monitor이면 presentationId가 필요하다는 관계는 공개 스키마에 표현할 수 있다. 현재 정책이 fixed인지, 작업이 여전히 실행 중인지, 질문이 같은 worker의 같은 턴에 속하는지는 runtime에서 판단해야 한다.

## 3. 구조화된 다음 행동을 그대로 도입할 수 없는 이유

### 3.1 기존 출력 계약과 캐시된 클라이언트가 거부함

현재 nextActions는 문자열 배열이다. 기존 클라이언트가 그 스키마를 저장한 상태에서 서버가 객체 배열을 반환하도록 바꾸는 격리 실험을 했다. 서버에는 새 스키마를 적용했지만 클라이언트가 data/nextActions/0 must be string 오류로 거부했다.

기존 응답에 선택 필드 하나를 추가한 실험도 data must NOT have additional properties 오류로 거부됐다. **새 스키마에서 optional이라는 사실이 구형의 닫힌 스키마와 호환됨을 뜻하지 않는다.**

isError=true이면 안전하다는 가정도 성립하지 않는다. SDK 서버는 오류 결과의 outputSchema 검증을 생략하지만, SDK 클라이언트는 structuredContent가 있으면 오류 여부와 관계없이 캐시된 스키마로 검증한다. 기존 성공 스키마에 맞지 않는 공통 error 객체를 넣으면 클라이언트에서 다시 실패한다.

생산 코드의 SdkToolDescriptorCoordinator도 활성 연결이 있을 때 출력 스키마 교체를 DYNAMIC_OUTPUT_SCHEMA_CHANGE_REQUIRES_VERSIONED_CONTRACT로 차단한다. 비동기 작업 도중 validator가 바뀌는 것을 막기 위한 의도적인 보호다.

근거: [전환 차단](/Volumes/Data/Dev/codex-mcp-bridge/src/modelPolicyTransport.ts:220), [동작 중 계약 유지 검사](/Volumes/Data/Dev/codex-mcp-bridge/test/modelPolicyTransport.test.ts:422). 관찰: sdk-error-structured-content-still-validated, sdk-old-client-rejects-cached_actions, sdk-old-client-rejects-cached_additive.

### 3.2 내부 action이 항상 완성된 호출은 아님

codex_agent가 사용 중인 에이전트의 보관을 거부하는 AGENT_BUSY 결과에는 내부 forceStop이 있다. tool=codex_cancel이고 인자는 requestId, jobId, expectedVersion이다. 그런데 현재 codex_cancel의 필수 reason이 없다. 이 생산자 형태를 실제 공개 입력 스키마로 검사하면 거부된다.

따라서 modelNextActionProjection이 버리던 내부 객체를 그대로 내보내는 수정은 불충분하다. 원래 보관 요청이 실행 중단까지 허용하는지도 별개의 판단이다.

다음 행동은 최소한 다음을 구별해야 한다.

- 지금 조회할 수 있는 정확한 도구 호출.
- GPT가 답변·이유·대상을 채운 뒤 수행할 수 있는 행동.
- 사용자 판단이나 기존 승인 절차가 필요한 행동.
- 전송 결과를 확인해야 하며 자동 재시도하면 안 되는 상태.

이 구조를 도입할 때는 도구별 필수 인자를 검사하고 현재 버전·대상을 재확인해야 한다. 내부 action에서 자동 생성한 requestId를 모든 새 시도의 식별자로 사용하면 안 된다.

근거: [AGENT_BUSY 생산자](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:6152), [취소 입력·접수](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:6423). 관찰: internal-forceStop-is-not-a-complete-call. 이 관찰은 실제 활성 작업을 만든 검사가 아니라 생산자 입력 형태와 현재 공개 스키마의 대조 검사다.

### 3.3 작은 객체로 바꿔도 현재 스키마 예산을 초과함

동일한 계산 방식으로 공개 출력 스키마 합계는 18,719바이트이며 회귀 검사 상한은 19,500바이트다. 스키마 복사본의 nextActions 11곳에 설정·모델 조회 두 종류만 담는 작은 객체를 넣어도 21,106바이트가 됐다. 실제 작업·질문·취소 인자를 모두 포함하는 완성된 action 스키마를 측정한 것이 아니며, 단순 일괄 확장도 여유가 없다는 증거다.

작업 도구 자체의 입력·출력 합계는 회귀 검사에서 9,500바이트 이하를 요구한다. runtime의 전체 descriptor 하드 상한은 별도로 128 KiB다. 두 제한을 같은 것으로 취급하면 안 된다.

근거: [출력 합계 제한](/Volumes/Data/Dev/codex-mcp-bridge/test/outputContracts.test.ts:254), [작업 계약 크기 검사](/Volumes/Data/Dev/codex-mcp-bridge/test/tools.test.ts:1642), [runtime 상한](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:204). 관찰: inline-action-object-schema-budget.

### 3.4 적용 방법 수정

우선 기존 문자열 배열 형식을 유지하면서 PROJECT_SETUP_REQUIRED에 codex_settings와 필요한 인자를 정확히 표시하고 잘못된 복구 문구를 고치는 것이 적합하다. 그 뒤 구조화된 action을 도입한다면 새로운 출력 계약·클라이언트 재조회 경계·도구별 최소 형태·저장된 결과의 호환을 함께 설계해야 한다.

오류도 전부 “실행 전 실패”로 통일해서는 안 된다. codex_steer는 prepared/dispatching/delivered/uncertain 기록을 남긴다. codex_answer는 questionRef별 전송 시작을 기록해 다른 requestId로도 중복 전송을 막는다. 이 결과를 공통 예외 처리에서 “새 ID로 재시도”로 바꾸면 기존 전달 보장이 무너진다.

카드용 호환 text도 유지해야 한다. Activity 카드의 errorText는 문자열·message·error·content를 읽으며 structuredContent.error를 직접 읽지 않는다. Settings 카드의 오류 helper는 code를 보존하고 설정 revision 충돌을 감지해 다시 읽는다. 공개 오류 helper 변경을 카드·네이티브 서비스까지 일괄 적용할 이유가 없다.

근거: [질문 전송 기록](/Volumes/Data/Dev/codex-mcp-bridge/src/questionStore.ts:147), [steer 전달 상태](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:2966), [Activity 오류 소비](/Volumes/Data/Dev/codex-mcp-bridge/src/activityCard.ts:250), [Settings 오류 소비](/Volumes/Data/Dev/codex-mcp-bridge/src/settingsCard.ts:36).

## 4. 프로젝트 조회 분리와 복구 안내의 실제 수정 범위

현재 codex_task의 순서는 다음과 같다.

1. 입력 정규화와 대화 범위 확인.
2. 이미 접수한 requestId이면 저장된 실행의 hash·맥락으로 정확한 재시도 확인.
3. 새 호출의 contract/envelope 검증.
4. projectLookup이면 조회 결과 반환.
5. 일반 실행이면 Activity·Agent·모델·프로젝트 검증.
6. 비동기 준비 후 정책·프로젝트 재확인, 원자적 접수, 실제 Codex 전달.

조회는 실제 실행 전에 분기하지만, 실행용 prompt와 requestId, envelope 계약 안에 들어 있다. 기존 테스트는 조회 성공의 isError=true까지 명시적으로 기대한다. 이는 실수로 끼어든 한 줄이 아니라 현재 계약에 고정된 표현이다. 표현 자체는 개선해야 하지만 같은 v2 도구의 출력만 바꾸는 방식은 호환 문제를 만든다.

**새 카드 없는 조회 도구가 더 적합하다.** 기존 ProjectRegistry를 재사용해 이름 정규화·현재 폴더 상태·보관 상태를 확인하고 공개 name/projectRef/projectRevision만 투영한다. 내부 ProjectTarget 전체를 반환하면 private UUID와 cwd가 포함되므로 반드시 허용 필드만 선택한다. 프로젝트 최대 수는 현재 100개다.

새 조회에 실행용 prompt·requestId·모델 선택·실행 envelope를 요구할 이유는 없다. 사용자·대화의 권한 경계는 유지하되 Activity/Agent/Job나 실행 재시도 기록을 생성하지 않아야 한다. 기존 projectLookup은 구형 호출의 호환 경로로 유지하고, 새 도구 목록의 호스트 적용을 확인한 뒤 기본 안내를 옮긴다.

반면 **실행 resolver 자체의 자동 대체 방지 로직은 바꾸면 안 된다.** 직접 Alpha selector를 보내는 실행 경로는 폴더 접근 불가를 정확히 차단한다. 다른 Beta를 추천하는 것은 projectLookupResult가 요청 대상을 누락해 projectRecoveryActions의 “유일한 선택 가능 항목” 분기로 들어가는 별도 경로다. 두 경로를 격리된 생산 MCP로 각각 확인했다.

또한 계속하기·분기하기는 Activity와 스레드의 프로젝트 및 폴더를 고정해 사용한다. 등록 정보가 바뀌었더라도 그 맥락을 새 프로젝트로 바꾸지 않는다. 신규 선택 복구와 기존 작업 맥락 복구를 같은 helper로 자동 처리해서는 안 된다. 정확한 실행 재시도는 현재 등록 상태를 다시 해석하기 전에 기존 실행을 돌려준다.

근거: [실행 handler](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:7852), [프로젝트 접수 경로](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:8663), [재시도 hash](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:14140), [최신 registry 조회](/Volumes/Data/Dev/codex-mcp-bridge/src/userSettings.ts:211), [정상 조회의 기존 테스트](/Volumes/Data/Dev/codex-mcp-bridge/test/tools.test.ts:5560).

관찰: direct-project-admission-unavailable, lookup-project-unavailable, lookup-existing-is-preflight-error. 모든 생산 MCP 검사에서 Codex 상위 호출 0회, 접수된 Job 0개였다.

## 5. 모드별 스키마는 객체 루트를 유지해야 함

현재 SDK에 최상위 Zod discriminatedUnion 입력을 등록해 확인했다. tools/list에는 원래 분기들이 사라지고 type=object, properties={}만 노출됐다. 최상위 출력 union은 outputSchema 자체가 노출되지 않았고 실제 호출은 _zod 관련 검증 오류를 반환했다.

따라서 앞서 말한 “모드를 분리한다”를 최상위 Zod union으로 구현하면 안 된다. SDK가 tools/list에서 normalizeObjectSchema를 먼저 요구하는 코드 때문이다.

대안은 현재 codex_activity의 runtime 객체와 handler 검증을 유지하고, 공개 JSON Schema를 닫힌 객체 루트와 조건 분기로 만드는 것이다. 격리된 SDK에서 다음 다섯 가지를 공개 validator와 실제 호출 양쪽으로 확인했다.

| 입력 | 공개 검증·runtime 결과 |
| --- | --- |
| 생략 | full-history 기본값으로 허용 |
| full-history만 지정 | 허용 |
| compact-monitor와 presentationId 지정 | 허용 |
| compact-monitor에서 presentationId 생략 | 거부 |
| full-history에 presentationId 지정 | 거부 |

이는 현재 SDK에서의 적합성 검증이다. 새 스키마를 실제 ChatGPT가 받아 도구 선택에 사용하는 검증은 후속 적용 단계에서 별도로 필요하다.

표시 정책도 모드별로 유지해야 한다. never는 자동 compact 카드에 적용되며 명시적으로 여는 full-history까지 금지하지 않는다. 실제 생산 MCP에서 never 상태의 compact는 거부되고 full-history는 열리는 것을 확인했다.

compact 호출은 표시 예약을 만들고, snapshot은 감시 lease를 갱신하며, handoff는 현재 자동 카드의 소유권을 확인한다. rehydrate는 소유권을 얻지 않는다. 질문 카드는 이 소유권 체계에 참여하지 않는다. 설명을 짧게 만들더라도 이 의미를 하나의 “카드 열기”로 합치면 안 된다.

근거: [SDK 객체 정규화](/Volumes/Data/Dev/codex-mcp-bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:75), [현재 카드 입력·검증](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:5471), [lease 검증](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:2516), [완료 알림 소유권](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:5994).

관찰: sdk-root-union-input-erased, sdk-root-union-output-unpublished, sdk-object-root-condition-alternative, compact-card-never-policy-rejected, explicit-history-survives-never-policy.

## 6. 질문·답변 관련 제안의 정정

### 답변 목록의 “최근 100개 누락” 우려는 철회

QuestionStore.create가 대화당 유효 보관 항목을 최대 100개로 제한한다. readResponses의 최근 100개 조회는 이 전체 상한을 포함한다. 100개 제출 응답을 만들어 101번째 생성이 거부됨을 확인하고, 20개씩 상세 읽기를 5회 반복해 가장 오래된 응답까지 100개 모두 회수했다.

따라서 현재 정상 생성 경로에서 이 제한 때문에 더 오래된 유효 응답이 뒤에 숨는다는 우려는 성립하지 않는다. 이 문제를 해결한다는 이유로 커서나 새 operation을 추가할 필요는 없다.

다만 목록 조회와 상세 읽기의 차이를 responseRef 필드 설명에 명시하는 개선은 유지한다. 목록은 읽음 처리를 하지 않고, 특정 참조를 읽으면 consumedAt을 기록한다. 이 기록은 카드 표시뿐 아니라 재알림 허용 여부에도 사용된다. 새 질문 카드의 claimNotification이 이미 읽은 응답을 다시 알리지 않는 것도 확인했다.

근거: [보관 상한](/Volumes/Data/Dev/codex-mcp-bridge/src/questionStore.ts:45), [읽음·알림 연계](/Volumes/Data/Dev/codex-mcp-bridge/src/questionStore.ts:109). 관찰: question-discovery-does-not-consume, question-cap-prevents-older-live-row-loss.

### 질문별 식별·전달 계약은 단순화 대상이 아님

codex_input의 cursor는 입력 이벤트·질문 참조에 기반한다. codex_answer의 questionRef는 Job·scope·worker·generation·thread·질문 내용을 묶으며 일반 Job version을 사용하지 않는다. 독립적인 작업 진행으로 Job version이 바뀌었다고 질문 답변을 거부하지 않기 위한 구조다. 모든 변경 도구에 같은 expectedVersion을 강제하는 식의 통일은 맞지 않는다.

codex_answer는 일반 질문 출처·현재 턴·worker를 확인하고 정확한 질문 ID에 답변을 연결한 후 전송 기록을 남긴다. 승인·비밀·출처 미확인 입력은 다른 경로다. 메시지형 질문 답변은 현재 턴에 지침을 보내는 codex_steer를 사용하며 구조화 질문을 대신 해소하지 않는다.

codex_ask_user에는 Job ID가 없다. GPT가 질문을 작성해 사용자 의견을 받고 이후 어느 Codex 질문에 어떻게 답할지 결정하는 현재 용도와 맞다. 편의를 위해 특정 Codex Job이나 원 질문 ID를 필수로 추가하면 원래의 GPT용 질문 도구 역할이 좁아진다.

근거: [질문·cursor 식별](/Volumes/Data/Dev/codex-mcp-bridge/src/codexInputs.ts:19), [답변 전달 경로](/Volumes/Data/Dev/codex-mcp-bridge/src/questionTools.ts:74), [질문 카드 후속 메시지](/Volumes/Data/Dev/codex-mcp-bridge/src/questionCardUi.ts:46), [질문·승인 출처 분리](/Volumes/Data/Dev/codex-mcp-bridge/src/questionRouting.ts:6).

## 7. 모델·설정은 정보 조회와 실행 권한을 분리해야 함

자동 정책에서 허용 모델·추론 조합을 하나만 둔 상태와, 같은 조합을 고정 정책으로 저장한 상태를 비교했다. codex_models 응답과 codex_task descriptor는 동일했다. 그런데 고정 모드에서 selection을 보내면 실제 실행 전 MODEL_SELECTION_FORBIDDEN이 발생했다. **조회 결과의 모델 수로 정책 모드를 추정할 수 없다.**

모델 선택에 필요한 좁은 정보는 카드 없이 읽을 수 있게 해야 한다. 예를 들어 모델 조회의 새 계약에 현재 선택 정책을 명시하는 것이 적합하다. 전체 설정·폴더 경로·정책 revision 목록을 모두 반복 제공할 필요는 없다. 설정 변경마다 입력 스키마를 다시 생성하는 이전 구조로 돌아가서도 안 된다. 현재 descriptor가 정책과 프로젝트 변경에 흔들리지 않는 것은 의도된 안정성이다.

정책 모드를 반환한다면 허용 모델 목록 계산에 사용한 동일한 preferences에서 읽어야 한다. 조회 이후 정책이 바뀌는 경우는 실제 작업 접수의 resolveExecutionDecision·assertExecutionPolicyAdmission이 처리하도록 유지한다. 이 정보 공백이 있다는 사실은 확인했지만, 이전 브라우저의 설정 카드 반복 호출 원인이라고 단정하지는 않는다.

codex_settings는 applicationService.settingsSnapshot → settingsViewResult의 model 투영을 반환한다. 실제 Settings 카드 초기 내용은 codex_settings_snapshot을 별도로 호출해 읽는다. 따라서 설정 카드의 목적 설명을 줄이는 데 저장·검증·카드 초기화 코드를 바꿀 필요가 없다. 설명에서 반환 항목 나열을 지운다는 이유로 실제 응답 필드까지 지울 필요도 없다.

설정 변경 서비스는 MCP뿐 아니라 companion의 settings.update와 네이티브 앱이 공유한다. revision을 스키마에 더 명확하게 표현하는 것은 가능하지만 두 revision을 항상 필수로 만들면 기존 정상 호출을 깨뜨린다.

| 변경 | 실제 필요한 revision | 격리된 생산 호출 |
| --- | --- | --- |
| 프로젝트 이름만 변경 | expectedRegistryRevision | 설정 revision 없이 성공 |
| 일반 설정 초기화 | expectedSettingsRevision | registry revision 없이 성공, 프로젝트 2개 유지 |
| 일반 설정과 프로젝트를 함께 변경 | 두 revision | 기존 서비스가 각각 검증 후 원자적으로 반영 |

첫 두 정상 호출은 두 revision을 무조건 필수로 바꾼 스키마에서 모두 거부됐다. 수정한다면 reset/patch 및 일반 설정·프로젝트 변경의 조합에 맞춘 조건이어야 한다.

근거: [모델 조회](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:7381), [모델 선택의 실행 시 검사](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:8533), [설정의 공개·앱 투영](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:14648), [변경 전 검증](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:7636), [저장소의 원자적 변경](/Volumes/Data/Dev/codex-mcp-bridge/src/userSettings.ts:300), [네이티브 공유 경로](/Volumes/Data/Dev/codex-mcp-bridge/src/companionServer.ts:339).

## 8. 30개 도구의 실제 연결 경로와 최종 수정 범위

다음은 등록 함수의 직접 호출 목록과 주요 공통 경로를 확인해 작성한 표다. 함수 이름을 검색한 결과만으로 판단한 표가 아니며, 앞 절의 코드 분석·격리 관찰과 함께 읽어야 한다.

| 도구 | 실제 처리·소비 경로 | 적합한 수정 범위 |
| --- | --- | --- |
| codex_task | normalize → scope → 저장된 request hash → envelope → 조회 분기 또는 정책·프로젝트 접수 → Codex → taskProjectionForJob/projectToolResult | 목적 설명 축약, 복구 안내 교정. 기존 v2/hash v7·접수 순서를 유지하고 새 조회 도구 분리. |
| codex_status | scope/query → jobs.wait/상태 조회 → formatJobStatus → compactStatusProjection/statusToolResult | 미존재 대상 안내 수정. 정확한 Job만 본문을 주는 계약과 waitFor 관계 유지. |
| codex_input | ownedJob → waitForInput → codexInputSnapshot → resultOf | cursor·wait·질문 출처의 필드 설명 보완. runtime 대화 소유권·질문 분류 유지. |
| codex_answer | 정확한 질문 확인 → validateAnswers → beginDelivery → respondToInteraction → delivered/uncertain | 일반 질문 의미를 명확히 표현. 질문 참조·중복 전송 방지·승인 분리 유지. |
| codex_ask_user | 유일성 검사 → QuestionStore.create transaction → 카드 metadata → 사용자 제출 | 목적 설명 축약 및 필드 의미 추가. Job과의 독립성·상한·기한·동일 카드 재시도 유지. |
| codex_user_answer | readResponses transaction → 참조 목록 또는 본문·consumedAt → GPT | responseRef 생략 의미 명확화. 읽음 효과와 알림 연계 유지. 새 커서·operation은 우선 제외. |
| codex_models | getCatalog → publishTaskProjection → listAllowedModelSelections → 공개 모델 목록 | 호출 절차 나열 축약. 현재 정책 모드 정보는 새 출력 계약에서 보완. |
| codex_settings | shared settingsSnapshot → model용 compact view → 별도 카드의 초기 조회 | 설명만 목적 중심으로 축약 가능. 등록·모델 상세 항목을 설명에서 제거해도 저장·출력 코드는 유지. |
| codex_activity | 표시 정책 → Activity 선택 → 표시 예약 → buildActivityView → 카드 | 객체 루트의 모드 조건 표현. 기본값·자동 감시 소유권·never의 적용 범위 유지. |
| codex_dashboard | shared dashboardSnapshot → retained Job/Agent/thread와 bounded runtime 조회 → dashboardViewResult | 여러 대화에 걸친 보관 데이터 범위 유지. GPT의 목표 완료 판단과 Codex 상태를 섞지 않음. |
| codex_agent | 범위·mutation replay → busy/process 검사 또는 probe → transaction 변경 → mutationToolResult | 설명 축약. 보관 실패를 취소 허가로 바꾸지 않음. 내부 forceStop의 불완전함 수정 필요. |
| codex_steer | 정확한 Job/version → prepared 기록 → active-turn 검사 → dispatch 기록 → steer → 결과 저장·재시도 | 현재 턴 의미·전송 불확실성 유지. 종료 후 절차는 이미 실패 응답에 있으므로 루트 중복을 줄일 수 있음. |
| codex_cancel | cancellation replay → 정확한 대상·version → durable intent → cancel 확인 → 결과 저장 | 미존재 대상의 새 작업 지시 수정. 이유·공유 worker 영향 확인·확인된 취소·부분 변경 잔존 유지. |
| codex_activity_update | scope/version transaction → lifecycle/verification/policy 메서드 → mutationToolResult | 기존 operation 분기는 유지. 서버 상태별 허용 전환을 응답에서 설명. 무조건 requestId를 추가하지 않음. |
| codex_activity_cancel | 버전·전체 영향 집합 → 부모/자식 intent → 작업 중단 → Activity 종료 상태 | 전체 범위와 부분 실패 의미 유지. 단일 작업 취소와 합치지 않음. |
| codex_question_card | cardScope·proof → requireCard/get → private 카드 데이터 | 짧은 설명 유지. revision·presentationToken·scope 및 만료 검증 보존. |
| codex_question_submit | 정확한 proof → immutable submit/cancel transaction → 카드 데이터 | 답변 저장과 Codex 응답을 분리한 구조 유지. 실제 입력 검증 삭제 금지. |
| codex_question_notify | proof → claim/ack transaction → host ui/message → 별도 GPT 읽기 | 알림 요청·호스트 확인·GPT 읽음을 하나의 성공으로 합치지 않음. |
| codex_dashboard_snapshot | widget/scope 확인 → shared dashboardSnapshot → app projection | enrich의 생략 호환 의미·페이지 입력 유지. 공개 status와 합치지 않음. |
| codex_diagnostics | operator용 upstream inventory·저장소·descriptor 관찰·카드 성능 → diagnostic contract | 설명을 목적 중심으로 줄일 수 있음. 내부 진단 데이터를 공개 모델 도구로 확장하지 않음. |
| codex_activity_rehydrate | widget·보관된 조회 근거 검증 → non-owning buildActivityView | 입력 조건 설명은 보완 가능. 구형 Job/request 및 full-history 복구 형태 유지. |
| codex_activity_snapshot | exact proof → touch/release lease → scope wait → buildActivityView | 기다림 입력 관계와 enrich 의미 보완. 중단된 관찰을 실제 Job 취소로 연결하지 않음. |
| codex_activity_handoff | current card lease → automatic owner 확인 → outbox claim/delivered/release | 설명 축약 여지 적음. 전달 배치·소유권·재알림 방지 보존. |
| codex_agent_recovery_detach | 운영자 활성화 → scope/version → transaction 유휴 배정 해제 → replay 기록 | 비공개·기본 비활성·유휴 상태만 허용하는 구조 유지. |
| codex_background_process_terminate | card lease → 유휴 Agent·thread → process 목록 → 소유권 재확인 → 정확한 종료 | 서버 재검증 유지. 비동기 조회 뒤 소유권을 다시 확인하는 부분을 제거하지 않음. |
| codex_activity_job_cancel | card proof/lease → cancellation intent·replay → 실제 취소 | 공개 취소와 목적은 유사해도 카드의 제어 근거가 다르므로 별도 경로 유지. |
| codex_interaction_respond | card proof/lease → 질문/승인 응답 형태·정확한 요청 확인 → respondToInteraction | 공개 일반 질문 도구와 합치지 않음. transient 응답·카드의 실제 승인 근거 보존. |
| codex_job_steer | card proof/lease → idempotent mutation → 현재 turn steer | 공개 steer의 대화 위임과 카드의 소유권을 혼동하지 않음. |
| codex_settings_snapshot | shared settingsSnapshot → 전체 editor view → 현재/이전 Settings 카드 | private view·enrich/모델 새로고침·locale 호환 유지. 일반 GPT 조회 도구로 공개하지 않음. |
| codex_update_settings | shared settingsInput.parse → 두 종류 revision 사전검사 → 정책 준비 → transaction → 앱/네이티브 결과 | 설명 축약 가능. 변경 종류별 revision을 구분하고 native 호출 호환 유지. |

[배경 프로세스 종료의 재검증](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:10389), [Activity 원자적 전환](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:7150), [카드 전용 상호작용](/Volumes/Data/Dev/codex-mcp-bridge/src/tools.ts:6634)에서도 도구 설명의 조건 중 상당 부분이 실제 권한·동시성 계약임을 확인했다. 이 조건은 중복 설명을 정리하는 과정에서 유지해야 한다.

## 9. 실행 가능한 수정 순서

1. 기존 출력 모양을 유지하면서 잘못된 프로젝트 안내, status/cancel의 미존재 대상 안내, 미등록·보관·접근 불가 상태 안내를 고친다.
2. 설정 필요 응답에서 정확한 도구를 잃지 않도록 한다. 완료되지 않은 내부 action을 그대로 노출하지 않고 입력·의도 경계를 확인한다.
3. 설정 카드와 다른 도구의 설명을 목적 중심으로 줄인다. 정적 조건은 필드와 공개 스키마에, 서버 상태에 따른 안내는 실제 응답에 둔다.
4. 카드 모드는 현재 runtime 입력을 보존한 공개 객체 스키마 조건으로 보완한다. 사용자 답변은 기존 responseRef의 의미 설명부터 개선한다.
5. 새 프로젝트 조회 도구와 좁은 정책 조회 정보를 별도 계약으로 도입한다. 기존 호출·저장된 결과·구형 카드의 호환을 유지하고 실제 호스트에서 도구 목록 적용을 확인한다.
6. 구조화된 공통 action은 새 출력 계약과 크기 예산을 설계한 뒤 적용한다. 이 전환을 앞의 문구·복구 수정의 전제조건으로 만들 필요는 없다.

## 10. 검증 근거와 한계

[격리 재현 스크립트](/Volumes/Data/Dev/codex-mcp-bridge/scripts/probe-tool-guidance-code-paths.ts)는 다음을 검사한다.

- 실제 설치된 SDK의 최상위 union 처리, 객체 루트 조건 표현, 오류·변경된 출력의 클라이언트 검증.
- 메모리 저장소를 사용하는 실제 브리지 handler의 직접 프로젝트 접수와 조회 복구 차이, 취소 오류, 입력 검증 계층, 정책 모드, 카드 표시 정책, 설정 revision.
- 실제 QuestionStore의 100개 상한과 20개 단위 조회·읽음·재알림 효과.
- 생산자 형태와 대상 입력 스키마의 대조 및 출력 스키마 복사본의 크기 실험.
- 30개 등록 handler의 직접 호출·오류 위치와 소스 hash 수집. 자동 추출은 정적 참고 자료이며 실행 경로 전체의 검증으로 간주하지 않는다.

[기계 판독용 근거](/Volumes/Data/Dev/codex-mcp-bridge/docs/audits/2026-09-08-tool-guidance-code-fit.json)에 23개 관찰과 30개 handler 추적을 보존한다. 이 스크립트의 TypeScript 검사를 통과했다.

기존 관련 테스트는 test/tools, projectRegistry, questionStore, questionOrchestration, outputContracts, modelPolicyTransport의 235개가 통과했다. 첫 실행에는 이름 필터가 output 아래의 이전 격리 복사본까지 포함해 2개 실패가 있었다. 실패 위치를 확인하고 output을 명시적으로 제외해 현재 6개 파일을 다시 검증했다. 이전 복사본 실패를 현재 코드의 실패나 수정 완료로 계산하지 않았다.

23개 관찰에는 코드·스키마 대조와 크기 실험도 포함되어 있으며 23개의 실제 ChatGPT 시나리오라는 뜻이 아니다. 새 도구·출력 계약을 실제 ChatGPT에 배포한 수용 검증, 모든 종류의 구형 카드 브라우저 검증은 아직 수행하지 않았다. 이번 결과는 제안의 코드 적합성과 필요한 변경 경계를 확인한 검토다.
