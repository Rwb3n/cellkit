// Lint: the log is intact and every entry is valid. Mechanical governance — runs at every session start.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimRefError, entryHash, logDir, readLog, type Entry } from './log.ts';
import { viewsDir } from './fold.ts';
import { check } from './schemas.ts';
import { lintBedrock } from './bedrock.ts';
import { lintBinding, lintCells } from './cell.ts';
import { configPath, loadConfig } from './config.ts';
import { globRe } from './glob.ts';
import { spawnSync } from 'node:child_process';
import { inMain } from './worktree.ts';

export interface LintResult { errors: string[]; warnings: string[]; entries: number }

// The root handover (docs/ROOT.md, from templates/ROOT.md) goes stale quietly while the project moves on. DTG reports
// the commits since its handover changed at every status; lint warns once there are HANDOVER_STALE of them.
export const HANDOVER_STALE = 20;
export function handoverAge(root: string): number | null {
  if (!existsSync(join(root, 'docs', 'ROOT.md'))) return null;
  const last = spawnSync('git', ['-C', root, 'log', '-1', '--format=%H', '--', 'docs/ROOT.md'], { encoding: 'utf8' });
  if (last.status !== 0 || !last.stdout.trim()) return null;
  const n = spawnSync('git', ['-C', root, 'rev-list', '--count', `${last.stdout.trim()}..HEAD`], { encoding: 'utf8' });
  return n.status === 0 ? Number(n.stdout.trim()) : null;
}

// Ownership (bedrock guards.json cells.<name>.owns): no tracked file is owned by two cells, and every owner is a cell.
// Read from the committed tree, so an overlap shows once both cells' files are in it. Root is no owner: it has no
// boundary and may write anywhere.
export function lintOwnership(root: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  const config = loadConfig(configPath(root));
  if (config.error) return { errors: [config.error], warnings };
  const owners = Object.entries(config.owns).filter(([, g]) => g.length);
  for (const [n] of owners) if (!existsSync(join(root, 'cells', n, 'binding.json'))) warnings.push(`guards.json: cells.${n} owns paths, but there is no cell ${n}`);
  if (owners.length < 2) return { errors, warnings };
  const r = spawnSync('git', ['-C', root, '-c', 'core.quotepath=off', 'ls-files'], { encoding: 'utf8' });
  if (r.status !== 0) return { errors, warnings };
  const res = owners.map(([n, g]) => [n, g.map(globRe)] as const);
  for (const f of r.stdout.split(/\r?\n/).filter(Boolean)) {
    const by = res.filter(([, rs]) => rs.some((x) => x.test(f.toLowerCase()))).map(([n]) => n);
    if (by.length > 1) errors.push(`${f} is owned by ${by.join(' and ')} (guards.json): one owner per path`);
  }
  return { errors, warnings };
}

// Claude Code's own worktrees (isolation: "worktree", EnterWorktree) sit in the main checkout at .claude/worktrees/, on
// worktree-* branches. Their work reaches main only through cell land or root's own commits (#48), and the shell guard
// refuses merging them; one left behind, or a branch holding commits main doesn't have, is flagged so a session ends
// with none. Root's lint only: a cell's leaves it to root.
export function lintNativeWorktrees(root: string): string[] {
  if (existsSync(join(root, 'binding.json'))) return [];
  const g = (...a: string[]) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  const list = g('worktree', 'list', '--porcelain');
  if (list.status !== 0) return [];
  const main = inMain(root).replaceAll('\\', '/').toLowerCase();
  const out: string[] = [], held = new Set<string>();
  for (const block of list.stdout.split(/\r?\n\r?\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1].replaceAll('\\', '/');
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? '(detached)';
    if (!path || !path.toLowerCase().startsWith(`${main}/.claude/worktrees/`)) continue;
    held.add(branch);
    out.push(`native worktree ${path.slice(main.length + 1)} (${branch}) is still here: its work reaches main only through cell land or a root commit, never a merge. Move what it holds into a cell task or a commit on main, then remove it (git worktree remove).`);
  }
  const unmerged = g('branch', '--list', 'worktree-*', '--no-merged', 'HEAD', '--format=%(refname:short)');
  for (const b of unmerged.status === 0 ? unmerged.stdout.split(/\r?\n/).filter(Boolean) : [])
    if (!held.has(b)) out.push(`branch ${b} holds commits main doesn't have, from a native worktree: it won't be merged (cell land or a root commit instead). Take what's needed, then delete it (git branch -D ${b}).`);
  return out;
}

export function lint(cellDir: string): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const dir = logDir(cellDir);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f !== '.gitkeep').sort() : [];
  let prev: string | null = null;
  const kinds = new Map<string, string>();
  const earlier = new Map<string, Entry>();

  files.forEach((f, i) => {
    const m = /^([0-9]{6})\.([a-z-]+)\.json$/.exec(f);
    if (!m) { errors.push(`${f}: not a log file name`); return; }
    let e: Entry;
    try { e = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { errors.push(`${f}: not JSON`); return; }
    const expectId = String(i + 1).padStart(6, '0');
    if (m[1] !== expectId || e.id !== expectId) errors.push(`${f}: sequence gap or mismatch (expected ${expectId})`);
    if (e.kind !== m[2]) errors.push(`${f}: kind ${e.kind} does not match file name`);
    const bodyErrors = e.kind === 'observation' || e.kind === 'claim' ? check(e.kind, e.body) : [];
    for (const msg of [...check('envelope', e), ...bodyErrors]) errors.push(`${f}: ${msg}`);
    if (e.prev !== prev) errors.push(`${f}: chain broken (prev does not match previous hash)`);
    const { hash, ...rest } = e;
    if (entryHash(rest) !== hash) errors.push(`${f}: hash mismatch (entry was edited)`);
    if (e.kind === 'claim') {
      const from = (e.body as { from: string }).from;
      if (kinds.get(from) !== 'observation') errors.push(`${f}: claim.from ${from} is not an earlier observation`);
      const refErr = claimRefError(e.body, earlier);
      if (refErr) errors.push(`${f}: ${refErr}`);
    }
    for (const c of e.causes ?? []) if (!kinds.has(c)) errors.push(`${f}: cause ${c} is not an earlier entry`);
    kinds.set(e.id, e.kind);
    earlier.set(e.id, e);
    prev = hash;
  });

  if (!errors.length) {
    const b = lintBedrock(cellDir, readLog(cellDir));
    errors.push(...b.errors);
    warnings.push(...b.warnings);
    errors.push(...lintCells(cellDir, readLog(cellDir))); // every cell head the parent recorded still exists
    errors.push(...lintBinding(cellDir, readLog(cellDir))); // a cell's binding.json is the one on its log
    const o = lintOwnership(cellDir);
    errors.push(...o.errors);
    warnings.push(...o.warnings);
    const stale = handoverAge(cellDir);
    if (stale !== null && stale >= HANDOVER_STALE) warnings.push(`docs/ROOT.md last changed ${stale} commits ago: are its routines and lessons still true?`);
    warnings.push(...lintNativeWorktrees(cellDir));
  }

  const summaryPath = join(viewsDir(cellDir), 'summary.json');
  if (files.length && !existsSync(summaryPath)) warnings.push('views missing — run fold');
  else if (existsSync(summaryPath)) {
    const head = JSON.parse(readFileSync(summaryPath, 'utf8')).head;
    if (head !== prev) warnings.push('views are stale (built from an older log head) — run fold');
  }
  return { errors, warnings, entries: files.length };
}
