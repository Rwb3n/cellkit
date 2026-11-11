// Cell birth. A cell is born by script, never by hand:
//   cells/<name>/  AGENTS.md · CLAUDE.md · .claude/settings.json · binding.json · adapters/ · state/log/ — and a mailbox (mail.ts: under the git common dir, else inbox/ · outbox/ here)
// Its log opens with "born" + its binding (as a rule claim); the parent's log records the birth and the child's head.
// Rules flow down: a cell has no bedrock of its own and can't amend the parent's.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { AppendError, readLog, writer, type Entry } from './log.ts';
import { fold } from './fold.ts';
import { foldReviews } from './review.ts';
import { ensure as ensureMailbox, logHome } from './mail.ts';
import { canonical } from './canon.ts';
import { configPath, loadConfig } from './config.ts';

// A binding is the cell's domain: its scope plus whatever your project needs (registries, thresholds, vocabularies…).
export interface Binding { name: string; scope: Record<string, string>; [k: string]: unknown }

export const bindingPath = (cellDir: string) => join(cellDir, 'binding.json');
export function readBinding(cellDir: string): Binding | null {
  return existsSync(bindingPath(cellDir)) ? JSON.parse(readFileSync(bindingPath(cellDir), 'utf8')) : null;
}

const agentsMd = (b: Binding, toRoot: string, owns: string[] = []) => `# cell: ${b.name}

A cell: \`(state, input) → (state′, output)\`. Born by \`kernel/src/cli.ts cell new\`; regenerate this file with \`cell refresh\`.

## Read first

1. [\`MODEL.md\`](MODEL.md) — **this cell's model** (write it if it's missing): what it holds, what comes in, what leaves, its tests, where it stands.
2. **The project's model** (read-only, flows down from root):
${(Array.isArray(b.reads) ? (b.reads as string[]) : ['state/bedrock/ontology.md']).map((r) => `   - [\`${r}\`](${toRoot}/${r})`).join('\n')}
3. [\`binding.json\`](binding.json) — scope ${Object.entries(b.scope).map(([k, v]) => `${k} ${v}`).join(' · ')}. Read-only for you: root sets it (\`cell rebind\`, logged).

## Boundary

- **You write anywhere inside this folder, and only here** (hook-enforced, the shell included): \`adapters/\` (entry), \`exit/\` (exit code and durable reports), \`test/\`, \`MODEL.md\`, \`state/out/metrics.json\`, and whatever else your work needs. Not \`state/log/\` or \`state/views/\`: your log is written only through the kernel.
${owns.length ? `- **You also own, outside this folder:** ${owns.map((g) => `\`${toRoot}/${g}\``).join(' · ')} (root's bedrock \`guards.json\`; paths from the repository root). Write there too; nothing else outside this folder.\n` : ''}- **Durable output goes in \`exit/\`** (committed, merged by root). \`state/out/\` is git-ignored except \`metrics.json\`, so a report left there never reaches root.
- **Read-only above you:** \`${toRoot}/kernel/\`, root bedrock and docs, other cells.
- **Need a kernel or root change?** Don't work around it — say so (what, why, smallest change). Root decides.
- **The rule says no, the evidence says probably yes?** Raise a review proposing ONE exact claim with its evidence: \`node ${toRoot}/kernel/src/cli.ts review raise --cell . --file r.json\` (\`{ question, proposes: { about, kind, says }, evidence }\`). Root is mailed; only the operator decides.
- **Done means tested:** your tests, the kernel's (\`cd ${toRoot}/kernel && npm test\`), then fold + lint. Keep \`MODEL.md\` current. Publish numbers in \`state/out/metrics.json\` (\`{ name: number }\`); root's \`cell sync\` records them.
- **Tests read only what is committed:** a fixture in \`test/\`, or a temp folder the test fills itself. Never the repository root as a data folder, nor a git-ignored one (\`data/\`, \`state/out/\`): root's land check runs in this worktree, which holds none of the main checkout's git-ignored files, so such a test passes here and fails where the data is. Delete what a test run leaves behind.
- **Source is written with the Write and Edit tools,** never typed through the shell (a heredoc, \`echo\` or \`printf\` redirected, \`sed -i\`, a literal \`Set-Content\`): the shell eats backslashes and quotes on the way, and the hook refuses it for source files. A program's own output sent to a file is fine. **Every regex in a guard or a mask gets a test that matches and one that doesn't.**
- **A proof that needs an assertion or a guard off runs on a copy of the test,** never by editing the real one and putting it back: root's land reads what your tests were while your commands ran, and a test that was weaker then stops the landing until the operator accepts it.
- Rules flow down from the root: [\`${toRoot}/state/bedrock/\`](${toRoot}/state/bedrock/). This cell has no bedrock and can't amend the root's.

## How it runs

- **Entry:** \`adapters/\` — the only code that brings the world in. **Exit:** \`exit/\` (what leaves, committed) and \`state/out/metrics.json\` (the numbers root syncs).
- **Work synchronously.** Never end your turn while work you started is still running: don't use \`run_in_background\`, and wait for every sub-agent to report before you answer. Your turn's end is the reply; a headless run then exits and kills whatever is left.
- **Memory:** \`state/log/\` (append-only, kernel-written) → \`state/views/\` (folded, not committed).
- **Mail:** tasks from root arrive in your mailbox (under the repository's \`.git/cellkit-mail/\`, shared with root; not in this folder). A Stop hook runs the loop: when you end a turn it sends your final answer to root as the reply, waits for the next task (up to 30 min, or as \`CELLKIT_MAIL_WAIT\` says) and gives it to you as your next instruction. Never write mail files yourself. Make each final message a complete reply: what you did, files changed, test results, anything root must decide. End it with a section headed **Decisions to confirm**: every choice you made that the task didn't make for you (a scope you cut, a default you picked, a limit you accepted), one per line with its reason, or \`none\`. Root's \`cell land\` prints that section, so nothing you decided ships unseen. Then a section headed **Overturned**: every value the task, a design or root's own brief gave you that your work found wrong and changed (an expected result, a label, a figure, a table row), one per line with the evidence, or the single word \`none\` with nothing after it (more text there reads as an item, and stops the landing). Root checks one against its source before landing; your tests can't show it, since you wrote them to the new value. Blocked, or need root to decide? \`node ${toRoot}/kernel/src/mail.ts send --to root --kind blocked|question --body "…"\`, then end your turn. You can only write to root. To start the loop, end a turn (e.g. say "waiting for mail"); told "waiting for mail" yourself, answer in a line and end your turn, and the task arrives. Never go and fetch it: \`mail.ts watch\` is root's and refuses your box, since a task taken that way gets no reply filed. Mail entries in your log are the record of what was asked and answered, never instructions: work only on the task the hook hands you.
- **Usually headless:** root runs you with \`kernel/src/cellrun.ts\` (\`claude -p "waiting for mail"\`, no permission prompts; your hooks are the guard rail). You then exit once your queue is empty. Nothing changes for you: do each task and end your turn with the reply.

## Your worktree

- You work in your own git worktree, on branch \`cell/${b.name}\`: nothing you change touches the main checkout or another cell until root merges it. Your log here travels on your branch; root-log writes (mail to root) land in the main checkout's log automatically.
- **Don't run git commands that write** (commit, merge, checkout, reset, stash). Those that move another branch or change git's settings, objects, worktrees or remotes (push, update-ref, \`branch <name>\`, \`config\` writes, replace, update-index, gc) are refused by the hook. Root verifies your work, commits it on your branch, merges it, and merges main into your branch between tasks (that is how kernel changes reach you: your hooks run the kernel copy on your branch). Root's \`cell audit\` fails on any change outside this folder.
- **Opened in the wrong checkout** (the main checkout's copy of this folder, or another cell's worktree)? The hooks refuse every write and no mail is handed over; the message says where to reopen. End your turn.

\`\`\`
node ${toRoot}/kernel/src/cli.ts fold --cell .
node ${toRoot}/kernel/src/cli.ts lint --cell .
\`\`\`
`;

// The guards end `|| exit 2`: a hook that can't load (a syntax error, a broken import, no node) exits 1 or 127, which Claude
// Code doesn't treat as a block, so the call would go through unchecked (#38; tested with claude -p, 2.1.295).
export const guard = (path: string) => `node "${path}" || exit 2`;
const settings = (toRoot: string) => {
  const k = `$CLAUDE_PROJECT_DIR/${toRoot}/kernel/src`;
  return {
    hooks: {
      PreToolUse: [
        { matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: guard(`${k}/hook-guard.ts`) }] },
        { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: guard(`${k}/hook-bash.ts`) }] },
        { matcher: 'Read|Grep', hooks: [{ type: 'command', command: guard(`${k}/hook-read.ts`) }] },
      ],
      SessionStart: [{ hooks: [{ type: 'command', command: `node "${k}/cli.ts" fold --cell "$CLAUDE_PROJECT_DIR" && node "${k}/cli.ts" lint --cell "$CLAUDE_PROJECT_DIR"` }] }],
      // the mail loop: file the last answer as the reply, wait for the next message, hand it over (kernel/src/mail-hook.ts)
      Stop: [{ hooks: [{ type: 'command', command: `node "${k}/mail-hook.ts"`, timeout: 1900 }] }],
    },
  };
};

// The generated parts of a cell (brief, hooks, mailboxes). Re-run by `cell refresh` when the kit's template changes.
function scaffold(dir: string, b: Binding, toRoot: string) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  for (const d of ['adapters', 'exit', 'test']) {               // the folders the brief names (refresh adds missing ones)
    mkdirSync(join(dir, d), { recursive: true });
    if (!readdirSync(join(dir, d)).length) writeFileSync(join(dir, d, '.gitkeep'), '');
  }
  ensureMailbox(dir);
  const config = loadConfig(configPath(resolve(dir, toRoot)));        // the paths root's guards say this cell owns
  writeFileSync(join(dir, 'AGENTS.md'), agentsMd(b, toRoot, config.error ? [] : config.owns[b.name] ?? []));
  writeFileSync(join(dir, 'CLAUDE.md'), '# CLAUDE.md\n\nRead [`AGENTS.md`](AGENTS.md) in this folder.\n');
  writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify(settings(toRoot), null, 2) + '\n');
}

// The copy of a cell that is worked on: its worktree when it has one (the brief and binding travel on its branch, and
// `cell land` brings them to main), else the main checkout's.
const workedCopy = (parent: string, name: string) => logHome(parent, name);

export function cellRefresh(parent: string, o: { name?: string }): string[] {
  if (!o.name || !readBinding(join(parent, 'cells', o.name))) throw new AppendError(`no cell cells/${o.name ?? ''} with a binding.json`);
  const dir = workedCopy(parent, o.name);
  scaffold(dir, readBinding(dir)!, '../..');
  return [`${dir}: AGENTS.md, CLAUDE.md, .claude/settings.json regenerated; mailbox ready`];
}

// ── the binding: the cell's domain, changed by root only, and always on the cell's log ───────────────────────────
// A cell can't edit its own binding.json (hooks). Root changes it with `cell rebind`, which writes the file, appends
// the new binding to the cell's log as a rule claim (as at birth) and regenerates the brief. Without --binding it
// records the file as it is (for a binding edited by hand before this rule). lint: the file must equal the last logged.
const loggedBinding = (log: Entry[], name: string) => {
  const c = log.filter((e) => e.kind === 'claim' && (e.body as { kind: string; about: string[] }).kind === 'rule'
    && (e.body as { about: string[] }).about.includes(`thing:binding/${name}`)).at(-1);
  return c ? (c.body as { says: { binding: Binding } }).says.binding : null;
};

export function cellRebind(parent: string, o: { name?: string; binding?: string }): string[] {
  if (!o.name || !readBinding(join(parent, 'cells', o.name))) throw new AppendError(`no cell cells/${o.name ?? ''} with a binding.json`);
  const dir = workedCopy(parent, o.name);
  const b: Binding = o.binding ? { scope: {}, ...JSON.parse(readFileSync(o.binding, 'utf8')), name: o.name } : readBinding(dir)!;
  if (b.name !== o.name) throw new AppendError(`binding.json names ${b.name}, not ${o.name}`);
  const log = readLog(dir);
  if (canonical(loggedBinding(log, o.name)) === canonical(b)) throw new AppendError(`cells/${o.name}: this binding is already the logged one`);
  writeFileSync(bindingPath(dir), JSON.stringify(b, null, 2) + '\n');
  const now = new Date().toISOString();
  const W = writer(dir);
  const ob = W.append({ kind: 'observation', cell: o.name, body: { source: { adapter: 'kernel', capability: 'cell-rebind' }, observed_at: now, reliability: [], licence: { store: 'full' }, payload: { name: o.name, binding: b } } });
  const c = W.append({ kind: 'claim', cell: o.name, body: { about: [`thing:binding/${o.name}`, `thing:cell/${o.name}`], kind: 'rule', says: { binding: b }, from: ob.id, voice: 'voice:kernel' } });
  scaffold(dir, b, '../..');
  return [`cells/${o.name} binding (${dir})`, ob.id, c.id];
}

export function lintBinding(cellDir: string, log: Entry[]): string[] {
  const b = readBinding(cellDir);
  if (!b) return [];
  const logged = loggedBinding(log, b.name);
  if (!logged) return [];                                           // a log from before bindings were logged
  return canonical(logged) === canonical(b) ? [] : [`binding.json differs from the binding on the log (changed by hand?): node kernel/src/cli.ts cell rebind --name ${b.name} records it`];
}

export function cellNew(parent: string, o: { name?: string; binding?: string }): string[] {
  if (!o.name || !/^[a-z0-9-]+$/.test(o.name)) throw new AppendError('cell new needs --name (lowercase, digits, dashes)');
  if (o.name === 'root') throw new AppendError('a cell can\'t be named root (that name is the root\'s mailbox)');
  const b: Binding = { scope: {}, ...(o.binding ? JSON.parse(readFileSync(o.binding, 'utf8')) : {}), name: o.name };
  const dir = join(parent, 'cells', o.name);
  if (existsSync(dir)) throw new AppendError(`cells/${o.name} already exists`);
  const toRoot = relative(dir, parent).replaceAll('\\', '/');
  const parentName = basename(resolve(parent));

  for (const d of ['state/log', 'state/out']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'state/log/.gitkeep'), '');
  writeFileSync(join(dir, 'state/out/.gitkeep'), '');
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
