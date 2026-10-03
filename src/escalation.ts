/**
 * The escalation vocabulary and choreography, ported from dsh
 * `packages/sandbox/sandbox/src/escalation.ts`.
 *
 * Every model-facing string is copied verbatim so a pi session teaches and
 * reports denials exactly as a dsh session does: the marker, the same-turn
 * hint, the parameter description, and the fail-closed error texts.
 *
 * dsh routes the approval through `ctx.approval`; pi has no approval service,
 * so the channel is the extension UI (`ctx.ui.select`). The sequencing is
 * unchanged: validate the pairing, prove the target is strictly wider, ask the
 * human BEFORE anything executes, and apply the granted mode to this one call.
 *
 * @module pi-dsh-sandbox/escalation
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { SandboxMode } from "./modes.ts";

/**
 * The strictly-wider table: what a call whose effective mode is the key may
 * escalate TO. Checked at EXECUTION, never baked into a tool schema — schemas
 * are fixed while the effective mode is per-call truth.
 */
export const WIDER_MODES: Record<string, readonly SandboxMode[]> = {
  "read-only": ["workspace-write", "danger-full-access"],
  "workspace-write": ["danger-full-access"],
};

/**
 * The closed escalation-target vocabulary — every mode a call could ever
 * escalate TO (`read-only` is the floor; nothing escalates to it).
 */
export const ESCALATION_TARGETS: readonly SandboxMode[] = ["workspace-write", "danger-full-access"];

/**
 * Validate the escalation argument pairing a tool schema cannot express:
 * `sandbox_permissions` and `justification` travel together, and the
 * justification must be a non-empty sentence.
 *
 * @param sandboxPermissions The raw `sandbox_permissions` argument, if given.
 * @param justification The raw `justification` argument, if given.
 */
export function validateEscalationArgs(
  sandboxPermissions: string | undefined,
  justification: string | undefined,
): void {
  if (sandboxPermissions !== undefined && justification === undefined) {
    throw new Error("invalid escalation: sandbox_permissions requires a justification");
  }
  if (justification !== undefined && sandboxPermissions === undefined) {
    throw new Error("invalid escalation: justification is only valid together with sandbox_permissions");
  }
  if (justification !== undefined && justification.trim().length === 0) {
    throw new Error("invalid justification: expected a non-empty sentence");
  }
}

/**
 * The model-facing denial marker's stable prefix — the anchor the tool layer maps
 * a wrapped denial back onto (dsh `FsSandboxController.mapError`).
 */
export const DENIAL_MARKER_PREFIX = "[sandbox: file access denied under ";

/**
 * The model-facing denial marker — one vocabulary for both enforcing families,
 * so the model recognizes a policy denial identically whether the kernel
 * refused a bash file effect or the filesystem fence refused a mutation.
 *
 * @param mode The mode the denied call ran under.
 * @returns The marker line, exactly as the model sees it.
 */
export function sandboxDenialMarker(mode: SandboxMode): string {
  return `${DENIAL_MARKER_PREFIX}${mode} mode]`;
}

/**
 * The same-turn escalation hint that rides a denial when the composition
 * advertises the escalation fields.
 *
 * @param subject The family's noun for the denied action (`command` for bash,
 *   `operation` for a filesystem mutation).
 * @returns The hint line, exactly as the model sees it.
 */
export function escalationHintMarker(subject: string): string {
  return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`;
}

/**
 * The model-facing `sandbox_permissions` parameter description.
 *
 * @param subject The family's noun for the denied action.
 * @returns The parameter description, exactly as the model sees it.
 */
export function sandboxPermissionsDescription(subject: string): string {
  return `The narrowest wider sandbox mode for a one-shot retry of the exact ${subject} the sandbox just denied; the retry asks the user for approval.`;
}


/** One escalation request, as {@link approveEscalation} judges it. */
export interface EscalationRequest {
  /** The requested target mode (schema-pinned to {@link ESCALATION_TARGETS}). */
  requestedMode: string;
  /** The model's one-sentence reason, shown verbatim to the user. */
  justification: string;
  /** The call's effective mode (session override ?? deployment default). */
  effectiveMode: SandboxMode;
  /** The family's noun for the escalated action in user-facing texts. */
  subject: string;
}

/** The approval ingredients the tool layer holds. */
export interface EscalationApproval {
  /** pi's extension UI (dialog channel). */
  ui: ExtensionUIContext;
  /** Whether an interactive channel exists; false fails closed. */
  hasUI: boolean;
  /** The tool name, for the audit prompt. */
  toolName: string;
}

/**
 * Resolve a sandbox permission request before execution. Repeating the call's
 * effective mode returns it without approval. A strictly wider mode requires
 * approval and applies only to this call. Narrower or unsupported targets, and
 * a missing interactive channel, throw before execution.
 *
 * @param request The escalation to judge.
 * @param approval The approval ingredients the tool holds.
 * @returns The granted mode, consumed by the one call that asked.
 */
export async function approveEscalation(
  request: EscalationRequest,
  approval: EscalationApproval,
): Promise<SandboxMode> {
  const { requestedMode: mode, effectiveMode, justification, subject } = request;
  if (mode === effectiveMode) return effectiveMode;
  if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode as SandboxMode)) {
    throw new Error(
      `sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode`,
    );
  }
  if (!approval.hasUI) {
    throw new Error(
      `sandbox escalation to "${mode}" requires approval, but no approval channel is available`,
    );
  }
  const choice = await approval.ui.select(
    `Allow this ${subject} with ${mode} permissions: ${justification}`,
    ["Allow once", "Cancel"],
  );
  if (choice === undefined) throw new Error(`approval for escalating to "${mode}" was cancelled`);
  if (choice !== "Allow once") {
    throw new Error(
      `the user rejected escalating this ${subject} to "${mode}"; it stays denied, so stop and explain instead of working around it`,
    );
  }
  return mode as SandboxMode;
}
