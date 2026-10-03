/**
 * End-to-end enforcement check over pi's RPC mode — no model call involved.
 *
 * The RPC `bash` command goes through the `user_bash` event, so it exercises the
 * same confined operations the `bash` tool uses.
 *
 * Usage: node scripts/e2e-rpc.mjs [extensionDir]
 *
 * @module pi-dsh-sandbox/scripts/e2e-rpc
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import readline from "node:readline";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = process.argv[2] ?? resolve(here, "..");

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

const agentDir = agentDirForChild();
const child = spawn("pi", ["--mode", "rpc", "-e", extensionDir, "--no-session"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
});

let stderr = "";
child.stderr.on("data", (data) => {
  stderr += data;
});

const pending = new Map();
const events = [];
const waiters = [];
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === "response" && message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  events.push(message);
  for (const waiter of [...waiters]) {
    if (waiter.predicate(message)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  }
});

/** Await one event matching the predicate among those already seen or arriving later. */
function waitForEvent(predicate, timeoutMs = 5000) {
  const seen = events.find(predicate);
  if (seen) return Promise.resolve(seen);
  return new Promise((resolvePromise, reject) => {
    const waiter = { predicate, resolve: resolvePromise };
    waiters.push(waiter);
    setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index !== -1) {
        waiters.splice(index, 1);
        reject(new Error("timeout waiting for event"));
      }
    }, timeoutMs);
  });
}

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

const rows = [];
const record = (name, ok, detail = "") => rows.push([ok ? "PASS" : "FAIL", name, detail]);

try {
  const warm = await send({ type: "bash", command: "echo hello" });
  record("RPC ready", warm.success === true, `exit=${warm.data?.exitCode}`);

  const tmp = await send({ type: "bash", command: "echo hi > /tmp/pi-dsh-e2e-write.txt && cat /tmp/pi-dsh-e2e-write.txt" });
  record("workspace-write: /tmp is writable", tmp.data?.exitCode === 0, `output=${JSON.stringify(tmp.data?.output?.trim())}`);

  const etc = await send({ type: "bash", command: "echo hi > /etc/pi-dsh-should-not-exist" });
  record(
    "workspace-write: /etc is denied",
    etc.data?.exitCode !== 0 && /read-only file system/i.test(etc.data?.output ?? ""),
    `exit=${etc.data?.exitCode}`,
  );

  const toReadOnly = await send({ type: "prompt", message: "/sandbox read-only" });
  record("/sandbox read-only applies", toReadOnly.success === true);

  const readOnlyNotice = await waitForEvent(
    (event) => event.type === "message_end" && event.message?.customType === "dsh-sandbox-notice",
  );
  record(
    "read-only posts the switch notice",
    /switched this session's sandbox mode to read-only/.test(readOnlyNotice.message?.content ?? ""),
  );

  const readOnlyTmp = await send({ type: "bash", command: "echo hi > /tmp/pi-dsh-e2e-write2.txt" });
  record("read-only: /tmp is denied", readOnlyTmp.data?.exitCode !== 0, `exit=${readOnlyTmp.data?.exitCode}`);

  const readOnlyRoot = await send({ type: "bash", command: "touch /pi-dsh-e2e-root.txt" });
  record("read-only: / is denied", readOnlyRoot.data?.exitCode !== 0, `exit=${readOnlyRoot.data?.exitCode}`);

  const restore = await send({ type: "prompt", message: "/sandbox workspace-write" });
  const wsNotice = await waitForEvent(
    (event) =>
      event.type === "message_end" &&
      event.message?.customType === "dsh-sandbox-notice" &&
      /workspace-write/.test(event.message?.content ?? ""),
  );
  record("workspace-write posts the switch notice", wsNotice.message?.content !== undefined);
  const back = await send({ type: "bash", command: "rm -f /tmp/pi-dsh-e2e-write.txt && echo restored" });
  record("workspace-write restores writes", restore.success === true && back.data?.exitCode === 0, `exit=${back.data?.exitCode}`);
} catch (error) {
  record("unexpected failure", false, String(error));
} finally {
  child.stdin.end();
  child.kill("SIGKILL");
  for (const [status, name, detail] of rows) {
    console.log(`${status}  ${name}${detail === "" ? "" : `  (${detail})`}`);
  }
  if (stderr.trim() !== "") {
    console.log(`--- stderr ---\n${stderr.split("\n").slice(0, 8).join("\n")}`);
  }
  process.exitCode = rows.some(([status]) => status === "FAIL") ? 1 : 0;
}
