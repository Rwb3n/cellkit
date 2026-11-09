// Land a cell's work: root's loop (README "Root's loop") as one command, so no step is skipped. 01-HAIOS-PERS lost six
// hours to two cell-log entries left uncommitted in a worktree; AI-MMO and PS5-STUDY did these steps by hand each time.
//
//   node kernel/src/cli.ts cell land --name <cell> [--message "…"] [--check "<command>"] [--into <branch>] [--dry-run]
//   ! node kernel/src/cli.ts cell land … --accept-weaker "<why>"      (operator only)
//
// Refused whole, before anything changes, when: the cell has no worktree · its session is working on a message ·
// root's checkout is not on <into> (default: the branch it is on) · root has uncommitted work of its own (anything but
// state/log/, state/views/, docs/assumptions.md: mail and sync write those) · `cell audit` finds a change outside
// cells/<name>/ · the worktree holds git-ignored files outside the project's `land.ignored` allowlist, if it set one.
// Then, stopping at the first failure and undoing what it did on the cell's branch:
//   1. commit the cell's uncommitted work on its branch (pathspec cells/<name> and the paths it owns)
//   2. merge <into> into the cell's branch (a conflict: abort, and leave it to root in the worktree)
//   3. audit again, and run --check in the worktree (e.g. "cd kernel && npm test"): the merged result is what is tested;
//      then the allowlist again (what the check left behind), and the report says which of the main checkout's
//      git-ignored paths the check ran without
//   4. merge the cell's branch into <into> with --no-ff (one revertable commit: git revert -m 1 <it>)
// Before 2, the cell's tests must not have got weaker (weaker.ts): fewer cases or assertions, skips or loosening added.
// If they did, the land stops; the operator alone lands it anyway, with --accept-weaker "<why>" (hook-blocked for
// agents), and the reason goes into the merge commit.
// The CLI then syncs the cell and commits root's log (commitRootLog), so mail entries never sit uncommitted.
import { spawnSync } from 'node:child_process';
// --check runs through the system shell: cmd.exe on Windows (`(cd x && …)` doesn't scope the cd there), else /bin/sh
const SHELL = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
const runCheck = (check: string, cwd: string) => spawnSync(check, { cwd, shell: true, encoding: 'utf8' });
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { status } from './mail.ts';
import { configPath, loadConfig } from './config.ts';
import { globRe } from './glob.ts';
import { weakerTests } from './weaker.ts';
import { cellAudit, cellBranch, cellWorktree, currentBranch, inMain, WorktreeError } from './worktree.ts';

const ROOT_WRITTEN = [/^state\/log\//, /^state\/views\//, /^docs\/assumptions\.md$/];

function git(dir: string, args: string[], check = true): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8' });
  const out = (r.stdout + r.stderr).trim();
  if (check && r.status !== 0) throw new WorktreeError(`git ${args.join(' ')}: ${out}`);
  return { ok: r.status === 0, out };
}
// Not git(): its trim() takes the leading space of an unstaged first line (" M docs/x"), and slice(3) then cut a
// letter off the path (SF-DEV: the next land refused "ocs/assumptions.md" as root's own work).
export function dirty(dir: string): string[] {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.quotepath=off', 'status', '--porcelain=v1', '-uall'], { encoding: 'utf8' });
  if (r.status !== 0) throw new WorktreeError(`git status: ${(r.stdout + r.stderr).trim()}`);
  return r.stdout.split(/\r?\n/).filter(Boolean)
    .flatMap((l) => l.slice(3).split(' -> ').map((p) => p.trim().replace(/^"|"$/g, '')));
}
const head = (dir: string) => git(dir, ['rev-parse', 'HEAD']).out;

// Git-ignored files. Git never shows them, so nothing else in a land accounts for them:
//   - in the cell's worktree (#77; COCKPIT: 8 MB of real-data output left in an ignored test/tmp/, found by hand): every
//     land lists them, and once the project sets bedrock guards.json `land.ignored`, refuses any outside that allowlist,
//     before it starts and again after the check (a check that leaves data behind is the same leftover);
//   - in the main checkout but not the worktree (#68; ecom-lab: a test read the repo's ignored data/, found none in the
//     worktree and passed, then failed where the data was): a land with a check names them beside the result.
// In the worktree one thing is left out: the views fold writes (state/views/<name>.json, the root's or a cell's). They
// are named by place and extension, not content: a file put there under such a name is not seen. Everything else is
// listed and judged, a stale state/log.lock, a kernel/node_modules/ or a .claude/ file included (a cell's worktree has
// none by design), and any other folder that merely has such a name (a review found data passing under them).
const VIEW = /^(cells\/[^/]+\/)?state\/views\/[^/]+\.json$/;
// In the main checkout, where the list only names what the check ran without, what the kit and Claude Code keep there.
const MAIN_LOCAL = [/^(cells\/[^/]+\/)?state\/views\//, /^(cells\/[^/]+\/)?state\/log\.lock$/, /^kernel\/node_modules\//, /^\.claude\/(settings\.local\.json$|worktrees\/)/];
interface IgnoredFile { path: string; bytes: number }
export interface Ignored { entry: string; files: IgnoredFile[] }

// Git's own list of what it ignores. Plain, it names every file (a nested repository as its folder); with --directory, a
// folder ignored whole is one name. Never --no-empty-directory: with it git leaves out the ignored files of a folder it
// doesn't track yet (a review found a land completing over them).
function lsIgnored(dir: string, folders: boolean): string[] {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.quotepath=off', 'ls-files', '-z', '-o', '-i', '--exclude-standard', ...(folders ? ['--directory'] : [])],
    { encoding: 'utf8', maxBuffer: 1 << 29 });
  if (r.status !== 0 || r.error) throw new WorktreeError(`git ls-files: ${(r.stdout + r.stderr).trim() || r.error?.message}`);
  return r.stdout.split('\0').filter(Boolean).sort();
}
// The folders git ignores whole, outermost only (the list is sorted: a folder's own entries follow it).
function wholeFolders(dir: string): string[] {
  const out: string[] = [];
  for (const p of lsIgnored(dir, true)) if (p.endsWith('/') && !(out.length && p.startsWith(out.at(-1)!))) out.push(p);
  return out;
}
function filesUnder(dir: string, rel: string): IgnoredFile[] {
  try {
    const st = lstatSync(join(dir, rel));
    if (!st.isDirectory()) return [{ path: rel, bytes: st.size }];
    const base = rel.replace(/\/$/, '');
    return readdirSync(join(dir, rel)).flatMap((n) => filesUnder(dir, `${base}/${n}`));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];          // gone since git listed it
    throw new WorktreeError(`can't read the git-ignored ${rel} in ${dir}: ${(e as Error).message}`);   // there, and unseen: no land
  }
}
const hasFile = (dir: string, rel: string): boolean => {
  try { return !lstatSync(join(dir, rel)).isDirectory() || readdirSync(join(dir, rel)).some((n) => hasFile(dir, `${rel.replace(/\/$/, '')}/${n}`)); }
  catch { return false; }
};
// Every git-ignored file in a checkout, with its size. The files come from git's plain list, so the count never depends
// on how folders are grouped; the grouping (a folder ignored whole is one entry, "data/") is for the report alone.
export function ignoredEntries(dir: string): Ignored[] {
  const folders = new Set(wholeFolders(dir));
  const by = new Map<string, IgnoredFile[]>();
  for (const f of lsIgnored(dir, false).flatMap((p) => filesUnder(dir, p)).filter((x) => !VIEW.test(x.path))) {
    const parts = f.path.split('/');
    let entry = f.path;
    for (let i = 1, at = ''; i < parts.length; i++) { at += `${parts[i - 1]}/`; if (folders.has(at)) { entry = at; break; } }
    if (!by.has(entry)) by.set(entry, []);
    by.get(entry)!.push(f);
  }
  return [...by].map(([entry, files]) => ({ entry, files }));
}
const SHOWN = 12;
const more = (shown: string[], n: number) => shown.join(' · ') + (n > SHOWN ? ` · and ${n - SHOWN} more` : '');
const size = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const bytesOf = (e: Ignored) => e.files.reduce((s, f) => s + f.bytes, 0);
// the largest first (ecom-lab's market held 1.3 GB in three of sixteen entries), and the sum when there are several
const show = (es: Ignored[]) => (es.length > 1 ? `${es.length} entries, ${size(es.reduce((s, e) => s + bytesOf(e), 0))} in all: ` : '')
  + more([...es].sort((a, b) => bytesOf(b) - bytesOf(a)).slice(0, SHOWN)
    .map((e) => `${e.entry} (${e.entry.endsWith('/') ? `${e.files.length} file(s), ` : ''}${size(bytesOf(e))})`), es.length);

// What the worktree holds that git ignores: a line for the land's report, and why the land must stop, if it must.
function leftovers(main: string, wt: string, name: string): { note: string | null; refuse: string | null } {
  const cfg = loadConfig(configPath(main));                               // an invalid one never gets here: the audit refuses it
  const all = ignoredEntries(wt);
  if (!all.length) return { note: null, refuse: null };
  if (!cfg.landIgnored) return { note: `git-ignored in the worktree, not landed: ${show(all)}`, refuse: null };
  const allow = cfg.landIgnored.map(globRe);
  const over = all.map((e) => ({ entry: e.entry, files: e.files.filter((f) => !allow.some((re) => re.test(f.path.toLowerCase()))) })).filter((e) => e.files.length);
  return { note: `git-ignored in the worktree, not landed (allowed by land.ignored): ${show(all)}`,
    refuse: over.length ? `cell ${name}'s worktree holds git-ignored files that bedrock guards.json (land.ignored) doesn't allow: ${show(over)}\nDelete them (what a run left behind doesn't outlive it), or propose them for land.ignored (the operator approves)` : null };
}
// The git-ignored paths the main checkout holds files in and the worktree doesn't (an empty folder of the same name is
// not the data): what the check ran without. Names only: the main checkout can hold whole clones.
function absent(main: string, wt: string): string | null {
  const names: string[] = [];
  for (const p of lsIgnored(main, true)) if (!MAIN_LOCAL.some((r) => r.test(p)) && !(names.length && names.at(-1)!.endsWith('/') && p.startsWith(names.at(-1)!))) names.push(p);
  const lacks = names.filter((p) => hasFile(main, p) && !hasFile(wt, p));
  return lacks.length ? `the check ran without the main checkout's git-ignored paths: ${more(lacks.slice(0, SHOWN), lacks.length)} (the worktree holds no file there: a test that reads one passes here whatever it holds)` : null;
}

export interface LandOptions { name?: string; message?: string; check?: string; into?: string; dryRun?: boolean; acceptWeaker?: string }

export function cellLand(root: string, o: LandOptions): string[] {
  const main = inMain(root), name = o.name ?? '';
  const wt = cellWorktree(main, name);
  if (!wt) throw new WorktreeError(`cell ${name} has no worktree (node kernel/src/cli.ts cell checkout --name ${name})`);
  const busy = status(join(wt, 'cells', name)).working_on;
  if (busy) throw new WorktreeError(`cell ${name} is working on ${busy}; land it after its reply (if its session died: node kernel/src/cellrun.ts --cell ${name} --resume)`);
  const into = o.into ?? currentBranch(main);
  if (currentBranch(main) !== into) throw new WorktreeError(`the main checkout is on ${currentBranch(main)}, not ${into}`);
  const mine = dirty(main).filter((p) => !ROOT_WRITTEN.some((r) => r.test(p)));
  if (mine.length) {
    // #89 (ecom-lab: the operator's .vscode/settings.json stopped a verified landing). An untracked file still stops
    // it: root's own new work looks the same, and nothing unaccounted for sits in root when a cell lands. But say the
    // way out for a file that isn't the project's, which is neither committing nor deleting someone else's file.
    // not git(): its trim() takes a leading space off the first name
    const loose = new Set(spawnSync('git', ['-C', main, '-c', 'core.quotepath=off', 'ls-files', '-z', '-o', '--exclude-standard'], { encoding: 'utf8' }).stdout.split('\0').filter(Boolean));
    const foreign = mine.filter((p) => loose.has(p));
    throw new WorktreeError(`root has uncommitted work of its own: ${mine.join(', ')} (commit or stash it first${foreign.length
      ? `; an untracked file that isn't the project's, such as editor settings, can be ignored on this machine instead: add its path to .git/info/exclude (untracked here: ${foreign.join(', ')})` : ''})`);
  }
  const bad = cellAudit(main, name);
  if (bad.length) throw new WorktreeError(`cell ${name} changed paths outside cells/${name}/: ${bad.join(', ')}`);
  const left = leftovers(main, wt, name);
  if (left.refuse) throw new WorktreeError(left.refuse);

  const branch = cellBranch(name), message = o.message ?? `cell ${name}: work`;
  const pending = dirty(wt);
  const weakerNote = (w: string[]) => `the cell's tests got weaker:\n  ${w.join('\n  ')}\nLand it anyway only on the operator's word: ! node kernel/src/cli.ts cell land --name ${name} … --accept-weaker "<why>"`;
  const strayNote = (paths: string[]) => `the check left uncommitted paths in the worktree: ${more(paths.slice(0, SHOWN), paths.length)}`;
  if (o.dryRun) {
    const plan = [
      pending.length ? `would commit ${pending.length} path(s) on ${branch}: "${message}"` : `nothing uncommitted on ${branch}`,
      ...((w) => (w.length ? [`would stop: ${weakerNote(w)}`] : []))(weakerTests(wt, git(wt, ['merge-base', into, 'HEAD']).out)),
      `would merge ${into} into ${branch}${o.check ? `, then run in ${wt} under ${SHELL}: ${o.check}` : ''}`,
    ];
    if (o.check) {
      // the check is the step most likely to fail (COCKPIT #76: a subshell cd that cmd.exe doesn't scope): run it now, on
      // the worktree as it stands, before the merge; then read what it left behind, as the land does
      const r = runCheck(o.check, wt);
      plan.push(r.status === 0 ? 'the check passes now, before the merge'
        : `would stop: the check fails now, before the merge (exit ${r.status}):\n${(r.stdout + r.stderr).trim().split(/\r?\n/).slice(-15).join('\n')}`);
      const l = leftovers(main, wt, name), a = absent(main, wt), stray = dirty(wt).filter((p) => !pending.includes(p));
      if (l.refuse) plan.push(`would stop: ${l.refuse}`);
      else if (l.note) plan.push(l.note);
      if (a) plan.push(a);
      if (stray.length) plan.push(strayNote(stray));
    } else if (left.note) plan.push(left.note);
    return [...plan, `would merge ${branch} into ${into} (--no-ff), sync the cell and commit root's log`];
  }

  const steps: string[] = [];
  const start = head(wt);
  if (pending.length) {
    // the cell's folder, and each path it owns that has changes (git refuses a pathspec matching nothing)
    const owned = (loadConfig(configPath(main)).owns[name] ?? []).filter((g) => pending.some((p) => globRe(g).test(p.toLowerCase())));
    const spec = [`cells/${name}`, ...owned.map((g) => `:(glob)${g}`)];
    git(wt, ['add', '-A', '--', ...spec]);
    git(wt, ['commit', '-q', '-m', message, '--', ...spec]);
    steps.push(`committed on ${branch}: ${head(wt).slice(0, 9)}`);
  }
  const committed = head(wt);
  const weaker = weakerTests(wt, `${into}...${committed}`);
  // Back to before the land: drop the merge (all work was committed, so --hard loses nothing), then un-commit the
  // cell's work, leaving it staged in the worktree as it was.
  const undo = (why: string): never => {
    git(wt, ['merge', '--abort'], false);
    const hard = git(wt, ['reset', '--hard', '-q', committed], false).ok;
    const soft = git(wt, ['reset', '--soft', '-q', start], false).ok;
    // said only if true: an undo runs when something already failed, and its own git commands can fail the same way
    // (both resets, not the head alone: a --hard that fails on a locked file leaves the merge in the tree)
    const back = hard && soft && git(wt, ['rev-parse', 'HEAD'], false).out === start;
    throw new WorktreeError(`${why}\n${back ? `${branch} is back where it was (${start.slice(0, 9)}); nothing was landed`
      : `nothing was landed, but ${branch} could NOT be put back to ${start.slice(0, 9)}: look at ${wt} (git status, git log) before anything else`}`);
  };
  if (weaker.length && !o.acceptWeaker) undo(weakerNote(weaker));
  if (weaker.length) steps.push(`weaker tests accepted by the operator: ${o.acceptWeaker}`);
  const merged = git(wt, ['merge', '-q', '--no-edit', into], false);
  if (!merged.ok) undo(`merging ${into} into ${branch} conflicted. Resolve it in ${wt} (git merge ${into}), then land again.\n${merged.out}`);
  steps.push(`merged ${into} into ${branch}`);
  const after = cellAudit(main, name);
  if (after.length) undo(`after merging ${into}, cell ${name} differs outside its folder: ${after.join(', ')}`);
  let leftNow = left;
  if (o.check) {
    const before = new Set(dirty(wt));
    const r = runCheck(o.check, wt);
    if (r.status !== 0) undo(`check failed in ${wt} (${o.check}, exit ${r.status}):\n${(r.stdout + r.stderr).trim().split(/\r?\n/).slice(-15).join('\n')}`);
    steps.push(`check passed: ${o.check}`);
    // What the check left behind. If that can't be read, the land is undone, not left half done.
    let unread: string | null = null, missing: string | null = null, stray: string[] = [];
    try { leftNow = leftovers(main, wt, name); missing = absent(main, wt); stray = dirty(wt).filter((p) => !before.has(p)); }
    catch (e) { unread = (e as Error).message; }
    if (unread) undo(`after the check, the worktree's git-ignored files couldn't be listed: ${unread}`);
    if (leftNow.refuse) undo(`after the check: ${leftNow.refuse}`);
    if (missing) steps.push(missing);
    // not ignored, so git shows them: the next land commits those in the cell's folder and its audit refuses the others
    if (stray.length) steps.push(strayNote(stray));
  }
  if (leftNow.note) steps.push(leftNow.note);
  const ahead = git(main, ['rev-list', '--count', `${into}..${branch}`]).out;
  if (ahead === '0') { steps.push('nothing to land'); return steps; }
  const why = weaker.length ? `\n\nWeaker tests, accepted by the operator: ${o.acceptWeaker}\n  ${weaker.join('\n  ')}` : '';
  const landed = git(main, ['merge', '-q', '--no-ff', '-m', `Land ${branch}: ${message}${why}`, branch], false);
  if (!landed.ok) { git(main, ['merge', '--abort'], false); throw new WorktreeError(`merging ${branch} into ${into} failed; aborted.\n${landed.out}`); }
  steps.push(`landed ${branch} on ${into}: ${head(main).slice(0, 9)} (${ahead} commit(s); undo with git revert -m 1 ${head(main).slice(0, 9)})`);
  return steps;
}

// Commit what the kernel wrote in root's checkout (mail and sync entries, the generated assumptions), and nothing else.
export function commitRootLog(root: string, message: string): string | null {
  const main = inMain(root);
  const paths = dirty(main).filter((p) => /^state\/log\//.test(p) || p === 'docs/assumptions.md');
  if (!paths.length) return null;
  git(main, ['add', '--', ...paths]);
  git(main, ['commit', '-q', '-m', message, '--', ...paths]);
  return head(main).slice(0, 9);
}
