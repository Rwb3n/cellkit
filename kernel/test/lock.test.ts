// Every append holds the log's lock, so concurrent writers never fork the chain; assumption ids are chosen under it.
// The first three tests are SF-DEV's (kernel/test/lock.test.ts). Concurrency code is stress-tested: one clean run of a
// race proves nothing (two writers took one id about 1 run in 20 on Windows without the lock).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { append, lockPath, readLog, withLock, writer } from '../src/log.ts';
import { assume, nextAssumptionId } from '../src/generators.ts';
import { lint } from '../src/lint.ts';

const fresh = () => mkdtempSync(join(tmpdir(), 'cellkit-lock-'));
const obs = { source: { adapter: 'test' }, observed_at: '2026-10-11T00:00:00Z', reliability: [], licence: { store: 'full' }, payload: {} };
const src = (f: string) => JSON.stringify('file:///' + resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', f).replaceAll('\\', '/'));

// n node processes running `script` at once; resolves when all exit, with their stderr if any failed
function processes(n: number, script: string): Promise<string[]> {
  const errors: string[] = [];
  const run = () => new Promise<void>((ok) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => { if (code) errors.push(err.split('\n').slice(0, 6).join('\n')); ok(); });
  });
  return Promise.all(Array.from({ length: n }, run)).then(() => errors);
}

test('two writers with the same cached tail: an observation and a claim never share an id', () => {
  const cell = fresh();
  append(cell, { kind: 'observation', body: obs });                 // 000001
  const a = writer(cell), b = writer(cell);
  a.append({ kind: 'observation', body: obs });                      // b's tail is now stale
  b.append({ kind: 'observation', body: obs });
  const c = b.append({ kind: 'claim', body: { about: ['thing:x'], kind: 'fact', says: 'y', from: '000001', voice: 'voice:a' } });
  assert.equal(c.id, '000004');
  const log = readLog(cell);
  assert.deepEqual(log.map((e) => e.id), ['000001', '000002', '000003', '000004']);
  assert.equal(log[2].prev, log[1].hash);
  assert.deepEqual(lint(cell).errors, []);
  assert.equal(existsSync(lockPath(cell)), false, 'the lock is released');
});

test('a lock left by a process that is gone is taken over', () => {
  const cell = fresh();
  mkdirSync(join(cell, 'state'), { recursive: true });
  writeFileSync(lockPath(cell), JSON.stringify({ pid: 2 ** 22 + 12345, at: '2026-10-11T00:00:00Z' }));
  append(cell, { kind: 'observation', body: obs });
  assert.equal(readLog(cell).length, 1);
  assert.equal(existsSync(lockPath(cell)), false);
});

test('the lock nests in one process, and is released once, at the outermost', () => {
  const cell = fresh();
  withLock(cell, () => {
    append(cell, { kind: 'observation', body: obs });
    withLock(cell, () => append(cell, { kind: 'observation', body: obs }));
    assert.ok(existsSync(lockPath(cell)), 'still held by the outer hold');
  });
  assert.equal(existsSync(lockPath(cell)), false);
  assert.equal(readLog(cell).length, 2);
});

test('eight processes appending at once: every entry lands, the chain holds, lint is clean', async () => {
  const cell = fresh();
  append(cell, { kind: 'observation', body: obs });
  const errors = await processes(8, `import { append } from ${src('log.ts')};
    for (let i = 0; i < 10; i++) append(${JSON.stringify(cell)}, { kind: i % 2 ? 'claim' : 'observation',
      body: i % 2 ? { about: ['thing:x'], kind: 'fact', says: 'y', from: '000001', voice: 'voice:p' } : ${JSON.stringify(obs)} });`);
  assert.deepEqual(errors, []);
  assert.equal(readLog(cell).length, 81);
  assert.deepEqual(lint(cell).errors, []);
});

test('assume without --id takes one past the highest; with --id, that one', () => {
  const cell = fresh();
  assert.equal(nextAssumptionId(cell), 'A1');
  assert.equal(assume(cell, { statement: 'one' })[0], 'A1');
  assert.equal(assume(cell, { id: 'A7', statement: 'seven' })[0], 'A7');
  assert.equal(assume(cell, { statement: 'eight' })[0], 'A8');
  assert.throws(() => assume(cell, { id: 'B1', statement: 'x' }), /like A1/);
  assert.deepEqual(lint(cell).errors, []);
});

test('eight processes assuming at once, without --id: every id distinct, each claim right after its observation', async () => {
  const cell = fresh();
  const errors = await processes(8, `import { assume } from ${src('generators.ts')};
    for (let i = 0; i < 5; i++) assume(${JSON.stringify(cell)}, { statement: 'from pid ' + process.pid + ' #' + i });`);
  assert.deepEqual(errors, []);
  const log = readLog(cell);
  const claims = log.filter((e) => e.kind === 'claim');
  const ids = claims.map((e) => (e.body as { about: string[] }).about[0]);
  assert.equal(claims.length, 40);
  assert.equal(new Set(ids).size, 40, 'no id taken twice');
  for (const c of claims) assert.equal(c.causes[0], String(Number(c.id) - 1).padStart(6, '0'), 'its observation is the entry before it');
  assert.deepEqual(lint(cell).errors, []);
});
