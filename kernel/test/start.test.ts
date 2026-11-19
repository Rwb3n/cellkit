// Root's session-start report (start.ts): the kit's version against the newest release (#103), and the declared key
// names missing on this machine (#121). One line each, never a value, never a refusal; a cell is told nothing.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { bare as bareUrl, kitReport, kitUrl, KIT_URL, reportPath } from '../src/start.ts';
import { checkGuards } from '../src/config.ts';
import { lintOwnership } from '../src/lint.ts';
import { cellNew } from '../src/cell.ts';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, '..', 'src', 'start.ts');
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
const SECRET = 'planted-value-9f3e1c';                // must never be printed or written

// A project at kit `version`, and a kit repository tagged `tags`; the report's file is under the project's .git.
function world(t: TestContext, o: { version?: string | null; tags?: string[]; guards?: object } = {}) {
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'cellkit-start-')));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const proj = join(tmp, 'proj'), kit = join(tmp, 'kit');
  mkdirSync(join(proj, 'kernel'), { recursive: true });
  git(tmp, 'init', '-q', '-b', 'main', proj);
  const version = o.version === undefined ? '0.6.0' : o.version;
  writeFileSync(join(proj, 'kernel', 'package.json'), JSON.stringify(version === null ? { name: 'k' } : { name: 'k', version }));
  if (o.guards) { mkdirSync(join(proj, 'state', 'bedrock'), { recursive: true }); writeFileSync(join(proj, 'state', 'bedrock', 'guards.json'), JSON.stringify(o.guards)); }
  git(tmp, 'init', '-q', '-b', 'main', kit);
  git(kit, 'commit', '-q', '--allow-empty', '-m', 'kit');
  for (const tag of o.tags ?? ['v0.5.0', 'v0.6.0']) git(kit, 'tag', tag);
  return { proj, kit, tmp };
}
const { CELLKIT_UPSTREAM: _u, CLAUDE_PROJECT_DIR: _p, CELLKIT_CONFIG: _c, ...bare } = process.env;
const start = (proj: string, upstream: string, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script, '--root', proj], { encoding: 'utf8', env: { ...bare, CELLKIT_UPSTREAM: upstream, ...env } });
const report = (proj: string) => JSON.parse(readFileSync(reportPath(proj)!, 'utf8'));

test('start: a kit behind the newest release says which is out and where to read about it', (t) => {
  const { proj, kit } = world(t, { tags: ['v0.5.0', 'v0.6.0', 'v0.10.0', 'v0.7.0', 'v0.11.0-rc1'] });
  const r = start(proj, kit);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^kit v0\.6\.0; v0\.10\.0 is out: read its CHANGELOG \("Upgrading a project"\)/m);   // numeric, releases only
  assert.equal(report(proj).kit.latest, 'v0.10.0');
  assert.equal(report(proj).kit.state, 'behind');
});

test('start: a kit level with the newest release, or ahead of it, says so in one line', (t) => {
  const level = world(t);
  assert.match(start(level.proj, level.kit).stdout, /^kit v0\.6\.0 \(the latest\)\.$/m);
  const ahead = world(t, { tags: ['v0.5.0'] });
  assert.match(start(ahead.proj, ahead.kit).stdout, /^kit v0\.6\.0; the newest tag is v0\.5\.0 \(this kit is ahead of it/m);
});

test('start: a kit repository it can\'t reach is "latest unknown", with when it was last read, never "up to date"', (t) => {
  const { proj, kit, tmp } = world(t, { tags: ['v0.7.0'] });
  const gone = join(tmp, 'nowhere');
  const never = start(proj, gone);
  assert.equal(never.status, 0);
  assert.match(never.stdout, /^kit v0\.6\.0; latest unknown \(remote unreachable: .+; never read\)\.$/m);
  assert.doesNotMatch(never.stdout, /latest\)|is out/);
  // read once, then unreachable once the cache is stale: the last good answer is named with its date
  try {
    process.env.CELLKIT_UPSTREAM = kit;
    const ok = kitReport(proj, new Date('2026-11-01T10:00:00Z'));
    assert.equal(ok.state, 'behind');
    rmSync(kit, { recursive: true, force: true });                            // the same repository, gone
    const later = kitReport(proj, new Date('2026-11-02T10:00:00Z'), ok);
    assert.deepEqual([later.state, later.fetched], ['unknown', true]);
    assert.match(later.line, /^kit v0\.6\.0; latest unknown \(remote unreachable: .+; last read 2026-11-01 10:00, when it was v0\.7\.0\)\.$/);
    // a failure is asked again after an hour, not a day
    assert.equal(kitReport(proj, new Date('2026-11-02T10:30:00Z'), later).fetched, false);
    assert.equal(kitReport(proj, new Date('2026-11-02T11:30:00Z'), later).fetched, true);
  } finally { delete process.env.CELLKIT_UPSTREAM; }
});

test('start: a fresh cache answers without asking the remote; a stale one asks again', (t) => {
  const { proj, kit } = world(t, { tags: ['v0.7.0'] });
  process.env.CELLKIT_UPSTREAM = kit;
  try {
    const first = kitReport(proj, new Date('2026-11-01T10:00:00Z'));
    assert.equal(first.fetched, true);
    git(kit, 'tag', 'v0.8.0');
    const soon = kitReport(proj, new Date('2026-11-01T20:00:00Z'), first);
    assert.deepEqual([soon.fetched, soon.latest], [false, 'v0.7.0']);          // no network call: still the cached answer
    const day = kitReport(proj, new Date('2026-11-02T10:00:00Z'), first);
    assert.deepEqual([day.fetched, day.latest], [true, 'v0.8.0']);
  } finally { delete process.env.CELLKIT_UPSTREAM; }
});

test('start: a kernel with no version to compare says so, rather than passing as current', (t) => {
  const { proj, kit } = world(t, { version: null });
  assert.match(start(proj, kit).stdout, /^kit version unknown: kernel\/package\.json has no version/m);
});

test('start: the kit\'s repository is a remote named for cellkit, else the kit\'s own URL', (t) => {
  const { proj } = world(t);
  assert.equal(kitUrl(proj), KIT_URL);
  git(proj, 'remote', 'add', 'origin', 'https://example.invalid/me/cellkit-notes.git');   // named like it, not it
  assert.equal(kitUrl(proj), KIT_URL);
  git(proj, 'remote', 'add', 'kit', 'https://example.invalid/me/cellkit.git');
  assert.equal(kitUrl(proj), 'https://example.invalid/me/cellkit.git');
});

test('start: a cell\'s session is told nothing, and only root\'s settings run it', (t) => {
  const { proj, kit } = world(t);
  const cell = join(proj, 'cells', 'demo');
  mkdirSync(cell, { recursive: true });
  writeFileSync(join(cell, 'binding.json'), '{"name":"demo","scope":{}}');
  const r = start(proj, kit, { CLAUDE_PROJECT_DIR: cell });
  assert.deepEqual([r.status, r.stdout], [0, '']);
  const rootSettings = readFileSync(resolve(here, '..', '..', '.claude', 'settings.json'), 'utf8');
  assert.match(rootSettings, /kernel\/src\/start\.ts/);
  const born = join(proj, 'cells', 'born');
  cellNew(proj, { name: 'born' });
  assert.doesNotMatch(readFileSync(join(born, '.claude', 'settings.json'), 'utf8'), /start\.ts/);
});

test('start: declared key names missing on this machine are named; a value never appears', (t) => {
  const names = ['CKT_IN_FILE', 'CKT_IN_ENV', 'CKT_NOWHERE'];
  const { proj, kit } = world(t, { guards: { keys: { names } } });
  writeFileSync(join(proj, '.env'), `# keys\nexport CKT_IN_FILE=${SECRET}\nOTHER=${SECRET}\n`);
  const r = start(proj, kit, { CKT_IN_ENV: SECRET });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^keys: 1 of 3 declared missing, set in neither \.env nor the environment: CKT_NOWHERE\.$/m);
  const written = readFileSync(reportPath(proj)!, 'utf8');
  for (const s of [r.stdout, r.stderr, written]) assert.ok(!s.includes(SECRET), 'a value leaked');
  assert.deepEqual(report(proj).keys.found, { CKT_IN_FILE: 'env file', CKT_IN_ENV: 'environment' });
  assert.deepEqual(report(proj).keys.missing, ['CKT_NOWHERE']);
  writeFileSync(join(proj, '.env'), `CKT_IN_FILE=x\nCKT_NOWHERE=y\n`);
  assert.match(start(proj, kit, { CKT_IN_ENV: 'z' }).stdout, /^keys: all 3 declared present\.$/m);
  // nothing declared: no keys line
  const none = world(t);
  assert.doesNotMatch(start(none.proj, none.kit).stdout, /^keys:/m);
});

test('start: the names can come from a file the project already keeps (one list, not two)', (t) => {
  const { proj, kit } = world(t, { guards: { keys: { file: 'keys.json', at: 'vars' } } });
  writeFileSync(join(proj, 'keys.json'), JSON.stringify({ project: 'p', vars: { CKT_A: 'store-name-a', CKT_B: 'store-name-b' }, keys: { a: {} } }));
  writeFileSync(join(proj, '.env'), 'CKT_A=1\n');
  assert.match(start(proj, kit).stdout, /^keys: 1 of 2 declared missing, set in neither \.env nor the environment: CKT_B\.$/m);
  // a list where an object was meant (`at` pointing at the wrong thing) declares nothing: its items may be values
  writeFileSync(join(proj, 'keys.json'), JSON.stringify({ vars: [`sk_live_${SECRET.replaceAll('-', '_')}`] }));
  const listed = start(proj, kit);
  assert.match(listed.stdout, /^keys: the declaration can't be read \(keys\.json at vars is not an object/m);
  assert.ok(!listed.stdout.includes(SECRET.replaceAll('-', '_')) && !readFileSync(reportPath(proj)!, 'utf8').includes(SECRET.replaceAll('-', '_')));
  writeFileSync(join(proj, 'keys.json'), JSON.stringify({ vars: {} }));
  assert.ok(lintOwnership(proj).warnings.some((w) => /guards\.json keys: keys\.json at vars holds no names/.test(w)), 'lint warns: no names');
  // a file that isn't JSON is never quoted, here or by lint (a parse error quotes the text around the fault)
  writeFileSync(join(proj, 'keys.json'), `{"vars": {"CKT_A": ${SECRET}}}`);
  const broken = start(proj, kit);
  assert.match(broken.stdout, /^keys: the declaration can't be read \(keys\.json is not JSON\)/m);
  for (const s of [broken.stdout, broken.stderr, readFileSync(reportPath(proj)!, 'utf8'), lintOwnership(proj).warnings.join('\n')])
    assert.ok(!s.includes(SECRET.slice(0, 8)), 'a fragment of the file leaked');
  writeFileSync(join(proj, 'keys.json'), `﻿${JSON.stringify({ vars: { CKT_A: 'a' } })}`);   // PowerShell 5.1 writes a BOM
  assert.match(start(proj, kit).stdout, /^keys: all 1 declared present\.$/m);
  rmSync(join(proj, 'keys.json'));
  assert.match(start(proj, kit).stdout, /^keys: the declaration can't be read \(keys\.json is not there\)/m);
  assert.ok(lintOwnership(proj).warnings.some((w) => /guards\.json keys: keys\.json is not there/.test(w)), 'lint warns');
});

test('start: a name set to nothing in .env is missing, as an empty one in the environment is', (t) => {
  const { proj, kit } = world(t, { guards: { keys: { names: ['CKT_E1', 'CKT_E2', 'CKT_E3', 'CKT_E4', 'CKT_OK', 'CKT_BOM'] } } });
  writeFileSync(join(proj, '.env'), `﻿CKT_BOM=1\nCKT_E1=\nexport CKT_E2= ""\nCKT_E3='' # copied from .env.example\nCKT_E4=   \r\nCKT_OK=x\n`);
  assert.match(start(proj, kit, { CKT_E4: '' }).stdout, /^keys: 4 of 6 declared missing, set in neither \.env nor the environment: CKT_E1, CKT_E2, CKT_E3, CKT_E4\.$/m);
});

test('start: a cache edited by hand is no cache, and the report mends it', (t) => {
  const { proj, kit } = world(t, { tags: ['v0.7.0'] });
  for (const junk of ['null', '[]', '{"kit": null}', '{"kit": {"url": 1}}', `{"kit": {"url": ${JSON.stringify(kit)}, "latest": 7, "checked_at": "${new Date().toISOString()}", "ok": true}}`, 'not json']) {
    writeFileSync(reportPath(proj)!, junk);
    const r = start(proj, kit);
    assert.match(r.stdout, /^kit v0\.6\.0; v0\.7\.0 is out/m, junk);
    assert.equal(report(proj).kit.latest, 'v0.7.0', junk);
  }
});

test('start: a user or token in the kit\'s URL is never written down; bare version tags are not releases', (t) => {
  const { proj, kit } = world(t, { tags: ['v0.5.0', '0.9.0', 'V0.8.0', 'v0.6.0'] });
  assert.match(start(proj, kit).stdout, /^kit v0\.6\.0 \(the latest\)\.$/m);   // 0.9.0 and V0.8.0 aren't releases
  const r = start(proj, 'https://someone:tok3n-9f3e@127.0.0.1:9/me/cellkit.git');   // a refused port: no network
  assert.equal(r.status, 0);
  const written = readFileSync(reportPath(proj)!, 'utf8');
  assert.ok(!written.includes('tok3n') && !r.stdout.includes('tok3n'), written);
  assert.equal(report(proj).kit.url, 'https://127.0.0.1:9/me/cellkit.git');
  assert.equal(bareUrl('https://u:p@ss/x@host/me/cellkit.git'), 'https://host/me/cellkit.git');   // unescaped @ and / in it
});

test('start: guards.json keys is checked: one form, names that are variable names, a path in the repository', () => {
  assert.deepEqual(checkGuards({ keys: { names: ['A_1', 'B'] } }), []);
  assert.deepEqual(checkGuards({ keys: { file: 'keys.json', at: 'vars' } }), []);
  const bad = (v: unknown) => checkGuards({ keys: v }).join(' | ');
  assert.match(bad({ names: ['A'], file: 'k.json' }), /exactly one of "names" or "file"/);
  assert.match(bad({}), /exactly one of "names" or "file"/);
  assert.match(bad({ names: ['A-B'] }), /not a variable name/);
  assert.match(bad({ names: [] }), /at least one name/);
  assert.match(bad({ file: '../other/keys.json' }), /a path inside the repository/);
  assert.match(bad({ names: ['A'], at: 'vars' }), /keys\.at goes with "file"/);
  assert.match(bad({ file: 'k.json', extra: 1 }), /unknown key "extra"/);
  assert.match(bad(['A']), /keys must be an object/);
});
