/**
 * Live model regression over pi's RPC mode: does a real model understand the
 * denial, retry with `sandbox_permissions`, and get one approved write?
 *
 * RPC forwards `ctx.ui.select` as an `extension_ui_request`, so this script
 * plays the human: it approves exactly once. Cost is one small model turn
 * (`--model` defaults to a free one). Nothing else in this repo can cover the
 * model-facing contract, because the model's decision to retry is the thing
 * under test.
 *
 * Usage:
 *   node scripts/e2e-model.mjs [--model <pattern>] [--provider <id>]
 *
 * @module pi-dsh-sandbox/scripts/e2e-model
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const here = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = resolve(here, "..");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const MODEL = flag("model", process.env.PI_TEST_MODEL ?? "deepseek-flash-free");
const PROVIDER = flag("provider", process.env.PI_TEST_PROVIDER ?? "teamorouter");
const TURN_TIMEOUT_MS = Number(process.env.PI_TEST_TURN_TIMEOUT_MS ?? 240_000);

const agentDir = agentDirForChild();
const workspace = mkdtempSync(join(tmpdir(), "pi-dsh-model-"));
// The write must land outside the CHILD's writable roots (its cwd + /tmp +
// os.tmpdir()), which is why the fixture lives under the candidate root.
const outsideRoot = pickOutsideRoot(process.cwd(), `.pi-dsh-probe-${process.pid}.txt`);
const outside = outsideRoot === undefined ? "" : join(outsideRoot, `pi-dsh-model-check-${process.pid}.txt`);

const rows = [];
const record = (name, ok, detail = "") => rows.push([ok ? "PASS" : "FAIL", name, detail]);
const recordSkip = (name, why) => rows.push(["SKIP", name, why]);



/**
 * A writable agent dir for the child pi.
 *
 * A confined session cannot create `<agentDir>/settings.json.lock`, and pi
 * treats a settings file it cannot lock as invalid — which silently drops the
 * default model and the provider credentials, so a model turn never starts. The
 * child therefore gets its own dir: `settings.json` is COPIED (preferences, no
 * credentials) while `models.json` and `auth.json` are SYMLINKED, so credentials
 * are read from the real location and never duplicated.
 *
 * @returns The temp dir to pass as `PI_CODING_AGENT_DIR`, and a cleanup.
 */
function agentDirForChild() {
  const real = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const dir = mkdtempSync(join(tmpdir(), "pi-dsh-agent-"));
  for (const name of ["models.json", "auth.json"]) {
    if (existsSync(join(real, name))) symlinkSync(join(real, name), join(dir, name));
  }
  if (existsSync(join(real, "settings.json"))) copyFileSync(join(real, "settings.json"), join(dir, "settings.json"));
  return dir;
}

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
  for (const root of [process.env.PI_DSH_OUTSIDE_ROOT, "/var/tmp", join(base, ".pi-dsh-outside")]) {
    if (root === undefined) continue;
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, probeName), "probe");
      rmSync(join(root, probeName), { force: true });
      return root;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

const child = spawn(
  "pi",
  ["--mode", "rpc", "-e", packageRoot, "--no-session", "--provider", PROVIDER, "--model", MODEL],
  { cwd: workspace, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } },
);

let stderr = "";
child.stderr.on("data", (data) => {
  stderr += data;
});

const observed = {
  approvals: [],
  selects: [],
  notifications: [],
  statuses: [],
  toolEnds: [],
  denials: [],
  assistantText: [],
};
const pending = new Map();
let settledWaiters = [];

readline.createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  switch (message.type) {
    case "response":
      pending.get(message.id)?.(message);
      pending.delete(message.id);
      return;
    case "extension_ui_request": {
      const request = message;
      if (request.method === "select") {
        // Play the human: approve escalations, and answer the `/sandbox` mode
        // picker by keeping the current mode (the label marked "current").
        observed.selects.push({ title: request.title, options: request.options ?? [] });
        const options = request.options ?? [];
        if (/permissions/.test(request.title ?? "")) {
          observed.approvals.push(request.title);
          child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: request.id, value: "Allow once" })}\n`);
        } else if (options.some((option) => option.includes("workspace-write"))) {
          const current = options.find((option) => option.includes("current")) ?? options[0];
          child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: request.id, value: current })}\n`);
        } else {
          child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: request.id, cancelled: true })}\n`);
        }
        return;
      }
      if (request.method === "confirm") {
        child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: request.id, cancelled: true })}\n`);
        return;
      }
      if (request.method === "notify") {
        observed.notifications.push(request.message ?? "");
        return;
      }
      if (request.method === "setStatus") {
        observed.statuses.push(request.statusText ?? "");
        return;
      }
      return;
    }
    case "tool_execution_end": {
      const text = (message.result?.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n");
      observed.toolEnds.push({ tool: message.toolName, isError: message.isError === true, text });
      if (text.includes("[sandbox: file access denied under")) observed.denials.push({ tool: message.toolName, text });
      return;
    }
    case "agent_end": {
      for (const entry of message.messages ?? []) {
        if (entry.role !== "assistant") continue;
        const text = (entry.content ?? [])
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("\n");
        if (text.trim() !== "") observed.assistantText.push(text);
      }
      return;
    }
    case "agent_settled": {
      const waiters = settledWaiters;
      settledWaiters = [];
      for (const waiter of waiters) waiter();
      return;
    }
    default:
  }
});

/** Send one RPC command and await its response. */
function send(command, timeoutMs = 30_000) {
  return new Promise((resolvePromise, reject) => {
    const id = `req-${Math.random().toString(36).slice(2)}`;
    pending.set(id, resolvePromise);
    child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout: ${JSON.stringify(command)}`));
    }, timeoutMs);
  });
}

/** Wait for the next `agent_settled`. */
function waitSettled(timeoutMs = TURN_TIMEOUT_MS) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`no agent_settled within ${timeoutMs}ms`)), timeoutMs);
    settledWaiters.push(() => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

try {
  const started = await send({ type: "bash", command: "true" });
  record("RPC session is ready", started.success === true);

  const model = send({ type: "get_state" });
  const state = await model;
  record("a model is selected", state.data?.model !== undefined, `${state.data?.model?.provider ?? "?"}/${state.data?.model?.id ?? "?"}`);

  // The turn under test: a write outside the workspace, with no instruction
  // about HOW to recover beyond "follow the refusal's guidance".
  const prompt =
    `Write the text "sandbox-check" into ${outside} (that path is outside my workspace). `
    + "Do not substitute another path. If a tool refuses the write, follow the refusal's own guidance and retry.";
  const turn = send({ type: "prompt", message: prompt }, TURN_TIMEOUT_MS);
  await waitSettled();
  await turn;

  record(
    "the model saw the denial marker",
    observed.denials.length > 0,
    observed.denials.length > 0 ? observed.denials[0].tool : "no tool result carried the marker",
  );
  record(
    "the model retried with an approved escalation",
    observed.approvals.length > 0,
    observed.approvals[0] ?? observed.toolEnds.map((end) => `${end.tool}:${end.isError ? "err" : "ok"}`).join(", "),
  );
  if (outsideRoot !== undefined && outside !== "") {
    const written = existsSync(outside) && readFileSync(outside, "utf-8").includes("sandbox-check");
    record("the approved write reached the outer path", written, written ? outside : "file missing or empty");
  } else {
    recordSkip(
      "the approved write reached the outer path",
      "no usable outside root (this session is confined and the repository is not writable)",
    );
  }

  // The approval was for one call: the session mode must be unchanged. Bare
  // `/sandbox` now raises an interactive picker, so this also covers it.
  observed.notifications.length = 0;
  observed.selects.length = 0;
  await send({ type: "prompt", message: "/sandbox" }, 30_000);
  const picker = observed.selects.find((select) => select.options.some((option) => option.includes("workspace-write")));
  record("/sandbox raises the interactive picker", picker !== undefined, picker?.title ?? "no picker request");
  const offered = ["read-only", "workspace-write", "danger-full-access"].every((mode) =>
    (picker?.options ?? []).some((option) => option.includes(mode)),
  );
  record("the picker offers every mode and marks the current one", offered && /current/.test(picker?.options.join(" ") ?? ""), (picker?.options ?? []).join(" | "));

  const entries = await send({ type: "get_entries" });
  const modeEntries = (entries.data?.entries ?? [])
    .filter((entry) => entry.type === "custom" && entry.customType === "dsh-sandbox-mode")
    .map((entry) => entry.data?.mode);
  record(
    "the one-shot grant never became a session mode",
    !modeEntries.includes("danger-full-access"),
    `dsh-sandbox-mode entries: [${modeEntries.join(", ")}]`,
  );
  record(
    "picking the current mode records it and keeps it",
    modeEntries.at(-1) === "workspace-write",
    `dsh-sandbox-mode entries: [${modeEntries.join(", ")}]`,
  );
} catch (error) {
  record("unexpected failure", false, String(error));
} finally {
  child.stdin.end();
  child.kill("SIGKILL");
  rmSync(outside, { force: true });
  rmSync(workspace, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
  if (outsideRoot !== undefined) {
    try { rmdirSync(outsideRoot); } catch { /* shared root or not empty */ }
  }

  for (const [status, name, detail] of rows) {
    console.log(`${status}  ${name}${detail === "" ? "" : `  (${detail})`}`);
  }
  if (rows.some(([status]) => status === "FAIL")) {
    console.log("--- tool calls ---");
    for (const end of observed.toolEnds) {
      console.log(`  ${end.tool} ${end.isError ? "ERROR" : "ok"}: ${end.text.split("\n").slice(0, 3).join(" / ")}`);
    }
    const last = observed.assistantText.at(-1);
    if (last !== undefined) console.log(`--- last assistant text ---\n${last}`);
    if (stderr.trim() !== "") console.log(`--- stderr ---\n${stderr.split("\n").slice(0, 10).join("\n")}`);
  }
  process.exitCode = rows.some(([status]) => status === "FAIL") ? 1 : 0;
}
