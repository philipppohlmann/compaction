# Codex exec JSONL demo fixture

`codex-exec-demo.jsonl` is a **SYNTHETIC, hand-authored fixture** shaped like real
`codex exec --json` output. It is **not** a captured Codex run. It exists so the documented
Codex MVP path can be walked end-to-end and so parser/compaction coverage has a realistic input:

- agent/user message events (`item.completed` with `agent_message` / `user_message` items),
- `command_execution` events with `npm test` output,
- the **same** large test-output block repeated across three runs, so the
  `repeated_tool_output` waste category triggers and the
  `stale_tool_output_to_state_capsule` policy has real, byte-identical duplicates to compact
  (the repeated block is large enough to cross the conservative compaction thresholds).

## Walking the path

```bash
compaction import src/examples/codex-exec-demo.jsonl --source codex-exec-jsonl --out ./my-trace
compaction analyze      ./my-trace/captured-trace.json
compaction recommend    ./my-trace/captured-trace.json
compaction compact      ./my-trace/captured-trace.json --out ./my-trace/compacted
compaction apply-context ./my-trace/captured-trace.json --out ./my-trace/apply            # review only
compaction apply-context ./my-trace/captured-trace.json --out ./my-trace/apply --approve-in-workflow-use
```

## Honesty / status

- **Evidence tier on this demo path is `fixture` (the weakest honest tier), NOT `imported_local`.**
  Because this file is synthetic, importing it WITHOUT `--operator-export` deliberately labels the
  trace `manual` → `fixture`. The import boundary defaults to the weakest honest tier; it never
  auto-upgrades Codex JSONL to a real-local-export tier.
- **`--operator-export` is the explicit opt-in for real provenance.** Only when you import your OWN
  real `codex exec --json` export and pass `--operator-export` does the trace become `codex_import`
  → `imported_local`. Even then it stays strictly below `real_captured`, never unlocks the `ready`
  approval rung (caps at `conditional`), and carries no billing/semantic/commitment claim. Do NOT
  pass `--operator-export` for this synthetic demo fixture — that would over-label synthetic data.
- Token counts on this **import** path are **locally estimated (chars/4)**, never provider-reported:
  the import adapter skips `turn.*` lifecycle events and does not invent token counts. The compact
  output labels this explicitly.
- The fixture's `turn.completed` event carries a **SYNTHETIC usage block** (round demo numbers:
  24000 input / 16000 cached / 1800 output / 200 reasoning — hand-picked, from no real run) in the
  documented `codex exec --json` shape. This exists so the **`run codex --export`** flow can
  demonstrate the provider-reported token tier from a committed fixture:

  ```bash
  compaction run codex --out ./codex-demo --export src/examples/codex-exec-demo.jsonl
  compaction summary   # rolls the run up as "live (provider-reported)"
  ```

  The `provider-reported` label on that path describes the token **source field** in the JSONL
  (read from `turn.completed.usage`, not invented locally) — the values themselves are synthetic
  demo numbers, NOT evidence of any real Codex run, cost, or saving.
- **Real codex artifact validation: OPEN.** This path has been verified end-to-end against this
  synthetic fixture only. It has not yet been walked against a real `codex exec --json` export
  from an actual Codex run. Closing that gap is operator-side follow-up.

`codex-exec-fixtures/demo-codex-exec.jsonl` is a separate, smaller fixture used by the adapter
audit demo (`npm run adapter:audit:demo`); it is intentionally below the compaction thresholds.
