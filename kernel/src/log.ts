// The log: append is the only writer. Entries are never edited (ontology §3 rule 1).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical, sha256 } from './canon.ts';
import { check, type Kind } from './schemas.ts';

export interface Entry {
  id: string;
  kind: Kind;
  at: string;
  cell: string;
  prev: string | null;
  causes: string[];
  hash: string;
  body: Record<string, unknown>;
}

export const logDir = (cellDir: string) => join(cellDir, 'state', 'log');

// The envelope's `cell`: a cell's name comes from its binding.json; anything else is the root.
const names = new Map<string, string>();
export function cellName(cellDir: string): string {
  if (!names.has(cellDir)) {
    const b = join(cellDir, 'binding.json');
    names.set(cellDir, existsSync(b) ? (JSON.parse(readFileSync(b, 'utf8')) as { name?: string }).name ?? 'root' : 'root');
  }
  return names.get(cellDir)!;
}
const fileName = (id: string, kind: string) => `${id}.${kind}.json`;

export function readLog(cellDir: string): Entry[] {
  const dir = logDir(cellDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^[0-9]{6}\.[a-z-]+\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Entry);
}

export function entryHash(entry: Omit<Entry, 'hash'>): string {
  return sha256(canonical(entry));
}

export class AppendError extends Error {}

export interface AppendInput {
  kind: Kind;
  body: Record<string, unknown>;
  causes?: string[];
  cell?: string;
  at?: string;
}

// Licence enforced at the entry: link-only content is never written to disk.
function applyLicence(kind: Kind, body: Record<string, unknown>): Record<string, unknown> {
  if (kind !== 'observation') return body;
  const licence = body.licence as { store?: string } | undefined;
  if (licence?.store === 'link-only' && 'payload' in body) {
    const { payload: _dropped, ...rest } = body;
    return { ...rest, payload_stripped: true };
  }
  return body;
}

// v0.5: a claim may be about an earlier claim (claim:<id>); a check is never about another check.
export function claimRefError(body: Record<string, unknown>, earlier: Map<string, Entry>): string | null {
  for (const s of (body.about as string[] | undefined) ?? []) {
    if (!s.startsWith('claim:')) continue;
    const target = earlier.get(s.slice(6));
    if (!target || target.kind !== 'claim') return `${s} is not an earlier claim`;
    if (body.kind === 'check' && (target.body as { kind?: string }).kind === 'check') return `${s} is a check — a check can't be checked`;
  }
  return null;
}

export function append(cellDir: string, input: AppendInput): Entry {
  return writer(cellDir).append(input);
}

// Every append holds the log's lock (state/log.lock, outside state/log so lint never sees it). File names carry the
// kind, so `wx` alone can't stop two writers with the same cached tail writing 000123.observation.json and
// 000123.claim.json and forking the chain: on Windows two writers took the same id about 1 run in 20 (SF-DEV). Under
// the lock a writer checks its next id is still free and re-reads the tail if it isn't. A lock whose process is gone,
// or older than LOCK_STALE_MS, is taken over. Held again by the same process (withLock inside withLock), it nests, so
// a generator can choose an id and append both its entries under one hold. Ported from SF-DEV (kernel/src/log.ts, S1).
// A waiter gives up only when one holder has kept the lock LOCK_WAIT_MS, never while it keeps changing hands: under
// load (eight writers, a busy machine) a fixed 10 s made waiters give up while every holder was making progress.
export const lockPath = (cellDir: string) => join(cellDir, 'state', 'log.lock');
const LOCK_STALE_MS = 30_000, LOCK_WAIT_MS = 10_000, LOCK_WAIT_MAX_MS = 300_000, LOCK_STEP_MS = 25;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const held = new Map<string, number>();   // lock path → depth, this process

export function withLock<T>(cellDir: string, fn: () => T): T {
  const path = resolve(lockPath(cellDir));
  if (held.has(path)) { held.set(path, held.get(path)! + 1); try { return fn(); } finally { held.set(path, held.get(path)! - 1); } }
  mkdirSync(join(cellDir, 'state'), { recursive: true });
  const start = Date.now();
  let until = start + LOCK_WAIT_MS, seen = '';
  for (;;) {
    try { writeFileSync(path, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' }); break; }
    catch (e) { if (!['EEXIST', 'EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; } // Windows: EPERM while the old lock is being deleted
    let raw = '', holder: { pid?: number; at?: string } = {};
    try { raw = readFileSync(path, 'utf8'); holder = JSON.parse(raw); } catch { /* being written or just released */ }
    let age = 0;
    try { age = Date.now() - statSync(path).mtimeMs; } catch { continue; }   // released meanwhile: try again
    if ((holder.pid && holder.pid !== process.pid && !alive(holder.pid)) || age > LOCK_STALE_MS) {
      // take over only the lock judged stale: if another waiter took it over first, the file now holds its fresh lock
      try { if (readFileSync(path, 'utf8') === raw) unlinkSync(path); } catch { /* gone or changed: try again */ }
      continue;
    }
    if (raw && raw !== seen) { seen = raw; until = Date.now() + LOCK_WAIT_MS; }   // a new holder: the lock is moving
    if (Date.now() > until || Date.now() - start > LOCK_WAIT_MAX_MS) throw new AppendError(`log is locked by pid ${holder.pid ?? '?'} since ${holder.at ?? '?'} (${path})`);
    pause(LOCK_STEP_MS);
  }
  held.set(path, 1);
  try { return fn(); } finally { held.delete(path); release(path); }
}

// Windows refuses to delete a file another process has open for a moment (EPERM, EBUSY): retry, so a lock is never
// left behind by a process that is still alive (a left lock is what made two waiters take it over at once)
function release(path: string): void {
  for (let i = 0; i < 400; i++) {
    try { unlinkSync(path); return; }
    catch (e) { const code = (e as NodeJS.ErrnoException).code; if (code === 'ENOENT') return; if (code !== 'EPERM' && code !== 'EBUSY') throw e; }
    pause(5);
  }
  throw new AppendError(`could not release the log lock ${path}`);
}

// A writer reads the log once and keeps its tail in memory — for adapters appending thousands of entries.
// Same checks as append. Under the lock it re-reads the tail when another writer appended since, so it never goes stale.
const KINDS: Kind[] = ['observation', 'claim'];
export function writer(cellDir: string): { append: (input: AppendInput) => Entry } {
  let byId: Map<string, Entry> | null = null;
  let last: Entry | undefined;
  const taken = (id: string) => KINDS.some((k) => existsSync(join(logDir(cellDir), fileName(id, k))));
  return {
    append: (input) => withLock(cellDir, () => {
      if (!byId || taken(String(byId.size + 1).padStart(6, '0'))) { byId = new Map(readLog(cellDir).map((e) => [e.id, e])); last = [...byId.values()].at(-1); }
      const e = appendTo(cellDir, input, byId, last); byId.set(e.id, e); last = e; return e;
    }),
  };
}

function appendTo(cellDir: string, input: AppendInput, byId: Map<string, Entry>, last: Entry | undefined): Entry {
  const body = applyLicence(input.kind, input.body);
  const bodyErrors = check(input.kind, body);
  if (bodyErrors.length) throw new AppendError(bodyErrors.join('\n'));

  for (const c of input.causes ?? []) if (!byId.has(c)) throw new AppendError(`cause ${c} is not in the log`);
  if (input.kind === 'claim') {
    const from = body.from as string;
    const source = byId.get(from);
    if (!source || source.kind !== 'observation') throw new AppendError(`claim.from ${from} is not an observation in the log`);
    const err = claimRefError(body, byId);
    if (err) throw new AppendError(err);
  }

  const id = String(byId.size + 1).padStart(6, '0');
  const unhashed = {
    id,
    kind: input.kind,
    at: input.at ?? new Date().toISOString(),
    cell: input.cell ?? cellName(cellDir),
    prev: last ? last.hash : null,
    causes: input.causes ?? [],
    body,
  };
  const entry: Entry = { ...unhashed, hash: entryHash(unhashed) };
  const envErrors = check('envelope', entry);
  if (envErrors.length) throw new AppendError(envErrors.join('\n'));

  mkdirSync(logDir(cellDir), { recursive: true });
  const path = join(logDir(cellDir), fileName(id, input.kind));
  writeFileSync(path, JSON.stringify(entry, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' }); // wx: refuse to overwrite
  return entry;
}
