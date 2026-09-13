import { createHash } from "node:crypto";
import { canonicalManifestBytes } from "../engine-install/manifest.js";
import type { PairDescriptor } from "./types.js";

/** Identity binds the installed dependency inventory as well as the published CLI artifact. */
export function createPair(cli: PairDescriptor["cli"], engine: PairDescriptor["engine"]): PairDescriptor {
  const identity = JSON.stringify({
    version: cli.version, integrity: cli.integrity,
    files: Object.keys(cli.files).sort().map((file) => [file, cli.files[file]]),
    engine: engine.mode === "basic" ? "basic" : canonicalManifestBytes(engine.manifest).toString("utf8")
  });
  return { id: createHash("sha256").update(identity).digest("hex"), cli, engine };
}
