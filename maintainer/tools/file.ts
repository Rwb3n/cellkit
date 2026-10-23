// File an issue on Rwb3n/cellkit in one step: create it with its labels (and milestone), add it to the cellkit board,
// set its Status, then pause, since GitHub refuses fast bursts of creates. One command, so no issue misses the board
// (AI-MMO's board lost two weeks of hand-filed issues). Kit-private: maintainer/ only.
//
//   node maintainer/tools/file.ts --title "…" --body-file body.md --label area:guards --label bug [--label from:sf-dev]
//                                 [--status Next] [--milestone v0.5]
//   node maintainer/tools/file.ts --board <issue number> [--status Later]      add an existing issue to the board
//
// Status: Intake (default) · Next · In Progress · Later · Watching · Done. The body follows the anatomy in
// maintainer/ROOT.md ("Issues"): what, Outcome, After #n, Refs, Source.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const REPO = 'Rwb3n/cellkit', OWNER = 'Rwb3n', BOARD = 9;
const gh = (...a: string[]) => execFileSync('gh', a, { encoding: 'utf8' }).trim();

const argv = process.argv.slice(2);
const one = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const all = (k: string) => argv.flatMap((a, i) => (a === k && argv[i + 1] ? [argv[i + 1]] : []));
const fail = (m: string): never => { console.error(m); process.exit(2); };

const status = one('--status') ?? 'Intake';
let url: string;
const existing = one('--board');
if (existing) url = `https://github.com/${REPO}/issues/${existing}`;
else {
  const title = one('--title') ?? fail('--title is required');
  const body = one('--body-file') ?? fail('--body-file is required (the anatomy: maintainer/ROOT.md, "Issues")');
  if (!existsSync(body)) fail(`no file ${body}`);
  if (!all('--label').some((l) => l.startsWith('area:'))) fail('give at least one --label area:<part>');
  const ms = one('--milestone');
  url = gh('issue', 'create', '--repo', REPO, '--title', title, '--body-file', body,
    ...all('--label').flatMap((l) => ['--label', l]), ...(ms ? ['--milestone', ms] : []));
}

const project = JSON.parse(gh('project', 'view', String(BOARD), '--owner', OWNER, '--format', 'json')).id as string;
const field = (JSON.parse(gh('project', 'field-list', String(BOARD), '--owner', OWNER, '--format', 'json')).fields as
  { id: string; name: string; options?: { id: string; name: string }[] }[]).find((f) => f.name === 'Status')!;
const option = field.options!.find((o) => o.name.toLowerCase() === status.toLowerCase())
  ?? fail(`no Status "${status}" (${field.options!.map((o) => o.name).join(', ')})`);
const item = JSON.parse(gh('project', 'item-add', String(BOARD), '--owner', OWNER, '--url', url, '--format', 'json')).id as string;
gh('project', 'item-edit', '--project-id', project, '--id', item, '--field-id', field.id, '--single-select-option-id', option.id);
console.log(`${url} · board: ${option.name}`);
if (!existing) execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 4000)']);   // GitHub's burst limit
