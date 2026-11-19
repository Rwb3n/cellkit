// Root's session-start report (SessionStart hook, root's .claude/settings.json only; a cell is never told): one line
// per report, never a value, never a refusal (always exit 0). Run as its own script, not through cli.ts, which loads the
// repo's env file into its own environment: this one only ever reads the names in it.
//   kit (#103)   the project's kit version (kernel/package.json) against the newest v* tag of the kit's repository:
//                behind, level, ahead, or unknown, never silence. The lookup is `git ls-remote --tags` with a short
//                timeout and no prompt, cached: a success for KIT_FRESH_H hours, a failure for KIT_RETRY_H.
//   keys (#121)  the names of the variables the project declares (guards.json `keys`) that are in neither the main
//                checkout's env file nor the session's environment. Nothing declared: no line.
// Both results go to <git common dir>/cellkit-start.json for other tools to read (#100 will report it): never in a
// checkout, never committed, one per clone.
// The kit's repository: CELLKIT_UPSTREAM (tests), else a remote named for cellkit, else the kit's canonical URL.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, loadConfig, VAR_NAME, type Keys } from './config.ts';
import { gitCommonDir, inMain } from './worktree.ts';

export const KIT_URL = 'https://github.com/Rwb3n/cellkit.git';
const KIT_FRESH_H = 20, KIT_RETRY_H = 1, TIMEOUT_MS = 5000;

type Version = [number, number, number];
const parse = (v: string): Version | null => { const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim()); return m ? [+m[1], +m[2], +m[3]] : null; };
const cmp = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const show = (v: Version) => `v${v.join('.')}`;
// a release is tagged vX.Y.Z: not 0.9.0, not v0.7.0-rc1
const release = (tag: string) => (/^v\d+\.\d+\.\d+$/.test(tag) ? parse(tag) : null);
// a URL as it may be written down: without a user or token in it (#100 will print the report)
// (up to the last @: a password with an unescaped @ or / is still taken out whole; a path with an @ loses its host too)
export const bare = (url: string) => url.replace(/^([a-z][\w+.-]*:\/\/).*@/i, '$1');

export interface KitCache { url: string; latest: string | null; checked_at: string; ok: boolean; error?: string; last_ok_at?: string }
export interface KitReport extends KitCache { version: string | null; state: 'behind' | 'level' | 'ahead' | 'unknown'; line: string; fetched: boolean }
export interface KeysReport { declared: string[]; missing: string[]; found: Record<string, 'env file' | 'environment'>; from: string; error?: string; line: string }

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' } });

// a remote of this repository named for the kit (its URL ends in /cellkit or /cellkit.git), else the kit's own URL
export function kitUrl(root: string): string {
  if (process.env.CELLKIT_UPSTREAM) return process.env.CELLKIT_UPSTREAM;
  const r = git(root, ['remote', '-v']);
  const hit = (r.stdout ?? '').split(/\r?\n/).map((l) => l.split(/\s+/)[1]).find((u) => u && /[\\/:]cellkit(\.git)?\/?$/i.test(u));
  return hit ?? KIT_URL;
}

// the newest vX.Y.Z tag at url, or why not
export function newestTag(root: string, url: string): { latest: string | null; error?: string } {
  // An ssh remote asks its host-key and passphrase questions on the terminal Claude Code is using, and a timeout stops
  // git, not the ssh it started. BatchMode makes ssh fail instead of asking, unless the project set its own ssh command.
  const ssh = !/^(https?|file):\/\//i.test(url) && /^[\w.-]+@[\w.-]+:|^ssh:\/\//i.test(url)
    && !process.env.GIT_SSH_COMMAND && !process.env.GIT_SSH && !git(root, ['config', '--get', 'core.sshCommand']).stdout?.trim();
  const r = git(root, [...(ssh ? ['-c', 'core.sshCommand=ssh -o BatchMode=yes'] : []), 'ls-remote', '--tags', '--refs', url]);
  if (r.error || r.status !== 0) {
    const why = r.error ? ((r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? `no answer in ${TIMEOUT_MS / 1000} s` : r.error.message)
      : (r.stderr ?? '').trim().split(/\r?\n/).at(-1) || `git exited ${r.status}`;
    return { latest: null, error: `remote unreachable: ${why}` };
  }
  const tags = (r.stdout ?? '').split(/\r?\n/).map((l) => /refs\/tags\/(.+)$/.exec(l)?.[1]).map((t) => (t ? release(t) : null)).filter((v): v is Version => !!v);
  if (!tags.length) return { latest: null, error: 'no vX.Y.Z tag there' };
  return { latest: show(tags.sort(cmp).at(-1)!) };
}

const stamp = (iso: string) => iso.slice(0, 16).replace('T', ' ');

// the shape a cache must have to be used (it is a file anyone can edit)
const isKitCache = (c: unknown): c is KitCache => {
  const k = c as Record<string, unknown> | null;
  return !!k && typeof k === 'object' && typeof k.url === 'string' && typeof k.checked_at === 'string' && typeof k.ok === 'boolean'
    && (k.latest === null || (typeof k.latest === 'string' && !!release(k.latest)))
    && (k.last_ok_at === undefined || typeof k.last_ok_at === 'string') && (k.error === undefined || typeof k.error === 'string');
};

export function kitReport(root: string, now = new Date(), cached?: KitCache): KitReport {
  let version: string | null = null, why = '';
  const pkg = join(root, 'kernel', 'package.json');
  try {
    const v = (JSON.parse(readFileSync(pkg, 'utf8')) as { version?: unknown }).version;
    if (typeof v === 'string' && parse(v)) version = show(parse(v)!);
    else why = `kernel/package.json has no version like 0.7.0 (${JSON.stringify(v ?? null)}): a ported kernel?`;
  } catch (e) { why = existsSync(pkg) ? `kernel/package.json can't be read (${(e as Error).message})` : 'no kernel/package.json'; }
  const real = kitUrl(root), url = bare(real);
  if (!isKitCache(cached)) cached = undefined;                         // a cache edited by hand is no cache
  const age = cached && cached.url === url ? (now.getTime() - Date.parse(cached.checked_at)) / 36e5 : Infinity;
  const fresh = cached && age >= 0 && age < (cached.ok ? KIT_FRESH_H : KIT_RETRY_H);
  let c: KitCache;
  if (fresh) c = cached!;
  else {
    const t = newestTag(root, real), at = now.toISOString();
    const before = cached && cached.url === url ? cached : undefined;
    c = t.latest ? { url, latest: t.latest, checked_at: at, ok: true, last_ok_at: at }
      : { url, latest: before?.latest ?? null, checked_at: at, ok: false, error: t.error, ...(before?.last_ok_at ? { last_ok_at: before.last_ok_at } : {}) };
  }
  const latest = c.ok && c.latest ? parse(c.latest) : null;
  const mine = version ? parse(version) : null;
  const last = c.last_ok_at ? `last read ${stamp(c.last_ok_at)}${c.latest ? `, when it was ${c.latest}` : ''}` : 'never read';
  let state: KitReport['state'] = 'unknown', line: string;
  if (!mine) line = `kit version unknown: ${why}; ${latest ? `the latest is ${show(latest)}` : `latest unknown too (${c.error})`}. Compare it by hand with the kit's CHANGELOG.`;
  else if (!latest) line = `kit ${version}; latest unknown (${c.error}; ${last}).`;
  else if (cmp(mine, latest) < 0) { state = 'behind'; line = `kit ${version}; ${show(latest)} is out: read its CHANGELOG ("Upgrading a project") with the operator before merging it.`; }
  else if (cmp(mine, latest) > 0) { state = 'ahead'; line = `kit ${version}; the newest tag is ${show(latest)} (this kit is ahead of it: not released yet).`; }
  else { state = 'level'; line = `kit ${version} (the latest).`; }
  return { ...c, version, state, line, fetched: !fresh };
}

// The variable names an env file sets to something (KEY=…, export KEY=…). A name set to nothing (KEY=, KEY="", a
// placeholder copied from .env.example) isn't set. Only whether a value is empty is looked at; no value is kept.
const BOM = /^\uFEFF/;
export const envNames = (text: string) => new Set([...text.replace(BOM, '').matchAll(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(?![ \t]*(?:""|'')?[ \t]*(?:#.*)?\r?$)/gm)].map((m) => m[1]));

// The names a keys declaration gives: inline, or the keys of an object in a JSON file the project keeps (`at`: a dotted
// path to it). A file's own text is never quoted: a key store's file may hold more than names.
export function declaredNames(root: string, k: Keys): { names: string[]; from: string; error?: string } {
  if (k.names) return { names: [...new Set(k.names)], from: 'guards.json keys.names' };
  const from = `${k.file}${k.at ? ` at ${k.at}` : ''}`;
  const path = join(root, k.file!);
  if (!existsSync(path)) return { names: [], from, error: `${k.file} is not there` };
  let v: unknown;
  try { v = JSON.parse(readFileSync(path, 'utf8').replace(BOM, '')); } catch { return { names: [], from, error: `${k.file} is not JSON` }; }
  for (const step of k.at ? k.at.split('.') : []) v = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>)[step] : undefined;
  const names = v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : null;
  if (!names) return { names: [], from, error: `${from} is not an object (its keys are the names)` };
  const bad = names.filter((n) => !VAR_NAME.test(n));
  if (bad.length) return { names: [], from, error: `${from} holds ${bad.length} name(s) that are not variable names` };
  if (!names.length) return { names: [], from, error: `${from} holds no names` };
  return { names: [...new Set(names)], from };
}

export function keysReport(root: string, k: Keys | undefined, env: NodeJS.ProcessEnv = process.env): KeysReport | null {
  if (!k) return null;
  const d = declaredNames(root, k);
  if (d.error) return { declared: [], missing: [], found: {}, from: d.from, error: d.error, line: `keys: the declaration can't be read (${d.error}); fix guards.json keys or the file it names.` };
  const envFile = join(root, '.env');
  let inFile = new Set<string>();
  try { inFile = envNames(readFileSync(envFile, 'utf8')); } catch { /* no env file: every name is looked for in the environment */ }
  const found: KeysReport['found'] = {}, missing: string[] = [];
  for (const n of d.names) {
    if (inFile.has(n)) found[n] = 'env file';
    else if (env[n] !== undefined && env[n] !== '') found[n] = 'environment';
    else missing.push(n);
  }
  const line = missing.length
    ? `keys: ${missing.length} of ${d.names.length} declared missing, set in neither .env nor the environment: ${missing.join(', ')}.`
    : `keys: all ${d.names.length} declared present.`;
  return { declared: d.names, missing, found, from: d.from, line };
}

export const reportPath = (root: string) => { const g = gitCommonDir(root); return g ? join(g, 'cellkit-start.json') : null; };

export function start(root: string, now = new Date()): string[] {
  const out = reportPath(root);
  let before: unknown = null;
  try { if (out && existsSync(out)) before = JSON.parse(readFileSync(out, 'utf8')); } catch { /* a broken report is rebuilt */ }
  const prior = before && typeof before === 'object' ? (before as { kit?: unknown }).kit : undefined;
  const kit = kitReport(root, now, isKitCache(prior) ? prior : undefined);
  const config = loadConfig(configPath(root));
  const keys = config.error ? null : keysReport(root, config.keys);
  const { line: _k, version: _v, state: _s, fetched: _f, ...kitCache } = kit;
  const record = { at: now.toISOString(), kit: { ...kitCache, version: kit.version, state: kit.state }, keys: keys ? (({ line: _l, ...r }) => r)(keys) : null };
  if (out) try { writeFileSync(out, JSON.stringify(record, null, 2) + '\n'); } catch { /* reporting only */ }
  return [kit.line, ...(keys ? [keys.line] : []), ...(config.error ? ['keys: not read (guards.json is invalid; lint says why).'] : [])];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const project = process.env.CLAUDE_PROJECT_DIR;
    // root only: a cell can't upgrade the kit, and its keys are its binding's (#122)
    if (!(project && existsSync(join(project, 'binding.json')))) {
      const i = process.argv.indexOf('--root');
      const root = inMain(i > 0 ? resolve(process.argv[i + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));
      for (const l of start(root)) console.log(l);
    }
  } catch (e) { console.log(`start: the report failed (${(e as Error).message}).`); }
  process.exitCode = 0;                                                  // never a refusal; and let stdout drain
}
