// Claude Code PreToolUse hook for Write/Edit/MultiEdit/NotebookEdit.
// Kernel-owned paths can't be edited by hand (ontology §3 rules 1, 8; §5):
//   state/log/, state/views/, docs/assumptions.md  → written by the kernel CLI only
//   state/bedrock/ (except proposed/)              → changed by amendment only; approval is the operator's
//   paths bedrock guards.json protects             → only the script it names (config.ts)
// stdin is read asynchronously: readFileSync(0) returns empty on Windows pipes.

import { existsSync } from 'node:fs';
import { basename, posix } from 'node:path';
import { misplaced } from './worktree.ts';
import { loadConfig, ownedRes } from './config.ts';

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
const config = loadConfig();
if (config.error) { console.error(`Blocked: ${config.error}`); process.exit(2); }

// Cell boundary: a session running in a cell (its project dir has a binding.json) writes only inside that cell, and in
// the repo paths bedrock guards.json says it owns (cells.<name>.owns). Everything else above it (kernel, root bedrock,
// root docs, other cells) is read-only from here; ask root by reply.
const project = (process.env.CLAUDE_PROJECT_DIR ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
// A cell session opened in the wrong checkout (worktree.ts) writes nothing at all. Writes from a cell's worktree into
// the main checkout or another worktree need no extra rule: they are outside the cell's folder.
if (project && existsSync(`${project}/binding.json`)) {
  const wrong = misplaced(project);
  if (wrong) { console.error(`Blocked: ${wrong}`); process.exit(2); }
  const abs = posix.normalize(/^[a-zA-Z]:\//.test(path) || path.startsWith('/') ? path : `${project}/${path}`).toLowerCase(); // no ../ escapes
  const top = posix.normalize(`${project}/../..`).toLowerCase();
  const owned = abs.startsWith(top + '/') && ownedRes(config, basename(project)).some((r) => r.test(abs.slice(top.length + 1)));
  if (!abs.startsWith(project.toLowerCase() + '/') && !owned) {
    console.error(`Blocked: ${path} is outside this cell (${project}) and not among the paths it owns. A cell writes only inside its own folder and its owned paths (bedrock guards.json); if anything else needs a change, say so in your reply.`);
    process.exit(2);
  }
  if (abs === `${project.toLowerCase()}/binding.json`) {
    console.error(`Blocked: binding.json is this cell's domain, set by root (node kernel/src/cli.ts cell rebind, logged). If it should change, say what and why in your reply.`);
    process.exit(2);
  }
}

if (/(^|\/)state\/bedrock\//.test(path) && !/(^|\/)state\/bedrock\/proposed\//.test(path)) {
  console.error(`Blocked: ${path} is bedrock. Stage the new version at state/bedrock/proposed/<doc>.md|.json ("node kernel/src/cli.ts stage --doc <doc>" copies the live one), then run "node kernel/src/cli.ts amend --doc <doc> --layer <layer> --reason …". Approval is the operator's.`);
  process.exit(2);
}
// state/out/ is the cell's exit (metrics.json for cell sync): the cell writes it, inside its own boundary.
if (/(^|\/)state\/(log|views)\//.test(path) || /(^|\/)docs\/assumptions\.md$/.test(path)) {
  console.error(`Blocked: ${path} is written only by the kernel. Use "node kernel/src/cli.ts append|assume|evidence|constraint" (they refold).`);
  process.exit(2);
}
const guarded = config.protected.find((g) => g.re.test(path));
if (guarded) {
  console.error(`Blocked: ${path} is written only ${guarded.by ? `by "node ${guarded.by}"` : 'by the operator'} (bedrock guards.json: protected ${guarded.path}).`);
  process.exit(2);
}
