// Mail: root sends a cell a task → the cell's Stop hook hands it over → the session's next answer lands in root's inbox.
// Cells may write only to root, and only reply · blocked · question · done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { send, receive, current, interim, HOLD_MAX, MailError } from '../src/mail.ts';

const hook = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mail-hook.ts');
const world = () => {
  const root = mkdtempSync(join(tmpdir(), 'cellkit-mail-'));
  for (const c of ['c1', 'c2']) { mkdirSync(join(root, 'cells', c), { recursive: true }); writeFileSync(join(root, 'cells', c, 'binding.json'), '{}'); }
  return { root, c1: join(root, 'cells', 'c1'), c2: join(root, 'cells', 'c2') };
};
const stop = (cell: string, answer: string) => {
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ cwd: cell, last_assistant_message: answer, stop_hook_active: false }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: cell, CELLKIT_MAIL_WAIT: '0' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
};

test('mail: nothing waiting → the session may stop', () => {
  const { c1 } = world();
  assert.equal(stop(c1, 'hello'), null);
});

test('mail: tasks are handed over in order; each answer lands in root\'s inbox as a reply; read once', () => {
  const { root, c1 } = world();
  const t1 = send(root, 'c1', 'count the places');
  const t2 = send(root, 'c1', 'then lint');

  const first = stop(c1, 'just started');            // nothing current: nothing filed
  assert.ok(first.reason.includes('count the places'));
  assert.equal(current(c1), t1.id);
  assert.deepEqual(receive(root), []);

  const second = stop(c1, '445 places');               // reply to t1 → root inbox; t2 handed over
  assert.ok(second.reason.includes('then lint'));
  const [r1] = receive(root);
  assert.equal(r1.kind, 'reply');
  assert.equal(r1.from, 'c1');
  assert.equal(r1.reply_to, t1.id);
  assert.equal(r1.body, '445 places');
  assert.deepEqual(receive(root), []);

  assert.equal(stop(c1, 'lint clean'), null);          // reply to t2; inbox empty → stop
  assert.equal(receive(root, t2.id)[0].body, 'lint clean');
  assert.equal(current(c1), null);
  assert.equal(readdirSync(join(c1, 'inbox', 'read')).length, 2);
  assert.equal(readdirSync(join(root, 'outbox', 'read')).length, 2);   // root's sent record
});

test('mail: a cell may raise blocked/question/done to root, and nothing else', () => {
  const { root, c1 } = world();
  const q = send(c1, 'root', 'need a kernel change: X', 'blocked');
  assert.equal(receive(root)[0].kind, 'blocked');
  assert.ok(q.id);
  assert.throws(() => send(c1, 'c2', 'hi', 'question'), MailError);      // no cell-to-cell
  assert.throws(() => send(c1, 'root', 'do this', 'task'), MailError);   // cells don't give root tasks
  assert.throws(() => send(root, 'c1', 'fine', 'reply'), MailError);     // root sends tasks
  assert.throws(() => send(root, 'nope', 'x'), MailError);               // unknown cell
});

test('mail is on the log: every message is an observation on the sender\'s and the recipient\'s log, body included', async () => {
  const { readLog } = await import('../src/log.ts');
  const { lint } = await import('../src/lint.ts');
  const { root, c1 } = world();
  const t = send(root, 'c1', 'count the places');
  stop(c1, 'started');                // hands t over
  stop(c1, '445 places');             // files the reply
  const mailOn = (dir: string) => readLog(dir).filter((e) => (e.body as { source: { capability?: string } }).source?.capability === 'mail').map((e) => (e.body as { payload: { id: string; kind: string; body: string; reply_to?: string } }).payload);
  const r = mailOn(root), c = mailOn(c1);
  assert.deepEqual(r.map((m) => m.kind), ['task', 'reply']);
  assert.deepEqual(c.map((m) => m.kind), ['task', 'reply']);
  assert.equal(r[0].id, t.id);
  assert.equal(c[1].reply_to, t.id);
  assert.equal(c[1].body, '445 places');
  assert.deepEqual(lint(root).errors, []);
  assert.deepEqual(lint(c1).errors, []);
});

test('mail: a progress note is not a reply (the notes SF-DEV and AI-MMO saw filed); a real reply is', () => {
  for (const note of [
    "The test suite is still running. I'll write the reply once it finishes.",
    'Waiting for the gatecheck notification.',
    'Tests are running; waiting for the results.',
    'The export is still running; I will report when it completes.',
  ]) assert.ok(interim(note), note);
  for (const reply of [
    '445 places. Lint clean.',
    'Done: added the adapter (cells/c1/src/a.ts), 12 tests pass, nothing for root to decide.',
    'Blocked: need a kernel change, sent to root as blocked.',
    `Done. ${'Details of the change. '.repeat(20)} I'll follow up if root wants more.`,   // long: a reply that mentions a follow-up
  ]) assert.ok(!interim(reply), reply);
});

test('mail: the hook holds a progress note back (block, task stays current) up to HOLD_MAX times, then files it', () => {
  const { root, c1 } = world();
  const t = send(root, 'c1', 'run the suite');
  stop(c1, 'started');                                          // hands t over
  const note = 'The test suite is still running. I\'ll write the reply once it finishes.';
  for (let i = 0; i < HOLD_MAX; i++) {
    const held = stop(c1, note);
    assert.equal(held.decision, 'block');
    assert.ok(held.reason.includes('Not sent as your reply') && held.reason.includes(t.id));
    assert.equal(current(c1), t.id);
    assert.deepEqual(receive(root), []);
  }
  assert.equal(stop(c1, note), null);                           // held enough: filed as it is
  assert.equal(receive(root, t.id)[0].body, note);
  assert.equal(current(c1), null);

  const t2 = send(root, 'c1', 'run it again');                  // the counter is per message
  stop(c1, 'started');
  assert.equal(stop(c1, note).decision, 'block');
  assert.equal(stop(c1, '43 tests pass.'), null);
  assert.equal(receive(root, t2.id)[0].body, '43 tests pass.');
  assert.equal(readdirSync(join(c1, 'inbox')).filter((f) => f.startsWith('.held-')).length, 0);
});

test('mail: with no task in flight, a progress-sounding answer is not held', () => {
  const { c1 } = world();
  assert.equal(stop(c1, 'Waiting for mail.'), null);
});
