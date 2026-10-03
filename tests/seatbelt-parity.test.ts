/**
 * Behavior parity with dsh for the macOS Seatbelt profile: the same policy
 * must produce the same SBPL profile, because that profile is the command
 * boundary on macOS.
 *
 * @module pi-dsh-sandbox/tests/seatbelt-parity
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { seatbeltProfileArgs } from "../src/seatbelt.ts";
import type { Policy, SandboxMode } from "../src/modes.ts";
import { loadDsh, paritySkip } from "./parity/dsh.ts";

interface DshProfiles {
  seatbeltProfileArgs(policy: { mode: string; workspaceRoot: string }): string[];
}

const MODES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

test("seatbeltProfileArgs matches dsh for every mode", { skip: paritySkip }, async (t) => {
  const dsh = await loadDsh<DshProfiles>("packages/sandbox/sandbox-local/src/profiles.ts");
  const workspace = mkdtempSync(join(tmpdir(), "pi-dsh-seatbelt-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  for (const mode of MODES) {
    const policy = { mode, workspaceRoot: workspace };
    assert.deepEqual(seatbeltProfileArgs(policy as Policy), dsh.seatbeltProfileArgs(policy), mode);
  }
});
