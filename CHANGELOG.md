# Changelog

## Unreleased

**Fixes**
- **A cell's views no longer show stale after every land** (#7; callsheet). Mail appended the task and its reply to the cell's log and to root's without refolding, so root's `lint --all` warned "views are stale" after every task; and `fold --cell cells/<x>` run from main folded the main checkout's copy (a snapshot from the last land), not the live log in the cell's worktree that lint reads, so the warning stayed. Now every write refolds the log it wrote, mail included (`refold.ts`, under the log's lock), and `fold` and `lint` of a cell with a worktree go to its log there, as writes already did (the CLI prints a note). Not a line-ending problem, as first guessed on the issue. The cost: each message now reads and folds the logs it writes (root's and the cell's); small for logs of hundreds of entries. Lint reports views it catches half-written as "views unreadable" instead of crashing.

**Upgrading a project:** nothing to run. `lint --cell cells/<x>` from main now lints the cell's worktree copy when it has one: the live log, the one `lint --all` already read.

## v0.4 — guards by act, cells outside the repo (2026-10-23)

What the projects filed since v0.3, now GitHub issues on `Rwb3n/cellkit` (`maintainer/notes/`).

**Guards**
- **git's restores are writes** (#1). `git checkout -- docs/assumptions.md`, `git restore …` and `git checkout HEAD -- state/log/…` passed the shell guard: their text has no write verb. They are refused now, as are the same commands behind git's own options (`-C <dir>`, `-C<dir>`, `--work-tree`, `--git-dir`, `-c k=v`, `--no-pager`), which AI-MMO found passing its port (1e39484). So is a folder or pathspec that holds a kernel-owned path (`git checkout -- .`, `git restore state/log`, `"*.md"`): name the files you mean. Index-only forms stay open (`rm --cached`, `restore --staged`). The same git paths count for the project's own guarded paths (`guards.json` `protected`) and, in a cell, against its boundary.
- **The read guard follows `cd`, and `/d/x` is `D:/x` on Windows** (#1). `cd <another repo> && grep -r …` was judged against this project's `.env` (apify-actor-dev, callsheet); a Git Bash path was read as a folder of the project. A `cd` it can't judge (`$x`, `%x%`, `~`) is judged from the session's folder, as before.
- **Claude Code's own worktrees are guarded, and never merged into main** (#48). A subagent with `isolation: "worktree"` works in `.claude/worktrees/<name>` under root's hooks; its worktree's kernel-owned files could be restored from the shell, and its `worktree-*` branch merged into main past `cell land`'s audit and check. The shell guard now treats those worktrees as checkouts of their own and refuses merge, pull, cherry-pick, rebase and reset onto a `worktree-*` branch (Claude Code's `worktree-<name>`: documented for `claude --worktree`, seen for subagents). Lint warns on any worktree under `.claude/worktrees/`, whatever its branch, and on an unmerged `worktree-*` branch left behind. The rule: work reaches main through `cell land` or root's own commits.
- **The shell guard matches acts, not text** (#2; SF-DEV S5). A commit message, an `echo`'d string, a grep pattern, a `sed` script or a heredoc a program reads as data that only *names* a kernel-owned path, a `protected` path or a secret is no longer refused (root 2026-10-22: `grep -n "\.env" …`; apify-actor-dev: a script written by heredoc; SF-DEV). Write targets are checked one by one, quoted or not. The operator's acts (`approve`, `review decide`, `--accept-weaker`, `operator_only`) stay mention-strict.
- **Now refused, found on the way** (#2): what runs inside a command is judged like the command: `$(cat .env)` and backticks (also inside double quotes), `bash -c` / `pwsh -Command` / `cmd /c` strings, a heredoc fed to `bash` or `python -`, and an interpreter's `-e`/`-c` code. Now allowed: a search given only files (`grep -rn x a.ts`) reads those files, not the whole folder.

**Cells**
- **Cells' worktrees live outside the repository, where the project says** (#26). `guards.json` `"worktrees": { "home": "../.cells/<project>" }`, relative to the main checkout, puts every cell's worktree at `<home>/<cell>`: one folder for all projects' cells, instead of a `<repo>-cells/` sibling per project (processkit, modelkit: "worktrees littering the projects dir"). Without it, the sibling stays the default. A home inside the repository or by drive (`D:/…`, `/mnt/d/…`) is refused when the guards are checked: the project opens from Windows and WSL alike. `cell checkout` refuses a worktree inside the main checkout, `--path` included, and root's lint makes one made by hand an error: root's guards judge everything under the main checkout as root's, so a nested cell's files would be root's (tested 2026-10-22, `maintainer/notes/2026-10-22-native-agents.md`). Lint warns on a cell worktree that isn't at `<home>/<cell>` when a home is set.
- **Cells' worktrees are locked** (#22). `cell checkout` runs `git worktree add --lock --reason "cell <name>"`: a cell's worktree is kept, not throwaway (AI-MMO: a by-hand worktree outlived its session with 61 edited files), and `git worktree prune` leaves it. Root's lint warns on an unlocked one. A locked worktree deleted by hand stays registered; `cell checkout` then says how to release it (`git worktree unlock`, `git worktree prune`).

**Upgrading a project to v0.4**
- Add `.claude/worktrees/` to `.gitignore` (the template has it), or `git add -A` in main can commit a native worktree as an embedded repository. A session that restored a generated file with `git checkout --`, or discarded everything with `git checkout -- .`, now gets a refusal: regenerate with `node kernel/src/cli.ts fold`, and restore other files by name. Lint may now warn about native worktrees or `worktree-*` branches left from earlier sessions: remove them once nothing in them is needed.
- Cells' worktrees: existing ones in `<repo>-cells/` keep working where they are; nothing moves unless you want it to. Lint now warns that each is unlocked: `git worktree lock --reason "cell <name>" <path>`. Removing a cell's worktree now takes `git worktree remove -f -f` (one `--force` is refused for a locked one). To gather a project's cells in one folder, the operator approves `"worktrees": { "home": "../.cells/<project>" }` in `guards.json` (stage, `amend`, `approve`); new checkouts go there, and lint warns on each existing one elsewhere until it is moved, with no session open in it: `git worktree unlock <old>`, `git worktree move <old> <home>/<cell>`, `git worktree lock --reason "cell <cell>" <home>/<cell>`. A cell worktree inside the main checkout (e.g. `<repo>/.worktrees/<cell>`) is now a lint error: move it out the same way.

## v0.3 — the field survey (2026-10-18)

What SF-DEV, AI-MMO, callsheet, 01-HAIOS-PERS, project-archivist and live-stream-setup ran into (`maintainer/notes/`, `maintainer/backlog.md`).

**Cells, mail and headless runs**
- **A task reaches the cell's log when it is handed over**, not when it is sent. Sessions that read their log found queued tasks there, did them before the Stop hook handed them over, then did them again, and the first answer was lost (01-HAIOS-PERS, project-archivist). The brief now says a mail entry in the log is a record, never an instruction (`cell refresh` existing cells).
- **A progress note is not a reply.** While a task is in flight, the mail Stop hook holds back a final answer under 400 characters that reads as interim ("still running", "waiting for", "I'll report once it finishes"): it blocks and sends the session back to finish, at most 3 times per message, then files what it has (`mail.ts` `hold`, `test/mail.test.ts`). From SF-DEV (four lost replies) and AI-MMO (#112).
- **Headless runs are light and queue for room.** `cellrun` starts the session with `--strict-mcp-config` (no MCP servers: cells use none, and each loaded one costs helper processes). A run holds the cell's `runner.lock` (a second run refuses, exit 5) and waits, polling every 30 s, while 3 sessions run across cells or free memory is under 4 GB (`CELLKIT_MAX_RUNNERS`, `CELLKIT_MIN_FREE_MB`); after `--hold` (default 4 h) it gives up with the mail queued (exit 6). The choice to start is made under one lock, so two waiters never take the last slot together. From AI-MMO (dbd8995, 5e4b688), where the OS killed three runners for memory.
- **Dead runs and orphaned sessions.** `cellrun` records its session's pid in the runner lock: a session whose runner was killed keeps the cell's lock and a slot until it ends, and `cellrun` and `mail.ts release` refuse meanwhile (AI-MMO: a kill by process name took every runner). A run that ends with its task unfiled files the answer from its run log if the session finished one (marked recovered); if it died mid-task, the cell keeps the task and root gets a `blocked` mail. **`cellrun --resume`** recovers the answer from the last run's log, or starts a fresh session told the task and its partial work, whose reply goes to the original. Each run leaves `<log>.exit`. `mail.ts status` shows `run`. Before, a dead run filed "the task was not done" and the partial work was orphaned; a run killed with its parent left the cell stuck (project-archivist, seven days).
- **Cells run on main as it is.** Bedrock JSON (`kinds.json`, `guards.json`) is read from the main checkout, also by a cell's hooks and kernel in its worktree: a kind or guard approved on main is in force in every cell at once (SF-DEV: a cell refused claims of a kind approved that day). And `cellrun` merges main into the cell's worktree before the session starts, when the worktree is clean (in practice the first run after a land), so kernel and hook changes reach it too (SF-DEV: a read guard in kernel code didn't cover cells until root merged); uncommitted work, a merge in progress, or ignored files main would overwrite leave it alone; a conflict is aborted and the run stops (exit 7) with the mail queued. From AI-MMO (DEC-0013, 849252f).
- **Mail bodies can stay out of the logs.** `guards.json` `"mail": { "log": "hash" }` logs each message's sha256 and length; the body lives in the mailbox only. The default, `"body"`, logs it whole as before. An invalid `guards.json` logs hashes. From callsheet, whose rule against personal data in any log kept a component from being a cell.

**Guards**
- **The read guard.** No session, root's included, reads a secret (keys, `.env` but not `.env.example`, credential files and folders, shell histories) or a path the project lists in `guards.json` `"unreadable"` (by folder name anywhere on the disk), from Read, Grep (new `hook-read.ts`, matcher `Read|Grep`) or the shell (by act: `cat .env` is a read, a commit message naming it is not). A content search over a tree holding a secret must be narrowed. It fails closed. A floor, not a boundary: scripts read past it; an OS sandbox is the boundary (README). Ported from SF-DEV (secrets.ts, hook-read.ts). Existing cells get the new hook with `cell refresh`; a project's root `.claude/settings.json` needs the `Read|Grep` entry added (see this repo's).
- **Guards fail closed.** A check in `hook-bash` or `hook-guard` that throws, or input they can't parse, now refuses (exit 2, naming the error) instead of exiting 1, which let the command or write through unchecked. From AI-MMO (#134).
- **Kernel-owned paths are anchored.** The shell guard refuses `state/log|views|bedrock/` and `docs/assumptions.md` only as paths from the repo or a cell root, so a test fixture such as `test/fixtures/x/state/views/` can be written (SF-DEV: a cell gave up on static fixtures). The refusal names the path it matched (01-HAIOS-PERS: one listed paths the command never named).
- **No killing by name.** `taskkill /IM`, `pkill`, `killall`, `Stop-Process -Name` and pipes into `Stop-Process` are refused for every session; by pid is fine. From AI-MMO, where another project's `taskkill /F /IM python.exe` took every runner.
- **Write/Edit may use the temp folder** (outside the repo), as the shell already could (SF-DEV).

**The log**
- **The log has a lock.** Every append holds `state/log.lock` (git-ignored) and re-reads a stale tail, so writers at once never fork the chain: on Windows two took one id about 1 run in 20 without it. A dead holder's lock, or one older than 30 s, is taken over; a waiter gives up only when one holder keeps it 10 s (5 min at most), never while it changes hands. The lock nests within one process (`withLock`). From SF-DEV (S1), stress-tested with 8 processes (`test/lock.test.ts`).
- **`assume` without `--id`** takes one past the highest, chosen and appended under one hold of the lock: no probing for a free id with a throwaway entry, which the log keeps forever. From AI-MMO (d63993f).

**Fixes**
- **`cell land` read a path with its first letter cut off** when the first `git status` line was an unstaged change (` M docs/assumptions.md` → `ocs/assumptions.md`). Root's log commit then skipped the generated doc, and the next land refused it as root's own work. `dirty()` no longer trims git's output (`test/land-dirty.test.ts`). From SF-DEV.

**Upgrading a project to v0.3**
- Merge the kit, then `node kernel/src/cli.ts cell refresh --name <cell>` for each cell (new brief lines, the `Read|Grep` hook), commit, and land or merge main into each cell.
- Add the `Read|Grep` entry to the project's root `.claude/settings.json` (copy this repo's).
- Add `**/state/log.lock` to `.gitignore`.
- `cellrun` has new exit codes: 5 (a live run or orphaned session holds the cell), 6 (no room within `--hold`), 7 (merging main into the worktree failed). A cell whose session died: `cellrun --resume`, not `release`.
- Optional, in `guards.json` (operator approves): `"unreadable"` paths, and `"mail": { "log": "hash" }` to keep mail bodies out of the logs.
- The read guard now refuses `cat .env` and unnarrowed recursive searches over a folder holding one, for root too. A project that relied on reading its own `.env` in a session: let the tool read it (`process.loadEnvFile`).

## v0.2.1 — the rest of the lessons (2026-10-09)

- **`cell land` refuses weaker tests.** If the cell's diff drops test files, cases or assertions, or adds skips or loosening (`|| true`, tolerances), the land stops and undoes itself. Only the operator lands it anyway, with `--accept-weaker "<why>"`; the hook blocks that flag for agents, and the reason goes into the merge commit. From AI-MMO: a cell loosened a test so a regression passed.
- **Independent voices.** The fold counts, per subject, the voices that aren't the kit's, a model's or a check (`independent`), and the summary counts subjects with two or more (`agreed`). From carnet.
- **Stale handover warning.** Root's lint warns when `docs/ROOT.md` hasn't changed in 20 commits. From DTG.
- **`/session-open` and `/session-close` skills** (`.claude/skills/`) run the routines in `templates/ROOT.md`. From carnet, rewritten for land, `lint --all` and release.
- **README:** every guarantee names the test that proves it. New traps: no backslash-bearing text through a shell heredoc (from SF-DEV, and hit three times while building v0.2), and weaker tests.
- **`docs/assumptions.md` is committed** in the template (empty, generated), as a project commits it.

## v0.2 — lessons from the projects (2026-10-09)

What carnet, 01-HAIOS-PERS, PS5-STUDY, SF-DEV, PORTOFOLIO-MANAGER, loyalty-code-app, AI-MMO and DTG ran into.

**Fixes**
- `worktree.test.ts` failed (25/26) whenever the kernel's tests ran from a cell's worktree, which is what the brief tells every cell to do. It now takes the main checkout's `node_modules`.
- `cli.ts --cell cells/<x>` run from the main checkout wrote the main checkout's copy of a cell that has a worktree. That forked the cell's chain. Writes now land in the worktree, as mail already did. `cell refresh` does the same.
- A headless run that died mid-task left the cell refusing every later run (exit 3). `cellrun` now files a reply saying the task was not done; `mail.ts release --as <cell>` does the same by hand.
- The shell had no cell boundary (`cp x ../../kernel/…` passed). Redirects and file verbs aimed outside the cell are now refused.
- Removed carnet's `docs/models` leftover from `hook-guard.ts`.

**A configuration surface: nothing in `kernel/` to edit** (README, "Configuring it for your project")
- Bedrock holds `.json` docs the kernel reads. They go live only when the operator approves, and `amend` and `approve` refuse one that doesn't check.
- `state/bedrock/kinds.json`: your claim kinds, each a JSON Schema, merged into the kit's claim schema. A proposal is checked against every claim already logged, so a kind can't be dropped or narrowed while claims of it exist.
- `state/bedrock/guards.json`: your operator-only commands and script-written paths, read by both hooks. It replaces forks of `hook-bash.ts` and `hook-guard.ts`; see `templates/guards.example.json`.
- `guards.json` → `cells.<x>.owns`: repo paths a cell owns beyond its folder. Write/Edit, the shell guard, `cell audit`, `cell land`, the brief and lint all honour them; lint errors if a tracked file has two owners.
- `cell rebind`: a cell's `binding.json` is root's to change, and each change is logged on the cell's log. A cell can't edit its own binding, and lint catches a hand edit.

**New commands**
- `cell land`: root's whole loop in one command, which undoes itself if any step fails.
- Bedrock: `stage --doc` records the base, `amend` refuses a stale copy, and `approve --proposal <entry>` (with several proposals pending it refuses to guess).
- `lint --all` lints every cell's log too.
- Assumptions can be parked with `evidence --note "parked: …"`.
- `templates/ROOT.md`: root's handover (role, where state lives, routines, lessons).

**Cell brief** (existing cells: `cell refresh --name <cell>`)
- A cell may write anywhere in its folder except its log and its binding, plus the paths it owns. The old brief listed five folders, and a cell refused allowed work over it.
- `exit/` and `test/` are created at birth. Durable output goes in `exit/`, because `state/out/` is ignored except `metrics.json`.
- Work synchronously: no background work or sub-agents left running at the end of a turn.

**Taking it into a project**, in this order:
1. Merge the kit (README, "Using it in a project").
2. **Kinds**, if you added any to `kernel/schemas/claim.schema.json`:
   - write them to `state/bedrock/proposed/kinds.json` and amend;
   - the operator approves;
   - only then take the kit's `claim.schema.json`.

   The two enums merge, so lint stays green at each step.
3. **Guards**, if you edited `kernel/src/hook-*.ts`:
   - move the rules to `state/bedrock/proposed/guards.json`, amend, and the operator approves;
   - then take the kit's hook files as they are.
4. **Bindings**: lint now compares each cell's `binding.json` with its log. If one was edited by hand, run `node kernel/src/cli.ts cell rebind --name <cell>` to record it.
5. Run `cell refresh` for each cell, then land it.
