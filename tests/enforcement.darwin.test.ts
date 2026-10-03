/**
 * Real macOS enforcement through Apple's `sandbox-exec`.
 *
 * Skips everywhere except macOS; on a Mac (or GitHub's `macos-latest` runner)
 * this is the test that completes the darwin rung: it proves the profile is
 * accepted by the kernel and that `sandbox-exec` actually denies the writes the
 * `Policy` promises. The fake runner in `seatbelt.test.ts` cannot prove that,
 * and this suite is the reason the rung can claim parity with Linux at all.
 *
 * A failing probe is a FAILURE here, never a skip: a macOS without a usable
 * `sandbox-exec` is exactly the signal the extension's fail-closed gate exists
 * for.
 *
 * @module pi-dsh-sandbox/tests/enforcement.darwin.test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { probeBackend, type Confiner } from "../src/backend.ts";
import { DEFAULT_CONFIG, type Policy } from "../src/modes.ts";
import { canonicalPath } from "../src/roots.ts";

const onDarwin = process.platform === "darwin";
const skip = onDarwin ? false : "macOS only (Seatbelt)";
const probe = probeBackend("darwin", DEFAULT_CONFIG);

/** The probed confiner, failing loudly when the host has none. */
function confiner(): Confiner {
  assert.equal(
    probe.ok,
    true,
    probe.ok ? "" : `sandbox-exec is not usable on this host: ${(probe as { reason: string }).reason}`,
  );
  return (probe as { ok: true; confiner: Confiner }).confiner;
}

/** Run one confined shell command through the probed rung. */
function run(policy: Policy, command: string): { status: number | null; stderr: string } {
  const wrapped = confiner().wrap(policy, ["/bin/bash", "-c", command]);
  const result = spawnSync("/bin/bash", ["-c", wrapped], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr ?? "" };
}

test("darwin: sandbox-exec exists and accepts our read-only profile", { skip }, () => {
  const probed = confiner();
  assert.equal(probed.name, "seatbelt");
  // The probe already ran the profile through `sandbox_init`; reaching here
  // means the kernel accepted it in whichever separator form this host wants.
  assert.match(probed.program, /sandbox-exec$/);
});

test("darwin: read-only denies a workspace write with the EPERM dialect", { skip }, () => {
  const workspace = mkdtempSync(join(homedir(), ".pi-dsh-darwin-ro-"));
  try {
    const target = join(workspace, "written.txt");
    const result = run({ mode: "read-only", workspaceRoot: workspace }, `echo hi > '${target}'`);
    assert.notEqual(result.status, 0);
    assert.equal(confiner().matchesDenial(result.stderr), true, `stderr: ${result.stderr}`);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("darwin: workspace-write allows the workspace and denies the rest of $HOME", { skip }, () => {
  const workspace = mkdtempSync(join(homedir(), ".pi-dsh-darwin-ws-"));
  const outside = join(homedir(), `.pi-dsh-darwin-outside-${process.pid}.txt`);
  try {
    const inside = join(workspace, "written.txt");
    const allowed = run({ mode: "workspace-write", workspaceRoot: workspace }, `echo hi > '${inside}'`);
    assert.equal(allowed.status, 0, `stderr: ${allowed.stderr}`);
    assert.equal(readFileSync(inside, "utf-8"), "hi\n");

    const denied = run({ mode: "workspace-write", workspaceRoot: workspace }, `echo hi > '${outside}'`);
    assert.notEqual(denied.status, 0);
    assert.equal(confiner().matchesDenial(denied.stderr), true, `stderr: ${denied.stderr}`);
    assert.equal(existsSync(outside), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test("darwin: workspace-write allows the temp areas, /tmp spelling included", { skip }, () => {
  // `/tmp` is `/private/tmp` on macOS and `os.tmpdir()` is a per-user
  // /var/folders path: both are granted as CANONICAL subpaths, so this test is
  // what proves the canonicalization assumption holds on a real kernel.
  const workspace = mkdtempSync(join(homedir(), ".pi-dsh-darwin-tmp-"));
  const viaTmp = `/tmp/pi-dsh-darwin-tmp-check-${process.pid}.txt`;
  const viaUserTemp = join(tmpdir(), `pi-dsh-darwin-utmp-check-${process.pid}.txt`);
  try {
    const policy: Policy = { mode: "workspace-write", workspaceRoot: workspace };
    for (const target of [viaTmp, viaUserTemp]) {
      const result = run(policy, `echo hi > '${target}'`);
      assert.equal(result.status, 0, `expected ${target} (canonical ${canonicalPath(target)}) to be writable; stderr: ${result.stderr}`);
      assert.equal(readFileSync(target, "utf-8"), "hi\n");
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(viaTmp, { force: true });
    rmSync(viaUserTemp, { force: true });
  }
});

test("darwin: a nested workspace directory can be created while its parent tree stays protected", { skip }, () => {
  const workspace = mkdtempSync(join(homedir(), ".pi-dsh-darwin-mkdir-"));
  try {
    const nested = join(workspace, "a", "b");
    mkdirSync(workspace, { recursive: true });
    const result = run({ mode: "workspace-write", workspaceRoot: workspace }, `mkdir -p '${nested}' && echo ok > '${nested}/file.txt'`);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(readFileSync(join(nested, "file.txt"), "utf-8"), "ok\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
