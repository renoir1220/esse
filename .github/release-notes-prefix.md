## 简体中文

### Esse 0.3.0-alpha.1

#### Agent Sidecar（Windows x64 预览）

- 新增面向 WorkBuddy 等本地 Agent 的 Esse Windows 安装包，提供与 Codex Plugin 对齐的批次、图库、历史版本、选择、修改、大图查看和设置工作台。
- 改为完全本地的 Provider 配置：内置兔子 Provider 与常用图片模型预设，但不包含 API Key，也不依赖 Esse 云端后端、账户、余额或渠道管理。
- Agent 提交 Provider 任务后立即返回，Esse 在后台持久执行；普通任务不再反复播报金额、轮询进度或把生成结果主动复制回 Agent 工作区。
- 修复参考图交接契约：粘贴或附加的图片必须以真实本地文件传入；任务详情保留参考图来源，无法传输时不会退化为误导性的纯文字修改。
- 修复批次下拉、更多菜单和大图遮罩的鼠标关闭行为；单张图片保持与多图一致的缩略图尺度。

当前 Agent Sidecar 是未签名的 Windows x64 alpha 预览；macOS 包尚未发布，也不宣称完成 macOS 人工验证。

#### Codex Plugin

- 源码迁移到 `plugins/codex`，发布包继续保留原文件名与内部安装布局，兼容已有安装器和升级路径。
- Plugin 与 Agent Sidecar 现在从同一公开仓库、同一版本标签发布，同时仍可独立构建和运行，不相互依赖。

[查看 v0.2.4-alpha.1...v0.3.0-alpha.1 完整变更](../../compare/v0.2.4-alpha.1...v0.3.0-alpha.1)

## English

### Esse 0.3.0-alpha.1

#### Agent Sidecar (Windows x64 preview)

- Adds an Esse Windows installer for WorkBuddy and other local Agents, with batch, library, history, selection, editing, lightbox, and settings workflows aligned with the Codex Plugin.
- Replaces the hosted commercial path with fully local Provider settings. Tuzi Provider and common image-model presets are included, but no API key, Esse backend, account, balance, or channel administration is bundled.
- Returns control as soon as Provider work is durably accepted while Esse continues in the background. Routine tasks no longer narrate prices, poll progress, or copy generated output back into the Agent workspace.
- Fixes reference-image handoff: pasted and attached images must be transferred as real local files, their source is recorded in task details, and failed attachment transfer never degrades into a misleading text-only edit.
- Fixes outside-click dismissal for the batch picker and menus, closes the lightbox through its mask, and keeps a single-image thumbnail consistent with multi-image grids.

The Agent Sidecar is an unsigned Windows x64 alpha preview. No macOS package is included, and this release does not claim macOS manual validation.

#### Codex Plugin

- Moves source to `plugins/codex` while preserving historical archive names and the internal installation layout for existing installers and upgrades.
- Publishes the Plugin and Agent Sidecar from one public repository and one version tag while keeping both distributions independently buildable and runnable.

[View the full v0.2.4-alpha.1...v0.3.0-alpha.1 changelog](../../compare/v0.2.4-alpha.1...v0.3.0-alpha.1)
