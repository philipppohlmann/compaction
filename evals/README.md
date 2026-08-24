# Eval registry

Navigation layer for Compaction evals. **Implementation stays in `src/` and `tests/`** — this directory does not move code.

Machine-readable index: [`manifest.json`](manifest.json)

---

## Two eval gates (do not conflate)

| Gate | Question | Used for |
|---|---|---|
| **Context-preservation** | Was task-critical input context recoverable after compaction? | **Input-token reduction** claims |
| **Short-but-sufficient** | Is shaped output still complete for the task? | **Output-token reduction** claims |

Passing one gate proves nothing about the other.

---

## Registry

### 1. Deterministic recoverability (input safety baseline)

| Field | Location |
|---|---|
| **Proves** | Byte/hash/source-pointer recoverability after compaction |
| **Does NOT prove** | Semantic meaning; commitment meaning; token savings; billing |
| **Implementation** | Hybrid Engine (delivered separately) |
| **CLI** | `compaction compact <trace> --eval`, `compaction eval <fixture-or-dir>` |
| **Tests** | `tests/core/eval-harness.test.ts`, `tests/core/eval-cli.test.ts`, `tests/cli/compact-eval-one-command-cli.test.ts`, `tests/core/strong-eval-integration.test.ts` |
| **Fixtures** | `tests/fixtures/eval/*.json` |
| **Status** | **Shipped** — open-core recoverability path |

### 2. Commitment recoverability check (strong eval block)

| Field | Location |
|---|---|
| **Proves** | Extracted task-critical commitments remain present/recoverable (deterministic) |
| **Does NOT prove** | Semantic equivalence of commitments |
| **Implementation** | Hybrid Engine (delivered separately) |
| **CLI** | Part of `compact --eval` strong eval output |
| **Tests** | `tests/core/commitment-preservation.test.ts`, `tests/core/strong-eval-integration.test.ts` |
| **Status** | **Shipped** |

### 3. Fixture task-check (strong eval block)

| Field | Location |
|---|---|
| **Proves** | Required task anchors recoverable for **supported** fixture workflows |
| **Does NOT prove** | Model replay or real agent re-execution |
| **Implementation** | Hybrid Engine (delivered separately) |
| **Tests** | via `strong-eval-integration.test.ts` |
| **Status** | **Shipped** (fixture-scoped) |

### 4. Input compaction verification gate

| Field | Location |
|---|---|
| **Proves** | Provider-reported input-token A/B meets N≥3/arm, ±2·SE excludes zero **and** context-preservation eval passes |
| **Does NOT prove** | Output reduction; cross-provider magnitude; billing-confirmed savings |
| **Implementation (engine)** | Hybrid Engine (delivered separately) |
| **Implementation (public harness)** | `src/core/input-compaction-ab.ts` |
| **CLI** | `compaction input-compaction-ab init\|add\|status` |
| **Tests** | `tests/core/input-compaction-ab.test.ts`, `tests/core/input-compaction-verification.test.ts`, `tests/core/superseded-same-source-read.test.ts` |
| **Status** | **Shipped** — Codex confirmed scoped; Claude Code mixed local-estimate + scoped provider-reported |

### 5. Output sufficiency / shaping verification gate

| Field | Location |
|---|---|
| **Proves** | Provider-reported output A/B with N≥3/arm, ±2·SE excludes zero **and** full-content sufficiency eval passes (control-first calibrated) |
| **Does NOT prove** | Input context preservation; single headline % across models/prompts |
| **Implementation (engine)** | Hybrid Engine (delivered separately) |
| **Implementation (public)** | `src/core/output-shaping.ts`, `src/core/output-shaping-ab.ts`, `src/core/output-shaping-attach.ts` |
| **CLI** | `compaction output-shaping`, `compaction output-shaping-ab init\|add\|status`; attach via `capture codex\|cursor --output-shaping` |
| **Tests** | `tests/core/output-shaping*.test.ts` |
| **Status** | **Shipped** — eval proven to block live insufficient output (`exp-cc-output-005`) |

### 6. Context store retrieval eval (V0.4, internal)

| Field | Location |
|---|---|
| **Proves** | Recall, source coverage, continuation markers on fixture store (internal thresholds) |
| **Does NOT prove** | Public sufficiency verdict; 300M corpus claim |
| **Implementation** | `src/core/context-store-eval.ts`, `context-store-eval-cases.ts`, `context-store-sufficiency.ts` |
| **CLI** | `compaction context` (store path); eval internal to tests |
| **Tests** | `tests/core/context-store-eval*.test.ts`, `context-store-sufficiency.test.ts` |
| **Status** | **Shipped (internal)** — no public sufficiency claim |

### 7. Claims / overclaim regression guard

| Field | Location |
|---|---|
| **Proves** | First-value CLI surfaces stay within evidence ladder wording |
| **Implementation** | — |
| **Tests** | `tests/security/no-overclaim-first-value.test.ts` |
| **Status** | **Shipped** |

---

## Provider-reported vs local-estimate

| Source | When | Eval implication |
|---|---|---|
| **provider-reported** | Codex `turn.completed.usage`; Claude Code `claude -p` stream-json usage | Required for **confirmed (scoped)** A/B records |
| **local-estimate** | chars/4; Cursor wrapper | Measured deltas may exist; **confirmed (scoped)** provider-reported claims cannot |
| **unavailable** | Browser, Cursor output | No output savings number; recommendation mode only |

Code: `src/core/usage-metadata.ts`, `src/core/token-estimator.ts`

---

## Gaps (open validation targets)

1. **Claude Code input on ≥3 independent non-sensitive real sessions** — data-gated.
2. **Broader output distribution** — more prompt families + a second model.
3. **Category 2–3 input policy reach** — designed only; category 1 implemented.
4. **Cursor provider-reported path** — blocked on vendor usage API.
5. **Semantic preservation eval** — explicitly future (`not_evaluated`).
6. **Billing-confirmed savings** — operator protocol exists; no repo figure labeled billing-confirmed.

---

## How to add an eval to this registry

1. Add a row to this README and an entry in `manifest.json`.
2. Link proof records (content-free numbers only).
3. If the eval gates a new claim type, agree the design before implementing it.

Do **not** move implementation into `evals/` without an explicit architecture decision.
