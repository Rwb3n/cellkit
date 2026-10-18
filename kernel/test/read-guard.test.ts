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
