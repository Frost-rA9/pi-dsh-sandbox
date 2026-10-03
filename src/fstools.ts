/**
 * The write/edit family: pi's built-in definitions with their operations
 * replaced by the dsh filesystem fence.
 *
 * Ported from dsh `packages/fs/fs-sandbox/src/index.ts` (fence on the two
 * mutations, fresh-target delegation) and `packages/fs/tool-fs/src/{write,edit}.ts`
 * (per-call policy + escalation fields). Reads, listings, and the edit tool's
 * content read pass through untouched, because every mode permits reading
 * (dsh: "Reads pass through untouched"); the edit tool's access check is a
 * write-intent check and is fenced with the mutation.
 *
 * Reusing pi's own definitions keeps the diff renderers, the read-before-edit
 * mechanics, and `withFileMutationQueue` (which wraps the operations calls, so
 * the fence runs inside the per-path critical section).
 *
 * @module pi-dsh-sandbox/fstools
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { access as fsAccess, mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import type {
  EditOperations,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveCallPolicy, type EscalationArgs } from "./calls.ts";
import { escalationHintMarker, sandboxDenialMarker, DENIAL_MARKER_PREFIX } from "./escalation.ts";
import { escalationSchemaFields } from "./schema.ts";
import { checkedTarget } from "./fence.ts";
import type { Policy } from "./modes.ts";
import type { SandboxState } from "./state.ts";

/** The family's noun in model-facing texts. */
const SUBJECT = "operation";

/**
 * Map a fence denial back to the shared vocabulary (dsh
 * `FsSandboxController.mapError`, which likewise takes the call's policy).
 *
 * pi's built-in edit tool wraps an `access`-check failure into
 * `Could not edit file: <path>. Error code: FS_SANDBOX_DENIED.` — printing the
 * CODE instead of the message, so the marker is gone by the time the tool
 * returns. Recognizing the denial by either the marker text (unwrapped path:
 * mkdir/writeFile) or the code (wrapped path) and rebuilding the message from
 * the policy keeps both families on one vocabulary.
 *
 * @param error The error thrown by the tool execution.
 * @param policy The policy the call ran under.
 * @returns The error the model should receive.
 */
function mapFsError(error: unknown, policy: Policy): unknown {
  if (policy.mode === "danger-full-access") return error;
  const message = error instanceof Error ? error.message : String(error);
  const markerAt = message.indexOf(DENIAL_MARKER_PREFIX);
  if (markerAt === 0) return error;
  if (markerAt > 0) return new Error(message.slice(markerAt));
  if (!message.includes("FS_SANDBOX_DENIED")) return error;
  return new Error(`${sandboxDenialMarker(policy.mode)}\n${escalationHintMarker(SUBJECT)}`);
}

/** The policy of the mutation currently running (set per tool call). */
export const fencePolicy = new AsyncLocalStorage<Policy>();

/** The fence's policy, or a hard failure — a fenced operation without one is a bug. */
function requirePolicy(): Policy {
  const policy = fencePolicy.getStore();
  if (policy === undefined) {
    throw new Error("pi-dsh-sandbox: filesystem fence ran without a resolved policy");
  }
  return policy;
}

/** The `write` tool's validated arguments (pi's fields plus the escalation pair). */
interface WriteParams extends EscalationArgs {
  path: string;
  content: string;
}

/** The `edit` tool's validated arguments (pi's fields plus the escalation pair). */
interface EditParams extends EscalationArgs {
  path: string;
  edits: { oldText: string; newText: string }[];
}

/** Write operations with the fence on both mutations (create-or-overwrite path). */
export function fencedWriteOps(): WriteOperations {
  return {
    async mkdir(dir: string): Promise<void> {
      await fsMkdir(await checkedTarget(dir, requirePolicy()), { recursive: true });
    },
    async writeFile(path: string, content: string): Promise<void> {
      // The FRESH canonical target is the one written: a symlink ancestor
      // swapped since the tool resolved the path is caught by this check.
      await fsWriteFile(await checkedTarget(path, requirePolicy()), content, "utf-8");
    },
  };
}

/** Edit operations: the access check and the write are fenced, reads pass through. */
export function fencedEditOps(): EditOperations {
  return {
    async access(path: string): Promise<void> {
      // The edit tool's access check is a WRITE-intent check (R_OK|W_OK on the
      // very target it is about to rewrite), so fencing it keeps the denial
      // deterministic: without this, a read-only session editing a missing file
      // would get pi's bare "Could not edit file … ENOENT" instead of the shared
      // marker and the escalation hint. A workspace-write path passes the fence
      // and then gets the real check unchanged.
      await checkedTarget(path, requirePolicy());
      await fsAccess(path, constants.R_OK | constants.W_OK);
    },
    readFile: (path: string) => fsReadFile(path),
    async writeFile(path: string, content: string): Promise<void> {
      await fsWriteFile(await checkedTarget(path, requirePolicy()), content, "utf-8");
    },
  };
}

/**
 * Register the fenced `write` and `edit` tools.
 *
 * @param pi The extension API.
 * @param state The session sandbox state.
 */
export function registerFsTools(pi: ExtensionAPI, state: SandboxState): void {
  const writeBase = createWriteToolDefinition(process.cwd(), { operations: fencedWriteOps() });
  const editBase = createEditToolDefinition(process.cwd(), { operations: fencedEditOps() });

  const run = async <T>(
    base: { execute: unknown },
    toolName: string,
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionToolContext,
  ): Promise<T> => {
    const policy = await resolveCallPolicy(
      state,
      params as { sandbox_permissions?: string; justification?: string },
      { ui: ctx.ui, hasUI: ctx.hasUI },
      toolName,
      SUBJECT,
    );
    try {
      return await fencePolicy.run(policy, () =>
        (base.execute as (...args: unknown[]) => Promise<T>)(toolCallId, params, signal, onUpdate, ctx),
      );
    } catch (error: unknown) {
      throw mapFsError(error, policy);
    }
  };

  pi.registerTool({
    ...writeBase,
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
      content: Type.String({ description: "Content to write to the file" }),
      ...escalationSchemaFields(SUBJECT),
    }),
    execute: (
      toolCallId: string,
      params: WriteParams,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ExtensionToolContext,
    ) => run(writeBase, "write", toolCallId, params, signal, onUpdate, ctx),
  } as unknown as ToolDefinition);

  pi.registerTool({
    ...editBase,
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({ description: "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call." }),
          newText: Type.String({ description: "Replacement text for this targeted edit." }),
        }),
        {
          description:
            "One or more targeted replacements. Each edit is matched against the original file, not incrementally. "
            + "Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
        },
      ),
      ...escalationSchemaFields(SUBJECT),
    }),
    execute: (
      toolCallId: string,
      params: EditParams,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ExtensionToolContext,
    ) => run(editBase, "edit", toolCallId, params, signal, onUpdate, ctx),
  } as unknown as ToolDefinition);
}
