## 简体中文

### Esse 0.3.0-alpha.2

#### Agent Sidecar（Windows x64 预览）

- Windows 窗口改为与工作台一致的白色一体化标题栏，移除黑色的 Electron 默认菜单框，同时保留原生最小化、最大化和关闭按钮。
- Esse 品牌图标现在用于程序窗口、`esse.exe` 和 Windows 安装程序，不再显示 Electron 默认图标。
- Agent 把 Provider 任务持久交给 Esse 后会立即结束当前任务，不再主动轮询、播报状态或把结果复制回 Agent 工作区；用户之后明确询问时仍可查询。
- 明确 Esse 是调用用户已配置 Provider 与模型的本地图片任务工作台，不会因推测某类模型可能不擅长文字、数字或图表而中断信息充分的请求。
- 增加公开代码签名政策以及应用程序和安装程序的签名验证门禁，为 SignPath Foundation 审批后的可信发布做好准备。

⚠️ **本版本仍是未签名的测试版。Windows 可能显示“未知发布者”或 SmartScreen 警告。不要关闭 Windows 安全功能；请只从本 Release 下载并核对 `sidecar-latest.json` 或 `checksums.txt`。**

Agent Sidecar 当前仅发布 Windows x64 安装包，不宣称完成 macOS Sidecar 验证。

[查看 v0.3.0-alpha.1...v0.3.0-alpha.2 完整变更](../../compare/v0.3.0-alpha.1...v0.3.0-alpha.2)

## English

### Esse 0.3.0-alpha.2

#### Agent Sidecar (Windows x64 preview)

- Replaces the black default Electron menu frame with a light integrated title bar aligned with the workspace while retaining native minimize, maximize, and close controls.
- Applies the Esse brand icon to the window, `esse.exe`, and Windows installer instead of the default Electron icon.
- Ends the current Agent task immediately after Provider work is durably handed to Esse, without unsolicited polling, status narration, or result copying. A later explicit user request can still query status.
- Clarifies that Esse is a local image-task workspace that invokes the user's configured Provider and model, so a sufficiently specified request is not interrupted by guesses about whether a model may struggle with text, numbers, or charts.
- Adds a public code-signing policy and signature gates for the application and installer in preparation for trusted releases after SignPath Foundation approval.

⚠️ **This build is still an unsigned test release. Windows may show an “Unknown publisher” or SmartScreen warning. Do not disable Windows security features; download only from this Release and verify `sidecar-latest.json` or `checksums.txt`.**

The Agent Sidecar remains Windows x64 only and does not claim macOS Sidecar validation.

[View the full v0.3.0-alpha.1...v0.3.0-alpha.2 changelog](../../compare/v0.3.0-alpha.1...v0.3.0-alpha.2)
