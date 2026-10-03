/**
 * The confined bash family: a `bash` tool override plus the `user_bash` (`!`)
 * path, both executing through the same bubblewrap-wrapped operations. Only
 * registered where a backend exists — a platform that falls back to
 * `danger-full-access` never mounts confinement at all.
 *
 * Ported from dsh `packages/shell/bash-sandbox/src/index.ts` (wrap the exact
 * argv, report the denial dialect) with pi's seams: dsh swaps `ctx.shell`, pi
 * overwrites the registered `bash` tool and answers the `user_bash` event.
 *
 * Escalation (`sandbox_permissions` + `justification`) is resolved per call
 * before execution, exactly like dsh's tool layer.
 *
 * @module pi-dsh-sandbox/bash
 */

import type {
  BashOperations,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createLocalBashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Confiner } from "./backend.ts";
import { SandboxUnavailableError } from "./backend.ts";
import { resolveCallPolicy } from "./calls.ts";
import { escalationHintMarker, sandboxDenialMarker } from "./escalation.ts";
import { escalationSchemaFields } from "./schema.ts";
import type { Policy } from "./modes.ts";
import { execPolicy, type SandboxState } from "./state.ts";

/** The family's noun in model-facing texts. */
const SUBJECT = "command";

/**
 * Build the sandbox-wrapping operations over pi's local shell mechanics, so
 * timeout, abort, output streaming, and truncation stay pi's own.
 *
 * Settings are read at EXECUTION time, never during loading: pi's action
 * methods (`getSettings`) throw while the extension is still loading. The
 * command prefix is applied here rather than by the tool definition for the
 * same reason, and it lands inside the sandbox either way.
 *
 * @param state The session sandbox state.
 * @param getPolicy The policy for the execution about to start.
 * @param getShell pi's resolved shell configuration (`settings.shellPath`
 *   included), so the confined child runs the SAME shell the unconfined tool
 *   would — a user who configured zsh must not silently get bash inside.
 * @param getCommandPrefix pi's `settings.shellCommandPrefix`, current per execution.
 * @returns Operations that run the wrapped command instead of the raw one.
 */
export function createBashOps(
  state: SandboxState,
  getPolicy: () => Policy,
  getShell: () => { shell: string },
  getCommandPrefix: () => string | undefined,
): BashOperations {
  return {
    exec: (command, cwd, options) => {
      const policy = getPolicy();
      state.assertBackend(policy.mode);
      const confiner = state.confiner as Confiner;
      if (policy.mode === "danger-full-access") return createLocalBashOperations().exec(command, cwd, options);
      const prefix = getCommandPrefix();
      const resolved = prefix === undefined ? command : `${prefix}\n${command}`;
      // pi's `-s`/stdin transport exists for the legacy WSL bash shim, which
      // cannot reach a confined rung anyway; `-c` is what every shell this
      // wrapper can confine accepts.
      const shell = getShell().shell;
      const wrapped = confiner.wrap(policy, [shell, "-c", resolved]);
      return createLocalBashOperations({ shellPath: shell }).exec(wrapped, cwd, options);
    },
  };
}

/** The shape of a pi tool result this module inspects (text content + error flag). */
interface ToolResultLike {
  content?: readonly { type: string; text?: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}

/** Text content of a bash result, joined for signature matching. */
function resultText(result: ToolResultLike): string {
  return (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/**
 * Turn a finished confined bash result into the model-facing facts.
 *
 * Runner failure outranks denial because the command never ran (dsh
 * `classifyRunnerFailure` before `classifyDenial`). A denial keeps the raw
 * output but leads with the shared marker and the escalation hint.
 *
 * @param result The base tool result.
 * @param policy The policy the command ran under.
 * @returns The result the model receives.
 */
export function annotateBashResult<T extends ToolResultLike>(result: T, policy: Policy, confiner: Confiner | undefined): T {
  if (policy.mode === "danger-full-access" || result.isError !== true || confiner === undefined) return result;
  const text = resultText(result);
  if (confiner.matchesRunnerFailure(text)) {
    throw new SandboxUnavailableError(policy.mode, text.split("\n").find((line) => confiner.matchesRunnerFailure(line)) ?? text);
  }
  if (!confiner.matchesDenial(text)) return result;
  const annotated = `${sandboxDenialMarker(policy.mode)}\n${escalationHintMarker(SUBJECT)}\n\n${text}`;
  const structuredContent =
    typeof result.structuredContent === "object" && result.structuredContent !== null
      ? { ...(result.structuredContent as Record<string, unknown>), output: annotated }
      : result.structuredContent;
  return {
    ...result,
    content: [{ type: "text", text: annotated }],
    structuredContent,
  } as T;
}

/**
 * Register the confined `bash` tool and the `user_bash` handler.
 *
 * @param pi The extension API.
 * @param state The session sandbox state.
 */
export function registerBashTool(pi: ExtensionAPI, state: SandboxState): void {
  // Read at execution time: pi's action methods throw during loading.
  const getShell = () => getShellConfig(pi.getSettings().shellPath);
  const getCommandPrefix = () => pi.getSettings().shellCommandPrefix;
  const base = createBashToolDefinition(process.cwd(), {
    operations: createBashOps(state, () => execPolicy.getStore() ?? state.resolve(), getShell, getCommandPrefix),
  });

  pi.registerTool({
    ...base,
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute (run through bash -c)" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
      ...escalationSchemaFields(SUBJECT),
    }),
    async execute(
      toolCallId: string,
      params: { command: string; timeout?: number; sandbox_permissions?: string; justification?: string },
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ExtensionToolContext,
    ) {
      const policy = await resolveCallPolicy(
        state,
        params,
        { ui: ctx.ui, hasUI: ctx.hasUI },
        "bash",
        SUBJECT,
      );
      const result = await execPolicy.run(policy, () =>
        (base.execute as unknown as (...args: unknown[]) => Promise<ToolResultLike>)(
          toolCallId,
          params,
          signal,
          onUpdate,
          ctx,
        ),
      );
      return annotateBashResult(result, policy, state.confiner);
    },
  } as unknown as ToolDefinition);

  // `!` and `!!` commands take the same confinement. A handler failure blocks
  // the command (pi never falls through to local execution), so an unusable
  // backend fails closed here too.
  pi.on("user_bash", () => {
    const policy = state.resolve();
    state.assertBackend(policy.mode);
    return { operations: createBashOps(state, () => policy, getShell, getCommandPrefix) };
  });
}
