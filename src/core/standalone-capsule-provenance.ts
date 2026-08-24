import { access, readFile } from "node:fs/promises";
import type { StateCapsule, StateCapsuleProvenanceEntry } from "./types.js";

export type StandaloneCapsuleProvenanceStatus = "complete" | "partial" | "missing" | "unknown";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function hasCompleteEntry(entry: StateCapsuleProvenanceEntry): boolean {
  return (
    typeof entry.source_trace_id === "string" &&
    entry.source_trace_id.length > 0 &&
    typeof entry.source_message_id === "string" &&
    entry.source_message_id.length > 0 &&
    typeof entry.source_pointer === "string" &&
    entry.source_pointer.length > 0 &&
    typeof entry.source_hash === "string" &&
    entry.source_hash.length > 0 &&
    entry.source_hash_algorithm === "sha256" &&
    entry.source_recoverable === true &&
    typeof entry.source_recovery_path === "string" &&
    entry.source_recovery_path.length > 0
  );
}

export function statusFromStateCapsule(capsule: StateCapsule): StandaloneCapsuleProvenanceStatus {
  const entries = capsule.provenance_entries ?? [];
  const topLevelComplete = hasCompleteEntry({
    source_trace_id: capsule.source_trace_id,
    source_message_id: capsule.source_message_id,
    source_pointer: capsule.source_pointer,
    source_hash: capsule.source_hash,
    source_hash_algorithm: capsule.source_hash_algorithm,
    source_recoverable: capsule.source_recoverable ?? "unknown",
    source_recovery_path: capsule.source_recovery_path,
    original_payload_token_count: capsule.original_payload_token_count,
    capsule_token_count: capsule.capsule_token_count
  });

  if (topLevelComplete && entries.length > 0 && entries.every(hasCompleteEntry)) {
    return "complete";
  }

  if (topLevelComplete || entries.length > 0 || capsule.source_recoverable === true || capsule.source_recoverable === "unknown") {
    return "partial";
  }

  return "missing";
}

export async function readStandaloneCapsuleProvenanceStatus(capsulePath: string | null | undefined): Promise<StandaloneCapsuleProvenanceStatus> {
  if (!capsulePath) return "missing";
  if (!(await fileExists(capsulePath))) return "missing";

  try {
    const capsule = JSON.parse(await readFile(capsulePath, "utf8")) as StateCapsule;
    if (typeof capsule !== "object" || capsule === null || Array.isArray(capsule)) {
      return "unknown";
    }
    return statusFromStateCapsule(capsule);
  } catch {
    return "unknown";
  }
}
