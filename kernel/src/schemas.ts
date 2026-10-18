// Loads the kernel's JSON Schemas once and exposes validators.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { Ajv2020 as Ajv2020Class, ErrorObject } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { inMain } from './worktree.ts';

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, '..', 'schemas');
const load = (name: string) => JSON.parse(readFileSync(join(schemaDir, name), 'utf8'));

// ajv ships CommonJS; load it with require so the class and plugin keep their types.
// A cell's worktree has no node_modules of its own (git-ignored), so its kernel copy loads them from the main checkout's
// kernel. (Not a link: `git worktree remove --force` follows a junction and empties the target.)
const kernelDir = join(here, '..');
const require = createRequire(join(existsSync(join(kernelDir, 'node_modules')) ? kernelDir : inMain(kernelDir), 'package.json'));
const { Ajv2020 } = require('ajv/dist/2020.js') as { Ajv2020: typeof Ajv2020Class };
const addFormats = require('ajv-formats') as FormatsPlugin;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

// ── claim kinds ──────────────────────────────────────────────────────────────────
// The kit's own kinds are in claim.schema.json. A project's kinds are bedrock: state/bedrock/kinds.json, proposed and
// approved like the ontology (kinds.ts checks a proposal against every claim already logged):
//   { "kinds": { "visit": { "description": "…", "schema": { <JSON Schema for the claim when kind = visit> } } } }
// e.g. "schema": { "properties": { "says": { "type": "object", "required": ["at"] } } }. The kernel adds each to the kind
// enum with an if/then rule. (A project that still lists its kinds in claim.schema.json keeps working: the enums merge.)
export const BASE_KINDS = ['fact', 'opinion', 'same-as', 'part-of', 'relation', 'rule', 'hypothesis', 'check'];
export interface KindDef { description?: string; schema?: Record<string, unknown> }
// The main checkout's, also from a cell's worktree: kinds approved on main apply to a cell at once, not after root
// merges main into it (SF-DEV: a cell refused valid claims of a kind approved that day). No git: this checkout's.
export const kindsPath = (root = inMain(join(kernelDir, '..'))) => join(root, 'state', 'bedrock', 'kinds.json');

export function compileClaim(kinds: Record<string, KindDef> = {}) {
  const s = load('claim.schema.json');
  delete s.$id;                                                     // compiled once per kinds doc: no id clash
  const own = s.properties.kind.enum as string[];
  s.properties.kind.enum = [...new Set([...own, ...Object.keys(kinds)])];
  for (const [k, d] of Object.entries(kinds)) if (d.schema) s.allOf.push({ if: { properties: { kind: { const: k } } }, then: d.schema });
  return ajv.compile(s);
}
const projectKinds = (): Record<string, KindDef> =>
  existsSync(kindsPath()) ? (JSON.parse(readFileSync(kindsPath(), 'utf8')) as { kinds?: Record<string, KindDef> }).kinds ?? {} : {};

export const validators = {
  envelope: ajv.compile(load('envelope.schema.json')),
  observation: ajv.compile(load('observation.schema.json')),
  claim: compileClaim(projectKinds()),
};

export type Kind = 'observation' | 'claim';

export const errorsOf = (v: { errors?: ErrorObject[] | null }, kind: string) => (v.errors ?? []).map((e: ErrorObject) => `${kind}${e.instancePath} ${e.message}`);
export function check(kind: 'envelope' | Kind, value: unknown): string[] {
  const v = validators[kind];
  return v(value) ? [] : errorsOf(v, kind);
}
