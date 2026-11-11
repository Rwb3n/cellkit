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
//    Nor does one command both list processes and stop some (#97): that is a kill by name with a filter.
// 8. In a cell session, before a command runs, what the changed test files hold is written down
//    for the land to read (weaker.ts, #72). It refuses nothing; a record that can't be written refuses the command.
// Deliberately strict: a command that merely mentions `cli.ts approve` is refused too.
// Fails closed: a check that throws refuses the command, naming the error (an uncaught throw exits 1, which Claude Code
// doesn't treat as blocking: the command would run unchecked; AI-MMO #134).
import { existsSync } from 'node:fs';
import { inMain } from './worktree.ts';
import { misplaced } from './worktree.ts';
import { isSource, loadConfig, ownedRes } from './config.ts';
import { basename, posix, resolve } from 'node:path';
import { acts, actUnits, CD, CLOSE, codeTargets, commandsRun, gitGlobals, OPEN, outside, typedWrites, verbOf, writePrimitive, writeTargets } from './shell.ts';
import { shellRefusal } from './secrets.ts';
import { noteWeaker } from './weaker.ts';

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

// What the command does, not text it carries (#2): quoted text blanked unless it is a target or code, data heredocs dropped,
// what runs inside (-c strings, $(…), shell-fed heredocs) appended. The operator's acts above stay mention-strict.
const act = acts(command);
// Killing by name (rule 6), outside quoted text: a commit message may name it. Read in the command as written and in
// what it runs (a shell's -c / -Command string: `powershell -Command "Stop-Process -Name node"` from bash).
const blank = (s: string) => s.replace(/"[^"]*"|'[^']*'/g, '""');
const unquoted = blank(command), ran = [unquoted, blank(act)];
if (ran.some((u) => /\btaskkill\b[^|;&\n]*[\s/-]im\b|\bpkill\b|\bkillall\b|\bStop-Process\b[^|;&\n]*-(Name|ProcessName)\b|\|\s*(Stop-Process|spps|kill)\b|\bpgrep\b[^;&\n]*\bkill\b|\bkill\b[^;&\n]*\$\(\s*pgrep\b/i.test(u)))
  block('killing processes by name takes every matching process on this machine, other projects\' runners and builds included. Kill by pid (taskkill /PID <pid> /T, kill <pid>, Stop-Process -Id <pid>), only a process you started or can name.');
// Nor does one command both list processes and stop any: that is killing by name with a filter (#97; COCKPIT's root
// stopped every node whose command line held "mail.ts watch", machine-wide: `Get-CimInstance Win32_Process | Where-Object
// … | ForEach-Object { Stop-Process -Id $_.ProcessId }`; only its own watcher matched that day). Read the pid, then stop
// it in a command of its own. A tool's own subcommand is neither (docker ps, docker kill, tmux kill-session).
const TOOLS = String.raw`(?<!\b(docker|podman|kubectl|tmux|pm2|compose|git)\s+)`;
const listsProcesses = new RegExp(String.raw`\b(Get-CimInstance|gcim|Get-WmiObject|gwmi)\b[^;\n]*\bWin32_Process\b|\bGet-Process\b|${TOOLS}(^|(?<=[\s|;&({]))(gps|pgrep|tasklist|ps)(?=\s|$|[|;&)}])|\bwmic\s+process\b`, 'im');
const stopsProcesses = new RegExp(String.raw`\bStop-Process\b|${TOOLS}(^|(?<=[\s|;&({]))(spps|taskkill|kill)(?=\s|$)|\.Kill\s*\(|\.Terminate\s*\(|\bInvoke-CimMethod\b[^;\n]*\bTerminate\b`, 'im');
// cmd's `for /f %i in ('<command>') do …` runs what its single quotes hold: read that command as written
if ([...ran, ...(/\bfor\s+\/f\b/i.test(unquoted) ? [command] : [])].some((u) => listsProcesses.test(u) && stopsProcesses.test(u)))
  block('one command both lists processes and stops some: that stops whatever the filter matches, other projects\' runners and watchers included. List first, read the pid and its command line, then stop that pid in a command of its own (Stop-Process -Id <pid>, taskkill /PID <pid> /T, kill <pid>).');

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

// Rule 9: git commands that move a branch by force, in any session (#54): `git checkout -B main <commit>`, `git switch
// -C`, `git branch -f` put a branch back the way `git reset --hard <commit>` does (refused above), and the log entries
// committed since leave it. By form: whether the branch exists, and where the commit is, the hook doesn't ask.
// Rule 10, a cell session only (#84, from the reviews of #72 and #101): git commands that change what root's landing
// compares the cell's work against, none of which a cell's work needs: another branch moved (`git push . HEAD:main`,
// `update-ref`, `branch <name>`, `fetch . a:b`: with a weakened commit in main, the land's comparison has it as its
// base and finds nothing), git's settings and marks (`config` writes, `replace`, `update-index`), its objects (`gc`,
// `prune`, `reflog expire`), its worktrees and remotes. And root's mail: a mail.ts that is not the worktree's own, or
// --root, is root's mail run as root (the CLI can't tell once the main checkout's kernel is the one run).
{
  const cellSession = !!project && existsSync(`${project}/binding.json`);
  const here0 = norm(cwd || project || '.');
  const win = (p: string) => (process.platform === 'win32' ? p.replace(/^\/([a-zA-Z])(\/|$)/, '$1:/') : p);
  const absIn = (base: string | null, p: string): string | null => {
    const s = win(p.replaceAll('\\', '/'));
    if (/[$%~`]/.test(s)) return null;
    if (/^([a-zA-Z]:)?\//.test(s)) return norm(posix.normalize(s));
    return base === null ? null : norm(posix.normalize(`${base}/${s}`));
  };
  let here: string | null = here0;
  const stack: (string | null)[] = [];
  for (const words of commandsRun(command)) {
    if (words.length === 1 && words[0] === OPEN) { stack.push(here); continue; }
    if (words.length === 1 && words[0] === CLOSE) { here = stack.pop() ?? here; continue; }
    const { verb, i } = verbOf(words), args = words.slice(i + 1);
    if (CD.test(verb)) { const d = args.find((a) => !a.startsWith('-')); if (d) here = absIn(here, d); continue; }
    if (/^git(\.exe)?$/i.test(verb)) {
      const [sub = '', ...g] = gitGlobals(args).rest;
      const s = sub.toLowerCase(), plain = g.filter((a) => !a.startsWith('-'));
      const short = (letters: RegExp) => g.some((a) => /^-[A-Za-z]+$/.test(a) && letters.test(a.slice(1)));
      const long = (re: RegExp) => g.some((a) => re.test(a));
      if ((s === 'checkout' && short(/B/)) || (s === 'switch' && (short(/C/) || long(/^--force-create$/))) || (s === 'branch' && (short(/[fMC]/) || long(/^--force$/))))
        block(`git ${s} with ${s === 'branch' ? '-f, -M or -C' : s === 'checkout' ? '-B' : '-C'} moves a branch that exists to another commit, as git reset --hard does: the commits it held leave it, and the log entries in them with it. A new branch needs no force (git ${s === 'branch' ? 'branch <name>' : s === 'checkout' ? 'checkout -b <name>' : 'switch -c <name>'}); undo a commit with git revert. If the operator wants the branch moved, they run it from their prompt with "!".`);
      if (!cellSession) continue;
      const configWrite = s === 'config' && !long(/^(--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|--list|--show-origin|--show-scope|--name-only)$/) && !short(/l/)
        && !/^(get|list)$/.test(plain[0] ?? '') && (plain.length > 1 || /^(set|unset|rename-section|remove-section|edit)$/.test(plain[0] ?? '') || long(/^(--unset|--unset-all|--add|--replace-all|--rename-section|--remove-section|--edit)$/) || short(/e/));
      const refused = /^(push|update-ref|replace|update-index|gc|prune|filter-branch|fast-import|pack-refs)$/.test(s)
        || configWrite
        || (s === 'branch' && (plain.length > 0 || short(/[dDmMcC]/) || long(/^--(delete|move|copy|set-upstream-to|unset-upstream|edit-description)/)))
        || (s === 'tag' && (plain.length > 0 || short(/d/) || long(/^--delete$/)) && !short(/l/) && !long(/^--list$/))
        || (s === 'fetch' && plain.some((a) => a.includes(':')))
        || (s === 'symbolic-ref' && plain.length > 1)
        || (s === 'reflog' && /^(expire|delete)$/.test(plain[0] ?? ''))
        || (s === 'worktree' && /^(add|remove|move|prune|lock|unlock|repair)$/.test(plain[0] ?? ''))
        || (s === 'remote' && /^(add|remove|rm|rename|set-url|set-head|set-branches|prune|update)$/.test(plain[0] ?? ''));
      if (refused) block(`a cell's session doesn't run git ${s}${plain[0] && /^(reflog|worktree|remote)$/.test(s) ? ` ${plain[0]}` : ''} this way: it changes what root's landing compares your work against (a branch other than your own, git's settings or marks, its objects, worktrees or remotes), and none of your work needs it. Root commits and lands what is in your folder. If this is truly needed, say what and why in your reply.`);
      continue;
    }
    if (!cellSession) continue;
    const mails = words.filter((w) => /(^|[\\/])mail\.ts$/i.test(w));
    if (!mails.length) continue;
    if (words.some((w) => /^--root(=|$)/.test(w))) block('--root makes mail.ts act for another repository\'s root: a cell sends mail as itself, with its worktree\'s own kernel (node ../../kernel/src/mail.ts send --to root --kind blocked|question --body "…"), and its tasks arrive when it ends its turn.');
    for (const m of mails) {
      const at = absIn(here, m);
      if (at === null || !(at === `${top}/kernel/src/mail.ts`))
        block(`${m} is not this worktree's own mail.ts${at === null ? ' (its folder can\'t be told from the command)' : ''}: run from another checkout it acts as root there, and root's mail is root's. A cell sends mail as itself: node ../../kernel/src/mail.ts send --to root --kind blocked|question --body "…" from its own folder; its tasks arrive when it ends its turn.`);
    }
  }
}

// Rule 11 (#82): source files are written with the Write and Edit tools, never typed through the shell. In a cell's
// session; in root's when the project says so (guards.json source.root). Only files in the repository: a scratch file
// in the temp folder is nobody's source. A target built from a variable can't be judged and is let through, as in rule 4.
if ((project && existsSync(`${project}/binding.json`)) || config.sourceRoot) {
  const from = norm(cwd || project || '.');
  for (const w of typedWrites(command)) {
    const s = (process.platform === 'win32' ? w.target.replace(/^\/([a-zA-Z])(\/|$)/, '$1:/') : w.target).replaceAll('\\', '/');
    if (/[$%~`]/.test(s)) continue;
    const abs = norm(posix.normalize(/^([a-zA-Z]:)?\//.test(s) ? s : `${from}/${s}`));
    const home = roots.find((r) => abs.startsWith(`${r}/`));
    if (home && isSource(config, abs.slice(home.length + 1)))
      block(`${w.target} is a source file, and that command types its content through the shell (${w.how}): the shell eats backslashes and quotes on the way, and what lands still reads as code (a regex's \\w becomes w). Write it with the Write tool, or change it with Edit. A program's own output sent to a file is fine (node gen.js > ${w.target}).`);
  }
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
const saved: string[] = [];
// where the project's cell worktrees live (worktree.ts cellsCheckoutDir), seen from the main checkout
const mainTop = norm(inMain(top));
const cellsHome = mainTop && /^([a-z]:)?\//.test(mainTop) ? norm(config.home ? resolve(mainTop, config.home) : `${mainTop}-cells`) : '';
for (const t of [...writeTargets(command), ...codeTargets(act)]) {
  if (t.sub) { if (t.sub === 'open') saved.push(base); else base = saved.pop() ?? base; continue; }   // a subshell's cd ends at its close
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
  // A copy or move INTO a folder brings its sources in under their own names (#54): `cp -r backup/state .` lands
  // ./state, log and bedrock with it (#1's restore, done with cp); `mv old/docs .` replaces docs/assumptions.md. By
  // name, not by what the source holds on disk: a source called state, docs, cells, log, views or bedrock (or a glob
  // that can match one) arriving where that name is or holds kernel-owned paths. `cp notes.md docs/` names none.
  if (t.from && !viaKernel.test(command)) for (const src of t.from) {
    const last = src.replaceAll('\\', '/').replace(/\/+$/, '').replace(/^.*\//, '');
    const re = /[*?[]/.test(last) ? new RegExp(`^${last.replace(/[.+^${}()|\\]/g, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '[^/]').replace(/\[!/g, '[^')}$`, 'i') : null;
    for (const n of ['state', 'docs', 'cells', 'log', 'views', 'bedrock']) {
      if (re ? !re.test(n) : last.toLowerCase() !== n) continue;
      const lands = posix.join(p.replaceAll('\\', '/'), n);
      // from the shell's folder too: `cd .. && cp -r backup/state <repo>` names the repository from outside it
      const abs = /^([a-zA-Z]:)?\//.test(lands) ? lands : posix.normalize(`${(cwd || proj || '.').replaceAll('\\', '/')}/${lands}`);
      if (kernelOwned(lands) || kernelOwned(`${lands}/`) || holdsOwned(lands) || holdsOwned(abs))
        block(`that command brings ${src} in as ${lands}, which is or holds kernel-owned paths (state/log, state/views, state/bedrock, docs/assumptions.md): a copy or move of a whole ${n} folder replaces log entries and approved bedrock with someone else's. Copy the files you mean by name; the log and bedrock are written only by the kernel CLI.`);
    }
  }
  // A cell's worktree deleted from outside it (#54: `rm -rf ../<repo>-cells/<cell>` from root): its uncommitted work and
  // its log's new entries go with it, and git's lock (#22) stops `git worktree remove`, not rm. The home folder, a
  // worktree in it, or a folder above them.
  if (t.removes && !t.git && cellsHome) {
    const s = p.replaceAll('\\', '/');
    const abs = norm(/^([a-zA-Z]:)?\//.test(s) ? posix.normalize(s) : posix.normalize(`${norm(cwd || proj || '.')}/${s}`));
    const depth = abs.startsWith(`${cellsHome}/`) ? abs.slice(cellsHome.length + 1).split('/').length : 0;
    if (abs === cellsHome || depth === 1 || cellsHome.startsWith(`${abs}/`))
      block(`that command removes ${p}, which is or holds a cell's worktree (${cellsHome}/<cell>): its work not yet landed and its log's new entries go with it. Land the cell's work first; a worktree is taken down with git worktree remove (after git worktree unlock), by the operator's word.`);
  }
  if (owned)
    block(`that command ${t.removes ? 'removes' : 'writes'} ${p}${t.git ? (t.removes ? ' (git clean or stash -u takes away what is not committed there, new log entries included)' : ' (git restores or removes it)') : ''}, which is or holds kernel-owned paths (state/log, state/views, state/bedrock, docs/assumptions.md): written only by the kernel CLI. Use it, or name the files you mean.`);
}
// Rule 8, last: the command is about to run.
if (project && existsSync(`${project}/binding.json`) && !misplaced(project)) noteWeaker(project);   // in its own worktree: another's is not its record
} catch (e) {
  block(`hook-bash failed (${(e as Error).message}); refusing rather than letting the command run unchecked. Tell root if it persists.`);
}
