// Take-outs on a copy of the kernel (never the live one): each case removes one part of a fix and names the test that
// should then fail. Files are read and written as bytes-preserving strings (latin1) so line endings never change.
//   node takeout.mjs <repo> <work dir> <cases.json>
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const [repo, work, casesFile] = process.argv.slice(2);
const k = join(work, 'kernel');
rmSync(k, { recursive: true, force: true });
mkdirSync(k, { recursive: true });
for (const d of ['src', 'test', 'schemas', 'package.json', 'tsconfig.json']) if (existsSync(join(repo, 'kernel', d))) cpSync(join(repo, 'kernel', d), join(k, d), { recursive: true });
if (process.platform === 'win32') spawnSync('cmd', ['/c', 'mklink', '/J', join(k, 'node_modules'), join(repo, 'kernel', 'node_modules')]);
else spawnSync('ln', ['-s', join(repo, 'kernel', 'node_modules'), join(k, 'node_modules')]);
const cases = JSON.parse(readFileSync(casesFile, 'utf8'));
let bad = 0;
for (const c of cases) {
  const file = join(k, 'src', c.file), was = readFileSync(file, 'latin1');
  const from = Buffer.from(c.from, 'utf8').toString('latin1'), to = Buffer.from(c.to, 'utf8').toString('latin1');
  if (was.split(from).length !== 2) { console.log(`?? ${c.id}: the text to take out occurs ${was.split(from).length - 1} times in ${c.file}`); bad++; continue; }
  const run = (pattern) => spawnSync(process.execPath, ['--test', '--test-name-pattern', pattern, ...c.tests.map((t) => join(k, 'test', t))], { cwd: k, encoding: 'utf8' });
  writeFileSync(file, was.replace(from, () => to), 'latin1');
  const out = run(c.pattern);
  writeFileSync(file, was, 'latin1');
  const failed = out.status !== 0, ran = /ℹ tests [1-9]/.test(out.stdout) || /# tests [1-9]/.test(out.stdout);
  const firstFail = (out.stdout.match(/✖ .*/) ?? [''])[0].slice(0, 130);
  if (failed && ran) console.log(`ok  ${c.id}: fails with the part out (${firstFail})`);
  else { console.log(`BAD ${c.id}: ${ran ? 'the test still passes with the part out' : 'no test ran'}`); bad++; }
}
console.log(bad ? `${bad} case(s) need a look` : `all ${cases.length} take-outs fail their test`);
process.exit(bad ? 1 : 0);
