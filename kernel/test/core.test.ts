// The kit's own guarantees: the log can't be edited, claims trace back, checks attach to claims,
// assumptions live in the log, bedrock changes only by approved amendment, cells are born by script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { append, AppendError, readLog, writer } from '../src/log.ts';
import { fold } from '../src/fold.ts';
import { lint } from '../src/lint.ts';

const freshCell = () => mkdtempSync(join(tmpdir(), 'cellkit-'));
const obs = (extra: Record<string, unknown> = {}) => ({ source: { adapter: 'test' }, observed_at: '2026-01-01T00:00:00Z', reliability: [], licence: { store: 'full' }, payload: { x: 1 }, ...extra });

test('append chains entries; lint passes', () => {
  const cell = freshCell();
  append(cell, { kind: 'observation', body: obs() });
  append(cell, { kind: 'claim', body: { about: ['thing:x'], kind: 'fact', says: 'y', from: '000001', voice: 'voice:a' } });
  const log = readLog(cell);
  assert.equal(log[1].prev, log[0].hash);
  assert.deepEqual(lint(cell).errors, []);
});

test('lint catches an edited entry', () => {
  const cell = freshCell();
  append(cell, { kind: 'observation', body: obs() });
  const f = join(cell, 'state', 'log', readdirSync(join(cell, 'state', 'log'))[0]);
  const e = JSON.parse(readFileSync(f, 'utf8')); e.body.payload = { x: 2 }; writeFileSync(f, JSON.stringify(e));
  assert.ok(lint(cell).errors.some((m) => m.includes('hash mismatch')));
});

test('link-only payloads never reach disk', () => {
  const cell = freshCell();
  const e = append(cell, { kind: 'observation', body: obs({ licence: { store: 'link-only' } }) });
  assert.equal('payload' in e.body, false);
});

test('a claim must come from an earlier observation; a check must be about an earlier, non-check claim', () => {
  const cell = freshCell();
  assert.throws(() => append(cell, { kind: 'claim', body: { about: ['thing:x'], kind: 'fact', says: 'y', from: '000001', voice: 'v' } }), AppendError);
  const W = writer(cell);
  const o = W.append({ kind: 'observation', body: obs() }).id;
  const c = W.append({ kind: 'claim', body: { about: ['thing:x'], kind: 'fact', says: 'y', from: o, voice: 'voice:a' } }).id;
  assert.throws(() => W.append({ kind: 'claim', body: { about: ['claim:000099'], kind: 'check', says: { p: 0.9 }, from: o, voice: 'voice:model/m' } }), AppendError);
  assert.throws(() => W.append({ kind: 'claim', body: { about: ['thing:x'], kind: 'check', says: { p: 0.9 }, from: o, voice: 'voice:model/m' } }), AppendError);
  const k = W.append({ kind: 'claim', body: { about: [`claim:${c}`], kind: 'check', says: { p: 0.9 }, from: o, voice: 'voice:model/m' } }).id;
  assert.throws(() => W.append({ kind: 'claim', body: { about: [`claim:${k}`], kind: 'check', says: { p: 0.9 }, from: o, voice: 'voice:model/m' } }), AppendError);
  assert.equal(fold(readLog(cell)).checks[c], 0.9);
  assert.deepEqual(lint(cell).errors, []);
});

test('assumptions and constraints live in the log and fold with their history', async () => {
  const { assume, evidence, constraint } = await import('../src/generators.ts');
  const cell = freshCell();
  assume(cell, { id: 'A1', voice: 'claude', statement: 'x is true', test: 'look' });
  evidence(cell, { id: 'A1', status: 'some', note: 'n=1' });
  constraint(cell, { slug: 'scope', text: 'one city only' });
  const p = fold(readLog(cell));
  assert.equal(p.hypotheses.A1.status, 'some');
  assert.equal(p.hypotheses.A1.history.length, 2);
  assert.equal(p.constraints[0].text, 'one city only');
  assert.deepEqual(lint(cell).errors, []);
});

test('bedrock: register → draft; amendments stay pending until approved; hand edits fail lint', async () => {
  const { register, amend, approve, foldBedrock } = await import('../src/bedrock.ts');
  const cell = freshCell();
  mkdirSync(join(cell, 'state', 'bedrock', 'proposed'), { recursive: true });
  const live = join(cell, 'state', 'bedrock', 'doc.md'), staged = join(cell, 'state', 'bedrock', 'proposed', 'doc.md');
  writeFileSync(live, 'v0.1\n');
  register(cell, { doc: 'doc', layer: 'meta' });
  approve(cell, { doc: 'doc' });
  writeFileSync(staged, 'v0.2\r\n');                     // CRLF hashes like LF
  amend(cell, { doc: 'doc', layer: 'rules', reason: 'r' });
  assert.equal(readFileSync(live, 'utf8'), 'v0.1\n');
  writeFileSync(live, 'sneaky\n');
  assert.ok(lint(cell).errors.some((m) => m.includes('edited outside an amendment')));
  writeFileSync(live, 'v0.1\n');
  approve(cell, { doc: 'doc' });
  assert.equal(readFileSync(live, 'utf8').replace(/\r/g, ''), 'v0.2\n');
  assert.equal(foldBedrock(readLog(cell)).doc.pending.length, 0);
  assert.deepEqual(lint(cell).errors, []);
});

test('bedrock: a copy staged from an older live version is refused; with several pending, approve names one', async () => {
  const { register, amend, approve, stage, foldBedrock } = await import('../src/bedrock.ts');
  const cell = freshCell();
  mkdirSync(join(cell, 'state', 'bedrock', 'proposed'), { recursive: true });
  const live = join(cell, 'state', 'bedrock', 'doc.md'), staged = join(cell, 'state', 'bedrock', 'proposed', 'doc.md');
  writeFileSync(live, 'v1\n');
  register(cell, { doc: 'doc', layer: 'meta' });
  approve(cell, { doc: 'doc' });
  stage(cell, { doc: 'doc' });                                     // an agent starts editing from v1…
  assert.equal(readFileSync(staged, 'utf8'), 'v1\n');
  assert.throws(() => stage(cell, { doc: 'doc' }), /already staged/);
  const early = readFileSync(staged, 'utf8');
  writeFileSync(staged, 'v2\n');                                   // …meanwhile v2 is proposed and approved
  amend(cell, { doc: 'doc', layer: 'rules', reason: 'v2' });
  approve(cell, { doc: 'doc' });
  stage(cell, { doc: 'doc' });
  writeFileSync(join(cell, 'state', 'bedrock', 'proposed', 'doc.base'), '0'.repeat(64) + '\n');   // the old copy's base
  writeFileSync(staged, early + 'from v1\n');
  assert.throws(() => amend(cell, { doc: 'doc', layer: 'rules', reason: 'stale' }), /staged from an older version/);
  writeFileSync(join(cell, 'state', 'bedrock', 'proposed', 'doc.base'), '');                    // no base recorded: no check
  amend(cell, { doc: 'doc', layer: 'rules', reason: 'a' });
  writeFileSync(staged, 'v2\nb\n');
  amend(cell, { doc: 'doc', layer: 'rules', reason: 'b' });
  const [a, b] = foldBedrock(readLog(cell)).doc.pending;
  assert.throws(() => approve(cell, { doc: 'doc' }), /2 proposals pending .*--proposal/s);
  assert.throws(() => approve(cell, { doc: 'doc', proposal: '999999' }), /not a pending proposal/);
  approve(cell, { doc: 'doc', proposal: a.entry });                // the older one: the newer stays pending
  assert.deepEqual(foldBedrock(readLog(cell)).doc.pending.map((x) => x.entry), [b.entry]);
  assert.equal(readFileSync(live, 'utf8'), 'v1\nfrom v1\n');
});

test('cell new: born by script with brief, hooks, mailboxes, first entries, and a record in the parent', async () => {
  const { cellNew } = await import('../src/cell.ts');
  const root = freshCell();
  const b = join(root, 'b.json');
  writeFileSync(b, JSON.stringify({ scope: { city: 'Lisbon' } }));
  cellNew(root, { name: 'lisbon', binding: b });
  const dir = join(root, 'cells', 'lisbon');
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'binding.json', '.claude/settings.json']) assert.ok(readFileSync(join(dir, f), 'utf8').length);
  assert.ok(readFileSync(join(dir, '.claude/settings.json'), 'utf8').includes('mail-hook.ts'));
  for (const d of ['adapters', 'exit', 'test']) assert.ok(existsSync(join(dir, d, '.gitkeep')), d);   // every folder the brief names
  const brief = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.match(brief, /Durable output goes in `exit\/`/);
  assert.match(brief, /Work synchronously/);
  assert.equal(readLog(dir).length, 3);
  assert.equal(readLog(root).length, 2);
  assert.deepEqual(lint(dir).errors, []);
  assert.throws(() => cellNew(root, { name: 'lisbon', binding: b }), AppendError);
});

test('cell sync: root records a cell\'s head + published numbers once per move; lint catches a cell log changed under it', async () => {
  const { cellNew, cellSync, foldCells } = await import('../src/cell.ts');
  const { rmSync, mkdirSync: mk } = await import('node:fs');
  const root = freshCell();
  writeFileSync(join(root, 'b.json'), JSON.stringify({ scope: { city: 'X' } }));
  cellNew(root, { name: 'c1', binding: join(root, 'b.json') });
  const dir = join(root, 'cells', 'c1');
  const o = append(dir, { kind: 'observation', body: obs() });
  assert.equal(o.cell, 'c1');
  mk(join(dir, 'state', 'out'), { recursive: true });
  writeFileSync(join(dir, 'state', 'out', 'metrics.json'), JSON.stringify({ ranked: 7, note: 'ignored, not a number' }));
  cellSync(root);
  const c = foldCells(readLog(root)).c1;
  assert.equal(c.entries, 4);
  assert.equal((c.summary as { ranked: number }).ranked, 7);
  assert.equal((c.summary as { note?: string }).note, undefined);
  const n = readLog(root).length;
  cellSync(root);
  assert.equal(readLog(root).length, n);
  assert.deepEqual(lint(root).errors, []);
  rmSync(join(dir, 'state', 'log', '000004.observation.json'));
  assert.ok(lint(root).errors.some((m) => m.includes('no longer in its log')));
});
