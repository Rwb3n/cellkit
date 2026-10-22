# Native Claude Code agents vs cellkit's runner (#47), 2026-10-22

The operator asked whether cellkit adds value over native subagents. Short answer: native agents do delegation well and the kit should use them inside sessions, but they can't be cells. A cell's guarantees come from its own session in its own folder, and that is what `cellrun` already launches natively (`claude -p` with the cell folder as cwd). The question narrows to the plumbing around that launch.

Sources: two spikes in this repo with Claude Code 2.1.295 (**tested**), and the Claude Code docs at code.claude.com/docs/en/ read by a docs agent (**docs**: sub-agents, hooks, headless, worktrees, sessions, agent view, agent teams, workflows, routines, Agent SDK). "Not documented" means the docs agent found nothing, not that the feature is absent.

## What a subagent gets

| | Finding | Basis |
|---|---|---|
| Hooks | The parent session's settings hooks run for a subagent's tool calls. A frontmatter `hooks` adds to them while it runs; it doesn't replace them | docs (sub-agents) |
| `$CLAUDE_PROJECT_DIR` | The parent's project root, even in an `isolation: "worktree"` subagent. In spike 2 the subagent's `git checkout -- <main>/docs/assumptions.md` was refused, and `git checkout -- <its worktree>/docs/assumptions.md` was **allowed**: root's hook judged it as root, and a cell's boundary (which needs the project dir to be the cell, with `binding.json`) would never apply | **tested** · docs (worktrees: "hook paths don't follow the worktree") |
| Folder | No `cwd` field: a subagent starts in the parent's folder. Worktree isolation puts it at `<repo>/.claude/worktrees/agent-<id>`, nested in the main checkout | **tested** · docs |
| Instructions | The CLAUDE.md hierarchy of the main conversation, not the worktree's; AGENTS.md isn't mentioned | docs |
| Persistence | Continued with SendMessage within the session; transcripts kept 30 days. Surviving the parent's end, or being resumed from a new session: not documented | docs |
| Concurrency | At most 20 at once; a spawn beyond fails ("Concurrent subagent limit reached"), with no queue. No memory admission | docs |
| PreToolUse | Subagent calls carry `agent_id` and `agent_type` | docs |

So a subagent can't be a cell: it has root's hooks, root's project dir, root's instructions and no persistence across sessions. That rules out the Agent tool as a replacement for `cellrun`.

## What else native offers, and what it means

- **Headless `claude -p` (what cellrun uses).** The session id is in the stream-json result. `claude -p --resume <id>` restores history, model and agent, re-reads `settings.json` hooks, and re-enters a bound worktree; it does **not** restore the permission mode, `--mcp-config` or `--settings`, which must be passed again. `-p` stops still-running background work after 10 minutes of idle waiting (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`). **Consequence:** `cellrun --resume` could continue the dead session itself (`--resume <session_id>` with the same flags) instead of starting a fresh one; that is a smaller change than more recovery code. (docs)
- **Background sessions (`claude --bg`, agent view).** Full sessions that survive the terminal closing; a supervisor restarts crashed ones and, when memory stays low, stops idle ones. Whether they load the folder's `.claude` hooks is not documented, and `-p` rejects `--bg`. **The closest native match for a detached cell run**, worth one spike before building more runner code. (docs)
- **Agent SDK.** `query()` with `cwd` set to the cell loads `<cwd>/.claude/settings.json` hooks (no parent fallback) and CLAUDE.md from cwd up. A typed alternative to spawning the CLI, under the same rules. (docs)
- **Agent teams, workflows, routines, cloud sessions.** Teams are experimental and interactive-only; workflow agents' folder and hooks aren't documented; routines and cloud sessions run on a fresh clone, not the local worktree. None fits a cell. (docs)
- **The "reaper".** Projects reported Claude Code's background-job reaper killing runs (AI-MMO, apify-actor-dev). The documented mechanisms are the agent-view supervisor's low-memory stop (background sessions) and `-p`'s 10-minute idle cap; neither is a general admission. **The kit's slots and memory wait stay.** (docs)

## Outcome for the issues

- **#36 runner extras: keep.** Add one item: `--resume` continues the dead session natively (`claude -p --resume <session_id>`, re-passing `--permission-mode`, `--strict-mcp-config`). Spike `claude --bg` in a cell before adding `--stop`/`--status`; the supervisor may cover them.
- **#34 jobs: keep.** Nothing native admits or detaches a root job that survives the session and is logged.
- **#12 one landing at a time: keep.** Nothing native.
- **#26 where worktrees live:** native isolation already nests worktrees in the main checkout (`.claude/worktrees/`), and root's guard doesn't protect kernel-owned files there (spike 2). Evidence for the nested-worktree risks, whichever way the operator decides.
- **Inside sessions:** root and cells should use native subagents for fan-out, review and research. Nothing in the kit needs to change for that; their writes are judged by the session's own hooks.
