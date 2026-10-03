/**
 * Anchor checks and drift report for this repository.
 *
 * Local mode (default) verifies that every anchor in `docs/anchors-dsh.json`
 * still points at a file and symbol that exist in the recorded dsh ref, that
 * every seam in `docs/anchors-pi.json` still points at a file and declaration
 * that exist, and that the recorded pi version matches the installed one.
 *
 * Drift mode (`--to <ref>`) compares the recorded dsh ref with a new ref and
 * prints a report. It states a verdict and lists the drifted items:
 *
 *   - MECHANICAL DRIFT is what the script can decide: a dsh file or symbol the
 *     anchor needs is gone, or a `ported-verbatim` anchor's string literals
 *     changed. Each item shows the literal before and after.
 *   - REVIEW is what only a human can decide: a contract-bearing anchor's file
 *     changed without a mechanical signal, so the contract may or may not have
 *     moved.
 *
 * The script never edits a file and never decides whether to adopt a change.
 *
 * Design mode (`--design`) also compares the behavior names in the chapter 5
 * table of `docs/design.md` with the ledger, so the two hand-maintained views
 * cannot drift apart silently.
 *
 * The dsh checkout is found through `--dsh`, then `PI_DSH_ROOT`, then the
 * sibling and home candidates. When none exists, the dsh checks are skipped
 * with a notice, because CI has no dsh checkout and still checks the pi side.
 *
 * Usage:
 *   node scripts/check-anchors.mjs
 *   node scripts/check-anchors.mjs --to <new-ref> [--from <baseline-ref>] [--report <path.md>]
 *   node scripts/check-anchors.mjs --design
 *   node scripts/check-anchors.mjs --dsh /path/to/deepseek-harness
 *
 * @module check-anchors
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

const flagValue = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

if (argv.includes("--help")) {
  console.log("Usage: node scripts/check-anchors.mjs [--to <ref>] [--from <ref>] [--report <path.md>] [--design] [--dsh <path>]");
  process.exit(0);
}

const dshLedger = JSON.parse(readFileSync(join(repoRoot, "docs", "anchors-dsh.json"), "utf8"));
const piLedger = JSON.parse(readFileSync(join(repoRoot, "docs", "anchors-pi.json"), "utf8"));
const fromRef = flagValue("--from") ?? dshLedger.recordedRef;

let failures = 0;
const note = (kind, text) => console.log(`${kind.padEnd(8)} ${text}`);

// --- locate the dsh checkout ------------------------------------------------
const explicitDsh = flagValue("--dsh") ?? process.env.PI_DSH_ROOT;
const dshCandidates = explicitDsh === undefined
  ? [join(repoRoot, "..", "deepseek-harness"), join(homedir(), "projects", "deepseek-harness")]
  : [explicitDsh];
const dshRoot = dshCandidates.find((candidate) => existsSync(join(candidate, "packages")));
if (dshRoot === undefined && explicitDsh !== undefined) {
  note("FAIL", `dsh checkout not found at ${explicitDsh}`);
  process.exit(1);
}

// --- locate the installed pi package ----------------------------------------
const explicitPi = process.env.PI_PACKAGE_ROOT;
const piCandidates = explicitPi === undefined
  ? [
      join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent"),
      join(homedir(), ".volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent"),
    ]
  : [explicitPi];
const piRoot = piCandidates.find((candidate) => existsSync(join(candidate, "package.json")));
if (piRoot === undefined && explicitPi !== undefined) {
  note("FAIL", `pi package not found at ${explicitPi}`);
  process.exit(1);
}

const readVersion = (root) => JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function git(args) {
  return execFileSync("git", ["-C", dshRoot, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function dshFile(ref, path) {
  return git(["show", `${ref}:${path}`]);
}

/** The source region of one symbol at a ref, or null when the symbol is absent. */
function anchorRegion(ref, path, symbol) {
  if (symbol === null) return null;
  let content;
  try {
    content = dshFile(ref, path);
  } catch {
    return null;
  }
  const index = content.indexOf(symbol);
  if (index === -1) return null;
  const after = content.slice(index);
  const brace = after.indexOf("{");
  const lineEnd = after.indexOf("\n");
  if (brace === -1 || brace > 200) return after.slice(0, lineEnd === -1 ? after.length : lineEnd);

  let depth = 0;
  let index2 = brace;
  let inString = null;
  for (; index2 < after.length; index2 += 1) {
    const character = after[index2];
    if (inString !== null) {
      if (character === "\\") index2 += 1;
      else if (character === inString) inString = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      inString = character;
      continue;
    }
    if (character === "/" && after[index2 + 1] === "/") {
      const newline = after.indexOf("\n", index2);
      if (newline === -1) break;
      index2 = newline;
      continue;
    }
    if (character === "/" && after[index2 + 1] === "*") {
      const close = after.indexOf("*/", index2 + 2);
      if (close === -1) break;
      index2 = close + 1;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        index2 += 1;
        break;
      }
    }
  }
  return after.slice(0, index2);
}

/** The string literals inside a region, with their delimiters, for a verbatim comparison. */
function literals(region) {
  const found = new Set();
  if (region === null) return found;
  const regex = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/gs;
  let match;
  while ((match = regex.exec(region)) !== null) found.add(`${match[1]}${match[2]}${match[1]}`);
  return found;
}

function diffStat(from, to, path) {
  const output = git(["diff", "--numstat", from, to, "--", path]).trim();
  if (output === "") return null;
  const [added, removed] = output.split("\t");
  return { added: Number(added), removed: Number(removed) };
}

// --- local consistency ------------------------------------------------------
if (dshRoot === undefined) {
  note("SKIP", "no dsh checkout; set PI_DSH_ROOT or pass --dsh to run the dsh checks");
} else {
  let bad = 0;
  for (const anchor of dshLedger.anchors) {
    for (const entry of anchor.dsh) {
      const content = anchorRegion(fromRef, entry.path, entry.symbol);
      if (content === null && !hasFile(fromRef, entry.path)) {
        note("FAIL", `dsh file missing at ${fromRef}: ${anchor.id} -> ${entry.path}`);
        failures += 1;
        bad += 1;
      } else if (entry.symbol !== null && content === null) {
        note("FAIL", `dsh symbol missing: ${anchor.id} -> ${entry.path} :: ${entry.symbol}`);
        failures += 1;
        bad += 1;
      }
    }
    for (const entry of anchor.pi) {
      let content;
      try {
        content = readFileSync(join(repoRoot, entry.path), "utf8");
      } catch {
        note("FAIL", `pi file missing: ${anchor.id} -> ${entry.path}`);
        failures += 1;
        bad += 1;
        continue;
      }
      if (entry.symbol !== null && !content.includes(entry.symbol)) {
        note("FAIL", `pi symbol missing: ${anchor.id} -> ${entry.path} :: ${entry.symbol}`);
        failures += 1;
        bad += 1;
      }
    }
  }
  if (bad === 0) note("OK", `dsh ledger: ${dshLedger.anchors.length} anchors resolve at ${fromRef}`);
}

function hasFile(ref, path) {
  try {
    dshFile(ref, path);
    return true;
  } catch {
    return false;
  }
}

let piBad = 0;
for (const seam of piLedger.seams) {
  for (const usage of seam.usage) {
    if (!existsSync(join(repoRoot, usage))) {
      note("FAIL", `usage file missing: ${seam.id} -> ${usage}`);
      failures += 1;
      piBad += 1;
    }
  }
  if (seam.declaration === null || piRoot === undefined) continue;
  let content;
  try {
    content = readFileSync(join(piRoot, seam.declaration), "utf8");
  } catch {
    note("FAIL", `declaration missing: ${seam.id} -> ${seam.declaration}`);
    failures += 1;
    piBad += 1;
    continue;
  }
  if (seam.symbol !== null && !content.includes(seam.symbol)) {
    note("FAIL", `declaration symbol missing: ${seam.id} -> ${seam.declaration} :: ${seam.symbol}`);
    failures += 1;
    piBad += 1;
  }
}
if (piBad === 0 && piRoot !== undefined) {
  note("OK", `pi ledger: ${piLedger.seams.length} seams resolve against ${readVersion(piRoot)}`);
}

if (piRoot === undefined) {
  note("SKIP", "no installed pi package; the version pin and declaration checks were not run");
} else if (readVersion(piRoot) === piLedger.recordedVersion) {
  note("OK", `pi version matches recordedVersion ${piLedger.recordedVersion}`);
} else {
  note("WARN", `pi ${readVersion(piRoot)} differs from recordedVersion ${piLedger.recordedVersion}; re-review docs/anchors-pi.json when you choose to`);
}

// --- design table versus ledger ---------------------------------------------
if (argv.includes("--design")) {
  const design = readFileSync(join(repoRoot, "docs", "design.md"), "utf8").split("\n");
  const header = design.findIndex((line) => line.startsWith("| Behavior |"));
  if (header === -1) {
    note("FAIL", "design.md has no chapter 5 table with a `| Behavior |` header");
    failures += 1;
  } else {
    const table = [];
    for (let index = header + 2; index < design.length && design[index].startsWith("|"); index += 1) {
      table.push(design[index].split("|")[1].replaceAll("`", "").trim());
    }
    const ledger = dshLedger.anchors.map((anchor) => anchor.behavior.replaceAll("`", "").trim());
    const missingFromTable = ledger.filter((behavior) => !table.includes(behavior));
    const missingFromLedger = table.filter((behavior) => !ledger.includes(behavior));
    for (const behavior of missingFromTable) {
      note("FAIL", `design table is missing the ledger behavior: ${behavior}`);
      failures += 1;
    }
    for (const behavior of missingFromLedger) {
      note("FAIL", `ledger is missing the design table behavior: ${behavior}`);
      failures += 1;
    }
    if (missingFromTable.length === 0 && missingFromLedger.length === 0) {
      note("OK", `design table matches the ledger (${ledger.length} behaviors)`);
    }
  }
}

// --- drift report -----------------------------------------------------------
const toRef = flagValue("--to");
if (toRef !== undefined) {
  if (dshRoot === undefined) {
    note("FAIL", "--to needs a dsh checkout; set PI_DSH_ROOT or pass --dsh");
    process.exit(1);
  }
  let refOk = true;
  try {
    git(["rev-parse", "--verify", "--quiet", `${toRef}^{commit}`]);
  } catch {
    note("FAIL", `unknown ref: ${toRef}`);
    refOk = false;
  }
  if (refOk) {
    const report = buildDriftReport(toRef);
    console.log("");
    console.log(report.markdown);
    const reportPath = flagValue("--report");
    if (reportPath !== undefined) {
      mkdirSync(dirname(resolve(reportPath)), { recursive: true });
      writeFileSync(resolve(reportPath), `${report.markdown}\n`);
      console.log(`report written to ${resolve(reportPath)}`);
    }
    failures += report.mechanical.length + report.review.length;
  } else {
    failures += 1;
  }
}

/** Build the drift report for one target ref. */
function buildDriftReport(toRefValue) {
  const paths = [...new Set(dshLedger.anchors.flatMap((anchor) => anchor.dsh.map((entry) => entry.path)))];
  const output = git(["diff", "--name-status", fromRef, toRefValue, "--", ...paths]).trim();
  const changes = output === "" ? [] : output.split("\n").map((line) => {
    const parts = line.split("\t");
    const status = parts[0][0];
    return status === "R" || status === "C"
      ? { status, from: parts[1], to: parts[2] }
      : { status, from: parts[1], to: parts[1] };
  });

  const described = git(["show", "-s", "--format=%h %s", toRefValue]).trim();
  const unchanged = [];
  const mechanical = [];
  const review = [];

  for (const anchor of dshLedger.anchors) {
    const anchorChanges = changes.filter((change) =>
      anchor.dsh.some((entry) => entry.path === change.from || entry.path === change.to));
    if (anchorChanges.length === 0) {
      unchanged.push(anchor);
      continue;
    }

    const items = [];
    for (const entry of anchor.dsh) {
      const rename = anchorChanges.find((change) => change.from === entry.path && change.to !== change.from);
      const path = rename === undefined ? entry.path : rename.to;
      if (!hasFile(toRefValue, path)) {
        items.push({ kind: "missing-file", path, symbol: entry.symbol, note: `gone at ${toRefValue}` });
        continue;
      }
      if (entry.symbol === null) {
        if (anchor.result === "ported-verbatim") {
          items.push({ kind: "verbatim-file", path, symbol: null, note: "whole-file verbatim anchor changed" });
        }
        continue;
      }
      const region = anchorRegion(toRefValue, path, entry.symbol);
      if (region === null) {
        items.push({ kind: "missing-symbol", path, symbol: entry.symbol, note: `symbol absent at ${toRefValue}` });
        continue;
      }
      if (anchor.result === "ported-verbatim") {
        const before = literals(anchorRegion(fromRef, entry.path, entry.symbol));
        const after = literals(region);
        const removed = [...before].filter((literal) => !after.has(literal));
        const added = [...after].filter((literal) => !before.has(literal));
        if (removed.length > 0 || added.length > 0) {
          items.push({ kind: "verbatim", path, symbol: entry.symbol, note: "string literals changed", removed, added });
        }
      }
    }

    if (items.length > 0) mechanical.push({ anchor, changes: anchorChanges, items });
    else review.push({ anchor, changes: anchorChanges });
  }

  const lines = [];
  lines.push("# Anchor drift report");
  lines.push("");
  lines.push(`- repository: ${repoRoot}`);
  lines.push(`- baseline (dsh): \`${fromRef}\`${fromRef === dshLedger.recordedRef ? "" : ` (recorded in the ledger: \`${dshLedger.recordedRef}\`)`}`);
  lines.push(`- target (dsh): \`${toRefValue}\` (${described})`);
  lines.push(`- generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  if (mechanical.length === 0 && review.length === 0) {
    lines.push(`CLEAN. No anchored dsh path changed between \`${fromRef}\` and \`${toRefValue}\`.`);
  } else {
    const mechanicalCount = mechanical.reduce((sum, entry) => sum + entry.items.length, 0);
    lines.push(`DRIFT. ${mechanicalCount} mechanical drift item(s) across ${mechanical.length} anchor(s), and ${review.length} anchor(s) needing semantic review.`);
    lines.push("");
    lines.push("Mechanical items are decidable from the source and should be resolved. Review items need a person to decide whether the contract moved.");
  }
  lines.push("");

  if (mechanical.length > 0) {
    lines.push("## Mechanical drift");
    lines.push("");
    for (const { anchor, items } of mechanical) {
      lines.push(`### ${anchor.id} (${anchor.result}, ${anchor.contract ? "contract" : "internal"})`);
      lines.push("");
      for (const item of items) {
        lines.push(`- \`${item.path}\`${item.symbol === null ? "" : ` :: \`${item.symbol}\``}`);
        lines.push(`  - ${item.kind}: ${item.note}`);
        for (const literal of item.removed ?? []) lines.push(`  - removed literal: ${literal}`);
        for (const literal of item.added ?? []) lines.push(`  - added literal: ${literal}`);
      }
      lines.push("");
      for (const entry of anchor.pi) lines.push(`pi side: \`${entry.path}\`${entry.symbol === null ? "" : ` :: \`${entry.symbol}\``}`);
      if (anchor.parity !== null && anchor.parity !== undefined) lines.push(`parity test: ${anchor.parity.status} (${anchor.parity.test})`);
      lines.push("");
      lines.push(`read: \`git -C ${dshRoot} diff ${fromRef} ${toRefValue} -- ${items[0].path}\``);
      lines.push("");
    }
  }

  if (review.length > 0) {
    lines.push("## Review required");
    lines.push("");
    for (const { anchor, changes: anchorChanges } of review) {
      lines.push(`### ${anchor.id} (${anchor.result}, ${anchor.contract ? "contract" : "internal"})`);
      lines.push("");
      for (const change of anchorChanges) {
        const status = change.status === "R" ? "renamed" : change.status === "D" ? "deleted" : "changed";
        const stat = diffStat(fromRef, toRefValue, change.from);
        lines.push(`- ${status}: \`${change.from}\`${change.to === change.from ? "" : ` -> \`${change.to}\``}${stat === null || status === "renamed" ? "" : ` (+${stat.added}/-${stat.removed})`}`);
      }
      for (const entry of anchor.dsh) {
        if (entry.symbol === null) continue;
        const rename = anchorChanges.find((change) => change.from === entry.path && change.to !== change.from);
        const path = rename === undefined ? entry.path : rename.to;
        const symbol = hasFile(toRefValue, path) && anchorRegion(toRefValue, path, entry.symbol) !== null ? "present" : "MISSING";
        lines.push(`- symbol \`${entry.symbol}\` at target: ${symbol}`);
      }
      lines.push("");
      lines.push(`read: \`git -C ${dshRoot} diff ${fromRef} ${toRefValue} -- ${anchorChanges.map((change) => change.from).join(" ")}\``);
      lines.push("");
    }
  }

  if (unchanged.length > 0) {
    lines.push("## Unchanged anchors");
    lines.push("");
    lines.push(unchanged.map((anchor) => anchor.id).join(", "));
    lines.push("");
  }

  lines.push("## After the review");
  lines.push("");
  lines.push("Adopt the change in code, record a divergence, or defer it. Then update `docs/anchors-dsh.json`, the table in `docs/design.md`, and `recordedRef` in the same commit.");
  lines.push("");

  return { markdown: lines.join("\n"), mechanical, review };
}

console.log("");
console.log(failures === 0 ? "anchors clean" : `${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
