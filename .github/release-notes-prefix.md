## 简体中文

### Esse 0.3.0

#### Agent Sidecar（Windows x64）

- 正式加入面向 WorkBuddy 与其他本地 HTTP MCP Agent 的 Esse 工作台，通过仅监听 `127.0.0.1` 的配对令牌接口接收图片生成和修改任务。
- Agent 将 Provider 任务持久交给 Esse 后立即结束当前任务，不再主动轮询、播报状态或把结果复制回 Agent 工作区；用户之后明确询问时仍可查询。
- “打开输出文件夹”现在直接进入当前批次目录，其中集中显示该批次的当前图片和保留版本，不再需要逐个进入 Provider 请求目录查找。
- Windows 窗口使用白色一体化标题栏和 Esse 程序图标，首页使用相同品牌图标，并取消窗口最小宽度限制。
- `v0.3.0` 是 SignPath Foundation 审批期间由维护者明确允许的未签名正式版；后续版本仍默认强制验证主程序与安装程序的 Authenticode 签名及可信时间戳。

⚠️ **Windows Agent Sidecar 安装程序尚未签名。Windows 可能显示“未知发布者”或 SmartScreen 警告。不要关闭 Windows 安全功能；请只从本 Release 下载并核对 `sidecar-latest.json` 或 `checksums.txt`。**

#### 统一发布

- Codex Plugin 与 Agent Sidecar 现在使用同一版本号、Git 标签和 GitHub Release，安装元数据分别校验各平台插件包与 Windows Sidecar 安装程序。
- Agent Sidecar 当前仅发布 Windows x64 安装包，不宣称完成 macOS Sidecar 验证。

[查看 v0.2.3...v0.3.0 完整变更](../../compare/v0.2.3...v0.3.0)

## English

### Esse 0.3.0

#### Agent Sidecar (Windows x64)

- Introduces the Esse workspace for WorkBuddy and other local HTTP MCP Agents, accepting image generation and modification tasks through a pairing-token endpoint bound only to `127.0.0.1`.
- Ends the current Agent task immediately after Provider work is durably handed to Esse, without unsolicited polling, status narration, or result copying. A later explicit user request can still query status.
- Opens a batch-scoped output folder containing the batch's current images and preserved versions instead of forcing users to inspect separate Provider request directories.
- Uses the integrated light Windows title bar and Esse application icon, applies the same brand icon to Home, and removes the window minimum-width restriction.
- `v0.3.0` is an explicitly unsigned stable release authorized by the maintainer while SignPath Foundation approval is pending. Later releases remain behind mandatory Authenticode signature and trusted-timestamp verification.

⚠️ **The Windows Agent Sidecar installer is not yet signed. Windows may show an “Unknown publisher” or SmartScreen warning. Do not disable Windows security features; download only from this Release and verify `sidecar-latest.json` or `checksums.txt`.**

#### Unified release

- The Codex Plugin and Agent Sidecar now share one version, Git tag, and GitHub Release, with installation metadata verifying every platform Plugin archive and the Windows Sidecar installer independently.
- The Agent Sidecar currently ships for Windows x64 only and does not claim macOS Sidecar validation.

[View the full v0.2.3...v0.3.0 changelog](../../compare/v0.2.3...v0.3.0)
