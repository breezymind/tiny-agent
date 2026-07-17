# SQLite ADR Record Format

ADRs are append-only records in the project's `architecture_documents` SQLite table with `doc_type=adr`. Use sequential logical keys such as `adr/0001-slug`, `adr/0002-slug`; these are record keys, not Markdown paths.

Create a record lazily — only when the first ADR is needed. Use the typed `put-adr` CLI command and never modify the SQLite file directly.

## Template

Store this body in the record:

```text
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

That's it. An ADR can be a single paragraph. The value is in recording *that* a decision was made and *why* — not in filling out sections.

## Optional sections

Only include these when they add genuine value. Most ADRs won't need them.

- **Status** frontmatter (`proposed | accepted | deprecated | superseded by ADR-NNNN`) — useful when decisions are revisited
- **Considered Options** — only when the rejected alternatives are worth remembering
- **Consequences** — only when non-obvious downstream effects need to be called out

## Numbering

Use `list-architecture --doc-type adr` or the existing logical keys to find the highest number and increment by one. The `adr/<n>-<slug>` value is a logical SQLite key, not a path under `docs/adr/`.

## Storage command

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
node "$AGENT_DIR/scripts/issue-store.js" put-adr \
  --source-path "adr/0001-example" \
  --heading "Short title" \
  --body "# Short title\n\nDecision and rationale." \
  --root "$PROJECT"
```

Do not use `write`, `edit`, shell redirection, or `docs/adr/*.md` for a project ADR. The body can contain Markdown formatting; it is stored as text in SQLite.

## When to offer an ADR

All three of these must be true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If a decision is easy to reverse, skip it — you'll just reverse it. If it's not surprising, nobody will wonder why. If there was no real alternative, there's nothing to record beyond "we did the obvious thing."

### What qualifies

- **Architectural shape.** "We're using a monorepo." "The write model is event-sourced, the read model is projected into Postgres."
- **Integration patterns between contexts.** "Ordering and Billing communicate via domain events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth provider, deployment target. Not every library — just the ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Customer data is owned by the Customer context; other contexts reference it by ID only." The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** "We're using manual SQL instead of an ORM because X." Anything where a reasonable reader would assume the opposite. These stop the next engineer from "fixing" something that was deliberate.
- **Constraints not visible in the code.** "We can't use AWS because of compliance requirements." "Response times must be under 200ms because of the partner API contract."
- **Rejected alternatives when the rejection is non-obvious.** If you considered GraphQL and picked REST for subtle reasons, record it — otherwise someone will suggest GraphQL again in six months.
