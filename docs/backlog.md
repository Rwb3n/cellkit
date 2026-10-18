# Backlog

From the projects' notes in [`notes/`](notes/): SF-DEV (2026-10-10 to 10-15), AI-MMO "Scally" session 6 (2026-10-09), and the field survey of 2026-10-18 (callsheet, 01-HAIOS-PERS, SF-DEV, AI-MMO sessions 7–9, project-archivist, live-stream-setup; "survey N" below). Ranked; each line names its source. Re-ranked 2026-10-18.

## Next

1. **Dead runs and orphaned sessions.** runner.lock records the session's pid (spawn, not spawnSync); while the session lives the lock isn't stale, orphans count toward MAX_RUNNERS, and a new run refuses. `working_on` with no live runner is reported as orphaned (mail status, session-open). Recovery in order: file the answer from the run log if there is one (marked recovered), else `cellrun --resume` (task text + "partial work is uncommitted in the worktree", reply filed to the original), else release. An exit note beside each run log. *survey 2 (project-archivist stuck 7 days; AI-MMO d1b3deb, d1030f4) · Scally 1*
2. **Cells run on main's bedrock and guards.** `cellrun` merges main into a clean, idle cell before starting (conflict: abort, check, exit with the mail queued; never over uncommitted work or ignored files main would overwrite), and kinds and secrets read bedrock from the main checkout as guards already do. *survey 6 (SF-DEV S-3c, 2c87840, 9f28d63; AI-MMO 849252f, ca8ec08)*
3. **Shell guard correctness.** Fail closed on its own errors (exit 2, naming the check); kernel-owned paths only as paths from the repo or cell root, and the message names the one matched; Write/Edit get the shell's temp exemption; refuse killing processes by name (`taskkill /IM`, `pkill`). Then acts, not text (Later). *survey 3–5 · AI-MMO 897ee08*
4. **Guard reads.** Today a session can read a neighbouring workspace's `.env` with Read, Grep or `cat`. Add a `Read|Grep` hook matcher, a read check on shell commands, and a `guards.json` `"unreadable"` list (defaults: `.ssh`, `.env` but not `.env.example`, key files). *SF-DEV 18 (secrets.ts, hook-read.ts)*

## Later

- **The shell guard matches acts, not text.** A commit message, a heredoc's `=>` or a fixture path that names a protected path is blocked (root 2026-10-18; SF-DEV runs 164435Z, 173850Z; archivist task 4). Blank quoted strings and heredoc bodies before matching, unless they are a write's target or go to a shell. *SF-DEV 10 · survey 4*
- **Lint notices abandonment**: a cell's worktree N commits behind main; root changing a cell's folder on main while it has a worktree; untracked log entries (and `/session-close` refuses them). *survey 8*
- **Worktrees**: `cell checkout` links configured root paths (`node_modules`, tools) into the worktree; `git worktree add --relative-paths --lock`. *survey 9–11*
- **One landing at a time**: a landing lock; main's hook refuses commit, merge and push meanwhile; runners wait. *survey 11 (AI-MMO 633cf6b)*
- **`cell land` re-runs new or changed tests** N times (default 3), and runs the cell's own fold and lint on the merged result. *SF-DEV 11 (cellverify.ts)*
- **The brief**: where mail lives (every headless run looks for `inbox/` in the cell); paths in a task are from the repository root. Approving guards refreshes the briefs it changes, or prints the command. *survey 14*
- **`amend`/`approve` refuse template placeholders** ("<your project>"). *survey 13*
- **`constraint --quote`**, required when the voice is the operator's. *SF-DEV 8*
- **`drift.ts`**: a project's kernel edits beyond its contract points, the kernel symbols it imports, and the upstream commits that will conflict. *SF-DEV 9 · survey 14*
- **An extension point** for a project's own lint and fold modules, so they can live outside `kernel/`. *SF-DEV 12*
- **Adopting into an existing product repo**: a README section (keep the product's README, skills and `CLAUDE.md`; exclude `kernel/` and `cells/` from the app's tsconfig, lint and tests). *survey 14 (callsheet)*
- **One voice format** (`claude` vs `voice:kernel`), enforced by the schema. *survey 14*
- **Jobs** (a cell's long command, started and watched by root) and **recurring mail**. *SF-DEV 4 · survey 14 (callsheet #66)*
- **Writes outside the repo**: a binding declares external roots; both hooks and audit honour them. *survey 12*
- **Runner extras**: `--pause` after the head of the queue, `--stop`, `--status`; joint land (`--cells a,b`). *survey 14 (AI-MMO)*
- **Traps (README)**: a tool path never runs for the first time on the only copy of anything; a session ends with no runners or stray worktrees left. *SF-DEV 14 · Scally 7*

## Watching (not kit work yet)

- **Cells on another machine or in a sandbox** (a transport over SSH; hooks without git). callsheet's operator named this as a reason to revisit. *SF-DEV 6 · survey 10*
- **Promoted builds**: the operator plays a promoted build, never main. This is project-shaped. *Scally 5*
- **Maps, predictions, divergences.** Alpha, rule of three. *SF-DEV 12*

## Already in the kit

- A task reaches the cell's log at hand-over; mail bodies logged whole or hashed (`guards.json` `mail.log`, operator's choice 2026-10-18: a project setting, default body): Unreleased. *survey 1, 7 · SF-DEV 13*
- Light headless runs that queue for room: Unreleased (20cfefb). *Scally 1, 6 · survey: callsheet loaded 11 MCP servers*
- Log lock, and `assume` choosing its id under it: Unreleased (7b18ce8). *SF-DEV 3, 7 · Scally 3*
- Placeholder replies held back by the mail hook: Unreleased (2f2add6). *SF-DEV 2, 13 · Scally 2*
- `cell land`'s `dirty()` cutting a letter off a path: Unreleased (58279f5). *SF-DEV 15 · survey: callsheet patched it twice*
- Kernel tests failing from a cell worktree: fixed in v0.2. *SF-DEV 1*
- Shell heredocs eating backslashes: in Traps since v0.2.1. *SF-DEV 5*
- Landing stops on weaker tests: in v0.2.1; prose is never a test file (ed205f1). *Scally 4 · survey: archivist*
