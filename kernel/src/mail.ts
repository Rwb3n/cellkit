// Mail between cells — files, not chat. Agents never write message structure; this module does.
//   cells/<name>/inbox/<id>.json        unread, to the cell        → inbox/read/<id>.json once delivered
//   cells/<name>/outbox/<id>.json       unread reply, from the cell → outbox/read/<id>.json once received
//   inbox/.current                      the message the cell's session is working on (its next stop = the reply)
// The cell side is a Stop hook (mail-hook.ts): on each stop it files the session's last answer as the reply,
// then waits for the next message and hands it to the session as its next instruction.
//
//   node kernel/src/mail.ts send   --cell cells/<name> --body "…" [--from root]     → prints the message id
//   node kernel/src/mail.ts recv   --cell cells/<name> [--wait 600] [--for <id>]    → prints unread replies, marks them read
//   node kernel/src/mail.ts status --cell cells/<name>
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface Message { id: string; from: string; to: string; at: string; body: string; reply_to?: string }

const box = (cell: string, which: 'inbox' | 'outbox') => join(cell, which);
const ensure = (cell: string) => { for (const b of ['inbox', 'outbox'] as const) mkdirSync(join(box(cell, b), 'read'), { recursive: true }); };
// ids sort in send order: timestamp (ms) + a per-box sequence (two messages in the same ms still keep their order)
const count = (d: string) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).length : 0);
const newId = (dir: string) => `${new Date().toISOString().replace(/[-:.]/g, '').replace('Z', '')}-${String(count(dir) + count(join(dir, 'read')) + 1).padStart(5, '0')}-${randomBytes(2).toString('hex')}`;
const unread = (cell: string, which: 'inbox' | 'outbox'): Message[] => {
  const d = box(cell, which);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')));
};
const markRead = (cell: string, which: 'inbox' | 'outbox', id: string) => renameSync(join(box(cell, which), `${id}.json`), join(box(cell, which), 'read', `${id}.json`));
const cellName = (cell: string) => resolve(cell).replaceAll('\\', '/').split('/').at(-1)!;

export function send(cell: string, body: string, from = 'root'): Message {
  ensure(cell);
  const m: Message = { id: newId(box(cell, 'inbox')), from, to: cellName(cell), at: new Date().toISOString(), body };
  writeFileSync(join(box(cell, 'inbox'), `${m.id}.json`), JSON.stringify(m, null, 2) + '\n', { flag: 'wx' });
  return m;
}

export function receive(cell: string, forId?: string): Message[] {
  const got = unread(cell, 'outbox').filter((m) => !forId || m.reply_to === forId);
  for (const m of got) markRead(cell, 'outbox', m.id);
  return got;
}

// cell side ──────────────────────────────────────────────────────────────────────
const currentPath = (cell: string) => join(box(cell, 'inbox'), '.current');
export const current = (cell: string): string | null => (existsSync(currentPath(cell)) ? readFileSync(currentPath(cell), 'utf8').trim() || null : null);

// The session finished a turn: if it was working on a message, its last answer is the reply.
export function fileReply(cell: string, answer: string): Message | null {
  const id = current(cell);
  if (!id) return null;
  ensure(cell);
  const asked: Message = JSON.parse(readFileSync(join(box(cell, 'inbox'), 'read', `${id}.json`), 'utf8'));
  const m: Message = { id: newId(box(cell, 'outbox')), from: cellName(cell), to: asked.from, at: new Date().toISOString(), body: answer, reply_to: id };
  writeFileSync(join(box(cell, 'outbox'), `${m.id}.json`), JSON.stringify(m, null, 2) + '\n', { flag: 'wx' });
  rmSync(currentPath(cell));
  return m;
}

// Hand the oldest unread message to the session (marks it read and current).
export function takeNext(cell: string): Message | null {
  const [m] = unread(cell, 'inbox');
  if (!m) return null;
  markRead(cell, 'inbox', m.id);
  writeFileSync(currentPath(cell), m.id);
  return m;
}

// CLI ─────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
  const cell = resolve(opt('cell') ?? '.');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  if (cmd === 'send') {
    const body = opt('body') ?? (opt('file') ? readFileSync(opt('file')!, 'utf8') : '');
    if (!body.trim()) { console.error('send needs --body "…" or --file <path>'); process.exit(2); }
    const m = send(cell, body, opt('from') ?? 'root');
    console.log(m.id);
  } else if (cmd === 'recv') {
    const until = Date.now() + Number(opt('wait') ?? 0) * 1000;
    let got = receive(cell, opt('for'));
    while (!got.length && Date.now() < until) { await sleep(3000); got = receive(cell, opt('for')); }
    if (!got.length) { console.log('(no unread replies)'); process.exit(0); }
    for (const m of got) console.log(`── ${m.id} · reply to ${m.reply_to} · ${m.at}\n${m.body}\n`);
  } else if (cmd === 'status') {
    console.log(JSON.stringify({ inbox_unread: unread(cell, 'inbox').length, working_on: current(cell), outbox_unread: unread(cell, 'outbox').length }));
  } else {
    console.error('usage: mail.ts send|recv|status --cell <dir> …'); process.exit(2);
  }
}
