// Every write refolds: a log's views (state/views/*) are fold(log), rebuilt by whoever appends, so lint never finds
// them behind their log (#7: mail appended a task and its reply to a cell's log and root's without refolding, and every
// land then showed both stale). Under the log's lock, so two writers never leave the older picture behind.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLog, withLock } from './log.ts';
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
