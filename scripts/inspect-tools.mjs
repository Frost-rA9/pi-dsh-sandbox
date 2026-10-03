/**
 * Offline tool-surface check: create an SDK session with this extension and
 * print the registered bash/write/edit schemas — no model call involved.
 *
 * Usage: node scripts/inspect-tools.mjs
 *
 * Set PI_DIST to the pi package's dist/index.js when it is not in the default
 * volta location.
 *
 * @module pi-dsh-sandbox/scripts/inspect-tools
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = resolve(here, "..");

const candidates = [
  process.env.PI_DIST,
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

const { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } = await import(piDist);

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  additionalExtensionPaths: [join(packageRoot, "index.ts")],
});
await loader.reload();

const errors = loader.getExtensions().errors ?? [];
if (errors.length > 0) {
  console.error("EXTENSION LOAD ERRORS:", errors);
  process.exit(1);
}

const { session } = await createAgentSession({ resourceLoader: loader, sessionManager: SessionManager.inMemory() });
try {
  console.log(`active: ${session.getActiveToolNames().sort().join(", ")}`);
  for (const name of ["bash", "write", "edit"]) {
    const tool = session.getAllTools().find((candidate) => candidate.name === name);
    if (tool === undefined) {
      console.log(`${name}: MISSING`);
      continue;
    }
    const props = Object.keys(tool.parameters?.properties ?? {});
    console.log(`${name}: params=[${props.join(", ")}] escalation=${props.includes("sandbox_permissions") ? "yes" : "NO"}`);
  }
} finally {
  session.dispose();
}
