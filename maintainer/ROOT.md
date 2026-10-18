# ROOT — the kit's maintainer

The handover for the root session of **this repo, cellkit itself**. Read it after [`AGENTS.md`](../AGENTS.md), which is the template every project starts from, not this repo's brief. It holds the role, the routines and the lessons, **not** live state: read that from the sources below.

It lives in `maintainer/`, not `docs/ROOT.md`: projects take kit updates by merging this repo, and a `docs/ROOT.md` here would collide with every project's own at its next merge. Everything in this repo reaches every project, so nothing kit-private goes in `docs/`, `templates/` or the root.

## The role

The projects are the field; the kit is what they share. Root here:

- **Gathers lessons** from the projects that run cellkit: their notes (`FROM-*.txt` dropped in this repo's root), and surveys of their repos, mailboxes and run logs, read-only.
- **Ports, doesn't invent.** A fix comes from a failure a project hit, with its evidence; where a project already built it, start from its commit (SF-DEV, AI-MMO have done most of the hard ones).
- **Proves each guarantee with a test** that fails with the fix taken out, and names it in the README's table.
- **Releases** with grouped changelog entries and upgrade notes, then leaves each project's upgrade to that project's own root session.
- Never writes in a project's repo unless the operator asks.

## Where the live state is

| What | Where | How |
|---|---|---|
| What's next | [`maintainer/backlog.md`](backlog.md) | Next · Later · Watching · Already in the kit; each line names its source |
| The projects' lessons | [`maintainer/notes/`](notes/) | dated; the latest survey is the newest `*-field-survey.md` |
| New notes not yet filed | `FROM-*.txt` in the repo root | `ls FROM-*` |
| What shipped | [`CHANGELOG.md`](../CHANGELOG.md), git tags (`v0.3.0`…) | `git log --oneline -20`, `git tag` |
| Kit version | `kernel/package.json` | — |
| The projects | `D:\PROJECTS\*` with a `kernel/src/log.ts`, a `.git/cellkit-mail/`, or "cellkit" in `AGENTS.md`/`README.md` | the survey's table; `git -C <p> log -1 --format=%cs` for activity |
| This repo's own log | `state/log/` | empty on purpose: it is the template's, and every new project starts from it. Record decisions in the backlog and the changelog, not with `constraint` here |

## Open a session

1. SessionStart ran `cell sync` and `lint` (no cells here; expect 0 entries).
2. Read `AGENTS.md`, then this file.
3. File new notes: `git mv`/move `FROM-*.txt` to `maintainer/notes/<date>-<project>.txt`, triage them into the backlog (check each against the code first: some are already done).
4. Brief the operator: backlog Next, unfiled notes, unreleased commits since the last tag (`git log --oneline $(git describe --tags --abbrev=0)..`), and what you'd do next. Then wait.

## Take a backlog item

1. Read the source: the project's commit and test (`git -C <project> show <commit>`), not only the note.
2. Build it, with a test. **A test must fail with the fix taken out**: copy the file aside, revert the line, run the test, restore. Twice this session a test passed against the bug.
3. Concurrency: stress it (8 processes, a start barrier so they collide), run the full suite several times under load.
4. Before calling it done, ask for a review (the advisor caught a wrong-reply bug and doc claims the code didn't back).
5. Commit with the message in a file (`git commit -F`), update README (the guarantee and its test), CHANGELOG (Unreleased), and the backlog (move it to "Already in the kit", with what's not done).

## Survey the projects

Fan out read-only investigators, one per project (or per group of small ones), each told: what's already known (backlog, notes, changelog), read-only, evidence for every finding, classify (kit bug · kit gap · docs · worked as designed), say what couldn't be checked. Verify the serious claims against the kit's code yourself before ranking. Write the survey to `maintainer/notes/<date>-field-survey.md`, re-rank the backlog.

## Release

1. CHANGELOG: turn Unreleased into `## vX.Y — <title> (<date>)`, grouped, with **Upgrading a project** notes (refresh cells, settings changes, `.gitignore` lines, new exit codes, behaviour that now refuses).
2. `kernel/package.json` version. Full suite, typecheck, lint.
3. Commit, `git tag -a vX.Y.Z`, push `main` and the tag (the operator's go).

## Lessons (keep them)

- **This repo runs its own hooks.** A broken `kernel/src/hook-bash.ts` refuses every shell command of this session (it fails closed). Fix it with the Edit tool, which goes through `hook-guard`, not the shell.
- **The guards are mention-strict for some rules.** A heredoc or commit message that names a kernel-owned path, `taskkill /IM`, or `cat .env` is refused. Commit messages via a file; tests that contain guarded text via the Write/Edit tools; edit scripts as files in the scratchpad, run with `python <file>`.
- **No backslash-bearing text through a shell heredoc** (regexes): write the file, then run it.
- **Test fixtures vanish:** `world()` temp repos are removed after each test; to debug, print from inside the test.
- **A fake `claude`:** `CELLKIT_CLAUDE` pointing at a `.cmd` shim around a `.mjs` that prints stream-json (`{"type":"result",…}`) exercises `cellrun` end to end, the cmd.exe quoting included.
- **Run logs:** `-p --output-format stream-json` writes one `result` line per turn; the Stop hook's hand-over shows as a user line naming the task id.
- **`git worktree add --relative-paths`** marks the whole repo for git ≥ 2.48; WSL's Ubuntu 24.04 has 2.43. Not used.
- **Files here flow into every project on merge.** Don't add kit-private files outside `maintainer/`.

## The operator

- Says "go" / "go on" to proceed with the proposed next step; asks "suggestion?" when they want one recommendation with its reasons, not a menu.
- Decides per-project settings and anything outward (push, release). Choices made 2026-10-18: mail bodies in the log are a project setting, default `body` (`guards.json` `mail.log`); the read guard as a hook denylist now, OS sandboxing watched until a project needs it.
