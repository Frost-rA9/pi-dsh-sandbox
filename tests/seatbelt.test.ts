/**
 * The macOS Seatbelt rung, exercised on Linux through a **fake `sandbox-exec`**.
 *
 * No Mac is required for any of this: the profile is pure text, and the runner
 * is an executable whose argv this test records. What the fake cannot prove is
 * that Apple's real `sandbox-exec` enforces the profile — the probe is exactly
 * the thing that fails closed if it does not — so the fake covers the parts we
 * control (profile content, quoting, probe forms, dialect classification) while
 * leaving the kernel behavior to a real host.
 *
 * @module pi-dsh-sandbox/tests/seatbelt.test
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { probeBackend } from "../src/backend.ts";
import { DEFAULT_CONFIG } from "../src/modes.ts";
import { canonicalPath } from "../src/roots.ts";
import { seatbeltProfileArgs, seatbeltRunnerArgv, sbplString } from "../src/seatbelt.ts";

const config = { ...DEFAULT_CONFIG, probeTimeoutMs: 5_000 };

/** A fake `sandbox-exec`: records its argv, optionally refuses, else runs the command. */
const FAKE_RUNNER = `#!/bin/sh
log="\${FAKE_SANDBOX_LOG:-/dev/null}"
printf 'argv:%s\\n' "$*" >> "$log"
if [ "$1" != "-p" ]; then echo "fake-sandbox-exec: expected -p" >&2; exit 64; fi
profile="$2"; shift 2
withsep=0
if [ "$1" = "--" ]; then withsep=1; shift; fi
printf 'separator:%s\\n' "$withsep" >> "$log"
printf 'profile:%s\\n' "$profile" >> "$log"
if [ "\${FAKE_SANDBOX_REFUSE_SEPARATOR:-0}" = "1" ] && [ "$withsep" = "1" ]; then
  echo "sandbox-exec: refusing to apply the profile" >&2
  exit 65
fi
if [ "\${FAKE_SANDBOX_REFUSE_ALWAYS:-0}" = "1" ]; then
  echo "sandbox-exec: sandbox_init: Operation not permitted" >&2
  exit 66
fi
exec "$@"
`;

/** Install the fake runner in a scratch dir and return its paths plus a log reader. */
function withFakeRunner<T>(fn: (runner: { path: string; readLog: () => string; reset: () => void }) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pi-dsh-fake-seatbelt-"));
  const path = join(dir, "sandbox-exec");
  const log = join(dir, "argv.log");
  writeFileSync(path, FAKE_RUNNER);
  chmodSync(path, 0o755);
  const previousLog = process.env.FAKE_SANDBOX_LOG;
  const previousRefuse = process.env.FAKE_SANDBOX_REFUSE_SEPARATOR;
  const previousRefuseAlways = process.env.FAKE_SANDBOX_REFUSE_ALWAYS;
  process.env.FAKE_SANDBOX_LOG = log;
  try {
    return fn({
      path,
      readLog: () => (existsSyncSafe(log) ? readFileSync(log, "utf-8") : ""),
      reset: () => {
        rmSync(log, { force: true });
        delete process.env.FAKE_SANDBOX_REFUSE_SEPARATOR;
        delete process.env.FAKE_SANDBOX_REFUSE_ALWAYS;
      },
    });
  } finally {
    if (previousLog === undefined) delete process.env.FAKE_SANDBOX_LOG;
    else process.env.FAKE_SANDBOX_LOG = previousLog;
    if (previousRefuse === undefined) delete process.env.FAKE_SANDBOX_REFUSE_SEPARATOR;
    else process.env.FAKE_SANDBOX_REFUSE_SEPARATOR = previousRefuse;
    if (previousRefuseAlways === undefined) delete process.env.FAKE_SANDBOX_REFUSE_ALWAYS;
    else process.env.FAKE_SANDBOX_REFUSE_ALWAYS = previousRefuseAlways;
    rmSync(dir, { recursive: true, force: true });
  }
}

function existsSyncSafe(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

test("read-only profile denies every write and re-allows only /dev/null", () => {
  const [flag, profile] = seatbeltProfileArgs({ mode: "read-only", workspaceRoot: "/work" });
  assert.equal(flag, "-p");
  assert.equal(
    profile,
    '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))',
  );
});

test("workspace-write profile re-allows the shared writable roots as subpaths", () => {
  const [, profile] = seatbeltProfileArgs({ mode: "workspace-write", workspaceRoot: "/work" });
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /\(allow file-write\* \(literal "\/dev\/null"\)\)/);
  for (const root of [canonicalPath("/work"), canonicalPath("/tmp"), canonicalPath(tmpdir())]) {
    assert.ok(profile.includes(`(subpath ${sbplString(root)})`), `profile should grant ${root}`);
  }
});

test("sbplString escapes backslashes and quotes", () => {
  assert.equal(sbplString('/tmp/a"b\\c'), '"\\/tmp/a\\"b\\\\c"'.replace("\\/", "/"));
});

test("the separator-less form is available for hosts that refuse `--`", () => {
  const profileArgs = seatbeltProfileArgs({ mode: "read-only", workspaceRoot: "/" });
  assert.deepEqual(seatbeltRunnerArgv(config, profileArgs, true), ["sandbox-exec", "-p", profileArgs[1], "--"]);
  assert.deepEqual(seatbeltRunnerArgv(config, profileArgs, false), ["sandbox-exec", "-p", profileArgs[1]]);
});

test("darwin probes the `--` form and wraps with it when accepted", () => {
  withFakeRunner((runner) => {
    const result = probeBackend("darwin", { ...config, seatbeltPath: runner.path });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.confiner.name, "seatbelt");
    assert.equal(result.confiner.program, runner.path);
    runner.reset();
    const wrapped = result.confiner.wrap(
      { mode: "workspace-write", workspaceRoot: "/work" },
      ["/bin/zsh", "-c", "echo hi > /work/a"],
    );
    assert.match(wrapped, /'--' '\/bin\/zsh' '-c' 'echo hi > \/work\/a'$/);
    assert.ok(wrapped.includes("(deny file-write*)"));
  });
});

test("darwin falls back to the separator-less form when `--` is refused", () => {
  withFakeRunner((runner) => {
    process.env.FAKE_SANDBOX_REFUSE_SEPARATOR = "1";
    const result = probeBackend("darwin", { ...config, seatbeltPath: runner.path });
    assert.equal(result.ok, true, "the second probe form must rescue the rung");
    if (!result.ok) return;
    runner.reset();
    const wrapped = result.confiner.wrap({ mode: "read-only", workspaceRoot: "/work" }, ["/bin/bash", "-c", "true"]);
    assert.doesNotMatch(wrapped, /'--'/);
    assert.match(wrapped, /'-p' /);
  });
});

test("darwin fails closed when the runner refuses every form", () => {
  withFakeRunner((runner) => {
    process.env.FAKE_SANDBOX_REFUSE_ALWAYS = "1";
    const result = probeBackend("darwin", { ...config, seatbeltPath: runner.path });
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /could not apply a read-only profile/);
  });
});

test("darwin fails closed when the runner is missing", () => {
  const result = probeBackend("darwin", { ...config, seatbeltPath: "/nonexistent/sandbox-exec" });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /could not apply a read-only profile/);
});

test("seatbelt dialects: EPERM denials and sandbox-exec runner failures", () => {
  withFakeRunner((runner) => {
    const result = probeBackend("darwin", { ...config, seatbeltPath: runner.path });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const { confiner } = result;
    assert.equal(confiner.matchesDenial("zsh:1: operation not permitted: /work/a"), true);
    assert.equal(confiner.matchesDenial("bwrap: Can't create file at /work/.tmp"), false);
    assert.equal(confiner.matchesRunnerFailure("sandbox-exec: sandbox_init: Operation not permitted"), true);
    assert.equal(confiner.matchesRunnerFailure("zsh: operation not permitted"), false);
  });
});
