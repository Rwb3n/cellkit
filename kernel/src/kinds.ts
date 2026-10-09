// Checks a proposed kinds doc (state/bedrock/kinds.json, schemas.ts) before it can be proposed or approved:
//   - shape: { kinds: { <name>: { description?, schema? } } }, names lowercase, none of the kit's own kinds redefined;
//   - every schema compiles;
//   - every claim already in root's log and in each cell's log still validates under it. A kind can't be removed or
//     narrowed while claims of it exist: the log is never edited, so the rules must keep fitting it.
// Run at amend and again at approve (claims may have landed in between).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readLog } from './log.ts';
import { BASE_KINDS, compileClaim, errorsOf, type KindDef } from './schemas.ts';
import { isCell, logHome } from './mail.ts';

export function checkKinds(root: string, value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['kinds.json must be an object'];
  const v = value as { kinds?: Record<string, KindDef> };
  const keys = Object.keys(v).filter((k) => k !== 'kinds');
  if (keys.length) return [`unknown key(s) ${keys.join(', ')} (only "kinds")`];
  const kinds = v.kinds ?? {};
  const out: string[] = [];
  for (const [k, d] of Object.entries(kinds)) {
    if (!/^[a-z][a-z0-9-]*$/.test(k)) out.push(`kind "${k}": lowercase letters, digits and dashes`);
    if (BASE_KINDS.includes(k)) out.push(`kind "${k}" is one of the kit's own kinds; name yours differently`);
    if (!d || typeof d !== 'object' || (d.schema !== undefined && (typeof d.schema !== 'object' || Array.isArray(d.schema)))) out.push(`kind "${k}": { description?, schema? } with schema a JSON Schema object`);
  }
  if (out.length) return out;
  let validate: ReturnType<typeof compileClaim>;
  try { validate = compileClaim(kinds); } catch (e) { return [`a schema doesn't compile: ${(e as Error).message}`]; }
  const cells = join(root, 'cells');
  const logs = [root, ...(existsSync(cells) ? readdirSync(cells).filter((n) => isCell(join(cells, n))).map((n) => logHome(root, n)) : [])];
  for (const dir of logs) {
    for (const e of readLog(dir)) {
      if (e.kind !== 'claim' || validate(e.body)) continue;
      out.push(`${dir === root ? 'root' : dir.replaceAll('\\', '/').split('/').at(-1)} ${e.id} (kind ${(e.body as { kind: string }).kind}) would no longer be valid: ${errorsOf(validate, 'claim').join('; ')}`);
      if (out.length >= 10) return [...out, '… (first 10 shown)'];
    }
  }
  return out;
}
