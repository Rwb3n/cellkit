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
// Deliberately strict: a command that merely mentions `cli.ts approve` is refused too.
import { existsSync } from 'node:fs';
import { misplaced } from './worktree.ts';
import { loadConfig, ownedRes } from './config.ts';
import { basename } from 'node:path';
import { outside, writeTargets } from './shell.ts';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let command = '', cwd = '';
try {
  const input = JSON.parse(raw || '{}') as { cwd?: string; tool_input?: { command?: string } };
  command = input.tool_input?.command ?? '';
  cwd = input.cwd ?? '';
} catch {
  console.error('hook-bash: could not parse hook input; not blocking');
  process.exit(0);
}

const block = (why: string) => { console.error(`Blocked: ${why}`); process.exit(2); };
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

// state/out/ is not here: it is the cell's exit (metrics.json for cell sync), written by the cell itself.
const protectedPath = /(state[\\/](log|views|bedrock)[\\/]|docs[\\/]assumptions\.md)/;
// PowerShell (same hook, matcher Bash|PowerShell): its cmdlets, aliases and .NET file writes, case-insensitive like the shell.
// A redirect is never inside quotes: `>` in "a <b@c.com>" or node -e "a > b" is text, so look for it with quoted parts blanked.
const redirect = /(^|[^=\-0-9])>>?(?![&=])/;
const verbs = /(\bsed\s+-i|\btee\b|\bcp\b|\bmv\b|\brm\b|\btruncate\b|\bdd\b|writeFileSync|unlinkSync|\b(Set|Add|Clear)-Content\b|\bOut-File\b|\b(Remove|Copy|Move|New|Rename)-Item\b|(^|[;|&({]\s*)(del|erase|ri|copy|move|ren|sc|ac)\s|\[(System\.)?IO\.File\]::)/i;
const writes = { test: (c: string) => redirect.test(c.replace(/"[^"]*"|'[^']*'/g, '""')) || verbs.test(c) };
// `git rm --cached` only untracks; it never changes or deletes the files themselves.
const viaKernel = /kernel[\\/](src[\\/](cli|mail)\.ts|scripts[\\/])|^\s*git\s+rm\s+(-r\s+)?--cached\b/;
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
const hits = (re: RegExp) => targets.some((t) => re.test(t)) || (scriptWrite.test(command) && re.test(command));
if (project && existsSync(`${project}/binding.json`) && hits(/(^|[\\/\s"'=])binding\.json(?![\w.-])/i))
  block('binding.json is this cell\'s domain, set by root (node kernel/src/cli.ts cell rebind, logged). If it should change, say what and why in your reply.');
const guarded = config.protected.find((g) => hits(g.re));
if (guarded && !config.writers.some((w) => w.test(command)))
  block(`that command writes ${guarded.path}, which only ${guarded.by ? `"node ${guarded.by}"` : 'the operator'} writes (bedrock guards.json).`);

if (protectedPath.test(command) && writes.test(command) && !viaKernel.test(command)) {
  const proposedOnly = /state[\\/]bedrock[\\/]proposed[\\/]/.test(command) && !/state[\\/](log|views)[\\/]|docs[\\/]assumptions\.md/.test(command)
    && !/state[\\/]bedrock[\\/][a-z0-9-]+\.(md|json|base)/.test(command.replace(/state[\\/]bedrock[\\/]proposed[\\/][a-z0-9-]+\.(md|json|base)/g, ''));
  if (!proposedOnly) block('that command writes a kernel-owned path (state/log, state/views, state/bedrock, docs/assumptions.md). Use the kernel CLI.');
}
