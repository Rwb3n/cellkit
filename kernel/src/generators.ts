// Generators: the only sanctioned way to add assumptions, status changes and constraints.
// Each writes an observation (where it came from) and a claim (what it says) through append.
import { append, AppendError, readLog, withLock } from './log.ts';

export interface GenOptions {
  id?: string; voice?: string; statement?: string; test?: string; evidence?: string; source?: string;
  status?: string; note?: string; slug?: string; text?: string; observed_at?: string; at?: string;
}

const adapterFor = (voice: string) => (['operator', 'claude', 'probe'].includes(voice) ? voice : 'probe');

function origin(cell: string, o: GenOptions, voice: string, payload: unknown): string {
  return append(cell, {
    kind: 'observation', at: o.at,
    body: { source: { adapter: adapterFor(voice), provider: 'conversation' }, ...(o.source ? { url: o.source } : {}),
      observed_at: o.observed_at ?? new Date().toISOString(), reliability: [], licence: { store: 'full' }, payload },
  }).id;
}

// One past the highest assumption id in the cell's log (A1 for none). Called under the log's lock, so two writers
// never take the same id, and nobody probes for a free one with a throwaway entry (AI-MMO: the log keeps it forever).
export function nextAssumptionId(cell: string): string {
  let max = 0;
  for (const e of readLog(cell)) for (const a of ((e.body as { about?: string[] }).about ?? []))
    { const m = /^thing:assumption\/A([0-9]+)$/.exec(a); if (m) max = Math.max(max, Number(m[1])); }
  return `A${max + 1}`;
}

// Without --id, the next free one. The id is chosen and both entries appended under one hold of the log's lock.
export function assume(cell: string, o: GenOptions): string[] {
  if (o.id !== undefined && !/^A[0-9]+$/.test(o.id)) throw new AppendError('assume --id must be like A1 (or leave it out for the next free one)');
  if (!o.statement) throw new AppendError('assume needs --statement');
  return withLock(cell, () => {
    const id = o.id ?? nextAssumptionId(cell);
    const voice = o.voice ?? 'claude';
    const from = origin(cell, o, voice, { statement: o.statement, source: o.source });
    const c = append(cell, {
      kind: 'claim', at: o.at, causes: [from],
      body: { about: [`thing:assumption/${id}`], kind: 'hypothesis', status: o.status ?? 'guess', from, voice,
        says: { statement: o.statement, ...(o.test ? { test: o.test } : {}), ...(o.evidence ? { evidence: o.evidence } : {}), ...(o.source ? { source: o.source } : {}) } },
    });
    return [id, from, c.id];
  });
}

export function evidence(cell: string, o: GenOptions): string[] {
  if (!o.id || !/^A[0-9]+$/.test(o.id)) throw new AppendError('evidence needs --id like A1');
  if (!o.status) throw new AppendError('evidence needs --status guess|some|evidence|refuted');
  if (!o.note) throw new AppendError('evidence needs --note');
  const voice = o.voice ?? 'claude';
  const from = origin(cell, o, voice, { note: o.note, source: o.source });
  const c = append(cell, {
    kind: 'claim', at: o.at, causes: [from],
    body: { about: [`thing:assumption/${o.id}`], kind: 'hypothesis', status: o.status, from, voice, says: { note: o.note } },
  });
  return [from, c.id];
}

export function constraint(cell: string, o: GenOptions): string[] {
  if (!o.slug || !/^[a-z0-9-]+$/.test(o.slug)) throw new AppendError('constraint needs --slug like scope-one-city');
  if (!o.text) throw new AppendError('constraint needs --text');
  const voice = o.voice ?? 'operator';
  const from = origin(cell, o, voice, { text: o.text, source: o.source });
  const c = append(cell, {
    kind: 'claim', at: o.at, causes: [from],
    body: { about: [`thing:constraint/${o.slug}`], kind: 'rule', from, voice, says: { text: o.text } },
  });
  return [from, c.id];
}
