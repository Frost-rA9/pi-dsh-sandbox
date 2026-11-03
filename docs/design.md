# Design: pi-dsh-sandbox

**File-effect confinement for pi: one dsh mode vocabulary, two enforcement layers, and named platform fallbacks.**

|                |                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------- |
| **Status**     | Implemented and open for comments                                                        |
| **Owner**      | Frost-rA9                                                                                |
| **Scope**      | This document records the design points of `pi-dsh-sandbox`, and the dsh anchor and port result for each ported behavior. |
| **Related**    | [`README.md`](../README.md), [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md), [`anchors-dsh.json`](anchors-dsh.json), [`anchors-pi.json`](anchors-pi.json), [pi-dsh-plan](https://github.com/Frost-rA9/pi-dsh-plan) |
| **Audience**   | Maintainers of `pi-dsh-sandbox`, and anyone porting another dsh package to pi            |

Out of scope:

- The implementation walkthrough, which the source headers own.
- The operational procedures, which `README.md` owns.
- dsh features left out on purpose, one row each in chapter 5.

## 1. Summary

`pi-dsh-sandbox` limits which files a pi session can write, without removing tools. One dsh mode vocabulary decides the limits. Two layers enforce them: an in-process check over `write` and `edit`, and an OS sandbox around commands (`bubblewrap` on Linux, Seatbelt on macOS).

The extension binds the mode as an appended entry. It resolves a per-call policy under the deployment default. It allows one approved, strictly-wider retry after a denial.

## 2. Terms and grounding

**Mode** is the file-effect tier: `read-only`, `workspace-write`, or `danger-full-access`. It governs file writes only. The network and process visibility stay outside the vocabulary, as in dsh.

**Anchor** is the dsh path and symbol that a ported behavior came from. **Port result** uses one of five labels:

- **Ported**: the behavior matches dsh, with pi-specific plumbing where an API differs.
- **Ported verbatim**: strings or derivations copied without change.
- **Substituted**: the behavior is the same, and the storage or channel is a pi equivalent.
- **Extended**: the port adds behavior dsh does not have at that anchor.
- **Not ported**: the dsh feature is absent here, and the table names the consequence.

The dsh anchors below come from `deepseek-harness` at `687f282e86` (`0.2.1-rc.2`). The pi behavior refers to pi `1.5.0` in `anchors-pi.json`. dsh paths are relative to the harness root, and pi paths to this repository.

The dsh tree moves, so re-check a path and symbol before you rely on it, and cite the commit when a divergence matters. Tooling anchors live in `anchors-dsh.json` and `anchors-pi.json`. The chapter 5 table is the readable view, and both files change with it.

## 3. Goals and non-goals

The extension keeps dsh's policy decisions and replaces only the pi integration points.

Goals:

- Express dsh's file-effect policy through pi's own tools, without removing a tool.
- Fail closed when a required backend is absent.
- Keep every model-facing string traceable to dsh.

Non-goals:

- Windows confinement: the dsh ACL rung stays unported, so win32 falls back instead.
- The Landlock rung on Linux, so `bubblewrap` is the only rung.
- Network and process isolation, which the mode vocabulary never covered.
- Guidance. Plan mode is a separate extension, `pi-dsh-plan`.

## 4. Design points

### 4.1 One policy, two enforcement layers

> **Why & What: one policy, two enforcement layers**
>
> **What:** `write` and `edit` pass an in-process policy check, and `bash` plus `!` run inside bubblewrap on Linux or Seatbelt on macOS.
>
> **Why:** dsh expresses one policy through a provider per platform. An in-process check covers pi's own file mutations without a kernel facility, while commands need OS confinement because they can call anything.
>
> **Alternatives considered:**
> - *Confine only commands:* leaves `write` and `edit` ungoverned unless tools are filtered, which would change the tool catalog on every switch.
> - *Confine only the file tools:* leaves commands able to write anywhere.
>
> **Fallback:** a platform with no backend mounts no confinement and says so.

Both layers read the same writable-root derivation, so the `write` tool and `bash` cannot disagree about what `workspace-write` means.

dsh 0.2.2 splits that derivation in two: the workspace plus its explicit extra directories (`workspaceWritableRoots`) and the same set plus the platform temp areas (`writableRoots`). Bubblewrap mounts its own `/tmp`, so it takes the first; the fence and Seatbelt take the second. An explicit extra root must be an existing physical directory, checked on every confined call, and grants nothing under `read-only`.

### 4.2 Session state and per-call resolution

> **Why & What: `appendEntry` replaces the log-only event**
>
> **What:** the session override is one `dsh-sandbox-mode` custom entry, restored by folding the active branch at `session_start`.
>
> **Why:** dsh stores `sandbox/mode` as a log-only session event folded by a projection. pi exposes no such event or projection registry, so the nearest durable store is a custom entry. The entry does not give the policy one home: each layer reads it from this module, but nothing outside the extension can.
>
> **Alternatives considered:**
> - *In-process memory:* cheaper, but resume and fork lose the override.
> - *A JSON file outside the session:* durable, but branch navigation and fork cannot see it, so an abandoned branch leaks.
>
> **Fallback:** no entry means the deployment default applies, and a missing entry never widens access.

Resolution precedence is dsh's: an approved grant outranks the session override, which outranks the deployment default. The workspace root is the session `cwd`, with a configured absolute root as the fallback.

### 4.3 Escalation is per-call and strictly wider

> **Why & What: escalation covers one call and only widens**
>
> **What:** a denied call may retry once with `sandbox_permissions` plus a `justification`. The user approves, and the grant applies to that call only. Requesting the mode already in force is not an escalation, so it needs neither a justification nor a dialog.
>
> **Why:** dsh checks the pairing, proves the target is strictly wider, and asks for approval before execution. A session-wide grant would turn one exception into a standing widening, and it would not help a denial caused by anything other than the mode. Those denials keep their own error.
>
> **Alternatives considered:**
> - *A session-wide escalation:* fewer prompts, but one approval silently raises the tier for every later call.
> - *Auto-approving a repeated justification:* no user in the loop for a write the user has not seen.
>
> **Fallback:** the denial stands, and the model explains instead of working around it.

pi has no approval service, so the channel is `ctx.ui.select`. pi shows one extension dialog at a time. A queue (`src/dialog-queue.ts`) keeps one dialog open and withdraws a request when its call aborts.

Escalation also has a program-sized tier, ported from dsh's `run_code`. The `codemode` tool carries the same two fields, and one approval covers the calls a script makes.

The grant dies with the run (`src/codemode.ts`, `src/run-grant.ts`). dsh confines the program's own process. pi's codemode has none, so the grant rides the run's nested calls instead. That is the one recorded divergence (ch. 5).

A session mode change cancels the run. The next program waits for its cleanup before it resolves the new mode.

Nested calls keep their own policies, and a wider request still asks on its own. A denied run reports dsh's guidance paragraph, so the model knows the one-shot grant and that earlier effects may already have completed.

### 4.4 The policy reaches the model on a switch

> **Why & What: a tier change emits a visible notice**
>
> **What:** a `/sandbox` switch that changes the effective tier emits one custom message (`dsh-sandbox-notice`). It appears in the transcript, reaches the model, and carries the policy sentences for the new tier.
>
> **Why:** dsh surfaces the standing policy in every request through the `sandbox:policy` runtime context. pi has no such channel, so a notice on change is the nearest delivery. The notice does not cover the startup flags, which stay silent.
>
> **Alternatives considered:**
> - *A prompt section like plan mode's:* pi would rebuild it per prompt, paying tokens on every request. The notice fires once per change.
> - *Silence, relying on denial markers:* the model learns the tier only when a call is denied, after the failure.
>
> **Fallback:** the denial markers still teach the boundary when a layer refuses a call.

### 4.5 The platform fallback is explicit

> **Why & What: an unenforceable tier is not promised**
>
> **What:** win32 has no backend and starts in `danger-full-access`. On a supported platform, a confined command refuses to run when the probe fails.
>
> **Why:** a `read-only` session on Windows would still run PowerShell writes unconfined, so claiming the tier would be false. A missing bubblewrap or Seatbelt on Linux or macOS is a host fact, not a platform limit, so that case fails closed at execution.
>
> **Alternatives considered:**
> - *Refuse to start on win32:* honest, but it blocks unrelated work that needs no write.
> - *Best-effort partial confinement:* an unenforced mode that looks enforced is worse than a named fallback.
>
> **Fallback:** switch the session to `danger-full-access` deliberately, or install a confinement backend.

## 5. Porting results and dsh anchors

| Behavior | dsh anchor | pi anchor | Port result |
| --- | --- | --- | --- |
| Mode vocabulary and policy type | `packages/sandbox/sandbox/src/index.ts` (`SandboxMode`, `SandboxExecutionPolicy`, `SandboxUnavailableError`) | `src/modes.ts` | Ported. |
| Writable roots | `packages/sandbox/sandbox/src/roots.ts` (`canonicalPath`, `workspaceWritableRoots`, `writableRoots`) | `src/roots.ts` | Ported verbatim, including the explicit extra-directory checks. Substitution: dsh extends `HarnessError` (`SANDBOX_INVALID_ROOT`); pi has no such base class, so `SandboxInvalidRootError` extends `Error` and carries the same `code` and message. |
| Filesystem fence | `packages/fs/fs-sandbox/src/index.ts` (`SandboxedFileSystem.checkedTarget`) | `src/fence.ts` | Ported, including the re-canonicalize-before-write window. Divergence: dsh 0.2.2 also fences `patchText`, `deleteFile`, and `moveFile`; pi has no such tools, and its deletions and moves run through `bash`, which the command boundary confines. |
| Path containment | `packages/fs/fs-sandbox/src/containment.ts` (`isPathUnder`) | `src/containment.ts` | Ported. |
| Per-call policy resolution | `packages/fs/tool-fs/src/sandbox.ts` (`FsSandboxController.resolvePolicy`) | `src/calls.ts` | Ported precedence and the relaxed pairing. The workspace root stays the session-start cwd because pi has no working-directory service (reviewed at `687f282e86`). |
| Write and edit tools | `packages/fs/tool-fs/src/write.ts`, `edit.ts` | `src/fstools.ts` | Ported for the two mutations. Reads and listings pass through. Path resolution and results come from pi, not from dsh's tool layer (reviewed at `687f282e86`). |
| Escalation vocabulary | `packages/sandbox/sandbox/src/escalation.ts` | `src/escalation.ts`, `src/schema.ts`, `src/dialog-queue.ts` | Ported verbatim for the strings. The approval channel substitutes `ctx.ui.select` for `ctx.approval`. A queue keeps one dialog open. dsh builds the approval `displayReason` from its locale tables; pi keeps the English sentence. The relaxed pairing (repeating the standing mode needs no justification) applies to the program tier too, where dsh still validates strictly. |
| Program-level escalation (PTC `run_code`) | `packages/core/tool-executor-ptc/src/ptc.ts` (`RUN_CODE_CONTROLS`, `escalationGuidance`, `subject: 'program'`) | `src/codemode.ts`, `src/run-grant.ts` | Ported for the fields, one-shot grant, denial guidance, retry flow, and mode-change cancellation. Divergence: the grant rides nested calls because pi's codemode has no effects (ch. 4.3). |
| Bash family | `packages/shell/bash-sandbox/src/index.ts` | `src/bash.ts` | Ported. The pi seams are the `bash` tool override and `user_bash`. |
| Bubblewrap profile | `packages/sandbox/sandbox-local/src/profiles.ts` (`bwrapProfileArgs`) | `src/bwrap.ts` | Ported. The Landlock rung from the same file is not. |
| Seatbelt profile | `packages/sandbox/sandbox-local/src/profiles.ts` (`seatbeltProfileArgs`) | `src/seatbelt.ts` | Ported, including the dialect probe. |
| Backend selection and probe | `packages/sandbox/sandbox-local/src/index.ts` | `src/backend.ts` | Ported and reduced to one rung per platform. |
| Session override | `packages/sandbox/sandbox-policy/src/session-mode.ts` (`sandbox/mode`, `setSandboxMode`), `index.ts` (`SandboxPolicyService.resolve`) | `src/state.ts` | Substituted storage, same precedence (ch. 4.2). |
| Policy sentences | `packages/sandbox/sandbox-policy/src/index.ts` (`renderPolicyContext`) | `src/notice.ts` | Adapted: the per-request runtime context becomes a switch notice, with the product name replaced. The extra-directory sentence is ported with it. |
| Windows ACL rung | `packages/sandbox/sandbox-windows-acl/src/` | not ported | Divergence: win32 falls back to `danger-full-access` (ch. 4.5), so dsh 0.2.2's `SandboxUnsupportedPolicyError` for extra roots on that rung has no pi counterpart — no policy reaches a rung there. |
| Landlock rung | `packages/sandbox/sandbox-local/src/profiles.ts` (`landlockProfileArgs`) | not ported | Divergence: Linux uses bubblewrap only. |

## 6. Benefits and costs

Benefits:

- The fence governs pi's own file mutations without a kernel facility, and commands get a real OS boundary.
- Every model-facing denial and escalation string matches dsh, so the model sees one vocabulary.
- Missing backends and unenforceable platforms fail closed with a named state.

Costs:

- Windows and Landlock stay uncovered, so confinement is weaker than dsh's on those rungs.
- The fence is a policy check in trusted code, not a kernel boundary. Another extension that calls `node:fs` bypasses it. Use a container or microVM for a hard boundary.
- Re-canonicalizing before the mutation narrows the check-to-write window. It does not close the window.
- `/tmp` means two things: the fence writes the host path, while the command boundary mounts a fresh tmpfs.
- A confined session cannot start a nested `pi`, because the agent directory's lock file sits outside the workspace.

## 7. Open questions

- Should the extension add the Landlock or the Windows ACL rung? Owner: maintainer. Both need a host and a test bed that the current CI does not have.
- Should the fence cover more than `write` and `edit`, such as a future patch tool? Owner: maintainer. The current coverage follows the two mutations dsh fences.
- Should the approval offer a session-scoped grant alongside the per-call one? Owner: maintainer. Chapter 4.3 rejected it for silent widening. A separately labeled option may still earn its place.
