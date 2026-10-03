/**
 * Model-facing sandbox-mode switch notices.
 *
 * dsh surfaces the standing file policy to every request through the
 * `sandbox:policy` runtime context, and never emits a switch notice. pi has no
 * runtime-context channel here, so the resolved policy reaches the model when it
 * changes: one custom message per real tier switch, displayed in the transcript
 * and converted to a user message in model context. The switch sentence follows
 * the pi-dsh-plan notice, and the policy sentences are adapted from dsh's
 * `renderPolicyContext` with the product name replaced by this extension's own
 * vocabulary, matching the denial and escalation strings.
 *
 * The notice fires only on a user-driven `/sandbox` switch, and only when the
 * effective tier actually changed, so repeated selections and the startup
 * `--sandbox-mode` flag stay silent.
 *
 * @module pi-dsh-sandbox/notice
 */

import type { SandboxMode } from "./modes.ts";

/** Custom message type for the switch notice. */
export const SANDBOX_NOTICE_TYPE = "dsh-sandbox-notice";

/**
 * dsh's per-mode policy sentence (`renderPolicyContext`), with the product name
 * replaced by "file policy" and "the sandbox".
 *
 * @param mode The mode now in force.
 * @param workspaceRoot The absolute `workspace-write` boundary.
 */
export function sandboxPolicyContext(mode: SandboxMode, workspaceRoot: string): string {
  switch (mode) {
    case "read-only":
      return "Current file policy: read-only. Any available operation enforced by the sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.";
    case "workspace-write":
      return `Current file policy: workspace-write. Any available operation enforced by the sandbox may modify files under the session workspace: ${JSON.stringify(workspaceRoot)}. Some platform temporary areas may also be writable.`;
    case "danger-full-access":
      return "Current file policy: danger-full-access. The sandbox does not restrict file modifications by available operations.";
  }
}

/**
 * The complete notice text for one switch.
 *
 * @param mode The effective mode after the switch.
 * @param workspaceRoot The absolute `workspace-write` boundary.
 */
export function sandboxSwitchNotice(mode: SandboxMode, workspaceRoot: string): string {
  return `The user switched this session's sandbox mode to ${mode}.\n\n${sandboxPolicyContext(mode, workspaceRoot)}`;
}
