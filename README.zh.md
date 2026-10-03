# pi-dsh-sandbox

[English](README.md) | 中文

在不拿走工具的前提下，限制 pi 会话能写入的范围。

三种模式决定会话能写什么，两层机制负责执行。

`write` 与 `edit` 工具在进程内检查目标路径。命令，也就是 `bash` 工具和 `!` 后面的命令，在 Linux 上跑进 bubblewrap，在 macOS 上跑进 Seatbelt。

读取不受限制，命令保留宿主网络。沙箱只管文件写入。

沙箱做限制，[pi-dsh-plan](https://github.com/Frost-rA9/pi-dsh-plan) 做指导，两者各自维护状态。

代码入口是 `index.ts`，`src/` 下每个模块管一件事。

设计要点与 dsh 锚点见 [`docs/design.md`](docs/design.md)。

模式词汇、逐次调用解析的策略、升级流程、以及模型可见的文案，都来自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）。

## 模式

| 模式 | 会话可写 | 适用场景 |
|---|---|---|
| `read-only` | 除 shell 必需的写入目标（如 `/dev/null`）之外都不能写 | 读代码、跑不可信的计划 |
| `workspace-write` | 工作目录、`/tmp` 与平台临时目录 | 默认 |
| `danger-full-access` | 该用户能写的任何位置 | 装包，或任何需要离开工作区的任务 |

## 平台

每个平台用一个后端执行命令边界。

- **Linux**：bubblewrap 挂只读根，探测在会话启动时套用一次只读 profile。
- **macOS**：Seatbelt（`sandbox-exec`）套用一份 Sandbox Profile Language (SBPL) profile。探测先试 dsh 的 `-p <profile> --` 形式，再试不带 `--` 的形式，并记住这台机器接受哪一种。
- **Windows**：没有后端，会话直接以 `danger-full-access` 启动并说明原因。那里的 `read-only` 会话仍会不受限地执行 PowerShell 写入，所以这个回退是有意为之。
- **其它平台**：受限命令拒绝执行。受限模式不会退化为不受限执行。

Windows 的回退也不注册任何限制工具，因此工具 schema 里没有升级字段。

## 安装

```bash
pi install git:github.com/Frost-rA9/pi-dsh-sandbox   # 从 GitHub 安装
pi -e ./pi-dsh-sandbox                               # 或临时加载一份检出
pi --sandbox-mode read-only                          # 优先于恢复出来的模式
```

本扩展没有运行时依赖，不需要 `npm install`。

## 使用

`/sandbox` 打开选择器并标出当前模式。没有对话通道时，例如 print 模式，改为打印状态。

选 `danger-full-access` 会先要一次确认，`/sandbox danger-full-access` 同样会问。

`/sandbox <mode>` 与 `/sandbox off` 跳过选择器。每次切换追加一条会话条目，所以恢复会话时模式一并恢复。

切换真正改变了生效档位时，还会向模型发一条 notice：一条显示在 transcript 里的消息，说明新的模式及其文件策略。重复选择当前模式，以及启动时的 `--sandbox-mode` 旗标，都不会发。

footer 把模式显示为 `[sandbox::<mode>]`。`read-only` 是绿色，`workspace-write` 是主题色，`danger-full-access` 是黄色；`unavailable` 是红色，表示该受限模式没有可用后端。

## 升级

被拒的写入只带一条标记，无论拒绝来自哪一层：

```text
[sandbox: file access denied under workspace-write mode]
```

同一条工具结果会告诉模型，用 `sandbox_permissions` 加一句 `justification` 重试这次操作。

pi 会请你审批，而授权只覆盖那一次调用。拒绝、取消弹窗、或没有对话通道，都会保留拒绝状态。

## 配置

全局配置在 `<agentDir>/extensions/pi-dsh-sandbox.json`，`agentDir` 默认是 `~/.pi/agent`。项目配置 `<cwd>/.pi/dsh-sandbox.json` 会覆盖全局。

未知键或非法值会在启动时报告。随后会话回落到 `read-only`，而不是把它忽略掉。

| 键 | 默认值 | 含义 |
|---|---|---|
| `mode` | `workspace-write` | 会话启动时的模式 |
| `bwrapPath` | `bwrap` | Linux 后端调用的 runner |
| `seatbeltPath` | `sandbox-exec` | macOS 后端调用的 runner |
| `probeTimeoutMs` | `5000` | 一次性后端探测的毫秒上限 |

## 已知限制

- **围栏是进程内的策略检查，不构成内核边界。** 它只在可信代码里读取一个受模型控制的路径，所以直接调用 `node:fs` 的扩展能绕过它。要硬边界就用容器或 microVM。
- **检查与写入之间的窗口被收窄，但未被消除。** 写入前会重新 canonicalize 目标，窗口大小与 dsh 一致。
- **`/tmp` 在两层里含义不同。** 围栏写的是宿主 `/tmp`，命令边界挂的是全新的 tmpfs。命令写进 `/tmp` 的文件，`read` 工具与后续命令都看不到。
- **受限会话里跑不了嵌套 `pi`。** `<agentDir>/settings.json.lock` 是 pi 启动时取的锁，路径在工作区之外。那次写入会失败，于是 pi 忽略全局 `packages` 列表；要跑就先切到 `danger-full-access`。
- **命令多付一层 shell。** 包裹形式是 `<runner> <profile> <shell> -c '<command>'`，因为 pi 的 shell operations 接收的是命令字符串。

## 测试

```bash
npm test              # 单测、围栏、真实 bubblewrap、假 sandbox-exec
npm run check         # tsc，宿主声明走符号链接
npm run check:anchors # dsh 与 pi 锚点漂移检查
npm run inspect       # 打印工具 schema，无需模型调用
npm run e2e           # 真实 pi 走 RPC：bash 与 ! 的强制生效
npm run check:tools   # 工具执行内部的围栏与升级审批
npm run e2e:model     # 一次真实模型回合：从被拒到审批后重试
```

`npm run check:anchors` 校验 `docs/` 里的 dsh 与 pi 锚点，有 `deepseek-harness` 检出时用 `PI_DSH_ROOT` 或 `--dsh` 定位；传 `--to <ref>` 会对新的 dsh ref 产出一份漂移报告：机器可判定的漂移（含变更的字面量）与需要人工判定的锚点，`--report <path>` 可把报告写入文件。

`npm test` 还会对同一检出跑行为比对测试：直接 import dsh 的函数，比较 writable roots、路径包含、升级文案，以及 bubblewrap 与 Seatbelt profile。没有检出时跳过。

`.github/workflows/ci.yml` 在 `ubuntu-latest` 与 `macos-latest` 上跑 `npm test` 与 `tsc`。

macOS job 用真的 `sandbox-exec` 跑 `tests/enforcement.darwin.test.ts`。Seatbelt profile、EPERM 拒绝、以及 `/tmp` 到 `/private/tmp` 的映射，只有在那里才对着真正的内核验证。

`npm run check` 把宿主声明符号链接进被 gitignore 的 `node_modules/`，再用机器上已有的 `tsc`。

## 许可证

MIT。从 DeepSeek Harness 移植的部分另见[第三方声明](THIRD-PARTY-NOTICES.md)。
