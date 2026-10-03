/**
 * Session-scoped sandbox state: the deployment default, the `/sandbox`
 * override, the backend verdict, and the per-call policy resolution.
 *
 * Mirrors dsh `packages/sandbox/sandbox-policy/src/{index,session-mode}.ts`
 * adapted to pi's storage model: pi has no log-only session event and no
 * projection registry, so the override is one `pi.appendEntry` custom entry
 * (durable, never sent to the LLM) restored from the active branch at session
 * start. Precedence is unchanged: approved escalation grant > session override
 * > deployment default.
 *
 * Platform fallback: win32 has no confinement backend here yet, so a confined
 * mode cannot be honestly promised — every confined request resolves to
 * `danger-full-access` instead of a half-enforced `read-only` (the fence cannot
 * govern commands there, and command execution is the larger write surface).
 * The session says so at start and in the footer, and no confinement tool is
 * registered.
 *
 * @module pi-dsh-sandbox/state
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SandboxUnavailableError, probeBackend, type Confiner } from "./backend.ts";
import {
  DEFAULT_CONFIG,
  isSandboxMode,
  parseConfig,
  type Config,
  type Policy,
  type SandboxMode,
} from "./modes.ts";

/** Custom entry type carrying the session's sandbox-mode override. */
export const MODE_ENTRY = "dsh-sandbox-mode";

/** Footer status key. */
export const STATUS_KEY = "dsh-sandbox";

/** The policy of the execution currently running on this async chain (bash). */
export const execPolicy = new AsyncLocalStorage<Policy>();

/** The topic the footer colour communicates, from safest tier to loudest. */
export type StatusColor = "success" | "accent" | "warning" | "error";

/** What happened to a requested mode selection. */
export interface ModeSelection {
  /** The mode actually recorded (after the platform ceiling). */
  mode: SandboxMode;
  /** Whether the requested mode was narrowed by the platform ceiling. */
  downgraded: boolean;
  /** The mode that was requested, for the user-facing notice. */
  requested: SandboxMode;
}

/** One session's sandbox state. */
export class SandboxState {
  /** Validated configuration (global file overridden by project file). */
  config: Config = { ...DEFAULT_CONFIG };

  /** The protocol's config error, if any; a configured session fails closed. */
  configError: string | undefined;

  /** The probed, usable backend — undefined until {@link probeBackend} runs, or when none is usable. */
  confiner: Confiner | undefined;

  /** Why no backend is usable, when none is. */
  backendFailure: string | undefined = "backend not probed yet";

  /** Session override; `undefined` means the deployment default applies. */
  private override: SandboxMode | undefined;

  /** Session cwd — the `workspace-write` boundary. */
  private workspaceRoot: string = process.cwd();

  /** Host platform (injectable so the ceiling is testable off-win32). */
  private readonly platform: NodeJS.Platform;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.platform = platform;
  }

  /** The host platform this state was created for. */
  get hostPlatform(): NodeJS.Platform {
    return this.platform;
  }

  /**
   * The mode this platform falls back to when it has no confinement backend.
   * win32 has none yet: rather than promise a boundary that cannot cover
   * commands, every confined request resolves to `danger-full-access`. macOS is
   * deliberately NOT capped here — it fails closed at execution instead,
   * because a missing Seatbelt runner is a host fact, not a platform limit.
   */
  get fallbackMode(): SandboxMode | undefined {
    return this.platform === "win32" ? "danger-full-access" : undefined;
  }

  /** Apply the platform fallback to a requested mode. */
  private applyFallback(mode: SandboxMode): { mode: SandboxMode; downgraded: boolean } {
    const fallback = this.fallbackMode;
    if (fallback === undefined || mode === fallback) return { mode, downgraded: false };
    return { mode: fallback, downgraded: true };
  }

  /** Whether the platform fallback is currently replacing the configured mode. */
  get platformFallback(): boolean {
    return this.applyFallback(this.override ?? this.config.mode).downgraded;
  }

  /** Why the platform falls back, for user-facing notices. */
  fallbackReason(): string | undefined {
    if (this.fallbackMode === undefined) return undefined;
    return `no sandbox backend is implemented on ${this.platform}`;
  }

  /** Record the session cwd and reset per-session state. */
  beginSession(ctx: ExtensionContext): void {
    this.workspaceRoot = ctx.cwd;
    this.override = undefined;
  }

  /** Load configuration; failures are recorded and fail closed (read-only). */
  loadConfig(raw: unknown): void {
    try {
      this.config = parseConfig(raw);
      this.configError = undefined;
    } catch (error: unknown) {
      this.configError = error instanceof Error ? error.message : String(error);
      // A broken config never widens access: fall back to the strictest mode.
      this.config = { ...this.config, mode: "read-only" };
    }
  }

  /** Probe this platform's backend once; a failure disables confined execution. */
  probeBackend(): void {
    const result = probeBackend(this.platform, this.config);
    if (result.ok) {
      this.confiner = result.confiner;
      this.backendFailure = undefined;
    } else {
      this.confiner = undefined;
      this.backendFailure = result.reason;
    }
  }

  /** The session's effective mode without applying a per-call grant. */
  effectiveMode(): SandboxMode {
    return this.applyFallback(this.override ?? this.config.mode).mode;
  }

  /**
   * Resolve the complete policy for one capability call.
   *
   * @param approvedMode A granted escalation mode, which outranks the session override.
   * @returns The fully resolved per-call mode and absolute workspace root.
   */
  resolve(approvedMode?: SandboxMode): Policy {
    return {
      mode: this.applyFallback(approvedMode ?? this.override ?? this.config.mode).mode,
      workspaceRoot: this.workspaceRoot,
    };
  }

  /**
   * Select a new session override: the switch IS its entry, so a resume replays
   * it (dsh's `setSandboxMode`). The platform fallback replaces the recorded mode.
   *
   * @param pi The extension API, for the durable entry.
   * @param mode The requested mode.
   * @returns What was recorded, and whether the ceiling narrowed it.
   */
  setOverride(pi: ExtensionAPI, mode: SandboxMode): ModeSelection {
    const capped = this.applyFallback(mode);
    this.override = capped.mode;
    pi.appendEntry(MODE_ENTRY, { mode: capped.mode });
    return { ...capped, requested: mode };
  }

  /** Restore the override from the active branch at session start. */
  restore(branch: readonly { type: string; customType?: string; data?: unknown }[]): void {
    for (const entry of branch) {
      if (entry.type !== "custom" || entry.customType !== MODE_ENTRY) continue;
      const mode = (entry.data as { mode?: unknown } | undefined)?.mode;
      if (isSandboxMode(mode)) this.override = mode;
    }
  }

  /**
   * Fail closed before a confined execution when no usable backend exists.
   * `danger-full-access` never calls the backend, so it is exempt — precisely
   * dsh's rule that a full-access consumer does not reach `ctx.sandbox`. A
   * platform fallback (win32) never produces a confined mode in the first
   * place, so this guard covers host-level backend absence only.
   *
   * @param mode The mode this execution would run under.
   */
  assertBackend(mode: SandboxMode): void {
    if (mode === "danger-full-access") return;
    if (this.confiner === undefined) throw new SandboxUnavailableError(mode, this.backendFailure);
  }

  /**
   * The footer indicator: `[sandbox::<tier>]` carrying the session's EFFECTIVE
   * tier. A confined tier that no backend can enforce reports
   * `[sandbox::unavailable]` instead, because claiming the tier would be a lie;
   * `danger-full-access` needs no backend and reports itself. The colour the
   * caller sets carries the warning.
   */
  statusText(): string {
    const mode = this.effectiveMode();
    if (this.confiner === undefined && mode !== "danger-full-access") return "[sandbox::unavailable]";
    return `[sandbox::${mode}]`;
  }

  /**
   * The footer colour for the session's state — a gradient, so the three tiers
   * are distinguishable at a glance: `read-only` is the safe end (`success`),
   * `workspace-write` the working default (`accent`), `danger-full-access` the
   * loud end (`warning`), and a confined tier no backend can enforce is `error`.
   */
  statusColor(): StatusColor {
    const mode = this.effectiveMode();
    if (mode === "danger-full-access") return "warning";
    if (this.confiner === undefined) return "error";
    return mode === "read-only" ? "success" : "accent";
  }

  /** Whether confined execution is currently runnable. */
  get backendReady(): boolean {
    return this.confiner !== undefined;
  }

  /** Why the backend is unusable, when it is. */
  backendReason(): string | undefined {
    return this.confiner === undefined ? this.backendFailure : undefined;
  }

  /** The probed rung's name, for status text. */
  get backendName(): string {
    return this.confiner?.name ?? "none";
  }

  /** The probed rung's runner executable, for status text. */
  backendProgram(): string | undefined {
    return this.confiner?.program;
  }
}
