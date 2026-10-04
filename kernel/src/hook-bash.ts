// Claude Code PreToolUse hook for Bash.
// 1. The agent may not approve bedrock: `approve` must come from the operator's own prompt
//    (`! node kernel/src/cli.ts approve --doc …`), which does not pass through this hook.
// 2. The agent may not write kernel-owned paths with shell tricks (redirects, sed -i, cp, mv, rm, tee).
//    Heuristic — lint (hash chain + bedrock hashes) is the backstop at every session start.
// Deliberately strict: a command that merely mentions `cli.ts approve` is refused too.

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let command = '';
try {
  command = (JSON.parse(raw || '{}') as { tool_input?: { command?: string } }).tool_input?.command ?? '';
} catch {
  console.error('hook-bash: could not parse hook input; not blocking');
  process.exit(0);
}

const block = (why: string) => { console.error(`Blocked: ${why}`); process.exit(2); };

if (/cli\.ts["']?\s+approve\b/.test(command)) {
  block('bedrock approval is the operator\'s. Ask them to run it from their prompt: ! node kernel/src/cli.ts approve --doc <doc>');
}

const protectedPath = /(state[\\/](log|views|bedrock|out)[\\/]|docs[\\/]assumptions\.md)/;
const writes = /((^|[^=\-0-9])>>?(?!&)|\bsed\s+-i|\btee\b|\bcp\b|\bmv\b|\brm\b|\btruncate\b|\bdd\b|writeFileSync|unlinkSync)/;
// `git rm --cached` only untracks; it never changes or deletes the files themselves.
const viaKernel = /kernel[\\/](src[\\/](cli|mail)\.ts|scripts[\\/])|^\s*git\s+rm\s+(-r\s+)?--cached\b/;
if (protectedPath.test(command) && writes.test(command) && !viaKernel.test(command)) {
  const proposedOnly = /state[\\/]bedrock[\\/]proposed[\\/]/.test(command) && !/state[\\/](log|views)[\\/]|docs[\\/]assumptions\.md/.test(command)
    && !/state[\\/]bedrock[\\/][a-z0-9-]+\.md/.test(command.replace(/state[\\/]bedrock[\\/]proposed[\\/][a-z0-9-]+\.md/g, ''));
  if (!proposedOnly) block('that command writes a kernel-owned path (state/log, state/views, state/bedrock, docs/assumptions.md). Use the kernel CLI.');
}
