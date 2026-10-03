/**
 * Port tests for the Linux rung's profile construction and shell quoting.
 *
 * @module pi-dsh-sandbox/tests/bwrap.test
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { bwrapProfileArgs, shellQuote } from "../src/bwrap.ts";

test("read-only profile keeps the whole filesystem read-only and grants only /dev", () => {
  assert.deepEqual(bwrapProfileArgs({ mode: "read-only", workspaceRoot: "/work" }), [
    "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent",
  ]);
});

test("workspace-write adds an ephemeral /tmp and a read-write workspace bind", () => {
  const args = bwrapProfileArgs({ mode: "workspace-write", workspaceRoot: "/work" });
  assert.deepEqual(args.slice(-5), ["--tmpfs", "/tmp", "--bind", "/work", "/work"]);
});

test("shellQuote escapes embedded single quotes", () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("shellQuote keeps a whole argv element literal", () => {
  assert.equal(shellQuote("echo 'hi' > /work/a b"), "'echo '\\''hi'\\'' > /work/a b'");
});
