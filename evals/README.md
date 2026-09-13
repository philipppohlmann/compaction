# Eval registry

This public tree contains content-free gate definitions, synthetic fixtures, and the A/B harnesses
used to record scoped token evidence. Engine-backed validation is delivered separately. The registry
does not present an evaluator that is absent from this tree as shipped here.

Machine-readable index: [`manifest.json`](manifest.json)

## Independent gates

| Gate | Question | Used for |
|---|---|---|
| **Context-preservation** | Was task-critical input context recoverable after compaction? | Input-token reduction claims |
| **Short-but-sufficient** | Is shaped output still complete for the task? | Output-token reduction claims |

Passing one gate proves nothing about the other. See [`gates.md`](gates.md) for the public definitions.

## Public registry

### Recoverability fixtures

- **Files:** [`tests/fixtures/eval/`](../tests/fixtures/eval/)
- **Proves:** only that the published synthetic cases and expected labels are inspectable.
- **Does not prove:** that an engine-backed evaluator ran, semantic equivalence, or token savings.
- **Status:** fixture catalog shipped; evaluator delivered separately.

### Input-compaction A/B harness

- **Implementation:** [`src/core/input-compaction-ab.ts`](../src/core/input-compaction-ab.ts)
- **CLI:** `compaction input-compaction-ab init|add|status`
- **Tests:** [`tests/core/input-compaction-ab.test.ts`](../tests/core/input-compaction-ab.test.ts)
- **Proves:** scoped provider-reported A/B statistics when the required observations exist.
- **Does not prove:** context preservation. An input-reduction claim also needs the separately delivered
  engine validation to pass.

### Output-shaping A/B harness

- **Implementation:** [`src/core/output-shaping.ts`](../src/core/output-shaping.ts),
  [`src/core/output-shaping-ab.ts`](../src/core/output-shaping-ab.ts), and
  [`src/core/output-shaping-attach.ts`](../src/core/output-shaping-attach.ts)
- **CLI:** `compaction output-shaping`, `compaction output-shaping-ab init|add|status`
- **Tests:** `tests/core/output-shaping.test.ts`, `tests/core/output-shaping-ab.test.ts`, and
  `tests/core/output-shaping-attach.test.ts`
- **Proves:** scoped provider-reported A/B statistics when the required observations exist.
- **Does not prove:** output sufficiency. An output-reduction claim also needs the separately delivered
  sufficiency validation to pass.

### Claims guards

- **Tests:** `tests/security/open-basic-engine-free.test.ts` and
  `tests/cli/watch-tier-label-provenance.test.ts`
- **Proves:** public Open/basic and receipt-line surfaces retain their evidence labels.

## Token-source honesty

| Source | When | Eval implication |
|---|---|---|
| **provider-reported** | Provider usage fields are present | Can support confirmed, scoped A/B evidence |
| **local-estimate** | The public parser or wrapper derives an estimate | Cannot support a provider-reported claim |
| **unavailable** | No usable usage fields reach Compaction | No savings number |

Compaction's current Cursor parser/read path does not receive provider-reported per-turn token fields;
Cursor evidence therefore stays local-estimate or unavailable as appropriate.

## Open validation targets

1. Broader provider/model/prompt coverage for both A/B harnesses.
2. Provider-reported token fields through Compaction's Cursor parser/read path.
3. Semantic-preservation evaluation; current deterministic checks do not establish it.
4. Billing-confirmed savings; no public repository figure carries that label.

## Adding a public eval

1. Add a registry entry and update [`manifest.json`](manifest.json).
2. Reference only paths that exist in this public tree.
3. Use synthetic fixtures and content-free evidence.
4. Get design approval before adding a new claim type.
