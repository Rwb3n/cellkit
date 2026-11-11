// One git worktree per cell: a shared mailbox outside both checkouts, root-log writes from a worktree land in the main
// checkout, a session opened in the wrong checkout is refused, the audit reads only the cell's branch, and cellrun
// starts a cell headless in its own worktree only when mail is queued.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { cellNew } from '../src/cell.ts';
import { readLog } from '../src/log.ts';
import { current, mailbox, receive, release, runnerOf, send, status, takeNext } from '../src/mail.ts';
import { level, liveRunners, recoverAnswer, room } from '../src/cellrun.ts';
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
      if (l.startsWith('worktree ') && !samePath(l.slice(9), main)) spawnSync('git', ['-C', main, 'worktree', 'remove', '-f', '-f', l.slice(9)]);   // -f -f: cells' worktrees are locked
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
  assert.match(git(main, 'worktree', 'list', '--porcelain'), /^locked cell demo$/m);   // kept, not throwaway (#22)
  const gone = cellCheckout(main, { name: 'other' });                       // a worktree folder deleted by hand
  rmSync(gone, { recursive: true, force: true });
  assert.equal(cellWorktree(main, 'other'), null);                           // is no worktree: its main copy is the cell's
  git(main, 'worktree', 'prune');                                            // a locked one stays registered: checkout says how
  assert.throws(() => cellCheckout(main, { name: 'other' }), /still registered to the worktree .* git worktree unlock/);
  git(main, 'worktree', 'unlock', gone);
  git(main, 'worktree', 'prune');
  assert.ok(samePath(cellCheckout(main, { name: 'other' }), gone));
  git(main, 'worktree', 'unlock', gone);                                     // an unlocked one (checked out before #22), not yet pruned
  rmSync(gone, { recursive: true, force: true });
  assert.throws(() => cellCheckout(main, { name: 'other' }), (e: Error) => /: git worktree prune/.test(e.message) && !/unlock/.test(e.message));
  git(main, 'worktree', 'prune');
  assert.ok(samePath(cellCheckout(main, { name: 'other' }), gone));
  assert.ok(readFileSync(join(cellWt, 'AGENTS.md'), 'utf8').includes('branch `cell/demo`'));   // the brief says so
  // node_modules is git-ignored, so the worktree has none: its kernel copy (the cell's hooks) loads the main checkout's
  assert.equal(existsSync(join(wt, 'kernel', 'node_modules')), false);
  const lint = spawnSync(process.execPath, [join(wt, 'kernel', 'src', 'cli.ts'), 'lint', '--cell', cellWt], { encoding: 'utf8' });
  assert.equal(lint.status, 0, lint.stderr);
  const stopped = spawnSync(process.execPath, [join(wt, 'kernel', 'src', 'mail-hook.ts')], { input: '{}', encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: cellWt, CELLKIT_MAIL_WAIT: '0' } });
  assert.equal(stopped.status, 0, stopped.stderr);
  // #101: root's mail is handled from the main checkout only. The root of a cell's worktree is no cell's folder, so a
  // session that stepped up to it (cd ../..) would be root there: it could watch root's box and task other cells.
  const { CLAUDE_PROJECT_DIR: _, ...bare } = process.env;
  const fromWt = (...args: string[]) => spawnSync(process.execPath, [join(wt, 'kernel', 'src', 'mail.ts'), ...args], { cwd: wt, env: bare, encoding: 'utf8' });
  const q = send(cellWt, 'root', 'a question for root', 'question');
  for (const args of [['watch'], ['watch', '--as', 'root'], ['recv'], ['send', '--to', 'other', '--body', 'do this'], ['release', '--as', 'other']]) {
    const r = fromWt(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /^refused: root's mail is handled from the main checkout, and this is another checkout of the repository \(.*repo-cells.demo\)/, args.join(' '));
  }
  assert.equal(JSON.parse(fromWt('status').stdout).unread, 1);              // looking is fine; nothing was taken
  const fromMain = spawnSync(process.execPath, [join(main, 'kernel', 'src', 'mail.ts'), 'watch'], { cwd: main, env: bare, encoding: 'utf8' });
  assert.match(fromMain.stdout, new RegExp(q.id), fromMain.stderr);
  assert.notEqual(spawnSync('git', ['-C', main, 'worktree', 'remove', '--force', wt]).status, 0);   // locked: one -f won't
  git(main, 'worktree', 'remove', '-f', '-f', wt);
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

test('worktree: guards.json worktrees.home puts cells in one folder outside the repo; none goes inside the main checkout (#26)', async (t) => {
  const { tmp, main } = world(t);
  const { lintCellWorktrees } = await import('../src/lint.ts');
  const guards = join(main, 'state', 'bedrock', 'guards.json');
  mkdirSync(dirname(guards), { recursive: true });
  writeFileSync(guards, JSON.stringify({ worktrees: { home: '../.cells/repo' } }));
  assert.ok(samePath(cellCheckout(main, { name: 'other' }), join(tmp, '.cells', 'repo', 'other')));
  let l = lintCellWorktrees(main);
  assert.deepEqual(l.errors, []);
  assert.match(l.warnings.join('\n'), /cell demo's worktree .* is not at .*worktrees\.home/);   // checked out before home was set
  assert.doesNotMatch(l.warnings.join('\n'), /cell other/);
  // inside the main checkout: refused, by home or by --path
  cellNew(main, { name: 'third' });
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'third');
  writeFileSync(guards, JSON.stringify({ worktrees: { home: '../repo/.worktrees' } }));
  assert.throws(() => cellCheckout(main, { name: 'third' }), /inside the main checkout/);
  writeFileSync(guards, '{}');
  const nested = join(main, '.worktrees', 'third');
  assert.throws(() => cellCheckout(main, { name: 'third', path: nested }), /inside the main checkout/);
  assert.equal(existsSync(nested), false);
  // one made by hand there is a lint error, and unlocked a warning
  git(main, 'worktree', 'add', '-q', '-b', 'cell/third', nested);
  l = lintCellWorktrees(main);
  assert.match(l.errors.join('\n'), /cell third's worktree .* is inside the main checkout/);
  assert.match(l.warnings.join('\n'), /cell third's worktree .* is not locked/);
  assert.doesNotMatch(l.warnings.join('\n'), /cell (demo|other)'s worktree .* is not locked/);
  const cli = run('cli.ts', ['lint', '--cell', main]);                      // root's lint at session start says so
  assert.notEqual(cli.status, 0);
  assert.match(cli.stdout + cli.stderr, /cell third's worktree .* is inside the main checkout/);
  assert.deepEqual(lintCellWorktrees(join(main, 'cells', 'demo')), { errors: [], warnings: [] });   // a cell's lint leaves it to root
  // the setting: relative to the main checkout and outside it, never by drive (the project opens from Windows and WSL)
  const { checkGuards } = await import('../src/config.ts');
  for (const home of ['../.cells/repo', './../x', '..']) assert.deepEqual(checkGuards({ worktrees: { home } }), [], home);
  for (const home of ['D:/PROJECTS/.cells/repo', '/mnt/d/x', '~/cells']) assert.match(checkGuards({ worktrees: { home } }).join(), /never by drive/, home);
  for (const home of ['.worktrees', './cells-home', '']) assert.match(checkGuards({ worktrees: { home } }).join(), /inside the repository|must be a folder/, home);
  assert.match(checkGuards({ worktrees: { root: 'x' } }).join(), /worktrees: unknown key "root"/);
});

test('views: mail written to a log refolds its views, so root\'s lint --all is clean after a task and its reply (#7)', (t) => {
  const { main, cellWt, cellMain } = world(t);
  for (const d of [main, cellWt, join(main, 'cells', 'other')]) assert.equal(run('cli.ts', ['fold', '--cell', d]).status, 0);
  const clean = () => { const l = run('cli.ts', ['lint', '--all', '--cell', main]); assert.equal(l.status, 0, l.stderr); assert.doesNotMatch(l.stderr, /views are stale|views missing/); };
  send(main, 'demo', 'a task');
  const m = takeNext(cellWt)!;                                              // handed over: on the cell's log, in its worktree
  send(cellWt, 'root', 'the answer', 'reply', m.id);                       // filed: on both logs
  clean();
  // fold aimed at the main checkout's copy (a snapshot from the last land) folds the cell's live log, in its worktree
  rmSync(join(cellWt, 'state', 'views'), { recursive: true, force: true });
  const f = run('cli.ts', ['fold', '--cell', cellMain]);
  assert.equal(f.status, 0, f.stderr);
  assert.match(f.stderr, /has its own worktree; its log is there/);
  clean();
  // a summary caught half-written (another process refolding) is a warning, never a crash of the session-start lint
  writeFileSync(join(main, 'state', 'views', 'summary.json'), '{"head": "sha');
  const torn = run('cli.ts', ['lint', '--cell', main]);
  assert.equal(torn.status, 0, torn.stderr);
  assert.match(torn.stderr, /views unreadable — run fold/);
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
  assert.match(r.stderr, /has its own worktree; its log is there/);
  assert.equal(readLog(cellMain).length, before.main);                       // the main checkout's copy is untouched
  assert.equal(readLog(cellWt).length, before.wt + 2);
  assert.equal(run('cli.ts', ['lint', '--cell', cellMain]).status, 0);       // lint follows it there too (#7)
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
  assert.match(cellrun('--cell', 'demo', '--dry-run', '--model', 'claude-sonnet-5-5', '--effort', 'medium').out, /--model claude-sonnet-5-5 --effort medium/);   // #73
  assert.equal(cellrun('--cell', 'demo', '--dry-run', '--effort', 'loud').code, 2);
  assert.equal(cellrun('--cell', 'other', '--dry-run').code, 2);            // no worktree: refused
  takeNext(cellWt);
  assert.equal(cellrun('--cell', 'demo', '--dry-run').code, 3);             // a session is already on a task
  assert.match(cellrun('--cell', 'demo', '--dry-run').out, /cellrun\.ts --cell demo --resume/);
});

test('cellrun: a run that dies mid-task keeps the task and tells root; --resume recovers the answer or finishes it; an orphan holds the cell', (t) => {
  const { main, cellWt } = world(t);
  const t1 = send(main, 'demo', 'task one');
  const t2 = send(main, 'demo', 'task two');
  // a scriptable "claude" (CELLKIT_FAKE): takes the next task like the Stop hook would, prints stream-json, exits
  const fake = join(tmpdir(), `cellkit-fake-claude-${process.pid}`);
  writeFileSync(`${fake}.mjs`, `import { takeNext } from ${JSON.stringify(pathToFileURL(join(src, 'mail.ts')).href)};
import { readFileSync } from 'node:fs';
const say = (o) => console.log(JSON.stringify(o));
const mode = process.env.CELLKIT_FAKE;
if (mode === 'resume') {
  const prompt = process.argv[process.argv.indexOf('-p') + 1];
  const task = readFileSync(prompt.match(/Read the task in (.+?\\.task\\.md)/)[1], 'utf8');
  say({ type: 'result', subtype: 'success', is_error: false, result: 'finished: ' + task.split('\\n').at(-2) });
  process.exit(0);
}
const m = takeNext(process.cwd());
say({ type: 'user', message: { content: [{ type: 'text', text: 'Stop hook feedback: Task ' + m.id }] } });
if (mode === 'answer') say({ type: 'result', subtype: 'success', is_error: false, result: 'answered ' + m.body });
process.exit(mode === 'answer' ? 0 : 1);
`);
  const exe = process.platform === 'win32' ? `${fake}.cmd` : fake;
  writeFileSync(exe, process.platform === 'win32' ? `@"${process.execPath}" "${fake}.mjs" %*
` : `#!/bin/sh
exec "${process.execPath}" "${fake}.mjs" "$@"
`, { mode: 0o755 });
  t.after(() => { rmSync(`${fake}.mjs`, { force: true }); rmSync(exe, { force: true }); });
  const cellrun = (mode: string, ...args: string[]) => run('cellrun.ts', ['--root', main, '--cell', 'demo', ...args], { CELLKIT_CLAUDE: exe, CELLKIT_FAKE: mode, CELLKIT_MIN_FREE_MB: '0' });

  takeNext(cellWt);                                                          // a session took t1, then died (no run log)
  const refused = cellrun('answer');
  assert.equal(refused.status, 3, refused.stderr);                           // in flight: refused, pointed at --resume
  assert.match(refused.stderr, /--resume/);
  const resumed = cellrun('resume', '--resume');                             // a fresh session, told the task, finishes it
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  const [r1] = receive(main);
  assert.equal(r1.reply_to, t1.id);
  assert.match(r1.body, /^finished: task one[\s\S]*recovered by cellrun/);
  assert.equal(current(cellWt), null);

  const died = cellrun('die', '--effort', 'high');                                               // takes t2, dies mid-task
  assert.equal(died.status, 1, died.stdout + died.stderr);
  assert.match(died.stderr, /still in flight; told root/);
  assert.equal(current(cellWt), t2.id);                                      // the cell keeps the task
  const [blocked] = receive(main);
  assert.equal(blocked.kind, 'blocked');
  assert.match(blocked.body, new RegExp(`working on ${t2.id}[\\s\\S]*--resume`));
  const [, log] = blocked.body.match(/Transcript: (.+\.jsonl)$/)!;
  assert.equal(JSON.parse(readFileSync(`${log}.exit`, 'utf8')).code, 1);     // how the run ended, beside its log
  assert.equal(JSON.parse(readFileSync(`${log}.exit`, 'utf8')).effort, 'high');   // and what it was started with (#73)
  // no answer in its log, and t1's resume run is no source for t2: nothing is recovered, nothing is filed
  const nothing = run('cellrun.ts', ['--root', main, '--cell', 'demo', '--resume'], { CELLKIT_CLAUDE: join(tmpdir(), 'no-such-claude'), CELLKIT_MIN_FREE_MB: '0' });
  assert.equal(nothing.status, 1, nothing.stdout + nothing.stderr);          // tried a fresh session: no such claude
  assert.equal(current(cellWt), t2.id);
  assert.deepEqual(receive(main, t2.id), []);
  // the session had in fact finished its answer before its runner died: --resume files it, no session started
  writeFileSync(log, readFileSync(log, 'utf8') + JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'two is done' }) + '\n');
  const recovered = run('cellrun.ts', ['--root', main, '--cell', 'demo', '--resume'], { CELLKIT_CLAUDE: join(tmpdir(), 'no-such-claude'), CELLKIT_MIN_FREE_MB: '0' });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.match(receive(main, t2.id)[0].body, /^two is done[\s\S]*recovered by cellrun/);
  assert.equal(current(cellWt), null);

  const t3 = send(main, 'demo', 'task three');                               // the session answered; its stop never filed it
  const unfiled = cellrun('answer');
  assert.equal(unfiled.status, 0, unfiled.stdout + unfiled.stderr);
  assert.match(receive(main, t3.id)[0].body, /^answered task three[\s\S]*recovered by cellrun/);
  assert.equal(recoverAnswer(log, t3.id), null);                             // another task's log holds no answer to it

  // an orphan: the runner is gone, its session still works (this test's pid stands in for it)
  send(main, 'demo', 'task four');
  writeFileSync(join(mailbox(cellWt), 'runner.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, at: 'then', state: 'running', session: process.pid }));
  assert.equal(runnerOf(cellWt)?.orphan, true);
  assert.equal(liveRunners(main), 1);                                        // it still uses the machine
  const orphaned = cellrun('answer');
  assert.equal(orphaned.status, 5);
  assert.match(orphaned.stderr, new RegExp(`orphaned session \\(pid ${process.pid}`));
  takeNext(cellWt);
  assert.match(status(cellWt).run!, /^orphaned session/);
  assert.match(run('mail.ts', ['release', '--as', 'demo'], { CLAUDE_PROJECT_DIR: cellWt }).stderr, /orphaned session .* let it finish/);
});

test('cellrun: a session can\'t take its own mail with watch; a task a run took and left unanswered is told to root (#101)', (t) => {
  const { main, cellWt } = world(t);
  const t0 = send(main, 'demo', 'task zero');
  // "watch": what ecom-lab's session did, told "waiting for mail". "grab": a task read with nothing making it the one in
  // flight, however that comes about (what watch did before it refused a cell's box).
  const fake = join(tmpdir(), `cellkit-fake-grab-${process.pid}`);
  writeFileSync(`${fake}.mjs`, `import { spawnSync } from 'node:child_process';
import { readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const say = (o) => console.log(JSON.stringify(o));
if (process.env.CELLKIT_FAKE === 'watch') {
  const r = spawnSync(process.execPath, [${JSON.stringify(join(src, 'mail.ts'))}, 'watch'], { encoding: 'utf8' });
  say({ type: 'user', message: { content: [{ type: 'tool_result', content: 'exit ' + r.status + ' ' + r.stdout + r.stderr }] } });
} else {
  const box = join(process.env.CELLKIT_BOX, 'inbox'), [f] = readdirSync(box).filter((x) => x.endsWith('.json')).sort();
  renameSync(join(box, f), join(box, 'read', f));
}
say({ type: 'result', subtype: 'success', is_error: false, result: 'did the work' });
`);
  const exe = process.platform === 'win32' ? `${fake}.cmd` : fake;
  writeFileSync(exe, process.platform === 'win32' ? `@"${process.execPath}" "${fake}.mjs" %*
` : `#!/bin/sh
exec "${process.execPath}" "${fake}.mjs" "$@"
`, { mode: 0o755 });
  t.after(() => { rmSync(`${fake}.mjs`, { force: true }); rmSync(exe, { force: true }); });
  const cellrun = (mode: string) => run('cellrun.ts', ['--root', main, '--cell', 'demo'], { CELLKIT_CLAUDE: exe, CELLKIT_FAKE: mode, CELLKIT_BOX: mailbox(cellWt), CELLKIT_MIN_FREE_MB: '0' });
  const lost = () => (status(cellWt) as { unanswered?: string[] }).unanswered;

  assert.match(readFileSync(join(cellWt, 'AGENTS.md'), 'utf8'), /told "waiting for mail" yourself, answer in a line and end your turn.*Never go and fetch it: `mail\.ts watch` is root's/);
  const watched = cellrun('watch');
  assert.equal(watched.status, 0, watched.stdout + watched.stderr);
  const [, log] = watched.stdout.match(/; log (.+\.jsonl)/)!;
  assert.match(readFileSync(log, 'utf8'), /exit 1 refused: this is cell demo's session, and a cell watches no box/);
  assert.deepEqual([status(cellWt).unread, current(cellWt), lost()], [1, null, undefined]);   // still queued…
  assert.deepEqual(receive(main), []);
  assert.match(stop(cellWt, 'waiting for mail').stdout, /task zero/);       // …and the Stop hook hands it over, so its answer is filed
  stop(cellWt, 'zero is done');
  assert.deepEqual(receive(main).map((m) => [m.reply_to, m.body]), [[t0.id, 'zero is done']]);

  const t1 = send(main, 'demo', 'task one');
  const grabbed = cellrun('grab');                                          // claude exits 0 with nothing in flight: it would read as done
  assert.equal(grabbed.status, 8, grabbed.stdout + grabbed.stderr);
  assert.match(grabbed.stderr, new RegExp(`cellrun: demo took ${t1.id} and left it unanswered; told root`));
  const told = receive(main);
  assert.deepEqual(told.map((m) => m.kind), ['blocked']);
  assert.match(told[0].body, new RegExp(`demo took task ${t1.id}, and it has no reply and is not in flight[\\s\\S]*exited 0[\\s\\S]*transcript: .+\\.jsonl[\\s\\S]*release --as demo --for ${t1.id} `));
  assert.deepEqual(lost(), [t1.id]);

  const t2 = send(main, 'demo', 'task two');                                // told once per task: t1 is not news to the next run
  assert.equal(cellrun('grab').status, 8);
  const again = receive(main);
  assert.equal(again.length, 1);
  assert.match(again[0].body, new RegExp(`took task ${t2.id}, `));
  assert.deepEqual(lost(), [t1.id, t2.id]);

  // one left by something other than a run that finished (an interrupted run, an interactive session): the next run tells root
  rmSync(join(mailbox(cellWt), 'inbox', `.told-${t1.id}`));
  send(main, 'demo', 'task three');
  assert.equal(cellrun('watch').status, 8);                                 // this run took nothing itself
  assert.deepEqual(receive(main).map((m) => m.body.match(/took task (\S+),/)![1]), [t1.id]);
  release(cellWt, 'read the worktree: nothing was done', t1.id);            // recorded: no longer unanswered, and never told again
  assert.deepEqual(lost(), [t2.id]);
  assert.equal(cellrun('watch').status, 0);
  assert.deepEqual(receive(main).map((m) => [m.kind, m.reply_to]), [['reply', t1.id]]);
});

test('cellrun: no MCP servers; one runner per cell; waits for room (sessions, memory) and gives up with the mail queued', (t) => {
  const { main, cellWt } = world(t);
  assert.equal(room(8000, 3, 3, 4096), '3 session(s) running (at most 3, CELLKIT_MAX_RUNNERS)');
  assert.match(room(1000, 0, 3, 4096)!, /1000 MB free \(under 4096/);
  assert.equal(room(8000, 2, 3, 4096), null);
  send(main, 'demo', 'task one');
  const cellrun = (env: Record<string, string>, ...args: string[]) => run('cellrun.ts', ['--root', main, '--cell', 'demo', ...args], { CELLKIT_MIN_FREE_MB: '0', ...env });
  const lock = join(mailbox(cellWt), 'runner.lock');

  const dry = cellrun({ CELLKIT_MAX_RUNNERS: '0' }, '--dry-run', '--hold', '60');
  assert.match(dry.stdout, /--strict-mcp-config/);
  assert.match(dry.stdout, /room not yet: 0 session\(s\) running \(at most 0.*would wait up to 60 s/);

  const full = cellrun({ CELLKIT_MAX_RUNNERS: '0', CELLKIT_CLAUDE: process.execPath }, '--hold', '0');   // no room: gives up
  assert.equal(full.status, 6, full.stdout + full.stderr);
  assert.match(full.stdout, /waiting for room/);
  assert.match(full.stderr, /no room within 0 s; its mail is still queued/);
  assert.equal(existsSync(lock), false, 'the runner lock is released');
  assert.equal(status(cellWt).unread, 1);

  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: 'now', state: 'running' }));   // a live runner (this test)
  assert.equal(liveRunners(main), 1);
  assert.equal(cellrun({}).status, 5);
  assert.match(cellrun({}, '--dry-run').stdout, /room no: a runner \(pid \d+\) is already live for this cell/);
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: 'then', state: 'running' }));   // its run is gone
  assert.equal(runnerOf(cellWt), null);
  assert.equal(liveRunners(main), 0);
  const ran = cellrun({ CELLKIT_CLAUDE: process.execPath });     // taken over; "claude" (node) refuses its flags and exits
  assert.match(ran.stdout, /cellrun: demo in .*1 message\(s\) queued/, ran.stdout + ran.stderr);   // it started
  assert.equal(existsSync(lock), false);
});

test('cellrun keeps a cell level with main: merges a clean worktree; leaves uncommitted work and ignored files alone; aborts a conflict', (t) => {
  const { main, wt, cellWt } = world(t);
  const commit = (dir: string, path: string, text: string, force = false) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    git(dir, 'add', ...(force ? ['-f'] : []), path);
    git(dir, 'commit', '-qm', `${path}: ${text.trim()}`);
  };
  assert.match(level(main, wt).say, /^already level with main/);
  commit(main, 'docs/a.md', 'a\n');
  assert.match(level(main, wt, true).say, /^would merge main/);
  assert.equal(existsSync(join(wt, 'docs', 'a.md')), false, 'a dry run merges nothing');
  assert.match(level(main, wt).say, /^merged main [0-9a-f]{7} into the worktree/);
  assert.equal(readFileSync(join(wt, 'docs', 'a.md'), 'utf8'), 'a\n');

  writeFileSync(join(cellWt, 'draft.md'), 'the cell\'s work, not landed\n');   // uncommitted: never a merge over it
  commit(main, 'docs/b.md', 'b\n');
  assert.match(level(main, wt).say, /not levelled .* 1 uncommitted path/);
  assert.equal(existsSync(join(wt, 'docs', 'b.md')), false);
  rmSync(join(cellWt, 'draft.md'));
  assert.match(level(main, wt).say, /^merged main/);

  commit(main, '.gitignore', 'node_modules/\n**/state/views/\n*.local\n');
  assert.match(level(main, wt).say, /^merged main/);
  writeFileSync(join(wt, 'notes.local'), 'the cell\'s own, ignored\n');      // git status can't see it
  commit(main, 'notes.local', 'main\'s\n', true);
  assert.match(level(main, wt).say, /ignored files, which a merge would overwrite: notes\.local/);
  assert.equal(readFileSync(join(wt, 'notes.local'), 'utf8'), 'the cell\'s own, ignored\n');
  rmSync(join(wt, 'notes.local'));
  assert.match(level(main, wt).say, /^merged main/);

  commit(wt, 'docs/c.md', 'the cell\'s\n');                                  // both sides change one file
  commit(main, 'docs/c.md', 'main\'s\n');
  const head = git(wt, 'rev-parse', 'HEAD').trim();
  const conflict = level(main, wt);
  assert.equal(conflict.ok, false);
  assert.match(conflict.say, /conflicts in docs\/c\.md; aborted, the worktree is as it was/);
  assert.equal(git(wt, 'rev-parse', 'HEAD').trim(), head);
  assert.equal(git(wt, 'status', '--porcelain').trim(), '');                   // no MERGE_HEAD, nothing half-merged
  send(main, 'demo', 'a task');
  const r = run('cellrun.ts', ['--root', main, '--cell', 'demo'], { CELLKIT_CLAUDE: join(tmpdir(), 'no-such-claude'), CELLKIT_MIN_FREE_MB: '0' });
  assert.equal(r.status, 7, r.stdout + r.stderr);
  assert.match(r.stderr, /conflicts in docs\/c\.md[\s\S]*mail is still queued; the session was not started/);
  assert.equal(status(cellWt).unread, 1);
  assert.equal(existsSync(join(mailbox(cellWt), 'runner.lock')), false);
});

test('a cell\'s kernel copy reads bedrock (kinds, guards) from the main checkout: approved on main, in force in every cell', (t) => {
  const { main, wt } = world(t, { kernel: true });
  const env = { ...process.env };
  delete env.CELLKIT_CONFIG;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { kindsPath } = await import(${JSON.stringify(pathToFileURL(join(wt, 'kernel', 'src', 'schemas.ts')).href)});
    const { configPath } = await import(${JSON.stringify(pathToFileURL(join(wt, 'kernel', 'src', 'config.ts')).href)});
    console.log(JSON.stringify([kindsPath(), configPath()]));`], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const [kinds, guards] = JSON.parse(r.stdout) as string[];
  assert.ok(samePath(kinds, join(main, 'state', 'bedrock', 'kinds.json')), kinds);
  assert.ok(samePath(guards, join(main, 'state', 'bedrock', 'guards.json')), guards);
});

test('cellrun admission: eight runs for eight cells at once, two slots: exactly two start', async (t) => {
  const { main } = world(t);
  const cells = Array.from({ length: 8 }, (_, i) => `c${i}`);
  for (const c of cells) { mkdirSync(join(main, 'cells', c), { recursive: true }); writeFileSync(join(main, 'cells', c, 'binding.json'), '{}'); }
  const url = (f: string) => JSON.stringify(pathToFileURL(join(src, f)).href);
  const go = join(main, 'go');
  // each: take its cell's runner lock, try once for a slot (hold 0), keep it 2 s if admitted, print the verdict
  const script = (c: string) => `import { admit, claimRunner, dropRunner } from ${url('cellrun.ts')};
    import { existsSync } from 'node:fs';
    import { pause } from ${url('log.ts')};
    const dir = ${JSON.stringify(join(main, 'cells', c))};
    if (claimRunner(dir)) process.exit(5);
    while (!existsSync(${JSON.stringify(go)})) pause(1);     // all eight ask in the same instant
    const ok = admit(${JSON.stringify(main)}, dir, ${JSON.stringify(c)}, 0);
    if (ok) pause(2000);
    dropRunner(dir);
    process.stderr.write(ok ? 'ADMITTED' : 'WAITED');`;
  const { spawn } = await import('node:child_process');
  setTimeout(() => writeFileSync(go, ''), 2500);
  const verdicts = await Promise.all(cells.map((c) => new Promise<string>((done) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script(c)], { env: { ...process.env, CELLKIT_MAX_RUNNERS: '2', CELLKIT_MIN_FREE_MB: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', () => done(err.includes('ADMITTED') ? 'admitted' : err.includes('WAITED') ? 'waited' : err));
  })));
  assert.equal(verdicts.filter((v) => v === 'admitted').length, 2, verdicts.join('\n'));
  assert.equal(verdicts.filter((v) => v === 'waited').length, 6, verdicts.join('\n'));
  assert.equal(liveRunners(main), 0);
});

test('cell land: commits the cell\'s work, merges main in, checks, lands it --no-ff, and commits root\'s log', (t) => {
  const { main, wt, cellWt } = world(t);
  const land = (...args: string[]) => run('cli.ts', ['cell', 'land', '--cell', main, '--name', 'demo', ...args]);
  const clean = (dir: string) => git(dir, 'status', '--porcelain').trim();
  send(main, 'demo', 'write a report');                                     // mail: root-log entries, uncommitted
  takeNext(cellWt);
  mkdirSync(join(cellWt, 'exit'), { recursive: true });
  writeFileSync(join(cellWt, 'exit', 'report.md'), 'done\n');
  assert.match(land().stderr, /working on .*cellrun\.ts --cell demo --resume/);           // mid-task: refused
  stop(cellWt, 'report written');
  receive(main);
  writeFileSync(join(main, 'notes.md'), 'mine\n');
  assert.match(land().stderr, /root has uncommitted work of its own: notes\.md/);
  // #89: an untracked file that isn't the project's still stops the land, and the refusal names the way out
  assert.match(land().stderr, /\(commit or stash it first; an untracked file that isn't the project's.*\.git\/info\/exclude \(untracked here: notes\.md\)\)/);
  writeFileSync(join(main, ' lead my.txt'), 'x');                            // a name git's -z list starts with, spaces and all
  writeFileSync(join(main, 'kernel', '.gitkeep'), 'changed\n');             // with a tracked change: only the untracked are named
  assert.match(land().stderr, /of its own: .*kernel\/\.gitkeep.*\(untracked here:  lead my\.txt, notes\.md\)\)/);
  rmSync(join(main, ' lead my.txt'));
  writeFileSync(join(main, 'kernel', '.gitkeep'), '');
  writeFileSync(join(main, '.git', 'info', 'exclude'), 'notes.md\n');
  assert.ok(land('--dry-run').stdout.includes('would commit'));             // ignored on this machine: no longer root's work
  writeFileSync(join(main, '.git', 'info', 'exclude'), '');
  rmSync(join(main, 'notes.md'));
  writeFileSync(join(main, 'kernel', '.gitkeep'), 'changed\n');             // a tracked file: nothing to ignore, no such advice
  assert.match(land().stderr, /of its own: kernel\/\.gitkeep \(commit or stash it first\)/);
  writeFileSync(join(main, 'kernel', '.gitkeep'), '');
  writeFileSync(join(wt, 'stray.md'), 'x\n');
  assert.match(land().stderr, /outside cells\/demo\/: stray\.md/);
  rmSync(join(wt, 'stray.md'));
  const start = git(wt, 'rev-parse', 'HEAD').trim();
  const failed = land('--check', 'node -e "process.exit(3)"');
  assert.match(failed.stderr, /check failed .*exit 3[\s\S]*back where it was/);
  assert.equal(git(wt, 'rev-parse', 'HEAD').trim(), start);                // undone: the branch is where it was…
  assert.equal(readFileSync(join(cellWt, 'exit', 'report.md'), 'utf8'), 'done\n');   // …and the work is still there
  assert.ok(land('--dry-run').stdout.includes('would commit'));
  // #76: the dry run runs the check too, and names the shell it runs under
  assert.match(land('--dry-run', '--check', 'node -e "process.exit(4)"').stdout, /would stop: the check fails now, before the merge \(exit 4\)/);
  assert.match(land('--dry-run', '--check', 'node -e "process.exit(0)"').stdout, /under \S+[\s\S]*the check passes now/);
  const r = land('--message', 'the report', '--check', 'node -e "process.exit(0)"');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(main, 'cells', 'demo', 'exit', 'report.md'), 'utf8'), 'done\n');
  assert.equal(git(main, 'log', '-2', '--format=%s').trim().split('\n')[1], 'Land cell/demo: the report');
  assert.equal(git(main, 'rev-list', '--parents', '-1', 'HEAD~1').trim().split(' ').length, 3);   // a merge commit: revertable
  assert.match(git(main, 'log', '-1', '--format=%s'), /Root log: cell demo landed/);
  assert.equal(clean(main), '');                                             // nothing left uncommitted in root
  assert.equal(clean(wt), '');
  assert.equal(run('cli.ts', ['lint', '--cell', main]).status, 0);
  assert.doesNotMatch(run('cli.ts', ['lint', '--all', '--cell', main]).stderr, /(root|demo): views (are stale|missing)/);   // #7
  assert.match(land().stdout, /nothing to land/);
});

// #102 (ecom-lab): the cell had folded the root views in its worktree; root then logged an assumption on main; the land
// merged main in and its check compared the merged log with those views (git-ignored: no merge touches them).
test('cell land: the views in the worktree are rebuilt from the merged log before the check runs, and follow it back on an undo (#102)', async (t) => {
  const { refold } = await import('../src/refold.ts');
  const { tmp, main, wt, cellWt } = world(t);
  const land = (...args: string[]) => run('cli.ts', ['cell', 'land', '--cell', main, '--name', 'demo', ...args]);
  const work = (n: number) => { mkdirSync(join(cellWt, 'exit'), { recursive: true }); writeFileSync(join(cellWt, 'exit', `report${n}.md`), 'done\n'); };
  const onMain = (statement: string) => {                                   // root logs a guess and commits it
    assert.equal(run('cli.ts', ['assume', '--cell', main, '--statement', statement]).status, 0);
    git(main, 'add', '-A'); git(main, 'commit', '-qm', statement);
  };
  // the check a project would write: the root views in this checkout are those of the log in this checkout
  const check = join(tmp, 'views-current.mjs');
  writeFileSync(check, `import { readFileSync } from 'node:fs';
import { readLog } from ${JSON.stringify(pathToFileURL(join(src, 'log.ts')).href)};
const head = JSON.parse(readFileSync('state/views/summary.json', 'utf8')).head, log = readLog('.').at(-1).hash;
if (head !== log) { console.error('views are of ' + head + ', the log is at ' + log); process.exit(3); }
`);
  const viewHead = () => JSON.parse(readFileSync(join(wt, 'state', 'views', 'summary.json'), 'utf8')).head;
  const logHead = () => readLog(wt).at(-1)!.hash;

  work(1); onMain('the first guess');                                       // a checkout with no views gets none
  const none = land('--check', 'node -e "process.exit(0)"');
  assert.equal(none.status, 0, none.stdout + none.stderr);
  assert.ok(!existsSync(join(wt, 'state', 'views')));
  assert.doesNotMatch(none.stdout, /rebuilt the worktree's views/);

  refold(wt); refold(cellWt);                                               // the cell folds the root views in its worktree, and its own
  work(2); onMain('the second guess');
  const before = viewHead();
  assert.notEqual(before, readLog(main).at(-1)!.hash);                      // main's log has moved on
  const failed = land('--check', `node "${check}" && node -e "process.exit(5)"`);   // the views were current when the check ran: it got to the exit 5
  assert.match(failed.stderr, /check failed .*exit 5[\s\S]*back where it was/);
  assert.deepEqual([viewHead(), logHead()], [before, before]);              // undone: the views are of the branch's log again
  const r = land('--check', `node "${check}"`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /rebuilt the worktree's views from the merged log: \.\n[\s\S]*check passed/);   // the cell's own were not behind: not named
  assert.equal(viewHead(), logHead());
  assert.notEqual(viewHead(), before);

  onMain('the third guess');                                                // the same merge, made by cellrun before a session starts
  assert.match(level(main, wt).say, /^merged main [0-9a-f]{7} into the worktree; rebuilt its views from the merged log \(\.\)$/);
  assert.equal(viewHead(), logHead());

  // each cell's views too; views with no log beside them (a cell that is gone) are left alone; a log that can't be read
  // is named with its folder, stops a land, and doesn't keep the other folders' views from being rebuilt
  const { append, logDir } = await import('../src/log.ts');
  const { refoldPresent } = await import('../src/refold.ts');
  append(cellWt, { kind: 'observation', body: { source: { adapter: 't', provider: 't', capability: 't' }, observed_at: '2026-01-01T00:00:00.000Z', reliability: [], licence: { store: 'full' }, payload: { n: 1 } } });
  mkdirSync(join(wt, 'cells', 'ghost', 'state', 'views'), { recursive: true });
  assert.deepEqual(refoldPresent(wt), ['cells/demo']);
  assert.deepEqual(readdirSync(join(wt, 'cells', 'ghost', 'state', 'views')), []);
  const other = join(wt, 'cells', 'other');
  refold(other);
  append(cellWt, { kind: 'observation', body: { source: { adapter: 't', provider: 't', capability: 't' }, observed_at: '2026-01-01T00:00:00.000Z', reliability: [], licence: { store: 'full' }, payload: { n: 2 } } });
  const torn = join(logDir(other), readdirSync(logDir(other)).sort().at(-1)!), whole = readFileSync(torn);
  writeFileSync(torn, '{ "id": ');
  assert.throws(() => refoldPresent(wt), /^Error: cells\/other: /);
  assert.equal(JSON.parse(readFileSync(join(cellWt, 'state', 'views', 'summary.json'), 'utf8')).head, readLog(cellWt).at(-1)!.hash);   // demo's were still rebuilt
  writeFileSync(torn, whole);
  const tornFirst = join(logDir(cellWt), readdirSync(logDir(cellWt)).sort().at(-1)!), wholeFirst = readFileSync(tornFirst);
  writeFileSync(tornFirst, '{ "id": ');                                      // the failing folder comes first: the later one is still rebuilt
  rmSync(join(other, 'state', 'views', 'summary.json'));
  assert.throws(() => refoldPresent(wt), /^Error: cells\/demo: /);
  assert.ok(existsSync(join(other, 'state', 'views', 'summary.json')));
  writeFileSync(tornFirst, wholeFirst);
  const onMainToo = torn.replace(wt, main);                                  // the same entry, torn on main: the merge brings it in
  writeFileSync(onMainToo, '{ "id": '); git(main, 'commit', '-qam', 'a torn entry');
  work(3);
  const stopped = land('--check', 'node -e "process.exit(0)"');
  assert.match(stopped.stderr, /views in .* couldn't be rebuilt from the merged log.*: cells\/other: [\s\S]*lint --all[\s\S]*back where it was/);
  writeFileSync(onMainToo, whole); git(main, 'commit', '-qam', 'mended');
  const mended = land('--check', `node "${check}"`);
  assert.equal(mended.status, 0, mended.stdout + mended.stderr);
});

test('lint: a root handover untouched for 20 commits gets a warning', async (t) => {
  const { main } = world(t);
  const { handoverAge, HANDOVER_STALE } = await import('../src/lint.ts');
  assert.equal(handoverAge(main), null);                                    // no docs/ROOT.md: nothing to say
  mkdirSync(join(main, 'docs'), { recursive: true });
  writeFileSync(join(main, 'docs', 'ROOT.md'), '# ROOT\n');
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'handover');
  assert.equal(handoverAge(main), 0);
  for (let i = 0; i < HANDOVER_STALE; i++) git(main, 'commit', '-q', '--allow-empty', '-m', `work ${i}`);
  assert.match(run('cli.ts', ['lint', '--cell', main]).stderr, /docs\/ROOT\.md last changed 20 commits ago/);
});

test('lint: a native worktree left in the repo, or its branch unmerged, gets a warning; a cell\'s own worktree doesn\'t (#48)', async (t) => {
  const { main } = world(t);
  const { lintNativeWorktrees } = await import('../src/lint.ts');
  assert.deepEqual(lintNativeWorktrees(main), []);                          // demo's sibling worktree is a cell's, not native
  const n = join(main, '.claude', 'worktrees', 'agent-1');
  git(main, 'worktree', 'add', '-q', n, '-b', 'worktree-agent-1');
  writeFileSync(join(n, 'x.md'), 'x'); git(n, 'add', '-A'); git(n, 'commit', '-qm', 'side work');
  let w = lintNativeWorktrees(main);
  assert.equal(w.length, 1, w.join('\n'));                                   // the worktree; its branch is said with it
  assert.match(w[0], /native worktree \.claude\/worktrees\/agent-1 \(worktree-agent-1\)/);
  assert.match(run('cli.ts', ['lint', '--cell', main]).stderr, /native worktree/);
  assert.deepEqual(lintNativeWorktrees(join(main, 'cells', 'demo')), []);  // a cell's lint leaves it to root
  git(main, 'worktree', 'remove', '--force', n);
  w = lintNativeWorktrees(main);
  assert.equal(w.length, 1, w.join('\n'));
  assert.match(w[0], /branch worktree-agent-1 holds commits main doesn't have/);
  git(main, 'branch', '-D', 'worktree-agent-1');
  git(main, 'branch', 'worktree-merged');                                    // nothing of its own: nothing to say
  assert.deepEqual(lintNativeWorktrees(main), []);
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

// #94 (modelkit): the cell replaced a fixture folder with a regenerated one; each deleted file stopped the land.
test('cell land: test data replaced by as much data lands, and the land says so; a net loss, or data gone only during the run, still stops it (#94)', (t) => {
  const { main, wt, cellWt } = world(t);
  const land = (...args: string[]) => run('cli.ts', ['cell', 'land', '--cell', main, '--name', 'demo', ...args]);
  const shell = (command: string) => hook('hook-bash.ts', cellWt, { command });
  const fx = (dir: string, v: string, name: string) => join(dir, 'test', 'fixtures', v, name);
  mkdirSync(join(main, 'cells', 'demo', 'test', 'fixtures', 'v1'), { recursive: true });
  for (const n of ['log.jsonl', 'rows.json']) writeFileSync(fx(join(main, 'cells', 'demo'), 'v1', n), '{"n": 1}\n');
  writeFileSync(join(main, 'cells', 'demo', 'test', 'a.test.ts'), `for (const f of fixtures) test(f, () => { assert.ok(read(f)); });\n`);
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'tests'); git(wt, 'merge', '-q', 'main');

  // the cell regenerates the fixture, and runs its tests with the old one gone: a state the record holds
  rmSync(join(cellWt, 'test', 'fixtures', 'v1'), { recursive: true });
  mkdirSync(join(cellWt, 'test', 'fixtures', 'v2'), { recursive: true });
  for (const n of ['log.jsonl', 'rows.json']) writeFileSync(fx(cellWt, 'v2', n), '{"n": 2}\n');
  assert.equal(shell('node --test').status, 0);
  const said = /test data replaced, not counted as weaker tests: 2 file\(s\) holding no test case or assertion deleted, 2 added \(deleted: cells\/demo\/test\/fixtures\/v1\/log\.jsonl · cells\/demo\/test\/fixtures\/v1\/rows\.json\)/;
  const dry = land('--dry-run');
  assert.match(dry.stdout, said);
  assert.doesNotMatch(dry.stdout, /would stop/);

  rmSync(fx(cellWt, 'v2', 'rows.json'));                                    // one short: weaker, each deleted file named
  assert.match(land('--dry-run').stdout, /would stop: the cell's tests got weaker:\n  cells\/demo\/test\/fixtures\/v1\/log\.jsonl: deleted \(0 test case\(s\), 0 assertion\(s\)\)\n  cells\/demo\/test\/fixtures\/v1\/rows\.json: deleted/);
  const short = land('--message', 'one short');
  assert.match(short.stderr, /the cell's tests got weaker[\s\S]*fixtures\/v1\/rows\.json: deleted[\s\S]*back where it was/);
  writeFileSync(fx(cellWt, 'v2', 'rows.json'), '{"n": 2}\n');

  const ok = land('--message', 'fixture regenerated');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, said);
  assert.ok(!existsSync(fx(join(main, 'cells', 'demo'), 'v1', 'rows.json')) && existsSync(fx(join(main, 'cells', 'demo'), 'v2', 'rows.json')));

  // data gone while a command ran and put back since is not "replaced": nothing in the tree being landed stands for it
  rmSync(fx(cellWt, 'v2', 'log.jsonl'));
  assert.equal(shell('node --test').status, 0);
  writeFileSync(fx(cellWt, 'v2', 'log.jsonl'), '{"n": 2}\n');
  mkdirSync(join(cellWt, 'exit'), { recursive: true });
  writeFileSync(join(cellWt, 'exit', 'report.md'), 'done\n');
  assert.match(land('--message', 'report').stderr, /were weaker during its run[\s\S]*fixtures\/v2\/log\.jsonl: deleted \(0 test case\(s\), 0 assertion\(s\)\)[\s\S]*--accept-weaker/);
});

test('cell land: replaced test data lands when the cell committed the deletion itself; a state where the data was changed, not gone, still stops it (#94)', (t) => {
  const { main, wt, cellWt } = world(t);
  const land = (...args: string[]) => run('cli.ts', ['cell', 'land', '--cell', main, '--name', 'demo', ...args]);
  const shell = (command: string) => hook('hook-bash.ts', cellWt, { command });
  const fx = (v: string) => join(cellWt, 'test', 'fixtures', v, 'rows.json');
  mkdirSync(join(main, 'cells', 'demo', 'test', 'fixtures', 'v1'), { recursive: true });
  writeFileSync(join(main, 'cells', 'demo', 'test', 'fixtures', 'v1', 'rows.json'), '{"n": 1}\n');
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'tests'); git(wt, 'merge', '-q', 'main');

  git(wt, 'rm', '-q', 'cells/demo/test/fixtures/v1/rows.json'); git(wt, 'commit', '-qm', 'old fixture out');   // a commit of the cell's own
  assert.equal(shell('node --test').status, 0);                             // a state whose commit is one data file short
  mkdirSync(join(cellWt, 'test', 'fixtures', 'v2'), { recursive: true });
  writeFileSync(fx('v2'), '{"n": 2}\n');
  const ok = land('--message', 'fixture regenerated');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /test data replaced, not counted as weaker tests: 1 file\(s\)/);

  writeFileSync(fx('v2'), '{"cmd": "run || true"}\n');                      // changed to something that reads as loosening, a command run…
  assert.equal(shell('node --test').status, 0);
  rmSync(fx('v2'));                                                         // …then replaced
  mkdirSync(join(cellWt, 'test', 'fixtures', 'v3'), { recursive: true });
  writeFileSync(fx('v3'), '{"n": 3}\n');
  const stopped = land('--message', 'again');
  assert.match(stopped.stdout + stopped.stderr, /were weaker during its run[\s\S]*fixtures\/v2\/rows\.json: loosened/);
});

test('cell land: git-ignored files in the worktree are listed; with land.ignored set, any outside it stop the land, the check\'s own leftovers too (#77)', async (t) => {
  const { main, wt, cellWt } = world(t);
  const land = (...args: string[]) => run('cli.ts', ['cell', 'land', '--cell', main, '--name', 'demo', ...args]);
  const onMain = (message: string) => { git(main, 'add', '-A'); git(main, 'commit', '-qm', message); git(wt, 'merge', '-q', 'main'); };
  writeFileSync(join(main, '.gitignore'), 'node_modules/\n**/state/views/\ntmp/\n*.cache\n*.dat\n');
  onMain('ignores');
  const put = (text: string, ...path: string[]) => { mkdirSync(dirname(join(...path)), { recursive: true }); writeFileSync(join(...path), text); };
  put('done\n', cellWt, 'exit', 'report.md');
  put('x'.repeat(3000), cellWt, 'tmp', 'deep', 'real.json');                 // what a run left behind
  put('x', cellWt, 'tmp', 'a.json');
  put('{}', cellWt, 'tmp', 'node_modules', 'm', 'x.json');                   // a kit name elsewhere is data like the rest
  put('{}', cellWt, 'tmp', 'state', 'views', 'x.json');
  put('k', cellWt, 'tmp', 'ok.cache');
  put('{}', cellWt, 'state', 'views', 'x.json');                             // a view fold wrote: the one thing never listed
  // no allowlist: listed, never a refusal
  const listed = land('--dry-run');
  assert.match(listed.stdout, /git-ignored in the worktree, not landed: cells\/demo\/tmp\/ \(5 file\(s\), 3 KB\)/);
  assert.doesNotMatch(listed.stdout, /cells\/demo\/state\/views|would stop/);
  // an allowlist: anything outside it stops the land before it changes a thing
  const guards = join(main, 'state', 'bedrock', 'guards.json');
  put(JSON.stringify({ land: { ignored: ['**/*.cache'] } }), guards);
  onMain('guards');
  const start = git(wt, 'rev-parse', 'HEAD').trim();
  const refused = land('--message', 'the report');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /land\.ignored\) doesn't allow: cells\/demo\/tmp\/ \(4 file\(s\), 3 KB\)[\s\S]*the operator approves/);   // ok.cache is allowed
  assert.doesNotMatch(refused.stderr, /back where it was/);                  // refused whole: nothing to undo
  assert.equal(git(wt, 'rev-parse', 'HEAD').trim(), start);
  assert.match(git(wt, 'status', '--porcelain'), /report\.md/);              // not even committed on its branch
  rmSync(join(cellWt, 'tmp'), { recursive: true });
  // an ignored file in a folder git doesn't track yet, beside a plain one: git's folder listing leaves it out
  put('notes\n', cellWt, 'new', 'a.txt');
  put('x'.repeat(2000), cellWt, 'new', 'deep', 'b.dat');
  put('rows', cellWt, 'state', 'views', 'customers.csv');                    // and beside the views, something that is no view
  const hidden = land('--message', 'the report');
  assert.match(hidden.stderr, /doesn't allow: 2 entries, [\s\S]*cells\/demo\/new\/deep\/ \(1 file\(s\), 2 KB\) · cells\/demo\/state\/views\/ \(1 file\(s\), 1 KB\)/);
  assert.doesNotMatch(hidden.stderr, /back where it was/);
  rmSync(join(cellWt, 'new', 'deep'), { recursive: true });
  rmSync(join(cellWt, 'state', 'views', 'customers.csv'));
  put('k', cellWt, 'keep.cache');
  assert.match(land('--dry-run').stdout, /not landed \(allowed by land\.ignored\): cells\/demo\/keep\.cache \(1 KB\)/);
  put('x'.repeat(5000), cellWt, 'big.cache');                                // several: the sum, and the largest first
  assert.match(land('--dry-run').stdout, /: 2 entries, 5 KB in all: cells\/demo\/big\.cache \(5 KB\) · cells\/demo\/keep\.cache \(1 KB\)/);
  rmSync(join(cellWt, 'big.cache'));
  // a check that leaves files behind, in an ignored folder and in a new one: the land is undone
  const leaves = `node -e "const f=require('fs');f.mkdirSync('tmp');f.mkdirSync('scratch');f.writeFileSync('tmp/out.json','x');f.writeFileSync('scratch/log.txt','x');f.writeFileSync('scratch/real.dat','x')"`;
  const sweep = () => { for (const d of ['tmp', 'scratch']) rmSync(join(wt, d), { recursive: true }); };
  assert.match(land('--dry-run', '--check', leaves).stdout, /would stop: [\s\S]*doesn't allow: 2 entries, [\s\S]*scratch\/real\.dat \(1 KB\)/);
  sweep();
  const undone = land('--message', 'the report', '--check', leaves);
  assert.equal(undone.status, 1);
  assert.match(undone.stderr, /after the check: [\s\S]*doesn't allow: 2 entries, [\s\S]*tmp\/ \(1 file[\s\S]*back where it was/);
  assert.match(undone.stderr, /scratch\/real\.dat \(1 KB\)/);
  assert.equal(git(wt, 'rev-parse', 'HEAD').trim(), start);
  assert.doesNotMatch(git(main, 'log', '--format=%s'), /Land cell\/demo/);
  sweep();
  // a check that leaves a file git does show: said, and left to the next land
  assert.match(land('--dry-run', '--check', `node -e "require('fs').writeFileSync('cells/demo/dry.txt','x')"`).stdout, /the check left uncommitted paths in the worktree: cells\/demo\/dry\.txt/);
  rmSync(join(cellWt, 'dry.txt'));
  const ok = land('--message', 'the report', '--check', `node -e "require('fs').writeFileSync('cells/demo/left.txt','x')"`);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /the check left uncommitted paths in the worktree: cells\/demo\/left\.txt/);
  assert.match(ok.stdout, /allowed by land\.ignored\): cells\/demo\/keep\.cache/);
  // a guards doc that can't be read as an allowlist allows nothing
  writeFileSync(guards, JSON.stringify({ land: { ignored: ['**'] } }));
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'too wide');
  assert.match(land().stderr, /refused: .*land\.ignored\[0\] "\*\*": too wide/);
  const { checkGuards } = await import('../src/config.ts');
  assert.deepEqual(checkGuards({ land: { ignored: [] } }), []);              // set and empty: nothing ignored is allowed
  assert.deepEqual(checkGuards({ land: { ignored: ['**/__pycache__/**', 'cells/*/state/out/**'] } }), []);
  assert.match(checkGuards({ land: { ignored: ['../data/**'] } }).join(), /inside the worktree/);
  assert.match(checkGuards({ land: { ignored: 'tmp' } }).join(), /must be a list of globs/);
  for (const wide of ['**', '**/*', '**/*.*', '?*/**', '**/?*', '**/*.???*']) assert.match(checkGuards({ land: { ignored: [wide] } }).join(), /too wide/, wide);
  assert.match(checkGuards({ land: { allow: [] } }).join(), /land: unknown key "allow"/);
});

test('cell land: the last thing it prints is the "Decisions to confirm" of each reply it lands, or that a reply has none (#74)', async (t) => {
  const { main, wt, cellWt } = world(t);
  const { decisionsIn } = await import('../src/land.ts');
  const land = (...args: string[]) => run('cli.ts', ['cell', 'land', '--cell', main, '--name', 'demo', ...args]);
  const task = (ask: string, answer: string) => { send(main, 'demo', ask); takeNext(cellWt); stop(cellWt, answer); return receive(main)[0].id; };
  // the brief's heading, whatever marks surround it
  for (const h of ['## Decisions to confirm', '### Decisions to confirm', '**Decisions to Confirm**', '__Decisions to confirm__', '4. Decisions to confirm',
    '## 4. Decisions to confirm', '- **Decisions to confirm:**', '> ## Decisions to confirm', '## Decisions to be confirmed', '# Decisions to confirm #',
    '## Decisions to confirm.', '**Decisions to confirm** (2)', 'Decisions to confirm —', 'Decisions for the operator to confirm:  ', 'DECISIONS TO CONFIRM'])
    assert.deepEqual(decisionsIn(`Done.\r\n\r\n${h}\r\n- x\r\n`), ['- x'], h);
  assert.deepEqual(decisionsIn('Decisions to confirm (1): dropped the retry'), ['dropped the retry']);
  // where a section ends: under a # heading, the next one of its level or above; else the next # heading or the reply's end
  assert.deepEqual(decisionsIn('Done.\n\n## Decisions to confirm\n- Caption not read: the research didn\'t use it\n- Limit 50 per run\n\n## Files\n- a.ts'),
    ['- Caption not read: the research didn\'t use it', '- Limit 50 per run']);
  assert.deepEqual(decisionsIn('## Decisions to confirm\nScope:\n- export is CSV only\n**Default**\n- 50 per page\n\n## Files\n- a.ts'),
    ['Scope:', '- export is CSV only', '**Default**', '- 50 per page']);                 // grouped items are items
  assert.deepEqual(decisionsIn('## Decisions to confirm\n### 1. Caption not read\nThe research did not use it.\n# Next\nx'), ['### 1. Caption not read', 'The research did not use it.']);
  assert.deepEqual(decisionsIn('**Decisions to confirm:**\n1. kept the old schema\n\n## Tests\n12 pass'), ['1. kept the old schema']);
  assert.deepEqual(decisionsIn('**Decisions to confirm**\nNone\n**Except:**\n- capped runs at 50\n'), ['None', '**Except:**', '- capped runs at 50']);   // a bold line ends nothing
  assert.deepEqual(decisionsIn('Decisions to confirm (I capped runs at 50): none'), ['(I capped runs at 50)', 'none']);   // said in the heading's brackets
  assert.deepEqual(decisionsIn('Decisions to confirm:\nuse v2?\nI also chose the following:\n- limit 50'), ['use v2?', 'I also chose the following:', '- limit 50']);
  assert.deepEqual(decisionsIn('## Decisions to confirm\n- a\n```\n# limit raised\n```\n- b\n## Tests\nok'), ['- a', '```', '# limit raised', '```', '- b']);
  assert.equal(decisionsIn('Done.\n```\n## Decisions to confirm\n- quoted, not said\n```\n'), null);
  // every section is read; a look-alike before the real one hides nothing
  assert.deepEqual(decisionsIn('Decisions to confirm: none\n\n## Part 2\n\n## Decisions to confirm\n- real'), ['- real']);
  assert.deepEqual(decisionsIn('To confirm: all 12 tests pass.\n\n## Open questions\nNone.\n\n## Decisions to confirm\n- real'), ['- real']);
  // silent only when all it says is none; empty is said; "none, but" and "none" then more are decisions
  for (const none of ['Decisions to confirm: none', '## Decisions to confirm\n\n- None.\n', '**Decisions to confirm**\nnone\n\n## Tests\nok', 'Decisions to confirm: none\n\n(recovered by cellrun from runs/20261109T101500.jsonl: the session finished but its reply was never filed)'])
    assert.deepEqual(decisionsIn(none), [], none);
  assert.deepEqual(decisionsIn('## Decisions to confirm\n## Tests\nok'), ['(this section is empty: read the reply)']);
  assert.deepEqual(decisionsIn('Decisions to confirm:\n- none yet, but the limit is 50'), ['- none yet, but the limit is 50']);
  assert.deepEqual(decisionsIn('## Decisions to confirm\nNone.\n- except: capped the run at 50 items\n'), ['None.', '- except: capped the run at 50 items']);
  assert.deepEqual(decisionsIn('Decisions to confirm: none\n\nOne caveat: I dropped the XLSX export.'), ['none', 'One caveat: I dropped the XLSX export.']);
  assert.deepEqual(decisionsIn('## Decisions to confirm\n**None**\n### Caveat\nDropped XLSX.'), ['**None**', '### Caveat', 'Dropped XLSX.']);
  assert.deepEqual(decisionsIn('## Decisions to confirm\nNone — но экспорт ограничен'), ['None — но экспорт ограничен']);   // letters of any script
  assert.deepEqual(decisionsIn('Decisions to confirm:\n(recovered by cellrun from memory: capped runs at 50)'), ['(recovered by cellrun from memory: capped runs at 50)']);
  for (const absent of ['All done, 12 tests pass.', 'Open questions remain about the schema, but tests pass.', 'I had two decisions to confirm with you earlier; both are settled.',
    'Decisions to confirm with the operator were all settled.', '## Open questions\n- is v2 wanted?'])
    assert.equal(decisionsIn(absent), null, absent);                         // prose, or another heading, is no section
  // what is printed can't redraw the terminal or run on for ever
  assert.deepEqual(decisionsIn('## Decisions to confirm\n- a\u001b[2K\u0007b\r\n'), ['- a[2Kb']);
  const long = `- kept the old schema ${'because the migration was out of scope '.repeat(12)}and capped every run at 50 items`;   // a paragraph: whole
  assert.deepEqual(decisionsIn(`## Decisions to confirm\n${long}`), [long]);
  assert.match(decisionsIn(`## Decisions to confirm\n${'.'.repeat(300000)}x`)![0], /^\.{1000} … \(line cut: read the reply\)$/);

  mkdirSync(join(cellWt, 'exit'), { recursive: true });
  writeFileSync(join(cellWt, 'exit', 'report.md'), 'one\n');
  const first = task('write the report', 'Report written.\n\n## Decisions to confirm\n- Caption not read: the research didn\'t use it\n\n## Tests\n3 pass');
  const dry = land('--dry-run');
  assert.match(dry.stdout, new RegExp(`DECISIONS TO CONFIRM, from the reply being landed \\(${first}\\)\\. Take each to the operator, or log it[^\\n]*\\n  - Caption not read: the research didn't use it\\n(?!  )`));
  rmSync(join(mailbox(main), 'inbox', 'read', `${first}.json`));             // the mailbox is transient: the log's copy will do
  const landed = land('--message', 'the report');
  assert.equal(landed.status, 0, landed.stderr);
  // after everything else, the sync and root's log commit too: the last thing on the screen
  assert.match(landed.stdout, /landed cell\/demo on main[\s\S]*committed root's log: \w+\r?\n[^\n]*has no "Overturned" section[^\n]*\r?\nDECISIONS TO CONFIRM[^\n]*\n  - Caption not read: the research didn't use it\r?\n$/);
  assert.doesNotMatch(landed.stdout, /3 pass/);                              // the section, not the reply

  // the next land: only its own replies; one that says none is silent, one with no section is said
  writeFileSync(join(cellWt, 'exit', 'report.md'), 'two\n');
  task('revise it', 'Revised.\n\nDecisions to confirm: none\nOverturned: none');
  const quiet = land('--message', 'revised');
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stdout, /DECISIONS TO CONFIRM|Caption|no "Decisions to confirm"|Overturned/);
  writeFileSync(join(cellWt, 'exit', 'report.md'), 'three\n');
  const bare = task('once more', 'Done, all pass.');
  git(wt, 'add', '-A'); git(wt, 'commit', '-qm', 'by hand');                 // already committed on the branch: still a reply this land lands
  const kept = task('and the index', 'Indexed.\n\n**Decisions to confirm**\n- kept v1 of the schema');   // two replies in one land
  writeFileSync(join(mailbox(main), 'inbox', 'read', `${kept}.json`), '{ not json');   // a damaged mail file: the log's copy will do
  const both = land('--message', 'again').stdout;
  assert.match(both, new RegExp(`the reply being landed \\(${bare}\\) has no "Decisions to confirm" section: read it`));
  assert.match(both, new RegExp(`DECISIONS TO CONFIRM, from the reply being landed \\(${kept}\\)[^\\n]*\\n  - kept v1 of the schema`));

  // the work lands, then root's log commit fails (a hook that refuses): the decisions are printed all the same
  writeFileSync(join(cellWt, 'exit', 'report.md'), 'three and a half\n');
  task('one more', 'Done.\n\nDecisions to confirm:\n- dropped the XLSX export');
  mkdirSync(join(main, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(main, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\nif grep -q "^Root log:" "$1"; then exit 1; fi\nexit 0\n', { mode: 0o755 });
  const hooked = land('--message', 'hooked');
  rmSync(join(main, '.git', 'hooks', 'commit-msg'));
  assert.notEqual(hooked.status, 0);
  assert.match(hooked.stdout, /landed cell\/demo on main[\s\S]*DECISIONS TO CONFIRM[^\n]*\n  - dropped the XLSX export/);
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'the log the hook refused');

  // bodies kept out of the logs (mail.log "hash"): the text comes from root's mailbox
  mkdirSync(join(main, 'state', 'bedrock'), { recursive: true });
  writeFileSync(join(main, 'state', 'bedrock', 'guards.json'), JSON.stringify({ mail: { log: 'hash' } }));
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'guards'); git(wt, 'merge', '-q', 'main');
  writeFileSync(join(cellWt, 'exit', 'report.md'), 'four\n');
  task('and again', 'Done.\n\nDecisions to confirm:\n- skipped the archive (too large)');
  assert.doesNotMatch(readLog(cellWt).map((e) => JSON.stringify(e)).join('\n'), /skipped the archive/);
  assert.match(land('--message', 'hashed').stdout, /DECISIONS TO CONFIRM[^\n]*\n  - skipped the archive \(too large\)/);
});

test('cell land: "Overturned" items stop the land until root says what it checked, and the check is kept in the merge (#72)', async (t) => {
  const { main, wt, cellWt } = world(t);
  const { decisionsIn, overturnedIn } = await import('../src/land.ts');
  const land = (...args: string[]) => run('cli.ts', ['cell', 'land', '--cell', main, '--name', 'demo', ...args]);
  const task = (ask: string, answer: string) => { send(main, 'demo', ask); takeNext(cellWt); stop(cellWt, answer); return receive(main)[0].id; };
  // read as "Decisions to confirm" is; either heading ends the other's section
  const both = 'Done.\n\n## Decisions to confirm\nnone\n\n## Overturned\n- Sovereign at 10:53 was working, not waiting (transcript line 412)\n';
  assert.deepEqual(overturnedIn(both), ['- Sovereign at 10:53 was working, not waiting (transcript line 412)']);
  assert.deepEqual(decisionsIn(both), []);
  assert.deepEqual(overturnedIn('Decisions to confirm: none\nOverturned: the timeline was 3 messages short'), ['the timeline was 3 messages short']);
  assert.deepEqual(decisionsIn('Decisions to confirm: none\nOverturned: the timeline was 3 messages short'), []);
  assert.deepEqual(decisionsIn('Overturned: none\nDecisions to confirm:\n- capped runs at 50'), ['- capped runs at 50']);
  assert.deepEqual(overturnedIn('**Overturned values** (2)\n- a\n- b\n\n## Tests\nok'), ['- a', '- b']);
  for (const none of ['Overturned: none', '**Overturned**\nNothing overturned.', '## Overturned items\n- none', 'Overturned: no values'])
    assert.deepEqual(overturnedIn(none), [], none);
  assert.deepEqual(overturnedIn('Overturned: none, except the 10:53 label'), ['none, except the 10:53 label']);
  assert.deepEqual(overturnedIn('## Overturned\nnone\n\n---\n'), []);                // a rule under it says nothing
  assert.deepEqual(overturnedIn('**Overturned**\nnone\n\nAll tests pass (212/212).'), ['none', 'All tests pass (212/212).']);   // strict: more text is an item
  assert.deepEqual(overturnedIn('Overturned: none\n- ✗ → ✓'), ['none', '- ✗ → ✓']);                // symbols are not a rule
  // as a list item it is both: a line of the section it stands in, which goes on, and an item with what is indented under it
  const mine = 'Decisions to confirm:\n- Overturned: my own earlier default of 50, now 100\n- capped the run at 20';
  assert.deepEqual(decisionsIn(mine), ['- Overturned: my own earlier default of 50, now 100', '- capped the run at 20']);
  assert.deepEqual(overturnedIn(mine), ['my own earlier default of 50, now 100', '- capped the run at 20']);   // shown under both: never lost
  const numbered = 'Decisions to confirm:\n1. Capped at 20\n2. Overturned: my default 50, now 100\n3. Skipped the archive';
  assert.deepEqual(decisionsIn(numbered), ['1. Capped at 20', '2. Overturned: my default 50, now 100', '3. Skipped the archive']);
  assert.deepEqual(overturnedIn(numbered), ['my default 50, now 100', '3. Skipped the archive']);
  const bullets = '- **Decisions to confirm:** none\n- **Overturned:** label 3 was working, not waiting';
  assert.deepEqual(overturnedIn(bullets), ['label 3 was working, not waiting']);
  assert.deepEqual(decisionsIn(bullets), ['none', '- **Overturned:** label 3 was working, not waiting']);
  assert.deepEqual(overturnedIn('Done.\n* Overturned:\n  - label 3\n  - label 4\n* Tests: 12 pass'), ['  - label 3', '  - label 4', '* Tests: 12 pass']);
  assert.deepEqual(overturnedIn('- **Overturned:** label 3 was working,\nnot waiting (line 412)\n- label 4 too'), ['label 3 was working,', 'not waiting (line 412)', '- label 4 too']);
  assert.deepEqual(overturnedIn('- Overturned:\n- label 3'), ['- label 3']);
  assert.deepEqual(overturnedIn('- Overturned: none'), []);
  for (const absent of ['I overturned two labels.', 'Overturned two of the three labels: see below.', '## Decisions to confirm\n- a', 'Done.\n```\nOverturned: quoted, not said\n```'])
    assert.equal(overturnedIn(absent), null, absent);

  mkdirSync(join(cellWt, 'exit'), { recursive: true });
  writeFileSync(join(cellWt, 'exit', 'labels.md'), 'one\n');
  const id = task('label the sessions', 'Labelled.\n\nDecisions to confirm: none\n\nOverturned:\n- Sovereign at 10:53 was working, not waiting (transcript line 412)\n');
  assert.match(land('--dry-run').stdout, new RegExp(`would stop: cell demo overturned values the task or its sources gave:\\nfrom the reply being landed \\(${id}\\):\\n  - Sovereign at 10:53[^\\n]*\\n[^\\n]*--checked`));
  const start = git(wt, 'rev-parse', 'HEAD').trim(), mainStart = git(main, 'rev-parse', 'HEAD').trim();
  const refused = land('--message', 'labels');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /cell demo overturned values[\s\S]*Sovereign at 10:53[\s\S]*Check at least one item against its source yourself[\s\S]*--checked/);
  assert.equal(git(wt, 'rev-parse', 'HEAD').trim(), start);                  // refused before anything changed
  assert.equal(git(main, 'rev-parse', 'HEAD').trim(), mainStart);
  for (const noValue of [['--message', 'labels', '--checked', '  '], ['--checked', '--message', 'labels']]) {   // empty, or the next option taken as its value
    const r = land(...noValue);
    assert.equal(r.status, 1, noValue.join(' '));
    assert.match(r.stderr, /--checked needs what you checked/);
  }
  assert.match(land('--message', 'labels', '--checked', 'x', '--accept-weaker', '--dry').stderr, /--accept-weaker needs the operator's reason/);
  assert.equal(git(main, 'rev-parse', 'HEAD').trim(), mainStart);
  const ok = land('--message', 'labels', '--checked', 'read transcript line 412 myself: a tool call was open');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /overturned items checked by root: read transcript line 412 myself/);
  assert.match(git(main, 'log', '-1', '--format=%B', 'HEAD~1'), new RegExp(`Overturned by the cell, checked by root: read transcript line 412 myself[^\\n]*\\nfrom the reply being landed \\(${id}\\):\\n  - Sovereign at 10:53`));

  // --checked with nothing overturned is refused: never typed out of habit
  writeFileSync(join(cellWt, 'exit', 'labels.md'), 'two\n');
  task('again', 'Done.\n\nDecisions to confirm: none\nOverturned: none');
  const habit = land('--message', 'again', '--checked', 'looked fine');
  assert.equal(habit.status, 1);
  assert.match(habit.stderr, /--checked was given, but no reply being landed lists overturned items/);
  assert.match(land('--dry-run', '--checked', 'looked fine').stdout, /would stop: --checked was given/);
  const plain = land('--message', 'again');
  assert.equal(plain.status, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /Overturned|overturned/);

  // a reply with no such section (a cell not refreshed): said, not refused
  writeFileSync(join(cellWt, 'exit', 'labels.md'), 'three\n');
  const bare = task('more', 'Done.\n\nDecisions to confirm: none');
  const said = land('--message', 'more');
  assert.equal(said.status, 0, said.stderr);
  assert.match(said.stdout, new RegExp(`the reply being landed \\(${bare}\\) has no "Overturned" section: read it`));

  // two replies in one land: the one with items stops it, whatever the other says
  writeFileSync(join(cellWt, 'exit', 'labels.md'), 'four\n');
  const withItems = task('relabel', 'Done.\n\nDecisions to confirm: none\nOverturned:\n- apify after 11:07 was waiting, not idle');
  task('and tidy', 'Tidied.\n\nDecisions to confirm: none\nOverturned: none');
  const two = land('--message', 'two');
  assert.equal(two.status, 1);
  assert.match(two.stderr, new RegExp(`from the reply being landed \\(${withItems}\\):\\n  - apify after 11:07`));
  assert.equal(land('--message', 'two', '--checked', '--no-ff was not it: the 11:07 transcript line shows a question open').status, 0);   // words after it: a text, not an option

  // a long section keeps its end: an item far down is not past the cut
  writeFileSync(join(cellWt, 'exit', 'labels.md'), 'four and a half\n');
  task('all of them', `Done.\n\nDecisions to confirm: none\nOverturned:\n${Array.from({ length: 50 }, (_, i) => `- label ${i + 1} was wrong`).join('\n')}`);
  const long = land('--message', 'long');
  assert.equal(long.status, 1);
  assert.match(long.stderr, /  - label 30 was wrong\n  … 10 more line\(s\) here: read the reply\n  - label 41 was wrong\n[\s\S]*  - label 50 was wrong\n/);
  assert.equal(land('--message', 'long', '--checked', 'labels 1, 25 and 50 against the transcript').status, 0);

  // bodies kept out of the logs and no copy in root's mailbox (a second machine): unread is not "nothing overturned"
  mkdirSync(join(main, 'state', 'bedrock'), { recursive: true });
  writeFileSync(join(main, 'state', 'bedrock', 'guards.json'), JSON.stringify({ mail: { log: 'hash' } }));
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'guards'); git(wt, 'merge', '-q', 'main');
  writeFileSync(join(cellWt, 'exit', 'labels.md'), 'five\n');
  const gone = task('once more', 'Done.\n\nDecisions to confirm: none\nOverturned:\n- the timeline was 3 messages short');
  rmSync(join(mailbox(main), 'inbox', 'read', `${gone}.json`));
  const unread = land('--message', 'unread');
  assert.equal(unread.status, 1);
  assert.match(unread.stderr, new RegExp(`^refused: the text of a reply being landed \\(${gone}\\) can't be read here[^\\n]*\\nRead an unread reply where you have it[^\\n]*--checked`));
  assert.doesNotMatch(unread.stderr, /overturned values the task/);          // not known: not said
  const read = land('--message', 'unread', '--checked', 'its Overturned section: the timeline; I counted the 3 messages in the transcript');
  assert.equal(read.status, 0, read.stderr);
  assert.match(git(main, 'log', '-1', '--merges', '--format=%B'), /A reply that could not be read here, checked by root: its Overturned section: the timeline[^\n]*\nthe text of a reply being landed/);
});

test('cell land: a test that was weaker while a command of the run ran stops the land, though it was put back (#72)', async (t) => {
  const { tmp, main, wt, cellWt } = world(t);
  const { weakerDuring, weakerTests } = await import('../src/weaker.ts');
  const land = (...args: string[]) => run('cli.ts', ['cell', 'land', '--cell', main, '--name', 'demo', ...args]);
  const shell = (command: string, project = cellWt) => hook('hook-bash.ts', project, { command });
  const record = join(mailbox(cellWt), 'weaker.jsonl');
  const during = (into = 'main') => weakerDuring(cellWt, wt, into).map((x) => x.what);
  const body = `test('guard', () => {\n  assert.ok(guard());\n  assert.equal(written(), 0);\n});\n`, cut = body.replace('  assert.equal(written(), 0);\n', '');
  const fewer = (file: string) => `cells/demo/${file}: 1 fewer assertion line(s)`;
  for (const d of ['test', 'src']) mkdirSync(join(main, 'cells', 'demo', d), { recursive: true });
  writeFileSync(join(main, 'cells', 'demo', 'test', 'a.test.ts'), body);
  writeFileSync(join(main, 'cells', 'demo', 'src', 'my guard.test.ts'), body);   // a space in the name: git ends its diff header with a tab
  writeFileSync(join(main, 'cells', 'demo', 'test', 'rows.csv'), 'assert,1\n'.repeat(130000));   // over 1 MB: data, whatever its folder
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'tests'); git(wt, 'merge', '-q', 'main');
  const suite = join(cellWt, 'test', 'a.test.ts'), spaced = join(cellWt, 'src', 'my guard.test.ts');

  assert.throws(() => weakerTests(wt, 'no-such-commit'), /the tests couldn't be compared/);   // not "nothing weaker"
  assert.equal(shell('node --test').status, 0);
  assert.deepEqual(during(), []);
  // the cell takes an assertion out (an edit, or a sed the guards didn't see), runs its proof, and puts the line back
  writeFileSync(suite, cut);
  const proof = shell('node --test');
  assert.equal(proof.status, 0, proof.stderr);                               // it refuses nothing
  assert.equal(shell('git status').status, 0);                               // the same state again: written once
  assert.equal(readFileSync(record, 'utf8').trim().split('\n').length, 2);   // the tree as committed, then with the cut
  writeFileSync(suite, body);
  assert.equal(shell('git status').status, 0);
  assert.deepEqual(during(), [fewer('test/a.test.ts')]);
  assert.match(weakerDuring(cellWt, wt, 'main')[0].at, /^20\d\d-/);
  assert.deepEqual(git(wt, 'status', '--porcelain').trim(), '');             // the tree is as it was: git shows nothing

  // accepted with nothing to land: the acceptance would be in no commit, so the record stays
  const nothing = land('--message', 'nothing', '--accept-weaker', 'ok');
  assert.equal(nothing.status, 0, nothing.stderr);
  assert.match(nothing.stdout, /nothing to land; the record of tests that were weaker during the run is kept/);
  assert.equal(during().length, 1);

  mkdirSync(join(cellWt, 'exit'), { recursive: true });
  writeFileSync(join(cellWt, 'exit', 'proof.md'), 'the planted write was refused\n');
  assert.match(land('--dry-run').stdout, /would stop: the cell's tests were weaker during its run than they are now[^\n]*\n  cells\/demo\/test\/a\.test\.ts: 1 fewer assertion line\(s\) \(first seen 20[^\n]*\)\n[^\n]*--accept-weaker/);
  const start = git(wt, 'rev-parse', 'HEAD').trim();
  const refused = land('--message', 'proof');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /were weaker during its run[\s\S]*a\.test\.ts: 1 fewer assertion[\s\S]*--accept-weaker[\s\S]*back where it was/);
  assert.equal(git(wt, 'rev-parse', 'HEAD').trim(), start);
  assert.equal(during().length, 1);                                          // a refused land keeps the record
  const ok = land('--message', 'proof', '--accept-weaker', 'the proof was rerun on a copy of the test');   // (the operator)
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(git(main, 'log', '-1', '--merges', '--format=%B'), /Weaker tests, accepted by the operator: the proof was rerun[^\n]*\n  during the run, since put back: cells\/demo\/test\/a\.test\.ts: 1 fewer assertion/);
  assert.equal(existsSync(record), false);                                   // landed: the next run starts with none

  // weaker and still weaker at the land: said once, as the tree's; a test file with a space in its name is compared too
  // … whatever git is set to print: other prefixes, an external diff program that prints nothing
  git(main, 'config', 'diff.mnemonicPrefix', 'true'); git(main, 'config', 'diff.external', 'true');
  writeFileSync(suite, cut); writeFileSync(spaced, cut);
  shell('node --test');
  assert.deepEqual(during(), [fewer('src/my guard.test.ts'), fewer('test/a.test.ts')]);
  const still = land('--message', 'trimmed');
  assert.equal(still.status, 1);
  assert.match(still.stderr, /the cell's tests got weaker:\n  cells\/demo\/src\/my guard\.test\.ts: 1 fewer assertion[^\n]*\n  cells\/demo\/test\/a\.test\.ts: 1 fewer assertion/);
  assert.doesNotMatch(still.stderr, /during its run/);
  git(wt, 'reset', '-q');                                                    // (the refused land left the cut staged: unstage it)
  writeFileSync(spaced, body); rmSync(record);
  git(main, 'config', '--unset', 'diff.mnemonicPrefix'); git(main, 'config', '--unset', 'diff.external');

  // one assertion off for a proof and put back, then another dropped for good: the same words, and both are said
  shell('node --test');                                                      // (suite is cut: the proof's state)
  writeFileSync(suite, body.replace('  assert.ok(guard());\n', ''));
  shell('node --test');
  const twice = land('--message', 'the other line');
  assert.equal(twice.status, 1);
  assert.match(twice.stderr, /got weaker:\n  cells\/demo\/test\/a\.test\.ts: 1 fewer assertion[^\n]*\n[^\n]*were weaker during its run[^\n]*\n  cells\/demo\/test\/a\.test\.ts: 1 fewer assertion/);
  git(wt, 'reset', '-q'); writeFileSync(suite, cut); rmSync(record);

  // off and on again in two commits, a command between: the commit the command ran on is a state too
  git(wt, 'add', '--', 'cells/demo/test/a.test.ts'); git(wt, 'commit', '-qm', 'off for the proof');
  shell('node --test');
  writeFileSync(suite, body);
  git(wt, 'add', '--', 'cells/demo/test/a.test.ts'); git(wt, 'commit', '-qm', 'and on again');
  shell('node --test');
  assert.deepEqual(during(), [fewer('test/a.test.ts')]);
  assert.deepEqual(weakerTests(wt, 'main...HEAD'), []);                      // the tree being landed shows nothing
  git(wt, 'reset', '-q', '--hard', 'HEAD~2');                                // the test's own tidying
  writeFileSync(suite, cut); rmSync(record);

  // the bytes on disk are what is written down, whatever git is told to show of the file: an attribute that calls the
  // tests binary, a pathspec setting in the environment, assume-unchanged, skip-worktree (suite is still cut)
  writeFileSync(join(cellWt, '.gitattributes'), '*.test.ts binary\n');
  run('hook-bash.ts', [], { CLAUDE_PROJECT_DIR: cellWt, GIT_LITERAL_PATHSPECS: '1' }, JSON.stringify({ cwd: cellWt, tool_input: { command: 'node --test' } }));
  assert.deepEqual(during(), [fewer('test/a.test.ts')]);
  process.env.GIT_LITERAL_PATHSPECS = '1';                                   // the land's own comparison, of the tree, under both
  try { assert.deepEqual(weakerTests(wt, git(wt, 'merge-base', 'main', 'HEAD').trim()), [fewer('test/a.test.ts')]); } finally { delete process.env.GIT_LITERAL_PATHSPECS; }
  rmSync(join(cellWt, '.gitattributes')); rmSync(record);
  // … or an edit of the same size with the old modification time put back (git trusts the stat data, and shows nothing)
  writeFileSync(suite, body);
  const stat = statSync(suite);
  writeFileSync(suite, body.replace('  assert.equal(written(), 0);', '  //sert.equal(written(), 0);'));
  utimesSync(suite, stat.atime, stat.mtime);
  shell('node --test');
  assert.deepEqual(during(), [fewer('test/a.test.ts')]);
  assert.equal(existsSync(join(mailbox(cellWt), 'weaker')), true);           // the bytes are kept beside the record, not as git objects (a prune takes those)
  writeFileSync(suite, cut); rmSync(record);
  for (const flag of ['assume-unchanged', 'skip-worktree']) {
    git(wt, 'update-index', `--${flag}`, 'cells/demo/test/a.test.ts');
    assert.equal(git(wt, 'status', '--porcelain').trim(), '', flag);         // git shows nothing
    shell('node --test');
    assert.deepEqual(during(), [fewer('test/a.test.ts')], flag);
    rmSync(record); rmSync(suite);
    shell('node --test');
    assert.deepEqual(during(), ['cells/demo/test/a.test.ts: deleted (1 test case(s), 2 assertion(s))'], flag);   // gone: a finding, whichever mark hid it
    if (flag === 'skip-worktree') {                                          // but for a worktree that is a sparse checkout: left out, not there to run
      git(wt, 'config', 'core.sparseCheckout', 'true'); rmSync(record);
      shell('node --test');
      assert.deepEqual(during(), []);
      git(wt, 'config', '--unset', 'core.sparseCheckout');
    }
    rmSync(record, { force: true }); mkdirSync(suite);
    assert.equal(shell('node --test').status, 0, flag);                      // a folder where the file was: a finding, not a failure
    assert.deepEqual(during(), ['cells/demo/test/a.test.ts: deleted (1 test case(s), 2 assertion(s))'], flag);
    rmSync(suite, { recursive: true }); rmSync(record);
    writeFileSync(suite, body);
    shell('node --test');
    assert.deepEqual(during(), [], flag);                                    // hidden and unchanged: nothing
    git(wt, 'update-index', `--no-${flag}`, 'cells/demo/test/a.test.ts');
    writeFileSync(suite, cut); rmSync(record);
  }
  // Not a state of its own: the commit's bytes as git converts them (CRLF on disk under core.autocrlf), and a file over
  // 1 MB (data, though a test file by its folder).
  git(wt, 'config', 'core.autocrlf', 'true');
  writeFileSync(suite, body.replaceAll('\n', '\r\n'));
  writeFileSync(join(cellWt, 'test', 'rows.csv'), 'xssert,1\n'.repeat(130000));
  shell('node --test');
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8').trim().split('\n').at(-1)!).files, {});
  git(wt, 'config', 'core.autocrlf', 'false');
  git(wt, 'checkout', '-q', '--', 'cells/demo/test/rows.csv');
  writeFileSync(suite, cut); rmSync(record);
  // nor objects as git replace says: the commit the cell left main at, replaced by one that holds the cut
  const base = git(wt, 'merge-base', 'main', 'HEAD').trim();
  git(wt, 'add', '--', 'cells/demo/test/a.test.ts');
  const swapped = git(wt, 'commit-tree', git(wt, 'write-tree').trim(), '-p', base, '-m', 'as if it had always been so').trim();
  git(wt, 'reset', '-q');
  git(wt, 'replace', base, swapped);
  shell('node --test');
  assert.deepEqual(during(), [fewer('test/a.test.ts')]);
  git(wt, 'replace', '-d', base);
  writeFileSync(suite, body); rmSync(record);

  // a session that is not this cell's in its own worktree writes nothing down: another cell's session opened here, a
  // cell with no worktree (its session sits in the main checkout), root's, one in a folder that is no repository
  writeFileSync(suite, cut);
  writeFileSync(join(main, 'cells', 'demo', 'test', 'a.test.ts'), cut);
  const lone = join(tmp, 'lone', 'cells', 'x');
  mkdirSync(lone, { recursive: true });
  writeFileSync(join(lone, 'binding.json'), '{}');
  for (const project of [join(wt, 'cells', 'other'), join(main, 'cells', 'other'), main, lone]) {
    const r = shell('node --test', project);
    assert.equal(r.status, 0, `${project}: ${r.stderr}`);
  }
  for (const box of [cellWt, join(main, 'cells', 'other'), main]) assert.equal(existsSync(join(mailbox(box), 'weaker.jsonl')), false, box);
  writeFileSync(suite, body);
  git(main, 'checkout', '-q', '--', 'cells/demo/test/a.test.ts');

  // what can't be read is a finding: a line of the record, a commit it names, the bytes of a state
  mkdirSync(join(mailbox(cellWt)), { recursive: true });
  const none = '0'.repeat(40), head = git(wt, 'rev-parse', 'HEAD').trim();
  writeFileSync(record, `{ not json\n${JSON.stringify({ at: 'x', head: none, files: {} })}\n${JSON.stringify({ at: 'x', head, files: { 'cells/demo/test/a.test.ts': none } })}\n${JSON.stringify({ at: 'x', head: '--help', files: {} })}\n`);
  assert.deepEqual(during(), ['the record of this run holds a line that can\'t be read', 'the record of this run names a commit (000000000) that is gone, or shares none with main',
    'cells/demo/test/a.test.ts: what it held during the run can no longer be read']);
  writeFileSync(join(cellWt, 'exit', 'proof.md'), 'again\n');
  const damaged = land('--message', 'again');
  assert.equal(damaged.status, 1);
  assert.match(damaged.stderr, /were weaker during its run[\s\S]*the record of this run holds a line that can't be read/);
  rmSync(record);
  // a record that can't be written refuses the command
  if (process.platform === 'win32' || process.getuid?.() !== 0) {            // (root writes a read-only file)
    writeFileSync(record, '{}\n');
    chmodSync(record, 0o444);
    const blocked = shell('node --test');
    chmodSync(record, 0o644);
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /hook-bash failed/);
    assert.equal(readFileSync(record, 'utf8'), '{}\n');
  }
  rmSync(record);
  git(wt, 'checkout', '-q', '--', 'cells/demo/exit/proof.md');

  // The land judges, not the hook: each state against where the cell had left the branch being landed on. So none of
  // these is the cell's: a branch root made at the cell's tip, root's checkout sitting on it, or detached at an older
  // commit; an assertion main itself dropped; a trunk that isn't called main.
  writeFileSync(suite, `${body}test('more', () => { assert.ok(more()); });\n`);
  git(wt, 'add', '--', 'cells/demo/test'); git(wt, 'commit', '-qm', 'one more test');
  git(main, 'branch', 'look-at-demo', 'cell/demo');
  writeFileSync(suite, body);                                                // back to what main has: nothing weaker than main
  assert.equal(shell('ls').status, 0);
  git(main, 'checkout', '-q', 'look-at-demo');
  assert.equal(shell('ls').status, 0);
  git(main, 'checkout', '-q', 'main');
  assert.deepEqual(during(), []);
  git(main, 'branch', '-D', 'look-at-demo');
  git(wt, 'reset', '-q', '--hard', 'HEAD~1');                                // the test's own tidying: the branch as it was
  rmSync(record);

  git(main, 'checkout', '-q', '-b', 'develop');                              // the trunk here; main goes stale
  writeFileSync(join(main, 'cells', 'demo', 'test', 'a.test.ts'), cut);
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'root drops an assertion');
  git(wt, 'merge', '-q', 'develop');
  git(main, 'checkout', '-q', '--detach', 'HEAD~1');
  assert.equal(shell('ls').status, 0);
  git(main, 'checkout', '-q', 'develop');
  assert.deepEqual(during('develop'), []);
  assert.deepEqual(during('main'), [fewer('test/a.test.ts')]);               // landing on main instead, it would be: main still has the assertion
  assert.doesNotMatch(land('--dry-run').stdout, /would stop/);

  // an acceptance of nothing is refused, as a check of nothing is
  assert.match(land('--dry-run', '--accept-weaker', 'as last time').stdout, /would stop: --accept-weaker was given, but no test is or was weaker/);
  const habit = land('--message', 'x', '--accept-weaker', 'as last time');
  assert.equal(habit.status, 1);
  assert.match(habit.stderr, /--accept-weaker was given, but no test is or was weaker: drop it[\s\S]*back where it was/);

  // a worktree made anew starts with no record (one left by an earlier worktree, removed by hand, refused its first land)
  const left = join(mailbox(join(main, 'cells', 'other')), 'weaker.jsonl');
  mkdirSync(dirname(left), { recursive: true });
  writeFileSync(left, '{ an earlier run\n');
  assert.equal(run('cli.ts', ['cell', 'checkout', '--cell', main, '--name', 'other']).status, 0);
  assert.equal(existsSync(left), false);
});

test('cell land: an undo that fails says so, never "back where it was" (#77)', (t) => {
  const { tmp, main, wt, cellWt } = world(t);
  mkdirSync(join(cellWt, 'exit'), { recursive: true });
  writeFileSync(join(cellWt, 'exit', 'report.md'), 'done\n');
  const start = git(wt, 'rev-parse', 'HEAD').trim();
  // a check that breaks the worktree's git index: the listing after it fails, and so does the undo
  writeFileSync(join(tmp, 'break.cjs'), `const fs = require('fs'); fs.writeFileSync(fs.readFileSync('.git', 'utf8').replace('gitdir: ', '').trim() + '/index', 'garbage');\n`);
  const r = run('cli.ts', ['cell', 'land', '--cell', main, '--name', 'demo', '--message', 'the report', '--check', `node "${join(tmp, 'break.cjs')}"`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /after the check, the worktree's git-ignored files couldn't be listed: [\s\S]*nothing was landed, but cell\/demo could NOT be put back to/);
  assert.doesNotMatch(r.stderr, /is back where it was/);
  assert.doesNotMatch(git(main, 'log', '--format=%s'), /Land cell\/demo/);
  assert.notEqual(git(main, 'rev-parse', 'cell/demo').trim(), start);          // the message is true: the land's commit is still there
});

test('cell land: a check\'s result names the main checkout\'s git-ignored paths it ran without (#68)', (t) => {
  const { main, wt, cellWt } = world(t);
  const land = (...args: string[]) => run('cli.ts', ['cell', 'land', '--cell', main, '--name', 'demo', ...args]);
  writeFileSync(join(main, '.gitignore'), 'node_modules/\n**/state/views/\ndata/\n.env\n');
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'ignores'); git(wt, 'merge', '-q', 'main');
  for (const d of [join(main, 'data', 'raw'), join(main, 'kernel', 'node_modules', 'm')]) {   // real data; and what npm installs
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'x.json'), '{}');
  }
  writeFileSync(join(main, '.env'), 'K=v\n');
  mkdirSync(join(cellWt, 'exit'), { recursive: true });
  writeFileSync(join(cellWt, 'exit', 'report.md'), 'done\n');
  const pass = 'node -e "process.exit(0)"';
  assert.match(land('--dry-run', '--check', pass).stdout, /the check ran without the main checkout's git-ignored paths: \.env · data\/ \(/);
  assert.doesNotMatch(land('--dry-run').stdout, /ran without/);              // no check: nothing ran
  mkdirSync(join(wt, 'data', 'raw'), { recursive: true });                   // an empty folder of that name is not the data
  assert.match(land('--dry-run', '--check', pass).stdout, /git-ignored paths: \.env · data\/ \(/);
  // files of its own there: no longer missing
  writeFileSync(join(wt, 'data', 'sample.json'), '{}');
  const r = land('--message', 'the report', '--check', pass);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /check passed[\s\S]*git-ignored paths: \.env \([\s\S]*not landed: data\/ \(1 file/);
  assert.doesNotMatch(r.stdout, /node_modules/);
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
