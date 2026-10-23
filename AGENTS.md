# <your project>

<One paragraph: what this system is for, who it serves, what leaves it.>

Built on **cellkit** (see [`README.md`](README.md)): cells over an append-only log, governed mechanically.

## Bootstrap

Read in order:
1. [`state/bedrock/ontology.md`](state/bedrock/ontology.md) — what this system is made of (created by `node kernel/src/cli.ts init`)
2. [`docs/assumptions.md`](docs/assumptions.md) — every claim it rests on, with status. **Generated from the log; never edit by hand.**
3. [`docs/ROOT.md`](docs/ROOT.md) — root's role, routines and lessons (copy it from `templates/ROOT.md` at the start)
4. `cells/*/AGENTS.md` — each cell's brief

Start each session with `/session-open`, and end it with `/session-close`.

## Working rules

- **Sketch → check → schema → code**, always against real data. Cheap text first.
- **Every guess goes on the assumptions list, labelled as a guess:**
  `node kernel/src/cli.ts assume --voice claude --statement "…" --test "…"`  (takes the next free id; `--id A7` to choose)
  `node kernel/src/cli.ts evidence --id A1 --status some --note "…"`
  `node kernel/src/cli.ts constraint --slug x --text "…"`  (operator decisions)
- **Agents write content; scripts write structure.** Never hand-edit `state/log/`, `state/views/`, `state/bedrock/` or `docs/assumptions.md` (hook-blocked).
- **Bedrock changes need operator approval.** Stage at `state/bedrock/proposed/<doc>.md`, run `node kernel/src/cli.ts amend …`; the operator approves with `! node kernel/src/cli.ts approve --doc <doc>`.
- **Cells** (README: "A cell, and talking to it"):
  - Create with `node kernel/src/cli.ts cell new --name <name> --binding <file>`, commit it, then `node kernel/src/cli.ts cell checkout --name <name>`: its own locked git worktree, branch `cell/<name>`, outside the repo: `<repo>-cells/<name>`, or `<home>/<name>` with `guards.json` `"worktrees": { "home": "../.cells/<project>" }`. Never inside the main checkout (lint error).
  - Give it work by mail, **one task per mail**: `node kernel/src/mail.ts send --to <name> --body "…"`. Then run it **headless** (the default), in the background: `node kernel/src/cellrun.ts --cell <name>`. It refuses an empty queue, a task already in flight or a second run for the cell, and waits for room (at most 3 sessions at once, 4 GB free) before starting. Read the reply with `node kernel/src/mail.ts watch --as root --wait 600`.
  - Interactive fallback: the operator opens `claude` in `<worktree>/cells/<name>` and says "waiting for mail". Never both at once for one cell. A session opened anywhere else (the main checkout's copy, another cell's worktree) is refused: no writes, no mail.
  - Land a reply with `node kernel/src/cli.ts cell land --name <name> --message "…" --check "<tests>"`. It commits the cell's work on its branch, merges main in, audits it (every change inside `cells/<name>/`), runs the check on the merged result, merges it into main and commits root's log. It refuses, or undoes itself, if any step fails or the cell's tests got weaker (landing weaker tests is the operator's call).
  - A session that died mid-task: `node kernel/src/cellrun.ts --cell <name> --resume` (files the answer from the run log if it finished, else a fresh session finishes the task). To drop the task instead: `node kernel/src/mail.ts release --as <name>`, then resend.
  - Project configuration is bedrock, never `kernel/`: claim kinds in `state/bedrock/kinds.json`, guards and cell ownership (`cells.<x>.owns`) in `state/bedrock/guards.json`. Propose them like the ontology (stage/amend); only the operator approves. A cell's `binding.json` changes only by `cell rebind`.
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
