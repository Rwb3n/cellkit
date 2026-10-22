// The read guard: what no session reads, root's included. The kit guards writes everywhere; reads only here, for the
// Read and Grep tools (hook-read.ts) and the shell (hook-bash.ts). A floor, not a boundary: a script a command runs can
// still read anything its user can (an OS sandbox is the boundary; README "Limits"). Ported from SF-DEV (secrets.ts).
//   kit defaults (ANYWHERE): key material, .env files (not .env.example), credential files and folders, shell histories
//   the project's own (bedrock guards.json "unreadable"): [{ "path": "SOME_PROJECT/vault/", "why": "…" }, …], matched
//     by folder name anywhere on the disk, never by drive, so a clone or a worktree is covered too; a trailing / is a
//     folder, * matches within one name. Case-insensitive.
import { existsSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { CD, expandEnv, simpleCommands } from './shell.ts';

export interface Hit { path: string; why: string }
export interface Unreadable { path: string; why: string }

const ANYWHERE: { re: RegExp; why: string }[] = [
  { re: /(^|\/)\.ssh(\/|$)/i, why: 'SSH keys' },
  { re: /(^|\/)\.env(\.(?!example$)[^/]+)?$/i, why: 'environment secrets (.env)' },
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
  for (const n of ['.env', '.env.local', '.ssh']) if (existsSync(`${abs}/${n}`)) return { path: `${abs}/${n}`, why: n === '.ssh' ? 'SSH keys' : 'environment secrets (.env)' };
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

// The shell, one simple command at a time (split at ; & | and newlines). A segment reads when it starts with a read
// verb, or holds a read primitive (node -e "…readFileSync…", python's open()). Only a reading segment's path tokens
// count, quoted or not: a commit message naming .ssh is text, `cat ".env"` is a read.
const verbs = 'cat|type|gc|Get-Content|head|tail|less|more|grep|egrep|rg|findstr|Select-String|sed|awk|cp|copy|Copy-Item|scp|rsync|tar|zip|7z|base64|xxd|od|strings|source|Import-Csv|Get-FileHash';
const startsRead = new RegExp(String.raw`^\s*(?:sudo\s+|npx\s+)?(?:${verbs})(?=\s|$)`, 'i');
const readPrimitive = /readFileSync|readFile\(|createReadStream|ReadAllText|ReadAllBytes|ReadAllLines|read_text|read_bytes|\bopen\(|Get-Content/i;
const searchVerb = /^\s*(rg(?=\s|$)|e?grep\s(?:[^\n]*\s)?-[a-zA-Z]*[rR]|findstr\s(?:[^\n]*\s)?\/s\b|Select-String\b)/i;
const narrowedSearch = /(--glob|\s-g\s|--include|--type|\s-t\s)/;

// A `cd` moves the folder later segments are judged from (#1: `cd <another repo> && grep -r …` was judged against this
// project). One it can't judge ($x, %x%, ~, `…`) goes back to the session's folder, as before.
export function shellRefusal(command: string, session: string, own: Unreadable[] = []): string | null {
  let cwd = session;
  for (const seg of command.split(/;|&&?|\|\|?|\n/)) {
    const words = simpleCommands(seg)[0] ?? [];
    if (/^popd$/i.test(words[0] ?? '')) { cwd = session; continue; }        // back where it was: judged from the session's folder
    if (CD.test(words[0] ?? '')) {
      const args = words.slice(1).filter((w) => !/^-/.test(w));
      const to = expandEnv(args.length > 1 && /^\/d$/i.test(args[0]) ? args[1] : args[0] ?? '');   // cmd's `cd /d D:\x`; Git Bash's `cd /d` is D:/
      if (to) cwd = /[$%~`]/.test(to) ? session : absPath(to, cwd);
      continue;
    }
    const unquoted = seg.replace(/"[^"]*"|'[^']*'/g, '""');
    if (!startsRead.test(unquoted) && !readPrimitive.test(seg)) continue;
    const tokens = seg.split(/[\s()<>`,=]+/).map((t) => t.replace(/^["'@]+|["')]+$/g, '').replace(/^["']|["']$/g, '')).filter((t) => t && !t.startsWith('-'));
    for (const t of tokens) {
      const d = denied(t, cwd, own);
      if (d) return `that command reads ${d.path} (${d.why}): no session reads it. ${how}`;
    }
    if (searchVerb.test(unquoted) && !narrowedSearch.test(unquoted)) {
      const dirs = tokens.slice(1).map((t) => absPath(t, cwd)).filter(isDir);
      for (const dir of dirs.length ? dirs : [cwd]) {
        const h = treeHolds(dir, '', own);
        if (h) return `a recursive search of ${dir} would read ${h.path} (${h.why}). Search a subfolder, or narrow it (--include / --glob / -t).`;
      }
    }
  }
  return null;
}
