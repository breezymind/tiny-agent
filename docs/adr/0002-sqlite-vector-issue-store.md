# Replace Markdown issue tracker with sqlite-vector issue store

- **Status:** Accepted
- **Date:** 2026-07-16

## Decision

We replace the Markdown issue tracker with a project-local SQLite database at `docs/issues.sqlite`. The database uses `better-sqlite3` for Node access and `@sqliteai/sqlite-vector` for vector operations while preserving `T-###` identifiers and the `backlog`/`current`/`done` status model.

Issues and PRDs are stored as searchable document rows in the same issue model. Each row keeps its source `body`, a 1024-dimensional Float32 `embedding BLOB`, and `embedding_status=missing|ready|failed`. Parent and blocker relationships are stored as database fields/relations. Existing `docs/tasks/*.md` files are accepted only as a one-time migration input; after `migrate`, SQLite and the `scripts/issue-store.js` JSON CLI are the source of truth.

Embeddings are generated locally by a Python `sentence-transformers` process using `BAAI/bge-m3`. Publishing an issue never depends on embedding success. `search` uses sqlite-vector `vector_full_scan` and filters to ready documents; `reembed-failed` retries failed and missing documents after the local model is available.

## Rationale

- SQLite is a durable, Git-trackable artifact that keeps issue metadata, document text, state, and relationships in one source of truth instead of allowing Markdown and automation to diverge.
- sqlite-vector provides the required local nearest-neighbor search without introducing a server or remote embedding API.
- A subprocess adapter keeps the Node CLI independent from Python model lifecycle and gives seam tests a deterministic fake embedding command.
- Saving source text before embedding failure preserves planning work and makes model installation/recovery operationally safe.

## Consequences

- `docs/issues.sqlite` is committed; only its `-wal` and `-shm` runtime files are ignored.
- `docs/tasks/*.md` remains useful for migration/audit history but must not receive new issue appends or state transitions.
- Developers and agents use `init`, `migrate`, `create`, `get`, `list`, `update-status`, `search`, and `reembed-failed` rather than direct SQL or Markdown edits.
- A working local Python environment is needed for ready embeddings, but issue creation and status changes remain usable when that environment is unavailable.
