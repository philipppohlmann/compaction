# Eval gates

Public-safe definitions for the two **independent** eval gates. Passing one gate proves nothing about the other.

**Registry:** [`README.md`](README.md) · **Fixtures:** [`fixtures.md`](fixtures.md)

Implementation stays in `src/` and `tests/` — this file describes **what each gate means**, not proprietary scoring internals.

---

## Gate 1 — Context-preservation

| Field | Value |
|---|---|
| **Question** | After compaction, is task-critical **input** context still recoverable per deterministic checks? |
| **Used for** | **Input-token reduction** claims only |
| **Does NOT prove** | Output quality; semantic meaning; billing-confirmed savings |
| **Typical evals** | Deterministic recoverability; commitment recoverability; input compaction A/B + this gate |
| **CLI (when engine available)** | `compaction compact <trace> --eval` |
| **Public A/B harness (no engine in npm)** | `compaction input-compaction-ab init\|add\|status` |

### What “pass” means (honest summary)

- Compacted spans retain resolvable **source pointers** and **content hashes** against retained originals, **or**
- Provider-reported input A/B meets the accepted statistical bar (N≥3/arm, ±2·SE excludes zero) **and** the context-preservation eval passes for that workflow.

Does **not** mean the model would behave identically or that meaning is preserved.

---

## Gate 2 — Short-but-sufficient

| Field | Value |
|---|---|
| **Question** | Is shaped **output** still complete enough for the task? |
| **Used for** | **Output-token reduction** claims only |
| **Does NOT prove** | Input context preservation; cross-model generalization |
| **Typical evals** | Output sufficiency eval + output shaping A/B |
| **CLI (public harness)** | `compaction output-shaping`, `compaction output-shaping-ab init\|add\|status` |

### What “pass” means (honest summary)

- Full-content sufficiency checks pass on the shaped output (control-first calibrated fixtures), **and**
- Provider-reported output A/B meets N≥3/arm, ±2·SE excludes zero for that scoped workflow.

Does **not** mean a single headline % applies to all prompts or models.

---

## Gate binding (do not conflate)

```
Input savings claim  ──requires──▶  context-preservation gate
Output savings claim ──requires──▶  short-but-sufficient gate
```

A workflow may pass one and fail the other. Evidence-matrix records are scoped per tool and per gate.

---

## Token source honesty

| Label | When | Can support confirmed (scoped) A/B? |
|---|---|---|
| **provider-reported** | Captured usage metadata present | Yes, when N≥3/arm criterion met |
| **local-estimate** | chars/4 or wrapper without vendor usage | Measured deltas may exist; **not** confirmed provider-reported claims |
| **unavailable** | No usage fields | No savings number; recommendation mode only |

---

## What this file deliberately omits

- Proprietary thresholds and scoring formulas
- Real-session trace content
- Billing-confirmed savings (no repo figure today)

The registry rows in [`README.md`](README.md) say which surface each eval runs on.
