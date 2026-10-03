/**
 * Path-containment mechanics, ported from dsh
 * `packages/fs/fs-sandbox/src/containment.ts`.
 *
 * Canonical spellings take the fast lexical path; filesystem identity supplies
 * the conservative fallback for alias-equivalent roots such as Windows 8.3
 * names and casing.
 *
 * @module pi-dsh-sandbox/containment
 */

import type { BigIntStats } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, sep } from "node:path";

const MISSING_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && MISSING_CODES.has(code);
}

function comparablePath(path: string, caseSensitive: boolean): string {
  return caseSensitive ? path : path.toLowerCase();
}

function isLexicallyUnder(path: string, root: string, caseSensitive: boolean): boolean {
  const comparableTarget = comparablePath(path, caseSensitive);
  const comparableRoot = comparablePath(root, caseSensitive);
  if (comparableTarget === comparableRoot) return true;
  const prefix = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
  return comparableTarget.startsWith(prefix);
}

async function statIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await stat(path, { bigint: true });
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Determine whether a canonical target is a writable root or lies beneath it.
 * The lexical fast path handles normal canonical spellings. When spellings
 * differ, walk the target's existing ancestors and compare filesystem identity
 * with the root; this recognizes Windows long-name/8.3 aliases and casing
 * without weakening containment to a textual approximation.
 *
 * @param path Canonical target key, which may end in a missing suffix.
 * @param root Canonical writable root.
 * @param caseSensitive Whether lexical comparison preserves case; defaults to
 *   the host filesystem convention.
 * @returns Whether the target is the root or a descendant of it.
 */
export async function isPathUnder(
  path: string,
  root: string,
  caseSensitive = process.platform !== "win32",
): Promise<boolean> {
  if (isLexicallyUnder(path, root, caseSensitive)) return true;

  const rootInfo = await statIfPresent(root);
  if (!rootInfo) return false;

  let ancestor = path;
  for (;;) {
    const ancestorInfo = await statIfPresent(ancestor);
    if (ancestorInfo && sameIdentity(ancestorInfo, rootInfo)) return true;
    const parent = dirname(ancestor);
    if (parent === ancestor) return false;
    ancestor = parent;
  }
}
