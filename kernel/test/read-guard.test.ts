// The read guard (secrets.ts, hook-read.ts, hook-bash.ts): no session reads a secret, or a path the project's bedrock
// guards.json lists as unreadable; text that only names one is not a read. Ported from SF-DEV's tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { denied, treeHolds } from '../src/secrets.ts';
import { checkGuards } from '../src/config.ts';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const UNREADABLE = [
  { path: 'CASTLE/vault/', why: 'the vault' },
  { path: 'CASTLE/docs/research/venture/', why: 'third parties\' contact data' },
  { path: 'LIFE/records/*bank*', why: 'bank records' },
];

// a disk like D:\PROJECTS: this project with a .env, and two other workspaces with unreadable parts
function world() {
  const root = mkdtempSync(join(tmpdir(), 'cellkit-read-')).replaceAll('\\', '/');
  const files = ['APP/.env', 'APP/.env.example', 'APP/kernel/src/a.ts', 'CASTLE/vault/k.txt', 'CASTLE/.ssh/id_ed25519',
    'CASTLE/docs/decisions/ADR.md', 'CASTLE/docs/research/venture/seed.csv', 'CASTLE/README.md',
    'LIFE/records/2026-01-01-bank-statement.json', 'LIFE/records/2026-10-09-career.json'];
  for (const f of files) { mkdirSync(dirname(`${root}/${f}`), { recursive: true }); writeFileSync(`${root}/${f}`, 'x'); }
  const cfg = `${root}/guards.json`;
  writeFileSync(cfg, JSON.stringify({ unreadable: UNREADABLE }));
  return { root, cfg };
}
const run = (hook: string, input: object, cfg: string) =>
  spawnSync(process.execPath, [join(src, hook)], { input: JSON.stringify(input), env: { ...process.env, CLAUDE_PROJECT_DIR: '', CELLKIT_CONFIG: cfg }, encoding: 'utf8' }).status;

test('read guard: the kit\'s defaults and the project\'s unreadable paths, by folder name anywhere on the disk', () => {
  const { root: r } = world();
  for (const p of ['APP/.env', 'CASTLE/vault/k.txt', 'CASTLE/vault', 'CASTLE/.ssh/id_ed25519', 'CASTLE/docs/research/venture/seed.csv',
    'LIFE/records/2026-01-01-bank-statement.json', 'x/server.pem', 'x/.env.local'])
    assert.ok(denied(`${r}/${p}`, '', UNREADABLE), p);
  for (const p of ['APP/.env.example', 'APP/kernel/src/a.ts', 'CASTLE/README.md', 'CASTLE/docs/decisions/ADR.md', 'LIFE/records/2026-10-09-career.json'])
    assert.equal(denied(`${r}/${p}`, '', UNREADABLE), null, p);
  for (const p of ['vm/.alpaca-keys', 'vm/.bash_history', 'vm/.claude.json', 'home/.aws/credentials', 'home/.config/gh/hosts.yml', 'home/.git-credentials', 'home/.npmrc'])
    assert.ok(denied(`${r}/${p}`), p);                                          // a home folder's credentials, with no project list
  for (const p of ['vm/workspace/notes.md', 'APP/.claude/settings.json', 'APP/docs/keys.md', 'APP/kernel/src/secrets.ts', 'APP/certs/ca.crt'])
    assert.equal(denied(`${r}/${p}`), null, p);                                // ordinary files, even with "keys" in the name; a certificate is public
  assert.ok(denied('.env', `${r}/APP`));                                        // relative to the cwd
  assert.ok(denied('vault/k.txt', `${r}/CASTLE`, UNREADABLE));
  assert.equal(denied('vault/k.txt', `${r}/APP`, UNREADABLE), null);            // another project's vault/ is not CASTLE's
  assert.ok(denied(`${r}/castle/VAULT/k.txt`, '', UNREADABLE));                 // Windows paths are case-insensitive
  assert.ok(treeHolds(`${r}/APP`));                                             // .env in it
  assert.ok(treeHolds(r, '', UNREADABLE));                                      // workspaces with unreadable parts in it
  assert.ok(treeHolds(`${r}/CASTLE/docs`, '', UNREADABLE));                     // part-way down an entry
  assert.ok(treeHolds(`${r}/LIFE/records`, '', UNREADABLE));                    // the folder a glob entry matches in
  assert.equal(treeHolds(`${r}/CASTLE/docs/decisions`, '', UNREADABLE), null);
  assert.equal(treeHolds(`${r}/APP/kernel`, '', UNREADABLE), null);
});

test('read guard: <name>.env is a .env file, <name>.env.example is not (#5)', () => {
  // callsheet's instrument kept its key in vein.env; the defaults matched only .env and .env.*
  const { root: r, cfg } = world();
  for (const p of ['TOOLS/vein.env', 'TOOLS/vein.env.local', 'TOOLS/PROD.ENV'])
    assert.ok(denied(`${r}/${p}`), p);
  for (const p of ['TOOLS/vein.env.example', 'TOOLS/environment.md', 'TOOLS/envoy.ts', 'TOOLS/env', 'TOOLS/.envrc.md', 'TOOLS/dotenv.ts'])
    assert.equal(denied(`${r}/${p}`), null, p);
  mkdirSync(`${r}/TOOLS`, { recursive: true });
  writeFileSync(`${r}/TOOLS/vein.env`, 'KEY=x');
  assert.ok(treeHolds(`${r}/TOOLS`));                                           // a search over the folder must be narrowed
  const sh = (command: string) => run('hook-bash.ts', { cwd: `${r}/TOOLS`, tool_input: { command } }, cfg);
  assert.equal(sh('cat vein.env'), 2);
  assert.equal(sh('grep -r KEY .'), 2);
  assert.equal(sh('node -e "console.log(process.env.HOME)"'), 0);              // process.env is code, not a file
  assert.equal(sh('grep -rn "process.env" src/'), 0);
});

test('read guard: guards.json "unreadable" is checked like the rest of the guards', () => {
  assert.deepEqual(checkGuards({ unreadable: UNREADABLE }), []);
  assert.match(checkGuards({ unreadable: [{ why: 'x' }] }).join(), /needs "path"/);
  assert.match(checkGuards({ unreadable: [{ path: 'D:/PROJECTS/x/' }] }).join(), /never by drive/);
  assert.match(checkGuards({ unreadable: [{ path: '**/*' }] }).join(), /too wide/);
  assert.match(checkGuards({ unreadable: 'vault' }).join(), /must be a list/);
});

test('read guard: the Read and Grep tools', () => {
  const { root: r, cfg } = world();
  const read = (file_path: string, cwd = `${r}/APP`) => run('hook-read.ts', { tool_name: 'Read', cwd, tool_input: { file_path } }, cfg);
  const grep = (i: object, cwd = `${r}/APP`) => run('hook-read.ts', { tool_name: 'Grep', cwd, tool_input: { pattern: 'x', ...i } }, cfg);
  assert.equal(read(`${r}/APP/.env`), 2);
  assert.equal(read(`${r}/APP/.env.example`), 0);
  assert.equal(read(`${r}/CASTLE/vault/k.txt`), 2);
  assert.equal(read(`${r}/CASTLE/docs/decisions/ADR.md`), 0);
  assert.equal(read(`${r}/LIFE/records/2026-01-01-bank-statement.json`), 2);
  assert.equal(read(`${r}/LIFE/records/2026-10-09-career.json`), 0);
  assert.equal(grep({ path: `${r}/CASTLE/vault` }), 2);                          // a denied path, any mode
  assert.equal(grep({ output_mode: 'content' }), 2);                             // content of a tree holding .env
  assert.equal(grep({ output_mode: 'content', glob: '*.ts' }), 0);               // narrowed
  assert.equal(grep({ output_mode: 'content', type: 'ts' }), 0);
  assert.equal(grep({ output_mode: 'content', glob: '.env*' }), 2);              // "narrowed" to the secret
  assert.equal(grep({ output_mode: 'content', glob: '**/*' }), 2);
  assert.equal(grep({}), 0);                                                     // file names leak nothing
  assert.equal(grep({ output_mode: 'count' }), 0);
  assert.equal(grep({ output_mode: 'content', path: `${r}/APP/kernel` }), 0);    // a subfolder without secrets
  assert.equal(grep({ output_mode: 'content', path: `${r}/CASTLE/docs` }), 2);
  assert.equal(run('hook-read.ts', { tool_name: 'Read', tool_input: { file_path: 'x' } }, `${r}`), 2);   // fails closed (a folder as guards.json)
  assert.equal(spawnSync(process.execPath, [join(src, 'hook-read.ts')], { input: '{ nope', encoding: 'utf8' }).status, 2);
});

test('read guard: the shell reads by act, not by text', () => {
  const { root: r, cfg } = world();
  const sh = (command: string, cwd = `${r}/APP`) => run('hook-bash.ts', { cwd, tool_input: { command } }, cfg);
  for (const c of ['cat .env', 'cat ".env"', 'type .env', 'Get-Content .env', 'gc ".env"', 'head -3 .env', 'cp .env /tmp/x', 'grep KEY .env',
    `cat ${r}/CASTLE/vault/k.txt`, `Get-Content "${r}/CASTLE/.ssh/id_ed25519"`, 'node -e "console.log(require(\'fs\').readFileSync(\'.env\',\'utf8\'))"',
    'python - <<\'EOF\'\nprint(open(\'.env\').read())\nEOF', 'git status && cat .env', 'grep -rn KEY .', 'rg KEY', `grep -r x ${r}/CASTLE/docs`])
    assert.equal(sh(c), 2, c);
  for (const c of ['cat .env.example', 'git status', 'ls -la', 'git add .env.example', 'git commit -m "never cat .env; keys stay in vault/"',
    'node kernel/src/mail.ts send --to sources --body "never read CASTLE/vault or .ssh"', 'grep -rn x kernel/src', 'rg x kernel',
    'grep -rn x --include=*.ts .', 'rg -t ts KEY', `cat ${r}/CASTLE/docs/decisions/ADR.md`, 'node kernel/src/cli.ts lint', 'echo .env'])
    assert.equal(sh(c), 0, c);
  assert.equal(sh('cat vault/k.txt', `${r}/CASTLE`), 2);                       // relative, from inside the workspace
});

test('read guard: a pattern, a message or a heredoc written to a file is text, not a read (#2)', () => {
  // root 2026-10-22 (a grep whose pattern named the secrets file), apify-actor-dev 1a–c (a script written by heredoc,
  // a sed replacement), SF-DEV S5. What runs is still judged: interpreters reading code from stdin, -c strings, $(…).
  const { root: r, cfg } = world();
  const sh = (command: string, cwd = `${r}/APP`) => run('hook-bash.ts', { cwd, tool_input: { command } }, cfg);
  for (const c of ['grep -nE "\\.env|secrets" kernel/src/a.ts', "grep -n '.env' kernel/src/a.ts", 'rg "\\.env" kernel', 'rg -e .env -t ts kernel',
    "sed -i 's/CONFIG/.env/' kernel/src/a.ts", 'sed -n "/.ssh/p" kernel/src/a.ts', "awk '/vault\\/k.txt/' kernel/src/a.ts", 'Select-String -Pattern ".env" -Path kernel/src/a.ts',
    'git commit -m "readFileSync(.env) is gone"', 'git commit -m "a; cat .env"', "git commit -m 'never `cat .env` or $(cat .env)'",
    "cat > tools/set-env.py <<'EOF'\nimport os\nprint(open(os.path.join(root, '.env')).read())\nEOF",
    "cat > notes.md <<EOF\ncat .env\nEOF", "node kernel/src/mail.ts send --to x --file - <<'EOF'\nnever cat .env\nEOF",
    "python - > out.md <<'EOF'\nprint(open('kernel/src/a.ts').read())\nEOF", 'grep -rn x kernel/src/a.ts', 'Select-String -Pattern x -Path kernel/src/a.ts'])
    assert.equal(sh(c), 0, c);                                                 // a search given files reads those files only
  assert.equal(sh('grep -rn x kernel/src/a.ts .'), 2);
  for (const c of ['cat ".env"', 'grep KEY .env', 'grep -e KEY .env', 'rg -e KEY -- .env', 'sed -n 1p .env', 'awk 1 .env', 'Select-String -Pattern KEY -Path .env',
    'node -e "console.log(require(\'fs\').readFileSync(\'.env\',\'utf8\'))"', 'python -c "print(open(\'.env\').read())"',
    "python - <<'EOF'\nprint(open('.env').read())\nEOF", "python3 -u - <<'EOF'\nprint(open('.env').read())\nEOF",
    "node --input-type=module - <<'EOF'\nimport fs from 'node:fs'; fs.readFileSync('.env')\nEOF", "bash <<'EOF'\ncat .env\nEOF", 'bash -c "cat .env"', "pwsh -Command 'Get-Content .env'",
    'echo "$(cat .env)"', 'x=$(cat .env)', 'echo `cat .env`', 'git commit -m "never `cat .env`"', '$k = Get-Content .env', 'git commit -m "x" && cat .env',
    'grep -f .env kernel/src/a.ts', 'cmd /c "type .env"'])
    assert.equal(sh(c), 2, c);
});

test('read guard: prose in a script\'s strings is text; Select-String reads its pipeline, files only from a listing (#60)', () => {
  // ecom-lab: a script editing a doc with "this project's `.env`" in a string, and `schtasks … | Select-String`, were refused
  const { root: r, cfg } = world();
  const sh = (command: string, cwd = `${r}/APP`) => run('hook-bash.ts', { cwd, tool_input: { command } }, cfg);
  for (const c of ["python - <<'EOF'\ns = open('docs/HANDOVER.md').read().replace('x', \"keys live in this project's `.env`\")\nopen('docs/HANDOVER.md', 'w').write(s)\nEOF",
    'schtasks /Query /FO LIST | Select-String "TaskName|Status"', 'git log | Select-String KEY', 'Get-ChildItem -Recurse -Filter *.ts | Select-String KEY',
    `Get-ChildItem -Recurse ${r}/CASTLE/docs/decisions | Select-String KEY`])
    assert.equal(sh(c), 0, c);
  for (const c of ['Get-ChildItem -Recurse | Select-String KEY', 'gci | Select-String KEY', 'ls -r . | Select-String KEY',
    "python - <<'EOF'\nimport os\nprint(open(f\"{os.getcwd()}/.env\").read())\nEOF", "python - <<'EOF'\np = '.env'\nprint(open(p).read())\nEOF",
    "node - <<'EOF'\nconst p = `${process.cwd()}/.env`; require('fs').readFileSync(p)\nEOF",
    // review of #60: a listing that selects the secret, a pass-through between, a file operand, a stray quote
    'gci -r -Filter .env -Force | Select-String KEY', 'Get-ChildItem -Recurse -Include *.env | Select-String KEY', 'gci -r | Get-Content | Select-String KEY',
    'gci -r | Where-Object { $_.Length -gt 0 } | Select-String KEY', 'Get-Item .env | Select-String KEY', 'gci -r -Exclude *.ts | Select-String KEY',
    'gci -r | sls KEY', "node -e \"const q=/'/; console.log(require('fs').readFileSync('.env','utf8'))\"",
    '(cat .env)', '(cd /tmp) && cat .env',                                   // a subshell's cd ends at its close
    // second review: a wrapped listing, a glob, a pattern that isn't `*.<ext>`, an abbreviated parameter, a pipe over lines
    '@(gci -r) | Select-String KEY', '(gci -r) | Select-String KEY', '& { gci -r } | Select-String KEY', 'gci -r * | Select-String KEY',
    'gci -r -Filter *env* | Select-String KEY', 'gci -r -Include *.* | Select-String KEY', 'gci -r -Fil * | Select-String KEY', 'gci -r |\n Select-String KEY',
    'cd src\\\nGet-Content ..\\.env', 'dir src\\\ncat .env'])                    // a path's trailing \ continues no line (third review)
    assert.equal(sh(c), 2, c);
  assert.equal(sh(`(cd ${r}/CASTLE/docs/decisions && grep -rn x .)`), 0);    // inside it, it holds
  for (const c of ['gci -r -Include *.ts,*.md | Select-String KEY', 'gci -r -Fil *.ts | Select-String KEY', 'Get-Process | Select-String node', 'git log |\n  Select-String fix',
    'npm ls | Select-String react', 'gci -r -Filter *.test.ts | Select-String describe', 'gci -r -Filter package.json | Select-String version'])
    assert.equal(sh(c), 0, c);
});

test('read guard: the shell follows cd, and Git Bash drive paths are drive paths (#1)', () => {
  // apify-actor-dev and callsheet: `cd <another repo> && grep -r …` was judged against this project's .env, and
  // /d/PROJECTS/x was read as relative to the project.
  const { root: r, cfg } = world();
  const sh = (command: string, cwd = `${r}/APP`) => run('hook-bash.ts', { cwd, tool_input: { command } }, cfg);
  const clean = `${r}/CASTLE/docs/decisions`;                                   // no secret in or below it
  for (const c of [`cd ${clean} && grep -rn x .`, `cd "${clean}"; grep -r x .`, 'cd ../CASTLE/docs/decisions && rg x', `pushd ${clean} && grep -rn x . && popd`,
    `cd /d ${clean} && grep -r x .`, `Set-Location ${clean}; Select-String -Path * -Pattern x`, `cd ${clean} && cat ADR.md`])
    assert.equal(sh(c), 0, c);
  for (const c of [`cd ${clean} && cd ../.. && grep -r x .`, 'cd kernel && grep -rn x ..', `cd ${clean} && cat ../../vault/k.txt`,
    `cd ${clean} && cd ${r}/CASTLE && cat vault/k.txt`, 'cd $CELLKIT_UNSET_X && grep -rn x .', 'cd %CELLKIT_UNSET_X% && grep -r x .', 'cd ~ && rg x', 'git status && rg x',
    `cd ${clean} && cd $CELLKIT_UNSET_X && grep -r x .`, 'cd kernel && cat ../.env', `pushd ${clean} && popd && grep -rn x .`])
    assert.equal(sh(c), 2, c);                                                 // a cd it can't judge ($x, %x%, ~): judged from the session's folder, as before
  if (process.platform === 'win32') {
    const msys = r.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
    assert.equal(sh(`cat ${msys}/APP/.env`), 2);
    assert.equal(sh(`cat ${msys}/CASTLE/vault/k.txt`), 2);
    assert.equal(sh(`grep -rn x ${msys}/CASTLE/docs/decisions`), 0);
    assert.equal(sh(`grep -rn x ${msys}/CASTLE`), 2);
    assert.equal(sh(`cd ${msys}/CASTLE/docs/decisions && grep -rn x .`), 0);
    assert.equal(sh(`cd ${msys}/APP && grep -rn x .`), 2);
  }
});
