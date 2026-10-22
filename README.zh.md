# pi-dsh-sandbox

[English](README.md) | 中文

在不拿走工具的前提下，限制 pi 会话能写入的范围。三种模式决定会话能写哪些位置，两层机制保证限制生效。

`write` 与 `edit` 工具在进程内检查目标路径。`bash` 工具和 `!` 后面的命令由操作系统的沙箱限制。Linux 上用 bubblewrap，macOS 上用 Seatbelt。读取不受限制，命令保留宿主网络。

沙箱只限制文件写入。本扩展与 [pi-dsh-plan](https://github.com/Frost-rA9/pi-dsh-plan) 配合，后者指导 agent，两者各自维护状态。

设计要点与 dsh 锚点见 [`docs/design.md`](docs/design.md)。

模式词汇、每次调用的策略解析、提权流程，以及模型可见的文案，都来自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）。

## 模式

| 模式 | 会话可写 | 适用场景 |
|---|---|---|
| `read-only` | 除 shell 必需的写入目标（如 `/dev/null`）之外都不能写 | 读代码、运行不可信的计划 |
| `workspace-write` | 工作目录、`/tmp` 与平台临时目录 | 默认 |
| `danger-full-access` | 该用户能写的任何位置 | 安装软件包，或任何需要离开工作区的任务 |

## 平台

每个平台用一个后端限制命令的文件写入。

- **Linux**：bubblewrap 挂载只读根。探测在会话启动时应用一次只读 profile。
- **macOS**：Seatbelt（`sandbox-exec`）应用一份 Sandbox Profile Language（SBPL）profile。探测先试 dsh 的 `-p <profile> --` 形式，再试不带 `--` 的形式。探测记住这台机器接受哪一种形式。
- **Windows**：没有后端，会话直接以 `danger-full-access` 启动并说明原因。该平台上的 `read-only` 会话仍会不受限地执行 PowerShell 写入，所以这个回退是有意为之。
- **其他平台**：受限命令拒绝执行。受限模式不会退化为不受限执行。

Windows 的回退还会让工具 schema 保持原样，不带提权字段。

## 安装

```bash
pi install git:github.com/Frost-rA9/pi-dsh-sandbox   # 从 GitHub 安装
pi -e ./pi-dsh-sandbox                               # 或临时加载一份检出
pi --sandbox-mode read-only                          # 优先于恢复出来的模式
```

本扩展没有运行时依赖，不需要 `npm install`。

本扩展注册自己的 `codemode`：pi 的定义加上程序级提权。pi 因此不加载内置的 `codemode` 扩展，并在启动时报告这件事。关闭内置项即可消除警告。`codemode` 定义取自 pi 本身，关闭后不会少任何功能。在 `~/.pi/agent/settings.json` 中写入：

```json
{
  "extensions": ["-builtin:codemode"]
}
```

## 使用

`/sandbox` 打开选择器并标出当前模式。没有对话通道时（例如 print 模式），改为打印状态。

选择 `danger-full-access` 会先要求确认。`/sandbox danger-full-access` 也会要求确认。

`/sandbox <mode>` 与 `/sandbox off` 跳过选择器。每次切换追加一条会话条目，恢复会话时模式一并恢复。

切换改变生效模式时，会向模型发送一条 notice。notice 显示在 transcript 里，并说明新的模式和对应的文件策略。重复选择当前模式，以及启动时的 `--sandbox-mode` 旗标，都不会发送。

footer 把模式显示为 `[sandbox::<mode>]`。`read-only` 是绿色，`workspace-write` 是主题色，`danger-full-access` 是黄色。`unavailable` 是红色，表示该受限模式没有可用后端。

## 提权

被拒的写入带一条标记，无论拒绝来自哪一层：

```text
[sandbox: file access denied under workspace-write mode]
```

同一条工具结果会告诉模型，用 `sandbox_permissions` 加一句 `justification` 重试这次操作。

pi 会请你审批，授权只覆盖那一次调用。拒绝、取消弹窗或没有对话通道，都会保留拒绝状态。并发的审批请求会在队列里等待，同一时间只打开一个。

`codemode` 脚本也可以为整次运行申请更宽的模式。`sandbox_permissions` 与 `justification` 写在 `codemode` 调用上，覆盖脚本发出的每次调用。授权随本次运行结束而失效，会话模式变化时也失效。

模式变化会取消正在运行的脚本。下一个脚本会等前一个脚本的嵌套调用结束后再开始。被拒的运行会说明这次一次性授权的用途。

## 配置

全局配置在 `<agentDir>/extensions/pi-dsh-sandbox.json`，`agentDir` 默认是 `~/.pi/agent`。项目配置 `<cwd>/.pi/dsh-sandbox.json` 会覆盖全局。

启动时，扩展会报告未知键或非法值，随后会话回落到 `read-only`。

| 键 | 默认值 | 含义 |
|---|---|---|
| `mode` | `workspace-write` | 会话启动时的模式 |
| `bwrapPath` | `bwrap` | Linux 后端调用的 runner |
| `seatbeltPath` | `sandbox-exec` | macOS 后端调用的 runner |
| `probeTimeoutMs` | `5000` | 一次性后端探测的毫秒上限 |

## 已知限制

- **围栏是进程内的策略检查，不构成内核边界。** 围栏在可信代码里读取受模型控制的路径，所以直接调用 `node:fs` 的扩展能绕过围栏。要硬边界，就用容器或 microVM。
- **检查与写入之间的窗口收窄了，但没有消除。** 写入前，围栏会再次 canonicalize 目标，与 dsh 的窗口一致。
- **`/tmp` 在两层里含义不同。** 围栏写的是宿主 `/tmp`，命令边界挂载的是全新的 tmpfs。命令写入 `/tmp` 的文件，`read` 工具与后续命令都看不到。
- **受限会话里无法运行嵌套 `pi`。** `<agentDir>/settings.json.lock` 是 pi 启动时获取的锁，路径在工作区之外。那次写入会失败，于是 pi 忽略全局 `packages` 列表。需要运行时，先切到 `danger-full-access`。
- **命令会多一层 shell。** 包装命令是 `<runner> <profile> <shell> -c '<command>'`，因为 pi 的 shell 操作接收的是命令字符串。

## 测试

```bash
npm test              # 单测、围栏、真实 bubblewrap、假 sandbox-exec
npm run check         # tsc，宿主声明走符号链接
npm run check:anchors # dsh 与 pi 锚点漂移检查
npm run inspect       # 打印工具 schema，无需模型调用
npm run e2e           # 真实 pi 走 RPC：验证 bash 与 ! 的围栏
npm run check:tools   # 工具执行内部的围栏与提权审批
npm run check:shape   # 替换定义仍携带 pi 原定义的内容
npm run e2e:model     # 2 次真实模型回合：逐次重试，然后 1 次程序级提权
```

`npm run check:anchors` 校验 `docs/` 里的 dsh 与 pi 锚点。存在 `deepseek-harness` 检出时，用 `PI_DSH_ROOT` 或 `--dsh` 定位。传 `--to <ref>` 会对新的 dsh ref 产出漂移报告。报告列出机器可判定的漂移（含变更的字面量）与需要人工判定的锚点。`--report <path>` 把报告写入文件。

`npm run e2e:model` 通过 RPC（远程过程调用）驱动真实模型，并在弹窗处扮演用户。第二个回合要求一个 `codemode` 脚本在工作区外写 2 个文件，因此覆盖程序级提权：1 次审批、2 次写入，以及随脚本结束的运行级模式。该命令需要 provider 凭据，并消耗 2 个回合。

`npm run check:shape` 把每个替换工具定义与 pi 自己的定义对比。键集合必须一致，只有声明的覆盖项可以不同。去掉提权字段后，`parameters` 必须与 pi 相同。该命令用 3 个合成漂移自检，检测不到时报错。`ci.yml` 用固定的 pi 版本运行该检查。

`npm test` 还会对同一检出运行行为比对测试。测试直接导入 dsh 的函数，比较 writable roots、路径包含、提权文案，以及 bubblewrap 与 Seatbelt profile。没有检出时跳过。

`.github/workflows/ci.yml` 在 `ubuntu-latest` 与 `macos-latest` 上运行 `npm test`、`tsc` 与锚点检查。

macOS job 用真实的 `sandbox-exec` 运行 `tests/enforcement.darwin.test.ts`。只有 macOS job 会用真实内核验证 Seatbelt profile、EPERM 拒绝，以及 `/tmp` 到 `/private/tmp` 的映射。

`npm run check` 把宿主声明符号链接进被 gitignore 的 `node_modules/`，再用机器上已有的 `tsc`。

## 许可证

MIT。从 DeepSeek Harness 移植的部分另见[第三方声明](THIRD-PARTY-NOTICES.md)。
