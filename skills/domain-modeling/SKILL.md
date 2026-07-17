---
name: domain-modeling
description: Build and sharpen a project's domain model. Use when the user wants to pin down domain terminology or a ubiquitous language, record an architectural decision, or when another skill needs to maintain the domain model.
---

# Domain Modeling

Actively build and sharpen the project's domain model as you design. Challenge terms, invent edge-case scenarios, and write the glossary and decisions to the project's SQLite document store as soon as they crystallise. Searching stored vocabulary alone is not this skill; this skill changes the model.

## SQLite document structure

Use the installed `scripts/issue-store.js` CLI. Project glossary and architecture records live in `docs/issues.sqlite` by default. Do not create, edit, or scan project Markdown files for them. Markdown syntax may be used inside a SQLite `body`, but a project `.md` file is never the storage target.

```text
architecture_documents
├── context/main       (doc_type=context)
├── context/ordering   (doc_type=context)
└── adr/0001-orders    (doc_type=adr)
```

Store the current glossary as one or more `doc_type=context` records with stable logical keys such as `context/main` or `context/ordering`. Store decisions as append-only `doc_type=adr` records with keys such as `adr/0001-orders`. These are record keys, not filesystem paths.

Create records lazily. Use `list-architecture`, `get-architecture`, and `search-architecture` to discover existing records. Use the typed CLI commands below to write records, and never edit the SQLite file directly.

### Document storage contract

All user-requested documents are SQLite records. Choose the storage command by record type:

- ADR / decision: `put-adr --source-path "adr/<n>-<slug>" --heading "..." --body "..."`
- Context / glossary: `put-context --source-path "context/<name>" --heading "..." --body "..."`
- Research / design / reference document: `put-document --source-path "doc/<slug>" --heading "..." --body "..."`
- PRD / implementation issue: the issue-store `create` or `get`/update flow, with the complete document in the SQLite issue `body`

When the user says to save, record, or update a document, do not create or modify `docs/adr/*.md`, `docs/*.md`, `docs/tasks/*.md`, `.agent/prd/*.md`, or another project Markdown artifact. A key such as `adr/0004-image-composition` is a logical SQLite `source_path`, not a filesystem path. Existing Markdown files are historical or skill-internal references only.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the stored glossary, call it out immediately. "The glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Update the SQLite glossary inline

When a term is resolved, fetch the relevant context record, update its complete body, and write it back with `put-context` immediately. Do not batch these updates. Use the content format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md). The command must include a stable `source_path`, `section_index`, `heading`, and the complete `body`.

Context records should be devoid of implementation details. Do not treat them as a spec, scratch pad, or repository for implementation decisions. They are glossaries and nothing else.

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. Otherwise use [ADR-FORMAT.md](./ADR-FORMAT.md), then append a new SQLite `doc_type=adr` record with `put-adr`; never modify an existing ADR record or create a Markdown ADR file.
