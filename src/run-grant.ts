/**
 * The grant one codemode run holds over its nested calls.
 *
 * dsh resolves a `run_code` program's sandbox policy once, before the program
 * runs, and holds it for that one execution; the program's own effects are
 * confined by it while nested tool calls keep their own policies and approvals.
 * pi's codemode has no effects of its own, so the same one-shot grant is
 * attached to the calls the script makes instead — the divergence
 * `docs/design.md` chapter 4.3 records.
 *
 * A run is keyed by the codemode tool call's id. Nested calls carry
 * `<parent id>/<n>` ids, and calls a nested tool issues extend the same prefix,
 * so membership is a prefix test against the longest matching run.
 *
 * @module pi-dsh-sandbox/run-grant
 */

import type { SandboxMode } from "./modes.ts";

/** One live codemode run. */
interface Run {
  /** The mode every nested call underneath it resolves to. */
  mode: SandboxMode;
  /** Whether any nested call was denied by confinement. */
  denied: boolean;
}

const runs = new Map<string, Run>();

/**
 * Start a run.
 *
 * @param callId The codemode tool call's id.
 * @param mode The mode its nested calls resolve to.
 */
export function beginRun(callId: string, mode: SandboxMode): void {
  runs.set(callId, { mode, denied: false });
}

/**
 * End a run.
 *
 * @param callId The codemode tool call's id.
 * @returns What the run hit, or `undefined` when it was not open.
 */
export function endRun(callId: string): { denied: boolean } | undefined {
  const run = runs.get(callId);
  runs.delete(callId);
  return run === undefined ? undefined : { denied: run.denied };
}

/** The run a tool call belongs to, by longest matching call-id prefix. */
function runOf(toolCallId: string): Run | undefined {
  let found: Run | undefined;
  let matched = 0;
  for (const [callId, run] of runs) {
    if (!toolCallId.startsWith(`${callId}/`) || callId.length <= matched) continue;
    found = run;
    matched = callId.length;
  }
  return found;
}

/**
 * The mode a nested call must run under.
 *
 * @param toolCallId The tool call's id.
 * @returns The owning run's mode, or `undefined` when no run owns the call.
 */
export function runModeFor(toolCallId: string | undefined): SandboxMode | undefined {
  return toolCallId === undefined ? undefined : runOf(toolCallId)?.mode;
}

/**
 * Record that a nested call was denied, so the run can tell the model what the
 * one-shot grant is for.
 *
 * @param toolCallId The denied tool call's id.
 */
export function markRunDenied(toolCallId: string | undefined): void {
  if (toolCallId === undefined) return;
  const run = runOf(toolCallId);
  if (run !== undefined) run.denied = true;
}

/** Drop every run; a test seam. */
export function clearRuns(): void {
  runs.clear();
}
