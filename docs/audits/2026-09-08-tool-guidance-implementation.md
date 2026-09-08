# 도구 설명·복구 안내 정비 — 이슈 #70

이슈: https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/70

병행 이슈 #69의 `af1a8f7e480b93e52b16629729871afe44711625`를 기준으로 별도
`codex/issue-70-tool-guidance` 작업공간에서 구현했다. #69 작업공간이나 운영
서비스를 수정하지 않았다. 이 보고서와 함께 있는 JSON은 기준 커밋과 실제
소스 내용의 SHA-256을 구분해 기록한다.

## 반영 내용

| 영역 | 변경 |
| --- | --- |
| 현재 공개 도구 12개와 앱 전용 도구 5개 | 설명을 목적·효과 중심으로 줄였다. 입력의 의미와 공통 오케스트레이션 책임, 실제 실행 시의 검증을 보존했다. |
| 설정 카드 | “브리지를 설정하는 대화형 카드”라는 역할만 설명한다. 등록·복구 조건과 다음 호출은 해당 실행 응답에 둔다. |
| 프로젝트 복구 | 접근 불가 Alpha 대신 Beta를 추천하지 않는다. 알려진 ref를 같은 이름의 다른 등록으로 바꾸지 않고, 유일한 프로젝트도 임의 선택하지 않는다. |
| 프로젝트 상태 | 등록 없음은 신규 등록, 전체 보관은 기존 등록 복구, 접근 불가는 해당 폴더 복구, 없는 이름은 사용자 의도 확인으로 안내한다. |
| 조회·취소 오류 | 알 수 없는 Job에 대해 새 작업을 만들라는 안내를 공개 및 내부 경로 총 5곳에서 제거했다. 현재 대화의 정확한 대상 조회를 안내한다. |
| 접수 후 실패 | 실행 접수 이후의 실패를 새 작업의 사전 오류로 반환하지 않고 기존 Job 결과와 ID를 돌려준다. 같은 요청의 재시도는 실제 실행을 반복하지 않는다. |
| 다음 행동 | 기존 문자열 배열 안에서 읽기 도구 이름과 검증된 JSON 인자를 보존한다. 사용 중 Agent 보관과 과거 불완전한 취소 기록은 먼저 대상 조회로 안내한다. |
| 사용자 답변 | responseRef 생략은 미확인 참조 목록, 지정은 본문 읽기·확인 처리임을 필드 설명에 명시했다. |
| 모델 정책 조회 | 기존 codex_models에 명시적 contractVersion=2를 추가했다. 같은 스냅샷의 허용 모델과 fixed/automatic 정책을 카드 없이 읽는다. 기존 호출은 이전 응답 모양을 유지한다. |

일반 질문의 GPT 응답과 실제 승인 경로의 분리, 전달 불확실 시 중복 전송 방지,
설정/프로젝트의 별도 버전 검증, 계속하기·분기와 이미 접수한 작업의 프로젝트
고정 및 기존 재시도 식별·정합성 검증을 보존했다. #69가 정한 브리지 설정 기반 실행 권한도
그대로 유지했다.

## 병행 작업에 맞춰 제외한 제안

- 별도 codex_projects 도구는 만들지 않았다. #69의 codex_status 프로젝트 조회를 사용하며, 기존 codex_task projectLookup은 호환 경로만 유지한다.
- 제거되는 신규 Activity 카드의 모드 스키마는 확장하지 않았다.
- 앱 전용 통합 API와 과거 카드용 호환 등록을 되돌리거나 다시 나누지 않았다.
- 객체 nextActions나 공통 오류 객체를 모든 닫힌 출력 스키마에 추가하지 않았다.
- 철회했던 사용자 답변 100개 제한의 유실 가설을 근거로 페이지·커서를 추가하지 않았다.

## 계측 및 검증

실제 production MCP `tools/list`에서 #69와 도구 이름이 일치한다. 현재 기능은
GPT 12개·앱 5개이며 이전 카드용 앱 전용 호환 설명 12개가 별도로 유지된다.
current 도구 설명 본문 합계는 9,634 → 2,233바이트(76.8% 감소), 전체 current
descriptor는 138,463 → 133,252바이트다. 공개 출력 스키마는 18,747바이트로
19,500바이트 제한 안에 있고 Task 입출력 스키마는 7,313바이트다.

최종 전체 검사 63개 파일, 770개 테스트가 통과했다. 초기 관련 검사 7개 파일의
279개 테스트와 추가한 접수 후 실패 회귀도 통과했다. 새 production MCP 회귀 검사는
접근 불가·보관·미선택·누락·이름 변경, 잘못된 Job 복구, 실제 호출 가능한 읽기
인자, 과거 취소 action, SDK의 이전 catalog validator, 비동기 catalog 조회 도중
정책 변경을 다룬다. 접수 후 실패와 정확한 재시도 회귀를 추가로 확인했다.
실제 CLI 없이 모의 upstream으로 수행했으며, 접수 이후 실패 검사는 모의 Job을 생성한다.
TypeScript 빌드, 감사 스크립트 타입 검사, 릴리즈 계약, App Server CLI 0.153.3
계약 검사도 통과했다. 최초 전체 검사에서 5초 제한 초과가 2건 발생했으며,
시간 제한을 늘리지 않고 병렬 실행 2개에서 모두 통과했다. 이어 저장소의 기본
병렬 설정 4개로 affected 검증을 다시 실행해 빌드와 전체 770개 테스트가
통과하는 것까지 확인했다. macOS 소스 변경이 없어 이번 affected 범위에는
macOS 빌드가 포함되지 않는다.

재현 명령:

```sh
npx tsx scripts/tool-guidance-audit.ts /path/to/issue-69-worktree
npx vitest run test/toolGuidance.test.ts test/projectRegistry.test.ts test/questionOrchestration.test.ts test/outputContracts.test.ts test/tools.test.ts test/server.test.ts test/modelPolicyTransport.test.ts --exclude 'output/**' --maxWorkers=4
node scripts/release-validation.mjs affected --base af1a8f7
npx vitest run --exclude 'output/**' --maxWorkers=2
```

## 적용 경계

로컬 구현과 MCP/SDK 검증 결과다. 실제 ChatGPT가 새 설명과 선택형 모델 응답
계약을 채택하는지의 확인 및 운영 반영은 #69 통합·배포와 함께 진행한다.
#69에 남아 있는 실제 완료·결과 회수·알림, 활성 작업 전환 및 원본 승인 제어
검증을 이 변경의 테스트 통과로 완료 처리하지 않는다.
