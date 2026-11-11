// What got weaker in a branch's tests: fewer cases or assertions, skips or loosening added, test files deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { TEST_FILE, compareTests, weakerTests } from '../src/weaker.ts';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });

test('weaker: which files are tests', () => {
  for (const f of ['test/a.ts', 'cells/x/test/b.test.ts', 'src/a.spec.js', 'pkg/a_test.go', 'tests/test_a.py', 'game/__tests__/x.tsx']) assert.ok(TEST_FILE.test(f), f);
  for (const f of ['src/a.ts', 'docs/testing.md', 'contest/x.ts', 'cells/x/exit/posts/catching-weakened-tests.md', 'test/README.md', 'notes/unit-test.txt']) assert.ok(!TEST_FILE.test(f), f);
});

test('weaker: fewer cases or assertions, skips, loosening and deleted test files are found; stronger tests are not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cellkit-weaker-'));
  git(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'test'));
  const suite = (body: string) => writeFileSync(join(dir, 'test', 'a.test.ts'), body);
  suite(`test('one', () => {\n  assert.equal(f(1), 2);\n  assert.equal(f(2), 4);\n});\ntest('two', () => {\n  assert.ok(g());\n});\n`);
  writeFileSync(join(dir, 'test', 'b.test.ts'), `test('b', () => { assert.ok(1); });\n`);
  writeFileSync(join(dir, 'src.ts'), 'export const f = 1;\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'cell/x');
  // stronger: one more case and assertion, and source changes, are fine
  suite(`test('one', () => {\n  assert.equal(f(1), 2);\n  assert.equal(f(2), 4);\n});\ntest('two', () => {\n  assert.ok(g());\n});\ntest('three', () => {\n  assert.ok(h());\n});\n`);
  writeFileSync(join(dir, 'src.ts'), 'export const f = 2;\n');
  git(dir, 'commit', '-qam', 'stronger');
  assert.deepEqual(weakerTests(dir, 'main...HEAD'), []);
  // weaker: a case gone, an assertion gone, a skip and an `|| true` added, a test file deleted
  suite(`test('one', () => {\n  assert.ok(f(1) === 2 || true);\n});\ntest.skip('three', () => {\n  assert.ok(h());\n});\n`);
  rmSync(join(dir, 'test', 'b.test.ts'));
  git(dir, 'commit', '-qam', 'weaker');
  const found = weakerTests(dir, 'main...HEAD');
  assert.ok(found.some((f) => /a\.test\.ts: 1 fewer test case/.test(f)), found.join('\n'));
  assert.ok(found.some((f) => /a\.test\.ts: 1 skip\(s\) added/.test(f)), found.join('\n'));
  assert.ok(found.some((f) => /a\.test\.ts: \d fewer assertion line/.test(f)), found.join('\n'));
  assert.ok(found.some((f) => /a\.test\.ts: loosened/.test(f)), found.join('\n'));
  assert.ok(found.some((f) => /b\.test\.ts: deleted \(1 test case/.test(f)), found.join('\n'));
  rmSync(dir, { recursive: true, force: true });
});

test('weaker: a new test file can\'t be weaker; a tolerance added to an old one still is (#71)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cellkit-weaker-new-'));
  git(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'tests'));
  writeFileSync(join(dir, 'tests', 'test_old.py'), 'def test_a():\n    assert f(1) == 2\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'cell/x');
  // ecom-lab: float assertions in a brand-new file read as "loosened"
  writeFileSync(join(dir, 'tests', 'test_colleague.py'), 'import pytest\n\ndef test_days():\n    assert days(20.0) == pytest.approx(30 + 20)\n    assert m["premium"] == pytest.approx(49.80 / 15.99 - 1)\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'new tests');
  assert.deepEqual(weakerTests(dir, 'main...HEAD'), []);
  writeFileSync(join(dir, 'tests', 'test_old.py'), 'def test_a():\n    assert f(1) == pytest.approx(2, abs=1)\n');
  git(dir, 'commit', '-qam', 'loosen the old one');
  const found = weakerTests(dir, 'main...HEAD');
  assert.ok(found.some((f) => /test_old\.py: loosened/.test(f)), found.join('\n'));
  assert.ok(!found.some((f) => /test_colleague/.test(f)), found.join('\n'));
  rmSync(dir, { recursive: true, force: true });
});

// #94 (modelkit): a fixture folder replaced by a regenerated one stopped the land, one "deleted (0 test case(s), 0
// assertion(s))" per file.
test('weaker: test data replaced by as many data files is not weaker; a net loss of data still is (#94)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cellkit-weaker-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.autocrlf', 'false');
  const put = (path: string, text: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  const commit = (m: string) => { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', m); };
  const old = ['test/fixtures/v1/log.jsonl', 'test/fixtures/v1/mail.eml', 'test/fixtures/v1/rows.json'];
  const lines = (fs: string[]) => fs.map((f) => `${f}: deleted (0 test case(s), 0 assertion(s))`);
  for (const f of old) put(f, `{"n": 1}\n`);
  put('test/a.test.ts', `for (const f of fixtures) test(f, () => { assert.ok(read(f)); });\n`);
  put('test/old.test.ts', `test('old', () => { assert.ok(1); });\n`);
  commit('base');
  git(dir, 'checkout', '-qb', 'cell/x');

  rmSync(join(dir, 'test', 'fixtures', 'v1'), { recursive: true });         // the fixture regenerated: three out, three in
  for (const f of old) put(f.replace('v1', 'v2'), `{"n": 2}\n`);
  // a dry run compares the worktree with one commit: the new fixture is not tracked yet, and still counts
  assert.deepEqual(compareTests(dir, 'main'), { findings: [], replaced: old, added: 3 });
  commit('regenerated');
  assert.deepEqual(compareTests(dir, 'main...HEAD'), { findings: [], replaced: old, added: 3 });
  assert.deepEqual(weakerTests(dir, 'main...HEAD'), []);

  rmSync(join(dir, old[0].replace('v1', 'v2')));                            // one fewer than before: every deleted file is named
  commit('one short');
  assert.deepEqual(compareTests(dir, 'main...HEAD'), { findings: lines(old), replaced: [], added: 2 });
  put('test/new.test.ts', `test('new', () => { assert.ok(1); });\n`);       // a new test file is no data: still one short
  commit('a test, not data');
  assert.deepEqual(weakerTests(dir, 'main...HEAD'), lines(old));
  put('test/fixtures/v2/extra.json', `{"n": 3}\n`);                         // made up again
  rmSync(join(dir, 'test', 'old.test.ts'));                                 // a deleted test is a finding whatever the data did
  commit('level again, a test deleted');
  assert.deepEqual(compareTests(dir, 'main...HEAD'), { findings: ['test/old.test.ts: deleted (1 test case(s), 1 assertion(s))'], replaced: old, added: 3 });

  // data is what holds no case, skip, assertion or loosening: a fixture whose text says "should" is judged as a test
  git(dir, 'checkout', '-q', 'main'); put('test/fixtures/spec.json', `{"it": "should round"}\n`); commit('a wordy fixture');
  git(dir, 'checkout', '-qb', 'cell/y'); rmSync(join(dir, 'test', 'fixtures', 'spec.json')); put('test/fixtures/spec2.json', `{"n": 1}\n`); commit('replaced');
  assert.deepEqual(weakerTests(dir, 'main...HEAD'), ['test/fixtures/spec.json: deleted (0 test case(s), 1 assertion(s))']);

  // and data has a data file's name: the counts know few languages, so a deleted test, helper or snapshot that counts
  // nothing is still a deleted test, and a new one offsets no deleted data
  const code = ['src/test/java/FooTest.java', 'test/LoginTests.json', 'test/__snapshots__/a.snap.json', 'test/index.html', 'test/sums.test.json', 'test/sums.tests.json', 'test/sums_test.json',
    'tests/calc.rs', 'tests/conftest.py', 'tests/spec.json', 'tests/suite.yml', 'tests/test-cases.json', 'tests/test.json', 'tests/test_data.json'];
  git(dir, 'checkout', '-q', 'main');
  for (const f of code) put(f, `check(sum(1, 2), 3)\n`);
  put('tests/data/in.json', `{"n": 1}\n`);
  commit('tests the counts cannot read');
  git(dir, 'checkout', '-qb', 'cell/z');
  for (const f of code) rmSync(join(dir, f));
  for (let i = 0; i < 14; i++) put(`tests/data/new${i}.json`, `{"n": ${i}}\n`);
  commit('deleted beside new data');
  assert.deepEqual(weakerTests(dir, 'main...HEAD'), lines(code));
  git(dir, 'checkout', '-q', 'main'); git(dir, 'checkout', '-qb', 'cell/w');
  rmSync(join(dir, 'tests', 'data', 'in.json'));
  put('src/test/java/BarTest.java', `check(1)\n`); put('tests/more.rs', `check(1)\n`);
  commit('data deleted beside new tests');
  assert.deepEqual(compareTests(dir, 'main...HEAD'), { findings: lines(['tests/data/in.json']), replaced: [], added: 0 });

  // the worktree against one commit (a dry run) counts what the land's own diff will, once the files are committed
  const dry = () => compareTests(dir, 'main');
  const short = { findings: lines(['tests/data/in.json']), replaced: [], added: 0 };
  git(dir, 'checkout', '-q', 'main'); git(dir, 'checkout', '-qb', 'cell/v');
  rmSync(join(dir, 'tests', 'data', 'in.json'));
  put('tests/data/empty.json', '');                                         // an empty file: a diff shows none
  put('exit/report.json', `{"n": 1}\n`);                                    // not under a test path
  put('tests/helper.ts', `export const h = 1;\n`);                          // code
  put('tests/data/wordy.json', `{"it": "should"}\n`);                       // reads as a test
  assert.deepEqual(dry(), short);
  git(dir, 'rm', '-q', '--cached', 'tests/data/in.json'); put('tests/data/in.json', `{"n": 1}\n`);   // untracked, still there: not its own replacement
  assert.deepEqual(dry(), short);
  rmSync(join(dir, 'tests', 'data', 'in.json'));
  put('tests/data/bigwordy.json', `{"n": 1}\n`.repeat(150000) + `{"it": "should"}\n`);   // over 1 MB: read all the same, as the diff will
  assert.deepEqual(dry(), short);
  put('tests/data/latest.json', `{"n": 1}\n`.repeat(150000));               // "latest" is no test's name
  assert.deepEqual(dry(), { findings: [], replaced: ['tests/data/in.json'], added: 1 });
  commit('a big fixture');
  assert.deepEqual(compareTests(dir, 'main...HEAD'), { findings: [], replaced: ['tests/data/in.json'], added: 1 });
  rmSync(dir, { recursive: true, force: true });
});

test('weaker: accepting weaker tests is the operator\'s (hook)', () => {
  const hook = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hook-bash.ts');
  const run = (command: string) => spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_input: { command } }), env: { ...process.env, CLAUDE_PROJECT_DIR: '' }, encoding: 'utf8' }).status;
  assert.equal(run('node kernel/src/cli.ts cell land --name x --accept-weaker "fine"'), 2);
  assert.equal(run('node kernel/src/cli.ts cell land --name x --check "npm test"'), 0);
});
