# #221 구조화 오류 요약 P2 보완 — 2026-10-03

보존된 구조화 오류가 요약에서 `JOB_FAILED`로 축소되던 기존 P2를 수정했다. 개별 Job과 overview/jobs/Activity/thread는 같은 정규화 함수를 사용한다. 원래 오류가 있으면 공개 가능한 code·message·retryable·missingFields·contextContinuity를 우선 보존하며, 없을 때만 상태와 문자열에서 기본 오류를 만든다. 결과 본문과 내부 진단 필드는 요약에 포함하지 않는다. [대응 JSON](2026-10-03-issue-221-structured-errors.json)에 producer를 포함한 검증 metadata와 로컬 증거 digest가 있다.

## 구현과 회귀

기준선은 clean dev/origin/dev `6ef2abe3c80043b1ed3c197fbc0b6106328ef14c`, 이전 설치 producer는 `1d9ea4a51615bbe60d73339116296e84be888725`다. npm 10.9.3의 lockfile 기준 ci를 사용했으며 의존성·lockfile 변경은 없다. 수동 task worktree에서 제품 커밋 **`a16cc51f20af396ba05d83b8d165240b52d528b5`**를 만들고 dev에 fast-forward 통합·non-force push했다. 이 보완 감사는 docs-only 후속 commit이며 설치 producer를 감사 commit으로 바꾸지 않는다.

새 SDK HTTP 회귀 3종을 변경 전 코드에 실행해 모두 요약 축소를 재현했다. 수정 후에는 CONTEXT_WINDOW_EXCEEDED/retryable=true, retryable=false와 추가 공개 필드, retryable 누락이 다섯 조회에서 일치한다. 구조화 원래 오류가 문자열보다 우선하며 원문·내부 upstreamKind·privateDiagnostic은 노출되지 않는다. 기존 취소·중단·terminal commit 실패의 fallback도 유지한다.

후속 실행 코드는 변경하지 않았다. 새 B의 최초 접수에서는 현재 부모 reviewedVersion과 승인 조건을 검사한다. 이미 접수된 B의 replay는 원래 동일성·권한·prompt·context를 확인해 같은 B를 반환하며 reviewedVersion 일치를 다시 검사하지 않는다. 새 시험은 오래된 버전으로 최초 접수가 거부되고 영수증이 유지되며, 정상 접수 뒤 같은 오래된 버전의 replay는 기존 B로 수렴하고 추가 upstream 실행이 없음을 확인한다.

| 검증 | 새 producer의 결과·범위 |
| --- | --- |
| focused | 2개 파일, 36개 통과. precommit 로그이며 동일 시험이 아래 full producer run에도 포함됨 |
| 전체 Node | 120개 파일, **1,307/1,307 통과**, 실패0 |
| strict Swift | **218개 실행, 2개 선택 skipped, 실패0**. 앱 패키징의 strict 검사도 같은 집계로 통과 |
| fast/schema | release/localization 일치, Codex CLI 0.153.3의 JSON416/TypeScript827 schema 일치 |
| 설치된 Native Companion | 실제 bridge.sock의 Dashboard/Settings 읽기 계약 **1개 통과** |
| 설치 런타임 오류 조회 | 실제 설치 dist의 server/config/state/settings/tools와 workspace 시험용 SDK client. 임시 SQLite·합성 upstream·loopback HTTP에서 **3종 × 5경로 × 실행/재시작 2단계 = 30개 통과** |
| 실제 connector 읽기 | 현재 원래 대화 scope의 목록이 전후 정상 반환. Job0이며 다른 대화 scope로 옮기지 않음. 운영 구조화 실패의 actual 비교로 집계하지 않음 |
| 독립 CI | 제품 SHA의 GitHub Actions run0. 로컬 통과를 독립 CI로 표현하지 않음 |

Node/Swift/앱 빌드 및 설치 시험의 새 로그 첫 줄과 동반 JSON에는 clean producer와 sourceHash, command, 시간, exitCode와 로그 digest를 기록했다. 최초 affected 실행에는 스키마 검사용 CLI 환경값을 전체 시험에 잘못 적용해 환경 선택 시험4개가 실패했다. 지정값을 fast/schema 검사에만 한정한 뒤 전체 Node가 통과했으며 제품 코드를 바꾸지 않았다. 설치 fixture의 최초 실행은 앱에 제외된 시험용 devDependency client를 찾다가 실패했다. 시험 client만 workspace에서 읽도록 고쳤고 모든 제품 server module은 설치 경로에서 읽는다. 두 실패 기록도 보존한다.

## 실제 배포와 보존

새 설치는 0.4.1/development, 공개 RC·stable release 없음이다.

- product producer: `a16cc51f20af396ba05d83b8d165240b52d528b5`, dirty=false
- sourceHash: `5975f3bd727fc98ec78f2aa9f0bbdad8f8caab9f6c0b0858006b6e2aee284dc0`
- buildId: `a16cc51f20af:5975f3bd727f`, CFBundleVersion **2026100303**
- 앱/Helper/Bridge buildId 일치, running, Bridge/Tunnel connected
- 설치 tools.js SHA-256: `0e35e94a3b398b70dff16bfb1e7084d98789f686094698dde410a670ae2e0955`, 빌드 bundle 및 설치 fixture와 일치

교체 직전 active/pending Job·interaction·protected memory/background/unknown이 모두0임을 확인했다. Helper의 force=false graceful shutdown 뒤 앱·launcher·SQLite owner 종료와 lifecycle handoff completed를 확인하고 consistent DB backup/integrity/FK 검증을 했다. 0700 recovery 디렉터리에 0600 DB/env와 이전 앱을 보존하고 서명 검증한 bundle로 교체했다. native launch의 AX 관측은 timeout됐지만 앱은 시작됐으며 API의 starting→running 및 Bridge/Tunnel 연결로 준비 상태를 확인했다.

설치 후 조회 검사를 마친 뒤 다시 대조해 **1054개 Job의 모든 raw payload와 3개 후속 승인 영수증**, settings/project registry/projects/env가 모두 동일했다. 새 운영 Job0, quick check/FK 정상이다. 구조화 실패는 임시 fixture에서만 만들었다. 이번 변경은 읽기 projection이며 기존 실행·승인·정책·식별자를 변경하지 않는다.

Dashboard/Settings compiled module digest가 이전 설치와 동일하다. 카드 URI는 Dashboard v4/generation38, Settings v4/generation25를 유지한다. 카드·wait 수명·transport·retention 변경이 없어 기존 실제 A→B/replay/취소/명시적 카드 무송신과 30·60분 근거를 재사용하며, 새 producer의 actual 시험으로 소급 집계하지 않는다.

## 보고 정정과 완료 범위

[이전 감사](2026-10-03-issue-221-direct-wait.md)의 reviewedVersion replay 설명을 위의 최초 접수/기접수 반환 구분으로 정정했다. 기존 MCP 상세 기록은 **29개 통과·1개 skipped, 실패0·경고0**이며 stdout29/29의 분모에 skipped가 없다는 점을 명시했다. 이 보완에서 MCP 적합성 runner를 새로 실행하지 않았다.

새 질문·승인 대기 경계를 실제 ChatGPT에서 발생시키지는 않았다. 해당 검증 근거는 로컬 integration/fixture로 유지한다. 구형 v3 iframe이 이미 결과를 가진 경우의 최초 host 송신1회 가능성과 원 대화의 결과 접근 권한도 기존 한계로 유지한다. 새 대화로 기존 Job 권한이 이전된다고 주장하지 않는다.

이전 로컬 증거 **118/118개 크기·SHA-256**가 그대로임을 재확인했다. 새 증거는 별도 ignored `output/issue-221-p2`에 보존한다. 제품 commit의 dev 통합·push는 완료했고 이 감사의 docs-only 통합, 이슈 종료, task-owned worktree/branch의 안전한 정리를 최종 완료 전 확인한다. 다른 worktree와 모든 Codex/ChatGPT 대화는 정리 대상에 포함하지 않는다.
