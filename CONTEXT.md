# loop-agent

pi 코딩 에이전트의 반자동 계획→구현→검증 파이프라인 확장. 그릴 인터뷰로 계획을 확정하고, 자식 pi 프로세스로 구현·테스트·검수·문서 정합화를 실행한다.

## Language

**문서 정합화 (Doc Reconciliation)**:
검수 PASS 직후 한 번 실행되는 종료 단계로, 인터뷰 시점에 기록한 결정(PRD·ADR·용어집)을 최종 구현에 맞춰 최신화하는 작업.
_Avoid_: 문서 동기화, 문서 업데이트

**정합화 에이전트 (Reconciliation Agent)**:
문서 정합화를 수행하는 전용 자식 pi 프로세스. `edit/write`는 있으나 `bash`는 없으며 문서 파일만 수정한다.
_Avoid_: 문서 에이전트

**종료 단계 (Terminal Stage)**:
결과가 개선 루프를 재진입시키지 않고 워크플로를 끝내는 단계. 실패해도 워크플로를 FAIL로 되돌리지 않는다.
_Avoid_: 마무리 단계, 최종 단계

**Supersede**:
기존 ADR을 직접 수정하지 않고, 그 결정을 대체하는 새 ADR을 추가하며 원본에는 "superseded by ####" 한 줄만 붙이는 방식.
_Avoid_: ADR 덮어쓰기, ADR 수정

**sqlite-vector 이슈 저장소**:
기존 `docs/tasks/*.md` Markdown 이슈 트래커를 대체해 PRD·이슈·상태·부모/의존 관계와 검색용 임베딩을 SQLite 데이터베이스에 저장하는 로컬 이슈 저장소. 기본 DB 파일 경로는 `docs/issues.sqlite`다. 기존 `T-###` 식별자와 backlog/current/done 상태 모델은 유지한다. 기존 Markdown 이슈는 최초 실행 시 DB로 자동 마이그레이션하고, 이후 SQLite를 source of truth로 삼는다. 이슈 테이블은 안정적인 정수 rowid와 unique `issue_id`를 두며, PRD와 이슈 본문은 검색 대상 문서 행의 `embedding BLOB`로 저장한다. PRD는 별도 엔티티가 아니라 부모 PRD 이슈(`T-### ... (PRD)`)의 본문 문서로 저장한다. 이슈/PRD 원문 저장은 임베딩 생성 성공에 의존하지 않고, 임베딩은 `embedding_status=missing|ready|failed`로 추적한다. 벡터 검색에는 sqlite-vector 확장을 사용하며 ready 임베딩만 검색 대상으로 삼는다. 조작 인터페이스는 `scripts/issue-store.js` CLI(`init`, `migrate`, `create`, `update-status`, `get`, `list`, `search`, `reembed-failed`)로 제공한다. `search`는 sqlite-vector `vector_full_scan`에서 `embedding_status=ready` 문서만 반환하고, loop-agent 병렬 후보 선택은 CLI의 backlog/current 이슈 JSON을 사용한다. `docs/issues.sqlite`는 Git 추적 대상이고, WAL/SHM 임시 파일은 ignore한다.
_Avoid_: Markdown 이슈 트래커, 보조 인덱스, 새 이슈 번호 체계, PRD 전용 별도 엔티티, 임베딩 실패로 이슈 발행 실패, DB 직접 조작

**이슈 임베딩 모델**:
PRD·이슈 본문을 벡터화하기 위해 로컬 Python 프로세스에서 실행하는 `BAAI/bge-m3` 모델. sqlite-vector 이슈 저장소의 검색용 벡터를 생성한다.
_Avoid_: 임베딩 생성기 미정, 원격 임베딩 API
