// A project's own guards, in cellkit.json at the repository root, so a project never edits the kernel's hooks:
//   {
//     "operator_only": [ { "command": "portfolio/src/pm.ts decide", "message": "…" },          a script + subcommand
//                        { "pattern": "\\bsf\\s+data\\s+delete\\b", "message": "…" } ],         or a raw regex (case-insensitive)
//     "protected":     [ { "path": "docs/portfolio/", "by": "portfolio/src/pm.ts" } ]           written only by that script
//   }
// Both hooks read it. The file is itself protected (an agent can't edit or delete its own guards): the operator edits
// it by hand. Missing = no project guards. Invalid = every command and write is refused until the operator fixes it.
// CELLKIT_CONFIG overrides the path (tests).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG = 'cellkit.json';
export interface OperatorOnly { re: RegExp; message: string }
export interface Guarded { re: RegExp; path: string; by?: string }
export interface Config { operatorOnly: OperatorOnly[]; protected: Guarded[]; writers: RegExp[]; error?: string }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// a path written with / matches \ too, after a start or a separator
const pathRe = (p: string) => esc(p.replace(/^\.?\/+/, '')).replaceAll('/', '[\\\\/]');

// "dir/script.ts sub cmd" → script (quoted or not, any folder before it) followed by its subcommand words
export function commandRe(command: string): RegExp {
  const [script, ...words] = command.trim().split(/\s+/);
  return new RegExp(`(^|[\\s"'\\\\/])${pathRe(script.split('/').at(-1)!)}["']?${words.map((w) => `\\s+${esc(w)}`).join('')}\\b`, 'i');
}

export function configPath(): string {
  return process.env.CELLKIT_CONFIG || join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), CONFIG);
}

export function loadConfig(path = configPath()): Config {
  const none: Config = { operatorOnly: [], protected: [], writers: [] };
  if (!existsSync(path)) return none;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      operator_only?: { command?: string; pattern?: string; message?: string }[]; protected?: { path: string; by?: string }[] };
    const operatorOnly = (raw.operator_only ?? []).map((o) => {
      if (!o.command && !o.pattern) throw new Error('operator_only entries need "command" or "pattern"');
      return { re: o.pattern ? new RegExp(o.pattern, 'i') : commandRe(o.command!), message: o.message ?? `${o.command ?? o.pattern} is the operator's: ask them to run it from their own prompt with "!"` };
    });
    const guarded = (raw.protected ?? []).map((p) => {
      if (!p.path) throw new Error('protected entries need "path"');
      return { re: new RegExp(`(^|[\\\\/\\s"'=])${pathRe(p.path)}${p.path.endsWith('/') ? '' : '(?![\\w.-])'}`, 'i'), path: p.path, by: p.by };
    });
    return { operatorOnly, protected: guarded, writers: guarded.flatMap((g) => (g.by ? [new RegExp(pathRe(g.by), 'i')] : [])) };
  } catch (e) {
    return { ...none, error: `${path} is invalid (${(e as Error).message}); the operator must fix it by hand` };
  }
}
