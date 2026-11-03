/**
 * Pure-vocabulary tests: the mode union and the fail-at-load config contract.
 *
 * @module pi-dsh-sandbox/tests/modes.test
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, isConfined, isSandboxMode, parseConfig } from "../src/modes.ts";

test("mode validation accepts every documented mode and nothing else", () => {
  for (const mode of ["read-only", "workspace-write", "danger-full-access"]) {
    assert.equal(isSandboxMode(mode), true);
  }
  for (const value of ["off", "", 42, undefined, null, {}]) {
    assert.equal(isSandboxMode(value), false);
  }
});

test("only danger-full-access is unconfined", () => {
  assert.equal(isConfined("read-only"), true);
  assert.equal(isConfined("workspace-write"), true);
  assert.equal(isConfined("danger-full-access"), false);
});

test("config defaults to workspace-write (documented deviation from dsh read-only)", () => {
  assert.deepEqual(parseConfig(undefined), { ...DEFAULT_CONFIG });
  assert.equal(parseConfig({}).mode, "workspace-write");
});

test("config rejects unknown keys instead of ignoring them (dsh contract)", () => {
  assert.throws(() => parseConfig({ mode2: "read-only" }), /unknown config key/);
});

test("config rejects bad values", () => {
  assert.throws(() => parseConfig({ mode: "sandbox" }), /"mode" must be one of/);
  assert.throws(() => parseConfig({ bwrapPath: "" }), /"bwrapPath" must be a non-empty string/);
  assert.throws(() => parseConfig({ probeTimeoutMs: 0 }), /"probeTimeoutMs" must be a positive finite number/);
});

test("config accepts a full valid object", () => {
  assert.deepEqual(
    parseConfig({
      mode: "read-only",
      bwrapPath: "/usr/bin/bwrap",
      seatbeltPath: "/usr/bin/sandbox-exec",
      additionalWritableRoots: ["/srv/data"],
      probeTimeoutMs: 250,
    }),
    {
      mode: "read-only",
      bwrapPath: "/usr/bin/bwrap",
      seatbeltPath: "/usr/bin/sandbox-exec",
      additionalWritableRoots: ["/srv/data"],
      probeTimeoutMs: 250,
    },
  );
});

test("extra writable roots default to none and are detached, deduplicated, and frozen", () => {
  assert.deepEqual(parseConfig({}).additionalWritableRoots, []);
  const roots = ["/srv/a", "/srv/a", "/srv/b"];
  const config = parseConfig({ additionalWritableRoots: roots });
  assert.deepEqual(config.additionalWritableRoots, ["/srv/a", "/srv/b"]);
  assert.equal(Object.isFrozen(config.additionalWritableRoots), true);
  roots.push("/srv/c");
  assert.deepEqual(config.additionalWritableRoots, ["/srv/a", "/srv/b"]);
});

test("extra writable roots must be absolute paths without NUL bytes", () => {
  assert.throws(() => parseConfig({ additionalWritableRoots: ["srv/data"] }), /entries must be absolute paths/);
  assert.throws(() => parseConfig({ additionalWritableRoots: ["/srv/\0x"] }), /must not contain NUL bytes/);
  assert.throws(() => parseConfig({ additionalWritableRoots: "/srv/data" }), /must be an array of absolute paths/);
  assert.throws(() => parseConfig({ additionalWritableRoots: [42] }), /entries must be absolute paths/);
});

test("each platform's runner path has its own default", () => {
  assert.equal(parseConfig({}).bwrapPath, "bwrap");
  assert.equal(parseConfig({}).seatbeltPath, "sandbox-exec");
  assert.throws(() => parseConfig({ seatbeltPath: "  " }), /"seatbeltPath" must be a non-empty string/);
});
