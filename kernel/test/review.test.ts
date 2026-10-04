// Hand approval: a cell raises a review proposing one exact claim; only the operator decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { append, AppendError, readLog } from '../src/log.ts';
import { lint } from '../src/lint.ts';
import { raise, decide, foldReviews } from '../src/review.ts';

const fresh = () => {
  const cell = mkdtempSync(join(tmpdir(), 'cellkit-review-'));
  append(cell, { kind: 'observation', body: { source: { adapter: 'test' }, observed_at: '2026-10-04T00:00:00Z', reliability: [], licence: { store: 'full' } } });
  return cell;
};
const sameAs = { about: ['thing:place/hotel-st-pancras', 'thing:place/gmaps:terrace'], kind: 'same-as', says: 'Laurent-Perrier terrace = St. Pancras Terrace' };
const evidence = { dist_m: 0, name_sim: 0.62, check: 0.91, why: 'name rule rejects; checked reading names the terrace' };

test('review: raise → open; decide yes → the exact proposed claim lands in the operator\'s voice, traced', () => {
  const cell = fresh();
  const r = raise(cell, { question: 'Same place?', proposes: sameAs, evidence, voice: 'voice:cell/c1' });
  assert.equal(r.id, 'R-0001');
  assert.equal(foldReviews(readLog(cell))['R-0001'].status, 'open');
  decide(cell, { id: 'R-0001', yes: true, note: 'obviously the terrace' });
  const log = readLog(cell);
  const landed = log.at(-1)!;
  assert.equal((landed.body as { kind: string }).kind, 'same-as');
  assert.equal((landed.body as { voice: string }).voice, 'voice:operator');
  assert.deepEqual((landed.body as { about: string[] }).about, sameAs.about);
  assert.ok(landed.causes.length === 2);
  const pic = foldReviews(log)['R-0001'];
  assert.equal(pic.status, 'approved');
  assert.equal(pic.landed, landed.id);
  assert.deepEqual(lint(cell).errors, []);
});

test('review: no → rejected; the same proposal with the same evidence can\'t be raised again; new evidence can', () => {
  const cell = fresh();
  raise(cell, { question: 'Same place?', proposes: sameAs, evidence, voice: 'voice:cell/x' });
  decide(cell, { id: 'R-0001', yes: false, note: 'different terrace' });
  assert.equal(foldReviews(readLog(cell))['R-0001'].status, 'rejected');
  assert.throws(() => raise(cell, { question: 'Same place?', proposes: sameAs, evidence, voice: 'voice:cell/x' }), AppendError);
  const r2 = raise(cell, { question: 'Same place? (new photo)', proposes: sameAs, evidence: { ...evidence, photo: 'signage matches' }, voice: 'voice:cell/x' });
  assert.equal(r2.id, 'R-0002');
});

test('review: an invalid proposal is refused; a decision is made once; open duplicates are refused', () => {
  const cell = fresh();
  assert.throws(() => raise(cell, { question: 'q', proposes: { about: ['thing:a'], kind: 'same-as', says: 'x' }, evidence, voice: 'voice:cell/x' }), AppendError); // same-as needs 2 subjects
  raise(cell, { question: 'q', proposes: sameAs, evidence, voice: 'voice:cell/x' });
  assert.throws(() => raise(cell, { question: 'q again', proposes: sameAs, evidence: { other: 1 }, voice: 'voice:cell/x' }), AppendError); // already open
  decide(cell, { id: 'R-0001', yes: true });
  assert.throws(() => decide(cell, { id: 'R-0001', yes: false }), AppendError);
  assert.throws(() => decide(cell, { id: 'R-0009', yes: true }), AppendError);
});

test('review: agents can\'t decide (Bash hook), like approve', () => {
  const hook = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hook-bash.ts');
  const run = (command: string) => spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' }).status;
  assert.equal(run('node kernel/src/cli.ts review decide --cell cells/c1 --id R-0001 --yes'), 2);
  assert.equal(run('node kernel/src/cli.ts review list --all'), 0);
  assert.equal(run('node kernel/src/cli.ts review raise --file r.json'), 0);
});
