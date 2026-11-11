// Mail: root sends a cell a task → the cell's Stop hook hands it over → the session's next answer lands in root's inbox.
// Cells may write only to root, and only reply · blocked · question · done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { send, receive, current, interim, claimWatch, status, release, unanswered, HOLD_MAX, MailError } from '../src/mail.ts';

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

test('mail: a task reaches the cell\'s log when it is handed over, not when it is sent (a queued task is no instruction)', async () => {
  const { readLog } = await import('../src/log.ts');
  const { root, c1 } = world();
  const kinds = (dir: string) => readLog(dir).filter((e) => (e.body as { source: { capability?: string } }).source?.capability === 'mail')
    .map((e) => (e.body as { payload: { kind: string; id: string } }).payload);
  const t1 = send(root, 'c1', 'first');
  send(root, 'c1', 'second');
  assert.deepEqual(kinds(c1), []);                                 // queued: nothing on the cell's log to find
  assert.deepEqual(kinds(root).map((p) => p.kind), ['task', 'task']);
  stop(c1, 'started');                                             // hands t1 over
  assert.deepEqual(kinds(c1).map((p) => p.id), [t1.id]);
  stop(c1, 'done one');                                            // reply to t1, hands t2 over
  assert.deepEqual(kinds(c1).map((p) => p.kind), ['task', 'reply', 'task']);
});

test('mail: guards.json mail.log "hash" keeps bodies out of every log; the mailbox still carries them', async (t) => {
  const { readLog } = await import('../src/log.ts');
  const { lint } = await import('../src/lint.ts');
  const { sha256 } = await import('../src/canon.ts');
  const { root, c1 } = world();
  const cfg = join(root, 'guards.json');
  writeFileSync(cfg, JSON.stringify({ mail: { log: 'hash' } }));
  process.env.CELLKIT_CONFIG = cfg;
  t.after(() => { delete process.env.CELLKIT_CONFIG; });
  const t1 = send(root, 'c1', 'call Ada Lovelace on 0123');
  assert.ok(stop(c1, 'started').reason.includes('call Ada Lovelace'));   // the session still gets the task
  stop(c1, 'Ada says yes');
  assert.equal(receive(root, t1.id)[0].body, 'Ada says yes');            // and root the reply
  for (const dir of [root, c1]) {
    const text = readLog(dir).map((e) => JSON.stringify(e)).join('\n');
    assert.ok(!/Ada/.test(text), `no body on ${dir}'s log`);
    assert.ok(text.includes(sha256('call Ada Lovelace on 0123')));
    assert.deepEqual(lint(dir).errors, []);
  }
});

test('mail: mail.log takes "body" or "hash"; a broken guards.json logs hashes', async () => {
  const { checkGuards, loadConfig } = await import('../src/config.ts');
  assert.deepEqual(checkGuards({ mail: { log: 'hash' } }), []);
  assert.deepEqual(checkGuards({ mail: { log: 'body' } }), []);
  assert.match(checkGuards({ mail: { log: 'none' } }).join(), /mail\.log must be "body" or "hash"/);
  assert.match(checkGuards({ mail: { keep: 1 } }).join(), /unknown key "keep"/);
  const dir = mkdtempSync(join(tmpdir(), 'cellkit-cfg-'));
  assert.equal(loadConfig(join(dir, 'none.json')).mailLog, 'body');
  writeFileSync(join(dir, 'bad.json'), '{ not json');
  assert.equal(loadConfig(join(dir, 'bad.json')).mailLog, 'hash');
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

// #90: `watch` marks mail read, so two watchers on one box race for it. One watcher per box.
const mailCli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mail.ts');
// run as the temp world's root: --root names its repository (a cell's session watches no box: #101)
const rootOfCell = (c1: string) => resolve(c1, '..', '..');
const asRoot = (c1: string) => ({ env: { ...process.env, CLAUDE_PROJECT_DIR: rootOfCell(c1) }, encoding: 'utf8' as const });
const watchRoot = (c1: string, ...args: string[]) => spawnSync(process.execPath, [mailCli, 'watch', '--root', rootOfCell(c1), '--as', 'root', ...args], asRoot(c1));

test('mail: one watcher per box: a second is refused and takes nothing; a dead one counts for nothing; --steal takes over (#90)', () => {
  const { root, c1 } = world();
  const lock = join(root, 'inbox', 'watch.lock');
  const first = claimWatch(root);                                   // a live watcher: this process
  const q = send(c1, 'root', 'need a decision', 'question');
  const second = watchRoot(c1);
  assert.equal(second.status, 1);
  assert.match(second.stderr, new RegExp(`refused: root's mail is already being watched \\(pid ${process.pid} since .*--steal`));
  assert.equal(watchRoot(c1, '--for', 'x1').status, 1);             // one for a single message could take the same mail
  const seen = status(root) as { unread: number; watched_by?: string };
  assert.equal(seen.unread, 1);                                     // nothing was taken…
  assert.match(seen.watched_by ?? '', new RegExp(`^pid ${process.pid} since `));
  assert.deepEqual(first.take()!.map((m) => m.id), [q.id]);        // …so the first watcher gets it
  first.release();
  assert.ok(!existsSync(lock));
  assert.ok(!('watched_by' in status(root)));

  const dead = spawnSync(process.execPath, ['-e', '']).pid!;        // a watcher that was killed leaves its lock
  writeFileSync(lock, JSON.stringify({ pid: dead, at: '2026-01-01T00:00:00.000Z' }));
  send(c1, 'root', 'second question', 'question');
  const third = watchRoot(c1);
  assert.equal(third.status, 0, third.stderr);
  assert.match(third.stdout, /second question/);
  assert.ok(!existsSync(lock));                                     // released on the way out

  const a = claimWatch(root, { forId: 'a1' });                      // watchers for different messages run side by side
  assert.equal(watchRoot(c1, '--for', 'b2').status, 0);
  assert.equal(watchRoot(c1, '--for', 'a1').status, 1);
  assert.equal(watchRoot(c1).status, 1);                            // a watch of the whole box could take a1's reply
  assert.match(watchRoot(c1, '--for', '../x').stderr, /--for takes a message id/);
  send(c1, 'root', 'third question', 'question');
  const thief = watchRoot(c1, '--steal');
  assert.equal(thief.status, 0, thief.stderr);
  assert.match(thief.stdout, /third question/);
  assert.equal(a.take(), null);                                     // taken over: it takes nothing more
  a.release();

  // pids are reused: a killed watcher's lock can name a live process that is no watcher, or this very process
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, at: '2026-01-01T00:00:00.000Z' }));
  assert.match(watchRoot(c1).stderr, /already being watched \(pid \d+ since 2026-01-01.*is not a mail watch.*--steal clears it/);
  assert.equal(watchRoot(c1, '--for', 'a1', '--steal').status, 0);  // one for a single message takes over a whole-box lock
  assert.ok(!existsSync(lock));
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: '2026-01-01T00:00:00.000Z' }));
  claimWatch(root).release();                                       // our pid, not our lock: nobody's
  writeFileSync(lock, JSON.stringify({ pid: 0, at: 'x' }));         // no process at all
  assert.equal(watchRoot(c1).status, 0);
  // a name that is no cell is nobody's box (its folder, once made, would read as root's)
  const typo = spawnSync(process.execPath, [mailCli, 'watch', '--root', root, '--as', 'typo'], asRoot(c1));
  assert.match(typo.stderr, /refused: no cell named typo/);
  assert.ok(!existsSync(join(root, 'cells', 'typo')));
  for (const bad of [['--for'], ['--for', '--steal']]) assert.match(watchRoot(c1, ...bad).stderr, /--for takes a message id/, bad.join(' '));
  // the short claim lock stuck (a leftover naming a live process): one line, no stack
  writeFileSync(join(root, 'inbox', 'watch.claim'), JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }));
  const stuck = watchRoot(c1);
  assert.equal(stuck.status, 1);
  assert.match(stuck.stderr, /^refused: the box's watch lock is busy: .*watch\.claim.*delete that file\s*$/);
});

test('mail: a waiting watcher that is taken over ends (exit 3) without taking the mail; of eight started at once, one watches (#90)', async () => {
  const { root, c1 } = world();
  const start = (...args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const p = spawn(process.execPath, [mailCli, 'watch', '--root', root, '--as', 'root', ...args], asRoot(c1));
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => done({ code, out, err }));
  });
  const waiting = start('--wait', '60');
  for (let i = 0; i < 400 && !existsSync(join(root, 'inbox', 'watch.lock')); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(watchRoot(c1, '--steal').stdout, /no unread mail/);  // takes over, finds nothing, leaves
  send(c1, 'root', 'the reply', 'question');
  const ended = await waiting;
  assert.equal(ended.code, 3, ended.err);
  assert.match(ended.err, /another watcher took this box over/);
  assert.doesNotMatch(ended.out, /the reply/);
  assert.equal(receive(root).length, 1);                            // still unread: nobody's output swallowed it

  const eight = await Promise.all(Array.from({ length: 8 }, () => start('--wait', '6')));
  assert.equal(eight.filter((r) => r.code === 0).length, 1, eight.map((r) => `${r.code} ${r.err}`).join('\n'));
  assert.equal(eight.filter((r) => r.code === 1 && /already being watched/.test(r.err)).length, 7);
});

// #101 (ecom-lab): a headless session told "waiting for mail" took its own task with `watch`: read, never in flight, so
// its answer was filed nowhere, and the run exited 0.
test('mail: a cell\'s box is never watched, and a cell watches no box: the task stays queued for the Stop hook, whose hand-over gets its reply filed (#101)', () => {
  const { root, c1, c2 } = world();
  const t1 = send(root, 'c1', 'count the places');
  const q = send(c2, 'root', 'c2 needs a decision', 'question');   // mail in root's box, another cell's
  const { CLAUDE_PROJECT_DIR: _, ...bare } = process.env;
  const cli = (args: string[], o: { project?: string; cwd?: string }) =>
    spawnSync(process.execPath, [mailCli, ...args], { env: { ...bare, ...(o.project ? { CLAUDE_PROJECT_DIR: o.project } : {}) }, cwd: o.cwd, encoding: 'utf8' });
  mkdirSync(join(c1, 'adapters'));
  // from the cell's own session, as it was done; from a folder inside the cell; and the flags a session tries next
  for (const where of [{ project: c1 }, { cwd: c1 }, { cwd: join(c1, 'adapters') }])
    for (const args of [['watch'], ['watch', '--as', 'c1'], ['recv'], ['watch', '--as', 'c1', '--steal'], ['watch', '--for', t1.id], ['watch', '--as', 'root'], ['watch', '--root', root, '--as', 'root']]) {
      const r = cli(args, where), what = `${args.join(' ')} from ${JSON.stringify(where)}`;
      assert.equal(r.status, 1, what);
      assert.match(r.stderr, /^refused: this is cell c1's session, and a cell watches no box: .*End your turn, and the task arrives( \(run from .*, you are cell c1\))?\s*$/, what);
      assert.equal(r.stdout, '', what);
    }
  // a folder inside a cell is the cell for sending too: it writes to root only, never a task to another cell
  assert.match(cli(['send', '--to', 'c2', '--body', 'do this'], { cwd: join(c1, 'adapters') }).stderr, /refused: a cell writes only to root \(not c2\) \(run from .*adapters, you are cell c1\)/);
  // only a cell's folder: a binding.json elsewhere makes no cell of the folders under it
  mkdirSync(join(root, 'lone', 'sub'), { recursive: true });
  writeFileSync(join(root, 'lone', 'binding.json'), '{}');
  assert.equal(JSON.parse(cli(['status', '--root', root], { cwd: join(root, 'lone', 'sub') }).stdout).box, 'root');
  assert.match(cli(['status', '--root'], { project: root }).stderr, /--root takes a repository folder/);
  // root, asking for a cell's box: refused too, and told where to look
  const asked = cli(['watch', '--root', root, '--as', 'c1'], { project: root });
  assert.equal(asked.status, 1);
  assert.match(asked.stderr, /^refused: c1 is a cell: its mail is handed to its session by the Stop hook.*status --as c1 shows what is queued/);
  assert.deepEqual((status(root) as { unread: number }).unread, 1);  // root's mail was taken by nobody
  assert.match(cli(['watch', '--root', root, '--as', 'root'], { project: root }).stdout, new RegExp(q.id));   // root reads its own
  assert.throws(() => receive(c1), MailError);
  assert.throws(() => claimWatch(c1), MailError);
  assert.ok(!existsSync(join(c1, 'inbox', 'watch.lock')));          // refused before anything is written
  assert.deepEqual([status(c1).unread, current(c1), 'unanswered' in status(c1)], [1, null, false]);   // still queued, nothing lost

  assert.ok(stop(c1, 'waiting for mail').reason.includes('count the places'));
  assert.equal(stop(c1, '445 places'), null);
  assert.equal(receive(root, t1.id)[0].body, '445 places');
});

test('mail: an answer of only spaces and newlines is still filed as a reply (#101)', () => {
  const { root, c1 } = world();
  const t = send(root, 'c1', 'run the suite');
  stop(c1, 'started');
  assert.equal(stop(c1, ' \n\t\n'), null);                          // the hook must not throw with the task no longer in flight
  assert.equal(receive(root, t.id)[0].body, '(no answer text)');
  assert.deepEqual([current(c1), 'unanswered' in status(c1)], [null, false]);
});

test('mail: a task taken with no reply and not in flight shows in status as unanswered; release --for files its placeholder (#101)', () => {
  const { root, c1 } = world();
  const t1 = send(root, 'c1', 'map the new sheet');
  renameSync(join(c1, 'inbox', `${t1.id}.json`), join(c1, 'inbox', 'read', `${t1.id}.json`));   // read, and nothing made it the task in flight
  assert.deepEqual((status(c1) as { unanswered?: string[] }).unanswered, [t1.id]);
  assert.ok(!('unanswered' in status(root)));

  const t2 = send(root, 'c1', 'then state the currency');          // the task in flight is not unanswered; nor one answered
  stop(c1, 'started');
  assert.deepEqual(unanswered(c1), [t1.id]);
  assert.throws(() => release(c1, 'x', t2.id), /it is the task in flight: release it without --for/);
  stop(c1, 'all three are in pounds');
  assert.equal(receive(root, t2.id)[0].body, 'all three are in pounds');
  assert.deepEqual(unanswered(c1), [t1.id]);

  assert.throws(() => release(c1, 'x', 'nope'), MailError);
  const cli = (...args: string[]) => spawnSync(process.execPath, [mailCli, 'release', '--root', root, '--as', 'c1', ...args], asRoot(c1));
  assert.match(cli('--for').stderr, /--for takes a message id/);
  // during a live run (this process stands in for it) a hand-over could be between "read" and "in flight": no release
  writeFileSync(join(c1, 'runner.lock'), JSON.stringify({ pid: process.pid, at: 'now', state: 'running' }));
  assert.match(cli('--for', t1.id).stderr, new RegExp(`refused: c1 has a live run \\(pid ${process.pid}\\); let it finish, then release ${t1.id}\\. If that pid is not .*delete .*runner\\.lock`));
  rmSync(join(c1, 'runner.lock'));
  writeFileSync(join(c1, 'inbox', '.told-' + t1.id), 'then');      // root was told of it (cellrun): cleared with its reply
  writeFileSync(join(c1, 'outbox', 'read', 'torn.json'), '{ "id": ');   // a file that can't be read is no answer, and no crash
  assert.deepEqual(unanswered(c1), [t1.id]);
  const done = cli('--for', t1.id, '--note', 'read the worktree: the mapping is written, its check fails');
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, new RegExp(`^released: filed \\S+ as the reply to ${t1.id}`));
  const [r] = receive(root, t1.id);
  assert.deepEqual([r.kind, r.body], ['reply', 'read the worktree: the mapping is written, its check fails']);
  assert.ok(!('unanswered' in status(c1)) && !existsSync(join(c1, 'inbox', '.told-' + t1.id)));
  assert.throws(() => release(c1, 'again', t1.id), /is not a task c1 took and left unanswered/);   // one reply, not two

  const t3 = send(root, 'c1', 'a third');                           // with no note, the placeholder says what is known
  renameSync(join(c1, 'inbox', `${t3.id}.json`), join(c1, 'inbox', 'read', `${t3.id}.json`));
  release(c1, undefined, t3.id);
  assert.match(receive(root, t3.id)[0].body, /^\(released: the task was taken, and no reply was ever filed/);
});
