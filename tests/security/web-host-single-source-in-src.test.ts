/**
 * REGRESSION GUARD: `src/` names external hosts in exactly one place per purpose, and the website
 * host is named ONLY in `src/core/web-origin.ts`.
 *
 * ── THE DEFECT THIS EXISTS FOR ───────────────────────────────────────────────────────────────────
 * `compaction upgrade` shipped `https://compaction.dev/pricing` as the browser handoff for the one
 * conversion surface. That host had no DNS record: the request did not 404, it failed to connect,
 * so the command opened a browser error. Browser handoffs now resolve from `src/core/web-origin.ts`
 * — and the thing that must not come back is a SURFACE NAMING ITS OWN HOST, because that is what
 * put a host beyond the reach of the one constant that is supposed to govern all of them.
 *
 * ── WHAT THIS GUARD NOW GUARANTEES ──────────────────────────────────────────────────────────────
 *  1. Every URL-shaped literal in tracked `src/` names a host that is loopback, or is one of the
 *     justified external hosts below, or lives in `src/core/web-origin.ts`. A website host
 *     hardcoded into any other file — the original defect, and any repeat of it — fails here.
 *  2. `src/core/web-origin.ts` names exactly ONE URL-shaped host, and it is the value of
 *     `DEFAULT_WEB_ORIGIN`. So the default cannot be duplicated, branched, or shadowed inside the
 *     one file allowed to hold it.
 *  3. A new outbound host cannot appear anywhere in `src/` without editing the allowlist below,
 *     which makes it a reviewed decision rather than a diff nobody notices.
 *
 * ── WHAT IT DELIBERATELY NO LONGER GUARANTEES, AND WHY ───────────────────────────────────────────
 * The previous form failed on ANY URL-shaped `compaction.dev` anywhere in `src/`. That blanket ban
 * caught the defect, but it also banned the CORRECT eventual value of `DEFAULT_WEB_ORIGIN` — so
 * pointing the CLI at the live launch site would have meant changing the constant AND changing this
 * test, turning a configuration decision into two code edits. The launch hostname is no longer
 * blacklisted; it is permitted in `web-origin.ts` and forbidden everywhere else, exactly like the
 * host that is there today.
 *
 * THIS TEST DOES NOT PROVE THE DEFAULT RESOLVES. It makes no network call and must not: whether a
 * hostname answers is a deployment fact that changes without any commit, and a test that asserted
 * it would fail on an airplane and pass against a hijacked domain. Reachability is re-verified by
 * the procedure recorded in `src/core/web-origin.ts` (the route screen plus the Vercel console), at
 * the moment that constant is changed. The structural property here is what a test can
 * actually hold: ONE place to change, and no second place that could disagree with it.
 *
 * ALSO OUT OF REACH, stated so nobody mistakes it for covered: a host assembled entirely at runtime
 * (`` `http://${host}:${port}` ``) has no literal to check, and `src/` contains several
 * legitimately (local gateway addresses). A literal PREFIX is still read — `http://127.0.0.1:${port}`
 * is checked as `127.0.0.1` — so only a fully-interpolated host escapes. The countermeasure there is
 * structural rather than textual: `webUrl()` takes a PATH and never a host, so a caller has nowhere
 * to put one.
 *
 * ── WHY IT MATCHES URL SHAPE ONLY, AND WHY THAT IS LOAD-BEARING ─────────────────────────────────
 * `compaction.dev` is also the PRODUCT NAME, and it appears throughout `src/` inside honesty
 * statements that are the opposite of a defect — "compaction.dev makes NO live provider call".
 * Flagging those would push an author to reword a safety claim to satisfy a lint, which is exactly
 * backwards. So a match requires an explicit `http(s)://` immediately before the host: a URL, never
 * prose. The classifier cases below falsify both halves.
 *
 * OUT OF SCOPE, deliberately: `scripts/install.sh` and `apps/web/public/install` reference
 * `cli.compaction.dev/install`; an install surface is not a browser handoff the CLI performs, and
 * neither file is under `src/`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_WEB_ORIGIN } from "../../src/core/web-origin.js";

const REPO_ROOT = join(__dirname, "..", "..");

/** The ONE file permitted to name the website host. Everything else resolves through it. */
const WEB_ORIGIN_SOURCE = "src/core/web-origin.ts";

/**
 * PARSE, DO NOT PATTERN-MATCH — the host is whatever a URL parser says it is.
 *
 * The first version of this guard read the host with `/https?:\/\/([A-Za-z0-9._-]+)/`, which stops
 * at `@` and therefore captured the USERINFO rather than the destination:
 * `https://api.openai.com@evil.example/path` was classified as the allowlisted `api.openai.com`
 * while `fetch` would connect to `evil.example`. A brand-new outbound host could pass a guard whose
 * entire stated purpose is to make new outbound hosts a reviewed decision.
 *
 * This is the same class as the substring hook-matcher defect this repo has already fixed twice:
 * a hand-rolled approximation of a parser disagrees with the real parser, and an attacker (or an
 * honest typo) lives in the gap. So candidates are EXTRACTED textually and then handed to
 * `new URL()`, whose `hostname` is authoritative and also normalizes case and IDN.
 */

/** A scheme-ful candidate, taken up to the first delimiter that cannot appear inside a URL. */
const ABSOLUTE_URL = /\bhttps?:\/\/[^\s"'`)\]}<>\\]+/g;

/**
 * A scheme-RELATIVE candidate (`//host/path`), anchored to an opening quote.
 *
 * The anchor is load-bearing: unanchored, `//` matches the start of every line comment in the tree.
 * Quote-anchored it currently matches nothing at all in `src/` (measured: 0 occurrences), so it
 * costs no false positives while closing a form that would otherwise reach a host with no scheme
 * for the pattern above to find.
 */
const PROTOCOL_RELATIVE_URL = /["'`](\/\/[^\s"'`)\]}<>\\]+)/g;

/** Addresses that name THIS machine. A local dev/gateway URL is not a shipped destination. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1"]);

/**
 * External hosts `src/` may name outside `web-origin.ts`, each with the reason it is not a website
 * host. Adding an entry is the point of friction: a new outbound destination should be a decision
 * somebody made on purpose, not a string that arrived with a feature.
 */
const ALLOWED_HOSTS = new Map<string, string>([
  ["api.anthropic.com", "provider API base (gateway upstream) — not a browser handoff"],
  ["api.openai.com", "provider API base (OpenAI-compatible upstream) — not a browser handoff"],
  [
    "chatgpt.com",
    "pinned Codex ChatGPT-subscription inference upstream — not a browser handoff"
  ],
  ["api.example.com", "RFC 2606 documentation host inside an example — resolves nowhere by design"],
  [
    "pub-cf9336d86d8140a5aaefd7412832adf7.r2.dev",
    "pinned local-model mirror (engine/lcm/model-mirror-manifest.ts) — a download origin, not a site"
  ],
  [
    "compaction-api-513828095806.europe-west1.run.app",
    // The production API origin (src/core/api-client/config.ts). It is a service endpoint, not a
    // browser handoff: nothing opens it in a browser, so `webUrl()` is the wrong source for it. It
    // has to be a literal in exactly one place precisely BECAUSE the host a device authenticates to
    // is a trust boundary — `lease-client` refuses redirects so a device token cannot be moved to
    // another host, which only means anything if the origin is reviewable rather than assembled.
    "production API origin (api-client/config.ts) — a device-auth service endpoint, not a website"
  ]
]);

/** Updater-specific literals, not blanket host permissions for unrelated browser handoffs. */
const UPDATE_LITERALS = new Map<string, Map<string, string>>([
  ["src/core/update/registry.ts", new Map([
    ["https://registry.npmjs.org", "single public npm acquisition origin; requests omit credentials and reject redirects"],
    ["https://slsa.dev/provenance/v0.2", "exact supported provenance predicate identifier; never fetched"],
    ["https://slsa.dev/provenance/v1", "exact supported provenance predicate identifier; never fetched"]
  ])],
  ["src/cli/commands/update.ts", new Map([
    ["https://cli.compaction.dev/install", "printed official-installer instruction for unknown ownership; not opened or fetched"]
  ])]
]);

interface Offender {
  file: string;
  line: number;
  host: string;
}

function trackedSourceFiles(): string[] {
  const stdout = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "src"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  return stdout.split("\0").filter((p) => p !== "");
}

/**
 * One candidate → the host a client would actually connect to, or `null`.
 *
 * A runtime-interpolated tail is cut first (`http://127.0.0.1:${port}` → `http://127.0.0.1:`), which
 * keeps the literal prefix parseable and yields the real host. When nothing literal remains
 * (`` `http://${host}` ``) the parse fails and the candidate is skipped — a host assembled at
 * runtime has no literal to check, which is stated in the header as a known limit.
 */
function hostOf(candidate: string): string | null {
  const literal = candidate.split("${")[0] as string;
  const withScheme = literal.startsWith("//") ? `https:${literal}` : literal;
  try {
    // NO `.toLowerCase()` here, deliberately: `URL.hostname` is already normalized by the parser
    // (lowercased, IDN punycoded — `EVIL.Example` → `evil.example`, `XN--e1afmkfd.RU` →
    // `xn--e1afmkfd.ru`). A defensive lowercase looked prudent and was DEAD — mutation removed it
    // with every test still green, which is the signal this repo treats as "delete it". The
    // case-insensitivity is still pinned below; it is the parser's property, not this line's.
    const { hostname } = new URL(withScheme);
    return hostname === "" ? null : hostname;
  } catch {
    return null;
  }
}

/** Every URL host in one file's text, with the line it sits on. */
function urlHostsIn(contents: string): { line: number; host: string; literal: string }[] {
  const found: { line: number; host: string; literal: string }[] = [];
  contents.split("\n").forEach((text, index) => {
    const candidates = [
      ...[...text.matchAll(ABSOLUTE_URL)].map((m) => m[0] as string),
      ...[...text.matchAll(PROTOCOL_RELATIVE_URL)].map((m) => m[1] as string)
    ];
    for (const candidate of candidates) {
      const host = hostOf(candidate);
      if (host !== null) found.push({ line: index + 1, host, literal: candidate });
    }
  });
  return found;
}

/** A host is an offender in this file unless it is loopback, allowlisted, or the one source. */
function offendersIn(file: string, contents: string): Offender[] {
  if (file === WEB_ORIGIN_SOURCE) return [];
  return urlHostsIn(contents)
    .filter(({ host, literal }) => !LOOPBACK.has(host) && !ALLOWED_HOSTS.has(host) && !UPDATE_LITERALS.get(file)?.has(literal))
    .map(({ line, host }) => ({ file, line, host }));
}

describe("the classifier itself (falsified in both directions before it is trusted)", () => {
  it("allows only the exact updater file/purpose literals, not their hosts elsewhere or arbitrary paths", () => {
    for (const [file, literals] of UPDATE_LITERALS) {
      for (const literal of literals.keys()) {
        expect(offendersIn(file, JSON.stringify(literal))).toEqual([]);
        expect(offendersIn("src/cli/commands/unrelated.ts", JSON.stringify(literal))).toHaveLength(1);
        expect(offendersIn(file, JSON.stringify(`${literal}/arbitrary`))).toHaveLength(1);
      }
    }
    expect(offendersIn("src/core/update/registry.ts", 'fetch("https://registry.npmjs.org@evil.example")')[0]?.host).toBe("evil.example");
  });
  it("flags the original defect: a surface naming the website host in a URL", () => {
    const found = offendersIn("src/cli/commands/upgrade.ts", 'const u = "https://compaction.dev/pricing";');
    expect(found.map((o) => o.host)).toEqual(["compaction.dev"]);
  });

  it("flags any other website host a surface might hardcode, including the current default", () => {
    const staging = offendersIn("src/cli/commands/anything.ts", `open("${DEFAULT_WEB_ORIGIN}/activate");`);
    expect(staging).toHaveLength(1);
    const invented = offendersIn("src/cli/commands/anything.ts", 'fetch("https://app.compaction.io/x")');
    expect(invented).toHaveLength(1);
  });

  it("does NOT flag the product name used as prose, which src/ is full of on purpose", () => {
    const prose = [
      "compaction.dev makes NO live provider call",
      "A custom domain (models.compaction.dev) can replace this later.",
      "pretends `api.compaction.dev` (or any remote) is live"
    ].join("\n");
    expect(offendersIn("src/core/anything.ts", prose)).toEqual([]);
  });

  it("reads the CONNECTED host, not the userinfo that precedes it", () => {
    // The defect: a textual `[A-Za-z0-9._-]+` capture stops at `@` and reports the allowlisted
    // `api.openai.com`, while `new URL(...).hostname` — and any real client — says `evil.example`.
    const smuggled = offendersIn("src/core/anything.ts", 'fetch("https://api.openai.com@evil.example/path")');
    expect(smuggled.map((o) => o.host)).toEqual(["evil.example"]);
  });

  it("is not fooled by userinfo carrying a port, or by credentials", () => {
    for (const url of [
      "https://api.openai.com:8080@evil.example/x",
      "https://api.anthropic.com:443@evil.example/x",
      "https://user:pw@evil.example/x"
    ]) {
      expect(offendersIn("src/core/anything.ts", `const u = "${url}";`).map((o) => o.host), url).toEqual([
        "evil.example"
      ]);
    }
  });

  it("treats an @ in the PATH as a path, not a host", () => {
    // The mirror of the case above: over-correcting here would flag a legitimate allowlisted call.
    expect(offendersIn("src/core/anything.ts", 'fetch("https://api.openai.com/u@evil.example")')).toEqual([]);
  });

  it("catches a scheme-relative URL, which has no scheme for a scheme-anchored pattern to find", () => {
    expect(offendersIn("src/cli/commands/anything.ts", 'open("//evil.example/pricing")').map((o) => o.host)).toEqual([
      "evil.example"
    ]);
    // Still anchored to a quote: bare `//` opens every line comment in the tree.
    expect(offendersIn("src/core/anything.ts", "// evil.example is not a URL here")).toEqual([]);
  });

  it("normalizes case, so a host cannot slip past the allowlist by shouting", () => {
    expect(offendersIn("src/core/anything.ts", 'fetch("https://API.OpenAI.COM/v1")')).toEqual([]);
    expect(offendersIn("src/core/anything.ts", 'fetch("https://EVIL.Example/v1")').map((o) => o.host)).toEqual([
      "evil.example"
    ]);
  });

  it("does NOT flag loopback or an allowlisted provider host", () => {
    const legitimate = [
      'const base = "http://127.0.0.1:8787";',
      'const dev = "http://localhost:3000/x";',
      'const upstream = "https://api.anthropic.com/v1";'
    ].join("\n");
    expect(offendersIn("src/core/anything.ts", legitimate)).toEqual([]);
  });

  it("does NOT flag the one file permitted to name the website host", () => {
    const line = `export const DEFAULT_WEB_ORIGIN = "https://anything.example";`;
    expect(offendersIn(WEB_ORIGIN_SOURCE, line)).toEqual([]);
    // …and the same line anywhere else is an offender, which is what makes the exemption mean
    // "this file", not "this text".
    expect(offendersIn("src/core/elsewhere.ts", line)).toHaveLength(1);
  });
});

describe("tracked src/ names no host outside the one source and the justified allowlist", () => {
  it("has no unaccounted URL host in any tracked src/ file", () => {
    const offenders: Offender[] = [];
    for (const file of trackedSourceFiles()) {
      offenders.push(...offendersIn(file, readFileSync(join(REPO_ROOT, file), "utf8")));
    }
    expect(
      offenders.map((o) => `${o.file}:${o.line}: ${o.host}`),
      `Resolve browser handoffs from ${WEB_ORIGIN_SOURCE} (webUrl() takes a path, never a host) instead ` +
        "of naming a website host here. If this is a genuinely new NON-website destination, add it to " +
        "ALLOWED_HOSTS in this test with the reason — that entry is the review."
    ).toEqual([]);
  });

  it("actually inspected files, so an empty result cannot come from an empty sweep", () => {
    expect(trackedSourceFiles().length).toBeGreaterThan(100);
  });
});

describe("the default web origin has exactly one source", () => {
  const contents = readFileSync(join(REPO_ROOT, WEB_ORIGIN_SOURCE), "utf8");

  it("names exactly one URL host in the whole file", () => {
    // More than one means a second host is available to be picked up — a branch, a fallback, or a
    // commented-out alternative that a later edit promotes.
    expect(urlHostsIn(contents).map((h) => h.host)).toHaveLength(1);
  });

  it("that host is the one DEFAULT_WEB_ORIGIN resolves to", () => {
    const [only] = urlHostsIn(contents);
    expect(only?.host).toBe(new URL(DEFAULT_WEB_ORIGIN).hostname.toLowerCase());
  });

  it("survives a host change: whatever that constant becomes is permitted here and nowhere else", () => {
    // The property is positional, not textual — any host in this one position is permitted and the
    // same host anywhere else is not, which is what makes a host change a single edit.
    const flipped = 'export const DEFAULT_WEB_ORIGIN = "https://staging.example";';
    expect(offendersIn(WEB_ORIGIN_SOURCE, flipped)).toEqual([]);
    expect(offendersIn("src/cli/commands/upgrade.ts", flipped)).toHaveLength(1);
  });
});
