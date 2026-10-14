/**
 * The program-running tool: pi's `codemode` plus dsh's program-level escalation.
 *
 * Ported from dsh `packages/core/tools/src/ptc.ts` (`run_code`): escalation
 * fields on the tool call, one approval before the program runs, the approved
 * mode held for that one execution, and `escalationGuidance` teaching the
 * one-shot grant. dsh's policy confines the program's own process; pi's
 * codemode has no process, so the grant rides the run's nested calls instead
 * (`src/run-grant.ts`), the divergence chapter 4.3 records.
 *
 * pi does not export the codemode tool definition, only the extension factory,
 * so this module runs that factory against a registering proxy to capture the
 * definition and registers the wrapped one under the same name; pi replaces
 * the built-in tool of that name (`docs/mcp.md`).
 *
 * @module pi-dsh-sandbox/codemode
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
  ToolLoadout,
} from "@earendil-works/pi-coding-agent";
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveCallPolicy } from "./calls.ts";
import { beginRun, endRun } from "./run-grant.ts";
import { programEscalationSchemaFields } from "./schema.ts";
import type { SandboxState } from "./state.ts";

/** The family's noun in model-facing texts (dsh `subject: 'program'`). */
const SUBJECT = "program";

/** dsh `packages/core/tools/src/ptc.ts` (`escalationGuidance`), verbatim. */
const PROGRAM_GUIDANCE =
  "A sandbox escalation approves this complete program for one execution only. "
  + "Nested tools retain their own policies and approvals. Request wider access only after evidence of a denial. "
  + "Earlier effects may already have completed: inspect them before explicitly retrying. "
  + "Programs are never replayed automatically.";

/** A tool definition's parameter property map. */
type ParameterProperties = Record<string, unknown>;

/** The definition captured from the codemode extension factory. */
type CodemodeDefinition = ToolDefinition & { parameters: { properties?: ParameterProperties } };

/** Append the denial guidance to a finished run's result. */
function withProgramGuidance<T extends AgentToolResult<unknown>>(result: T): T {
  return {
    ...result,
    content: [...result.content, { type: "text" as const, text: PROGRAM_GUIDANCE }],
  };
}

/**
 * Register the confined `codemode` tool.
 *
 * @param pi The extension API.
 * @param state The session sandbox state.
 */
export function registerCodemode(pi: ExtensionAPI, state: SandboxState): void {
  let captured: CodemodeDefinition | undefined;
  const capture = new Proxy(pi, {
    get: (target, property, receiver) => property === "registerTool"
      ? (tool: CodemodeDefinition) => { captured = tool; }
      : Reflect.get(target, property, receiver),
  });
  createCodemodeExtension()(capture);
  if (captured === undefined) {
    throw new Error("pi-dsh-sandbox: the codemode extension registered no tool");
  }
  const base = captured;

  pi.registerTool({
    ...base,
    description: `${base.description} ${PROGRAM_GUIDANCE}`,
    parameters: Type.Object({
      ...(base.parameters.properties ?? {}),
      ...programEscalationSchemaFields(),
    }),
    // codemode replaces its own description whenever the active set changes,
    // so the guidance rides that projection too (dsh appends it to the tool
    // description the model sees).
    prepareLoadout: base.prepareLoadout === undefined ? undefined : (loadout: ToolLoadout) => {
      const changes = base.prepareLoadout?.(loadout) ?? {};
      const descriptions: Record<string, string> = { ...changes.descriptions };
      descriptions[base.name] = `${descriptions[base.name] ?? base.description} ${PROGRAM_GUIDANCE}`;
      return { ...changes, descriptions };
    },
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ExtensionToolContext,
    ) {
      const policy = await resolveCallPolicy(
        state,
        params,
        { ui: ctx.ui, hasUI: ctx.hasUI, signal },
        base.name,
        SUBJECT,
        toolCallId,
      );
      beginRun(toolCallId, policy.mode);
      let result: AgentToolResult<unknown>;
      try {
        result = await (base.execute as unknown as (...args: unknown[]) => Promise<AgentToolResult<unknown>>)(
          toolCallId,
          params,
          signal,
          onUpdate,
          ctx,
        );
      } catch (error: unknown) {
        const run = endRun(toolCallId);
        if (run?.denied === true) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`${message}\n\n${PROGRAM_GUIDANCE}`, { cause: error });
        }
        throw error;
      }
      return endRun(toolCallId)?.denied === true ? withProgramGuidance(result) : result;
    },
  } as unknown as ToolDefinition);
}
