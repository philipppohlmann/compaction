import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * THE MECHANISM behind the credentialed-fetch redirect policy.
 *
 * The policy itself is behaviour-tested through the real modules
 * (`tests/core/net/credentialed-fetch.test.ts`, `tests/core/engine-install/network-redirect.test.ts`).
 * This test guards the thing those cannot: a NEW credential-bearing call site that builds its own
 * fetch init and silently omits the policy. That is exactly how the policy came to be on three of
 * six call sites — an omission is invisible, because the call keeps working and only the redirect
 * behaviour differs.
 *
 * PER CALL SITE, NOT PER FILE. The original rule was "a file that attaches a
 * credential must IMPORT the helper somewhere", which the probes below walk straight
 * through: a SECOND credentialed fetch appended to a file that already imports the helper passed,
 * because the import was still there. It also keyed on the literal `Bearer` scheme, so
 * `Headers.set("Authorization", …)` and a concatenated scheme were invisible. Three rules now:
 *
 *   1. PER CALL SITE — every `fetch(...)` whose own argument text attaches a credential must build
 *      its init through `credentialedFetchInit`.
 *   2. PER FILE COUNT — in a file that attaches a credential at all, there must be at least as many
 *      `credentialedFetchInit(` uses as `fetch(` call sites. This is what catches a credential
 *      attached OUTSIDE the call expression (a `Headers` object mutated on an earlier line) and a
 *      second call site riding on the first one's import.
 *   3. INVENTORY — the exact set of credential-bearing call sites is pinned, so a new one is a
 *      deliberate edit rather than a silent addition.
 *
 * HONEST RESIDUAL GAP: these are static text rules. An init built by a distant helper function and
 * passed by variable, in a file whose counts happen to match, is not detected. Rule 2 makes that
 * hard to reach by accident; nothing here claims it is unreachable.
 *
 * SCOPE: `src/core/**` — the public client surface. The private engine's LCM
 * model/judge clients also send a model API key to a user-configured endpoint; routing those through
 * this helper would add a private-engine → public-core import edge and is tracked as follow-up work,
 * not silently assumed here.
 */
const SRC_CORE = join(process.cwd(), "src", "core");
const HELPER_IMPORT = "credentialedFetchInit";

/** The helper itself, and the un-credentialed-by-construction paths, are not call sites to check. */
const NOT_A_CALL_SITE = new Set(["src/core/net/credentialed-fetch.ts"]);

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/**
 * Does this text attach a credential to an outbound request?
 *
 * Keyed on the HEADER NAME rather than the auth SCHEME. `Bearer` as a literal is trivially evaded by
 * building the scheme from parts; the header name has to appear for the request to authenticate at
 * all. Covers object-literal headers (`authorization:`), `Headers` mutation (`.set("Authorization"`,
 * `.append(…)`), and the api-client builder that attaches the configured key.
 */
function attachesCredential(source: string): boolean {
  return (
    /\bauthorization\b\s*:/i.test(source) ||
    /["'`]\s*(?:proxy-)?authorization\s*["'`]\s*:/i.test(source) ||
    /\.(?:set|append)\s*\(\s*["'`](?:proxy-)?authorization["'`]/i.test(source) ||
    /["'`]x-api-key["'`]\s*:/i.test(source) ||
    /\.(?:set|append)\s*\(\s*["'`]x-api-key["'`]/i.test(source) ||
    /buildHeaders\(/.test(source)
  );
}

/**
 * Extract the full argument text of every `fetch(` call in a source file, by balanced-paren scan.
 * String/template literals are tracked so a parenthesis inside a URL template cannot end the scan
 * early. `foo.fetch(` / `prefetch(` are excluded — only a bare `fetch(` call.
 */
function fetchCallSites(source: string): string[] {
  const sites: string[] = [];
  const re = /(^|[^.\w$])fetch\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let quote: string | null = null;
    for (let i = open; i < source.length; i++) {
      const c = source[i];
      if (quote !== null) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          sites.push(source.slice(open, i + 1));
          break;
        }
      }
    }
  }
  return sites;
}

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

describe("credentialed fetch policy is constructed in ONE place", () => {
  const files = tsFiles(SRC_CORE)
    .map((f) => ({ path: relative(process.cwd(), f), source: readFileSync(f, "utf8") }))
    .filter(({ path }) => !NOT_A_CALL_SITE.has(path))
    .map((file) => ({ ...file, sites: fetchCallSites(file.source) }));

  it("every credential-bearing fetch CALL SITE routes through the shared helper", () => {
    const offenders = files.flatMap(({ path, sites }) =>
      sites
        .map((site, index) => ({ path, index, site }))
        .filter(({ site }) => attachesCredential(site) && !site.includes(HELPER_IMPORT))
        .map(({ path: p, index }) => `${p}#${index}`)
    );
    expect(offenders).toEqual([]);
  });

  it("a credential-attaching file cannot have more fetch call sites than helper uses", () => {
    // Catches the two shapes a per-call-site text scan cannot see on its own: a credential attached
    // OUTSIDE the call expression, and a second call site riding on the first one's import.
    const offenders = files
      .filter(({ source, sites }) => sites.length > 0 && attachesCredential(source))
      .filter(({ source, sites }) => countOccurrences(source, `${HELPER_IMPORT}(`) < sites.length)
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("pins the exact inventory of credential-bearing call sites (the scan is not vacuously empty)", () => {
    const covered = files
      .flatMap(({ path, sites }) =>
        sites.map((site, index) => ({ path, index, site })).filter(({ site }) => attachesCredential(site))
      )
      .map(({ path, index }) => `${path}#${index}`)
      .sort();
    expect(covered).toEqual([
      "src/core/auth/device-flow.ts#1",
      "src/core/auth/device-flow.ts#2",
      "src/core/auth/lease-client.ts#0",
      "src/core/auth/usage-reconcile-client.ts#0",
      "src/core/engine-install/installer.ts#0",
      "src/core/provider-usage/provider-usage-client.ts#0"
    ]);
  });

  it("the one credentialed call site that attaches OUTSIDE the call is still covered — by rule 2", () => {
    // `api-client/client.ts` funnels every credentialed request through one `fetchWithTimeout`, and
    // the credential arrives on the caller's `init` (`buildHeaders`) rather than in the call text.
    // Rule 1 cannot see it; this asserts rule 2 is what holds it, so the coverage is a fact rather
    // than an assumption about the file staying shaped this way.
    const file = files.find(({ path }) => path === "src/core/api-client/client.ts");
    expect(file).toBeDefined();
    expect(attachesCredential(file!.source)).toBe(true);
    expect(file!.sites.length).toBeGreaterThan(0);
    expect(countOccurrences(file!.source, `${HELPER_IMPORT}(`)).toBeGreaterThanOrEqual(file!.sites.length);
  });

  it("REGRESSION PROBES: the rules reject each shape the per-file rule let through", () => {
    // Three probes against the old per-file rule. Run against the rule
    // functions directly (not the tree) so the guard's own strength is proven, not assumed.
    const compliant = 'fetch(url, credentialedFetchInit({ headers: { authorization: `Bearer ${t}` } }))';

    // (a) Headers.set with an auth header name — the old scheme-keyed regex missed it entirely.
    const headersSet = 'const h = new Headers(); h.set("Authorization", `Bearer ${t}`); fetch(url, { headers: h });';
    expect(attachesCredential(headersSet)).toBe(true);
    expect(fetchCallSites(headersSet).some((s) => attachesCredential(s))).toBe(false); // rule 1 blind…
    expect(countOccurrences(headersSet, `${HELPER_IMPORT}(`)).toBeLessThan(fetchCallSites(headersSet).length); // …rule 2 catches it

    // (b) A concatenated scheme — keyed on the header NAME, so the scheme literal is irrelevant.
    const concatenated = 'fetch(url, { headers: { authorization: "Bea" + "rer " + t } })';
    const concatSite = fetchCallSites(concatenated)[0];
    expect(attachesCredential(concatSite)).toBe(true);
    expect(concatSite.includes(HELPER_IMPORT)).toBe(false); // rule 1 flags it

    // (c) A SECOND credentialed fetch appended to a file that already imports the helper.
    const secondSite = `import { credentialedFetchInit } from "../net/credentialed-fetch.js";\n${compliant}\nfetch(other, { headers: { authorization: \`Bearer \${t}\` } });`;
    const sites = fetchCallSites(secondSite);
    expect(sites).toHaveLength(2);
    expect(sites.filter((s) => attachesCredential(s) && !s.includes(HELPER_IMPORT))).toHaveLength(1);

    // Control: the compliant shape trips neither rule.
    const compliantSite = fetchCallSites(compliant)[0];
    expect(attachesCredential(compliantSite) && !compliantSite.includes(HELPER_IMPORT)).toBe(false);
  });

  it("the helper refuses redirects and offers no way to ask for anything else", () => {
    const helper = readFileSync(join(SRC_CORE, "net", "credentialed-fetch.ts"), "utf8");
    expect(helper).toContain('redirect: "error"');
    expect(helper).not.toMatch(/redirect:\s*["'](follow|manual)["']/);
  });
});
