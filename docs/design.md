# Design: pi-dsh-sandbox

**File-effect confinement for pi: one dsh mode vocabulary, two enforcement layers, and named platform fallbacks.**

|                |                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------- |
| **Status**     | Implemented; open for comments                                                           |
| **Owner**      | Frost-rA9                                                                                |
| **Scope**      | The design points of `pi-dsh-sandbox` and the dsh anchor and port result for each ported behavior. Excludes the implementation walkthrough (the source headers own it), the operational procedures (`README.md` owns them), and dsh features left out on purpose (one row each in chapter 5). |
| **Related**    | [`README.md`](../README.md); [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md); [`anchors-dsh.json`](anchors-dsh.json); [`anchors-pi.json`](anchors-pi.json); [pi-dsh-plan](https://github.com/Frost-rA9/pi-dsh-plan) |
| **Audience**   | Maintainers of `pi-dsh-sandbox`, and anyone porting another dsh package to pi            |

## 1. Summary

`pi-dsh-sandbox` limits which files a pi session can write, without removing tools. One mode vocabulary from dsh decides the limits, and two layers enforce it: an in-process policy check over pi's `write` and `edit` tools, and an operating-system sandbox around commands (`bubblewrap` on Linux, Seatbelt on macOS). The extension binds the mode to the session as an appended entry, resolves a per-call policy under the deployment default, and allows one approved, strictly-wider retry after a denial. Chapter 4 records the design points, each non-trivial choice in a Why & What box. Chapter 5 anchors every ported behavior to its dsh source and names the divergence.

## 2. Terms and grounding

**Mode** is the file-effect tier: `read-only`, `workspace-write`, or `danger-full-access`. It governs file writes only; the network and process visibility stay outside the vocabulary, as in dsh.

**Anchor** is the dsh path and symbol a behavior was ported from. **Port result** uses one of five labels:

- **Ported**: the behavior matches dsh, with pi-specific plumbing where an API differs.
- **Ported verbatim**: strings or derivations copied without change.
- **Substituted**: the behavior is the same, the storage or channel is a pi equivalent.
- **Extended**: the port adds behavior dsh does not have at that anchor.
- **Not ported**: the dsh feature is absent here, and the table names the consequence.

The dsh anchors below were read from the `deepseek-harness` checkout at commit `5badb15009`. The pi behavior was verified against `pi-dsh-sandbox` at `7f7327d`. dsh paths are relative to the `deepseek-harness` root; pi paths are relative to this repository root. The dsh tree moves, so re-check a path and symbol before relying on it, and cite the commit when a divergence matters. Anchors for tooling live beside this document in [`anchors-dsh.json`](anchors-dsh.json) and [`anchors-pi.json`](anchors-pi.json); the table in chapter 5 is the readable view, and both are updated in the same change.

## 3. Goals and non-goals

The extension keeps dsh's policy decisions and replaces only the pi integration points.

Goals:

- Express dsh's file-effect policy through pi's own tools, without removing a tool.
- Read one writable-root derivation in both enforcement layers, so they cannot disagree about `workspace-write`.
- Fail closed when a required backend is absent.
- Keep every model-facing string traceable to dsh.

Non-goals:

- Windows confinement: the dsh ACL rung stays unported, so win32 falls back instead.
- The Landlock rung on Linux; `bubblewrap` is the single Linux rung here.
- Network and process isolation, which the mode vocabulary never covered.
- Guidance; plan mode is a separate extension, `pi-dsh-plan`.

## 4. Design points

### 4.1 One policy, two enforcement layers

> **Why & What: one policy, two enforcement layers**
>
> **What:** `write` and `edit` pass an in-process policy check, and `bash` plus `!` run inside bubblewrap on Linux or Seatbelt on macOS.
>
> **Why:** dsh expresses one file-effect policy through a provider per platform. An in-process check covers pi's own file mutations without a kernel facility, while commands need OS confinement because they can call anything. It does not cover a command's file effects on a platform with no backend (ch. 4.5).
>
> **Alternatives considered:**
> - *Confine only commands:* leaves `write` and `edit` ungoverned unless tools are filtered, which would change the tool catalog on every switch.
> - *Confine only the file tools:* leaves commands able to write anywhere.
>
> **Fallback:** a platform with no backend mounts no confinement and says so.

Both layers read the same writable-root derivation, so the `write` tool and `bash` cannot disagree about what `workspace-write` means.

### 4.2 Session state and per-call resolution

> **Why & What: `appendEntry` replaces the log-only event**
>
> **What:** the session override is one `dsh-sandbox-mode` custom entry, restored by folding the active branch at `session_start`.
>
> **Why:** dsh stores `sandbox/mode` as a log-only session event folded by a projection. pi exposes neither a log-only event type nor a projection registry to extensions, so the nearest durable, non-context store is a custom entry. It does not give the policy one home across extensions: each enforcement layer reads the same resolved policy from this module, but nothing outside the extension can.
>
> **Alternatives considered:**
> - *In-process memory:* cheaper, but a resume or a fork loses the override, which is the case the store exists for.
> - *A JSON file outside the session:* durable, but invisible to branch navigation and fork, so an abandoned branch would leak into the next session.
>
> **Fallback:** no entry means the deployment default applies, and a missing entry never widens access.

Resolution precedence is dsh's: an approved grant outranks the session override, which outranks the deployment default. The workspace root is the session `cwd`, with a configured absolute root as the fallback.

### 4.3 Escalation is per-call and strictly wider

> **Why & What: escalation covers one call and only widens**
>
> **What:** a denied call may retry once with `sandbox_permissions` plus a `justification`. The user approves, and the grant applies to that call only.
>
> **Why:** dsh validates the pairing, proves the target is strictly wider, and asks for approval before execution. A session-wide grant would turn one approved exception into a standing widening. It does not help a denial caused by something other than the mode; those keep their own error.
>
> **Alternatives considered:**
> - *A session-wide escalation:* fewer prompts, but one approval silently raises the tier for every later call.
> - *Auto-approving a repeated justification:* no user in the loop for a write the user has not seen.
>
> **Fallback:** the denial stands, and the model explains instead of working around it.

pi has no approval service, so the channel is `ctx.ui.select`; every model-facing string around it is dsh's.

### 4.4 The policy reaches the model on a switch

> **Why & What: a tier change emits a visible notice**
>
> **What:** a `/sandbox` switch that changes the effective tier emits one custom message (`dsh-sandbox-notice`), displayed in the transcript and sent to the model, carrying the policy sentences for the new tier.
>
> **Why:** dsh surfaces the standing policy to every request through the `sandbox:policy` runtime context and never emits a switch notice. pi has no runtime-context channel here, so a notice on change is the nearest delivery. It does not cover the startup flags, which stay silent because no request has been told otherwise.
>
> **Alternatives considered:**
> - *A prompt section like plan mode's:* pi would rebuild it per prompt, paying tokens on every request; the notice fires once per change.
> - *Silence, relying on denial markers:* the model learns the tier only when a call is denied, after the failure.
>
> **Fallback:** the denial markers still teach the boundary when a call is refused.

### 4.5 The platform fallback is explicit

> **Why & What: an unenforceable tier is not promised**
>
> **What:** win32 has no backend and starts in `danger-full-access`. On a supported platform, a confined command refuses to run when the probe fails.
>
> **Why:** a `read-only` session on Windows would still run PowerShell writes unconfined, so claiming the tier would be false. A missing bubblewrap or Seatbelt on Linux or macOS is a host fact, not a platform limit, so that case fails closed at execution instead. It does not port the Windows ACL rung, which would be the real fix.
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
| Writable roots | `packages/sandbox/sandbox/src/roots.ts` (`canonicalPath`, `writableRoots`) | `src/roots.ts` | Ported verbatim; one derivation shared by the fence and the bubblewrap profile. |
| Filesystem fence | `packages/fs/fs-sandbox/src/index.ts` (`SandboxedFileSystem.checkedTarget`) | `src/fence.ts` | Ported, including the re-canonicalize-before-write window. |
| Path containment | `packages/fs/fs-sandbox/src/containment.ts` (`isPathUnder`) | `src/containment.ts` | Ported. |
| Per-call policy resolution | `packages/fs/tool-fs/src/sandbox.ts` (`FsSandboxController.resolvePolicy`) | `src/calls.ts` | Ported precedence. |
| Write and edit tools | `packages/fs/tool-fs/src/write.ts`, `edit.ts` | `src/fstools.ts` | Ported for the two mutations; reads and listings pass through. |
| Escalation vocabulary | `packages/sandbox/sandbox/src/escalation.ts` | `src/escalation.ts`, `src/schema.ts` | Ported verbatim for the strings; the approval channel substitutes `ctx.ui.select` for `ctx.approval`. |
| Bash family | `packages/shell/bash-sandbox/src/index.ts` | `src/bash.ts` | Ported; the pi seams are the `bash` tool override and `user_bash`. |
| Bubblewrap profile | `packages/sandbox/sandbox-local/src/profiles.ts` (`bwrapProfileArgs`) | `src/bwrap.ts` | Ported; the Landlock rung from the same file is not. |
| Seatbelt profile | `packages/sandbox/sandbox-local/src/profiles.ts` (`seatbeltProfileArgs`) | `src/seatbelt.ts` | Ported, including the dialect probe. |
| Backend selection and probe | `packages/sandbox/sandbox-local/src/index.ts` | `src/backend.ts` | Ported and reduced to one rung per platform. |
| Session override | `packages/sandbox/sandbox-policy/src/session-mode.ts` (`sandbox/mode`, `setSandboxMode`), `index.ts` (`SandboxPolicyService.resolve`) | `src/state.ts` | Substituted storage, same precedence (ch. 4.2). |
| Policy sentences | `packages/sandbox/sandbox-policy/src/index.ts` (`renderPolicyContext`) | `src/notice.ts` | Adapted: the per-request runtime context becomes a switch notice, with the product name replaced. |
| Windows ACL rung | `packages/sandbox/sandbox-windows-acl/src/` | not ported | Divergence: win32 falls back to `danger-full-access` (ch. 4.5). |
| Landlock rung | `packages/sandbox/sandbox-local/src/profiles.ts` (`landlockProfileArgs`) | not ported | Divergence: Linux uses bubblewrap only. |

## 6. Benefits and costs

Benefits:

- The fence governs pi's own file mutations without a kernel facility, and commands get a real OS boundary.
- One writable-root derivation serves both layers, so they cannot drift apart.
- Every model-facing denial and escalation string matches dsh, so the model sees one vocabulary.
- Missing backends and unenforceable platforms fail closed with a named state.

Costs:

- Windows and Landlock stay uncovered, so confinement is weaker than dsh's on those rungs.
- The fence is a policy check in trusted code, not a kernel boundary. Another extension that calls `node:fs` directly bypasses it; a container or microVM is the answer for a hard boundary.
- The check-to-write window is narrowed by re-canonicalizing before the mutation, not closed.
- `/tmp` means two things: the fence writes the host path, while the command boundary mounts a fresh tmpfs.
- A confined session cannot start a nested `pi`, because the agent directory's lock file sits outside the workspace.

## 7. Open questions

- Should the extension add the Landlock or the Windows ACL rung? Owner: maintainer. Both need a host and a test bed that the current CI does not have.
- Should the fence cover more than `write` and `edit`, such as a future patch tool? Owner: maintainer. The current coverage follows the two mutations dsh fences.
- Should the approval offer a session-scoped grant alongside the per-call one? Owner: maintainer. Chapter 4.3 rejected it for silent widening; a separately labeled option may still earn its place.

The design points and the anchors are facts checked at the commits named in chapter 2. The open questions are proposals, and input on them is welcome.
