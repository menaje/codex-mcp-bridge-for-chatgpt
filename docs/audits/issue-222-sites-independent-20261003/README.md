# #222 독립 Sites 저장·MCP 시험 — 2026-10-03 KST

전용 private Site `appgprj_6abf89d2d04c8191a617d5193ef5471a`의 **D1 저장은 actual PASS, MCP 실제 호출은 정상 인증 경계에서 BLOCKED**다. 코드 작성이나 `has_mcp:true`만으로 MCP 성공을 판정하지 않았다. 기존 P3 Agent/thread는 접근·변경하지 않았다. 이전 작업자 보고와 감사 문서는 참고자료이고 아래 결과는 이번 독립 원응답이다.

| 항목 | 독립 결과 |
| --- | --- |
| 기존 v1 | owner/custom audience, allowed user 1, editor 0, external visitor 0, automations 0. deployment succeeded, has_mcp=false. D1 bindings/tables 없음. |
| v1 HTTP | metadata/ingest HTTP200, 두 ingest 모두 accepted:true/persisted:false. MCP initialize HTTP404. |
| 최소 v2 | 공식 manifest에 capabilities:[mcp], d1:DB. 스키마만 포함하는 Drizzle migration 적용. private 재배포 succeeded/has_mcp:true, 정상 MCP 연결 metadata 제공. |
| v2 저장 | 처음 count:0 → 첫 쓰기 inserted:true/persisted:true → 별도 HTTP GET count:1 → 같은 key/payload 재쓰기 inserted:false → 또 다른 HTTP GET count:1. payload digest와 최초 createdAt 유지. actual PASS. |
| v2 MCP | 공식 연결 URL에 initialize 실제 POST 1회, HTTP401/Unauthorized. 즉시 호출 중단. tools/list 및 read_fixture 미수행. Worker RPC 실행 도달 미확인. |
| Site→Local | 정상 지원·승인된 채널 확인되지 않음. 실제 호출 0회. v2는 local command mock 도구를 노출하지 않음. |
| ChatGPT 플러그인/OAuth 연결 | 미수행. 정상 사용자 Connect 필요. storage에 수락된 기존 서비스 인증이 MCP OAuth 수락을 증명하지 않음. |

공식 Sites 도구 이름 전체와 실제 입력 계약은 `tool-contracts.json`에 보존했다. Sites 스킬의 설치본은 0.1.75이고 `sites-building`, `sites-hosting`, `sites-mcp` 및 persistence/storage reference를 읽었다. 도구의 MCP 선언, source Worker RPC 구현, 원격 호출 성공을 별개로 판정했다. 공개 검색·추측 URL·추측 schema를 사용하지 않았다. `/metadata`, `/ingest`, 기존 `/mcp`는 정상 source open에서 확인했고, v2 MCP 주소는 `get_site(include_mcp_connection:true)`가 반환한 주소와 일치했다. v2 `/fixture`는 이번에 작성·게시한 고정 조회 계약이다.

무해한 payload는 정확히 한 종류 `{"probe":"issue-222","phase":"A","value":222}`다. UTF-8 compact JSON SHA256은 `41dc4aa8f1eee177712f07a26317117b9971f3239061a35420637e3ced89aaaf`. v2 fixed key는 `issue-222-independent-20261003`이며 사용자 prompt/result/identity/비밀을 저장하지 않았다. `createdAt=2026-10-02T23:38:53.750Z`가 두 독립 조회와 중복 쓰기 후 동일했다. 장시간·재시작 persistence를 별도로 재시험하거나 주장하지 않았다.

Runtime HTTP는 총 12회(v1 6, v2 6), ingest는 총 4회(v1 비저장 2, v2 2), D1 실제 신규 레코드는 1건이다. MCP initialize는 총 2회(v1 404, v2 401), initialized notification/tools-list/tool-call은 모두 0회다. Sites native 호출은 11회이며 source workflow의 Git 통신은 runtime HTTP 횟수에 넣지 않았다. 브라우저/TinyFish/로그인 자동화, 일정 생성·재활성화, #213 연결, Events 구독, 유료 모델 호출, 새 계정/API key, 운영 Bridge 변경, 기존 thread 작업은 모두 미수행이다. Codex 실제 fixture Job 생성 0회.

v1 source SHA는 `77dff7da2988c5ca2ceed4a2f913a62424741e6c`, v2는 `99a9f88391876416666b26c18b500039f77c5303`이다. 사용자 후속 답변이 **전용 Site 소스 commit/push**를 허용한 뒤 공식 `site-workflow.mjs`가 commit/push/packaging을 수행했다. native `save_version_and_deploy_private`를 사용했고 audience 변경 도구는 호출하지 않았다. source checkout은 clean이다. v2 deployment ID는 `appgdep_6ac0402a4d3881918caaf9ab124ebfb0`; 저장 version ID와 archive hash/상태/시각은 provider 원응답 evidence에 있다. migration을 다시 쓰거나 실패 archive를 재시도하지 않았다.

시험 인증은 정상 get_site가 제공한 **기존** bearer를 계약의 OAI-Sites-Authorization header로 사용했다. generate_siwc_bypass_token은 호출하지 않았으며 기존 token 생성·rotation이나 cookie/credentials 파일 조사는 없다. source credential은 정상 공식 도구로 제공받아 hidden stdin/session memory에서만 사용했다. identity-less 서비스 접근을 사용자 identity/connected-app consent/local 권한으로 해석하지 않았다.

privacy 한계: 초기 metadata 요약 tool 출력 1건에 provider의 임시 서명된 screenshot URL 필드가 포함됐다. 해당 URL은 이후 출력·evidence 파일에서 제외했고 재접근하지 않았다. Site bearer와 source credential 값은 출력·파일에 쓰지 않았다. 최종 task evidence는 실제 제공 token 값의 exact match와 서명 URL 패턴을 검사한다. 이 한계 때문에 전체 실행의 비민감 출력 규칙을 완전 충족했다고 주장하지 않는다.

정상 인증 경계에서 남은 한 가지 조치는 사용자가 **Sites가 생성한 private 플러그인 연결을 완료(Connect)**하는 것이다. 공식 안내 위치는 Plugins → Personal → Created by you이며 `get_site`가 반환한 plugin ID는 `plugin_asdk_app_sites_7f70e9571a3081918772e5e96d81268d`다. 설치/연결 UI를 열거나 자동화하지 않았다. 정상 연결 후 별도 문맥에서 initialize→tools/list→read_fixture를 검증할 수 있으며 이번 evidence에 그 성공을 기입하지 않는다.

evidence: `provider-observations.json`(v1/배포 시작), `post-deploy-observations.json`(v2 배포·MCP 선언·DB metadata), `v1-http.json`, `v2-http.json`(비민감 response body/status/시각/digest), `source/`(v1 및 v2 비민감 소스/migration snapshot), `tool-contracts.json`, `validation.json`, `file-digests.json`. HTTP request는 매번 새 요청이며 Connection:close/no-store를 지정했다. 원응답의 payload digest를 독립 계산값과 대조했다.

Bridge evidence branch는 `codex/issue-222-sites-independent-20261003`, worktree는 `/private/tmp/bridge-222-sites-independent-20261003`, base/target은 dev `a584d34`다. Bridge commit/push/merge/issue 수정은 0회. 상위 최종 검토·commit·dev 통합·branch/worktree 정리가 대기 중이므로 결과물을 보존한다. root dev는 clean이며 운영 source/DB/service/direct-wait 설정에 변화가 없다. Site private v2와 무해한 D1 레코드 1건, task-owned source checkout/archive를 유지한다. conversation 또는 과거 작업의 cleanup은 수행하지 않았다.
