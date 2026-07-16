# SQLite-vector Issue Tracker

이 프로젝트의 source of truth는 Git에 추적되는 `docs/issues.sqlite`다. Markdown 파일 트리는 외부 트래커가 아니며, 기존 저장소를 처음 전환할 때 `docs/tasks/*.md`를 `migrate`의 읽기 전용 입력으로만 사용한다. 마이그레이션 이후 새 이슈 발행·조회·검색·상태 전이는 반드시 agent 설치 위치의 `scripts/issue-store.js` CLI를 통해 수행하고 대상 프로젝트는 `--root`로 지정한다. `PI_CODING_AGENT_DIR`가 있으면 그 값을 agent 설치 위치로, 없으면 `~/.pi/agent`를 사용한다. SQLite를 직접 조작하거나 Markdown에 이슈를 append하지 않는다.

## 모델

- 식별자는 재사용하지 않는 `T-###`다.
- 상태는 `backlog`, `current`, `done`이다.
- triage label은 `ready-for-agent` 같은 `triage_label` 값으로 저장한다.
- 부모는 하나의 `parent_issue_id`, 선행 이슈는 `issue_blockers` 관계로 저장한다. CLI JSON에서는 `parent`와 `blockedBy`로 읽고 쓴다.
- 이슈와 PRD는 같은 행의 `title`·`body` 문서다. PRD는 별도 엔티티가 아니라 `(PRD)` 제목을 가진 부모 이슈의 본문으로 저장한다.
- `body`는 임베딩 실패와 관계없이 먼저 저장된다. `embedding_status`는 `missing`, `ready`, `failed` 중 하나이며, 실패 원인은 `embedding_error`에 남는다.
- 임베딩은 로컬 Python `sentence-transformers` 프로세스와 `BAAI/bge-m3`를 사용하고 1024차원 `embedding BLOB`로 저장한다. 실행 시 기본적으로 `~/.cache/huggingface`의 로컬 모델만 사용하며, 모델이 없으면 먼저 온라인으로 다운로드해야 한다. 자동 마이그레이션은 설치 폴더의 `.venv/bin/python`을 우선 사용하며, 다른 인터프리터는 `ISSUE_EMBEDDING_PYTHON`으로 지정할 수 있다. `search`는 `embedding_status=ready`인 문서만 sqlite-vector `vector_full_scan` 대상으로 삼는다.
- `docs/issues.sqlite-wal`과 `docs/issues.sqlite-shm`은 Git에서 제외하고, `docs/issues.sqlite` 자체는 추적한다.

자동 계획 파이프라인은 계획 프롬프트를 만들기 전에 현재 목표로 `search`와
`search-architecture`를 실행한다. `search`는 기존 이슈 참고 문맥이고,
`search-architecture`는 `CONTEXT.md`, `docs/*.md`, `docs/adr/**/*.md`의 관련 section 후보를 찾는 보조 수단이다.
계획·코딩 에이전트는 검색 결과와 무관하게 `CONTEXT.md`와 관련 ADR을 `read` 도구로 직접 읽는다.
이슈 검색 또는 임베딩이 실패하면 자동 파이프라인을 시작하지 않지만, 아키텍처 검색 실패는
직접 읽기 게이트가 있으므로 경고만 남기고 계속할 수 있다.
`docs/issues.sqlite`가 없으면 세션 시작과 직접 코딩 경로에서도 아키텍처 문서 색인을 먼저 자동 생성한다.

## 아키텍처 문서 색인

```sh
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PROJECT=/path/to/project
node "$AGENT_DIR/scripts/issue-store.js" index-architecture --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" search-architecture "source of truth와 책임 경계" --limit 8 --root "$PROJECT"
```

아키텍처 문서 원문은 `CONTEXT.md`, `docs/*.md`, `docs/adr/**/*.md`이며, SQLite 문서 인덱스는 검색용 복제본이다. `docs/*.md`는 `doc`, ADR은 `adr` 유형으로 저장한다.
원문과 인덱스가 다르면 원문을 기준으로 다시 색인한다.

## 최초 전환

```sh
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PROJECT=/path/to/project
node "$AGENT_DIR/scripts/issue-store.js" init --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" migrate --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" prune-migrated --yes --root "$PROJECT"
```

`migrate`는 `docs/tasks/backlog.md`, `docs/tasks/current.md`, `docs/tasks/archive/*.md`의 `T-###` 블록을 한 번씩 가져온다. 마이그레이션 전에 모든 신규 이슈의 임베딩을 검증하며, 하나라도 실패하면 SQLite 이슈를 쓰지 않고 실패한다. 성공한 경우 반복 실행해도 unique `issue_id` 때문에 중복되지 않으며, 상태와 Parent/Blocked by 관계를 보존한다. 이 명령 뒤 Markdown은 갱신하지 않는다. Pi를 시작할 때 `docs/issues.sqlite`가 없고 레거시 `T-###` 문서가 있으면 loop-agent가 자동으로 이 명령을 실행하며, 원본 Markdown은 유지한다.

`prune-migrated --yes`는 모든 `T-###`가 SQLite에 존재하는지 확인한 뒤에만 backlog/current/archive Markdown을 짧은 source-of-truth 안내문으로 축약한다. 확인에 실패하면 파일을 수정하지 않는다.

## CLI 계약

모든 명령은 stdout에 한 줄의 JSON 객체를 출력하고, 임베딩·SQLite 읽기/쓰기 진행 로그는 stderr에 출력한다. 오류도 `{ "ok": false, "error": "..." }` 형태로 출력하고 비정상 종료한다. 기본 DB는 `docs/issues.sqlite`이며 테스트·별도 작업은 `--db` 또는 `ISSUE_STORE_DB_PATH`로 바꿀 수 있다. 에이전트 지침에서는 프로젝트 루트의 `scripts/issue-store.js`를 기대하지 말고 agent 설치 위치의 CLI에 `--root`를 넘긴다. 임베딩 명령은 `ISSUE_EMBEDDING_COMMAND`로 fake 프로세스를 주입할 수 있다.

```sh
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PROJECT=/path/to/project

# 자동으로 다음 T-### 발급. body는 원문 문서다.
node "$AGENT_DIR/scripts/issue-store.js" create \
  --title "새 이슈" --label ready-for-agent --status backlog \
  --parent T-006 --blocked-by T-007 --body "구현 내용" --root "$PROJECT"

node "$AGENT_DIR/scripts/issue-store.js" get T-007 --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" list --status backlog --label ready-for-agent --parent T-006 --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" update-status T-007 current --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" update-status T-007 done --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" search "관련 이슈 문서" --limit 10 --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" reembed-failed --root "$PROJECT"
```

`create --json`는 stdin의 JSON payload(`title`, `body`, `label` 또는 `triage_label`, `status`, `parent`, `blockedBy`)도 받는다. `get`·`list` 결과는 본문, 관계, 임베딩 상태를 포함하고 `search` 결과는 이슈 메타데이터와 거리값을 함께 반환한다.

## 에이전트 규약

to-prd·to-issues는 Markdown 직접 append 대신 위 `create`를 사용한다. 코딩 에이전트가 태스크를 착수하거나 완료할 때는 파일 블록을 이동하지 말고 다음처럼 DB 상태만 전이한다.

```sh
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PROJECT=/path/to/project
node "$AGENT_DIR/scripts/issue-store.js" update-status T-### current --root "$PROJECT"
# 구현·검증 완료 후
node "$AGENT_DIR/scripts/issue-store.js" update-status T-### done --root "$PROJECT"
```

부수적인 문서·설정 변경만 `docs/changes/YYYY-MM.md`에 기록한다. 이슈 원문·관계·상태는 항상 CLI JSON과 SQLite를 기준으로 판단한다.
