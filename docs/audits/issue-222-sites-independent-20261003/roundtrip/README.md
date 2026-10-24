# #222 Sites 고정 fixture 실제 pull 왕복 — 2026-10-03

**actual PASS: 사용자 승인된 명시적 1회 pull 왕복**이다. 클라우드 D1에서 만든 고정 명령을 local이 claim하여 실제 loopback handler가 task-owned fixture를 1회 읽었고, 실제 cloud ACK 저장과 독립 조회를 확인했다. HTTP200 또는 코드 선언만으로 판정하지 않았다. cloud-initiated push/tunnel, 무인 실행·지속 polling 성공은 아니다.

상위 ChatGPT의 기존 v2 read_fixture 성공은 **parent-observed actual, user instruction으로 agent에 전달**된 증거다. 정확한 응답을 `parent-mcp-observation.json`에 저장했다. 설치/OAuth 연결은 user-confirmed actual이다. 이번 agent에 read_fixture MCP 도구가 직접 노출되지 않았으므로 그 상위 호출을 agent 직접 호출로 바꾸지 않았다. 사용자가 확인한 GPT 재개 완료 상태도 유지하며 재시험하지 않았다.

현재 설치된 공식 Sites 스킬 0.1.75의 hosting/MCP/storage 계약과 실제 25개 Sites 도구 입력 스키마를 확인했다. tunnel 이름의 callable 도구 0개, 설치본 tunnel 계약 없음, 정상 plugin-management의 Tunnel 검색은 plugins:[]였다. 이를 이 환경의 현재 노출 범위로만 판정한다. tunnel binding/endpoint/schema를 추측하거나 연결 승인을 건너뛰지 않았다. 이미 승인된 대안인 직접 HTTPS outbound/pull 경로를 선택했고 새로운 서비스·계정·OAuth 연결은 만들지 않았다.

## 방향·실행·수락 증거

물리적 네트워크 시작 방향은 모두 **Local → private Site HTTPS**다. Site backend가 enqueue 때 만든 명령이 claim 응답으로 **Site → Local 데이터**로 전달됐다. 로컬 runner는 이 원응답의 명령을 **Local runner → 127.0.0.1 loopback handler**에 보냈다. handler는 cloud 응답을 단순 echo하지 않고 고정 task-owned fixture 파일을 실제 읽었다. 그 응답이 **Local → Site ACK**로 저장된 뒤 독립 HTTP GET과 native D1 rows 도구로 대조됐다. 클라우드 Worker가 로컬 listener에 직접 접속한 사실은 없다.

단일 trial의 원응답·지역 handler 관측은 `actual-trial.json`이다. Site에 대한 HTTP 8회, loopback HTTP 1회, accepted claim 1회, 실제 localHandlerExecutions 1회, 최초 ACK 1회, duplicate ACK 1회다. enqueue 최초 1회와 duplicate 1회 모두 동일 command row 1건을 유지했다. 총 논리 왕복 1회, fake/mock 0회, polling loop 0회, schedule 0회다. 이 turn의 native Sites 호출은 11회, plugin search 1회이며 source Git 통신은 runtime HTTP 횟수에서 제외한다.

| 관측 | 실제 값 |
| --- | --- |
| cloud 생성 고정 command ID | issue-222-pull-roundtrip-20261003 |
| 허용 operation | read_fixture만; 임의 command/URL/shell/path/scope 없음 |
| command payload digest | e1f0757524bb4b7e568ab3378c8aaba461ac8b5254729f74a06bbc3f2ee6b820 |
| local response 및 저장 ACK digest | 647a4c380af69927a3b47155cb936dba7939f493bb5dac2a3f7eeefbca73cbf7 |
| 원 fixture digest | 41dc4aa8f1eee177712f07a26317117b9971f3239061a35420637e3ced89aaaf |
| cloud receipt 상태/건수 | acked / 1 |
| 원 fixture 유지 | 1건, createdAt=2026-10-02T23:38:53.750Z 동일 |
| local server 수명 | ready 2026-10-03T00:29:09.059Z → closed 2026-10-03T00:29:30.595Z; 프로세스 exit0 관측 |

server 측 createdAt/claimedAt/ackedAt은 Worker가 write 직전에 생성한 필드이며 정확한 D1 commit 시각이라고 주장하지 않는다. 요청 시작/완료 시각은 local runner의 UTC wall clock이다. 다른 clock 간 latency, GPT 모델·추론·사용량 연속성은 판정하지 않았고 Codex 카운터를 부모 모델·usage 근거로 사용하지 않았다.

실제로 수행한 중복 조건은 **enqueue 중복**과 **동일 ACK 중복**뿐이다. command count/생성 시각/digest가 유지됐고 ACK count/최초 ACK 시각/응답 digest가 유지됐다. local handler는 추가 실행되지 않았다. offline, duplicate claim, 재시작·30/60분·A→B, 자동 wake, 운영 Bridge 접근은 미시험이다. handler 종료는 정리 관측이며 cloud offline 테스트로 재분류하지 않는다.

## 기존 MCP 읽기 도구로 확인할 receipt

원래 read_fixture 이름·inputSchema·read-only annotations를 보존했고 기존 fixture 필드를 유지했다(localChannel:false는 direct tunnel binding 부재). workerVersion은 3으로 갱신했다. 추가 `roundtrip`은 SELECT-only 요약이다. 호출은 enqueue/claim/handler 실행/ACK를 유발하지 않는다. 새 도구 설치 없이 같은 private plugin의 read_fixture로 상위가 직접 대조할 수 있다.

```json
{
  "mode": "explicit-one-shot-pull",
  "status": "acked",
  "commandId": "issue-222-pull-roundtrip-20261003",
  "requestDigest": "e1f0757524bb4b7e568ab3378c8aaba461ac8b5254729f74a06bbc3f2ee6b820",
  "responseDigest": "647a4c380af69927a3b47155cb936dba7939f493bb5dac2a3f7eeefbca73cbf7",
  "executionCount": 1,
  "resultMatchesFixture": true,
  "cloudToLocalPush": false,
  "persistentPolling": false
}
```

executionCount은 cloud에 저장된 **local handler ACK 보고값**이며 그 basis 설명도 도구 응답에 반환한다. 실제 1회 실행은 별도의 loopback request/handler log/response hash가 뒷받침한다. 명령 digest는 command JSON digest이며 loopback HTTP envelope digest와 구분된다. summary에는 로컬 경로·credential·사용자 작업 원문을 넣지 않았다. 상위의 v3 MCP 재조회는 이번 turn에서 아직 관측되지 않았다; 기존 v2 MCP 성공과 v3 HTTP/native D1 독립 검증을 구분한다.

## source·배포·정리

동일 Site `appgprj_6abf89d2d04c8191a617d5193ef5471a`의 owner-only audience를 유지했다. 현재 owner/custom, allowed user1/editor0/external0/automations[]와 같은 plugin ID를 정상 도구로 재확인했다. private v3 deployment `appgdep_6ac04c20c7d8819189be9303b6a24a55` succeeded/has_mcp:true. source SHA `7755827919c042166cf5e2a7cfe3e0f5f76df577`, saved version ID `appgprj_6abf89d2d04c8191a617d5193ef5471a~appgver_2ad493d0916081919080d70be5bc126f`. 정상 source commit/non-force push/private publish만 수행했다.

기존 fixture table과 0000 migration/snapshot의 exact bytes는 보존했다. schema-only 새 0001 migration은 issue_222_roundtrips만 생성한다. native D1 rows의 has_more:false/truncated:false로 원 fixture 1건과 acked receipt 1건을 별도 조회했다. source snapshot/migration/계약/배포/native DB 원응답은 `source-v3/`, `current-contracts.json`, `provider-before-trial.json`, `provider-after-trial.json`에 있다.

기존 정상 get_site 서비스 bearer는 이 전용 Site HTTPS에만 썼고 local handler로 전달하지 않았다. source credential은 정상 도구·hidden stdin으로만 사용했다. cookie/credentials 파일 조사·token rotation·새 API key·인증 우회·public 전환은 없다. 이번 turn에 새 AUTH 거부가 발생하지 않았다. task evidence exact credential match/서명 URL 검사 및 원응답/DB/소스 일관성 검사를 `validation.json`과 `file-digests.json`에 보존한다. 이전 turn의 signed screenshot URL 출력 사건은 이전 감사에 남아 있으며 이번 성공으로 지우지 않는다.

loopback server 종료와 task-owned one-shot 프로세스 exit0을 확인했다. cloud에 owner-only v3, 원 fixture 1건 및 비민감 receipt 1건을 남겨 상위 재조회가 가능하다. 전용 source checkout은 clean, source/archive/evidence는 보존한다. Bridge production source/DB/global 설정/서비스/direct-wait는 변경하지 않았다. TinyFish/브라우저/UI/예약/#213/Events/임의 scope·권한 참조/범용 실행/유료 호출/GitHub 이슈 변경은 0회다.

Bridge branch/worktree는 기존 `codex/issue-222-sites-independent-20261003` / `/private/tmp/bridge-222-sites-independent-20261003`를 재사용했다. Bridge commit/push/merge·통합은 사용자 지시대로 미수행, 상위 최종 검토·dev 통합·task branch/worktree 정리가 대기 중이다. 운영 root dev는 clean이다. 기존 대화·thread 또는 다른 작업자 자산은 수정·정리하지 않았다.
