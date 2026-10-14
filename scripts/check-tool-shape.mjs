/**
 * Tool-shape drift check: does each replacement definition still carry
 * everything pi's own definition carries?
 *
 * The extension registers pi's definitions with a few keys rewritten (`...base`
 * plus `parameters` and `execute`, and for `codemode` also `description` and
 * `prepareLoadout`). Everything else is inherited, so the only place a pi
 * release can silently take something away from the model is those rewritten
 * keys — above all `parameters`, whose hand copy would drift, and any override
 * added later without a second thought.
 *
 * The check compares the registered definition with pi's current one:
 *
 *   - key sets must match, with nothing missing and nothing extra;
 *   - a declared override table names the keys allowed to differ;
 *   - every other key must be structurally equal to pi's;
 *   - `parameters` must equal pi's after the two escalation fields are removed
 *     (parameter descriptions are reported, not failed: bash's wording is
 *     deliberately pi's own now, but the field stays reportable);
 *   - the declared overrides and the actual differences must agree, so a new
 *     override fails and a stale declaration fails too.
 *
 * A self-check drives the same comparison with three synthetic drifts, so the
 * detector proves it still detects.
 *
 * Usage: node scripts/check-tool-shape.mjs
 *
 * @module pi-dsh-sandbox/scripts/check-tool-shape
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = resolve(here, "..");

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
  createBashToolDefinition,
  createCodemodeExtension,
  createEditToolDefinition,
  createWriteToolDefinition,
  getAgentDir,
  SessionManager,
} = await import(piDist);

/** The escalation fields every confined tool adds to pi's parameters. */
const ESCALATION_FIELDS = ["sandbox_permissions", "justification"];

/**
 * The keys each replacement is allowed to differ in, and why. A key that
 * differs without an entry here fails the check; an entry here whose key does
 * not differ fails it too.
 */
const OVERRIDES = {
  bash: {
    parameters: "the two escalation fields are added",
    execute: "resolves the per-call policy and delegates to pi's execute",
  },
  write: {
    parameters: "the two escalation fields are added",
    execute: "resolves the per-call policy and delegates to pi's execute",
  },
  edit: {
    parameters: "the two escalation fields are added",
    execute: "resolves the per-call policy and delegates to pi's execute",
  },
  codemode: {
    description: "dsh's program guidance is appended",
    parameters: "the two program escalation fields are added",
    execute: "resolves the program grant and delegates to pi's execute",
    prepareLoadout: "the guidance rides codemode's own description projection",
  },
};

const rows = [];
const record = (name, ok, detail = "") => rows.push([ok ? "PASS" : "FAIL", name, detail]);
const note = (name, detail = "") => rows.push(["INFO", name, detail]);

/** A structural copy with every `description` key dropped. */
function omitDescriptions(value) {
  if (Array.isArray(value)) return value.map(omitDescriptions);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "description") continue;
    out[key] = omitDescriptions(entry);
  }
  return out;
}

/** The first structural difference between two JSON values, or undefined. */
function firstDifference(left, right, path = "(root)") {
  if (left === right) return undefined;
  const kind = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
  if (kind(left) !== kind(right)) return { path, left, right };
  if (kind(left) === "array") {
    if (left.length !== right.length) return { path, left: `length ${left.length}`, right: `length ${right.length}` };
    for (let index = 0; index < left.length; index += 1) {
      const found = firstDifference(left[index], right[index], `${path}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (kind(left) === "object") {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const found = firstDifference(
        Object.hasOwn(left, key) ? left[key] : "(absent)",
        Object.hasOwn(right, key) ? right[key] : "(absent)",
        `${path}.${key}`,
      );
      if (found !== undefined) return found;
    }
    return undefined;
  }
  return { path, left, right };
}

/** Every path where both sides carry a `description` and the texts differ. */
function descriptionDiffs(left, right, path = "(schema)") {
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return [];
  const found = typeof left.description === "string" && typeof right.description === "string" && left.description !== right.description
    ? [path]
    : [];
  for (const key of Object.keys(left)) {
    if (!Object.hasOwn(right, key)) continue;
    found.push(...descriptionDiffs(left[key], right[key], `${path}.${key}`));
  }
  return found;
}

/**
 * Compare one replacement definition with pi's.
 *
 * @param name The tool name, for the report.
 * @param ours The registered definition.
 * @param base pi's own definition.
 * @param overrides The declared overrides for this tool.
 * @returns The failure messages, in report order.
 */
function compareTool(name, ours, base, overrides) {
  const failures = [];
  const show = (value) => (typeof value === "string" ? `"${value}"` : JSON.stringify(value));

  for (const key of Object.keys(base)) {
    if (!Object.hasOwn(ours, key)) failures.push(`pi's key "${key}" is missing from the replacement`);
  }
  for (const key of Object.keys(ours)) {
    if (!Object.hasOwn(base, key)) failures.push(`the replacement adds the undeclared key "${key}"`);
  }

  if (Object.hasOwn(ours, "parameters") && Object.hasOwn(base, "parameters")) {
    const fields = ours.parameters.properties ?? {};
    for (const field of ESCALATION_FIELDS) {
      if (!Object.hasOwn(fields, field)) failures.push(`parameters: the escalation field "${field}" is missing`);
    }
    const stripped = omitDescriptions(ours.parameters);
    for (const field of ESCALATION_FIELDS) delete stripped.properties?.[field];
    if (Array.isArray(stripped.required)) {
      stripped.required = stripped.required.filter((entry) => !ESCALATION_FIELDS.includes(entry));
    }
    const difference = firstDifference(omitDescriptions(base.parameters), stripped, "parameters");
    if (difference !== undefined) {
      failures.push(
        `parameters differ at ${difference.path}: pi=${show(difference.left)} replacement=${show(difference.right)}`,
      );
    }
    const described = descriptionDiffs(base.parameters, ours.parameters);
    if (described.length > 0) note(`${name}: parameter descriptions rewritten`, described.join(", "));
  }

  for (const key of new Set([...Object.keys(base), ...Object.keys(ours)])) {
    if (key === "parameters") continue;
    const left = base[key];
    const right = ours[key];
    if (typeof left === "function" || typeof right === "function") continue;
    const declared = overrides[key] !== undefined;
    const equal = JSON.stringify(left) === JSON.stringify(right);
    if (equal && declared) failures.push(`key "${key}" is declared as an override but still matches pi`);
    if (!equal && !declared) {
      failures.push(`key "${key}" differs from pi and is not declared: pi=${show(left)} replacement=${show(right)}`);
    }
  }

  return failures;
}

/** pi's codemode definition, captured the way src/codemode.ts captures it. */
function codemodeBaseline() {
  let captured;
  createCodemodeExtension()({
    registerTool: (tool) => { captured = tool; },
    getSettings: () => ({}),
    getAllTools: () => [],
    appendEntry: () => {},
  });
  if (captured === undefined) throw new Error("the codemode extension registered no tool");
  return captured;
}

/** A minimal confined-tool pair for the self-check. */
function syntheticPair() {
  const base = {
    name: "synthetic",
    label: "synthetic",
    description: "Synthetic tool",
    promptGuidelines: ["one"],
    parameters: { type: "object", required: ["code"], properties: { code: { type: "string", description: "code" } } },
    execute: function baseExecute() {},
    renderCall: function baseRender() {},
  };
  const ours = {
    ...base,
    parameters: {
      ...base.parameters,
      properties: {
        ...base.parameters.properties,
        sandbox_permissions: { type: "string", description: "wider" },
        justification: { type: "string", description: "why" },
      },
    },
    execute: function oursExecute() {},
  };
  return { base, ours };
}

const SYNTHETIC_OVERRIDES = { parameters: "escalation fields added", execute: "policy wrapper" };

try {
  const services = await createAgentSessionServices({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    resourceLoaderOptions: { additionalExtensionPaths: [join(packageRoot, "index.ts")] },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(),
  });
  await session.bindExtensions({
    uiContext: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => undefined,
      confirm: async () => false,
      theme: { fg: (_color, text) => text },
    },
    mode: "print",
  });

  const baselines = {
    bash: createBashToolDefinition(process.cwd(), {}),
    write: createWriteToolDefinition(process.cwd(), {}),
    edit: createEditToolDefinition(process.cwd(), {}),
    codemode: codemodeBaseline(),
  };

  for (const [name, base] of Object.entries(baselines)) {
    const ours = session.getToolDefinition(name);
    if (ours === undefined) {
      record(`${name}: registered`, false, "the extension registered no such tool");
      continue;
    }
    const failures = compareTool(name, ours, base, OVERRIDES[name]);
    record(
      `${name}: keys, values, and parameters match pi`,
      failures.length === 0,
      failures.length === 0 ? `overrides: ${Object.keys(OVERRIDES[name]).join(", ")}` : failures.join("; "),
    );
  }

  // The detector proves it still detects: each case must report a failure.
  const { base, ours } = syntheticPair();
  const selfChecks = [
    [
      "a pi-side parameter addition",
      { ...base, parameters: { ...base.parameters, properties: { ...base.parameters.properties, added: { type: "string" } } } },
      ours,
    ],
    ["an undeclared override", base, { ...ours, description: "changed" }],
    ["a parameter schema that lost required", base, { ...ours, parameters: { ...ours.parameters, required: [] } }],
  ];
  for (const [label, mutatedBase, mutatedOurs] of selfChecks) {
    const failures = compareTool("synthetic", mutatedOurs, mutatedBase, SYNTHETIC_OVERRIDES);
    record(`self-check: detects ${label}`, failures.length > 0, failures[0] ?? "no failure reported");
  }
  const control = compareTool("synthetic", ours, base, SYNTHETIC_OVERRIDES);
  record("self-check: the unmutated pair passes", control.length === 0, control.join("; "));
} catch (error) {
  record("unexpected failure", false, String(error));
}

for (const [status, name, detail] of rows) {
  console.log(`${status}  ${name}${detail === "" ? "" : `  (${detail})`}`);
}
process.exitCode = rows.some(([status]) => status === "FAIL") ? 1 : 0;
