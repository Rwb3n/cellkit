// Claude Code PreToolUse hook for Read and Grep: the read guard (secrets.ts). No session reads a secret (the kit's
// defaults: keys, .env, credentials) or a path the project's bedrock guards.json lists as "unreadable", root's included.
// Fails closed, like the other hooks. Ported from SF-DEV (hook-read.ts).
// stdin is read asynchronously: readFileSync(0) returns empty on Windows pipes.
import { loadConfig } from './config.ts';
import { denied, grepRefusal } from './secrets.ts';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

const block = (why: string) => { console.error(`Blocked: ${why}`); process.exit(2); };
let input: { tool_name?: string; cwd?: string; tool_input?: { file_path?: string; path?: string; glob?: string; type?: string; output_mode?: string } } = {};
try { input = JSON.parse(raw || '{}'); } catch { block('hook-read could not parse its input; refusing rather than letting the read through unchecked.'); }
try {
  const config = loadConfig();
  if (config.error) block(config.error);
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const t = input.tool_input ?? {};
  if (input.tool_name === 'Grep') {
    const why = grepRefusal(t, cwd, config.unreadable);
    if (why) block(why);
  } else if (t.file_path) {
    const d = denied(t.file_path, cwd, config.unreadable);
    if (d) block(`${d.path} is ${d.why}: no session reads it. If a tool needs it, the tool reads it itself (process.loadEnvFile, a keychain); a session never sees it.`);
  }
} catch (e) {
  block(`hook-read failed (${(e as Error).message}); refusing rather than letting the read through unchecked. Tell root if it persists.`);
}
