# 이슈 #70 완료 여부 재검토

2026-09-08 재검토 판정: **전체 완료가 아니다.** 로컬 구현의 주요 경로는
검증됐지만 모델 오류 복구 안내의 누락, 최종 개발 브랜치 통합, 실제 호스트
적용 확인이 남아 있다. 이번 재검토는 제품 소스와 운영 서비스를 변경하지 않았다.

## 검토 기준과 확인된 결과

- 구현: `e62b5834da74f5f2691a1d05e0768cc73b0b76d6`.
- 병행 #69 최신: `b6157b086ac563e0bbdf3b9eabe69727cba9ac40`.
- 로컬 및 원격 `dev`: `323d55c725acfa82e81a0e3d350adf16f53468e7`.
- 현재 `src`의 SHA-256은 `831ad1eec5bd66fb274dce750e5ea3f31e894aa834e9098fdf8eca1dce37f0de`로
  이전 감사 기록과 일치한다. 이전 affected 로그의 빌드·계약 검사 및 770개
  테스트 통과가 다른 소스의 결과인 것은 아니다.
- 재검토에서 `toolGuidance`, `projectRegistry`, `modelPolicyTransport`,
  `outputContracts`의 4개 파일, **50개 테스트가 다시 통과**했다.
- #69의 `af1a8f7` 이후 변경은 문서·검증 기록뿐이다. 최신 #69와의 가상 병합은
  성공했고 제품 소스·테스트·스크립트·의존성 파일에는 추가 차이가 없다.

## 1. 모델 오류의 실행 시 복구 안내가 아직 정리되지 않음

`src/modelPolicy.ts:606`의 `MODEL_UNAVAILABLE`은 다음 문자열을 생성하며,
`src/tools.ts:16786`의 현재 계약용 변환에서도 그대로 남는다.

> Refresh the model catalog and settings.

목록에 없는 추론 수준으로 현재 `codex_task`를 호출하는 상황을 production
MCP 서버와 SDK 클라이언트로 재현했다. `delivery: none`, `jobId: null`인
오류가 반환됐으며 `nextActions`에는 위 문구와 일반적인 모델 선택 안내만
있었다. 같은 설정에서 `codex_models({contractVersion: "2", refresh: true})`는
`selectionMode: automatic`과 사용할 수 있는 `gpt-5.6-sol/max`를 반환했다.
이 검사는 모의 카탈로그와 임시 DB를 사용했고 upstream 호출은 **0회**였다.

따라서 카드 없이 복구 정보를 얻을 수 있는 오류에서도 정확한 읽기 도구와
인자를 안내한다는 기준이 아직 충족되지 않는다. 이 재현만으로 실제 ChatGPT가
설정 카드를 열었다거나 이전 반복 열기의 원인이라고 단정하지 않는다.

남은 수정은 현재 모델 오류의 복구 안내를 정책 모드·실제 오류에 맞게 정리하고
그 경로의 회귀 검사를 추가하는 것이다. 고정 정책이 per-call selection을
거부하는 정상 계약이나 구형 응답 스키마를 일괄 변경해서는 안 된다.

재현 자료: 로컬 `output/tool-guidance-implementation/review-model-recovery.ts`
및 같은 이름의 JSON. 기존 50개 재검사에는 이 누락을 잡는 단언이 없다.

## 2. 최종 dev 통합은 아직 충돌을 해결해야 함

작업공간을 변경하지 않는 `git merge-tree --write-tree HEAD dev`에서 다음
**7개 파일의 충돌**을 확인했다.

- `macos/Resources/Localization/Localizable.xcstrings`
- `src/activityCard.ts`
- `src/dashboardCard.ts`
- `src/settingsCard.ts`
- `src/uiI18n.ts`
- `src/uiManifest.generated.ts`
- `ui-manifest.lock.json`

최신 #69만 `dev`와 비교해도 정확히 같은 7개가 충돌한다. 따라서 #70이 새로
일으킨 충돌로 분류하지 않는다. #69의 도구 통합·이전 카드 호환과 dev의
Fast 모드 표시 변경을 함께 보존해 해결한 뒤 생성 자료와 관련 검사를 다시
확인해야 한다. #69 최신 변경과 충돌이 없다는 사실은 dev 통합 완료를 뜻하지 않는다.

검사 로그: 로컬 `review-dev-merge.txt`, `review-issue69-dev-merge.txt`.

## 3. 실제 적용은 아직 확인되지 않음

원격에는 #69·#70 작업 브랜치가 없으며 dev에 이번 변경이 포함되지 않았다.
#69 최신 호스트 검증 기록은 `af1a8f7`의 일부 실제 실행을 확인하지만 이후
운영 빌드와 플러그인 탐색을 원래 상태로 복구했다고 명시한다. #70의 설명과
모델 v2가 실제 ChatGPT에서 채택된 증거는 아니다.

최종 통합·원격 반영·운영 적용 후 새로운 설명과 v2 조회의 실제 채택을
확인해야 한다. #69의 완료 알림·종료된 GPT 응답 이후 인계·원본 제어·활성 작업
재시작 검증은 계속 별도의 미완료 조건이다. 이 검토의 테스트 통과로 대신하지 않는다.

초기 분석 문서 4개(`tool-guidance-review`와 `tool-guidance-code-fit`의 MD/JSON)는
원래 작업공간의 미추적 파일이며 #70 커밋에는 없다. 이슈가 해당 자료를 근거로
참조하므로 최종 통합 시 최종 구현과 역사적 제안을 구분해 함께 보존할 필요가 있다.

## 후속 보완 — 모델 오류 안내

위 1번 누락을 후속 구현에서 보완했다. 현재 Task 계약은 모델 선택 누락,
지원되지 않는 선택, 허용 목록 불일치, 카탈로그 조회 실패 및 Priority 조건
불일치를 `codex_models({"contractVersion":"2","refresh":true})`로 안내한다.
고정 정책의 per-call override는 `selection` 생략으로 별도 안내하고, 기존
백엔드가 모델 변경을 지원하지 않는 오류는 현재의 `agent.context` 구조를 쓴다.
정책 오류의 원인 구분은 내부 타입으로 보존하며 원문 문자열 매칭에 의존하지 않는다.

카탈로그의 정책 모드에 따라 다음 입력을 결정하고, 읽기 실패나 호환 선택이
없는 상황은 사용자에게 보고한다. 오류 복구를 위해 저장된 Priority·접근
정책을 자동 변경하라는 지시는 제거했다. 구형 계약의 기존 안내와 출력
스키마, 접수 후 실패·정확한 재시도 경로는 유지한다.

회귀 검사 8개를 추가했다. 고정 모드의 값 생략을 실제 JSON 전송과 동일하게
검증하도록 메모리 전송 테스트에서도 undefined 속성을 직렬화 단계에서
제거한다. 전체 affected 검사에서 빌드·릴리즈·CLI 0.153.3 계약 및
**63개 파일, 778개 테스트가 통과**했다. 로그는 로컬
`output/tool-guidance-implementation/model-recovery-affected.log`에 있다.

최종 통합은 병행 #69 작업공간에서 진행 중이다. 현재 작업공간에서 중복으로
운영 빌드나 서비스를 교체하지 않았다. 위 2·3번의 최종 완료 여부는 통합 및
호스트 증거로 별도 확인한다.

## 후속 통합 검증

#69가 개발 브랜치 `323d55c`와 원래 진행 중이던 파일을 보존해 통합한
`ee9bd35`를 이번 보완과 병합했다. 검증 커밋은 `f5027b3`다. 기존 7개 충돌의
해결을 포함한 통합본이며 dev는 그 조상이다. #70 보완과의 추가 병합 충돌은
없었다. 분석 MD/JSON 4개와 재현 스크립트도 이 통합으로 보존됐으며 역사적
제안과 최종 구현을 구분하는 안내를 MD에 추가했다.

`node scripts/release-validation.mjs affected --base origin/dev`에서 빌드·릴리즈·
CLI 0.153.3 계약, **63개 파일 780개 테스트**, macOS의 엄격한 동시성 검사와
**101개 테스트 중 99개 통과·2개 건너뜀·실패 0건**을 확인했다. 변경 174개
경로에 대해 Node와 macOS 검사가 모두 수행됐다. 로컬 로그는
`output/tool-guidance-implementation/integrated-affected.log`이며, 커밋과 소스
지문을 포함한 기록은 [통합 검증](issue-70-integration-validation.json)에 있다.

이 통합본은 `codex/issue-70-tool-guidance` 원격 브랜치에 반영했다. 운영 배포와
실제 호스트 검증은 병행 #69 작업에서 수행하도록 조율했다. 병행 작업의
추가 수정이 있으면 최종 적용 커밋과 검증 범위를 다시 대조한다.

실제 호스트 검증은 Mac 잠금으로 멈췄다. #69의
`2026-09-08-issue-69-integration.md`는 정상 컴퓨터 사용 도구가 잠금을 보고했고
사용자에게 해제를 요청했으며, 운영 서비스 교체나 플러그인 탐색 갱신은 아직
하지 않았다고 기록한다. 통합 후보 빌드는 `f5027b367309:21c885d97b57`이다.
이 상태를 실제 ChatGPT 채택 또는 운영 배포 완료로 처리하지 않는다.
