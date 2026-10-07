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

export const validators = {
  envelope: ajv.compile(load('envelope.schema.json')),
  observation: ajv.compile(load('observation.schema.json')),
  claim: ajv.compile(load('claim.schema.json')),
};

export type Kind = 'observation' | 'claim';

export function check(kind: 'envelope' | Kind, value: unknown): string[] {
  const v = validators[kind];
  return v(value) ? [] : (v.errors ?? []).map((e: ErrorObject) => `${kind}${e.instancePath} ${e.message}`);
}
