// land's dirty() keeps a path whole when the first status line is an unstaged change (" M <path>"). From SF-DEV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { dirty } from '../src/land.ts';

test('land dirty(): an unstaged change on the first status line keeps its full path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cellkit-dirty-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a]);
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', 'assumptions.md'), 'a\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  writeFileSync(join(dir, 'docs', 'assumptions.md'), 'b\n');
  assert.deepEqual(dirty(dir), ['docs/assumptions.md']);
  writeFileSync(join(dir, 'new.md'), 'x');
  assert.deepEqual(dirty(dir).sort(), ['docs/assumptions.md', 'new.md']);
});
