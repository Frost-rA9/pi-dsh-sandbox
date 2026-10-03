/**
 * Behavior parity with dsh for path containment, the derivation both the fence
 * and the bubblewrap profile use to decide what a writable root covers.
 *
 * @module pi-dsh-sandbox/tests/containment-parity
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isPathUnder } from "../src/containment.ts";
import { loadDsh, paritySkip } from "./parity/dsh.ts";

interface DshContainment {
  isPathUnder(path: string, root: string, caseSensitive?: boolean): Promise<boolean>;
}

test("isPathUnder matches dsh across lexical and filesystem cases", { skip: paritySkip }, async (t) => {
  const dsh = await loadDsh<DshContainment>("packages/fs/fs-sandbox/src/containment.ts");
  const workspace = mkdtempSync(join(tmpdir(), "pi-dsh-containment-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const inner = join(workspace, "inner");
  mkdirSync(inner);
  const escape = join(workspace, "escape");
  symlinkSync(tmpdir(), escape);

  const cases: [string, string][] = [
    [workspace, workspace],
    [inner, workspace],
    [join(inner, "file.txt"), workspace],
    [join(workspace, "missing", "file.txt"), workspace],
    [join(workspace, ".."), workspace],
    [`${workspace}-sibling`, workspace],
    [escape, workspace],
    [join(escape, "file.txt"), workspace],
    ["/usr/bin", "/usr"],
    ["/usr", "/usr/bin"],
  ];

  for (const [path, root] of cases) {
    assert.equal(
      await isPathUnder(path, root),
      await dsh.isPathUnder(path, root),
      `${path} under ${root}`,
    );
  }
});
