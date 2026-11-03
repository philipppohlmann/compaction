#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message) => { process.stderr.write(`${message}\n`); process.exit(64); };
const args = process.argv.slice(2);
if (process.env.CALIBRATION_SPAWNED_STUB) {
  if (process.argv[1] !== process.env.CALIBRATION_SPAWNED_STUB) fail("stub boundary path failed");
  if (!process.env.CALIBRATION_CAPTURED_EXECUTABLE || process.env.CALIBRATION_CAPTURED_EXECUTABLE !== process.env.CALIBRATION_EXPECTED_PROVIDER || process.env.CALIBRATION_CAPTURED_EXECUTABLE === process.env.CALIBRATION_SPAWNED_STUB) fail("captured executable identity failed");
}
const requiredFlags = ["--no-daemon", "exec", "--json", "--ephemeral", "--model", "--sandbox", "--cd", "--color", "--output-last-message", "-"];
if (!requiredFlags.every((value) => args.includes(value))) fail("argv contract failed");
if (!process.env.HOME || !process.env.CODEX_HOME || !process.env.TMPDIR || !process.env.PATH || !process.env.USER || !process.env.LOGNAME || !process.env.SHELL) fail("environment contract failed");

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
if (!process.env.CALIBRATION_PROMPT_SHA256 || sha(Buffer.from(prompt, "utf8")) !== process.env.CALIBRATION_PROMPT_SHA256) fail("stdin contract failed");

const scenario = process.env.CALIBRATION_FAKE_SCENARIO ?? "valid";
const patch = process.env.CALIBRATION_CONTROLLER_PATCH;
if (!patch || sha(readFileSync(patch)) !== process.env.CALIBRATION_CONTROLLER_PATCH_SHA256) fail("controller patch identity failed");
if (process.env.CALIBRATION_CONTROLLER_PATCH_KIND === "git-apply") {
  const applied = spawnSync("git", ["apply", "--whitespace=nowarn", patch], {
    cwd: process.env.CALIBRATION_TASK_ROOT,
    env: process.env,
    encoding: "utf8"
  });
  if (applied.status !== 0) fail("controller patch apply failed");
} else {
  copyFileSync(patch, join(process.env.CALIBRATION_TASK_ROOT, "src", "value.txt"));
}
if (scenario === "oracle-failure") {
  if (process.env.CALIBRATION_CONTROLLER_PATCH_KIND === "git-apply") process.exit(65);
  writeFileSync(join(process.env.CALIBRATION_TASK_ROOT, "src", "value.txt"), "almost\n");
}

if (scenario === "mutate-normal-config") writeFileSync(process.env.CALIBRATION_NORMAL_CONFIG, "child-secret-content\n");
if (scenario === "mutate-normal-hooks") writeFileSync(process.env.CALIBRATION_NORMAL_HOOKS, "child-secret-content\n");
if (scenario === "mutate-isolated-config") writeFileSync(process.env.CALIBRATION_ISOLATED_CONFIG, "child-secret-content\n");
if (scenario === "mutate-isolated-manifest") writeFileSync(process.env.CALIBRATION_ISOLATED_MANIFEST, "child-secret-content\n");
if (scenario === "mutate-isolated-auth") writeFileSync(process.env.CALIBRATION_ISOLATED_AUTH, "child-secret-content\n");

const treatmentEnabled = args.some((value) => value.startsWith("hooks.UserPromptSubmit="));
if (treatmentEnabled && scenario !== "treatment-mismatch") {
  const count = scenario === "multiple-treatment" ? 2 : 1;
  for (let index = 0; index < count; index += 1) {
    const hookInput = `${JSON.stringify({
      session_id: "11111111-1111-4111-8111-111111111111",
      turn_id: "22222222-2222-4222-8222-222222222222",
      cwd: process.env.CALIBRATION_TASK_ROOT,
      hook_event_name: "UserPromptSubmit",
      prompt: "provider-free exact treatment identity check"
    })}\n`;
    const hook = spawnSync(process.env.SHELL, ["-lc", process.env.CALIBRATION_HOOK_COMMAND], { encoding: "utf8", input: hookInput });
    if (hook.status !== 0) fail("hook invocation failed");
  }
}

const lastIndex = args.indexOf("--output-last-message");
writeFileSync(args[lastIndex + 1], "done\n");
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
if (scenario === "malformed") process.stdout.write("not-json secret-child-output\n");
const requestedModel = args[args.indexOf("--model") + 1];
emit({ type: "thread.started", thread_id: "fake-thread", ...(scenario === "missing-resolved-model" ? {} : { model: scenario === "different-resolved-model" ? "provider-reported-other" : requestedModel }) });
let requiredCommands;
try { requiredCommands = JSON.parse(process.env.CALIBRATION_REQUIRED_COMMANDS ?? "null"); } catch {}
if (!Array.isArray(requiredCommands) || requiredCommands.some((argv) => !Array.isArray(argv) || argv.some((part) => typeof part !== "string"))) fail("required command contract failed");
const commandOrder = scenario === "required-command-missing" ? [0]
  : scenario === "required-command-duplicate" ? [0, 0, 1]
    : scenario === "required-command-reversed" ? [1, 0]
      : requiredCommands.map((_, index) => index);
if (scenario === "required-command-overlap") {
  for (const index of commandOrder) emit({ type: "item.started", item: { id: `cmd-${index}`, type: "command_execution", command: requiredCommands[index].join(" ") } });
}
for (const [position, index] of commandOrder.entries()) {
  const argv = requiredCommands[index];
  const bareCommand = argv.join(" ");
  const command = scenario === "shell-wrapped-commands" ? `/bin/zsh -lc '${bareCommand}'`
    : scenario === "shell-wrapper-extra-argument" ? `/bin/zsh -lc '${bareCommand} --extra'`
      : scenario === "shell-wrapper-extra-prefix" ? `/bin/zsh -lc 'env ${bareCommand}'`
        : scenario === "shell-wrapper-wrong-path" ? `/usr/bin/zsh -lc '${bareCommand}'`
          : bareCommand;
  const id = `cmd-${index}-${position}`;
  if (scenario !== "required-command-overlap") emit({ type: "item.started", item: { id, type: "command_execution", command } });
  emit({ type: "item.completed", item: { id: scenario === "required-command-overlap" ? `cmd-${index}` : id, type: "command_execution", command, exit_code: scenario === "required-command-nonzero" && index === 1 ? 9 : 0, aggregated_output: "private tool result" } });
}
if (scenario !== "missing-result") emit({ type: "item.completed", item: { id: "answer", type: "agent_message", text: "private final answer" } });
const usage = scenario === "invalid-usage"
  ? { input_tokens: 10, cached_input_tokens: 11, output_tokens: 4, reasoning_output_tokens: 5 }
  : { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 3, output_tokens: 20, reasoning_output_tokens: 5 };
if (scenario !== "missing-usage") emit({ type: "turn.completed", usage });
if (scenario === "duplicate-usage") emit({ type: "turn.completed", usage });
if (scenario === "child-exit") process.exit(23);
