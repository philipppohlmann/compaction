import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useStdout } from "ink";
import { renderWordmark, type Segment } from "./wordmark.js";

/**
 * The first-run header for the interactive onboarding: a bordered
 * "✦ Welcome to Compaction" badge, the block-glyph COMPACTION wordmark, the
 * stacked DEV block glyphs, and the version line. On short or narrow terminals
 * the block art collapses to the spaced text fallback ("C O M P A C T I O N" /
 * "D E V") so the header never wraps or scrolls the flow off-screen.
 */

export const FRAME_MAX = 96;
const BLOCK_WIDTH = 83;
const COMPACT_COMPACTION = "C O M P A C T I O N";
const COMPACT_DEV = "D E V";

// Baked "ANSI Shadow" rendering of DEV (same treatment as the COMPACTION block
// in wordmark.ts). Do not hand-edit; regenerate from figlet if the word changes.
const DEV_LINES = [
  "██████╗ ███████╗██╗   ██╗",
  "██╔══██╗██╔════╝██║   ██║",
  "██║  ██║█████╗  ██║   ██║",
  "██║  ██║██╔══╝  ╚██╗ ██╔╝",
  "██████╔╝███████╗ ╚████╔╝ ",
  "╚═════╝ ╚══════╝  ╚═══╝  "
];

function segmentLine(line: string): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | undefined;
  for (const character of line.padEnd(BLOCK_WIDTH, " ")) {
    const layer = character === " " ? "empty" : character === "█" ? "fill" : "outline";
    if (current?.layer === layer) {
      current.text += character;
    } else {
      current = { text: character, layer };
      segments.push(current);
    }
  }
  return segments;
}

const DEV_ROWS = DEV_LINES.map(segmentLine);

export function renderHeaderWordmark(maxWidth: number, compact: boolean): Segment[][] {
  if (compact || maxWidth < BLOCK_WIDTH) {
    return [
      [{ text: COMPACT_COMPACTION, layer: "fill" }],
      [{ text: COMPACT_DEV, layer: "fill" }]
    ];
  }
  return [...renderWordmark(maxWidth).rows, ...DEV_ROWS];
}

export function WelcomeHeader({
  version,
  maxWidth,
  color,
  compact
}: {
  version: string;
  maxWidth: number;
  color: string;
  compact: boolean;
}): React.ReactElement {
  const rows = useMemo(() => renderHeaderWordmark(maxWidth, compact), [compact, maxWidth]);
  return (
    <Box flexDirection="column">
      <Box alignSelf="flex-start" borderStyle="round" borderColor={color} paddingX={1} marginBottom={1}>
        <Text color={color}>✦</Text>
        <Text> Welcome to <Text bold>Compaction</Text></Text>
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        {rows.map((row, rowIndex) => (
          <Text key={rowIndex}>
            {row.map((segment, segmentIndex) => (
              <Text
                key={segmentIndex}
                color={segment.layer === "empty" ? undefined : color}
                bold={segment.layer === "fill"}
              >
                {segment.text}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={color} bold>v{version}</Text>
        <Text color="gray"> compaction: context optimization for AI agents.</Text>
      </Box>
    </Box>
  );
}

/** Live terminal size (debounced on resize), with safe fallbacks off-TTY. */
export function useTerminalSize(): { cols: number; rows: number } {
  const { stdout } = useStdout();
  const read = (): { cols: number; rows: number } => ({
    cols: stdout && typeof stdout.columns === "number" && stdout.columns > 0 ? stdout.columns : FRAME_MAX,
    rows: stdout && typeof stdout.rows === "number" && stdout.rows > 0 ? stdout.rows : 24
  });
  const [size, setSize] = useState(read);

  useEffect(() => {
    if (!stdout || typeof stdout.on !== "function") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setSize(read()), 24);
    };
    stdout.on("resize", onResize);
    return () => {
      if (timer) clearTimeout(timer);
      if (typeof stdout.off === "function") stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}
