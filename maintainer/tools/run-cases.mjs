// Feed each case to the repo's shell hook as Claude Code would, and print its verdict. Nothing is executed.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const [repo, file] = process.argv.slice(2);
for (const c of JSON.parse(readFileSync(file, 'utf8'))) {
  const r = spawnSync(process.execPath, [`${repo}/kernel/src/hook-bash.ts`], {
    input: JSON.stringify({ cwd: repo, tool_input: { command: c.command } }), encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
  });
  console.log(`${r.status === 0 ? 'allow ' : 'REFUSE'}  ${c.id}${r.status === 0 ? '' : `\n          ${r.stderr.trim().slice(0, 200)}`}`);
}
