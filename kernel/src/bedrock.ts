// Bedrock guard: bedrock docs change only by amendment (ontology §5).
// propose: the agent stages state/bedrock/proposed/<doc>.md, then `amend` logs it.
// approve: only the operator, from their own prompt (`! node kernel/src/cli.ts approve --doc <doc>`);
//          the agent's Bash is hook-blocked from running it. The kernel then writes the live file.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './canon.ts';
import { append, AppendError, readLog, type Entry } from './log.ts';

// Line endings are normalised to LF before hashing: git checks bedrock out as LF (.gitattributes),
// editors on Windows write CRLF. A hash must mean the same text on every machine.
export const normalise = (text: string) => text.replace(/\r\n?/g, '\n');
const readText = (path: string) => normalise(readFileSync(path, 'utf8'));

export const LAYERS = ['shape', 'kinds', 'rules', 'binding', 'meta'] as const;
export const bedrockDir = (cell: string) => join(cell, 'state', 'bedrock');
export const proposedPath = (cell: string, doc: string) => join(bedrockDir(cell), 'proposed', `${doc}.md`);
export const livePath = (cell: string, doc: string) => join(bedrockDir(cell), `${doc}.md`);
const basePath = (cell: string, doc: string) => join(bedrockDir(cell), 'proposed', `${doc}.base`);

// Copy the live doc to proposed/ to edit it, remembering which live version it came from: `amend` refuses a copy staged
// from a version that has since changed (it would silently undo the newer text). AI-MMO and DTG both hit this.
export function stage(cell: string, o: { doc?: string }): string[] {
  if (!o.doc || !/^[a-z0-9-]+$/.test(o.doc)) throw new AppendError('stage needs --doc like ontology');
  if (!existsSync(livePath(cell, o.doc))) throw new AppendError(`no live ${o.doc}.md to stage (a new doc: write proposed/${o.doc}.md directly)`);
  if (existsSync(proposedPath(cell, o.doc))) throw new AppendError(`${proposedPath(cell, o.doc)} is already staged; amend it or delete it first`);
  const text = readText(livePath(cell, o.doc));
  mkdirSync(join(bedrockDir(cell), 'proposed'), { recursive: true });
  writeFileSync(proposedPath(cell, o.doc), text, 'utf8');
  writeFileSync(basePath(cell, o.doc), sha256(text) + '\n', 'utf8');
  return [`staged ${proposedPath(cell, o.doc)}: edit it, then amend`];
}

interface Says { action: 'propose' | 'approve'; doc: string; content_hash: string; layer?: string; reason?: string; evidence?: string[]; base_hash?: string | null; proposal?: string }

export interface BedrockPicture {
  doc: string;
  status: 'approved' | 'draft';
  live_hash: string;            // what the live file must hash to
  approved?: { entry: string; content_hash: string; proposal: string };
  pending: { entry: string; content_hash: string; layer: string; reason: string }[];
  history: { entry: string; action: string; layer?: string; reason?: string; voice: string }[];
}

const bedrockClaims = (log: Entry[]) =>
  log.filter((e) => e.kind === 'claim' && (e.body as { kind: string }).kind === 'rule'
    && (e.body as { about: string[] }).about.some((a) => a.startsWith('thing:bedrock/')));

export function foldBedrock(log: Entry[]): Record<string, BedrockPicture> {
  const out: Record<string, BedrockPicture> = {};
  for (const e of bedrockClaims(log)) {
    const b = e.body as { says: Says; voice: string };
    const s = b.says;
    const p = (out[s.doc] ??= { doc: s.doc, status: 'draft', live_hash: s.content_hash, pending: [], history: [] });
    p.history.push({ entry: e.id, action: s.action, layer: s.layer, reason: s.reason, voice: b.voice });
    if (s.action === 'propose') {
      p.pending.push({ entry: e.id, content_hash: s.content_hash, layer: s.layer ?? '', reason: s.reason ?? '' });
      if (p.status === 'draft') p.live_hash = s.content_hash; // never approved: live file shows the latest draft
    } else {
      p.status = 'approved';
      p.approved = { entry: e.id, content_hash: s.content_hash, proposal: s.proposal ?? '' };
      p.live_hash = s.content_hash;
      p.pending = p.pending.filter((x) => x.entry !== s.proposal && x.entry > (s.proposal ?? ''));
    }
  }
  return out;
}

function proposalContent(log: Entry[], claimId: string): string {
  const claim = log.find((e) => e.id === claimId);
  const obs = log.find((e) => e.id === (claim?.body as { from: string }).from);
  return (obs?.body as { payload: { content: string } }).payload.content;
}

export function amend(cell: string, o: { doc?: string; layer?: string; reason?: string; evidence?: string; voice?: string }): string[] {
  if (!o.doc || !/^[a-z0-9-]+$/.test(o.doc)) throw new AppendError('amend needs --doc like ontology');
  if (!o.layer || !(LAYERS as readonly string[]).includes(o.layer)) throw new AppendError(`amend needs --layer ${LAYERS.join('|')}`);
  if (!o.reason) throw new AppendError('amend needs --reason');
  const path = proposedPath(cell, o.doc);
  if (!existsSync(path)) throw new AppendError(`stage the new version first at ${path}`);
  const content = readText(path);
  const content_hash = sha256(content);
  const current = foldBedrock(readLog(cell))[o.doc];
  const base = existsSync(basePath(cell, o.doc)) ? readFileSync(basePath(cell, o.doc), 'utf8').trim() : null;
  if (base && current && base !== current.live_hash)
    throw new AppendError(`proposed/${o.doc}.md was staged from an older version of ${o.doc}.md, which has changed since; amending it would undo the newer text. Delete proposed/${o.doc}.md and .base, stage again, and redo the edit.`);
  if (current && current.live_hash === content_hash) throw new AppendError('proposed text is identical to the live version');
  if (current && current.pending.some((x) => x.content_hash === content_hash)) throw new AppendError('this exact text is already proposed');
  const voice = o.voice ?? 'claude';
  const from = append(cell, {
    kind: 'observation', body: { source: { adapter: voice === 'operator' ? 'operator' : 'claude', provider: 'bedrock' }, url: `state/bedrock/proposed/${o.doc}.md`,
      observed_at: new Date().toISOString(), reliability: [], licence: { store: 'full' }, payload: { doc: o.doc, content, content_hash } },
  }).id;
  const evidence = o.evidence?.split(',').map((x) => x.trim()).filter(Boolean) ?? [];
  const c = append(cell, {
    kind: 'claim', causes: [from],
    body: { about: [`thing:bedrock/${o.doc}`], kind: 'rule', from, voice,
      says: { action: 'propose', doc: o.doc, content_hash, layer: o.layer, reason: o.reason, evidence, base_hash: current?.approved?.content_hash ?? null } },
  });
  if (!current || current.status === 'draft') {
    // Nothing approved yet: the live file simply shows the latest draft.
    writeFileSync(livePath(cell, o.doc), content, 'utf8');
    unlinkSync(path);
  }
  if (existsSync(basePath(cell, o.doc))) unlinkSync(basePath(cell, o.doc));
  return [from, c.id];
}

// With several proposals pending, the operator names one (--proposal <entry>): approving a newer one drops the older
// ones; approving an older one keeps the newer pending. 01-HAIOS-PERS lost an ordering to "approve takes the latest".
export function approve(cell: string, o: { doc?: string; proposal?: string }): string[] {
  if (!o.doc) throw new AppendError('approve needs --doc');
  const log = readLog(cell);
  const pic = foldBedrock(log)[o.doc];
  if (!pic?.pending.length) throw new AppendError(`no pending proposal for ${o.doc}`);
  if (pic.pending.length > 1 && !o.proposal)
    throw new AppendError(`${pic.pending.length} proposals pending for ${o.doc}; name one with --proposal:\n` + pic.pending.map((x) => `  ${x.entry}  ${x.layer}  ${x.reason}`).join('\n'));
  const latest = o.proposal ? pic.pending.find((x) => x.entry === o.proposal) : pic.pending[0];
  if (!latest) throw new AppendError(`${o.proposal} is not a pending proposal for ${o.doc} (pending: ${pic.pending.map((x) => x.entry).join(', ')})`);
  const content = proposalContent(log, latest.entry);
  if (sha256(content) !== latest.content_hash) throw new AppendError('logged proposal content does not match its hash');
  const from = append(cell, {
    kind: 'observation', causes: [latest.entry], body: { source: { adapter: 'operator', provider: 'bedrock' },
      observed_at: new Date().toISOString(), reliability: [], licence: { store: 'full' }, payload: { approved: latest.entry, doc: o.doc } },
  }).id;
  const c = append(cell, {
    kind: 'claim', causes: [latest.entry, from],
    body: { about: [`thing:bedrock/${o.doc}`], kind: 'rule', from, voice: 'operator',
      says: { action: 'approve', doc: o.doc, content_hash: latest.content_hash, proposal: latest.entry } },
  });
  mkdirSync(bedrockDir(cell), { recursive: true });
  writeFileSync(livePath(cell, o.doc), content, 'utf8');
  if (existsSync(proposedPath(cell, o.doc))) unlinkSync(proposedPath(cell, o.doc));
  return [from, c.id];
}

// Used once to register a doc that predates the guard: logs the current live file as a draft proposal.
export function register(cell: string, o: { doc?: string; layer?: string; reason?: string; voice?: string }): string[] {
  if (!o.doc) throw new AppendError('register needs --doc');
  if (foldBedrock(readLog(cell))[o.doc]) throw new AppendError(`${o.doc} is already registered`);
  mkdirSync(join(bedrockDir(cell), 'proposed'), { recursive: true });
  writeFileSync(proposedPath(cell, o.doc), readText(livePath(cell, o.doc)), 'utf8');
  return amend(cell, { ...o, reason: o.reason ?? 'register existing draft under the bedrock guard' });
}

export function lintBedrock(cell: string, log: Entry[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const pics = foldBedrock(log);
  const dir = bedrockDir(cell);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
  for (const f of files) {
    const doc = f.slice(0, -3);
    const p = pics[doc];
    if (!p) { errors.push(`bedrock/${f}: not registered in the log (amend or register it)`); continue; }
    if (sha256(readText(join(dir, f))) !== p.live_hash) errors.push(`bedrock/${f}: edited outside an amendment (hash ≠ ${p.status} version)`);
  }
  for (const p of Object.values(pics)) {
    if (!files.includes(`${p.doc}.md`)) errors.push(`bedrock/${p.doc}.md: missing (log has it)`);
    if (p.status === 'draft') warnings.push(`bedrock/${p.doc}.md is a draft — operator approval pending (! node kernel/src/cli.ts approve --doc ${p.doc})`);
    else if (p.pending.length) warnings.push(`bedrock/${p.doc}.md has ${p.pending.length} pending proposal(s)`);
  }
  return { errors, warnings };
}
