import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureProviderUsageCommand } from "../../src/cli/commands/capture-provider-usage.js";
import { DEFAULT_CREDENTIAL_ENV_VAR } from "../../src/core/provider-usage/provider-usage-adapter.js";
import type {
  FetchUsageInput,
  ProviderAggregateUsage,
  ProviderUsageClient
} from "../../src/core/provider-usage/provider-usage-client.js";

// Clearly-fake sentinel credential. NOT a real secret. NEVER touches a network.
const SENTINEL_CREDENTIAL = "SENTINEL-CLI-LEAK-DO-NOT-USE-0123456789abcdef0123456789abcdef";

// Fixture aggregate-usage response (mock client). Usage/cost AGGREGATES ONLY, no content.
const FIXTURE_USAGE: ProviderAggregateUsage = {
  model: "claude-3-5-sonnet",
  provider: "anthropic",
  input_tokens: 120000,
  output_tokens: 34000,
  total_tokens: 154000,
  request_count: 87,
  cost: 4.21,
  currency: "USD",
  window_start: "2026-06-01T00:00:00.000Z",
  window_end: "2026-06-08T00:00:00.000Z"
};

/** Mock client returning the fixture. Records whether it was called (to prove the refusal path never reads). */
function mockClient(
  response: ProviderAggregateUsage,
  onCall?: (input: FetchUsageInput) => void
): ProviderUsageClient {
  return {
    async fetchUsage(input: FetchUsageInput): Promise<ProviderAggregateUsage> {
      onCall?.(input);
      return response;
    }
  };
}

/** Capture everything written to stdout/stderr while running the command. */
function captureConsole(): { stdout: () => string; stderr: () => string; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(" "));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    err.push(args.map(String).join(" "));
  });
  return {
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    restore: () => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  };
}

async function readAllArtifacts(dir: string): Promise<string> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return "";
  }
  const contents = await Promise.all(
    names.map((name) => readFile(join(dir, name), "utf8").catch(() => ""))
  );
  return contents.join("\n");
}

describe("provider-usage capture CLI - no-secret-leak (stdout/stderr/artifacts)", () => {
  let tmpDir: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "provider-usage-cli-"));
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(async () => {
    process.exitCode = savedExitCode;
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("SUCCESS path: sentinel appears NOWHERE in stdout, stderr, or written artifacts", async () => {
    const outDir = join(tmpDir, "out");
    const cap = captureConsole();
    let seenCredential: string | undefined;
    try {
      await captureProviderUsageCommand(
        {
          endpoint: "https://provider.example/usage",
          credentialEnvVar: DEFAULT_CREDENTIAL_ENV_VAR,
          windowStart: "2026-06-01T00:00:00.000Z",
          windowEnd: "2026-06-08T00:00:00.000Z",
          out: outDir
        },
        {
          env: { [DEFAULT_CREDENTIAL_ENV_VAR]: SENTINEL_CREDENTIAL },
          client: mockClient(FIXTURE_USAGE, (input) => {
            seenCredential = input.credential;
          }),
          capturedAt: "2026-06-08T12:00:00.000Z",
          runId: "provider-usage-cli-test"
        }
      );
    } finally {
      cap.restore();
    }

    const stdout = cap.stdout();
    const stderr = cap.stderr();
    const artifacts = await readAllArtifacts(outDir);

    // The success path completed and produced output + artifacts (sanity).
    expect(process.exitCode).toBeUndefined();
    expect(stdout).toContain("Artifacts written to:");
    expect(artifacts.length).toBeGreaterThan(0);

    // The client received the credential (it authenticates the read)...
    expect(seenCredential).toBe(SENTINEL_CREDENTIAL);
    // ...but the sentinel leaks NOWHERE: not stdout, not stderr, not any artifact file.
    expect(stdout).not.toContain(SENTINEL_CREDENTIAL);
    expect(stderr).not.toContain(SENTINEL_CREDENTIAL);
    expect(artifacts).not.toContain(SENTINEL_CREDENTIAL);
  });

  it("MISSING-credential path: clean refusal, non-zero exit, NO artifact, NO client read, sentinel absent", async () => {
    const outDir = join(tmpDir, "out-missing");
    const cap = captureConsole();
    let clientCalled = false;
    try {
      await captureProviderUsageCommand(
        {
          endpoint: "https://provider.example/usage",
          credentialEnvVar: DEFAULT_CREDENTIAL_ENV_VAR,
          out: outDir
        },
        {
          // Env var ABSENT: the command must refuse before any read.
          env: {},
          client: mockClient(FIXTURE_USAGE, () => {
            clientCalled = true;
          })
        }
      );
    } finally {
      cap.restore();
    }

    const stdout = cap.stdout();
    const stderr = cap.stderr();
    const refusal = `${stdout}\n${stderr}`;

    // Non-zero exit code path.
    expect(process.exitCode).toBe(1);
    // The mock client was NEVER called on the missing-credential path.
    expect(clientCalled).toBe(false);
    // No artifact directory/files written.
    expect(await readAllArtifacts(outDir)).toBe("");
    // Clean refusal: names the env var, contains no secret/sentinel.
    expect(refusal).toContain(DEFAULT_CREDENTIAL_ENV_VAR);
    expect(refusal.toLowerCase()).toContain("no fallback");
    expect(stdout).not.toContain(SENTINEL_CREDENTIAL);
    expect(stderr).not.toContain(SENTINEL_CREDENTIAL);
  });

  it("EMPTY credential is treated as missing: clean refusal, non-zero exit, NO artifact, NO read", async () => {
    const outDir = join(tmpDir, "out-empty");
    const cap = captureConsole();
    let clientCalled = false;
    try {
      await captureProviderUsageCommand(
        {
          endpoint: "https://provider.example/usage",
          credentialEnvVar: DEFAULT_CREDENTIAL_ENV_VAR,
          out: outDir
        },
        {
          env: { [DEFAULT_CREDENTIAL_ENV_VAR]: "" },
          client: mockClient(FIXTURE_USAGE, () => {
            clientCalled = true;
          })
        }
      );
    } finally {
      cap.restore();
    }

    expect(process.exitCode).toBe(1);
    expect(clientCalled).toBe(false);
    expect(await readAllArtifacts(outDir)).toBe("");
    expect(`${cap.stdout()}\n${cap.stderr()}`).toContain(DEFAULT_CREDENTIAL_ENV_VAR);
  });
});
