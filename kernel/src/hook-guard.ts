// Claude Code PreToolUse hook for Write/Edit/MultiEdit/NotebookEdit.
// Kernel-owned paths can't be edited by hand (ontology §3 rules 1, 8; §5):
//   state/log/, state/views/, docs/assumptions.md  → written by the kernel CLI only
//   state/bedrock/ (except proposed/)              → changed by amendment only; approval is the operator's
// stdin is read asynchronously: readFileSync(0) returns empty on Windows pipes.

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

if (/(^|\/)state\/bedrock\//.test(path) && !/(^|\/)state\/bedrock\/proposed\//.test(path)) {
  console.error(`Blocked: ${path} is bedrock. Stage the new version at state/bedrock/proposed/<doc>.md, then run "node kernel/src/cli.ts amend --doc <doc> --layer <layer> --reason …". Approval is the operator's.`);
  process.exit(2);
}
if (/(^|\/)state\/(log|views|out)\//.test(path) || /(^|\/)docs\/assumptions\.md$/.test(path)) {
  console.error(`Blocked: ${path} is written only by the kernel. Use "node kernel/src/cli.ts append|assume|evidence|constraint" (they refold).`);
  process.exit(2);
}
