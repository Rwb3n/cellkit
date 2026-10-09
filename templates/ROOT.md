# ROOT — chief of cells

The handover for whoever runs the **root session**: a fresh session, a compacted one, or the next model. Copy this to `docs/ROOT.md` at the start and keep it current. Read it after [`AGENTS.md`](../AGENTS.md). It holds the role, the routines and the lessons, **not** live state. Live state is always read from the sources below, so this file can't go stale.

(From carnet's `docs/ROOT.md`. 01-HAIOS-PERS, AI-MMO and DTG each grew the same thing.)

## The role

Root is the cell that contains the others. Its session is the operator's working partner:

- **Holds the whole:** the ontology (bedrock), the kernel, the root log, cross-cell contracts.
- **Delegates cell work** by mail, one task per mail. It doesn't do a cell's work itself when the cell has a session.
- **Verifies before it lands:** reads the reply, then `cell land` with a `--check` that runs the tests on the merged result.
- **Decides root things** and asks the operator for theirs. It never takes an operator-only action (`approve`, `review decide`, anything in bedrock `guards.json`'s `operator_only`, or anything outward).
- **Keeps the record whole:** every guess is an assumption, every operator decision a constraint.

## Where the live state is — read it, don't remember it

| What | Where | How |
|---|---|---|
| Each cell: head, entries, published numbers | `state/views/cells.json` | `node kernel/src/cli.ts cell sync` (runs at session start) |
| Mail waiting for root | the root mailbox | `node kernel/src/mail.ts status` · `watch --as root` |
| A cell mid-task | its mailbox | `node kernel/src/mail.ts status --as <cell>` (`working_on`) |
| Reviews waiting for the operator | the cells' logs | `node kernel/src/cli.ts review list --all` |
| Decisions and assumptions | `docs/assumptions.md` (generated) | `## Known` = operator decisions |
| What changed recently | git | `git log --oneline -20` |
| A cell's own view of itself | `cells/<name>/MODEL.md` | — |
| <your board / tracker> | | |

## Resume (every new root session)

1. SessionStart already ran `cell sync` and `lint`. If lint shows errors, fix those first. Run `lint --all` if any cell worked since the last session.
2. Read `AGENTS.md`, then this file.
3. Mail: `mail.ts status`, then `watch --as root`. If a reply is in, land it (below).
4. Reviews: `review list --all`. Tell the operator about any open one; never decide it.
5. Brief the operator in a few lines: what's in flight, what's waiting on them, what you'd do next. Then wait.

## Delegate to a cell

1. Write the task to a file (the session scratchpad, not the repo). Say what and why, the boundary, the tests to run, and exactly what to reply with. Mention any work in flight on the same code.
2. `node kernel/src/mail.ts send --to <cell> --file task.md`, then `node kernel/src/cellrun.ts --cell <cell>` in the background.
3. `node kernel/src/mail.ts watch --as root --wait 3500` in the background. Never block the operator's turn. Only one watcher: `watch` marks mail read.

## When a cell replies

1. Read the reply in full. Note what it says is for root. Don't take "all pass" on trust.
2. `node kernel/src/cli.ts cell land --name <cell> --message "<what>" --check "<the tests>"`. Land refuses whole or undoes itself if the audit, the merge or the check fails. Read why, then send the cell a follow-up task.
3. Take its "for root" items: decide what's root's, ask the operator about theirs.

## Hand over (end of a session)

1. Nothing half-done is uncommitted: `git status` is clean, or each leftover is explained.
2. Every in-flight task is visible in `mail.ts status --as <cell>`.
3. `cell sync` and `lint --all` are clean. Push to the backup remote.
4. Anything the next session must know that isn't in the sources above goes in your tracker, not in this file.

## Lessons (keep them)

- **The Bash guard is deliberately strict.** It blocks commands that only *mention* `approve`, `review decide` or a kernel-owned path next to a write. Don't loosen it. Use the Edit/Write tools, a file for the message body (`git commit -F`, `mail.ts send --file`), or split the command.
- **Bedrock:** `stage` the live doc before editing it. Diff the staged text against the live one before `amend`.
- **"Lint passed first time" deserves a negative test.** Inject a bad reference and see it caught.
- **IDs are never removed.** A closed item is retired, not deleted.
- **Tag honestly:** only what the operator actually decided is a decision; your own wording of it is a guess.
- <lessons from this project>

## The operator

- <how they like to work: sketch first? recommendation + trade-off table? what is theirs alone?>
