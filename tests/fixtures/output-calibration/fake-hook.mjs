#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [auditDir, stateDir, driver, treatmentSha, treatmentBytes] = process.argv.slice(2);
const countPath = join(stateDir, "count.txt");
const invocations = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;
writeFileSync(countPath, String(invocations), { mode: 0o600 });
writeFileSync(join(auditDir, "hook-audit.json"), `${JSON.stringify({
  invocation_count: invocations,
  treatment_sha256: treatmentSha,
  treatment_bytes: Number(treatmentBytes),
  marker_count: 1,
  hook_event: "UserPromptSubmit",
  valid: true,
  driver_present: Boolean(driver)
})}\n`, { mode: 0o600 });
