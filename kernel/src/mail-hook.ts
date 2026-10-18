// Claude Code Stop hook for a cell session: the mail loop.
//   1. the session just stopped → if it was working on a message, file its last answer as the reply (outbox/);
//      an answer that reads as a progress note ("still running…") is held back instead: block, and send the session
//      back to finish, at most HOLD_MAX times per message (mail.ts hold)
//   2. wait for the next message in inbox/ (poll every 3 s, up to CELLKIT_MAIL_WAIT seconds; default 1800)
//   3. a message arrives → block the stop and hand it over as the next instruction; none → let the session stop
//   A session opened in the wrong checkout (worktree.ts `misplaced`) files any in-flight reply but is handed no new
//   mail, so the queue waits for the session in the cell's own worktree.
// Input (stdin): { cwd, transcript_path, last_assistant_message?, stop_hook_active, … }.
import { readFileSync, existsSync } from 'node:fs';
import { fileReply, hold, takeNext } from './mail.ts';
import { misplaced } from './worktree.ts';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || '{}') as { cwd?: string; transcript_path?: string; last_assistant_message?: string };
const cell = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();

// the session's last answer: given by the hook input in newer versions, else read from the transcript
function lastAnswer(): string {
  if (input.last_assistant_message) return input.last_assistant_message;
  if (!input.transcript_path || !existsSync(input.transcript_path)) return '(no transcript)';
  const lines = readFileSync(input.transcript_path, 'utf8').trim().split('\n').reverse();
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      if (e.type !== 'assistant') continue;
      const text = (e.message?.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('\n').trim();
      if (text) return text;
    } catch { /* skip */ }
  }
  return '(no answer text)';
}

// a progress note ("still running…") isn't a reply: send the session back to finish (mail.ts hold)
const answer = lastAnswer(), held = hold(cell, answer);
if (held) { console.log(JSON.stringify({ decision: 'block', reason: held })); process.exit(0); }
fileReply(cell, answer);

const wrong = misplaced(cell);
if (wrong) { console.error(wrong); process.exit(0); }

const waitS = Number(process.env.CELLKIT_MAIL_WAIT ?? 1800);
const until = Date.now() + waitS * 1000;
let m = takeNext(cell);
while (!m && Date.now() < until) { await new Promise((r) => setTimeout(r, 3000)); m = takeNext(cell); }

if (m) {
  const reason = `📬 Task ${m.id} from ${m.from} (${m.at}). Do what it asks inside this cell, then end your turn with your answer — your final message is sent back as the reply automatically; don't write any reply file yourself.\n` +
    `Blocked or need root to decide something before you can go on? Send it and end your turn (root's answer arrives as your next task):\n` +
    `  node "${process.env.CLAUDE_PROJECT_DIR ?? '.'}/../../kernel/src/mail.ts" send --to root --kind blocked|question --body "…"\n\n${m.body}`;
  console.log(JSON.stringify({ decision: 'block', reason }));
}
process.exit(0);
