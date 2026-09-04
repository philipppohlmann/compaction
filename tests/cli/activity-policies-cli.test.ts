/**
 * `compaction activity` + `compaction policies list/disable/explain` end-to-end CLI tests.
 * Runs the BUILT CLI (`dist/cli/index.js`) in a tmpdir cwd so
 * `.compaction/` never leaks into the repo checkout.
 *
 * Proven here:
 * - `activity` on an empty store → the friendly message, exit 0;
 * - `activity` after seeding 2 synthetic events → both rows, honest labels, exit 0;
 * - `activity --json` → parseable machine output; `--surface` filters;
 * - `policies list/explain/disable` → the saved preference lifecycle; unknown id → non-zero exit
 *   and a clear error; disable is idempotent; there is NO `enable` subcommand.
 *
 * ALL SYNTHETIC + CWD-SCOPED. dist is built by `pretest`.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI = resolve("dist/cli/index.js");
const SEED = resolve("dist/core/activity-event.js");
const STORE = resolve("dist/core/activity-store.js");
const PREF = resolve("dist/core/policy-preferences.js");

async function run(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI, ...args], { cwd });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

async function seedTwoEvents(cwd: string): Promise<void> {
  const script = `
    import { buildMeasureOnlyActivityEvent } from ${JSON.stringify(SEED)};
    import { appendActivityEvent } from ${JSON.stringify(STORE)};
    await appendActivityEvent(buildMeasureOnlyActivityEvent({
      surface: 'cursor', provider: 'cursor', model_label: 'unknown', run_id: 'cursor-1',
      token_source: { input: { source: 'local-estimate' }, output: { source: 'unavailable', unavailable_reason: "Compaction does not ingest Cursor's conditional result.usage" } },
      input_before: 820, cost_source: 'unavailable', cost_unavailable_reason: 'no cost', claim_scope: 'run-scoped'
    }, { original_retained: true, location: '.compaction/runs/cursor-1/t.json' }));
    await appendActivityEvent(buildMeasureOnlyActivityEvent({
      surface: 'codex', provider: 'openai', model_label: 'gpt-5-codex', run_id: 'codex-1',
      token_source: { input: { source: 'provider-reported' }, output: { source: 'provider-reported' } },
      input_before: 1500, output_before: 420, policy_used: 'stale_tool_output_to_state_capsule', claim_scope: 'run-scoped'
    }, { original_retained: true, location: '.compaction/runs/codex-1/t.json' }));
  `;
  await execFileAsync("node", ["--input-type=module", "-e", script], { cwd });
}

async function savePreference(cwd: string): Promise<string> {
  const script = `
    import { savePolicyPreference } from ${JSON.stringify(PREF)};
    const r = await savePolicyPreference({ scope: { tool: 'cursor', repo: 'demo', policy_type: 'stale_tool_output_to_state_capsule' }, preference: 'auto-when-gates-pass' });
    process.stdout.write(r.saved ? r.preference.id : 'FAILED');
  `;
  const { stdout } = await execFileAsync("node", ["--input-type=module", "-e", script], { cwd });
  return stdout.trim();
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "activity-policies-cli-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("compaction activity (CLI)", () => {
  it("empty store → friendly message, exit 0", async () => {
    const result = await run(cwd, ["activity"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/No activity recorded yet/);
  });

  it("populated → both rows with honest labels, exit 0", async () => {
    await seedTwoEvents(cwd);
    const result = await run(cwd, ["activity"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("420 measured (provider-reported)");
    expect(result.stdout).toContain("820 measured (local-estimate)");
    expect(result.stdout).toContain("unavailable (unavailable)");
    // No savings/cost claim on the surface.
    expect(result.stdout).not.toMatch(/\bsaved\b/i);
    expect(result.stdout).not.toMatch(/\$\d/);
  });

  it("--json → parseable machine output; --surface filters", async () => {
    await seedTwoEvents(cwd);
    const json = await run(cwd, ["activity", "--json"]);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.activity).toHaveLength(2);
    expect(parsed.meta.total_events).toBe(2);

    const filtered = await run(cwd, ["activity", "--surface", "codex", "--json"]);
    const parsedFiltered = JSON.parse(filtered.stdout);
    expect(parsedFiltered.activity).toHaveLength(1);
    expect(parsedFiltered.activity[0].surface).toBe("codex");
  });
});

describe("compaction policies (CLI)", () => {
  it("list (empty) → default ask-each-time note", async () => {
    const result = await run(cwd, ["policies", "list"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/No auto-apply preferences saved/);
  });

  it("full lifecycle: save (via store API) → list → explain → disable → idempotent disable", async () => {
    const id = await savePreference(cwd);
    expect(id).toMatch(/^pref-[0-9a-f]{24}$/);

    const list = await run(cwd, ["policies", "list"]);
    expect(list.stdout).toContain(id);
    // The list preamble states the honest semantics: an enabled auto-when-gates-pass preference is
    // a scoped authorization, gated fail-closed; everything else is forwarded unchanged.
    expect(list.stdout).toMatch(/scoped authorization/);
    expect(list.stdout).toMatch(/forwarded unchanged/);

    const explain = await run(cwd, ["policies", "explain", id]);
    expect(explain.code).toBe(0);
    // This preference carries the legacy default gate list, which the eligibility engine does not
    // evaluate - so it is honestly STORED, NEVER APPLIED (fail-closed on unevaluable gates).
    expect(explain.stdout).toMatch(/STORED, NEVER APPLIED/);
    expect(explain.stdout).toContain(`compaction policies disable ${id}`);

    const disable = await run(cwd, ["policies", "disable", id]);
    expect(disable.code).toBe(0);
    expect(disable.stdout).toMatch(/Disabled preference/);

    const again = await run(cwd, ["policies", "disable", id]);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/already disabled/);
  });

  it("unknown id → non-zero exit and a clear error (nothing changed)", async () => {
    const disable = await run(cwd, ["policies", "disable", "pref-000000000000000000000000"]);
    expect(disable.code).not.toBe(0);
    expect(disable.stderr + disable.stdout).toMatch(/no preference with id/);

    const explain = await run(cwd, ["policies", "explain", "pref-000000000000000000000000"]);
    expect(explain.code).not.toBe(0);
    expect(explain.stderr + explain.stdout).toMatch(/No preference with id/i);
  });

  it("has NO enable subcommand (enable only ever happens via the live post-approval ask)", async () => {
    const id = await savePreference(cwd);
    const result = await run(cwd, ["policies", "enable", id]);
    expect(result.code).not.toBe(0);
  });
});

/**
 * THE EMPTY STATE CARRIES THE RECOVERY PATH.
 *
 * An authorization is stored per DEVICE. Before 0.6.7 it was written into whatever directory
 * `init --authorize-auto-apply` happened to run in, so a user who authorized that way sees apply stop
 * after upgrading and runs `policies list` to find out why — standing in the very project whose
 * `.compaction/policy-preferences.json` is still sitting on disk. "Nothing saved" is true and useless
 * to them. This pins that the empty listing explains the device scope and names the one command that
 * fixes it, because the populated listing (which also explains it) is the branch they will never see.
 */
describe("compaction policies list - the empty state tells a stranded user how to recover", () => {
  let deviceDir: string;
  let projectDir: string;

  beforeEach(async () => {
    deviceDir = await mkdtemp(join(tmpdir(), "policies-empty-device-"));
    projectDir = await mkdtemp(join(tmpdir(), "policies-empty-project-"));
    // The pre-0.6.7 authorization, exactly where that version put it — present, enabled, and inert.
    await mkdir(join(projectDir, ".compaction"), { recursive: true });
    await writeFile(
      join(projectDir, ".compaction", "policy-preferences.json"),
      JSON.stringify({
        preferences: [
          {
            id: "pref-41b78feb6a5e8e3baa0ca817",
            scope: { tool: "claude-code", policy_type: "deterministic-dedupe" },
            preference: "auto-when-gates-pass",
            enabled: true,
            gates_required: ["scope-match", "supported-shape", "deterministic-policy", "original-retainable", "change-produced"]
          }
        ]
      }),
      "utf8"
    );
  });

  afterEach(async () => {
    for (const d of [deviceDir, projectDir]) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("names the device scope and the exact re-authorize command, and still lists nothing", async () => {
    const { stdout } = await execFileAsync("node", [resolve("dist/cli/index.js"), "policies", "list"], {
      cwd: projectDir,
      env: { ...process.env, COMPACTION_CONFIG_DIR: deviceDir, FORCE_COLOR: "0" }
    });
    // The project file is real and visible to the user; it must still authorize nothing.
    expect(stdout).toContain("No auto-apply preferences saved on this device");
    expect(stdout).not.toContain("pref-41b78feb6a5e8e3baa0ca817");
    // …and the user is told why, where authorizations live, and what to run.
    expect(stdout).toContain("stored per DEVICE");
    expect(stdout).toContain(deviceDir);
    expect(stdout).toContain("inside a project grants nothing");
    expect(stdout).toContain("compaction init --authorize-auto-apply claude-code");
  });
});
