// The log: append is the only writer. Entries are never edited (ontology §3 rule 1).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

// A writer reads the log once and keeps its tail in memory — for adapters appending thousands of entries.
// Same checks as append; only one writer per cell at a time (the `wx` flag still refuses an overwrite).
export function writer(cellDir: string): { append: (input: AppendInput) => Entry } {
  const byId = new Map(readLog(cellDir).map((e) => [e.id, e]));
  let last: Entry | undefined = [...byId.values()].at(-1);
  return { append: (input) => { const e = appendTo(cellDir, input, byId, last); byId.set(e.id, e); last = e; return e; } };
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
    cell: input.cell ?? 'root',
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
