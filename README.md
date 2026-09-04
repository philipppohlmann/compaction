<div align="center">

<!-- Banner hosted on the public R2 bucket so it renders on GitHub AND the npm package page (absolute URL; source file kept at docs/assets/brand/readme-soul.png, mirror-included). -->
<img src="https://pub-cf9336d86d8140a5aaefd7412832adf7.r2.dev/brand/readme-soul.png" alt="Compaction" width="720" />

### The local optimization layer for AI coding agents.

Local token optimization, content-free receipts, and no prompt or code telemetry to Compaction.

[![npm version](https://img.shields.io/npm/v/@compaction/cli)](https://www.npmjs.com/package/@compaction/cli)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![updated August 2026](https://img.shields.io/badge/updated-August%202026-informational)

[Install](#install) · [How it works](#how-it-works) · [What you get](#what-you-get) ·
[Supported tools](#supported-tools) · [Contributing](#contributing) ·
[Privacy](#privacy-and-security)

</div>

---

Compaction connects to **Claude Code, Codex, and Cursor** and optimizes eligible model calls from your
own machine. Output shaping starts with the first eligible turn. Community adds model-visible input
compaction on supported routes.

- **Output shaping from the first eligible turn.** Compaction attaches the shipped policy before
  generation, with no account required. A numerical output estimate appears only when applicable
  empirical calibration exists; otherwise the result reports `output N/A→ACTUAL (N/A%, est.)`.
- **~48-50% less billed input on uncached API sessions**, ~5-10% on cached sessions (real gateway
  E2E, provider-reported). This runs in the adaptive engine, on the routed integrations that support
  it (see [Supported tools](#supported-tools)). Community installs the engine for you.

Observed per-run counts come from content-free receipts. Input reductions use measured model-visible
before/after states; output before-values are counterfactual estimates and appear only when applicable
empirical calibration exists.

Compaction processes request content locally and forwards it only to the provider you selected. It
does not send prompts, code, or responses to Compaction services, and it never reads, stores, or logs
your provider key.

⭐ **If Compaction saves you tokens, star the repo.**

## Install

```bash
curl -fsSL https://cli.compaction.dev/install | sh
```

Then run `compaction` for guided onboarding. The installed binary is `compaction`; sanity-check with
`compaction --version`.

The hosted installer is served as `text/plain`, and its only network call is the `npm install` of the
published package. No `sudo` by default (it installs into a user-writable prefix), no telemetry,
macOS and Linux. It fails clearly instead of faking success.

```bash
curl -fsSL https://cli.compaction.dev/install | less                 # read it first
curl -fsSL https://cli.compaction.dev/install | sh -s -- --dry-run   # preview, install nothing
```

Or use npm directly:

```bash
npm install -g @compaction/cli   # then: compaction
npx @compaction/cli init         # no global install
npx @compaction/cli --help       # no install at all
```

Local-first and file-based, with **no prompt or code telemetry**. Without an account, the only
network traffic is your own provider traffic: nothing contacts Compaction at all. With a free
account, the client also exchanges content-free records with our service (see
[Privacy](#privacy-and-security)).

## How it works

1. **Install once.** See [Install](#install), then run `compaction`.
2. **Connect your tools.** Guided onboarding detects Claude Code, Codex, and Cursor, shows exactly
   what enabling each one does, and asks for your explicit authorization before anything is installed
   or applied. You choose the optimization mode per tool, and everything is reversible:
   `compaction init --disconnect claude-code|codex|cursor` removes a connection, and
   `compaction hooks uninstall --tool <tool>` removes only Compaction's own hooks.
3. **Keep working exactly as before.** `claude`, `codex`, and Cursor run unchanged. Output shaping
   is active from the first eligible turn wherever the connected integration exposes a shaping seam.
   Live-history input compaction runs in the adaptive engine on the routed integrations that support
   it (see [Supported tools](#supported-tools)).
4. **Instrumented calls write a content-free receipt.** Token and cache counts plus structural
   labels, never your prompt, your code, or the response. Local-only, gitignored. Gateway traffic,
   Claude Code, and Codex are instrumented; Cursor shapes before generation and its turns surface at
   session level.
5. **Watch it happen.** `compaction watch` prints each turn's line the moment it lands, live, until
   you stop it. It covers anything routed through the local Gateway, so one surface covers Claude
   Code and Codex alike. `compaction watch --once` prints the last few and exits.
6. **See the rollup.** `compaction status` shows your connected tools, gateway health, receipts,
   measured reductions, and the exact next command. Share it content-free with
   `compaction api export --json`.

### Two ways to connect

**API key, through the local Gateway.** Your tool's traffic routes through a local reverse proxy on
your machine, with provider-reported token counts on every receipt. Output shaping reaches this route
through your tool's own hook, the same as on a subscription. The Gateway's own shaping and hybrid
live-history input compaction both ride the adaptive engine's apply path, which Community installs.
Your key rides straight through to your provider and is never read, stored, or logged.

**Subscription (Claude/ChatGPT plan), through native tool hooks.** No API key needed. Compaction
installs the tool's own hook and attaches the shipped shaping policy before eligible generations. On
**Claude Code** a subscription session also reaches hybrid input compaction: `claude` runs through
Compaction's transparent local route, and a verified Community
entitlement, not an API key, is what activates the apply path. This is the route we have live-proven
on a Claude Max plan.

**Current behavior.** Output shaping is on by default once a tool is connected. Kill switches:
`COMPACTION_SHAPING_HOOKS=0`, `compaction stop` (persisted, reversed by `compaction start`), or
`compaction hooks uninstall --tool <tool>`. Gateway input compaction (apply) is explicit and gated:
it runs only under an authorization you grant at onboarding, unsupported request shapes pass through
unchanged, and the original request is always retained locally, recoverable byte-for-byte with
`compaction gateway recover <id>`.

## What you get

- **Output shaping, on by default.** The shipped policy is attached before generation from the first
  eligible turn. Where per-turn classification is available, planning and reasoning turns are held;
  that turn-aware selection ships in both Open and Community. Eligibility follows the current
  validated policy; calibration changes only whether output impact can be quantified. With applicable
  empirical calibration the result may show `output ESTIMATED_BEFORE→ACTUAL (−N%, est.)`; without it
  the result shows `output N/A→ACTUAL (N/A%, est.)`. Kill switch:
  `COMPACTION_SHAPING_HOOKS=0`.
- **Hybrid input compaction on supported routes, with Community.** Live session history is compacted
  before it is re-sent: ~48-50% less billed input on uncached API sessions, ~5-10% on cached sessions
  (provider-reported). The code that produces those numbers is the adaptive engine, delivered
  separately from npm and installed when you activate Community (see
  [The Hybrid Engine](#the-hybrid-engine)). A Community account includes a per-period allowance for
  input compaction on every supported route. It pays for use of the engine, not for the billing route
  your provider traffic takes. **Output shaping is never metered**, on any route. When the allowance
  is spent, input optimization pauses, output shaping carries on, and your requests keep going
  through. `compaction usage` shows where you stand.
- **A content-free receipt for every instrumented call.** Counts and structural labels only, never
  your prompt, your code, or the response. Receipts live in `.compaction/gateway/receipts.jsonl` on
  your machine (gitignored, never uploaded). Gateway traffic, Claude Code, and Codex are
  instrumented; Cursor's hook-shaped turns are recorded at session level.
- **One rollup.** `compaction status` shows connected tools, requests observed, measured reductions,
  and the exact next command. Figures are labeled by source (provider-reported or local estimate),
  and a number is shown only at the strength the evidence supports.

### What you see, one line per turn

On an instrumented turn Compaction prints one content-free line: counts, labels, and a short receipt
id. Never your prompt, your code, or the response.

Capability decides which axes exist. Route decides whether a reduction can be priced. The three lines
below are the same real turn under three configurations, which is why they share a receipt id.

Open shapes output. The input is counted but never changed, so the input axis is a plain observed
count:

```
compaction · observed input 91,472 · output 857→463 (−46%, est.) · basic shaping · id 5f539978
```

Community adds input compaction. The input axis becomes a real before→after, the label says what ran,
and the line carries what is left of the period's optimized-input allowance:

```
compaction · input 91,472→74,769 (−18%) · output 857→463 (−46%, est.) · full apply · 1.92M/2M left · id 5f539978
```

On an **API-key route** the provider bills per token at a published rate, so that same reduction can
also be priced:

```
compaction · input 91,472→74,769 (−18%) · output 857→463 (−46%, est.) · −$0.05 (list price) · full apply · 1.92M/2M left · id 5f539978
```

Those last two are the same turn, same tier, same model, and only the route differs. A subscription
route carries no dollar clause: a plan does not bill per token, so pricing its reduction at a list
rate would be a number with no basis.

Community runs on a subscription route as readily as on an API key, live-proven on Claude Code with a
Claude Max plan. An API-key route without Community prints the Open line, dollars or not.

The input arrow is the only unlabeled `−PP%` on the line, because both of its endpoints were
measured. The output side has no per-turn counterfactual — the unshaped twin of that exact generation
was never produced — so its reduction is always labeled an estimate. `est.` means the unshaped output
and the saving derived from it are **inferred from applicable empirical calibration**, not observed
for that generation. The actual output count beside it is always observed.

Where no calibration applies to a turn, nothing is inferred and the axis says so:

```
compaction · observed input 91,472 · output N/A→463 (N/A%, est.) · basic shaping · id 5f539978
```

Shaping still ran on that turn — `basic shaping` says so — and `463` is the provider's own count. What
is absent is any applicable calibration for what shaping removed, and the `N/A` is that absence stated
rather than filled in. Compaction ships a starting rate for its own internal estimates, and
deliberately does not spend it here: a percentage with no empirical basis behind it is not put on
your turn.

An axis that is not available says `N/A` rather than being faked or quietly dropped. There is no
fabricated `−$0`, and no percentage on an axis that was not measured.

`compaction watch` (live) and `compaction watch --once` (the last few turns) show the line for every
instrumented turn, whichever tool produced it. It also renders inline on the Claude Code status line
and in the Gateway's own log, and Compaction emits it through Codex's post-turn hook. Cursor has a
post-turn hook but no channel to display through: its `stop` response schema carries only a follow-up
prompt, not a message. Cursor's numbers surface in `compaction watch` and `compaction status`
instead. Silence the line with `COMPACTION_RECEIPT_LINE=0`; receipts are still written either way.

### What a receipt looks like

*Illustrative receipt. Synthetic values in the real receipt schema, showing an account-enabled
gateway call where the hybrid compacted a long session's history before forwarding. The before/after
model-visible reduction is a local estimate; the `tokens` block is read from the provider's own usage
metadata. Your numbers come from your own runs.*

```json
{
  "receipt_id": "8f4c2f6e-9d1a-4b7e-a301-5c2e9b7d4f10",
  "captured_at": "2026-07-27T09:14:31.402Z",
  "provider": "anthropic",
  "endpoint": "/v1/messages",
  "mode": "apply",
  "request_mutated": true,
  "response_mutated": false,
  "estimated_input_tokens_before": 41210,
  "estimated_input_tokens_after": 21876,
  "estimated_model_visible_input_reduction_percent": 46.9,
  "token_source_before": "local-estimate",
  "token_source_after": "provider-reported",
  "tokens": { "prompt_input": 22012, "output": 412 },
  "applied_components": ["lcm-compaction", "output-shaping"],
  "recovery_id": "8f4c2f6e",
  "content_uploaded": false
}
```

The original request behind every mutated call is retained locally and restored byte-for-byte with
`compaction gateway recover <id>`. Without the engine the same request is forwarded **unchanged**,
and the receipt records that honestly: `request_mutated: false`, with the reason. Compaction never
describes a pass-through as an apply.

## Supported tools

| Tool | Route | Output shaping | Input optimization | Token counts |
|---|---|---|---|---|
| **Claude Code** | transparent local route (subscription or API key) | eligible per-prompt turns; planning/reasoning held | Community, on both routes, live-proven on a Claude Max subscription | provider-reported |
| **Codex** | native hook (subscription) or gateway (API key) | eligible per-prompt turns; planning/reasoning held | Community, on the API-key gateway route | provider-reported |
| **Cursor** | session-level instruction | session-level shaping; no per-turn selection | not available (the tool exposes no per-call route) | local estimate |

Input optimization is metered against your Community allowance wherever it runs, on any supported
route. Output shaping is never metered.

Also supported for measurement: OpenAI Agents SDK capture and offline trace import
(`compaction capture`, `compaction import`). Captured traces can contain local file content, so
review a trace before sharing one.

## The Hybrid Engine

The adaptive engine performs input optimization. It is delivered separately from npm: **nothing below
is in this package**. Activating Community installs the signed release, and the client verifies its
signature against a trust root compiled into this package before it will run it. The input side is a
hybrid: deterministic protection first, an adaptive model second.

- **Deterministic protection keeps the load-bearing content byte-exact.** Code blocks, commands, file
  paths, flags, and `file:line` references are extracted and locked verbatim before anything else
  runs. They are never summarized or paraphrased.
- **The adaptive step summarizes only obsolete history.** Old tool output, superseded discussion, and
  dead ends are compressed; the current task state is preserved.
- **It runs on your device.** The model is provisioned locally. No cloud model, and no traffic
  through a hosted middleman.
- **The original is always retained.** Every compacted request is recoverable byte-for-byte, so
  compaction is never destructive.
- **Quality is eval-gated.** Compaction and shaping ship behind evals that hold response quality;
  effects are task-dependent and always measured on your own receipts.

## Open and Community

**Open** is this repository, and it needs no account. The Apache-2.0 CLI and core: the CLI, the local
Gateway, the native tool hooks for all three tools, output shaping, content-free receipts, the apply
gates, and byte-exact recovery. All of it runs on your machine.

**Community** is a free account, and it adds the input side. Activating it registers this device and
installs the signed Hybrid Engine for you. Set it up from the CLI:

```bash
compaction login      # free Community account, 1 device
compaction mode full  # adaptive input optimization + output shaping
```

## Commands

```bash
compaction                                       # guided onboarding: detect tools, connect, authorize
compaction init                                  # the same onboarding, explicitly
compaction status                                # connected tools, gateway health, receipts rollup, next commands
compaction watch                                 # live per-turn receipt lines, any tool through the Gateway
compaction watch --once                          # the last few lines, then exit
compaction mode                                  # show or set the optimization mode for this device
compaction stop / compaction start               # turn Compaction off / back on (persisted, reversible)

# Community:
compaction login                                 # connect this device to a free Community account
compaction usage                                 # this device's optimized-input allowance for the period
compaction engine status                         # the installed engine and its verified state
compaction devices                               # list or revoke registered devices
compaction logout                                # revoke this device and delete local credentials

# Native hooks (subscription path):
compaction hooks install --tool codex            # native output-shaping hook (default-on; kill switch: COMPACTION_SHAPING_HOOKS=0)
compaction hooks install --tool cursor           # session-level shaping for Cursor
compaction hooks status                          # content-free usage rollup from hook records
compaction hooks uninstall --tool <tool>         # remove ONLY Compaction's hooks

# Gateway (API-key path):
compaction gateway start                         # start the local gateway
compaction gateway run -- codex exec --json "…"  # route a Codex run through the gateway
compaction gateway run --provider anthropic -- claude   # route Claude Code through the gateway
compaction gateway status                        # requests observed + content-free receipts rollup
compaction gateway verify-cache --provider <id>  # live provider-reported cache check (needs YOUR key)
compaction gateway recover <recovery_id>         # byte-exact restore of an original request
compaction gateway stop                          # stop a running local gateway

# Local trace utilities:
compaction capture claude-code --session <session.jsonl> --out <dir>
compaction import <trace-file> --source <source> --out <dir>
compaction analyze <trace-file>                  # tokens + estimated spend, labeled by source
compaction context add <artifact>                # local memory from your own captured traces
compaction api export --json                     # ONE content-free JSON doc; local-only, no upload
```

`compaction --help` lists everything. Commands that need the adaptive engine say so plainly and exit
without doing anything when it is not installed. They never pretend to have optimized.

## Privacy and security

- **Your content is never sent to Compaction services.** Compaction processes request content locally
  and forwards it only to the provider you selected. Prompts, code, and responses are never uploaded
  to Compaction services. Receipts record token and cache counts and structural labels only, and stay
  on your machine (gitignored).
- **Without an account, nothing contacts Compaction.** No telemetry, no check-in, no network call of
  our own. The only traffic is your provider traffic going where it was already going.
- **With a free account, four things talk to our service, all content free.** Activating a device,
  getting the entitlement that unlocks the fuller optimization, syncing usage counts, and looking up
  or downloading the engine release. What crosses is counts, identifiers, and status labels. There is
  no field in any of them that can carry a prompt, a completion, or a line of your code.
- **Your key never leaves your machine.** On the gateway route your provider key rides straight
  through to your provider and is never read, stored, or logged.
- **The gateway has exactly one destination: your provider.** Your traffic goes where it was already
  going. The four account exchanges above are separate, explicit, and content-free; they never carry
  a request.
- **Nothing is destructive.** Every mutated request retains its original locally (restrictive
  permissions) for byte-exact recovery; hooks are merge-not-replace, idempotent, and removable with
  one command.
- **You can read the code.** The privacy and local-only claims above are verifiable in this
  repository rather than taken on trust.
- **Captured traces can contain local content.** Capturing a session may include local file content,
  so review a trace before sharing. `compaction feedback --redact` produces a redacted, local-only
  bundle (explicit `--yes` required, no upload path).
- **No `sudo` by default** in the installer; it installs into a user-writable prefix.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and please read our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Methodology

Observed token counts are labeled by source: provider-reported counts come from provider usage
metadata; local token estimates and costs derived from price tables are labeled as estimates. An
output saving on a user run is a counterfactual estimate derived only from applicable empirical
calibration, never an observed twin generation; without applicable calibration it remains `N/A`.
Effects are provider-, model-, policy-, and task-dependent.

## License

Licensed under the [Apache License 2.0](LICENSE).
