// Land a cell's work: root's loop (README "Root's loop") as one command, so no step is skipped. 01-HAIOS-PERS lost six
// hours to two cell-log entries left uncommitted in a worktree; AI-MMO and PS5-STUDY did these steps by hand each time.
//
//   node kernel/src/cli.ts cell land --name <cell> [--message "…"] [--check "<command>"] [--into <branch>] [--dry-run]
//   ! node kernel/src/cli.ts cell land … --accept-weaker "<why>"      (operator only)
//
// Refused whole, before anything changes, when: the cell has no worktree · its session is working on a message ·
// root's checkout is not on <into> (default: the branch it is on) · root has uncommitted work of its own (anything but
// state/log/, state/views/, docs/assumptions.md: mail and sync write those) · `cell audit` finds a change outside
// cells/<name>/.
// Then, stopping at the first failure and undoing what it did on the cell's branch:
//   1. commit the cell's uncommitted work on its branch (pathspec cells/<name> and the paths it owns)
//   2. merge <into> into the cell's branch (a conflict: abort, and leave it to root in the worktree)
//   3. audit again, and run --check in the worktree (e.g. "cd kernel && npm test"): the merged result is what is tested
//   4. merge the cell's branch into <into> with --no-ff (one revertable commit: git revert -m 1 <it>)
// Before 2, the cell's tests must not have got weaker (weaker.ts): fewer cases or assertions, skips or loosening added.
// If they did, the land stops; the operator alone lands it anyway, with --accept-weaker "<why>" (hook-blocked for
// agents), and the reason goes into the merge commit.
// The CLI then syncs the cell and commits root's log (commitRootLog), so mail entries never sit uncommitted.
import { spawnSync } from 'node:child_process';
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

export interface LandOptions { name?: string; message?: string; check?: string; into?: string; dryRun?: boolean; acceptWeaker?: string }

export function cellLand(root: string, o: LandOptions): string[] {
  const main = inMain(root), name = o.name ?? '';
  const wt = cellWorktree(main, name);
  if (!wt) throw new WorktreeError(`cell ${name} has no worktree (node kernel/src/cli.ts cell checkout --name ${name})`);
  const busy = status(join(wt, 'cells', name)).working_on;
  if (busy) throw new WorktreeError(`cell ${name} is working on ${busy}; land it after its reply (or mail.ts release --as ${name} if its session died)`);
  const into = o.into ?? currentBranch(main);
  if (currentBranch(main) !== into) throw new WorktreeError(`the main checkout is on ${currentBranch(main)}, not ${into}`);
  const mine = dirty(main).filter((p) => !ROOT_WRITTEN.some((r) => r.test(p)));
  if (mine.length) throw new WorktreeError(`root has uncommitted work of its own: ${mine.join(', ')} (commit or stash it first)`);
  const bad = cellAudit(main, name);
  if (bad.length) throw new WorktreeError(`cell ${name} changed paths outside cells/${name}/: ${bad.join(', ')}`);

  const branch = cellBranch(name), message = o.message ?? `cell ${name}: work`;
  const pending = dirty(wt);
  const weakerNote = (w: string[]) => `the cell's tests got weaker:\n  ${w.join('\n  ')}\nLand it anyway only on the operator's word: ! node kernel/src/cli.ts cell land --name ${name} … --accept-weaker "<why>"`;
  if (o.dryRun) return [
    pending.length ? `would commit ${pending.length} path(s) on ${branch}: "${message}"` : `nothing uncommitted on ${branch}`,
    ...((w) => (w.length ? [`would stop: ${weakerNote(w)}`] : []))(weakerTests(wt, git(wt, ['merge-base', into, 'HEAD']).out)),
    `would merge ${into} into ${branch}${o.check ? `, then run in ${wt}: ${o.check}` : ''}`,
    `would merge ${branch} into ${into} (--no-ff), sync the cell and commit root's log`,
  ];

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
    git(wt, ['reset', '--hard', '-q', committed], false);
    git(wt, ['reset', '--soft', '-q', start], false);
    throw new WorktreeError(`${why}\n${branch} is back where it was (${start.slice(0, 9)}); nothing was landed`);
  };
  if (weaker.length && !o.acceptWeaker) undo(weakerNote(weaker));
  if (weaker.length) steps.push(`weaker tests accepted by the operator: ${o.acceptWeaker}`);
  const merged = git(wt, ['merge', '-q', '--no-edit', into], false);
  if (!merged.ok) undo(`merging ${into} into ${branch} conflicted. Resolve it in ${wt} (git merge ${into}), then land again.\n${merged.out}`);
  steps.push(`merged ${into} into ${branch}`);
  const after = cellAudit(main, name);
  if (after.length) undo(`after merging ${into}, cell ${name} differs outside its folder: ${after.join(', ')}`);
  if (o.check) {
    const r = spawnSync(o.check, { cwd: wt, shell: true, encoding: 'utf8' });
    if (r.status !== 0) undo(`check failed in ${wt} (${o.check}, exit ${r.status}):\n${(r.stdout + r.stderr).trim().split(/\r?\n/).slice(-15).join('\n')}`);
    steps.push(`check passed: ${o.check}`);
  }
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
