/**
 * Platform-fallback and session-state tests. win32 has no confinement backend
 * here, so a confined request resolves to `danger-full-access` — never a
 * half-enforced read-only — which is exercised through an injected platform and
 * therefore remains testable off Windows.
 *
 * @module pi-dsh-sandbox/tests/state.test
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxState, MODE_ENTRY } from "../src/state.ts";

/** A throwaway `pi` surface for selections whose result is not inspected. */
function asApi(): Parameters<SandboxState["setOverride"]>[0] {
  return fakePi().api;
}

/** The minimal `pi` surface `setOverride` uses. */
function fakePi(): { api: Parameters<SandboxState["setOverride"]>[0]; entries: { customType: string; data?: unknown }[] } {
  const entries: { customType: string; data?: unknown }[] = [];
  const api = {
    appendEntry: (customType: string, data?: unknown) => {
      entries.push({ customType, data });
    },
  } as unknown as Parameters<SandboxState["setOverride"]>[0];
  return { api, entries };
}

test("linux keeps the workspace-write default and mounts confinement", () => {
  const state = new SandboxState("linux");
  assert.equal(state.fallbackMode, undefined);
  assert.equal(state.effectiveMode(), "workspace-write");
  assert.equal(state.platformFallback, false);
  assert.equal(state.resolve().mode, "workspace-write");
  assert.equal(state.fallbackReason(), undefined);
});

test("win32 falls back to danger-full-access for the configured default", () => {
  const state = new SandboxState("win32");
  assert.equal(state.effectiveMode(), "danger-full-access");
  assert.equal(state.platformFallback, true);
  assert.equal(state.resolve().mode, "danger-full-access");
  assert.equal(state.statusText(), "[sandbox::danger-full-access]");
  assert.match(state.fallbackReason() ?? "", /no sandbox backend is implemented on win32/);
});

test("win32 replaces ANY confined selection with danger-full-access", () => {
  const state = new SandboxState("win32");
  const { api, entries } = fakePi();
  for (const requested of ["read-only", "workspace-write"] as const) {
    const selection = state.setOverride(api, requested);
    assert.deepEqual(selection, { mode: "danger-full-access", downgraded: true, requested });
    assert.equal(state.effectiveMode(), "danger-full-access");
  }
  assert.deepEqual(entries, [
    { customType: MODE_ENTRY, data: { mode: "danger-full-access" } },
    { customType: MODE_ENTRY, data: { mode: "danger-full-access" } },
  ]);
});

test("win32 caps a restored session override and a confined per-call grant", () => {
  const state = new SandboxState("win32");
  state.restore([{ type: "custom", customType: MODE_ENTRY, data: { mode: "workspace-write" } }]);
  assert.equal(state.effectiveMode(), "danger-full-access");
  assert.equal(state.resolve("read-only").mode, "danger-full-access");
});

test("an explicit danger-full-access is not a downgrade on either platform", () => {
  const { api } = fakePi();
  for (const platform of ["win32", "linux"] as const) {
    const state = new SandboxState(platform);
    const selection = state.setOverride(api, "danger-full-access");
    assert.equal(selection.downgraded, false);
    assert.equal(state.effectiveMode(), "danger-full-access");
    assert.equal(state.platformFallback, false);
  }
});

test("win32 never attempts confined execution: the fallback produces full access", () => {
  // The invariant that keeps the missing backend honest: nothing on win32 can
  // hand `assertBackend` a confined mode, so it must not reject it either.
  const state = new SandboxState("win32");
  for (const mode of ["read-only", "workspace-write"] as const) {
    assert.equal(state.resolve(mode).mode, "danger-full-access");
  }
  assert.doesNotThrow(() => state.assertBackend(state.resolve().mode));
});

test("a linux backend failure still fails closed with the probe reason", () => {
  const state = new SandboxState("linux");
  state.backendFailure = "spawn bwrap ENOENT";
  assert.throws(() => state.assertBackend("workspace-write"), /Backend failure: spawn bwrap ENOENT/);
});

test("the footer indicator is [sandbox::<tier>] for every effective state", () => {
  const ready = { name: "bwrap", program: "bwrap" } as never;
  const states: { state: SandboxState; expected: string; why: string }[] = [];

  for (const mode of ["read-only", "workspace-write", "danger-full-access"] as const) {
    const state = new SandboxState("linux");
    state.confiner = ready;
    state.setOverride(asApi(), mode);
    states.push({ state, expected: `[sandbox::${mode}]`, why: `${mode} with a probed backend` });
  }

  // A confined tier no backend can enforce must not claim the tier.
  const noBackendConfined = new SandboxState("linux");
  noBackendConfined.backendFailure = "spawn bwrap ENOENT";
  states.push({ state: noBackendConfined, expected: "[sandbox::unavailable]", why: "confined tier, no backend" });

  // Full access needs no backend, so it reports itself either way.
  const noBackendFull = new SandboxState("linux");
  noBackendFull.backendFailure = "spawn bwrap ENOENT";
  noBackendFull.setOverride(asApi(), "danger-full-access");
  states.push({ state: noBackendFull, expected: "[sandbox::danger-full-access]", why: "full access, no backend" });
  states.push({ state: new SandboxState("win32"), expected: "[sandbox::danger-full-access]", why: "win32 fallback" });

  for (const { state, expected, why } of states) {
    assert.equal(state.statusText(), expected, why);
  }
});

test("each state gets its own footer colour (a visible gradient)", () => {
  const ready = { name: "bwrap", program: "bwrap" } as never;
  const colorOf = (mode: "read-only" | "workspace-write" | "danger-full-access"): string => {
    const state = new SandboxState("linux");
    state.confiner = ready;
    state.setOverride(asApi(), mode);
    return state.statusColor();
  };
  assert.equal(colorOf("read-only"), "success");
  assert.equal(colorOf("workspace-write"), "accent");
  assert.equal(colorOf("danger-full-access"), "warning");

  const unavailable = new SandboxState("linux");
  unavailable.backendFailure = "spawn bwrap ENOENT";
  assert.equal(unavailable.statusColor(), "error");

  // Every reachable state must be visually distinct from the others.
  const colors = [colorOf("read-only"), colorOf("workspace-write"), colorOf("danger-full-access"), unavailable.statusColor()];
  assert.equal(new Set(colors).size, colors.length, `colours must be distinct, got ${colors.join(", ")}`);
});

test("a broken config falls back to read-only and records the error", () => {
  const state = new SandboxState("linux");
  state.loadConfig({ mode: "nope" });
  assert.match(state.configError ?? "", /"mode" must be one of/);
  assert.equal(state.effectiveMode(), "read-only");
});
