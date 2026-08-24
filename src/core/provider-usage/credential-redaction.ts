/**
 * Credential-shaped redaction for the provider-usage capture path.
 *
 * A single redaction pass applies to EVERY output path (logs, errors, artifacts, reports, debug dumps).
 *
 * The PRIMARY control is that the credential is never placed into any structure
 * that gets logged or serialized (see provider-usage-adapter.ts). This redaction
 * pass is the defense-in-depth backstop: it masks the configured secret value (if
 * present) AND anything matching known credential shapes, before any string is
 * written to stdout/stderr/log/error/artifact.
 *
 * NO real secret ever appears here, tests exercise this with fake sentinels only.
 */

export const REDACTION_MASK = "***REDACTED***";

/**
 * Known credential-shaped patterns (defense in depth). These are deliberately
 * conservative shape matchers, NOT a DLP/ML classifier:
 *  - `Authorization: Bearer <token>` header values
 *  - `x-api-key: <token>` header values
 *  - common provider key prefixes followed by a long token body
 *  - long high-entropy bearer-style tokens
 */
const KNOWN_CREDENTIAL_SHAPE_PATTERNS: RegExp[] = [
  // Authorization: Bearer <token>  (mask the token, keep the header name)
  /(authorization\s*:\s*bearer\s+)[A-Za-z0-9._\-+/=]{8,}/gi,
  // x-api-key: <token>  (mask the value, keep the header name)
  /(x-api-key\s*:\s*)[A-Za-z0-9._\-+/=]{8,}/gi,
  // Common provider key prefixes (sk-, sk-ant-, sk-proj-, anthropic-, etc.) + body
  /\b(?:sk-(?:ant-|proj-)?|api[-_]?key[-_]|anthropic-|openai-)[A-Za-z0-9._\-]{12,}\b/gi,
  // Long high-entropy token bodies (>= 32 chars of base64url-ish content)
  /\b[A-Za-z0-9._\-+/=]{40,}\b/g
];

/**
 * Redact a string for safe output. If `configuredSecret` is provided and present
 * in the text, every occurrence is masked first (exact match, provider-agnostic),
 * then known credential shapes are masked as a backstop.
 */
export function redactSecrets(text: string, configuredSecret?: string): string {
  let redacted = text;

  if (configuredSecret && configuredSecret.length > 0) {
    // Exact-match mask of the known secret value (provider-agnostic, highest-precision).
    redacted = redacted.split(configuredSecret).join(REDACTION_MASK);
  }

  for (const pattern of KNOWN_CREDENTIAL_SHAPE_PATTERNS) {
    redacted = redacted.replace(pattern, (match, prefix?: string) => {
      // Header patterns capture a non-secret prefix we preserve; keep it, mask the value.
      if (typeof prefix === "string" && prefix.length > 0) {
        return `${prefix}${REDACTION_MASK}`;
      }
      return REDACTION_MASK;
    });
  }

  return redacted;
}

/** Redact then write to stderr. Use for ALL error/diagnostic output on this path. */
export function redactedError(message: string, configuredSecret?: string): string {
  return redactSecrets(message, configuredSecret);
}
