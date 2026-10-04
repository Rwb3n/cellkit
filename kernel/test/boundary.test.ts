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
  assert.equal(tryWrite(root, `${root}/kernel/src/x.ts`), 0);          // root session: no cell boundary
});
