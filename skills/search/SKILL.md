---
name: search
description: Search the project-local SQLite issue/PRD store from Pi agent chat. Use when the user types /search <query> to find related T-### issues or PRDs.
---

# Search SQLite Issues and PRDs

Use this skill when the user invokes `/search` in Pi agent chat.

## Responsibility boundary

- Search only the project-local sqlite-vector issue store at `docs/issues.sqlite`.
- Use the installed agent `scripts/issue-store.js search` CLI as the only search interface.
- Resolve the agent directory as `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}` and pass the target project root with `--root`.
- If the SQLite store is unavailable, report the CLI failure; do not use a file-based fallback.
- Do not query SQLite directly.
- Do not run architecture document search (`search-architecture`) from this skill.

## Argument handling

Treat the text after `/search` as raw arguments.

1. Parse an optional result limit from `--limit N` or `--limit=N`.
2. Remove the limit option from the raw arguments.
3. Treat the remaining text as the search query.
4. If no non-option query remains, respond exactly:

```text
검색어가 필요합니다. 예: /search 인터뷰
```

Default to `--limit 5` when the user does not provide a limit. Forward a user-provided `--limit N` to the CLI.

Examples:

```text
/search 인터뷰
/search 인터뷰 --limit 10
/search --limit=10 인터뷰
```

## Execution

Run the installed issue-store CLI with the parsed query and limit. If you are already in the target project root, use `PROJECT_ROOT="$PWD"`; otherwise set `PROJECT_ROOT` to the absolute target project path. Do not require the target project to contain `scripts/issue-store.js`.

```sh
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PROJECT_ROOT="$PWD"
node "$AGENT_DIR/scripts/issue-store.js" search "<query>" --limit <limit> --root "$PROJECT_ROOT"
```

The CLI prints one JSON object to stdout. Progress logs and errors are part of the existing CLI contract and may appear on stderr. Parse the stdout JSON for display.

If the CLI, embedding model, or SQLite store fails, do not try another search path. Respond in this form, using a short cause from the CLI error when available:

```text
검색을 실행할 수 없습니다: <짧은 원인>
```

## Output format

Render successful results as a concise human-readable list, not raw JSON.

If the CLI returns zero results, respond exactly:

```text
검색 결과가 없습니다.
```

For each result, include:

- `T-###` issue id
- title
- status
- label
- distance
- a short body excerpt

Use this shape:

```markdown
검색 결과 (<count>개):

1. T-### <title>
   - 상태: <status>
   - 라벨: <label or 없음>
   - distance: <distance>
   - 본문: <short excerpt>
```

Keep excerpts short enough for chat output, typically one or two lines. Do not mark issues as current or done and do not modify issue state while searching.
