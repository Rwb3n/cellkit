// Claude Code PreToolUse hook for Bash.
// 1. The agent may not approve bedrock: `approve` must come from the operator's own prompt
//    (`! node kernel/src/cli.ts approve --doc …`), which does not pass through this hook.
// 2. The agent may not write kernel-owned paths with shell tricks (redirects, sed -i, cp, mv, rm, tee, and PowerShell's
//    Set-Content, Out-File, Remove-Item, Copy-Item, Move-Item, … — the hook runs for the PowerShell tool too).
//    Heuristic — lint (hash chain + bedrock hashes) is the backstop at every session start.
// 3. A cell session opened in the wrong checkout (worktree.ts `misplaced`) may not write: no shell writes, no git, no
//    kernel CLI command that appends (only fold, lint, review list). Mail to root stays open (`mail.ts send`): it is
//    logged by box name, never in the wrong checkout's copy of a log.
// 4. A session running in a cell may not write outside its folder from the shell either (shell.ts `outside`: redirects
//    and file verbs whose target leaves the cell; the temp folder is fine). `cell audit` is the backstop.
// 5. The project's own guards (bedrock guards.json, config.ts): its operator-only commands, and paths only a named
//    script writes. guards.json itself is bedrock (rule 2).
// 7. Nobody reads a secret or an unreadable path (secrets.ts; Read and Grep: hook-read.ts), by act, not by text.
// 6. Nobody kills processes by name (taskkill /IM, pkill, killall, Stop-Process -Name): on one machine that takes other
//    projects' runners and builds too (AI-MMO: another project's `taskkill /F /IM python.exe` took every runner). By pid.
// Deliberately strict: a command that merely mentions `cli.ts approve` is refused too.
// Fails closed: a check that throws refuses the command, naming the error (an uncaught throw exits 1, which Claude Code
// doesn't treat as blocking: the command would run unchecked; AI-MMO #134).
import { existsSync } from 'node:fs';
import { inMain } from './worktree.ts';
import { misplaced } from './worktree.ts';
import { loadConfig, ownedRes } from './config.ts';
import { basename, posix, resolve } from 'node:path';
import { acts, actUnits, codeTargets, commandsRun, gitGlobals, outside, writePrimitive, writeTargets } from './shell.ts';
import { shellRefusal } from './secrets.ts';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let command = '', cwd = '';
try {
  const input = JSON.parse(raw || '{}') as { cwd?: string; tool_input?: { command?: string } };
  command = input.tool_input?.command ?? '';
  cwd = input.cwd ?? '';
} catch {
  console.error('Blocked: hook-bash could not parse its input; refusing rather than letting the command run unchecked.');
  process.exit(2);
}

const block = (why: string) => { console.error(`Blocked: ${why}`); process.exit(2); };
try {
const config = loadConfig();
if (config.error) block(config.error);
for (const o of config.operatorOnly) if (o.re.test(command)) block(o.message);

if (/cli\.ts["']?\s+approve\b/.test(command)) {
  block('bedrock approval is the operator\'s. Ask them to run it from their prompt: ! node kernel/src/cli.ts approve --doc <doc>');
}

if (/cli\.ts["']?\s+review\s+decide\b/.test(command)) {
  block('review decisions are the operator\'s. Ask them to run it from their prompt: ! node kernel/src/cli.ts review decide --cell <cell> --id R-NNNN --yes|--no');
}

if (/cli\.ts["']?\s+cell\s+land\b/.test(command) && /--accept-weaker\b/.test(command)) {
  block('landing weaker tests is the operator\'s call. Show them what got weaker, then ask them to run it from their prompt: ! node kernel/src/cli.ts cell land --name <cell> … --accept-weaker "<why>"');
}

// Reads (rule 7).
const reads = shellRefusal(command, cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(), config.unreadable);
if (reads) block(reads);

// Killing by name (rule 6), outside quoted text: a commit message may name it.
const unquoted = command.replace(/"[^"]*"|'[^']*'/g, '""');
if (/\btaskkill\b[^|;&\n]*[\s/-]im\b|\bpkill\b|\bkillall\b|\bStop-Process\b[^|;&\n]*-(Name|ProcessName)\b|\|\s*(Stop-Process|spps|kill)\b|\bpgrep\b[^;&\n]*\bkill\b|\bkill\b[^;&\n]*\$\(\s*pgrep\b/i.test(unquoted))
  block('killing processes by name takes every matching process on this machine, other projects\' runners and builds included. Kill by pid (taskkill /PID <pid> /T, kill <pid>, Stop-Process -Id <pid>), only a process you started or can name.');

// state/out/ is not here: it is the cell's exit (metrics.json for cell sync), written by the cell itself.
const protectedPath = /(state[\\/](log|views|bedrock)[\\/]|docs[\\/]assumptions\.md)/;
// Kernel-owned only as a path from the repo or a cell's root: bare, ./ or ../ steps, cells/<name>/, ../<name>/, or the
// repo's absolute path. test/fixtures/x/state/views is a fixture, not root's views (SF-DEV: a cell gave up on static
// fixtures). The match names the path, so a refusal says which.
const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const proj = process.env.CLAUDE_PROJECT_DIR ?? '';
const top = norm(proj && existsSync(`${proj}/binding.json`) ? resolve(proj, '..', '..') : resolve(proj || cwd || '.'));
const roots = [...new Set([top, norm(inMain(top))])];
// Claude Code's own worktrees (isolation: "worktree", EnterWorktree) are checkouts of the repo nested in the main one, at
// .claude/worktrees/<name>/ (#48): their kernel-owned paths are kernel-owned too.
const native = String.raw`(\.claude\/worktrees\/[\w.-]+\/)?(cells\/[\w.-]+\/)?`;
function kernelOwned(c: string): string | null {
  for (const m of c.matchAll(new RegExp(protectedPath.source, 'gi'))) {
    const before = c.slice(0, m.index).match(/[^\s"'=>(|;&,]*$/)![0];
    const pre = before.replaceAll('\\', '/'), low = pre.toLowerCase();
    const rel = new RegExp(String.raw`^(\.{1,2}\/)*${native}$|^(\.\.\/)+[\w.-]+\/$`, 'i').test(pre);
    const abs = roots.some((r) => low.startsWith(`${r}/`) && new RegExp(`^${native}$`).test(low.slice(r.length + 1)));
    if (rel || abs) return pre + m[0];
  }
  return null;
}
// PowerShell (same hook, matcher Bash|PowerShell): its cmdlets, aliases and .NET file writes, case-insensitive like the shell.
// A redirect is never inside quotes: `>` in "a <b@c.com>" or node -e "a > b" is text, so look for it with quoted parts blanked.
const redirect = /(^|[^=\-0-9])>>?(?![&=])/;
const verbs = /(\bsed\s+-i|\btee\b|\bcp\b|\bmv\b|\brm\b|\btruncate\b|\bdd\b|writeFileSync|unlinkSync|\b(Set|Add|Clear)-Content\b|\bOut-File\b|\b(Remove|Copy|Move|New|Rename)-Item\b|(^|[;|&({]\s*)(del|erase|ri|copy|move|ren|sc|ac)\s|\[(System\.)?IO\.File\]::)/i;
const writes = { test: (c: string) => redirect.test(c.replace(/"[^"]*"|'[^']*'/g, '""')) || verbs.test(c) || writePrimitive.test(c) };
// What the command does, not text it carries (#2): quoted text blanked unless it is a target or code, data heredocs dropped,
// what runs inside (-c strings, $(…), shell-fed heredocs) appended. The operator's acts above stay mention-strict.
const act = acts(command);
// `git rm --cached` only untracks; it never changes or deletes the files themselves (git's own options may come first).
const viaKernel = /kernel[\\/](src[\\/](cli|mail)\.ts|scripts[\\/])|^\s*git(\s+(-C|-c|--git-dir|--work-tree)\s+\S+|\s+-\S+)*\s+rm\s+(-r\s+)?--cached\b/;
const project = process.env.CLAUDE_PROJECT_DIR ?? '';
if (project && existsSync(`${project}/binding.json`)
  && (writes.test(command) || /\bgit\b/.test(command) || /cli\.ts["']?\s+(?!fold\b|lint\b|review\s+list\b)\S/.test(command))) {
  const wrong = misplaced(project);
  if (wrong) block(wrong);
}
if (project && existsSync(`${project}/binding.json`)) {
  const out = outside(command, cwd || project, project, ownedRes(config, basename(project)));
  if (out) block(`${out} is outside this cell (${project}) and not among the paths it owns. A cell writes only inside its own folder and its owned paths (bedrock guards.json); if the kernel or root docs need a change, say so in your reply.`);
}

// The project's guards look at what a command writes (shell.ts targets, or a path a script-write call names), not at
// every mention: a commit message or mail body that names a protected path is not a write.
const targets = writeTargets(command).flatMap((t) => (t.target ? [t.target] : []));
const scriptWrite = /writeFileSync|appendFileSync|unlinkSync|rmSync|renameSync|\[(System\.)?IO\.File\]::/i;
const hits = (re: RegExp) => targets.some((t) => re.test(t)) || (scriptWrite.test(act) && re.test(act));
if (project && existsSync(`${project}/binding.json`) && hits(/(^|[\\/\s"'=])binding\.json(?![\w.-])/i))
  block('binding.json is this cell\'s domain, set by root (node kernel/src/cli.ts cell rebind, logged). If it should change, say what and why in your reply.');
const guarded = config.protected.find((g) => hits(g.re));
if (guarded && !config.writers.some((w) => w.test(command)))
  block(`that command writes ${guarded.path}, which only ${guarded.by ? `"node ${guarded.by}"` : 'the operator'} writes (bedrock guards.json).`);

// A kernel-owned path named and written in one act: one simple command, or one piece of program code (#81: `git add
// docs/assumptions.md && printf … > /tmp/x` is two, and wrote only /tmp/x). A write to a target built from a variable
// can't be judged, nor a write that names a variable (`$p = 'state/log/x'; [IO.File]::WriteAllText($p, …)`), so with a
// kernel-owned path named anywhere the whole command is the act (`f=state/log/x; echo > $f`). The null device is no write.
const split = actUnits(command), variable = /\$(?!null\b)[\w{(:]|%\w+%|`/i;
const units = targets.some((t) => variable.test(t) || /^~/.test(t)) || split.some((u) => writes.test(u) && variable.test(u.replace(/>\s*\$null\b/gi, ''))) ? [act] : split;
for (const u of viaKernel.test(command) ? [] : units) {
  const owned = kernelOwned(u);
  if (!owned || !writes.test(u)) continue;
  const proposedOnly = /state[\\/]bedrock[\\/]proposed[\\/]/.test(u) && !/state[\\/](log|views)[\\/]|docs[\\/]assumptions\.md/.test(u)
    && !/state[\\/]bedrock[\\/][a-z0-9-]+\.(md|json|base)/.test(u.replace(/state[\\/]bedrock[\\/]proposed[\\/][a-z0-9-]+\.(md|json|base)/g, ''));
  if (!proposedOnly) block(`that command writes ${owned}, which is kernel-owned (state/log, state/views, state/bedrock, docs/assumptions.md): written only by the kernel CLI. Use it.`);
}
// git's checkout, restore, rm and mv write their paths, read through git's own options (-C, --work-tree, --git-dir: #1).
// Their text has no write verb, so the check above never saw them (`git checkout -- docs/assumptions.md` passed). A
// folder or pathspec that holds a kernel-owned path writes it too: `.`, `docs`, `state/log`, `cells/<x>`, `*.md`.
function holdsOwned(target: string): boolean {
  let p = norm(target);
  for (const r of roots) if (p === r) p = '.'; else if (p.startsWith(`${r}/`)) p = p.slice(r.length + 1);
  if (/^([a-z]:)?\//.test(p)) return false;                                  // elsewhere on the disk
  p = posix.normalize(p.replace(/(^|\/)[^/]*[*?[].*$/, '') || '.').replace(/\/+$/, '');   // a glob: the folder it starts in
  p = p.replace(/^\.claude\/worktrees\/[\w.-]+(\/|$)/, '') || '.';           // a native worktree is a checkout of its own (#48)
  return /^(\.\.\/)*(\.|\.\.|docs|state|state\/(log|views|bedrock)|cells|cells\/[\w.-]+(\/state(\/(log|views|bedrock))?)?)$/.test(p);
}
// A native worktree's branch (worktree-*) never goes into another branch (#48): its work reaches main through cell land
// (audit, test check) or root's own commits. Merge, pull, cherry-pick, rebase and reset onto it are refused.
for (const words of commandsRun(command)) {
  if (!/^git(\.exe)?$/i.test(words[0] ?? '')) continue;
  const [sub = '', ...args] = gitGlobals(words.slice(1)).rest;
  const side = /^(merge|pull|cherry-pick|rebase|reset)$/i.test(sub) && args.find((a) => !a.startsWith('-') && /(^|[/.])worktree-[\w.-]/i.test(a));
  if (side) block(`${side} is a branch of Claude Code's own worktree (.claude/worktrees/): its work reaches main only through cell land or root's own commits, never a merge of the branch. Turn the change into a cell task, or redo it as a commit on main. If the operator wants this merge, they run it from their prompt.`);
}
// A path deleted or moved away by the shell or a script (rm, mv's sources, rmSync, rmtree) holds a kernel-owned one (#49):
// as holdsOwned, but a glob in its last name matches names, not the whole folder (`rm *.tmp` is fine, `rm -rf *` takes
// state/). git's pathspecs keep holdsOwned: `*.md` there matches at any depth, docs/assumptions.md included.
function removesOwned(target: string): boolean {
  const p = target.replaceAll('\\', '/').replace(/\/+$/, '');
  const i = p.lastIndexOf('/'), dir = i < 0 ? '.' : p.slice(0, i) || '/', last = p.slice(i + 1);
  if (!/[*?[]/.test(last) || /[*?[]/.test(dir)) return holdsOwned(target);
  if (holdsOwned(dir) && /(^|\/)cells$/i.test(posix.normalize(dir))) return true;                  // cells/*: some cell
  const re = new RegExp(`^${last.replace(/[.+^${}()|\\]/g, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '[^/]')}$`, 'i');
  return ['state', 'docs', 'cells', 'log', 'views', 'bedrock', 'assumptions.md'].some((n) => re.test(n) && (holdsOwned(`${dir}/${n}`) || !!kernelOwned(`${dir}/${n}/`) || !!kernelOwned(`${dir}/${n}`)));
}
// Every write target, quoted or not (#2: the text check above no longer sees inside quotes): `cp a "state/log/x"`, and
// every path a script's file call names; each joined to the folder a `cd` before it named. A kernel-owned folder is
// kernel-owned without its slash too (`rm -rf state/log`, `rmSync('state/views')`: #49), and a path removed or moved away
// may not hold one (`rm -rf docs`, `rm -rf *`), as git's may not (#1).
let base = '';
for (const t of [...writeTargets(command), ...codeTargets(act)]) {
  if (t.cd !== undefined) {
    const d = t.cd.replaceAll('\\', '/');
    base = /^([a-zA-Z]:)?\//.test(d) ? d : /^[\w.\/-]+$/.test(d) ? posix.join(base || '.', d) : '';   // $x, ~, -: as before
    continue;
  }
  if (!t.target || /state[\\/]bedrock[\\/]proposed([\\/]|$)/i.test(t.target)) continue;   // staging a proposal is anyone's
  const joined = !base || /^([a-zA-Z]:)?[\\/]/.test(t.target) ? t.target : posix.join(base, t.target.replaceAll('\\', '/'));
  // Git Bash's /d/x is D:/x on Windows (as the read guard reads it): `cd /d/PROJECTS/x && rm -rf state/views` passed
  const p = process.platform === 'win32' ? joined.replace(/^\/([a-zA-Z])(\/|$)/, '$1:/') : joined;
  // a reset moves the whole checkout, wherever in it it runs: refused unless it runs in another repository (#3)
  if (t.reset && (!/^([a-zA-Z]:)?\//.test(p.replaceAll('\\', '/')) || roots.some((r) => norm(p) === r || norm(p).startsWith(`${r}/`))))
    block(t.reset.includes(' ')
      ? `git reset ${t.reset} moves this checkout back: the commits after ${t.reset.split(' ')[1]} leave the branch, and the log entries in them with it (AI-MMO lost 10 that way). Undo a commit with git revert (a landing: git revert -m 1 <merge>); if the operator wants the reset, they run it from their prompt with "!".`
      : `git reset --hard discards every uncommitted change in this checkout, kernel-owned ones included (an approved bedrock doc not yet committed, a staged log entry). Restore the files you mean by name (git checkout -- <file>); if the operator wants the reset, they run it from their prompt with "!".`);
  if (t.reset) continue;
  const owned = t.git ? kernelOwned(p) || holdsOwned(p) : (kernelOwned(p) || kernelOwned(`${p}/`) || (t.removes && removesOwned(p))) && !viaKernel.test(command);
  if (owned)
    block(`that command ${t.removes ? 'removes' : 'writes'} ${p}${t.git ? (t.removes ? ' (git clean or stash -u takes away what is not committed there, new log entries included)' : ' (git restores or removes it)') : ''}, which is or holds kernel-owned paths (state/log, state/views, state/bedrock, docs/assumptions.md): written only by the kernel CLI. Use it, or name the files you mean.`);
}
} catch (e) {
  block(`hook-bash failed (${(e as Error).message}); refusing rather than letting the command run unchecked. Tell root if it persists.`);
}
