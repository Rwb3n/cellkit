// Hand approval — the standing step for "the rule says no, the evidence says probably yes".
//   raise   a cell (or root) proposes ONE exact claim, with its evidence → thing:review/R-NNNN, open
//   decide  the operator only (hook-blocked for agents, like approve): yes → the kernel appends the proposed
//           claim in voice:operator, caused by the review and the decision; no → rejected, never raised again
//           with the same evidence.
// Everything is on the log, so a decision is traceable like any other claim.
import { canonical, sha256 } from './canon.ts';
import { AppendError, readLog, writer, type Entry } from './log.ts';
import { check } from './schemas.ts';

export interface ReviewPicture {
  id: string; status: 'open' | 'approved' | 'rejected';
  question: string; proposes: Record<string, unknown>; evidence: Record<string, unknown>;
  raised_by: string; raised: string; decided?: string; note?: string; landed?: string;
  key: string; evidence_key: string;
}

const subject = (id: string) => `thing:review/${id}`;
const isReview = (e: Entry) => e.kind === 'claim' && (e.body as { about: string[] }).about.some((a) => a.startsWith('thing:review/'));

export function foldReviews(log: Entry[]): Record<string, ReviewPicture> {
  const out: Record<string, ReviewPicture> = {};
  for (const e of log) {
    if (isReview(e)) {
      const b = e.body as { voice: string; says: { review: string; id: string; question?: string; proposes?: Record<string, unknown>; evidence?: Record<string, unknown>; decision?: string; note?: string } };
      const s = b.says;
      if (s.review === 'raise')
        out[s.id] = { id: s.id, status: 'open', question: s.question!, proposes: s.proposes!, evidence: s.evidence!, raised_by: b.voice, raised: e.id,
          key: sha256(canonical(s.proposes)), evidence_key: sha256(canonical(s.evidence)) };
      else if (s.review === 'decide' && out[s.id]) Object.assign(out[s.id], { status: s.decision === 'yes' ? 'approved' : 'rejected', decided: e.id, note: s.note });
    } else if (e.kind === 'claim') {
      // the claim a "yes" landed: caused by the review's decision
      for (const r of Object.values(out)) if (r.decided && e.causes.includes(r.decided) && !r.landed) r.landed = e.id;
    }
  }
  return out;
}

export function raise(cell: string, o: { question?: string; proposes?: Record<string, unknown>; evidence?: Record<string, unknown>; voice?: string }): { id: string; entries: string[] } {
  if (!o.question || !o.proposes || !o.evidence) throw new AppendError('review raise needs question, proposes (one exact claim, without "from") and evidence');
  const { from: _f, voice: _v, ...proposes } = o.proposes as Record<string, unknown>;
  const errs = check('claim', { ...proposes, from: '000001', voice: 'voice:operator' });
  if (errs.length) throw new AppendError(`the proposed claim is invalid:\n${errs.join('\n')}`);
  const log = readLog(cell);
  const reviews = Object.values(foldReviews(log));
  const key = sha256(canonical(proposes)), evidence_key = sha256(canonical(o.evidence));
  if (reviews.some((r) => r.key === key && r.status === 'open')) throw new AppendError('this exact claim is already waiting for review');
  if (reviews.some((r) => r.key === key && r.status === 'rejected' && r.evidence_key === evidence_key)) throw new AppendError('this was rejected with the same evidence — raise it again only with new evidence');
  const id = `R-${String(reviews.length + 1).padStart(4, '0')}`;
  const W = writer(cell);
  const obs = W.append({ kind: 'observation', body: { source: { adapter: 'kernel', capability: 'review-raise' }, observed_at: new Date().toISOString(), reliability: [], licence: { store: 'full' }, payload: { review: id, evidence: o.evidence } } });
  const c = W.append({ kind: 'claim', causes: [obs.id], body: { about: [subject(id)], kind: 'fact', from: obs.id, voice: o.voice ?? 'voice:root',
    says: { review: 'raise', id, question: o.question, proposes, evidence: o.evidence } } });
  return { id, entries: [obs.id, c.id] };
}

export function decide(cell: string, o: { id?: string; yes?: boolean; note?: string }): string[] {
  if (!o.id || o.yes === undefined) throw new AppendError('review decide needs --id R-NNNN and --yes or --no');
  const r = foldReviews(readLog(cell))[o.id];
  if (!r) throw new AppendError(`no review ${o.id}`);
  if (r.status !== 'open') throw new AppendError(`${o.id} is already ${r.status}`);
  const W = writer(cell);
  const obs = W.append({ kind: 'observation', causes: [r.raised], body: { source: { adapter: 'operator', capability: 'review-decide' }, observed_at: new Date().toISOString(), reliability: [], licence: { store: 'full' }, payload: { review: o.id, decision: o.yes ? 'yes' : 'no', ...(o.note ? { note: o.note } : {}) } } });
  const d = W.append({ kind: 'claim', causes: [r.raised, obs.id], body: { about: [subject(o.id)], kind: 'fact', from: obs.id, voice: 'voice:operator',
    says: { review: 'decide', id: o.id, decision: o.yes ? 'yes' : 'no', ...(o.note ? { note: o.note } : {}) } } });
  if (!o.yes) return [obs.id, d.id];
  const landed = W.append({ kind: 'claim', causes: [r.raised, d.id], body: { ...r.proposes, from: obs.id, voice: 'voice:operator' } });
  return [obs.id, d.id, landed.id];
}
