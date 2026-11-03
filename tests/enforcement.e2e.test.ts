/**
 * Enforcement tests: run the WRAPPED command through a real shell and assert
 * the probed backend's observable behavior (denial dialect, allowed workspace
 * writes). The suite is backend-agnostic — Linux runs it against bubblewrap,
 * macOS against Seatbelt — and skips on a host with no usable backend.
 *
 * @module pi-dsh-sandbox/tests/enforcement.e2e.test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { probeBackend, type Confiner } from "../src/backend.ts";
import { DEFAULT_CONFIG, type Policy } from "../src/modes.ts";
import { shellQuote } from "../src/bwrap.ts";
import { SandboxInvalidRootError } from "../src/roots.ts";

const probe = probeBackend(process.platform, DEFAULT_CONFIG);
const skip = probe.ok ? false : `no usable backend: ${probe.reason}`;
const confiner = probe.ok ? probe.confiner : undefined;

/** Wrap one command through the probed rung, mirroring bash.ts's shell choice. */
function wrap(confiner: Confiner | undefined, policy: Policy, command: string): string {
  // The suite is skipped unless a backend was probed successfully.
  return (confiner as Confiner).wrap(policy, ["bash", "-c", command]);
}

/** Run one already-wrapped command through the same shell pi uses. */
function run(command: string): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

function withWorkspace<T>(fn: (workspace: string) => T): T {
  const workspace = mkdtempSync(join(tmpdir(), "pi-dsh-sandbox-e2e-"));
  try {
    return fn(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

test("read-only refuses a workspace write with the backend denial dialect", { skip }, () => {
  withWorkspace((workspace) => {
    const target = join(workspace, "written.txt");
    const command = wrap(confiner, { mode: "read-only", workspaceRoot: workspace }, `echo hi > ${shellQuote(target)}`);
    const result = run(command);
    assert.notEqual(result.status, 0);
    assert.equal(confiner?.matchesDenial(result.stderr), true, `stderr: ${result.stderr}`);
    assert.equal(existsSync(target), false);
  });
});

test("workspace-write allows a workspace write", { skip }, () => {
  withWorkspace((workspace) => {
    const target = join(workspace, "written.txt");
    const command = wrap(confiner, { mode: "workspace-write", workspaceRoot: workspace }, `echo hi > ${shellQuote(target)}`);
    const result = run(command);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(readFileSync(target, "utf-8"), "hi\n");
  });
});

test("workspace-write still refuses a write outside the workspace", { skip }, () => {
  const target = `/etc/pi-dsh-sandbox-should-not-exist-${process.pid}`;
  const command = wrap(confiner, { mode: "workspace-write", workspaceRoot: tmpdir() }, `echo hi > ${shellQuote(target)}`);
  const result = run(command);
  assert.notEqual(result.status, 0);
  assert.equal(confiner?.matchesDenial(result.stderr), true, `stderr: ${result.stderr}`);
  assert.equal(existsSync(target), false);
});

test("workspace-write grants an explicit extra root", { skip }, () => {
  withWorkspace((workspace) => {
    const extra = mkdtempSync(join(tmpdir(), "pi-dsh-sandbox-extra-"));
    try {
      const target = join(extra, "written.txt");
      const command = wrap(
        confiner,
        { mode: "workspace-write", workspaceRoot: workspace, additionalWritableRoots: [extra] },
        `echo hi > ${shellQuote(target)}`,
      );
      const result = run(command);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(readFileSync(target, "utf-8"), "hi\n");
    } finally {
      rmSync(extra, { recursive: true, force: true });
    }
  });
});

test("workspace-write still refuses a write outside the workspace and the extra roots", { skip }, () => {
  withWorkspace((workspace) => {
    const extra = mkdtempSync(join(tmpdir(), "pi-dsh-sandbox-extra-"));
    try {
      const target = `/etc/pi-dsh-sandbox-extra-probe-${process.pid}`;
      const command = wrap(
        confiner,
        { mode: "workspace-write", workspaceRoot: workspace, additionalWritableRoots: [extra] },
        `echo hi > ${shellQuote(target)}`,
      );
      const result = run(command);
      assert.notEqual(result.status, 0);
      assert.equal(confiner?.matchesDenial(result.stderr), true, `stderr: ${result.stderr}`);
      assert.equal(existsSync(target), false);
    } finally {
      rmSync(extra, { recursive: true, force: true });
    }
  });
});

test("a symlinked explicit extra root is rejected before the command runs", { skip }, () => {
  withWorkspace((workspace) => {
    const physical = join(workspace, "physical");
    mkdirSync(physical);
    const alias = join(workspace, "alias");
    symlinkSync(physical, alias);
    assert.throws(
      () => wrap(
        confiner,
        { mode: "workspace-write", workspaceRoot: workspace, additionalWritableRoots: [alias] },
        "true",
      ),
      SandboxInvalidRootError,
    );
  });
});

test("danger-full-access is handled by the caller, not the rung", { skip }, () => {
  withWorkspace((workspace) => {
    const target = join(workspace, "written.txt");
    const raw = `echo hi > ${shellQuote(target)}`;
    // `wrap` is only reached for confined modes; full access spawns the raw
    // command (bash.ts returns it untouched before any rung is consulted).
    assert.equal(run(raw).status, 0);
  });
});
