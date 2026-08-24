import chalk from "chalk";
import { Command } from "commander";
import { readActivityEvents } from "../../core/activity-store.js";
import {
  DEFAULT_ACTIVITY_LIMIT,
  buildActivityJson,
  buildActivityRows,
  formatActivityTable
} from "../../core/activity-view.js";

interface ActivityOptions {
  limit?: string;
  surface?: string;
  json?: boolean;
}

/**
 * `compaction activity`, READ-ONLY, metrics-only view of recent runs from the local activity
 * store (`.compaction/activity/activity.jsonl`). Content-free: it renders only the counts/labels
 * the events already carry; it never reads or prints prompt/response content, and it writes
 * NOTHING. Empty store → a friendly message, exit 0.
 */
export function registerActivityCommand(program: Command): void {
  program
    .command("activity")
    .description("Show recent runs recorded in the local metrics-only activity store (read-only, content-free).")
    .option("--limit <n>", `Max runs to show, most recent first (default ${DEFAULT_ACTIVITY_LIMIT})`)
    .option("--surface <surface>", "Only show runs from this surface (e.g. cursor, codex, cli, claude_code)")
    .option("--json", "Machine-readable JSON output")
    .action(async (options: ActivityOptions) => {
      const limit = options.limit !== undefined ? Number.parseInt(options.limit, 10) : DEFAULT_ACTIVITY_LIMIT;
      if (Number.isNaN(limit) || limit < 0) {
        console.error(`Invalid --limit "${options.limit}": expected a non-negative integer.`);
        process.exitCode = 1;
        return;
      }

      const { events, skipped } = await readActivityEvents();
      const rows = buildActivityRows(events, { limit, surface: options.surface });
      const meta = { totalEvents: events.length, limit, surface: options.surface, skippedCount: skipped.length };

      if (options.json) {
        console.log(JSON.stringify(buildActivityJson(rows, meta), null, 2));
        return;
      }
      const table = formatActivityTable(rows, meta);
      console.log(rows.length === 0 ? chalk.yellow(table) : chalk.cyan(table));
    });
}
