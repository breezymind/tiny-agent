# SQLite-vector Issue Tracker

이 프로젝트의 source of truth는 Git에 추적되는 `docs/issues.sqlite`다. Markdown 파일 트리는 기존 이슈의 최초 `migrate` 입력으로만 사용하며, 이후 이슈 발행·조회·검색·상태 전이는 agent 설치 위치의 `scripts/issue-store.js` CLI를 통해 수행하고 대상 프로젝트는 `--root`로 지정한다. `PI_CODING_AGENT_DIR`가 있으면 그 값을 agent 설치 위치로, 없으면 `~/.pi/agent`를 사용한다. Markdown에 이슈를 직접 append하거나 SQLite를 직접 조작하지 않는다.

- 식별자는 `T-###`, 상태는 `backlog|current|done`이다.
- triage label은 `triage_label`, 부모는 `parent_issue_id`, 선행 이슈는 `blockedBy` 관계로 저장한다.
- PRD는 별도 엔티티가 아니라 `(PRD)` 부모 이슈의 `body` 문서다.
- `body`는 임베딩 실패와 관계없이 저장되며 `embedding_status`는 `missing|ready|failed`다.
- 로컬 Python `sentence-transformers`의 `BAAI/bge-m3`가 1024차원 `embedding BLOB`를 생성한다. 실행 시 기본적으로 `~/.cache/huggingface`의 로컬 모델만 사용하며, 모델이 없으면 먼저 온라인으로 다운로드해야 한다. 자동 마이그레이션은 설치 폴더의 `.venv/bin/python`을 우선 사용하며, 다른 인터프리터는 `ISSUE_EMBEDDING_PYTHON`으로 지정할 수 있다. `search`는 ready 문서만 검색한다.

최초 전환:

```sh
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PROJECT=/path/to/project
node "$AGENT_DIR/scripts/issue-store.js" init --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" migrate --root "$PROJECT"
```

`migrate`는 모든 신규 이슈의 임베딩을 먼저 검증하며, 하나라도 실패하면 SQLite 이슈를 쓰지 않고 실패한다. 성공한 경우에만 상태와 관계를 보존해 저장한다. Pi를 시작할 때 `docs/issues.sqlite`가 없고 레거시 `T-###` 문서가 있으면 loop-agent가 마이그레이션 여부를 묻고, 승인한 경우에만 이 명령을 자동 실행한다. 거절해도 원본 Markdown은 유지된다.

CLI는 기계 판독용 한 줄 JSON을 stdout에, 임베딩·SQLite 읽기/쓰기 진행 로그를 stderr에 출력한다. 기본 DB는 `docs/issues.sqlite`이며 `--db`/`ISSUE_STORE_DB_PATH`로 바꿀 수 있다. 에이전트 지침에서는 프로젝트 루트의 `scripts/issue-store.js`를 기대하지 말고 agent 설치 위치의 CLI에 `--root`를 넘긴다. 테스트 fake 임베딩은 `ISSUE_EMBEDDING_COMMAND`로 주입한다.

```sh
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PROJECT=/path/to/project
node "$AGENT_DIR/scripts/issue-store.js" create --title "새 이슈" --label ready-for-agent --body "구현 내용" --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" update-status T-001 current --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" get T-001 --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" list --status backlog --label ready-for-agent --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" search "관련 문서" --limit 10 --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" reembed-failed --root "$PROJECT"
```

`create --json`는 stdin JSON(`title`, `body`, `label`/`triage_label`, `status`, `parent`, `blockedBy`)을 받는다. `docs/issues.sqlite-wal`과 `docs/issues.sqlite-shm`은 Git에서 제외하고 DB 본체는 추적한다.
