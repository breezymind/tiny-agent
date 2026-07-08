# tiny-agent

**[Pi 코딩 에이전트](https://github.com/earendil-works/pi-coding-agent) 기반의 커스텀 하네스(harness)입니다.**

Pi 코어를 그대로 두고, 그 위에 전역 에이전트 규칙 · 확장(extension) · 스킬(skill) · 자동 계획
워크플로우를 얹어 **계획 → 구현 → 테스트 → 리뷰**를 하나의 파이프라인으로 자동화하고,
그래프 기반 코드 탐색을 강제하는 독자적인 에이전트 하네스로 재구성한 것입니다.

즉, 범용 코딩 에이전트인 Pi를 다음과 같이 감싸(harness) 특정 작업 방식에 최적화합니다.

- **행동 계층** — `AGENT.md`로 모든 세션의 판단·보고·검증 규칙을 고정
- **오케스트레이션 계층** — `loop-agent` 확장이 한 턴의 입력을 다단계 계획·구현 루프로 승격
- **탐색 계층** — `graph-gate` · `auto-index` 확장이 CodeGraph 우선 탐색을 강제·준비
- **지식 계층** — `skills/`가 작업 유형별 전문 지침을 주입

이 저장소는 `~/.pi/agent` 디렉토리에 위치하며, Pi 실행 시 위 계층이 자동으로 로드됩니다.

## 반자동 파이프라인

이 하네스의 핵심은 `loop-agent` 확장이 구현하는 **반자동(semi-automatic) 워크플로**입니다.
계획은 사람과 함께 다듬고, 합의된 계획을 기계 판독 가능한 체크리스트로 고정한 뒤,
그다음부터 구현·검증만 확장이 자동으로 돌립니다. 사람이 판단할 지점과 기계가 반복할
지점을 명확히 나눈 것이 핵심입니다.

```
[사람과 함께] 계획 단계 (인터뷰 · 질의응답)
  grill-with-docs → to-prd → to-issues → grill-checklist
        │
        ▼  기계 판독 체크리스트 생성
────────────────────────────────────────────  ← 자동/수동 경계
        │
[확장이 자동] 실행 루프 (최대 maxImprovementRounds회 반복)
  implement → test → review
        │
        ▼  체크리스트 항목이 모두 통과할 때까지 실패 항목만 개선
      완료
```

- **계획 단계는 수동** — `grill-with-docs`가 사람과 질문·답변을 주고받으며 모호함을 없애고,
  ADR·용어집·PRD·이슈를 만든 뒤 `grill-checklist`로 검증 체크리스트를 확정합니다.
- **경계** — 체크리스트가 기계 판독 경계 안에 생성되면 자동 실행으로 넘어갑니다.
  일반 대화는 여기서 사용자의 구현 승인을 기다리고, `/goal`로 시작한 작업은 기본적으로 계획 파이프라인을 거치되 짧고 단일한 작업은 직접 실행 경로를 탈 수 있습니다(`/goal direct`로 명시 가능).
- **실행 루프는 자동** — 코드 에이전트가 `implement → test → review`를 수행하고,
  독립 검수 에이전트가 체크리스트로 결과를 판정합니다. 실패 항목이 남으면 그 항목만
  개선하며 `maxImprovementRounds`(기본 3)회까지 반복합니다.
- **복구 가능** — 루프 상태를 세션 브랜치에 스냅샷으로 남겨 reload/resume 시 같은 지점에서
  이어집니다.

각 단계에 서로 다른 모델을 배정할 수 있습니다(`settings.json`의 `loopAgent`):
계획·검증은 `claude-opus-4-8`, 코딩·테스트는 `claude-sonnet-5`처럼 단계별로 나눠 씁니다.

### 계획 단계 산출물이 유지보수에 주는 영향

계획 단계의 각 스킬은 대화만 진행하는 게 아니라 매번 파일·이슈트래커 산출물을 남깁니다.
이 산출물이 세션이 끊기거나 사람이 바뀌어도 "왜/무엇을/언제 끝났다고 판단하는지"를
재추론 없이 복원할 수 있게 해주는 것이 이 파이프라인의 실질적인 유지보수 효과입니다.

- **`grill-with-docs`** — 한 번에 하나씩 질문·답변을 주고받아 모호함을 없애는 동시에
  **ADR**과 **용어집**을 생성합니다. 결정의 이유가 대화 로그에만 남지 않고 `docs/`에
  파일로 남아, 이후 이 코드를 만지는 사람(또는 에이전트)이 결정을 다시 추론하지 않고
  ADR을 읽으면 됩니다. 용어집은 이후 PRD·이슈·코드에서 같은 단어를 같은 의미로 쓰도록
  강제합니다.
- **`to-prd`** — 인터뷰가 끝난 뒤 추가 질문 없이 대화 맥락만으로 PRD를 작성해
  `docs/tasks/backlog.md`에 발행합니다. 합의된 범위(Problem/Solution/User Stories/
  Implementation Decisions/Testing Decisions/Out of Scope)가 채팅 밖의 git으로
  추적되는 파일로 고정되어, 세션이 압축·종료돼도 범위가 증발하지 않고 diff로 리뷰할
  수 있는 산출물이 됩니다.
- **`to-issues`** — PRD를 계층별이 아니라 끝단까지 관통하는 tracer-bullet 수직 슬라이스로
  쪼개 `docs/tasks/backlog.md`에 발행합니다. 각 슬라이스는 독립적으로 데모·검증
  가능하고 의존관계(`Blocked by`)가 명시되어, 나중에 문제가 생겼을 때 어느 슬라이스가
  무엇을 바꿨는지 이슈 단위로 추적할 수 있습니다. 큰 PR 하나가 아니라 작고 완결된
  단위로 히스토리가 쌓여 롤백·bisect·리뷰 단위가 작아집니다.
- **`grill-checklist`** — 위 세 단계의 산출물(합의된 명세, ADR·용어집, PRD, 이슈)을
  "정상 동작한다" 같은 비측정 표현 없이 검증 가능한 체크리스트로 변환합니다. 이 체크리스트가
  이후 자동 `implement → test → review` 루프의 유일한 판정 기준이 되어, 루프가 반복되는
  동안 범위가 슬금슬금 넓어지거나 좁아지는 걸 막는 앵커 역할을 합니다. 독립 검수 에이전트가
  주관적 판단 대신 체크리스트 통과/실패로만 판정하므로, 나중에 "이 기능이 원래 뭘 하기로
  했었지?"를 체크리스트만 보고 재구성할 수 있습니다.

다만 이 구조는 코드를 짜기 전에 인터뷰·PRD·이슈 분해라는 오버헤드를 필요로 하고,
`docs/tasks/backlog.md`·ADR·용어집 같은 산출물이 최신 상태로 유지되지 않으면 낡은 문서가
오히려 혼란을 더할 수 있다는 대가가 있습니다.

## 구성 요소

### 에이전트 규칙 — `AGENT.md`

모든 세션에 적용되는 전역 행동 규칙입니다. 요청 분류(질문/명령/혼합형), 최소 변경 원칙,
그래프 우선 코드 탐색, 컨텍스트 관리, 검증, 중단·질문 조건 등을 정의합니다.
모든 보고는 한국어로 합니다.

### 확장 — `extensions/`

Pi에 기능을 더하는 TypeScript 확장입니다.

- **`loop-agent.ts`** — 위 "반자동 파이프라인"을 구현하는 확장입니다.
- **`graph-gate.ts`** — grep/read 같은 원시 검색보다 CodeGraph 도구를 먼저 쓰도록 강제하는
  그래프 우선 게이트입니다. 인덱스가 있을 때만 작동하며 `/graph-gate` 명령으로 모드를 바꿉니다.
- **`auto-index.ts`** — 신규 프로젝트를 자동으로 CodeGraph 인덱싱합니다.
  여러 세션이 동시에 인덱싱하지 않도록 lock 파일로 조율합니다.
- **`lib/graph-status.ts`** — 그래프 상태 조회 공통 로직 (게이트·인덱서 공유).

### 스킬 — `skills/`

파이프라인 각 단계(계획/구현/리뷰/테스트)에 특화된 지침 모음입니다. 주요 스킬:

| 분류 | 스킬 |
| --- | --- |
| 계획 | `grill-with-docs`, `grill-checklist`, `grilling`, `to-prd`, `to-issues`, `domain-modeling` |
| 구현 | `implement`, `tdd` |
| 리뷰 | `code-review` |
| 테스트 | `frontend-testing`, `e2e-tester` |

그 외 스택별·리서치용 스킬은 `skills/` 디렉토리를 참고하세요.

### 설정 파일

- **`settings.json`** — 기본 프로바이더/모델, `loopAgent` 단계별 모델(계획·코딩·검증·테스트) 설정

## 요구 사항

- [Pi 코딩 에이전트](https://github.com/earendil-works/pi-coding-agent)
- Node.js (확장 실행용)
- [CodeGraph](https://www.npmjs.com/package/@colbymchenry/codegraph) — 그래프 기반 코드 탐색
- LiteLLM 프로바이더 (`settings.json` 기본값)

## 설치

먼저 하네스가 얹힐 Pi 코어를 설치합니다.

```bash
npm install -g @earendil-works/pi-coding-agent
```

이후 용도에 따라 두 가지 방식 중 하나를 선택합니다.

### 방식 A — 확장·스킬만 추가 (`pi install`, 권장)

기존 Pi 환경에 tiny-agent의 **확장과 스킬만** 얹고 싶을 때 사용합니다.
Pi가 저장소를 받아 `extensions/`, `skills/` 디렉토리를 자동 발견해 등록합니다.

```bash
pi install git:github.com/breezymind/tiny-agent
pi install npm:@capyup/pi-basic-tools
```

- 전역이 아닌 특정 프로젝트에만 설치하려면 `-l`(`--local`)을 붙입니다.
- 설치·제거·목록은 `pi list`, `pi remove <source>`, `pi update`로 관리합니다.
- `npm:@capyup/pi-basic-tools`는 기본 편집·운영 보조 도구 묶음입니다.

> **참고:** `pi install`은 확장·스킬 **리소스만** 등록합니다.
> `AGENT.md`(전역 규칙), `settings.json`의 `loopAgent` 모델 구성, `mcp.json` 같은
> agent home 레벨 설정은 포함되지 않으므로, 반자동 파이프라인까지 그대로 쓰려면 방식 B를 사용합니다.

### 방식 B — agent home 전체 재현 (클론)

전역 규칙·파이프라인·모델 구성까지 이 하네스를 **그대로 복제**하려면
저장소를 Pi의 agent home 위치에 클론합니다.

```bash
git clone https://github.com/breezymind/tiny-agent.git ~/.pi/agent
cd ~/.pi/agent/npm && npm install   # 확장 실행에 필요한 npm 의존성
```

### 로컬 전용 파일 구성 (공통)

`.gitignore`로 제외된 민감·로컬 파일은 커밋되지 않으므로 직접 준비해야 합니다.

- **`auth.json`** — 프로바이더 인증 토큰
- **CodeGraph 설치** (그래프 탐색·게이트에 필요)

  ```bash
  npm install -g @colbymchenry/codegraph
  ```

- **`mcp.json`** — MCP 서버 설정. 로컬 절대경로가 포함되므로 환경에 맞게 작성합니다.

  ```json
  {
    "mcpServers": {
      "codegraph": {
        "command": "node",
        "args": ["<codegraph 설치 경로>/npm-shim.js", "serve", "--mcp"],
        "directTools": true
      }
    }
  }
  ```

### 편집 규칙

파일을 수정할 때는 `bash`로 직접 덮어쓰지 말고 `apply_patch`를 기본 도구로 사용합니다.
`bash`는 탐색, 검증, 빌드, 포맷팅 같은 실행 용도로만 씁니다.

### 실행

```bash
cd <작업할 프로젝트>
pi
```

Pi를 실행하면 확장과 스킬이 로드되고(방식 B는 `AGENT.md` 전역 규칙까지),
신규 프로젝트는 `auto-index`가 백그라운드에서 CodeGraph 인덱싱을 시작합니다.

## 보안

`.gitignore`가 다음을 커밋 대상에서 제외합니다.

- 자격증명·토큰: `auth.json`, `litellm-models.json`, `*.key`, `*.pem`, `.env*`
- 개인정보: `sessions/`(대화 기록), `mcp.json`(로컬 절대경로)
- 캐시·생성물: `mcp-cache.json`, `.auto-index/`, `.codegraph/`
- 의존성·바이너리: `node_modules/`, `bin/`
