# Issue Tracker

이 프로젝트의 이슈 트래커는 외부 서비스가 아니라 로컬 파일 트리다.
to-prd·to-issues·코딩 에이전트는 아래 규약만 사용하고 외부 트래커 CLI나 MCP를
가정하지 않는다.

## 파일 트리

- `docs/tasks/backlog.md` — 앞으로 할 큰 태스크. append-only로 관리한다.
- `docs/tasks/current.md` — 지금 착수한 태스크(## In progress).
- `docs/tasks/archive/<YYYY-MM>.md` — 완료된 태스크(## Done). 월별 파일.
- `docs/changes/<YYYY-MM>.md` — 큰 태스크가 아닌 부수 변경 로그.

## 이슈 식별자

- 각 이슈는 `T-###`(0으로 채운 3자리 일련번호)로 식별한다. 번호는 backlog에
  발행되는 순서대로 단조 증가하며 재사용하지 않는다.
- 제목 줄 형식: `### T-### [triage-label] 제목`
- 각 이슈 블록 첫 줄에 `**Status:**`(backlog | in-progress | done)를 둔다.

## 상태 이동 규약

1. 착수: backlog.md `## Backlog`의 T-### 블록을 잘라내 current.md
   `## In progress`로 옮기고 Status를 in-progress로 바꾼다.
2. 완료: 수용 기준을 모두 만족하면 current.md의 블록을 잘라내
   archive/<YYYY-MM>.md `## Done`으로 옮기고 Status를 done으로 바꾼다.
   블록 내용은 지우지 말고 이동만 한다(감사 추적).
3. 사소한 변경: 큰 태스크가 아닌 변경은 changes/<YYYY-MM>.md에
   `- <YYYY-MM>-DD: 요약 (관련 T-### 있으면 참조)` 형태로 append한다.

## 부모·의존 관계

- 이 파일 트리는 네이티브 sub-issue/blocking edge를 지원하지 않는다.
- 부모 이슈는 블록 안 `## Parent` 섹션에 `- T-###`로, 선행 이슈는
  `## Blocked by` 섹션에 `- T-###`로 참조한다. 없으면
  `- None - can start immediately`.
