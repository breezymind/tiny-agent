# SQLite Issue and Document Store

이 프로젝트의 런타임 source of truth는 `docs/issues.sqlite`다. 이슈·PRD·상태·관계·아키텍처 문서·변경 이력은 모두 agent 설치 위치의 `scripts/issue-store.js` CLI로 관리한다. 프로젝트 문서 파일을 직접 읽거나 수정하지 않는다.

## CLI

```sh
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PROJECT=/path/to/project

node "$AGENT_DIR/scripts/issue-store.js" init --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" create --title "새 이슈" --body "구현 내용" --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" get T-001 --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" list --status backlog --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" update-status T-001 current --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" update-status T-001 done --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" search "관련 이슈" --root "$PROJECT"
```

아키텍처 문서는 `put-architecture`, `get-architecture`, `list-architecture`, `delete-architecture`, `search-architecture`로 관리한다. 부수 변경은 `record-change --summary "요약" --issue T-001`로 `change_log`에 기록한다.

임베딩 실패 시에도 원문은 SQLite에 저장되며 `reembed-failed`로 재시도할 수 있다. SQLite를 직접 조작하지 않는다.
