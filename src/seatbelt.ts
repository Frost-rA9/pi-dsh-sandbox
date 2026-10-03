/**
 * The macOS Seatbelt rung: SBPL profile construction and its dialects.
 *
 * Ported from dsh `packages/sandbox/sandbox-local/src/profiles.ts`
 * (`seatbeltProfileArgs`) and the darwin row of its `DENIAL_SIGNATURES` /
 * `RUNNER_FAILURE_RULES` tables. macOS has no namespaces and no Landlock, so
 * the confinement mechanism is a completely different kernel facility —
 * TrustedBSD MAC via `/usr/bin/sandbox-exec` — while the *policy* it expresses
 * is the same `Policy` every other rung consumes, including the shared
 * `writableRoots` allow-list, so the fence and the runner cannot drift.
 *
 * `sandbox-exec` is deprecated by Apple but ships on every macOS; the probe is
 * what fails closed if that ever changes.
 *
 * @module pi-dsh-sandbox/seatbelt
 */

import { spawnSync } from "node:child_process";
import type { Config, Policy } from "./modes.ts";
import { writableRoots } from "./roots.ts";

/** The Seatbelt denial dialect: a denied write surfaces as EPERM, not EROFS. */
export const SEATBELT_DENIAL_SIGNATURES: readonly string[] = ["operation not permitted"];

/** The `sandbox-exec` runner-failure dialect. */
export const SEATBELT_RUNNER_FAILURE_SIGNATURES: readonly string[] = ["sandbox-exec: "];

/** Quote one path as an SBPL string literal. */
export function sbplString(path: string): string {
  return `"${path.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
}

/**
 * Build the `sandbox-exec` profile for one file-effect policy — verbatim from
 * dsh. The default policy allows everything and then denies every file write;
 * `read-only` stops there (only `/dev/null` is re-allowed), `workspace-write`
 * re-allows the shared writable roots as SBPL subpath filters.
 *
 * @param policy The file-effect policy to express as an SBPL profile.
 * @returns Profile arguments before the command argv.
 */
export function seatbeltProfileArgs(policy: Policy): string[] {
  const forms = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (literal ${sbplString("/dev/null")}))`,
  ];
  const roots = writableRoots(policy);
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map((root) => `(subpath ${sbplString(root)})`).join(" ")})`);
  }
  return ["-p", forms.join(" ")];
}

/**
 * The runner invocation for one policy. The `--` separator is dsh's spelling
 * (`sandbox-exec -p <profile> -- <cmd>`): the probe verifies the form this host
 * accepts before any real execution, and the caller falls back to the
 * separator-less form when `sandbox-exec` refuses it.
 *
 * @param config Extension configuration (runner path).
 * @param profileArgs Arguments from {@link seatbeltProfileArgs}.
 * @param withSeparator Whether to pass `--` before the command argv.
 * @returns The argv prefix the command follows.
 */
export function seatbeltRunnerArgv(config: Config, profileArgs: readonly string[], withSeparator: boolean): string[] {
  return withSeparator
    ? [config.seatbeltPath, ...profileArgs, "--"]
    : [config.seatbeltPath, ...profileArgs];
}

/**
 * One functional probe form: apply the real `read-only` profile and run `true`
 * under it. Exit 0 means the kernel accepted and enforced the profile
 * (`sandbox-exec` exits non-zero when `sandbox_init` refuses it); a missing
 * `sandbox-exec` fails the spawn and probes `unusable`.
 *
 * @param config Extension configuration.
 * @param withSeparator Whether this form passes `--` before the command.
 * @returns Whether this form works on this host.
 */
export function probeSeatbeltForm(config: Config, withSeparator: boolean): boolean {
  try {
    const argv = seatbeltRunnerArgv(config, seatbeltProfileArgs({ mode: "read-only", workspaceRoot: "/" }), withSeparator);
    const probe = spawnSync(argv[0] as string, [...argv.slice(1), "true"], {
      timeout: config.probeTimeoutMs,
      stdio: "ignore",
    });
    return probe.error === undefined && probe.status === 0;
  } catch {
    return false;
  }
}
