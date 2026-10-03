# pi-dsh-sandbox

English | [中文](README.zh.md)

Confine the writes a pi session can make without taking its tools away.

Three modes decide what a session may write, and two layers enforce the choice.

The `write` and `edit` tools check the target path in process. Commands, in the
`bash` tool and after `!`, run inside bubblewrap on Linux or Seatbelt on macOS.

Reads stay unrestricted, and commands keep the host network. The sandbox
governs file writes only.

The code lives in `index.ts`, with one module per concern under `src/`.

The modes, the per-call policy, the escalation flow, and the model-facing
strings come from
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

## Modes

| Mode | Session may write | Use when |
|---|---|---|
| `read-only` | Nothing outside the sinks shells need, such as `/dev/null` | Reviewing code or running untrusted plans |
| `workspace-write` | The working directory, `/tmp`, and the platform temp dir | Default |
| `danger-full-access` | Anything the user can | Installing packages, or any task that leaves the workspace |

## Platforms

One backend per platform enforces the command boundary.

- **Linux**: bubblewrap mounts a read-only root, and the probe applies a
  read-only profile once at session start.
- **macOS**: Seatbelt (`sandbox-exec`) applies a profile in the Sandbox
  Profile Language (SBPL). The probe tries dsh's `-p <profile> --` form first,
  then the form without `--`, and remembers the one this host accepts.
- **Windows**: no backend exists, so the session starts in
  `danger-full-access` and says so. A `read-only` session there would still run
  PowerShell writes unconfined, so the fallback is deliberate.
- **Anywhere else**: a confined command refuses to run. No confined mode ever
  falls through to an unconfined run.

The Windows fallback also leaves the tool schemas plain, with no escalation
fields.

## Install

```bash
pi install git:github.com/Frost-rA9/pi-dsh-sandbox   # from GitHub
pi -e ./pi-dsh-sandbox                               # or a checkout, once
pi --sandbox-mode read-only                          # outranks a restored mode
```

The extension ships no runtime dependencies, so it needs no `npm install`.

## Use

`/sandbox` opens a picker and marks the current mode. Without a dialog channel,
such as print mode, it prints the state instead.

Picking `danger-full-access` asks for confirmation first, and so does
`/sandbox danger-full-access`.

`/sandbox <mode>` and `/sandbox off` skip the picker. A switch appends one
session entry, so a resumed session restores it.

The footer shows the mode as `[sandbox::<mode>]`. The token is green for
`read-only`, accent for `workspace-write`, yellow for `danger-full-access`, and
red for `unavailable`, meaning a confined mode with no usable backend.

## Escalation

A denied write carries one marker, whichever layer refused it:

```text
[sandbox: file access denied under workspace-write mode]
```

The same result tells the model to retry that exact operation with
`sandbox_permissions` and a one-sentence `justification`.

pi asks you to approve, and the grant covers that single call. A rejection, a
cancelled prompt, or a missing dialog channel keeps the denial.

## Configuration

Global settings live at `<agentDir>/extensions/pi-dsh-sandbox.json`, where
`agentDir` defaults to `~/.pi/agent`. Project settings at
`<cwd>/.pi/dsh-sandbox.json` replace them.

An unknown key or a bad value is reported at startup. The session then falls
back to `read-only` instead of ignoring it.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `workspace-write` | Mode the session starts from |
| `bwrapPath` | `bwrap` | Runner the Linux backend invokes |
| `seatbeltPath` | `sandbox-exec` | Runner the macOS backend invokes |
| `probeTimeoutMs` | `5000` | Milliseconds allowed for the one-time backend probe |

## Limitations

- **The fence is a policy check, not a kernel boundary.** It reads a
  model-controlled path in trusted code, so an extension that calls `node:fs`
  directly bypasses it. Use a container or microVM for a hard boundary.
- **The check-to-write window is narrow, not closed.** The target is
  canonicalized again right before the write, matching dsh's own window.
- **`/tmp` means two different things.** The fence writes the host `/tmp`, while
  the command boundary mounts a fresh tmpfs there. A file a command writes to
  `/tmp` is invisible to the `read` tool and to later commands.
- **A confined session cannot run nested `pi`.** `<agentDir>/settings.json.lock`,
  the lock pi takes at startup, sits outside the workspace. That write fails,
  so pi ignores its global `packages` list; switch to `danger-full-access`.
- **Commands pay one extra shell.** The wrapper is
  `<runner> <profile> <shell> -c '<command>'`, because pi's shell operations
  take a command string.

## Tests

```bash
npm test              # Unit, fence, real bubblewrap, fake sandbox-exec
npm run check         # tsc, with host declarations symlinked
npm run inspect       # Tool schemas, no model call
npm run e2e           # Real pi over RPC: bash and ! enforcement
npm run check:tools   # Fence and escalation inside a tool execution
npm run e2e:model     # One live model turn, denial to approved retry
```

`.github/workflows/ci.yml` runs `npm test` and `tsc` on `ubuntu-latest` and
`macos-latest`.

The macOS job runs `tests/enforcement.darwin.test.ts` against the real
`sandbox-exec`. That is the only place the Seatbelt profile, the EPERM denials,
and the `/tmp` to `/private/tmp` mapping meet the kernel they target.

`npm run check` symlinks the host declarations into a gitignored `node_modules/`
and looks for `tsc` on the machine.

## License

MIT. Portions ported from DeepSeek Harness are covered by the
[third-party notices](THIRD-PARTY-NOTICES.md).
