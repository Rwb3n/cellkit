// Every write refolds: a log's views (state/views/*) are fold(log), rebuilt by whoever appends, so lint never finds
// them behind their log (#7: mail appended a task and its reply to a cell's log and root's without refolding, and every
// land then showed both stale). Under the log's lock, so two writers never leave the older picture behind: insurance,
// untested; 8 processes mailing one log, 5 rounds, kept the views current with the lock taken out too (2026-10-23).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { logDir, readLog, withLock } from './log.ts';
import { fold, viewsDir, writeViews, type Pictures } from './fold.ts';
import { foldBedrock } from './bedrock.ts';
import { foldReviews } from './review.ts';
import { foldCells } from './cell.ts';
import { writeDocs } from './render.ts';

// The views of the log at `dir`, and the generated docs under `docs` when given (root's: docs/assumptions.md).
export function refold(dir: string, o: { docs?: string } = {}): Pictures {
  return withLock(dir, () => {
    const log = readLog(dir);
    const p = fold(log);
    writeViews(dir, p);
    for (const [name, v] of Object.entries({ bedrock: foldBedrock(log), reviews: foldReviews(log), cells: foldCells(log) }))
      writeFileSync(join(viewsDir(dir), `${name}.json`), JSON.stringify(v, null, 2) + '\n', 'utf8');
    if (o.docs) { mkdirSync(join(o.docs, 'docs'), { recursive: true }); writeDocs(o.docs, p); }
    return p;
  });
}

// The views a checkout already holds (the root's, each cell's), rebuilt from the logs it holds now; returns the ones
// that were behind, as paths from `top`. For a merge that brought log entries in: views are git-ignored, so a merge
// never touches them, and they stay as folded from the log before it (#102; ecom-lab: `cell land` merged main, with a
// new assumption, into a cell's worktree, and its check compared a table generated from the merged log with the views
// the cell had folded earlier: KeyError 'A51'). Only where there are views and a log to fold: none are made where a
// checkout had none, and views left by a cell that is gone are left alone. Views only, never the generated docs, which
// are tracked and came with the merge. A log that can't be folded doesn't stop the others: every folder is tried, then
// the failures are thrown together, each naming its folder.
export function refoldPresent(top: string): string[] {
  const cells = join(top, 'cells');
  const dirs = [top, ...(existsSync(cells) ? readdirSync(cells).sort().map((n) => join(cells, n)) : [])].filter((d) => existsSync(viewsDir(d)) && existsSync(logDir(d)));
  const headOf = (d: string): unknown => { try { return (JSON.parse(readFileSync(join(viewsDir(d), 'summary.json'), 'utf8')) as { head?: unknown }).head; } catch { return undefined; } };
  const behind: string[] = [], failed: string[] = [];
  for (const d of dirs) {
    const was = headOf(d), name = relative(top, d).replaceAll('\\', '/') || '.';
    try { if (refold(d).summary.head !== was) behind.push(name); }
    catch (e) { failed.push(`${name === '.' ? 'the root log' : name}: ${(e as Error).message}`); }
  }
  if (failed.length) throw new Error(failed.join('; '));
  return behind;
}
