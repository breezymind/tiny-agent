# Architecture baseline and mandatory read gate

**Status:** accepted
**Date:** 2026-07-17

이 프로젝트의 구현 에이전트가 개별 태스크나 semantic search 결과만 보고 코드를 수정하면, 현재 아키텍처의 책임 경계와 source of truth를 놓칠 수 있다. 따라서 `CONTEXT.md`와 이 ADR을 현재 구현 기준으로 지정하고, 계획·직접 코딩·병렬 코딩·개선 단계의 에이전트가 코드를 수정하기 전에 직접 읽도록 한다.

## Architecture

- `extensions/loop-agent.ts`는 계획→구현→테스트→독립 검수→문서 정합화를 연결하는 오케스트레이터다. 자식 Pi 프로세스는 `LOOP_AGENT_CHILD=1`로 부모 확장의 재귀 실행을 막는다.
- 계획은 `grill-with-docs → to-prd → to-issues → grill-checklist` 순서로 진행한다. 체크리스트가 확정되면 구현과 검증은 별도 자식 프로세스가 수행한다.
- CodeGraph/knowledge graph는 코드의 정의·호출·영향 관계 탐색을 담당한다. 문서 벡터 검색을 코드 그래프의 대체 수단으로 사용하지 않는다.
- `scripts/issue-store.js`는 이슈·PRD의 유일한 조작 경계다. `docs/issues.sqlite`가 이슈 상태·관계·본문의 source of truth이며, `docs/tasks/*.md`는 최초 마이그레이션과 감사용 입력이다.
- sqlite-vector의 이슈 임베딩은 기존 계획·태스크를 찾기 위한 보조 검색이다. 계획의 근거는 현재 사용자 요구, 실제 코드, 직접 읽은 아키텍처 문서다.
- `CONTEXT.md`, `docs/*.md`, ADR의 문서 임베딩은 관련 아키텍처 문서를 찾기 위한 보조 수단이다. 검색 결과만으로 설계 결정을 확정하지 않는다.

## Source-of-truth rules

| 정보 | 기준 | 금지 |
| --- | --- | --- |
| 현재 아키텍처·용어 | `CONTEXT.md` + 최신 accepted ADR | 오래된 태스크 본문으로 덮어쓰기 |
| 결정의 역사 | `docs/adr/*.md` append-only | 기존 ADR 본문 직접 수정 |
| 이슈·PRD·상태·관계 | `docs/issues.sqlite`와 CLI | Markdown 직접 append·DB 직접 조작 |
| 코드 구조·호출 관계 | 실제 코드 + CodeGraph | 문서만 보고 구현 경계 추정 |
| 관련 문서 후보 | `CONTEXT.md`/`docs/*.md`/ADR vector search | 검색 결과를 확정 사실로 취급 |

## Mandatory read gate

계획 또는 코드 수정 에이전트는 작업을 시작하기 전에 다음을 `read` 도구로 직접 읽는다.

1. `CONTEXT.md`
2. `docs/adr/0003-architecture-baseline-and-read-gate.md`
3. 현재 작업과 관련된 `docs/adr/*.md`
4. 현재 작업과 관련된 `docs/*.md`
5. 이슈를 생성·상태 변경·조회해야 한다면 `docs/agents/issue-tracker.md`

읽은 뒤 작업 프롬프트에 다음을 짧게 기록한다.

- 적용되는 source of truth
- 변경하지 않아야 할 책임 경계
- 관련 ADR 또는 CONTEXT 규칙

문서 벡터 검색은 위 읽기 전에 실행할 수 있지만, 읽기를 대체하지 않는다. 문서 검색이나 임베딩이 실패해도 직접 읽기 경로가 존재하면 구현 기준은 유지된다. 반대로 필수 아키텍처 문서를 읽을 수 없으면 자동 코딩을 시작하지 않는다.

최종 목표 체크리스트에는 변경된 코드가 위 아키텍처의 책임 경계, source of truth, 불변조건을 지키는지 확인하는 항목을 항상 포함한다. 작업 크기와 무관하게 생략하지 않는다.

## Document reduction

새 이슈·PRD·상태 전이는 Markdown에 기록하지 않는다. 기존 `docs/tasks/*.md`는 `migrate`로 SQLite에 옮긴 뒤 새 source of truth로 사용하지 않는다. 원본을 제거하거나 축약하는 작업은 마이그레이션 성공과 감사 필요성을 확인한 뒤 별도 변경으로 수행한다.

이 ADR은 구현 현재 상태의 요약이지 모든 문서의 복사본이 아니다. 세부 절차는 각 원문 문서에 남기고, 아키텍처 결정이 바뀌면 새 ADR을 추가하며 `CONTEXT.md`를 현재 상태에 맞게 갱신한다.

## Consequences

- 에이전트 프롬프트에 문서 읽기 경계가 공통으로 주입되어 vibe coding 중 아키텍처 누락 가능성을 줄인다.
- ADR/CONTEXT는 SQLite 문서 인덱스에 section 단위로 임베딩되지만, 검색 실패가 직접 읽기 기준을 무효화하지 않는다.
- 문서가 중복 source of truth로 늘어나지 않도록 이슈 Markdown은 마이그레이션 입력·감사 자료로만 유지한다.
