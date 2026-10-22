# pi-dsh-sandbox

English | [中文](README.zh.md)

Confine the writes a pi session can make without taking its tools away. Three modes decide what a session may write, and two layers enforce the choice.

The `write` and `edit` tools check the target path in process. Commands, in the `bash` tool and after `!`, run inside bubblewrap on Linux or Seatbelt on macOS. Reads stay unrestricted, and commands keep the host network.

The sandbox governs file writes only. It works with [pi-dsh-plan](https://github.com/Frost-rA9/pi-dsh-plan), which guides the agent. The two keep separate state.

The design rationale and the dsh anchors are in [`docs/design.md`](docs/design.md).

The modes, the per-call policy, the escalation flow, and the model-facing strings come from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

## Modes

| Mode | Session may write | Use when |
|---|---|---|
| `read-only` | Nothing outside the sinks shells need, such as `/dev/null` | Reviewing code or running untrusted plans |
| `workspace-write` | The working directory, `/tmp`, and the platform temp dir | Default |
| `danger-full-access` | Anything the user can | Installing packages, or any task that leaves the workspace |

## Platforms

One backend per platform enforces the command boundary.

- **Linux**: bubblewrap mounts a read-only root. The probe applies a read-only profile once at session start.
- **macOS**: Seatbelt (`sandbox-exec`) applies a profile in the Sandbox Profile Language (SBPL). The probe tries dsh's `-p <profile> --` form first, then the form without `--`. It remembers the form this host accepts.
- **Windows**: no backend exists, so the session starts in `danger-full-access` and says so. A `read-only` session there would still run PowerShell writes unconfined, so the fallback is deliberate.
- **Anywhere else**: a confined command refuses to run. No confined mode falls through to an unconfined run.

The Windows fallback also leaves the tool schemas plain, with no escalation fields.

## Install

```bash
pi install git:github.com/Frost-rA9/pi-dsh-sandbox   # from GitHub
pi -e ./pi-dsh-sandbox                               # or a checkout, once
pi --sandbox-mode read-only                          # outranks a restored mode
```

The extension ships no runtime dependencies, so it needs no `npm install`.

The extension registers its own `codemode`: pi's definition plus the program-level escalation. pi therefore drops the built-in `codemode` extension and reports it at startup. Disable the built-in to remove the warning. The extension gets the codemode definition from pi, so nothing is lost. In `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["-builtin:codemode"]
}
```

## Use

`/sandbox` opens a picker and marks the current mode. Without a dialog channel, such as print mode, it prints the state instead.

Picking `danger-full-access` asks for confirmation first. So does `/sandbox danger-full-access`.

`/sandbox <mode>` and `/sandbox off` skip the picker. A switch appends one session entry, so a resumed session restores it.

A switch that changes the effective mode posts one notice to the model. The notice appears in the transcript and names the new mode and its file policy. A repeat selection and the startup `--sandbox-mode` flag stay silent.

The footer shows the mode as `[sandbox::<mode>]`. The token is green for `read-only`, accent for `workspace-write`, yellow for `danger-full-access`, and red for `unavailable`, meaning a confined mode with no usable backend.

## Escalation

A denied write carries one marker, whichever layer refused it:

```text
[sandbox: file access denied under workspace-write mode]
```

The same result tells the model to retry that exact operation with `sandbox_permissions` and a one-sentence `justification`.

pi asks you to approve, and the grant covers that single call. A rejection, a cancelled prompt, or a missing dialog channel keeps the denial. Concurrent asks wait in a queue and open one at a time.

A `codemode` script may ask for the wider mode for its whole run. `sandbox_permissions` and `justification` on the `codemode` call cover every call the script makes. The grant ends with the run or when the session mode changes.

A mode change cancels the running script, and the next script waits for its nested calls to finish. A run that hit a denial reports what the one-shot grant is for.

## Configuration

Global settings live at `<agentDir>/extensions/pi-dsh-sandbox.json`, where `agentDir` defaults to `~/.pi/agent`. Project settings at `<cwd>/.pi/dsh-sandbox.json` replace them.

The extension reports an unknown key or a bad value at startup, and the session falls back to `read-only`.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `workspace-write` | Mode the session starts from |
| `bwrapPath` | `bwrap` | Runner the Linux backend invokes |
| `seatbeltPath` | `sandbox-exec` | Runner the macOS backend invokes |
| `probeTimeoutMs` | `5000` | Milliseconds allowed for the one-time backend probe |

## Limitations

- **Not a kernel boundary.** The fence is a policy check in trusted code. It reads a model-controlled path, so an extension that calls `node:fs` bypasses it. Use a container or microVM for a hard boundary.
- **The window is narrow, not closed.** The fence canonicalizes the target again right before the write, as dsh does.
- **`/tmp` means two different things.** The fence writes the host `/tmp`, while the command boundary mounts a fresh tmpfs there. A file a command writes to `/tmp` is invisible to the `read` tool and to later commands.
- **A confined session cannot run nested `pi`.** `<agentDir>/settings.json.lock`, the lock pi takes at startup, sits outside the workspace. That write fails, so pi ignores its global `packages` list. Switch to `danger-full-access`.
- **Commands pay one extra shell.** The wrapper is `<runner> <profile> <shell> -c '<command>'`, because pi's shell operations take a command string.

## Tests

```bash
npm test              # Unit, fence, real bubblewrap, fake sandbox-exec
npm run check         # tsc, with host declarations symlinked
npm run check:anchors # dsh and pi anchor drift checks
npm run inspect       # Tool schemas, no model call
npm run e2e           # Real pi over RPC: bash and ! enforcement
npm run check:tools   # Fence and escalation inside a tool execution
npm run check:shape   # Replacement definitions still carry what pi's do
npm run e2e:model     # Two live model turns: per-call retry, then one program-sized approval
```

`npm run check:anchors` checks the dsh and pi anchors in `docs/`, and uses `PI_DSH_ROOT` (or `--dsh`) when a `deepseek-harness` checkout exists. `--to <ref>` reports drift for a new dsh ref: mechanical drift with the changed literals, plus anchors that need semantic review. `--report <path>` writes the report to a file.

`npm run e2e:model` drives a real model over RPC and plays the human at the dialogs. The second turn asks for one `codemode` script that writes two files outside the workspace. That covers the program-sized grant: one approval, both writes, and the run-scoped mode that expires with the script. It needs provider credentials and spends two turns.

`npm run check:shape` compares each replacement tool definition with pi's own. Key sets must match, only the declared overrides may differ, and `parameters` must equal pi's after it removes the escalation fields. It drives itself with three synthetic drifts, so it fails loudly if it stops detecting. `ci.yml` runs it against the pinned pi package.

`npm test` also runs behavior-parity tests against the same checkout. They import the dsh functions and compare the writable roots, path containment, the escalation strings, and the bubblewrap and Seatbelt profiles. They skip when no checkout exists.

`.github/workflows/ci.yml` runs `npm test`, `tsc`, and the anchor checks on `ubuntu-latest` and `macos-latest`.

The macOS job runs `tests/enforcement.darwin.test.ts` against the real `sandbox-exec`. That is the only place the Seatbelt profile, the EPERM denials, and the `/tmp` to `/private/tmp` mapping meet the kernel they target.

`npm run check` symlinks the host declarations into a gitignored `node_modules/` and looks for `tsc` on the machine.

## License

MIT. The [third-party notices](THIRD-PARTY-NOTICES.md) cover portions ported from DeepSeek Harness.
