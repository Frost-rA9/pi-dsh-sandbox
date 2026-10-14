/**
 * Per-call policy resolution shared by the bash and filesystem families.
 *
 * Ported from dsh `packages/fs/tool-fs/src/sandbox.ts` (`resolvePolicy`) and
 * `packages/sandbox/sandbox/src/escalation.ts` (`approveEscalation`): the
 * approved grant outranks the session override, which outranks the deployment
 * default; a non-widening or rejected request throws BEFORE anything executes.
 *
 * @module pi-dsh-sandbox/calls
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { approveEscalation, validateEscalationArgs } from "./escalation.ts";
import type { Policy } from "./modes.ts";
import { runModeFor } from "./run-grant.ts";
import type { SandboxState } from "./state.ts";

/** The two escalation arguments a mutating tool may carry. */
export interface EscalationArgs {
  sandbox_permissions?: string;
  justification?: string;
}

/**
 * Resolve the policy to stamp onto one call.
 *
 * @param state The session sandbox state.
 * @param args The call's escalation arguments.
 * @param channel The approval channel (pi's extension UI and the call's abort signal).
 * @param toolName The tool name, for the approval prompt.
 * @param subject The family's noun for the denied action.
 * @param toolCallId The call's id, so a codemode run's grant can be found.
 * @returns The per-call policy.
 */
export async function resolveCallPolicy(
  state: SandboxState,
  args: EscalationArgs,
  channel: { ui: ExtensionUIContext; hasUI: boolean; signal?: AbortSignal },
  toolName: string,
  subject: string,
  toolCallId?: string,
): Promise<Policy> {
  validateEscalationArgs(args.sandbox_permissions, args.justification);
  const standing = state.resolve();
  // A call inside a codemode run resolves to the mode that run was granted,
  // which is dsh's one-shot program policy carried to the calls pi's codemode
  // makes in its place (docs/design.md chapter 4.3).
  const runMode = runModeFor(toolCallId);
  const base = runMode === undefined ? standing : { ...standing, mode: runMode };
  if (args.sandbox_permissions === undefined) return base;
  const granted = await approveEscalation(
    {
      requestedMode: args.sandbox_permissions,
      justification: args.justification as string,
      effectiveMode: base.mode,
      subject,
    },
    { ui: channel.ui, hasUI: channel.hasUI, toolName, signal: channel.signal },
  );
  return { ...base, mode: granted };
}
