# cellkit

A template for building systems as **cells** with Claude Code: each cell is a pure function over an append-only log, born by script, guarded by hooks, and run by its own agent session that you talk to by mail.

```
  cell : (State, Input) → (State′, Output)

          ┌──────────── THE WORLD ────────────┐
          └──── ENTRY ──────────────▲ EXIT ───┘
                adapters/           │ state/out/
                   ▼                │
          ┌─────────────────────────┴─────────┐
          │  log (append-only, hash-chained)   │
          │    └ fold → pictures (views)       │   ← pure, rebuilt any time
          └────────────────────────────────────┘
          cells contain cells — same shape at every scale
```

Extracted from **carnet**, where it runs a London food map. Nothing here is food-specific.

## What you get

| | What | Enforced by |
|---|---|---|
| **Log** | every input is an observation; every statement is a claim from one observation, by one voice; entries are hash-chained with gapless ids and never edited | `append` (only writer, `wx`), `lint` (chain, schemas, references) |
| **Pictures** | state = fold(log); views are disposable and never committed | `fold`, `.gitignore`, hooks |
| **Bedrock** | the docs the system rests on (`state/bedrock/`) change only by amendment; **only the operator approves** | Write/Edit hook, Bash hook, `lint` hashes |
| **Assumptions** | every guess is a hypothesis claim with a status (guess → some → evidence · refuted); `docs/assumptions.md` is generated | `assume` / `evidence` / `constraint` CLI; hook blocks hand edits |
| **Checks** | a model's verification is a claim *about a claim* — it adjusts belief, never counts as a voice | claim schema + `append` |
| **Cells** | `cell new` creates a cell with its own brief, hooks, binding, log and mailboxes; the parent logs the birth | `cell new` / `cell refresh` |
| **Mail** | you (or a root agent) send a cell instructions; the cell's Claude session picks them up, works, and its final answer comes back as the reply — no agent writes message files | Stop hook + `mail.ts` |
| **Session start** | every Claude Code session folds, then lints | SessionStart hook |

## Quick start

Needs **Node ≥ 24** (runs TypeScript directly, no build) and **Claude Code**.

```
git clone <this template> my-project && cd my-project
cd kernel && npm install && npm test && cd ..
node kernel/src/cli.ts init                      # state/ + starter ontology, registered as a draft
# edit templates → stage at state/bedrock/proposed/ontology.md → amend, then YOU approve:
! node kernel/src/cli.ts approve --doc ontology   # from your own Claude Code prompt
```

Then open Claude Code at the root. `AGENTS.md` is its brief; replace the placeholders with your project.

## A cell, and talking to it

```
node kernel/src/cli.ts cell new --name lisbon --binding lisbon.json     # {"scope": {"city": "Lisbon"}, …}
```

```
  cells/lisbon/
  ├── AGENTS.md · CLAUDE.md        the cell's brief (generated; `cell refresh` rewrites it)
  ├── .claude/settings.json        guard hooks + fold/lint at start + the mail Stop hook
  ├── binding.json                 the cell's domain: scope, registries, thresholds, vocabularies
  ├── adapters/                    ENTRY: the only code that brings the world in
  ├── state/log/ · state/out/      memory · EXIT
  └── inbox/ · outbox/             mail (not committed)
```

1. Open a terminal in `cells/lisbon`, run `claude`, say *"waiting for mail"*. Its turn ends, and the Stop hook starts listening (3 s polls, up to 30 min).
2. From the root:
   ```
   node kernel/src/mail.ts send --to lisbon --body "Run fold and lint; report the counts."   # or --file task.md
   node kernel/src/mail.ts watch --as root --wait 600                                       # run it in the background
   node kernel/src/mail.ts status --as lisbon
   ```
3. The hook hands the task to the cell's session as its next instruction. When the session ends its turn, its final answer lands in **root's** inbox as the reply. Unread = in the box; read = moved to `read/`; each box keeps a sent record in `outbox/read/`.
4. **Who may say what:** root → cell `task`; cell → root `reply` (by the hook) · `blocked` · `question` · `done`. Never cell → cell, and a cell can't give root tasks — no agent chatter.

**Boundary.** A session running in a cell writes only inside that cell (hook-enforced, `../` escapes caught). The kernel, root docs and other cells are read-only from there; a cell that needs a change says so.

**Hand approval.** When a rule refuses but the evidence says yes, a cell raises a review proposing **one exact claim** with its evidence: `node ../../kernel/src/cli.ts review raise --cell . --file r.json`. Root is mailed; `review list --all` shows open ones; **only the operator decides** (the decide command is hook-blocked for agents, like `approve`). Yes → the kernel appends the proposed claim in `voice:operator`, traced to the review and the decision; no → it can't be raised again on the same evidence.

**Reporting up.** `node kernel/src/cli.ts cell sync` records each cell's head and the numbers it publishes in `state/out/metrics.json`. Root's lint then checks that every head it ever recorded still exists in that cell's log, so a rewritten cell history is caught. Run it at session start.

## Your ontology

The kit ships the envelope and base claim kinds (`fact · opinion · same-as · part-of · relation · rule · hypothesis · check`). Your domain adds its own:

1. **Sketch first**, in cheap text: what flows in, what you claim about it, what leaves.
2. Write it into the ontology (amend → approve).
3. Add the kinds to `kernel/schemas/claim.schema.json` (enum + an `allOf` rule each).
4. Write tests first (fixtures as journeys), then a fold for your pictures; merge it into `fold()`.
5. Put domain values (thresholds, registries, vocabularies) in each cell's `binding.json`, not in code.

## Working method

- **Sketch → check → schema → code**, always against real data.
- **Every guess is logged as a guess** (`assume`), and moves only with evidence (`evidence`).
- **Decisions are logged** (`constraint`) so they aren't re-litigated.
- **Agents write content; scripts write structure.** If you find yourself hand-shaping a log entry, a message or an amendment, write a generator.

## Commands

```
node kernel/src/cli.ts init | fold | lint [--cell <dir>]
node kernel/src/cli.ts append --kind observation|claim --body <file|->
node kernel/src/cli.ts assume --id A1 --statement "…" [--test "…"] · evidence --id A1 --status some --note "…" · constraint --slug x --text "…"
node kernel/src/cli.ts amend --doc ontology --layer shape|kinds|rules|binding|meta --reason "…"   (after staging state/bedrock/proposed/)
! node kernel/src/cli.ts approve --doc ontology                                                    (operator only)
node kernel/src/cli.ts cell new --name <name> [--binding <file>] · cell refresh --name <name>
node kernel/src/mail.ts send --to <name> · watch [--as root] · status [--as <name>]
node kernel/src/cli.ts cell sync · review raise|list   (review decide: operator only)
```

## Limits (today)

- One writer per cell at a time. `append` re-reads the log; bulk adapters use `writer(cell)`.
- Log files are one JSON file per entry: fine to tens of thousands, then it needs a packed format.
- Mail isn't on the log yet (it's transient files; the log is the record).
- The Bash guard is a heuristic; `lint` (hash chain + bedrock hashes) is the backstop.
- A cell's Claude session also loads parent-folder CLAUDE.md files. Keep the root's CLAUDE.md a pointer.

## Roadmap

This is option **C — a template repo**: copy it and own it. Two packagings are planned:

- **A · Claude Code plugin.** The hooks, `/cell-new` and `/mail` commands, and a skill that teaches the method, installable into any repo. The rules only work because hooks enforce them, so the plugin is the natural home.
- **B · npm package** (`npx cellkit init`). The kernel as a library and CLI, for projects that wire their own hooks or run without Claude Code. The plugin (A) would carry it.

Until then, kit improvements are copied between projects by hand. Keep `kernel/` free of domain code so that stays easy.
