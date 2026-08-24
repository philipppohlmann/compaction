/**
 * `compaction api export`, the LOCAL, CONTENT-FREE JSON export for dashboard/app ingestion (PUBLIC CLI).
 *
 * WHAT IT DOES: prints (or writes to an operator-specified local file) ONE typed content-free JSON document
 * assembled by `buildApiExport`, the SAME content-free truth `gateway status` / `gateway proof` /
 * `gateway capabilities` / `activity` already show, so the dashboard consumes one source without duplicating
 * interpretation logic. JSON is the ONLY output mode (it is a machine handoff). Schema v2 adds the two-route
 * proof data (`proof_scopes`, `plan_lifetime`; Route-B provider-priced cost rides on `verifications`).
 *
 * `--dashboard-contract` emits the typed dashboard contract (the export mapped to the accepted `/app`
 * source-status tiers via `dashboard-contract.ts`), the same content-free truth, no reinterpretation; the
 * dashboard reads THIS instead of re-deriving from the raw stores. Wiring it into `apps/web` (Lovable-managed)
 * is coordination-gated and deliberately out of scope here.
 *
 * HARD RAILS: LOCAL EXPORT ONLY, read-only. It only READS the already-content-free local `.compaction/*`
 * stores and computes/derives from them, it makes NO network call, performs NO upload/telemetry, handles NO
 * key, and (absent `--out`) writes NOTHING. With `--out <file>` it writes the document ONLY to that operator-
 * specified local path. The document carries no prompt/response/tool content and no credentials (see
 * `api-export.ts`). A live sync / API server is a clearly-scoped FUTURE step, not this command.
 */
import { writeFileSync } from "node:fs";
import { Command } from "commander";
import { buildApiExport } from "../../core/api-export.js";
import { toDashboardContract } from "../../core/dashboard-contract.js";
import {
  ApiNotConfirmedError,
  ApiTransportError,
  previewPayload,
  resolveTarget,
  sendIngestExport,
  validateContentFreeDocument
} from "../../core/api-client/index.js";
import { registerApiConnectCommand } from "./upgrade-status.js";

interface ApiExportOptions {
  /** Present for symmetry with other commands; JSON is the only mode (a machine handoff). */
  json?: boolean;
  /** Optional operator-specified local path to write the document to (instead of stdout). */
  out?: string;
  /** Emit the typed dashboard contract (mapped to the /app source-status tiers) instead of the raw export. */
  dashboardContract?: boolean;
  /** Explicit opt-in to POST this content-free export to the API. */
  toApi?: boolean;
  yes?: boolean;
  url?: string;
  key?: string;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

async function shareToApi(options: ApiExportOptions): Promise<void> {
  const target = resolveTarget({ flagUrl: options.url, flagKey: options.key });
  if (!target.url.trim()) {
    console.error("api export --to-api refused: API endpoint is not configured");
    process.exit(1);
    return;
  }
  if (!isLoopbackUrl(target.url) && !target.apiKey) {
    console.error("api export --to-api refused: a key is required for a non-local endpoint");
    process.exit(1);
    return;
  }
  const contract = toDashboardContract(await buildApiExport(process.cwd()));
  const body = contract as unknown as Record<string, unknown>;
  const validation = validateContentFreeDocument(body);
  if (!validation.ok) {
    console.error(`api export --to-api refused: content-free validation failed at ${validation.path}`);
    process.exit(1);
    return;
  }
  const preview = previewPayload("POST", "/v0/ingest/export", target.url, body);
  console.log("[preview] content-free dashboard export");
  console.log(`[preview] endpoint: ${preview.endpoint}`);
  console.log(`[preview] url: ${preview.url}`);
  console.log(`[preview] bytes: ${preview.byteSize}`);
  console.log(`[preview] payload: ${JSON.stringify(preview.body, null, 2)}`);
  if (options.yes !== true) {
    console.error("api export --to-api not sent: pass --yes to confirm this exact preview");
    process.exit(2);
    return;
  }
  try {
    const config = target.apiKey
      ? { url: target.url, apiKey: target.apiKey, timeoutMs: 30_000 }
      : { url: target.url, timeoutMs: 30_000 };
    const response = await sendIngestExport(config, body, { confirmed: true });
    if (!response.ok) {
      console.error(`api export --to-api failed: API returned HTTP ${response.status}`);
      process.exit(1);
      return;
    }
    console.log(`api export --to-api accepted: content-free export ingested (HTTP ${response.status})`);
    process.exit(0);
  } catch (error) {
    const message = error instanceof ApiNotConfirmedError || error instanceof ApiTransportError ? error.message : "request failed";
    console.error(`api export --to-api failed: ${message}`);
    process.exit(1);
  }
}

export function registerApiCommand(program: Command): void {
  const api = program
    .command("api")
    .description(
      "Local, content-free data export for dashboard/app ingestion, plus connecting a private-beta / " +
        "self-hosted endpoint. `export` reads only the local .compaction stores and emits the SAME " +
        "content-free truth the CLI shows (no network, no upload, no keys, no content)."
    );

  // `api connect` — formerly `compaction upgrade`. See `upgrade-status.ts` for why the name moved.
  registerApiConnectCommand(api);

  api
    .command("export")
    .description(
      "Print ONE typed, content-free JSON document (schema v2: gateway status, cache summary, receipts, " +
        "activity, verifications, capabilities, proof_scopes, plan_lifetime) for the dashboard/app - reuses " +
        "the existing readers/derivers so it never drifts from 'gateway status'/'proof'/'capabilities'. " +
        "Route A (plan-lifetime) and Route B (api-billing provider-priced) stay separate; no invoice-confirmed " +
        "figure. LOCAL EXPORT ONLY: read-only, no network, no upload, no telemetry."
    )
    .option("--json", "Machine-readable JSON output (default and only mode).")
    .option("--out <file>", "Write the JSON to this local file instead of stdout (operator-specified path).")
    .option(
      "--dashboard-contract",
      "Emit the typed dashboard contract (ApiExportDocument mapped to the /app source-status tiers) instead " +
        "of the raw export - the same content-free truth, no reinterpretation. Local-only; the dashboard reads " +
        "this file (apps/web wiring is coordination-gated)."
    )
    .option("--to-api", "Preview and explicitly POST the content-free dashboard contract to /v0/ingest/export.")
    .option("--yes", "Confirm the exact --to-api preview and perform the requested POST (required with --to-api).")
    .option("--url <url>", "API base URL (otherwise COMPACTION_API_URL or persisted config).")
    .option("--key <key>", "API key for a non-local private endpoint (never printed or persisted).")
    .action(async (options: ApiExportOptions) => {
      if (options.toApi) {
        await shareToApi(options);
        return;
      }
      const doc = await buildApiExport(process.cwd());
      const payload = options.dashboardContract ? toDashboardContract(doc) : doc;
      const json = JSON.stringify(payload, null, 2);
      if (options.out) {
        writeFileSync(options.out, `${json}\n`, "utf8");
        console.log(`compaction api export: wrote content-free export to ${options.out} (local only - nothing uploaded)`);
        return;
      }
      console.log(json);
    });

}
