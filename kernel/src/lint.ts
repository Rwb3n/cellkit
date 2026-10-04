// Lint: the log is intact and every entry is valid. Mechanical governance — runs at every session start.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimRefError, entryHash, logDir, readLog, type Entry } from './log.ts';
import { viewsDir } from './fold.ts';
import { check } from './schemas.ts';
import { lintBedrock } from './bedrock.ts';

export interface LintResult { errors: string[]; warnings: string[]; entries: number }

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
  }

  const summaryPath = join(viewsDir(cellDir), 'summary.json');
  if (files.length && !existsSync(summaryPath)) warnings.push('views missing — run fold');
  else if (existsSync(summaryPath)) {
    const head = JSON.parse(readFileSync(summaryPath, 'utf8')).head;
    if (head !== prev) warnings.push('views are stale (built from an older log head) — run fold');
  }
  return { errors, warnings, entries: files.length };
}
