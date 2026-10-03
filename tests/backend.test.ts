/**
 * Backend-selection tests: which rung this platform probes, how a probed
 * confiner wraps, and that an unusable or absent backend fails closed.
 *
 * The darwin rung's own profile/dialect tests live in `seatbelt.test.ts`; these
 * tests cover the selection layer plus the real Linux host's rung.
 *
 * @module pi-dsh-sandbox/tests/backend.test
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { probeBackend, SandboxUnavailableError, SANDBOX_UNAVAILABLE } from "../src/backend.ts";
import { DEFAULT_CONFIG } from "../src/modes.ts";

const config = { ...DEFAULT_CONFIG, probeTimeoutMs: 5_000 };

test("linux probes bubblewrap and reports its runner", () => {
  const result = probeBackend("linux", config);
  // The development host ships bwrap; a failure here is an environment fact,
  // not a code regression, so the shape is asserted either way.
  if (result.ok) {
    assert.equal(result.confiner.name, "bwrap");
    assert.equal(result.confiner.program, "bwrap");
  } else {
    assert.match(result.reason, /bwrap/);
  }
});

test("a missing runner fails the probe with a reason instead of degrading", () => {
  const result = probeBackend("linux", { ...config, bwrapPath: "/nonexistent/bwrap" });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /nonexistent|ENOENT/i);
});

test("platforms without a rung fail closed", () => {
  // win32 never reaches a confined mode (the state falls back to
  // danger-full-access), but a direct probe must still refuse.
  for (const platform of ["win32", "freebsd"] as NodeJS.Platform[]) {
    const result = probeBackend(platform, config);
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /no sandbox backend is implemented/);
  }
});

test("the probed linux confiner wraps with the separator and quotes every element", () => {
  const result = probeBackend("linux", config);
  if (!result.ok) return;
  const wrapped = result.confiner.wrap(
    { mode: "workspace-write", workspaceRoot: "/work" },
    ["/bin/bash", "-c", "echo 'hi' > /work/a b"],
  );
  assert.equal(
    wrapped,
    "'bwrap' '--ro-bind' '/' '/' '--dev' '/dev' '--unshare-pid' '--proc' '/proc' '--die-with-parent' "
      + "'--tmpfs' '/tmp' '--bind' '/work' '/work' '--' '/bin/bash' '-c' 'echo '\\''hi'\\'' > /work/a b'",
  );
});

test("rung dialects do not overlap", () => {
  const result = probeBackend("linux", config);
  if (!result.ok) return;
  const { confiner } = result;
  assert.equal(confiner.matchesDenial("bash: /work/a: Read-only file system"), true);
  assert.equal(confiner.matchesRunnerFailure("bash: /work/a: Read-only file system"), false);
  assert.equal(confiner.matchesRunnerFailure("bwrap: Can't create file at /work/.tmp: Permission denied"), true);
  assert.equal(confiner.matchesDenial("bash: command not found"), false);
});

test("the fail-closed error carries the dsh code and refuses to run unconfined", () => {
  const error = new SandboxUnavailableError("workspace-write", "spawn bwrap ENOENT");
  assert.equal(error.code, SANDBOX_UNAVAILABLE);
  assert.match(error.message, /refusing to run the command unconfined/);
  assert.match(error.message, /bubblewrap with unprivileged user namespaces \(Linux\) or ensure sandbox-exec/);
  assert.match(error.message, /Backend failure: spawn bwrap ENOENT/);
});
