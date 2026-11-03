/**
 * Behavior parity with dsh for the writable-root derivation: the same policy
 * must produce the same roots, because the fence and the bubblewrap profile
 * both read this one derivation.
 *
 * @module pi-dsh-sandbox/tests/roots-parity
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalPath, workspaceWritableRoots, writableRoots } from "../src/roots.ts";
import type { Policy, SandboxMode } from "../src/modes.ts";
import { loadDsh, paritySkip } from "./parity/dsh.ts";

interface DshRoots {
  canonicalPath(path: string): string;
  workspaceWritableRoots(policy: { mode: string; workspaceRoot: string; additionalWritableRoots?: readonly string[] }): string[];
  writableRoots(policy: { mode: string; workspaceRoot: string; additionalWritableRoots?: readonly string[] }): string[];
}

const MODES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

test("canonicalPath matches dsh", { skip: paritySkip }, async (t) => {
  const dsh = await loadDsh<DshRoots>("packages/sandbox/sandbox/src/roots.ts");
  const workspace = mkdtempSync(join(tmpdir(), "pi-dsh-roots-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const file = join(workspace, "file.txt");
  writeFileSync(file, "x");
  const link = join(workspace, "link");
  symlinkSync(file, link);

  const inputs = [workspace, file, link, join(workspace, "missing.txt"), tmpdir(), "/"];
  for (const input of inputs) {
    assert.equal(canonicalPath(input), dsh.canonicalPath(input), input);
  }
});

test("writableRoots matches dsh for every mode", { skip: paritySkip }, async (t) => {
  const dsh = await loadDsh<DshRoots>("packages/sandbox/sandbox/src/roots.ts");
  const workspace = mkdtempSync(join(tmpdir(), "pi-dsh-roots-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  for (const mode of MODES) {
    const policy = { mode, workspaceRoot: workspace };
    assert.deepEqual(writableRoots(policy as Policy), dsh.writableRoots(policy), mode);
  }
});

test("explicit extra roots match dsh in both derivations", { skip: paritySkip }, async (t) => {
  const dsh = await loadDsh<DshRoots>("packages/sandbox/sandbox/src/roots.ts");
  const workspace = mkdtempSync(join(tmpdir(), "pi-dsh-roots-"));
  const extra = mkdtempSync(join(tmpdir(), "pi-dsh-roots-extra-"));
  t.after(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(extra, { recursive: true, force: true });
  });

  for (const mode of MODES) {
    const policy = { mode, workspaceRoot: workspace, additionalWritableRoots: [extra] };
    assert.deepEqual(workspaceWritableRoots(policy as Policy), dsh.workspaceWritableRoots(policy), `${mode} workspace roots`);
    assert.deepEqual(writableRoots(policy as Policy), dsh.writableRoots(policy), `${mode} writable roots`);
  }
});

test("a rejected explicit root matches dsh: same message, same code", { skip: paritySkip }, async (t) => {
  const dsh = await loadDsh<DshRoots>("packages/sandbox/sandbox/src/roots.ts");
  const workspace = mkdtempSync(join(tmpdir(), "pi-dsh-roots-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const missing = join(workspace, "missing");
  const file = join(workspace, "file.txt");
  writeFileSync(file, "x");
  const alias = join(workspace, "alias");
  symlinkSync(workspace, alias, "dir");

  for (const root of [missing, file, alias]) {
    const policy = { mode: "workspace-write", workspaceRoot: workspace, additionalWritableRoots: [root] };
    const ours = (() => {
      try {
        writableRoots(policy as Policy);
        return undefined;
      } catch (error: unknown) {
        return error as { message: string; code?: string };
      }
    })();
    const theirs = (() => {
      try {
        dsh.writableRoots(policy);
        return undefined;
      } catch (error: unknown) {
        return error as { message: string; code?: string };
      }
    })();
    assert.ok(ours !== undefined && theirs !== undefined, `both must reject ${root}`);
    assert.equal(ours.message, theirs.message);
    assert.equal(ours.code, theirs.code);
  }
});
