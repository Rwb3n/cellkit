# Changelog

## v0.2 — lessons from the projects (2026-10-09)

What carnet, 01-HAIOS-PERS, PS5-STUDY, SF-DEV, PORTOFOLIO-MANAGER, loyalty-code-app, AI-MMO and DTG ran into.

**Fixes**
- `worktree.test.ts` failed (25/26) whenever the kernel's tests ran from a cell's worktree, which is what the brief tells every cell to do. It now takes the main checkout's `node_modules`.
- `cli.ts --cell cells/<x>` run from the main checkout wrote the main checkout's copy of a cell that has a worktree. That forked the cell's chain. Writes now land in the worktree, as mail already did.
- A headless run that died mid-task left the cell refusing every later run (exit 3). `cellrun` now files a reply saying the task was not done; `mail.ts release --as <cell>` does the same by hand.
- The shell had no cell boundary (`cp x ../../kernel/…` passed). Redirects and file verbs aimed outside the cell are now refused.
- Removed carnet's `docs/models` leftover from `hook-guard.ts`.

**New**
- `cell land`: root's whole loop in one command, which undoes itself if any step fails.
- `cellkit.json`: project operator-only commands and script-written paths, read by both hooks. No more forks of `hook-bash.ts` and `hook-guard.ts`. See `templates/cellkit.example.json`.
- Bedrock: `stage --doc` records the base, `amend` refuses a stale copy, and `approve --proposal <entry>` (with several proposals pending it refuses to guess).
- `lint --all` lints every cell's log too.
- Assumptions can be parked with `evidence --note "parked: …"`.
- `templates/ROOT.md`: root's handover (role, where state lives, routines, lessons).

**Cell brief** (existing cells: `cell refresh --name <cell>`)
- A cell may write anywhere in its folder except its log. The old brief listed five folders, and a cell refused allowed work over it.
- `exit/` and `test/` are created at birth. Durable output goes in `exit/`, because `state/out/` is ignored except `metrics.json`.
- Work synchronously: no background work or sub-agents left running at the end of a turn.

**Taking it into a project**
1. Merge (see README, "Using it in a project").
2. Move any domain guards from `kernel/src/hook-*.ts` into `cellkit.json`, and take the kit's hook files as they are.
3. Run `cell refresh` for each cell, then commit and land.
