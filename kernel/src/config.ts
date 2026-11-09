// A project's own guards: state/bedrock/guards.json, a bedrock doc like the ontology, so a project never edits the
// kernel's hooks, and every change to its guards is proposed, approved by the operator and logged:
//   {
//     "operator_only": [ { "command": "portfolio/src/pm.ts decide", "message": "…" },          a script + subcommand
//                        { "pattern": "\\bsf\\s+data\\s+delete\\b", "message": "…" } ],         or a raw regex (case-insensitive)
//     "protected":     [ { "path": "docs/portfolio/", "by": "portfolio/src/pm.ts" } ],          written only by that script
//     "cells":         { "game": { "owns": ["game/**", "sim/**"] } },                          paths a cell owns beyond its folder
//     "mail":          { "log": "hash" },                                                      mail bodies kept out of the logs
//     "unreadable":    [ { "path": "OTHER_PROJECT/vault/", "why": "…" } ],                     no session reads these
//     "worktrees":     { "home": "../.cells/myproject" },                                      where cell checkout puts cells
//     "land":          { "ignored": ["**/__pycache__/**", "cells/*/state/out/**"] }            git-ignored files a land accepts
//   }
// land.ignored (#77): globs over worktree paths. Once set (an empty list too), `cell land` refuses while the cell's
// worktree holds a git-ignored file outside it, what the kit rebuilds aside (land.ts REBUILT): data a run left behind is
// deleted or allowed by the operator, never waved through. Not set: land only lists them.
// worktrees.home: the folder holding the project's cell worktrees (<home>/<cell>), relative to the main checkout and
// outside it (#26: under the main checkout is root's, so a cell nested there would be judged as root). Default: the
// sibling <repo>-cells/. Relative, never by drive, so the project opens the same from Windows and WSL.
// unreadable: on top of the kit's defaults (keys, .env, credentials; secrets.ts), matched by folder name anywhere on the
// disk; a trailing / is a folder, * matches within one name. Read by the Read/Grep hook and the shell guard.
// mail.log: "body" (default) logs each message whole, so the log is the record of what was asked and answered; "hash"
// logs its sha256 and length only, and the body lives in the mailbox alone (transient, under .git, deletable). For a
// project whose rules keep personal data out of every log (callsheet's ontology rule 8): the log is append-only.
// Change it like any bedrock doc: `stage --doc guards` (or write proposed/guards.json), `amend`, and the operator
// approves. amend and approve refuse a doc that doesn't check (checkGuards); a .json doc goes live only on approval.
// The hooks read the live file, the main checkout's even from a cell's worktree. Where root's folded views are present
// they also check its hash against the approved one and refuse everything on a mismatch. Either way the
// real guards are elsewhere: bedrock is hook-protected, a cell can't write outside its folder, `cell audit` catches
// script writes, and lint catches a hand edit at every session start.
// Missing = no project guards. Invalid = every command and write is refused until the operator fixes it, and mail logs
// hashes only (a broken config never leaks a body into a log).
// CELLKIT_CONFIG overrides the path (tests).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './canon.ts';
import { globRe } from './glob.ts';
import { inMain } from './worktree.ts';
import type { Unreadable } from './secrets.ts';

export const GUARDS = 'guards';
export interface OperatorOnly { re: RegExp; message: string }
export interface Guarded { re: RegExp; path: string; by?: string }
export type MailLog = 'body' | 'hash';
export interface Config { operatorOnly: OperatorOnly[]; protected: Guarded[]; writers: RegExp[]; owns: Record<string, string[]>; mailLog: MailLog; unreadable: Unreadable[]; home?: string; landIgnored?: string[]; error?: string }
interface Raw {
  operator_only?: { command?: string; pattern?: string; message?: string }[];
  protected?: { path?: string; by?: string }[];
  cells?: Record<string, { owns?: string[] }>;
  mail?: { log?: string };
  unreadable?: { path?: string; why?: string }[];
  worktrees?: { home?: string };
  land?: { ignored?: string[] };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// a path written with / matches \ too, after a start, a separator, a space, a quote or =
const pathRe = (p: string) => esc(p.replace(/^\.?\/+/, '')).replaceAll('/', '[\\\\/]');

// "dir/script.ts sub cmd" → script (quoted or not, any folder before it) followed by its subcommand words
export function commandRe(command: string): RegExp {
  const [script, ...words] = command.trim().split(/\s+/);
  return new RegExp(`(^|[\\s"'\\\\/])${pathRe(script.split('/').at(-1)!)}["']?${words.map((w) => `\\s+${esc(w)}`).join('')}\\b`, 'i');
}

// What a cell may not own: the kernel, the logs and bedrock, other cells, the hooks, git, the generated docs.
const UNOWNABLE = /^(kernel|state|cells|\.claude|\.git)(\/|$)|^docs\/assumptions\.md$/i;

// Probe paths nobody would name. The operator still reads each glob: this catches the catch-alls, not intent.
const TOO_WIDE = ['zq9x', 'zq9x/w7zk/j3v8', 'zq9x/w7zk/j3.v8', 'zq9x/w7zk/j3.v8qx'];

// The problems with a guards doc (empty = fine). Used by bedrock's amend and approve, and when the hooks load it.
export function checkGuards(value: unknown): string[] {
  const out: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['guards.json must be an object'];
  const raw = value as Raw;
  for (const k of Object.keys(raw)) if (!['operator_only', 'protected', 'cells', 'mail', 'unreadable', 'worktrees', 'land'].includes(k)) out.push(`unknown key "${k}" (operator_only, protected, cells, mail, unreadable, worktrees, land)`);
  if (raw.land !== undefined) {
    if (!raw.land || typeof raw.land !== 'object' || Array.isArray(raw.land)) out.push('land must be an object ({ "ignored": ["<glob>", …] })');
    else {
      for (const k of Object.keys(raw.land)) if (k !== 'ignored') out.push(`land: unknown key "${k}" (ignored)`);
      const g = raw.land.ignored;
      if (g !== undefined && !Array.isArray(g)) out.push('land.ignored must be a list of globs (e.g. ["**/__pycache__/**"])');
      for (const [i, x] of (Array.isArray(g) ? g : []).entries()) {
        if (typeof x !== 'string' || !x.trim()) out.push(`land.ignored[${i}] must be a glob`);
        else if (/^[a-zA-Z]:|^[\\/]|^~|(^|\/)\.\.(\/|$)/.test(x)) out.push(`land.ignored[${i}] "${x}": a path inside the worktree, from its root`);
        // a glob that takes a path nobody named allows whatever a run leaves: **, **/*.*, ?*/**
        else if (TOO_WIDE.some((p) => globRe(x).test(p))) out.push(`land.ignored[${i}] "${x}": too wide (it would allow any file); name a folder or an extension, or leave land.ignored out to only list`);
      }
    }
  }
  if (raw.worktrees !== undefined) {
    if (!raw.worktrees || typeof raw.worktrees !== 'object' || Array.isArray(raw.worktrees)) out.push('worktrees must be an object ({ "home": "../.cells/<project>" })');
    else {
      for (const k of Object.keys(raw.worktrees)) if (k !== 'home') out.push(`worktrees: unknown key "${k}" (home)`);
      const h = raw.worktrees.home;
      if (h !== undefined) {
        if (typeof h !== 'string' || !h.trim()) out.push('worktrees.home must be a folder (e.g. "../.cells/<project>")');
        else if (/^[a-zA-Z]:|^[\\/]|^~/.test(h)) out.push(`worktrees.home "${h}": relative to the main checkout (e.g. "../.cells/<project>"), never by drive`);
        else if (!/^\.\.([\\/]|$)/.test(h.replace(/^(\.[\\/])+/, ''))) out.push(`worktrees.home "${h}": inside the repository; cells live outside it (e.g. "../.cells/<project>")`);
      }
    }
  }
  if (raw.unreadable !== undefined && !Array.isArray(raw.unreadable)) out.push('unreadable must be a list of { "path": "…", "why": "…" }');
  for (const [i, u] of (Array.isArray(raw.unreadable) ? raw.unreadable : []).entries()) {
    if (!u || typeof u.path !== 'string' || !u.path.trim()) out.push(`unreadable[${i}] needs "path"`);
    else if (/^[a-zA-Z]:|^\//.test(u.path)) out.push(`unreadable[${i}] "${u.path}": a path by folder name (e.g. "OTHER_PROJECT/vault/"), never by drive`);
    else if (/^[*/]*$/.test(u.path.replace(/\*\*?\/?/g, '*'))) out.push(`unreadable[${i}] "${u.path}": too wide (it would match everything)`);
  }
  if (raw.mail !== undefined) {
    if (!raw.mail || typeof raw.mail !== 'object' || Array.isArray(raw.mail)) out.push('mail must be an object ({ "log": "body" | "hash" })');
    else {
      for (const k of Object.keys(raw.mail)) if (k !== 'log') out.push(`mail: unknown key "${k}" (log)`);
      if (raw.mail.log !== undefined && !['body', 'hash'].includes(raw.mail.log)) out.push(`mail.log must be "body" or "hash", not ${JSON.stringify(raw.mail.log)}`);
    }
  }
  for (const [i, o] of (raw.operator_only ?? []).entries()) {
    if (!o.command === !o.pattern) out.push(`operator_only[${i}] needs exactly one of "command" or "pattern"`);
    if (o.pattern) try { new RegExp(o.pattern); } catch (e) { out.push(`operator_only[${i}].pattern: ${(e as Error).message}`); }
  }
  for (const [i, p] of (raw.protected ?? []).entries()) if (!p.path) out.push(`protected[${i}] needs "path"`);
  for (const [name, c] of Object.entries(raw.cells ?? {})) {
    if (!/^[a-z0-9-]+$/.test(name)) out.push(`cells.${name}: not a cell name`);
    if (!Array.isArray(c.owns)) { out.push(`cells.${name}.owns must be a list of globs`); continue; }
    for (const g of c.owns) {
      const lead = g.replace(/^\.?\/+/, '').split(/[*?[]/)[0];       // the literal part before the first wildcard
      if (!/\//.test(lead)) out.push(`cells.${name}.owns "${g}": must start with a folder (e.g. "game/**"), not a wildcard or a root file`);
      else if (UNOWNABLE.test(lead)) out.push(`cells.${name}.owns "${g}": the kernel, state/, cells/, .claude/, .git/ and the generated docs belong to no cell`);
    }
  }
  return out;
}

const repoRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The main checkout's, also from a cell's worktree (whose hooks run its own kernel copy): guards approved on main protect
// every cell at once, not after root merges main into it (SF-DEV: a read guard added on main didn't cover the cells).
export const configPath = (root = inMain(repoRoot())) => process.env.CELLKIT_CONFIG || join(root, 'state', 'bedrock', `${GUARDS}.json`);

export function loadConfig(path = configPath()): Config {
  const none: Config = { operatorOnly: [], protected: [], writers: [], owns: {}, mailLog: 'body', unreadable: [] };
  if (!existsSync(path)) return none;
  const fail = (why: string): Config => ({ ...none, mailLog: 'hash', error: `${path} ${why}; the operator must fix it` });
  const text = readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
  // best effort (see the header): the main checkout's folded views know the approved hash
  const views = join(dirname(path), '..', 'views', 'bedrock.json');
  if (!process.env.CELLKIT_CONFIG && existsSync(views)) {
    try {
      const approved = (JSON.parse(readFileSync(views, 'utf8')) as Record<string, { live_hash?: string | null }>)[GUARDS]?.live_hash;
      if (approved && approved !== sha256(text)) return fail('differs from its approved version (edited by hand? or changed on main without a fold: run node kernel/src/cli.ts fold in the main checkout); approve a proposal or restore it');
    } catch { /* unreadable views: lint will say */ }
  }
  let raw: Raw;
  try { raw = JSON.parse(text); } catch (e) { return fail(`is not JSON (${(e as Error).message})`); }
  const problems = checkGuards(raw);
  if (problems.length) return fail(`is invalid (${problems.join('; ')})`);
  const guarded = (raw.protected ?? []).map((p) => ({ re: new RegExp(`(^|[\\\\/\\s"'=])${pathRe(p.path!)}${p.path!.endsWith('/') ? '' : '(?![\\w.-])'}`, 'i'), path: p.path!, by: p.by }));
  return {
    operatorOnly: (raw.operator_only ?? []).map((o) => ({ re: o.pattern ? new RegExp(o.pattern, 'i') : commandRe(o.command!),
      message: o.message ?? `${o.command ?? o.pattern} is the operator's: ask them to run it from their own prompt with "!"` })),
    protected: guarded,
    writers: guarded.flatMap((g) => (g.by ? [new RegExp(pathRe(g.by), 'i')] : [])),
    owns: Object.fromEntries(Object.entries(raw.cells ?? {}).map(([n, c]) => [n, c.owns ?? []])),
    mailLog: raw.mail?.log === 'hash' ? 'hash' : 'body',
    unreadable: (raw.unreadable ?? []).map((u) => ({ path: u.path!, why: u.why ?? `unreadable (bedrock guards.json: ${u.path})` })),
    home: raw.worktrees?.home,
    landIgnored: raw.land?.ignored,
  };
}

// The globs a cell owns beyond its own folder, as regexes over repo-relative paths (lowercase, / separators).
export const ownedRes = (c: Config, name: string) => (c.owns[name] ?? []).map(globRe);
