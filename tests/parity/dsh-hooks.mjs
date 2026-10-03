/**
 * ESM resolve hook for the parity tests.
 *
 * Two dsh workspace dependencies are unbuilt in a checkout (`lib/` is absent),
 * and one is a native addon. Mapping them to local stubs lets the anchored dsh
 * modules load unchanged, so the parity tests call dsh's real functions rather
 * than a copy. `@deepseek-ai/dsh-sandbox` resolves to its importable source.
 *
 * @module pi-dsh-sandbox/tests/parity/dsh-hooks
 */

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const dshRoot = process.env.PI_DSH_PARITY_ROOT;
const shim = (name) => pathToFileURL(join(import.meta.dirname, "shims", name)).href;

const MAP = {
  "@deepseek-ai/dsh-util-values": shim("dsh-util-values.ts"),
  "@deepseek-ai/node-addon-system/landlock-run": shim("landlock-run.ts"),
  ...(dshRoot === undefined
    ? {}
    : { "@deepseek-ai/dsh-sandbox": pathToFileURL(join(dshRoot, "packages", "sandbox", "sandbox", "src", "roots.ts")).href }),
};

/** Resolve a mapped specifier to its local target, or defer to the default resolver. */
export async function resolve(specifier, context, nextResolve) {
  const target = MAP[specifier];
  if (target !== undefined) return { url: target, shortCircuit: true };
  return nextResolve(specifier, context);
}
