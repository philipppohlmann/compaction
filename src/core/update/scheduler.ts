import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readUpdatePreferences } from "../onboarding-preferences.js";
import { loadManagedInstallation } from "./ownership.js";
import { atomicWrite, withManagedLock } from "./state.js";
import type { UpdateChannel } from "./registry.js";

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
interface UpdateCheck { schema: 1; checkedAt: number; channel: UpdateChannel; candidate?: string; pairId?: string; notified?: string }
function cachePath(root: string): string { return path.join(root, "update-check.json"); }
function readCheck(root: string): UpdateCheck | undefined {
  try {
    const value = JSON.parse(readFileSync(cachePath(root), "utf8"));
    if (value.schema !== 1 || !Number.isFinite(value.checkedAt) || value.checkedAt < 0 ||
        !["stable", "preview"].includes(value.channel)) return undefined;
    for (const field of ["candidate", "pairId", "notified"]) {
      if (value[field] !== undefined && (typeof value[field] !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/.test(value[field]))) return undefined;
    }
    return { schema: 1, checkedAt: value.checkedAt, channel: value.channel,
      ...(value.candidate ? { candidate: value.candidate } : {}), ...(value.pairId ? { pairId: value.pairId } : {}), ...(value.notified ? { notified: value.notified } : {}) };
  } catch { return undefined; }
}
export function automaticUpdatesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMPACTION_AUTO_UPDATE !== "0" && !env.CI && readUpdatePreferences(env).autoUpdates;
}

/** Exclusive attempt reservation, shared by concurrent top-level launches. No network occurs here. */
export async function reserveUpdateCheck(root: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<boolean> {
  if (!automaticUpdatesEnabled(env)) return false;
  try {
    return await withManagedLock(root, () => {
      loadManagedInstallation(root, false);
      const previous = readCheck(root);
      if (previous && now - previous.checkedAt < UPDATE_CHECK_TTL_MS) return false;
      const channel = readUpdatePreferences(env).channel;
      atomicWrite(cachePath(root), JSON.stringify({ ...previous, schema: 1, checkedAt: now, channel }) + "\n");
      return true;
    }, 30);
  } catch { return false; }
}

/** Returns immediately. Reservation and the quiet bounded worker never delay command dispatch. */
export function maybeScheduleUpdate(root: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!automaticUpdatesEnabled(env)) return;
  void reserveUpdateCheck(root, env).then((reserved) => {
    if (!reserved) return;
    const child = spawn(process.execPath, [fileURLToPath(new URL("./worker.js", import.meta.url)), root], {
      detached: true, stdio: "ignore", env: {
        PATH: env.PATH ?? "/usr/bin:/bin", HOME: env.HOME,
        COMPACTION_CONFIG_DIR: path.dirname(root), COMPACTION_HOME: path.dirname(root),
        COMPACTION_UPDATE_WORKER: "1"
      }
    });
    child.once("error", () => {});
    child.unref();
  }).catch(() => {});
}

export async function rememberUpdateCandidate(root: string, version: string, pairId?: string): Promise<void> {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/.test(version)) return;
  if (pairId !== undefined && !/^[0-9a-f]{64}$/.test(pairId)) return;
  await withManagedLock(root, () => {
    const previous = readCheck(root);
    if (previous) {
      const { pairId: _oldPair, ...retained } = previous;
      atomicWrite(cachePath(root), JSON.stringify({ ...retained, candidate: version, ...(pairId ? { pairId } : {}),
        ...(pairId && previous.notified === version ? { notified: pairId } : {}) }) + "\n");
    }
  });
}

/** Called only by a human-facing terminal boundary; hooks never call this function. */
export async function consumeUpdateNotice(root: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (!automaticUpdatesEnabled(env)) return undefined;
  try {
    return await withManagedLock(root, () => {
      const previous = readCheck(root);
      if (!previous?.candidate || previous.notified === (previous.pairId ?? previous.candidate)) return undefined;
      const { state } = loadManagedInstallation(root);
      let notice: string;
      if (previous.pairId === state.current.id) notice = `Compaction ${previous.candidate} is now active.`;
      else if (state.staged && state.staged.cli.version === previous.candidate && (!previous.pairId || previous.pairId === state.staged.id)) {
        notice = `Compaction ${previous.candidate} is staged for a safe next session.`;
      } else if (previous.pairId) return undefined; // Removed/rolled-back candidates never generate a stale ready notice.
      else notice = `Compaction ${previous.candidate} is available; run compaction update to inspect or stage it.`;
      atomicWrite(cachePath(root), JSON.stringify({ ...previous, notified: previous.pairId ?? previous.candidate }) + "\n");
      return notice;
    }, 30);
  } catch { return undefined; }
}
