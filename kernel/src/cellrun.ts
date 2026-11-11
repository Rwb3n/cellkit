// Run a cell's session headless, in its own worktree, for the mail queued to it. The default way to run a cell;
// an interactive terminal in the same folder is the fallback.
//
//   node kernel/src/cellrun.ts --cell <name> [--resume] [--wait 0] [--hold 14400] [--model <m>] [--effort <level>] [--dry-run] [--root <repo>]
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
// live runner already, (6) no room within --hold, (7) merging main into the worktree failed (aborted; the mail is still queued).
// Otherwise exits with claude's code, or (8) when claude exited 0 and a reply is not coming: a task still in flight
// with no answer in the log, or one found taken, unanswered and not in flight (root is told by mail either way: #101). The transcript (stream-json) goes to <mailbox>/runs/<UTC stamp>.jsonl.
// The run's lock records the session's pid too: a runner can die while its session works on (AI-MMO: a kill by process
// name from another project took every runner), and that orphan keeps the lock, counts toward MAX_RUNNERS, and makes a
// new run and `mail.ts release` refuse until it ends. Every run leaves <log>.exit (how it ended; none: killed hard).
// A run that ends with a message still in flight (the Stop hook never filed it) first looks in its log: a session that
// finished its answer has it filed from there, marked recovered. Otherwise (it died mid-task) the cell keeps the task,
// with its partial work in the worktree, and root is told (a "blocked" mail): `--resume` recovers the answer from the
// last run's log if it is there, else starts a fresh session that is told the task and its partial work, and whose
// reply is filed to the original. `mail.ts release` (give up, resend) stays the last resort. project-archivist had a
// cell stuck seven days on a run killed with its parent session.
//
// Cells are kept level (from AI-MMO, DEC-0013): once admitted, and before the session starts, the run merges the main
// checkout's branch into the cell's worktree, so the task starts on main as it is (its kernel, hooks and briefs; SF-DEV's
// cells ran on old copies until root merged by hand). Only a clean worktree (nothing uncommitted, untracked included)
// that is not mid-merge is merged; a dirty one (work not landed yet, a resumed task) is left alone and said so, never a
// merge over a cell's work. Nor when main changed a file the worktree holds as an ignored file: git status doesn't see
// it and a merge would overwrite it silently. A conflict is aborted (and checked: MERGE_HEAD gone) and the run stops
// (exit 7) with the mail still queued, as does a merge that fails without starting. It prints what it did.
// CELLKIT_CLAUDE names the claude executable (default: claude on PATH).
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { alive, lockFile, pause } from './log.ts';
import { dirOf, fileReply, mailbox, markTold, message, runnerLock, runnerOf, send, status, told, unanswered, type Runner } from './mail.ts';
import { refoldPresent } from './refold.ts';
import { cellWorktree, currentBranch, inMain } from './worktree.ts';

export const PROMPT = 'waiting for mail';

// The claude executable on PATH (with PATHEXT on Windows), else the bare name.
function which(name: string): string {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const d of (process.env.PATH ?? '').split(delimiter).filter(Boolean))
    for (const e of exts) if (existsSync(join(d, name + e.toLowerCase()))) return join(d, name + e.toLowerCase());
  return name;
}

export function command(model?: string, prompt = PROMPT, effort?: string): string[] {
  return [process.env.CELLKIT_CLAUDE || which('claude'), '-p', prompt, '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
}

// --resume's prompt. One line, no double quotes: a .cmd shim passes it through cmd.exe. The task itself is in a file.
export const resumePrompt = (id: string, task: string) =>
  `Your previous session died while working on task ${id}; its partial work is uncommitted in this worktree. ` +
  `Read the task in ${task}, review what was done (git status, git diff), finish the task as it asks, and end your turn with the full reply, as you would have.`;

// ── room on the machine ─────────────────────────────────────────────────────────
export const MAX_RUNNERS = Number(process.env.CELLKIT_MAX_RUNNERS ?? 3);    // sessions running at once, across cells
export const MIN_FREE_MB = Number(process.env.CELLKIT_MIN_FREE_MB ?? 4096); // don't start one below this much free memory
export const HOLD_S = 4 * 3600, POLL_S = 30;

// Take the cell's runner lock (state waiting), or say whose it is. A lock whose run and session are both gone is taken
// over; an orphaned session (its runner gone, the session still working) keeps it.
export function claimRunner(cellDir: string): string | null {
  mkdirSync(mailbox(cellDir), { recursive: true });
  for (let i = 0; i < 5; i++) {
    try { writeFileSync(runnerLock(cellDir), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), state: 'waiting' }), { flag: 'wx' }); return null; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    let raw = '';
    try { raw = readFileSync(runnerLock(cellDir), 'utf8'); } catch { continue; }
    const r = runnerOf(cellDir);
    if (r?.orphan) return `an orphaned session (pid ${r.session}; its runner, pid ${r.pid}, is gone) is still working in this cell. Let it finish, or end it (Windows: taskkill /PID ${r.session} /T /F; else kill ${r.session}). If that pid is not a claude session (pids are reused), delete ${runnerLock(cellDir)}`;
    if (r) return `a runner is already live for this cell (pid ${r.pid}, ${r.state} since ${r.at})`;
    // take over only the lock judged gone: if another run took it over first, the file now holds its own
    try { if (readFileSync(runnerLock(cellDir), 'utf8') === raw) rmSync(runnerLock(cellDir)); } catch { /* gone or changed: try again */ }
  }
  return 'could not take the runner lock';
}
function setRunner(cellDir: string, state: Runner['state'], extra: Partial<Runner> = {}): void {
  let was: Partial<Runner> = {};
  try { was = JSON.parse(readFileSync(runnerLock(cellDir), 'utf8')); } catch { /* new */ }
  writeFileSync(runnerLock(cellDir), JSON.stringify({ ...was, pid: process.pid, at: new Date().toISOString(), state, ...extra }));
}
// Drop the lock if it is this run's, unless its session still works (then the lock names an orphan to come).
export function dropRunner(cellDir: string): void {
  try {
    const r = JSON.parse(readFileSync(runnerLock(cellDir), 'utf8')) as Runner;
    if (r.pid === process.pid && !(r.session && alive(r.session))) rmSync(runnerLock(cellDir));
  } catch { /* gone */ }
}

// Sessions running now, across the repo's cells, orphans included (a run still waiting for room doesn't count).
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

// ── keeping the cell level with main ───────────────────────────────────────────
function git(dir: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout + r.stderr).trim() };
}
const midMerge = (wt: string) => existsSync(resolve(wt, git(wt, ['rev-parse', '--git-path', 'MERGE_HEAD']).out));

// Merge the main checkout's branch into the cell's worktree when that is safe; ok false (with why) only when a merge
// was tried and failed. dryRun says what it would do.
export function level(root: string, wt: string, dryRun = false): { ok: boolean; say: string } {
  const branch = currentBranch(root);
  const head = git(root, ['rev-parse', '--verify', '-q', `${branch}^{commit}`]);
  if (!head.ok) return { ok: true, say: `not levelled: no branch ${branch} in the main checkout` };
  const sha = head.out, short = sha.slice(0, 7);
  if (midMerge(wt)) return { ok: true, say: `not levelled with ${branch} ${short}: the worktree is mid-merge (left alone)` };
  const dirty = git(wt, ['status', '--porcelain=v1', '-uall']);
  if (!dirty.ok) return { ok: true, say: `not levelled: git status failed: ${dirty.out}` };
  if (dirty.out) {
    const n = dirty.out.split(/\r?\n/).length;
    return { ok: true, say: `not levelled with ${branch} ${short}: ${n} uncommitted path(s) in the worktree (land the cell's work first; never a merge over it)` };
  }
  const base = git(wt, ['merge-base', 'HEAD', sha]).out;
  if (base === sha) return { ok: true, say: `already level with ${branch} ${short}` };
  const changed = git(wt, ['diff', '--name-only', base, sha]).out.split(/\r?\n/).filter(Boolean);
  const inTheWay = changed.filter((p) => existsSync(join(wt, p)) && git(wt, ['check-ignore', '-q', p]).ok);
  if (inTheWay.length) return { ok: true, say: `not levelled with ${branch} ${short}: ${branch} changed file(s) the worktree holds as ignored files, which a merge would overwrite: ${inTheWay.join(', ')} (move them, then run again)` };
  if (dryRun) return { ok: true, say: `would merge ${branch} ${short} into the worktree` };
  const merged = git(wt, ['merge', '-q', '--no-edit', sha]);
  if (merged.ok) {
    // the merge brought main's log entries in; the views here are git-ignored and still as folded before it (#102)
    let behind: string[] = [], failed = '';
    try { behind = refoldPresent(wt); } catch (e) { failed = (e as Error).message; }
    return { ok: true, say: `merged ${branch} ${short} into the worktree${behind.length ? `; rebuilt its views from the merged log (${behind.join(', ')})` : ''}${failed ? `; its views could not be rebuilt (${failed}): run fold there` : ''}` };
  }
  const tail = merged.out.split(/\r?\n/).slice(-8).map((l) => `    ${l}`).join('\n');
  if (!midMerge(wt)) return { ok: false, say: `merging ${branch} ${short} failed before it started (not a conflict); the worktree is as it was. Fix what git says, then run again:\n${tail}` };
  const unmerged = git(wt, ['diff', '--name-only', '--diff-filter=U']).out.split(/\r?\n/).filter(Boolean);
  const abort = git(wt, ['merge', '--abort']);
  if (!abort.ok || midMerge(wt)) return { ok: false, say: `merging ${branch} ${short} failed and merge --abort failed too: the worktree is MID-MERGE, look at it (git status):\n${tail}\n    ${abort.out}` };
  return { ok: false, say: `merging ${branch} ${short} conflicts in ${unmerged.join(', ') || '(see below)'}; aborted, the worktree is as it was. Land the cell's work or merge by hand in ${wt}, then run again:\n${tail}` };
}

// ── a run's log ─────────────────────────────────────────────────────────────────
// The session's final answer in a run log (stream-json: a "result" line, subtype success), written after the task was
// handed over: after the last line naming the task's id, or anywhere in a --resume run (its prompt named it). Null when
// the session never finished a turn after taking it (it died mid-task).
export function recoverAnswer(log: string, id: string, resumed = false): string | null {
  if (!existsSync(log)) return null;
  const lines = readFileSync(log, 'utf8').split(/\r?\n/);
  const from = resumed ? 0 : lines.findLastIndex((l) => l.includes(id));   // the hand-over line (or the answer itself)
  if (from < 0) return null;
  for (let i = lines.length - 1; i >= from; i--) {
    try {
      const e = JSON.parse(lines[i]) as { type?: string; subtype?: string; is_error?: boolean; result?: unknown };
      if (e.type === 'result') return e.subtype === 'success' && !e.is_error && typeof e.result === 'string' && e.result.trim() ? e.result : null;
    } catch { /* not JSON */ }
  }
  return null;
}
// A --resume run for this task: its task file (beside its log) names it. Another task's resume run is no source.
const resumedFor = (log: string, id: string) => {
  try { return readFileSync(log.replace(/\.jsonl$/, '.task.md'), 'utf8').startsWith(`# Task ${id} `); } catch { return false; }
};
const runLogs = (cellDir: string) => {
  const d = join(mailbox(cellDir), 'runs');
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.jsonl')).sort().map((f) => join(d, f)) : [];
};
// How a run ended, beside its log (<log>.exit). A log with no exit note: its runner was killed hard.
const exitNote = (log: string, note: Record<string, unknown>) => { try { writeFileSync(`${log}.exit`, JSON.stringify({ at: new Date().toISOString(), ...note }) + '\n'); } catch { /* best effort */ } };

async function main(argv: string[]): Promise<number> {
  const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const name = opt('cell'), resume = argv.includes('--resume');
  if (!name) { console.error('usage: cellrun.ts --cell <name> [--resume] [--wait 0] [--hold 14400] [--model <m>] [--effort <level>] [--dry-run] [--root <repo>]'); return 2; }
  const wait = Number(opt('wait') ?? 0), hold = Number(opt('hold') ?? HOLD_S);
  if (!Number.isFinite(wait) || wait < 0) { console.error('cellrun: --wait takes seconds (>= 0)'); return 2; }
  if (!Number.isFinite(hold) || hold < 0) { console.error('cellrun: --hold takes seconds (>= 0)'); return 2; }
  const effort = opt('effort');
  if (effort !== undefined && !/^(low|medium|high|xhigh|max)$/.test(effort)) { console.error('cellrun: --effort takes low, medium, high, xhigh or max'); return 2; }
  const root = inMain(resolve(opt('root') ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..')));

  const wt = cellWorktree(root, name);
  if (!wt) { console.error(`cellrun: cell ${name} has no worktree (node kernel/src/cli.ts cell checkout --name ${name})`); return 2; }
  const cellDir = join(wt, 'cells', name);
  if (!existsSync(join(cellDir, 'binding.json'))) { console.error(`cellrun: ${cellDir} is not a cell folder`); return 2; }
  const st = status(cellDir);
  if (resume && !st.working_on) { console.error(`cellrun: ${name} is not working on a message: nothing to resume`); return 4; }
  if (!resume && st.working_on) {
    console.error(`cellrun: ${name} is already working on ${st.working_on} (run: ${st.run}); not starting a second. ` +
      `If its session died: node kernel/src/cellrun.ts --cell ${name} --resume (recovers the reply from the run log, or a fresh session finishes the task)`);
    return 3;
  }
  if (!resume && !st.unread) { console.error(`cellrun: no mail queued for ${name}`); return 4; }

  const runs = join(mailbox(cellDir), 'runs');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const log = join(runs, `${stamp}.jsonl`), task = join(runs, `${stamp}.task.md`);
  const cmd = command(opt('model'), resume ? resumePrompt(st.working_on!, task) : PROMPT, effort);
  if (argv.includes('--dry-run')) {
    const why = room(freeMb(), liveRunners(root)), r = runnerOf(cellDir);
    console.log(`cwd ${cellDir}\nenv CELLKIT_MAIL_WAIT=${wait}\n${cmd.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\nlog ${log}\nlevel ${level(root, wt, true).say}\n` +
      `room ${r ? `no: ${r.orphan ? `an orphaned session (pid ${r.session})` : `a runner (pid ${r.pid})`} is already live for this cell` : why ? `not yet: ${why} (would wait up to ${hold} s)` : 'yes'}`);
    return 0;
  }
  const taken = claimRunner(cellDir);
  if (taken) { console.error(`cellrun: ${name}: ${taken}; not starting a second`); return 5; }
  try {
    if (resume) {
      // the session may have finished its answer before it (or its runner) died: file that, no new session needed
      const id = st.working_on!;
      for (const l of runLogs(cellDir).reverse()) {
        const answer = recoverAnswer(l, id, resumedFor(l, id));
        if (!answer) continue;
        const m = fileReply(cellDir, `${answer}\n\n(recovered by cellrun from ${l}: the session finished but its reply was never filed)`);
        console.log(`cellrun: ${name}: recovered the reply to ${id} from ${l}; filed ${m?.id}`);
        return 0;
      }
      const asked = message(cellDir, id);
      mkdirSync(runs, { recursive: true });
      writeFileSync(task, `# Task ${id} (from ${asked?.from ?? 'root'}, ${asked?.at ?? '?'})\n\n${asked?.body ?? '(not found: ask root)'}\n`);
    }
    return await runSession(root, wt, cellDir, name, wait, hold, cmd, log, resume);
  } finally { dropRunner(cellDir); }
}

async function runSession(root: string, wt: string, cellDir: string, name: string, wait: number, hold: number, cmd: string[], log: string, resume: boolean): Promise<number> {
  if (!admit(root, cellDir, name, hold)) {
    console.error(`cellrun: ${name}: no room within ${hold} s; its mail is still queued. Run it again later, or raise --hold.`);
    return 6;
  }
  const st = status(cellDir);                          // the wait may have been long: look again
  if (!resume && st.working_on) { console.error(`cellrun: ${name} took ${st.working_on} in another session while this run waited; not starting a second`); return 3; }
  if (!resume && !st.unread) { console.error(`cellrun: no mail queued for ${name} any more`); return 4; }
  const levelled = level(root, wt);
  if (!levelled.ok) { console.error(`cellrun: ${name}: ${levelled.say}\nIts mail is still queued; the session was not started.`); return 7; }
  console.log(`cellrun: ${name}: ${levelled.say}`);
  mkdirSync(dirname(log), { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, CELLKIT_MAIL_WAIT: String(wait) };
  delete env.CLAUDE_PROJECT_DIR;                       // the cell's folder is the project, not the caller's
  console.log(`cellrun: ${name} in ${cellDir}, ${resume ? `resuming ${st.working_on}` : `${st.unread} message(s) queued`}; log ${log}`);
  const out = openSync(log, 'w');
  // a .cmd/.bat shim can only be started through the shell (Node refuses it otherwise); quote every argument then
  const shim = /\.(cmd|bat)$/i.test(cmd[0]);
  const child = shim
    ? spawn(cmd.map((a) => `"${a}"`).join(' '), { cwd: cellDir, env, stdio: ['ignore', out, out], shell: true })
    : spawn(cmd[0], cmd.slice(1), { cwd: cellDir, env, stdio: ['ignore', out, out] });
  if (child.pid) setRunner(cellDir, 'running', { session: child.pid, log });
  // the runner interrupted: say so beside the log; the lock stays while the session works (an orphan, not a free cell)
  const interrupted = (signal: string) => {
    exitNote(log, { runner: signal, session: child.pid, session_alive: !!child.pid && alive(child.pid) });
    dropRunner(cellDir);
    process.exit(130);
  };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(s, interrupted);
  const r = await new Promise<{ code: number | null; signal: string | null; error?: Error }>((done) => {
    child.on('error', (error) => done({ code: null, signal: null, error }));
    child.on('exit', (code, signal) => done({ code, signal }));
  });
  for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.off(s, interrupted);
  closeSync(out);
  const flag = (f: string) => (cmd.includes(f) ? { [f.slice(2)]: cmd[cmd.indexOf(f) + 1] } : {});
  exitNote(log, { code: r.code, signal: r.signal, ...flag('--model'), ...flag('--effort'), ...(r.error ? { error: r.error.message } : {}) });
  if (r.error) { console.error(`cellrun: could not start ${cmd[0]}: ${r.error.message}`); return 1; }

  let after = status(cellDir);
  if (after.working_on) {
    const id = after.working_on, answer = recoverAnswer(log, id, resume);
    if (answer) {
      const m = fileReply(cellDir, `${answer}\n\n(recovered by cellrun from ${log}: the session finished but its reply was never filed)`);
      console.error(`cellrun: ${name} exited with ${id} unfiled; recovered its answer from the run log and filed ${m?.id}`);
    } else {
      // died mid-task: the cell keeps the task (its partial work is in the worktree) and root is told how to go on
      const m = send(cellDir, 'root', `cellrun: ${name}'s session exited (${r.code ?? r.signal}) while working on ${id}, without a reply. ` +
        `Its partial work is uncommitted in the worktree. Resume it: node kernel/src/cellrun.ts --cell ${name} --resume ` +
        `(or give up on it: node kernel/src/mail.ts release --as ${name}, then resend). Transcript: ${log}`, 'blocked');
      console.error(`cellrun: ${name} exited with ${id} still in flight; told root (${m.id}): resume with --resume`);
    }
    after = status(cellDir);
  }
  // A task the cell took that is neither answered nor in flight (#101): no reply is coming, and an exit code of 0 with
  // nothing in flight would read as done. Root is told where to look, once per task (a mark in the box), whichever run
  // finds it: this one's, or one left by a run that was interrupted or by an interactive session. The run then exits 8.
  const lost = unanswered(cellDir).filter((id) => !told(cellDir, id));
  for (const id of lost) {
    const m = send(cellDir, 'root', `cellrun: ${name} took task ${id}, and it has no reply and is not in flight: no reply is coming. ` +
      `Found at the end of the run that exited ${r.code ?? r.signal}; what was done, if anything, is uncommitted in the worktree (git status there) and in the transcript: ${log} ` +
      `(a task an earlier run took is in an earlier transcript, in the same folder). ` +
      `Read them, then record what you found as its reply: node kernel/src/mail.ts release --as ${name} --for ${id} --note "…" (then send the task again if it still needs doing)`, 'blocked');
    markTold(cellDir, id);
    console.error(`cellrun: ${name} took ${id} and left it unanswered; told root (${m.id})`);
  }
  console.log(`cellrun: ${name} exited ${r.code ?? r.signal}; its inbox ${after.unread} unread, working_on ${after.working_on}; root inbox ${status(root).unread} unread`);
  // the same for a task still in flight that the log held no answer to: root was told above, and 0 would read as done
  return (r.code ?? 1) === 0 && (lost.length || after.working_on) ? 8 : r.code ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
