# Issue Tracker

이 프로젝트의 이슈 트래커는 **외부 서비스(GitHub/Linear/Jira 등)가 아니라 로컬
파일 트리**다. `to-prd`, `to-issues`, `code-review` 등 "이슈 트래커에 발행/조회"하는
모든 스킬은 아래 규약을 유일한 진실 소스로 따른다. 외부 트래커 CLI(`gh` 등)나
MCP를 호출하지 말 것. 이 환경에는 없다.

## 트래커 구조 (필수)

저장소 루트 기준 아래 트리를 유지한다.

```
docs/tasks/
  current.md          # 지금 작업 중인 큰 태스크(작업)
  backlog.md          # 앞으로 해야 할 큰 태스크(작업)
  archive/
    YYYY-MM.md        # 완료된 큰 태스크 (완료 시점의 연-월)
docs/changes/
  YYYY-MM.md          # 작업하며 발생한, 큰 태스크가 아닌 사소한 변경 기록 (연-월)
```

- `YYYY-MM`은 항상 그 항목을 **기록/완료하는 시점의 연-월**이다(예: 2026년 7월 → `2026-07.md`).
- 필요한 파일/디렉터리가 없으면 아래 "파일 형식"대로 새로 생성한 뒤 추가한다.

## 각 파일의 역할

| 파일 | 담는 것 | 넣는 시점 |
|------|---------|-----------|
| `docs/tasks/backlog.md` | 앞으로 해야 할 큰 태스크 | `to-prd`/`to-issues`가 발행할 때 |
| `docs/tasks/current.md` | 지금 착수해 진행 중인 큰 태스크 | backlog에서 착수(implement 시작)할 때 이동 |
| `docs/tasks/archive/YYYY-MM.md` | 완료된 큰 태스크 | current의 태스크가 완료될 때 이동(완료 연-월 파일) |
| `docs/changes/YYYY-MM.md` | 큰 태스크가 아닌 사소한 변경(오타/문구/리팩터/설정 등) | 작업 중 발생할 때 그때그때 append |

- "큰 태스크(작업)"란 PRD 또는 tracer-bullet vertical slice 단위의 작업이다.
- "사소한 것"이란 별도 태스크로 트래킹할 가치가 없는 부수 변경이다.

## 발행 규칙 (강제)

1. `to-prd`와 `to-issues`가 발행하는 큰 태스크는 **항상 `docs/tasks/backlog.md`의
   `## Backlog` 섹션에 append-only**로 추가한다. 기존 항목을 삭제하거나 재정렬하지 않는다.
2. 각 태스크에는 안정적인 식별자 `T-<3자리>`를 부여한다(예: `T-001`). 다음 번호는
   `backlog.md`·`current.md`·`archive/*`를 통틀어 존재하는 가장 큰 번호 + 1이다.
3. 의존 순서(blocker 우선)대로 추가해 실제 식별자를 참조할 수 있게 한다.
4. 부모/차단 관계는 네이티브 기능이 없으므로 태스크 본문의 `## Parent`,
   `## Blocked by` 섹션에 `T-###` 식별자로 표기한다(fallback 방식).

## 상태 이동 규칙

- **착수**: `backlog.md`에서 해당 `T-###` 블록을 잘라내 `current.md`의 `## In progress`에
  붙이고 `**Status:** in-progress`로 바꾼다.
- **완료**: `current.md`에서 해당 블록을 잘라내 `docs/tasks/archive/<완료연-월>.md`의
  `## Done` 섹션에 붙이고 `**Status:** done`으로 바꾼다. 블록 자체는 지우지 않는다(감사 추적).
- 태스크 블록은 이동만 하고 내용을 삭제하지 않는다.

## Triage 라벨 어휘

라벨은 각 태스크 헤더 라인에 `[label]` 형태로 붙인다.

- `[ready-for-agent]` — AFK 에이전트가 바로 집어갈 수 있는, 완전히 명세된 작업.
  `to-prd`/`to-issues`가 발행하는 태스크의 기본 라벨.
- `[needs-triage]` — 아직 명세가 부족해 사람이 다듬어야 하는 작업.
- `[blocked]` — 다른 태스크가 끝나야 시작 가능한 작업.

별도 지시가 없으면 발행 태스크에는 `[ready-for-agent]`를 붙인다.

## 파일 형식

### `docs/tasks/backlog.md`

```markdown
# Backlog

앞으로 해야 할 큰 태스크. 스킬이 append-only로 관리한다.

## Backlog

### T-001 [ready-for-agent] 슬라이스 제목

**Status:** backlog

## Parent
(부모 태스크 식별자 또는 생략)

## What to build
...

## Acceptance criteria
- [ ] ...

## Blocked by
- None - can start immediately

---
```

- PRD는 단일 태스크로 `### T-### [ready-for-agent] PRD: <제목>` 형태로 추가하고,
  본문에 to-prd 템플릿(Problem Statement, Solution, User Stories, Implementation
  Decisions, Testing Decisions, Out of Scope, Further Notes)을 그대로 담는다.

### `docs/tasks/current.md`

```markdown
# Current

지금 작업 중인 큰 태스크.

## In progress

<!-- backlog에서 착수한 T-### 블록이 여기로 이동한다. -->
```

### `docs/tasks/archive/YYYY-MM.md`

```markdown
# Archive YYYY-MM

이 달에 완료된 큰 태스크.

## Done

<!-- current에서 완료된 T-### 블록이 여기로 이동한다. -->
```

### `docs/changes/YYYY-MM.md`

```markdown
# Changes YYYY-MM

이 달의 사소한 변경 기록(큰 태스크가 아닌 것).

- YYYY-MM-DD: 무엇을 왜 바꿨는지 한 줄 요약 (관련 T-### 있으면 참조)
```

## 조회 규칙

- "태스크를 fetch한다"는 것은 `backlog.md`/`current.md`/`archive/*`에서 해당 `T-###`
  블록을 읽는다는 뜻이다.
- 부모 태스크를 close/수정하지 않는다.
