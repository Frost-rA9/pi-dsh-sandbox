/**
 * Tool-level integration check for the filesystem family — no model call.
 *
 * Builds SDK sessions with this extension and invokes the registered
 * `write`/`edit` definitions directly with a fake extension context. This is the
 * only way to exercise the parts of the design that live inside a tool
 * execution: the fence on pi's own write path, the shared denial text, and the
 * whole escalation choreography (approve / reject / no channel / malformed), in
 * both `workspace-write` and `read-only`.
 *
 * Usage: node scripts/check-fs-tools.mjs
 *
 * @module pi-dsh-sandbox/scripts/check-fs-tools
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = resolve(here, "..");

// Most portable first: the explicit override, this checkout's own node_modules
// (what `npm install` produces, locally and in CI), then the volta layout of the
// development machine.
const candidates = [
  process.env.PI_DIST,
  resolve(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
  join(
    homedir(),
    ".volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
  ),
].filter((candidate) => typeof candidate === "string");

const piDist = candidates.find((candidate) => existsSync(candidate));
if (piDist === undefined) {
  console.error(`Could not locate pi's dist entry. Tried:\n${candidates.join("\n")}\nSet PI_DIST to the correct path.`);
  process.exit(1);
}

const {
  createAgentSessionServices,
  createAgentSessionFromServices,
  getAgentDir,
  SessionManager,
} = await import(piDist);

const rows = [];
const record = (name, ok, detail = "") => rows.push([ok ? "PASS" : "FAIL", name, detail]);
/** A check whose fixture this host cannot provide — not a pass, not a failure. */
const recordSkip = (name, why) => rows.push(["SKIP", name, why]);


/**
 * Where the "outside the workspace" fixture lives.
 *
 * The normal choice is /var/tmp: user-writable and outside every writable root
 * (workspace + /tmp + os.tmpdir()). When this process is ITSELF confined — a
 * developer dogfooding the globally installed extension, where /var/tmp is
 * read-only — that candidate is unusable, but a directory inside this
 * repository is: it is outside the TEST's roots (which live under /tmp) while
 * remaining writable by the ambient session. Candidates are probed in order.
 *
 * @param probeName A uniquely named child used for the writability probe.
 * @returns The first usable root, or undefined when none is.
 */
function pickOutsideRoot(base, probeName) {
  for (const root of [process.env.PI_DSH_OUTSIDE_ROOT, "/var/tmp/pi-dsh-tools-outside", join(base, ".pi-dsh-outside")]) {
    if (root === undefined) continue;
    try {
      mkdirSync(root, { recursive: true });
      const probe = join(root, probeName);
      writeFileSync(probe, "probe");
      rmSync(probe, { force: true });
      return root;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/** A no-op extension UI: the extension only notifies/statuses during startup. */
const stubUi = {
  notify: () => {},
  setStatus: () => {},
  setWidget: () => {},
  select: async () => undefined,
  confirm: async () => false,
  theme: { fg: (_color, text) => text },
};

/** Build a bound session whose extension was loaded with the given CLI flag values. */
async function buildSession(cwd, extensionFlagValues) {
  const services = await createAgentSessionServices({
    cwd,
    agentDir: getAgentDir(),
    extensionFlagValues,
    resourceLoaderOptions: { additionalExtensionPaths: [join(packageRoot, "index.ts")] },
  });
  const errors = services.resourceLoader?.getExtensions?.().errors ?? [];
  if (errors.length > 0) {
    throw new Error(`extension load errors: ${JSON.stringify(errors)}`);
  }
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(),
  });
  await session.bindExtensions({ uiContext: stubUi, mode: "print" });
  return { session, errors };
}

/** Invoke one tool definition and normalize throw/return into a result. */
async function call(tool, params, ctx, toolCallId = `call-${Math.random().toString(36).slice(2)}`) {
  try {
    const result = await tool.execute(toolCallId, params, undefined, undefined, ctx);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** A fake tool-execution context: cwd plus the approval channel. */
function fakeContext(cwd, { hasUI, choice }) {
  return { cwd, hasUI, ui: { ...stubUi, select: async () => choice } };
}

const workspace = mkdtempSync(join(tmpdir(), "pi-dsh-tools-"));
// Anything under /tmp is legitimately writable in workspace-write, so the
// "outside" target must live elsewhere: /var/tmp is user-writable and not a
// writable root, with a home-directory fallback for hosts without it.
const outsideRoot = pickOutsideRoot(process.cwd(), `probe-${process.pid}.txt`);
const outside = outsideRoot === undefined ? "" : join(outsideRoot, "outside.txt");
const existingOutside = existsSync("/etc/hostname") ? "/etc/hostname" : "/etc/hosts";

try {
  // ---------------------------------------------------------------- phase A —
  // Default configuration (workspace-write).
  const { session } = await buildSession(workspace, undefined);
  try {
    const write = session.getToolDefinition("write");
    const edit = session.getToolDefinition("edit");
    record("write/edit are registered", write !== undefined && edit !== undefined);

    const inside = join(workspace, "inside.txt");
    const allowed = await call(write, { path: inside, content: "inside" }, fakeContext(workspace, { hasUI: false }));
    record(
      "workspace-write: write inside the workspace succeeds",
      allowed.ok && readFileSync(inside, "utf-8") === "inside",
      allowed.ok ? "" : allowed.message,
    );

    const denied = await call(write, { path: outside, content: "x" }, fakeContext(workspace, { hasUI: false }));
    record(
      "workspace-write: write outside is denied with the dsh marker",
      !denied.ok
        && /\[sandbox: file access denied under workspace-write mode\]/.test(denied.message)
        && /escalation available/.test(denied.message),
      denied.ok ? "unexpectedly allowed" : denied.message.split("\n")[0],
    );

    // An EXISTING outside file, so the fence (not a missing-file error) is what denies it.
    const editDenied = await call(
      edit,
      { path: existingOutside, edits: [{ oldText: "localhost", newText: "sandboxed" }] },
      fakeContext(workspace, { hasUI: false }),
    );
    record(
      "workspace-write: edit outside is denied with the dsh marker",
      !editDenied.ok && /\[sandbox: file access denied under workspace-write mode\]/.test(editDenied.message),
      editDenied.ok ? "unexpectedly allowed" : editDenied.message.split("\n")[0],
    );

    const approved = await call(
      write,
      { path: outside, content: "escalated", sandbox_permissions: "danger-full-access", justification: "integration check" },
      fakeContext(workspace, { hasUI: true, choice: "Allow once" }),
    );
    if (outsideRoot !== undefined) {
      record(
        "escalation: approved call writes outside once",
        approved.ok && existsSync(outside) && readFileSync(outside, "utf-8") === "escalated",
        approved.ok ? "" : approved.message,
      );
    } else {
      recordSkip(
        "escalation: approved call writes outside once",
        "no usable outside root (this session is confined and the repository is not writable)",
      );
    }

    const rejected = await call(
      write,
      { path: join(workspace, "rejected.txt"), content: "nope", sandbox_permissions: "danger-full-access", justification: "integration check" },
      fakeContext(workspace, { hasUI: true, choice: "Cancel" }),
    );
    record(
      "escalation: rejection keeps the denial",
      !rejected.ok && /the user rejected escalating this operation/.test(rejected.message) && !existsSync(join(workspace, "rejected.txt")),
      rejected.ok ? "unexpectedly allowed" : rejected.message.split("\n")[0],
    );

    const noChannel = await call(
      write,
      { path: join(workspace, "nochannel.txt"), content: "nope", sandbox_permissions: "danger-full-access", justification: "integration check" },
      fakeContext(workspace, { hasUI: false }),
    );
    record(
      "escalation: no interactive channel fails closed",
      !noChannel.ok
        && /requires approval, but no approval channel is available/.test(noChannel.message)
        && !existsSync(join(workspace, "nochannel.txt")),
      noChannel.ok ? "unexpectedly allowed" : noChannel.message.split("\n")[0],
    );

    const malformed = await call(
      write,
      { path: join(workspace, "malformed.txt"), content: "x", sandbox_permissions: "danger-full-access" },
      fakeContext(workspace, { hasUI: true, choice: "Allow once" }),
    );
    record(
      "escalation: sandbox_permissions without justification is invalid",
      !malformed.ok && /sandbox_permissions requires a justification/.test(malformed.message),
      malformed.ok ? "unexpectedly allowed" : malformed.message.split("\n")[0],
    );

    // pi's interactive UI holds one extension-dialog slot, so the extension
    // queues concurrent approvals instead of letting the second dialog replace
    // the first. Both calls must settle, one dialog at a time.
    let openDialogs = 0;
    let peakDialogs = 0;
    const parallelContext = {
      cwd: workspace,
      hasUI: true,
      ui: {
        ...stubUi,
        select: async () => {
          openDialogs += 1;
          peakDialogs = Math.max(peakDialogs, openDialogs);
          await new Promise((resolve) => setTimeout(resolve, 5));
          openDialogs -= 1;
          return "Allow once";
        },
      },
    };
    const [parallelFirst, parallelSecond] = await Promise.all([
      call(
        write,
        { path: join(workspace, "parallel-a.txt"), content: "a", sandbox_permissions: "danger-full-access", justification: "integration check" },
        parallelContext,
      ),
      call(
        write,
        { path: join(workspace, "parallel-b.txt"), content: "b", sandbox_permissions: "danger-full-access", justification: "integration check" },
        parallelContext,
      ),
    ]);
    record(
      "escalation: parallel requests open one dialog at a time and both settle",
      peakDialogs === 1 && parallelFirst.ok && parallelSecond.ok
        && readFileSync(join(workspace, "parallel-a.txt"), "utf-8") === "a"
        && readFileSync(join(workspace, "parallel-b.txt"), "utf-8") === "b",
      `peak dialogs=${peakDialogs} first=${parallelFirst.ok} second=${parallelSecond.ok}`,
    );
  } finally {
    session.dispose();
  }

  // ---------------------------------------------------------------- phase B —
  // `--sandbox-mode read-only`, the strictest confined mode.
  const readOnly = mkdtempSync(join(tmpdir(), "pi-dsh-tools-ro-"));
  const { session: roSession } = await buildSession(readOnly, new Map([["sandbox-mode", "read-only"]]));
  try {
    const write = roSession.getToolDefinition("write");
    const edit = roSession.getToolDefinition("edit");
    const insideRo = join(readOnly, "inside.txt");

    const deniedInside = await call(write, { path: insideRo, content: "x" }, fakeContext(readOnly, { hasUI: false }));
    record(
      "read-only: write INSIDE the workspace is denied",
      !deniedInside.ok && /\[sandbox: file access denied under read-only mode\]/.test(deniedInside.message),
      deniedInside.ok ? "unexpectedly allowed" : deniedInside.message.split("\n")[0],
    );

    const editDeniedRo = await call(
      edit,
      { path: existingOutside, edits: [{ oldText: "localhost", newText: "sandboxed" }] },
      fakeContext(readOnly, { hasUI: false }),
    );
    record(
      "read-only: edit is denied with the read-only marker (access-check path)",
      !editDeniedRo.ok && /\[sandbox: file access denied under read-only mode\]/.test(editDeniedRo.message),
      editDeniedRo.ok ? "unexpectedly allowed" : editDeniedRo.message.split("\n")[0],
    );

    // The realistic retry: read-only → workspace-write, strictly wider, approved once.
    const approvedRef = await call(
      write,
      { path: insideRo, content: "ref", sandbox_permissions: "workspace-write", justification: "reference implementation" },
      fakeContext(readOnly, { hasUI: true, choice: "Allow once" }),
    );
    record(
      "read-only: approved retry at workspace-write writes inside once",
      approvedRef.ok && existsSync(insideRo) && readFileSync(insideRo, "utf-8") === "ref",
      approvedRef.ok ? "" : approvedRef.message,
    );

    // Repeating the standing mode without escalation must stay denied.
    const stillDenied = await call(write, { path: join(readOnly, "again.txt"), content: "x" }, fakeContext(readOnly, { hasUI: false }));
    record(
      "read-only: the grant did not outlive its call",
      !stillDenied.ok && !existsSync(join(readOnly, "again.txt")),
      stillDenied.ok ? "unexpectedly allowed" : "",
    );
  } finally {
    roSession.dispose();
    rmSync(readOnly, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- phase C —
  // The program-level grant: one approval covers a whole codemode run.
  const programWorkspace = mkdtempSync(join(tmpdir(), "pi-dsh-tools-program-"));
  const { session: programSession } = await buildSession(programWorkspace, undefined);
  try {
    const write = programSession.getToolDefinition("write");
    const codemode = programSession.getToolDefinition("codemode");
    const properties = codemode?.parameters?.properties ?? {};
    record(
      "codemode: the replacement carries the program escalation fields",
      codemode !== undefined && "sandbox_permissions" in properties && "justification" in properties,
      codemode === undefined ? "codemode is not registered" : Object.keys(properties).join(","),
    );

    // codemode rewrites its own description from the loadout, so the guidance
    // must survive that projection to reach the model.
    const loadout = {
      declared: [],
      callable: [],
      registered: [],
      getExposure: () => "direct",
      getNamespace: () => undefined,
      getPromptGuidelines: () => [],
    };
    const projected = codemode?.prepareLoadout?.(loadout)?.descriptions?.codemode ?? "";
    record(
      "codemode: the projected description carries the program guidance",
      /Nested tools retain their own policies and approvals/.test(projected),
      projected === "" ? "no projected description" : "",
    );

    if (outsideRoot === undefined || codemode === undefined || write === undefined) {
      recordSkip("codemode: one approval covers every nested call of the run", "no usable outside root on this host");
      recordSkip("codemode: a denied run reports the program guidance", "no usable outside root on this host");
      recordSkip("codemode: the grant does not outlive its run", "no usable outside root on this host");
    } else {
      const textOf = (result) => (result?.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
      let dialogs = 0;
      let nested = 0;
      let runId = "";
      const programContext = {
        cwd: programWorkspace,
        hasUI: true,
        mode: "print",
        ui: {
          ...stubUi,
          select: async () => { dialogs += 1; return "Allow once"; },
          confirm: async () => false,
        },
        sessionManager: SessionManager.inMemory(),
        modelRegistry: {},
        tools: [{ name: "write", description: write.description, parameters: write.parameters }],
        executeTool: async (name, args) => {
          const toolCall = { type: "toolCall", id: `${runId}/${++nested}`, name, arguments: args };
          const outcome = await call(programSession.getToolDefinition(name), args, programContext, toolCall.id);
          return {
            toolCall,
            result: outcome.ok ? outcome.result : { content: [{ type: "text", text: outcome.message }], details: {} },
            isError: !outcome.ok,
          };
        },
      };
      const run = (code, params, toolCallId) => {
        runId = toolCallId;
        return call(codemode, { code, ...params }, programContext, toolCallId);
      };

      const targets = [join(outsideRoot, "program-a.txt"), join(outsideRoot, "program-b.txt")];
      const approved = await run(
        `await tools.write({ path: ${JSON.stringify(targets[0])}, content: "a" });\n`
        + `await tools.write({ path: ${JSON.stringify(targets[1])}, content: "b" });\n`
        + `return "done";`,
        { sandbox_permissions: "danger-full-access", justification: "integration check" },
        "program-run",
      );
      record(
        "codemode: one approval covers every nested call of the run",
        approved.ok && dialogs === 1 && nested === 2
          && readFileSync(targets[0], "utf-8") === "a" && readFileSync(targets[1], "utf-8") === "b",
        `ok=${approved.ok} dialogs=${dialogs} nested=${nested}${approved.ok ? "" : ` ${approved.message.split("\n")[0]}`}`,
      );

      dialogs = 0;
      const deniedTarget = join(outsideRoot, "program-c.txt");
      const denied = await run(
        `try { await tools.write({ path: ${JSON.stringify(deniedTarget)}, content: "c" }); return "wrote"; }\n`
        + `catch (error) { return String(error); }`,
        {},
        "program-denied",
      );
      record(
        "codemode: a denied run reports the program guidance",
        denied.ok && dialogs === 0 && !existsSync(deniedTarget)
          && /Nested tools retain their own policies and approvals/.test(textOf(denied.result)),
        denied.ok
          ? `dialogs=${dialogs} guidance=${/Nested tools retain their own policies and approvals/.test(textOf(denied.result))}`
          : denied.message.split("\n")[0],
      );

      const lateTarget = join(outsideRoot, "program-late.txt");
      const late = await call(write, { path: lateTarget, content: "x" }, programContext, "program-run/99");
      record(
        "codemode: the grant does not outlive its run",
        !late.ok && !existsSync(lateTarget),
        late.ok ? "unexpectedly allowed" : late.message.split("\n")[0],
      );
    }
  } finally {
    programSession.dispose();
    rmSync(programWorkspace, { recursive: true, force: true });
  }

} catch (error) {
  record("unexpected failure", false, String(error));
} finally {
  rmSync(workspace, { recursive: true, force: true });
  if (outsideRoot !== undefined) {
    rmSync(join(outsideRoot, "outside.txt"), { force: true });
    try { rmdirSync(outsideRoot); } catch { /* shared root or not empty */ }
  }
  for (const [status, name, detail] of rows) {
    console.log(`${status}  ${name}${detail === "" ? "" : `  (${detail})`}`);
  }
  process.exitCode = rows.some(([status]) => status === "FAIL") ? 1 : 0;
}
