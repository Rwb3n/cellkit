// Where a shell command writes, roughly: the targets of redirects and of the usual file verbs (bash and PowerShell).
// Used by hook-bash.ts for the cell boundary. A heuristic like the rest of the shell guard: a script can write anywhere,
// and `cell audit` is the backstop.
import { tmpdir } from 'node:os';
import { posix } from 'node:path';

// A subshell opens and closes: marker commands simpleCommands puts where its parens stand.
export const OPEN = '\u0000(', CLOSE = '\u0000)';
export const isMark = (words: string[]) => words.length === 1 && (words[0] === OPEN || words[0] === CLOSE);
// The first command of a segment that is not a subshell's marker.
export const firstCommand = (s: string): string[] => simpleCommands(s).find((w) => !isMark(w)) ?? [];

// split into simple commands (; && || | newline, a subshell's parens) and words, honouring quotes
export function simpleCommands(command: string): string[][] {
  const out: string[][] = [[]];
  let word = '', quote = '', had = false;
  const parens: boolean[] = [];   // open parens: true for a subshell's
  const cases: number[] = [];     // each open case … esac (its patterns end in `)`): the parens open at its start
  const end = () => { if (had) { out.at(-1)!.push(word); if (!quote) { if (word === 'case') cases.push(parens.length); else if (word === 'esac') cases.pop(); } } word = ''; had = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) { if (c === quote) quote = ''; else word += c; continue; }
    if (c === '"' || c === "'") { quote = c; had = true; continue; }
    if (/\s/.test(c) && c !== '\n') { end(); continue; }
    // A subshell's parens, where a command starts, end a word and a command (#75: `(ls 2>/dev/null)` read the target as
    // `/dev/null)`). Any other paren stays in its word, as before: PowerShell's `-Path (Join-Path . state)` is an argument.
    // Each is marked by a command of its own (OPEN, CLOSE), so a cd inside is undone at its close (`(cd /tmp) && rm x`).
    if (c === '(' && !had && !out.at(-1)!.length && !cases.length) { parens.push(true); out.at(-1)!.push(OPEN); out.push([]); continue; }
    if (c === '(') parens.push(false);
    if (c === ')' && cases.length && parens.length === cases.at(-1)) { word += c; had = true; continue; }   // a case pattern's `a)`
    if (c === ')' && parens.pop()) { end(); if (out.at(-1)!.length) out.push([]); out.at(-1)!.push(CLOSE); out.push([]); continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      end();
      if ((c === '&' && command[i - 1] === '>') || (c === '&' && command[i + 1] === '>')) { word = '&'; had = true; continue; }
      if (out.at(-1)!.length) out.push([]);
      if (command[i + 1] === c) i++;
      continue;
    }
    if (c === '>') {
      // a redirect is its own word: ">", ">>", "2>", "&>"; its target is the next word
      const prev = had && /^(\d|&)$/.test(word) ? word : '';
      if (prev) { word = ''; had = false; } else end();
      const op = command[i + 1] === '>' ? '>>' : '>';
      if (op === '>>') i++;
      out.at(-1)!.push(prev + op);
      continue;
    }
    word += c; had = true;
  }
  end();
  return out.filter((w) => w.length);
}

const LAST = /^(cp|mv|copy|move|cpi|mi|copy-item|move-item|ln)$/i;
const ALL = /^(rm|rmdir|touch|mkdir|tee|truncate|del|erase|rd|ri|remove-item|ni|new-item|sc|set-content|ac|add-content|clear-content|out-file|ren|rename|rename-item|unlink)$/i;
export const CD = /^(cd|set-location|sl|chdir|pushd)$/i;
// Of those, the verbs that delete or move their paths away: a folder they name goes, with whatever it holds (#49).
const REMOVES = /^(rm|rmdir|del|erase|rd|ri|remove-item|ren|rename|rename-item|unlink)$/i;
const MOVES = /^(mv|move|mi|move-item)$/i;

// $X, ${X}, %X%, $env:X from the environment (an unset one stays as written, so it still reads as unjudgeable)
export const expandEnv = (s: string) => s.replace(/\$env:(\w+)|\$\{(\w+)\}|\$(\w+)|%(\w+)%/gi, (m, a, b, c, d) => process.env[a ?? b ?? c ?? d] ?? m);

// git's own options before the subcommand (#1, AI-MMO 1e39484): the subcommand's words, and the folders its paths may
// be relative to. -C <dir> moves the folder as git does (each relative to the one before); --work-tree adds the work
// tree, --git-dir the folder holding it (a pathspec is relative to the cwd inside the work tree, to its top outside it:
// both are checked). '' is the shell's own folder. Never throws: an unknown option just advances, a missing value is ''.
const GIT_VALUED = /^(-c|--git-dir|--work-tree|--namespace|--super-prefix|--config-env|--exec-path|--attr-source)$/;
export function gitGlobals(args: string[]): { rest: string[]; bases: string[] } {
  const join = (base: string, d: string) => {
    let s = expandEnv(d).replaceAll('\\', '/');
    if (process.platform === 'win32') s = s.replace(/^\/([a-zA-Z])(\/|$)/, '$1:/');
    return posix.normalize(/^([a-zA-Z]:)?\//.test(s) || !base ? s : `${base}/${s}`);
  };
  let at = '', i = 0;
  const extra: string[] = [];
  while (i < args.length && args[i].startsWith('-') && args[i] !== '--') {
    const a = args[i], eq = a.indexOf('=');
    let name = eq > 0 ? a.slice(0, eq) : a, value = eq > 0 ? a.slice(eq + 1) : '';
    if (a === '-C' || (GIT_VALUED.test(name) && eq < 0)) { value = args[i + 1] ?? ''; i += 2; }
    else if (a.startsWith('-C') && a.length > 2) { name = '-C'; value = a.slice(2); i++; }   // -C<dir>, as git reads it
    else i++;
    if (!value) continue;
    if (name === '-C') at = join(at, value);
    else if (name === '--work-tree') extra.push(join(at, value));
    else if (name === '--git-dir') extra.push(posix.dirname(join(at, value)));
  }
  if (args[i] === '--') i++;
  return { rest: args.slice(i), bases: [...new Set([at, ...extra])] };
}

// What a command does, not the text it carries (#2; SF-DEV S5, retro C8). A heredoc's body is text unless a shell or an
// interpreter reads its program from it (`bash <<EOF`, `python - <<EOF`; not `cat > f <<EOF`, `git commit -F -`, or
// `node script.ts <<EOF`, which reads it as data). What runs wherever it stands: command substitution ($(…), backticks;
// not in single quotes), a shell's -c / -Command / cmd's /c string, eval's arguments, an interpreter's -e / -c code.
const SHELLS = /^(bash|sh|zsh|dash|ksh|fish|pwsh|powershell|cmd|eval)(\.exe)?$/i;
const INTERPRETERS = /^(node|nodejs|deno|bun|tsx|ts-node|python[\d.]*|py|pythonw|ruby|perl|php|rscript|osascript)(\.exe)?$/i;
const REMOTE = /^(ssh|wsl|docker|podman|kubectl)(\.exe)?$/i;                  // their heredoc runs as commands elsewhere
export const PATTERNED = /^(grep|egrep|fgrep|rg|findstr|sed|awk|gawk|select-string|sls)(\.exe)?$/i;
const PREFIX = /^(sudo|env|time|command|nice|nohup|exec|npx|bunx|pnpx|[A-Za-z_]\w*=.*)$/i;

// The verb of a simple command's words, past prefixes (sudo, env, npx, X=y), without its folder.
export function verbOf(words: string[]): { verb: string; i: number } {
  let i = 0;
  while (i < words.length - 1 && PREFIX.test(words[i])) i++;
  return { verb: (words[i] ?? '').replace(/^.*[\\/]/, ''), i };
}

// Simple commands as written (quotes kept), split at ; & | and newlines outside quotes.
export function segments(s: string): string[] {
  return piped(s).map((x) => x.seg);
}
// The same, each with `up`: the segments a single | feeds into it, first to last (none: []).
export function piped(s: string): { seg: string; up: string[] }[] {
  const out: { seg: string; up: string[] }[] = [];
  let cur = '', q = '', pipe = false;
  const push = () => { const t = cur.trim(); if (t) { const prev = out.at(-1); out.push({ seg: t, up: pipe && prev ? [...prev.up, prev.seg] : [] }); } cur = ''; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if ((c === '\\' || c === '`') && /^\r?\n/.test(s.slice(i + 1, i + 3))) { cur += ' '; i += s[i + 1] === '\r' ? 2 : 1; continue; }   // a continued line
    if (c === '\n' && pipe && !cur.trim()) continue;                       // `a |` then the next command on the next line
    if (c === ';' || c === '\n' || c === '|' || (c === '&' && s[i - 1] !== '>' && s[i + 1] !== '>')) {
      push();
      pipe = c === '|' && s[i + 1] !== '|';
      if (s[i + 1] === c) i++;
      else if (pipe && s[i + 1] === '&') i++;                                 // |& pipes stderr too
      continue;
    }
    cur += c;
  }
  push();
  return out;
}

// How the command before a heredoc reads its body: as shell commands, as program code, or (null) as data.
function reader(head: string): 'shell' | 'code' | null {
  const words = firstCommand(segments(head).at(-1) ?? '');
  const { verb, i } = verbOf(words);
  const args = words.slice(i + 1).filter((w, j, a) => !/^(\d|&)?>>?$/.test(w) && !/^(\d|&)?>>?$/.test(a[j - 1] ?? ''));
  const script = args.find((w) => !w.startsWith('-'));
  const ownProgram = !!script && /\.(c|m)?[jt]s$|\.(py|rb|pl|php|ps1|sh|bash)$/i.test(script);
  if (SHELLS.test(verb)) return ownProgram ? null : 'shell';
  if (INTERPRETERS.test(verb)) return ownProgram ? null : 'code';
  return REMOTE.test(verb) ? 'shell' : null;
}

// text: the command with data heredocs' bodies taken out (quotes kept). shell: strings that run as shell commands.
// code: program code an interpreter runs. One level; callers recurse into shell.
export function parts(command: string): { text: string; shell: string[]; code: string[] } {
  const shell: string[] = [], code: string[] = [];
  const heredoc = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;
  const text = command.replace(heredoc, (m: string, _q: string, _tag: string, body: string, off: number, all: string) => {
    const kind = reader(all.slice(all.lastIndexOf('\n', off) + 1, off));
    if (kind === 'shell') shell.push(body); else if (kind === 'code') code.push(body);
    return m.slice(0, m.indexOf('\n'));
  });
  const unsingle = text.replace(/'[^']*'/g, (q) => ' '.repeat(q.length));
  for (const m of unsingle.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) shell.push(m[1] ?? m[2]);
  for (const seg of segments(text)) {
    const words = firstCommand(seg);
    const { verb, i } = verbOf(words);
    if (/^eval$/i.test(verb)) { shell.push(words.slice(i + 1).join(' ')); continue; }
    if (SHELLS.test(verb)) {
      const k = words.findIndex((w, j) => j > i && /^(-c|-command|\/c|\/k)$/i.test(w));
      if (k > 0) shell.push(words.slice(k + 1).join(' '));
      continue;
    }
    if (PATTERNED.test(verb) || /^git(\.exe)?$/i.test(verb)) continue;    // grep -e, sed -e, git commit -c: not code
    for (let j = i + 1; j < words.length - 1; j++) if (/^(-e|--eval|-c|-p|--print|-E|-r)$/.test(words[j])) code.push(words[j + 1]);
  }
  return { text, shell, code };
}

// Writes in program code (SF-DEV): a quoted string or heredoc that holds one counts.
export const writePrimitive = /writeFileSync|appendFileSync|unlinkSync|rmSync|rmdirSync|renameSync|\bshutil\.(rmtree|move)\b|\bos\.(remove|unlink|rmdir)\b|WriteAllText|WriteAllLines|AppendAllText|write_text|write_bytes|\bopen\([^)]*,\s*['"][wax]|\b(Set|Add|Clear)-Content\b|\bOut-File\b|\b(Remove|Copy|Move|New|Rename)-Item\b/i;

// The command as acts, for the text checks: quoted text blanked unless it holds a write primitive (code for a runner
// parts() doesn't know: `deno eval "…"`) or substitutes a command; data heredocs dropped; what runs (shell strings, code
// with a write primitive) appended, one per line. Write targets, quoted or not, are checked one by one (writeTargets).
function kept(text: string): string {
  const quoted = /"[^"]*"|'[^']*'/g;
  const writesBare = writePrimitive.test(text.replace(quoted, '""'));
  return text.replace(quoted, (q: string) => writesBare || writePrimitive.test(q) || (q[0] === '"' && /\$\(|`/.test(q)) ? q : '""');
}
export function acts(command: string, depth = 0): string {
  const p = parts(command);
  return [kept(p.text), ...(depth < 4 ? p.shell.map((s) => acts(s, depth + 1)) : p.shell), ...p.code.filter((c) => writePrimitive.test(c))].join('\n');
}
// The same acts, one unit per pipeline (#81: a path one command names and a write in another are not one act; but
// `echo state/log/x | xargs rm` is one), and program code whole: its path and its write call may stand on different lines.
export function actUnits(command: string, depth = 0): string[] {
  const p = parts(command);
  // each pipeline with what it runs (`sh -c 'echo state/log/x' | xargs rm`): its acts, whole
  const pipelines = piped(p.text).reduce<string[]>((a, { seg, up }) => (up.length && a.length ? [...a.slice(0, -1), `${a.at(-1)} | ${seg}`] : [...a, seg]), []);
  return [...pipelines.map((pl) => acts(pl, depth)), ...(depth < 4 ? p.shell.flatMap((s) => actUnits(s, depth + 1)) : p.shell), ...p.code.filter((c) => writePrimitive.test(c))];
}

// The write targets of a command, and the cwd changes (`cd x`) in order: [{ cwd?, target? }]. `git` marks a path that
// git's checkout, restore, rm or mv writes, already joined to the folder git's own options name; `removes` one deleted
// or moved away (rm, mv's sources). Data heredocs are text (#2); what runs in a shell string or a shell-fed heredoc counts.
export interface WriteTarget { cd?: string; target?: string; git?: boolean; removes?: boolean; reset?: string; sub?: 'open' | 'close' }
// A git command's pathspecs: its arguments that aren't options (nor the value of one in `valued`), or all after `--`;
// none means the whole checkout ('.').
function pathspecs(args: string[], valued: string[]): string[] {
  if (args.includes('--')) return args.slice(args.indexOf('--') + 1).filter(Boolean).length ? args.slice(args.indexOf('--') + 1) : ['.'];
  const out = args.filter((a, i) => !a.startsWith('-') && !valued.includes(args[i - 1]));
  return out.length ? out : ['.'];
}
export function writeTargets(command: string): WriteTarget[] {
  const out: WriteTarget[] = [];
  for (const words of commandsRun(command)) {
    if (isMark(words)) { out.push({ sub: words[0] === OPEN ? 'open' : 'close' }); continue; }   // a subshell: its cd is undone at the close
    for (let i = 0; i < words.length; i++) if (/^(\d|&)?>>?$/.test(words[i]) && words[i + 1]) out.push({ target: words[i + 1] });
    const ws = words.filter((w, i) => !/^(\d|&)?>>?$/.test(w) && !/^(\d|&)?>>?$/.test(words[i - 1] ?? ''));
    const [verb, ...args] = ws;
    if (!verb) continue;
    const plain = args.filter((a) => !/^-/.test(a));
    if (CD.test(verb) && plain[0]) out.push({ cd: plain[0] });
    else if (/^git(\.exe)?$/i.test(verb)) {
      const { rest, bases } = gitGlobals(args);
      const [sub = '', ...gargs] = rest;
      // index only: rm --cached, restore --staged (-S) without --worktree (-W); neither touches a file
      const indexOnly = gargs.some((a) => /^(--cached|--staged|-S)$/.test(a)) && !gargs.some((a) => /^(--worktree|-W)$/.test(a));
      const at = (p: string) => bases.map((b) => (b ? posix.normalize(/^([a-zA-Z]:)?\//.test(p.replaceAll('\\', '/')) ? p : `${b}/${p}`) : p));
      if (/^(checkout|restore|rm|mv)$/i.test(sub) && !indexOnly)
        for (const p of gargs.filter((a) => !a.startsWith('-'))) for (const t of at(p)) out.push({ target: t, git: true });
      // #3: what deletes files git doesn't hold yet (a log entry not committed) or the commits that hold them.
      // clean that deletes (-f, not -n), unless only ignored files (-X: views, locks, never a log entry): its pathspecs
      const flags = gargs.filter((a) => /^-[^-]/.test(a)).join('');
      if (/^clean$/i.test(sub) && (/f/.test(flags) || gargs.includes('--force')) && !/n/.test(flags) && !gargs.includes('--dry-run') && !(/X/.test(flags) && !/x/.test(flags)))
        for (const p of pathspecs(gargs, ['-e', '--exclude'])) for (const t of at(p)) out.push({ target: t, git: true, removes: true });
      // stash (push, save): it takes away what isn't committed, a staged new entry or an approved bedrock doc too, and
      // with -u/-a an untracked entry: its pathspecs (after --), else the whole checkout
      const stashArgs = /^stash$/i.test(sub) && /^(push|save)?$/i.test(gargs[0]?.startsWith('-') ? '' : gargs[0] ?? '') ? gargs.filter((a) => !/^(push|save)$/i.test(a)) : null;
      if (stashArgs)
        for (const p of stashArgs.includes('--') ? stashArgs.slice(stashArgs.indexOf('--') + 1) : ['.']) for (const t of at(p)) out.push({ target: t, git: true, removes: true });
      // reset --hard discards every uncommitted change (an approved bedrock doc not yet committed); --hard, --keep or
      // --merge to a commit other than HEAD moves the checkout back, and the log entries committed since go with it
      // (AI-MMO lost 10 after a landing that way). --keep/--merge to HEAD keep local changes.
      const mode = gargs.find((a) => /^--(hard|keep|merge)$/.test(a));
      const commit = gargs.slice(0, gargs.includes('--') ? gargs.indexOf('--') : undefined).find((a) => !a.startsWith('-'));
      const back = !!commit && !/^(HEAD|@)$/i.test(commit);
      if (/^reset$/i.test(sub) && mode && (back || mode === '--hard'))
        for (const t of at('.')) out.push({ target: t, git: true, reset: back ? `${mode} ${commit}` : mode });
    }
    else if (LAST.test(verb) && plain.length) {
      out.push({ target: plain.at(-1)! });
      if (MOVES.test(verb)) for (const a of plain.slice(0, -1)) out.push({ target: a, removes: true });   // mv's sources go
    }
    else if (ALL.test(verb)) for (const a of plain) out.push({ target: a, ...(REMOVES.test(verb) ? { removes: true } : {}) });
    else if (verb === 'sed' && args.some((a) => /^-i/.test(a)) && plain.length) out.push({ target: plain.at(-1)! });
  }
  return out;
}

// The simple commands a command runs (words, quotes taken off): its own, less data heredocs, then what runs inside it.
// The paths a script's file calls name, in code a command runs (acts): `rmSync('state/views', …)`, `shutil.rmtree('state')`.
// Deletes, renames and removing moves mark `removes` (the path goes, with what it holds); a write names only its file (#49).
const CODE_CALL = /\b(rmSync|rmdirSync|unlinkSync|renameSync|writeFileSync|appendFileSync|rmtree|remove|unlink|rmdir|move|rm)\s*\(\s*(['"])([^'"\n]+)\2/g;
export function codeTargets(code: string): WriteTarget[] {
  return [...code.matchAll(CODE_CALL)].map((m) => ({ target: m[3], ...(/^(writeFileSync|appendFileSync)$/.test(m[1]) ? {} : { removes: true }) }));
}

export function commandsRun(command: string, depth = 0): string[][] {
  const p = parts(command);
  return [...simpleCommands(p.text), ...(depth < 4 ? p.shell.flatMap((s) => commandsRun(s, depth + 1)) : [])];
}

const norm = (p: string) => {
  let s = p.replaceAll('\\', '/');
  if (process.platform === 'win32') s = s.replace(/^\/([a-zA-Z])(\/|$)/, '$1:/').toLowerCase();   // Git Bash /d/x → d:/x
  return posix.normalize(s).replace(/\/+$/, '');
};
const isAbs = (p: string) => /^[a-zA-Z]:\//.test(p) || p.startsWith('/');

// The first write target of `command`, run in `cwd`, that lies outside `dir` (null = none). The temp folder (outside the
// cell's repository) and the null device are fine; a target built from a variable ($x, %x%, ~) can't be judged and is
// let through. `owned`: the repo paths the cell also owns (config.ts ownedRes), matched against the path relative to
// the repository (the folder two above the cell).
export function outside(command: string, cwd: string, dir: string, owned: RegExp[] = []): string | null {
  const home = norm(dir), tmp = norm(tmpdir()), repo = norm(`${home}/../..`);
  const under = (p: string, d: string) => p === d || p.startsWith(d + '/');
  let here = norm(cwd);
  const resolveIn = (p: string) => { const n = norm(p); return isAbs(n) ? n : norm(`${here}/${n}`); };
  const saved: string[] = [];
  for (const { cd, target, sub } of writeTargets(command)) {
    if (sub) { if (sub === 'open') saved.push(here); else here = saved.pop() ?? here; continue; }
    if (cd) { if (!/[$%~`]/.test(cd)) here = resolveIn(cd); continue; }
    const t = target!;
    if (/[$%~`]/.test(t) || t.startsWith('&') || /^(\/dev\/(null|stdout|stderr)|nul|\$null)$/i.test(t)) continue;
    const abs = resolveIn(t);
    if (under(abs, repo) && abs !== repo && owned.some((r) => r.test(abs.slice(repo.length + 1)))) continue;
    if (under(abs, home) || ((under(abs, tmp) || under(abs, '/tmp')) && !under(abs, repo))) continue;   // /tmp: Git Bash's temp too
    return t;
  }
  return null;
}
