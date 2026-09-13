# Eval fixtures catalog

Pointer catalog for **public-safe synthetic** eval fixtures. All files live under `tests/fixtures/eval/` — **do not move** implementation here. Index file: [`01-valid-exact-recoverability.json`](../tests/fixtures/eval/01-valid-exact-recoverability.json).

**Gates:** [`gates.md`](gates.md) · **Registry:** [`README.md`](README.md)

---

## Fixture index

| File | What it exercises | Expected recoverability | `real_captured` |
|---|---|---|---|
| [`01-valid-exact-recoverability.json`](../tests/fixtures/eval/01-valid-exact-recoverability.json) | Happy path: every compacted span pointer-resolvable + hash-matching | `passed` | `false` |
| [`02-missing-source-pointer.json`](../tests/fixtures/eval/02-missing-source-pointer.json) | `rawSourcePointer` stripped from compacted metadata | `failed` | `false` |
| [`03-hash-mismatch.json`](../tests/fixtures/eval/03-hash-mismatch.json) | Recorded hash no longer matches retained original | `failed` | `false` |
| [`04-ambiguous-source-span.json`](../tests/fixtures/eval/04-ambiguous-source-span.json) | Pointer references unresolvable message id/index | `failed` | `false` |
| [`05-removed-content-not-recoverable.json`](../tests/fixtures/eval/05-removed-content-not-recoverable.json) | Original source message dropped from retained trace | `failed` | `false` |
| [`06-noop-unchanged.json`](../tests/fixtures/eval/06-noop-unchanged.json) | Nothing compacted — no recoverability evidence | `not_computed` | `false` |
| [`07-codex-imported-not-real-captured.json`](../tests/fixtures/eval/07-codex-imported-not-real-captured.json) | Imported evidence path; recoverability passes | `passed` | **`false`** (imported ≠ real capture) |
| [`08-claude-code-real-captured.json`](../tests/fixtures/eval/08-claude-code-real-captured.json) | Real-capture label path for Claude Code fixture | `passed` | **`true`** (only fixture allowed this label) |

All content is **synthetic** — no secrets, no customer data.

---

## Validate the public catalog

From the repository root:

```bash
npm test -- tests/security/public-eval-registry-closure.test.ts
npm test -- tests/core/input-compaction-ab.test.ts tests/core/output-shaping-ab.test.ts
```

The signed engine's recoverability evaluator is delivered separately. These public fixtures document
its input and expected labels; the npm package does not pretend to execute an absent evaluator.

---

## Adding a fixture

1. Add JSON under `tests/fixtures/eval/` with a top-level `"note"` describing expected behavior.
2. Add a row to this file and to [`manifest.json`](manifest.json) if machine-readable discovery needed.
3. Link the proof record — content-free numbers only.
4. **Never** commit real traces or operator session content.

Do **not** move fixtures into `evals/` without an explicit architecture decision.
