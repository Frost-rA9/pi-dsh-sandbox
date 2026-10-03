/**
 * TypeBox schema fields for the escalation parameters.
 *
 * Split out of `escalation.ts` so the vocabulary and approval choreography
 * stay dependency-free (and testable outside the pi runtime).
 *
 * @module pi-dsh-sandbox/schema
 */

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
