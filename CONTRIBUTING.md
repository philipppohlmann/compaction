# Contributing to Compaction

Thanks for your interest in contributing to **Compaction** — the local optimization layer for AI coding
agents. It connects to Claude Code, Codex, and Cursor and optimizes model calls from your own machine:
**output shaping** before generation via the tools' native hooks and the local gateway, a **content-free
receipt** for every call, and byte-exact recovery. Live-history **input compaction** is the other half and
lives in the proprietary Engine, delivered separately. Everything the open core does runs **on your
machine**: no hosted service, no prompt or code telemetry, no trace content leaving your environment.
With a free account the client also exchanges content-free records with our service — device activation,
entitlement, usage counts, engine release lookup — and that client code is open too, so you can read
exactly what crosses.

Compaction is **open core**. The open-core surface is the **client**: the CLI, the local gateway, the
native tool hooks, the one public deterministic output-shaping method, content-free receipts, the apply
gates, byte-exact recovery, and the account/entitlement/usage client code. All of it runs on your machine.

The **adaptive Engine is proprietary** and is not part of this contribution surface. It is the part that
changes what the model sees on the input side — live-history compaction, candidate generation and ranking,
commitment preservation, turn-aware method selection, and the adaptive output path — and it is delivered
separately from npm. The hosted and org layer is likewise proprietary (see
[What is out of scope](#what-is-out-of-scope-for-contributions)).

---

## Where contributions are most welcome

The open-core wedge is **single-user, local-first**. High-value areas, roughly in order:

- **CLI** (`src/cli/`) — command ergonomics, honest reporting output, clearer errors and exit paths.
- **Public core** (`src/core/`) — trace parsing, waste detection, token/cost estimation, the deterministic
  compaction policies, safety/recoverability artifacts.
- **Adapters and wrappers** — local capture/import for agent tools (Claude Code, Codex, Cursor, OpenAI
  Agents): new adapters, format fixes, better degrade behavior when a tool exposes less data.
- **Output shaping** — the deterministic instruction family applied before generation. This is the part
  most open to contribution and the one with the widest effect: output is the larger share of a typical
  bill. Better wording, better structure, better coverage of request shapes — all of it helps everyone
  who installs this, and it is readable, testable, and engine-free.
- **Examples** (`src/examples/`) — synthetic demo traces and runnable demos.
- **Docs** — user-facing documentation, honest capability descriptions, setup guides.
- **Synthetic fixtures** — deterministic test fixtures for adapters, policies, and evals. **Never real
  sessions — synthetic only** (see privacy rules below).
- **Public eval gates** (`evals/`) — registry rows, gate definitions, fixture catalogs. The registry is
  navigation; implementation stays in `src/` with tests.
- **Local reports** — the `.compaction/` artifact writers, report generators, and summaries (all local,
  content-free by default).
- **Privacy / local-first improvements** — anything that strengthens the local-first posture: content-free
  logging, redaction, consent flows, provenance, recoverability.

---

## What is out of scope for contributions

These surfaces are **not part of the open core**. The proprietary surface is the **adaptive Engine**, the
**hosted and org layer**, and the private evaluation machinery. PRs that touch, reimplement, or try to
expose them will be declined:

- The adaptive Engine (`src/engine/**`) — live-history input compaction, candidate generation and ranking,
  commitment preservation, turn-aware method selection, the adaptive output path, and the on-device hybrid
- Hosted API and control-plane internals (hosted meter, evidence dashboard, team/fleet view, seats)
- Signed receipt verification, SSO/RBAC/audit, and other org-layer internals
- Billing / entitlement internals
- Private eval / judge / corpus machinery (savings-confirmation gates, strong verifiers, judge rubrics,
  real-corpus evaluation and capture)
- Customer or private traces — in any form, including test fixtures
- Commercial and strategy documents

If a change seems to need one of these, open an issue describing the problem instead — often there is an
open-core way to solve it.

---

## Prerequisites

- Node.js ≥ 18
- npm (use `npm ci`, not `npm install`, for reproducible deps)

---

## Setup and verify

```bash
npm ci
npm run verify          # typecheck + test + package smoke
```

Optional full baseline (behavior changes):

```bash
npm run build
npm run analyze:demo
npm run compact:demo
```

Inspect generated artifacts under `.compaction/runs/` when working on compaction behavior.

---

## Open-core boundary (critical)

The published npm package ships `dist/cli` + `dist/core`, minus the private modules the `files` list
excludes by name. The Engine under `src/engine/` is **proprietary**: it is not in the npm package and not
in the open-core source surface — the runtime reaches it only through a lazy, gated seam that fails open
when it is absent, so the client builds, ships, and runs without it. Boundary checks verify no engine code
reaches the npm package's static import graph — keep them green on any change touching packaging, imports,
or CLI entry
paths:

```bash
npm run build
npm run boundary:engine
npm run smoke:package
```

Do not add non-open-core modules to the CLI's static import graph. When a proprietary capability is absent,
the CLI must **degrade honestly** (clear message, non-zero exit where appropriate) — never fake a result.

---

## Layout of the open-core surface

| Path | Role |
|---|---|
| `src/cli/` | Commander commands |
| `src/core/` | Deterministic product logic (ships in npm as `dist/core`) |
| `src/engine/` | The proprietary adaptive Engine (NOT open core, not in npm, not a contribution surface; reached only via a gated seam) |
| `src/examples/` | Synthetic demo traces and demos |
| `tests/` | Vitest suites |
| `evals/` | Eval registry (navigation; implementation stays in `src/`) |
| `docs/` | Documentation |

Architecture map: [`ARCHITECTURE.md`](ARCHITECTURE.md)

---

## Privacy and honesty rules (non-negotiable)

- **Local-first:** no feature may send trace content anywhere by default. Anything network-shaped needs
  explicit maintainer approval first.
- **Synthetic fixtures only:** never commit real sessions, customer data, credentials, or personally
  identifying content — including in tests, fixtures, and docs.
- **Content-free logging:** logs and reports must not leak trace content by default.
- **Honest labels:** token/cost figures are labeled by source (provider-reported vs local-estimate) and never
  overstated. Do not expand capability or savings language in user-facing output or docs — that requires
  maintainer review. Run `npm test -- tests/security/no-overclaim-first-value.test.ts` when changing
  user-facing CLI copy.
- **Recoverability:** compaction must stay deterministic and recoverable (hashes, provenance, artifacts) —
  never silently destructive.

---

## Evals

- Registry: [`evals/README.md`](evals/README.md) · gates: [`evals/gates.md`](evals/gates.md) · fixtures:
  [`evals/fixtures.md`](evals/fixtures.md)
- Add registry rows + `manifest.json` entries when adding evals; keep implementation in `src/` with tests.
- Public gates are defined content-free and reproducible from synthetic fixtures.

---

## Pull requests

- One scoped change per PR; no unrelated files.
- Include tests for behavior changes; report the exact verification commands you ran and their results.
- No placeholder implementations.
- Run `npm run preflight:push` before pushing. If a tool has left your checkout on a detached HEAD,
  a push that names a branch pushes the branch ref instead of your commits and still reports
  `Everything up-to-date` with exit 0. Optionally have git enforce it:
  `git config core.hooksPath .githooks` (opt-in; nothing is installed for you).
- Changes that need **maintainer approval before implementation**: new dependencies (especially runtime deps),
  trace schema changes, claims/capability language, packaging or publish configuration, anything touching the
  privacy guarantees or the open-core boundary above.

---

## License

The Compaction client — the CLI, the local gateway, the tool hooks, output shaping, receipts, recovery, and
the account/entitlement/usage client code — is licensed **Apache-2.0**. The Compaction Engine is proprietary,
is not part of the client, and is licensed separately. By contributing, you agree your contribution to the
client is licensed under Apache-2.0.

Releases published before this change keep the license that was attached to each of them.
