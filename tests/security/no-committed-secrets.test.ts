import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static "no real secret committed in the repo" check.
 *
 * Security/privacy review worksheet item 14.1 [BLOCKING]
 * requires a static,
 * repo-wide check that fails if a real secret-shaped string / real credential
 * is committed to tracked source/tests/docs/config text files.
 *
 * Design notes:
 *  - Dependency-free: uses Node built-ins only (`child_process` to list
 *    git-tracked files, `fs` to read them). No npm dependency, no network.
 *  - Scans ONLY git-tracked files, so git-ignored junk (node_modules, dist,
 *    .env*, build output, local artifacts) is naturally out of scope.
 *  - Tuned to MINIMIZE false positives: each candidate match must (a) look
 *    like a real provider/cloud credential by shape AND (b) survive a
 *    "looks-fake" guard (markers like SENTINEL/REDACTED/FAKE/EXAMPLE and
 *    low-entropy / sequential / dictionary-word bodies are treated as
 *    deliberate placeholders, not real secrets).
 *
 * If this test ever FAILS, do NOT silence it by deleting the evidence:
 * a real committed secret must be reported to a human and rotated.
 */

const REPO_ROOT = join(__dirname, "..", "..");

/** Path prefixes excluded from the scan (in addition to git-ignored files). */
const EXCLUDED_PREFIXES = [
  ".claude/", // agent/skill harness content, incl. .claude/worktrees/*
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/"
];

/** Non-text / binary extensions we never scan. */
const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".zip",
  ".gz",
  ".tgz",
  ".bin",
  ".lock",
  ".mp3",
  ".mp4",
  ".mov",
  ".wav"
]);

/** Skip absurdly large files to keep the scan fast and avoid generated blobs. */
const MAX_FILE_BYTES = 1_000_000;

/**
 * Substrings (case-insensitive) that mark a string as an obvious, deliberate
 * placeholder / sentinel rather than a real secret. Any candidate token
 * containing one of these is allowed.
 */
const FAKE_MARKERS = [
  "sentinel",
  "redacted",
  "fake",
  "do-not-use",
  "donotuse",
  "example",
  "placeholder",
  "longtoken",
  "dummy",
  "sample",
  "your-",
  "your_",
  "yourkey",
  "changeme",
  "replace",
  "test-key",
  "testkey",
  "xxxx",
  "abcdef0123", // ascending hex run used by the redaction unit-test fakes
  "0123456789abcdef" // sentinel tail used by the SENTINEL_CREDENTIAL fakes
];

/** Real provider/cloud credential shapes. */
const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  // OpenAI-style: sk- (optionally sk-ant- / sk-proj-) + 20+ base62 chars.
  { name: "openai/anthropic sk- key", regex: /\bsk-(?:ant-|proj-)?(?:[A-Za-z0-9]{2,}-)?[A-Za-z0-9]{20,}\b/g },
  // AWS access key id.
  { name: "aws access key id", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  // Google API key.
  { name: "google api key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // GitHub tokens (personal, oauth, server, user, refresh).
  { name: "github token", regex: /\bgh[posru]_[A-Za-z0-9]{36}\b/g },
  // Slack tokens.
  { name: "slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // Generic long bearer tokens in non-doc contexts (no whitespace/quotes/slash).
  { name: "bearer token", regex: /\bBearer\s+([A-Za-z0-9._-]{30,})\b/g },
  // PEM private-key headers.
  { name: "pem private key", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  // High-entropy value assigned to an obviously-secret variable name.
  {
    name: "secret-named assignment",
    regex:
      /\b(?:api[_-]?key|secret[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|token|client[_-]?secret|private[_-]?key)\b["'\s]*[:=]+["'\s]*([A-Za-z0-9+/_-]{24,}={0,2})/gi
  }
];

/** Return the most "token-like" capture from a regex match. */
function tokenOf(match: RegExpExecArray): string {
  return match[1] ?? match[0];
}

/** True if the token looks like a deliberate placeholder rather than a real secret. */
function looksFake(raw: string): boolean {
  const value = raw.toLowerCase();
  if (FAKE_MARKERS.some((m) => value.includes(m))) {
    return true;
  }
  // Angle-bracket / template placeholders, e.g. <PROVIDER_API_KEY env var>, ${secret}.
  if (/[<>${}]/.test(raw)) {
    return true;
  }
  // env-var NAMES (ALL_CAPS_WITH_UNDERSCORES, no lowercase, no other symbols),
  // e.g. COMPACTION_PROVIDER_USAGE_TOKEN, a name, not a value.
  if (/^[A-Z0-9_]+$/.test(raw) && raw.includes("_")) {
    return true;
  }
  return false;
}

/** Shannon entropy (bits/char) of a string. Real secrets are high-entropy. */
function entropyPerChar(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Length of the longest ascending/descending consecutive-character run (case-insensitive). */
function longestSequentialRun(value: string): number {
  const lower = value.toLowerCase();
  let best = 1;
  let asc = 1;
  let desc = 1;
  for (let i = 1; i < lower.length; i += 1) {
    const delta = lower.charCodeAt(i) - lower.charCodeAt(i - 1);
    asc = delta === 1 ? asc + 1 : 1;
    desc = delta === -1 ? desc + 1 : 1;
    best = Math.max(best, asc, desc);
  }
  return best;
}

/**
 * Decide whether a regex-matched token is a credible REAL secret (vs. a fake).
 * Conservative: only flags tokens that both look real by shape AND carry real
 * entropy and are not obvious sequential/dictionary placeholders.
 */
function isCredibleSecret(token: string): boolean {
  if (looksFake(token)) {
    return false;
  }
  // The body that should carry entropy: strip a known key prefix if present.
  const body = token.replace(/^sk-(?:ant-|proj-)?(?:api\d*-)?/i, "").replace(/^Bearer\s+/i, "");
  // PEM headers have no body but are always real-shaped enough to flag.
  if (token.includes("PRIVATE KEY")) {
    return true;
  }
  if (body.length < 16) {
    return false;
  }
  // Long ascending alphabet/number runs => deliberate fake (e.g. ABCDEFGHIJ..., 0123456789).
  if (longestSequentialRun(body) >= 8) {
    return false;
  }
  // A real key mixes character classes; require at least a letter and a digit
  // somewhere in the body to drop plain dictionary words / pure-hex test stubs.
  const hasLetter = /[A-Za-z]/.test(body);
  const hasDigit = /[0-9]/.test(body);
  if (!hasLetter || !hasDigit) {
    return false;
  }
  // Require genuine entropy. Real base62/hex secrets sit well above ~3.0 bits/char;
  // repeated/low-variety placeholders fall below.
  if (entropyPerChar(body) < 3.2) {
    return false;
  }
  return true;
}

function listTrackedFiles(): string[] {
  const stdout = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  return stdout.split("\0").filter((p) => p.length > 0);
}

function shouldScan(relPath: string): boolean {
  if (EXCLUDED_PREFIXES.some((prefix) => relPath.startsWith(prefix))) {
    return false;
  }
  if (SKIP_EXTENSIONS.has(extname(relPath).toLowerCase())) {
    return false;
  }
  return true;
}

interface Finding {
  file: string;
  line: number;
  pattern: string;
  token: string;
}

function scanFile(relPath: string): Finding[] {
  const abs = join(REPO_ROOT, relPath);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    return [];
  }
  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    return [];
  }
  // Skip apparently-binary content (NUL byte present).
  if (content.includes("\u0000")) {
    return [];
  }

  const findings: Finding[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const { name, regex } of SECRET_PATTERNS) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        const token = tokenOf(match);
        if (isCredibleSecret(token)) {
          findings.push({ file: relPath, line: i + 1, pattern: name, token });
        }
        if (match.index === regex.lastIndex) {
          regex.lastIndex += 1; // guard against zero-width matches
        }
      }
    }
  }
  return findings;
}

describe("static repo-wide secret scan (worksheet 14.1, BLOCKING)", () => {
  const trackedFiles = listTrackedFiles();

  it("derives a non-empty file list from git-tracked content", () => {
    expect(trackedFiles.length).toBeGreaterThan(0);
  });

  it("finds no real committed secret in tracked text files", () => {
    const findings: Finding[] = [];
    for (const relPath of trackedFiles) {
      if (!shouldScan(relPath)) {
        continue;
      }
      findings.push(...scanFile(relPath));
    }

    if (findings.length > 0) {
      const report = findings
        .map((f) => `  ${f.file}:${f.line} [${f.pattern}] -> ${f.token.slice(0, 12)}…`)
        .join("\n");
      throw new Error(
        `Possible REAL secret(s) found in tracked files. Investigate and rotate - do NOT delete the test:\n${report}`
      );
    }

    expect(findings).toHaveLength(0);
  });

  it("would flag a planted real-shaped credential (self-test of the detector)", () => {
    // Synthetic, non-real values used only to prove the detector is not a no-op.
    // Built from fragments at runtime so THIS source file contains no contiguous
    // secret-shaped literal (otherwise the repo-wide scan above would flag its own
    // self-test fixtures). The detector still sees the full contiguous value at runtime.
    const plantedAws = "AKIA" + "1B2C3D4E5F6G7H8J"; // AWS key-id shape (split to avoid a self-match)
    const plantedSk = "sk-ant-" + "9fK2pVqLmZ7wRtN4aXc8Hb3D1eYsUjQ0oPgI6lM"; // mixed-entropy sk- key (split for the same reason)
    expect(scanLineForTest(`aws_key = "${plantedAws}"`)).toBe(true);
    expect(scanLineForTest(`Authorization: Bearer ${plantedSk}`)).toBe(true);
    // And the documented fakes must NOT trip it.
    expect(scanLineForTest("x-api-key: sk-ant-abcdef0123456789abcdef0123")).toBe(false);
    expect(scanLineForTest('secret = "SENTINEL-FAKE-KEY-DO-NOT-USE-0123456789abcdef"')).toBe(false);
    expect(scanLineForTest("const file = \"sk-sequencing.md\";")).toBe(false);
    expect(scanLineForTest("token: ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij")).toBe(false);
  });
});

/** Test helper: does the given single line contain a credible secret? */
function scanLineForTest(line: string): boolean {
  for (const { regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      if (isCredibleSecret(tokenOf(match))) {
        return true;
      }
      if (match.index === regex.lastIndex) {
        regex.lastIndex += 1;
      }
    }
  }
  return false;
}
