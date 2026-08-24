/**
 * ONE construction point for the fetch options of a request that carries one of the user's
 * credentials (PUBLIC client; no dependencies, no I/O of its own).
 *
 * THE RULE: a credentialed request refuses redirects (`redirect: "error"`). It reaches the host the
 * user named and no other, and a redirect target receives nothing at all — not the credential, not
 * the request, not a connection.
 *
 * WHY A HELPER RATHER THAN THE OPTION AT EACH SITE: the option is easy to omit, and an omission is
 * invisible (the call keeps working; only the redirect behaviour silently differs). Before this
 * existed the policy was present on three of the credential-bearing calls and absent from the rest,
 * with no mechanism that would notice a new call site omitting it. Building the init here means the
 * next credentialed call inherits the policy by construction; `tests/security/credentialed-fetch-policy.test.ts`
 * fails if a credential-bearing module builds its own init instead.
 *
 * HONEST SCOPE: this is defence in depth and provenance, NOT a patched leak. On the Node runtime
 * this ships against, a CROSS-ORIGIN redirect already drops the `Authorization` header, so no
 * measured credential leak is being closed here. What refusing adds is (a) a same-origin-to-
 * elsewhere hop cannot be introduced by a compromised or misconfigured endpoint, and (b) a response
 * always comes from the host the user configured, so data read over a credentialed call cannot come
 * from a host they never named.
 *
 * NOT FOR UN-CREDENTIALED REQUESTS: a public CDN artifact download legitimately relies on redirects
 * and carries no credential to move. Those calls deliberately do not use this helper.
 */

/**
 * Build the `fetch` init for a request that carries a credential. Copies the caller's init and
 * stamps the redirect policy; the caller cannot pass a different one (the policy is not an argument).
 */
export function credentialedFetchInit<T extends RequestInit>(init: T = {} as T): T & { redirect: "error" } {
  return { ...init, redirect: "error" };
}

/**
 * Turn a THROWN credentialed-fetch failure into an operator-readable reason.
 *
 * WHY THIS EXISTS: `redirect: "error"` makes `fetch` THROW rather than return a response, so the
 * throw happens before any `HTTP ${status}` formatting a caller does on the result. An operator who
 * typo'd a URL onto a host that redirects (a bare domain that 301s to `https://`, a service behind a
 * path rewrite) got the runtime's opaque `TypeError: fetch failed` and no hint at all about which of
 * their settings caused it. The refusal is deliberate and stays; only its legibility changes.
 *
 * The runtime does not expose a typed redirect-refusal error, so the redirect case is identified by
 * message text on the error or its `cause`, and ANY unrecognised failure falls through to a generic
 * (still honest) network reason rather than being misreported as a redirect.
 */
export function describeCredentialedFetchFailure(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  // Walk the cause chain (undici nests the real reason under `cause`), bounded so a cyclic or
  // pathological chain cannot spin.
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    parts.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  const text = parts.join(" | ");
  if (/redirect/i.test(text)) {
    return "the server answered with a redirect, which is refused on a credentialed request (your credential is only ever sent to the host you named) - check the URL you configured";
  }
  return text === "" ? "network request failed" : `network request failed (${parts[0]})`;
}
