# Contributing to Compaction

Thanks for helping make Compaction better.

PRs are welcome across the public CLI, integrations, output shaping, receipts, developer experience,
docs, tests, A/B harnesses, and local-first tooling.

**Compaction** is the local optimization layer for AI coding agents. It connects to Claude Code,
Codex, and Cursor and optimizes model calls from your own machine: **output shaping** before
generation via the tools' native hooks and the local gateway, a **content-free receipt** for every
instrumented call, and byte-exact recovery. The signed adaptive engine that performs live-history
input compaction is delivered separately and is not part of the public contribution surface. The CLI
processes request content locally: no prompt, code, or trace content is sent to Compaction services.
With a free account the client exchanges content-free device, entitlement, usage, and engine-release
records with our service.

---

## Where contributions are welcome

The public contribution surface includes:

- **CLI** (`src/cli/`) — command ergonomics, honest reporting output, clearer errors and exit paths.
- **Core** (`src/core/`) — trace parsing, waste detection, token/cost estimation, output shaping,
  content-free records, and recovery contracts.
- **Integrations and adapters** — local capture/import for agent tools (Claude Code, Codex, Cursor,
  OpenAI Agents): new adapters, format fixes, better degrade behavior when a tool exposes less data.
- **Output shaping** — the deterministic instruction family applied before generation. This is the
  area with the widest effect: output is the larger share of a typical bill. Better wording, better
  structure, better coverage of request shapes — all of it helps everyone who installs this, and it
  is readable and testable.
- **Local gateway** — the transparent local route: routing, resilience, diagnostics, ergonomics.
- **Receipts and reporting** — the `.compaction/` artifact writers, report generators, and summaries
  (all local, content-free by default).
- **Examples** (`src/examples/`) — synthetic demo traces and runnable demos.
- **Docs** — user-facing documentation, honest capability descriptions, setup guides.
- **Synthetic fixtures** — deterministic test fixtures for adapters, policies, and evals. **Never
  real sessions — synthetic only** (see privacy rules below).
- **Public eval harnesses** — the A/B implementations and tests under `src/core/` and `tests/core/`,
  plus the registry, gate definitions, and synthetic fixture catalog under `evals/`. Engine-backed
  validation is delivered separately.
- **Privacy / local-first improvements** — anything that strengthens the local-first posture:
  content-free logging, redaction, consent flows, provenance, recoverability.
- **Developer experience** — setup, scripts, test speed, error messages, anything that makes this
  repository nicer to work in.

Not sure where something fits? Open an issue describing the problem — that is always a good start.

---

## Prerequisites

- Node.js ≥ 20 for the contributor toolchain and test suite (the published CLI runtime supports Node.js ≥ 18)
- npm (use `npm ci`, not `npm install`, for reproducible deps)

---

## Setup and verify

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run boundary:engine
npm run smoke:package
npm run analyze:demo
```

---

## Packaging boundary (critical)

The published npm package ships `dist/cli` + `dist/core`, minus the modules the `files` list excludes
by name. Some adaptive capabilities are not in the npm package; the runtime reaches them at runtime
only through a lazy, gated seam that **fails open when they are absent**, so the client builds,
ships, and runs without them. Boundary checks verify that nothing outside the packaged surface
reaches the npm package's static import graph — keep them green on any change touching packaging,
imports, or CLI entry paths:

```bash
npm run build
npm run boundary:engine
npm run smoke:package
```

Do not add unpackaged modules to the CLI's static import graph. When an optional capability is
absent, the CLI must **degrade honestly** (clear message, non-zero exit where appropriate) — never
fake a result.

---

## Layout

| Path | Role |
|---|---|
| `src/cli/` | Commander commands |
| `src/core/` | Deterministic product logic (ships in npm as `dist/core`) |
| `src/examples/` | Synthetic demo traces and demos |
| `tests/` | Vitest suites |
| `evals/` | Public eval registry, gate definitions, and synthetic fixture catalog |
| `scripts/` | Build, boundary, and packaging checks |
| `docs/` | Documentation |

---

## Privacy and honesty rules (non-negotiable)

- **Local-first:** no feature may send trace content anywhere by default. Anything network-shaped
  needs explicit maintainer approval first.
- **Synthetic fixtures only:** never commit real sessions, customer data, credentials, or personally
  identifying content — including in tests, fixtures, and docs.
- **Content-free logging:** logs and reports must not leak trace content by default.
- **Honest labels:** token/cost figures are labeled by source (provider-reported vs local-estimate)
  and never overstated. Do not expand capability or savings language in user-facing output or docs —
  that requires maintainer review. Run `npm test -- tests/security/open-basic-engine-free.test.ts
  tests/cli/watch-tier-label-provenance.test.ts` when changing user-facing CLI copy.
- **Recoverability:** compaction must stay deterministic and recoverable (hashes, provenance,
  artifacts) — never silently destructive.

---

## Evals

- Registry: [`evals/README.md`](evals/README.md) · gates: [`evals/gates.md`](evals/gates.md) ·
  fixtures: [`evals/fixtures.md`](evals/fixtures.md)
- Add registry rows and `manifest.json` entries for public evals, and keep every referenced path valid
  in the public tree.
- Public A/B harnesses live in `src/core/` with tests. Synthetic fixtures are public; engine-backed
  evaluators and their release gates are delivered separately.

---

## Pull requests

- One scoped change per PR; no unrelated files.
- Include tests for behavior changes; report the exact verification commands you ran and their
  results.
- No placeholder implementations.
- Run `npm run preflight:push` before pushing. If a tool has left your checkout on a detached HEAD,
  a push that names a branch pushes the branch ref instead of your commits and still reports
  `Everything up-to-date` with exit 0.
- Changes that need **maintainer approval before implementation**: new dependencies (especially
  runtime deps), trace schema changes, claims/capability language, packaging or publish
  configuration, and anything touching the privacy guarantees or the packaging boundary above.

Please also read our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## License

The code in this repository is licensed under **Apache-2.0**. By contributing, you agree that your
contribution is licensed under Apache-2.0.
