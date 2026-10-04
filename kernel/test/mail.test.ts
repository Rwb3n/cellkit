// The cell mail loop: root sends → the Stop hook hands it over → the session's next answer comes back as the reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { send, receive, current } from '../src/mail.ts';

const hook = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mail-hook.ts');
const stop = (cell: string, answer: string) => {
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ cwd: cell, last_assistant_message: answer, stop_hook_active: false }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: cell, CELLKIT_MAIL_WAIT: '0' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
};

test('mail: nothing waiting → the session may stop', () => {
  const cell = mkdtempSync(join(tmpdir(), 'cellkit-mail-'));
  assert.equal(stop(cell, 'hello'), null);
});

test('mail: a message is handed over, the next answer becomes its reply, read/unread is tracked', () => {
  const cell = mkdtempSync(join(tmpdir(), 'cellkit-mail-'));
  const m1 = send(cell, 'count the places');
  const m2 = send(cell, 'then lint');

  const first = stop(cell, 'just started');                    // no current message: nothing filed
  assert.equal(first.decision, 'block');
  assert.ok(first.reason.includes('count the places'));
  assert.equal(current(cell), m1.id);
  assert.deepEqual(receive(cell), []);

  const second = stop(cell, '445 places');                      // answer to m1 filed; m2 handed over
  assert.ok(second.reason.includes('then lint'));
  const [r1] = receive(cell);
  assert.equal(r1.reply_to, m1.id);
  assert.equal(r1.body, '445 places');
  assert.deepEqual(receive(cell), []);                          // read once

  assert.equal(stop(cell, 'lint clean'), null);                 // answer to m2 filed; inbox empty → stop
  const [r2] = receive(cell, m2.id);
  assert.equal(r2.body, 'lint clean');
  assert.equal(current(cell), null);
  assert.deepEqual(readdirSync(join(cell, 'inbox')).filter((f) => f.endsWith('.json')), []);
  assert.equal(readdirSync(join(cell, 'inbox', 'read')).length, 2);
});
