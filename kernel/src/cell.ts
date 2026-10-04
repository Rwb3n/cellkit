// Cell birth. A cell is born by script, never by hand:
//   cells/<name>/  AGENTS.md · CLAUDE.md · .claude/settings.json · binding.json · adapters/ · state/log/ · inbox/ · outbox/
// Its log opens with "born" + its binding (as a rule claim); the parent's log records the birth and the child's head.
// Rules flow down: a cell has no bedrock of its own and can't amend the parent's.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { AppendError, readLog, writer, type Entry } from './log.ts';
import { fold } from './fold.ts';
import { foldReviews } from './review.ts';

// A binding is the cell's domain: its scope plus whatever your project needs (registries, thresholds, vocabularies…).
export interface Binding { name: string; scope: Record<string, string>; [k: string]: unknown }

export const bindingPath = (cellDir: string) => join(cellDir, 'binding.json');
export function readBinding(cellDir: string): Binding | null {
  return existsSync(bindingPath(cellDir)) ? JSON.parse(readFileSync(bindingPath(cellDir), 'utf8')) : null;
}

const agentsMd = (b: Binding, toRoot: string) => `# cell: ${b.name}

A cell: \`(state, input) → (state′, output)\`. Born by \`kernel/src/cli.ts cell new\`; regenerate this file with \`cell refresh\`.

## Read first

1. [\`MODEL.md\`](MODEL.md) — **this cell's model** (write it if it's missing): what it holds, what comes in, what leaves, its tests, where it stands.
2. **The project's model** (read-only, flows down from root):
${(Array.isArray(b.reads) ? (b.reads as string[]) : ['state/bedrock/ontology.md']).map((r) => `   - [\`${r}\`](${toRoot}/${r})`).join('\n')}
3. [\`binding.json\`](binding.json) — scope ${Object.entries(b.scope).map(([k, v]) => `${k} ${v}`).join(' · ')}.

## Boundary

- **You write only inside this folder** (hook-enforced): \`adapters/\` (entry), \`exit/\` (exit code), \`test/\`, \`MODEL.md\`, \`state/out/\`. Your log is written only through the kernel.
- **Read-only above you:** \`${toRoot}/kernel/\`, root bedrock and docs, other cells.
- **Need a kernel or root change?** Don't work around it — say so (what, why, smallest change). Root decides.
- **The rule says no, the evidence says probably yes?** Raise a review proposing ONE exact claim with its evidence: \`node ${toRoot}/kernel/src/cli.ts review raise --cell . --file r.json\` (\`{ question, proposes: { about, kind, says }, evidence }\`). Root is mailed; only the operator decides.
- **Done means tested:** your tests, the kernel's (\`cd ${toRoot}/kernel && npm test\`), then fold + lint. Keep \`MODEL.md\` current. Publish numbers in \`state/out/metrics.json\` (\`{ name: number }\`); root's \`cell sync\` records them.
- Rules flow down from the root: [\`${toRoot}/state/bedrock/\`](${toRoot}/state/bedrock/). This cell has no bedrock and can't amend the root's.

## How it runs

- **Entry:** \`adapters/\` — the only code that brings the world in. **Exit:** \`state/out/\`.
- **Memory:** \`state/log/\` (append-only, kernel-written) → \`state/views/\` (folded, not committed).
- **Mail:** tasks from root arrive in \`inbox/\`. A Stop hook runs the loop: when you end a turn it sends your final answer to root as the reply, waits for the next task (up to 30 min) and gives it to you as your next instruction. Never write mail files yourself. Blocked, or need root to decide? \`node ${toRoot}/kernel/src/mail.ts send --to root --kind blocked|question --body "…"\`, then end your turn. You can only write to root. To start the loop, end a turn (e.g. say "waiting for mail").

\`\`\`
node ${toRoot}/kernel/src/cli.ts fold --cell .
node ${toRoot}/kernel/src/cli.ts lint --cell .
\`\`\`
`;

const settings = (toRoot: string) => {
  const k = `$CLAUDE_PROJECT_DIR/${toRoot}/kernel/src`;
  return {
    hooks: {
      PreToolUse: [
        { matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: `node "${k}/hook-guard.ts"` }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: `node "${k}/hook-bash.ts"` }] },
      ],
      SessionStart: [{ hooks: [{ type: 'command', command: `node "${k}/cli.ts" fold --cell "$CLAUDE_PROJECT_DIR" && node "${k}/cli.ts" lint --cell "$CLAUDE_PROJECT_DIR"` }] }],
      // the mail loop: file the last answer as the reply, wait for the next message, hand it over (kernel/src/mail-hook.ts)
      Stop: [{ hooks: [{ type: 'command', command: `node "${k}/mail-hook.ts"`, timeout: 1900 }] }],
    },
  };
};

// The generated parts of a cell (brief, hooks, mailboxes). Re-run by `cell refresh` when the kit's template changes.
function scaffold(dir: string, b: Binding, toRoot: string) {
  for (const d of ['.claude', 'inbox/read', 'outbox/read']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'AGENTS.md'), agentsMd(b, toRoot));
  writeFileSync(join(dir, 'CLAUDE.md'), '# CLAUDE.md\n\nRead [`AGENTS.md`](AGENTS.md) in this folder.\n');
  writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify(settings(toRoot), null, 2) + '\n');
}

export function cellRefresh(parent: string, o: { name?: string }): string[] {
  const dir = join(parent, 'cells', o.name ?? '');
  const b = readBinding(dir);
  if (!o.name || !b) throw new AppendError(`no cell cells/${o.name ?? ''} with a binding.json`);
  scaffold(dir, b, relative(dir, parent).replaceAll('\\', '/'));
  return [`cells/${o.name}: AGENTS.md, CLAUDE.md, .claude/settings.json, inbox/, outbox/ regenerated`];
}

export function cellNew(parent: string, o: { name?: string; binding?: string }): string[] {
  if (!o.name || !/^[a-z0-9-]+$/.test(o.name)) throw new AppendError('cell new needs --name (lowercase, digits, dashes)');
  const b: Binding = { scope: {}, ...(o.binding ? JSON.parse(readFileSync(o.binding, 'utf8')) : {}), name: o.name };
  const dir = join(parent, 'cells', o.name);
  if (existsSync(dir)) throw new AppendError(`cells/${o.name} already exists`);
  const toRoot = relative(dir, parent).replaceAll('\\', '/');
  const parentName = basename(resolve(parent));

  for (const d of ['adapters', 'state/log', 'state/out']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'state/log/.gitkeep'), '');
  writeFileSync(join(dir, 'state/out/.gitkeep'), '');
  writeFileSync(join(dir, 'adapters/.gitkeep'), '');
  writeFileSync(bindingPath(dir), JSON.stringify(b, null, 2) + '\n');
  scaffold(dir, b, toRoot);

  const now = new Date().toISOString();
  const obs = (payload: unknown) => ({ source: { adapter: 'kernel', capability: 'cell-new' }, observed_at: now, reliability: [], licence: { store: 'full' }, payload });
  const W = writer(dir);
  const born = W.append({ kind: 'observation', cell: o.name, body: obs({ name: o.name, parent: parentName }) });
  W.append({ kind: 'claim', cell: o.name, body: { about: [`thing:cell/${o.name}`], kind: 'fact', says: { born: now, parent: parentName }, from: born.id, voice: 'voice:kernel' } });
  W.append({ kind: 'claim', cell: o.name, body: { about: [`thing:binding/${o.name}`, `thing:cell/${o.name}`], kind: 'rule', says: { binding: b }, from: born.id, voice: 'voice:kernel' } });
  const head = readLog(dir).at(-1)!.hash;

  const P = writer(parent);
  const po = P.append({ kind: 'observation', body: obs({ cell: `cells/${o.name}`, head }) });
  const pc = P.append({ kind: 'claim', body: { about: [`thing:cell/${o.name}`], kind: 'fact', says: { born: now, path: `cells/${o.name}`, head, scope: b.scope }, from: po.id, voice: 'voice:kernel' } });
  return [`cells/${o.name} (3 entries)`, po.id, pc.id];
}

// ── reporting up: root learns each cell's state without reading its log ─────────────
// `cell sync` appends, per cell whose head or published numbers moved, one observation + one fact about thing:cell/<name>:
// { synced, head, entries, summary } (summary = fold counts + the cell's state/out/metrics.json). Root's lint checks every
// recorded head still exists in that cell's log — so a cell log rewritten after a sync is caught.
export interface CellPicture { name: string; path: string; head: string; entries?: number; synced?: string; born?: string; summary?: Record<string, unknown>; entry: string }

export function foldCells(log: Entry[]): Record<string, CellPicture> {
  const out: Record<string, CellPicture> = {};
  for (const e of log) {
    if (e.kind !== 'claim') continue;
    const b = e.body as { about: string[]; kind: string; says: { born?: string; synced?: string; path?: string; head?: string; entries?: number; summary?: Record<string, unknown> } };
    const s = b.about.find((a) => a.startsWith('thing:cell/'));
    if (!s || b.kind !== 'fact' || !b.says?.head) continue;
    const name = s.slice('thing:cell/'.length);
    out[name] = { ...(out[name] ?? {}), name, path: b.says.path ?? out[name]?.path ?? `cells/${name}`, head: b.says.head, entry: e.id,
      ...(b.says.born ? { born: b.says.born } : {}), ...(b.says.synced ? { synced: b.says.synced, entries: b.says.entries, summary: b.says.summary } : {}) };
  }
  return out;
}

export function cellSync(parent: string, o: { name?: string } = {}): string[] {
  const dir = join(parent, 'cells');
  const names = (o.name ? [o.name] : existsSync(dir) ? readdirSync(dir) : []).filter((n) => existsSync(join(dir, n, 'binding.json')));
  const known = foldCells(readLog(parent));
  const P = writer(parent);
  const out: string[] = [];
  for (const n of names) {
    const cdir = join(dir, n);
    const log = readLog(cdir);
    const head = log.at(-1)?.hash;
    if (!head) continue;
    const p = fold(log);
    const mpath = join(cdir, 'state', 'out', 'metrics.json');
    const published = existsSync(mpath) ? Object.fromEntries(Object.entries(JSON.parse(readFileSync(mpath, 'utf8')) as Record<string, unknown>).filter(([, v]) => typeof v === 'number')) : {};
    const summary = { ...published, observations: p.summary.observations, claims: p.summary.claims, reviews_open: Object.values(foldReviews(log)).filter((r) => r.status === 'open').length };
    if (known[n]?.head === head && JSON.stringify(known[n]?.summary) === JSON.stringify(summary)) continue;
    const now = new Date().toISOString();
    const ob = P.append({ kind: 'observation', body: { source: { adapter: 'kernel', capability: 'cell-sync' }, observed_at: now, reliability: [], licence: { store: 'full' }, payload: { cell: `cells/${n}`, head, entries: log.length } } });
    const c = P.append({ kind: 'claim', body: { about: [`thing:cell/${n}`], kind: 'fact', says: { synced: now, path: `cells/${n}`, head, entries: log.length, summary }, from: ob.id, voice: 'voice:kernel' } });
    out.push(`${n} @ ${log.length}`, ob.id, c.id);
  }
  return out.length ? out : ['(all cells already in sync)'];
}

export function lintCells(parent: string, log: Entry[]): string[] {
  const errors: string[] = [];
  const recorded = new Map<string, Set<string>>();
  for (const e of log) {
    if (e.kind !== 'claim') continue;
    const b = e.body as { about: string[]; kind: string; says?: { head?: string } };
    const s = b.about.find((a) => a.startsWith('thing:cell/'));
    if (s && b.kind === 'fact' && b.says?.head) (recorded.get(s.slice(10)) ?? recorded.set(s.slice(10), new Set()).get(s.slice(10))!).add(b.says.head);
  }
  for (const [n, heads] of recorded) {
    const cdir = join(parent, 'cells', n);
    if (!existsSync(cdir)) { errors.push(`cells/${n}: recorded in the log but missing on disk`); continue; }
    const hashes = new Set(readLog(cdir).map((x) => x.hash));
    for (const h of heads) if (!hashes.has(h)) errors.push(`cells/${n}: recorded head ${h.slice(0, 19)}… is no longer in its log (rewritten?)`);
  }
  return errors;
}
