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
모델이 캐시에 없으면 새 이슈·문서의 임베딩과 검색이 실패하므로 위 다운로드를 먼저 실행해야 합니다.
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

모든 업무 진입 시에는 위 파이프라인에 앞서 현재 목표를 SQLite issue-store와
SQLite 아키텍처 문서의 semantic search로 반드시 검색합니다(`--limit 8`). 검색 결과는 계획·직접 구현 프롬프트의
참고 문맥으로 주입되며, 검색 명령이나 임베딩 환경이 실패하면 파이프라인을 시작하지
않습니다. 관련 결과가 0건인 것은 정상적인 검색 결과로 허용합니다.

```text
인터뷰
  grill-with-docs → to-prd → to-issues → grill-checklist
                                      │
                              목표 체크리스트
                                      │
구현 → 테스트 ─ PASS → easy-goal 완료(독립 리뷰 생략)
           └ FAIL → planningModel 원인 분석 → 개선 구현 → 테스트 재실행

hard-goal: 구현 → 테스트 ─ FAIL → planningModel 원인 분석 → 개선 구현 → 테스트 재실행
                    └ PASS → 독립 리뷰 → 실패 항목 개선 반복
```

- `grill-with-docs`: 모호한 요구사항을 한 번에 하나씩 질문하고 ADR·용어집을 기록합니다.
- `to-prd`: 합의된 대화를 PRD로 정리해 이슈 저장소에 발행합니다.
- `to-issues`: PRD를 독립적인 수직 슬라이스 `T-###` 이슈로 분해합니다.
- `grill-checklist`: 구현과 검증에 사용할 측정 가능한 목표 체크리스트를 만듭니다.
- `easy-goal`은 테스트가 실패하면 planningModel이 실패 원인과 수정 방향을 분석한 뒤
  코드 에이전트를 다시 실행하고 테스트를 반복합니다. 최대 개선 횟수에 도달하면 실패로 종료합니다.
- `hard-goal`도 테스트가 실패하면 먼저 planningModel이 원인과 수정 방향을 분석합니다.
  테스트 통과 후에만 독립 검수를 진행하며, 최대 개선 횟수까지 반복합니다.

### 결정적 검증

테스트 단계의 PASS/FAIL은 모델의 자기보고가 아니라 `verification-runner`가 실제 명령을
직접 실행한 종료 코드와 타임아웃으로 결정합니다. 기본적으로 프로젝트의 `package.json`에
`scripts.test`가 있으면 `npm test`를 required 검증으로 실행하며, Cargo/Pytest/Go/Flutter
프로젝트도 감지합니다. required 명령이 하나도 없거나 실행 파일을 찾지 못하면 PASS가 아니라
UNVERIFIED/FAIL로 남습니다.

프로젝트별 명령을 명시해야 하면 다음처럼 JSON으로 지정할 수 있습니다.

```bash
PI_VERIFICATION_COMMANDS='[{"program":"npm","args":["run","check"],"timeoutMs":120000}]' \
  pi
```

모델은 실패 로그를 해석해 개선 방향을 제안할 수 있지만, 검증 결과 자체를 PASS로 바꿀
권한은 없습니다.

### loop-agent 역할별 persona

`~/.pi/agent/persona.json`에 역할별 `instructions`를 정의하면
loop-agent가 해당 모델을 실행할 때 persona를 프롬프트에 자동으로 주입합니다.

```json
{
  "planning": { "instructions": "요구사항을 계획과 위험으로 변환하라." },
  "coding": { "instructions": "최소 변경으로 구현하고 관련 검증을 실행하라." },
  "verifying": { "instructions": "근거를 포함해 체크리스트를 findings-first로 검수하라." },
  "test": { "instructions": "검증 결과와 체크리스트의 테스트 공백을 분석하라." }
}
```

역할 이름은 `planning`/`plan`/`architect`, `coding`/`implement`/`builder`,
`verifying`/`verify`/`review`/`reviewer`, `test`/`testing`/`tester`를 지원합니다.
`planningModel`, `codingModel`, `verifyingModel`, `testModel`은 각각 해당 역할의
모델을 선택합니다. 테스트 PASS/FAIL은 여전히 결정적 검증 러너가 판정하고,
`testModel`은 결과 설명을 보조합니다.

## SQL VectorDB 이슈 저장소

이슈 트래커의 source of truth는 프로젝트 로컬 `docs/issues.sqlite`입니다.
Node.js의 `better-sqlite3`로 SQLite를 열고 `@sqliteai/sqlite-vector` 확장을 로드해 PRD·이슈 본문을
1024차원 `embedding BLOB`로 저장합니다.

기존 `T-###` 식별자, `backlog/current/done` 상태, parent·blockedBy 관계를 유지합니다.
기존 Markdown 태스크 파일은 런타임 source of truth가 아니며, loop-agent는 이를 읽거나 생성·수정하지 않습니다.
새 이슈·PRD·상태·관계는 SQLite CLI만 사용합니다. `docs/issues.sqlite`가 없으면 loop-agent가 빈 SQLite 저장소를 초기화합니다.

임베딩 상태는 다음 중 하나입니다.

- `missing`: 아직 임베딩하지 않음
- `ready`: 벡터 검색 가능
- `failed`: 원문은 저장됐지만 임베딩에 실패함

`search`는 `ready` 행만 대상으로 sqlite-vector의 `vector_full_scan`을 사용합니다.
일반 이슈 발행은 임베딩 실패를 막지 않고 `failed`로 저장하며, 모델을 준비한 뒤 `reembed-failed`로 재시도할 수 있습니다.

## 아키텍처 문서 인덱스와 읽기 게이트

아키텍처 문서 section은 `architecture_documents` SQLite 테이블에 저장되고
`search-architecture`로 검색합니다. 원문을 직접 읽거나 Markdown 파일을 색인하는 런타임 경로는 없습니다.
문서 추가·수정·삭제는 typed `put-document`·`put-context`·`put-adr`, `get-architecture`, `delete-architecture` CLI로 수행합니다. `put-architecture`는 하위 호환용 generic 명령입니다.

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PROJECT=/path/to/project
node "$AGENT_DIR/scripts/issue-store.js" put-architecture \
  --source-path "adr/0004" --doc-type adr --section-index 0 \
  --heading "Decision" --body "SQLite is the source of truth." --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" put-adr \
  --source-path "adr/0005-image-composition" \
  --heading "Image composition" --body "Decision and rationale." --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" search-architecture "관련 아키텍처 규칙" --limit 8 --root "$PROJECT"
```

사용자가 문서·ADR·용어집·조사 결과·PRD를 저장하라고 하면 프로젝트 Markdown 파일을 만들지 않습니다. Markdown 문법은 SQLite `body` 안에서만 사용할 수 있으며, PRD·이슈는 issue-store의 `create`/`get` 흐름으로 저장합니다.

### SQLite 문서·변경 이력 관리

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PROJECT=/path/to/project
node "$AGENT_DIR/scripts/issue-store.js" init --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" list-architecture --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" list-changes --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" record-change --summary "변경 요약" --root "$PROJECT"
```

이제 SQLite가 이슈·아키텍처 문서·변경 이력의 유일한 런타임 저장소입니다.

### CLI

`--json`은 JSON 문자열을 인자로 받지 않고 stdin에서 읽습니다.

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PROJECT=/path/to/project

# 이슈 생성·조회·상태 변경
printf '%s\n' '{"title":"Example","body":"..."}' | node "$AGENT_DIR/scripts/issue-store.js" create --json --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" list --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" get T-001 --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" update-status T-001 current --root "$PROJECT"

# 벡터 검색과 임베딩 재시도
node "$AGENT_DIR/scripts/issue-store.js" search "관련 이슈" --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" search-architecture "관련 아키텍처" --root "$PROJECT"
node "$AGENT_DIR/scripts/issue-store.js" reembed-failed --root "$PROJECT"
```

에이전트와 스킬은 DB 스키마를 직접 조작하지 않고 agent 설치 위치의 `scripts/issue-store.js` CLI에 `--root`를 넘겨 사용합니다.
CLI는 기계 판독용 JSON을 stdout에, 임베딩·SQLite 읽기/쓰기 진행 로그를 stderr에 출력하므로 Pi 화면과 일반 터미널에서 과정을 확인할 수 있습니다.
`docs/issues.sqlite`는 Git 추적 대상이며 WAL/SHM 임시 파일은 무시합니다.
