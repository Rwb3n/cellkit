// Run a cell's session headless, in its own worktree, for the mail queued to it. The default way to run a cell;
// an interactive terminal in the same folder is the fallback.
//
//   node kernel/src/cellrun.ts --cell <name> [--wait 0] [--model <m>] [--dry-run] [--root <repo>]
//
// Root sends a task with mail.ts as usual, then runs this (usually in the background). It starts
//   claude -p "waiting for mail" --permission-mode bypassPermissions --output-format stream-json --verbose
// in <cell worktree>/cells/<cell>, so the cell's own brief, hooks and Stop-hook mail loop apply: the first stop hands
// over the queued mail, the cell does it, and its final message is filed as the reply. CELLKIT_MAIL_WAIT is set to
// --wait seconds (default 0), so the session exits once its queue is empty: one run = the tasks queued now.
// Permission prompts are off (a headless session can't answer them); the cell's hooks are the guard rail.
//
// Refuses (exit 2) a cell with no worktree, (3) a cell already working on a message (another session is running it:
// never run headless and interactive for the same cell at once), (4) a cell with nothing queued.
// Otherwise exits with claude's code. The transcript (stream-json) goes to <mailbox>/runs/<UTC stamp>.jsonl.
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mailbox, status } from './mail.ts';
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
  return [which('claude'), '-p', PROMPT, '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose', ...(model ? ['--model', model] : [])];
}

function main(argv: string[]): number {
  const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const name = opt('cell');
  if (!name) { console.error('usage: cellrun.ts --cell <name> [--wait 0] [--model <m>] [--dry-run] [--root <repo>]'); return 2; }
  const wait = Number(opt('wait') ?? 0);
  if (!Number.isFinite(wait) || wait < 0) { console.error('cellrun: --wait takes seconds (>= 0)'); return 2; }
  const root = inMain(resolve(opt('root') ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..')));

  const wt = cellWorktree(root, name);
  if (!wt) { console.error(`cellrun: cell ${name} has no worktree (node kernel/src/cli.ts cell checkout --name ${name})`); return 2; }
  const cellDir = join(wt, 'cells', name);
  if (!existsSync(join(cellDir, 'binding.json'))) { console.error(`cellrun: ${cellDir} is not a cell folder`); return 2; }
  const st = status(cellDir);
  if (st.working_on) { console.error(`cellrun: ${name} is already working on ${st.working_on} (another session?); not starting a second`); return 3; }
  if (!st.unread) { console.error(`cellrun: no mail queued for ${name}`); return 4; }

  const cmd = command(opt('model'));
  const runs = join(mailbox(cellDir), 'runs');
  const log = join(runs, `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.jsonl`);
  if (argv.includes('--dry-run')) {
    console.log(`cwd ${cellDir}\nenv CELLKIT_MAIL_WAIT=${wait}\n${cmd.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\nlog ${log}`);
    return 0;
  }
  mkdirSync(runs, { recursive: true });
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
  const after = status(cellDir);
  console.log(`cellrun: ${name} exited ${r.status}; its inbox ${after.unread} unread, working_on ${after.working_on}; root inbox ${status(root).unread} unread`);
  return r.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
