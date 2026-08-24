# Compaction Hosted API — v0 contract (LOCAL-ENGINE DEV; not hosted)

**Status:** `v0` — LOCAL-ENGINE DEV (open-core Phase 2). The endpoints below
describe the *shape* of a future hosted API. The local server in `apps/api/`
validates request bodies against these schemas and now runs the compaction/eval
**engine server-side, locally** for `/v0/optimize` and `/v0/evaluate`, and the
PUBLIC aggregator for `/v0/reports`. This document remains the typed boundary a
future backend would satisfy — it is **not** evidence that a hosted service
exists. The engine runs server-side ONLY inside `apps/api` (a separate package);
the public `@compaction/cli` package still ships ZERO engine.

**What this is NOT (read first):**

- NOT a running hosted service. There is no deployment, no public endpoint, no
  hosting from this repo. The default server is local-only (`127.0.0.1`), makes
  no outbound network call, and logs no request content. Hosted MODE exists in
  the code (fail-closed API-key auth, Cloud Run-shaped) but deploying it is a
  separate, deliberate step that this repository does not take.
- NOT a full production backend. No billing, no raw-trace retention (the only
  persistence is the content-free ingested-export store described below).
- NOT a savings claim. No figure returned by these endpoints is a real, realized,
  or billing-confirmed saving. Token deltas are `local-estimate` (chars/4); cost
  deltas are `token-estimated cost` (price-table estimate), never billing-confirmed
  and never extrapolated to any time period.
- NOT a semantic guarantee / model replay. `/v0/evaluate` returns DETERMINISTIC
  recoverability verdicts only; semantic preservation stays `not_evaluated` and
  TRUE model replay stays `future`.
- NOT a change to the CLI. The local-first CLI (`@compaction/cli`) is unchanged
  and remains the product's first-value surface. This API is a separate
  **local-dev** package for a *future* hosted track, and production/hosted use is
  out of scope for this repository.

Evidence labels are governed by the ladder in "Evidence labels used in this
contract" below, which matches the README's Methodology section. That precedence
covers how figures are labeled and nothing else: it does not settle what this
package ships, what runs where, or what any endpoint is permitted to do. Those
are fixed by the statements above and by the code, not by prose elsewhere.

---

## Versioning and base path

- All endpoints are under `/v0`.
- `v0` is explicitly a **contract** version. Field names and shapes may change
  before any real backend ships; a real backend would pin a stable version.

## Evidence labels used in this contract

These mirror the ladder described in the README Methodology section. The API never invents a stronger label
than the data supports.

| Label | Meaning |
|---|---|
| `local-estimate` | token counts or cost estimated locally (e.g. `chars/4` + price table). NOT provider-reported, NOT billing-confirmed. |
| `provider-reported` | token counts read from the provider's own usage metadata. Deterministic for a fixed context+prompt. NOT billing-confirmed. |
| `token-estimated-cost` | a price-table estimate applied to token counts. An estimate, never a billed figure. |
| `billing-confirmed` | reserved; requires real provider billing evidence AND the README measurement criterion (N ≥ 3 runs per arm AND delta-of-means ±2·SE excludes zero). **No response in v0 may carry this label.** |
| `unknown` | the data does not carry the value; the field stays `unknown` and is never inferred. |

Recoverability / readiness results returned by `/v0/evaluate` are **deterministic
recoverability** outcomes (source pointers, content hashes, state capsules,
commitment preservation, fixture-based replay where supported) — **NOT** semantic
or meaning-preservation guarantees. `ready` / `conditional` / `not_ready` is a
scoped, fail-closed verdict, never a universal "no context is lost" claim.

## Security and privacy posture (v0)

- **No raw trace upload by default.** A request carries a redacted-or-permitted
  trace only. The default expectation is that the caller has redacted or has
  explicit local consent to send the payload.
- **Explicit user consent for uploads.** Any upload of trace content is opt-in
  and operator-asserted. The contract carries a `consent` block the caller must
  set; the server does not transmit anything anywhere (local-only, no network
  egress).
- **Payload classes.** Requests declare (or are inferred to) one of
  `metrics_only` / `redacted_structure` / `sanitized_snippets` / `full_trace`.
  `metrics_only` and `redacted_structure` are accepted without raw-content consent;
  `sanitized_snippets` and `full_trace` REQUIRE `consent.upload_permitted: true`
  and are otherwise rejected `400` with a `consent_required` detail. Fail closed.
- **Redacted-bundle support.** Callers may send a redacted bundle (content
  removed, structure/metadata/labels retained). The schema accepts a
  `redacted: true` bundle without raw content.
- **No content logging.** The server logs no request body, no query string, and no
  trace content — only content-free lifecycle lines plus ONE structured content-free
  JSON request line per response (`method`, query-stripped `path`, `status`,
  `duration_ms`, `env`, generated `request_id`, `auth_result` — never a key or body).
- **No trace-content persistence.** Optimize/evaluate/reports persist nothing and return
  no compacted trace body. The ONLY persisted objects are projected, content-free dashboard
  evidence records (`POST /v0/ingest/export`, below), which are validated, deep-scanned, and
  fail-closed REJECTED if they carry any content-shaped field — there is no consent
  path on that endpoint; content is refused, never stored.
- **Payload size limits.** Requests above a configured byte limit are rejected
  with `413`-style `payload_too_large` (the scaffold enforces a small local
  limit; a real backend would set production limits).
- **Auth (hosted mode).** LOCAL mode (default) has no auth. HOSTED mode
  (`COMPACTION_API_MODE=hosted`) requires an API key on EVERY route except
  `/healthz`, checked constant-time and fail-closed BEFORE any body parse. The key
  may be presented as `X-Compaction-Api-Key`, `X-Api-Key`, or
  `Authorization: Bearer` (all equivalent; the custom headers compose with Cloud
  Run IAM, which occupies `Authorization`). Deploy itself is out of scope here.
- **CORS: default deny.** Cross-origin responses carry CORS headers only for an
  origin exactly on the `COMPACTION_API_CORS_ORIGINS` allowlist (hosted mode) or a
  loopback origin (local mode). Never `*`, never credentials.
- **No telemetry without opt-in.** The scaffold emits no telemetry and makes no
  outbound calls. A real backend would gate any telemetry behind explicit opt-in.
- **Retention policy = future / legal-dependent.** The optional JSON-file driver retains only the latest
  projected evidence record per workspace until an operator removes it. Any production retention policy
  remains undecided and legal-dependent.

---

## Endpoints

All payload-bearing requests may declare a `payload_class`:
`"metrics_only" \| "redacted_structure" \| "sanitized_snippets" \| "full_trace"`.
`sanitized_snippets` and `full_trace` REQUIRE `consent.upload_permitted: true`;
otherwise the request is rejected `400 { error: "validation_error" }` with a
`consent_required` detail. `metrics_only` / `redacted_structure` are accepted
without upload consent.

### `POST /v0/optimize`

Request a compaction/optimization of a trace. **Engine-backed (local dev):** when
an inline trace body is present and consent passes, the server runs the compaction
policy server-side and returns labeled deltas; otherwise it returns `not_ready`.
The API never applies and never returns the compacted trace body.

**Request**

| Field | Type | Notes |
|---|---|---|
| `trace` | object | redacted-or-permitted trace. `{ redacted: boolean, content?: object, reference?: string }`. Inline `content` is parsed by the PUBLIC trace parser; a `reference` is never fetched. |
| `consent` | object | `{ upload_permitted: boolean, redacted: boolean }`. Required. |
| `payload_class` | enum | optional; drives consent enforcement (see above). |
| `provider_metadata` | object | `{ provider?: string, runtime?: string }`. Strings only; unknown stays unset. |
| `token_usage` | object | `{ input_tokens?: number, output_tokens?: number, source: "provider-reported" \| "local-estimate" \| "unknown" }`. `source` is required and honest. |
| `evidence_labels` | object | local evidence labels the caller has already computed. Passed through, not re-derived server-side. |
| `labels` | object | `{ project?: string, session?: string }` free-form local labels. |
| `optimization_mode` | enum | `"recommend" \| "compact" \| "apply-ready"`. Requested mode. The API never applies. |

**Response**

| Field | Type | Notes |
|---|---|---|
| `status` | enum | `"optimized"` (engine ran) or `"not_ready"` (no inline trace body to optimize). |
| `optimization_id` | string | assigned id (opaque, not persisted). |
| `compacted_context` | null | always `null` — the API does not echo the compacted trace body back. |
| `reference` | null | reserved. |
| `token_delta` | object\|null | `{ before, after, saved, percent, source: "local-estimate" }`. chars/4 estimate; never `provider-reported` for an estimate. `null` on `not_ready`. |
| `estimated_cost_delta` | object\|null | `{ before, after, saved, currency: "USD", label: "token-estimated-cost" }`. price-table estimate, **never** billing-confirmed, **never** extrapolated. `null` on `not_ready`. |
| `evidence_status` | enum | `"not_evaluated"` — optimize does not run the eval; call `/v0/evaluate`. |
| `apply_recommendation` | enum | `"review_required"` (engine ran) or `"not_recommended"` (`not_ready`). Never `apply`. |
| `warnings` | string[] | always includes the local-estimate + no-content-echo caveats. |

### `POST /v0/evaluate`

Evaluate whether a compacted context is recoverable / commitment-preserving /
task-faithful relative to an original. **Engine-backed (local dev):** runs the
deterministic strong eval server-side. Fail-closed.

**Request**

| Field | Type | Notes |
|---|---|---|
| `original_trace` | object | original-or-redacted/permitted trace (same `{ redacted, content?, reference? }` shape). Inline `content` is parsed and evaluated. |
| `compacted_context` | object | the compacted context to check (`{ content?, reference? }`). |
| `consent` | object | `{ upload_permitted, redacted }`. Required. |
| `payload_class` | enum | optional; drives consent enforcement. |
| `evidence_requirements` | object | `{ require_recoverability?, require_commitment_preservation?, require_task_replay? }`. What the caller wants checked. |

**Response**

| Field | Type | Notes |
|---|---|---|
| `status` | enum | `"evaluated"` (engine ran) or `"not_ready"` (no inline original trace body). |
| `recoverability_result` | enum | `passed` / `failed` / `not_computed` / `not_evaluated`. DETERMINISTIC byte/hash/source-pointer recoverability, NOT semantic. |
| `commitment_preservation_result` | enum | DETERMINISTIC recoverability of task-critical commitments, NOT semantic. |
| `task_replay_result` | enum | always `"future"`. TRUE model replay is NOT implemented and never faked. |
| `task_check_result` | enum | FIXTURE-based task-check (where supported), NOT model replay. Distinct from `task_replay_result`. |
| `readiness` | enum | `ready` / `conditional` / `not_ready`. Scoped, fail-closed apply-readiness — never a universal "no context is lost" claim. |
| `per_axis` | array | per-axis `{ axis, status, reason }` outcome descriptions. |
| `scope_note` | string | the verbatim non-overclaim scope statement. |
| `reasons` | string[] | always includes the recoverability/semantic-scope caveat. |

### `POST /v0/reports`

Accept a local report / share bundle for normalized aggregation. **Backed by the
PUBLIC aggregator (no engine, no disk):** validates each submitted run and
aggregates the valid ones in memory.

**Request**

| Field | Type | Notes |
|---|---|---|
| `report_bundle` | object | `{ runs?: array, summary?: object, redacted: boolean }`. Each run is judged by the PUBLIC `validateCompactionReport`. |
| `labels` | object | `{ team?: string, project?: string }` optional local labels. |
| `consent` | object | `{ upload_permitted, redacted }`. Required. |
| `payload_class` | enum | optional; drives consent enforcement. |

**Response**

| Field | Type | Notes |
|---|---|---|
| `status` | enum | `"aggregated"` (≥1 valid run) or `"accepted_no_valid_runs"`. |
| `report_id` | string | assigned id (opaque, not persisted). |
| `normalized_summary` | object | `{ run_count, total_original_input_tokens, total_compacted_input_tokens, total_tokens_saved, total_estimated_cost_before/after/saved, average_percent_reduction }`. Sums over SUBMITTED runs only, at the caller's labels. No label upgrade, no synthesized savings, no time-period extrapolation. Cost is a price-table estimate, never billing-confirmed. |
| `skipped_runs` | array | `{ index, reason }` for runs that failed validation. |
| `warnings` | string[] | includes the sums-only / never-extrapolated / in-memory-only caveats. |

### `POST /v0/ingest/export`

Ingest ONE content-free export document for dashboard use (key-gated in hosted
mode). Accepts exactly two payload shapes, both `schema_version: "2"`:

- a v2 `ApiExportDocument` (the local `compaction api export` output), or
- a v2 dashboard contract (the `toDashboardContract` output).

**Fail-closed validation:** strict structural schema (unknown top-level keys
rejected) + a DEEP key/value scan over the whole tree. The scan rejects any
content-shaped key (`prompt` / `response` / `messages` / `content` / `choices` /
`api_key` / `authorization`, normalized), any `input` key carrying a string body,
any credential-looking `sk-…` value, and — billing boundary — any `invoice*` key
or `invoice-confirmed` / `invoice-reconciled` label value. Rejections are
`400 { error: "content_rejected" | "billing_boundary_rejected", path }` naming
only the KEY PATH (never a value). **There is no consent path here:** content is
refused outright, never stored.

**Storage:** the server stores a canonical evidence projection, latest-per-workspace
(per-customer account in the control-plane strategy, else one shared workspace). Caller-authored
narrative strings are discarded; display labels and the ingestion note are generated server-side.
Route A (`plan_lifetime`) and Route B (`api-billing` proof scopes /
`verifications`) records are never merged or relabeled. Drivers: in-memory
(default) or JSON-file (`COMPACTION_API_STORE_DIR`, 0700 dir / 0600 files).
Firestore is the intended Cloud Run production driver — NOT implemented.

**Response:** `200 { status: "ingested", kind, workspace_id, ingested_at,
ingest_count, store, note }` — all content-free.

### `GET /v0/dashboard-contract`

The dashboard-ready aggregate from the LATEST ingested export (key-gated in
hosted mode). An ingested `api-export` document is adapted through the repo-root
`toDashboardContract` — the SAME function the CLI uses, so the hosted answer can
reuse the CLI's label mapping; both accepted shapes are projected to the same stored evidence form.
No label is upgraded and `invoice-confirmed` is never emitted (the ingest
gate refuses any document claiming it).

**Response:** `200 { source: "ingested-export", status: "ok" | "empty",
contract_version, generated_at, contract, … }` — `status: "empty"` with
`contract: null` and an honest note when nothing has been ingested.

### `GET /healthz`

Unauthenticated liveness probe (Cloud Run-shaped). No body is read; response is
`200 { ok: true, env }` — content-free.

### `GET /v0/status`

Health / status. **Real.**

**Response**

| Field | Type | Notes |
|---|---|---|
| `status` | string | `"ok"`. |
| `service` | string | `"compaction-api"`. |
| `version` | string | `"v0"`. |
| `mode` | string | `"local-engine-dev"` (default local dev) or `"hosted"` (auth-gated hosted mode). Describes THIS process's serving mode — NOT a claim that a deployed service exists. |
| `engine` | string | `"local-engine"` — the engine runs server-side inside this process (Phase 2). |
| `hosted` | boolean | `true` only when the process runs in hosted (auth-gated) mode. Not a deployment claim. |
| `env` | string | `"local"` / `"staging"` / `"prod"` — the `COMPACTION_API_ENV` label. Descriptive only. |
| `uptime_seconds` | number | process uptime. |

---

## Error shape

All endpoints return a consistent error body:

```json
{ "error": "validation_error" | "payload_too_large" | "not_found" | "method_not_allowed" | "optimization_failed" | "evaluation_failed" | "internal_error" | "unauthorized" | "rate_limited" | "forbidden" | "auth_unavailable" | "cors_forbidden" | "content_rejected" | "billing_boundary_rejected", "details": [ ... ] }
```

- Invalid request bodies return `400` with `error: "validation_error"` and zod
  issue details (consent failures carry a `consent_required` detail message).
- Oversized payloads return `413` with `error: "payload_too_large"`.
- Unknown routes return `404`; wrong methods return `405`.
- An engine throw is caught and returned as `500` with a clean coded error
  (`optimization_failed` / `evaluation_failed` / `internal_error`) — **never** an
  engine stack trace or proprietary internal.

## Relationship to the CLI and the production/hosting gate

- The CLI (`@compaction/cli`) is the product's local-first first-value surface and
  is unchanged by this work. It still ships ZERO engine code.
- `apps/api/` is a **separate, local-dev** package (open-core Phase 2) that runs
  the engine server-side LOCALLY behind this contract. It is excluded from the CLI
  package and from the root `npm run verify`.
- **Hosting / deploy / production backend** (real database, auth, public endpoint,
  real-trace retention, billing) is **out of scope for this contract**: nothing in
  this repository deploys or configures one.
