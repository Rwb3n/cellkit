// A throwaway project built from one copy of the kernel, with a cell checked out, as the kit's tests build theirs.
// For judging case files under one state of the hooks (run-worlds.mjs): one world per state, e.g. main's kernel and a
// branch's (`git archive <ref> kernel | tar -x -C <dir>`, with node_modules copied in).
//   node maintainer/tools/build-world.ts <kernel folder> <world folder>      (the world folder outside any repository)
// Result: <world>/proj (the main checkout), <world>/proj-cells/c1 (cell c1's worktree), cells c1 and other, and a few
// folders the review cases name (src, docs, backup/state/log, dist, build). Kit-private: maintainer/ only.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const [kernel, world] = process.argv.slice(2).map((p) => resolve(p));
if (existsSync(world)) { console.error(`${world} exists`); process.exit(2); }
const main = join(world, 'proj');
mkdirSync(join(main, 'kernel'), { recursive: true });
const devOnly = /node_modules[\\/](typescript|@types|undici-types)([\\/]|$)/;
for (const d of ['src', 'schemas', 'package.json', 'node_modules']) cpSync(join(kernel, d), join(main, 'kernel', d), { recursive: true, filter: (f) => !devOnly.test(f) });
writeFileSync(join(main, '.gitignore'), 'node_modules/\n**/state/views/\n');
const git = (...a: string[]) => { const r = spawnSync('git', ['-C', main, ...a], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout; };
git('init', '-q', '-b', 'main');
git('config', 'core.autocrlf', 'false');
git('config', 'user.email', 't@t');
git('config', 'user.name', 't');
const { cellNew } = await import(pathToFileURL(join(main, 'kernel', 'src', 'cell.ts')).href);
const { cellCheckout } = await import(pathToFileURL(join(main, 'kernel', 'src', 'worktree.ts')).href);
for (const name of ['c1', 'other']) cellNew(main, { name });
for (const d of ['src', 'docs', 'backup/state/log', 'dist', 'build', 'cells/c1/test/fixtures']) mkdirSync(join(main, d), { recursive: true });
writeFileSync(join(main, 'src', 'a.ts'), 'export const a = 1;\n');
writeFileSync(join(main, 'docs', 'notes.md'), 'notes\n');
for (const d of ['dist', 'build', 'cells/c1/test/fixtures']) writeFileSync(join(main, d, 'index.js'), '// built\n');
writeFileSync(join(main, 'backup', 'state', 'log', 'old.json'), '{}\n');
mkdirSync(join(main, 'cells', 'c1', 'src'), { recursive: true });
writeFileSync(join(main, 'cells', 'c1', 'src', 'a.ts'), 'export const a = 1;\n');
writeFileSync(join(main, 'cells', 'c1', 'notes.md'), 'notes\n');
git('add', '-A');
git('commit', '-qm', 'init');
const wt = cellCheckout(main, { name: 'c1' });
console.log(JSON.stringify({ main, wt, cell: join(wt, 'cells', 'c1') }));
