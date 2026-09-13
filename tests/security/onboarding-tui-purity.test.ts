import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ONBOARDING TUI PURITY — the components RENDER, `init.ts` PERFORMS.
 *
 * Every onboarding component carries a docblock asserting "no network call or credential read". Until
 * this guard, that was PROSE ONLY: nothing failed if someone imported the device-flow client straight
 * into a component. That is not a hypothetical — Community activation was added to the stepper, and
 * the shortest way to write it is exactly the import this test forbids.
 *
 * The rail is a SEAM, not a ban on the capability: activation happens through an injected callback
 * (`onCommunityAuth`), implemented in `init.ts`. Keeping the account client out of the component tree
 * is what makes "no credential crosses into the UI" checkable rather than merely intended — the
 * component cannot leak what it cannot reach.
 *
 * The two checks below are deliberately calibrated differently:
 *  - DIRECT imports in the onboarding tree are banned even when type-only. The contract across the
 *    seam is content-free by design, so a component has no business naming the account client at all;
 *    the onboarding-owned `AuthProgress`/`AuthOutcome` types live in `model.js`.
 *  - The TRANSITIVE walk follows RUNTIME edges only, skipping `import type` exactly as the Open-path
 *    walker does. An erased type edge (a shared enum reached four modules away) is not a dependency,
 *    and failing on it would make the guard noisy enough to be relaxed — which is how rails die.
 *
 * If this fails, do NOT relax it: move the I/O to `init.ts` and inject a callback.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const ONBOARDING_DIRS = [
  join(REPO_ROOT, "src", "cli", "onboarding")
];

/** Import/require specifiers this tree may never reach for. */
const FORBIDDEN_SPECIFIERS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /["'][^"']*\/core\/auth\/[^"']*["']/, why: "account/device-flow client (init.ts performs; inject a callback)" },
  { pattern: /["'][^"']*\/api-client\/[^"']*["']/, why: "account/entitlement/usage service client" },
  { pattern: /["'][^"']*\/core\/engine-install\/[^"']*["']/, why: "signed-engine installer (network on explicit commands)" },
  { pattern: /from\s*["'](?:node:)?(?:http|https|net|tls|dns)["']/, why: "network primitive" },
  { pattern: /require\(\s*["'](?:node:)?(?:http|https|net|tls|dns)["']\s*\)/, why: "network primitive" }
];

/** A direct call to global `fetch` — the one network primitive no import can reveal. */
const FETCH_CALL = /(?<![.\w])fetch\s*\(/;

function sourceFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFilesUnder(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("the onboarding TUI owns no I/O (it renders; init.ts performs)", () => {
  /**
   * PLACEMENT CHECK FIRST (the #827 lesson): a guard that scans a path which does not exist in the
   * environment it runs in passes vacuously and protects nothing. Assert the tree is really there
   * and really populated before drawing any conclusion from its cleanliness.
   */
  it("scans a directory that actually exists and contains the production stepper", () => {
    const files = ONBOARDING_DIRS.flatMap(sourceFilesUnder);
    expect(files.length, "no onboarding sources found — this guard would pass vacuously").toBeGreaterThan(0);
    expect(
      files.some((f) => f.endsWith(join("onboarding", "OnboardingTui.tsx"))),
      "the production stepper was not among the scanned files — this guard is pointed at the wrong tree"
    ).toBe(true);
  });

  it("no onboarding source imports the account client, the api client, or a network module", () => {
    const offenders: string[] = [];
    for (const file of ONBOARDING_DIRS.flatMap(sourceFilesUnder)) {
      const source = readFileSync(file, "utf8");
      for (const { pattern, why } of FORBIDDEN_SPECIFIERS) {
        if (pattern.test(source)) offenders.push(`${file.slice(REPO_ROOT.length)} → ${why}`);
      }
    }
    expect(offenders, `onboarding source reached for I/O:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("no onboarding source calls global fetch", () => {
    const offenders: string[] = [];
    for (const file of ONBOARDING_DIRS.flatMap(sourceFilesUnder)) {
      if (FETCH_CALL.test(readFileSync(file, "utf8"))) offenders.push(file.slice(REPO_ROOT.length));
    }
    expect(offenders, `onboarding source called fetch:\n${offenders.join("\n")}`).toEqual([]);
  });

  /**
   * The transitive check. A component that imports a pure-looking sibling which itself imports the
   * account client is exactly as impure as importing it directly, so the ban has to follow the graph
   * out of the onboarding tree — `model.ts` and friends are shared, and shared is where a stray edge
   * would actually land.
   */
  it("nothing reachable from the onboarding sources pulls in the account or api client", () => {
    const seen = new Set<string>();
    const stack = ONBOARDING_DIRS.flatMap(sourceFilesUnder);
    const offenders: string[] = [];
    while (stack.length > 0) {
      const file = stack.pop()!;
      if (seen.has(file) || !existsSync(file)) continue;
      seen.add(file);
      const rel = file.slice(REPO_ROOT.length);
      if (rel.includes("/core/auth/") || rel.includes("/api-client/") || rel.includes("/core/engine-install/")) {
        offenders.push(rel);
        continue;
      }
      const source = readFileSync(file, "utf8");
      const re = /(?:import|export)\b([^;"']*?)from\s*["'](\.[^"']+)["']|import\s*["'](\.[^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        // `import type` / `export type` are erased — no runtime edge, so no runtime dependency.
        if (m[1] !== undefined && /^\s+type\b/.test(m[1])) continue;
        const spec = m[2] ?? m[3];
        const base = resolve(dirname(file), spec);
        for (const candidate of [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), `${base}.ts`, `${base}.tsx`]) {
          if (existsSync(candidate)) {
            stack.push(candidate);
            break;
          }
        }
      }
    }
    expect(offenders, `onboarding graph reached an account/api module:\n${offenders.join("\n")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE OTHER HALF OF THE SEAM: what may CROSS it.
// ---------------------------------------------------------------------------

/**
 * The guard above makes the no-I/O half of the seam structural — a component cannot leak what it
 * cannot reach. The content-free half was still only convention: nothing stopped someone widening
 * `OnboardingAuthSuccess` to carry a device token, and that change would have passed every other
 * check in this tree, because it adds no import and calls no network.
 *
 * So the field set is PINNED. Adding a field to the activation seam now fails a test, which forces
 * the decision to be made deliberately rather than noticed in review — the same reason `email?` is
 * named explicitly in the seam's docblock instead of being implied by a list of exclusions.
 *
 * WHAT THIS DOES NOT PROVE, stated plainly so the assertion is not read as stronger than it is:
 * this is a NAME-based, TYPE-level check. It catches a new field, and it catches a field named like
 * a credential. It does NOT and cannot prove content-freeness — a token smuggled inside an existing
 * string field (say, appended to `fullApplyPendingReason`) would pass. What keeps THAT honest is
 * that the credential never leaves `src/core/auth/**` in the first place: `performDeviceLogin`
 * writes it to the 0600 store and returns none of it, so there is nothing at the seam to smuggle.
 * This test guards the shape; that design guards the contents.
 */
const MODEL_SOURCE = join(REPO_ROOT, "src", "cli", "onboarding", "model.ts");

/** Field names that must never appear on the seam, whatever they are called or cased. */
const CREDENTIAL_SHAPED = /token|secret|key|credential/i;

/**
 * The EXACT fields each seam type may declare. A closed list: a new field fails here until it is
 * added deliberately, with the same scrutiny `email` got.
 */
const ALLOWED_SEAM_FIELDS: Record<string, string[]> = {
  // `step` was added deliberately, in the same breath as the seam docblock: a two-value enum
  // (`"lease" | "engine"`) naming which automatic setup step the screen is waiting on. A constant
  // chosen by the code — not read from the device, the account, or the service — so unlike a string
  // field it has no room to carry anything about the user at all.
  OnboardingAuthProgress: ["kind", "step", "userCode", "verificationUri"],
  OnboardingAuthSuccess: ["ok", "alreadyLoggedIn", "email", "effectiveMode", "fullApplyPendingReason"],
  // `serviceStatus` was added deliberately (F67), in the same breath as the seam docblock: a bare
  // HTTP status integer off the response line, carried only on the two ANSWERED reasons
  // (`endpoint_not_found`, `service_error`). It describes the answer, never the user or their
  // machine. The split that separated `endpoint_not_found` out reused this same field rather
  // than widening the seam again — a new reason is not a new field.
  OnboardingAuthOutcome: ["ok", "reason", "serviceStatus"]
};

/**
 * Field names declared by a `type X = …` / `interface X { … }` block in the model source. Deliberately
 * source-based rather than runtime-based: these types are erased at compile time, so there is no
 * runtime object to inspect until someone actually populates one — and the widening this guards
 * against would land in the declaration, not in a particular call.
 */
function declaredFieldNames(source: string, typeName: string): string[] {
  const start = new RegExp(`export\\s+(?:type|interface)\\s+${typeName}\\b`).exec(source);
  if (!start) return [];
  // The declaration runs to the next top-level `export` (every type here is followed by one).
  const rest = source.slice(start.index + start[0].length);
  const end = rest.search(/\nexport\s/);
  // Comments MUST go before matching: prose contains colons ("not a secret: the user typed …"), and
  // reading a docblock as a field declaration is exactly the kind of false positive that gets a guard
  // deleted rather than fixed.
  const body = (end === -1 ? rest : rest.slice(0, end))
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
  const names = new Set<string>();
  // `name: type` and `name?: type`, at any nesting depth inside the declaration.
  for (const m of body.matchAll(/(?:^|[{;\s])([A-Za-z_$][\w$]*)\??\s*:/g)) names.add(m[1]);
  return [...names];
}

describe("the activation seam carries a CLOSED set of content-free fields", () => {
  it("finds the seam declarations at all (a guard that parses nothing proves nothing)", () => {
    const source = readFileSync(MODEL_SOURCE, "utf8");
    for (const typeName of Object.keys(ALLOWED_SEAM_FIELDS)) {
      expect(declaredFieldNames(source, typeName).length, `${typeName} parsed to zero fields`).toBeGreaterThan(0);
    }
  });

  it("declares no field named like a token, secret, key, or credential", () => {
    const source = readFileSync(MODEL_SOURCE, "utf8");
    const offenders: string[] = [];
    for (const typeName of Object.keys(ALLOWED_SEAM_FIELDS)) {
      for (const field of declaredFieldNames(source, typeName)) {
        if (CREDENTIAL_SHAPED.test(field)) offenders.push(`${typeName}.${field}`);
      }
    }
    expect(
      offenders,
      `a credential-shaped field appeared on the activation seam:\n${offenders.join("\n")}\n` +
        "The TUI renders; init.ts performs. Credentials belong in the 0600 store, not in a callback payload."
    ).toEqual([]);
  });

  it("declares ONLY the fields on the closed list (a widening must be deliberate, not incidental)", () => {
    const source = readFileSync(MODEL_SOURCE, "utf8");
    for (const [typeName, allowed] of Object.entries(ALLOWED_SEAM_FIELDS)) {
      const declared = declaredFieldNames(source, typeName).sort();
      expect(
        declared,
        `${typeName} changed shape. If the new field genuinely belongs at the seam, add it to ` +
          "ALLOWED_SEAM_FIELDS and to the closed list in the seam's docblock — deliberately, in the " +
          "same breath. Do not widen this list to make a red test pass."
      ).toEqual([...allowed].sort());
    }
  });
});
