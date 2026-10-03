/**
 * Static type check without putting host packages in the repo.
 *
 * pi loads extensions with jiti and aliases `@earendil-works/pi-coding-agent`
 * and `typebox` to its own copies, so this package legitimately ships with no
 * runtime dependencies. Type checking still needs those declarations plus a
 * compiler, so this script SYMLINKS them into a gitignored `node_modules/`
 * (host copy, never a physical duplicate that could shadow pi's module
 * mapping) and then runs the compiler found on the machine.
 *
 * Resolution order:
 *   - pi package root: $PI_PACKAGE_ROOT, else the volta install location
 *   - compiler:        $PI_TSC, else typescript under the pi package, else a
 *                      typescript install under a sibling project, else `tsc`
 *
 * Usage: node scripts/check-types.mjs [--setup-only]
 *
 * @module pi-dsh-sandbox/scripts/check-types
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Candidate pi package directories, most explicit first. */
function piPackageCandidates() {
  const candidates = [];
  if (process.env.PI_PACKAGE_ROOT !== undefined) candidates.push(process.env.PI_PACKAGE_ROOT);
  candidates.push(
    join(
      homedir(),
      ".volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent",
    ),
  );
  return candidates;
}

const piRoot = piPackageCandidates().find((candidate) => existsSync(join(candidate, "package.json")));
if (piRoot === undefined) {
  console.error(`Could not locate the pi package. Tried:\n${piPackageCandidates().join("\n")}\nSet PI_PACKAGE_ROOT.`);
  process.exit(1);
}

/** Candidate `tsc` entry points. */
function compilerCandidates() {
  const candidates = [];
  if (process.env.PI_TSC !== undefined) candidates.push(process.env.PI_TSC);
  candidates.push(join(piRoot, "node_modules/typescript/bin/tsc"));
  const projects = join(homedir(), "projects");
  if (existsSync(projects)) {
    for (const entry of readdirSync(projects)) {
      candidates.push(join(projects, entry, "node_modules/typescript/bin/tsc"));
    }
  }
  return candidates;
}

const tsc = compilerCandidates().find((candidate) => existsSync(candidate));
if (tsc === undefined) {
  console.error(
    `Could not locate a TypeScript compiler. Tried:\n${compilerCandidates().join("\n")}\n`
      + "Set PI_TSC to a typescript/bin/tsc path, or `npm i -D typescript`.",
  );
  process.exit(1);
}

// --- link the host declarations into a gitignored node_modules ---------------
const nodeModules = join(packageRoot, "node_modules");
mkdirSync(nodeModules, { recursive: true });
mkdirSync(join(nodeModules, "@earendil-works"), { recursive: true });
mkdirSync(join(nodeModules, "@types"), { recursive: true });

/** Point node_modules/<name> at the host copy, replacing a stale link. */
function link(name, target) {
  const linkPath = join(nodeModules, name);
  if (!existsSync(target)) {
    console.error(`Missing host package for "${name}": ${target}`);
    process.exit(1);
  }
  rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(target, linkPath, "dir");
}

link("@earendil-works/pi-coding-agent", piRoot);
link("typebox", join(piRoot, "node_modules/typebox"));
const typesNode = [join(piRoot, "node_modules/@types/node"), join(homedir(), "projects/deepseek-harness/node_modules/@types/node")];
const nodeTypes = typesNode.find((candidate) => existsSync(candidate));
if (nodeTypes === undefined) {
  console.error(`Could not locate @types/node. Tried:\n${typesNode.join("\n")}`);
  process.exit(1);
}
link("@types/node", nodeTypes);

console.log(`pi package:  ${piRoot}`);
console.log(`compiler:    ${tsc}`);

if (process.argv.includes("--setup-only")) {
  console.log(`linked ${nodeModules} (gitignored)`);
  process.exit(0);
}

const result = spawnSync(process.execPath, [tsc, "-p", join(packageRoot, "tsconfig.json"), "--noEmit"], {
  cwd: packageRoot,
  stdio: "inherit",
});
// A clean check should not leave the linked tree behind: it exists only so the
// compiler can resolve host declarations.
console.log(`\n${result.status === 0 ? "type check passed" : "type check FAILED"}`);
process.exit(result.status ?? 1);
