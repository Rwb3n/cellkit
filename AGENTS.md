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
- **Cells** (README: "A cell, and talking to it"):
  - Create with `node kernel/src/cli.ts cell new --name <name> --binding <file>`, commit it, then `node kernel/src/cli.ts cell checkout --name <name>`: its own git worktree at `<repo>-cells/<name>`, branch `cell/<name>`.
  - Give it work by mail, **one task per mail**: `node kernel/src/mail.ts send --to <name> --body "…"`. Then run it **headless** (the default), in the background: `node kernel/src/cellrun.ts --cell <name>`. It refuses an empty queue or a task already in flight. Read the reply with `node kernel/src/mail.ts watch --as root --wait 600`.
  - Interactive fallback: the operator opens `claude` in `<repo>-cells/<name>/cells/<name>` and says "waiting for mail". Never both at once for one cell. A session opened anywhere else (the main checkout's copy, another cell's worktree) is refused: no writes, no mail.
  - Before verifying a reply: commit the cell's work on its branch, `git -C <worktree> merge main`, test there, and `node kernel/src/cli.ts cell audit --name <name>` (every change inside `cells/<name>/`). Then merge `cell/<name>` into main and commit the root-log entries the cell's mail wrote with it.
  - Worktrees on Windows can hold CRLF copies of LF files (`git ls-files --eol`); re-check them out if a hash or fixture differs in one worktree only.
- Secrets live in `.env` (git-ignored). Never print them.

## Plan

```
  1 ontology      ☐ sketch · ☐ first draft (init) · ☐ approved
  2 kernel        ✓ cellkit · ☐ your claim kinds + fold
  3 first cell    ☐ cell new · ☐ cell checkout · ☐ entry adapter · ☐ replay test against real data
  4 first exit    ☐ what leaves, to whom
```

## Open — waiting on the operator

- <decisions only the operator can make>
