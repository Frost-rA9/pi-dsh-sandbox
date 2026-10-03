/**
 * Switch-notice text: the plan-style switch sentence over dsh's policy
 * sentences.
 *
 * @module pi-dsh-sandbox/tests/notice.test
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { sandboxPolicyContext, sandboxSwitchNotice } from "../src/notice.ts";

test("every mode has a policy sentence", () => {
  assert.match(sandboxPolicyContext("read-only", "/work"), /^Current file policy: read-only\./);
  assert.match(sandboxPolicyContext("workspace-write", "/work"), /^Current file policy: workspace-write\./);
  assert.match(sandboxPolicyContext("danger-full-access", "/work"), /^Current file policy: danger-full-access\./);
});

test("workspace-write names the workspace boundary", () => {
  assert.match(sandboxPolicyContext("workspace-write", "/home/me/project"), /"\/home\/me\/project"/);
});

test("the switch notice pairs the sentence with the policy text", () => {
  const notice = sandboxSwitchNotice("read-only", "/work");
  assert.match(notice, /^The user switched this session's sandbox mode to read-only\./);
  assert.match(notice, /Current file policy: read-only\./);
  assert.doesNotMatch(notice, /DSH/);
});
