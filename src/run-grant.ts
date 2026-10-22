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
 * The run also carries the session mode that was in force when it was admitted
 * and a controller of its own. dsh cancels an in-flight `run_code` call when
 * the session mode changes, and makes later calls wait for the cancelled
 * call's nested cleanup before they resolve the new policy; both live here.
 *
 * @module pi-dsh-sandbox/run-grant
 */

import type { SandboxMode } from "./modes.ts";

/** One live codemode run. */
interface Run {
  /** The mode every nested call underneath it resolves to. */
  mode: SandboxMode;
  /** The session mode in force when the run was admitted. */
  standing: SandboxMode;
  /** Whether any nested call was denied by confinement. */
  denied: boolean;
  /** Aborts the program when the session mode changes. */
  controller: AbortController;
  /** Resolves when {@link endRun} releases the run. */
  settled: Promise<void>;
  /** Resolves `settled`; kept so {@link clearRuns} can release a test's runs. */
  release: () => void;
}

const runs = new Map<string, Run>();

/**
 * Start a run.
 *
 * @param callId The codemode tool call's id.
 * @param mode The mode its nested calls resolve to.
 * @param standing The session mode in force now; a later change cancels the run.
 * @returns The signal that aborts the program when the session mode changes.
 */
export function beginRun(
  callId: string,
  mode: SandboxMode,
  standing: SandboxMode = mode,
): AbortSignal {
  let release: () => void = () => {};
  const settled = new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController();
  runs.set(callId, { mode, standing, denied: false, controller, settled, release });
  return controller.signal;
}

/**
 * End a run.
 *
 * @param callId The codemode tool call's id.
 * @returns What the run hit, or `undefined` when it was not open.
 */
export function endRun(callId: string): { denied: boolean } | undefined {
  const run = runs.get(callId);
  if (run === undefined) return undefined;
  runs.delete(callId);
  run.release();
  return { denied: run.denied };
}

/**
 * Set the mode a run's nested calls resolve to.
 *
 * The run is admitted under the session mode, before an approval dialog opens;
 * the grant replaces that mode once the user decides.
 *
 * @param callId The codemode tool call's id.
 * @param mode The granted mode.
 */
export function setRunMode(callId: string, mode: SandboxMode): void {
  const run = runs.get(callId);
  if (run !== undefined) run.mode = mode;
}

/**
 * Cancel the runs admitted under a mode other than `mode`.
 *
 * @param mode The session mode that is now in force.
 * @returns How many runs were cancelled.
 */
export function cancelRunsForMode(mode: SandboxMode): number {
  let cancelled = 0;
  for (const run of runs.values()) {
    if (run.standing === mode || run.controller.signal.aborted) continue;
    run.controller.abort(new Error("sandbox mode changed"));
    cancelled += 1;
  }
  return cancelled;
}

/**
 * Wait for every cancelled run to finish its nested cleanup.
 *
 * A later program resolves its policy only after the earlier one has stopped,
 * so a widened or narrowed session mode never overlaps a stale run.
 */
export async function awaitCancelledRuns(): Promise<void> {
  for (;;) {
    const pending = [...runs.values()].filter((run) => run.controller.signal.aborted);
    if (pending.length === 0) return;
    await Promise.all(pending.map((run) => run.settled));
  }
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
  for (const run of runs.values()) run.release();
  runs.clear();
}
