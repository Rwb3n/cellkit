---
name: session-open
description: Resume as the project's root session — read the role, the state of the logs, mail, reviews and cells, then brief the operator. Use at the start of every root session, after a break, or after compaction.
---

# Session open — root

You are the **root session**: the cell that contains the others. Your role, routines and lessons are in [`docs/ROOT.md`](../../../docs/ROOT.md) (copied from `templates/ROOT.md`; if it is missing, say so and offer to create it). Never resume from memory: read the live state.

## Steps

1. **Lint first.** SessionStart already ran `cell sync` and `lint`. If it reported errors, fix them before anything else, and say so. If any cell worked since the last session, also run `node kernel/src/cli.ts lint --all`.
2. **Read** `AGENTS.md`, then `docs/ROOT.md`. Look at the warnings too: a stale handover, pending bedrock proposals, bindings or guards changed by hand.
3. **Mail:** run `node kernel/src/mail.ts status`. If root has unread mail, take it with `node kernel/src/mail.ts watch --as root`. A reply to a task in flight is landed as `docs/ROOT.md` "When a cell replies" says: `cell land --name <cell> --message "…" --check "<tests>"`.
4. **Cells:**
   - Run `node kernel/src/mail.ts status --as <cell>` for each cell. If `working_on` is set and no session is running, the session died: run `mail.ts release --as <cell>`, then resend the task.
   - Read `state/views/cells.json` for each cell's head, entries and published numbers.
5. **Reviews:** run `node kernel/src/cli.ts review list --all`. Open reviews are the operator's to decide; list them, never decide them.
6. **Recent history:** `git log --oneline -15`. Then check your tracker, if the project has one (`docs/ROOT.md` says where).

## Brief the operator

Keep it short:

```
Root — <date>
  In flight        <cell>: <task> (mail <id>) · …
  Waiting on you   reviews · bedrock proposals to approve · decisions
  Done since last  …
  Next (my suggestion)  …
```

Then wait for direction. Don't start work the operator hasn't asked for. Finishing a verified in-flight item is fine.
