# #222 최종 증거 통합 — 2026-10-03

시험에서 확인된 Site 역할은 **private MCP + D1 저장 + 사용자 승인된 명시적 1회 outbound/pull 왕복**이다. 기존 fixture 1건과 왕복 receipt 1건이 보존됐고, 정상 연결된 같은 MCP read_fixture를 originating ChatGPT가 v3 이후 두 번 읽어 전체 응답이 동일함을 확인했다. 운영 기본 direct-wait와 기존 원본권한을 변경하지 않는다. 이 문서는 최종 증거 취합·문서 통합이며 새 Site/원격 시험·배포·연결은 수행하지 않았다.

## 최종 관측과 출처

| 근거 | 관측자·범위 | durable 위치 |
| --- | --- | --- |
| 정상 Install/OAuth Connect, 최초 v2 조회 | 사용자 연결 확인 + originating ChatGPT 실제 도구 관측 | [당시 parent snapshot](issue-222-sites-independent-20261003/roundtrip/parent-mcp-observation.json) |
| v3 같은 MCP 도구 2회, 전체 응답 동일 | **originating ChatGPT actual tool observation**, 최종 사용자 지시로 작성 Agent에 전달. 작성 Agent/Reviewer의 직접 MCP 호출이 아님 | [최종 상위 관측](issue-222-sites-independent-20261003/finalization/originating-chatgpt-observations.json) |
| fixture compact JSON SHA256 재계산 일치 | originating ChatGPT 실제 관측 보고; 문서 취합에서 제공 객체를 로컬 재계산 | [최종 JSON](2026-10-03-issue-222-final-evidence.json) 및 [검증](issue-222-sites-independent-20261003/finalization/validation.json) |
| cloud HTTP8 / loopback HTTP1 | 실제 trial runner 기록. 로컬 이벤트도 **같은 runner가 작성**했으며 독립 외부 계측이라고 표현하지 않음 | [단일 시험 원자료](issue-222-sites-independent-20261003/roundtrip/actual-trial.json) |
| cloud 저장 receipt/원 fixture 각 1건 | 당시 공식 Sites native D1 read 및 배포 원응답 | [provider 원응답](issue-222-sites-independent-20261003/roundtrip/provider-after-trial.json) |
| source·원자료 검토 PASS | 독립 Reviewer Job `89f45a29-49e8-4466-902a-f5e6fd2c29f8`. 원자료·source 검토이며 Reviewer 직접 MCP 호출이 아님 | [Reviewer 전달 결과](issue-222-sites-independent-20261003/finalization/reviewer-result.json) |

Reviewer는 queued→claimed→acked, enqueue inserted:false/ACK duplicate:true, count1·최초 시각 유지, SELECT-only read_fixture, 기존 D1 fixture 보존 및 v3 manifest **23개** 해시·크기 일치를 확인했다. 작성 Agent도 이번 문서 취합에서 저장 bytes/manifest와 제공 응답을 로컬 검증했다. 두 digest는 **서로 다른 값**이며 command JSON과 local response JSON을 각각 재계산한 값이다. 같은 값이라는 의미가 아니다.

원 fixture key는 `issue-222-independent-20261003`, payload는 `{"probe":"issue-222","phase":"A","value":222}`, digest는 `41dc4aa8f1eee177712f07a26317117b9971f3239061a35420637e3ced89aaaf`, 최초 저장 시각은 `2026-10-02T23:38:53.750Z`다. v3 receipt의 command ID는 `issue-222-pull-roundtrip-20261003`, 상태 acked, executionCount1, resultMatchesFixture:true다.

- requestDigest: `e1f0757524bb4b7e568ab3378c8aaba461ac8b5254729f74a06bbc3f2ee6b820`
- responseDigest: `647a4c380af69927a3b47155cb936dba7939f493bb5dac2a3f7eeefbca73cbf7`

executionCount는 ACK에 저장된 local handler 보고값이며 실제 로컬 1회 실행은 같은 runner의 request/handler/response 기록과 대조했다. 응답 원문의 executionCountBasis에 있는 “independent local log” 문구는 원문대로 보존하지만 외부 독립 계측이라는 해석은 채택하지 않는다. 원래 read_fixture의 fixture 필드는 유지됐고 roundtrip 요약은 SELECT-only다. 읽기로 enqueue/claim/실행/ACK가 발생하지 않는다.

## 과거 snapshot과 최신 관측의 연결

[v1/v2 README](issue-222-sites-independent-20261003/README.md), [v3 trial README](issue-222-sites-independent-20261003/roundtrip/README.md), 각 validation 및 parent-mcp-observation.json은 당시 snapshot이다. “v3 상위 재조회 미관측”은 그 capture 시점의 상태이며 **삭제·수정하거나 직접 네트워크 관측으로 소급 변경하지 않았다**. 최종 상위 2회 관측은 별도 JSON으로 연결한다. [2026-10-02 기존 감사](2026-10-02-issue-222-receiver-research.md)도 역사적 연구 상태로 보존하며 이번 제한된 성공을 플랫폼 전체·운영 receiver 성공으로 확장하지 않는다.

기존 원자료·source·manifest는 exact bytes로 보존했다. 원래 scripts 경로를 참조하는 manifest는 변경하지 않았고, runner 파일을 docs의 비실행 `.txt` snapshot으로 보존했다. [경로 대응 index](issue-222-sites-independent-20261003/preserved-runner-source/index.json)가 원래 path와 durable path/동일 hash를 연결한다. 이 최종 단계에서 보존된 runtime/validator script는 실행하지 않았다.

## 범위표와 재사용

| 항목 | 최종 판정·출처 | 이번 단계 |
| --- | --- | --- |
| private MCP 읽기 | originating ChatGPT actual: v2 최초 성공 + v3 같은 도구 2회 동일 응답 | 새 호출 없음 |
| D1 저장·fixture 보존 | actual HTTP/native D1 + source/원자료 검토 | 원자료 재사용 |
| 고정 1회 outbound/pull 왕복 | actual claim→loopback read→ACK, cloud HTTP8/local HTTP1 | 원자료 재사용 |
| 중복 enqueue·동일 ACK | 실제 수행한 중복 조건. count1·최초 시각 유지 | 재시험 없음 |
| 화면 이탈·앱 종료 뒤 GPT 재개 | **user-confirmed actual 완료** | 재시험 없음 |
| 30분/60분 | 과거 actual 완료 재사용: **1800.086446041초 / 3600.075175209초** | 원 지시의 완료 보고를 출처로 기록; 새 원자료 취득·실행 없음 |
| A→B/replay | 과거 actual 완료 증거 재사용 | 재시험 없음 |
| UI/TinyFish·예약·Events | 사용자 제외 | 새 동작 없음 |
| 부모 ChatGPT 모델·추론·usage | 공개 응답에 미노출하여 측정불가. 성공으로 판정하지 않음 | Codex 카운터로 추정하지 않음 |
| 직접 push·상주 polling·production Codex remote routing | 미검증, 별도 #223 설계 범위 | 기능 성공으로 확장하지 않음 |
| 모든 장애·오프라인·동시경합 | 미검증. 기록된 enqueue/ACK 중복 조건과 구별 | 새 시험 없음 |

실제 네트워크 시작은 Local→private Site HTTPS다. Site가 생성한 command가 claim 응답으로 Local에 전달되고, task-owned loopback handler 응답을 Local이 cloud에 ACK했다. Worker가 로컬 listener에 직접 연결한 push는 확인하지 않았다. 따라서 성공은 명시적 1회 pull 범위다. user-confirmed GPT 재개 완료와 종료된 모든 일반 Chat turn의 자동 wake 보장은 서로 다른 범위다.

운영 DB·전역 설정을 직접 감사하지 않았다. “변경하지 않았다”는 당시 수행 범위·보고이며 직접 DB/settings 감사 결과로 쓰지 않는다. 이번 Git 변화는 감사 docs만이고 운영 소스·워크플로·CI 설정은 변경하지 않았다. 과거 임시 서명 screenshot URL 출력 사건은 이전 감사에 남겨 두며 실제 URL은 durable evidence에 포함하지 않는다.

## 배포 source와 Bridge 감사 Git 구분

Site는 기존 owner-only `appgprj_6abf89d2d04c8191a617d5193ef5471a`, v3 deployment `appgdep_6ac04c20c7d8819189be9303b6a24a55`, **Site source commit `7755827919c042166cf5e2a7cfe3e0f5f76df577`**다. 이 SHA는 Bridge 감사 commit이 아니다. 이번 문서 단계에서는 Site를 조회·재배포하거나 credential을 발급하지 않았다.

Bridge 통합 대상은 dev이며 작업 시작 시 root/dev/origin/dev와 실제 ls-remote는 모두 `a584d34c64b7449a391b5acba4f80ca447e518e7`, root는 clean이었다. Bridge 감사 commit과 실제 remote dev SHA는 완료 시 Git 원응답으로 보고하며 자기 commit SHA를 문서에 순환 삽입하지 않는다. selective stage는 이 최종 Markdown/JSON과 전용 evidence docs에만 적용한다. 기존 untracked scripts 및 다른 작업자 worktree는 수정·stage하지 않는다.

[최종 검증](issue-222-sites-independent-20261003/finalization/validation.json)은 JSON·기존/최종 manifest·hash/size·상대 링크·비밀 패턴·whitespace·출처/범위 대조를 기록한다. [docs-only affected 검증 로그](issue-222-sites-independent-20261003/finalization/affected-validation.txt)와 [최종 hash inventory](issue-222-sites-independent-20261003/finalization/file-digests.json)를 함께 보존한다. 원자료를 소급 조작하지 않으며 GitHub 이슈 본문·코멘트·상태는 상위 담당으로 남긴다.

원 Site/비민감 receipt는 그대로 남아 있고 새 task-owned 서버는 만들지 않았다. 기존 evidence worktree는 원래 untracked runner를 보존하므로 강제 정리하지 않는다. 검증용 임시 worktree는 검증 종료 후 clean/프로세스 사용 여부를 확인해 안전하게 제거한다. 다른 대화/thread/작업자 자산은 정리하지 않는다.
