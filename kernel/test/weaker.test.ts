// What got weaker in a branch's tests: fewer cases or assertions, skips or loosening added, test files deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { TEST_FILE, weakerTests } from '../src/weaker.ts';

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

test('weaker: accepting weaker tests is the operator\'s (hook)', () => {
  const hook = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hook-bash.ts');
  const run = (command: string) => spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_input: { command } }), env: { ...process.env, CLAUDE_PROJECT_DIR: '' }, encoding: 'utf8' }).status;
  assert.equal(run('node kernel/src/cli.ts cell land --name x --accept-weaker "fine"'), 2);
  assert.equal(run('node kernel/src/cli.ts cell land --name x --check "npm test"'), 0);
});
