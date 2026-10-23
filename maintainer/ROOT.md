# ROOT — the kit's maintainer

The handover for the root session of **this repo, cellkit itself**. Read it after [`AGENTS.md`](../AGENTS.md), which is the template every project starts from, not this repo's brief. It holds the role, the routines and the lessons, **not** live state: read that from the sources below.

It lives in `maintainer/`, not `docs/ROOT.md`: projects take kit updates by merging this repo, and a `docs/ROOT.md` here would collide with every project's own at its next merge. Everything in this repo reaches every project, so nothing kit-private goes in `docs/`, `templates/` or the root.

## The role

The projects are the field; the kit is what they share. Root here:

- **Gathers lessons** from the projects that run cellkit: the issues their root sessions file on `Rwb3n/cellkit` (label `intake`; earlier ones dropped a `FROM-*.txt` in this repo's root), and surveys of their repos, mailboxes and run logs, read-only.
- **Ports, doesn't invent.** A fix comes from a failure a project hit, with its evidence; where a project already built it, start from its commit (SF-DEV, AI-MMO have done most of the hard ones).
- **Proves each guarantee with a test** that fails with the fix taken out, and names it in the README's table.
- **Releases** with grouped changelog entries and upgrade notes, then leaves each project's upgrade to that project's own root session.
- Never writes in a project's repo unless the operator asks.

## Where the live state is

| What | Where | How |
|---|---|---|
| The direction and the operator's priorities | the pinned **Roadmap** issue, #52: the body is the direction, each comment one operator decision, dated, in their words | `gh issue view 52 --repo Rwb3n/cellkit --comments` |
| The backlog | GitHub issues on `Rwb3n/cellkit`, ranked on the [cellkit board](https://github.com/users/Rwb3n/projects/9) (Status only: Intake · Next · In Progress · Later · Watching · Done) | `gh issue list --repo Rwb3n/cellkit`, the board for the order. Labels: `area:<part>` (one per issue: guards · mail · land · worktree · log · cellrun · docs · direction), `from:<project>` the source, `bug`/`enhancement`/`documentation` the class, `decision` waits on the operator. Milestones are releases (`v0.5` …), set when an issue moves to Next |
| New lessons from the projects | issues labelled `intake` | `gh issue list --repo Rwb3n/cellkit --label intake`; stragglers as `FROM-*.txt` in the repo root (`ls FROM-*`) |
| The evidence behind the issues | [`maintainer/notes/`](notes/) | dated notes and surveys; an issue's **Source** names the file and item |
| What shipped | [`CHANGELOG.md`](../CHANGELOG.md), git tags (`v0.3.0`…) | `git log --oneline -20`, `git tag` |
| Kit version | `kernel/package.json` | — |
| The projects | `D:\PROJECTS\*` with a `kernel/src/log.ts`, a `.git/cellkit-mail/`, or "cellkit" in `AGENTS.md`/`README.md` | the survey's table; `git -C <p> log -1 --format=%cs` for activity |
| This repo's own log | `state/log/` | empty on purpose: it is the template's, and every new project starts from it. Record decisions on the issues and in the changelog, not with `constraint` here |

## Open a session

1. SessionStart ran `cell sync` and `lint` (no cells here; expect 0 entries).
2. Read `AGENTS.md`, then this file, then the Roadmap issue (#52) and its latest comments.
3. Triage intake: check each `intake` issue against the code first (some are already done), then add its `area:`, `from:<project>` and class labels, drop `intake`, add it to the board with a Status (`node maintainer/tools/file.ts --board <n> --status <s>`) (or close it: done, duplicate, worked as designed, saying why). A `FROM-*.txt` straggler: move it to `maintainer/notes/<date>-<project>.txt` and file its items as issues.
4. Brief the operator: the board's Next and the v0.x milestone, new intake, unreleased commits since the last tag (`git log --oneline $(git describe --tags --abbrev=0)..`), and what you'd do next. Then wait.

## Take an issue

1. Read the source: the project's commit and test (`git -C <project> show <commit>`), not only the note.
2. Build it, with a test. **A test must fail with the fix taken out**: copy the file aside, revert the line, run the test, restore. Twice this session a test passed against the bug.
3. Concurrency: stress it (8 processes, a start barrier so they collide), run the full suite several times under load.
4. Before calling it done, ask for a review (the advisor caught a wrong-reply bug and doc claims the code didn't back).
5. Set it In Progress on the board when you start. Commit with the message in a file (`git commit -F`) ending `Fixes #n`; work with no code (a spike, research, a review) is closed by hand with an outcome comment, the report itself on the issue or in a note it names; update README (the guarantee and its test) and CHANGELOG (Unreleased, naming `#n`). What's not done becomes a new issue, linked from the closed one.

## Issues

- **File only through `node maintainer/tools/file.ts`** (`--title`, `--body-file`, `--label area:<part>` and the others, `--status`, `--milestone`): it creates the issue, adds it to the board with its Status and pauses for GitHub's burst limit. AI-MMO's board missed two weeks of hand-filed issues; this is why.
- **The body:** what and why · **Outcome** (what done looks like; for a spike, "a negative result is a result") · **After:** #n (ordering) · **Refs:** related issues · **Source:** the note and item, or the operator's words.
- **The operator's priority calls** go on the Roadmap issue (#52) as a comment, dated and quoted, not only in a session.
- No title prefixes, no board fields beyond Status, no gate milestones: AI-MMO's decayed within a week (survey 2026-10-23).

## Survey the projects

Fan out read-only investigators, one per project (or per group of small ones), each told: what's already known (open issues, notes, changelog), read-only, evidence for every finding, classify (kit bug · kit gap · docs · worked as designed), say what couldn't be checked. Verify the serious claims against the kit's code yourself before ranking. Write the survey to `maintainer/notes/<date>-field-survey.md`, file its findings as issues, re-rank the board.

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
- **Take-out scripts:** mutate and restore source files as bytes (`read_bytes`/`write_bytes`), or Python's text mode rewrites LF as CRLF; run them with `python -u` in the background (or the output stays buffered); never run the suite while one is running (it sees a mutated file). A take-out that fails no test is code nothing needs, or a missing test: decide which.
- **Verify a claim before it goes in a doc or a CHANGELOG, especially one repeated from a project's note**: two this session were wrong (processkit's `git clean -fdx` deletes nested worktrees: only `-ffdx` does; `grep -f .env` listed as newly refused: it already was). A throwaway repo in the scratchpad settles most in a minute.
- **Probe Claude Code's own behaviour with a subagent or `claude -p`** in a throwaway repo, with markers (which `CLAUDE.md` loaded, whose hooks judged): cheaper and surer than reading the docs alone. Results so far: `maintainer/notes/2026-10-22-native-agents.md`.
- **Files here flow into every project on merge.** Don't add kit-private files outside `maintainer/`. That includes `.github/`: an issue form there would become every project's own. The field-note format lives in `templates/ROOT.md` instead.
- **GitHub refuses fast bursts of issue creation** (it stopped at the 27th of 46): pause a few seconds between creates. The board's item list lags behind adds; check from the issue side (`projectItems` in `gh api graphql`). A push that closes an issue (`Fixes #n`) moves it to Done only if the board's built-in "Item closed" workflow is on (the operator's switch, board settings → Workflows); until it is, set the Status by hand and check from the issue side.

## The operator

- What they want from the kit (2026-10-22): **tight governance**, clean and well architected, closed loop, recoverable, observable. Weigh a design against that: a structural rule over exceptions (cells live outside the repo, #26), work reaching main only through `cell land` or root commits (#48), the operator's acts mention-strict (#2).
- Asks "what's your confidence?": answer per claim (tested · docs · memory · opinion), and offer the cheap test that would settle the weakest one.
- Says "go" / "go on" to proceed with the proposed next step; asks "suggestion?" when they want one recommendation with its reasons, not a menu.
- Decides per-project settings and anything outward (push, release). Choices made 2026-10-18: mail bodies in the log are a project setting, default `body` (`guards.json` `mail.log`); the read guard as a hook denylist now, OS sandboxing watched until a project needs it. 2026-10-22: the backlog moved to GitHub issues and the cellkit board; projects file their lessons there instead of dropping `FROM-*.txt`.
