// Run a cell's session headless, in its own worktree, for the mail queued to it. The default way to run a cell;
// an interactive terminal in the same folder is the fallback.
//
//   node kernel/src/cellrun.ts --cell <name> [--wait 0] [--hold 14400] [--model <m>] [--dry-run] [--root <repo>]
//
// Root sends a task with mail.ts as usual, then runs this (usually in the background). It starts
//   claude -p "waiting for mail" --permission-mode bypassPermissions --output-format stream-json --verbose --strict-mcp-config
// in <cell worktree>/cells/<cell>, so the cell's own brief, hooks and Stop-hook mail loop apply: the first stop hands
// over the queued mail, the cell does it, and its final message is filed as the reply. CELLKIT_MAIL_WAIT is set to
// --wait seconds (default 0), so the session exits once its queue is empty: one run = the tasks queued now.
// Permission prompts are off (a headless session can't answer them); the cell's hooks are the guard rail.
//
// Light on the machine (from AI-MMO, after the OS killed three runners for memory): the session loads no MCP servers
// (--strict-mcp-config: cells use none, and each starts its own helper processes), and a run is a queue, not a
// launcher. It holds <mailbox>/runner.lock for its life, so a second run for the same cell refuses (exit 5), and before
// starting it waits while MAX_RUNNERS sessions run (across cells) or free memory is under MIN_FREE_MB, polling every
// 30 s for --hold seconds (default 4 h: the wait must be as long as real work takes), then gives up (exit 6) with the
// mail still queued. A queued run costs only time; a killed one costs a half-finished worktree. The limits are a count,
// not "use all free memory", because the operator's other projects share the machine: tune them with
// CELLKIT_MAX_RUNNERS and CELLKIT_MIN_FREE_MB. Runs that are waiting don't count; the choice to start is made under
// one lock (<root's mailbox>/admission.lock), so two waiters never take the last slot together. A lock left by a run
// that is gone is taken over.
//
// Refuses (exit 2) a cell with no worktree, (3) a cell already working on a message (another session is running it:
// never run headless and interactive for the same cell at once), (4) a cell with nothing queued, (5) a cell with a
// live runner already, (6) no room within --hold.
// Otherwise exits with claude's code. The transcript (stream-json) goes to <mailbox>/runs/<UTC stamp>.jsonl.
// A run that ends with a message still in flight (crash, kill, API error: no final stop filed the reply) files a reply
// saying so, so root learns the task was not done and the cell is not left refusing every later run (exit 3).
// CELLKIT_CLAUDE names the claude executable (default: claude on PATH).
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { alive, lockFile, pause } from './log.ts';
import { dirOf, fileReply, mailbox, status } from './mail.ts';
import { cellWorktree, inMain } from './worktree.ts';

export const PROMPT = 'waiting for mail';

// The claude executable on PATH (with PATHEXT on Windows), else the bare name.
function which(name: string): string {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const d of (process.env.PATH ?? '').split(delimiter).filter(Boolean))
    for (const e of exts) if (existsSync(join(d, name + e.toLowerCase()))) return join(d, name + e.toLowerCase());
  return name;
}

export function command(model?: string): string[] {
  return [process.env.CELLKIT_CLAUDE || which('claude'), '-p', PROMPT, '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', ...(model ? ['--model', model] : [])];
}

// ── room on the machine ─────────────────────────────────────────────────────────
export const MAX_RUNNERS = Number(process.env.CELLKIT_MAX_RUNNERS ?? 3);    // sessions running at once, across cells
export const MIN_FREE_MB = Number(process.env.CELLKIT_MIN_FREE_MB ?? 4096); // don't start one below this much free memory
export const HOLD_S = 4 * 3600, POLL_S = 30;

interface Runner { pid: number; at: string; state: 'waiting' | 'running' }
const runnerLock = (cellDir: string) => join(mailbox(cellDir), 'runner.lock');
// The cell's live runner, if any (a lock whose process is gone is none).
export function runnerOf(cellDir: string): Runner | null {
  try { const r = JSON.parse(readFileSync(runnerLock(cellDir), 'utf8')) as Runner; return alive(r.pid) ? r : null; } catch { return null; }
}

// Take the cell's runner lock (state waiting), or say whose it is. A lock whose run is gone is taken over.
export function claimRunner(cellDir: string): string | null {
  mkdirSync(mailbox(cellDir), { recursive: true });
  for (let i = 0; i < 5; i++) {
    try { writeFileSync(runnerLock(cellDir), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), state: 'waiting' }), { flag: 'wx' }); return null; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    let raw = '';
    try { raw = readFileSync(runnerLock(cellDir), 'utf8'); } catch { continue; }
    const r = runnerOf(cellDir);
    if (r) return `a runner is already live for this cell (pid ${r.pid}, ${r.state} since ${r.at})`;
    // take over only the lock judged gone: if another run took it over first, the file now holds its own
    try { if (readFileSync(runnerLock(cellDir), 'utf8') === raw) rmSync(runnerLock(cellDir)); } catch { /* gone or changed: try again */ }
  }
  return 'could not take the runner lock';
}
const setRunner = (cellDir: string, state: Runner['state']) =>
  writeFileSync(runnerLock(cellDir), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), state }));
export function dropRunner(cellDir: string): void {
  try { if ((JSON.parse(readFileSync(runnerLock(cellDir), 'utf8')) as Runner).pid === process.pid) rmSync(runnerLock(cellDir)); } catch { /* gone */ }
}

// Sessions running now, across the repo's cells (a run still waiting for room doesn't count).
export function liveRunners(root: string): number {
  const cells = join(root, 'cells');
  if (!existsSync(cells)) return 0;
  return readdirSync(cells).map((n) => dirOf(root, n)).filter((d) => existsSync(join(d, 'binding.json')) && runnerOf(d)?.state === 'running').length;
}

// Why a session may not start yet, or null when it may.
export function room(freeMb: number, live: number, max = MAX_RUNNERS, minFree = MIN_FREE_MB): string | null {
  if (live >= max) return `${live} session(s) running (at most ${max}, CELLKIT_MAX_RUNNERS)`;
  if (freeMb < minFree) return `${freeMb} MB free (under ${minFree}, CELLKIT_MIN_FREE_MB)`;
  return null;
}
const freeMb = () => Math.floor(freemem() / 2 ** 20);

// Wait for room, then mark this run running; false if none came within holdS. The check and the mark are one step
// under the admission lock, so two waiters never both take the last slot.
export function admit(root: string, cellDir: string, name: string, holdS: number): boolean {
  const admission = join(mailbox(root), 'admission.lock');
  const until = Date.now() + holdS * 1000;
  let said = '';
  for (;;) {
    const why = lockFile(admission, () => { const w = room(freeMb(), liveRunners(root)); if (!w) setRunner(cellDir, 'running'); return w; });
    if (!why) return true;
    if (why !== said) { console.log(`cellrun: ${name} waiting for room: ${why}`); said = why; }
    if (Date.now() >= until) return false;
    pause(Math.min(POLL_S * 1000, until - Date.now()));
  }
}

function main(argv: string[]): number {
  const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const name = opt('cell');
  if (!name) { console.error('usage: cellrun.ts --cell <name> [--wait 0] [--hold 14400] [--model <m>] [--dry-run] [--root <repo>]'); return 2; }
  const wait = Number(opt('wait') ?? 0), hold = Number(opt('hold') ?? HOLD_S);
  if (!Number.isFinite(wait) || wait < 0) { console.error('cellrun: --wait takes seconds (>= 0)'); return 2; }
  if (!Number.isFinite(hold) || hold < 0) { console.error('cellrun: --hold takes seconds (>= 0)'); return 2; }
  const root = inMain(resolve(opt('root') ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..')));

  const wt = cellWorktree(root, name);
  if (!wt) { console.error(`cellrun: cell ${name} has no worktree (node kernel/src/cli.ts cell checkout --name ${name})`); return 2; }
  const cellDir = join(wt, 'cells', name);
  if (!existsSync(join(cellDir, 'binding.json'))) { console.error(`cellrun: ${cellDir} is not a cell folder`); return 2; }
  const st = status(cellDir);
  if (st.working_on) {
    console.error(`cellrun: ${name} is already working on ${st.working_on} (another session?); not starting a second. ` +
      `If no session is running (it died), file a placeholder reply and free the cell: node kernel/src/mail.ts release --as ${name}`);
    return 3;
  }
  if (!st.unread) { console.error(`cellrun: no mail queued for ${name}`); return 4; }

  const cmd = command(opt('model'));
  const runs = join(mailbox(cellDir), 'runs');
  const log = join(runs, `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.jsonl`);
  if (argv.includes('--dry-run')) {
    const why = room(freeMb(), liveRunners(root)), r = runnerOf(cellDir);
    console.log(`cwd ${cellDir}\nenv CELLKIT_MAIL_WAIT=${wait}\n${cmd.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\nlog ${log}\n` +
      `room ${r ? `no: a runner is already live for this cell (pid ${r.pid})` : why ? `not yet: ${why} (would wait up to ${hold} s)` : 'yes'}`);
    return 0;
  }
  const taken = claimRunner(cellDir);
  if (taken) { console.error(`cellrun: ${name}: ${taken}; not starting a second`); return 5; }
  try { return runSession(root, cellDir, name, wait, hold, cmd, log); } finally { dropRunner(cellDir); }
}

function runSession(root: string, cellDir: string, name: string, wait: number, hold: number, cmd: string[], log: string): number {
  if (!admit(root, cellDir, name, hold)) {
    console.error(`cellrun: ${name}: no room within ${hold} s; its mail is still queued. Run it again later, or raise --hold.`);
    return 6;
  }
  const st = status(cellDir);                          // the wait may have been long: look again
  if (st.working_on) { console.error(`cellrun: ${name} took ${st.working_on} in another session while this run waited; not starting a second`); return 3; }
  if (!st.unread) { console.error(`cellrun: no mail queued for ${name} any more`); return 4; }
  mkdirSync(dirname(log), { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, CELLKIT_MAIL_WAIT: String(wait) };
  delete env.CLAUDE_PROJECT_DIR;                       // the cell's folder is the project, not the caller's
  console.log(`cellrun: ${name} in ${cellDir}, ${st.unread} message(s) queued; log ${log}`);
  const out = openSync(log, 'w');
  // a .cmd/.bat shim can only be started through the shell (Node refuses it otherwise); quote every argument then
  const shim = /\.(cmd|bat)$/i.test(cmd[0]);
  const r = shim
    ? spawnSync(cmd.map((a) => `"${a}"`).join(' '), { cwd: cellDir, env, stdio: ['ignore', out, out], shell: true })
    : spawnSync(cmd[0], cmd.slice(1), { cwd: cellDir, env, stdio: ['ignore', out, out] });
  closeSync(out);
  if (r.error) { console.error(`cellrun: could not start ${cmd[0]}: ${r.error.message}`); return 1; }
  let after = status(cellDir);
  if (after.working_on) {
    const died = fileReply(cellDir, `(cellrun: the session exited ${r.status} without replying to ${after.working_on}. The task was not done; transcript ${log}. Resend it if it still matters.)`);
    console.error(`cellrun: ${name} exited with ${after.working_on} still in flight; filed ${died?.id} to say so`);
    after = status(cellDir);
  }
  console.log(`cellrun: ${name} exited ${r.status}; its inbox ${after.unread} unread, working_on ${after.working_on}; root inbox ${status(root).unread} unread`);
  return r.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
