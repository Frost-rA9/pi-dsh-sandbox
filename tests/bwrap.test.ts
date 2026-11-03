/**
 * Port tests for the Linux rung's profile construction and shell quoting.
 *
 * @module pi-dsh-sandbox/tests/bwrap.test
 */

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bwrapProfileArgs, shellQuote } from "../src/bwrap.ts";

/** Two real extra roots: an explicit grant must be an existing physical directory. */
function withExtraRoots<T>(fn: (first: string, second: string) => T): T {
  const base = realpathSync.native(tmpdir());
  const first = mkdtempSync(join(base, "pi-dsh-bwrap-a-"));
  const second = mkdtempSync(join(base, "pi-dsh-bwrap-b-"));
  try {
    return fn(first, second);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
}

test("read-only profile keeps the whole filesystem read-only and grants only /dev", () => {
  assert.deepEqual(bwrapProfileArgs({ mode: "read-only", workspaceRoot: "/work" }), [
    "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent",
  ]);
});

test("workspace-write adds an ephemeral /tmp and a read-write workspace bind", () => {
  const args = bwrapProfileArgs({ mode: "workspace-write", workspaceRoot: "/work" });
  assert.deepEqual(args.slice(-5), ["--tmpfs", "/tmp", "--bind", "/work", "/work"]);
});

test("workspace-write binds every explicit extra root, after the workspace", () => {
  withExtraRoots((first, second) => {
    const args = bwrapProfileArgs({
      mode: "workspace-write",
      workspaceRoot: "/work",
      additionalWritableRoots: [first, second],
    });
    assert.deepEqual(args.slice(-11), [
      "--tmpfs", "/tmp",
      "--bind", "/work", "/work",
      "--bind", first, first,
      "--bind", second, second,
    ]);
  });
});

test("read-only ignores explicit extra roots", () => {
  withExtraRoots((first) => {
    assert.deepEqual(
      bwrapProfileArgs({ mode: "read-only", workspaceRoot: "/work", additionalWritableRoots: [first] }),
      ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent"],
    );
  });
});

test("shellQuote escapes embedded single quotes", () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("shellQuote keeps a whole argv element literal", () => {
  assert.equal(shellQuote("echo 'hi' > /work/a b"), "'echo '\\''hi'\\'' > /work/a b'");
});
