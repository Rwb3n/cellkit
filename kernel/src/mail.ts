// Mail between cells — files, not chat. Agents never write message structure; this module does.
// Every cell has an inbox, root included (root = the repo root; a cell = cells/<name>):
//   <box>/inbox/<id>.json          unread  → <box>/inbox/read/<id>.json once taken
//   <box>/outbox/read/<id>.json    what this box sent (a record; never polled)
//   <box>/inbox/.current           the message a cell session is working on (its next stop = the reply)
// Addressed by name: --to root | --to <cell>. Replies go to the asker's inbox.
//
// Who may say what:
//   root → cell   task
//   cell → root   reply (written by the cell's Stop hook, never by hand) · blocked · question · done
// A cell can't send tasks, and can't write to another cell: no agent chatter.
//
//   node kernel/src/mail.ts send   --to <cell> --body "…" | --file f      (from root)
//   node kernel/src/mail.ts send   --to root --kind blocked|question|done --body "…"   (from inside a cell)
//   node kernel/src/mail.ts watch  [--as root] [--wait 600] [--for <id>]      → prints unread mail, marks it read
//   node kernel/src/mail.ts status [--as <name>]
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { append } from './log.ts';

export type MailKind = 'task' | 'reply' | 'blocked' | 'question' | 'done';
export interface Message { id: string; kind: MailKind; from: string; to: string; at: string; body: string; reply_to?: string }

const CELL_TO_ROOT: MailKind[] = ['reply', 'blocked', 'question', 'done'];
export class MailError extends Error {}

// ── where boxes live ─────────────────────────────────────────────────────────────
// A cell is a folder with binding.json under <root>/cells/; root is the folder above cells/ (or the repo root).
export const isCell = (dir: string) => existsSync(join(dir, 'binding.json'));
export function rootOf(dir: string): string {
  const d = resolve(dir);
  return isCell(d) ? resolve(d, '..', '..') : d;
}
export const nameOf = (dir: string) => (isCell(dir) ? resolve(dir).replaceAll('\\', '/').split('/').at(-1)! : 'root');
export const dirOf = (root: string, name: string) => (name === 'root' ? resolve(root) : join(resolve(root), 'cells', name));

const inbox = (dir: string) => join(dir, 'inbox');
const sent = (dir: string) => join(dir, 'outbox', 'read');
const ensure = (dir: string) => { mkdirSync(join(inbox(dir), 'read'), { recursive: true }); mkdirSync(sent(dir), { recursive: true }); };
const jsons = (d: string) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')) : []);
// ids sort in arrival order: timestamp (ms) + a per-box sequence (two messages in the same ms keep their order)
const newId = (dir: string) => `${new Date().toISOString().replace(/[-:.]/g, '').replace('Z', '')}-${String(jsons(inbox(dir)).length + jsons(join(inbox(dir), 'read')).length + 1).padStart(5, '0')}-${randomBytes(2).toString('hex')}`;
const unread = (dir: string): Message[] => jsons(inbox(dir)).sort().map((f) => JSON.parse(readFileSync(join(inbox(dir), f), 'utf8')));
const markRead = (dir: string, id: string) => renameSync(join(inbox(dir), `${id}.json`), join(inbox(dir), 'read', `${id}.json`));

// ── sending ──────────────────────────────────────────────────────────────────────
export function send(fromDir: string, to: string, body: string, kind: MailKind = 'task', reply_to?: string): Message {
  const from = nameOf(fromDir), root = rootOf(fromDir);
  if (!body.trim()) throw new MailError('empty message');
  if (from === 'root' && kind !== 'task') throw new MailError('root sends tasks');
  if (from !== 'root' && to !== 'root') throw new MailError(`a cell writes only to root (not ${to})`);
  if (from !== 'root' && !CELL_TO_ROOT.includes(kind)) throw new MailError(`a cell may send root: ${CELL_TO_ROOT.join(' · ')}`);
  const toDir = dirOf(root, to);
  if (to !== 'root' && !isCell(toDir)) throw new MailError(`no cell named ${to}`);
  ensure(toDir); ensure(resolve(fromDir));
  const m: Message = { id: newId(toDir), kind, from, to, at: new Date().toISOString(), body, ...(reply_to ? { reply_to } : {}) };
  const text = JSON.stringify(m, null, 2) + '\n';
  writeFileSync(join(inbox(toDir), `${m.id}.json`), text, { flag: 'wx' });
  writeFileSync(join(sent(resolve(fromDir)), `${m.id}.json`), text, { flag: 'wx' });
  logMail(resolve(fromDir), m);   // the files are transport; the log is the record — on both sides
  logMail(toDir, m);
  return m;
}

// One observation per message, on a box's own log. Two sessions (root and a cell's Stop hook) can append to the same
// log at once; the kernel's `wx` refuses a clash, so re-read and retry.
function logMail(dir: string, m: Message): void {
  for (let attempt = 1; ; attempt++) {
    try {
      append(dir, { kind: 'observation', body: { source: { adapter: 'kernel', provider: 'mail', capability: 'mail' }, observed_at: m.at, reliability: [], licence: { store: 'full' },
        payload: { id: m.id, kind: m.kind, from: m.from, to: m.to, ...(m.reply_to ? { reply_to: m.reply_to } : {}), body: m.body } } });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 5) throw e;
    }
  }
}

// Take unread mail from a box (marks it read). --for narrows to replies to one message.
export function receive(dir: string, forId?: string): Message[] {
  const got = unread(dir).filter((m) => !forId || m.reply_to === forId);
  for (const m of got) markRead(dir, m.id);
  return got;
}

// ── a cell session's side (used by mail-hook.ts) ────────────────────────────────
const currentPath = (cell: string) => join(inbox(cell), '.current');
export const current = (cell: string): string | null => (existsSync(currentPath(cell)) ? readFileSync(currentPath(cell), 'utf8').trim() || null : null);

// The session finished a turn: if it was working on a task, its last answer is the reply (to the asker's inbox).
export function fileReply(cell: string, answer: string): Message | null {
  const id = current(cell);
  if (!id) return null;
  const asked: Message = JSON.parse(readFileSync(join(inbox(cell), 'read', `${id}.json`), 'utf8'));
  rmSync(currentPath(cell));
  return send(cell, asked.from, answer || '(no answer text)', 'reply', id);
}

// Hand the oldest unread task to the session (marks it read and current).
export function takeNext(cell: string): Message | null {
  const [m] = unread(cell);
  if (!m) return null;
  markRead(cell, m.id);
  writeFileSync(currentPath(cell), m.id);
  return m;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
  const here = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const me = isCell(here) ? here : repo;                       // run from a cell → you are that cell; else root
  const boxOf = (name?: string) => (name ? dirOf(rootOf(me), name) : me);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    if (cmd === 'send') {
      const to = opt('to');
      if (!to) throw new MailError('send needs --to <root|cell>');
      const body = opt('body') ?? (opt('file') ? readFileSync(opt('file')!, 'utf8') : '');
      console.log(send(me, to, body, (opt('kind') as MailKind) ?? (nameOf(me) === 'root' ? 'task' : 'question')).id);
    } else if (cmd === 'watch' || cmd === 'recv') {
      const box = boxOf(opt('as')), until = Date.now() + Number(opt('wait') ?? 0) * 1000;
      let got = receive(box, opt('for'));
      while (!got.length && Date.now() < until) { await sleep(3000); got = receive(box, opt('for')); }
      if (!got.length) console.log('(no unread mail)');
      for (const m of got) console.log(`── ${m.kind} from ${m.from} · ${m.id}${m.reply_to ? ` · re ${m.reply_to}` : ''} · ${m.at}\n${m.body}\n`);
    } else if (cmd === 'status') {
      const box = boxOf(opt('as'));
      console.log(JSON.stringify({ box: nameOf(box), unread: unread(box).length, working_on: current(box) }));
    } else {
      throw new MailError('usage: mail.ts send|watch|status …');
    }
  } catch (e) {
    if (e instanceof MailError) { console.error(`refused: ${e.message}`); process.exit(1); }
    throw e;
  }
}
