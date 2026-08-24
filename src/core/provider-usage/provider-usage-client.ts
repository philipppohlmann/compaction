/**
 * Injectable provider-usage read client (Option A, read-only, aggregate-only).
 *
 * Read-only aggregate capture with strict secrets/privacy boundaries:
 *  - The provider HTTP read is abstracted behind this small interface so tests
 *    inject a MOCK returning a fixture aggregate-usage response (NO real network,
 *    NO real secret).
 *  - The real implementation uses Node's global `fetch` (built-in, NO new npm
 *    dependency) to a configurable endpoint with the credential in the auth header.
 *  - The credential is passed in-memory only and is NEVER stored, logged, or
 *    placed into any serialized structure (see provider-usage-adapter.ts).
 *
 * Aggregate-only invariant: the response carries usage/cost AGGREGATES ONLY.
 * There is NO field for prompt/completion/message content anywhere in this contract.
 */
import { credentialedFetchInit } from "../net/credentialed-fetch.js";

/**
 * Expected aggregate-usage input contract, the JSON shape the read expects from a
 * provider usage/cost reporting endpoint. Parsed defensively (parseAggregateUsage).
 *
 * NOTE: the exact per-provider response schema mapping is only validated when an
 * operator runs this against a real provider; here it is the documented contract
 * the read normalizes into, exercised with mock fixtures only. There is NO content
 * field in this contract by construction.
 */
export interface ProviderAggregateUsage {
  /** Model identifier the aggregate is reported for (e.g. "claude-3-5-sonnet"). */
  model?: string;
  /** Provider identifier (e.g. "anthropic", "openai"). */
  provider?: string;
  /** Aggregate input token count for the window. */
  input_tokens?: number;
  /** Aggregate output token count for the window. */
  output_tokens?: number;
  /** Aggregate total token count for the window (derived if absent). */
  total_tokens?: number;
  /** Aggregate request count for the window, if the endpoint reports it. */
  request_count?: number;
  /**
   * Aggregate cost for the window, ONLY when the endpoint genuinely exposes cost.
   * When present, cost is labeled provider-reported; when absent, cost stays a
   * price-table estimate. Never guessed.
   */
  cost?: number;
  /** Currency code for `cost` (e.g. "USD"), when cost is exposed. */
  currency?: string;
  /** Start of the reporting window (ISO 8601), if reported. */
  window_start?: string;
  /** End of the reporting window (ISO 8601), if reported. */
  window_end?: string;
}

export interface FetchUsageInput {
  /** Configurable provider usage/cost endpoint (non-secret). */
  endpoint: string;
  /**
   * The read-only credential, held in memory only for the single request.
   * Supplied as the auth header value; NEVER logged, stored, or serialized.
   */
  credential: string;
  /** Optional reporting window start (ISO 8601). */
  windowStart?: string;
  /** Optional reporting window end (ISO 8601). */
  windowEnd?: string;
}

export interface ProviderUsageClient {
  /**
   * Read aggregate usage/cost from the provider's own usage/cost reporting API.
   * Returns aggregate usage/cost ONLY, never prompt/completion content.
   */
  fetchUsage(input: FetchUsageInput): Promise<ProviderAggregateUsage>;
}

function coerceNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function coerceString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Defensive parser for the aggregate-usage contract. Accepts an unknown JSON value
 * (e.g. a provider response body) and extracts ONLY the aggregate usage/cost fields.
 * Any content-shaped or unexpected fields are dropped, they never reach the trace.
 */
export function parseAggregateUsage(raw: unknown): ProviderAggregateUsage {
  const obj = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>;
  const result: ProviderAggregateUsage = {};

  const model = coerceString(obj.model);
  if (model !== undefined) result.model = model;
  const provider = coerceString(obj.provider);
  if (provider !== undefined) result.provider = provider;

  const inputTokens = coerceNonNegativeNumber(obj.input_tokens);
  if (inputTokens !== undefined) result.input_tokens = inputTokens;
  const outputTokens = coerceNonNegativeNumber(obj.output_tokens);
  if (outputTokens !== undefined) result.output_tokens = outputTokens;
  const totalTokens = coerceNonNegativeNumber(obj.total_tokens);
  if (totalTokens !== undefined) result.total_tokens = totalTokens;
  const requestCount = coerceNonNegativeNumber(obj.request_count);
  if (requestCount !== undefined) result.request_count = requestCount;

  const cost = coerceNonNegativeNumber(obj.cost);
  if (cost !== undefined) result.cost = cost;
  const currency = coerceString(obj.currency);
  if (currency !== undefined) result.currency = currency;

  const windowStart = coerceString(obj.window_start);
  if (windowStart !== undefined) result.window_start = windowStart;
  const windowEnd = coerceString(obj.window_end);
  if (windowEnd !== undefined) result.window_end = windowEnd;

  return result;
}

/**
 * Real provider-usage client using Node's built-in global `fetch` (NO new npm
 * dependency). Performs exactly ONE read-only GET to the configured endpoint with
 * the credential in the auth header. The credential is used only for this request
 * and is never logged or returned. The response is parsed defensively to aggregate
 * usage/cost only.
 *
 * This live path is unit-tested with a MOCK client; it is NOT dogfooded against a
 * real provider in this environment (no credential/endpoint available).
 */
export class FetchProviderUsageClient implements ProviderUsageClient {
  async fetchUsage(input: FetchUsageInput): Promise<ProviderAggregateUsage> {
    const url = new URL(input.endpoint);
    if (input.windowStart) url.searchParams.set("window_start", input.windowStart);
    if (input.windowEnd) url.searchParams.set("window_end", input.windowEnd);

    // REDIRECTS ARE REFUSED, and this one is a deliberate call rather than a copied default. Unlike
    // the calls to our own service, this request goes to a THIRD-PARTY host and carries the user's
    // PROVIDER API KEY, so following a redirect could be argued either way. Refusing, because:
    //  1. the endpoint is one the operator explicitly configured; a hop to a host they did not name
    //     is not something this read has any reason to make;
    //  2. the figures this returns are labeled provider-reported. Following a redirect would let
    //     that label describe numbers fetched from an unnamed host — an evidence-provenance defect
    //     as well as a credential one;
    //  3. provider usage/cost endpoints serve JSON directly; redirects are a CDN-artifact pattern,
    //     not a JSON-API one, so there is no known legitimate redirect to preserve here.
    // The cost of refusing is honest and operator-fixable: an endpoint that redirects (an http→https
    // or trailing-slash hop) fails with a clear transport error instead of silently succeeding, and
    // the operator configures the final URL. Same defence-in-depth caveat as the other credentialed
    // calls — this runtime already drops `Authorization` across origins, so no measured leak is
    // being closed.
    const response = await fetch(
      url,
      credentialedFetchInit({
        method: "GET",
        headers: {
          // Auth header carries the credential for this single read only.
          Authorization: `Bearer ${input.credential}`,
          Accept: "application/json"
        }
      })
    );

    if (!response.ok) {
      // Surface status WITHOUT echoing the request auth header or the credential.
      // The caller redacts before printing as a backstop.
      throw new Error(`Provider usage endpoint returned HTTP ${response.status} ${response.statusText}.`);
    }

    const body: unknown = await response.json();
    return parseAggregateUsage(body);
  }
}
