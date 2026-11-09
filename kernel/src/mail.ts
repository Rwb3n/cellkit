// Mail between cells — files, not chat. Agents never write message structure; this module does.
// Every cell has a mailbox, root included (root = the repo root; a cell = cells/<name>):
//   <box>/inbox/<id>.json          unread  → <box>/inbox/read/<id>.json once taken
//   <box>/outbox/read/<id>.json    what this box sent (a record; never polled)
//   <box>/inbox/.current           the message a cell session is working on (its next stop = the reply)
//   <box>/runs/<stamp>.jsonl       a headless run's transcript (cellrun.ts)
// <box> is <git common dir>/cellkit-mail/<root|cell>/: shared by the main checkout and every cell worktree, inside no
// checkout, so root (in the main checkout) and a cell (in its worktree) reach the same box. Outside git (tests in a
// temp folder) it is the box's own folder.
// Addressed by name: --to root | --to <cell>. Replies go to the asker's inbox.
//
// Who may say what:
//   root → cell   task
//   cell → root   reply (written by the cell's Stop hook, never by hand) · blocked · question · done
// A cell can't send tasks, and can't write to another cell: no agent chatter.
//
//   node kernel/src/mail.ts send   --to <cell> --body "…" | --file f      (from root)
//   node kernel/src/mail.ts send   --to root --kind blocked|question|done --body "…"   (from inside a cell)
//   node kernel/src/mail.ts watch  [--as root] [--wait 600] [--for <id>] [--steal]   → prints unread mail, marks it
//                                  read; one watcher per box (exit 1 if another holds it, 3 if this one was taken over)
//   node kernel/src/mail.ts status [--as <name>]
//   node kernel/src/mail.ts release --as <cell> [--note "…"]   a session died mid-task: file a placeholder reply, free the cell
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { alive, append, AppendError, lockFile } from './log.ts';
import { sha256 } from './canon.ts';
import { configPath, loadConfig } from './config.ts';
import { cellWorktree, gitCommonDir, inMain } from './worktree.ts';
import { refold } from './refold.ts';

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

// The mailbox of the box at `dir` (see the header).
export const MAIL_DIR = 'cellkit-mail';
export function mailbox(dir: string): string {
  const d = resolve(dir), common = gitCommonDir(rootOf(d));
  return common ? join(common, MAIL_DIR, nameOf(d)) : d;
}
// The folder whose log records a box's mail, by name, so no checkout's copy of a log ever forks: root's log in the main
// checkout; a cell's in its worktree when it has one (its log travels on its branch), else the main checkout's copy.
export function logHome(root: string, name: string): string {
  const main = inMain(root);
  if (name === 'root') return main;
  const wt = cellWorktree(main, name);
  return wt ? join(wt, 'cells', name) : join(main, 'cells', name);
}

const inbox = (dir: string) => join(mailbox(dir), 'inbox');
const sent = (dir: string) => join(mailbox(dir), 'outbox', 'read');
export const ensure = (dir: string) => { mkdirSync(join(inbox(dir), 'read'), { recursive: true }); mkdirSync(sent(dir), { recursive: true }); };
const jsons = (d: string) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')) : []);
// ids sort in arrival order: timestamp (ms) + a per-box sequence (two messages in the same ms keep their order)
const newId = (dir: string) => `${new Date().toISOString().replace(/[-:.]/g, '').replace('Z', '')}-${String(jsons(inbox(dir)).length + jsons(join(inbox(dir), 'read')).length + 1).padStart(5, '0')}-${randomBytes(2).toString('hex')}`;
const unread = (dir: string): Message[] => jsons(inbox(dir)).sort().map((f) => JSON.parse(readFileSync(join(inbox(dir), f), 'utf8')));
const markRead = (dir: string, id: string) => renameSync(join(inbox(dir), `${id}.json`), join(inbox(dir), 'read', `${id}.json`));

// ── sending ──────────────────────────────────────────────────────────────────────
export function send(fromDir: string, to: string, body: string, kind: MailKind = 'task', reply_to?: string): Message {
  const from = nameOf(fromDir), root = inMain(rootOf(fromDir));
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
  // the files are transport; the log is the record, on both sides. A task reaches the cell's log when it is handed over
  // (takeNext), not now: a session that read its log found a task queued there, did it before the Stop hook handed it
  // over, then did it again and its first answer was lost (01-HAIOS-PERS, project-archivist).
  logMail(root, logHome(root, from), m);
  if (to === 'root') logMail(root, logHome(root, to), m);
  return m;
}

// One observation per message, on a box's own log: the body itself, or (bedrock guards.json mail.log "hash") its sha256
// and length, the body then living in the mailbox alone. Two sessions (root and a cell's Stop hook) can append to the
// same log at once; the kernel's `wx` refuses a clash, so re-read and retry.
function logMail(root: string, dir: string, m: Message): void {
  const body = loadConfig(configPath(inMain(root))).mailLog === 'hash' ? { body_sha256: sha256(m.body), body_chars: m.body.length } : { body: m.body };
  for (let attempt = 1; ; attempt++) {
    try {
      append(dir, { kind: 'observation', body: { source: { adapter: 'kernel', provider: 'mail', capability: 'mail' }, observed_at: m.at, reliability: [], licence: { store: 'full' },
        payload: { id: m.id, kind: m.kind, from: m.from, to: m.to, ...(m.reply_to ? { reply_to: m.reply_to } : {}), ...body } } });
      // every write refolds (#7); views are disposable, so a failed refold never fails the mail (lint will say)
      try { refold(dir); } catch { /* lint: views are stale */ }
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

// One watcher per box (#90). `watch` marks what it prints as read, so of two watchers on one box whichever wakes first
// takes the reply, and the other, the one someone is reading, never sees it (ecom-lab: a second `watch --as root` with
// its output thrown away, started while a background one waited for a cell's reply). A watch holds
// <box>/inbox/watch.lock for its life (watch-<id>.lock with --for <id>: it takes only replies to that message, so watchers
// for different messages run side by side). A second one that could take the same mail is refused, naming the first;
// --steal takes over, and the first then ends without taking anything. A lock whose process is gone counts for nothing.
// Claims, and each take of mail by a watcher, are made under one short lock, so two claimers never both win and a
// watcher that has just been taken over never takes mail. Pids are reused: a lock left by a killed watcher can come to
// name a live process that is no watcher (the refusal says so, and --steal clears it), or this very process (a lock
// with our pid that we didn't write is nobody's).
export interface Watcher { pid: number; at: string; for?: string }
const watchPath = (dir: string, forId?: string) => join(inbox(dir), forId ? `watch-${forId}.lock` : 'watch.lock');
const claimLock = (dir: string) => join(inbox(dir), 'watch.claim');
const claimed = new Set<string>();   // the lock files this process wrote
export function watchers(dir: string): (Watcher & { path: string })[] {
  const box = inbox(dir);
  return (existsSync(box) ? readdirSync(box) : []).filter((f) => /^watch(-.+)?\.lock$/.test(f)).flatMap((f) => {
    try {
      const w = JSON.parse(readFileSync(join(box, f), 'utf8')) as Watcher, path = join(box, f);
      const live = Number.isInteger(w.pid) && w.pid > 0 && (w.pid === process.pid ? claimed.has(path) : alive(w.pid));
      return live ? [{ ...w, path }] : [];
    }
    catch { return []; }
  });
}
export function claimWatch(dir: string, o: { forId?: string; steal?: boolean } = {}): { take: () => Message[] | null; release: () => void } {
  if (o.forId !== undefined && !/^\w[\w-]*$/.test(o.forId)) throw new MailError(`--for takes a message id, not ${JSON.stringify(o.forId)}`);
  ensure(dir);
  const own = watchPath(dir, o.forId);
  const mine = () => { try { return (JSON.parse(readFileSync(own, 'utf8')) as Watcher).pid === process.pid; } catch { return false; } };
  lockFile(claimLock(dir), () => {
    // who could take the same mail: anyone, for a watch of the whole box; else a whole-box watch or one for the same message
    const rivals = watchers(dir).filter((w) => !o.forId || !w.for || w.for === o.forId);
    if (rivals.length && !o.steal) {
      const [w] = rivals;
      throw new MailError(`${nameOf(dir)}'s mail is already being watched (pid ${w.pid} since ${w.at}${w.for ? `, for ${w.for}` : ''}): a second watcher could take the mail the first is waiting for. ` +
        `Let it finish, or take over with --steal: the first then ends without taking anything. If pid ${w.pid} is not a mail watch (a killed watcher's lock, its pid since reused), --steal clears it too`);
    }
    for (const w of rivals) { rmSync(w.path, { force: true }); claimed.delete(w.path); }
    claimed.add(own);
    writeFileSync(own, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...(o.forId ? { for: o.forId } : {}) }));
  });
  return {
    take: () => lockFile(claimLock(dir), () => (mine() ? receive(dir, o.forId) : null)),      // null: taken over
    release: () => lockFile(claimLock(dir), () => { if (mine()) rmSync(own, { force: true }); claimed.delete(own); }),
  };
}

// ── a cell session's side (used by mail-hook.ts) ────────────────────────────────
const currentPath = (cell: string) => join(inbox(cell), '.current');
export const current = (cell: string): string | null => (existsSync(currentPath(cell)) ? readFileSync(currentPath(cell), 'utf8').trim() || null : null);

// An answer that reads as a progress note, not a reply: short, and saying it's waiting or still running. A cell that
// ends its turn with a background job running ("The test suite is still running. I'll write the reply once it
// finishes.") had that filed as its reply (SF-DEV, four times; AI-MMO #112), though the brief says work synchronously.
export const HOLD_MAX = 3;
const INTERIM = /\b(waiting (for|on|until)|still (running|building|going|working|in progress)|(is|are) (still )?running|in progress|once (it|the|they|that)\b[^.]*\b(finish|finishes|completes?|is done|are done|returns?)|(I'll|I will|will) (report|reply|write|update|follow up|let you know|get back)|be back)\b/i;
export const interim = (answer: string) => answer.trim().length < 400 && INTERIM.test(answer);
const heldPath = (cell: string, id: string) => join(inbox(cell), `.held-${id}`);

// The reason to send the session back to finish instead of filing its answer, or null to file it. At most HOLD_MAX
// times per message (a counter in the mailbox); after that the answer is filed as it is.
export function hold(cell: string, answer: string): string | null {
  const id = current(cell);
  if (!id || !interim(answer)) return null;
  const n = existsSync(heldPath(cell, id)) ? Number(readFileSync(heldPath(cell, id), 'utf8')) || 0 : 0;
  if (n >= HOLD_MAX) return null;
  writeFileSync(heldPath(cell, id), String(n + 1));
  return `Not sent as your reply: it reads as a progress note, and your final message is filed as the reply to ${id}. ` +
    `Don't end your turn while something you started is still running: wait for it (run it in the foreground, or check its output until it's done), ` +
    `finish the task, then end with the full reply the task asks for.`;
}

// The session finished a turn: if it was working on a task, its last answer is the reply (to the asker's inbox).
export function fileReply(cell: string, answer: string): Message | null {
  const id = current(cell);
  if (!id) return null;
  const asked: Message = JSON.parse(readFileSync(join(inbox(cell), 'read', `${id}.json`), 'utf8'));
  rmSync(currentPath(cell));
  rmSync(heldPath(cell, id), { force: true });
  return send(cell, asked.from, answer || '(no answer text)', 'reply', id);
}

// Hand the oldest unread task to the session (marks it read and current), and record it on the cell's log now.
export function takeNext(cell: string): Message | null {
  const [m] = unread(cell);
  if (!m) return null;
  markRead(cell, m.id);
  writeFileSync(currentPath(cell), m.id);
  const root = inMain(rootOf(cell));
  logMail(root, logHome(root, nameOf(cell)), m);
  return m;
}

// The message with this id from a box's read inbox (its body: what cellrun --resume hands a fresh session).
export function message(dir: string, id: string): Message | null {
  const p = join(inbox(dir), 'read', `${id}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

// A headless run's lock, <mailbox>/runner.lock (cellrun.ts writes it): the runner's pid, and once started its session's.
// The runner can die while its session works on (a kill aimed at another project's processes took every runner on
// AI-MMO's machine): the session is then an orphan, and the lock stays live until it ends.
export interface Runner { pid: number; at: string; state: 'waiting' | 'running'; session?: number; log?: string }
export const runnerLock = (cell: string) => join(mailbox(cell), 'runner.lock');
export function runnerOf(cell: string): (Runner & { orphan: boolean }) | null {
  let r: Runner;
  try { r = JSON.parse(readFileSync(runnerLock(cell), 'utf8')); } catch { return null; }
  if (alive(r.pid)) return { ...r, orphan: false };
  if (r.session && alive(r.session)) return { ...r, orphan: true };
  return null;
}

// A cell's session died while working on a message (nothing will ever file its reply): file a placeholder reply so the
// asker learns the task was not done, and the cell can take mail again. Refused while a headless run or its orphaned
// session is live. cellrun --resume first: it recovers the reply from the run log, or a fresh session finishes the task.
export function release(cell: string, note = '(released: the session ended without a reply; the task was not done)'): Message | null {
  const r = runnerOf(cell);
  if (r) throw new MailError(`${nameOf(cell)} has a live ${r.orphan ? `orphaned session (pid ${r.session}, its runner gone)` : `run (pid ${r.pid})`}; let it finish. If that pid is not a claude session or cellrun (pids are reused), delete ${runnerLock(cell)}`);
  return fileReply(cell, note);
}

// working_on with no live run: a session that died mid-task (or an interactive one: only the operator knows).
export const status = (dir: string) => {
  const working_on = current(dir), r = isCell(dir) ? runnerOf(dir) : null;
  const w = watchers(dir);
  return { box: nameOf(dir), unread: unread(dir).length, working_on,
    run: r ? (r.orphan ? `orphaned session ${r.session}` : `${r.state} (pid ${r.pid})`) : working_on ? 'none: died, or interactive (cellrun --resume)' : null,
    ...(w.length ? { watched_by: w.map((x) => `pid ${x.pid} since ${x.at}${x.for ? ` for ${x.for}` : ''}`).join(' · ') } : {}) };
};

// ── CLI ──────────────────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
  const here = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const me = isCell(here) ? here : repo;                       // run from a cell → you are that cell; else root
  // a name that is no cell is nobody's box: its folder, once made, would read as root's (nameOf), and take root's mail
  const boxOf = (name?: string) => {
    if (name && name !== 'root' && !isCell(dirOf(rootOf(me), name))) throw new MailError(`no cell named ${name}`);
    return name ? dirOf(rootOf(me), name) : me;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    if (cmd === 'send') {
      const to = opt('to');
      if (!to) throw new MailError('send needs --to <root|cell>');
      const body = opt('body') ?? (opt('file') ? readFileSync(opt('file')!, 'utf8') : '');
      console.log(send(me, to, body, (opt('kind') as MailKind) ?? (nameOf(me) === 'root' ? 'task' : 'question')).id);
    } else if (cmd === 'watch' || cmd === 'recv') {
      const box = boxOf(opt('as')), until = Date.now() + Number(opt('wait') ?? 0) * 1000;
      if (rest.includes('--for') && opt('for') === undefined) throw new MailError('--for takes a message id, not nothing');
      const watch = claimWatch(box, { forId: opt('for'), steal: rest.includes('--steal') });
      try {
        let got = watch.take();
        while (got && !got.length && Date.now() < until) { await sleep(3000); got = watch.take(); }
        if (!got) { console.error('watch ended: another watcher took this box over (--steal); nothing was taken here'); process.exitCode = 3; }
        else if (!got.length) console.log('(no unread mail)');
        for (const m of got ?? []) console.log(`── ${m.kind} from ${m.from} · ${m.id}${m.reply_to ? ` · re ${m.reply_to}` : ''} · ${m.at}\n${m.body}\n`);
      } finally { watch.release(); }
    } else if (cmd === 'release') {
      if (!opt('as') || opt('as') === 'root') throw new MailError('release needs --as <cell>');
      const m = release(boxOf(opt('as')), opt('note'));
      console.log(m ? `released: filed ${m.id} as the reply to ${m.reply_to}` : `${opt('as')} is not working on a message`);
    } else if (cmd === 'status') {
      console.log(JSON.stringify(status(boxOf(opt('as')))));
    } else {
      throw new MailError('usage: mail.ts send|watch|status|release …');
    }
  } catch (e) {
    if (e instanceof MailError) { console.error(`refused: ${e.message}`); process.exit(1); }
    // the short lock around a claim, held too long: a process stuck in it, or a leftover whose pid was reused
    if (e instanceof AppendError && /watch\.claim/.test(e.message)) { console.error(`refused: the box's watch lock is busy: ${e.message}. If that pid is not a mail watch, delete that file`); process.exit(1); }
    throw e;
  }
}
