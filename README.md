# tiny-agent

Pi 코딩 에이전트 위에 `loop-agent` 확장과 스킬을 추가하는 커스텀 하네스입니다.
계획 인터뷰부터 구현·테스트·리뷰까지를 연결하고, PRD와 이슈를 SQL VectorDB에서 관리합니다.

## 설치

### Pi 패키지 설치

`tiny-agent`는 Pi 확장 여러 개와 스킬을 묶은 Pi 패키지입니다. 사용자 런타임 홈인
`~/.pi/agent`에 저장소를 직접 clone하지 말고 Pi 패키지 매니저로 설치합니다.

```bash
npm install -g @earendil-works/pi-coding-agent
pi install git:github.com/breezymind/tiny-agent
pi list
```

`pi install`은 패키지를 `~/.pi/agent/git/` 아래에 받고, 패키지 의존성을 설치하며,
전역 `~/.pi/agent/settings.json`에 패키지 소스를 등록합니다. `auth.json`, `settings.json`,
세션과 MCP 설정은 사용자 런타임 홈에 계속 남습니다.

### 로컬 개발

```bash
git clone https://github.com/breezymind/tiny-agent.git ~/Workspace/tiny-agent
cd ~/Workspace/tiny-agent
npm install
pi install ~/Workspace/tiny-agent
```

이미 저장소를 `~/.pi/agent`에 clone해 사용 중이라면, 먼저 작업 내용을 별도 저장소 위치로
옮긴 뒤 `pi install git:github.com/breezymind/tiny-agent`로 전환합니다.

필요한 로컬 설정:

- `auth.json`: 프로바이더 인증 정보
- `settings.json`: 모델과 `loopAgent` 단계별 설정
- CodeGraph MCP: 그래프 기반 코드 탐색에 필요

```bash
npm install -g @colbymchenry/codegraph
```

### 임베딩 모델

이슈·PRD 검색에는 로컬 Python `sentence-transformers`와 `BAAI/bge-m3`를 사용합니다.
Python이 uv로 관리되는 환경에서는 전역 `pip install` 대신 프로젝트 가상환경을 사용합니다.

```bash
uv venv .venv
uv pip install --python .venv/bin/python sentence-transformers
export ISSUE_EMBEDDING_MODEL=BAAI/bge-m3
export ISSUE_EMBEDDING_COMMAND=".venv/bin/python scripts/issue-embedding.py"

# 최초 한 번만: Hugging Face에서 로컬 캐시로 모델 다운로드
ISSUE_EMBEDDING_OFFLINE=0 .venv/bin/python -c \
  'from sentence_transformers import SentenceTransformer; SentenceTransformer("BAAI/bge-m3")'
```

실행 시 임베딩은 기본적으로 `~/.cache/huggingface`의 로컬 캐시만 사용하며 네트워크에 접속하지 않습니다.
모델이 캐시에 없으면 마이그레이션이 실패하므로 위 다운로드를 먼저 실행해야 합니다.
로컬 모델 디렉터리를 직접 지정하려면 `ISSUE_EMBEDDING_MODEL=/path/to/bge-m3`를 사용합니다.
온라인 다운로드를 다시 허용하려면 `ISSUE_EMBEDDING_OFFLINE=0`을 지정합니다.
Pi의 자동 마이그레이션은 `~/.pi/agent/.venv/bin/python`을 우선 사용합니다. 다른 Python을 써야 하면
`ISSUE_EMBEDDING_PYTHON`을 지정할 수 있습니다. Windows는 `.venv/bin/python` 대신
`.venv\\Scripts\\python.exe`를 지정합니다.

## `loop-agent` 확장

`extensions/loop-agent.ts`는 사람과 계획을 확정한 뒤 나머지 실행을 자동화합니다.
`graph-gate`와 `auto-index`는 CodeGraph 우선 탐색과 인덱싱을 담당하고, `skills/`는 각 단계의 지침을 제공합니다.

## 반자동 파이프라인

계획 단계는 사람과 함께 진행하고, 체크리스트가 확정된 뒤 실행 단계가 자동으로 시작됩니다.

```text
인터뷰
  grill-with-docs → to-prd → to-issues → grill-checklist
                                      │
                              목표 체크리스트
                                      │
구현 → 테스트 → 독립 리뷰 → 실패 항목 개선 반복
```

- `grill-with-docs`: 모호한 요구사항을 한 번에 하나씩 질문하고 ADR·용어집을 기록합니다.
- `to-prd`: 합의된 대화를 PRD로 정리해 이슈 저장소에 발행합니다.
- `to-issues`: PRD를 독립적인 수직 슬라이스 `T-###` 이슈로 분해합니다.
- `grill-checklist`: 구현과 검증에 사용할 측정 가능한 목표 체크리스트를 만듭니다.
- 구현 후 테스트와 독립 리뷰가 체크리스트를 검증하고, 실패한 항목만 개선합니다.

## SQL VectorDB 이슈 저장소

이슈 트래커의 source of truth는 프로젝트 로컬 `docs/issues.sqlite`입니다.
Node.js의 `better-sqlite3`로 SQLite를 열고 `@sqliteai/sqlite-vector` 확장을 로드해 PRD·이슈 본문을
1024차원 `embedding BLOB`로 저장합니다.

기존 `T-###` 식별자, `backlog/current/done` 상태, parent·blockedBy 관계를 유지합니다.
기존 `docs/tasks/*.md`는 최초 마이그레이션 입력으로만 사용하며, 이후 SQLite를 직접 사용합니다.
Pi를 기존 프로젝트에서 시작했을 때 `docs/issues.sqlite`가 없고 레거시 `T-###` 문서가 발견되면,
loop-agent가 마이그레이션 여부를 물어봅니다. 승인하면 자동으로 DB를 만들고 Markdown 이슈를 옮기며,
거절해도 원본 문서는 보존됩니다.

임베딩 상태는 다음 중 하나입니다.

- `missing`: 아직 임베딩하지 않음
- `ready`: 벡터 검색 가능
- `failed`: 원문은 저장됐지만 임베딩에 실패함

`search`는 `ready` 행만 대상으로 sqlite-vector의 `vector_full_scan`을 사용합니다.
일반 이슈 발행은 임베딩 실패를 막지 않고 `failed`로 저장하지만, Markdown `migrate`는 하나라도 임베딩에 실패하면 SQLite 이슈를 쓰지 않고 실패합니다. 모델을 준비한 뒤 다시 실행해야 하며, 이미 저장된 이슈는 `reembed-failed`로 재시도할 수 있습니다.

### 기존 프로젝트 마이그레이션

기존 프로젝트 루트에서 실행하면 `docs/tasks/backlog.md`, `current.md`, `archive/*.md`를 읽어
`docs/issues.sqlite`로 옮깁니다. `--root`를 사용하면 CLI를 다른 위치에서 실행할 수도 있습니다.

```bash
PROJECT=/path/to/existing-project
node ~/.pi/agent/scripts/issue-store.js init --root "$PROJECT"
node ~/.pi/agent/scripts/issue-store.js migrate --root "$PROJECT"
node ~/.pi/agent/scripts/issue-store.js list --root "$PROJECT"
```

이 명령은 기존 `T-###`, label, status, body, Parent, Blocked by 관계를 보존합니다.
같은 명령을 다시 실행해도 이미 존재하는 이슈는 건너뛰므로 중복되지 않습니다.

### CLI

`--json`은 JSON 문자열을 인자로 받지 않고 stdin에서 읽습니다.

```bash
# 이슈 생성·조회·상태 변경
printf '%s\n' '{"title":"Example","body":"..."}' | node scripts/issue-store.js create --json
node scripts/issue-store.js list
node scripts/issue-store.js get T-001
node scripts/issue-store.js update-status T-001 current

# 벡터 검색과 임베딩 재시도
node scripts/issue-store.js search "관련 이슈"
node scripts/issue-store.js reembed-failed
```

에이전트와 스킬은 DB 스키마를 직접 조작하지 않고 `scripts/issue-store.js` CLI를 사용합니다.
CLI는 기계 판독용 JSON을 stdout에, 임베딩·SQLite 읽기/쓰기 진행 로그를 stderr에 출력하므로 Pi 화면과 일반 터미널에서 과정을 확인할 수 있습니다.
`docs/issues.sqlite`는 Git 추적 대상이며 WAL/SHM 임시 파일은 무시합니다.
