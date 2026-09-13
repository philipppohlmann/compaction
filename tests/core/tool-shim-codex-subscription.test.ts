import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateShimScript } from "../../src/core/tool-shim.js";

describe("normal Codex shim subscription routing", () => {
  let dir: string;
  let real: string;
  let shim: string;
  let compaction: string;
  let gatewayCalls: string;
  let realCalls: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "codex-route-shim-"));
    mkdirSync(dir, { recursive: true });
    real = path.join(dir, "real-codex");
    shim = path.join(dir, "codex");
    compaction = path.join(dir, "compaction");
    gatewayCalls = path.join(dir, "gateway-calls");
    realCalls = path.join(dir, "real-calls");
    writeFileSync(real, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(realCalls)}\ncat\nexit 7\n`, "utf8");
    writeFileSync(compaction, `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(gatewayCalls)}
case "$1" in
  gateway)
    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
    [ "$#" -gt 0 ] && shift
    exec "$@"
    ;;
  precall) exit 1 ;;
  capture) exit 0 ;;
esac
exit 1
`, "utf8");
    writeFileSync(shim, generateShimScript("codex", real), "utf8");
    for (const file of [real, compaction, shim]) chmodSync(file, 0o755);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(args: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(shim, args, {
      input: "stdin-sentinel",
      encoding: "utf8",
      env: { PATH: process.env.PATH, COMPACTION_BIN: compaction, ...env }
    });
  }

  it("routes every normal invocation once and preserves argv/stdin/stdout/exit", () => {
    const result = run(["exec", "prompt with spaces"]);
    expect(result.status).toBe(7);
    expect(result.stdout).toBe("stdin-sentinel");
    expect(readFileSync(gatewayCalls, "utf8").trim()).toContain("gateway run --provider openai --workflow codex --subscription --");
    expect(readFileSync(gatewayCalls, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(realCalls, "utf8").trim()).toBe("exec prompt with spaces");
    expect(readFileSync(realCalls, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("an environment override preserves legacy measurable tee/capture without Gateway routing", () => {
    const result = run(["exec", "--json", "hello"], { OPENAI_BASE_URL: "http://127.0.0.1:9999/v1" });
    expect(result.status).toBe(7);
    const calls = readFileSync(gatewayCalls, "utf8").trim().split("\n");
    expect(calls.some((call) => call.startsWith("gateway "))).toBe(false);
    expect(calls.some((call) => call.startsWith("precall codex"))).toBe(true);
    expect(calls.some((call) => call.startsWith("capture codex"))).toBe(true);
    expect(readFileSync(realCalls, "utf8").trim()).toBe("exec --json hello");
  });

  it("passes through unchanged when Codex argv already selects a provider/base", () => {
    for (const args of [
      ["-c", 'model_provider="custom"', "exec", "hello"],
      ["--config", 'model_providers.custom.base_url="http://127.0.0.1:9"', "exec", "hello"]
    ]) {
      const result = run(args);
      expect(result.status).toBe(7);
    }
    expect(existsSync(gatewayCalls)).toBe(false);
    expect(readFileSync(realCalls, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("an unavailable Compaction launcher fails open through the legacy measurable real-child path", () => {
    const result = run(["exec", "--json", "hello"], { COMPACTION_BIN: path.join(dir, "missing-compaction") });
    expect(result.status).toBe(7);
    expect(result.stdout).toBe("stdin-sentinel");
    expect(existsSync(gatewayCalls)).toBe(false);
    expect(readFileSync(realCalls, "utf8").trim()).toBe("exec --json hello");
  });
});

describe("normal Codex shim respects a user's own config.toml route", () => {
  let dir: string;
  let real: string;
  let shim: string;
  let compaction: string;
  let gatewayCalls: string;
  let realCalls: string;
  let codexHome: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "codex-route-cfg-shim-"));
    mkdirSync(dir, { recursive: true });
    real = path.join(dir, "real-codex");
    shim = path.join(dir, "codex");
    compaction = path.join(dir, "compaction");
    gatewayCalls = path.join(dir, "gateway-calls");
    realCalls = path.join(dir, "real-calls");
    codexHome = path.join(dir, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(real, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(realCalls)}\ncat\nexit 7\n`, "utf8");
    writeFileSync(compaction, `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(gatewayCalls)}
case "$1" in
  gateway)
    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
    [ "$#" -gt 0 ] && shift
    exec "$@"
    ;;
  precall) exit 1 ;;
  capture) exit 0 ;;
esac
exit 1
`, "utf8");
    writeFileSync(shim, generateShimScript("codex", real), "utf8");
    for (const file of [real, compaction, shim]) chmodSync(file, 0o755);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeConfig(contents: string): void {
    writeFileSync(path.join(codexHome, "config.toml"), contents, "utf8");
  }

  function writeProfileConfig(name: string, contents: string): void {
    writeFileSync(path.join(codexHome, `${name}.config.toml`), contents, "utf8");
  }

  function run(args: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(shim, args, {
      input: "stdin-sentinel",
      encoding: "utf8",
      env: { PATH: process.env.PATH, COMPACTION_BIN: compaction, CODEX_HOME: codexHome, ...env }
    });
  }

  it("a user's own top-level model_provider in config.toml is NOT overridden - routes unrouted", () => {
    writeConfig(`# Personal Codex config - my company's own gateway
model_provider = "myenterprise"

[model_providers.myenterprise]
name = "My Enterprise Gateway"
base_url = "https://codex.mycompany.internal/v1"
wire_api = "responses"

[history]
persistence = "save-all"
`);
    const result = run(["exec", "hello"]);
    expect(result.status).toBe(7);
    expect(existsSync(gatewayCalls)).toBe(false);
    expect(readFileSync(realCalls, "utf8").trim()).toBe("exec hello");
  });

  it("no config.toml at all - current (routed) behavior, fail open", () => {
    const result = run(["exec", "prompt"]);
    expect(result.status).toBe(7);
    expect(readFileSync(gatewayCalls, "utf8").trim()).toContain("gateway run --provider openai --workflow codex --subscription --");
  });

  it("an unreadable config.toml - current (routed) behavior, fail open", () => {
    writeConfig('model_provider = "myenterprise"\n');
    chmodSync(path.join(codexHome, "config.toml"), 0o000);
    try {
      const result = run(["exec", "prompt"]);
      expect(result.status).toBe(7);
      expect(readFileSync(gatewayCalls, "utf8").trim()).toContain("gateway run --provider openai --workflow codex --subscription --");
    } finally {
      chmodSync(path.join(codexHome, "config.toml"), 0o644);
    }
  });

  it("a malformed config.toml - current (routed) behavior, fail open, never crashes the shim", () => {
    writeConfig("this is not [ valid toml at all\nmodel_provider\n=== broken ===\n");
    const result = run(["exec", "prompt"]);
    expect(result.status).toBe(7);
    expect(readFileSync(gatewayCalls, "utf8").trim()).toContain("gateway run --provider openai --workflow codex --subscription --");
  });

  it("CODEX_HOME is honored - a config.toml only at the CODEX_HOME path is detected", () => {
    const altHome = path.join(dir, "alt-codex-home");
    mkdirSync(altHome, { recursive: true });
    writeFileSync(path.join(altHome, "config.toml"), 'model_provider = "myenterprise"\n', "utf8");
    // codexHome (the default CODEX_HOME set by run()) has NO config.toml - only altHome does.
    const viaDefault = run(["exec", "--json", "hello"]);
    expect(viaDefault.status).toBe(7);
    expect(readFileSync(gatewayCalls, "utf8").trim()).toContain("gateway run --provider openai --workflow codex --subscription --");
    rmSync(gatewayCalls, { force: true });
    rmSync(realCalls, { force: true });
    const viaAlt = run(["exec", "hello"], { CODEX_HOME: altHome });
    expect(viaAlt.status).toBe(7);
    expect(existsSync(gatewayCalls)).toBe(false);
  });

  it("a custom [model_providers.*] block that is never SELECTED by a top-level model_provider does not override - still routes", () => {
    writeConfig(`# Custom provider defined but not selected as the active one
[model_providers.myenterprise]
name = "My Enterprise Gateway"
base_url = "https://codex.mycompany.internal/v1"

[history]
persistence = "save-all"
`);
    const result = run(["exec", "prompt"]);
    expect(result.status).toBe(7);
    expect(readFileSync(gatewayCalls, "utf8").trim()).toContain("gateway run --provider openai --workflow codex --subscription --");
  });

  it("model_provider set only inside a [profiles.*] table (not top-level) does not override - still routes", () => {
    writeConfig(`[profiles.work]
model_provider = "myenterprise"

[model_providers.myenterprise]
base_url = "https://internal/v1"
`);
    const result = run(["exec", "prompt"]);
    expect(result.status).toBe(7);
    expect(readFileSync(gatewayCalls, "utf8").trim()).toContain("gateway run --provider openai --workflow codex --subscription --");
  });

  it.each([
    ["short separated", ["-p", "work", "exec", "hello"]],
    ["long separated", ["--profile", "work", "exec", "hello"]],
    ["short equals", ["-p=work", "exec", "hello"]],
    ["long equals", ["--profile=work", "exec", "hello"]]
  ])("a selected profile route (%s) is preserved unrouted", (_label, args) => {
    writeProfileConfig("work", `model_provider = "myenterprise"

[model_providers.myenterprise]
base_url = "https://internal/v1"
`);
    const result = run(args);
    expect(result.status).toBe(7);
    expect(existsSync(gatewayCalls)).toBe(false);
    expect(readFileSync(realCalls, "utf8").trim()).toBe(args.join(" "));
  });

  it("only the selected profile is inspected; an unselected profile route does not disable subscription routing", () => {
    writeProfileConfig("work", 'model_provider = "myenterprise"\n');
    writeProfileConfig("plain", 'model = "gpt-5"\n');
    const result = run(["--profile", "plain", "exec", "hello"]);
    expect(result.status).toBe(7);
    expect(readFileSync(gatewayCalls, "utf8").trim()).toContain("gateway run --provider openai --workflow codex --subscription --");
  });

  it.each([
    ["missing profile value", ["--profile"]],
    ["empty long profile value", ["--profile=", "exec", "hello"]],
    ["empty short profile value", ["-p=", "exec", "hello"]],
    ["missing selected file", ["--profile", "missing", "exec", "hello"]],
    ["unsafe selected name", ["--profile", "../outside", "exec", "hello"]]
  ])("an ambiguous profile selection (%s) fails open unrouted", (_label, args) => {
    const result = run(args);
    expect(result.status).toBe(7);
    expect(existsSync(gatewayCalls)).toBe(false);
    expect(readFileSync(realCalls, "utf8").trim()).toBe(args.join(" "));
  });

  it.each([
    ["--oss", ["--oss", "exec", "hello"]],
    ["--local-provider separated", ["--local-provider", "ollama", "exec", "hello"]],
    ["--local-provider equals", ["--local-provider=ollama", "exec", "hello"]]
  ])("a local route declaration (%s) is preserved unrouted", (_label, args) => {
    const result = run(args);
    expect(result.status).toBe(7);
    expect(existsSync(gatewayCalls)).toBe(false);
    expect(readFileSync(realCalls, "utf8").trim()).toBe(args.join(" "));
  });

  it("our own provider id already present (model_provider = compaction_subscription) is NOT treated as an override - still routes", () => {
    writeConfig(`model_provider = "compaction_subscription"

[model_providers.compaction_subscription]
name = "Compaction ChatGPT subscription"
`);
    const result = run(["exec", "prompt"]);
    expect(result.status).toBe(7);
    expect(readFileSync(gatewayCalls, "utf8").trim()).toContain("gateway run --provider openai --workflow codex --subscription --");
  });

  it("a single-quoted top-level model_provider value is also detected as an override", () => {
    writeConfig("model_provider = 'myenterprise'\n");
    const result = run(["exec", "prompt"]);
    expect(result.status).toBe(7);
    expect(existsSync(gatewayCalls)).toBe(false);
  });
});

describe("normal Codex shim respects an OpenAI API key already configured", () => {
  let dir: string;
  let real: string;
  let shim: string;
  let compaction: string;
  let gatewayCalls: string;
  let realCalls: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "codex-route-key-shim-"));
    mkdirSync(dir, { recursive: true });
    real = path.join(dir, "real-codex");
    shim = path.join(dir, "codex");
    compaction = path.join(dir, "compaction");
    gatewayCalls = path.join(dir, "gateway-calls");
    realCalls = path.join(dir, "real-calls");
    writeFileSync(real, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(realCalls)}\ncat\nexit 7\n`, "utf8");
    writeFileSync(compaction, `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(gatewayCalls)}
case "$1" in
  gateway)
    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
    [ "$#" -gt 0 ] && shift
    exec "$@"
    ;;
  precall) exit 1 ;;
  capture) exit 0 ;;
esac
exit 1
`, "utf8");
    writeFileSync(shim, generateShimScript("codex", real), "utf8");
    for (const file of [real, compaction, shim]) chmodSync(file, 0o755);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(args: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(shim, args, {
      input: "stdin-sentinel",
      encoding: "utf8",
      env: { PATH: process.env.PATH, COMPACTION_BIN: compaction, ...env }
    });
  }

  it("checks whether OpenAI key variables are declared without expanding their values", () => {
    const generated = readFileSync(shim, "utf8");
    expect(generated).toContain("${OPENAI_API_KEY+x}");
    expect(generated).toContain("${OPENAI_KEY+x}");
    expect(generated).not.toContain("${OPENAI_API_KEY:-}");
    expect(generated).not.toContain("${OPENAI_KEY:-}");
  });

  it("OPENAI_API_KEY present - routes unrouted rather than forcing the ChatGPT-subscription route", () => {
    const result = run(["exec", "hello"], { OPENAI_API_KEY: "sk-fake-not-a-real-key" });
    expect(result.status).toBe(7);
    expect(existsSync(gatewayCalls)).toBe(false);
    expect(readFileSync(realCalls, "utf8").trim()).toBe("exec hello");
  });

  it("OPENAI_KEY present - routes unrouted rather than forcing the ChatGPT-subscription route", () => {
    const result = run(["exec", "hello"], { OPENAI_KEY: "sk-fake-not-a-real-key" });
    expect(result.status).toBe(7);
    expect(existsSync(gatewayCalls)).toBe(false);
  });

  it.each(["OPENAI_API_KEY", "OPENAI_KEY"])(
    "%s declared empty still preserves the user's auth route",
    (variable) => {
      const result = run(["exec", "hello"], { [variable]: "" });
      expect(result.status).toBe(7);
      expect(existsSync(gatewayCalls)).toBe(false);
      expect(readFileSync(realCalls, "utf8").trim()).toBe("exec hello");
    }
  );

  it("no API key present - routes through the Gateway as before", () => {
    const result = run(["exec", "prompt"]);
    expect(result.status).toBe(7);
    expect(readFileSync(gatewayCalls, "utf8").trim()).toContain("gateway run --provider openai --workflow codex --subscription --");
  });
});
