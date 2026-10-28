// The read guard: what no session reads, root's included. The kit guards writes everywhere; reads only here, for the
// Read and Grep tools (hook-read.ts) and the shell (hook-bash.ts). A floor, not a boundary: a script a command runs can
// still read anything its user can (an OS sandbox is the boundary; README "Limits"). Ported from SF-DEV (secrets.ts).
//   kit defaults (ANYWHERE): key material, .env files (.env, <name>.env; not *.env.example), credential files and folders, shell histories
//   the project's own (bedrock guards.json "unreadable"): [{ "path": "SOME_PROJECT/vault/", "why": "…" }, …], matched
//     by folder name anywhere on the disk, never by drive, so a clone or a worktree is covered too; a trailing / is a
//     folder, * matches within one name. Case-insensitive.
import { existsSync, readdirSync, statSync } from 'node:fs';
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
const TEXT_PRODUCERS = /^(git|gh|npm|npx|pnpm|yarn|node|deno|bun|python[\d.]*|py|pip|dotnet|cargo|go|docker|kubectl|claude|schtasks|tasklist|netstat|ipconfig|whoami|hostname|systeminfo|where|where\.exe|echo|Write-Output|Get-Process|gps|ps|Get-Service|gsv|Get-Date|Get-Command|gcm|Get-Module|Get-Content|gc|cat|type|Select-String|sls|Select-Object|select|Sort-Object|sort|head|tail|wc|uniq|cut|tr|grep|rg|findstr|sed|awk|jq|curl|wget)(\.exe)?$/i;
const textOnly = (u: string) => {
  const w = firstCommand(u);
  return TEXT_PRODUCERS.test(w[0] ?? '') && !/[$@({`]/.test(u.replace(quoted, '""')) && simpleCommands(u).filter((c) => !isMark(c)).length === 1;
};

// A `cd` moves the folder later segments are judged from (#1: `cd <another repo> && grep -r …` was judged against this
// project). One it can't judge ($x, %x%, ~, `…`) goes back to the session's folder, as before.
export function shellRefusal(command: string, session: string, own: Unreadable[] = [], depth = 0): string | null {
  const p = parts(command);
  let cwd = session;
  const saved: string[] = [];                                               // a subshell's cd ends at its close
  const mark = (w: string[]) => { if (w[0] === OPEN) saved.push(cwd); else cwd = saved.pop() ?? cwd; };
  const judge = (raw: string, words: string[], up: string[]): string | null => {
    if (/^popd$/i.test(words[0] ?? '')) { cwd = session; return null; }    // back where it was: judged from the session's folder
    if (CD.test(words[0] ?? '')) {
      const args = words.slice(1).filter((w) => !/^-/.test(w));
      const to = expandEnv(args.length > 1 && /^\/d$/i.test(args[0]) ? args[1] : args[0] ?? '');   // cmd's `cd /d D:\x`; Git Bash's `cd /d` is D:/
      if (to) cwd = /[$%~`]/.test(to) ? session : absPath(to, cwd);
      return null;
    }
    const unquoted = raw.replace(quoted, '""');
    if (!startsRead.test(unquoted) && !readPrimitive.test(unquoted)) return null;
    const tokens = tokensOf(withoutPattern(raw));
    for (const t of tokens) {
      const d = denied(t, cwd, own);
      if (d) return `that command reads ${d.path} (${d.why}): no session reads it. ${how}`;
    }
    // Select-String or Get-Content with no path reads what feeds it: text, or files when what feeds it lists them (#60,
    // ecom-lab: `schtasks … | Select-String "TaskName"` was refused). Text only when every command up the pipeline is a
    // known text producer with no expression in it (`echo (gci -r)` passes files); anything else, as before: a search
    // of the current folder. An allowlist on purpose: four reviews found ways around reading which commands list files.
    if (/^\s*(Select-String|sls|Get-Content|gc)(?=\s|$)/i.test(unquoted) && tokens.length < 2) {
      if (up.length && up.every(textOnly)) return null;
      const h = treeHolds(cwd, '', own);
      return h ? `${words[0]} with no path reads what feeds it; unless that is text, it is a search of ${cwd}, which would read ${h.path} (${h.why}). Give it the files (-Path), or search a subfolder.` : null;
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
    const r = shellRefusal(s, cwd, own, depth + 1);
    if (r) return r;
  }
  return null;
}
