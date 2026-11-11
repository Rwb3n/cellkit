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

// #82 (COCKPIT): two cells wrote source files through heredocs and sed; the shell ate backslashes, and a secret-mask
// regex came out with a gap no test covered.
test('shell guard: a cell\'s session types no source file through the shell (heredoc, echo, printf, sed -i, a literal Set-Content); a program\'s output is fine; root only if the project says so (#82)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cellkit-typed-')).replaceAll('\\', '/');
  const cell = `${root}/cells/c1`;
  mkdirSync(`${root}/state/bedrock`, { recursive: true });
  mkdirSync(cell, { recursive: true });
  writeFileSync(`${cell}/binding.json`, '{}');
  const typed = [
    `cat > src/mask.ts <<'EOF'\nexport const re = /\\w+@[\\w.]+/;\nEOF`, `cat <<EOF > src/mask.ts\nx\nEOF`, `cat <<EOF | tee src/mask.ts\nx\nEOF`, `tee src/mask.ts <<'EOF'\nx\nEOF`,
    `printf '%s\\n' 'const a = 1;' > src/a.ts`, `echo 'export const a = 1' >> src/a.ts`, `echo x >src/a.py && npm test`, `echo '{"n": 1}' > state/out/metrics.json`,
    `sed -i 's/\\\\w/\\\\d/' src/mask.ts`, `sed -i.bak -e 's/a/b/' src/a.ts`, `sed --in-place 's/a/b/' adapters/in.py`, `perl -pi -e 's/a/b/' src/a.ts`,
    `'const a = 1' | Set-Content src/a.ts`, `Set-Content -Path src/a.ts -Value 'const a = 1'`, `Add-Content src/a.ts -Value "x"`, `"x" | Out-File -FilePath src/a.ts`,
    `@'\nconst a = 1\n'@ | Set-Content src/a.ts`, `echo x | tee src/a.ts`, `bash -c "echo x > src/a.ts"`, `echo x > ${cell}/src/a.ts`, `"const a = 1" > src/a.ts`,
  ];
  for (const c of typed) assert.equal(shellIn(cell, c), 2, c);
  const said = spawnSync(process.execPath, [bashHook], { input: JSON.stringify({ cwd: cell, tool_input: { command: `cat > src/mask.ts <<'EOF'\nx\nEOF` } }), env: { ...process.env, CLAUDE_PROJECT_DIR: cell }, encoding: 'utf8' }).stderr;
  assert.match(said, /^Blocked: src\/mask\.ts is a source file, and that command types its content through the shell \(a heredoc redirected to it\).*Write tool.*Edit/);
  for (const c of [
    'node gen.js > src/generated.ts', 'git show HEAD:cells/c1/src/a.ts > src/a.ts', 'npx prettier src/a.ts > src/a.formatted.ts', 'cp src/a.ts src/b.ts', 'npm test > test/out.json 2>&1',
    'python tools/build.py | tee exit/table.json', 'cat src/a.ts src/b.ts > src/all.ts',                    // a program's output, a copy, a join of files
    `echo 'done' > exit/report.md`, `cat > exit/notes.txt <<'EOF'\nfree text\nEOF`, `echo x >> test/run.log`, `printf 'a,b\\n' > exit/rows.csv`,   // prose and data
    `echo x > ${tmpdir().replaceAll('\\', '/')}/scratch.ts`, 'echo x > /tmp/probe.py', 'echo x > /dev/null', 'echo x > $OUT',   // not in the repository; can't be judged
    `sed -n '1,5p' src/a.ts`, `sed 's/a/b/' src/a.ts`, `grep -n "echo x > a.ts" src/a.ts`, `git commit -m "never echo x > src/a.ts"`,
    `node ../../kernel/src/mail.ts send --to root --kind question --body "may I echo x > src/a.ts?"`,
  ]) assert.equal(shellIn(cell, c), 0, c);

  for (const c of [typed[0], typed[4], typed[8]]) assert.equal(shellIn(root, c.replaceAll('src/', 'kernel/src/')), 0, `${c} (root)`);   // root: not unless the project says so
  const guards = `${root}/state/bedrock/guards.json`, withGuards = (g: object, who: string, c: string) => { writeFileSync(guards, JSON.stringify(g)); return shellIn(who, c, { CELLKIT_CONFIG: guards }); };
  assert.equal(withGuards({ source: { root: true } }, root, `echo x > kernel/src/a.ts`), 2);
  assert.equal(withGuards({ source: { root: true } }, root, `node gen.js > kernel/src/a.ts`), 0);
  assert.equal(withGuards({ source: { files: ['cells/*/exit/**'] } }, cell, `echo x > src/a.ts`), 0);     // the project's list replaces the default
  assert.equal(withGuards({ source: { files: ['cells/*/exit/**'] } }, cell, `echo x > exit/report.md`), 2);
  assert.equal(withGuards({ source: { files: [] } }, cell, `echo x > src/a.ts`), 0);                      // an empty list switches it off
  assert.equal(withGuards({ source: { files: 'all' } }, cell, 'ls'), 2);                                    // a list of globs, or nothing runs
  assert.equal(withGuards({ source: { roots: true } }, cell, 'ls'), 2);
});

// #54: what #49 left open. A copy or move INTO a folder lands its sources under their own names; and a cell's worktree
// is outside the repository, where the kernel-owned anchors don't reach.
test('shell guard: a whole state, docs or cells folder copied or moved in is refused, and a cell\'s worktree removed from outside; files by name are fine (#54)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cellkit-copy-')).replaceAll('\\', '/');
  const cell = `${root}/cells/c1`;
  mkdirSync(cell, { recursive: true });
  writeFileSync(`${cell}/binding.json`, '{}');
  const at = (c: string, cwd = root) => shellIn(root, c, {}, cwd);
  for (const c of ['cp -r backup/state .', 'cp -r ../backup/state/ ./', 'mv old/docs .', 'cp -R /tmp/x/cells .', 'cp -r backup/log state/', 'cp -r backup/bedrock state', 'mv /tmp/views state/',
    'cp -r backup/* .', 'cp -r backup/st* .', 'Copy-Item -Recurse backup/state .', 'Move-Item old/docs .', 'cd .. && cp -r backup/state ' + root.replace(/^.*\//, ''),
    'cp -r backup/state cells/c1', 'cp -r a/log cells/c1/state', `bash -c "cp -r backup/state ."`, 'robocopy_placeholder_never && mv x/state .'])
    assert.equal(at(c), 2, c);
  assert.match(spawnSync(process.execPath, [bashHook], { input: JSON.stringify({ cwd: root, tool_input: { command: 'cp -r backup/state .' } }), env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: 'utf8' }).stderr,
    /^Blocked: that command brings backup\/state in as state, which is or holds kernel-owned paths/);
  for (const c of ['cp notes.md docs/', 'cp a.md b.md docs/', 'mv draft.md docs/plan.md', 'cp -r backup/state /tmp/elsewhere', 'cp -r src/state lib/', 'cp -r fixtures/docs cells/c1/test/fixtures',
    'cp -r assets docs/', 'cp kernel/package.json .', 'cp -r backup/*.md docs/', 'cp -r backup/state-old .', 'mv tmp/statement.txt .', 'git commit -m "cp -r backup/state . is refused"',
    'cp -r cells/c1/exit/reports docs/'])
    assert.equal(at(c), 0, c);

  // a cell's worktree: <repo>-cells/<cell> by default, or where guards.json worktrees.home says
  const home = `${root}-cells`;
  for (const c of [`rm -rf ../${home.replace(/^.*\//, '')}/c1`, `rm -rf ${home}/c1`, `rm -rf ${home}`, `Remove-Item -Recurse -Force ${home}/c1`, `rm -rf ${home}/*`, `cd .. && rm -rf ${home.replace(/^.*\//, '')}/c1`,
    `mv ${home}/c1 /tmp/gone`])
    assert.equal(at(c), 2, c);
  for (const c of [`rm -rf ${home}/c1/cells/c1/test/tmp`, `rm ${home}/c1/cells/c1/exit/old.md`, `rm -rf ${root}-old`, 'rm -rf /tmp/scratch', 'rm -rf node_modules'])
    assert.equal(at(c), 0, c);
  mkdirSync(`${root}/state/bedrock`, { recursive: true });
  writeFileSync(`${root}/state/bedrock/guards.json`, JSON.stringify({ worktrees: { home: '../.cells/proj' } }));
  const placed = resolve(root, '../.cells/proj').replaceAll('\\', '/');
  assert.equal(shellIn(root, `rm -rf ${placed}/c1`, { CELLKIT_CONFIG: `${root}/state/bedrock/guards.json` }), 2);
  assert.equal(shellIn(root, `rm -rf ${home}/c1`, { CELLKIT_CONFIG: `${root}/state/bedrock/guards.json` }), 0);   // no longer where its cells are
});

// #54: a branch moved by force loses the commits it held, as reset --hard does. #84 (from the reviews of #72 and #101):
// a cell's session changing what the landing compares against, or running root's mail as root.
test('shell guard: no session moves a branch by force; a cell\'s session moves no other branch, changes no git setting, and runs only its own mail.ts (#54, #84)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cellkit-git-')).replaceAll('\\', '/');
  const cell = `${root}/cells/c1`;
  mkdirSync(cell, { recursive: true });
  writeFileSync(`${cell}/binding.json`, '{}');
  const forced = ['git checkout -B main HEAD~3', 'git switch -C main abc123', 'git switch --force-create main abc123', 'git branch -f cell/c1 abc123', 'git branch --force main HEAD~1',
    'git -C ../.. branch -M old main', 'git checkout -qB main abc123', `bash -c "git branch -f main HEAD~2"`];
  for (const c of forced) for (const who of [root, cell]) assert.equal(shellIn(who, c), 2, `${c} (${who === root ? 'root' : 'cell'})`);
  for (const c of ['git checkout -b feature', 'git switch -c feature', 'git branch feature', 'git branch -d merged', 'git checkout main', 'git commit -m "never git branch -f main"',
    'git push origin main', 'git config user.name t', 'git tag -a v1.0.0 -m x', 'git gc', 'git fetch origin main:main', 'git worktree prune', `node kernel/src/mail.ts send --to c1 --body x`,
    `node kernel/src/mail.ts watch --root ${root} --as root`])
    assert.equal(shellIn(root, c), 0, `${c} (root)`);                        // root's own acts: unaffected

  const cellOnly = [
    'git push . HEAD:main', 'git push origin HEAD', 'git update-ref refs/heads/main HEAD', 'git branch main2 HEAD', 'git branch -D other', 'git fetch . HEAD:main',   // another branch moved
    'git config diff.external ./d.sh', 'git config --local filter.x.clean cat', 'git config set diff.x.textconv cat', 'git config --unset core.autocrlf', 'git config -e',
    'git replace abc123 def456', 'git update-index --assume-unchanged test/a.test.ts', 'git update-index --skip-worktree test/a.test.ts',                               // settings and marks
    'git gc --prune=now', 'git prune', 'git reflog expire --expire=now --all', 'git worktree add ../x', 'git remote set-url origin x', 'git tag -d v1', 'git tag mine',
    'git symbolic-ref HEAD refs/heads/main', 'cd ../.. && git -C . push . HEAD:main', `sh -c 'git update-ref refs/heads/main HEAD'`,
    // root's mail, run as root
    `node ${root}-main/kernel/src/mail.ts watch`, 'cd ../../../repo && node kernel/src/mail.ts watch --as root', 'node ../../kernel/src/mail.ts watch --root ../../../repo',
    'node ../../kernel/src/mail.ts status --root=D:/x', 'cd $MAIN && node kernel/src/mail.ts send --to c2 --body x', 'node ../../../other/kernel/src/mail.ts send --to c2 --body x',
  ];
  for (const c of cellOnly) assert.equal(shellIn(cell, c), 2, c);
  const said = spawnSync(process.execPath, [bashHook], { input: JSON.stringify({ cwd: cell, tool_input: { command: 'git push . HEAD:main' } }), env: { ...process.env, CLAUDE_PROJECT_DIR: cell }, encoding: 'utf8' }).stderr;
  assert.match(said, /^Blocked: a cell's session doesn't run git push this way: it changes what root's landing compares your work against/);
  for (const c of [
    'git status', 'git diff', 'git log --oneline -5', 'git show HEAD:cells/c1/x.ts', 'git branch', 'git branch -a -v', 'git branch --show-current', 'git tag -l', 'git tag --list "v*"',
    'git config --get core.autocrlf', 'git config user.name', 'git config --list', 'git config get core.autocrlf', 'git fetch origin', 'git remote -v', 'git worktree list', 'git reflog',
    'git ls-files --eol', 'git symbolic-ref HEAD', 'echo "git push . HEAD:main is refused" > exit/notes.md',
    'node ../../kernel/src/mail.ts send --to root --kind question --body "which sheet?"', 'node ../../kernel/src/mail.ts status',
    `node ${root}/kernel/src/mail.ts send --to root --kind blocked --body x`, 'cd exit && node ../../../kernel/src/mail.ts status', 'cat ../../kernel/src/mail.ts | head -5',
    'echo "never mail.ts --root, nor another checkout\'s mail.ts" > exit/notes.md',
  ]) assert.equal(shellIn(cell, c), 0, c);
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

test('shell guard: a kernel-owned path and a write are one act only in one command, or one piece of code (#81)', () => {
  // COCKPIT: staging the kernel's output and writing a message file in one call was refused as writing the kernel's file.
  for (const c of ['git add docs/assumptions.md && printf x > /tmp/msg.txt', 'git add state/log/000001.claim.json; echo x > out.txt',
    'cp a.md state/bedrock/proposed/ontology.md && echo x > out.txt', 'git add docs/assumptions.md; npm test > $null'])
    assert.equal(tryShell(c), 0, c);
  // a variable in a write: the whole command is the act
  for (const c of ['git add docs/assumptions.md; echo x > docs/assumptions.md', 'f=state/log/x.json; echo y > $f', "$p = 'state/log/x.json'; [IO.File]::WriteAllText($p, 'x')",
    "python - <<'EOF'\np = 'state/log/x.json'\nopen(p, 'w').write('x')\nEOF", 'cp a.md state/bedrock/proposed/ontology.md; cp b.md state/bedrock/ontology.md',
    // a pipeline is one act: the path one command prints is what the next writes (review of #81)
    'echo state/log/x.md | xargs rm', "sh -c 'echo state/log/x.md' | xargs rm", 'ls state/views/* | xargs -I{} cp /tmp/a {}',
    'Get-Item state/log/x.md | Remove-Item', "'state/log/x.md' | Remove-Item", '"docs/assumptions.md" | Clear-Content',
    'Get-Item docs/assumptions.md | Set-Content -Value x',
    'echo state/log/x.md |\nxargs rm', 'echo state/log/x.md | \\\nxargs rm', 'echo state/log/x.md |& xargs rm', 'Get-Item state/log/x.md |\n  Remove-Item'])   // a pipe over lines
    assert.equal(tryShell(c), 2, c);
});

test('shell guard: parens end a word, so a subshell\'s redirect to the null device is no write (#75)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cellkit-paren-')).replaceAll('\\', '/');
  const cell = `${root}/cells/c1`;
  mkdirSync(cell, { recursive: true });
  writeFileSync(`${cell}/binding.json`, '{}');
  assert.equal(shellIn(cell, '(ls x 2>/dev/null) && echo ok'), 0);   // COCKPIT: read as `/dev/null)`, outside the cell
  assert.equal(shellIn(cell, '(cd exit && ls 2>/dev/null)'), 0);
  assert.equal(shellIn(cell, '(echo x > ../../docs/x.md)'), 2);
  assert.equal(shellIn(cell, '(cd .. && echo x > y.txt)'), 2);        // the subshell's cd is followed
  assert.equal(shellIn(cell, "Set-Content -Path (Join-Path ../.. 'docs/x.md') -Value 1"), 2);   // an argument's parens are no subshell
  assert.equal(tryShell('Remove-Item -Recurse (Join-Path . state)'), 2);
  // a subshell's cd ends at its close (review of #75: `(cd /tmp) && rm -rf state/log` passed)
  for (const c of ['(cd /tmp) && rm -rf state/log', '(cd /tmp); rm -rf docs', '(cd /tmp) && git checkout -- docs/assumptions.md', '(ls && cd /tmp) && rm -rf state',
    '(case a in a) cd /tmp;; esac); rm -rf state/log'])                     // a case pattern's ) closes no subshell
    assert.equal(tryShell(c), 2, c);
  assert.equal(shellIn(cell, `(cd ${tmpdir().replaceAll('\\', '/')}) && echo x > ../../docs/x.md`), 2);
  assert.equal(shellIn(cell, `(cd ${tmpdir().replaceAll('\\', '/')} && echo x > scratch.txt)`), 0);   // inside it, it holds
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

test('shell guard: git clean, stash and reset --hard take away log entries and kernel-owned changes: refused where they would (#3)', () => {
  // Checked in a throwaway repo: reset --hard/--keep/--merge HEAD~1 deleted the entry committed since; clean -f and
  // stash -u/-a took the uncommitted one away, plain stash a staged one; reset --hard (HEAD) reverted a modified tracked
  // file (an approved bedrock doc before its commit). reset --mixed/--soft and clean -n kept everything.
  for (const c of ['git reset --hard HEAD~1', 'git reset --keep origin/main', 'git reset --merge abc123', 'git -C cells/demo reset --hard HEAD~2',
    'cd cells/demo && git reset --hard HEAD~1', 'git clean -fd', 'git clean -f', 'git clean -fdx', 'git clean -ffdx', 'git clean --force -d state',
    'git clean -fd cells/demo', 'cd cells/demo && git clean -fd', 'git stash -u', 'git stash push --include-untracked', 'git stash -a', 'git stash save -u wip',
    'git stash push -u -- state/log', 'git clean -fd -e build', 'git -c core.x=y clean -fd',
    'git reset --hard', 'git reset --hard HEAD', 'git stash', 'git stash push -m wip', 'git stash push -- docs'])
    assert.equal(tryShell(c), 2, c);
  for (const c of ['git reset --keep @', 'git reset --merge HEAD', 'git reset --mixed HEAD~1', 'git reset --soft HEAD~1', 'git reset HEAD~1',
    'git reset -- state/log/000001.observation.json', 'git clean -n', 'git clean -nd', 'git clean --dry-run -fd', 'git clean -fdX', 'git clean -fd build/',
    'cd build && git clean -fdx', 'git stash pop', 'git stash list', 'git stash -u -- build/', 'git stash push -- src/',
    'git -C /tmp/other reset --hard HEAD~1', 'cd /tmp/other && git reset --hard HEAD~1', 'git clean -fd /tmp/x'])
    assert.equal(tryShell(c), 0, c);
  assert.match(shellOut('git reset --hard HEAD~1').stderr, /moves this checkout back[\s\S]*git revert/);
  assert.match(shellOut('git reset --hard').stderr, /discards every uncommitted change[\s\S]*by name/);
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
  assert.equal(tryShell('powershell -NoProfile -Command "Stop-Process -Name node -Force"'), 2);   // in what a shell string runs, too
});

// #97 (COCKPIT): root stopped every node whose command line held "mail.ts watch", machine-wide, in one command. None of
// the by-name forms: it listed processes, filtered them, and stopped each by pid.
test('shell guard: one command that lists processes and stops some is a kill by name; listing, or stopping a pid, alone is fine (#97)', () => {
  const said = (c: string) => spawnSync(process.execPath, [bashHook], { input: JSON.stringify({ tool_input: { command: c } }), env: { ...process.env, CLAUDE_PROJECT_DIR: '' }, encoding: 'utf8' }).stderr;
  for (const c of [
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*mail.ts watch*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,   // the 7 Nov shape
    `(Get-WmiObject Win32_Process -Filter "name='node.exe'").Terminate()`,
    `Get-Process node | ForEach-Object { $_.Kill() }`,
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Invoke-CimMethod -MethodName Terminate`,
    `for /f %i in ('wmic process where "name='node.exe'" get processid') do taskkill /PID %i /F`,
    'tasklist | findstr node && taskkill /PID 4242 /F',
    `ps aux | grep cellrun | awk '{print $2}' | xargs kill -9`,
    'ps -ef | grep node\nkill 4242',                                         // two lines of one command are one command
    `powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId }"`,   // sent from bash
    `bash -c 'ps aux | grep watch; kill 4242'`,
  ]) assert.match(said(c), /^Blocked: (one command both lists processes and stops some|killing processes by name)/, c);
  assert.match(said('tasklist | findstr node && taskkill /PID 4242 /F'), /List first, read the pid and its command line, then stop that pid in a command of its own/);
  for (const c of [
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*mail.ts watch*' } | Select-Object ProcessId, CommandLine`,
    'ps aux | grep node', 'tasklist | findstr node', 'Stop-Process -Id 4242 -Force', 'kill -9 4242', 'taskkill /PID 4242 /T /F',
    'git commit -m "never Get-Process | Stop-Process; list with ps, then kill the pid"',
    'docker ps -q && docker kill web', 'tmux ls; tmux kill-session -t work',  // a tool's own subcommands
    'ps aux | grep -v killed', 'cat notes/ps.txt; kill 4242', 'npm run ps-report && npm run kill-switch-test', 'ls .claude/skills && echo done',
    `node -e "const c=require('child_process').spawn('node',['x.js']); setTimeout(()=>c.kill(),100)"`,   // its own child
  ]) assert.equal(tryShell(c), 0, c);
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
