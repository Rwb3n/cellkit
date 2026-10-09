// One git worktree per cell: a shared mailbox outside both checkouts, root-log writes from a worktree land in the main
// checkout, a session opened in the wrong checkout is refused, the audit reads only the cell's branch, and cellrun
// starts a cell headless in its own worktree only when mail is queued.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  git(main, 'config', 'user.email', 't@t');                                 // cell land commits: no global identity needed
  git(main, 'config', 'user.name', 't');
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
  const gone = cellCheckout(main, { name: 'other' });                       // a worktree folder deleted by hand
  rmSync(gone, { recursive: true, force: true });
  assert.equal(cellWorktree(main, 'other'), null);                           // is no worktree: its main copy is the cell's
  git(main, 'worktree', 'prune');
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

test('worktree: a write to a cell log from the main checkout lands in the cell worktree, so its chain never forks', (t) => {
  const { cellWt, cellMain } = world(t);
  const before = { main: readLog(cellMain).length, wt: readLog(cellWt).length };
  const r = run('cli.ts', ['assume', '--cell', cellMain, '--id', 'A1', '--voice', 'claude', '--statement', 's', '--test', 't']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /has its own worktree; writing its log there/);
  assert.equal(readLog(cellMain).length, before.main);                       // the main checkout's copy is untouched
  assert.equal(readLog(cellWt).length, before.wt + 2);
  assert.equal(run('cli.ts', ['lint', '--cell', cellMain]).status, 0);       // reads stay local
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
  assert.match(cellrun('--cell', 'demo', '--dry-run').out, /mail\.ts release --as demo/);
});

test('cellrun: a run that dies mid-task files a reply saying so and frees the cell; release does it by hand', (t) => {
  const { main, cellWt } = world(t);
  const sent = send(main, 'demo', 'task one');
  send(main, 'demo', 'task two');
  // a "claude" that exits at once: node refuses claude's flags. Pretend the session took the task first, then died.
  takeNext(cellWt);
  const r = run('cellrun.ts', ['--root', main, '--cell', 'demo'], { CELLKIT_CLAUDE: process.execPath });
  assert.equal(r.status, 3, r.stderr);                                       // in flight: refused, and told how to free it
  const rel = run('mail.ts', ['release', '--as', 'demo'], { CLAUDE_PROJECT_DIR: cellWt });
  assert.equal(rel.status, 0, rel.stderr);
  assert.equal(current(cellWt), null);
  const [placeholder] = receive(main);
  assert.equal(placeholder.reply_to, sent.id);
  // now a run whose session takes task two, then dies before any stop files the reply
  const fake = join(tmpdir(), `cellkit-fake-claude-${process.pid}`);
  writeFileSync(`${fake}.mjs`, `import { takeNext } from ${JSON.stringify(pathToFileURL(join(src, 'mail.ts')).href)};
takeNext(process.cwd());
process.exit(1);
`);
  const exe = process.platform === 'win32' ? `${fake}.cmd` : fake;
  writeFileSync(exe, process.platform === 'win32' ? `@"${process.execPath}" "${fake}.mjs"
` : `#!/bin/sh
exec "${process.execPath}" "${fake}.mjs"
`, { mode: 0o755 });
  t.after(() => { rmSync(`${fake}.mjs`, { force: true }); rmSync(exe, { force: true }); });
  const died = run('cellrun.ts', ['--root', main, '--cell', 'demo'], { CELLKIT_CLAUDE: exe });
  assert.equal(died.status, 1, died.stdout + died.stderr);
  assert.match(died.stderr, /still in flight; filed/);
  assert.equal(status(cellWt).working_on, null);                             // the cell can run again
  const [reply] = receive(main);
  assert.match(reply.body, /without replying .* The task was not done/);
});

test('cell land: commits the cell\'s work, merges main in, checks, lands it --no-ff, and commits root\'s log', (t) => {
  const { main, wt, cellWt } = world(t);
  const land = (...args: string[]) => run('cli.ts', ['cell', 'land', '--cell', main, '--name', 'demo', ...args]);
  const clean = (dir: string) => git(dir, 'status', '--porcelain').trim();
  send(main, 'demo', 'write a report');                                     // mail: root-log entries, uncommitted
  takeNext(cellWt);
  mkdirSync(join(cellWt, 'exit'), { recursive: true });
  writeFileSync(join(cellWt, 'exit', 'report.md'), 'done\n');
  assert.match(land().stderr, /working on .*mail\.ts release/);           // mid-task: refused
  stop(cellWt, 'report written');
  receive(main);
  writeFileSync(join(main, 'notes.md'), 'mine\n');
  assert.match(land().stderr, /root has uncommitted work of its own: notes\.md/);
  rmSync(join(main, 'notes.md'));
  writeFileSync(join(wt, 'stray.md'), 'x\n');
  assert.match(land().stderr, /outside cells\/demo\/: stray\.md/);
  rmSync(join(wt, 'stray.md'));
  const start = git(wt, 'rev-parse', 'HEAD').trim();
  const failed = land('--check', 'node -e "process.exit(3)"');
  assert.match(failed.stderr, /check failed .*exit 3[\s\S]*back where it was/);
  assert.equal(git(wt, 'rev-parse', 'HEAD').trim(), start);                // undone: the branch is where it was…
  assert.equal(readFileSync(join(cellWt, 'exit', 'report.md'), 'utf8'), 'done\n');   // …and the work is still there
  assert.ok(land('--dry-run').stdout.includes('would commit'));
  const r = land('--message', 'the report', '--check', 'node -e "process.exit(0)"');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(main, 'cells', 'demo', 'exit', 'report.md'), 'utf8'), 'done\n');
  assert.equal(git(main, 'log', '-2', '--format=%s').trim().split('\n')[1], 'Land cell/demo: the report');
  assert.equal(git(main, 'rev-list', '--parents', '-1', 'HEAD~1').trim().split(' ').length, 3);   // a merge commit: revertable
  assert.match(git(main, 'log', '-1', '--format=%s'), /Root log: cell demo landed/);
  assert.equal(clean(main), '');                                             // nothing left uncommitted in root
  assert.equal(clean(wt), '');
  assert.equal(run('cli.ts', ['lint', '--cell', main]).status, 0);
  assert.match(land().stdout, /nothing to land/);
});

test('cell land: weaker tests stop the land; the operator lands them with a reason that goes into the merge', (t) => {
  const { main, wt, cellWt } = world(t);
  const suite = join(main, 'cells', 'demo', 'test', 'a.test.ts');
  writeFileSync(suite, `test('one', () => { assert.ok(1); });\ntest('two', () => { assert.ok(2); });\n`);
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'tests'); git(wt, 'merge', '-q', 'main');
  writeFileSync(join(cellWt, 'test', 'a.test.ts'), `test('one', () => { assert.ok(1); });\n`);    // the cell drops a case
  const land = (...args: string[]) => run('cli.ts', ['cell', 'land', '--cell', main, '--name', 'demo', ...args]);
  assert.match(land('--dry-run').stdout, /would stop: the cell's tests got weaker/);
  const start = git(wt, 'rev-parse', 'HEAD').trim();
  const refused = land('--message', 'trim');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /a\.test\.ts: 1 fewer test case[\s\S]*--accept-weaker[\s\S]*back where it was/);
  assert.equal(git(wt, 'rev-parse', 'HEAD').trim(), start);
  const ok = land('--message', 'trim', '--accept-weaker', 'case two moved to the integration suite');   // (the operator)
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(git(main, 'log', '-1', '--format=%B', 'HEAD~1'), /Weaker tests, accepted by the operator: case two moved[\s\S]*1 fewer test case/);
});

test('kinds: a project\'s claim kinds are bedrock; a kinds doc that would invalidate a logged claim is refused', (t) => {
  const { main } = world(t, { kernel: true });
  // the project's own kernel copy reads the project's bedrock, as in a real project
  const cli = (...args: string[]) => { const r = spawnSync(process.execPath, [join(main, 'kernel', 'src', 'cli.ts'), ...args, '--cell', main], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
  const file = (name: string, v: unknown) => { const f = join(main, name); writeFileSync(f, JSON.stringify(v)); return f; };
  const proposed = join(main, 'state', 'bedrock', 'proposed');
  mkdirSync(proposed, { recursive: true });
  const visit = { kinds: { visit: { description: 'a visit', schema: { properties: { says: { type: 'object', required: ['at'] } } } } } };
  const o = cli('append', '--kind', 'observation', '--body', file('o.json', { source: { adapter: 'test' }, observed_at: '2026-01-01T00:00:00Z', reliability: [], licence: { store: 'full' }, payload: {} }));
  assert.equal(o.code, 0, o.out);
  const from = /appended (\d{6})/.exec(o.out)![1];
  const claim = (says: unknown) => cli('append', '--kind', 'claim', '--body', file('c.json', { about: ['thing:x'], kind: 'visit', says, from, voice: 'claude' }));
  writeFileSync(join(proposed, 'kinds.json'), JSON.stringify({ kinds: { fact: {} } }));
  assert.match(cli('amend', '--doc', 'kinds', '--layer', 'kinds', '--reason', 'r').out, /one of the kit's own kinds/);
  writeFileSync(join(proposed, 'kinds.json'), JSON.stringify(visit));
  assert.equal(cli('amend', '--doc', 'kinds', '--layer', 'kinds', '--reason', 'visits').code, 0);
  assert.equal(claim({ at: 'x' }).code, 1);                                  // proposed is not approved: no such kind yet
  assert.equal(cli('approve', '--doc', 'kinds').code, 0);                    // (the operator, from their prompt)
  assert.equal(claim({ at: 'x' }).code, 0);
  assert.match(claim({ when: 'x' }).out, /refused: .*must have required property 'at'/);
  writeFileSync(join(proposed, 'kinds.json'), JSON.stringify({ kinds: {} }));   // dropping a kind the log uses
  assert.match(cli('amend', '--doc', 'kinds', '--layer', 'kinds', '--reason', 'drop').out, /\(kind visit\) would no longer be valid/);
  assert.equal(cli('lint').code, 0);
});

test('binding: a cell can\'t edit its own; root rebinds it on the cell\'s log; lint catches a hand edit', (t) => {
  const { main, cellWt } = world(t);
  assert.equal(hook('hook-guard.ts', cellWt, { file_path: join(cellWt, 'binding.json') }).status, 2);
  assert.equal(hook('hook-bash.ts', cellWt, { command: 'echo {} > binding.json' }).status, 2);
  assert.equal(hook('hook-bash.ts', cellWt, { command: 'cat binding.json' }).status, 0);
  const lintCell = () => run('cli.ts', ['lint', '--cell', cellWt]);
  assert.equal(lintCell().status, 0);
  writeFileSync(join(cellWt, 'binding.json'), JSON.stringify({ name: 'demo', scope: { city: 'Porto' } }));   // by hand
  assert.match(lintCell().stderr, /binding\.json differs from the binding on the log .*cell rebind --name demo/);
  const before = readLog(cellWt).length;
  const r = run('cli.ts', ['cell', 'rebind', '--name', 'demo', '--cell', main]);   // record it as it is
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readLog(cellWt).length, before + 2);                          // on the cell's log, in its worktree
  assert.equal(lintCell().status, 0);
  assert.match(run('cli.ts', ['cell', 'rebind', '--name', 'demo', '--cell', main]).stderr, /already the logged one/);
  const f = join(main, 'lisbon.json');
  writeFileSync(f, JSON.stringify({ scope: { city: 'Lisbon' } }));
  assert.equal(run('cli.ts', ['cell', 'rebind', '--name', 'demo', '--binding', f, '--cell', main]).status, 0);
  assert.equal(JSON.parse(readFileSync(join(cellWt, 'binding.json'), 'utf8')).scope.city, 'Lisbon');
  assert.match(readFileSync(join(cellWt, 'AGENTS.md'), 'utf8'), /scope city Lisbon/);   // the brief follows
  assert.equal(lintCell().status, 0);
});

test('owns: a cell writes the repo paths root\'s guards give it — hooks, brief, audit and land agree; lint refuses two owners', async (t) => {
  const { main, wt, cellWt } = world(t, { kernel: true });
  const cli = (...args: string[]) => { const r = spawnSync(process.execPath, [join(main, 'kernel', 'src', 'cli.ts'), ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
  mkdirSync(join(main, 'state', 'bedrock', 'proposed'), { recursive: true });
  writeFileSync(join(main, 'state', 'bedrock', 'proposed', 'guards.json'), JSON.stringify({ cells: { demo: { owns: ['game/**'] } } }));
  assert.equal(cli('amend', '--doc', 'guards', '--layer', 'rules', '--reason', 'demo owns game/', '--cell', main).code, 0);
  assert.equal(cli('approve', '--doc', 'guards', '--cell', main).code, 0);  // (the operator)
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'guards');
  git(wt, 'merge', '-q', 'main');                                           // how bedrock reaches a cell's branch
  assert.equal(cli('cell', 'refresh', '--name', 'demo', '--cell', main).code, 0);
  // refresh writes the copy the cell works in (its worktree); land brings it to main
  assert.match(readFileSync(join(cellWt, 'AGENTS.md'), 'utf8'), /You also own, outside this folder:\*\* `\.\.\/\.\.\/game\/\*\*`/);
  assert.doesNotMatch(readFileSync(join(main, 'cells', 'demo', 'AGENTS.md'), 'utf8'), /You also own/);
  // the cell's hooks are its worktree's kernel copy, reading its branch's guards
  const hook = (script: string, tool_input: Record<string, string>) => spawnSync(process.execPath, [join(wt, 'kernel', 'src', script)],
    { input: JSON.stringify({ cwd: cellWt, tool_input }), env: { ...process.env, CLAUDE_PROJECT_DIR: cellWt }, encoding: 'utf8' }).status;
  assert.equal(hook('hook-guard.ts', { file_path: join(wt, 'game', 'map.ts') }), 0);
  assert.equal(hook('hook-guard.ts', { file_path: join(wt, 'sim', 'x.ts') }), 2);
  assert.equal(hook('hook-guard.ts', { file_path: join(wt, 'kernel', 'src', 'x.ts') }), 2);
  assert.equal(hook('hook-bash.ts', { command: 'echo x > ../../game/b.ts' }), 0);
  assert.equal(hook('hook-bash.ts', { command: 'echo x > ../../sim/b.ts' }), 2);
  mkdirSync(join(wt, 'game'), { recursive: true });
  writeFileSync(join(wt, 'game', 'map.ts'), 'export {}\n');
  assert.deepEqual(cellAudit(main, 'demo'), []);
  mkdirSync(join(wt, 'sim'));
  writeFileSync(join(wt, 'sim', 'x.ts'), '\n');
  assert.deepEqual(cellAudit(main, 'demo'), ['sim/x.ts']);
  rmSync(join(wt, 'sim'), { recursive: true });
  const landed = cli('cell', 'land', '--name', 'demo', '--message', 'map', '--cell', main);
  assert.equal(landed.code, 0, landed.out);
  assert.equal(readFileSync(join(main, 'game', 'map.ts'), 'utf8'), 'export {}\n');
  assert.match(readFileSync(join(main, 'cells', 'demo', 'AGENTS.md'), 'utf8'), /You also own/);
  // two owners of one tracked file: lint says so (root's ownership is a decision, not a race)
  const { lintOwnership } = await import('../src/lint.ts');
  assert.deepEqual(lintOwnership(main).errors, []);
  writeFileSync(join(main, 'state', 'bedrock', 'guards.json'), JSON.stringify({ cells: { demo: { owns: ['game/**'] }, other: { owns: ['game/map.ts'] } } }));
  assert.match(lintOwnership(main).errors.join('\n'), /differs from its approved version/);   // a hand edit is caught first
  rmSync(join(main, 'state', 'views', 'bedrock.json'));                     // (no views: the file is trusted, as in a worktree)
  assert.match(lintOwnership(main).errors.join('\n'), /game\/map\.ts is owned by demo and other/);
});
