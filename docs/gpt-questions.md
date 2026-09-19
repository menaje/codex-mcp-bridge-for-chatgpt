# GPT가 처리하는 Codex 질문

일반 Codex 질문은 별도 카드가 아니라 현재 ChatGPT 대화에서 처리한다. GPT는
사용자 위임 범위 안에서 질문을 해석하고, 필요한 경우 이 대화에서 사용자에게
직접 물은 뒤 원래 Codex turn에 답한다.

도구 구성이 바뀐 빌드를 설치하면 ChatGPT 연결을 **Refresh(새로고침)**해야
한다. 현행 기본 구성은 모델용 10개와 앱 전용 5개, 총 15개 도구이며 Question
리소스와 질문 카드 도구는 등록하지 않는다.

## 실행 흐름

1. `codex_status({query:{kind:"input", jobId}})`로 현재 일반 질문, 승인 요청,
   공개 중간 메시지를 읽는다.
2. 구조화된 일반 질문은
   `codex_answer({requestId, jobId, questionRef, answers})`로 답한다. 질문 ID와
   허용 선택지를 그대로 사용한다.
3. 구조화된 질문이나 승인이 없는 메시지형 요청에는 정확한 활성 Job 버전으로
   `codex_steer`를 사용할 수 있다. 승인이나 구조화된 질문을 steer로 해결하지
   않는다.
4. 사용자 의견이 필요하면 이 ChatGPT 대화에서 직접 질문한다. 사용자의 답을
   받은 뒤 현재 `questionRef`가 여전히 유효한지 확인하고 `codex_answer`를
   호출한다.
5. 새 입력을 기다릴 때는 마지막 `afterCursor`와 최대 60초의 `waitMs`를
   `codex_status` input query에 보낸다. 정확한 Job의 terminal 결과를 확인한
   뒤 GPT가 응답을 마무리한다.

입력 조회는 한 번에 현재 일반 질문 요청 하나와 최근 공개 메시지를 제한해
반환한다. `hasMoreQuestions`가 참이면 현재 요청을 처리한 뒤 다시 조회한다.
메시지의 `final_answer` phase는 turn 완료 근거가 아니며, 최종 판단은 정확한
Job 상태와 결과에서 한다.

## 의사결정카드를 함께 쓰는 경우

실행 중인 Codex 질문을 설명하거나 비교하는 데 카드가 유용해도 두 계약은
결합되지 않는다. 다음 순서를 유지한다.

1. `codex_status`의 input query로 현재 질문과 정확한 `questionRef`를 읽는다.
2. 필요할 때만 독립적인 `codex_decision` 카드를 만들고, 제출 결과는
   `codex_decision_result`로 읽는다.
3. 카드 결과를 받은 뒤 `codex_status`의 input query를 다시 호출해 같은 질문이
   아직 현재 상태인지 확인한다.
4. 사용자가 별도로 답변 전송을 원하고 질문이 여전히 유효할 때만 현재
   `questionRef`로 `codex_answer`를 호출한다.

카드 생성·제출·결과 조회만으로는 Codex 질문에 답하지 않고 Job을 시작하거나
계속하지 않는다. Job의 sandbox, access strategy, execution decision, Activity,
Agent, Job 수를 바꾸지 않으며 실행 승인이나 권한 승인도 부여하지 않는다.
승인 요청은 카드나 `codex_answer`로 해결하지 않고 Dashboard의 원본 승인
경로를 사용한다.

## 범위와 재전송 규칙

`codex_answer`는 현재 대화 범위의 활성 Job, 현재 worker/turn, 현재
`questionRef`만 수락한다. 응답은 request ID와 payload hash로 기록되어 같은
논리 요청의 중복 전송을 막는다. 전송이 불확실하면 새 request ID나 다른
채널로 자동 재전송하지 않고 정확한 Job을 다시 확인한다.

일반 질문은 인증 비밀이나 권한 승인을 요청하는 경로가 아니다. 그런 요청은
Dashboard 작업 상세의 원본 승인·입력 경로에서 별도로 처리한다.

## 폐기된 질문 카드

`codex_ask_user`, `codex_user_answer`, `codex_question_action`, Question
리소스, 그리고 `codex_ui_read`의 `view:"question"`은 폐기됐다. 과거
`user_questions`와 전달 영수증은 기존 SQLite 데이터의 보관·마이그레이션을
위해 남아 있지만, 현재 UI나 도구가 새 질문 카드로 다시 열지 않는다.

이전 #68의 카드 기반 호스트 검증 기록은
[감사 기록](audits/2026-09-08-gpt-question-followup.md)에 역사적 증거로 보존한다.
그 기록은 현행 공개 계약을 뜻하지 않는다.
