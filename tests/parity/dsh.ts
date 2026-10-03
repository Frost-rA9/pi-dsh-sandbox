/**
 * Loader for the dsh parity tests.
 *
 * Resolves the `deepseek-harness` checkout from `PI_DSH_ROOT` or the usual
 * candidates, registers the resolve hook, and imports dsh modules straight from
 * the checkout. When no checkout exists the caller skips, so the suite still
 * runs on a host without dsh.
 *
 * The parity tests call the dsh functions themselves. A hash or a text
 * extraction would only prove that the text matched; calling both sides proves
 * the behavior does.
 *
 * @module pi-dsh-sandbox/tests/parity/dsh
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

function findDshRoot(): string | undefined {
  const explicit = process.env.PI_DSH_ROOT;
  const candidates = explicit === undefined
    ? [resolve(repoRoot, "..", "deepseek-harness"), join(homedir(), "projects", "deepseek-harness")]
    : [explicit];
  return candidates.find((candidate) => existsSync(join(candidate, "packages")));
}

/** The resolved dsh checkout, or `undefined` when none exists. */
export const dshRoot = findDshRoot();

/** A skip reason for `node:test`, or `false` when the checkout is present. */
export const paritySkip: false | string = dshRoot === undefined
  ? "no deepseek-harness checkout; set PI_DSH_ROOT to run the parity tests"
  : false;

if (dshRoot !== undefined) {
  process.env.PI_DSH_PARITY_ROOT = dshRoot;
  register("./dsh-hooks.mjs", import.meta.url);
}

/**
 * Import a dsh module by its path inside the checkout.
 *
 * @param relativePath The module path relative to the dsh repository root.
 */
export async function loadDsh<T>(relativePath: string): Promise<T> {
  if (dshRoot === undefined) throw new Error("no deepseek-harness checkout");
  return (await import(pathToFileURL(join(dshRoot, relativePath)).href)) as T;
}
