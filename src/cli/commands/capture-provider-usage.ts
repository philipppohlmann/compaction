import { writeJsonArtifact, writeTextArtifact } from "../../core/artifact-writer.js";
import { redactSecrets } from "../../core/provider-usage/credential-redaction.js";
import {
  captureProviderUsage,
  DEFAULT_CREDENTIAL_ENV_VAR,
  MissingProviderCredentialError,
  PROVIDER_USAGE_PRIVACY_NOTE
} from "../../core/provider-usage/provider-usage-adapter.js";
import type { CaptureProvenance } from "../../core/capture-adapter.js";
import type { UsageMetadata } from "../../core/usage-metadata.js";
import type { ProviderUsageClient } from "../../core/provider-usage/provider-usage-client.js";

export interface CaptureProviderUsageOptions {
  endpoint?: string;
  credentialEnvVar?: string;
  windowStart?: string;
  windowEnd?: string;
  label?: string;
  out?: string;
}

/**
 * Optional, additive, backward-compatible testability seam. Tests pass a MOCK
 * provider-usage client (and may override the env reader) so the CLI-level
 * stdout/stderr/artifact no-secret-leak + refusal paths can be exercised with a
 * sentinel credential and NO real network. Defaults are the real client and
 * process.env, so the production command path is unchanged.
 */
export interface CaptureProviderUsageDeps {
  /** Injectable provider-usage client. Default: the real fetch-based client. */
  client?: ProviderUsageClient;
  /** Env reader override (tests). Default: process.env (used to read the credential for the redaction backstop). */
  env?: Record<string, string | undefined>;
  /** Fixed timestamp for deterministic test artifacts. Default: now (via the adapter). */
  capturedAt?: string;
  /** Fixed run id for deterministic test artifacts. Default: derived (via the adapter). */
  runId?: string;
}

function buildOutputDir(out?: string): string {
  if (out) return out;
  return ".compaction/runs/provider-usage";
}

function buildMarkdownReport(outDir: string, provenance: CaptureProvenance, usage: UsageMetadata): string {
  const lines: string[] = [
    "# Provider Usage Capture Report",
    "",
    `**Source:** ${provenance.sourcePath}`,
    `**Captured at:** ${provenance.capturedAt}`,
    `**Adapter:** ${provenance.captureAdapter}`,
    "",
    "## Usage (aggregate only - no content)",
    "",
    `- Input tokens: ${usage.input_tokens ?? "unknown"}`,
    `- Output tokens: ${usage.output_tokens ?? "unknown"}`,
    `- Total tokens: ${usage.total_tokens ?? "unknown"}`,
    `- Provider reported tokens: ${usage.provider_reported_tokens}`,
    `- Cost source: ${usage.cost_source}`,
    `- Cost confidence: ${usage.cost_confidence}`,
    ...(usage.currency ? [`- Currency: ${usage.currency}`] : []),
    "",
    "## Warnings",
    "",
    ...provenance.warnings.map((w) => `- ${w}`),
    "",
    "## Limitations",
    "",
    ...provenance.limitations.map((l) => `- ${l}`),
    "",
    "## Artifacts",
    "",
    `- \`${outDir}/captured-trace.json\` - AgentTrace (source: provider_usage, no messages)`,
    `- \`${outDir}/capture-report.json\` - CapturedRun metadata (usage/cost only)`,
    `- \`${outDir}/capture-report.md\` - this file`,
    ""
  ];
  return lines.join("\n");
}

/**
 * Read-only, aggregate-only provider usage/cost capture (Option A).
 *
 * Reads the credential from the named env var (default COMPACTION_PROVIDER_USAGE_TOKEN),
 * refuses cleanly if it is absent/empty (clear message naming the env var, non-zero
 * exit, NO artifact), performs the single read via the real fetch client, and writes
 * a usage-only CapturedRun under .compaction/. ALL output is redacted before printing.
 */
export async function captureProviderUsageCommand(
  options: CaptureProviderUsageOptions,
  deps: CaptureProviderUsageDeps = {}
): Promise<void> {
  const envVar = options.credentialEnvVar ?? DEFAULT_CREDENTIAL_ENV_VAR;
  // Env reader: process.env by default; tests may inject an override.
  const env = deps.env ?? process.env;
  // Capture the configured secret (if any) ONLY to feed the redaction backstop -
  // it is never printed and never written. Primary control is that nothing on this
  // path puts it into output; this is the defense-in-depth value for redaction.
  const configuredSecret = env[envVar];

  // Redacted printer: every line written by this command passes through redaction.
  const say = (line: string): void => console.log(redactSecrets(line, configuredSecret));
  const sayErr = (line: string): void => console.error(redactSecrets(line, configuredSecret));

  say(PROVIDER_USAGE_PRIVACY_NOTE);
  say("");

  if (!options.endpoint) {
    sayErr("error: --endpoint <url> is required (the provider usage/cost reporting endpoint).");
    process.exitCode = 1;
    return;
  }

  let capturedRun;
  try {
    capturedRun = await captureProviderUsage({
      endpoint: options.endpoint,
      credentialEnvVar: envVar,
      windowStart: options.windowStart,
      windowEnd: options.windowEnd,
      label: options.label,
      // Seam: default undefined => the adapter uses the real fetch client / process.env / now.
      client: deps.client,
      env: deps.env,
      capturedAt: deps.capturedAt,
      runId: deps.runId
    });
  } catch (error) {
    if (error instanceof MissingProviderCredentialError) {
      // Clean refusal: clear message naming the env var, non-zero exit, NO artifact.
      sayErr(`error: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    // Any other failure (auth error, network, parse): redact before printing,
    // exit non-zero, write NO partial artifact.
    const message = error instanceof Error ? error.message : String(error);
    sayErr(`error: provider usage read failed: ${message}`);
    process.exitCode = 1;
    return;
  }

  const { trace, usage, provenance } = capturedRun;
  const outDir = buildOutputDir(options.out);

  say(`Source: ${provenance.sourcePath}`);
  say(`Token totals (aggregate): input=${usage.input_tokens ?? 0}, output=${usage.output_tokens ?? 0}, total=${usage.total_tokens ?? 0}`);
  say(`Cost source: ${usage.cost_source} (confidence: ${usage.cost_confidence})`);
  say("Messages captured: 0 (aggregate usage only - no prompt/completion content)");

  const capturedRunArtifact = { trace, usage, provenance };
  const markdownReport = buildMarkdownReport(outDir, provenance, usage);

  await writeJsonArtifact(outDir, "captured-trace.json", trace);
  await writeJsonArtifact(outDir, "capture-report.json", capturedRunArtifact);
  await writeTextArtifact(outDir, "capture-report.md", markdownReport);

  say(`Artifacts written to: ${outDir}/`);
  say(`Next: compaction analyze ${outDir}/captured-trace.json`);
}
