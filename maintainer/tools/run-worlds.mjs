// Feed a case file to the shell hook of several throwaway projects (build-world.ts), as Claude Code would: nothing is
// executed. One column per world, oldest first; the last is the one under review.
//   node maintainer/tools/run-worlds.mjs <cases.json> <world>... [--all]
// A case: { id, session: "root" | "cell", command, expect?: "REFUSE" | "allow", cwd? }; <fixture> in a command is the
// world's path. Prints a case when the last world differs from `expect`, or allows what an earlier world refused (FELL:
// a regression until shown harmless), or exits with anything but 0 or 2; --all prints every one.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const argv = process.argv.slice(2), all = argv.includes('--all');
const [file, ...worlds] = argv.filter((a) => a !== '--all').map((a) => a.replaceAll('\\', '/'));
if (!file || !worlds.length) { console.error('usage: run-worlds.mjs <cases.json> <world>... [--all]'); process.exit(2); }
const verdict = (w, c) => new Promise((done) => {
  const root = `${w}/proj`, cell = `${w}/proj-cells/c1/cells/c1`;
  const dir = c.session === 'cell' ? cell : root, kit = c.session === 'cell' ? `${w}/proj-cells/c1` : root;
  const p = spawn(process.execPath, [`${kit}/kernel/src/hook-bash.ts`], { env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CELLKIT_CONFIG: '' } });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (status) => done({ v: status === 0 ? 'allow' : 'REFUSE', status, why: err.trim().replace(/\s+/g, ' ') }));
  p.stdin.end(JSON.stringify({ cwd: c.cwd ? `${dir}/${c.cwd}` : dir, tool_input: { command: c.command.replaceAll('<fixture>', w) } }));
});
const cases = JSON.parse(readFileSync(file, 'utf8')), results = new Array(cases.length);
let next = 0;
await Promise.all(Array.from({ length: 5 }, async () => {
  for (let k = next++; k < cases.length; k = next++) results[k] = await Promise.all(worlds.map((w) => verdict(w, cases[k])));
}));
let off = 0, fell = 0;
cases.forEach((c, k) => {
  const rs = results[k], now = rs.at(-1);
  const f = now.v === 'allow' && rs.slice(0, -1).some((r) => r.v === 'REFUSE'), differs = !!c.expect && now.v !== c.expect;
  const odd = rs.some((r) => r.status !== 0 && r.status !== 2);
  if (differs) off++;
  if (f) fell++;
  if (!(differs || f || odd || all)) return;
  console.log(`${differs ? '>>>' : '   '}${f ? ' FELL' : ''} ${c.id} [${c.session ?? 'root'}]${c.expect ? ` expect=${c.expect}` : ''} ${rs.map((r) => r.v).join(' / ')}${odd ? ` (exits ${rs.map((r) => r.status).join('/')})` : ''}`);
  console.log(`      ${JSON.stringify(c.command).slice(0, 260)}`);
  if (now.v === 'REFUSE') console.log(`      ${now.why.slice(0, 200)}`);
});
console.log(`${cases.length} cases, ${off} differ from expect, ${fell} allowed now that an earlier world refused`);
