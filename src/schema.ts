/**
 * TypeBox schema fields for the escalation parameters.
 *
 * Split out of `escalation.ts` so the vocabulary and approval choreography
 * stay dependency-free (and testable outside the pi runtime).
 *
 * @module pi-dsh-sandbox/schema
 */

import type { TSchema } from "typebox";
import { Type } from "typebox";
import { ESCALATION_TARGETS, sandboxPermissionsDescription } from "./escalation.ts";

/**
 * The schema fields a tool spreads into its `parameters` while confinement is
 * advertised (dsh `FsSandboxController.schemaFields`). The enum pins the closed
 * target vocabulary; the strict-wider check stays per call at execution.
 *
 * @param subject The family's noun for the denied action.
 * @returns The two escalation parameter specs.
 */
export function escalationSchemaFields(subject: string) {
  return {
    sandbox_permissions: Type.Optional(
      Type.Union(
        ESCALATION_TARGETS.map((target) => Type.Literal(target)),
        { description: sandboxPermissionsDescription(subject) },
      ),
    ),
    justification: Type.Optional(
      Type.String({
        description:
          `Required with sandbox_permissions: one sentence for the user explaining why this exact `
          + `${subject} needs the wider access. Use the language of the user's current request.`,
      }),
    ),
  };
}

/**
 * A confined tool's parameter schema: pi's own schema with the escalation
 * fields added on top, so a pi release that changes the tool's parameters
 * reaches the model without a hand copy drifting behind it. `scripts/
 * check-tool-shape.mjs` fails when the two disagree.
 *
 * @param base pi's definition parameters.
 * @param subject The family's noun for the denied action.
 * @returns The schema the tool registers.
 */
export function escalationParameters(base: TSchema, subject: string): TSchema {
  const properties = (base as { properties?: Record<string, unknown> }).properties ?? {};
  return {
    ...base,
    properties: { ...properties, ...escalationSchemaFields(subject) },
  } as unknown as TSchema;
}

/**
 * The schema fields on the program-running tool, with dsh's `run_code` texts
 * verbatim (dsh `packages/core/tools/src/ptc.ts`, `RUN_CODE_CONTROLS`). dsh
 * words this pair for a whole program rather than a single action, so it does
 * not use {@link escalationSchemaFields}'s per-action template.
 *
 * @returns The two program escalation parameter specs.
 */
export function programEscalationSchemaFields() {
  return {
    sandbox_permissions: Type.Optional(
      Type.Union(
        ESCALATION_TARGETS.map((target) => Type.Literal(target)),
        { description: "Wider sandbox mode for this complete program execution; requires justification and approval." },
      ),
    ),
    justification: Type.Optional(
      Type.String({
        description:
          "Reason this complete program needs wider access, shown to the user for approval. "
          + "Use the language of the user's current request.",
      }),
    ),
  };
}
