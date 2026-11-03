/**
 * Writable-root derivation, ported verbatim from dsh
 * `packages/sandbox/sandbox/src/roots.ts` as of dsh 0.2.2.
 *
 * One home for what `workspace-write` means as a canonical allow-list, so the
 * bwrap profile (bash) and the in-process filesystem fence (write/edit) can
 * never drift apart: "the write tool cannot write /tmp but bash can"
 * asymmetries cannot arise.
 *
 * dsh splits the set in two: {@link workspaceWritableRoots} is the
 * workspace-owned half (the workspace root plus explicit extra directories),
 * which every backend grants as a unit, while {@link writableRoots} adds the
 * platform temp areas that the fence and Seatbelt also grant. bwrap mounts its
 * own ephemeral `/tmp`, so it takes only the workspace-owned half.
 *
 * @module pi-dsh-sandbox/roots
 */

import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Policy } from "./modes.ts";

/** An explicit directory grant cannot be enforced without changing the caller's selected path. */
export class SandboxInvalidRootError extends Error {
  /** Stable code for programmatic callers (dsh: `SANDBOX_INVALID_ROOT`). */
  readonly code = "SANDBOX_INVALID_ROOT";

  constructor(path: string, detail: string) {
    super(`Invalid additional writable directory ${JSON.stringify(path)}: ${detail}`);
    this.name = "SandboxInvalidRootError";
  }
}

/**
 * Reject mutable path aliases before they can redirect an explicit grant.
 *
 * @param path A configured extra root, in execution-world spelling.
 * @returns The physical directory path.
 * @throws SandboxInvalidRootError When the path is missing, is not a directory,
 *   or is spelled through a symlink.
 */
function additionalRoot(path: string): string {
  let physical: string;
  let directory: boolean;
  try {
    physical = realpathSync.native(path);
    directory = statSync(physical).isDirectory();
  } catch (error) {
    throw new SandboxInvalidRootError(path, `cannot read the directory: ${String(error)}`);
  }
  if (!directory) throw new SandboxInvalidRootError(path, "expected an existing directory");
  if (physical !== resolve(path)) {
    throw new SandboxInvalidRootError(
      path,
      `use the physical directory path ${JSON.stringify(physical)}; symlinked grants are not supported`,
    );
  }
  return physical;
}

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
 * The workspace-owned writable roots — the policy's workspace root plus its
 * explicit extra directories, as a canonical, deduplicated allow-list. Both the
 * workspace and every extra root must be granted together by every backend;
 * this is the one derivation of that set, kept separate from the platform temp
 * policy each backend documents for itself (the fence and Seatbelt use
 * {@link writableRoots}; bwrap adds its own `/tmp` mount).
 *
 * @param policy The file-effect policy to derive the allow-list from.
 * @returns The canonical workspace-owned roots; empty under `read-only`.
 * @throws {SandboxInvalidRootError} An extra root is missing, is not a
 *   directory, or uses a symlink.
 */
export function workspaceWritableRoots(policy: Policy): string[] {
  if (policy.mode !== "workspace-write") return [];
  return [
    ...new Set([canonicalPath(policy.workspaceRoot), ...(policy.additionalWritableRoots ?? []).map(additionalRoot)]),
  ];
}

/**
 * The roots one confined execution may WRITE under: `read-only` allows nothing;
 * `workspace-write` allows the policy's workspace root, its explicit extra
 * directories, the host `/tmp`, and the per-user platform temp dir (`os.tmpdir()`
 * — the real temp area for mkstemp-family tools).
 *
 * @param policy The file-effect policy to derive the allow-list from.
 * @returns The canonical writable roots; empty exactly under `read-only`.
 */
export function writableRoots(policy: Policy): string[] {
  if (policy.mode !== "workspace-write") return [];
  return [...new Set([...workspaceWritableRoots(policy), canonicalPath("/tmp"), canonicalPath(tmpdir())])];
}
