// The read guard: what no session reads, root's included. The kit guards writes everywhere; reads only here, for the
// Read and Grep tools (hook-read.ts) and the shell (hook-bash.ts). A floor, not a boundary: a script a command runs can
// still read anything its user can (an OS sandbox is the boundary; README "Limits"). Ported from SF-DEV (secrets.ts).
//   kit defaults (ANYWHERE): key material, .env files (.env, <name>.env; not *.env.example), credential files and folders, shell histories
//   the project's own (bedrock guards.json "unreadable"): [{ "path": "SOME_PROJECT/vault/", "why": "…" }, …], matched
//     by folder name anywhere on the disk, never by drive, so a clone or a worktree is covered too; a trailing / is a
//     folder, * matches within one name. Case-insensitive.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import { CD, expandEnv, firstCommand, isMark, OPEN, parts, PATTERNED, piped, simpleCommands, verbOf } from './shell.ts';

export interface Hit { path: string; why: string }
export interface Unreadable { path: string; why: string }

// .env, .env.local, and <name>.env (callsheet's vein.env, #5); never *.env.example
const ENV = { re: /(^|\/)[^/]*\.env(\.(?!example$)[^/]+)?$/i, why: 'environment secrets (.env)' };
const ANYWHERE: { re: RegExp; why: string }[] = [
  { re: /(^|\/)\.ssh(\/|$)/i, why: 'SSH keys' },
  ENV,
  { re: /\.(pem|key|p12|pfx)$/i, why: 'a key or certificate' },
  { re: /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/i, why: 'a private SSH key' },
  { re: /(^|\/)\.[\w.-]*keys?$/i, why: 'a hidden key file' },
  { re: /(^|\/)\.(bash|zsh|sh|python|node_repl|psql|mysql)_history$/i, why: 'a shell history (may hold secrets)' },
  { re: /(^|\/)(\.claude\.json|\.netrc|\.npmrc|\.pypirc|\.git-credentials)$/i, why: 'a credentials file' },
  { re: /(^|\/)\.(aws|gnupg|docker|kube)(\/|$)/i, why: 'a credentials folder' },
  { re: /(^|\/)\.config\/gh(\/|$)/i, why: 'GitHub CLI credentials' },
];

const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '');
const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
// "A/B/" → the folder A/B and anything in it; "A/b*" → a name in A starting with b (and anything in it, if a folder)
const entryRe = (p: string) => {
  const body = norm(p).replace(/^\.?\/+/, '').split('/').map((s) => esc(s).replaceAll('*', '[^/]*')).join('/');
  return new RegExp(`(^|/)${body}(/|$)`, 'i');
};

// Git Bash's /d/x is D:/x on Windows (#1: callsheet's /d/PROJECTS/vein was read as a folder of the project); elsewhere
// /d/x is a real path.
const drive = (s: string) => process.platform === 'win32' ? s.replace(/^\/([a-zA-Z])(\/|$)/, '$1:/') : s;

export function absPath(p: string, cwd: string): string {
  const s = drive(norm(p.trim().replace(/^["']|["']$/g, '')));
  return /^[a-zA-Z]:\//.test(s) || s.startsWith('/') ? posix.normalize(s) : posix.normalize(`${norm(cwd)}/${s}`);
}

// The denied thing a path is, or lies in; null when it may be read.
export function denied(path: string, cwd = '', own: Unreadable[] = []): Hit | null {
  const abs = absPath(path, cwd);
  for (const d of ANYWHERE) if (d.re.test(abs)) return { path: abs, why: d.why };
  for (const u of own) if (entryRe(u.path).test(abs)) return { path: abs, why: u.why };
  return null;
}

// Whether a recursive search from dir would reach something denied: a .env or .ssh directly in it, or a project entry
// below it (dir may sit part-way down the entry: …/SOME_PROJECT/docs reaches SOME_PROJECT/docs/research/).
export function treeHolds(dir: string, cwd = '', own: Unreadable[] = []): Hit | null {
  const abs = absPath(dir, cwd);
  const self = denied(abs, '', own);
  if (self) return self;
  if (existsSync(`${abs}/.ssh`)) return { path: `${abs}/.ssh`, why: 'SSH keys' };
  let names: string[] = [];
  try { names = readdirSync(abs); } catch { /* not a folder */ }
  const env = names.find((n) => ENV.re.test(n));                       // .env, .env.local, <name>.env (#5)
  if (env) return { path: `${abs}/${env}`, why: ENV.why };
  const segs = abs.toLowerCase().split('/');
  for (const u of own) {
    // the entry's literal folders: all of it, or up to the folder holding its first wildcard (a glob in it may match)
    const p = norm(u.path).replace(/^\.?\/+/, '');
    const parts = (p.includes('*') ? p.slice(0, p.slice(0, p.indexOf('*')).lastIndexOf('/') + 1) : p).split('/').filter(Boolean);
    if (!parts.length) continue;                                   // a bare glob ("*secret*"): denied() catches each file
    for (let k = 0; k <= parts.length; k++) {                      // dir already ends with the entry's first k folders
      if (k && segs.slice(-k).join('/') !== parts.slice(0, k).join('/').toLowerCase()) continue;
      const rest = parts.slice(k).join('/');
      if (!rest || existsSync(`${abs}/${rest}`)) return { path: rest ? `${abs}/${rest}` : abs, why: u.why };
    }
  }
  return null;
}

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const how = 'If a tool needs it, the tool reads it itself (process.loadEnvFile, a keychain); a session never sees it.';

// The Grep tool: a denied path is refused; content from a tree that holds a secret needs a glob or type that narrows
// it (file names and counts leak nothing and stay open).
export function grepRefusal(i: { path?: string; glob?: string; type?: string; output_mode?: string }, cwd: string, own: Unreadable[] = []): string | null {
  const where = i.path || cwd;
  const d = denied(where, cwd, own);
  if (d) return `${d.path} is ${d.why}: no session reads it. ${how}`;
  if (i.output_mode !== 'content') return null;
  const glob = (i.glob ?? '').trim();
  const narrowed = !!i.type || (!!glob && !/^(\*\*\/)?\*$/.test(glob) && !/env|ssh|pem|key|p12|pfx|^\./i.test(glob));
  if (narrowed) return null;
  const t = isDir(absPath(where, cwd)) ? treeHolds(where, cwd, own) : null;
  return t ? `a content search of ${absPath(where, cwd)} would read ${t.path} (${t.why}). Narrow it with glob or type, search a subfolder, or use output_mode files_with_matches.` : null;
}

// The shell, one simple command at a time, split outside quotes (#2). A segment reads when it starts with a read verb, or
// holds a read primitive outside quotes (`$k = Get-Content .env`). Program code an interpreter runs (node -e, python -c,
// `python - <<EOF`) reads when it holds a read primitive; what runs in a shell string, $(…), backticks or a shell-fed
// heredoc is judged as commands; a heredoc a program reads as data (`cat > f <<EOF`) is text. Only a reading segment's
// path tokens count, quoted or not, less a search's pattern or a sed/awk script: a commit message naming .ssh is text,
// `cat ".env"` is a read.
const verbs = 'cat|type|gc|Get-Content|head|tail|less|more|grep|egrep|rg|findstr|Select-String|sls|sed|awk|cp|copy|Copy-Item|scp|rsync|tar|zip|7z|base64|xxd|od|strings|source|Import-Csv|Get-FileHash';
const startsRead = new RegExp(String.raw`^\s*(?:sudo\s+|npx\s+)?(?:${verbs})(?=\s|$)`, 'i');
const readPrimitive = /readFileSync|readFile\(|createReadStream|ReadAllText|ReadAllBytes|ReadAllLines|read_text|read_bytes|\bopen\(|Get-Content/i;
const searchVerb = /^\s*(rg(?=\s|$)|e?grep\s(?:[^\n]*\s)?-[a-zA-Z]*[rR]|findstr\s(?:[^\n]*\s)?\/s\b|Select-String\b|sls\b)/i;
const narrowedSearch = /(--glob|\s-g\s|--include|--type|\s-t\s)/;

const quoted = /"[^"]*"|'[^']*'/g;
const readCall = /(?:readFileSync|readFile|createReadStream|ReadAllText|ReadAllBytes|ReadAllLines|read_text|read_bytes|\bopen|Get-Content)\s*\(([^)]*)\)/gi;
const literal = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`]*)`/g;
const tokensOf = (s: string) => s.split(/[\s()<>`,=]+/).map((t) => t.replace(/^["'@]+|["')]+$/g, '').replace(/^["']|["']$/g, '')).filter((t) => t && !t.startsWith('-'));

// A search's pattern, or sed's and awk's script, is text, not a path (#2: `grep -n "\.env" src/a.ts`): the first operand,
// or each -e / --regexp / -Pattern value. An option's value that is a file (-f, -Path) stays.
function withoutPattern(seg: string): string {
  const words = firstCommand(seg);
  const { verb, i } = verbOf(words);
  if (!PATTERNED.test(verb)) return seg;
  const pats: string[] = [];
  let explicit = false, operand = false;
  for (let j = i + 1; j < words.length; j++) {
    const w = words[j];
    if (/^(-e|--regexp|--expression|-pattern)$/i.test(w)) { explicit = true; if (j + 1 < words.length) pats.push(words[++j]); continue; }
    if (/^(--regexp|--expression|-pattern)=/i.test(w)) { explicit = true; pats.push(w.slice(w.indexOf('=') + 1)); continue; }
    if (/^(-[ABCmgtTdf]|--(file|glob|type|type-not|max-count|after-context|before-context|context|include|exclude|max-depth)|-(path|literalpath|include|exclude|encoding))$/i.test(w)) { j++; continue; }
    if (w.startsWith('-') || operand) continue;
    operand = true;
    if (!explicit) pats.push(w);
  }
  let out = seg, from = seg.indexOf(words[i]) + (words[i]?.length ?? 0);
  for (const pat of pats) {
    for (const form of [`"${pat}"`, `'${pat}'`, pat]) {
      const k = out.indexOf(form, from);
      if (k >= 0 && form) { out = out.slice(0, k) + out.slice(k + form.length); from = k; break; }
    }
  }
  return out;
}

// Commands whose output is text, never files: what may feed a Select-String or Get-Content with no path.
const TEXT_PRODUCERS = /^(git|gh|npm|npx|pnpm|yarn|node|deno|bun|python[\d.]*|py|pip|dotnet|cargo|go|docker|kubectl|claude|schtasks|tasklist|netstat|ipconfig|whoami|hostname|systeminfo|where|where\.exe|echo|Write-Output|Get-Process|gps|ps|Get-Service|gsv|Get-Date|Get-Content|gc|cat|type|Select-String|sls|sort|head|tail|wc|uniq|cut|tr|grep|rg|findstr|sed|awk|jq|curl|wget)(\.exe)?$/i;
const textOnly = (u: string) => {
  const w = firstCommand(u);
  return TEXT_PRODUCERS.test(w[0] ?? '') && !/[$@({`]/.test(u.replace(quoted, '""')) && simpleCommands(u).filter((c) => !isMark(c)).length === 1;
};

// A path as the shell would see it (#106, #108): a leading ~ is the home folder, and $X, ${X}, %X%, $env:X are what the
// hook's own environment holds (an unset one stays as written). Judged as well as the text, never instead of it, so it
// can only add a refusal; and a refusal names the real path, not <project>/~/….
const home = (t: string) => expandEnv(t.replace(/^~(?=[\\/]|$)/, homedir().replaceAll('\\', '/')));

// #106: the key an ssh login names as its identity is used, not read: scp's `-i <key>`, and the `-i <key>` of the ssh
// that rsync's -e / --rsh runs (ssh itself reads nothing here). Only that word is let off, so the same file named again
// (copied) is still a read. Options are read as OpenSSH's getopt reads them: until the first operand or `--`, a valued
// option taking the rest of its word or the next word, so in `scp notes.txt -i ~/.ssh/key host:` the key is a file
// copied, not an identity (review 1). rsync takes options anywhere; its own -i (--itemize-changes) takes no value, and
// its --exclude, --include and --filter values are patterns, not paths. Only key material, or a path nothing denies,
// is an identity: a file that is also an env or credentials file (`~/.ssh/prod.env`) is read.
const SCP = /^scp(\.exe)?$/i, RSYNC = /^rsync(\.exe)?$/i;
const SCP_VALUED = new Set('cDFiJloPSX'), SSH_VALUED = new Set('BbcDEeFIiJLlmOoPpQRSWw');
const KEYS = new Set(['SSH keys', 'a key or certificate', 'a private SSH key', 'a hidden key file']);
// getopt over ws: the index of each option's value, and whether it is -i's
function getopt(ws: string[], valued: Set<string>): { at: number; i: boolean }[] {
  const out: { at: number; i: boolean }[] = [];
  for (let j = 0; j < ws.length; j++) {
    const w = ws[j];
    if (w === '--' || !/^-./.test(w)) break;
    for (let k = 1; k < w.length; k++) {
      if (!valued.has(w[k])) continue;
      if (k === w.length - 1 && j + 1 < ws.length) out.push({ at: ++j, i: w[k] === 'i' });
      break;                                                     // (an attached value is in a word starting with -: never a path)
    }
  }
  return out;
}
// the words of an scp or rsync command that are options' values (none of them a file it copies): the identities among
// them, rsync's patterns, and all of them
function optionValues(words: string[]): { ids: string[]; patterns: string[]; values: string[]; at: number[] } {
  const { verb, i } = verbOf(words);
  const args = words.slice(i + 1), ids: string[] = [], patterns: string[] = [], values: string[] = [], at: number[] = [];
  const ssh = (rsh: string) => {
    const ws = rsh.trim().split(/\s+/);
    if (!/^ssh(\.exe)?$/i.test((ws[0] ?? '').replace(/^.*[\\/]/, ''))) return;
    for (const v of getopt(ws.slice(1), SSH_VALUED)) (v.i ? ids : values).push(ws[v.at + 1]);
  };
  if (SCP.test(verb)) for (const v of getopt(args, SCP_VALUED)) { (v.i ? ids : values).push(args[v.at]); at.push(v.at); }
  else if (RSYNC.test(verb)) for (let j = 0; j < args.length && args[j] !== '--'; j++) {
    // (the *-from and --password-file values are files rsync reads here: judged as reads, never as files copied)
    const w = args[j], m = /^--(rsh|exclude|include|filter|exclude-from|include-from|files-from|password-file)=([\s\S]*)$/.exec(w);
    const name = m ? m[1] : /^--(rsh|exclude|include|filter|exclude-from|include-from|files-from|password-file)$/.exec(w)?.[1] ?? (/^-[a-zA-Z]*e$/.test(w) ? 'rsh' : /^-[a-zA-Z]*f$/.test(w) ? 'filter' : null);
    if (!name) continue;
    const value = m ? m[2] : j + 1 < args.length ? args[++j] : '';
    values.push(value);
    if (!m) at.push(j);
    if (name === 'rsh') ssh(value); else if (/^(exclude|include|filter)$/.test(name)) patterns.push(value);
  }
  return { ids, patterns, values: [...values, ...ids], at };
}
// An allowlist, not a finer reading (reviews 2 and 3: a folder copied takes its .env along, at any depth, and where the
// copy goes was misread behind a redirect or a trailing option): the identity is let off only for a copy whose every
// source is a file on the other machine or a literal path that is no folder here, and whose destination is on the other
// machine or a literal path. Anything else (a folder, `.`, a glob, a $variable, a substitution) keeps the old verdict:
// the key is named, so it is refused. Pushing a folder with a key stays the operator's, as before.
// Each of these fails closed, never reads finer (reviews 4 and 5): the folder lost (a `cd` before the copy the guard
// couldn't follow, here or in a command around a nested shell: it would judge `Roaming` in the wrong folder); a quoted
// redirect, `&`, `|` or `;` in the copy's own text (a word list can't tell it from a real one); `--` (a dash word after
// it is an operand); `~+`, `~user`; an rsync cluster in which a letter before e or f takes its own value (-Te: T's
// value is e, the next word an operand).
const REDIRECT = /^(\d*|&)(>>?|<|>&)$/;
const MOVES_DIR = /(^|[\s;&|(){}])(cd|chdir|pushd|popd|Set-Location|sl|Push-Location|Pop-Location)(\s|;|\.\.|\\|$)/i;
// `been`: every folder the command has been in (review 6: a cd that didn't run, behind `false &&`, to a folder that isn't
// there, leaves the copy in the folder before it)
function plainCopy(words: string[], been: string[], raw: string, lost: boolean): boolean {
  if (lost || /"[^"]*[<>&|;][^"]*"|'[^']*[<>&|;][^']*'|\\[<>&|;]/.test(raw)) return false;
  const { verb, i } = verbOf(words);
  const args = words.slice(i + 1), skip = new Set(optionValues(words).at);
  if (args.includes('--') || args.some((w) => /^~[^/\\]/.test(w))) return false;
  if (RSYNC.test(verb) && args.some((w) => /^-[^-]/.test(w) && (/[BMT]/.test(w) || /[ef]./.test(w)))) return false;
  const ops: string[] = [];
  for (let k = 0; k < args.length; k++) {
    if (REDIRECT.test(args[k])) { k++; continue; }
    if (skip.has(k) || /^[-<>]|^\d*>/.test(args[k]) || /[|;&]/.test(args[k])) continue;
    ops.push(args[k]);
  }
  if (!COPY.test(verb) || ops.length < 2) return false;
  // A word bash can't split or expand into more words: literal, or wholly in double quotes in the copy's text with
  // nothing in it but $NAME / ${NAME} (the replay's `"$D/"`). Review 7: an unquoted $D, {a,b}, `…` or ${IFS} in a pull's
  // destination made a local source of it.
  // (every time the word stands in the text it is in double quotes: the same word quoted elsewhere, as a redirect's
  // target, vouches for nothing, review 8)
  const quoted = (w: string) => raw.split(w).length === raw.split(`"${w}"`).length && raw.includes(`"${w}"`) && !/`|\$\(/.test(w) && !/\$(?!\{?\w+\}?)/.test(w);
  // a local source must be known here, to tell it from a folder: in quotes only for its spaces, never a $variable
  const known = (w: string) => !/[*?[\]{}$%`\s]/.test(home(w)) || (quoted(w) && !/[$%]/.test(home(w)));
  const literal = (w: string) => known(w) || quoted(w);
  // remote: a remote file's glob is the other machine's to expand, but nothing that splits here
  const remote = (w: string) => !/^[a-zA-Z]:[\\/]/.test(w) && REMOTE.test(w) && (!/[{}$%`\s]/.test(w) || quoted(w));
  // a folder by either reading of a backslash: a separator (PowerShell, `.\dist`) or an escape (bash, `b\ackup`)
  const folder = (w: string) => been.some((cwd) => isDir(absPath(home(w), cwd)) || isDir(absPath(home(w.replace(/\\(.)/g, '$1')), cwd)));
  // a pull (every source on the other machine) takes nothing from here, wherever it lands (`"$D/"`: the replay of real
  // commands, a project's pulls with its own key), as long as the destination is one word
  const sources = ops.slice(0, -1), dest = ops.at(-1)!;
  return sources.every((w) => remote(w) || (known(w) && !folder(w))) && (remote(dest) || literal(dest));
}
const reasons = (abs: string, own: Unreadable[]) => [...ANYWHERE.filter((d) => d.re.test(abs)), ...own.filter((u) => entryRe(u.path).test(abs))].map((d) => d.why);
const isIdentity = (w: string, cwd: string, own: Unreadable[]) =>
  [...reasons(absPath(home(w), cwd), own), ...reasons(absPath(w, cwd), own)].every((r) => KEYS.has(r));
// each of `drop` taken out of `from` once (the same path named twice stays once)
const less = (from: string[], drop: string[]) => { const out = [...from]; for (const d of drop) { const k = out.indexOf(d); if (k >= 0) out.splice(k, 1); } return out; };
const count = (a: string[], t: string) => a.filter((x) => x === t).length;
const COPY = /^(scp|rsync)(\.exe)?$/i;
// [user@]host:path, an operand on the other machine (not a drive: C:/x)
// (review 7: a user part of letters only, no `{backup,me@`; and no / inside an [ipv6] host: scp reads `[./x]:y` as local)
const REMOTE = /^(?:[\w.-]+@)?(?:[\w.-]{2,}|\[[^\]/\\]+\]):(.*)$/;
const copyRefusal = (what: string, why: string) => `that command copies ${what} (${why}) between machines: no session does. Copying a secret from one machine to another is the operator's: ask them to run it from their own prompt with "!". Write the line for the shell that prompt runs: on Windows that can be Git Bash even when this session's commands run in PowerShell.`;

// A `cd` moves the folder later segments are judged from (#1: `cd <another repo> && grep -r …` was judged against this
// project). One it can't judge ($x, %x%, ~, `…`) goes back to the session's folder, as before.
// `lost` (#106): the folder may not be what cwd says (a cd it couldn't follow, here or around a nested shell): only an
// identity's let-off reads it, and fails closed on it.
export function shellRefusal(command: string, session: string, own: Unreadable[] = [], depth = 0, lost = false): string | null {
  const p = parts(command);
  let cwd = session;
  const been = [session];                                                   // every folder it has been in (#106)
  const saved: string[] = [];                                               // a subshell's cd ends at its close
  const mark = (w: string[]) => { if (w[0] === OPEN) saved.push(cwd); else cwd = saved.pop() ?? cwd; };
  const judge = (raw: string, words: string[], up: string[]): string | null => {
    if (/^(popd|pop-location)$/i.test(words[0] ?? '')) { cwd = session; lost = true; return null; }   // back where it was: judged from the session's folder
    if (/^(cd|chdir)(\.\.|\\)/i.test(words[0] ?? '')) lost = true;          // PowerShell's cd.. and cd\: not followed
    if (/^(eval|Invoke-Expression|iex)$/i.test(verbOf(words).verb)) lost = true;   // a cd inside one word (review 6)
    if (words.slice(1).some((w) => CD.test(w) || /^(popd|pop-location)$/i.test(w))) lost = true;   // a cd behind then, do, {: not followed
    if (CD.test(words[0] ?? '')) {
      const args = words.slice(1).filter((w) => !/^-/.test(w));
      const to = expandEnv(args.length > 1 && /^\/d$/i.test(args[0]) ? args[1] : args[0] ?? '');   // cmd's `cd /d D:\x`; Git Bash's `cd /d` is D:/
      if (to) cwd = /[$%~`]/.test(to) ? session : absPath(to, cwd);
      been.push(cwd);
      if (!to || /[$%~`]/.test(to)) lost = true;
      return null;
    }
    // past the words that open a compound command: `if cat .env; then`, `! grep -r KEY .`, `{ cat .env; }` (review 3)
    raw = raw.replace(/^(\s*(if|then|else|elif|do|while|until|!|\{)\s+)+/, '');
    const unquoted = raw.replace(quoted, '""');
    if (!startsRead.test(unquoted) && !readPrimitive.test(unquoted)) return null;
    // #106: an identity and rsync's patterns are let off, each only when its tokens stand in the text as often as in
    // the words (a quote can't make one word stand for another: `scp -i id_"rsa" id_rsa host:`)
    const all = tokensOf(withoutPattern(raw)), wordTokens = words.flatMap(tokensOf);
    const { ids, patterns, values } = optionValues(words);
    // and never when the shell would make more words of it than the guard sees (review 2: `-i ~/.ssh/id_rsa{,}`, `-i
    // ~/.ssh/id_*`, `-i\ -i <key>`): the extra words are operands, copied
    const split = /\\ /.test(raw);
    const off = (w: string) => (!split && !/[*?[\]{}]/.test(w) && tokensOf(w).every((t) => count(all, t) === count(wordTokens, t)) ? tokensOf(w) : []);
    // rsync's patterns are not let off (that would be a second loosening, not decided): they are refused with their own text
    // a segment cut at an escaped metacharacter (`a\&b` is one word to bash; the reader ends the command at the &)
    const cut = /\\$/.test(raw.trimEnd()) && [...'&;|<>'].some((ch) => p.text.includes(raw.trimEnd() + ch));
    const letOff = ids.length && !cut && plainCopy(words, [cwd, ...been], raw, lost) ? ids.filter((w) => isIdentity(w, cwd, own)).flatMap(off) : [];
    const tokens = less(all, letOff);
    const patterned = patterns.flatMap(tokensOf);
    // what a copy names as its files: its words less the verb and every option's value
    const copy = COPY.test(verbOf(words).verb);
    const copied = copy ? less(wordTokens.slice(1), values.flatMap(tokensOf)) : [];
    for (const t of tokens) {
      const there = copy && !/^[a-zA-Z]:[\\/]/.test(t) ? REMOTE.exec(t) : null;
      const d = there ? denied(there[1] || '.', '/', own) : denied(home(t), cwd, own) ?? denied(t, cwd, own);
      if (!d) continue;
      if (copied.includes(t)) return copyRefusal(there ? `${t}, on the other machine` : d.path, d.why);
      if (patterned.includes(t)) return `that command names ${t} (${d.why}) in an rsync pattern (--exclude, --include, --filter), and the guard reads every such word as a path. Put the patterns in a file and pass it with --exclude-from=<file> (or --include-from), or ask the operator to run the command.`;
      return `that command reads ${d.path} (${d.why}): no session reads it. ${how}`;
    }
    // Select-String or Get-Content with no path reads what feeds it: text, or files when what feeds it lists them (#60,
    // ecom-lab: `schtasks … | Select-String "TaskName"` was refused). Text only when every command up the pipeline is a
    // known text producer with no expression in it (`echo (gci -r)` passes files); anything else, as before: a search
    // of the current folder. An allowlist on purpose: four reviews found ways around reading which commands list files.
    // (a redirect's target is where the result goes, not a path it reads: a review found `gci -r | Select-String KEY >
    // out.txt` passing on it)
    const reads = tokensOf(withoutPattern(raw.replace(/(\d|&)?>>?\s*(&\d|"[^"]*"|'[^']*'|[^\s|;&]+)/g, ' ')));
    if (/^\s*(Select-String|sls|Get-Content|gc)(?=\s|$)/i.test(unquoted) && reads.length < 2) {
      if (up.length && up.every(textOnly)) return null;
      const h = treeHolds(cwd, '', own);
      if (!h) return null;
      // fed by a command the list doesn't know, or one with a variable or an expression in it (#114, apify-actor-dev:
      // `ffmpeg -i $a 2>&1 | Select-String "Video:"`): say which, and both ways on, since the guard can't tell which it is
      const fed = up.find((u) => !textOnly(u));
      const search = /^(Select-String|sls)$/i.test(words[0] ?? '');
      return fed
        ? `${words[0]} with no path reads what feeds it, and "${fed.length > 80 ? `${fed.slice(0, 80)}…` : fed}" is not known to send only text: a command outside the guard's list of text producers, or one with a variable or an expression in it, may send files, and then this is a search of ${cwd}, which would read ${h.path} (${h.why}). If it sends text (a program's output), send that to a file first and read the file: <command> > out.txt, then ${search ? `${words[0]} <pattern> -Path out.txt` : `${words[0]} out.txt`}. If it lists files, give ${words[0]} the files themselves (-Path), or work in a subfolder.`
        : `${words[0]} with no path reads what feeds it; unless that is text, it is a search of ${cwd}, which would read ${h.path} (${h.why}). Give it the files (-Path), or search a subfolder.`;
    }
    if (searchVerb.test(unquoted) && !narrowedSearch.test(unquoted)) {
      const operands = tokens.slice(1);                                     // files or folders; none: the current folder
      for (const dir of operands.length ? operands.map((t) => absPath(t, cwd)).filter(isDir) : [cwd]) {
        const h = treeHolds(dir, '', own);
        if (h) return `a recursive search of ${dir} would read ${h.path} (${h.why}). Search a subfolder, or narrow it (--include / --glob / -t).`;
      }
    }
    return null;
  };
  // A listing's files: each path or glob it names, each -Filter/-Include pattern (`-Filter .env` selects the secret
  // itself), and, unless a pattern narrows it to other names, every folder it lists (none named: the current one).
  for (const { seg, up } of piped(p.text)) {
    const cmds = simpleCommands(seg);
    let k = 0;
    for (; k < cmds.length && isMark(cmds[k]); k++) mark(cmds[k]);
    const r = judge(seg.replace(/^[\s(]+/, ''), cmds[k] ?? [], up);
    if (r) return r;
    for (k++; k < cmds.length; k++) if (isMark(cmds[k])) mark(cmds[k]);
  }
  for (const code of p.code) {
    if (!readPrimitive.test(code)) continue;
    // a path in code is a string literal, judged whole: `'.env'`, f"{root}/.env" read; "this project's `.env`" is
    // prose a script writes into a doc (#60, ecom-lab)
    // and the arguments of a read call, token by token, which a stray quote can't hide (`/'/; readFileSync('.env')`)
    const args = [...code.matchAll(readCall)].flatMap((m) => tokensOf(m[1]));
    for (const t of [...[...code.matchAll(literal)].map((m) => m[1] ?? m[2] ?? m[3]).filter((s) => s.trim()), ...args]) {
      const d = denied(t, cwd, own);
      if (d) return `that command reads ${d.path} (${d.why}): no session reads it. ${how}`;
    }
  }
  if (depth < 4) for (const s of p.shell) {
    const r = shellRefusal(s, cwd, own, depth + 1, lost || MOVES_DIR.test(command));
    if (r) return r;
  }
  return null;
}
