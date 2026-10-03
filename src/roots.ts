/**
 * Writable-root derivation, ported verbatim from dsh
 * `packages/sandbox/sandbox/src/roots.ts`.
 *
 * One home for what `workspace-write` means as a canonical allow-list, so the
 * bwrap profile (bash) and the in-process filesystem fence (write/edit) can
 * never drift apart: "the write tool cannot write /tmp but bash can"
 * asymmetries cannot arise.
 *
 * @module pi-dsh-sandbox/roots
 */

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Policy } from "./modes.ts";

/**
 * Resolve a granted root to the path the enforcement layer compares: canonical
 * (symlinks resolved), because the containment check matches resolved paths —
 * `/tmp` IS `/private/tmp` on darwin, and an as-spelled grant would match
 * nothing.
 *
 * @param path Root as configured or platform-reported.
 * @returns The canonical path, or the spelling as-is when resolution fails (a
 *   missing root matches nothing until it exists — the conservative outcome).
 */
export function canonicalPath(path: string): string {
  try {
    // The native implementation follows component-by-component lookup, matching
    // spawn and the enforcement layers this identity feeds.
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * The roots one confined execution may WRITE under: `read-only` allows nothing;
 * `workspace-write` allows the policy's workspace root, the host `/tmp`, and
 * the per-user platform temp dir (`os.tmpdir()` — the real temp area for
 * mkstemp-family tools).
 *
 * @param policy The file-effect policy to derive the allow-list from.
 * @returns The canonical writable roots; empty exactly under `read-only`.
 */
export function writableRoots(policy: Policy): string[] {
  if (policy.mode !== "workspace-write") return [];
  return [...new Set([policy.workspaceRoot, "/tmp", tmpdir()].map(canonicalPath))];
}
