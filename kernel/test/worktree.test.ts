// One git worktree per cell: a shared mailbox outside both checkouts, root-log writes from a worktree land in the main
// checkout, a session opened in the wrong checkout is refused, the audit reads only the cell's branch, and cellrun
// starts a cell headless in its own worktree only when mail is queued.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { cellNew } from '../src/cell.ts';
import { readLog } from '../src/log.ts';
import { current, mailbox, receive, send, status, takeNext } from '../src/mail.ts';
import { cellAudit, cellCheckout, cellWorktree, gitCommonDir, inMain, misplaced, samePath } from '../src/worktree.ts';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
const run = (script: string, args: string[], env: Record<string, string> = {}, input = '{}') =>
  spawnSync(process.execPath, [join(src, script), ...args], { input, env: { ...process.env, ...env }, encoding: 'utf8' });
const hook = (script: string, project: string, tool_input: Record<string, string>) =>
  run(script, [], { CLAUDE_PROJECT_DIR: project }, JSON.stringify({ cwd: project, tool_input }));
const stop = (project: string, answer = 'answer') =>
  run('mail-hook.ts', [], { CLAUDE_PROJECT_DIR: project, CELLKIT_MAIL_WAIT: '0' }, JSON.stringify({ cwd: project, last_assistant_message: answer }));
const mailOn = (dir: string) => readLog(dir).filter((e) => (e.body as { source: { capability?: string } }).source?.capability === 'mail');

// A repo with cells demo and other committed at HEAD, and demo checked out. With kernel: a copy of this kernel (src,
// schemas, package.json) committed, and its runtime node_modules installed (git-ignored) in the main checkout only.
function world(t: TestContext, o: { kernel?: boolean } = {}) {
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'cellkit-wt-')));
  const main = join(tmp, 'repo');
  mkdirSync(join(main, 'kernel'), { recursive: true });
  writeFileSync(join(main, 'kernel', '.gitkeep'), '');
  if (o.kernel) {
    const k = resolve(src, '..');
    for (const d of ['src', 'schemas', 'package.json']) cpSync(join(k, d), join(main, 'kernel', d), { recursive: true });
    const devOnly = /node_modules[\\/](typescript|@types|undici-types)([\\/]|$)/;
    // run from a cell's worktree, this kernel has no node_modules of its own either: take the main checkout's (as schemas.ts does)
    const modules = existsSync(join(k, 'node_modules')) ? join(k, 'node_modules') : join(inMain(k), 'node_modules');
    cpSync(modules, join(main, 'kernel', 'node_modules'), { recursive: true, filter: (f) => !devOnly.test(f) });
  }
  writeFileSync(join(main, '.gitignore'), 'node_modules/\n**/state/views/\n');
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'core.autocrlf', 'false');
  for (const name of ['demo', 'other']) cellNew(main, { name });
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'init');
  const wt = cellCheckout(main, { name: 'demo' });
  t.after(() => {
    for (const l of git(main, 'worktree', 'list', '--porcelain').split(/\r?\n/))
      if (l.startsWith('worktree ') && !samePath(l.slice(9), main)) spawnSync('git', ['-C', main, 'worktree', 'remove', '--force', l.slice(9)]);
    rmSync(tmp, { recursive: true, force: true });
  });
  return { tmp, main, wt, cellWt: join(wt, 'cells', 'demo'), cellMain: join(main, 'cells', 'demo') };
}

test('worktree: cell checkout makes a worktree on branch cell/<name> beside the repo, whose own kernel copy runs', (t) => {
  const { tmp, main, wt, cellWt } = world(t, { kernel: true });
  assert.ok(samePath(wt, join(tmp, 'repo-cells', 'demo')));
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'cell/demo');
  assert.ok(samePath(cellWorktree(main, 'demo')!, wt));
  assert.equal(cellWorktree(main, 'other'), null);
  assert.ok(readFileSync(join(cellWt, 'AGENTS.md'), 'utf8').includes('branch `cell/demo`'));   // the brief says so
  // node_modules is git-ignored, so the worktree has none: its kernel copy (the cell's hooks) loads the main checkout's
  assert.equal(existsSync(join(wt, 'kernel', 'node_modules')), false);
  const lint = spawnSync(process.execPath, [join(wt, 'kernel', 'src', 'cli.ts'), 'lint', '--cell', cellWt], { encoding: 'utf8' });
  assert.equal(lint.status, 0, lint.stderr);
  const stopped = spawnSync(process.execPath, [join(wt, 'kernel', 'src', 'mail-hook.ts')], { input: '{}', encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: cellWt, CELLKIT_MAIL_WAIT: '0' } });
  assert.equal(stopped.status, 0, stopped.stderr);
  git(main, 'worktree', 'remove', '--force', wt);
  assert.ok(existsSync(join(main, 'kernel', 'node_modules', 'ajv', 'package.json')));   // main's are left alone
});

test('worktree: checkout refuses a cell not committed at HEAD, a second worktree, and a folder outside git', (t) => {
  const { main } = world(t);
  cellNew(main, { name: 'fresh' });
  assert.throws(() => cellCheckout(main, { name: 'fresh' }), /not committed at HEAD/);
  assert.throws(() => cellCheckout(main, { name: 'demo' }), /already has a worktree/);
  assert.throws(() => cellCheckout(main, { name: 'nope' }), /no cell cells\/nope/);
  const plain = realpathSync.native(mkdtempSync(join(tmpdir(), 'cellkit-nogit-')));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  cellNew(plain, { name: 'c1' });
  assert.throws(() => cellCheckout(plain, { name: 'c1' }), /not a git repository/);
});

test('worktree: root and the cell\'s worktree share one mailbox outside both checkouts; each log records mail in one place', (t) => {
  const { main, wt, cellWt, cellMain } = world(t);
  assert.equal(mailbox(cellMain), mailbox(cellWt));
  assert.ok(samePath(mailbox(cellWt), join(gitCommonDir(main)!, 'cellkit-mail', 'demo')));
  assert.ok(samePath(mailbox(main), join(gitCommonDir(main)!, 'cellkit-mail', 'root')));
  const t1 = send(main, 'demo', 'count the places');                       // root, in the main checkout
  assert.equal(takeNext(cellWt)!.id, t1.id);                                // the cell's Stop hook, in its worktree
  send(cellWt, 'root', 'need X decided', 'question');                       // a cell's own mail, from its worktree
  const [question] = receive(main);
  assert.equal(question.kind, 'question');
  assert.equal(stop(cellWt, '445 places').status, 0);                       // the reply, filed by the real hook
  assert.deepEqual(receive(main).map((m) => [m.kind, m.body, m.reply_to]), [['reply', '445 places', t1.id]]);
  // mail on the log: the cell's log on its branch (worktree copy), root's in the main checkout; no copy forks
  assert.deepEqual(mailOn(cellWt).map((e) => (e.body as { payload: { kind: string } }).payload.kind), ['task', 'question', 'reply']);
  assert.equal(mailOn(cellMain).length, 0);
  assert.equal(mailOn(main).length, 3);
  assert.equal(mailOn(wt).length, 0);
});

test('worktree: root-log writes made from a worktree land in the main checkout\'s log', (t) => {
  const { main, wt } = world(t);
  const before = { main: readLog(main).length, wt: readLog(wt).length };
  const r = run('cli.ts', ['assume', '--cell', wt, '--id', 'A1', '--voice', 'claude', '--statement', 's', '--test', 't']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readLog(main).length, before.main + 2);
  assert.equal(readLog(wt).length, before.wt);                               // the worktree's copy never forks
  assert.equal(run('cli.ts', ['lint', '--cell', wt]).status, 0);             // reads stay local
});

test('worktree: a session opened in the main checkout is refused — no writes, no new mail — and told where to reopen', (t) => {
  const { main, cellWt, cellMain } = world(t);
  const g = hook('hook-guard.ts', cellMain, { file_path: join(cellMain, 'MODEL.md') });
  assert.equal(g.status, 2, g.stderr);
  assert.ok(g.stderr.includes(cellWt), g.stderr);
  assert.equal(hook('hook-guard.ts', cellWt, { file_path: join(cellWt, 'MODEL.md') }).status, 0);   // its own worktree: fine
  const bash = (project: string, command: string) => hook('hook-bash.ts', project, { command }).status;
  assert.equal(bash(cellMain, 'echo x > MODEL.md'), 2);
  assert.equal(bash(cellMain, 'git status'), 2);
  assert.equal(bash(cellMain, 'node ../../kernel/src/cli.ts append --cell . --kind observation --body o.json'), 2);
  assert.equal(bash(cellMain, 'node ../../kernel/src/cli.ts lint --cell .'), 0);
  assert.equal(bash(cellMain, 'node ../../kernel/src/mail.ts send --to root --kind blocked --body "wrong checkout"'), 0);
  assert.equal(bash(cellWt, 'echo x > MODEL.md'), 0);
  // a message in flight is still answered; the next one waits for the session in the worktree
  const t1 = send(main, 'demo', 'first'), t2 = send(main, 'demo', 'second');
  takeNext(cellWt);
  const s = stop(cellMain, 'I am in the wrong checkout');
  assert.equal(s.stdout.trim(), '');                                         // nothing handed over
  assert.ok(s.stderr.includes(cellWt), s.stderr);
  assert.deepEqual(receive(main).map((m) => m.reply_to), [t1.id]);
  assert.deepEqual([status(cellWt).unread, current(cellWt)], [1, null]);
  assert.ok(JSON.parse(stop(cellWt).stdout).reason.includes('second'));      // the right session takes it
  assert.equal(current(cellWt), t2.id);
});

test('worktree: a session opened in another cell\'s worktree is refused', (t) => {
  const { main, cellWt } = world(t);
  const otherWt = cellCheckout(main, { name: 'other' });
  const stray = join(otherWt, 'cells', 'demo');
  const g = hook('hook-guard.ts', stray, { file_path: join(stray, 'MODEL.md') });
  assert.equal(g.status, 2, g.stderr);
  assert.ok(g.stderr.includes('cell/other'), g.stderr);
  assert.ok(g.stderr.includes(cellWt), g.stderr);
  assert.equal(hook('hook-bash.ts', stray, { command: 'echo x > MODEL.md' }).status, 2);
  send(main, 'demo', 'a task');
  assert.equal(stop(stray).stdout.trim(), '');
  assert.equal(status(cellWt).unread, 1);
  assert.equal(misplaced(cellWt), null);
  assert.equal(misplaced(join(otherWt, 'cells', 'other')), null);
  assert.equal(misplaced(join(main, 'cells', 'other')) !== null, true);      // other now has a worktree too
});

test('worktree: cell audit reads only the cell\'s branch and worktree', (t) => {
  const { main, wt } = world(t);
  writeFileSync(join(wt, 'cells', 'demo', 'MODEL.md'), 'model');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'cell work');                                     // committed on cell/demo: inside, fine
  writeFileSync(join(main, 'README.md'), 'root\'s own work');               // not the cell's: never read
  assert.deepEqual(cellAudit(main, 'demo'), []);
  writeFileSync(join(wt, 'kernel', 'sneaky.ts'), 'x');                       // uncommitted, outside the cell
  assert.deepEqual(cellAudit(main, 'demo'), ['kernel/sneaky.ts']);
  const r = run('cli.ts', ['cell', 'audit', '--cell', main, '--name', 'demo']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('kernel/sneaky.ts'));
  assert.deepEqual(cellAudit(main, 'demo', ['kernel/**']), []);
  unlinkSync(join(wt, 'kernel', 'sneaky.ts'));
  mkdirSync(join(wt, 'state', 'log'), { recursive: true });
  writeFileSync(join(wt, 'state', 'log', '000999.observation.json'), '{}'); // a forked root log on the branch
  assert.deepEqual(cellAudit(main, 'demo'), ['state/log/000999.observation.json']);
  unlinkSync(join(wt, 'state', 'log', '000999.observation.json'));
  git(wt, 'rm', '-q', 'kernel/.gitkeep');
  git(wt, 'commit', '-qm', 'outside, committed');
  assert.deepEqual(cellAudit(main, 'demo'), ['kernel/.gitkeep']);
});

test('cellrun: starts the cell headless in its own worktree, only with mail queued and nothing in flight', (t) => {
  const { main, cellWt } = world(t);
  const cellrun = (...args: string[]) => { const r = run('cellrun.ts', ['--root', main, ...args]); return { code: r.status, out: r.stdout + r.stderr }; };
  assert.equal(cellrun('--cell', 'demo', '--dry-run').code, 4);             // nothing queued: nothing started
  send(main, 'demo', 'task one');
  send(main, 'demo', 'task two');
  const { code, out } = cellrun('--cell', 'demo', '--dry-run', '--wait', '5');
  assert.equal(code, 0, out);
  assert.ok(out.includes(`cwd ${cellWt}`), out);
  assert.ok(out.includes('env CELLKIT_MAIL_WAIT=5'), out);
  assert.ok(/claude(\.exe|\.cmd)?"? -p "waiting for mail" --permission-mode bypassPermissions --output-format stream-json --verbose/.test(out), out);
  assert.ok(out.includes(join(mailbox(cellWt), 'runs')), out);
  assert.equal(cellrun('--cell', 'other', '--dry-run').code, 2);            // no worktree: refused
  takeNext(cellWt);
  assert.equal(cellrun('--cell', 'demo', '--dry-run').code, 3);             // a session is already on a task
});
