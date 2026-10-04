// Cell birth. A cell is born by script, never by hand:
//   cells/<name>/  AGENTS.md · CLAUDE.md · .claude/settings.json · binding.json · adapters/ · state/log/ · inbox/ · outbox/
// Its log opens with "born" + its binding (as a rule claim); the parent's log records the birth and the child's head.
// Rules flow down: a cell has no bedrock of its own and can't amend the parent's.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { AppendError, readLog, writer } from './log.ts';

// A binding is the cell's domain: its scope plus whatever your project needs (registries, thresholds, vocabularies…).
export interface Binding { name: string; scope: Record<string, string>; [k: string]: unknown }

export const bindingPath = (cellDir: string) => join(cellDir, 'binding.json');
export function readBinding(cellDir: string): Binding | null {
  return existsSync(bindingPath(cellDir)) ? JSON.parse(readFileSync(bindingPath(cellDir), 'utf8')) : null;
}

const agentsMd = (b: Binding, toRoot: string) => `# cell: ${b.name}

A cell: \`(state, input) → (state′, output)\`. Born by \`kernel/src/cli.ts cell new\`; regenerate this file with \`cell refresh\`.

- **Binding:** [\`binding.json\`](binding.json) — scope ${Object.entries(b.scope).map(([k, v]) => `${k} ${v}`).join(' · ')}.
- **Rules flow down** from the root: [\`${toRoot}/state/bedrock/\`](${toRoot}/state/bedrock/). This cell has no bedrock and can't amend the root's.
- **Entry:** \`adapters/\` — the only code that brings the world in. **Exit:** \`state/out/\`.
- **Memory:** \`state/log/\` (append-only, kernel-written) → \`state/views/\` (folded, not committed).
- **Mail:** \`inbox/\` → you · \`outbox/\` → root. A Stop hook runs the loop: when you end a turn it sends your final answer back as the reply, waits for the next message (up to 30 min) and gives it to you as your next instruction. Never write mail files yourself. To start the loop, end a turn (e.g. say "waiting for mail").

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
