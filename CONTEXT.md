# loop-agent

pi 코딩 에이전트의 반자동 계획→구현→검증 파이프라인 확장. 그릴 인터뷰로 계획을 확정하고, 자식 pi 프로세스로 구현·테스트·검수·SQLite 문서 정합화를 실행한다. 구현 에이전트는 SQLite `architecture_documents`의 최신 context/ADR record를 검색해야 한다.

## Language

**문서 정합화 (Doc Reconciliation)**:
검수 PASS 직후 한 번 실행되는 종료 단계로, 인터뷰 시점에 SQLite에 기록한 결정(PRD·ADR·용어집)을 최종 구현에 맞춰 최신화하는 작업.
_Avoid_: 문서 동기화, 문서 업데이트

**정합화 에이전트 (Reconciliation Agent)**:
문서 정합화를 수행하는 전용 자식 pi 프로세스. issue-store CLI를 사용해 SQLite document record만 수정하며 project Markdown 파일은 건드리지 않는다.
_Avoid_: 문서 에이전트

**종료 단계 (Terminal Stage)**:
결과가 개선 루프를 재진입시키지 않고 워크플로를 끝내는 단계. 실패해도 워크플로를 FAIL로 되돌리지 않는다.
_Avoid_: 마무리 단계, 최종 단계

**Supersede**:
기존 ADR record를 직접 수정하지 않고, 그 결정을 대체하는 새 SQLite ADR record를 추가하는 방식.
_Avoid_: ADR 덮어쓰기, ADR 수정

**sqlite-vector 이슈 저장소**:
기존 Markdown 이슈 트래커를 대체해 PRD·이슈·상태·부모/의존 관계·아키텍처 문서·변경 이력과 검색용 임베딩을 SQLite 데이터베이스에 저장하는 로컬 저장소. 기본 DB 파일 경로는 `docs/issues.sqlite`다. 기존 `T-###` 식별자와 backlog/current/done 상태 모델은 유지한다. 이슈와 문서 원문은 SQLite를 source of truth로 삼으며, 런타임은 프로젝트 Markdown 파일을 생성·읽기·수정하지 않는다. 이슈 테이블은 안정적인 정수 rowid와 unique `issue_id`를 두며, PRD와 이슈 본문은 검색 대상 문서 행의 `embedding BLOB`로 저장한다. PRD는 별도 엔티티가 아니라 부모 PRD 이슈(`T-### ... (PRD)`)의 본문 문서로 저장한다. 이슈/PRD/아키텍처 원문 저장은 임베딩 생성 성공에 의존하지 않고, 임베딩은 `embedding_status=missing|ready|failed`로 추적한다. 벡터 검색에는 sqlite-vector 확장을 사용하며 ready 임베딩만 검색 대상으로 삼는다. 조작 인터페이스는 `scripts/issue-store.js` CLI(`init`, `create`, `update-status`, `get`, `list`, `search`, `put-document`, `put-context`, `put-adr`, `put-architecture`, `get-architecture`, `list-architecture`, `delete-architecture`, `search-architecture`, `record-change`, `list-changes`, `reembed-failed`)로 제공한다. `put-document`·`put-context`·`put-adr`는 각각 `doc`, `context`, `adr` 유형을 고정해 저장하며, `search`와 `search-architecture`는 ready 임베딩만 sqlite-vector `vector_full_scan` 대상으로 삼는다. `docs/issues.sqlite`는 Git 추적 대상이고, WAL/SHM 임시 파일은 ignore한다.
_Avoid_: Markdown 이슈 트래커, 보조 인덱스, 새 이슈 번호 체계, PRD 전용 별도 엔티티, 임베딩 실패로 이슈 발행 실패, DB 직접 조작

**이슈 임베딩 모델**:
PRD·이슈 본문을 벡터화하기 위해 로컬 Python 프로세스에서 실행하는 `BAAI/bge-m3` 모델. sqlite-vector 이슈 저장소의 검색용 벡터를 생성한다.
_Avoid_: 임베딩 생성기 미정, 원격 임베딩 API

**아키텍처 기준 ADR**:
현재 구현의 책임 경계, source of truth, 파이프라인 불변조건을 SQLite `architecture_documents`에 저장한 기준 문서 section이다. 문서 section은 `get-architecture`와 `search-architecture`로 읽는다.
_Avoid_: SQLite 문서 본문 대신 프로젝트 Markdown 원문을 런타임 기준으로 사용하기

**아키텍처 읽기 게이트**:
계획·직접 코딩·병렬 코딩·개선 에이전트가 SQLite `search-architecture` 결과를 검색하고 필요 section을 `get-architecture`로 읽어 적용할 source of truth와 책임 경계를 확인하는 공통 절차.
_Avoid_: 태스크 본문만 읽고 구현하기, SQLite 문서 검색 없이 구현하기

모든 목표 체크리스트에는 변경된 코드가 정의된 아키텍처의 책임 경계·source of truth·불변조건을 지키는지 확인하는 항목을 작업 크기와 무관하게 포함한다.

**문서 벡터 인덱스**:
아키텍처 문서 section을 `architecture_documents` SQLite 테이블에 저장해 관련 문서를 찾는 검색 경계. 문서 본문과 임베딩은 SQLite가 함께 보유하며, 문서 추가·수정·삭제는 issue-store CLI가 담당한다. `doc_type`은 `context`, `doc`, `adr`로 구분한다.
_Avoid_: SQLite 문서 저장소와 별도의 파일 source of truth 만들기, 프로젝트 Markdown 자동 생성·복사하기

**SQLite 문서 저장 계약**:
사용자가 문서·ADR·용어집·조사 결과·PRD를 저장하라고 하면 결과는 반드시 `docs/issues.sqlite`의 issue 또는 `architecture_documents` record여야 한다. 본문 안의 Markdown 문법은 허용하지만, 프로젝트의 `docs/*.md`, `docs/adr/*.md`, `docs/tasks/*.md`, `.agent/prd/*.md`를 결과 저장 파일로 생성·수정하지 않는다.
_Avoid_: 문서 종류와 무관한 Markdown 파일 fallback, `adr/<slug>`를 파일 경로로 해석하기
