# Backlog

앞으로 해야 할 큰 태스크. 스킬이 append-only로 관리한다.

## Backlog

<!-- to-prd/to-issues가 발행한 T-### 블록이 여기에 append된다. -->

### T-001 [ready-for-agent] loop-agent 검수 PASS 후 문서 정합화 단계 추가 (PRD)

**Status:** backlog

## Parent

- None - can start immediately

## Problem Statement

loop-agent 파이프라인은 그릴 인터뷰 앞단에서 세 가지 지속 산출물(backlog.md 이슈, ADR, 용어집 CONTEXT.md)을 만든다. 실행(구현) 단계에서는 주입된 `<task-tracking>` 지침 덕분에 backlog.md·current.md·archive는 계속 이동·갱신되지만, 구현이 인터뷰 시점 결정과 달라졌을 때 ADR이나 CONTEXT.md(용어집)를 갱신하라는 지침이 어디에도 없다. 그 결과 태스크 파일은 최신인데 ADR·용어집은 조용히 낡아, 코드를 짜기 전 인터뷰+PRD+이슈분해의 오버헤드가 오히려 낡은 문서로 혼란을 더하게 된다.

## Solution

검수(독립 read-only 검수)가 PASS로 끝나는 시점에 단 하나의 종료 단계 seam으로 "문서 정합화(doc-reconciliation)"를 붙인다. 이 단계는 `edit/write`를 가진 전용 자식 pi 프로세스를 한 번 실행해, 인터뷰 시점 결정(PRD·ADR·용어집)과 최종 구현의 차이를 반영한다. 용어집은 직접 최신화하고 ADR은 append-only supersede로만 갱신한다. 정합화는 종료 단계라 코드 개선 루프로 되돌아가지 않으며, 정합화 자체 실패는 워크플로를 죽이지 않고 경고만 남긴다.

## User Stories

1. loop-agent 사용자로서, 나는 구현이 끝난 뒤 용어집이 실제 코드 용어와 일치하기를 원한다, 그래야 낡은 용어집이 혼란을 주지 않는다.
2. loop-agent 사용자로서, 나는 구현이 인터뷰 시점 결정을 뒤엎었을 때 ADR이 그 사실을 반영하기를 원한다, 그래야 문서와 코드가 모순되지 않는다.
3. loop-agent 사용자로서, 나는 ADR의 결정 이력이 사후 덮어쓰기로 사라지지 않기를 원한다, 그래야 감사 추적이 유지된다(supersede 방식).
4. loop-agent 사용자로서, 나는 문서 정합화가 자동(/hard-goal)이든 수동(/loop-agent review)이든 검수 PASS되면 항상 실행되기를 원한다, 그래야 진입 경로와 무관하게 문서가 최신으로 유지된다.
5. loop-agent 사용자로서, 나는 문서 정합화가 방금 PASS된 코드를 다시 건드리지 않기를 원한다, 그래야 검증된 구현이 오염되지 않는다.
6. loop-agent 사용자로서, 나는 문서 정합화가 실패해도 워크플로 전체가 실패로 뒤집히지 않기를 원한다, 그래야 이미 성공한 구현이 문서 작업 때문에 헛되지 않는다.
7. loop-agent 사용자로서, 나는 정합화가 무엇을 왜 바꿨는지(또는 차이 없음) 세션에 기록되기를 원한다, 그래야 나중에 독립적으로 확인할 수 있다.
8. loop-agent 사용자로서, 나는 워크플로를 clear하거나 새 /hard-goal을 시작하면 진행 중이던 정합화 자식도 함께 회수되기를 원한다, 그래야 보이지 않는 부하가 남지 않는다.
9. loop-agent 사용자로서, 나는 취소·교체된 목표의 정합화 결과가 현재 세션 기록을 오염시키지 않기를 원한다, 그래야 상태가 일관된다.
10. loop-agent 사용자로서, 나는 정합화가 인터뷰에서 합의한 PRD·명세·기존 ADR/용어집 경로를 근거로 대조하기를 원한다, 그래야 무엇과 무엇을 맞추는지 명확하다.
11. loop-agent 사용자로서, 나는 정합화 단계가 다른 단계(코드·테스트·검수)와 동일한 진행 로그·상태줄로 표시되기를 원한다, 그래야 진행 상황을 일관되게 볼 수 있다.
12. loop-agent 사용자로서, 나는 정합화가 오래 걸리면 타임아웃으로 안전하게 종료되기를 원한다, 그래야 세션이 무한정 멈추지 않는다.

## Implementation Decisions

- **수정 모듈:** `extensions/loop-agent.ts` 단일 파일. 새 자식 프로세스 실행 함수(예: `runReconciliationAgent`)와 프롬프트 빌더(예: `buildReconciliationPrompt`)를 추가하고, `runExecutionReviewLoop`의 검수 PASS 분기(현재 `state.reviewStage = "reviewed"; ... return;`)에 정합화 호출을 삽입한다.
- **실행 주체:** 전용 정합화 자식 pi 프로세스(ADR-0001). 검수·테스트 자식과 동일하게 `runPiCommandWithProgress`를 통해 `--mode json --print --no-session --no-skills --no-prompt-templates --no-context-files`로 실행한다.
- **도구 권한:** `--tools read,edit,write,grep,find,ls` (bash 제외). 프롬프트로 "CONTEXT.md·docs/adr/**·필요 시 backlog의 T-### 블록만 수정하고 소스 코드는 절대 건드리지 말라"를 명시.
- **입력(근거):** 프롬프트에 확정 명세/목표 체크리스트(`state.checklist`)와 그릴링 종료 턴의 전체 텍스트(planningResponse에 PRD·명세 포함)를 넣고, 기존 ADR/용어집은 경로(CONTEXT.md, docs/adr/)를 명시하며 코드는 도구로 직접 탐색한다. 확장은 backlog의 특정 T-### 블록을 파싱하지 않는다.
- **ADR 갱신 정책:** append-only supersede. PRD/ADR 결정과 코드가 명백히 모순될 때만 새 ADR을 추가하고 원본에 "superseded by ####" 한 줄을 붙인다. 모호하면 수정하지 않고 보고만 한다. domain-modeling의 ADR-FORMAT/CONTEXT-FORMAT 규약을 따른다.
- **용어집 갱신 정책:** CONTEXT.md는 현재 상태 글로서리이므로 term 추가·갱신을 직접 허용한다.
- **트리거 지점:** 검수 결과 overall==PASS인 모든 경로(자동 /hard-goal, 수동 /loop-agent review)에서 실행. PASS 분기 한 곳에만 두어 불변식이 코드상 한 지점에서 성립하게 한다.
- **제어 흐름:** 종료 단계. 정합화 결과는 개선 루프를 재진입시키지 않는다. 자연어 보고만 받아 기록하며 기계 판독 블록을 강제하지 않는다(제어에 쓰지 않으므로).
- **상태 전이:** 정합화 진입 전 `reviewStage="reconciling"`로 전이하고 persist. 성공/실패 무관하게 마지막에 `reviewStage="reviewed"`, `autoMode=false`, `workflowId=null`로 종료. ReviewStage 타입에 `"reconciling"` 추가.
- **기록·표시:** `pi.appendEntry("loop-agent-doc-reconciliation", ...)` + `pi.sendMessage({customType:"loop-agent-doc-reconciliation", display:true, ...})` + persistWorkflowState. 다른 단계 관례와 동일.
- **타임아웃:** `RECONCILE_TIMEOUT_MS = 10 * 60 * 1000`(10분) 상수 추가.
- **실패 처리:** 정합화 실행 전체를 try/catch로 감싸 예외/타임아웃/비정상 종료 시 `ctx.ui.notify(..., "warning")`만 남기고 워크플로는 성공(reviewed)으로 귀결.
- **취소·교체 안전:** 자식은 `activeChildren`에 등록되어 clear/새 세션 시 `killActiveChildren()`으로 회수. 정합화 자식 await 뒤 `isCurrentWorkflow(workflowId)` 검사로 죽은 워크플로의 기록 오염 차단.

## Testing Decisions

- **좋은 테스트:** 구현 세부가 아니라 외부 관찰 가능한 동작만 검증한다. 자식 pi 프로세스를 실제로 spawn하지 않고, 순수 함수(프롬프트 빌더, 도구 인자 목록)와 상태 전이 로직을 최고 seam에서 검증한다.
- **테스트 대상 모듈:** `extensions/loop-agent.ts` — (a) `buildReconciliationPrompt`가 체크리스트·planningResponse·문서 경로·"소스 코드 금지" 경계를 포함하는지, (b) 정합화 자식 인자에 `edit,write`가 포함되고 `bash`가 없는지, (c) PASS 분기가 정합화를 거쳐 최종 `reviewed`로 귀결하는지, (d) 정합화 실패가 워크플로를 FAIL로 만들지 않는지, (e) 취소된 워크플로의 결과가 기록되지 않는지.
- **Prior art:** 기존 검수/테스트 자식 로직(`runIndependentReview`, `runTestAgent`, `runValidatedReview`)과 그 도구 인자 구성이 프로토타입이자 대칭 대상이다. 정합화 함수를 이들과 같은 형태로 만든다.

## Out of Scope

- 태스크 파일(backlog/current/archive) 이동 로직 변경. 기존 `<task-tracking>` 지침 그대로 둔다(C는 가벼운 점검만).
- 정합화 결과 기반의 코드 재개선(개선 루프 재진입). 종료 단계로 확정.
- 정합화 결과의 기계 판독 구조화 블록 강제.
- diff 기반 정합화(안정적 워크플로 시작 커밋 기준 부재).
- 인터뷰(그릴링) 단계 자체의 문서 생성 규칙 변경.

## Further Notes

- 관련 ADR: docs/adr/0001-dedicated-doc-reconciliation-agent.md
- 관련 용어집: CONTEXT.md (문서 정합화, 정합화 에이전트, 종료 단계, Supersede)
- 정합화 자식도 LOOP_AGENT_CHILD 가드 대상이라 재귀 실행되지 않는다.

### T-002 [ready-for-agent] 정합화 프롬프트 빌더 + 상수 추가

**Status:** backlog

## Parent

- T-001

## What to build

전용 정합화 자식에게 줄 프롬프트를 생성하는 순수 함수(예: `buildReconciliationPrompt`)와 타임아웃 상수 `RECONCILE_TIMEOUT_MS`(10분)를 `extensions/loop-agent.ts`에 추가한다. 프롬프트는 확정 명세/목표 체크리스트, 그릴링 종료 턴 전체 텍스트(PRD·명세 포함), 기존 ADR/용어집 경로(CONTEXT.md, docs/adr/)를 담고, "CONTEXT.md·docs/adr/**·필요 시 backlog의 T-### 블록만 수정하고 소스 코드는 절대 건드리지 말라", "ADR은 append-only supersede(PRD/ADR 결정과 코드가 명백히 모순될 때만, 모호하면 보고만), 용어집은 직접 최신화", "변경한 파일 목록과 각 문서 판단(갱신/supersede/차이없음)을 보고에 포함" 지침을 명시한다.

## Acceptance criteria

- [ ] `buildReconciliationPrompt`가 추가되고, 출력 문자열에 체크리스트·planningResponse(PRD·명세)·CONTEXT.md 경로·docs/adr 경로가 모두 들어간다.
- [ ] 프롬프트에 "소스 코드 건드리지 말라", "ADR append-only supersede", "용어집 직접 최신화", "변경 파일 목록 보고" 문구가 포함된다.
- [ ] `RECONCILE_TIMEOUT_MS`가 10*60*1000으로 정의된다.
- [ ] 순수 함수 단위 테스트가 위 내용을 검증한다.

## Blocked by

- None - can start immediately

### T-003 [ready-for-agent] 정합화 자식 실행 함수 (도구 경계 포함)

**Status:** backlog

## Parent

- T-001

## What to build

전용 정합화 자식 pi 프로세스를 실행하는 함수(예: `runReconciliationAgent`)를 `runIndependentReview`/`runTestAgent`와 같은 형태로 추가한다. `runPiCommandWithProgress`를 통해 `--mode json --print --no-session --no-skills --no-prompt-templates --no-context-files --tools read,edit,write,grep,find,ls`로 실행하며(bash 제외), T-002의 프롬프트 빌더와 RECONCILE_TIMEOUT_MS를 사용한다. 자식은 activeChildren에 등록되어 killActiveChildren 회수 대상이 된다(runPiCommandWithProgress 공통 경로).

## Acceptance criteria

- [ ] `runReconciliationAgent`가 추가되고 도구 인자에 `edit,write`가 포함되며 `bash`가 부재한다.
- [ ] `--no-session`과 `--no-skills`가 인자에 포함된다.
- [ ] 도구 인자 구성을 검증하는 단위 테스트가 있다(실제 spawn 없이 인자 배열 검증).
- [ ] LOOP_AGENT_CHILD 가드로 자식 재귀가 일어나지 않는다(기존 가드 그대로 적용).

## Blocked by

- T-002

### T-004 [ready-for-agent] 검수 PASS 분기에 정합화 단계 배선 (상태 전이·기록·실패처리)

**Status:** backlog

## Parent

- T-001

## What to build

`runExecutionReviewLoop`의 검수 overall==PASS 분기에서, 기존 종료 처리(reviewed로 귀결) 직전에 정합화 단계를 배선한다. 자동(/hard-goal)·수동(/loop-agent review) 무관하게 PASS되는 모든 경로가 이 분기를 지나므로 한 곳만 수정한다. 진입 전 reviewStage를 "reconciling"으로 전이하고(ReviewStage 타입에 추가) persist, 정합화 자식을 실행해 결과를 `loop-agent-doc-reconciliation` customType으로 appendEntry+sendMessage(display)한다. 전체를 try/catch로 감싸 예외/타임아웃 시 warning만 남기고, 성공/실패 무관 마지막에 reviewStage="reviewed", autoMode=false, workflowId=null로 귀결한다.

## Acceptance criteria

- [ ] PASS 분기가 종료 전 정합화를 호출하고 최종 상태는 reviewed로 귀결한다.
- [ ] ReviewStage 타입에 "reconciling"이 추가되고 진입 시 해당 단계로 persist된다.
- [ ] 정합화 결과가 loop-agent-doc-reconciliation으로 세션에 기록(appendEntry)되고 화면에 표시(sendMessage display:true)된다.
- [ ] 정합화 자식이 실패/타임아웃해도 워크플로는 FAIL로 전환되지 않고 warning만 남긴다(테스트로 검증).
- [ ] 수동 /loop-agent review 경로에서도 PASS 시 정합화가 실행된다.

## Blocked by

- T-003

### T-005 [ready-for-agent] 취소·교체 워크플로에서 정합화 기록 오염 차단

**Status:** backlog

## Parent

- T-001

## What to build

정합화 자식을 await한 뒤 `isCurrentWorkflow(workflowId)`를 검사해, 그 사이 사용자가 /loop-agent clear하거나 새 /hard-goal을 시작해 워크플로가 교체되었으면 정합화 결과의 appendEntry·sendMessage·persist를 수행하지 않고 조용히 반환한다. 다른 단계(runCodingAgent/runTestAgent/runValidatedReview 뒤)의 isCurrentWorkflow 가드와 대칭이다.

## Acceptance criteria

- [ ] 정합화 await 직후 isCurrentWorkflow가 false면 기록·상태 갱신 없이 반환한다.
- [ ] 해당 상황을 재현하는 테스트가 있다(워크플로 ID 교체 후 결과가 기록되지 않음).

## Blocked by

- T-004

### T-006 [ready-for-agent] sqlite-vector 이슈 저장소로 Markdown 이슈 트래커 대체 (PRD)

**Status:** backlog

## Parent

- None - can start immediately

## Problem Statement

현재 loop-agent의 to-prd/to-issues와 코딩 에이전트는 `docs/tasks/*.md` Markdown 파일 트리를 이슈 트래커의 source of truth로 사용한다. 사용자는 PRD·이슈·상태·부모/의존 관계를 로컬 SQLite 데이터베이스에 저장하고, sqlite-vector와 `BAAI/bge-m3` 임베딩을 사용해 이슈/PRD 본문을 검색 가능하게 만들고자 한다. 기존 Markdown 파일을 계속 source of truth로 두면 새 저장소와 자동 병렬 실행 후보 선택이 어긋난다.

## Solution

`docs/issues.sqlite`를 프로젝트 로컬 sqlite-vector 이슈 저장소로 도입하고 기존 Markdown 이슈 트래커를 대체한다. 기존 `T-###` 식별자와 backlog/current/done 상태 모델은 유지하고, 기존 `docs/tasks/*.md` 이슈는 최초 실행 시 자동 마이그레이션한다. 조작 인터페이스는 `scripts/issue-store.js` CLI로 제공하며, 임베딩은 로컬 Python `sentence-transformers` 프로세스가 `BAAI/bge-m3`로 생성한다. loop-agent의 태스크 조회와 병렬 후보 선택도 새 저장소 기반으로 전환한다.

## User Stories

1. loop-agent 사용자로서, 나는 PRD와 이슈가 `docs/issues.sqlite`에 저장되기를 원한다, 그래야 Markdown 파일 대신 SQLite가 단일 source of truth가 된다.
2. loop-agent 사용자로서, 나는 기존 `T-###` 번호가 유지되기를 원한다, 그래야 기존 워크플로와 참조가 깨지지 않는다.
3. loop-agent 사용자로서, 나는 backlog/current/done 상태 모델이 유지되기를 원한다, 그래야 기존 상태 이동 의미를 잃지 않는다.
4. loop-agent 사용자로서, 나는 기존 Markdown 이슈가 최초 실행 시 자동 마이그레이션되기를 원한다, 그래야 현재 backlog를 잃지 않는다.
5. loop-agent 사용자로서, 나는 PRD가 별도 엔티티가 아니라 부모 PRD 이슈 본문으로 저장되기를 원한다, 그래야 to-prd/to-issues의 기존 parent 관계가 단순하게 유지된다.
6. loop-agent 사용자로서, 나는 이슈와 PRD 본문을 벡터 검색할 수 있기를 원한다, 그래야 과거 계획과 관련 태스크를 빠르게 찾을 수 있다.
7. loop-agent 사용자로서, 나는 `BAAI/bge-m3`가 로컬 Python 프로세스로 실행되기를 원한다, 그래야 원격 API에 의존하지 않는다.
8. loop-agent 사용자로서, 나는 임베딩 생성이 실패해도 이슈 발행은 성공하기를 원한다, 그래야 모델 설치 문제가 계획 파이프라인을 멈추지 않는다.
9. loop-agent 사용자로서, 나는 실패한 임베딩을 나중에 재생성할 수 있기를 원한다, 그래야 환경을 고친 뒤 검색 품질을 복구할 수 있다.
10. loop-agent 사용자로서, 나는 to-prd/to-issues와 코딩 에이전트가 안정적인 CLI만 사용하기를 원한다, 그래야 DB 스키마 세부가 프롬프트에 새지 않는다.
11. loop-agent 사용자로서, 나는 `docs/issues.sqlite`가 Git에 추적되기를 원한다, 그래야 이슈 저장소가 프로젝트 산출물로 공유된다.
12. loop-agent 사용자로서, 나는 WAL/SHM 임시 파일이 Git에 들어가지 않기를 원한다, 그래야 SQLite 런타임 파일이 저장소를 오염시키지 않는다.
13. loop-agent 사용자로서, 나는 자동 병렬 코딩 후보 선택이 새 DB의 ready-for-agent와 blockedBy 정보를 읽기를 원한다, 그래야 to-issues가 DB에 발행한 작업을 자동 실행할 수 있다.

## Implementation Decisions

- `docs/issues.sqlite`를 기본 DB 파일로 사용하고 Git 추적 대상으로 둔다.
- `docs/issues.sqlite-wal`과 `docs/issues.sqlite-shm`은 `.gitignore`에 추가한다.
- Node/TypeScript 쪽 SQLite 접근은 `better-sqlite3`와 `@sqliteai/sqlite-vector`를 사용한다.
- sqlite-vector 확장은 `@sqliteai/sqlite-vector`의 Node 패키지가 제공하는 extension path를 통해 로드한다.
- 스키마는 안정적인 정수 rowid를 가진 이슈 테이블과 unique `issue_id`(`T-###`)를 둔다.
- PRD와 이슈 본문은 검색 대상 문서 행으로 저장하고 `embedding BLOB` 컬럼을 둔다.
- PRD는 별도 엔티티가 아니라 부모 PRD 이슈(`T-### ... (PRD)`)의 본문 문서로 저장한다.
- 임베딩 모델은 로컬 Python 프로세스의 `sentence-transformers` 기반 `BAAI/bge-m3`로 실행한다.
- 기본 벡터 차원은 1024로 고정한다.
- 원문 저장은 임베딩 성공에 의존하지 않고, 임베딩 상태는 `missing|ready|failed`로 추적한다.
- 검색은 `ready` 임베딩만 대상으로 한다.
- 조작 인터페이스는 `scripts/issue-store.js` CLI로 제공한다: `init`, `migrate`, `create`, `update-status`, `get`, `list`, `search`, `reembed-failed`.
- `docs/agents/issue-tracker.md`는 sqlite-vector 이슈 저장소와 CLI 규약으로 교체한다.
- loop-agent의 태스크 로딩과 병렬 후보 선택은 기존 `docs/tasks/*.md` 파싱 대신 DB/CLI 기반 데이터로 전환한다.

## Testing Decisions

- 최상위 CLI seam인 `scripts/issue-store.js`를 중심으로 `init`, `migrate`, `create`, `list`, `get`, `search`, `update-status`, `reembed-failed`의 외부 동작을 검증한다.
- loop-agent seam에서는 DB/CLI 결과를 받아 ready-for-agent와 blockedBy 조건으로 병렬 후보를 고르는 순수 로직을 검증한다.
- 실제 `BAAI/bge-m3`는 느리고 환경 의존적이므로 테스트에서는 1024차원 fake embedding 명령을 사용한다.
- sqlite-vector 검색은 ready 임베딩만 결과 후보가 되는지 검증한다.
- 임베딩 실패 시 이슈 원문이 저장되고 상태가 `failed`로 남는지 검증한다.

## Out of Scope

- `T-###`가 아닌 새 이슈 번호 체계 도입.
- PRD 전용 별도 엔티티 도입.
- 원격 Hugging Face Inference API 기본 사용.
- Markdown `docs/tasks/*.md`를 SQLite와 양방향 동기화하는 기능.
- sqlite-vector 외 다른 벡터 DB 도입.

## Further Notes

- 관련 ADR: `docs/adr/0002-sqlite-vector-issue-store.md`
- 관련 용어집: `CONTEXT.md`의 `sqlite-vector 이슈 저장소`, `이슈 임베딩 모델`







