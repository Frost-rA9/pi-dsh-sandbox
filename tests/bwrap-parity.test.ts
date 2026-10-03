/**
 * Behavior parity with dsh for the Linux bubblewrap profile: the same policy
 * must produce the same mount arguments, because that profile is the command
 * boundary on Linux.
 *
 * @module pi-dsh-sandbox/tests/bwrap-parity
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bwrapProfileArgs } from "../src/bwrap.ts";
import type { Policy } from "../src/modes.ts";
import type { SandboxMode } from "../src/modes.ts";
import { loadDsh, paritySkip } from "./parity/dsh.ts";

interface DshProfiles {
  bwrapProfileArgs(policy: { mode: string; workspaceRoot: string }): string[];
}

const MODES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

test("bwrapProfileArgs matches dsh for every mode", { skip: paritySkip }, async (t) => {
  const dsh = await loadDsh<DshProfiles>("packages/sandbox/sandbox-local/src/profiles.ts");
  const workspace = mkdtempSync(join(tmpdir(), "pi-dsh-bwrap-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  for (const mode of MODES) {
    const policy = { mode, workspaceRoot: workspace };
    assert.deepEqual(bwrapProfileArgs(policy as Policy), dsh.bwrapProfileArgs(policy), mode);
  }
});
