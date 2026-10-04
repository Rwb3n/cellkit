// Claude Code PreToolUse hook for Write/Edit/MultiEdit/NotebookEdit.
// Kernel-owned paths can't be edited by hand (ontology §3 rules 1, 8; §5):
//   state/log/, state/views/, docs/assumptions.md  → written by the kernel CLI only
//   state/bedrock/ (except proposed/)              → changed by amendment only; approval is the operator's
// stdin is read asynchronously: readFileSync(0) returns empty on Windows pipes.

import { existsSync } from 'node:fs';
import { posix } from 'node:path';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let input: { tool_input?: { file_path?: string; notebook_path?: string } } = {};
try {
  input = JSON.parse(raw || '{}');
} catch {
  console.error('hook-guard: could not parse hook input; not blocking');
  process.exit(0);
}

const path = (input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? '').replaceAll('\\', '/');

// Cell boundary: a session running in a cell (its project dir has a binding.json) writes only inside that cell.
// Everything above it — kernel, root bedrock, root docs, other cells — is read-only from here; ask root by reply.
const project = (process.env.CLAUDE_PROJECT_DIR ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
if (project && existsSync(`${project}/binding.json`)) {
  const abs = posix.normalize(/^[a-zA-Z]:\//.test(path) || path.startsWith('/') ? path : `${project}/${path}`).toLowerCase(); // no ../ escapes
  if (!abs.startsWith(project.toLowerCase() + '/')) {
    console.error(`Blocked: ${path} is outside this cell (${project}). A cell writes only inside its own folder; if the kernel or root docs need a change, say so in your reply.`);
    process.exit(2);
  }
}

if (/(^|\/)state\/bedrock\//.test(path) && !/(^|\/)state\/bedrock\/proposed\//.test(path)) {
  console.error(`Blocked: ${path} is bedrock. Stage the new version at state/bedrock/proposed/<doc>.md, then run "node kernel/src/cli.ts amend --doc <doc> --layer <layer> --reason …". Approval is the operator's.`);
  process.exit(2);
}
if (/(^|\/)state\/(log|views|out)\//.test(path) || /(^|\/)docs\/assumptions\.md$/.test(path) || /(^|\/)docs\/models\/(README|6-code)\.md$/.test(path)) {
  console.error(`Blocked: ${path} is written only by the kernel. Use "node kernel/src/cli.ts append|assume|evidence|constraint" (they refold), or "node kernel/scripts/models.ts" for docs/models.`);
  process.exit(2);
}
