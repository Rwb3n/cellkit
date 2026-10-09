---
doc: ontology
version: 0.1
status: approval state lives in the log (state/views/bedrock.json)
changes: by amendment only (see §5)
---

# Ontology — <your project>

What this project is made of. Three layers that change at different speeds, plus a domain binding that lives outside, in each cell.

```
  1 SHAPE    almost never      the cell, the loop, memory
  2 KINDS    when evidence     what flows through a cell
  3 RULES    by amendment      what must always hold
  ─────────────────────────────────────────────────────────
  domain     every cycle       lives in each cell's binding.json, not here
```

Replace the placeholders. Keep the shape and the rules unless you have a reason; they're what the kit enforces.

---

## 1 · Shape

### 1.1 The cell

```
  cell : (State, Input) → (State′, Output)
```

- **Pure inside.** Nothing in the middle of a cell touches the world.
- **One entry, one exit.** Effects happen only at the edges: adapters bring the world in, the exit sends outputs out.
- **Nesting.** Cells contain cells. Seen from outside, a cell full of cells is one cell.

### 1.2 The loop

What leaves through the exit comes back through the entry (a reply, a click, an outcome) as an observation. That's what makes it a loop, not a pipeline.

### 1.3 Memory

```
  THE LOG        everything that came in, in order — never edited, never reordered
        │ fold
  THE PICTURES   what the cell currently believes — rebuilt from the log any time
```

---

## 2 · Kinds

```
  observation ──holds──▶ claim ──about──▶ thing · party · voice · claim
```

- **Observation:** one thing that came in (source, when, reliability, licence, payload).
- **Claim:** one statement from one observation, by one voice. Base kinds: fact · opinion · same-as · part-of · relation · rule · hypothesis · check.
- **<your kinds>:** add them here, then to `state/bedrock/kinds.json` (a JSON Schema each; README "Configuring it for your project").

---

## 3 · Rules

1. **The log is never edited.** Only appended. State = fold(log).
2. **Disagreement is kept.** Recency and voice trust decide the picture; history stays.
3. **Inferences are claims.** A model's or the system's conclusion is a claim in its own voice, trusted less than its sources.
4. **Agreement only counts between independent voices.** A check of a claim is never a second voice.
5. **Rules gate the exit.** Licences and terms are checked mechanically before anything leaves.
6. **Everything that leaves can be traced** back to the claims and observations behind it.
7. **Agents write content; scripts write structure.** Logs, mail and amendments are made by the kernel and checked by schemas and lint.

---

## 4 · Domain binding

Lives in each cell's `binding.json` (scope, registries, thresholds, vocabularies). The ontology names the slots; the cell fills them.

## 5 · Changing this document

Stage the new text at `state/bedrock/proposed/ontology.md`, run `node kernel/src/cli.ts amend --doc ontology --layer <layer> --reason "…"`. Only the operator approves, from their own prompt: `! node kernel/src/cli.ts approve --doc ontology`.

## 6 · Open

- <what you don't know yet>
