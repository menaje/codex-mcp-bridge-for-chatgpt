# #247 bounded Worker 인계 — 후행 안내와 기존 계약 검증

> 이 문서는 9b126dac 단계의 역사적 인계다. 해당 커밋은 독립 검증 후 dev와
> origin/dev에 통합됐다. 최신 사용자 결정으로 실제 GPT 재개·A→검토→B
> 실환경 시험도 완료 조건에서 제외됐다. 이전 표의 미확인은 시험 대기
> 조건이 아니며, 현재 구현 범위·연결 지원/작동 미확인과 최종 독립 결과는
> [갱신한 W0~W5 계획](../issue-247-implementation-plan.md)을 따른다.


이번 변경은 W1의 호스트 없이 유효한 안내 정합화와 기존 기능 계약 검증이다.
일반 ChatGPT Pro의 최초 응답 종료 후 자동 재개를 구현하거나 #247 전체를
완료한 결과가 아니다. 당시 독립 검토와 통합을 후속 작업으로 인계했으며,
최종 d231bd2b는 독립 검사 86개·빌드 통과 후 dev/origin 반영과 앱 적용,
일반 Chat 기본 연결 확인을 완료했다. 실사용 평가는 사용자 담당이다.

기준은 [#247](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/247),
[지속시간 시험 제외 결정](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/247#issuecomment-6134929204),
이슈의 W0~W5 계획 및 당시 bounded Worker 지시를 기준으로 했다.

## 작업 식별

| 항목 | 값 |
| --- | --- |
| 작업 브랜치 | `codex/issue-247-followup-guidance` |
| 기준선 | `6f0695914a0b08152d2c851b75a42df0fb099f5b` — 착수 시 `dev == origin/dev`, 원본 worktree clean |
| 당시 통합 대상 | `dev`, bounded Worker 인계 뒤 독립 검토와 통합 수행 |
| 실행 | 직접 로컬 Git/파일/Node 도구. Bridge 플러그인 호출·Bridge Job·추가 에이전트 없음 |
| 검사 런타임 | Node `v24.11.1`, Vitest `4.1.11`, 기존 로컬 의존성 복사본 |

최종 커밋 ID는 부모 인계와 아래 `git rev-parse HEAD`로 확인한다. 이 문서가
포함된 커밋의 ID를 문서 안에 자기 참조로 기록하지 않는다.

## 변경 내용

`src/server.ts`의 공통/Events 지침과 `src/tools.ts`의 task/status 설명,
`approvedFollowups` 설명, 기존 next-action 문구만 정합화했다. 접수·권한·
receipt·hash·구독·DB 처리 로직, 입력/출력의 필수 필드와 계약 version은 그대로다.

- A 전에 정확한 B가 확정된 경우: 기존 `approvedFollowups` 선언,
  시스템 발급 `followupId`/canonical `requestId`, 정확한 prompt와
  현재 `reviewedVersion` 경로를 유지한다.
- A 원본 검토 후 최초 목표와 위임 안에서 B를 구체화하는 경우: 기존 일반
  `codex_task`의 원래 Activity/Agent, `context: "continue"` 경로를 사용한다.
  `followup` 참조를 만들지 않는다. 응답 유실 시 같은 `requestId`를 먼저
  조회하고 동일 execution payload로 정확히 재시도한다.
- 다른 request ID는 prompt가 같거나 Activity를 공유해도 별도 요청이다.
  서로 다른 GPT 실행이 독립적으로 새 ID를 고른 경우를 이번 변경이
  자동 병합하거나 중복 방지한다고 주장하지 않는다.
- 새로운 사용자 판단/승인과 명시적 중단, untrusted 결과의 권한 확대 금지,
  원래 scope를 유지한다. ACK·결과 offer·실제 GPT 검토·B 접수·전체 목표
  완료를 구분한다.
- 동적 B는 Activity 공유만으로 Events 정책을 상속하지 않는다. 해당
  기존 실험을 쓰려면 B마다 명시적 Events opt-in과 정확한 구독이 필요하다.

문서는 `docs/output-contracts.md`, `docs/chatgpt-setup.md`,
`docs/mcp-events.md`, `docs/mcp-events-subscription-delegation.md`를 수정했다.
호환 문구 수정에 대한 PATCH change fragment를 추가했다.

## 수락 매핑과 실제 결과

| 기능/요구 | 결과 | 근거와 한계 |
| --- | --- | --- |
| 두 기존 B 접수 경로 안내 | 완료 | 코드 설명/지침/next actions와 네 문서가 optional receipt 및 일반 continue를 구분 |
| canonical B의 정확한 접수 | 기능 검사 통과 | offer 없음, stale review version, 변경 prompt/선택/프로젝트/Activity/context, 다른 대화 거부; 동시 호출은 같은 canonical B |
| 접수된 canonical B 재조회/재시작 | 기능 검사 통과 | 기존 receipt로 동일 B를 회수; 이미 접수된 B replay는 과거 reviewedVersion이어도 새 실행 없음 |
| A 검토 후 동적 B | 기능 검사 통과 | `approvedFollowups=null`; 실제 HTTP 접수 응답을 유실시킨 뒤 request 조회, 동시 exact retry, 최종 결과 조회 및 상태 저장소 재개방 후 동일 B 회수 |
| 다른 request ID 경계 | 기능 검사 통과 | 같은 Activity/Agent와 동일 prompt라도 새 ID는 별도 Job; payload 변경은 같은 ID로 재접수 불가 |
| 다른 대화 경계 | 기능 검사 통과 | foreign exact read와 없는 Job은 동일 오류; 원래 Activity/Agent continue도 거부 |
| direct-wait 회귀 | 기능 검사 통과 | ordinary 정책과 카드 없는 admission 유지; 명시적 abort 사건으로 observation만 종료, 같은 Job/input/result 회수 |
| 중간 질문·불확실 답변 송신 보호 | 기능 검사 통과 | current questionRef 검사, reply-loss 이후 `uncertain` 회수, 새 ID 및 변경 답변 재전송 거부; 기존 pre-send/restart 회귀도 통과 |
| 명시적 목표 중단 | 기능 검사 통과 | fixture Activity를 명시적으로 abandon한 후 늦은 두 B 경로 모두 새 접수 거부 |
| ACK/offer/검토 구분 | 기능 검사 통과 | 기존 OAuth Events ACK만으로 B 접수 불가; subscriptionRef는 ordinary 도구 권한이 아니며 `canProceed` 출력도 approval이 아님 |
| 실제 GPT의 A 검토/최종 목표 검토 | 미확인 | harness가 정확한 결과를 읽고 reviewedVersion을 선언한 기능 검사. 실제 GPT의 검토를 관측한 근거가 아님 |
| UI 로드 0회·최초 응답 종료 후 원래 일반 Chat Pro 자동 재개 | 사용자 평가·현재 연결 지원/작동 미확인 | 원래 대화·MCP scope를 유지하는 실제 자동 재개는 확인하지 않음. API 부재로 단정하지 않고 Work/dot/API 성공으로 대체하지 않음 |
| 원래 GPT 모델/추론·문맥·사용량 연속성 | 미확인 | 호스트 근거 없음; Codex 지표를 대체 근거로 쓰지 않음 |
| W2/W3 receiver·구독·권한 연결 및 수명 필드 | 후속 Bridge 구현으로 갱신 | 이 표는 bounded W1 당시 범위다. 최종 lifecycle 수신은 갱신한 계획을 따르며 일반 Chat Pro 전용 추가 연결은 미확인 |
| 독립 검증·dev 통합 | 대기 | 부모가 새 Verifier를 배정한 후 통과 변경만 통합 |

`test/issue247Followups.test.ts`는 disposable SQLite, 가짜 upstream,
명시적 release/abort/질문 사건, committed terminal notification과 Promise
장벽을 사용한다. elapsed-time assertion, sleep, clock acceleration,
expiry 단축이나 지속시간 관찰을 사용하지 않는다. direct-wait의 정상
20초 상한은 abort 사건으로 즉시 종료하며 시간을 기다리지 않는다.

| 실행 | 실제 결과 |
| --- | --- |
| 새 기능 검사 | 8 passed |
| 기존 output/guidance/ordinary summary/profile/input 계약 | 45 passed |
| 선별 OAuth Events 기능 검사 | 3 passed, 41 skipped |
| 선별 pre-send/restart 답변 검사 | 1 passed, 2 skipped |
| `npm run build` | exit 0; localization/release checks와 TypeScript compilation 통과 |
| `git diff --check` | exit 0 |

초기 실행은 sandbox의 loopback/tsx IPC socket 제한으로 중단됐다. 승인
검토를 거친 격리 검사 실행으로 해결했다. 첫 허용된 기능 실행은 6 passed,
1 failed였으며 검사에서 Activity의 `status`를 참조한 오류를 `lifecycle`
로 수정했다. 최종 8개 검사는 모두 통과했다. 초기 결과와 수정의 검증
자료는 보존했다. 남은 기능 검사 실패는 없다.

## 독립 검증 명령

다음 명령은 해당 검토 커밋을 checkout한 저장소 루트에서 실행한다. HTTP fixture와 tsx는 로컬
socket을 사용하므로 이 실행기의 sandbox에서는 승인된 실행이 필요했다.
모든 상태와 인증 자료는 테스트 fixture의 임시 경로를 사용한다.

```sh
git rev-parse HEAD
git diff 6f0695914a0b08152d2c851b75a42df0fb099f5b..HEAD -- src/server.ts src/tools.ts docs test/issue247Followups.test.ts .changes/issue-247-followup-guidance.json
npm run build
node node_modules/vitest/vitest.mjs run test/issue247Followups.test.ts --maxWorkers=1 --reporter=verbose
node node_modules/vitest/vitest.mjs run test/outputContracts.test.ts test/toolGuidance.test.ts test/issue221Profiles.test.ts test/issue221Summary.test.ts test/questionOrchestration.test.ts --maxWorkers=1 --reporter=verbose
node node_modules/vitest/vitest.mjs run test/mcpEventDelegation.test.ts -t 'delivers exact A then exactly one preapproved B without Dashboard or ui/message|cannot authorize ordinary result reads, tasks or configuration through a subscriptionRef|never treats fixture canProceed output as a followup approval' --maxWorkers=1 --reporter=verbose
node node_modules/vitest/vitest.mjs run test/questionStore.test.ts -t 'persists proven pre-send rejection and retries only the identical request after restart' --maxWorkers=1 --reporter=verbose
git diff --check
```

광범위 `npm test`, `npm run check`, `validate:affected/full`은 실행하지
않았다. 이 명령들은 지속시간 검사까지 묶어 실행하므로 사용자 결정에 따라
관련 기능 검사만 선별했다. native Swift와 운영 설치본 검증도 이번 문구
변경 범위에서는 실행하지 않았다. 장시간·지속시간·soak·반복 내구 시험과
그 축약 대체 시험/Job/자동화는 계획하거나 실행하지 않았으며, 사용자
실사용을 구현 인계의 대기 조건으로 추가하지 않았다.

운영 DB, 설치 Runtime/dist, 설정과 실제 자격증명, 다른 worktree를 수정하지
않았다. 앱 설치/재시작, 외부 receiver나 UI 구축, 이슈 게시/상태 변경,
remote push, dev 통합, 기존 worktree 정리는 하지 않았다. 작업 브랜치와
worktree 및 격리 빌드/로그는 독립 검증과 부모 통합을 위해 보존한다.
