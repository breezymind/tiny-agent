---
name: research
description: Investigate a question against high-trust primary sources and capture the findings in the project SQLite document store. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.
---

Spin up a **background agent** to do the research, so you keep working while it reads.

Its job:

1. Investigate the question against **primary sources** — official docs, source code, specs, first-party APIs — not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to one `architecture_documents` SQLite record with `doc_type=doc`, citing each claim's source in the body. Use the installed `scripts/issue-store.js put-architecture` CLI with `--root`.
3. Use a stable logical `source_path` such as `research/<slug>` and report that key so the findings can be retrieved with `get-architecture` or `search-architecture`.
4. Do not create or update a Markdown findings file.
