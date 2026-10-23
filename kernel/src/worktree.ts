// One git worktree per cell. Each cell works in its own locked checkout of the repository on branch cell/<name>, outside
// the main checkout (<repo>-cells/<name> by default, or guards.json worktrees.home/<name>), so nothing it changes touches
// the main checkout or another cell until root merges it, and an audit can attribute every changed file to the cell that
// wrote it.
//   - Mail lives under the git common dir (shared by every checkout, inside none): see mail.ts `mailbox`.
//   - Root-log writes made from a worktree land in the main checkout's log (cli.ts), so root's hash chain never forks;
//     a cell's own log is written in its worktree (mail.ts `logHome`), so the cell's chain never forks either.
//   - A cell session opened in the wrong checkout (the main checkout's copy of a cell that has a worktree, or another
//     cell's worktree) may write nothing and is handed no mail: `misplaced`, used by the three hooks.
// Outside git (tests in a temp folder) everything stays where it is.
//
//   node kernel/src/cli.ts cell checkout --name <cell> [--path <dir>]     (the cell must be committed at HEAD)
//   node kernel/src/cli.ts cell audit --name <cell> [--except <glob>]…
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { globRe } from './glob.ts';
import { configPath, loadConfig } from './config.ts';

export class WorktreeError extends Error {}

const isCellDir = (dir: string) => existsSync(join(dir, 'binding.json'));
const NAME = /^[a-z0-9-]+$/;
export const cellBranch = (name: string) => `cell/${name}`;

function git(dir: string, args: string[], check = true): string {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8' });
  if (r.status === 0) return r.stdout;
  if (check) throw new WorktreeError(`git ${args.join(' ')}: ${(r.stderr || r.stdout || String(r.error ?? '')).trim()}`);
  return '';
}

// Paths compare equal across git's forward slashes, 8.3 names and case-insensitive file systems.
export function samePath(a: string, b: string): boolean {
  const n = (p: string) => { let r = resolve(p); try { r = realpathSync.native(r); } catch { /* not on disk */ } return process.platform === 'win32' ? r.toLowerCase() : r; };
  return n(a) === n(b);
}

// ── where am I ───────────────────────────────────────────────────────────────────
// { common, top }: the git common dir (the main checkout's .git) and this checkout's top folder; null outside git.
const located = new Map<string, { common: string; top: string } | null>();
function locate(dir: string): { common: string; top: string } | null {
  const key = resolve(dir);
  if (!located.has(key)) {
    const out = existsSync(key) ? git(key, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], false).trim().split(/\r?\n/) : [];
    located.set(key, out.length === 2 && out[0] && out[1] ? { common: resolve(out[0]), top: resolve(out[1]) } : null);
  }
  return located.get(key)!;
}

export const gitCommonDir = (dir: string): string | null => locate(dir)?.common ?? null;

// The same folder in the main checkout: `dir` itself unless it lies in a linked worktree.
export function inMain(dir: string): string {
  const g = locate(dir);
  if (!g || basename(g.common) !== '.git') return resolve(dir);
  const main = dirname(g.common);
  return samePath(main, g.top) ? resolve(dir) : join(main, relative(g.top, resolve(dir)));
}

export const isLinkedWorktree = (dir: string) => !samePath(inMain(dir), dir);

// Where cell worktrees live (<dir>/<cell>): bedrock guards.json `worktrees.home`, relative to the main checkout, or by
// default its sibling <repo>-cells/. Never inside it (#26): location is ownership, and the main checkout is root's.
export function cellsCheckoutDir(mainRoot: string): string {
  const m = resolve(mainRoot);
  const config = loadConfig(configPath(m));
  if (config.error) throw new WorktreeError(config.error);
  return config.home ? resolve(m, config.home) : join(dirname(m), `${basename(m)}-cells`);
}

// `path` is the main checkout or lies inside it.
export function insideMain(mainRoot: string, path: string): boolean {
  const rel = relative(norm(mainRoot), norm(path));
  return !rel.startsWith('..') && !isAbsolute(rel);
}
const norm = (p: string) => { let r = resolve(p); try { r = realpathSync.native(r); } catch { /* not on disk yet */ } return process.platform === 'win32' ? r.toLowerCase() : r; };

export const currentBranch = (dir: string) => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], false).trim();

// The folder of cell `name`'s worktree (the checkout of branch cell/<name>), or null if it has none.
export function cellWorktree(root: string, name: string): string | null {
  const w = worktrees(root).find((x) => x.branch === cellBranch(name));
  // a worktree folder deleted without `git worktree remove` is still listed (prunable): it is no worktree
  return w && existsSync(w.path) ? w.path : null;
}

// Every checkout git knows of: its folder, branch (null if detached) and whether it is locked. [] outside git.
export function worktrees(root: string): { path: string; branch: string | null; locked: boolean }[] {
  if (!gitCommonDir(root)) return [];
  return git(root, ['worktree', 'list', '--porcelain'], false).split(/\r?\n\r?\n/).flatMap((block) => {
    const path = /^worktree (.+)$/m.exec(block)?.[1].trim();
    if (!path) return [];
    return [{ path: resolve(path), branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1].trim() ?? null, locked: /^locked(\s|$)/m.test(block) }];
  });
}

// The worktree git still holds branch `branch` checked out in, if its folder is gone (deleted by hand; prune leaves a locked one).
const registered = (main: string, branch: string) => worktrees(main).find((w) => w.branch === branch && !existsSync(w.path)) ?? null;

// ── cell checkout ────────────────────────────────────────────────────────────────
// Give cell `name` its own worktree on branch cell/<name>, made from HEAD (so the cell must be committed there).
// kernel/node_modules is git-ignored, so the worktree has none: its kernel copy loads the main checkout's (schemas.ts).
export function cellCheckout(root: string, o: { name?: string; path?: string }): string {
  const main = inMain(root);
  const name = o.name ?? '';
  if (!NAME.test(name) || !isCellDir(join(main, 'cells', name))) throw new WorktreeError(`no cell cells/${name} with a binding.json`);
  if (!gitCommonDir(main)) throw new WorktreeError(`${main} is not a git repository`);
  if (!git(main, ['ls-tree', 'HEAD', `cells/${name}/binding.json`], false).trim())
    throw new WorktreeError(`cells/${name} is not committed at HEAD; commit it first (the worktree is made from HEAD)`);
  const existing = cellWorktree(main, name);
  if (existing) throw new WorktreeError(`cell ${name} already has a worktree at ${existing}`);
  const dest = o.path ? resolve(o.path) : join(cellsCheckoutDir(main), name);
  if (insideMain(main, dest)) throw new WorktreeError(`${dest} is inside the main checkout: a cell's worktree lives outside it, or root's guards would judge it as root (#26). Set bedrock guards.json worktrees.home (e.g. "../.cells/<project>") or pass --path outside the repository`);
  if (existsSync(dest)) throw new WorktreeError(`${dest} already exists`);
  const branch = cellBranch(name);
  const stale = registered(main, branch);
  if (stale) throw new WorktreeError(`branch ${branch} is still registered to the worktree ${stale.path}, which is gone. If nothing there is needed: ${stale.locked ? `git worktree unlock "${stale.path}" && ` : ''}git worktree prune, then check out again`);
  // locked (#22): a cell's worktree is kept, not throwaway; removing it takes git worktree remove -f -f
  const lock = ['--lock', '--reason', `cell ${name}`];
  if (git(main, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], false).trim()) git(main, ['worktree', 'add', ...lock, dest, branch]);
  else git(main, ['worktree', 'add', ...lock, '-b', branch, dest, 'HEAD']);
  return dest;
}

// ── the wrong checkout ───────────────────────────────────────────────────────────
// A block reason if a session for the cell at `cellDir` runs in the wrong checkout, else null:
//   - the main checkout's copy of a cell that has its own worktree (it would edit main, not its branch), or
//   - another cell's worktree (a linked worktree on branch cell/<other>): both cells would edit one tree.
// Such a session may write nothing, and its Stop hook files any in-flight reply but hands over no new mail.
export function misplaced(cellDir: string): string | null {
  const dir = resolve(cellDir), name = basename(dir), root = resolve(dir, '..', '..');
  if (!isCellDir(dir) || !gitCommonDir(root)) return null;
  const wt = cellWorktree(root, name);
  const where = wt ? join(wt, 'cells', name) : `its own worktree (node kernel/src/cli.ts cell checkout --name ${name})`;
  if (isLinkedWorktree(root)) {
    const branch = currentBranch(root);
    if (!branch.startsWith('cell/') || branch === cellBranch(name)) return null;
    return `cell \`${name}\` session opened in the worktree of branch ${branch}, not its own. Nothing here may be written and no mail is handed over. ` +
      `End your turn and ask the operator to reopen this cell at ${where} (or to run it headless: node kernel/src/cellrun.ts --cell ${name}).`;
  }
  if (!wt || samePath(wt, root)) return null;
  return `cell \`${name}\` has its own worktree, but this session was opened in the main checkout (${dir}). Nothing here may be written and no mail is handed over. ` +
    `End your turn and ask the operator to reopen this cell at ${where} (or to run it headless: node kernel/src/cellrun.ts --cell ${name}).`;
}

// ── audit: detection backs up prevention ─────────────────────────────────────────
// Hooks are heuristics (a script a cell runs can write anywhere). Before root commits a cell's work, every changed
// path must lie inside cells/<name>/, or a path the cell owns (bedrock guards.json), or match an --except glob.
//   With a worktree: only the cell's branch (commits since it left main's HEAD) and its worktree (uncommitted) are
//   read, so every change is the cell's. Root's log and docs/assumptions.md are not excused there: root-log writes
//   always land in the main checkout, so a change to them on a cell branch is a fork.
//   Without one: the main checkout's uncommitted changes; root's log and docs/assumptions.md are excused (mail and
//   reviews write them), and root's own uncommitted work must be excluded with --except.
// Returns the offending paths (empty = clean).
export function cellAudit(root: string, name: string, except: string[] = []): string[] {
  const main = inMain(root);
  if (!isCellDir(join(main, 'cells', name))) throw new WorktreeError(`no cell cells/${name} with a binding.json`);
  // a cell's own folder, plus the repo paths it owns (main's bedrock guards.json: ownership is root's, as approved)
  const config = loadConfig(configPath(main));
  if (config.error) throw new WorktreeError(config.error);
  const own = [`cells/${name}/**`, ...(config.owns[name] ?? []), ...except];
  const wt = cellWorktree(main, name);
  const [changes, allowed] = wt
    ? [worktreeChanges(main, wt), own]
    : [changedPaths(main), [...own, 'state/log/**', 'docs/assumptions.md']];
  const res = allowed.map(globRe);
  return [...new Set(changes.filter((p) => !res.some((r) => r.test(p.toLowerCase()))))].sort();
}

function changedPaths(dir: string): string[] {
  return git(dir, ['status', '--porcelain=v1', '-uall']).split(/\r?\n/).filter(Boolean)
    .flatMap((l) => l.slice(3).split(' -> ').map((p) => p.trim().replace(/^"|"$/g, '').replaceAll('\\', '/')));
}

function worktreeChanges(main: string, wt: string): string[] {
  const base = git(wt, ['merge-base', 'HEAD', git(main, ['rev-parse', 'HEAD']).trim()], false).trim();
  const committed = base ? git(wt, ['diff', '--name-only', `${base}..HEAD`], false).split(/\r?\n/).map((p) => p.trim()).filter(Boolean) : [];
  return [...committed, ...changedPaths(wt)];
}

export { globRe };
