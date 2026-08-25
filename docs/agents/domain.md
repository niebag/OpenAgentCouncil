# Domain docs

How the engineering skills should use this repository's domain documentation when exploring the codebase.

## Read before exploring

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`**: read ADRs that affect the area you're about to work in.

If these files don't exist, proceed silently. Don't flag their absence or suggest creating them upfront. The `/domain-modeling` skill, reached through `/grill-with-docs` and `/improve-codebase-architecture`, creates them when terms or decisions are actually resolved.

## File structure

This repository uses a single-context layout:

```text
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

## Use the glossary's vocabulary

When output names a domain concept in an issue title, refactor proposal, hypothesis or test name, use the term defined in `CONTEXT.md`. Don't drift to synonyms that the glossary explicitly avoids.

If the concept isn't in the glossary, reconsider whether you're introducing language the project doesn't use. If it represents a real gap, note it for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface the conflict instead of silently overriding it:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
