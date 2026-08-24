import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

describe("Claude subscription pre-child fail-open", () => {
  let blocker: Server | undefined;
  let cwd = "";
  afterEach(async () => {
    if (blocker) await new Promise<void>((done) => blocker!.close(() => done()));
    blocker = undefined;
    if (cwd) rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it.each([
    ["public --subscription flag", "subscription"],
    ["internal spelling (same transport)", "internalClaudeSubscription"]
  ] as const)("runs the original argv and auth environment unchanged when the ephemeral Gateway cannot bind (%s)", async (_label, flag) => {
    blocker = createServer((_req, res) => res.end("occupied"));
    const port = await new Promise<number>((done) => blocker!.listen(0, "127.0.0.1", () => done((blocker!.address() as { port: number }).port)));
    cwd = mkdtempSync(join(tmpdir(), "claude-sub-fail-open-"));
    const moduleUrl = pathToFileURL(resolve("dist/cli/commands/dev.js")).href;
    // The public flag routes only a `claude`-named binary, so the fail-open probe IS a fake claude:
    // a shebang wrapper that prints its argv + auth environment exactly as the vendor CLI would see them.
    const claudePath = join(cwd, "claude");
    writeFileSync(
      claudePath,
      "#!/usr/bin/env node\nconsole.log(JSON.stringify({argv:process.argv.slice(2),base:process.env.ANTHROPIC_BASE_URL,key:process.env.ANTHROPIC_API_KEY,token:process.env.ANTHROPIC_AUTH_TOKEN,config:process.env.CLAUDE_CONFIG_DIR}))\n",
      "utf8"
    );
    chmodSync(claudePath, 0o755);
    const script =
      `import(${JSON.stringify(moduleUrl)}).then(({runThroughGateway})=>` +
      `runThroughGateway([${JSON.stringify(claudePath)},"ORIGINAL_ARG"],{provider:"anthropic",workflow:"claude-code",listen:${JSON.stringify(`http://127.0.0.1:${port}`)},${flag}:true}))`;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(process.execPath, ["-e", script], {
        cwd,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: "ORIGINAL_BASE_SENTINEL",
          ANTHROPIC_API_KEY: "ORIGINAL_KEY_SENTINEL",
          ANTHROPIC_AUTH_TOKEN: "ORIGINAL_TOKEN_SENTINEL",
          CLAUDE_CONFIG_DIR: "ORIGINAL_CONFIG_SENTINEL"
        }
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("exit", (code) => done({ code, stdout, stderr }));
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/running the original Claude Code command unchanged/i);
    const observed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(observed).toEqual({
      argv: ["ORIGINAL_ARG"],
      base: "ORIGINAL_BASE_SENTINEL",
      key: "ORIGINAL_KEY_SENTINEL",
      token: "ORIGINAL_TOKEN_SENTINEL",
      config: "ORIGINAL_CONFIG_SENTINEL"
    });
  }, 20000);
});
