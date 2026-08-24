/**
 * Compaction config-directory resolution (PUBLIC client, pure — `node:os` + `node:path` only).
 *
 * The single pure resolver for `~/.compaction` with the `COMPACTION_CONFIG_DIR` override (tests
 * point it at a tmpdir; the real `~/.compaction` is never touched by tests). Extracted so a module
 * that must stay OFF the account/api-client import graph (e.g. the pure entitlement lease-store on
 * the Open path) can resolve the config dir WITHOUT importing `api-client/persisted-config.ts`
 * (a forbidden substring on the Open graph). Mirrors that module's resolution exactly.
 *
 * Import-safe on the Open path: no fs, no network, no engine, no account client. Never throws.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Minimal env shape: the `COMPACTION_CONFIG_DIR` override, and the `HOME` the default hangs off. */
export interface ConfigDirEnv {
  COMPACTION_CONFIG_DIR?: string;
  HOME?: string;
}

/**
 * Resolve the config directory. `COMPACTION_CONFIG_DIR` overrides `<home>/.compaction` (tests use this).
 *
 * BOTH steps read the supplied env. The default used to fall back to the ambient `homedir()` even when
 * the caller had handed over an environment, so a caller running against an injected env (in-process
 * `runStatus({ env })`) resolved this machine's state directory unless it also happened to set
 * `COMPACTION_CONFIG_DIR` - reporting one environment's config while describing another's. Same
 * `env.HOME` -> `homedir()` fallback the shim resolver uses, so an unset HOME behaves exactly as before.
 */
export function compactionConfigDir(env: ConfigDirEnv = process.env): string {
  const override = (env.COMPACTION_CONFIG_DIR ?? "").trim();
  if (override !== "") return override;
  const home = (env.HOME ?? "").trim();
  return join(home !== "" ? home : homedir(), ".compaction");
}
