// Land a cell's work: root's loop (README "Root's loop") as one command, so no step is skipped. 01-HAIOS-PERS lost six
// hours to two cell-log entries left uncommitted in a worktree; AI-MMO and PS5-STUDY did these steps by hand each time.
//
//   node kernel/src/cli.ts cell land --name <cell> [--message "…"] [--check "<command>"] [--into <branch>] [--dry-run]
//                                    [--checked "<what root checked, against what>"]
//   ! node kernel/src/cli.ts cell land … --accept-weaker "<why>"      (operator only)
//
// Refused whole, before anything changes, when: the cell has no worktree · its session is working on a message ·
// root's checkout is not on <into> (default: the branch it is on) · root has uncommitted work of its own (anything but
// state/log/, state/views/, docs/assumptions.md: mail and sync write those) · `cell audit` finds a change outside
// cells/<name>/ · the worktree holds git-ignored files outside the project's `land.ignored` allowlist, if it set one ·
// a reply being landed lists "Overturned" items and root gave no --checked (or gave one with nothing overturned).
// Then, stopping at the first failure and undoing what it did on the cell's branch:
//   1. commit the cell's uncommitted work on its branch (pathspec cells/<name> and the paths it owns)
//   2. merge <into> into the cell's branch (a conflict: abort, and leave it to root in the worktree)
//   3. audit again, and run --check in the worktree (e.g. "cd kernel && npm test"): the merged result is what is tested;
//      then the allowlist again (what the check left behind), and the report says which of the main checkout's
//      git-ignored paths the check ran without
//   4. merge the cell's branch into <into> with --no-ff (one revertable commit: git revert -m 1 <it>)
// Before 2, the cell's tests must not have got weaker (weaker.ts): fewer cases or assertions, skips or loosening added,
// in the tree being landed or in any tree a command of the run ran against (the record hook-bash keeps).
// If they did, the land stops; the operator alone lands it anyway, with --accept-weaker "<why>" (hook-blocked for
// agents), and the reason goes into the merge commit.
// The CLI then syncs the cell and commits root's log (commitRootLog), so mail entries never sit uncommitted.
import { spawnSync } from 'node:child_process';
// --check runs through the system shell: cmd.exe on Windows (`(cd x && …)` doesn't scope the cd there), else /bin/sh
const SHELL = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
const runCheck = (check: string, cwd: string) => spawnSync(check, { cwd, shell: true, encoding: 'utf8' });
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { delivered, status } from './mail.ts';
import { configPath, loadConfig } from './config.ts';
import { globRe } from './glob.ts';
import { refoldPresent } from './refold.ts';
import { blobName, forgetWeaker, weakerDuring, weakerTests, type Was } from './weaker.ts';
import { cellAudit, cellBranch, cellWorktree, currentBranch, inMain, WorktreeError } from './worktree.ts';

const ROOT_WRITTEN = [/^state\/log\//, /^state\/views\//, /^docs\/assumptions\.md$/];

function git(dir: string, args: string[], check = true): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8' });
  const out = (r.stdout + r.stderr).trim();
  if (check && r.status !== 0) throw new WorktreeError(`git ${args.join(' ')}: ${out}`);
  return { ok: r.status === 0, out };
}
// Not git(): its trim() takes the leading space of an unstaged first line (" M docs/x"), and slice(3) then cut a
// letter off the path (SF-DEV: the next land refused "ocs/assumptions.md" as root's own work).
export function dirty(dir: string): string[] {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.quotepath=off', 'status', '--porcelain=v1', '-uall'], { encoding: 'utf8' });
  if (r.status !== 0) throw new WorktreeError(`git status: ${(r.stdout + r.stderr).trim()}`);
  return r.stdout.split(/\r?\n/).filter(Boolean)
    .flatMap((l) => l.slice(3).split(' -> ').map((p) => p.trim().replace(/^"|"$/g, '')));
}
const head = (dir: string) => git(dir, ['rev-parse', 'HEAD']).out;

// Git-ignored files. Git never shows them, so nothing else in a land accounts for them:
//   - in the cell's worktree (#77; COCKPIT: 8 MB of real-data output left in an ignored test/tmp/, found by hand): every
//     land lists them, and once the project sets bedrock guards.json `land.ignored`, refuses any outside that allowlist,
//     before it starts and again after the check (a check that leaves data behind is the same leftover);
//   - in the main checkout but not the worktree (#68; ecom-lab: a test read the repo's ignored data/, found none in the
//     worktree and passed, then failed where the data was): a land with a check names them beside the result.
// In the worktree one thing is left out: the views fold writes (state/views/<name>.json, the root's or a cell's). They
// are named by place and extension, not content: a file put there under such a name is not seen. Everything else is
// listed and judged, a stale state/log.lock, a kernel/node_modules/ or a .claude/ file included (a cell's worktree has
// none by design), and any other folder that merely has such a name (a review found data passing under them).
const VIEW = /^(cells\/[^/]+\/)?state\/views\/[^/]+\.json$/;
// In the main checkout, where the list only names what the check ran without, what the kit and Claude Code keep there.
const MAIN_LOCAL = [/^(cells\/[^/]+\/)?state\/views\//, /^(cells\/[^/]+\/)?state\/log\.lock$/, /^kernel\/node_modules\//, /^\.claude\/(settings\.local\.json$|worktrees\/)/];
interface IgnoredFile { path: string; bytes: number }
export interface Ignored { entry: string; files: IgnoredFile[] }

// Git's own list of what it ignores. Plain, it names every file (a nested repository as its folder); with --directory, a
// folder ignored whole is one name. Never --no-empty-directory: with it git leaves out the ignored files of a folder it
// doesn't track yet (a review found a land completing over them).
function lsIgnored(dir: string, folders: boolean): string[] {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.quotepath=off', 'ls-files', '-z', '-o', '-i', '--exclude-standard', ...(folders ? ['--directory'] : [])],
    { encoding: 'utf8', maxBuffer: 1 << 29 });
  if (r.status !== 0 || r.error) throw new WorktreeError(`git ls-files: ${(r.stdout + r.stderr).trim() || r.error?.message}`);
  return r.stdout.split('\0').filter(Boolean).sort();
}
// The folders git ignores whole, outermost only (the list is sorted: a folder's own entries follow it).
function wholeFolders(dir: string): string[] {
  const out: string[] = [];
  for (const p of lsIgnored(dir, true)) if (p.endsWith('/') && !(out.length && p.startsWith(out.at(-1)!))) out.push(p);
  return out;
}
function filesUnder(dir: string, rel: string): IgnoredFile[] {
  try {
    const st = lstatSync(join(dir, rel));
    if (!st.isDirectory()) return [{ path: rel, bytes: st.size }];
    const base = rel.replace(/\/$/, '');
    return readdirSync(join(dir, rel)).flatMap((n) => filesUnder(dir, `${base}/${n}`));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];          // gone since git listed it
    throw new WorktreeError(`can't read the git-ignored ${rel} in ${dir}: ${(e as Error).message}`);   // there, and unseen: no land
  }
}
const hasFile = (dir: string, rel: string): boolean => {
  try { return !lstatSync(join(dir, rel)).isDirectory() || readdirSync(join(dir, rel)).some((n) => hasFile(dir, `${rel.replace(/\/$/, '')}/${n}`)); }
  catch { return false; }
};
// Every git-ignored file in a checkout, with its size. The files come from git's plain list, so the count never depends
// on how folders are grouped; the grouping (a folder ignored whole is one entry, "data/") is for the report alone.
export function ignoredEntries(dir: string): Ignored[] {
  const folders = new Set(wholeFolders(dir));
  const by = new Map<string, IgnoredFile[]>();
  for (const f of lsIgnored(dir, false).flatMap((p) => filesUnder(dir, p)).filter((x) => !VIEW.test(x.path))) {
    const parts = f.path.split('/');
    let entry = f.path;
    for (let i = 1, at = ''; i < parts.length; i++) { at += `${parts[i - 1]}/`; if (folders.has(at)) { entry = at; break; } }
    if (!by.has(entry)) by.set(entry, []);
    by.get(entry)!.push(f);
  }
  return [...by].map(([entry, files]) => ({ entry, files }));
}
const SHOWN = 12;
const more = (shown: string[], n: number) => shown.join(' · ') + (n > SHOWN ? ` · and ${n - SHOWN} more` : '');
const size = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const bytesOf = (e: Ignored) => e.files.reduce((s, f) => s + f.bytes, 0);
// the largest first (ecom-lab's market held 1.3 GB in three of sixteen entries), and the sum when there are several
const show = (es: Ignored[]) => (es.length > 1 ? `${es.length} entries, ${size(es.reduce((s, e) => s + bytesOf(e), 0))} in all: ` : '')
  + more([...es].sort((a, b) => bytesOf(b) - bytesOf(a)).slice(0, SHOWN)
    .map((e) => `${e.entry} (${e.entry.endsWith('/') ? `${e.files.length} file(s), ` : ''}${size(bytesOf(e))})`), es.length);

// What the worktree holds that git ignores: a line for the land's report, and why the land must stop, if it must.
function leftovers(main: string, wt: string, name: string): { note: string | null; refuse: string | null } {
  const cfg = loadConfig(configPath(main));                               // an invalid one never gets here: the audit refuses it
  const all = ignoredEntries(wt);
  if (!all.length) return { note: null, refuse: null };
  if (!cfg.landIgnored) return { note: `git-ignored in the worktree, not landed: ${show(all)}`, refuse: null };
  const allow = cfg.landIgnored.map(globRe);
  const over = all.map((e) => ({ entry: e.entry, files: e.files.filter((f) => !allow.some((re) => re.test(f.path.toLowerCase()))) })).filter((e) => e.files.length);
  return { note: `git-ignored in the worktree, not landed (allowed by land.ignored): ${show(all)}`,
    refuse: over.length ? `cell ${name}'s worktree holds git-ignored files that bedrock guards.json (land.ignored) doesn't allow: ${show(over)}\nDelete them (what a run left behind doesn't outlive it), or propose them for land.ignored (the operator approves)` : null };
}
// The git-ignored paths the main checkout holds files in and the worktree doesn't (an empty folder of the same name is
// not the data): what the check ran without. Names only: the main checkout can hold whole clones.
function absent(main: string, wt: string): string | null {
  const names: string[] = [];
  for (const p of lsIgnored(main, true)) if (!MAIN_LOCAL.some((r) => r.test(p)) && !(names.length && names.at(-1)!.endsWith('/') && p.startsWith(names.at(-1)!))) names.push(p);
  const lacks = names.filter((p) => hasFile(main, p) && !hasFile(wt, p));
  return lacks.length ? `the check ran without the main checkout's git-ignored paths: ${more(lacks.slice(0, SHOWN), lacks.length)} (the worktree holds no file there: a test that reads one passes here whatever it holds)` : null;
}

// A reply's "Decisions to confirm" (#74; apify-actor-dev: a cell's reply listed "Caption not read: the research didn't
// use it" under that heading, root landed the work, nobody took the decision to the operator, and it shipped as a
// product limit a buyer found a day later). The brief asks every reply to end with that section ("none" if none); a
// land prints it, after everything else, for each reply it lands. The replies a land lands are the reply entries its
// branch adds to the cell's log; a reply's text is read from root's mailbox (the log may hold only its hash), else
// from the entry.
// Reading the section errs towards printing: a first reading that judged where a section ends by any line that looked
// like a heading printed nothing for grouped items, a sub-heading per decision or a second section (a review). So:
// the heading is the brief's words only, at the start of a line, whatever marks surround them; every such section is
// read; one under a # heading ends at the next # heading of its level or above, any other at the next # heading or
// the end of the reply (a bold line ends nothing: "None" then "**Except:**" was silent while it did); code fences hide
// nothing and end nothing; words in the heading's brackets are the section's first line. A section is
// silent only when every line of it says none (a second review: "None." followed by "except: capped the run at 50" was
// silent under a first-line rule); an empty one is said. What can't be told apart is printed.
//
// "Overturned" (#72; COCKPIT: a cell found root's own backbrief wrong in 2 of 3 expected labels, and a design's timeline
// short of 3 messages; both corrections were right, and nothing but the cell had checked either before they landed: the
// tests pass whether a correction is right or not, since the cell writes the code and the test that holds the new
// value). The brief asks for a second closing section headed "Overturned": each value the task or its sources gave that
// the work changed, with the evidence, or "none". It is read exactly as the first is, and a land that would land one
// with items stops until root says what it checked, against what: --checked "<…>", kept in the merge commit. A check is
// never by the claim's own voice: the cell's evidence is the claim. --checked with nothing overturned is refused too,
// so it is never typed out of habit.
const HEADS = {
  decisions: /^[^A-Za-z]*decisions?\s+(?:for\s+(?:you|root|the\s+operator)\s+)?to\s+(?:be\s+)?confirm(?:ed)?(?![A-Za-z0-9])/i,
  overturned: /^[^A-Za-z]*overturned(?:\s+(?:items?|values?))?(?![A-Za-z0-9])/i,
};
// "Overturned" as a list item ("- Overturned: my own earlier default of 50", "2. Overturned: …", "- **Overturned:**
// label 3") is both: a line of whatever section it stands in, which it doesn't end, and the heading of an Overturned
// section that runs as any other does. So what follows it under "Decisions to confirm" is printed as decisions and
// shown as overturned: twice, never lost. Read as a heading only, it took the rest of a Decisions section with it (a
// review); as a plain line only, a reply whose two closing sections were bullets landed its item unasked (the next);
// as an item with just the lines indented under it, its sibling bullets were in neither reading (the third).
const ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/;
type Head = keyof typeof HEADS;
const AFTER = /^[\s*_#.]*(?:\(([^)]*)\))?[\s*_#.]*(?:$|[:—–-]\s*(.*)$)/;      // alone on the line (a count or a note in brackets), or a colon or dash and the first item
const NONE = /^[^\p{L}\p{N}]*(?:none|nothing|n\/a|no\s+(?:decisions?|items?|values?))(?:\s+overturned)?[^\p{L}\p{N}]*$/iu;   // the word alone: no letter of any script beside it
const RECOVERED = /^\(recovered by cellrun from .*: the session finished but its reply was never filed\)$/;                         // cellrun's own line after a reply it filed from a run log
const FENCE = /^\s*(?:```|~~~)/, HASHES = /^\s{0,3}(#{1,6})\s/, RULE = /^[\s\-*_=~#>|`.]*$/;
// printed to a terminal: no control characters (a reply could redraw the land's own lines), no endless line (and a cut
// one says so: a paragraph of three decisions cut at the first is two decisions lost)
const LINE_MAX = 1000;
const printable = (l: string) => ((c) => (c.length > LINE_MAX ? `${c.slice(0, LINE_MAX)} … (line cut: read the reply)` : c))(l.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ''));
const sectionAt = (line: string): { head: Head; first: string[]; aside: boolean } | null => {
  for (const head of Object.keys(HEADS) as Head[]) {
    const m = HEADS[head].exec(line), rest = m && AFTER.exec(line.slice(m[0].length));
    if (!rest) continue;
    const note = /\p{L}/u.test(rest[1] ?? '') ? [`(${rest[1].trim()})`] : [], item = (rest[2] ?? '').replace(/^[\s*_]+/, '').trim();
    return { head, first: [...note, ...(item ? [item] : [])], aside: head === 'overturned' && ITEM.test(line) };
  }
  return null;
};
// The sections' lines, [] if each says none, null if the reply has no such section. Either heading ends the other's section.
export const decisionsIn = (reply: string) => sectionIn(reply, 'decisions');
export const overturnedIn = (reply: string) => sectionIn(reply, 'overturned');
function sectionIn(reply: string, want: Head): string[] | null {
  const lines = reply.split(/\r?\n/).map(printable), out: string[] = [];
  let found = false, fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) { fenced = !fenced; continue; }
    const head = fenced ? null : sectionAt(lines[i]);
    if (!head || head.head !== want) continue;
    found = true;
    const level = HASHES.exec(lines[i])?.[1].length;
    const body = [...head.first];
    let j = i + 1;
    for (let inFence = false; j < lines.length; j++) {
      if (FENCE.test(lines[j])) inFence = !inFence;
      else if (!inFence) {
        const h = HASHES.exec(lines[j])?.[1].length, s = sectionAt(lines[j]);
        if ((s && !s.aside) || (h && (!level || h <= level))) break;
      }
      body.push(lines[j].trimEnd());
    }
    const kept = body.filter((l) => l.trim()), said = kept.filter((l) => !RULE.test(l));   // a rule or a fence under the section says nothing
    if (!said.length) out.push('(this section is empty: read the reply)');
    else if (!said.every((l) => NONE.test(l) || RECOVERED.test(l))) out.push(...kept);
    i = j - 1;
  }
  return found ? out : null;
}
function repliesLanding(main: string, wt: string, name: string, into: string, pending: string[]): { id: string; text: string }[] {
  const log = `cells/${name}/state/log/`;
  const added = git(wt, ['diff', '--name-only', '--diff-filter=A', `${into}...HEAD`, '--', log], false);
  const files = [...new Set([...(added.ok ? added.out.split(/\r?\n/) : []), ...pending])].filter((p) => p.startsWith(log) && p.endsWith('.json')).sort();
  return files.flatMap((f) => {
    try {
      const p = (JSON.parse(readFileSync(join(wt, f), 'utf8')) as { body?: { source?: { capability?: string }; payload?: { id?: string; kind?: string; body?: string } } }).body;
      if (p?.source?.capability !== 'mail' || p.payload?.kind !== 'reply' || !p.payload.id) return [];
      let text = p.payload.body;                                            // the log's copy, unless root's mailbox has one that reads
      try { text = delivered(main, p.payload.id)?.body ?? text; } catch { /* a damaged mail file: the log's will do */ }
      return [{ id: p.payload.id, text: text ?? '' }];
    } catch { return []; }                                                  // not an entry: lint's business
  });
}
const SECTION_MAX = 40;
// a long one keeps its end: an item under a second heading, far below a first, was past the cut (a review)
const capped = (d: string[]) => (d.length <= SECTION_MAX ? d : [...d.slice(0, SECTION_MAX - 10), `… ${d.length - SECTION_MAX} more line(s) here: read the reply`, ...d.slice(-10)]).map((l) => `  ${l}`).join('\n');
// What the replies being landed overturn: the lines to show, and a line for each reply that has no such section.
function overturned(replies: { id: string; text: string }[]): { items: string[]; unread: string[]; absent: string[] } {
  const items: string[] = [], unread: string[] = [], absent: string[] = [];
  for (const { id, text } of replies) {
    const o = text ? overturnedIn(text) : null;
    // a reply that can't be read here is not a reply with nothing overturned (a review: with mail.log "hash" and no copy
    // in root's mailbox, as on a second machine, a reply with items landed unasked)
    if (!text) unread.push(id);
    else if (o === null) absent.push(`the reply being landed (${id}) has no "Overturned" section: read it for values the task or its sources gave that the work changed`);
    else if (o.length) items.push(`from the reply being landed (${id}):\n${capped(o)}`);
  }
  return { items, unread, absent };
}
function decisionNotes(replies: { id: string; text: string }[]): string[] {
  return replies.flatMap(({ id, text }) => {
    const d = text ? decisionsIn(text) : null;
    if (d === null) return [`the reply being landed (${id}) has no "Decisions to confirm" section${text ? '' : ' that can be read (its text is in neither root\'s mailbox nor the log)'}: read it for choices the cell made that nobody confirmed`];
    return d.length ? [`DECISIONS TO CONFIRM, from the reply being landed (${id}). Take each to the operator, or log it (constraint if they decided, assume if not):\n${capped(d)}`] : [];
  });
}

export interface LandOptions { name?: string; message?: string; check?: string; into?: string; dryRun?: boolean; acceptWeaker?: string; checked?: string }

// The steps taken, and `after`: what root must still do (a reply's decisions to confirm), for the caller to print last.
export type Landed = string[] & { after?: string[] };
export function cellLand(root: string, o: LandOptions): Landed {
  const main = inMain(root), name = o.name ?? '';
  const wt = cellWorktree(main, name);
  if (!wt) throw new WorktreeError(`cell ${name} has no worktree (node kernel/src/cli.ts cell checkout --name ${name})`);
  const busy = status(join(wt, 'cells', name)).working_on;
  if (busy) throw new WorktreeError(`cell ${name} is working on ${busy}; land it after its reply (if its session died: node kernel/src/cellrun.ts --cell ${name} --resume)`);
  const into = o.into ?? currentBranch(main);
  if (currentBranch(main) !== into) throw new WorktreeError(`the main checkout is on ${currentBranch(main)}, not ${into}`);
  const mine = dirty(main).filter((p) => !ROOT_WRITTEN.some((r) => r.test(p)));
  if (mine.length) {
    // #89 (ecom-lab: the operator's .vscode/settings.json stopped a verified landing). An untracked file still stops
    // it: root's own new work looks the same, and nothing unaccounted for sits in root when a cell lands. But say the
    // way out for a file that isn't the project's, which is neither committing nor deleting someone else's file.
    // not git(): its trim() takes a leading space off the first name
    const loose = new Set(spawnSync('git', ['-C', main, '-c', 'core.quotepath=off', 'ls-files', '-z', '-o', '--exclude-standard'], { encoding: 'utf8' }).stdout.split('\0').filter(Boolean));
    const foreign = mine.filter((p) => loose.has(p));
    throw new WorktreeError(`root has uncommitted work of its own: ${mine.join(', ')} (commit or stash it first${foreign.length
      ? `; an untracked file that isn't the project's, such as editor settings, can be ignored on this machine instead: add its path to .git/info/exclude (untracked here: ${foreign.join(', ')})` : ''})`);
  }
  const bad = cellAudit(main, name);
  if (bad.length) throw new WorktreeError(`cell ${name} changed paths outside cells/${name}/: ${bad.join(', ')}`);
  const left = leftovers(main, wt, name);
  if (left.refuse) throw new WorktreeError(left.refuse);

  const branch = cellBranch(name), message = o.message ?? `cell ${name}: work`;
  const pending = dirty(wt);
  // weaker in the tree being landed (w), and weaker in a tree a command of the run ran against, since put back (#72)
  const cellDir = join(wt, 'cells', name);
  // A state's finding is the tree's own, and not said twice, when the words are the tree's and the bytes are those now on
  // disk. The words alone are not enough: one assertion off for a proof and put back, then another dropped for good, is
  // "1 fewer assertion line(s)" both times (a review).
  const onDisk = (p: string, like: number) => { try { return blobName(readFileSync(join(wt, p)), like); } catch { return null; } };
  const during = (w: string[]): Was[] => {
    const out = new Map<string, Was>();
    for (const d of weakerDuring(cellDir, wt, into))
      if (!(w.includes(d.what) && (d.path === undefined || onDisk(d.path, d.name?.length ?? 40) === d.name)) && !out.has(d.what)) out.set(d.what, d);
    return [...out.values()];
  };
  const duringLines = (d: Was[]) => d.map((x) => `${x.what} (first seen ${x.at})`);
  const weakerNote = (w: string[], d: Was[]) => [
    ...(w.length ? [`the cell's tests got weaker:\n  ${w.join('\n  ')}`] : []),
    ...(d.length ? [`the cell's tests were weaker during its run than they are now: a command ran while they were, so a proof made then rests on the cell's word:\n  ${duringLines(d).join('\n  ')}`] : []),
    `Land it anyway only on the operator's word: ! node kernel/src/cli.ts cell land --name ${name} … --accept-weaker "<why>"`].join('\n');
  const replies = repliesLanding(main, wt, name, into, pending);
  const over = overturned(replies);
  const overText = [
    ...(over.items.length ? [`cell ${name} overturned values the task or its sources gave:\n${over.items.join('\n')}`] : []),
    ...(over.unread.length ? [`the text of ${over.unread.length > 1 ? 'replies' : 'a reply'} being landed (${over.unread.join(', ')}) can't be read here (it is in neither root's mailbox nor the log), so nor can what it overturned`] : [])].join('\n');
  const overNote = !overText ? null : [overText,
    ...(over.items.length ? ['The land\'s check can\'t tell whether a correction is right: the cell wrote both the code and the test that holds the new value. Check at least one item against its source yourself, then land with --checked "<what you checked, against what>". If a section in fact says nothing was overturned (a "none" with more text after it), say that instead: --checked "nothing overturned: <why the rest is no item>"'] : []),
    ...(over.unread.length ? ['Read an unread reply where you have it (the session that received it), or ask the cell to send it again, then land with --checked "<what its Overturned section says, and what you checked>"'] : [])].join('\n');
  const checked = o.checked?.trim();
  // a value that is the next option ("--checked --message x") is a forgotten value, not a check; the same for --accept-weaker
  const bare = (v: string | undefined) => v !== undefined && (!v.trim() || /^--\S*$/.test(v.trim()));
  const overRefusal = bare(o.checked) ? '--checked needs what you checked, against what, in quotes'
    : bare(o.acceptWeaker) ? '--accept-weaker needs the operator\'s reason, in quotes'
    : overNote && !checked ? overNote
    : checked && !overNote ? '--checked was given, but no reply being landed lists overturned items: drop it (it records a check of an "Overturned" section, nothing else)' : null;
  if (overRefusal && !o.dryRun) throw new WorktreeError(overRefusal);
  const decisions = [...over.absent, ...decisionNotes(replies)];
  const strayNote = (paths: string[]) => `the check left uncommitted paths in the worktree: ${more(paths.slice(0, SHOWN), paths.length)}`;
  if (o.dryRun) {
    const plan = [
      pending.length ? `would commit ${pending.length} path(s) on ${branch}: "${message}"` : `nothing uncommitted on ${branch}`,
      ...(overRefusal ? [`would stop: ${overRefusal}`] : []),
      ...((w) => ((d) => (w.length || d.length ? [`would stop: ${weakerNote(w, d)}`]
        : o.acceptWeaker ? ['would stop: --accept-weaker was given, but no test is or was weaker: drop it'] : []))(during(w)))(weakerTests(wt, git(wt, ['merge-base', into, 'HEAD']).out)),
      `would merge ${into} into ${branch}${o.check ? `, then run in ${wt} under ${SHELL}: ${o.check}` : ''}`,
    ];
    if (o.check) {
      // the check is the step most likely to fail (COCKPIT #76: a subshell cd that cmd.exe doesn't scope): run it now, on
      // the worktree as it stands, before the merge; then read what it left behind, as the land does
      const r = runCheck(o.check, wt);
      plan.push(r.status === 0 ? 'the check passes now, before the merge'
        : `would stop: the check fails now, before the merge (exit ${r.status}):\n${(r.stdout + r.stderr).trim().split(/\r?\n/).slice(-15).join('\n')}`);
      const l = leftovers(main, wt, name), a = absent(main, wt), stray = dirty(wt).filter((p) => !pending.includes(p));
      if (l.refuse) plan.push(`would stop: ${l.refuse}`);
      else if (l.note) plan.push(l.note);
      if (a) plan.push(a);
      if (stray.length) plan.push(strayNote(stray));
    } else if (left.note) plan.push(left.note);
    return [...plan, `would merge ${branch} into ${into} (--no-ff), sync the cell and commit root's log`, ...decisions];
  }

  const steps: Landed = [];
  steps.after = decisions;
  const start = head(wt);
  if (pending.length) {
    // the cell's folder, and each path it owns that has changes (git refuses a pathspec matching nothing)
    const owned = (loadConfig(configPath(main)).owns[name] ?? []).filter((g) => pending.some((p) => globRe(g).test(p.toLowerCase())));
    const spec = [`cells/${name}`, ...owned.map((g) => `:(glob)${g}`)];
    git(wt, ['add', '-A', '--', ...spec]);
    git(wt, ['commit', '-q', '-m', message, '--', ...spec]);
    steps.push(`committed on ${branch}: ${head(wt).slice(0, 9)}`);
  }
  const committed = head(wt);
  // Back to before the land: drop the merge (all work was committed, so --hard loses nothing), then un-commit the
  // cell's work, leaving it staged in the worktree as it was.
  const undo = (why: string): never => {
    git(wt, ['merge', '--abort'], false);
    const hard = git(wt, ['reset', '--hard', '-q', committed], false).ok;
    const soft = git(wt, ['reset', '--soft', '-q', start], false).ok;
    // said only if true: an undo runs when something already failed, and its own git commands can fail the same way
    // (both resets, not the head alone: a --hard that fails on a locked file leaves the merge in the tree)
    const back = hard && soft && git(wt, ['rev-parse', 'HEAD'], false).out === start;
    // the views follow the log back (if the merge was made, they were rebuilt from the merged one; before it, this
    // changes nothing); best effort: views are disposable, lint says
    try { refoldPresent(wt); } catch { /* the reason for the undo is what matters */ }
    throw new WorktreeError(`${why}\n${back ? `${branch} is back where it was (${start.slice(0, 9)}); nothing was landed`
      : `nothing was landed, but ${branch} could NOT be put back to ${start.slice(0, 9)}: look at ${wt} (git status, git log) before anything else`}`);
  };
  let weaker: string[] = [], was: Was[] = [];
  try { weaker = weakerTests(wt, `${into}...${committed}`); was = during(weaker); }
  catch (e) { undo((e as Error).message); }
  if ((weaker.length || was.length) && !o.acceptWeaker) undo(weakerNote(weaker, was));
  // as --checked: an acceptance of nothing is a habit, and would sit in no commit
  if (o.acceptWeaker && !weaker.length && !was.length) undo('--accept-weaker was given, but no test is or was weaker: drop it');
  if (weaker.length || was.length) steps.push(`weaker tests accepted by the operator: ${o.acceptWeaker}`);
  if (checked) steps.push(`overturned items checked by root: ${checked}`);
  const merged = git(wt, ['merge', '-q', '--no-edit', into], false);
  if (!merged.ok) undo(`merging ${into} into ${branch} conflicted. Resolve it in ${wt} (git merge ${into}), then land again.\n${merged.out}`);
  steps.push(`merged ${into} into ${branch}`);
  const after = cellAudit(main, name);
  if (after.length) undo(`after merging ${into}, cell ${name} differs outside its folder: ${after.join(', ')}`);
  // the merge brought ${into}'s log entries in; the views in the worktree are git-ignored and still as folded before it (#102)
  let behind: string[] = [];
  try { behind = refoldPresent(wt); }
  catch (e) { undo(`after merging ${into}, views in ${wt} couldn't be rebuilt from the merged log, so the check would run on views older than it: ${(e as Error).message}\nIf it is a log that can't be read, lint says which entry (node kernel/src/cli.ts lint --all); to land without those views, delete that folder's state/views in the worktree`); }
  if (behind.length) steps.push(`rebuilt the worktree's views from the merged log: ${behind.join(', ')}`);
  let leftNow = left;
  if (o.check) {
    const before = new Set(dirty(wt));
    const r = runCheck(o.check, wt);
    if (r.status !== 0) undo(`check failed in ${wt} (${o.check}, exit ${r.status}):\n${(r.stdout + r.stderr).trim().split(/\r?\n/).slice(-15).join('\n')}`);
    steps.push(`check passed: ${o.check}`);
    // What the check left behind. If that can't be read, the land is undone, not left half done.
    let unread: string | null = null, missing: string | null = null, stray: string[] = [];
    try { leftNow = leftovers(main, wt, name); missing = absent(main, wt); stray = dirty(wt).filter((p) => !before.has(p)); }
    catch (e) { unread = (e as Error).message; }
    if (unread) undo(`after the check, the worktree's git-ignored files couldn't be listed: ${unread}`);
    if (leftNow.refuse) undo(`after the check: ${leftNow.refuse}`);
    if (missing) steps.push(missing);
    // not ignored, so git shows them: the next land commits those in the cell's folder and its audit refuses the others
    if (stray.length) steps.push(strayNote(stray));
  }
  if (leftNow.note) steps.push(leftNow.note);
  const ahead = git(main, ['rev-list', '--count', `${into}..${branch}`]).out;
  // an acceptance is kept in the merge commit, and there is none: the record stays for the land that has one
  if (ahead === '0') { steps.push(`nothing to land${was.length ? '; the record of tests that were weaker during the run is kept (an acceptance is recorded with a landing)' : ''}`); return steps; }
  const why = (weaker.length || was.length ? `\n\nWeaker tests, accepted by the operator: ${o.acceptWeaker}\n  ${[...weaker, ...duringLines(was).map((l) => `during the run, since put back: ${l}`)].join('\n  ')}` : '')
    + (checked ? `\n\n${over.items.length ? 'Overturned by the cell' : 'A reply that could not be read here'}, checked by root: ${checked}\n${overText.replace(/^cell [^\n]* gave:\n/, '')}` : '');
  const landed = git(main, ['merge', '-q', '--no-ff', '-m', `Land ${branch}: ${message}${why}`, branch], false);
  if (!landed.ok) { git(main, ['merge', '--abort'], false); throw new WorktreeError(`merging ${branch} into ${into} failed; aborted.\n${landed.out}`); }
  steps.push(`landed ${branch} on ${into}: ${head(main).slice(0, 9)} (${ahead} commit(s); undo with git revert -m 1 ${head(main).slice(0, 9)})`);
  forgetWeaker(cellDir);                                                    // the record is of this landing's run; the next starts empty
  return steps;
}

// Commit what the kernel wrote in root's checkout (mail and sync entries, the generated assumptions), and nothing else.
export function commitRootLog(root: string, message: string): string | null {
  const main = inMain(root);
  const paths = dirty(main).filter((p) => /^state\/log\//.test(p) || p === 'docs/assumptions.md');
  if (!paths.length) return null;
  git(main, ['add', '--', ...paths]);
  git(main, ['commit', '-q', '-m', message, '--', ...paths]);
  return head(main).slice(0, 9);
}
