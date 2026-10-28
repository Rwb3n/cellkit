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

// Prose is never a test, whatever its name: a post called catching-weakened-tests.md that quotes `a || b` is not a
// loosened test (project-archivist hit this).
export const TEST_FILE = /^(?!.*\.(md|mdx|markdown|txt|rst|adoc)$)(?:.*(^|\/)(test|tests|__tests__|spec|specs)\/|.*[._-](test|spec)s?\.[a-z0-9]+$|(.*\/)?test_[^/]*\.py$|.*_test\.(py|go)$)/i;
const CASE = /^\s*(test|it|describe)(\.only)?\s*\(|^\s*(async\s+)?def\s+test_|^\s*func\s+Test|^\s*\[(Fact|Test|TestMethod|Theory)\]/;
const SKIP = /\.(skip|todo)\s*\(|\b(xit|xdescribe|xtest)\s*\(|\{\s*skip\s*:|@(pytest\.mark\.)?skip|\bt\.Skip(Now|f)?\(|\[Ignore\]|@Disabled/;
const ASSERT = /\b(assert|expect|should)\b/;
const LOOSE = /\|\|\s*true\b|catch\s*(\([^)]*\))?\s*\{\s*\}|\b(tolerance|approx|epsilon|atol|rtol)\b|toBeCloseTo/i;

interface Count { cases: number; skips: number; asserts: number; loose: number }

export function weakerTests(dir: string, range: string): string[] {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.quotepath=off', 'diff', '--unified=0', '--no-color', '--no-renames', range], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) return [];
  const per = new Map<string, { add: Count; del: Count; deleted: boolean; created: boolean }>();
  let file = '', from = '';
  const zero = (): Count => ({ cases: 0, skips: 0, asserts: 0, loose: 0 });
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith('--- ')) { from = line.slice(4).replace(/^a\//, ''); continue; }
    if (line.startsWith('+++ ')) {
      const to = line.slice(4);
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
    if (deleted) { out.push(`${f}: deleted (${del.cases} test case(s), ${del.asserts} assertion(s))`); continue; }
    if (del.cases > add.cases) out.push(`${f}: ${del.cases - add.cases} fewer test case(s)`);
    if (add.skips > del.skips) out.push(`${f}: ${add.skips - del.skips} skip(s) added`);
    if (del.asserts > add.asserts) out.push(`${f}: ${del.asserts - add.asserts} fewer assertion line(s)`);
    if (add.loose > del.loose) out.push(`${f}: loosened (${add.loose - del.loose} line(s) with || true, an empty catch, or a tolerance)`);
  }
  return out;
}
