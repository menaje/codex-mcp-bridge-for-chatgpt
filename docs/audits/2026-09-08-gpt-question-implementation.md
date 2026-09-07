# GPT 질문 오케스트레이션 구현 검증

이슈: [#68](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/68)

이 문서는 최초 구현 시점의 기록이다. 이후 서버형 질문·승인 분리와 실제 CLI
검증 결과는 [후속 검증](2026-09-08-gpt-question-followup.md)을 참조한다.

2026-09-08 로컬 작업 트리에서 메시지형 Codex 질문의 GPT 응답 경로와 GPT가
사용자에게 질문하는 카드 흐름을 구현했다. 실제 ChatGPT에서 카드 제출 후 모델이
실행되는 검증과 서버형 일반 질문의 출처 계약은 남아 있다. 운영 서비스 교체나
이슈 종료는 하지 않았다. 기존 CLI 권한 통일 작업과 함께 있는 로컬 변경이며,
현재 보고서는 배포된 릴리즈의 완료 선언이 아니다.

## 구현 내용

| 도구 | 역할 |
| --- | --- |
| `codex_input` | 정확한 Job의 일반 질문·공개 중간 메시지 조회, 입력 cursor에 따른 최대 60초 대기 |
| `codex_answer` | 출처가 검증된 서버형 일반 질문 응답 계약. 진행률 변경과 독립적인 질문 참조·중복 전송 방지 |
| `codex_steer` | 실제 CLI에서 관찰한 메시지형 질문에 현재 실행 턴으로 답변 |
| `codex_ask_user` | GPT가 작성한 질문을 기존 Activity renderer의 질문 모드로 표시 |
| `codex_user_answer` | 저장된 사용자 답변 조회. 목록으로 미확인 응답 복구 가능 |
| `codex_question_card/submit/notify` | 카드 전용 조회·불변 제출·후속 처리 통지. Codex 직접 응답 없음 |

카드는 Activity 감시 lease·완료 인계 소유권을 취득하지 않는다. 제출 저장,
호스트의 후속 메시지 접수, GPT의 실제 답변 조회를 별도로 표시한다. 전송이
불확실하면 자동 재전송하지 않는다. 새로고침과 언어 변경은 입력 중인 답변을
유지한다. 9개 UI 언어를 지원한다.

SQLite schema 12에서 13으로 질문 저장소를 추가한다. 카드 원문은 생성 후
최대 24시간까지 보관하며 다음 질문 작업 또는 재시작 때 만료 레코드를 삭제한다.
Codex 응답 전송 기록에는 해시만 저장하고 장애 후 불확실한 전송을 재실행하지
않는다. 복구·삭제·이전 버전 롤백의 범위는 [기능 문서](../gpt-questions.md)에 있다.

## 검증 결과

| 검사 | 결과 | 실제 사용한 계층 |
| --- | --- | --- |
| TypeScript 빌드·릴리즈 계약 | 통과 | 현재 작업 트리와 생성 리소스 |
| 저장소 전체 Vitest | 61개 파일·742개 테스트 통과 | 실제 저장소 테스트, `output/**`의 이전 빌드 복사본 제외 |
| 최종 출처 구분·전송·저장 회귀 | 43개 통과 | 제품 MCP·SQLite와 합성 upstream |
| 출력 계약 감사 | 통과 | 공개 도구 schema·결과 크기·저장된 감사 기준 |
| App Server 계약 | 통과 | 설치 CLI 0.153.3에서 생성한 JSON 416개·TypeScript 827개 |
| macOS | 100개 중 2개 건너뜀, 실패 0 | 9개 언어 검사와 Swift strict concurrency 검사 |
| 빌드된 질문 카드 | 5개 통과, Codex 호출 0회 | 실제 Chromium·제품 renderer·MCP·SQLite, 모의 ChatGPT 호스트 |
| 실제 앱 내장 CLI 0.153.4 | 질문 읽기 → `codex_steer` → 답변 반영 → 완료 | 실제 로그인·GPT-6 Astra·제품 MCP |
| 실제 터미널 CLI 0.153.3 | 동일 흐름 통과 | 동일 |
| 실제 브리지 관리 CLI 0.153.4 | 동일 흐름 통과 | 동일 |

브라우저 5개 조건은 표준 후속 메시지, 호환 후속 메시지, 명시적 전달 거절 후
수동 재시도, 전달 불확실, 만료다. 실패 후 재시도는 답변 재저장 없이 같은
식별자를 사용한다. 정확한 답변 내용은 공개 GPT 조회 도구로 회수했다. 이
검사에서 GPT 역할의 조회자는 프로그램이며 실제 상위 ChatGPT 모델이 아니다.

CLI 3종은 동일 모델·추론 설정과 격리된 읽기 전용 프로젝트를 사용했다. 임시
인증 home은 검사 후 제거했다. 서버형 입력 요청이 관찰됐다는 증거로 확대하지
않는다. 세부 수치: [검증 JSON](2026-09-08-gpt-question-implementation.json).

재현 명령:

```sh
npm run build
npx vitest run --exclude 'output/**' --maxWorkers=4
npx tsx scripts/output-contract-audit.ts --check
npm run app-server:compat:check
npm run macos:check
npx tsx scripts/question-card-browser-regression.ts --built
npx tsx scripts/check-live-gpt-questions.ts --run-authenticated source=/absolute/path/to/codex
```

## 남은 구현·제품 검증

1. **서버형 질문의 신뢰할 수 있는 출처 계약.** 현재 App Server의
   `item/tool/requestUserInput`에는 일반 질문·앱 승인을 구분하는 필드가 없다.
   `dynamicToolCall`은 클라이언트가 제공하는 도구이므로 이름이
   `request_user_input`과 같다는 이유로 일반 질문의 증거가 되지 않는다.
   해당 추정을 최종 점검에서 제거했다. 현재 이 경로는 `unknown`으로 남기고
   자동 응답을 거절한다. `codex_answer`는 출처를 지정한 합성 upstream으로
   계약을 검증한 상태이며, 실제 네이티브 서버형 질문 지원을 완료했다고
   표시하지 않는다. 출처 확인을 위해 비공개 raw reasoning 스트림을 켜지 않았다.
2. **실제 ChatGPT의 도구 선택과 카드 후속 실행.** 카드 표시 → 사용자 제출 →
   GPT 실행 재개 → `codex_user_answer` 조회 → Codex 반영, 그리고 재열기·오래된
   카드·거절/미지원 복구 검증이 필요하다. 화면 접근 시 Mac이 잠겨 있어 확인할
   수 없었다. 잠금 해제 요청을 전달했으며 실제 호스트 통과로 표시하지 않는다.

공식 소스에서 확인한 차이:

- [`request_user_input_async`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input_async.rs)는
  구조화된 질문을 포함한 비동기 `agentMessage`를 만들고 즉시 반환한다. 이
  형태는 서버 요청 응답이 아니라 이후 사용자 메시지로 답한다.
- [`request_user_input`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input.rs)는
  입력 응답을 기다린다. [App Server 변환](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/bespoke_event_handling.rs)은
  thread·turn·item·질문·차단 정보를 서버 요청으로 전달한다.
- [MCP 앱 승인](https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_call.rs)도
  협상된 기능에 따라 같은 입력 요청을 사용할 수 있다. 네이티브 질문과 승인
  분리를 입증하기 전에는 메서드 이름이나 도구 이름만으로 GPT 자동 응답을 열지 않는다.

공식 소스의 `main` 내용은 검사 시점의 근거다. 세 CLI에서 특정 내부 도구가
호출됐다는 실측 증거와 동일하게 취급하지 않는다.
