/**
 * Bounded, content-free HEAD+TAIL tee of a streamed upstream response for USAGE parsing only.
 *
 * The gateway forwards the client's `Accept-Encoding`, so the upstream (e.g. Anthropic on a real
 * subscription) may return a gzip/brotli/deflate-COMPRESSED body. The client pipe forwards those exact
 * compressed bytes (byte-safe, unchanged). But the usage adapter needs to read `input_tokens` /
 * `output_tokens` / cache fields out of the SSE/JSON body, which it cannot do on compressed bytes — so
 * every receipt on compressed traffic came back with empty tokens.
 *
 * This tee decompresses the READ-ONLY usage-parsing COPY (never what the client receives): copied chunks
 * are fed incrementally into a streaming decompressor and only a bounded decompressed HEAD (first
 * `headBytes`) + a sliding decompressed TAIL (last `tailBytes`) are retained. The whole decompressed body
 * is NEVER buffered (a multi-MB decompressed SSE stays bounded), and the compressed copy is fed-and-
 * discarded (never retained whole).
 *
 * FAIL-OPEN / NEVER-THROW: any decompressor error (truncated/invalid stream, unsupported coding) yields a
 * `decompressFailed` marker with an honest reason; the caller records `token_source: unavailable`. The
 * decompressor's `error` event is always handled so it can never throw or emit an unhandled error, and a
 * late/aborted stream cannot leak the decompressor.
 *
 * CONTENT-FREE: only the bounded window text is produced, solely for the adapter to read numeric token
 * counts + labels. No response content is stored, logged, or added to the receipt.
 */
import zlib from "node:zlib";

/** The compression codings we can decompress for the usage-parsing copy. */
type SupportedCoding = "gzip" | "br" | "deflate";

/**
 * The effective content coding from a (possibly comma-listed, possibly cased) `content-encoding` header.
 * Per RFC 7231 the codings are applied in order, so the LAST (outermost) is what we must undo first; we
 * only support a single applied coding, so anything beyond a lone supported coding is treated as
 * unsupported (fail-open). `identity`/absent/empty → no decompression.
 */
export function effectiveContentCoding(
  header: string | string[] | undefined
): { kind: "identity" } | { kind: "supported"; coding: SupportedCoding } | { kind: "unsupported"; label: string } {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (raw === undefined) return { kind: "identity" };
  const codings = raw
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== "");
  // Drop trailing identity codings (they are no-ops).
  while (codings.length > 0 && codings[codings.length - 1] === "identity") codings.pop();
  if (codings.length === 0) return { kind: "identity" };
  const last = codings[codings.length - 1];
  // We only undo a single applied coding; a stack (e.g. "gzip, br") is unsupported → fail-open.
  if (codings.length === 1 && (last === "gzip" || last === "br" || last === "deflate")) {
    return { kind: "supported", coding: last };
  }
  return { kind: "unsupported", label: codings.join(", ") };
}

function createDecompressor(coding: SupportedCoding): zlib.Gunzip | zlib.BrotliDecompress | zlib.Inflate {
  switch (coding) {
    case "gzip":
      return zlib.createGunzip();
    case "br":
      return zlib.createBrotliDecompress();
    case "deflate":
      return zlib.createInflate();
  }
}

/**
 * A bounded HEAD + sliding TAIL accumulator over a byte stream, capturing at most `headBytes` from the
 * front and `tailBytes` from the back while tracking the total length — WITHOUT buffering the middle.
 * Used for both the raw (identity) path and the decompressed output.
 */
export class BoundedHeadTail {
  private readonly head: Buffer[] = [];
  private headBytesSeen = 0;
  private readonly tail: Buffer[] = [];
  private tailBytesSeen = 0;
  private total = 0;

  constructor(private readonly headCap: number, private readonly tailCap: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.headBytesSeen < this.headCap) {
      const room = this.headCap - this.headBytesSeen;
      const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
      this.head.push(slice);
      this.headBytesSeen += slice.length;
    }
    this.tail.push(chunk);
    this.tailBytesSeen += chunk.length;
    while (this.tailBytesSeen > this.tailCap && this.tail.length > 1) {
      this.tailBytesSeen -= this.tail[0].length;
      this.tail.shift();
    }
  }

  headBuffers(): Buffer[] {
    return this.head;
  }

  tailBuffers(): Buffer[] {
    return this.tail;
  }

  totalBytes(): number {
    return this.total;
  }
}

/** Assemble the bounded HEAD + TAIL windows into the text fed to the usage adapter (see server.ts). */
export function assembleHeadTail(head: Buffer[], tail: Buffer[], totalBytes: number, tailCap: number): string {
  const tailBuf = Buffer.concat(tail);
  if (totalBytes <= tailCap) return tailBuf.toString("utf8");
  return `${Buffer.concat(head).toString("utf8")}\n${tailBuf.toString("utf8")}`;
}

/**
 * A streaming usage-parsing tee. `push` is called with each READ-ONLY copy of an upstream chunk (the same
 * bytes streamed to the client); `finish` returns the bounded window text to feed the adapter, or a
 * decompression-failure marker (fail-open). Bounded and content-free by construction.
 */
export interface UsageTee {
  push(chunk: Buffer): void;
  finish(): Promise<{ ok: true; windowText: string } | { ok: false; reason: string }>;
}

/**
 * Create a usage tee for a given response content-coding.
 *  - identity/absent/empty → the raw bytes are windowed exactly as before this change (no decompression).
 *  - a supported single coding (gzip/br/deflate) → copied chunks stream through the decompressor and the
 *    DECOMPRESSED output is windowed (bounded head+tail); the whole decompressed body is never retained.
 *  - an unsupported coding → fail-open marker (the caller records `unavailable` with an honest reason).
 */
export function createUsageTee(
  contentEncoding: string | string[] | undefined,
  headCap: number,
  tailCap: number
): UsageTee {
  const coding = effectiveContentCoding(contentEncoding);

  if (coding.kind === "identity") {
    const acc = new BoundedHeadTail(headCap, tailCap);
    return {
      push(chunk) {
        acc.push(chunk);
      },
      async finish() {
        return { ok: true, windowText: assembleHeadTail(acc.headBuffers(), acc.tailBuffers(), acc.totalBytes(), tailCap) };
      }
    };
  }

  if (coding.kind === "unsupported") {
    return {
      push() {
        // Nothing retained; the copy is discarded. Usage will be reported unavailable.
      },
      async finish() {
        return { ok: false, reason: `response content-encoding '${coding.label}' is not supported for usage parsing` };
      }
    };
  }

  // Supported coding: stream the copied chunks through a decompressor and window the DECOMPRESSED output.
  const acc = new BoundedHeadTail(headCap, tailCap);
  const decompressor = createDecompressor(coding.coding);
  let failed: string | null = null;
  // The decompressor MUST have an error handler so it can never throw / emit an unhandled error, even on a
  // late/aborted stream. On error we stop feeding it and remember the honest reason (fail-open).
  decompressor.on("error", (err: Error) => {
    if (failed === null) failed = `could not decompress the ${coding.coding} response for usage parsing (${err.message})`;
  });
  // Consume the DECOMPRESSED output into the bounded window; feed-and-discard (never buffer the whole body).
  decompressor.on("data", (chunk: Buffer) => {
    if (failed !== null) return;
    acc.push(chunk);
  });

  return {
    push(chunk) {
      if (failed !== null) return; // stop feeding a failed decompressor; discard remaining copied bytes
      // `write` can throw synchronously if the stream is already destroyed/errored; guard fail-open.
      try {
        decompressor.write(chunk);
      } catch (err) {
        if (failed === null) failed = `could not decompress the ${coding.coding} response for usage parsing (${(err as Error).message})`;
      }
    },
    finish() {
      return new Promise((resolve) => {
        const settle = (): void => {
          if (failed !== null) {
            resolve({ ok: false, reason: failed });
            return;
          }
          resolve({ ok: true, windowText: assembleHeadTail(acc.headBuffers(), acc.tailBuffers(), acc.totalBytes(), tailCap) });
        };
        if (failed !== null) {
          // Already errored while streaming; do not wait on the decompressor.
          settle();
          return;
        }
        // `end()` flushes remaining buffered output; `end`/`close` fires once fully drained, `error` on a
        // truncated/invalid stream. Either terminal event settles exactly once.
        let settled = false;
        const once = (): void => {
          if (settled) return;
          settled = true;
          settle();
        };
        decompressor.on("error", once);
        decompressor.on("end", once);
        try {
          decompressor.end();
        } catch (err) {
          if (failed === null) failed = `could not decompress the ${coding.coding} response for usage parsing (${(err as Error).message})`;
          once();
        }
      });
    }
  };
}
