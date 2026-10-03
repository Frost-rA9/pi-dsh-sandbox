/**
 * Behavior parity with dsh for the escalation vocabulary. Every model-facing
 * string and the wider-mode table must match, because a dsh session and a pi
 * session must teach the same denial and the same retry.
 *
 * @module pi-dsh-sandbox/tests/escalation-parity
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as ours from "../src/escalation.ts";
import { loadDsh, paritySkip } from "./parity/dsh.ts";

interface DshEscalation {
  WIDER_MODES: Record<string, readonly string[]>;
  ESCALATION_TARGETS: readonly string[];
  validateEscalationArgs(sandboxPermissions: string | undefined, justification: string | undefined): void;
  sandboxDenialMarker(mode: string): string;
  escalationHintMarker(subject: string): string;
  sandboxPermissionsDescription(subject: string): string;
}

const MODES = ["read-only", "workspace-write", "danger-full-access"];
const SUBJECTS = ["command", "operation"];

function messageOf(run: () => void): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

test("the wider-mode table matches dsh", { skip: paritySkip }, async () => {
  const dsh = await loadDsh<DshEscalation>("packages/sandbox/sandbox/src/escalation.ts");
  assert.deepEqual(ours.WIDER_MODES, dsh.WIDER_MODES);
  assert.deepEqual(ours.ESCALATION_TARGETS, dsh.ESCALATION_TARGETS);
});

test("every model-facing escalation string matches dsh", { skip: paritySkip }, async () => {
  const dsh = await loadDsh<DshEscalation>("packages/sandbox/sandbox/src/escalation.ts");
  for (const mode of MODES) {
    assert.equal(ours.sandboxDenialMarker(mode as never), dsh.sandboxDenialMarker(mode), mode);
  }
  for (const subject of SUBJECTS) {
    assert.equal(ours.escalationHintMarker(subject), dsh.escalationHintMarker(subject), subject);
    assert.equal(ours.sandboxPermissionsDescription(subject), dsh.sandboxPermissionsDescription(subject), subject);
  }
});

test("validateEscalationArgs rejects the same pairings", { skip: paritySkip }, async () => {
  const dsh = await loadDsh<DshEscalation>("packages/sandbox/sandbox/src/escalation.ts");
  const cases: [string | undefined, string | undefined][] = [
    [undefined, undefined],
    ["workspace-write", "why"],
    [undefined, "why"],
    ["workspace-write", undefined],
    ["workspace-write", "   "],
  ];
  for (const [permissions, justification] of cases) {
    assert.equal(
      messageOf(() => ours.validateEscalationArgs(permissions, justification)),
      messageOf(() => dsh.validateEscalationArgs(permissions, justification)),
      `${permissions ?? "undefined"} / ${justification ?? "undefined"}`,
    );
  }
});
