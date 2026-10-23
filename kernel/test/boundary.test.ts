// The cell boundary: a session running in a cell writes only inside it; root sessions are unaffected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  assert.equal(sh('git -C . checkout -- docs/models/trace.md'), 2);           // git's writes too (#1)
  assert.equal(sh('git restore --staged docs/models/trace.md'), 0);
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

const shellOut = (command: string, env: Record<string, string> = {}, cwd?: string) =>
  spawnSync(process.execPath, [bashHook], { input: JSON.stringify({ cwd, tool_input: { command } }), env: { ...process.env, CLAUDE_PROJECT_DIR: '', ...env }, encoding: 'utf8' });

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

test('shell guard: it matches what a command does, not text it carries (#2)', () => {
  // SF-DEV S5 (retro C8): a commit message, a mail body, a heredoc that is a message or only reads.
  for (const c of ['git commit -q -m "maps.json and maps.md under state/views/ now" && git log -1', "git commit -F - <<'EOF'\nC3: state/views/maps.md is rebuilt\nEOF",
    "python - > out.md <<'EOF'\nprint(open('state/bedrock/ontology.md').read())\nEOF", 'echo "see state/log/000001.observation.json" > notes.md',
    'git commit -m "fix state/log/ handling" && rm build.tmp', "cat > notes.md <<EOF\nnode -e \"writeFileSync('state/log/x.json')\"\nEOF",
    "cat > tools/fix.mjs <<'EOF'\nwriteFileSync('docs/assumptions.md', s)\nEOF", 'printf "%s" "state/views/ => rebuilt" > out.txt',
    "cat > notes.md <<EOF\nrm state/views/x\necho y > state/log/z\nEOF"])
    assert.equal(tryShell(c), 0, c);
  // acts: still refused
  for (const c of ['tee "state/log/000009.claim.json" < x', 'Set-Content -Path "state/log/000009.claim.json" -Value x', 'echo x > "state/log/000009.claim.json"',
    'cp a.json "state/log/000009.claim.json"', 'mv "a.json" "state/views/s.json"', "python - <<'EOF'\nopen('state/log/000009.claim.json', 'w').write('x')\nEOF",
    "bash <<'EOF'\necho x > state/log/000009.claim.json\nEOF", 'bash -c "rm state/views/summary.json"', 'node -e "require(\'fs\').writeFileSync(\'docs/assumptions.md\', \'x\')"',
    '[IO.File]::WriteAllText("state/log/x.json", "x")', "node - <<'EOF'\nrequire('fs').rmSync('state/views/summary.json')\nEOF",
    'cmd /c "del state\\views\\summary.json"', 'echo "x > state/log/000009.claim.json', 'echo "$(rm state/views/summary.json)"',
    'deno eval "Deno.writeFileSync(\'state/log/000009.claim.json\', x)"'])
    assert.equal(tryShell(c), 2, c);
  // the operator's acts stay mention-strict: a wrapper could hide them
  for (const c of ['bash -c "node kernel/src/cli.ts approve --doc x"', 'git commit -m "ran node kernel/src/cli.ts approve --doc x"'])
    assert.equal(tryShell(c), 2, c);
});

test('shell guard: a kernel-owned folder named without its slash, or a folder holding one removed, is refused (#49)', () => {
  // Before #49 only `state/log/` (with the slash) matched: `rm -rf state/log` and `rmSync('state/views')` passed.
  for (const c of ['rm -rf state/log', 'rm -r state/views', 'rmdir state/bedrock', 'mv state/bedrock old/', 'mv x.json state/log',
    'rm -rf cells/demo/state/log', 'Remove-Item -Recurse state\\views', 'rm -rf "state/log"',
    'rm -rf docs', 'rm -rf state', 'rm -rf .', 'rm -rf *', 'rm -rf ./*', 'rm -rf cells/demo', 'rm -rf cells/*', 'mv docs old-docs',
    'cd state && rm -rf log', 'cd cells/demo && rm -rf state', 'cd cells && rm -rf demo/state/views',
    "node - <<'EOF'\nrequire('fs').rmSync('state/views', { recursive: true })\nEOF", 'node -e "require(\'fs\').rmSync(\'docs\', { recursive: true })"',
    "python - <<'EOF'\nimport shutil\nshutil.rmtree('state')\nEOF", 'node -e "require(\'fs\').renameSync(\'state/log\', \'old\')"'])
    assert.equal(tryShell(c), 2, c);
  // the repo by its absolute path, and on Windows by Git Bash's /d/x for D:/x (root's own session ran `cd /d/… && rm -rf state/views`)
  const here = process.cwd().replaceAll('\\', '/');
  const bashForm = process.platform === 'win32' ? `/${here[0].toLowerCase()}${here.slice(2)}` : here;
  for (const r of [here, bashForm])
    for (const c of [`cd ${r} && rm -rf state/views`, `rm -rf ${r}/state/log`, `echo x > ${r}/state/log/000009.claim.json`, `cd ${r}/cells && rm -rf demo`])
      assert.equal(tryShell(c), 2, c);
  for (const c of ['mkdir -p test/fixtures/x/state/views', 'rm -rf test/fixtures/x/state', 'rm *.tmp', 'rm -rf build node_modules',
    'cp notes.md docs/', 'mv draft.md docs/guide.md', 'cd docs && rm old.md', 'rm -rf cells/demo/exit', 'rm -rf state/out',
    'mkdir -p state/bedrock/proposed', 'node -e "require(\'fs\').rmSync(\'build\', { recursive: true })"', 'cd /tmp && rm -rf state'])
    assert.equal(tryShell(c), 0, c);
});

test('shell guard: git clean, stash -u and reset to an earlier commit delete log entries: refused where they would (#3)', () => {
  // Checked in a throwaway repo: reset --hard/--keep/--merge HEAD~1 deleted the entry committed since; clean -f and
  // stash -u/-a took the uncommitted one away; reset --hard (HEAD), --mixed, plain stash and clean -n kept everything.
  for (const c of ['git reset --hard HEAD~1', 'git reset --keep origin/main', 'git reset --merge abc123', 'git -C cells/demo reset --hard HEAD~2',
    'cd cells/demo && git reset --hard HEAD~1', 'git clean -fd', 'git clean -f', 'git clean -fdx', 'git clean -ffdx', 'git clean --force -d state',
    'git clean -fd cells/demo', 'cd cells/demo && git clean -fd', 'git stash -u', 'git stash push --include-untracked', 'git stash -a', 'git stash save -u wip',
    'git stash push -u -- state/log', 'git clean -fd -e build', 'git -c core.x=y clean -fd'])
    assert.equal(tryShell(c), 2, c);
  for (const c of ['git reset --hard', 'git reset --hard HEAD', 'git reset --keep @', 'git reset --mixed HEAD~1', 'git reset --soft HEAD~1', 'git reset HEAD~1',
    'git reset -- state/log/000001.observation.json', 'git clean -n', 'git clean -nd', 'git clean --dry-run -fd', 'git clean -fdX', 'git clean -fd build/',
    'cd build && git clean -fdx', 'git stash', 'git stash push -m wip', 'git stash pop', 'git stash list', 'git stash -u -- build/',
    'git -C /tmp/other reset --hard HEAD~1', 'cd /tmp/other && git reset --hard HEAD~1', 'git clean -fd /tmp/x'])
    assert.equal(tryShell(c), 0, c);
  const r = shellOut('git reset --hard HEAD~1');
  assert.match(r.stderr, /moves this checkout back[\s\S]*git revert/);
});

test('shell guard: git checkout, restore, rm and mv write their paths, read through git\'s own options (#1)', () => {
  // Before #1 the bare `git checkout -- docs/assumptions.md` passed (no write verb in the text), and every form behind
  // git's options (-C <dir>, --work-tree, --git-dir, -c, --no-pager) did too. AI-MMO 1e39484 (test_hooks.py).
  const r = mkdtempSync(join(tmpdir(), 'cellkit-git-')).replaceAll('\\', '/');
  const sh = (command: string, cwd = r) => shellOut(command, { CLAUDE_PROJECT_DIR: r }, cwd);
  const owned = ['docs/assumptions.md', 'state/log/000009.claim.json', 'state/views/summary.json', 'state/bedrock/ontology.md'];
  const bare = owned.flatMap((p) => ['checkout --', 'restore', 'rm', 'checkout HEAD --', 'restore --source HEAD --staged --worktree'].map((sub) => `git ${sub} ${p}`));
  const prefixes = [`-C ${r}`, `-C "${r}"`, '-C .', `-C ${r}/docs -C ..`, `-C${r}`, '--no-pager', '-c core.autocrlf=false',
    `-C /nowhere --work-tree=${r}`, `-C /nowhere --work-tree ${r}`, `--git-dir=${r}/.git`, '-C $CLAUDE_PROJECT_DIR', '-C ${CLAUDE_PROJECT_DIR}'];
  const refused = [...bare, ...bare.flatMap((c) => prefixes.map((pre) => c.replace('git ', `git ${pre} `))),
    `git -C ${r}/docs checkout -- assumptions.md`, 'git -C docs restore assumptions.md', 'git mv notes.md docs/assumptions.md',
    `cd /nowhere && git -C ${r} checkout -- docs/assumptions.md`, `git status && git -C ${r} checkout -- state/log/000001.observation.json`,
    // a folder or pathspec that holds them: the usual discard-everything forms
    'git checkout -- .', 'git checkout .', 'git restore .', 'git restore ./', 'git checkout -- state', 'git restore state/log', 'git restore state/views/',
    'git checkout -- docs', `git -C ${r} checkout -- .`, `git checkout -- ${r}`, `git -C ${r}/kernel checkout -- ..`, 'git checkout -- "*.md"',
    'git restore -- state/*', 'git checkout -- cells/demo', 'git restore cells/demo/state/log', 'git checkout HEAD~1 -- .'];
  for (const c of refused) {
    const out = sh(c);
    assert.equal(out.status, 2, c);
    assert.match(out.stderr, /kernel-owned/, c);
  }
  for (const c of ['git status', `git -C ${r} status`, `git -C ${r} rm --cached state/views/summary.json`, 'git rm -r --cached state/views',
    'git restore --staged docs/assumptions.md', 'git restore -S state/log/000009.claim.json', `git -C ${r} log -- docs/assumptions.md`,
    `git -C ${r} -c x=y diff state/log`, 'git -C /nowhere checkout -- docs/assumptions.md', `git -C ${r} checkout -- docs/notes.md`,
    'git checkout -- state/bedrock/proposed/ontology.md', 'git checkout main && cat docs/assumptions.md', 'git -C', 'git -c', 'git --work-tree',
    'git checkout -- kernel', 'git restore docs/notes.md', 'git checkout -- cells/demo/exit', 'git restore "kernel/*.ts"', 'git checkout -b feature',
    'git checkout -', 'git rm -r --cached .', `git checkout -- /nowhere/state/log`])
    assert.equal(sh(c).status, 0, c);
  // in a cell, git's writes count against the boundary too
  const cell = `${r}/cells/c1`;
  mkdirSync(cell, { recursive: true });
  writeFileSync(`${cell}/binding.json`, '{}');
  assert.equal(shellIn(cell, 'git checkout -- exit/report.md'), 0);
  assert.equal(shellIn(cell, 'git checkout main'), 0);
  assert.equal(shellIn(cell, 'git checkout -- ../../kernel/src/log.ts'), 2);
  assert.equal(shellIn(cell, 'git -C ../.. restore kernel/src/log.ts'), 2);
});

test('Claude Code\'s own worktrees (.claude/worktrees/) are guarded like a checkout, and never merged into main (#48)', () => {
  // A subagent with isolation: "worktree" runs under root's hooks and project dir; before #48 its worktree's
  // kernel-owned files could be restored from the shell, and its branch merged into main past cell land.
  const r = mkdtempSync(join(tmpdir(), 'cellkit-native-')).replaceAll('\\', '/');
  const n = `${r}/.claude/worktrees/agent-1`;
  const sh = (command: string, cwd = r) => shellOut(command, { CLAUDE_PROJECT_DIR: r }, cwd);
  for (const [c, cwd] of [[`git checkout -- ${n}/docs/assumptions.md`, n], [`git checkout -- ${n}/docs/assumptions.md`, r], [`git -C ${n} checkout -- .`, r],
    [`git checkout -- ${n}`, n], [`echo x > ${n}/state/log/000009.claim.json`, r], ['echo x > .claude/worktrees/agent-1/state/views/s.json', r],
    [`rm ${n}/cells/demo/state/log/000001.observation.json`, r], [`git restore ${n}/state`, n]]) {
    const out = sh(c, cwd);
    assert.equal(out.status, 2, c);
    assert.match(out.stderr, /kernel-owned/, c);
  }
  for (const c of ['git merge worktree-agent-1', 'git merge --no-ff -m x worktree-agent-1', 'git pull . worktree-agent-1', 'git cherry-pick main..worktree-agent-1',
    'git rebase worktree-agent-1', 'git reset --hard worktree-agent-1~1', `git -C ${r} merge refs/heads/worktree-x`, 'git merge --squash origin/worktree-x']) {
    const out = sh(c);
    assert.equal(out.status, 2, c);
    assert.match(out.stderr, /cell land or root's own commits/, c);
  }
  for (const c of ['git merge main', 'git log worktree-agent-1', 'git diff main..worktree-agent-1', 'git branch -D worktree-agent-1', 'git worktree remove .claude/worktrees/agent-1',
    `cat ${n}/state/log/000001.observation.json`, 'git commit -m "not merging worktree-agent-1"', `echo x > ${n}/notes.md`, `git checkout -- ${n}/src/a.ts`])
    assert.equal(sh(c).status, 0, c);
  // Write/Edit already match kernel-owned paths at any depth: keep it so
  assert.equal(tryWrite(r, `${n}/state/log/000009.claim.json`), 2);
  assert.equal(tryWrite(r, `${n}/docs/assumptions.md`), 2);
  assert.equal(tryWrite(r, `${n}/state/bedrock/ontology.md`), 2);
  assert.equal(tryWrite(r, `${n}/README.md`), 0);
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

// #38: a guard that can't load (a syntax error, a broken import, no node) exits 1, which Claude Code doesn't treat as a
// block. The hook commands, root's (the template every project copies) and every cell's, turn that into a refusal.
test('guards: a hook that can\'t load refuses; one that loads allows and blocks as it says (#38)', async () => {
  const { cellNew, cellRefresh } = await import('../src/cell.ts');
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const bash = process.platform === 'win32'                                // Git Bash, as Claude Code runs hooks (not WSL's)
    ? join(spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim(), '..', '..', '..', 'usr', 'bin', 'bash.exe') : 'bash';
  const project = mkdtempSync(join(tmpdir(), 'cellkit-load-')).replaceAll('\\', '/');
  cellNew(project, { name: 'c1' });
  const commands = (settings: string) => (JSON.parse(readFileSync(settings, 'utf8')).hooks.PreToolUse as { hooks: { command: string }[] }[]).flatMap((m) => m.hooks.map((h) => h.command));
  const sets = [
    { dir: project, cmds: commands(join(repo, '.claude', 'settings.json')) },
    { dir: `${project}/cells/c1`, cmds: commands(`${project}/cells/c1/.claude/settings.json`) },
  ];
  for (const hook of ['hook-guard.ts', 'hook-bash.ts', 'hook-read.ts']) assert.equal(sets.every((s) => s.cmds.some((c) => c.includes(hook))), true, hook);
  mkdirSync(`${project}/kernel/src`, { recursive: true });
  const status = (dir: string, cmd: string, body: string) => {
    for (const h of ['hook-guard.ts', 'hook-bash.ts', 'hook-read.ts']) writeFileSync(`${project}/kernel/src/${h}`, body);
    return spawnSync(bash, ['-c', cmd], { input: '{}', env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8' }).status;
  };
  // an existing cell gets it from `cell refresh` (the upgrade note's step)
  const cellSettings = `${project}/cells/c1/.claude/settings.json`;
  writeFileSync(cellSettings, readFileSync(cellSettings, 'utf8').replaceAll(' || exit 2', ''));
  assert.equal(commands(cellSettings).some((c) => c.endsWith('|| exit 2')), false);
  cellRefresh(project, { name: 'c1' });
  assert.equal(commands(cellSettings).every((c) => c.endsWith('|| exit 2')), true);
  for (const { dir, cmds } of sets) for (const cmd of cmds) {
    assert.equal(status(dir, cmd, 'this is not ( javascript\n'), 2, `${cmd}: a syntax error`);
    assert.equal(status(dir, cmd, "import './missing.ts';\n"), 2, `${cmd}: a broken import`);
    assert.equal(status(dir, cmd, 'process.exit(0);\n'), 0, `${cmd}: allowed`);
    assert.equal(status(dir, cmd, 'process.exit(2);\n'), 2, `${cmd}: blocked`);
  }
});
