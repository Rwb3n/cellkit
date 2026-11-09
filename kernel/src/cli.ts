// cellkit kernel CLI.  node kernel/src/cli.ts <command> [--cell <dir>]   (the commands: USAGE below, or <command> --help)
// Mail between cells has its own CLI: node kernel/src/mail.ts send --to <name> · watch [--as root] · status
// Every write refolds (refold.ts): state/views/* and docs/assumptions.md (generated; hook-blocked).
// Run from a cell's worktree, every command that writes root's log writes the main checkout's (worktree.ts), so root's
// hash chain never forks; fold and lint of root stay local. A write, fold or lint of a cell's log (--cell <cell>) goes to
// that cell's worktree when it has one, wherever it is run from.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { append, AppendError, readLog } from './log.ts';
import { refold as refoldLog } from './refold.ts';
import { lint } from './lint.ts';
import { assume, constraint, evidence } from './generators.ts';
import { amend, approve, bedrockDir, foldBedrock, register, stage } from './bedrock.ts';
import { cellNew, cellRebind, cellRefresh, cellSync } from './cell.ts';
import { decide, foldReviews, raise } from './review.ts';
import { isCell, logHome, nameOf, rootOf, send as sendMail } from './mail.ts';
import { cellAudit, cellBranch, cellCheckout, inMain, samePath, WorktreeError } from './worktree.ts';
import { cellLand, commitRootLog } from './land.ts';
import type { Kind } from './schemas.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
try { process.loadEnvFile(join(repoRoot, '.env')); } catch { /* no .env */ }
const [cmd, ...rest] = process.argv.slice(2);
const opt = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const WRITES = ['init', 'append', 'assume', 'evidence', 'constraint', 'stage', 'amend', 'approve', 'register', 'cell', 'review'];
const local = resolve(opt('cell') ?? repoRoot);
let cell = WRITES.includes(cmd) && !isCell(local) ? inMain(local) : local;
// A cell with its own worktree keeps its log there (it travels on its branch): a write aimed at another copy of it (the
// main checkout's, e.g. `review decide --cell cells/<x>` from root) goes to the worktree's, as mail does, so its chain
// never forks. fold and lint follow it too: the main checkout's copy is a snapshot from the last land (#7: `fold --cell
// cells/<x>` from main folded the snapshot, and lint --all, reading the live log, still found its views stale).
if ([...WRITES, 'fold', 'lint'].includes(cmd) && isCell(local) && !samePath(logHome(rootOf(local), nameOf(local)), local)) {
  cell = logHome(rootOf(local), nameOf(local));
  console.error(`note: cells/${nameOf(local)} has its own worktree; its log is there (${cell})`);
}
const isRoot = cell === repoRoot || cell === inMain(repoRoot);

// Every command: its usage and the flags it needs ("--yes|--no": one of them). `<command> --help` prints it; a command
// missing flags is refused naming all of them, before it writes anything (#6: apify-actor-dev learnt the flags by
// grepping this file for opt(), one refusal at a time). Every command also takes --cell <dir>.
const USAGE: Record<string, { use: string; needs?: string[] }> = {
  'init': { use: 'init                                  first run: create state/, copy templates/ontology.md into bedrock, register it as a draft, fold' },
  'append': { use: 'append     --kind observation|claim --body <file.json|-> [--causes 000001,000002]', needs: ['--kind', '--body'] },
  'assume': { use: 'assume     --statement "…" [--id A1] [--voice claude|operator|probe] [--test "…"] [--evidence "…"] [--source "…"]   (no --id: the next free one)', needs: ['--statement'] },
  'evidence': { use: 'evidence   --id A1 --status guess|some|evidence|refuted --note "…" [--voice …] [--source "…"]', needs: ['--id', '--status', '--note'] },
  'constraint': { use: 'constraint --slug scope --text "…" [--voice …] [--source "…"]', needs: ['--slug', '--text'] },
  'stage': { use: 'stage      --doc ontology            copy the live doc to state/bedrock/proposed/ to edit (amend refuses it if the live doc moves)', needs: ['--doc'] },
  'amend': { use: 'amend      --doc ontology --layer shape|kinds|rules|binding|meta --reason "…" [--evidence A1,000140]   (the new text staged at state/bedrock/proposed/<doc>.md)', needs: ['--doc', '--layer', '--reason'] },
  'approve': { use: 'approve    --doc ontology [--proposal <entry>]   OPERATOR ONLY: from their own prompt with "!"; --proposal names one if several are pending', needs: ['--doc'] },
  'register': { use: 'register   --doc <doc> --layer meta  (a doc that predates the guard)', needs: ['--doc'] },
  'cell new': { use: 'cell new   --name <name> [--binding <file.json>]   → cells/<name>/ born by script', needs: ['--name'] },
  'cell refresh': { use: 'cell refresh --name <name>                          → regenerate its brief, hooks and mailboxes', needs: ['--name'] },
  'cell rebind': { use: 'cell rebind --name <name> [--binding <file.json>]   → change its binding (root only), logged on the cell\'s log', needs: ['--name'] },
  'cell sync': { use: 'cell sync [--name <name>]                           → root records each cell\'s head + published numbers; lint cross-checks' },
  'cell checkout': { use: 'cell checkout --name <name> [--path <dir>]          → its locked git worktree on branch cell/<name> (<repo>-cells/<name>, or guards.json worktrees.home/<name>)', needs: ['--name'] },
  'cell audit': { use: 'cell audit --name <name> [--except <glob>]…         → every changed path must lie inside cells/<name>/', needs: ['--name'] },
  'cell land': { use: 'cell land --name <name> [--message "…"] [--check "<cmd>"] [--into <branch>] [--dry-run]   → root\'s loop in one: commit, merge main in, audit, check, merge, sync', needs: ['--name'] },
  'review raise': { use: 'review raise --file r.json                          (or the JSON on stdin)' },
  'review list': { use: 'review list [--all] [--decided]' },
  'review decide': { use: 'review decide --id R-0001 --yes|--no [--note "…"]   OPERATOR ONLY', needs: ['--id', '--yes|--no'] },
  'fold': { use: 'fold                                  rebuild the views (and docs/assumptions.md at root) from the log' },
  'lint': { use: 'lint [--all]                          the log, bedrock, cells; --all: root and every cell' },
};
const usage = (keys: string[]) => keys.map((k) => `  ${USAGE[k].use}`).join('\n');
const group = (c: string) => Object.keys(USAGE).filter((k) => k === c || k.startsWith(`${c} `));

function refold(): number {
  console.log(JSON.stringify(refoldLog(cell, isRoot ? { docs: repoRoot } : {}).summary));
  return 0;
}

function write(run: () => string[]): number {
  try { console.log(`appended ${run().join(', ')}`); }
  catch (err) { if (err instanceof AppendError) { console.error(`refused: ${err.message}`); return 1; } throw err; }
  return refold();
}

function main(): number {
  const key = (cmd === 'cell' || cmd === 'review') && rest[0] && !rest[0].startsWith('-') ? `${cmd} ${rest[0]}` : cmd ?? '';
  const these = USAGE[key] ? [key] : group(key).length ? group(key) : Object.keys(USAGE);
  if (rest.includes('--help') || rest.includes('-h') || ['help', '--help', '-h'].includes(cmd ?? '')) {
    console.log(`node kernel/src/cli.ts <command> [--cell <dir>]\n${usage(these)}`);
    return 0;
  }
  if (!USAGE[key]) { console.error(`usage: node kernel/src/cli.ts <command> [--cell <dir>]\n${usage(these)}`); return 2; }
  const missing = (USAGE[key].needs ?? []).filter((f) => !f.split('|').some((x) => rest.includes(x)));
  if (missing.length) { console.error(`${key} needs ${missing.join(', ')}\n  usage: node kernel/src/cli.ts ${USAGE[key].use.replace(/\s{2,}/g, ' ')}`); return 2; }
  switch (cmd) {
    case 'init': {
      // first run: create state/, copy the starter ontology from templates/ (bedrock is only ever written by the kernel)
      for (const d of ['log', 'bedrock/proposed', 'out']) mkdirSync(join(cell, 'state', d), { recursive: true });
      for (const d of ['log', 'out']) if (!existsSync(join(cell, 'state', d, '.gitkeep'))) writeFileSync(join(cell, 'state', d, '.gitkeep'), '');
      const starter = join(repoRoot, 'templates', 'ontology.md');
      if (!existsSync(join(bedrockDir(cell), 'ontology.md')) && existsSync(starter)) writeFileSync(join(bedrockDir(cell), 'ontology.md'), readFileSync(starter, 'utf8'));
      const docs = existsSync(bedrockDir(cell)) ? readdirSync(bedrockDir(cell)).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)) : [];
      const known = foldBedrock(readLog(cell));
      return write(() => docs.filter((d) => !known[d]).flatMap((d) => register(cell, { doc: d, layer: 'meta', reason: 'init: first draft' })));
    }
    case 'append': {
      const kind = opt('kind') as Kind, src = opt('body');
      if (!kind || !src) { console.error('append needs --kind and --body'); return 2; }
      const body = JSON.parse(src === '-' ? readFileSync(0, 'utf8') : readFileSync(src, 'utf8'));
      return write(() => { const e = append(cell, { kind, body, causes: opt('causes')?.split(',').filter(Boolean) }); return [`${e.id}.${e.kind}`]; });
    }
    case 'assume':
    case 'evidence':
    case 'constraint': {
      const o = { id: opt('id'), voice: opt('voice'), statement: opt('statement'), test: opt('test'), evidence: opt('evidence'),
        source: opt('source'), status: opt('status'), note: opt('note'), slug: opt('slug'), text: opt('text') };
      return write(() => (cmd === 'assume' ? assume(cell, o) : cmd === 'evidence' ? evidence(cell, o) : constraint(cell, o)));
    }
    case 'stage':
      try { console.log(stage(cell, { doc: opt('doc') }).join('\n')); return 0; } catch (e) { if (e instanceof AppendError) { console.error(`refused: ${e.message}`); return 1; } throw e; }
    case 'amend':
    case 'approve':
    case 'register': {
      const o = { doc: opt('doc'), layer: opt('layer'), reason: opt('reason'), evidence: opt('evidence'), voice: opt('voice'), proposal: opt('proposal') };
      return write(() => (cmd === 'amend' ? amend(cell, o) : cmd === 'approve' ? approve(cell, o) : register(cell, o)));
    }
    case 'cell':
      if (rest[0] === 'sync') return write(() => cellSync(cell, { name: opt('name') }));
      if (rest[0] === 'checkout') {
        try {
          const dest = cellCheckout(cell, { name: opt('name'), path: opt('path') });
          console.log(`cell ${opt('name')}: worktree ${dest} on branch ${cellBranch(opt('name')!)}; run it headless (node kernel/src/cellrun.ts --cell ${opt('name')}) or open its session at ${join(dest, 'cells', opt('name')!)}`);
          return 0;
        } catch (e) { if (e instanceof WorktreeError) { console.error(`refused: ${e.message}`); return 1; } throw e; }
      }
      if (rest[0] === 'audit') {
        const except = rest.flatMap((a, i) => (a === '--except' && rest[i + 1] ? [rest[i + 1]] : []));
        let bad: string[];
        try { bad = cellAudit(cell, opt('name') ?? '', except); } catch (e) { if (e instanceof WorktreeError) { console.error(`refused: ${e.message}`); return 1; } throw e; }
        for (const p of bad) console.error(`OUTSIDE  ${p}`);
        console.log(`cell audit ${opt('name')}: ${bad.length} path(s) outside cells/${opt('name')}/${bad.length ? '' : ' (clean)'}`);
        return bad.length ? 1 : 0;
      }
      if (rest[0] === 'land') {
        const name = opt('name');
        let steps: ReturnType<typeof cellLand>;
        try { steps = cellLand(cell, { name, message: opt('message'), check: opt('check'), into: opt('into'), dryRun: rest.includes('--dry-run'), acceptWeaker: opt('accept-weaker') }); }
        catch (e) { if (e instanceof WorktreeError) { console.error(`refused: ${e.message}`); return 1; } throw e; }
        for (const s of steps) console.log(s);
        if (rest.includes('--dry-run')) return 0;
        // The work is on main now. Whatever the sync or root's log commit does (a commit hook that refuses), the reply's
        // decisions are still printed, last: a second land would say "nothing to land" and never show them (#74).
        try {
          const code = write(() => cellSync(cell, { name }));
          const logged = commitRootLog(cell, `Root log: cell ${name} landed (mail, sync)`);
          if (logged) console.log(`committed root's log: ${logged}`);
          return code;
        } finally { for (const s of steps.after ?? []) console.log(s); }
      }
      if (rest[0] === 'rebind') return write(() => cellRebind(cell, { name: opt('name'), binding: opt('binding') }));
      if (rest[0] === 'refresh') { try { console.log(cellRefresh(cell, { name: opt('name') }).join('\n')); return 0; } catch (e) { console.error(`refused: ${(e as Error).message}`); return 1; } }
      if (rest[0] !== 'new') { console.error(usage(group('cell'))); return 2; }
      return write(() => cellNew(cell, { name: opt('name'), binding: opt('binding') }));
    case 'review': {
      const name = (d: string) => (!isCell(d) ? 'root' : d.replaceAll('\\', '/').split('/').at(-1)!);
      if (rest[0] === 'raise') {
        const r = JSON.parse(readFileSync(opt('file') ?? 0, 'utf8'));
        let id = '';
        const code = write(() => { const x = raise(cell, { ...r, voice: r.voice ?? (isCell(cell) ? `voice:cell/${name(cell)}` : 'voice:root') }); id = x.id; return [x.id, ...x.entries]; });
        if (!code && isCell(cell)) sendMail(cell, 'root', `Review ${id} raised: ${r.question}\nOperator decides from their own prompt (review decide --cell cells/${name(cell)} --id ${id} --yes|--no).`, 'question');
        return code;
      }
      if (rest[0] === 'decide') return write(() => decide(cell, { id: opt('id'), yes: rest.includes('--yes') ? true : rest.includes('--no') ? false : undefined, note: opt('note') }));
      if (rest[0] === 'list') {
        const cellsDir = join(repoRoot, 'cells');
        const all = rest.includes('--all') ? [repoRoot, ...(existsSync(cellsDir) ? readdirSync(cellsDir).map((c) => join(cellsDir, c)).filter(isCell) : [])] : [cell];
        let n = 0;
        for (const c of all) for (const r of Object.values(foldReviews(readLog(c)))) {
          if (r.status !== 'open' && !rest.includes('--decided')) continue;
          n++;
          console.log(`${r.id} · ${name(c)} · ${r.status} · ${r.question}\n   proposes: ${String(r.proposes.kind)} ${JSON.stringify(r.proposes.about)} — ${JSON.stringify(r.proposes.says)}\n   evidence: ${JSON.stringify(r.evidence)}`);
        }
        if (!n) console.log('(no open reviews)');
        return 0;
      }
      console.error(usage(group('review')));
      return 2;
    }
    case 'fold':
      return refold();
    case 'lint': {
      // --all: root and every cell, each cell's log where it is written (its worktree when it has one)
      const cellsDir = join(cell, 'cells');
      const dirs = rest.includes('--all') && !isCell(cell)
        ? [cell, ...(existsSync(cellsDir) ? readdirSync(cellsDir).filter((n) => isCell(join(cellsDir, n))).map((n) => logHome(cell, n)) : [])]
        : [cell];
      let errors = 0;
      for (const d of dirs) {
        const r = lint(d);
        const tag = dirs.length > 1 ? `${nameOf(d)}: ` : '';
        for (const e of r.errors) console.error(`ERROR ${tag}${e}`);
        for (const w of r.warnings) console.error(`warn  ${tag}${w}`);
        console.log(`lint${dirs.length > 1 ? ` ${nameOf(d)}` : ''}: ${r.entries} entries, ${r.errors.length} errors, ${r.warnings.length} warnings`);
        errors += r.errors.length;
      }
      return errors ? 1 : 0;
    }
    default:
      console.error(usage(Object.keys(USAGE)));
      return 2;
  }
}

process.exitCode = main();
