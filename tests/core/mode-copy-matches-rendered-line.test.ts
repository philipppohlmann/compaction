/**
 * `compaction mode` MUST NOT PROMISE A PER-TURN LABEL THE RENDERER NO LONGER EMITS.
 *
 * `basic shaping` and `full apply` were retired from the per-turn line: `tierClause` renders a posture
 * word for `observe` ONLY (`apply off`), and `RECEIPT_TIER_LABELS.basic` / `.full` survive purely as
 * frozen internal values with no rendering path. `compaction mode` went on telling users
 * "per-turn line: `basic shaping`" and "the per-turn receipt line reads `full apply`" — copy describing
 * a line that no longer exists, on the command whose whole job is explaining what each mode does.
 *
 * This pins the COPY against the RUNTIME that implements it, which is the only thing that stops the two
 * drifting apart again: the same claim lives on the mode list, the mode `--description`, the `mode full`
 * confirmation and the module docs, and a fix applied to one of them has repeatedly missed the others.
 */
import { describe, expect, it } from "vitest";
import { MODE_DESCRIPTION } from "../../src/cli/commands/mode.js";
import { RECEIPT_TIER_LABELS, formatReceiptLine } from "../../src/core/gateway/receipt-line.js";

describe("mode copy matches the line the renderer actually emits", () => {
  it("the renderer emits a posture word for `observe` only", () => {
    // The frozen internal values still exist...
    expect(RECEIPT_TIER_LABELS.basic).toBe("basic shaping");
    expect(RECEIPT_TIER_LABELS.full).toBe("full apply");
    // ...but no line carries them. This is the runtime fact the copy below must not contradict.
    for (const tier of ["basic", "full"] as const) {
      const line = formatReceiptLine({ tier, outputTokens: 400, shortReceiptId: "a1b2c3d4" });
      expect(line, `a ${tier} line must carry no posture word`).not.toContain(RECEIPT_TIER_LABELS[tier]);
    }
    expect(formatReceiptLine({ tier: "observe", outputTokens: 400, shortReceiptId: "a1b2c3d4" }))
      .toContain(RECEIPT_TIER_LABELS.observe);
  });

  it("no mode description promises a retired per-turn label", () => {
    for (const [mode, description] of Object.entries(MODE_DESCRIPTION)) {
      expect(description, `${mode} description must not promise \`basic shaping\``)
        .not.toContain(RECEIPT_TIER_LABELS.basic);
      expect(description, `${mode} description must not promise \`full apply\` as a LINE`)
        .not.toMatch(/per-turn line[^.]*full apply/);
    }
    // `observe` is the one mode that may still name its label, because it is the one still rendered.
    expect(MODE_DESCRIPTION.observe).toContain(RECEIPT_TIER_LABELS.observe);
  });
});
