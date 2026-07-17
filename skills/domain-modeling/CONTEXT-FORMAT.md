# SQLite Context Record Format

Store the following body in an `architecture_documents` record with `doc_type=context`. The record's `source_path` is a stable logical key such as `context/main`; it is not a filesystem path.

```text
# {Context Name}

{One or two sentence description of what this context is and why it exists.}

## Language

**Order**:
{A one or two sentence description of the term}
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request

**Customer**:
A person or organization that places orders.
_Avoid_: Client, buyer, account
```

## Rules

- **Be opinionated.** When multiple words exist for the same concept, pick the best one and list the others under `_Avoid_`.
- **Keep definitions tight.** One or two sentences max. Define what it IS, not what it does.
- **Only include terms specific to this project's context.** General programming concepts do not belong even if the project uses them extensively. Before adding a term, ask: is this a concept unique to this context, or a general programming concept? Only the former belongs.
- **Group terms under subheadings** when natural clusters emerge. If all terms belong to a single cohesive area, a flat list is fine.

## Single vs multi-context projects

**Single context (most projects):** One `context/main` SQLite document record.

**Multiple contexts:** Use one stable `context/<name>` record per context. If relationships need to be recorded, include them in the context record body.

```text
# Context Map

## Contexts

- Ordering (`context/ordering`) — receives and tracks customer orders
- Billing (`context/billing`) — generates invoices and processes payments
- Fulfillment (`context/fulfillment`) — manages warehouse picking and shipping

## Relationships

- **Ordering → Fulfillment**: Ordering emits `OrderPlaced` events; Fulfillment consumes them to start picking
- **Fulfillment → Billing**: Fulfillment emits `ShipmentDispatched` events; Billing consumes them to generate invoices
- **Ordering ↔ Billing**: Shared types for `CustomerId` and `Money`
```

The skill infers which structure applies:

- Use `list-architecture` or `search-architecture` to find context records.
- If only one context record exists, use it as the single context.
- If no context record exists, create `context/main` lazily when the first term is resolved.

When multiple context records exist, infer which one the current topic relates to. If unclear, ask.
