// Did the cell's tests get weaker? `cell land --check` proves the tests pass, not that they still test anything: in
// AI-MMO a cell added an allowance to a test so a regression passed, and the check stayed green. This reads the cell
// branch's diff of its test files and reports what got weaker (a file the branch creates can't be):
//   - test files deleted · fewer test cases (test/it/describe, def test_, func Test, [Fact]/[Test])
//   - skips added (.skip/.todo, xit/xdescribe, { skip: }, @skip, t.Skip, [Ignore], @Disabled)
//   - fewer assertions (assert/expect/should)
//   - loosening added: `|| true`, an empty catch, tolerance/approx/epsilon/atol/rtol, toBeCloseTo
// A heuristic, like the guards: it counts lines, it doesn't read code. A finding stops the land; only the operator lands
// it anyway, with a reason (`--accept-weaker "<why>"`, hook-blocked for agents) that goes into the merge commit.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { mailbox } from './mail.ts';
import { inMain, samePath, WorktreeError } from './worktree.ts';

// Prose is never a test, whatever its name: a post called catching-weakened-tests.md that quotes `a || b` is not a
// loosened test (project-archivist hit this).
export const TEST_FILE = /^(?!.*\.(md|mdx|markdown|txt|rst|adoc)$)(?:.*(^|\/)(test|tests|__tests__|spec|specs)\/|.*[._-](test|spec)s?\.[a-z0-9]+$|(.*\/)?test_[^/]*\.py$|.*_test\.(py|go)$)/i;
const CASE = /^\s*(test|it|describe)(\.only)?\s*\(|^\s*(async\s+)?def\s+test_|^\s*func\s+Test|^\s*\[(Fact|Test|TestMethod|Theory)\]/;
const SKIP = /\.(skip|todo)\s*\(|\b(xit|xdescribe|xtest)\s*\(|\{\s*skip\s*:|@(pytest\.mark\.)?skip|\bt\.Skip(Now|f)?\(|\[Ignore\]|@Disabled/;
const ASSERT = /\b(assert|expect|should)\b/;
const LOOSE = /\|\|\s*true\b|catch\s*(\([^)]*\))?\s*\{\s*\}|\b(tolerance|approx|epsilon|atol|rtol)\b|toBeCloseTo/i;

interface Count { cases: number; skips: number; asserts: number; loose: number }

// git diff as written here, whatever the repository's or the user's git settings say: a.. b.. prefixes (not
// diff.mnemonicPrefix's w/ and i/, which named one test two ways), no external diff program and no textconv (either can
// print nothing for a test: a review emptied the comparison with one `git config`), and --text for the lines of a file an
// attribute calls binary. Only the test files are diffed, by name: a 135 MB data file rewritten on the same branch
// overran the buffer and, once a failed diff stopped the land, stopped it with no way through.
// Nor what the environment says: GIT_LITERAL_PATHSPECS made the names below match nothing, without an error. And
// objects as they are, not as `git replace` says: a replaced base hid a whole run's weakening.
const GIT = ['-c', 'core.quotepath=off', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false'];
const ENV = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(LITERAL_PATHSPECS|GLOB_PATHSPECS|NOGLOB_PATHSPECS|ICASE_PATHSPECS|EXTERNAL_DIFF|DIFF_OPTS)$/i.test(k))), GIT_NO_REPLACE_OBJECTS: '1' });
export function weakerTests(dir: string, range: string): string[] {
  const diff = (...a: string[]) => {
    const r = spawnSync('git', ['-C', dir, ...GIT, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: ENV() });
    // a diff that fails is not "nothing weaker": it stops the land
    if (r.status !== 0) throw new WorktreeError(`the tests couldn't be compared (git diff ${range}): ${(r.stderr || String(r.error ?? '')).trim()}`);
    return r.stdout;
  };
  const files = diff('--name-only', '-z', range).split('\0').filter((f) => f && TEST_FILE.test(f));
  let patch = '';
  // in batches a command line holds (Windows: 32,767 characters)
  for (let i = 0, n = 0; i < files.length; i += n) {
    for (n = 0; i + n < files.length && (n === 0 || files.slice(i, i + n + 1).join(' ').length < 16000) && n < 100;) n++;
    patch += `${diff('--text', '--unified=0', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', range, '--', ...files.slice(i, i + n).map((f) => `:(literal)${f}`))}\n`;
  }
  const per = new Map<string, { add: Count; del: Count; deleted: boolean; created: boolean }>();
  let file = '', from = '';
  const zero = (): Count => ({ cases: 0, skips: 0, asserts: 0, loose: 0 });
  for (const line of patch.split(/\r?\n/)) {
    // git ends a name that holds a space with a tab ("+++ b/src/my guard.test.ts\t"): such a test was never seen
    if (line.startsWith('--- ')) { from = line.slice(4).replace(/\t$/, '').replace(/^a\//, ''); continue; }
    if (line.startsWith('+++ ')) {
      const to = line.slice(4).replace(/\t$/, '');
      file = to === '/dev/null' ? from : to.replace(/^b\//, '');
      if (TEST_FILE.test(file)) per.set(file, { add: zero(), del: zero(), deleted: to === '/dev/null', created: from === '/dev/null' });
      continue;
    }
    const f = per.get(file);
    if (!f || !/^[+-]/.test(line)) continue;
    const c = line[0] === '+' ? f.add : f.del, text = line.slice(1);
    if (CASE.test(text)) c.cases++;
    if (SKIP.test(text)) c.skips++;
    if (ASSERT.test(text)) c.asserts++;
    if (LOOSE.test(text)) c.loose++;
  }
  const out: string[] = [];
  for (const [f, { add, del, deleted, created }] of per) {
    // A new file has no earlier version to be weaker than (ecom-lab #71: its pytest.approx lines read as loosening);
    // a test moved into it from an old file shows on the old one, as fewer cases.
    if (created) continue;
    if (deleted) out.push(gone(f, del)); else out.push(...judge(f, del, add));
  }
  return out;
}
// The findings for one file, from what it held before and holds now (or from the lines a diff took out and put in: the
// differences are the same).
const gone = (f: string, was: Count) => `${f}: deleted (${was.cases} test case(s), ${was.asserts} assertion(s))`;
const judge = (f: string, was: Count, now: Count): string[] => [
  ...(was.cases > now.cases ? [`${f}: ${was.cases - now.cases} fewer test case(s)`] : []),
  ...(now.skips > was.skips ? [`${f}: ${now.skips - was.skips} skip(s) added`] : []),
  ...(was.asserts > now.asserts ? [`${f}: ${was.asserts - now.asserts} fewer assertion line(s)`] : []),
  ...(now.loose > was.loose ? [`${f}: loosened (${now.loose - was.loose} line(s) with || true, an empty catch, or a tolerance)`] : [])];
const count = (text: string): Count => {
  const c: Count = { cases: 0, skips: 0, asserts: 0, loose: 0 };
  for (const l of text.split(/\r?\n/)) { if (CASE.test(l)) c.cases++; if (SKIP.test(l)) c.skips++; if (ASSERT.test(l)) c.asserts++; if (LOOSE.test(l)) c.loose++; }
  return c;
};

// Weaker for a while, then put back (#72; COCKPIT: for a "planted write" proof a cell switched a guard assertion off
// with sed, ran the proof, and restored the line: the final tree passed, and the comparison above reads only the final
// tree). So what the tests held is written down while the cell works: before each shell command of a cell session
// (hook-bash.ts), the commit the worktree is on and, for each test file of that commit whose bytes on disk are not the
// commit's, those bytes (gone is gone). The record and the bytes are kept in the cell's mailbox, which is in no checkout
// and which the cell's guards keep it out of. A command is when a test runs, so it holds the states commands ran
// against; an edit undone before any command isn't in it, nor a test weakened and restored inside one command (a
// guard's business, #82).
// The hook only writes down; the land judges, because only the land knows what the work is landing into. Each state is
// compared with where the cell had left that branch at the time (the merge base of <into> and the commit it was on):
// what main itself changed is never the cell's. Four rounds of review went on judging in the hook, against a base
// guessed there: the main checkout's HEAD (root sat detached at an older commit), every other branch (a branch root made
// at the cell's tip), a branch named main or master (a project whose trunk is develop): each wrote down as the cell's a
// weakening that was main's. What is weaker in a state and not in the tree being landed stops the land like any weaker
// test; the record is cleared when the work lands.
// Every test file is read, and its bytes are what is compared: git is asked what the commit holds, never what changed.
// So what changes git's view of a file doesn't hide it: assume-unchanged, a diff attribute, a same-size edit with the
// old modification time put back (git trusts the stat data; a review). The bytes are kept as files, not as git objects:
// unreferenced objects are pruned after two weeks, and a run landed later than that was refused over states that could
// no longer be read (the same review).
// Left out, each for a setup it broke in review: a file over 1 MB (any file under a test/ folder has a test file's name:
// a 150 MB fixture was read before every command and copied once changed); a file another program holds open (it
// refused every command); bytes git stores as the commit's (CRLF on disk under core.autocrlf put all 500 test files in
// every state; a filtered fixture read as loosened though untouched); a file a sparse checkout left out. Each is a way
// past for a cell that sets out to hide a test, as one command that weakens, tests and restores already is: the record
// is for what a cell does in the open, the guards for the rest.
const record = (cellDir: string) => join(mailbox(cellDir), 'weaker.jsonl');
const kept = (cellDir: string) => join(mailbox(cellDir), 'weaker');
const SHA = /^[0-9a-f]{40,64}$/, BIG = 1 << 20;
// A file's name as git would name its bytes, unfiltered: equal to the commit's name for it when nothing changed.
export const blobName = (bytes: Buffer, like = 40) => createHash(like === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
interface State { at: string; head: string; files: Record<string, string | null> }
const gitIn = (dir: string, ...a: string[]) => spawnSync('git', ['-C', dir, '-c', 'core.quotepath=off', ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: ENV() });
export function noteWeaker(cellDir: string): void {
  const wt = resolve(cellDir, '..', '..');
  if (samePath(inMain(wt), wt)) return;                                     // no repository, or no worktree of its own: no land from here
  const must = (r: ReturnType<typeof gitIn>, what: string) => { if (r.status !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout || String(r.error ?? '')).trim()}`); return r.stdout; };
  const head = must(gitIn(wt, 'rev-parse', '--verify', 'HEAD^{commit}'), 'git rev-parse HEAD').trim();
  // left out by a sparse checkout: marked skip-worktree in a worktree that is one (the mark alone is one command away)
  let sparse: Set<string> | null = null;                                    // asked only if a test file is not on disk
  const leftOut = (p: string) => (sparse ??= new Set(gitIn(wt, 'config', '--get', '--type=bool', 'core.sparseCheckout').stdout.trim() !== 'true' ? []
    : must(gitIn(wt, 'ls-files', '-v', '-z'), 'git ls-files').split('\0').filter((l) => l.startsWith('S ')).map((l) => l.slice(2)))).has(p);
  const files: Record<string, string | null> = {};
  const differ: { path: string; name: string; now: string; bytes: Buffer }[] = [];
  for (const l of must(gitIn(wt, 'ls-tree', '-r', '-z', 'HEAD'), 'git ls-tree').split('\0')) {
    const m = /^(100644|100755) blob ([0-9a-f]+)\t(.+)$/s.exec(l);          // files; a link or a submodule is not a test's text
    if (!m || !TEST_FILE.test(m[3])) continue;
    const [, , name, path] = m;
    let bytes: Buffer | null = null;
    try {
      const st = lstatSync(join(wt, path));
      if (st.isFile() && st.size > BIG) continue;
      if (st.isFile()) bytes = readFileSync(join(wt, path));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EBUSY' || code === 'EACCES' || code === 'EPERM') continue;   // held by another program: unseen, not a refused command
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
      if (leftOut(path)) continue;
    }
    if (!bytes) { files[path] = null; continue; }                           // gone, or a folder where it was
    const now = blobName(bytes, name.length);
    if (now !== name) differ.push({ path, name, now, bytes });
  }
  // Bytes that differ from the commit's are still the commit's file if git, converting them as it would to store them,
  // gets the commit's name: line endings under core.autocrlf, a fixture kept through a filter (Git LFS). If git can't
  // say, they differ.
  const asGit = differ.length ? spawnSync('git', ['-C', wt, 'hash-object', '--stdin-paths'], { input: differ.map((d) => d.path).join('\n'), encoding: 'utf8', env: ENV() }) : null;
  const names = asGit?.status === 0 ? asGit.stdout.trim().split(/\r?\n/) : [];
  differ.forEach((d, k) => {
    if (names.length === differ.length && names[k] === d.name) return;
    files[d.path] = d.now;
    if (!existsSync(join(kept(cellDir), d.now))) { mkdirSync(kept(cellDir), { recursive: true }); writeFileSync(join(kept(cellDir), d.now), d.bytes); }
  });
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
  const file = record(cellDir);
  const last = existsSync(file) ? readFileSync(file, 'utf8').trimEnd().split('\n').at(-1) ?? '' : '';
  try { const l = JSON.parse(last) as State; if (l.head === head && JSON.stringify(l.files) === JSON.stringify(sorted)) return; } catch { /* no last line that reads: write */ }
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), head, files: sorted } satisfies State)}\n`);
}
// What was weaker in the states the record holds, with when each was first seen, and for a finding about bytes the
// worktree had of its own, the file and the name of those bytes (null: gone). `dir` is the cell's worktree, `into` the
// branch the work is landing on. What can't be read is a finding: a line of the record, a commit it names, the bytes of
// a state.
export interface Was { what: string; at: string; path?: string; name?: string | null }
export function weakerDuring(cellDir: string, dir: string, into: string): Was[] {
  const file = record(cellDir);
  if (!existsSync(file)) return [];
  const seen = new Map<string, Was>();
  const note = (w: Was) => { const k = `${w.what}\0${w.path ?? ''}\0${w.name ?? ''}`; if (!seen.has(k)) seen.set(k, w); };
  const heads = new Map<string, { base: string; found: string[] } | null>(), counts = new Map<string, Count | null>();
  const countOf = (key: string, read: () => string | null) => { if (!counts.has(key)) { const t = read(); counts.set(key, t === null ? null : count(t)); } return counts.get(key)!; };
  const atBase = (object: string) => countOf(object, () => { const r = gitIn(dir, 'cat-file', 'blob', object); return r.status === 0 ? r.stdout : null; });
  const ofState = (name: string) => countOf(name, () => { try { return readFileSync(join(kept(cellDir), name), 'utf8'); } catch { return null; } });
  for (const line of readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())) {
    let e: State | null = null;
    try { e = JSON.parse(line) as State; } catch { /* below */ }
    const ok = e && typeof e.at === 'string' && typeof e.head === 'string' && SHA.test(e.head) && e.files && typeof e.files === 'object'
      && Object.values(e.files).every((b) => b === null || (typeof b === 'string' && SHA.test(b)));
    if (!e || !ok) { note({ what: 'the record of this run holds a line that can\'t be read', at: 'unknown' }); continue; }
    if (!heads.has(e.head)) {
      const mb = gitIn(dir, 'merge-base', into, e.head);
      heads.set(e.head, mb.status === 0 ? { base: mb.stdout.trim(), found: weakerTests(dir, `${mb.stdout.trim()}..${e.head}`) } : null);
    }
    const h = heads.get(e.head), at = e.at;
    if (!h) { note({ what: `the record of this run names a commit (${e.head.slice(0, 9)}) that is gone, or shares none with ${into}`, at }); continue; }
    const own = Object.keys(e.files);
    for (const what of h.found) if (!own.some((p) => what.startsWith(`${p}: `))) note({ what, at });   // the commit's, but for the files the worktree had its own of
    for (const [path, name] of Object.entries(e.files)) {
      const was = atBase(`${h.base}:${path}`);
      if (!was) continue;                                                   // not there when the cell left the branch: a new file can't be weaker
      const now = name === null ? null : ofState(name);
      if (name === null) note({ what: gone(path, was), at, path, name });
      else if (!now) note({ what: `${path}: what it held during the run can no longer be read`, at, path, name });
      else for (const what of judge(path, was, now)) note({ what, at, path, name });
    }
  }
  return [...seen.values()];
}
export const forgetWeaker = (cellDir: string) => { rmSync(record(cellDir), { force: true }); rmSync(kept(cellDir), { recursive: true, force: true }); };
