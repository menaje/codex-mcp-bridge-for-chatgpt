# CLI 실행 승인 정책 중앙화 · 2026-09-08

## 확인한 원인

브리지 관리 CLI, 앱 내장 CLI, 터미널 설치 CLI는 이미 같은 선택 관리자와
App Server 실행 경로를 사용하고 있었다. 다른 업체의 CLI를 실행하는 어댑터는
현재 없다. 그러나 접근 전략과 승인 정책은 서로 다른 위치에서 결정됐다.
`always-full`은 sandbox만 전체 접근으로 바꿨고, 새 작업·이어가기·분기 각각이
환경 설정의 승인 기본값을 읽었다. 승인 담당자는 선택한 CLI의 응답값에 의존했다.

문제가 된 실행에서도 전체 접근과 `on-request`가 함께 확인됐고,
`github.update_issue`의 MCP 승인 입력을 기다리던 작업을 상위 호출자가 취소했다.
Codex 사용자 설정의 `never`는 브리지가 명시한 `on-request`보다 우선하지 않았다.

## 변경한 실행 기준

`src/executionPolicy.ts`가 저장된 접근 전략과 운영자 상한으로 sandbox, 명령 승인,
승인 담당자, 연결 도구 기본 승인을 한 번에 결정한다. `UserSettingsStore`의
sandbox 조회도 같은 함수를 사용한다. 작업 입력으로 승인 정책을 바꾸는 필드는
추가하지 않았다.

| 전략 | sandbox | 명령 승인 | 연결 도구 기본 승인 |
| --- | --- | --- | --- |
| 항상 전체 접근 | 허용된 경우 danger-full-access | never | approve |
| 읽기 전용 | read-only | 기존 환경 기본값 | auto |
| 브리지 기본값 | 환경 기본값 또는 기존 문맥의 sandbox | 기존 환경 기본값 | auto |

승인 담당자는 `CODEX_MCP_BRIDGE_APPROVALS_REVIEWER`의 `user` 또는 `auto_review`를
명시해서 전달한다. 기본값은 `user`다. 전체 접근이 운영자 상한에서 비활성화됐으면
승인 생략과 연결 도구의 approve도 적용하지 않는다. 기존 문맥의 sandbox가 현재
설정과 충돌하면 실행 전에 거절한다.

typed 호출과 호환 호출 모두 같은 전달 함수를 사용한다. start/resume/fork에서
공통 정책을 전달하고, App Server가 반환한 sandbox·승인 정책·승인 담당자·작업
폴더를 비교한 뒤 turn을 시작한다. 연결 도구 기본값은 스레드 설정의
`apps._default.default_tools_approval_mode`로 전달한다. 모델 추론 설정과 함께
전달해도 승인 설정이 덮어써지지 않는다.

CLI 호환성 검사는 reviewer/config 요청 필드뿐 아니라 생성된 설정 스키마에서
연결 도구 승인 필드와 `auto`/`approve` 지원 여부도 검사한다. 임의 키를 받을 수
있는 config 객체의 존재만으로 지원을 인정하지 않는다. 정책 계약 버전과 승인
담당자를 실행 참조에 포함해 이전 정책의 신규 실행 요청을 재사용하지 않는다.

## 승인 경계와 증거 범위

`never`만 설정해도 MCP 승인 요청에 동의한 것으로 처리되는 것은 아니다.
따라서 전체 접근의 명령 승인과 연결 도구 기본값을 함께 설정한다. 개별 앱·도구의
명시적 예외, 비활성화된 도구, 서비스 인증·추가 입력, 조직 요구사항, ChatGPT
호스트의 승인은 별도로 적용된다. 실제 승인 요청을 자동으로 응답하거나 거절된
행위를 다른 도구로 재시도하는 코드는 추가하지 않았다.

App Server의 thread 응답에는 실제 도구별 승인 설정이 없다. 그래서 연결 도구
증거는 설정 전달 확인으로 표시하고, 응답에서 검증한 sandbox·명령 승인과 구분한다.
이미 로드된 스레드의 연결 도구 기본값이 다르면 새 문맥이 필요하다고 알린다.
브리지 외부에서 직접 실행하는 Codex의 사용자 설정 파일은 변경하지 않는다.

## 검증

| 검사 | 결과 |
| --- | --- |
| 최종 `npm run check` | 빌드·릴리스 정합성 통과, 64개 파일의 794개 테스트 통과 |
| `npm run app-server:compat:check` | CLI 0.153.3의 JSON 416개·TypeScript 827개 계약 일치 |
| `npm run macos:check` | 9개 언어 572개 문구 검증, Swift 테스트 101개 중 99개 통과·2개 건너뜀·실패 0개 |
| 실제 CLI 3종 | 공통 정책 9건, 명시적 정책 조합 27건, 임시 파일 허용/차단 12건, 조회 메서드 24건 통과 |
| 연결 도구 설정 인식 | 격리된 터미널 CLI에서 잘못된 승인 값을 보내자 해당 설정 경로의 enum 오류로 거절됨 |
| `git diff --check` | 공백 오류 없음 |

실제 설치본은 터미널 0.153.3, 앱 내장 0.153.4, 브리지 관리 0.153.4이며,
[설치본별 검증 결과](2026-09-08-central-execution-policy.json)에 기록했다.
실제 CLI 검사는 격리된 Codex home을 사용했고 모델 turn이나 인증된 외부 쓰기를
수행하지 않았다. 지속 세션의 이어가기·분기 및 잘못된 정책 응답 차단은 합성
App Server로 검증했다. 실제 GitHub 쓰기 승인 전체 흐름의 검증을 의미하지 않는다.

## 반영 상태

사용자의 앱 종료·빌드·실행 요청에 따라 2026-09-08 19:13 KST에 새 macOS 앱을
별도 빌드 폴더에 생성했다. 빌드 ID는 `b5b9094e355d-dirty:0f547a6777a6`이다.
번들 빌드의 Swift 테스트는 101개 중 99개 통과·2개 건너뜀·실패 0개였고,
앱 서명 및 설치본의 소스 해시 일치도 검증했다. 번들에 포함된 정책 모듈에
실제 저장 설정을 적용해 `always-full` → `danger-full-access`·`never`·`user`·
연결 도구 기본값 `approve`를 확인했다.

처음 종료 요청 시 실행 중이던 코니 작업 2개는 각각 19:28:10과 19:30:32 KST에
완료됐다. 이후 활성 작업·대기 입력·백그라운드 프로세스가 모두 0개임을 확인하고,
helper의 정상 drain 종료를 완료했다. Mac 잠금 상태에서 화면 조작을 사용할 수
없어 helper LaunchAgent를 해제한 뒤 이미 실행부가 정리된 기존 앱 프로세스만
TERM으로 종료했다. 기존 앱·helper·launcher·server·worker 및 소켓·잠금 파일이
모두 정리된 것을 확인한 후 새 앱을 실행했다. 진행 중 작업의 강제 취소는 없었다.

운영 앱은 이제
`output/builds/2026-09-08-191500-central-policy/Codex MCP Bridge for ChatGPT.app`이며,
앱 번들·실행 중 helper·bridge의 빌드 ID가 모두 위 새 빌드와 일치한다.
LaunchAgent도 새 번들의 실행부를 가리킨다. 브리지는 `running`, 보안 터널은
`connected`, 선택된 브리지 관리 CLI 0.153.4는 사용 가능·호환 상태로 확인됐다.
기동 후에도 활성 작업과 백그라운드 프로세스는 모두 0개였고, 실제 저장된
`always-full` 설정 및 `executionPolicyActive: true`를 확인했다.
조회된 `developerModeRefreshRequired`는 `false`다. ChatGPT 호스트에서 기존
도구 계약을 실제로 새로고침하는 조작이나 모델 turn은 실행하지 않았다.
배포 검증 기록은 해당 빌드 폴더의 `deployment-check.json`에 보관했다.
같은 작업 폴더의 별도 대시보드 변경은 보존했다.

기존 2026-09-07 감사의 `always-full`과 승인 정책을 별도로 유지한다는 동작 설명은
이번 사용자의 수정 요청에 따라 위 실행 기준으로 변경됐다.

공식 계약: [Codex 설정](https://learn.chatgpt.com/docs/config-file/config-reference),
[App Server](https://learn.chatgpt.com/docs/app-server).
