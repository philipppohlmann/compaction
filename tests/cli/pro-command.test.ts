/**
 * `compaction pro` — the ONE conversion surface.
 *
 * The claim boundary matters more than the copy here. Pro is WAITLIST-ONLY: no purchase, no
 * entitlement, no payment path.
 *
 * This docblock used to justify that with "the waitlist service is not live — there is no HTTP route
 * to sign up against". That reason expired when the capture endpoint was deployed and the website
 * was pointed at it, and it sat here stale for two weeks. The assertions
 * below were right the whole time; only the reason was wrong, which is the more dangerous shape — a
 * test defended by a fact that has quietly stopped being true is a test no one can safely change.
 *
 * The real reason, which does not expire: `compaction pro` hands off to the browser and writes
 * nothing itself, so it is never in a position to know whether a signup happened. A live capture
 * endpoint does not change that — a row issues no entitlement either. So the command must never say
 * a user has been added to anything. These tests pin that it explains, names the address it would
 * use, hands off, and claims nothing else.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRO_PATH, PRO_URL_ENV, proHandoffUrl, proUrl, runPro } from "../../src/cli/commands/pro.js";
import { DEFAULT_WEB_ORIGIN, WEB_ORIGIN_ENV } from "../../src/core/web-origin.js";

/** What the handoff resolves to with nothing configured. */
const DEPLOYED_PRO_URL = `${DEFAULT_WEB_ORIGIN}${PRO_PATH}`;

function isolatedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { COMPACTION_CONFIG_DIR: mkdtempSync(join(tmpdir(), "pro-cmd-")), ...extra } as NodeJS.ProcessEnv;
}

async function render(env: NodeJS.ProcessEnv): Promise<{ text: string; opened: string[] }> {
  const lines: string[] = [];
  const opened: string[] = [];
  await runPro({ env, print: (l) => lines.push(l), open: (url) => opened.push(url) });
  return { text: lines.join("\n"), opened };
}

describe("compaction upgrade — the conversion surface", () => {
  it("opens the canonical waitlist join surface for the plan being converted to", () => {
    // ONE waitlist surface, `/waitlist?plan=<plan>`, opened directly by the
    // contextual Community→Pro conversion. `/pricing` stays informational and is NOT this
    // command's destination — someone at their ceiling asked for the action, not the brochure.
    expect(PRO_PATH).toBe("/waitlist?plan=pro");
  });

  it("invents no parameters beyond the plan the route itself takes", () => {
    // Nothing consumes an account parameter, so none is appended — the plan is the only one.
    expect(proHandoffUrl("acct-123", {} as NodeJS.ProcessEnv)).toBe(DEPLOYED_PRO_URL);
    expect(proHandoffUrl(undefined, {} as NodeJS.ProcessEnv)).toBe(DEPLOYED_PRO_URL);
    expect(proHandoffUrl("acct-123", {} as NodeJS.ProcessEnv)).not.toMatch(/acct-123/);
  });

  it("resolves its host from the shared web origin, never from a literal of its own", () => {
    // The defect this guards: the command once carried its own hardcoded host, so a site move fixed
    // every other handoff and left this one pointing somewhere else. The assertion is positional —
    // whatever `DEFAULT_WEB_ORIGIN` says is what this surface opens.
    expect(proUrl({} as NodeJS.ProcessEnv)).toBe(DEPLOYED_PRO_URL);
    const moved = { [WEB_ORIGIN_ENV]: "https://elsewhere.example" } as NodeJS.ProcessEnv;
    expect(proUrl(moved)).toBe(`https://elsewhere.example${PRO_PATH}`);
  });

  it("follows COMPACTION_WEB_ORIGIN when no surface-specific override is set", () => {
    const env = { [WEB_ORIGIN_ENV]: "https://staging.example/" } as NodeJS.ProcessEnv;
    expect(proUrl(env)).toBe("https://staging.example/waitlist?plan=pro");
  });

  it("lets the more specific COMPACTION_PRO_URL beat COMPACTION_WEB_ORIGIN", () => {
    // Precedence is deliberate: someone aiming JUST this handoff at a page must not be overridden by
    // a broader site-wide setting.
    const env = {
      [PRO_URL_ENV]: "https://staging.example/waitlist",
      [WEB_ORIGIN_ENV]: "https://elsewhere.example"
    } as NodeJS.ProcessEnv;
    expect(proUrl(env)).toBe("https://staging.example/waitlist");
  });

  it("never claims the user has been added to anything", async () => {
    const { text } = await render(isolatedEnv());
    expect(text).not.toMatch(/you (are|have been|'ve been) (added|signed up|enrolled|on the (list|waitlist))/i);
    expect(text).not.toMatch(/we('| wi)ll (be in touch|email you)/i);
    // It states the true status instead.
    expect(text).toContain("Pro is not purchasable yet.");
  });

  it("makes no price, no payment, and no entitlement claim", async () => {
    const { text } = await render(isolatedEnv());
    expect(text).not.toMatch(/\$\d/);
    expect(text).not.toMatch(/\b(card|payment|billing|checkout|invoice)\b/i);
    expect(text).not.toMatch(/\b(unlocked|activated|entitled)\b/i);
  });

  it("names the allowance figures as a TARGET, never as a commitment", async () => {
    const { text } = await render(isolatedEnv());
    expect(text).toContain("2,000,000");
    expect(text).toContain("50,000,000");
    // Every Pro number is a non-contractual target, movable to 100M
    // without a client change. A waitlist-only command must not promise the figure.
    expect(text).toMatch(/target, not a commitment/i);
    expect(text).not.toMatch(/\braises the monthly[^.]*to 50,000,000/i);
  });

  it("hands off to the browser and prints the URL as the fallback", async () => {
    const env = isolatedEnv();
    const { text, opened } = await render(env);
    expect(opened).toEqual([DEPLOYED_PRO_URL]);
    expect(text, "the URL is printed too, for headless/SSH shells").toContain(DEPLOYED_PRO_URL);
  });

  it("honours a URL override so a staging site can be exercised", async () => {
    const env = isolatedEnv({ [PRO_URL_ENV]: "https://staging.example/pro" });
    expect(proUrl(env)).toBe("https://staging.example/pro");
    const { opened } = await render(env);
    expect(opened).toEqual(["https://staging.example/pro"]);
  });

  it("uses the signed-in account address when there is one, and says so when there is not", async () => {
    const signedOut = await render(isolatedEnv());
    expect(signedOut.text).toContain("not signed in");

    const dir = mkdtempSync(join(tmpdir(), "pro-cmd-auth-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "credentials.json"),
      JSON.stringify({
        schema_version: 1,
        account_id: "acct-1",
        api_url: "https://api.example",
        device_id: "d-1",
        device_token: "t-1",
        // Not a PEM on purpose: the reader only requires a non-empty string, and a real PEM header
        // would trip the repo-wide secret scanner even with a fake body.
        device_private_key_pem: "fake-device-private-key",
        device_public_key: "ZmFrZQ",
        created_at: "2026-08-03T00:00:00.000Z",
        email: "someone@example.com"
      }),
      "utf8"
    );
    const signedIn = await render({ COMPACTION_CONFIG_DIR: dir } as NodeJS.ProcessEnv);
    expect(signedIn.text).toContain("someone@example.com");
    expect(signedIn.text, "no new details needed — we already have the account").toMatch(/no new details/i);
  });

  it("reports standing honestly when the user is inside the allowance", async () => {
    const { text } = await render(isolatedEnv());
    expect(text).toContain("inside your current allowance");
    expect(text).not.toContain("allowance is spent");
  });

  it("never throws, even with an unreadable config dir", async () => {
    const env = { COMPACTION_CONFIG_DIR: "/nonexistent/really/not/here" } as NodeJS.ProcessEnv;
    await expect(render(env)).resolves.toBeDefined();
  });
});
