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
 * @param channel The approval channel (pi's extension UI).
 * @param toolName The tool name, for the approval prompt.
 * @param subject The family's noun for the denied action.
 * @returns The per-call policy.
 */
export async function resolveCallPolicy(
  state: SandboxState,
  args: EscalationArgs,
  channel: { ui: ExtensionUIContext; hasUI: boolean },
  toolName: string,
  subject: string,
): Promise<Policy> {
  validateEscalationArgs(args.sandbox_permissions, args.justification);
  const standing = state.resolve();
  if (args.sandbox_permissions === undefined) return standing;
  const granted = await approveEscalation(
    {
      requestedMode: args.sandbox_permissions,
      justification: args.justification as string,
      effectiveMode: standing.mode,
      subject,
    },
    { ui: channel.ui, hasUI: channel.hasUI, toolName },
  );
  return { ...standing, mode: granted };
}
