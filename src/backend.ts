/**
 * Backend selection: which kernel facility confines commands on this host.
 *
 * Mirrors dsh `packages/sandbox/sandbox-local/src/index.ts` — a platform chain,
 * a one-time functional probe, and fail-closed selection — reduced to one rung
 * per platform because neither rung ships a fallback here:
 *
 *   linux  → bubblewrap (mount/user/PID namespaces)
 *   darwin → Seatbelt (`sandbox-exec` + an SBPL profile)
 *   win32  → none; the session falls back to danger-full-access (see state.ts)
 *   other  → none; confined execution fails closed
 *
 * The rungs are data: a probed `Confiner` closes over the host's verified
 * invocation form, so `bash.ts` never re-derives how to wrap.
 *
 * @module pi-dsh-sandbox/backend
 */

import { spawnSync } from "node:child_process";
import { bwrapProfileArgs, BWRAP_DENIAL_SIGNATURES, BWRAP_RUNNER_FAILURE_SIGNATURES, shellQuote } from "./bwrap.ts";
import type { ConfinedSandboxMode, Config, Policy } from "./modes.ts";
import {
  probeSeatbeltForm,
  SEATBELT_DENIAL_SIGNATURES,
  SEATBELT_RUNNER_FAILURE_SIGNATURES,
  seatbeltProfileArgs,
  seatbeltRunnerArgv,
} from "./seatbelt.ts";

/** Error code carried by SandboxUnavailableError (dsh: `SANDBOX_UNAVAILABLE`). */
export const SANDBOX_UNAVAILABLE = "SANDBOX_UNAVAILABLE";

/**
 * Thrown when a confined mode is requested but no usable backend exists. The
 * semantics are dsh's: never run the command unconfined.
 */
export class SandboxUnavailableError extends Error {
  /** Stable code for programmatic callers. */
  readonly code = SANDBOX_UNAVAILABLE;

  /** The confined mode that was requested. */
  readonly mode: ConfinedSandboxMode;

  constructor(mode: ConfinedSandboxMode, detail?: string) {
    super(
      `sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; `
        + "refusing to run the command unconfined. Install bubblewrap with unprivileged user "
        + "namespaces (Linux) or ensure sandbox-exec is usable (macOS), or switch the session to "
        + "danger-full-access with `/sandbox`."
        + (detail === undefined ? "" : ` Backend failure: ${detail}`),
    );
    this.name = "SandboxUnavailableError";
    this.mode = mode;
  }
}

/** A probed, usable confinement backend. */
export interface Confiner {
  /** Rung name, for status and error messages. */
  readonly name: "bwrap" | "seatbelt";
  /** The runner executable this rung invokes. */
  readonly program: string;
  /**
   * Wrap one shell invocation so it executes confined.
   *
   * @param policy The per-call file-effect policy.
   * @param shellArgv The shell invocation to run inside the sandbox.
   * @returns The command string to spawn instead (pi's shell operations take a
   *   command, not an argv).
   */
  wrap(policy: Policy, shellArgv: readonly string[]): string;
  /** Whether a finished command's output identifies a policy denial. */
  matchesDenial(output: string): boolean;
  /** Whether a finished command's output identifies the runner failing before the command ran. */
  matchesRunnerFailure(output: string): boolean;
}

/** Whether any signature (case-insensitive substring) occurs in the output. */
function matches(output: string, signatures: readonly string[]): boolean {
  const lowered = output.toLowerCase();
  return signatures.some((signature) => lowered.includes(signature.toLowerCase()));
}

/** Wire the signatures of one rung into a `Confiner`'s classifiers. */
function confiner(
  name: Confiner["name"],
  program: string,
  wrap: Confiner["wrap"],
  denialSignatures: readonly string[],
  runnerFailureSignatures: readonly string[],
): Confiner {
  return {
    name,
    program,
    wrap,
    matchesDenial: (output) => matches(output, denialSignatures),
    matchesRunnerFailure: (output) => matches(output, runnerFailureSignatures),
  };
}

/** One-time functional bwrap probe (mirrors dsh's `defaultProbeBwrap`). */
function probeBwrap(config: Config): { ok: true } | { ok: false; reason: string } {
  try {
    const probe = spawnSync(
      config.bwrapPath,
      [...bwrapProfileArgs({ mode: "read-only", workspaceRoot: "/" }), "--", "true"],
      { timeout: config.probeTimeoutMs, stdio: "ignore" },
    );
    if (probe.error) return { ok: false, reason: probe.error.message };
    if (probe.status !== 0) return { ok: false, reason: `${config.bwrapPath} exited with status ${String(probe.status)}` };
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The Linux rung. */
function bwrapConfiner(config: Config): Confiner {
  return confiner(
    "bwrap",
    config.bwrapPath,
    (policy, shellArgv) =>
      [config.bwrapPath, ...bwrapProfileArgs(policy), "--", ...shellArgv].map(shellQuote).join(" "),
    BWRAP_DENIAL_SIGNATURES,
    BWRAP_RUNNER_FAILURE_SIGNATURES,
  );
}

/**
 * The darwin rung, probed in two forms: dsh's `--`-separated invocation first,
 * the separator-less one second. Both are the same profile; only the argv shape
 * differs, and the probe decides which this `sandbox-exec` accepts.
 */
function seatbeltConfiner(config: Config): { ok: true; confiner: Confiner } | { ok: false; reason: string } {
  for (const withSeparator of [true, false]) {
    if (!probeSeatbeltForm(config, withSeparator)) continue;
    return {
      ok: true,
      confiner: confiner(
        "seatbelt",
        config.seatbeltPath,
        (policy, shellArgv) =>
          seatbeltRunnerArgv(config, seatbeltProfileArgs(policy), withSeparator).concat(shellArgv).map(shellQuote).join(" "),
        SEATBELT_DENIAL_SIGNATURES,
        SEATBELT_RUNNER_FAILURE_SIGNATURES,
      ),
    };
  }
  return {
    ok: false,
    reason: `${config.seatbeltPath} could not apply a read-only profile on this host (missing, or refusing its profile)`,
  };
}

/**
 * Select and probe this platform's rung once.
 *
 * @param platform The host platform (injectable for tests).
 * @param config Extension configuration.
 * @returns The usable confiner, or the fail-closed reason.
 */
export function probeBackend(
  platform: NodeJS.Platform,
  config: Config,
): { ok: true; confiner: Confiner } | { ok: false; reason: string } {
  switch (platform) {
    case "linux": {
      const probe = probeBwrap(config);
      return probe.ok ? { ok: true, confiner: bwrapConfiner(config) } : probe;
    }
    case "darwin":
      return seatbeltConfiner(config);
    default:
      // win32 is handled by the state's platform fallback before execution ever
      // reaches a confined mode; anything else simply has no rung.
      return { ok: false, reason: `no sandbox backend is implemented on ${platform}` };
  }
}
