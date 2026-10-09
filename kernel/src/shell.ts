// Where a shell command writes, roughly: the targets of redirects and of the usual file verbs (bash and PowerShell).
// Used by hook-bash.ts for the cell boundary. A heuristic like the rest of the shell guard: a script can write anywhere,
// and `cell audit` is the backstop.
import { tmpdir } from 'node:os';
import { posix } from 'node:path';

// split into simple commands (; && || | newline) and words, honouring quotes
export function simpleCommands(command: string): string[][] {
  const out: string[][] = [[]];
  let word = '', quote = '', had = false;
  const end = () => { if (had) out.at(-1)!.push(word); word = ''; had = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) { if (c === quote) quote = ''; else word += c; continue; }
    if (c === '"' || c === "'") { quote = c; had = true; continue; }
    if (/\s/.test(c) && c !== '\n') { end(); continue; }
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

// The write targets of a command, and the cwd changes (`cd x`) in order: [{ cwd?, target? }]
export function writeTargets(command: string): { cd?: string; target?: string }[] {
  const out: { cd?: string; target?: string }[] = [];
  for (const words of simpleCommands(command)) {
    for (let i = 0; i < words.length; i++) if (/^(\d|&)?>>?$/.test(words[i]) && words[i + 1]) out.push({ target: words[i + 1] });
    const ws = words.filter((w, i) => !/^(\d|&)?>>?$/.test(w) && !/^(\d|&)?>>?$/.test(words[i - 1] ?? ''));
    const [verb, ...args] = ws;
    if (!verb) continue;
    const plain = args.filter((a) => !/^-/.test(a));
    if (/^(cd|set-location|sl|chdir|pushd)$/i.test(verb) && plain[0]) out.push({ cd: plain[0] });
    else if (LAST.test(verb) && plain.length) out.push({ target: plain.at(-1)! });
    else if (ALL.test(verb)) for (const a of plain) out.push({ target: a });
    else if (verb === 'sed' && args.some((a) => /^-i/.test(a)) && plain.length) out.push({ target: plain.at(-1)! });
  }
  return out;
}

const norm = (p: string) => {
  let s = p.replaceAll('\\', '/');
  if (process.platform === 'win32') s = s.replace(/^\/([a-zA-Z])(\/|$)/, '$1:/').toLowerCase();   // Git Bash /d/x → d:/x
  return posix.normalize(s).replace(/\/+$/, '');
};
const isAbs = (p: string) => /^[a-zA-Z]:\//.test(p) || p.startsWith('/');

// The first write target of `command`, run in `cwd`, that lies outside `dir` (null = none). The temp folder (outside the
// cell's repository) and the null device are fine; a target built from a variable ($x, %x%, ~) can't be judged and is
// let through.
export function outside(command: string, cwd: string, dir: string): string | null {
  const home = norm(dir), tmp = norm(tmpdir()), repo = norm(`${home}/../..`);
  const under = (p: string, d: string) => p === d || p.startsWith(d + '/');
  let here = norm(cwd);
  const resolveIn = (p: string) => { const n = norm(p); return isAbs(n) ? n : norm(`${here}/${n}`); };
  for (const { cd, target } of writeTargets(command)) {
    if (cd) { if (!/[$%~`]/.test(cd)) here = resolveIn(cd); continue; }
    const t = target!;
    if (/[$%~`]/.test(t) || t.startsWith('&') || /^(\/dev\/(null|stdout|stderr)|nul|\$null)$/i.test(t)) continue;
    const abs = resolveIn(t);
    if (under(abs, home) || (under(abs, tmp) && !under(abs, repo))) continue;
    return t;
  }
  return null;
}
