import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { generateShimScript, resolveShimDir, SHIM_TOOLS, type ShimTool } from "../tool-shim.js";
import { containedPath, loadManagedInstallation, sha256 } from "./ownership.js";
import { atomicWrite, withManagedLock } from "./state.js";

interface MigrationEntry { target: string; backup: string; before: string; after: string; status: "prepared" | "written" | "reverted" | "conflict" }
interface MigrationRecord { schema: 1; id: string; integrationSchema: 1; entries: MigrationEntry[] }

/** Exact owned-shim migration. Native hook commands already use stable `compaction` identity. */
export async function migrateOwnedIntegrations(root: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  return withManagedLock(root, () => {
    const { receipt } = loadManagedInstallation(root, false);
    const directory = resolveShimDir(env);
    const recordPath = path.join(directory, ".shim-record.json");
    if (!existsSync(recordPath)) return undefined;
    const shims = JSON.parse(readFileSync(recordPath, "utf8")).shims;
    const migration: MigrationRecord = { schema: 1, id: randomUUID(), integrationSchema: 1, entries: [] };
    const writes: Array<{ entry: MigrationEntry; contents: string }> = [];
    for (const tool of Object.keys(SHIM_TOOLS) as ShimTool[]) {
      const recorded = shims?.[tool];
      if (!recorded || typeof recorded.realBin !== "string" || !path.isAbsolute(recorded.realBin)) continue;
      const target = path.join(directory, SHIM_TOOLS[tool].shimName);
      // A removed/deselected tool stays removed. A foreign file is never adopted by a marker alone.
      if (!existsSync(target)) continue;
      if (lstatSync(target).isSymbolicLink()
        || path.dirname(realpathSync(target)) !== realpathSync(directory)) throw new Error("Refusing to migrate a linked shim");
      const before = readFileSync(target, "utf8");
      const after = generateShimScript(tool, recorded.realBin, receipt.launcherPath);
      if (before === after) continue;
      if (before !== generateShimScript(tool, recorded.realBin)) throw new Error("Owned shim has foreign edits; integration migration deferred");
      const backup = path.join(root, "backups", `${migration.id}-${SHIM_TOOLS[tool].shimName}`);
      atomicWrite(backup, before, 0o600);
      const entry: MigrationEntry = { target, backup, before: sha256(before), after: sha256(after), status: "prepared" };
      migration.entries.push(entry);
      writes.push({ entry, contents: after });
    }
    if (writes.length === 0) return undefined;
    const journal = path.join(root, "migrations", `${migration.id}.json`);
    atomicWrite(journal, JSON.stringify(migration) + "\n");
    for (const { entry, contents } of writes) {
      if (sha256(readFileSync(entry.target)) !== entry.before) throw new Error("Integration changed during migration");
      atomicWrite(entry.target, contents, 0o755);
      entry.status = "written";
      atomicWrite(journal, JSON.stringify(migration) + "\n");
    }
    return migration.id;
  });
}

/** Compare-before-inverse: later foreign edits stay intact, with a recorded conflict. */
export async function rollbackIntegrationMigration(root: string, id: string): Promise<{ reverted: number; conflicts: number }> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid migration identity");
  return withManagedLock(root, () => {
    const { receipt } = loadManagedInstallation(root, false);
    const journal = path.join(root, "migrations", `${id}.json`);
    const migration = JSON.parse(readFileSync(journal, "utf8")) as MigrationRecord;
    if (migration.schema !== 1 || migration.id !== id) throw new Error("Invalid migration journal");
    let reverted = 0, conflicts = 0;
    for (const entry of [...migration.entries].reverse()) {
      if (!existsSync(entry.target)) continue;
      const tool = (Object.keys(SHIM_TOOLS) as ShimTool[]).find((candidate) => SHIM_TOOLS[candidate].shimName === path.basename(entry.target));
      const recordPath = path.join(path.dirname(entry.target), ".shim-record.json");
      const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : undefined;
      const selected = tool ? record?.shims?.[tool] : undefined;
      if (!selected) continue; // A disconnected tool is not restored by an update rollback.
      if (!tool || typeof selected.realBin !== "string" || !path.isAbsolute(selected.realBin)
        || lstatSync(entry.target).isSymbolicLink()
        || !containedPath(realpathSync(path.join(root, "backups")), realpathSync(entry.backup))
        || entry.before !== sha256(generateShimScript(tool, selected.realBin))
        || entry.after !== sha256(generateShimScript(tool, selected.realBin, receipt.launcherPath))) {
        entry.status = "conflict"; conflicts++; continue;
      }
      const actual = sha256(readFileSync(entry.target));
      if (actual === entry.before) { entry.status = "reverted"; continue; }
      if (actual !== entry.after || sha256(readFileSync(entry.backup)) !== entry.before) {
        entry.status = "conflict"; conflicts++;
      } else {
        atomicWrite(entry.target, readFileSync(entry.backup), 0o755);
        entry.status = "reverted"; reverted++;
      }
      atomicWrite(journal, JSON.stringify(migration) + "\n");
    }
    atomicWrite(journal, JSON.stringify(migration) + "\n");
    return { reverted, conflicts };
  });
}
