// cellkit kernel CLI.  node kernel/src/cli.ts <command> [--cell <dir>]
//   init                                  first run: create state/, copy templates/ontology.md into bedrock, register it as a draft, fold
//   append     --kind observation|claim --body <file.json|-> [--causes 000001,000002]
//   assume     --id A1 --voice claude|operator|probe --statement "…" [--test "…"] [--evidence "…"] [--source "…"]
//   evidence   --id A1 --status guess|some|evidence|refuted --note "…" [--voice …] [--source "…"]
//   constraint --slug scope --text "…" [--voice …] [--source "…"]
//   amend      --doc ontology --layer shape|kinds|rules|binding|meta --reason "…" [--evidence A1,000140]
//                (stage the new text first at state/bedrock/proposed/<doc>.md)
//   approve    --doc ontology            OPERATOR ONLY — run from your own prompt with "!"
//   register   --doc <doc> --layer meta  (a doc that predates the guard)
//   cell new   --name <name> [--binding <file.json>]   → cells/<name>/ born by script
//   cell refresh --name <name>                          → regenerate its brief, hooks and mailboxes
//   fold · lint
// Mail between cells has its own CLI: node kernel/src/mail.ts send|recv|status --cell cells/<name>
// Every write refolds: state/views/* and docs/assumptions.md (generated; hook-blocked).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { append, AppendError, readLog } from './log.ts';
import { fold, writeViews } from './fold.ts';
import { lint } from './lint.ts';
import { writeDocs } from './render.ts';
import { assume, constraint, evidence } from './generators.ts';
import { amend, approve, bedrockDir, foldBedrock, register } from './bedrock.ts';
import { cellNew, cellRefresh } from './cell.ts';
import type { Kind } from './schemas.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
try { process.loadEnvFile(join(repoRoot, '.env')); } catch { /* no .env */ }
const [cmd, ...rest] = process.argv.slice(2);
const opt = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const cell = resolve(opt('cell') ?? repoRoot);

function refold(): number {
  const log = readLog(cell);
  const p = fold(log);
  writeViews(cell, p);
  writeFileSync(join(cell, 'state', 'views', 'bedrock.json'), JSON.stringify(foldBedrock(log), null, 2) + '\n', 'utf8');
  if (cell === repoRoot) { mkdirSync(join(repoRoot, 'docs'), { recursive: true }); writeDocs(repoRoot, p); }
  console.log(JSON.stringify(p.summary));
  return 0;
}

function write(run: () => string[]): number {
  try { console.log(`appended ${run().join(', ')}`); }
  catch (err) { if (err instanceof AppendError) { console.error(`refused: ${err.message}`); return 1; } throw err; }
  return refold();
}

function main(): number {
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
    case 'amend':
    case 'approve':
    case 'register': {
      const o = { doc: opt('doc'), layer: opt('layer'), reason: opt('reason'), evidence: opt('evidence'), voice: opt('voice') };
      return write(() => (cmd === 'amend' ? amend(cell, o) : cmd === 'approve' ? approve(cell, o) : register(cell, o)));
    }
    case 'cell':
      if (rest[0] === 'refresh') { try { console.log(cellRefresh(cell, { name: opt('name') }).join('\n')); return 0; } catch (e) { console.error(`refused: ${(e as Error).message}`); return 1; } }
      if (rest[0] !== 'new') { console.error('usage: cell new --name <name> [--binding <file.json>] · cell refresh --name <name>'); return 2; }
      return write(() => cellNew(cell, { name: opt('name'), binding: opt('binding') }));
    case 'fold':
      return refold();
    case 'lint': {
      const r = lint(cell);
      for (const e of r.errors) console.error(`ERROR ${e}`);
      for (const w of r.warnings) console.error(`warn  ${w}`);
      console.log(`lint: ${r.entries} entries, ${r.errors.length} errors, ${r.warnings.length} warnings`);
      return r.errors.length ? 1 : 0;
    }
    default:
      console.error('usage: cli.ts <init|append|assume|evidence|constraint|amend|approve|register|cell|fold|lint> [--cell dir]');
      return 2;
  }
}

process.exitCode = main();
