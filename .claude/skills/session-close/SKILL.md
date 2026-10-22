---
name: session-close
description: Hand over the project's root session cleanly before a break, compaction or a new session — land or record in-flight work, log decisions, sync, lint, push. Use when the operator says they're stopping, taking a break, or wants a handover.
---

# Session close — root

The next root session (fresh, compacted, or another model) must be able to resume from the repository, the logs and the mailboxes alone. See [`docs/ROOT.md`](../../../docs/ROOT.md) → "Hand over".

## Steps

1. **Replies:** land every reply you have verified with `cell land`. Don't leave cell work sitting uncommitted in a worktree.
2. **In flight:**
   - Every task still out is visible in `node kernel/src/mail.ts status --as <cell>` (`working_on`, or unread).
   - If a background `mail.ts watch` is running, say so: the next session takes the reply with `mail.ts watch --as root`.
3. **Decisions and guesses from this session** must be on the log, not only in chat:
   - `constraint` for what the operator decided;
   - `assume` and `evidence` for guesses and what moved them.

   Bedrock changes you proposed are staged and amended; tell the operator which wait for their approval.
4. **Working tree:** `git status`. Commit your finished work. Root's log entries go with it (`cell land` commits its own). Explain anything you leave uncommitted on purpose.
5. **State:** run `node kernel/src/cli.ts cell sync`, then `node kernel/src/cli.ts lint --all`. Both must be clean.
6. **Push** to the backup remote.
7. **Handover:** if a routine or lesson changed this session, update `docs/ROOT.md`. Lint warns when it is 20 commits stale. Live state never goes in it.
8. **Lessons for the kit:** anything this session learnt about the kit itself goes upstream as an issue, one per lesson, as [`templates/ROOT.md`](../../../templates/ROOT.md) → "Lessons for the kit" says (the kit's copy, which a kit merge keeps current; your `docs/ROOT.md` may predate it). Show the operator the drafts first; post only on their go.
9. **Tell the operator** in a few lines:
   - what's done;
   - what's in flight, and where its reply will land;
   - what's waiting on them (approvals, reviews, decisions);
   - what the next session should do first.
