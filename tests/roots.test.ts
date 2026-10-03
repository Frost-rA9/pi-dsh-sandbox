/**
 * Port tests for the writable-root derivation and the containment check.
 *
 * @module pi-dsh-sandbox/tests/roots.test
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isPathUnder } from "../src/containment.ts";
import { checkedTarget, freshestTarget, SandboxDeniedError } from "../src/fence.ts";
import { canonicalPath, writableRoots } from "../src/roots.ts";

function withWorkspace<T>(fn: (workspace: string) => T): T {
  const workspace = mkdtempSync(join(realpathSync.native(tmpdir()), "pi-dsh-sandbox-test-"));
  try {
    return fn(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

test("read-only has no writable roots", () => {
  assert.deepEqual(writableRoots({ mode: "read-only", workspaceRoot: "/tmp/x" }), []);
});

test("workspace-write includes the workspace, /tmp, and os.tmpdir() canonically", () => {
  const roots = writableRoots({ mode: "workspace-write", workspaceRoot: "/tmp/x" });
  // Canonical spellings, not literals: darwin resolves /tmp to /private/tmp and
  // os.tmpdir() to a per-user /var/folders path.
  assert.ok(roots.includes(canonicalPath("/tmp")));
  assert.ok(roots.includes(canonicalPath(tmpdir())));
  assert.equal(roots.length, new Set(roots).size, "roots are deduplicated");
});

test("danger-full-access has no allow-list (it never fences)", () => {
  assert.deepEqual(writableRoots({ mode: "danger-full-access", workspaceRoot: "/tmp/x" }), []);
});

test("containment is a path boundary, not a string prefix", async () => {
  assert.equal(await isPathUnder("/tmp/a/b", "/tmp/a"), true);
  assert.equal(await isPathUnder("/tmp/a", "/tmp/a"), true);
  assert.equal(await isPathUnder("/tmp/ab", "/tmp/a"), false);
});

test("containment accepts a not-yet-existing suffix under an existing root", async () => {
  assert.equal(await isPathUnder("/tmp/a/b/c/d", "/tmp/a"), true);
});

test("freshestTarget resolves the deepest existing ancestor", () => {
  withWorkspace((workspace) => {
    mkdirSync(join(workspace, "real"));
    assert.equal(freshestTarget(join(workspace, "real", "missing", "file.txt")), join(workspace, "real", "missing", "file.txt"));
  });
});

test("read-only denies a mutation with the shared marker", async () => {
  await assert.rejects(
    () => checkedTarget("/tmp/whatever", { mode: "read-only", workspaceRoot: "/tmp" }),
    (error: unknown) => {
      assert.ok(error instanceof SandboxDeniedError);
      assert.equal(error.code, "FS_SANDBOX_DENIED");
      assert.match(error.message, /\[sandbox: file access denied under read-only mode\]/);
      assert.match(error.message, /escalation available/);
      return true;
    },
  );
});

test("workspace-write allows the workspace and denies outside it", async () => {
  await withWorkspace(async (workspace) => {
    const policy = { mode: "workspace-write" as const, workspaceRoot: workspace };
    const inside = await checkedTarget(join(workspace, "new", "file.txt"), policy);
    assert.equal(inside, join(workspace, "new", "file.txt"));
    await assert.rejects(() => checkedTarget("/etc/passwd", policy), SandboxDeniedError);
  });
});

test("a symlink inside the workspace pointing outside is denied (fresh-target check)", async (t) => {
  await withWorkspace(async (workspace) => {
    // The escape target must be outside EVERY writable root, and /tmp is one of
    // them, so a /tmp sibling would legitimately be allowed. Candidates are
    // probed because a developer dogfooding the globally installed extension
    // runs this suite INSIDE the sandbox it tests, where /var/tmp is read-only;
    // a directory in this repository is then both writable and outside the
    // test's own roots (which live under /tmp).
    const candidates = [process.env.PI_DSH_OUTSIDE_ROOT, "/var/tmp", join(process.cwd(), ".pi-dsh-outside")]
      .filter((candidate): candidate is string => candidate !== undefined);
    let outside: string | undefined;
    for (const parent of candidates) {
      try {
        mkdirSync(parent, { recursive: true });
        outside = mkdtempSync(join(parent, "pi-dsh-sandbox-outside-"));
        break;
      } catch {
        // Try the next candidate.
      }
    }
    if (outside === undefined) {
      t.skip(`no writable outside root among ${candidates.join(", ")}`);
      return;
    }
    try {
      writeFileSync(join(outside, "secret.txt"), "secret");
      symlinkSync(outside, join(workspace, "escape"));
      const escapes = join(workspace, "escape", "resolved-inside.txt");
      // Lexically inside the workspace; canonically inside `outside`, which is
      // not a writable root. The fresh-target check must therefore deny it.
      assert.equal(escapes.startsWith(workspace), true);
      // The fresh target resolves to the CANONICAL outside path (darwin:
      // /var/tmp is /private/var/tmp), which is exactly the point of the check.
      assert.equal(freshestTarget(escapes), join(realpathSync.native(outside), "resolved-inside.txt"));
      await assert.rejects(
        () => checkedTarget(escapes, { mode: "workspace-write", workspaceRoot: workspace }),
        SandboxDeniedError,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("danger-full-access never fences", async () => {
  assert.equal(await checkedTarget("/etc/passwd", { mode: "danger-full-access", workspaceRoot: "/tmp" }), "/etc/passwd");
});
