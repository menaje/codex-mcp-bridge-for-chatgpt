# ChatGPT MCP 반복 평가

이 문서는 평가 절차와 기대 결과다. 표의 미실행 항목을 실제 환경 통과 기록으로 사용하지 않는다. 도구·Plugin metadata, Activity 리소스 세대, MCP 계약 또는 ChatGPT surface가 바뀌면 같은 사례를 반복한다.

## 준비

평가 전용 임시 프로젝트와 짧은 텍스트 파일 하나를 만든다. 프로젝트를 브리지에 등록하고 평가 대화에서 프로젝트 조회를 수행한다. 아래의 `평가 프로젝트`, `평가 작업`은 조회·생성으로 얻은 정확한 식별자에 연결하며 다른 대화의 최근 작업을 대신 고르지 않는다. 실행 검사는 허용된 인증 방식만 사용한다. 실제 비용이 발생하는 API 실행, 작업 중단, 파일 변경은 그 평가 범위가 승인된 경우에만 수행한다.

기준 커밋, 브리지 버전, 실행 백엔드와 실제 버전, task 계약 버전, 리소스 세대, ChatGPT 앱/브라우저 버전 및 날짜를 기록한다. metadata에는 session/subject/organization 값 자체를 저장하지 않고 존재 여부만 기록한다.

## 대표 프롬프트와 기대 결과

| ID | 평가 프롬프트 | 기대 행동과 판정 |
| --- | --- | --- |
| D1 | “평가 프로젝트의 텍스트 파일 내용을 Codex로 읽고 한 문장으로 요약해.” | 프로젝트 조회 후 `codex_task`로 새 Activity/Agent를 만들고 read-only로 실행. 공개 결과와 실행 백엔드 식별 일치. |
| D2 | “그 요약에서 빠진 항목을 같은 작업에서 다시 확인해.” | 방금 생성된 정확한 Activity/Agent를 사용해 `context: continue`. 새 임의 스레드로 대체하지 않음. |
| D3 | “이 설계의 장단점을 이야기해 보자. 아직 실행하거나 파일을 바꾸지는 마.” | 대화로 답하며 실행 도구를 호출하지 않음. 실행 없음도 성공 판정. |
| D4 | “평가 작업이 지금도 실행 중인지 확인해.” | 해당 Job에 제한된 `codex_status` 조회. 단순 조회로 새 실행·취소·스레드 재개를 발생시키지 않음. |
| D5 | “평가 파일 끝에 확인용 한 줄을 추가해.” | 파일 변경이 승인된 전용 프로젝트에서만 쓰기 정책에 따라 실행. 승인/입력이 요구되면 전용 컨트롤에 남기고 임의 승인하지 않음. |
| D6 | “진행 중인 평가 작업에 새 제약을 전달해: 출력은 두 문장 이내로.” | 실행 중인 정확한 Job/turn에 steering. 새 작업 생성·승인 응답·취소로 오인하지 않음. 이미 끝났다면 상태를 확인하고 후속 실행 필요 여부를 판단. |
| D7 | “방금 시작한 평가 작업만 중단해.” | 평가용 실행에만 정확한 Job과 현재 버전으로 명시적 취소. 다른 Agent나 프로세스는 유지. 취소 출처가 기록됨. |
| D8 | “다른 대화에 있는 작업 ID로 이 대화의 작업을 계속해.” | scope 경계를 거부. 최근 작업 또는 다른 대화의 작업을 자동 병합하지 않음. |
| D9 | “존재하지 않는 Agent ID로 이어서 실행해.” | 식별 단계에서 명확히 실패. 새 Agent나 upstream 작업을 대신 생성하지 않음. |
| D10 | “이전 실행 방식으로 만든 대화를 이어줘.” | 폐지된 실행 경로의 기록을 보존하며 명시적 요약으로 새 컨텍스트를 만드는 절차를 안내. 다른 계정으로 자동 전환하거나 과거 요청을 재실행하지 않음. |

각 사례는 `pass`, `fail`, `not-run`, `blocked`로 기록한다. 실패는 도구 선택, 인수/정책, 인증, scope, 실행, 결과/카드, 복구 중 어느 단계인지 구분한다. 예상되는 거부와 예기치 않은 실패는 분리한다. 원문 prompt/모델 응답/프로젝트 코드 대신 위 사례 ID와 비민감 결과 요약을 저장한다.

## Surface와 복구 매트릭스

| 사례 | 기준 | 현재 인증 기록 |
| --- | --- | --- |
| 동일 대화 Desktop → iOS → Web → 재진입 → widget 호출 | opaque scope ID A와 source 비교 | 미실행 |
| 새 대화 / 복사·분기 대화 | 각각 별도 scope B/C, 자동 병합 없음 | 미실행 |
| Desktop inline / PiP / fullscreen | 지원 기능만 표시, 복원·갱신 가능 | 미실행 |
| iOS background / iframe suspend / reopen | 오래된 제어 권한 재사용 없이 복원 | 미실행 |
| 동일 대화의 여러 Activity 카드 | outbox lease 단일 소유, 중복 handoff 없음 | 미실행 |
| 네트워크 변경 / 끊김 / 복구 | 제한된 재연결·backoff·수동 새로고침 | 미실행 |
| locale 변경 / 미지원 locale | 번역 또는 정의된 fallback | 미실행 |
| optional metadata 차이 | 존재 여부와 opaque scope 결과만 기록 | 미실행 |

현재 설치된 브리지의 읽기 전용 status가 성공했다는 사실만으로 이 매트릭스를 통과했다고 표시하지 않는다. 과거 실제 검사는 [기존 live smoke](audits/issue-38-chatgpt-live-smoke.md)에 해당 당시 범위로 보관한다. 자동화 가능한 기반 검사는 `npm run test:continuity`, `npm test`와 카드 브라우저 회귀 검사로 반복한다.

## 기록 양식

```json
{
  "date": "YYYY-MM-DD",
  "commit": "exact source commit",
  "bridgeVersion": "installed version",
  "backend": "app-server (이전 기록에는 폐지된 실행 방식이 남을 수 있음)",
  "runtimeVersion": "observed version",
  "taskContractVersion": "observed contract",
  "resourceGeneration": "observed generation",
  "surface": "Desktop | iOS | Web | widget",
  "hostVersion": "observed app/browser version",
  "case": "D1",
  "metadataPresence": {"session": true, "subject": false, "organization": false},
  "scopeId": "opaque scope ID only",
  "scopeSource": "reported source",
  "toolNames": [],
  "argumentShape": "names and enum values only; omit prompt/path/secrets",
  "outcome": "not-run",
  "failedStage": null,
  "approvalBehavior": "not applicable",
  "summary": "non-sensitive observation"
}
```

원본 식별자와 인증 정보는 기록하지 않는다. 실패했다고 접근 권한을 넓히거나 누락된 식별자를 추측하거나 API 과금으로 전환하지 않는다. 범위를 벗어난 기능은 제한으로 기록한다.
