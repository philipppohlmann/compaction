# Synthetic eval fixtures (`tests/fixtures/eval/`)

**Public-safe, synthetic** recoverability/eval fixtures. Every file here is hand-generated (see
`generate-fixtures.mjs`) — there is **no real session content, no prompts/responses, no customer/PII data**. They
exercise the deterministic recoverability + evidence-tier logic (recoverability outcome + `real_captured` label) so
the eval path can be tested without any real capture. Pointer catalog + column meanings: [`../../../evals/fixtures.md`](../../../evals/fixtures.md).

| Fixture | What it exercises | Recoverability | `real_captured` |
|---|---|---|---|
| `01-valid-exact-recoverability.json` | happy path: every compacted span pointer-resolvable + hash-matching | `passed` | `false` |
| `02-missing-source-pointer.json` | `rawSourcePointer` stripped from compacted metadata | `failed` | `false` |
| `03-hash-mismatch.json` | recorded hash no longer matches the retained original | `failed` | `false` |
| `04-ambiguous-source-span.json` | pointer references an unresolvable message id/index | `failed` | `false` |
| `05-removed-content-not-recoverable.json` | original source message dropped from the retained trace | `failed` | `false` |
| `06-noop-unchanged.json` | nothing compacted — no recoverability evidence | `not_computed` | `false` |
| `07-codex-imported-not-real-captured.json` | imported evidence path; recoverability passes but not a real capture | `passed` | `false` |
| `08-claude-code-real-captured.json` | real-capture label path (only fixture allowed the `real_captured` label) | `passed` | `true` |

## Regenerating
```bash
node tests/fixtures/eval/generate-fixtures.mjs
```
Regenerate deterministically after any change to the fixture schema. Keep every fixture **synthetic + content-free** —
never paste real session content, prompts, responses, file contents, or PII into this directory.
