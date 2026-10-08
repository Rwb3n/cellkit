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
  assert.equal(tryShell('Get-Content state\\log\\000001.observation.json'), 0);      // reading is fine
  assert.equal(tryShell('node kernel/src/cli.ts fold'), 0);
  assert.equal(tryShell('node -e "const v=require(\'./state/views/x.json\'); v.n>=1"'), 0);      // a comparison is not a redirect
});
