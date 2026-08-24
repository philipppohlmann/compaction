/**
 * Gateway project configure (PUBLIC CLI core).
 *
 * Approval-gated: this module only ever PLANS a change (detect the project, propose adding an
 * OPENAI_BASE_URL pointing at the local gateway, and render an exact diff). It writes NOTHING unless the
 * caller explicitly applies the plan, and even then it creates a `.bak` backup first and refuses to
 * overwrite an existing provider base URL without an explicit force. No auto-write, ever.
 */
import fs from "node:fs";
import path from "node:path";

/** The env var we set to route an OpenAI-compatible client through the gateway. */
export const CONFIGURE_ENV_VAR = "OPENAI_BASE_URL";

export interface ProjectDetection {
  /** `.env` / `.env.local` files that exist in the project root. */
  envFiles: string[];
  hasPackageJson: boolean;
  /** True when package.json lists the `openai` SDK as a dependency. */
  usesOpenAiSdk: boolean;
  /** An already-configured base URL, if any (OPENAI_BASE_URL or OPENAI_API_BASE), and where. */
  existingBaseUrl?: { file: string; var: string; value: string };
}

const ENV_CANDIDATES = [".env", ".env.local"];
const BASE_URL_VARS = ["OPENAI_BASE_URL", "OPENAI_API_BASE"];

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Find an existing base-URL assignment in a dotenv-style body. Returns the var + value, or null. */
function findBaseUrlAssignment(body: string): { var: string; value: string } | null {
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (BASE_URL_VARS.includes(m[1])) {
      return { var: m[1], value: m[2].replace(/^["']|["']$/g, "") };
    }
  }
  return null;
}

/** Detect the project's OpenAI-config surface WITHOUT modifying anything. */
export function detectProject(cwd: string): ProjectDetection {
  const envFiles: string[] = [];
  let existingBaseUrl: ProjectDetection["existingBaseUrl"];
  for (const name of ENV_CANDIDATES) {
    const body = readIfExists(path.join(cwd, name));
    if (body === null) continue;
    envFiles.push(name);
    if (!existingBaseUrl) {
      const found = findBaseUrlAssignment(body);
      if (found) existingBaseUrl = { file: name, var: found.var, value: found.value };
    }
  }
  let hasPackageJson = false;
  let usesOpenAiSdk = false;
  const pkgBody = readIfExists(path.join(cwd, "package.json"));
  if (pkgBody !== null) {
    hasPackageJson = true;
    try {
      const pkg = JSON.parse(pkgBody) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      usesOpenAiSdk = Boolean(pkg.dependencies?.openai || pkg.devDependencies?.openai);
    } catch {
      /* malformed package.json, leave usesOpenAiSdk false */
    }
  }
  return { envFiles, hasPackageJson, usesOpenAiSdk, ...(existingBaseUrl ? { existingBaseUrl } : {}) };
}

export type ConfigureAction = "create" | "append" | "conflict";

export interface ConfigurePlan {
  /** The file (relative) we would write. */
  targetFile: string;
  action: ConfigureAction;
  /** The base URL we would set (already includes /v1). */
  baseUrl: string;
  /** Unified-ish diff preview (content-free, env var + gateway URL only). */
  diff: string;
  /** Where the `.bak` backup would go, when the target already exists. */
  backupFile?: string;
  detection: ProjectDetection;
  /** Human-readable note about why apply is/should be gated. */
  note: string;
}

/**
 * Build a configure plan for pointing this project's OpenAI client at `baseUrl` (the gateway `/v1` URL).
 * Never writes. If a base URL is already configured, the plan action is "conflict" and apply requires force.
 */
export function planGatewayConfigure(cwd: string, baseUrl: string): ConfigurePlan {
  const detection = detectProject(cwd);
  const targetFile = detection.envFiles.includes(".env.local")
    ? ".env.local"
    : detection.envFiles.includes(".env")
      ? ".env"
      : ".env";
  const targetPath = path.join(cwd, targetFile);
  const existing = readIfExists(targetPath);
  const newLine = `${CONFIGURE_ENV_VAR}=${baseUrl}`;

  let action: ConfigureAction;
  let diff: string;
  let note: string;
  if (detection.existingBaseUrl) {
    action = "conflict";
    diff =
      `- ${detection.existingBaseUrl.var}=${detection.existingBaseUrl.value}   (in ${detection.existingBaseUrl.file})\n` +
      `+ ${newLine}`;
    note =
      `${detection.existingBaseUrl.file} already sets ${detection.existingBaseUrl.var}. ` +
      "Compaction will NOT overwrite an existing provider base URL without explicit confirmation (--force).";
  } else if (existing === null) {
    action = "create";
    diff = `+ ${newLine}`;
    note = `${targetFile} does not exist yet. Apply would create it with just the gateway base URL line.`;
  } else {
    action = "append";
    diff = `  (existing ${targetFile} unchanged)\n+ ${newLine}`;
    note = `Apply would append one line to ${targetFile} (a .bak backup is written first).`;
  }

  return {
    targetFile,
    action,
    baseUrl,
    diff,
    ...(existing !== null ? { backupFile: `${targetFile}.bak` } : {}),
    detection,
    note
  };
}

export interface ApplyResult {
  wrote: boolean;
  targetFile: string;
  backupFile?: string;
  reason?: string;
}

/**
 * Apply a configure plan: write a `.bak` backup (when the target exists), then create/append the base-URL
 * line. Refuses a "conflict" plan unless `force` is set. This is the ONLY function here that writes.
 */
export function applyGatewayConfigure(cwd: string, plan: ConfigurePlan, force = false): ApplyResult {
  if (plan.action === "conflict" && !force) {
    return { wrote: false, targetFile: plan.targetFile, reason: "existing provider base URL present; re-run with --force to overwrite" };
  }
  const targetPath = path.join(cwd, plan.targetFile);
  const existing = readIfExists(targetPath);
  const newLine = `${CONFIGURE_ENV_VAR}=${plan.baseUrl}`;

  let backupFile: string | undefined;
  if (existing !== null) {
    backupFile = `${plan.targetFile}.bak`;
    fs.writeFileSync(path.join(cwd, backupFile), existing, "utf8");
  }

  let next: string;
  if (plan.action === "conflict" && existing !== null) {
    // Replace the existing base-URL assignment line in place.
    next = existing
      .split(/\r?\n/)
      .map((line) => {
        const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/);
        return m && BASE_URL_VARS.includes(m[1]) ? newLine : line;
      })
      .join("\n");
  } else if (existing !== null) {
    next = existing.endsWith("\n") ? `${existing}${newLine}\n` : `${existing}\n${newLine}\n`;
  } else {
    next = `${newLine}\n`;
  }
  fs.writeFileSync(targetPath, next, "utf8");
  return { wrote: true, targetFile: plan.targetFile, ...(backupFile ? { backupFile } : {}) };
}

/** Render a configure plan as plain content-free lines (for the CLI preview). */
export function formatConfigurePlan(plan: ConfigurePlan): string[] {
  const lines: string[] = [];
  lines.push("compaction gateway configure - proposed change (nothing is written yet)");
  lines.push(`  target file:  ${plan.targetFile}   (${plan.action})`);
  lines.push(`  detected:     ${describeDetection(plan.detection)}`);
  lines.push("  diff:");
  for (const d of plan.diff.split("\n")) lines.push(`    ${d}`);
  lines.push(`  note:         ${plan.note}`);
  lines.push("");
  lines.push("  to apply:     compaction gateway configure --apply" + (plan.action === "conflict" ? " --force" : ""));
  return lines;
}

function describeDetection(d: ProjectDetection): string {
  const bits: string[] = [];
  bits.push(d.envFiles.length ? `env files: ${d.envFiles.join(", ")}` : "no .env files");
  bits.push(d.hasPackageJson ? (d.usesOpenAiSdk ? "openai SDK in package.json" : "package.json (no openai dep)") : "no package.json");
  if (d.existingBaseUrl) bits.push(`existing ${d.existingBaseUrl.var} in ${d.existingBaseUrl.file}`);
  return bits.join("; ");
}
