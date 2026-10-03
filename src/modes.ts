/**
 * Sandbox vocabulary and configuration.
 *
 * Ported from dsh `packages/sandbox/sandbox/src/index.ts` (mode union,
 * `SandboxExecutionPolicy`) and `packages/sandbox/sandbox-policy/src/index.ts`
 * (deployment default). The vocabulary governs FILE EFFECTS only; network and
 * process visibility are deliberately outside it, exactly as in dsh.
 *
 * @module pi-dsh-sandbox/modes
 */

/** Every sandbox mode, for option advertisement and untrusted-value validation. */
export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;

/**
 * File-effect policy for confined executions. `read-only` permits only required
 * sinks such as `/dev/null`; `workspace-write` also permits the workspace and a
 * platform temp area; `danger-full-access` bypasses confinement.
 */
export type SandboxMode = (typeof SANDBOX_MODES)[number];

/** A confining (non-`danger-full-access`) mode. */
export type ConfinedSandboxMode = Exclude<SandboxMode, "danger-full-access">;

/**
 * The complete file-effect policy resolved for one capability call. Mirrors dsh
 * `SandboxExecutionPolicy` without the `sessionId` (pi is one session per
 * process, so no backend keys per-session state off it).
 */
export interface Policy {
  /** The file-effect mode this execution runs under. */
  mode: SandboxMode;
  /** Absolute root directory `workspace-write` may write under. */
  workspaceRoot: string;
}

/** Extension configuration (project file overrides the global one). */
export interface Config {
  /**
   * Mode a session starts from before a `/sandbox` override.
   *
   * Matches dsh's shipped surface default: `packages/bundle/base/cordis.patch.yml`
   * pins `DSH_PERMISSION_MODE ?? 'workspace-write'` (`workspace-write` file
   * effects + `ask` approval). dsh's package-level fallback is narrower
   * (`read-only`); a deployment that wants that fail-safe sets it here.
   */
  mode: SandboxMode;
  /** bubblewrap executable used for the Linux OS-level boundary and its probe. */
  bwrapPath: string;
  /** `sandbox-exec` executable used for the macOS Seatbelt boundary and its probe. */
  seatbeltPath: string;
  /** Positive timeout for the one-time functional backend probe. */
  probeTimeoutMs: number;
}

/** Defaults; every field is optional in config files. */
export const DEFAULT_CONFIG: Config = {
  mode: "workspace-write",
  bwrapPath: "bwrap",
  seatbeltPath: "sandbox-exec",
  probeTimeoutMs: 5_000,
};

/** Whether an untrusted value is a sandbox mode. */
export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === "string" && (SANDBOX_MODES as readonly string[]).includes(value);
}

/** Whether a mode reaches the confinement path (`danger-full-access` does not). */
export function isConfined(mode: SandboxMode): mode is ConfinedSandboxMode {
  return mode !== "danger-full-access";
}

/**
 * Validate a raw config object. Unknown keys and bad values FAIL rather than
 * being ignored, following dsh's config contract (`resolveConfig`).
 *
 * @param raw Parsed JSON from a config file.
 * @returns a detached, fully defaulted config.
 */
export function parseConfig(raw: unknown): Config {
  if (raw === undefined || raw === null) return { ...DEFAULT_CONFIG };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("pi-dsh-sandbox: config must be a JSON object");
  }
  const input = raw as Record<string, unknown>;
  const unknown = Object.keys(input).filter(
    (key) => !["mode", "bwrapPath", "seatbeltPath", "probeTimeoutMs"].includes(key),
  );
  if (unknown.length > 0) {
    throw new Error(
      `pi-dsh-sandbox: unknown config key(s) ${unknown.join(", ")} — config is { mode, bwrapPath, seatbeltPath, probeTimeoutMs }`,
    );
  }
  const mode = input.mode ?? DEFAULT_CONFIG.mode;
  if (!isSandboxMode(mode)) {
    throw new Error(
      `pi-dsh-sandbox: config "mode" must be one of ${SANDBOX_MODES.join(", ")}`,
    );
  }
  const bwrapPath = input.bwrapPath ?? DEFAULT_CONFIG.bwrapPath;
  if (typeof bwrapPath !== "string" || bwrapPath.trim() === "") {
    throw new Error("pi-dsh-sandbox: config \"bwrapPath\" must be a non-empty string");
  }
  const seatbeltPath = input.seatbeltPath ?? DEFAULT_CONFIG.seatbeltPath;
  if (typeof seatbeltPath !== "string" || seatbeltPath.trim() === "") {
    throw new Error("pi-dsh-sandbox: config \"seatbeltPath\" must be a non-empty string");
  }
  const probeTimeoutMs = input.probeTimeoutMs ?? DEFAULT_CONFIG.probeTimeoutMs;
  if (!Number.isFinite(probeTimeoutMs) || (probeTimeoutMs as number) <= 0) {
    throw new Error("pi-dsh-sandbox: config \"probeTimeoutMs\" must be a positive finite number");
  }
  return { mode, bwrapPath, seatbeltPath, probeTimeoutMs: probeTimeoutMs as number };
}
