// Fold: log → pictures. Pure and deterministic; views can always be rebuilt from the log.
// The kit folds what it uses itself (subjects, assumptions, constraints, checks). Add your domain's
// pictures in a fold of your own and merge them in `fold()` (see README: 'Your ontology').
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Entry } from './log.ts';

export interface SubjectPicture { claims: number; voices: string[]; voice_count: number; kinds: Record<string, number> }

export interface HypothesisPicture {
  id: string; statement: string; test?: string; evidence?: string; source?: string; voice: string; status: string;
  opened: string;
  history: { entry: string; observed_at: string; status: string; note?: string; voice: string }[];
}

export interface ConstraintPicture { subject: string; text: string; entry: string; observed_at: string; voice: string }

export interface Pictures {
  summary: { head: string | null; entries: number; observations: number; claims: number; subjects: number };
  subjects: Record<string, SubjectPicture>;
  hypotheses: Record<string, HypothesisPicture>;
  constraints: ConstraintPicture[];
  checks: Record<string, number>;   // claim id → latest check p
}

export function fold(log: Entry[]): Pictures {
  const subjects: Record<string, SubjectPicture> = {};
  const voices: Record<string, Set<string>> = {};
  const hypotheses: Record<string, HypothesisPicture> = {};
  const constraints: ConstraintPicture[] = [];
  const checks: Record<string, number> = {};
  const observedAt: Record<string, string> = {};
  let observations = 0, claims = 0;

  for (const e of log) {
    if (e.kind === 'observation') { observations++; observedAt[e.id] = (e.body as { observed_at: string }).observed_at; continue; }
    claims++;
    const b = e.body as { about: string[]; kind: string; says: unknown; voice: string; from: string; status?: string };
    for (const s of b.about) {
      const p = (subjects[s] ??= { claims: 0, voices: [], voice_count: 0, kinds: {} });
      p.claims++;
      p.kinds[b.kind] = (p.kinds[b.kind] ?? 0) + 1;
      (voices[s] ??= new Set()).add(b.voice);
      if (b.kind === 'rule' && s.startsWith('thing:constraint/'))
        constraints.push({ subject: s, text: (b.says as { text: string }).text, entry: e.id, observed_at: observedAt[b.from], voice: b.voice });
    }
    if (b.kind === 'check') checks[b.about[0].slice('claim:'.length)] = (b.says as { p: number }).p; // log order = recency
    if (b.kind === 'hypothesis') {
      const says = b.says as { statement?: string; test?: string; evidence?: string; source?: string; note?: string };
      for (const s of b.about.filter((a) => a.startsWith('thing:assumption/'))) {
        const id = s.slice('thing:assumption/'.length);
        const step = { entry: e.id, observed_at: observedAt[b.from], status: b.status!, voice: b.voice, ...(says.note ? { note: says.note } : {}) };
        const cur = hypotheses[id];
        if (!cur) hypotheses[id] = { id, statement: says.statement ?? '', test: says.test, evidence: says.evidence, source: says.source, voice: b.voice, status: b.status!, opened: e.id, history: [step] };
        else { cur.status = b.status!; if (says.statement) cur.statement = says.statement; cur.history.push(step); }
      }
    }
  }

  const sorted: Record<string, SubjectPicture> = {};
  for (const s of Object.keys(subjects).sort()) { const v = [...voices[s]].sort(); sorted[s] = { ...subjects[s], voices: v, voice_count: v.length }; }
  return {
    summary: { head: log.at(-1)?.hash ?? null, entries: log.length, observations, claims, subjects: Object.keys(sorted).length },
    subjects: sorted,
    hypotheses: Object.fromEntries(Object.keys(hypotheses).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((k) => [k, hypotheses[k]])),
    constraints,
    checks,
  };
}

export const viewsDir = (cellDir: string) => join(cellDir, 'state', 'views');

export function writeViews(cellDir: string, p: Pictures): void {
  mkdirSync(viewsDir(cellDir), { recursive: true });
  for (const [name, value] of Object.entries({ summary: p.summary, subjects: p.subjects, assumptions: p.hypotheses, checks: p.checks }))
    writeFileSync(join(viewsDir(cellDir), `${name}.json`), JSON.stringify(value, null, 2) + '\n', 'utf8');
}
