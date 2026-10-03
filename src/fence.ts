/**
 * The in-process filesystem fence, ported from dsh
 * `packages/fs/fs-sandbox/src/index.ts` (`checkedTarget`).
 *
 * This fence is a policy check in TRUSTED code over a MODEL-CONTROLLED path —
 * not a kernel boundary. Reads pass through untouched (every mode permits
 * reading), exactly as in dsh. The residual resolve-to-write TOCTOU is narrowed
 * by re-canonicalizing immediately before the mutation and by mutating the
 * REFRESHED target, never the stale one.
 *
 * @module pi-dsh-sandbox/fence
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isPathUnder } from "./containment.ts";
import { escalationHintMarker, sandboxDenialMarker } from "./escalation.ts";
import type { ConfinedSandboxMode, Policy } from "./modes.ts";
import { writableRoots } from "./roots.ts";

/** The noun the fence uses in model-facing escalation hints. */
const SUBJECT = "operation";

/**
 * A denied mutation. Its message is the model-facing denial marker plus the
 * escalation hint, so the model sees the same vocabulary bash denials use.
 */
export class SandboxDeniedError extends Error {
  /** Stable code for programmatic callers (dsh: `FS_SANDBOX_DENIED`). */
  readonly code = "FS_SANDBOX_DENIED";

  /** The mode the denied call ran under. */
  readonly mode: ConfinedSandboxMode;

  /** The target the call tried to mutate. */
  readonly target: string;

  constructor(mode: ConfinedSandboxMode, target: string) {
    super(`${sandboxDenialMarker(mode)}\n${escalationHintMarker(SUBJECT)}`);
    this.name = "SandboxDeniedError";
    this.mode = mode;
    this.target = target;
  }
}

/**
 * Resolve a target to the freshest canonical spelling: the deepest existing
 * ancestor is realpath-resolved (native, component-by-component) and the
 * missing suffix is re-appended.
 *
 * Running this immediately before the mutation is what catches a symlink
 * ancestor swapped since the tool resolved the path — the dsh `resolve()` step
 * inside `checkedTarget`.
 *
 * @param absPath Absolute path the tool is about to mutate.
 * @returns A canonical path whose parent chain exists (suffix may still be missing).
 */
export function freshestTarget(absPath: string): string {
  const remainder: string[] = [];
  let current = absPath;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return remainder.length === 0 ? real : join(real, ...remainder);
    } catch {
      const parent = dirname(current);
      if (parent === current) return absPath;
      remainder.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Enforce the per-call policy against `absPath` and return the EXACT target the
 * mutation must use, so the checked identity is the mutated one.
 *
 * `read-only` denies; `workspace-write` re-canonicalizes NOW, requires
 * containment under a writable root, and returns that fresh target;
 * `danger-full-access` returns the caller's target unfenced.
 *
 * @param absPath Absolute path the tool is about to mutate.
 * @param policy The per-call file-effect policy.
 * @returns The path to mutate.
 * @throws SandboxDeniedError on refusal.
 */
export async function checkedTarget(absPath: string, policy: Policy): Promise<string> {
  if (policy.mode === "danger-full-access") return absPath;
  if (policy.mode === "read-only") throw new SandboxDeniedError("read-only", absPath);
  const fresh = freshestTarget(absPath);
  for (const root of writableRoots(policy)) {
    if (await isPathUnder(fresh, root)) return fresh;
  }
  throw new SandboxDeniedError("workspace-write", absPath);
}
