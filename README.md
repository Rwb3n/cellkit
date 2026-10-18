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

Each guarantee names the mechanism that enforces it and the test that proves it (`kernel/test/`). A guarantee with no test is a hope; add the test before you rely on it.

| | What | Enforced by | Proven by |
|---|---|---|---|
| **Log** | every input is an observation; every statement is a claim from one observation, by one voice; entries are hash-chained with gapless ids and never edited; writers at once (root, a cell's hook, a long-running tool) queue on the log's lock and never fork the chain | `append` (only writer, `wx`, `state/log.lock`), `lint` (chain, schemas, references) | `core`: append chains · lint catches an edited entry · a claim must come from an earlier observation · `lock`: 8 processes at once · stale tails · a dead holder's lock |
| **Pictures** | state = fold(log); views are disposable and never committed; agreement counts **independent** voices (not the kit's, not a model's, not checks) | `fold`, `.gitignore`, hooks | `core`: fold counts independent voices |
| **Bedrock** | the docs the system rests on (`state/bedrock/`) change only by amendment; **only the operator approves** | Write/Edit hook, Bash hook, `lint` hashes | `core`: bedrock (3 tests) · `boundary`: shell guard |
| **Assumptions** | every guess is a hypothesis claim with a status (guess → some → evidence · refuted, or parked); `docs/assumptions.md` is generated; `assume` without `--id` takes the next free id under the log's lock | `assume` / `evidence` / `constraint` CLI; hook blocks hand edits | `core`: assumptions and constraints · `lock`: 8 processes assuming at once |
| **Checks** | a model's verification is a claim *about a claim*; it adjusts belief, never counts as a voice | claim schema + `append` | `core`: a check must be about an earlier, non-check claim |
| **Cells** | `cell new` creates a cell with its own brief, hooks, binding, log and mailboxes; the parent logs the birth | `cell new` / `cell refresh` | `core`: cell new · cell sync |
| **Mail** | you (or a root agent) send a cell instructions; the cell's Claude session picks them up, works, and its final answer comes back as the reply. A short "still running…" answer is held back and the session sent to finish (3 times at most). A task reaches the cell's log only when it is handed over. Bodies are logged whole, or only hashed (`guards.json` `mail.log`). No agent writes message files | Stop hook + `mail.ts` | `mail` (10 tests) |
| **Hand approval** | a cell proposes one exact claim against a rule; only the operator decides | `review`, Bash hook | `review` (4 tests) |
| **Worktrees** | each cell works in its own git worktree on branch `cell/<name>`, so its changes touch nothing else until root merges them; a session opened in the wrong checkout writes nothing and gets no mail | `cell checkout`, the three hooks, `cell audit` | `worktree`: checkout · wrong checkout (2) · audit · writes never fork a chain (2) |
| **Boundary** | a cell writes only in its folder and the paths it owns, from Write/Edit and from the shell | both hooks (`shell.ts`) | `boundary` (2 tests) · `worktree`: owns |
| **Headless cells** | root queues a task, then runs the cell's session without a terminal; it does the queued mail and exits. Runs are light (no MCP servers) and queue for room: one per cell, at most 3 sessions at once, 4 GB free. A session whose runner died holds the cell until it ends; a run that dies mid-task keeps the task and tells root, and `--resume` files the answer from the run log or has a fresh session finish it | `cellrun.ts`, `mail.ts release` | `worktree`: cellrun (3 tests) · admission: 8 runs, 2 slots |
| **Landing** | root's loop in one command: commit the cell's work, merge main in, audit, check that its tests didn't get weaker, run your check on the merged result, merge `--no-ff`, sync and commit root's log; otherwise undo and refuse. Only the operator lands weaker tests | `cell land`, `weaker.ts`, Bash hook | `worktree`: cell land (2 tests) · `weaker` (3 tests) |
| **Configuration** | your claim kinds, guards (operator-only commands, script-written paths) and the repo paths each cell owns, as bedrock JSON docs; nothing in `kernel/` to edit | amend → operator approves; checked against the log; read by the hooks, audit, land, lint | `core`: a .json doc · `boundary`: guards.json · `worktree`: kinds · owns |
| **Bindings** | a cell's domain is root's to set, and every change is on the cell's log | `cell rebind`, hooks, `lint` | `worktree`: binding |
| **Session start** | every Claude Code session folds, then lints; root's lint also warns on a stale handover | SessionStart hook | `worktree`: lint handover |

## Quick start

Needs **Node ≥ 24** (runs TypeScript directly, no build) and **Claude Code**.

```
git clone <this template> my-project && cd my-project
cd kernel && npm install && npm test && cd ..
node kernel/src/cli.ts init                      # state/ + starter ontology, registered as a draft
# edit templates → stage at state/bedrock/proposed/ontology.md → amend, then YOU approve:
! node kernel/src/cli.ts approve --doc ontology   # from your own Claude Code prompt
```

Then open Claude Code at the root. `AGENTS.md` is its brief; replace the placeholders with your project. Copy `templates/ROOT.md` to `docs/ROOT.md` for root's handover; the `/session-open` and `/session-close` skills (`.claude/skills/`) run its routines.

## A cell, and talking to it

```
node kernel/src/cli.ts cell new --name lisbon --binding lisbon.json     # {"scope": {"city": "Lisbon"}, …}
git add -A && git commit -m "cell lisbon"                                # the worktree is made from HEAD
node kernel/src/cli.ts cell checkout --name lisbon                       # <repo>-cells/lisbon, branch cell/lisbon
```

```
  cells/lisbon/
  ├── AGENTS.md · CLAUDE.md        the cell's brief (generated; `cell refresh` rewrites it)
  ├── .claude/settings.json        guard hooks + fold/lint at start + the mail Stop hook
  ├── binding.json                 the cell's domain: scope, registries, thresholds, vocabularies
  ├── adapters/                    ENTRY: the only code that brings the world in
  ├── exit/ · test/                EXIT code and durable reports (committed) · the cell's tests
  └── state/log/ · state/out/      memory · EXIT

  .git/cellkit-mail/<root|lisbon>/  the mailboxes: inbox/ · outbox/read/ · runs/ (under the git common dir: shared by every checkout, in none)
  ../<repo>-cells/lisbon/           the cell's own git worktree, on branch cell/lisbon
```

**One worktree per cell.** A cell works in its own checkout of the repository on branch `cell/<name>`, beside the main checkout. Nothing it changes touches the main checkout or another cell until root merges it, so every changed file on its branch is the cell's. Its log (`cells/<name>/state/log/`) is written in its worktree and travels on its branch. Root's log is always written in the main checkout: a kernel command run from a worktree that writes root's log writes the main checkout's, so neither chain forks. The worktree has no `kernel/node_modules` of its own (git-ignored); its kernel copy loads the main checkout's.

1. From the root, queue a task, then run the cell **headless** (the default):
   ```
   node kernel/src/mail.ts send --to lisbon --body "Run fold and lint; report the counts."   # or --file task.md
   node kernel/src/cellrun.ts --cell lisbon                                                 # run it in the background
   node kernel/src/mail.ts watch --as root --wait 600                                       # the reply
   node kernel/src/mail.ts status --as lisbon
   ```
   `cellrun` starts `claude -p "waiting for mail" --permission-mode bypassPermissions --output-format stream-json --verbose --strict-mcp-config` (no MCP servers: cells use none) in `<worktree>/cells/lisbon` with `CELLKIT_MAIL_WAIT=0` (`--wait <s>` to change), so the cell's own brief, hooks and mail loop apply: its first stop takes the queued mail, it works, its final message is filed as the reply, and it exits when its queue is empty. Permission prompts are off; the hooks are the guard rail. It refuses a cell with no worktree (exit 2), a cell already working on a message (3: another session has it, or it died: `--resume`), an empty queue (4) and a cell with a live run already (5). Once there is room it merges main into the worktree if the worktree is clean (exit 7 on a conflict, aborted, mail still queued). Before starting it waits, polling every 30 s, while 3 sessions run across cells (`CELLKIT_MAX_RUNNERS`) or free memory is under 4 GB (`CELLKIT_MIN_FREE_MB`); after `--hold <s>` (default 4 h) it gives up (6) with the mail still queued. A queued run costs time; a run the OS kills for memory costs a half-finished worktree (AI-MMO lost three at once). The transcript goes to the cell's mailbox, `runs/<UTC stamp>.jsonl`. `--dry-run` prints the folder, environment and command instead; `--model <m>` picks the model.
2. **Interactive (fallback):** open a terminal in `<repo>-cells/lisbon/cells/lisbon`, run `claude`, say *"waiting for mail"*. Its turn ends, and the Stop hook starts listening (3 s polls, up to 30 min, `CELLKIT_MAIL_WAIT` to change). Never run a cell headless and interactively at once: both read one mailbox.
3. The hook hands each task to the cell's session as its next instruction. When the session ends its turn, its final answer lands in **root's** inbox as the reply. Unread = in the box; read = moved to `read/`; each box keeps a sent record in `outbox/read/`. Outside git (e.g. tests in a temp folder) each box lives in its own folder instead.
4. **Who may say what:** root → cell `task`; cell → root `reply` (by the hook) · `blocked` · `question` · `done`. Never cell → cell, and a cell can't give root tasks — no agent chatter.
5. **Root's loop: `cell land`.** Read the reply, then:
   ```
   node kernel/src/cli.ts cell land --name lisbon --message "what it did" --check "cd kernel && npm test"   # --dry-run to see the plan
   ```
   It refuses before changing anything if the cell is mid-task, if root has uncommitted work of its own, or if `cell audit` finds a change outside `cells/lisbon/`. The audit reads only the cell's branch (commits since it left main) and its worktree (uncommitted); root's log on a cell branch counts as a fork. Otherwise it:
   - commits the cell's work on `cell/lisbon`;
   - merges main into it and audits again;
   - runs `--check` in the worktree, so the merged result is what gets tested;
   - merges into main with `--no-ff`, so one `git revert -m 1` undoes it;
   - runs `cell sync` and commits root's log (the mail entries).

   If the merge, the audit or the check fails, the cell's branch goes back to where it was, with its work staged. `--into <branch>` targets another branch than the one the main checkout is on. Each of these steps can still be done by hand.

**Boundary.** A session running in a cell writes only inside that cell, so a cell in its worktree can't write into the main checkout or another worktree either. Both the Write/Edit hook and the shell hook enforce this: `../` escapes, `cd`, redirects and file verbs are followed, and the temp folder is allowed. Durable output goes in the cell's `exit/` (committed). `state/out/` is git-ignored except `metrics.json`. The kernel, root docs and other cells are read-only from there; a cell that needs a change says so.

**Wrong checkout.** A cell session opened in the main checkout's copy of a cell that has a worktree, or in another cell's worktree (a linked worktree on branch `cell/<other>`), is refused: the Write/Edit hook blocks every write, the Bash hook blocks shell writes, `git` and appending kernel commands, and the Stop hook files any in-flight reply but hands over no new mail. The message names the folder to reopen it in. Mail to root (`mail.ts send --to root`) still works from there.

**Hand approval.** When a rule refuses but the evidence says yes, a cell raises a review proposing **one exact claim** with its evidence: `node ../../kernel/src/cli.ts review raise --cell . --file r.json`. Root is mailed; `review list --all` shows open ones; **only the operator decides** (the decide command is hook-blocked for agents, like `approve`). Yes → the kernel appends the proposed claim in `voice:operator`, traced to the review and the decision; no → it can't be raised again on the same evidence.

**Reporting up.** `node kernel/src/cli.ts cell sync` records each cell's head and the numbers it publishes in `state/out/metrics.json`. Root's lint then checks that every head it ever recorded still exists in that cell's log, so a rewritten cell history is caught. Run it at session start. Both read the main checkout's copy of each cell, i.e. what has been merged; a cell's worktree is ahead of it until root merges.

## Configuring it for your project

A project changes the kit's behaviour through its **configuration surface**, never by editing `kernel/`. That keeps every kit update a clean merge.

| What | Where | Changed by | Read by |
|---|---|---|---|
| What the system is made of | `state/bedrock/ontology.md` | amend → **operator approves** | people, agents |
| Your claim kinds | `state/bedrock/kinds.json` | amend → **operator approves** | `append`, `lint` (schemas.ts) |
| Your guards, which repo paths each cell owns, and whether mail bodies go into the logs (`"mail": { "log": "hash" }` keeps them out: the log is append-only, so personal data in a task would stay forever) | `state/bedrock/guards.json` | amend → **operator approves** | both hooks, `cell audit`, `cell land`, the cell brief, `lint`, mail |
| One cell's domain (scope, thresholds, vocabularies) | `cells/<x>/binding.json` | root: `cell rebind` (logged) | that cell's code and brief |

Bedrock docs are `.md` (read by people) or `.json` (read by the kernel). The rules:

- A `.json` doc goes live **only when approved**. An agent's amend never changes what the hooks enforce or what a claim may say.
- `amend` and `approve` both refuse a `.json` doc that doesn't check:
  - `guards.json`: entries must be well formed and patterns must compile;
  - `kinds.json`: schemas must compile, no kit kind may be redefined, and **every claim already in root's and the cells' logs must still validate**. The log is never edited, so a kind can't be dropped or narrowed while claims of it exist.
- Lint errors on a hand edit, like any bedrock doc. In the main checkout the hooks also refuse everything while `guards.json` differs from its approved version.

The steps:

1. **Sketch first**, in cheap text: what flows in, what you claim about it, what leaves.
2. Write it into the ontology (`stage --doc ontology`, edit, `amend`; the operator approves).
3. Your kinds: write `state/bedrock/proposed/kinds.json` and amend it. Each kind is a JSON Schema the claim must meet when it has that kind:
   ```json
   { "kinds": { "visit": { "description": "someone went somewhere", "schema": { "properties": { "says": { "type": "object", "required": ["at"] } } } } } }
   ```
4. Write tests first (fixtures as journeys), then a fold for your pictures; merge it into `fold()`.
5. Put domain values in each cell's `binding.json` (`cell new --binding`, later `cell rebind`), not in code.
6. Your guards: `state/bedrock/proposed/guards.json` (see `templates/guards.example.json`), then amend.
   - `operator_only`: commands only the operator runs. Write `{ "command": "tools/x.ts publish" }` (a script and its subcommand, quoted or not, in any folder) or `{ "pattern": "<regex>" }`, each with a `message`.
   - `protected`: paths only a named script writes, e.g. `{ "path": "docs/report/", "by": "tools/report.ts" }`.
   - `cells`: repo paths a cell owns beyond its folder, e.g. `{ "game": { "owns": ["game/**"] } }`. A cell may write there and `cell land` commits them. A glob must start with a folder and can't reach `kernel/`, `state/`, `cells/`, `.claude/` or `.git/`. Lint errors if a tracked file has two owners. Root owns nothing and may write anywhere.

   If the live file is invalid or hand-edited, everything is refused until the operator fixes it.

A bedrock change reaches a cell through its branch: land the cell or merge main into it, then `cell refresh` so its brief shows what it owns.

## Working method

- **Sketch → check → schema → code**, always against real data.
- **Every guess is logged as a guess** (`assume`), and moves only with evidence (`evidence`).
- **Decisions are logged** (`constraint`) so they aren't re-litigated.
- **Agents write content; scripts write structure.** If you find yourself hand-shaping a log entry, a message or an amendment, write a generator.

## Commands

```
node kernel/src/cli.ts init | fold | lint [--cell <dir>]
node kernel/src/cli.ts append --kind observation|claim --body <file|->
node kernel/src/cli.ts assume [--id A1] --statement "…" [--test "…"] · evidence --id A1 --status some --note "…" · constraint --slug x --text "…"
node kernel/src/cli.ts stage --doc ontology                                                          (copy the live doc to proposed/, with its base)
node kernel/src/cli.ts amend --doc ontology --layer shape|kinds|rules|binding|meta --reason "…"   (after staging state/bedrock/proposed/)
! node kernel/src/cli.ts approve --doc ontology [--proposal <entry>]                               (operator only)
node kernel/src/cli.ts cell new --name <name> [--binding <file>] · cell refresh --name <name> · cell rebind --name <name> [--binding <file>]
node kernel/src/cli.ts cell checkout --name <name> [--path <dir>] · cell audit --name <name> [--except <glob>]…
node kernel/src/cli.ts cell land --name <name> [--message "…"] [--check "<cmd>"] [--into <branch>] [--dry-run]
! node kernel/src/cli.ts cell land … --accept-weaker "<why>"                                         (operator only)
node kernel/src/cli.ts lint --all                                                                     (root and every cell's log)
node kernel/src/mail.ts send --to <name> · watch [--as root] · status [--as <name>] · release --as <cell>
node kernel/src/cellrun.ts --cell <name> [--resume] [--wait <s>] [--hold <s>] [--model <m>] [--dry-run] [--root <repo>]
node kernel/src/cli.ts cell sync · review raise|list   (review decide: operator only)
```

## Limits (today)

- One writer per cell at a time. `append` re-reads the log; bulk adapters use `writer(cell)`.
- Log files are one JSON file per entry: fine to tens of thousands, then it needs a packed format.
- Mail is on the log: every message is an observation on both sides; the files are transport.
- Cells don't run git: root commits a cell's work on its branch and merges it (`cell land`). The Bash hook doesn't enforce that (it only blocks `git` for a session in the wrong checkout); `cell audit` is the check.
- Ownership is checked for overlap only in committed files (lint reads `git ls-files`), and only once the log's chain lints clean. Root is never an owner: it has no boundary.
- Bedrock JSON (`guards.json`, `kinds.json`) is read from the main checkout, also by a cell's hooks and kernel copy in its worktree, so what the operator approves is in force in every cell at once. Without git (a sandbox that can't read the worktree's `.git`), each checkout reads its own copy. The hooks' check that `guards.json` matches its approved version runs where root's folded views exist.

## Traps

- **One task per mail.** A mail is one turn and one reply: bundle two tasks and the cell replies after the first, and the second is lost. Queue a second mail instead; the cell takes it next.
- **A cell branch can be stale against main.** If main moved while the cell worked, its work is green on its branch but may fail once merged: `cell land --check` tests the merged result. Before a session starts, `cellrun` merges main into a clean worktree, so the task starts on main as it is (its kernel, hooks and brief). A worktree is clean only right after a land: each task leaves its own log entries uncommitted, so between lands a run says "not levelled" and only bedrock (read from main in any case) is current; kernel and hook changes reach the cell at the first run after its land. A conflict stops the run (exit 7). An interactive session isn't levelled: merge main into its worktree by hand between tasks, never over uncommitted work. Since cells' hooks check main's `guards.json` against main's folded views, a `guards.json` changed on main without a fold (a pull from elsewhere) makes every cell's hooks refuse too: run `node kernel/src/cli.ts fold` in the main checkout.
- **Never run a cell headless and interactively at once.** Both read one mailbox; `cellrun` refuses while a message is in flight, but an idle interactive session would still take the next one.
- **CRLF copies in worktrees on Windows.** With `core.autocrlf=true` a worktree can hold CRLF copies of LF files (`git ls-files --eol` shows `i/lf w/crlf`). Git status stays clean, but anything that hashes file bytes (fixtures, golden files) differs in that worktree only. Delete those files and `git checkout -- <files>` in the worktree, or set `core.autocrlf=false` for the repo.
- **A session can die mid-task.** The task stays with the cell (`mail.ts status` shows `working_on`, and `run` says whether anything still works on it), its partial work stays in the worktree, and a headless run tells root with a `blocked` mail. Then `node kernel/src/cellrun.ts --cell <cell> --resume`: if the session had finished its answer (its runner died before the reply was filed), the answer is filed from the run log; otherwise a fresh session is given the task and its partial work, and its reply goes to the original. Only if the task should be dropped: `mail.ts release --as <cell>` files a placeholder reply, then resend. Never `--resume` while an interactive session is on the task. A runner killed while its session works (a kill by process name, a closed parent session) leaves that session working: it holds the cell's lock and a slot until it ends, and `cellrun` and `release` refuse meanwhile. Pids are reused: if the pid they name is not a claude session, delete the cell's `runner.lock` in its mailbox. Each run leaves `<log>.exit` beside its transcript; a run with none was killed hard. Don't edit mail files.
- **Stress-test concurrency code.** One clean run of a race proves nothing: without the log's lock two writers took one id about 1 run in 20, under parallel load only (SF-DEV). Run such a test many times, under load, and check it fails with the fix taken out.
- **A cell must work synchronously.** If it ends its turn while sub-agents or background commands still run, its "waiting for…" becomes the reply, and a headless run's exit kills the rest. The brief says so, and the Stop hook holds back a short answer that reads as a progress note ("still running", "waiting for", "I'll report once it finishes"), sending the session back to finish up to 3 times before filing it. A longer one gets through: check replies for it (PS5-STUDY lost two this way, SF-DEV four).
- **Durable output goes in `exit/`.** `state/out/` is git-ignored except `metrics.json`, so a report left there never reaches root.
- **Brief changes reach existing cells only via `cell refresh --name <cell>`** (commit, then land or merge main into the cell's branch).
- **Bedrock with several proposals pending:** `approve` refuses until you name one with `--proposal`. Approving a newer one drops the older ones. Bedrock doc names are `[a-z0-9-]+` (no folders).
- **Mentions trip the guard.** The kernel's own rules refuse a command that merely mentions `approve`, `review decide` or a kernel-owned path next to a write, a `sed` replacement string included. This is deliberate. Use the Edit/Write tools, or a file for the message (`git commit -F`, `mail.ts send --file`). It is the same for `guards.json`'s `operator_only` commands: a mention is refused. Its `protected` paths look at write targets only.
- **Upgrading a project whose kinds are in `claim.schema.json`:** get `kinds.json` approved first, *while* your old `claim.schema.json` is still in place, then take the kit's copy. The other order leaves lint red. The two enums merge, so both states work.
- **On Windows a folder rename can fail** while something holds a handle on it (an editor, a watcher). Move its contents entry by entry instead.
- **Never put backslash-bearing text through a shell heredoc** (regexes, Windows paths, `\n` in code). Depending on the shell and interpreter, `\b` becomes a backspace and `\d` becomes `d`, or `\n` becomes a real line break inside a string literal. SF-DEV lost a binding's redaction patterns this way, and the kit's own v0.2 work broke TypeScript three times the same way. Use the Edit/Write tools, then compile or test what you wrote.
- **Weaker tests stop a land.** If a cell's change drops test cases or assertions, or adds skips or tolerances, `cell land` refuses. If the change is right, show the operator the findings; they land it with `--accept-weaker "<why>"` and the reason is recorded in the merge. The check counts lines, so a moved test can look like a dropped one.
- The Bash guard is a heuristic; `lint` (hash chain + bedrock hashes) is the backstop. The kit's hooks fail closed: a check that throws, or input they can't read, refuses (exit 2) and names the error; but a hook script that can't even load (a syntax error in it) still exits 1, which Claude Code doesn't block on. Hooks can't see inside the scripts a command runs, nor guard reads, so `cell audit` stays the check; for a real boundary run the cell in an OS sandbox (callsheet ran one in NVIDIA OpenShell: filesystem, network per binary, credentials kept outside).
- Kernel-owned paths count only as paths from the repo or a cell's root (`state/views/…`, `../../state/log/…`, `cells/x/state/…`, the repo's absolute path): `test/fixtures/x/state/views/` is a fixture. A `cd` into such a fixture first is still refused.
- Nobody kills processes by name (`taskkill /IM`, `pkill`, `killall`, `Stop-Process -Name`, a pipe into `Stop-Process`): on a shared machine that takes other projects' runners and builds too. Kill by pid.
- A cell's Claude session also loads parent-folder CLAUDE.md files. Keep the root's CLAUDE.md a pointer.

## Roadmap

This is option **C — a template repo**: copy it and own it. Two packagings are planned:

- **A · Claude Code plugin.** The hooks, `/cell-new` and `/mail` commands, and a skill that teaches the method, installable into any repo. The rules only work because hooks enforce them, so the plugin is the natural home.
- **B · npm package** (`npx cellkit init`). The kernel as a library and CLI, for projects that wire their own hooks or run without Claude Code. The plugin (A) would carry it.

Until then, kit improvements are copied between projects by hand. Keep `kernel/` free of domain code so that stays easy.

## Using it in a project, and sending fixes back

How the projects that use it do it:

- Rename this README to `KIT.md` (your project gets its own `README.md`). Add cellkit as a fetch-only remote: `git remote add cellkit <path-or-url>`, then `git fetch cellkit && git merge cellkit/main` to take kit updates.
- Your guards, kinds and ownership live in bedrock (`guards.json`, `kinds.json`) and your code lives outside `kernel/`. Then a kit merge never conflicts with your project.
- A kit fix found in a project goes back to cellkit as its own commit, never mixed with the project's log or domain code.
- Copy `templates/ROOT.md` to `docs/ROOT.md` for root's handover. Set `origin` to a private backup and push after committing: the log is the record, so don't let it live on one disk.
- Set `core.autocrlf=false` (see Traps).

Not in the kit yet: a person-data seal (crypto-shredding, carnet `seal.ts`), a model map (carnet `models.ts`), and requirement tracing (AI-MMO, DTG).
