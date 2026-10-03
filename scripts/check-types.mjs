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
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, rmdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * Candidate pi package directories, most portable first: the explicit override,
 * then this checkout's own `node_modules` (what `npm install` produces, locally
 * and in CI), and finally the volta layout of the development machine.
 */
function piPackageCandidates() {
  const candidates = [];
  if (process.env.PI_PACKAGE_ROOT !== undefined) candidates.push(process.env.PI_PACKAGE_ROOT);
  candidates.push(join(packageRoot, "node_modules/@earendil-works/pi-coding-agent"));
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
  console.error(
    `Could not locate the pi package. Tried:\n${piPackageCandidates().join("\n")}\n`
      + "Set PI_PACKAGE_ROOT, or install the declarations: "
      + "npm install --no-save typescript @types/node typebox @earendil-works/pi-coding-agent",
  );
  process.exit(1);
}

/** Candidate `tsc` entry points, same ordering rule. */
function compilerCandidates() {
  const candidates = [];
  if (process.env.PI_TSC !== undefined) candidates.push(process.env.PI_TSC);
  candidates.push(join(packageRoot, "node_modules/typescript/bin/tsc"));
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
      + "Set PI_TSC, or install the declarations: "
      + "npm install --no-save typescript @types/node typebox @earendil-works/pi-coding-agent",
  );
  process.exit(1);
}

// --- link the host declarations into a gitignored node_modules ---------------
const nodeModules = join(packageRoot, "node_modules");
mkdirSync(nodeModules, { recursive: true });
mkdirSync(join(nodeModules, "@earendil-works"), { recursive: true });
mkdirSync(join(nodeModules, "@types"), { recursive: true });

/** Names this run linked, so cleanup removes exactly those and nothing npm put there. */
const linked = [];

/**
 * Point node_modules/<name> at the host copy, replacing a stale link.
 *
 * Idempotent, and safe when the chosen candidate IS the link it would create:
 * after an `npm install`, the local copy is already in place, and re-linking a
 * symlink onto itself would leave a self-reference that resolves to ELOOP.
 */
function link(name, target) {
  const linkPath = join(nodeModules, name);
  if (!existsSync(target)) {
    console.error(`Missing host package for "${name}": ${target}`);
    process.exit(1);
  }
  if (resolve(target) === resolve(linkPath)) return;
  try {
    if (existsSync(linkPath) && realpathSync(linkPath) === realpathSync(target)) return;
  } catch {
    // A broken link resolves to nothing, so it gets replaced below.
  }
  rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(target, linkPath, "dir");
  linked.push(name);
}

/**
 * Remove the links this run created.
 *
 * A link left behind makes a later `npm install` walk into the user's own pi
 * installation and chmod files there. Only links are removed; anything npm
 * installed stays.
 */
function unlink() {
  for (const name of linked) {
    const linkPath = join(nodeModules, name);
    try {
      if (lstatSync(linkPath).isSymbolicLink()) rmSync(linkPath);
    } catch {
      // Already gone.
    }
  }
  for (const dir of ["@earendil-works", "@types", "."]) {
    try {
      rmdirSync(dir === "." ? nodeModules : join(nodeModules, dir));
    } catch {
      // Not empty, or never created: leave it.
    }
  }
}

/** Run the compiler and drop the links again, whatever the verdict. */
function compile() {
  try {
    const result = spawnSync(process.execPath, [tsc, "-p", join(packageRoot, "tsconfig.json"), "--noEmit"], {
      cwd: packageRoot,
      stdio: "inherit",
    });
    console.log(`\n${result.status === 0 ? "type check passed" : "type check FAILED"}`);
    return result.status ?? 1;
  } finally {
    unlink();
  }
}

const typebox = [
  join(packageRoot, "node_modules/typebox"),
  join(piRoot, "node_modules/typebox"),
].find((candidate) => existsSync(candidate));
if (typebox === undefined) {
  console.error(
    "Could not locate typebox. Install the declarations: "
      + "npm install --no-save typescript @types/node typebox @earendil-works/pi-coding-agent",
  );
  process.exit(1);
}

link("@earendil-works/pi-coding-agent", piRoot);
link("typebox", typebox);
const typesNode = [
  join(packageRoot, "node_modules/@types/node"),
  join(piRoot, "node_modules/@types/node"),
  join(homedir(), "projects/deepseek-harness/node_modules/@types/node"),
];
const nodeTypes = typesNode.find((candidate) => existsSync(candidate));
if (nodeTypes === undefined) {
  console.error(
    `Could not locate @types/node. Tried:\n${typesNode.join("\n")}\n`
      + "Install the declarations: npm install --no-save typescript @types/node typebox @earendil-works/pi-coding-agent",
  );
  process.exit(1);
}
link("@types/node", nodeTypes);

console.log(`pi package:  ${piRoot}`);
console.log(`compiler:    ${tsc}`);

if (process.argv.includes("--setup-only")) {
  console.log(`linked ${nodeModules} (gitignored)`);
  process.exit(0);
}

process.exit(compile());
