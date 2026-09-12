# Codex CLI 설치본별 권한·기능 일관성 검토 · 2026-09-07

> 이 문서는 수정 전 감사 기록이다. 이후 구현과 1,428개 테스트 검증은 [수정 결과](2026-09-07-cli-permission-parity-implementation.md)에 정리했다. 아래의 코드 상태·실패 재현 설명은 감사 기준 커밋을 가리키며, 재현 패치를 수정된 작업 트리에 다시 적용하지 않는다.

검토 기준은 `54296e0`이다. 브리지 관리 CLI만 권한을 잘못 적용한다는 증거는 없었다. 현재 설치된 세 CLI는 같은 sandbox와 승인 정책을 정상적으로 수신하고 파일 쓰기를 동일하게 제한했다. 그러나 **브리지 공통 경로에서 권한 상한 재검사 누락, 분기 시 명시한 sandbox 무시, 실제 적용 정책 검증 누락을 확인했다.** CLI를 교체하는 것만으로 해결되지 않는 문제다.

이번 변경은 조사 보고서, 격리된 검사 스크립트, 재현용 테스트 패치뿐이다. 운영 코드, 저장된 접근 정책, 선택한 CLI, 설치 파일, 실행 중 서비스는 변경하지 않았다. 실제 모델 작업을 새로 실행하거나 인증 정보를 복사하지 않았다.

## 인용한 오류의 원인

현재 로컬 브리지의 SQLite 설정은 `accessStrategy: always-full`이고 선택된 설치본은 브리지 관리 CLI `0.153.4`였다. 저장된 설정을 읽었으며 변경하지 않았다.

[`tools.ts`](../../src/tools.ts)의 7850–7855행은 접근 전략이 `adaptive`가 아니면 `sandbox` 필드의 **존재 자체**를 거부한다. 저장된 권한과 같은 값을 명시해도 `SANDBOX_OVERRIDE_UNAVAILABLE`이 발생한다. 이 검사는 작업 등록과 App Server 호출보다 앞에 있으므로, 이 오류로 거절된 호출은 새 Codex 작업을 생성하지 않는다. 다만 제공된 문장만으로 특정 과거 요청 ID나 그 후 재등록의 성공 여부까지 확인한 것은 아니다.

따라서 인용한 메시지는 해당 검사와 일치한다. 이는 CLI의 sandbox 실행 실패나 ChatGPT의 자동 승인 검토 거절과는 별개다. 동일한 브리지 설정에서는 앱 내장·터미널·브리지 관리 설치본 모두에 적용된다.

정책 전달에도 두 층이 있다. 확인한 브리지 환경 파일은 `APPROVAL_POLICY=on-request`, 사용자 Codex 설정은 `approval_policy="never"`였다. 새 작업의 `approvalPolicy`는 브리지 환경 설정으로 명시해서 보내므로 CLI의 사용자 기본값보다 우선한다. `always-full`은 파일 접근 전략이며 승인 생략 설정은 아니다. 실제 격리 검사에서도 `danger-full-access + on-request` 조합이 그대로 수신됐다. 명령 승인 정책과 승인 검토 담당자(`approvalsReviewer`)는 [공식 App Server 문서](https://learn.chatgpt.com/docs/app-server)의 별도 설정이다.

**개선 방향:** 고정 정책과 동일한 요청은 같은 권한의 확인으로 받아들일 수 있다. 서로 다른 요청은 요청값·유효값·거절 이유를 보여주어야 한다. 특히 전체 접근이 저장된 상태에서 호출자가 `read-only`를 지정했다면, 일률적으로 필드를 제거하라고 안내해 의도한 제한을 잃게 해서는 안 된다. 이 UI/계약 개선과 아래 권한 결함은 구분해서 처리해야 한다.

## 실제 설치본 비교

프로젝트가 지원하는 세 가지 **Codex 설치 출처**를 비교했다. 다른 회사의 CLI를 실행하는 어댑터는 현재 없다. `executionRuntime.ts`와 `upstreamRouter.ts`는 세 설치본을 모두 `codex app-server --listen stdio://`로 연결한다. 과거 내부 MCP Server/SDK 실행 경로는 퇴역 처리되어 있으며 비교 대상 실행 경로로 되살리지 않았다.

| 검사항목 | 터미널 CLI | 앱 내장 CLI | 브리지 관리 CLI |
| --- | --- | --- | --- |
| 설치 버전 | 0.153.3 | 0.153.4 | 0.153.4 |
| 환경 | macOS arm64 | 동일 | 동일 |
| 공개 JSON 스키마 | 416개 | 동일 | 동일 |
| 정규화 스키마 해시 | `59f583e6…c38b7e5` | 동일 | 동일 |
| sandbox 3종 × 승인 정책 3종 | 9/9 일치 | 9/9 일치 | 9/9 일치 |
| 실제 파일 쓰기 허용·차단 | 4/4 통과 | 4/4 통과 | 4/4 통과 |
| 읽기·조회 프로토콜 8종 | 8/8 수락 | 8/8 수락 | 8/8 수락 |
| 기능 플래그 | 135개 | 값·단계까지 동일 | 값·단계까지 동일 |
| 인증 없는 기본 모델 목록 | 5개 | 6개 | 6개 |
| 기본 모델 | `gpt-5.6-sol` | `gpt-6-astra` | `gpt-6-astra` |

파일 검사는 읽기 전용의 쓰기 거부, workspace 내부 쓰기 허용, workspace 밖 형제 폴더 쓰기 거부, 전체 접근의 형제 폴더 쓰기 허용이다. 모두 검사기가 만든 임시 폴더만 사용했다. workspace 밖 차단 검사에서는 임시 폴더에 대한 별도 쓰기 허용을 명시적으로 껐다. 이 검사는 App Server의 `command/exec`로 sandbox 자체를 확인한 것이며 모델이 작성한 명령의 승인 UI 검사로 계산하지 않았다.

8종은 `model/list`, `skills/list`, `mcpServerStatus/list`, `thread/read`, `thread/backgroundTerminals/list`, `permissionProfile/list`, `collaborationMode/list`, `experimentalFeature/list`다. 빈 저장소에서 메서드 수락을 검사했으므로, 실제 플러그인 도구 실행·백그라운드 프로세스 종료·계정별 모델 사용 권한까지 통과한 것은 아니다.

0.153.4 두 설치본의 인증 없는 목록에는 `gpt-6-astra`가 추가되어 있었다. 공통 모델의 reasoning effort와 입력 형식은 같았다. 이 결과는 **프로토콜 동일성이 모델 목록 동일성을 보장하지 않는 실제 사례**다. 로그인 후 계정·서버에서 갱신되는 목록은 달라질 수 있으므로 위 숫자를 사용자 계정의 사용 가능 모델 개수로 해석하면 안 된다. 모델 선택은 [공식 `model/list` 계약](https://learn.chatgpt.com/docs/app-server)에 따라 실행 설치본과 인증 맥락에서 확인해야 한다.

정규화 스키마 전체 해시와 개별 검사 결과는 [JSON 증거](2026-09-07-cli-parity-evidence.json)에 저장했다. 실행 경로·인증 정보·개인 프로젝트·작업 본문은 포함하지 않는다.

## 발견한 문제와 우선순위

| ID | 우선순위 | 발견 사항 | 근거 |
| --- | --- | --- | --- |
| A1 | P1 | 운영자 권한 상한을 낮춰도 기존 전체 접근 세션의 이어가기·분기가 허용됨 | MCP/SQLite 격리 재현 2건 |
| A2 | P1 | 전체 접근 세션 분기에 `read-only`를 명시해도 전체 접근으로 작업 등록 | 격리 재현 및 실제 공개 v2 입력으로 재확인 |
| A3 | P1 | App Server가 반환한 실제 sandbox·승인 정책을 검증하지 않고 turn 실행 | 실제 어댑터 + 합성 JSON-RPC 응답 |
| A4 | P2 | 읽기 전용 세션을 쓰기 sandbox로 이어가려는 명시적 요청을 조용히 무시 | MCP 격리 재현 |
| A5 | P2 | `compatible`과 기능 지원 플래그가 실제 작업 지원을 보장하지 않음 | 실제 런타임 관리자·어댑터 + 메서드 미지원 peer |
| A6 | P2 | 알려진 MCP 추가 입력 요청 미지원, 비동기 질문 의미 손실 | 어댑터 재현 및 설치 CLI 스키마 대조 |
| A7 | P2 | 고정 접근 모드의 불필요한 거절과 승인 정책 설명 부족 | 현재 저장 설정·코드·기존 테스트 |

**A1 — 변경된 운영자 상한을 기존 세션에도 재검사해야 한다.**

`tools.ts:14691`의 새 작업은 `enforceSandbox`로 상한을 검사한다. 그러나 `continueTrackedSession`(`tools.ts:9201`)과 `forkTrackedSession`(`tools.ts:9361`)은 고정 전략과의 일치 여부만 검사하고 기존 `session.sandbox`를 현재 운영자 상한으로 검사하지 않는다.

재현 순서는 다음과 같다.

1. `adaptive`, `ALLOW_DANGER_FULL_ACCESS=1`로 전체 접근 세션을 만든다.
2. 동일한 저장 상태를 이용해 `ALLOW_DANGER_FULL_ACCESS`가 꺼진 브리지를 다시 구성한다.
3. 기존 Agent를 sandbox 생략으로 이어가거나 분기한다.
4. 두 경우 모두 오류 없이 새 작업이 `danger-full-access`로 등록되고 upstream 호출이 발생했다.

임의의 전역 변수를 바꾼 테스트가 아니라 같은 SQLite 상태를 새 설정으로 다시 구성한 MCP 서버에서 검증했다. 실행 부분은 파일을 변경하지 않는 가짜 upstream이다. 새 작업·이어가기·분기에서 공통으로 유효 sandbox를 계산하고 현재 상한을 적용한 뒤 작업을 등록해야 한다. 거절 시 작업·Activity·Agent의 실행 상태와 upstream 호출 수가 변하지 않아야 한다.

**A2 — 분기에 명시한 제한이 사라진다.**

`tools.ts:8096`의 분기 호출은 `args.sandbox`를 `forkTrackedSession`에 전달하지 않는다. 이 함수는 `session.sandbox`를 그대로 사용한다. `adaptive` 전체 접근 세션에서 `sandbox: "read-only"`를 보낸 결과, 새 분기 작업도 전체 접근으로 등록됐다.

호환용 입력 변환을 거치는 재현 외에 `taskContractVersion: "2"`, 최신 `executionEnvelopeRef`, 정확한 Activity/Agent 식별자, 호스트 scope 메타데이터를 이용한 공개 계약으로도 같은 결과를 확인했다. 호출자 제한을 무시해서는 안 된다. 현재 스레드 권한을 유지하는 제품 계약이라면 서로 다른 sandbox를 작업 생성 전에 거절하고 fresh context를 안내해야 한다. 실제 전환을 지원하려면 upstream 전달과 응답 검증까지 함께 구현해야 한다.

**A3 — 요청한 정책과 적용된 정책을 비교하지 않는다.**

`appServerUpstream.ts:880`은 `thread/start`에 sandbox와 승인 정책을 보낸다. 응답에서는 thread ID와 계보만 읽고 반환된 `sandbox`, `approvalPolicy`, `approvalsReviewer`, `activePermissionProfile`을 비교하거나 보존하지 않는다. `thread/resume`(`1089행`)에는 thread ID만 보내며, `turn/start`(`1309행`)에도 sandbox·승인 정책이 없다. 이어가기·분기 요청 타입(`upstream.ts:156`)에도 정책 정보가 없다.

합성 peer에 `read-only/on-request`를 요청하고 peer가 `dangerFullAccess/never`를 반환하게 했는데도, 실제 `CodexAppServerUpstreamPool`은 `turn/start`를 보내고 완료 결과를 반환했다. 재개 응답에서도 동일한 검증 누락을 확인했다. 이는 **현재 설치된 실제 CLI가 잘못된 정책을 반환했다는 증거가 아니라, 어댑터가 불일치를 검출하지 못한다는 증거**다.

특히 브리지 스레드를 앱에서도 열 수 있고 설정·프로필·관리 정책이 바뀔 수 있으므로 저장된 브리지 sandbox만 신뢰해서는 안 된다. start/resume/fork의 유효 정책을 검증하고, 이후 turn에 필요한 정책을 전달하거나 권한 불일치를 거절해야 한다. 정책이 요청보다 좁아진 경우도 명시적으로 알려야 한다. 네트워크·쓰기 루트·프로필·승인 담당자를 포함한 실행 증거가 필요하다. App Server의 정책 응답과 turn별 override는 [공식 문서](https://learn.chatgpt.com/docs/app-server)에 있다.

**A4 — 이어가기는 권한 충돌을 비대칭으로 처리한다.**

`tools.ts:9207`은 기존 sandbox가 쓰기 가능한 경우만 요청값과 비교한다. `read-only` 세션에서 `workspace-write`를 요청하면 거절하거나 전환하지 않고 읽기 전용으로 실행한다. 반대 방향인 쓰기 세션→읽기 전용은 기존 테스트에서 거절된다. A2와 같은 공통 정책 결정 함수로 모든 방향의 일관된 처리가 필요하다.

**A5 — 설치 가능·연결 가능·기능 지원을 구분해야 한다.**

`codexRuntime.ts:486`의 외부 설치본 `compatible`은 버전 문자열 확인으로 결정된다. 관리 설치는 추가로 무결성과 초기 연결을 검사하지만 `runtimeCompatibility.ts:30`의 연결 검사는 initialize 응답 필드만 확인한다. `appServerUpstream.ts:1729`와 `modelPolicy.ts:61`의 기능 플래그는 실제 설치본별 탐지 결과가 아니라 상수다.

정상 버전·initialize·model/list 응답을 제공하지만 `thread/fork`를 지원하지 않는 합성 peer를 검사했다. `compatible: true`, `supportsFork: true`를 얻은 뒤 실제 분기는 미지원 오류를 반환했다. 신규 버전을 일률적으로 막는 과거 전체 스키마 해시 허용목록을 다시 도입할 필요는 없다. 대신 작업에 필요한 메서드·입력 필드·응답 의미를 설치본별로 검증하고, 필수 기능이 없으면 작업 생성 전에 구체적으로 거절해야 한다. 선택 기능의 미지원은 UI와 호출 결과에 일관되게 나타나야 한다.

**A6 — CLI가 제공하는 상호작용을 브리지가 모두 중계하지 않는다.**

`appServerUpstream.ts:1537`은 명령 승인, 파일 승인, 권한 승인, 일반 사용자 질문만 처리한다. 설치된 세 CLI의 스키마에 있는 `mcpServer/elicitation/request`는 처리하지 않는다. 합성 form 요청을 실제 어댑터로 보내면 사용자에게 표시되는 interaction 없이 JSON-RPC `-32601 Unsupported App Server request`가 반환됐다. 정상 MCP 도구 호출 이벤트를 표시하는 것과 그 도구가 요구하는 추가 입력을 처리하는 것은 다르다. 요청을 자동 승인하지 않은 처리는 올바르지만, 기능 지원 공백은 남는다. [공식 문서](https://learn.chatgpt.com/docs/app-server)는 form·URL elicitation을 별도 상호작용으로 정의한다.

설치된 `ToolRequestUserInputParams`에는 필수 `isBlocking`이 있고 질문에는 `isOther`가 있다. 브리지의 `CodexPendingInteraction`과 질문 투영에는 이 의미가 보존되지 않는다. 비차단 질문을 일반 대기 상태와 같은 이벤트로 취급할 가능성이 있다. 이는 스키마·코드 검토 결과이며, 실제 비동기 질문 UI 완료 시나리오까지 실행한 것은 아니다.

**A7 — 고정 접근 모드의 오류와 설명을 정리해야 한다.**

고정 모드의 동일 sandbox 명시도 거절하는 동작은 기존 `tools.test.ts:7209`에서 의도적으로 보장하고 있다. 그러므로 단순 재시도로 숨길 문제가 아니라 입력 계약의 개선 사항이다. `docs/security.md:454`에는 고정 모드 descriptor에서 sandbox를 생략한다고 남아 있지만, 현재 안정된 v2 descriptor는 해당 필드를 계속 노출한다. 같은 문서의 172행 설명과도 맞지 않는다.

접근 전략, 명령 승인 정책, 승인 검토 담당자, ChatGPT 플러그인 승인, OS 권한의 관계를 보여주고 실제 적용값을 실행 결과와 연결해야 한다. `always-full`을 선택했다는 이유로 `never`로 자동 변경하는 방식은 승인 경계를 임의로 바꾸므로 개선안으로 삼지 않았다.

## 권한 외 검토 범위

| 영역 | 확인한 상태 | 이번 검토의 한계 또는 조치 |
| --- | --- | --- |
| 실행 경로 | 세 출처 모두 동일 App Server 어댑터 | 출처별 분기 추가 없이 공통 계약을 교정 |
| 버전·설치·업데이트 | 명시 선택, 관리 설치 무결성, lease·수동 업데이트 구조와 관련 테스트 확인 | 출처별 업데이트 소유자가 다른 것은 의도된 동작 |
| 모델·reasoning·Priority | 선택한 실행 경로의 카탈로그를 사용하고 계속하기 override 지원 | 실제 기본 카탈로그 차이 확인; 선택 모델을 조용히 낮춰 일치시키면 안 됨 |
| 파일·네트워크 권한 | 세 CLI에서 동일한 협상과 쓰기 제한 확인 | 네트워크 allow/deny·프록시·세부 permission profile 적용은 추가 검증 필요 |
| 인증·사용량 | 공통 `CodexService`, 파일 인증 변경 guard·캐시 검증 테스트 통과 | 실제 계정 전환, Keychain 인증 변경, 계정별 도구 권한은 미검증 |
| 시작·계속·분기·저장 | 기존 App Server·세션 경로 검토 및 회귀 테스트 | A1–A4 재현; 이번에는 모델을 실행하지 않아 durable 재개를 새로 인증하지 않음 |
| 조향·취소·worker 손실 | 기존 프로토콜·정확한 취소 테스트 통과 | 물리적 프로세스 장애와 실제 서비스 작업 중단은 이번에 실행하지 않음 |
| MCP·질문·승인 | 기존 기본 승인·질문 테스트 통과 | A6 중계 공백; 모든 연결 앱을 통과했다고 볼 수 없음 |
| 입력·출력 | 브리지 turn 입력은 단일 텍스트; CLI 스키마는 이미지 등 추가 형식 지원 | 직접 CLI 사용과 브리지의 지원 범위를 명시해야 함 |
| ChatGPT 카드·호스트 | 실행 어댑터와 별도 계층임을 확인 | Web/Desktop/iOS 승인·scope·카드 복구는 이전 감사의 미완료 항목을 유지 |
| OS·아키텍처 | macOS arm64의 세 실제 설치본 검사 | Windows/Linux/Intel의 동일성은 이번 결과로 보장하지 않음 |

설치 출처·버전·계정·OS가 다른 모든 CLI를 무조건 같은 기능이라고 표시하는 것은 성립하지 않는다. 제품이 보장할 기준은 **지원되는 공통 작업은 같은 입력에 같은 권한 의미와 오류 규칙을 갖고, 미지원 기능은 작업 등록 전에 알 수 있어야 한다**는 것이다. 모델이나 계정에 없는 기능을 조용히 대체해서 겉보기 성공으로 만드는 것은 이 기준을 충족하지 않는다.

## 검증과 재현

기존 관련 회귀 테스트는 8개 파일, 320개가 통과했다. 이 통과 결과와 별개로, 추가한 권한 안전성 기대값 4건이 모두 실패해 A1·A2·A4를 확인했고 공개 v2 입력을 사용한 A2 재확인도 실패했다. 실패는 실제 모델이나 사용자 파일을 실행하지 않는 MCP·SQLite·upstream fixture에서 발생했다. 이번 결과를 전체 제품 검증 통과로 표시하지 않는다.

실제 CLI 비교는 다음 검사기로 반복할 수 있다. stdout은 JSON 보고서다. 각 경로는 검사 대상 설치본을 명시하며 저장된 선택을 변경하지 않는다.

```sh
npx tsx scripts/audit-cli-parity.ts \
  terminal=/absolute/terminal/codex \
  app=/absolute/app/codex \
  bridge=/absolute/managed/codex
```

검사기는 임시 Codex home과 프로젝트를 만들고 종료 시 정리한다. 인증 파일·API 키·실제 프로젝트를 사용하지 않으며 모델 turn을 생성하지 않는다. `checksPassed`는 정책·파일 검사와 조회 요청의 수락 결과다. `sameModels`와 `sameFeatures`는 별도로 보고한다. 스키마가 같다는 사실을 기능 전체 통과로 표시하지 않는다.

권한 결함의 재현 테스트는 [패치](../../scripts/fixtures/cli-permission-audit.patch)로 보관했다. 일반 테스트를 의도적으로 실패하는 상태로 남기지 않기 위해 기본 테스트 파일에는 적용하지 않았다. 기준 커밋에서 다음과 같이 임시로 적용할 수 있다. 현재 코드에서는 5개 테스트가 실패하는 것이 재현 결과다. 적용과 복원 사이에 다른 편집을 하지 않아야 한다.

```sh
git apply --check scripts/fixtures/cli-permission-audit.patch
git apply scripts/fixtures/cli-permission-audit.patch
npx vitest run test/tools.test.ts \
  -t 'permission audit reproductions|public v2 audit' --maxWorkers=1
git apply -R scripts/fixtures/cli-permission-audit.patch
```

기존 관련 검증 명령은 다음과 같다.

```sh
npx vitest run test/tools.test.ts test/config.test.ts test/userSettings.test.ts \
  test/appServerUpstream.test.ts test/appServerCompatibility.test.ts \
  test/codexRuntime.test.ts test/codexService.test.ts test/upstreamRouter.test.ts \
  --maxWorkers=4
```

이전의 실제 인증 실행·승인/취소/질문 증거는 [CLI 관리 검증](2026-09-07-cli-management-acceptance.md)과 [실제 호스트·상호작용 검증](2026-09-07-live-host-and-interactions.md)에 있다. 이번에는 그 모델 실행을 반복하지 않았다. 모델 없는 빈 스레드의 재개 시도는 `no rollout found`를 반환했으므로 durable 재개 성공으로 계산하지 않았다.

## 수정 순서와 완료 조건

1. **권한 결정과 admission을 통합한다.** fresh/continue/fork 모두 현재 운영자 상한, 저장 전략, 요청 제한, 기존 세션 정책을 같은 규칙으로 처리한다. A1·A2·A4 재현 테스트가 통과하고 거절 전에 작업·upstream 부작용이 없어야 한다.
2. **실제 실행 정책을 검증한다.** start/resume/fork 응답의 sandbox·승인 정책을 확인하고 turn의 정책 전달을 완성한다. 불일치한 peer 응답에서는 turn을 보내지 않아야 한다. 외부에서 바뀐 지속 세션·프로필·승인 정책을 포함한다.
3. **기능 지원을 설치본별 증거로 표시한다.** 실행 파일 식별자가 바뀌면 기능 검증을 무효화한다. 필수 기능 미지원은 작업 생성 전에 구체적인 원인과 함께 거절한다. 동일한 버전 문자열이나 initialize 성공만으로 전체 지원을 선언하지 않는다.
4. **상호작용과 설명을 보완한다.** MCP form/URL 요청과 비차단 질문을 정확히 중계하고, 고정 정책·승인 정책·실제 권한을 같은 용어로 표시한다. 문서의 v2 descriptor 설명도 일치시킨다.
5. **공통 검증표로 재검사한다.** 세 설치본에 같은 설정과 같은 지원 모델을 사용해 파일·네트워크·승인·질문·재개·분기·취소를 검증한다. 계정/OS/호스트에 종속된 항목은 별도 증거가 있어야 완료로 표시한다.

현재 판단은 **설치본별 기본 권한 전달은 일치하지만, 브리지의 권한 일관성과 전체 기능 동등성은 아직 보장되지 않는다**이다. 위 P1 결함부터 교정한 다음 나머지 검증표를 완료해야 한다.
