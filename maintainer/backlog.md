# Backlog

From the projects' notes in [`notes/`](notes/): SF-DEV (2026-10-10 to 10-15), AI-MMO "Scally" session 6 (2026-10-09), and the field survey of 2026-10-18 (callsheet, 01-HAIOS-PERS, SF-DEV, AI-MMO sessions 7–9, project-archivist, live-stream-setup; "survey N" below). Ranked; each line names its source. Re-ranked 2026-10-18.

## Next

(empty: pick from Later)

## Later

- **The shell guard matches acts, not text.** A commit message, a heredoc's `=>` or a fixture path that names a protected path is blocked (root 2026-10-18; SF-DEV runs 164435Z, 173850Z; archivist task 4). Blank quoted strings and heredoc bodies before matching, unless they are a write's target or go to a shell. *SF-DEV 10 · survey 4*
- **Lint notices abandonment**: a cell's worktree N commits behind main; root changing a cell's folder on main while it has a worktree; untracked log entries (and `/session-close` refuses them). *survey 8*
- **Worktrees**: `cell checkout` links configured root paths (`node_modules`, tools) into the worktree; `git worktree add --lock`. Not `--relative-paths`: it sets `extensions.relativeWorktrees`, which git before 2.48 refuses for the whole repo, and WSL's Ubuntu 24.04 ships 2.43 (the git it was meant to help). *survey 9–11*
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
- **Runner extras**: `--pause` after the head of the queue, `--stop` (kill an orphan's tree, only one the lock provably names), `--status`; the mail hook hands mail only to the lock holder's session; joint land (`--cells a,b`). *survey 14 (AI-MMO)*
- **Adapters: read, pure step, append.** A convention for the cell brief (no code): an adapter reads what it needs from the log, does one step that touches neither the log nor shared state (the only part it retries), then appends. A retry can then never half-write. PocketFlow's prep/exec/post (github.com/The-Pocket/PocketFlow, read 2026-10-18; the rest of it is in-process orchestration, a different layer). *outside: PocketFlow*
- **Traps (README)**: a tool path never runs for the first time on the only copy of anything; a session ends with no runners or stray worktrees left. *SF-DEV 14 · Scally 7*

## Watching (not kit work yet)

- **Cells on another machine or in a sandbox** (a transport over SSH; hooks without git; `cellrun` through a sandbox wrapper, as `CELLKIT_CLAUDE` already allows). callsheet ran a cell in NVIDIA OpenShell (WSL 2, experimental on Windows): writes and reads limited by the OS, network per binary, credentials injected outside; the kit's hooks were off inside and mail was carried by hand. Its operator named this as a reason to revisit. *SF-DEV 6 · survey 10 (callsheet #67, 556a6cb)*
- **Promoted builds**: the operator plays a promoted build, never main. This is project-shaped. *Scally 5*
- **Maps, predictions, divergences.** Alpha, rule of three. *SF-DEV 12*

## Already in the kit

- Read guard: kit defaults plus `guards.json` `unreadable`, Read/Grep hook and the shell: Unreleased. *SF-DEV 18*
- Shell guard correctness: fails closed; kernel-owned paths anchored, refusal names the path; Write/Edit temp exemption; no killing by name: Unreleased. Not done: a hook that can't load still fails open. *survey 3–5 · AI-MMO 897ee08*
- Cells run on main as it is: bedrock JSON read from the main checkout; `cellrun` merges main into a clean worktree first: Unreleased. Not done: a landing lock for runs to wait on. *survey 6*
- Dead runs and orphaned sessions: the lock holds the session's pid; recovery from the run log; `cellrun --resume`; exit notes; `run` in mail status: Unreleased. Not done: the session's creation time against pid reuse; `--stop`; the mail hook handing mail only to the lock holder's session. *survey 2 · Scally 1*
- A task reaches the cell's log at hand-over; mail bodies logged whole or hashed (`guards.json` `mail.log`, operator's choice 2026-10-18: a project setting, default body): Unreleased. *survey 1, 7 · SF-DEV 13*
- Light headless runs that queue for room: Unreleased (20cfefb). *Scally 1, 6 · survey: callsheet loaded 11 MCP servers*
- Log lock, and `assume` choosing its id under it: Unreleased (7b18ce8). *SF-DEV 3, 7 · Scally 3*
- Placeholder replies held back by the mail hook: Unreleased (2f2add6). *SF-DEV 2, 13 · Scally 2*
- `cell land`'s `dirty()` cutting a letter off a path: Unreleased (58279f5). *SF-DEV 15 · survey: callsheet patched it twice*
- Kernel tests failing from a cell worktree: fixed in v0.2. *SF-DEV 1*
- Shell heredocs eating backslashes: in Traps since v0.2.1. *SF-DEV 5*
- Landing stops on weaker tests: in v0.2.1; prose is never a test file (ed205f1). *Scally 4 · survey: archivist*
