import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { addSessionOwner } from "./sessions.js";
import { identifyProcess } from "./process-identity.js";

// The child may outlive its parent. Until the parent's durable registration, no tool is started.
let admitted = false;
process.once("disconnect", () => { if (!admitted) process.exit(125); });
process.send?.({ ready: true });
process.once("message", async (message: { root: string; id: string; command: string; args: string[] }) => {
  admitted = true;
  let child: ReturnType<typeof spawn> | undefined;
  let processGroup: number | undefined;
  try {
    // Bash job control creates a distinct process group without setsid, preserving /dev/tty.
    // The inner shell cannot exec until its actual PID is durably admitted by this supervisor.
    const gate = 'exec 4>&-; IFS= read -r __compaction_go <&3 || exit 125; [ "$__compaction_go" = go ] || exit 125; exec 3<&-; exec "$@"';
    child = spawn("/bin/bash", ["-c", 'set -m; /bin/bash -c "$1" compaction-session "${@:2}" & __pid=$!; printf "%s\\n" "$__pid" >&4; exec 4>&-; fg %1 >/dev/null 2>&1; exit $?',
      "compaction-session-owner", gate, message.command, ...message.args], { stdio: ["inherit", "inherit", "inherit", "pipe", "pipe"], env: process.env });
    const started = child;
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(signal, () => { try { if (processGroup) process.kill(-processGroup, signal); else started.kill(signal); } catch { /* Already gone. */ } });
    }
    const result = new Promise<number>((resolve, reject) => {
      started.once("error", reject);
      started.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)));
    });
    processGroup = await new Promise<number>((resolve, reject) => {
      let line = "";
      const identity = started.stdio[4] as Readable;
      const timer = setTimeout(() => reject(new Error("Tool identity handshake timed out")), 5_000);
      timer.unref();
      identity.on("data", (bytes) => {
        line += bytes.toString();
        if (!line.includes("\n")) return;
        clearTimeout(timer);
        if (!/^\d+\n$/.test(line) || !Number.isSafeInteger(Number(line.trim())) || Number(line.trim()) <= 0) reject(new Error("Invalid tool identity handshake"));
        else resolve(Number(line.trim()));
      });
      identity.once("end", () => { clearTimeout(timer); reject(new Error("Tool identity handshake ended")); });
      identity.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    await addSessionOwner(message.root, message.id, identifyProcess(processGroup), processGroup);
    // The actual exec PID is durable before this byte permits exec; EOF on a crash forbids exec.
    (started.stdio[3] as Writable).end("go\n");
    process.exitCode = await result;
  } catch {
    if (processGroup) { try { process.kill(-processGroup, "SIGTERM"); } catch { /* Already gone. */ } }
    child?.kill();
    process.exitCode = 125;
  } finally { if (process.connected) process.disconnect(); }
});
