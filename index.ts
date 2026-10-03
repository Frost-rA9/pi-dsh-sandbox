/**
 * pi-dsh-sandbox — dsh-style file-effect sandbox for pi.
 *
 * Modes are dsh's (`read-only` / `workspace-write` / `danger-full-access`), the
 * enforcement is two dialects over one policy:
 *
 * - write/edit: an in-process fence over pi's own tool operations (dsh
 *   `fs-sandbox`) — a policy check in trusted code, not a kernel boundary.
 * - bash and `!` commands: bubblewrap mounts (dsh `sandbox-local`'s Linux rung).
 *
 * Escalation (`sandbox_permissions` + `justification`, strictly wider, approved
 * once per call) and every model-facing string are ported verbatim from dsh.
 *
 * See README.md for the fidelity table and known limitations.
 *
 * @module pi-dsh-sandbox
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerBashTool } from "./src/bash.ts";
import { registerFsTools } from "./src/fstools.ts";
import { SANDBOX_MODES, isConfined, isSandboxMode, type SandboxMode } from "./src/modes.ts";
import { MODE_ENTRY, STATUS_KEY, SandboxState } from "./src/state.ts";
import { SANDBOX_NOTICE_TYPE, sandboxSwitchNotice } from "./src/notice.ts";

/** Global config file name under `<agentDir>/extensions/`. */
const GLOBAL_CONFIG_FILE = "pi-dsh-sandbox.json";

/** Project config file name under `<cwd>/.pi/`. */
const PROJECT_CONFIG_FILE = "dsh-sandbox.json";

/** Read one JSON config file; a missing file is fine, a broken one is reported. */
function readConfigFile(path: string, errors: string[]): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      errors.push(`${path}: expected a JSON object`);
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (error: unknown) {
    errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** Merge the global and project config files, project taking precedence. */
function loadRawConfig(cwd: string): { raw: unknown; errors: string[] } {
  const errors: string[] = [];
  const globalConfig = readConfigFile(join(getAgentDir(), "extensions", GLOBAL_CONFIG_FILE), errors);
  const projectConfig = readConfigFile(join(cwd, CONFIG_DIR_NAME, PROJECT_CONFIG_FILE), errors);
  return { raw: { ...globalConfig, ...projectConfig }, errors };
}

/** Render the footer status for the current state. */
function updateStatus(state: SandboxState, ctx: ExtensionContext): void {
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(state.statusColor(), state.statusText()));
}

/** The multi-line state report used when no dialog channel exists. */
function statusReport(state: SandboxState, confinementMounted: boolean): string {
  const lines = [
    `mode: ${state.effectiveMode()}${state.config.mode !== state.effectiveMode() ? ` (configured: ${state.config.mode})` : ""}`,
    `host: ${state.hostPlatform}`,
    `workspace root: ${state.resolve().workspaceRoot}`,
    confinementMounted ? "confinement: mounted" : `confinement: not mounted — ${state.fallbackReason() ?? "no backend"}`,
    `command backend: ${state.backendReady ? `ready (${state.backendName}: ${state.backendProgram()})` : `unavailable — ${state.backendReason() ?? "unknown"}`}`,
  ];
  return lines.join("\n");
}

/**
 * Apply one mode selection: confirm an explicit full-access request when a
 * dialog channel exists (dsh's browser keeps the same acknowledgement), record
 * it, report the outcome, and tell the model when the effective tier changed.
 */
async function applyMode(
  pi: ExtensionAPI,
  state: SandboxState,
  ctx: ExtensionContext,
  mode: SandboxMode,
): Promise<void> {
  if (mode === "danger-full-access" && ctx.hasUI && state.effectiveMode() !== "danger-full-access") {
    const confirmed = await ctx.ui.confirm(
      "Disable the file sandbox?",
      "danger-full-access lets commands and file writes reach anything this user can.",
    );
    if (!confirmed) {
      ctx.ui.notify("Sandbox mode unchanged.", "info");
      return;
    }
  }
  const before = state.effectiveMode();
  const selection = state.setOverride(pi, mode);
  updateStatus(state, ctx);
  // One visible model-facing notice per real switch. Sending it only when the
  // effective tier changed keeps a repeat selection and a downgraded request
  // quiet, and the startup flags never reach this path.
  if (state.effectiveMode() !== before) {
    pi.sendMessage(
      {
        customType: SANDBOX_NOTICE_TYPE,
        content: sandboxSwitchNotice(state.effectiveMode(), state.resolve().workspaceRoot),
        display: true,
        details: undefined,
      },
      ctx.isIdle() ? undefined : { deliverAs: "steer" },
    );
  }
  ctx.ui.notify(
    selection.downgraded
      ? `Sandbox mode: danger-full-access (${selection.requested} cannot be enforced — ${state.fallbackReason() ?? "no backend"})`
      : `Sandbox mode: ${selection.mode}`,
    selection.downgraded ? "warning" : "info",
  );
}

export default function dshSandbox(pi: ExtensionAPI): void {
  pi.registerFlag("sandbox-mode", {
    description: `Initial sandbox mode (${SANDBOX_MODES.join(" | ")})`,
    type: "string",
  });
  pi.registerFlag("no-sandbox", {
    description: "Start with danger-full-access (no confinement)",
    type: "boolean",
  });

  const state = new SandboxState();
  const confinementMounted = state.fallbackMode === undefined;

  // Confinement is mounted only where a backend can enforce it. On a platform
  // that falls back (win32) the built-in tools stay untouched and none of the
  // escalation schema is advertised — dsh's rule that an unconfined composition
  // mounts no confinement capability and no escalation fields.
  if (confinementMounted) {
    registerBashTool(pi, state);
    registerFsTools(pi, state);
  }
  pi.on("session_start", async (_event, ctx) => {
    state.beginSession(ctx);

    const { raw, errors } = loadRawConfig(ctx.cwd);
    for (const error of errors) ctx.ui.notify(`pi-dsh-sandbox: ${error}`, "error");
    state.loadConfig(raw);
    state.probeBackend();
    // The restored session override is the base; an explicit CLI flag outranks it.
    state.restore(ctx.sessionManager.getBranch());
    let selection: { mode: SandboxMode; downgraded: boolean; requested: SandboxMode } | undefined;
    if (pi.getFlag("no-sandbox") === true) {
      selection = state.setOverride(pi, "danger-full-access");
    } else {
      const flag = pi.getFlag("sandbox-mode");
      if (typeof flag === "string") {
        if (isSandboxMode(flag)) selection = state.setOverride(pi, flag);
        else ctx.ui.notify(`pi-dsh-sandbox: unknown --sandbox-mode "${flag}"`, "warning");
      }
    }
    if (selection?.downgraded === true) {
      ctx.ui.notify(
        `pi-dsh-sandbox: ${selection.requested} cannot be enforced — ${state.fallbackReason() ?? "no backend"}; running danger-full-access instead (writes are not confined)`,
        "warning",
      );
    } else if (selection === undefined && state.platformFallback) {
      ctx.ui.notify(
        `pi-dsh-sandbox: ${state.fallbackReason() ?? "no backend"} — the configured ${state.config.mode} cannot be enforced; running danger-full-access (writes are not confined)`,
        "warning",
      );
    }
    if (state.configError !== undefined) {
      ctx.ui.notify(`pi-dsh-sandbox: ${state.configError}`, "error");
    }
    if (!state.backendReady && isConfined(state.effectiveMode())) {
      ctx.ui.notify(
        `pi-dsh-sandbox: ${state.backendReason() ?? "no confinement backend is available"} — confined commands are refused until a backend works or the session switches to danger-full-access`,
        "warning",
      );
    }
    updateStatus(state, ctx);
  });

  pi.registerCommand("sandbox", {
    description: "Show or change the file-effect sandbox mode",
    handler: async (args, ctx) => {
      const requested = args.trim();

      // Bare `/sandbox`: an interactive picker wherever a dialog channel exists
      // (pi implements `select` for TUI and RPC alike), and the text report
      // otherwise — print and JSON sessions must still learn the state.
      if (requested === "") {
        if (!ctx.hasUI) {
          ctx.ui.notify(statusReport(state, confinementMounted), "info");
          return;
        }
        const current = state.effectiveMode();
        const options = SANDBOX_MODES.map((mode) => ({
          label: mode === current ? `${mode} · current` : mode,
          mode,
        }));
        const choice = await ctx.ui.select(
          `File-effect sandbox — host ${state.hostPlatform}, backend ${state.backendReady ? `ready (${state.backendName})` : "unavailable"}`,
          options.map((option) => option.label),
        );
        const picked = options.find((option) => option.label === choice)?.mode;
        if (picked === undefined) {
          ctx.ui.notify("Sandbox mode unchanged.", "info");
          return;
        }
        await applyMode(pi, state, ctx, picked);
        return;
      }

      const mode: SandboxMode | undefined =
        requested === "off" ? "danger-full-access" : isSandboxMode(requested) ? requested : undefined;
      if (mode === undefined) {
        ctx.ui.notify(
          `Unknown mode "${requested}". Use ${SANDBOX_MODES.join(", ")}, or off. Run /sandbox without arguments for a picker.`,
          "warning",
        );
        return;
      }
      await applyMode(pi, state, ctx, mode);
    },
  });
}

// Re-exported for tests and for a future plan-mode integration.
export { MODE_ENTRY, STATUS_KEY };
