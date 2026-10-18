# Field survey, 2026-10-18

The projects using cellkit, read by root (read-only), after the kit's notes from SF-DEV (to 10-15) and AI-MMO (to 10-09).
Each finding names its evidence in the project; the backlog (`../backlog.md`) holds what the kit will do about it.

| Project | Kit | State |
|---|---|---|
| callsheet (product repo, Next.js) | v0.2.1 `ed205f1`, no kernel drift | trial: 2 tasks landed; operator: "park it" (#67) |
| 01-HAIOS-PERS | 0.1 + `windows-guard-fixes`, 27 behind | cell loop used one day (10-09), root does cell work on main since |
| SF-DEV | v0.2.1 + declared drift | 4 cells, ~15 headless runs on 10-15 |
| AI-MMO (Python kernel) | own | sessions 7–9: orphans, recovery, keep-level, landing lock |
| project-archivist | `ed205f1`, no drift | a dead run has left its cell stuck for 7 days |
| live-stream-setup | `ed205f1`, no drift | stopped before `cell new`; one session's work uncommitted |

## Kit bugs

1. **A cell does its task before it is handed over.** `mail.ts` logs a task on the cell's log at send, so a session that reads its log finds and does it, then gets it from the Stop hook and does it again; its first answer is lost. 01-HAIOS-PERS (`money/runs/20261009T190401Z.jsonl`: "it was already in the log as entry 000008"), project-archivist (task 4: "I had already done the work after finding this task in my log"). Likely SF-DEV 13's "arrived again".
2. **A dead run leaves the cell stuck, and nothing says so.** project-archivist: run `20261011T142850Z` ends mid-task 16 with no result (cellrun most likely killed with its parent session); `.current` still names 16, task 17 queued, 2 replies unread, 13 log entries and 4 post edits uncommitted in the worktree, for 7 days. AI-MMO: `taskkill /F /IM python.exe` from another project killed every runner; their `claude -p` sessions lived on as orphans (d1b3deb). In cellkit 20cfefb a dead runner's lock is taken over even while its session still works, so a second session can start in the same worktree, and orphans don't count toward the 3.
3. **Shell guard: kernel-owned paths matched anywhere in the text.** `hook-bash.ts:52` is unanchored: SF-DEV's `mkdir -p test/fixtures/PORTOFOLIO-MANAGER/state/views` (a fixture) was refused, and the cell gave up on static fixtures. The message lists fixed paths, not the one matched (01-HAIOS-PERS: `state/out` reported as "state/log, state/views, …").
4. **Shell guard fails open on its own errors.** Only input parsing is caught; a check that throws exits 1, which Claude Code doesn't treat as blocking. AI-MMO found the same in theirs (#134, 897ee08: refuse on error, naming the check).
5. **Write/Edit can't reach the temp folder, the shell can** (SF-DEV run `sources/211643Z`).

## Kit gaps

6. **Cells run on stale bedrock and guards.** A kinds.json approved on main isn't in the cell's worktree, so the cell refuses valid claims (SF-DEV S-3c blocked); a read guard added on main didn't protect cells until main was merged in (`2c87840`, `9f28d63`). `worktree.ts` already reads main's guards for some checks; kinds and secrets don't. AI-MMO: cellrun merges main into a clean, idle cell before each run (849252f, 1f9b57a, ca8ec08), aborting a conflict and refusing to overwrite ignored files.
7. **Mail bodies go into the log, which is append-only.** callsheet's approved ontology rule 8 forbids personal data in any log; with tasks copied into the log in full, its Trust organ couldn't be a cell (#67). Needs an operator decision: a body hash plus a pointer, or a check at send.
8. **Abandonment goes unnoticed.** 01-HAIOS-PERS: worktrees 20 commits behind, all 68 writes since 10-10 on root's log, root editing `cells/*` and a binding on main. live-stream-setup: 18 log entries untracked on main. Lint could warn on both.
9. **Worktrees lack the app's dependencies.** callsheet linked `node_modules` by hand for `--check`; SF-DEV cells need the main checkout's `tsc`. `cell checkout` could link configured paths.
10. **Worktrees bind absolute Windows paths and the hooks need git.** callsheet's sandboxed run (OpenShell, WSL) turned the kit's hooks off and couldn't read the worktree's `.git` (`gitdir: D:/…`). `git worktree add --relative-paths`; a no-git mode for hooks.
11. **One landing at a time, and permanent worktrees locked.** AI-MMO: landing lock (main's hook refuses commit/merge/push meanwhile; runners wait), 633cf6b; worktrees made with `git worktree add --lock` so `prune`/`remove --force` refuse (6e5c18f).
12. **Writes outside the repo.** live-stream-setup's renders go to `D:\Videos\…`; callsheet's cell wrote `~/.processkit/evidence` unseen by audit. A binding could declare external roots.
13. **A template ontology was approved unedited** (live-stream-setup 000011–12). `amend`/`approve` could refuse template placeholders.
14. Smaller: the brief doesn't say where mail lives (every archivist and SF-DEV run first looks for `inbox/` in the cell); task paths are relative to what (callsheet trial 2); approving guards doesn't refresh briefs (callsheet `bd764b5`); two voice formats (`claude` vs `voice:kernel`); no recurring mail (callsheet #66); adoption into an existing product repo (README, skills and `CLAUDE.md` assume the kit is the repo); `drift.ts` should list kernel symbols a project imports (01-HAIOS-PERS `lifeos/` imports 9 modules); AI-MMO's reply recovery from the run log, exit notes, `--pause` after the head, `--stop`, joint land, landing's `Files:` check.

## Confirmed by the field

- `dirty()` cut paths (callsheet patched it twice by hand) — fixed 58279f5.
- callsheet's first headless run loaded 11 MCP servers and 91 tools — fixed 20cfefb.
- Weaker tests misfiring on prose (archivist's "-tests" slug rule can go) — fixed ed205f1.
- Worked as designed: a land refused while the database was down, retried clean (callsheet); audit caught a probe file; cells never wrote GitHub.

## Operator, quoted by the projects

- callsheet #67, 2026-10-17: "park it". Parked, not dropped; revisit with a second owner, cells on a Linux server, or real personal data to fence.
- 01-HAIOS-PERS checkpoint C-20261009-02: "Using the system finds its bugs."
