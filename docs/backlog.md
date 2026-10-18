# Backlog

From the projects' notes in [`notes/`](notes/): SF-DEV (2026-10-10 to 10-15) and AI-MMO "Scally" session 6 (2026-10-09). Ranked; each line names its source. Triaged 2026-10-18.

## Next

1. **Log lock, and ids chosen under it.** Two writers can append to one log at once, and on Windows they took the same id about 1 run in 20. Every append holds `state/log.lock` and re-reads a stale tail. `assume` without `--id` takes one past the highest, with the lock held across the read and the append, so nobody has to probe with throwaway entries. Stress-test with 8 writers or more, because one clean run proves nothing. *SF-DEV 3, 7 (log.ts, lock.test.ts) · Scally 3 (d63993f)*
2. **Lighter headless runs, with admission.** `cellrun` starts `claude -p` with `--strict-mcp-config` (cells use no MCP servers, and each server loaded costs node processes). It also waits instead of starting while runners ≥ 3 or free memory < 4 GB, polling every 30 s up to 4 h, with the limits as named constants. On the count, unreadable memory never blocks the run. *Scally 1, 6 (dbd8995, 5e4b688)*
3. **`cellrun --resume`.** A task whose session died restarts with the task text, plus a note that partial work is uncommitted in the worktree, and the reply is filed against the original message. This replaces release-and-resend. *Scally 1*
4. **Guard reads.** Today a session can read a neighbouring workspace's `.env` with Read, Grep or `cat`. Fix: add a `Read|Grep` hook matcher, a read check on shell commands, and a `guards.json` `"unreadable"` list (defaults: `.ssh`, `.env` but not `.env.example`, key files). *SF-DEV 18 (secrets.ts, hook-read.ts)*

## Later

- **The shell guard matches acts, not text.** Today a commit message that names `docs/assumptions.md` is blocked, which hit root on 2026-10-18. Blank quoted strings and heredoc bodies before matching, unless they are a write's target or go to a shell. *SF-DEV 10 (hook-bash.ts)*
- **`cell land` re-runs new or changed tests** N times (default 3), because a test the cell called passing failed 1 time in 3. It also runs the cell's own fold and lint on the merged result. *SF-DEV 11 (cellverify.ts)*
- **`constraint --quote`**, required when the voice is the operator's. It caught root adding a condition the operator never gave. *SF-DEV 8*
- **`drift.ts`**: lists a project's kernel edits beyond its contract points, and the upstream commits that will conflict with them. *SF-DEV 9*
- **An extension point** for a project's own lint and fold modules, so they can live outside `kernel/`. *SF-DEV 12*
- **Jobs**: a cell declares a long command, and root starts and watches it, one job per cell, tied to the log lock. *SF-DEV 4*
- **Traps (README)**: stress-test concurrency code; a tool path never runs for the first time on the only copy of anything; a session ends with no runners or stray worktrees left. *SF-DEV 7, 14 · Scally 7*

## Watching (not kit work yet)

- **Cells on another machine** (a transport over SSH). *SF-DEV 6*
- **Promoted builds**: the operator plays a promoted build, never main. This is project-shaped. *Scally 5*
- **Same message handed over twice** ("arrived again"). Not yet understood. *SF-DEV 13*
- **Maps, predictions, divergences.** Alpha, rule of three. *SF-DEV 12*

## Already in the kit

- Placeholder replies held back by the mail hook: Unreleased. *SF-DEV 2, 13 · Scally 2*
- Kernel tests failing from a cell worktree: fixed in v0.2. *SF-DEV 1*
- Shell heredocs eating backslashes: in Traps since v0.2.1. *SF-DEV 5*
- Landing stops on weaker tests: in v0.2.1. *Scally 4*
- `cell land`'s `dirty()` cutting a letter off a path: fixed in 58279f5. *SF-DEV 15*
