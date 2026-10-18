// The cell boundary: a session running in a cell writes only inside it; root sessions are unaffected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const guard = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hook-guard.ts');
const tryWrite = (project: string, file_path: string) =>
  spawnSync(process.execPath, [guard], { input: JSON.stringify({ tool_input: { file_path } }), env: { ...process.env, CLAUDE_PROJECT_DIR: project }, encoding: 'utf8' }).status;

test('boundary: a cell session writes inside its folder only', () => {
  const root = mkdtempSync(join(tmpdir(), 'cellkit-boundary-')).replaceAll('\\', '/');
  const cell = `${root}/cells/c1`;
  mkdirSync(cell, { recursive: true });
  writeFileSync(`${cell}/binding.json`, '{}');
  assert.equal(tryWrite(cell, `${cell}/exit/tonight.ts`), 0);
  assert.equal(tryWrite(cell, 'exit/tonight.ts'), 0);                 // relative = inside
  assert.equal(tryWrite(cell, `${root}/kernel/src/voices.ts`), 2);     // the kernel is root's
  assert.equal(tryWrite(cell, `${cell}/../../docs/MODELS.md`), 2);         // no ../ escape
  assert.equal(tryWrite(cell, '../../docs/MODELS.md'), 2);
  assert.equal(tryWrite(cell, `${root}/cells/c2/x.ts`), 2);            // other cells
  assert.equal(tryWrite(cell, `${cell}/state/log/000001.observation.json`), 2); // inside, but kernel-owned
  assert.equal(tryWrite(cell, `${cell}/state/views/summary.json`), 2);  // inside, but kernel-owned
  assert.equal(tryWrite(cell, `${cell}/state/out/metrics.json`), 0);    // the cell's exit: it publishes here (cell sync reads it)
  assert.equal(tryWrite(cell, 'state/out/metrics.json'), 0);
  assert.equal(tryWrite(root, `${root}/kernel/src/x.ts`), 0);          // root session: no cell boundary
});

const bashHook = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hook-bash.ts');
const tryShell = (command: string) =>
  spawnSync(process.execPath, [bashHook], { input: JSON.stringify({ tool_input: { command } }), env: { ...process.env, CLAUDE_PROJECT_DIR: '' }, encoding: 'utf8' }).status;

test('shell guard: kernel-owned paths are refused from bash and from PowerShell', () => {
  assert.equal(tryShell('echo x > state/log/000009.claim.json'), 2);
  assert.equal(tryShell('Set-Content state\\log\\000009.claim.json "x"'), 2);
  assert.equal(tryShell('"x" | Out-File docs/assumptions.md'), 2);
  assert.equal(tryShell('Remove-Item state\\views\\summary.json'), 2);
  assert.equal(tryShell('move-item a.md state/bedrock/ontology.md'), 2);
  assert.equal(tryShell('[IO.File]::WriteAllText("state/log/x.json", "x")'), 2);
  assert.equal(tryShell('Copy-Item draft.md state/bedrock/proposed/ontology.md'), 0); // staging a proposal is allowed
  assert.equal(tryShell('echo {} > state/out/metrics.json'), 0);                      // a cell publishes its numbers
  assert.equal(tryShell('Set-Content state\\out\\metrics.json "{}"'), 0);
  assert.equal(tryShell('Get-Content state\\log\\000001.observation.json'), 0);      // reading is fine
  assert.equal(tryShell('node kernel/src/cli.ts fold'), 0);
  assert.equal(tryShell('node -e "const v=require(\'./state/views/x.json\'); v.n>=1"'), 0);      // a comparison is not a redirect
  assert.equal(tryShell('node -e "require(\'./state/views/x.json\'); /copy|backup/.test(n)"'), 0); // an alias is a command only where a command starts
  assert.equal(tryShell('cd x; copy a.json state/log/000009.claim.json'), 2);
  assert.equal(tryShell('del state\\views\\summary.json'), 2);
  assert.equal(tryShell('git commit -m "x <noreply@anthropic.com>"; node -e "require(\'./state/views/p.json\')"'), 0); // an email in quotes is not a redirect
  assert.equal(tryShell('echo x > "state/log/000009.claim.json"'), 2);                      // a redirect to a quoted path still is
  assert.equal(tryShell('node -e "require(\'fs\').writeFileSync(\'state/log/x.json\', \'x\')"'), 2); // a script write inside quotes still is
});

const shellIn = (project: string, command: string, env: Record<string, string> = {}, cwd = project) =>
  spawnSync(process.execPath, [bashHook], { input: JSON.stringify({ cwd, tool_input: { command } }), env: { ...process.env, CLAUDE_PROJECT_DIR: project, ...env }, encoding: 'utf8' }).status;

test('shell guard: a cell session writes inside its folder only, from the shell too', () => {
  const root = mkdtempSync(join(tmpdir(), 'cellkit-shell-')).replaceAll('\\', '/');
  const cell = `${root}/cells/c1`;
  mkdirSync(cell, { recursive: true });
  writeFileSync(`${cell}/binding.json`, '{}');
  assert.equal(shellIn(cell, 'echo x > exit/report.md'), 0);
  assert.equal(shellIn(cell, 'cp ../../kernel/src/log.ts exit/log-copy.ts'), 0);             // reading from above is fine
  assert.equal(shellIn(cell, 'cp exit/a.ts ../../kernel/src/a.ts'), 2);                      // writing above is not
  assert.equal(shellIn(cell, 'rm -rf ../c2'), 2);                                            // nor into another cell
  assert.equal(shellIn(cell, 'cd .. && echo x > y.txt'), 2);                                 // cd is followed
  assert.equal(shellIn(cell, 'npm test 2>&1 | tee test/out.txt'), 0);
  assert.equal(shellIn(cell, `Set-Content -Path ${root}/docs/x.md -Value 1`), 2);
  assert.equal(shellIn(cell, `echo x > ${tmpdir().replaceAll('\\', '/')}/scratch.txt`), 0);    // the temp folder is fine
  assert.equal(shellIn(cell, 'echo x > /dev/null'), 0);
  assert.equal(shellIn(cell, 'npm test > /tmp/out.txt 2>&1'), 0);
  assert.equal(shellIn(cell, 'echo x > exit/a.md', {}, root), 2);                            // the shell's cwd counts
  assert.equal(shellIn(root, `cp a.ts ${root}/kernel/src/a.ts`), 0);                         // root session: no cell boundary
});

test('guards.json: a project adds operator-only commands and protected paths without editing the kernel', () => {
  const root = mkdtempSync(join(tmpdir(), 'cellkit-config-')).replaceAll('\\', '/');
  mkdirSync(`${root}/state/bedrock`, { recursive: true });
  const cfg = `${root}/state/bedrock/guards.json`;
  writeFileSync(cfg, JSON.stringify({
    operator_only: [{ command: 'portfolio/src/pm.ts decide', message: 'decisions are the operator\'s' }, { pattern: '\\bsf\\s+data\\s+delete\\b' }],
    protected: [{ path: 'docs/portfolio/', by: 'portfolio/src/pm.ts' }, { path: 'docs/models/trace.md' }],
  }));
  const env = { CELLKIT_CONFIG: cfg };
  const sh = (c: string) => shellIn('', c, env);
  const wr = (file_path: string) => spawnSync(process.execPath, [guard], { input: JSON.stringify({ tool_input: { file_path } }), env: { ...process.env, CLAUDE_PROJECT_DIR: '', ...env }, encoding: 'utf8' }).status;
  assert.equal(sh('node portfolio/src/pm.ts decide --file d.json'), 2);
  assert.equal(sh('node "portfolio\\src\\pm.ts" decide --file d.json'), 2);
  assert.equal(sh('node portfolio/src/pm.ts fold'), 0);                       // only the named subcommand
  assert.equal(sh('sf data delete record -s Account'), 2);
  assert.equal(sh('echo x > docs/portfolio/holdings.md'), 2);
  assert.equal(sh('node portfolio/src/pm.ts fold > docs/portfolio/holdings.md'), 0);        // its writer may
  assert.equal(sh('cat docs/portfolio/holdings.md'), 0);
  assert.equal(sh('rm docs/models/trace.md'), 2);
  assert.equal(sh('rm docs/models/trace.md.bak'), 0);
  assert.equal(sh('echo {} > state/bedrock/guards.json'), 2);                 // the guards are bedrock
  assert.equal(sh('cp draft.json state/bedrock/proposed/guards.json'), 0);    // …proposed like any bedrock doc
  assert.equal(sh('cat state/bedrock/guards.json'), 0);
  assert.equal(sh('git commit -F msg.txt; echo "see docs/portfolio/x.md" > notes.md'), 0);   // a mention is not a write
  assert.equal(sh('node -e "require(\'fs\').writeFileSync(\'docs/portfolio/x.md\', \'{}\')"'), 2);
  assert.equal(sh('Remove-Item docs\\portfolio\\holdings.md'), 2);
  assert.equal(wr(`${root}/docs/portfolio/holdings.md`), 2);
  assert.equal(wr('docs/models/trace.md'), 2);
  assert.equal(wr(cfg), 2);
  assert.equal(wr(`${root}/state/bedrock/proposed/guards.json`), 0);
  assert.equal(wr(`${root}/docs/notes.md`), 0);
  writeFileSync(cfg, '{ not json');
  assert.equal(sh('ls'), 2);                                                   // invalid: refuse until the operator fixes it
  assert.equal(wr(`${root}/docs/notes.md`), 2);
  writeFileSync(cfg, JSON.stringify({ cells: { c1: { owns: ['kernel/src/**'] } } }));
  assert.equal(sh('ls'), 2);                                                   // a cell can't own the kernel
  assert.equal(shellIn('', 'ls', { CELLKIT_CONFIG: `${root}/missing.json` }), 0);   // none: no project guards
});

const shellOut = (command: string, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [bashHook], { input: JSON.stringify({ tool_input: { command } }), env: { ...process.env, CLAUDE_PROJECT_DIR: '', ...env }, encoding: 'utf8' });

test('shell guard: kernel-owned only as a path from the repo or a cell root; the refusal names the path', () => {
  assert.equal(tryShell('mkdir -p test/fixtures/PM/state/views && echo {} > test/fixtures/PM/state/views/a.json'), 0);   // a fixture (SF-DEV)
  assert.equal(tryShell('cp x.json fixtures/ws/state/log/000001.observation.json'), 0);
  const r = shellOut('echo x > state/views/a.json');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /writes state\/views\/, which is kernel-owned/);
  assert.equal(tryShell('echo x > ../../state/log/000009.claim.json'), 2);                 // from a cell, up to root's
  assert.equal(tryShell('echo x > cells/demo/state/log/000009.claim.json'), 2);            // a cell's, from root
  assert.equal(tryShell('echo x > ../other/state/log/000009.claim.json'), 2);              // a sibling cell's
  assert.equal(tryShell(`echo x > ${process.cwd().replaceAll('\\', '/')}/state/log/000009.claim.json`), 2);   // the repo, absolute
  assert.equal(tryShell(`echo x > ${process.cwd().replaceAll('\\', '/')}/cells/demo/state/views/s.json`), 2);
});

test('guards fail closed: a check that throws, or input they can\'t read, refuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cellkit-failclosed-'));            // a directory where guards.json should be: reading throws
  const r = shellOut('ls', { CELLKIT_CONFIG: dir });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /hook-bash failed \(.*\); refusing/);
  const g = spawnSync(process.execPath, [guard], { input: JSON.stringify({ tool_input: { file_path: 'x.md' } }), env: { ...process.env, CLAUDE_PROJECT_DIR: '', CELLKIT_CONFIG: dir }, encoding: 'utf8' });
  assert.equal(g.status, 2, g.stderr);
  assert.match(g.stderr, /hook-guard failed/);
  for (const hook of [bashHook, guard])
    assert.equal(spawnSync(process.execPath, [hook], { input: '{ not json', env: { ...process.env, CLAUDE_PROJECT_DIR: '' }, encoding: 'utf8' }).status, 2);
});

test('shell guard: nobody kills processes by name (other projects\' runners die too); by pid is fine', () => {
  for (const c of ['taskkill /F /IM python.exe', 'taskkill /im claude.exe /t /f', 'pkill -f cellrun', 'killall node', 'Stop-Process -Name node -Force',
    'Get-Process claude | Stop-Process', 'kill -9 $(pgrep node)'])
    assert.equal(tryShell(c), 2, c);
  for (const c of ['taskkill /PID 4242 /T /F', 'kill 4242', 'Stop-Process -Id 4242', 'git commit -m "never taskkill /IM python.exe"'])
    assert.equal(tryShell(c), 0, c);
});

test('boundary: a cell may write the temp folder (outside the repo) from Write/Edit, as from the shell', () => {
  const root = mkdtempSync(join(tmpdir(), 'cellkit-tmpw-')).replaceAll('\\', '/');
  const cell = `${root}/cells/c1`;
  mkdirSync(cell, { recursive: true });
  writeFileSync(`${cell}/binding.json`, '{}');
  assert.equal(tryWrite(cell, join(tmpdir(), 'cellkit-scratch', 'fix2.mjs')), 0);   // SF-DEV run sources/211643Z
  assert.equal(tryWrite(cell, '/tmp/fix2.mjs'), 0);
  assert.equal(tryWrite(cell, `${root}/kernel/x.ts`), 2);                          // the repo is in the temp folder here: still root's
});
