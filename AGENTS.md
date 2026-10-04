# <your project>

<One paragraph: what this system is for, who it serves, what leaves it.>

Built on **cellkit** (see [`README.md`](README.md)): cells over an append-only log, governed mechanically.

## Bootstrap

Read in order:
1. [`state/bedrock/ontology.md`](state/bedrock/ontology.md) — what this system is made of (created by `node kernel/src/cli.ts init`)
2. [`docs/assumptions.md`](docs/assumptions.md) — every claim it rests on, with status. **Generated from the log; never edit by hand.**
3. `cells/*/AGENTS.md` — each cell's brief

## Working rules

- **Sketch → check → schema → code**, always against real data. Cheap text first.
- **Every guess goes on the assumptions list, labelled as a guess:**
  `node kernel/src/cli.ts assume --id A1 --voice claude --statement "…" --test "…"`
  `node kernel/src/cli.ts evidence --id A1 --status some --note "…"`
  `node kernel/src/cli.ts constraint --slug x --text "…"`  (operator decisions)
- **Agents write content; scripts write structure.** Never hand-edit `state/log/`, `state/views/`, `state/bedrock/` or `docs/assumptions.md` (hook-blocked).
- **Bedrock changes need operator approval.** Stage at `state/bedrock/proposed/<doc>.md`, run `node kernel/src/cli.ts amend …`; the operator approves with `! node kernel/src/cli.ts approve --doc <doc>`.
- **Cells:** create with `node kernel/src/cli.ts cell new --name <name> --binding <file>`; talk to a running cell session with `node kernel/src/mail.ts send|recv|status --cell cells/<name>`.
- Secrets live in `.env` (git-ignored). Never print them.

## Plan

```
  1 ontology      ☐ sketch · ☐ first draft (init) · ☐ approved
  2 kernel        ✓ cellkit · ☐ your claim kinds + fold
  3 first cell    ☐ cell new · ☐ entry adapter · ☐ replay test against real data
  4 first exit    ☐ what leaves, to whom
```

## Open — waiting on the operator

- <decisions only the operator can make>
