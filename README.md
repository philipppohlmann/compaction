<div align="center">

<!-- Banner hosted on the public R2 bucket so it renders on GitHub AND the npm package page (absolute URL; source file kept at docs/assets/brand/readme-soul.png, mirror-included). -->
<img src="https://pub-cf9336d86d8140a5aaefd7412832adf7.r2.dev/brand/readme-soul.png" alt="Compaction" width="720" />

### The local optimization layer for AI coding agents.

Fewer tokens, longer sessions, and your code never leaves your machine.

[![npm version](https://img.shields.io/npm/v/@compaction/cli)](https://www.npmjs.com/package/@compaction/cli)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![updated August 2026](https://img.shields.io/badge/updated-August%202026-informational)

[Install](#install) · [How it works](#how-it-works) · [What you get](#what-you-get) ·
[The Hybrid Engine](#the-hybrid-engine) · [Supported tools](#supported-tools) ·
[Open and Community](#open-and-community) · [Privacy](#privacy-and-security)

</div>

---

Compaction connects to **Claude Code, Codex, and Cursor** and optimizes model calls from your own
machine. The responses your agent gets back are shortened on every path. Optimizing the context it
sends up is the other half, and it comes with a free Community account.

- **Up to ~50-70% fewer output tokens on coding tasks.** Measured on real sessions,
  provider-reported, with quality held (eval-gated, task-dependent). This is what you get on
  install, with no account.
- **~48-50% less billed input on uncached API sessions** (real gateway E2E, provider-reported),
  and **~5-10% on cached sessions**. This is the input side. It runs on the API-key gateway route
  in the adaptive engine, which Community installs for you.
- **Longer usable sessions.** Shorter responses everywhere, and compacted history where it runs,
  mean the context window and the plan window go further.

Every number here is a real token count from a real run, not a projection. Every call you route
through the Gateway writes a content-free receipt, so the figures you act on are always your own.

Everything that touches your code runs on your machine. Your provider key never leaves it, and your
prompts, your code, and the responses are never uploaded.

⭐ **If Compaction saves you tokens, star the repo.** It is the only thing we ask for, and it is how
other people find it.

## Install

Local-first, file-based. **No prompt or code telemetry.** Without an account, the only network traffic is your own
provider traffic: nothing contacts Compaction at all. With a free account, the client also exchanges
content-free records with our service (see [Privacy](#privacy-and-security)).

```bash
npm install -g @compaction/cli   # then: compaction
npx @compaction/cli init         # no global install
npx @compaction/cli --help       # no install at all
```

The installed binary is `compaction`. Sanity-check with `compaction --version`, then run
`compaction` (no args) for guided onboarding.

**curl one-liner.** The hosted installer at `https://cli.compaction.dev/install` is served as
`text/plain`, and its only network call is the `npm install` of the published package. No `sudo` by
default (user-writable prefix), no telemetry, macOS and Linux, and it **fails clearly** rather than
faking success. Read it first, then run it:

```bash
curl -fsSL https://cli.compaction.dev/install | less           # inspect first (recommended)
curl -fsSL https://cli.compaction.dev/install | sh             # install
curl -fsSL https://cli.compaction.dev/install | sh -s -- --dry-run   # preview, install nothing
```

## How it works

1. **Install once.** `curl -fsSL https://cli.compaction.dev/install | sh`, then `compaction`
   (npm/npx alternatives are in [Install](#install)).
2. **Connect your tools.** Guided onboarding detects Claude Code, Codex, and Cursor, shows exactly
   what enabling each one does, and asks for your explicit authorization before anything is
   installed or applied. You choose the optimization mode per tool, and everything is reversible
   (`compaction init --disconnect claude-code|codex|cursor` removes the connection;
   `compaction hooks uninstall --tool <tool>` removes only Compaction's own hooks).
3. **Keep working exactly as before.** `claude`, `codex`, and Cursor run unchanged. Compaction
   optimizes underneath: output shaping before generation, on every path. Live-history input
   compaction on the API-key gateway route runs in the adaptive engine, which Community installs.
4. **Instrumented calls write a content-free receipt.** Token and cache counts plus structural
   labels, never your prompt, your code, or the response. Local-only, gitignored. Gateway traffic and
   Claude Code and Codex (both of which have a post-turn hook) are instrumented; Cursor shapes before
   generation and its turns surface at session level.
5. **Watch it happen.** `compaction watch` prints each turn's line the moment it lands, live, until
   you stop it. It works for anything routed through the local Gateway, so it is the one live
   surface that covers Claude Code and Codex alike. `compaction watch --once` prints the last few
   and exits.
6. **See the rollup.** `compaction status` shows your connected tools, gateway health, receipts,
   measured reductions, and the exact next command. Share it content-free with
   `compaction api export --json`.

### Two ways to connect

- **API key → the local Gateway.** Your tool's traffic routes through a local reverse proxy on your
  machine, with provider-reported token counts on every receipt. Output shaping reaches this route
  through your tool's own hook, the same as on a subscription; the Gateway's own shaping rides the
  adaptive engine's apply path, as does hybrid live-history input compaction — both need the engine,
  which Community installs. Your key rides straight through to your provider and is never read, stored, or logged.
- **Subscription (Claude/ChatGPT plan) → native tool hooks → output shaping + headroom.** No API key
  needed. Compaction installs the tool's own hook and shapes responses before generation, for
  shorter outputs and more useful work per plan window.

**Current behavior.** Output shaping is on by default once a tool is connected. Kill switches:
`COMPACTION_SHAPING_HOOKS=0`, `compaction stop` (persisted, reversed by `compaction start`), or
remove the hook with `compaction hooks uninstall --tool <tool>`. Gateway input compaction (apply) is
explicit and gated. It runs only under an authorization you grant at onboarding, unsupported request
shapes pass through unchanged, and the original request is always retained locally, recoverable
byte-for-byte with `compaction gateway recover <id>`.

## What you get

- **Output shaping, on by default.** Instructions injected before generation produce shorter
  responses on coding tasks, and quality is eval-gated. Measured effect: up to ~50-70% fewer output
  tokens, task-dependent. The instruction goes on every turn. Turn-aware selection — holding
  planning and reasoning turns, where prose is doing real work — belongs to the adaptive engine on
  the gateway route, so it needs Community. Kill switch: `COMPACTION_SHAPING_HOOKS=0`.
- **Hybrid input compaction on the gateway route — with Community.** Live session history is
  compacted before it is re-sent: ~48-50% less billed input on uncached API sessions, ~5-10% on
  cached sessions (provider-reported). The code that produces those numbers is the adaptive engine,
  delivered separately from npm and installed when you activate Community — see
  [The Hybrid Engine](#the-hybrid-engine). A Community account includes a per-period allowance
  covering **API-key traffic only**; subscription-route optimization does not consume it. When the
  allowance is spent, input optimization pauses, output shaping carries on, and your requests keep
  going through. `compaction usage` shows where you stand.
- **Session headroom.** Shorter responses stretch a plan window on any path, and where compacted
  history runs the context window fills later too, so sessions go further before truncation or
  forced restarts.
- **A content-free receipt for every instrumented call.** Counts and structural labels only, never
  your prompt, your code, or the response. Receipts live in `.compaction/gateway/receipts.jsonl` on
  your machine (gitignored, never uploaded). Gateway traffic, Claude Code and Codex are instrumented;
  Cursor's hook-shaped turns are recorded at session level.
- **One rollup.** `compaction status` shows connected tools, requests observed, measured reductions,
  and the exact next command. Figures are labeled by source (provider-reported vs local estimate),
  and a number is shown only at the strength the evidence supports.

### What you see, one line per turn

On an instrumented turn Compaction prints one content-free line: counts, labels, and a short receipt
id. Never your prompt, your code, or the response.

```
compaction · observed input 1,309 · output 20 · basic shaping · id 8e46224f
compaction · input 75,777→51,720 (−32%) · output 115→61 (−47%, est. · default prior) · id 7ac17b88
```

The first line is Open: output shaping ran, and the input was counted but not changed — so the input
axis is a plain observed count, never a reduction it did not make. The second is Community on the
gateway route: session history was compacted before the request went out, so the input axis carries a
real before→after where both endpoints were measured.

The output side has no per-turn counterfactual — there is no second response to compare against — so
its reduction is always labeled an estimate. `est.` means the rate came from your own provider-reported
A/B, which you run and process with `compaction savings`; `est. · default prior` means it is the
shipped starting rate, because this device has not measured its own yet. When the provider publishes
an input price, the line also carries a priced reduction such as `−$0.14 (list price)` — a
model-visible reduction priced at list, not an invoice-confirmed saving.

An axis that is not available is left out rather than faked, and a clause that cannot be earned is
omitted rather than invented — no fabricated `−$0`, and no percentage on an axis that was not
measured.

Where the line shows up: `compaction watch` (live) and `compaction watch --once` (the last few
turns) show it for every instrumented turn, whichever tool produced it. It also renders inline on
the Claude Code status line and in the Gateway's own log, and Compaction emits it through Codex's
post-turn hook. Cursor has a post-turn hook but no channel to display through — its `stop` response
schema carries only a follow-up prompt, not a message — so Cursor's numbers surface in
`compaction watch` and `compaction status` instead. Silence the line with
`COMPACTION_RECEIPT_LINE=0`; receipts are still written either way.

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
and the receipt records that honestly — `request_mutated: false`, with the reason. Compaction never
describes a pass-through as an apply.

## The Hybrid Engine

This is the adaptive engine that performs input optimization. It is delivered separately from npm:
**nothing below is in this package**. Activating Community installs the signed release, and the
client verifies its signature against a trust root compiled into this package before it will run it.
The input side is a hybrid: deterministic protection first, an adaptive model second.

- **Deterministic protection keeps the load-bearing content byte-exact.** Code blocks, commands,
  file paths, flags, and `file:line` references are extracted and locked verbatim before anything
  else runs. They are never summarized or paraphrased.
- **The adaptive step summarizes only obsolete history.** Old tool output, superseded discussion,
  and dead ends are compressed; the current task state is preserved.
- **It runs on your device.** The model is provisioned locally. No cloud model, and no traffic
  through a hosted middleman.
- **The original is always retained.** Every compacted request is recoverable byte-for-byte, so
  compaction is never destructive.
- **Quality is eval-gated.** Compaction and shaping ship behind evals that hold response quality;
  effects are task-dependent and always measured on your own receipts.

## Supported tools

| Tool | Route | Output shaping | Input optimization | Token counts |
|---|---|---|---|---|
| **Claude Code** | transparent local route (subscription or API key) | yes, every turn | Community, on the API-key gateway route | provider-reported |
| **Codex** | native hook (subscription) or gateway (API key) | yes, every turn | Community, on the API-key gateway route | provider-reported |
| **Cursor** | session-level instruction | yes (session-level only) | not available (no per-call route exposed by the tool) | local estimate |

Also supported for measurement: OpenAI Agents SDK capture and offline trace import
(`compaction capture`, `compaction import`). Captured traces can contain local file content, so
review a trace before sharing one.

## Open and Community

**Open** is this repository, and it needs no account. The Apache-2.0 Compaction CLI and core: the
CLI, the local Gateway, the native tool hooks for all three tools, output shaping, content-free
receipts, the apply gates, and byte-exact recovery. All of it runs on your machine. That is
deliberate — the privacy claim is verifiable because you can read the code that makes it.

**Community** is a free account, and it adds the input side. A free Hybrid Engine is also available
to add adaptive input optimization; activating Community registers this device and installs the
signed engine for you. Set it up from the CLI:

```bash
compaction login      # free Community account, 1 device
compaction mode full  # adaptive input optimization + output shaping
```

Contributions are welcome, and output shaping is the part most open to them. It is deterministic and
readable, and better shaping helps everyone who installs this. We keep working on it too.

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
without doing anything when it is not installed — they never pretend to have optimized.

## Privacy and security

- **Your content never leaves your machine.** Prompts, code, and responses are never uploaded, on
  any path. Receipts record token and cache counts and structural labels only, and stay on your
  machine (gitignored).
- **Without an account, nothing contacts Compaction.** No telemetry, no check-in, no network call of
  our own. The only traffic is your provider traffic going where it was already going.
- **With a free account, four things talk to our service, all content free.** Activating a device,
  getting the entitlement that unlocks the fuller optimization, syncing usage counts, and looking up
  or downloading the engine release. What crosses is counts, identifiers, and status labels. There
  is no field in any of them that can carry a prompt, a completion, or a line of your code.
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

## Methodology

Every figure Compaction prints is labeled by its source. Provider-reported counts come from your
provider's own usage metadata; anything else is labeled a local estimate; costs derived from price
tables are labeled estimates. Output-token reductions are measured before and after on real sessions
and gated on quality evals, and effects are task-dependent. Full methodology and evidence labels live
in the docs and on every receipt.

## License

Compaction is open core. The Compaction CLI and core in this repository are licensed under the
[Apache License 2.0](LICENSE). A free Hybrid Engine is also available to add adaptive input
optimization; its use is subject to the
[Compaction Engine License Agreement](https://compaction.dev/eula).

Releases published before this boundary existed remain available under the license attached to each
of them.
