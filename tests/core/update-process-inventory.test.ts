import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateShimScript } from "../../src/core/tool-shim.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function inspect(body: string): unknown {
  const home = mkdtempSync(path.join(tmpdir(), "compaction-inventory-")); roots.push(home);
  const launcher = path.join(home, "compaction"), script = path.join(home, "tool.cjs"), shims = path.join(home, "shims");
  mkdirSync(shims);
  writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(script, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);\n");
  writeFileSync(path.join(shims, "codex"), generateShimScript("codex", script, launcher));
  writeFileSync(path.join(shims, ".shim-record.json"), JSON.stringify({ shims: { codex: { realBin: script } } }));
  const probe = path.join(home, "inspect.mjs");
  writeFileSync(probe, `
    import { execFileSync, spawn } from "node:child_process";
    import { readlinkSync } from "node:fs";
    import { once } from "node:events";
    import { hasUntrackedToolProcessesForLauncher } from ${JSON.stringify(pathToFileURL(path.join(project, "dist/core/update/process-identity.js")).href)};
    import { readToolProcessMetadata } from ${JSON.stringify(pathToFileURL(path.join(project, "dist/core/update/process-metadata.js")).href)};
    const launcher = ${JSON.stringify(launcher)}, script = ${JSON.stringify(script)};
    const env = { HOME: ${JSON.stringify(home)}, PATH: ${JSON.stringify(`${home}:/usr/bin:/bin`)}, COMPACTION_SHIM_DIR: ${JSON.stringify(shims)} };
    function trackedExcept(...others) {
      const uid = process.getuid();
      return new Set(execFileSync("/bin/ps", ["-axo", "uid=,ruid=,pid="], { encoding: "utf8" }).trim().split("\\n").flatMap(row => {
        const match = /^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*$/.exec(row);
        if (!match) throw new Error("invalid fixture inventory");
        const pid = Number(match[3]);
        return Number(match[1]) === uid && Number(match[2]) === uid && pid !== process.pid && !others.includes(pid) ? [pid] : [];
      }));
    }
    const selfUnknown = readToolProcessMetadata([process.pid], [{ path: script, tool: "codex" }]) === undefined;
    ${body}
  `);
  // This valid Node flag deliberately falls outside the external-interpreter parser's grammar.
  const result = spawnSync(process.execPath, ["--trace-exit", probe], {
    env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024,
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

it.skipIf(process.platform !== "linux")("excludes only the coordinator's own PID from the real Linux inventory", () => {
  expect(inspect(`
    const blocked = hasUntrackedToolProcessesForLauncher(launcher, trackedExcept(), env);
    process.stdout.write(JSON.stringify({ selfUnknown, blocked }));
  `)).toEqual({ selfUnknown: true, blocked: false });
});

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("keeps an external inspection-denied live PID blocking at the scanner boundary", () => {
  expect(inspect(`
    const child = spawn("/usr/bin/perl", ["-e", "$|=1; exit 3 if syscall(157,4,0,0,0,0) != 0; print qq(ready\\n); my $line=<STDIN>;"],
      { env: { HOME: "/tmp", PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "ignore"] });
    const ended = once(child, "exit");
    let timer;
    try {
      await Promise.race([once(child.stdout, "data"), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("fixture readiness timeout")), 5000);
      })]);
      let denied = false;
      try { readlinkSync("/proc/" + child.pid + "/exe"); } catch (error) { denied = error.code === "EACCES"; }
      const blocked = hasUntrackedToolProcessesForLauncher(launcher, trackedExcept(child.pid), env);
      process.stdout.write(JSON.stringify({ selfUnknown, external: child.pid !== process.pid, denied, blocked }));
    } finally { clearTimeout(timer); child.stdin.end(); child.kill("SIGKILL"); await ended; }
  `)).toEqual({ selfUnknown: true, external: true, denied: true, blocked: true });
});
