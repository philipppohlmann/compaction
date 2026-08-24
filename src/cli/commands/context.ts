import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import {
  assembleContext,
  contextItemsFromTrace,
  retrieveContextItems,
  type RetrievalOptions
} from "../../core/context-store.js";
import { appendContextItems, loadContextStore } from "../../core/context-store-fs.js";
import type { AgentTrace } from "../../core/types.js";

/**
 * V0.4 `compaction context`, a LOCAL memory + retrieval surface over the user's own captured
 * traces.
 *
 * HARD RAILS (load-bearing): local-only, no network, no model, no embeddings, no engine. It
 * makes NO savings/cost claim (cost lives in `spend`/`summary`) and NO quality/recall/correctness
 * verdict on user data (the four-axis sufficiency harness stays internal, there is no ground
 * truth for an arbitrary user query). `get` prints local retrieval DIAGNOSTICS only.
 */

const DEFAULT_STORE_DIR = ".compaction/context-store";

function readTrace(path: string): AgentTrace {
  if (!existsSync(path)) {
    throw new Error(`File not found: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Not valid JSON: ${path}`);
  }
  const trace = parsed as Partial<AgentTrace>;
  if (!trace || typeof trace.id !== "string" || !Array.isArray(trace.messages)) {
    throw new Error(
      "Not a normalized AgentTrace (expected { id, messages: [...] }). " +
        "Produce one with `compaction capture` or `compaction import`."
    );
  }
  for (const message of trace.messages) {
    const m = message as { id?: unknown; content?: unknown };
    if (!m || typeof m.id !== "string" || typeof m.content !== "string") {
      throw new Error(
        "Malformed trace: every message needs a string `id` and `content`. " +
          "Produce a trace with `compaction capture` or `compaction import`."
      );
    }
  }
  return parsed as AgentTrace;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface GetOptions {
  storeDir?: string;
  budget?: string;
  source?: string[];
  limit?: string;
}

export function registerContextCommand(program: Command): void {
  const context = program
    .command("context")
    .description(
      "Local memory: build a durable context store from your own captured/imported traces and " +
        "retrieve the active context for a next step (local-only; no model, no network, no savings claim)."
    );

  context
    .command("add")
    .argument("<artifact>", "Path to a local normalized AgentTrace JSON (from `compaction capture`/`import`)")
    .option("--store-dir <dir>", "Context store directory (local, gitignored)", DEFAULT_STORE_DIR)
    .description("Append context items derived from a local trace into the local context store (size-cap enforced).")
    .action(async (artifact: string, options: { storeDir?: string }) => {
      const storeDir = resolve(options.storeDir ?? DEFAULT_STORE_DIR);
      const trace = readTrace(resolve(artifact));
      const items = contextItemsFromTrace(trace, { created_at: new Date().toISOString() });
      const result = await appendContextItems(storeDir, items);

      console.log(chalk.cyan("compaction context add"));
      console.log(`Source: ${artifact}`);
      console.log(`Store: ${storeDir}`);
      console.log(
        `Items added: ${result.appended.length}   skipped (duplicate): ${result.skipped.length}   ` +
          `evicted (size cap): ${result.evicted.length}`
      );
      console.log(`Store now holds: ${result.total} items.`);
      console.log("Local-only: nothing was uploaded. This makes no savings claim (see `compaction spend`/`summary` for cost).");
      console.log(chalk.bold('Next: compaction context get "<your query>"'));
    });

  context
    .command("get")
    .argument("<query>", "Free-text description of the current step")
    .option("--store-dir <dir>", "Context store directory (local, gitignored)", DEFAULT_STORE_DIR)
    .option("--budget <tokens>", "Token budget for the assembled context (local estimate)", "4000")
    .option("--source <pointer>", "Required source pointer for coverage diagnostics (repeatable)", collect, [])
    .option("--limit <n>", "Max candidate items to consider after ranking")
    .description(
      "Retrieve + assemble the active context for a query from the local store (deterministic, local). " +
        "Prints the assembled context WITH source pointers + local retrieval diagnostics - not a quality score."
    )
    .action(async (query: string, options: GetOptions) => {
      const storeDir = resolve(options.storeDir ?? DEFAULT_STORE_DIR);
      const budget = Number.parseInt(options.budget ?? "4000", 10);
      if (Number.isNaN(budget) || budget < 0) {
        console.error("--budget must be a non-negative integer number of tokens.");
        process.exitCode = 1;
        return;
      }
      let limit: number | undefined;
      if (options.limit !== undefined) {
        limit = Number.parseInt(options.limit, 10);
        if (Number.isNaN(limit) || limit < 0) {
          console.error("--limit must be a non-negative integer.");
          process.exitCode = 1;
          return;
        }
      }
      const items = await loadContextStore(storeDir);

      const retrievalOptions: RetrievalOptions = limit !== undefined ? { limit } : {};
      const start = performance.now();
      const ranked = retrieveContextItems(
        items,
        { text: query, source_pointers: options.source && options.source.length > 0 ? options.source : undefined },
        retrievalOptions
      );
      const assembled = assembleContext(ranked, { tokenBudget: budget });
      const latencyMs = performance.now() - start;

      console.log(chalk.cyan("compaction context get"));
      console.log(`Query: ${JSON.stringify(query)}`);
      console.log(`Store: ${storeDir} (${items.length} items)`);

      if (assembled.included.length === 0) {
        console.log("Assembled context: (no matching context in the store for this query)");
      } else {
        console.log(`Assembled context (~${assembled.estimated_tokens} tokens, local estimate; budget ${budget}):`);
        for (const item of assembled.included) {
          const pointer = item.source_pointer ?? "(no source pointer)";
          const oneLine = item.content.replace(/\s+/g, " ");
          console.log(`  [${pointer}] ${oneLine}`);
        }
      }

      const recoverable = assembled.included.filter((i) => i.recoverability === true && i.source_pointer).length;
      console.log("Diagnostics (local retrieval, not a quality score):");
      console.log(
        `  considered: ${ranked.length}   included: ${assembled.included.length}   dropped: ${assembled.dropped.length}`
      );
      console.log(`  recoverable (has source pointer): ${recoverable}/${assembled.included.length}`);
      if (options.source && options.source.length > 0) {
        const includedPointers = new Set(
          assembled.included.map((i) => i.source_pointer).filter((p): p is string => Boolean(p))
        );
        const covered = options.source.filter((s) => includedPointers.has(s)).length;
        console.log(`  source coverage: ${covered}/${options.source.length}`);
      } else {
        console.log("  source coverage: n/a (no --source given)");
      }
      console.log(`  latency: ${latencyMs.toFixed(1)} ms`);
      console.log("No model, no network. Local memory/retrieval view - it makes no savings claim and no quality/correctness claim.");
    });
}
