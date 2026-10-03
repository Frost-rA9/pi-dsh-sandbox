/**
 * The Linux bubblewrap rung: mount-profile construction, its dialects, and the
 * shell quoting used to hand a wrapped argv to pi's shell operations.
 *
 * Ported from dsh `packages/sandbox/sandbox-local/src/profiles.ts`
 * (`bwrapProfileArgs`) plus the Linux row of its denial/runner-failure tables.
 * Only bwrap is ported on purpose: it is dsh's preferred Linux rung ("its mount
 * profile is closest to the mode vocabulary"), and the Landlock rung exists
 * only as a fallback behind a native addon pi does not ship.
 *
 * @module pi-dsh-sandbox/bwrap
 */

import type { Policy } from "./modes.ts";

/**
 * Build the bwrap profile arguments for one file-effect policy — verbatim from
 * dsh. `read-only` keeps the whole filesystem read-only (only `--dev /dev`
 * grants the sink shells need); `workspace-write` adds an ephemeral `/tmp` and
 * a read-write bind of the workspace root OVER the read-only root.
 *
 * @param policy The file-effect policy to express as bwrap mounts.
 * @returns Profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: Policy): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent"];
  if (policy.mode === "workspace-write") {
    args.push("--tmpfs", "/tmp");
    args.push("--bind", policy.workspaceRoot, policy.workspaceRoot);
  }
  return args;
}

/** The bwrap denial dialect: the stderr text a denied write produces (EROFS). */
export const BWRAP_DENIAL_SIGNATURES: readonly string[] = ["read-only file system"];

/** The bwrap runner-failure dialect: the runner refusing before the command ran. */
export const BWRAP_RUNNER_FAILURE_SIGNATURES: readonly string[] = ["bwrap: "];

/** Quote one value as a POSIX shell word (single quotes, `'\''` escape). */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
