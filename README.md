# Esse

**语言：简体中文 | [English](README.en.md)**

Esse 是由 Agent 指挥的本地图片工作台。用户只需要说“用 Esse 生成图片”；无论安装的是 Codex Plugin 还是面向 WorkBuddy 等 Agent 的本地客户端，产品名称始终是 Esse。

Esse 在本机保存 Provider 配置、API Key、批次记录和原始图片。只有实际生图或改图请求会把选中的参考图发给用户配置的 Provider或当前 Agent 的图片能力。仓库和发行包不内置 API Key，也不依赖 Esse 云端后端。

## 两种发行形态

- **Codex Plugin**：适用于 Codex/ChatGPT 桌面端，支持 Windows x64、macOS arm64 和 macOS x64。
- **Agent Sidecar**：适用于 WorkBuddy 等支持本地 HTTP MCP 的 Agent；当前发布 Windows x64 安装包，带完整 Esse 工作台和后台任务执行能力。

这是同一个产品的两种技术分发方式，不是两个用户品牌。通常只安装适合当前 Agent 的一种。

## 安装 Codex Plugin

把下面这句话发给 Codex：

> 安装这个插件：https://github.com/renoir1220/esse

Codex 应先阅读 [`INSTALL.md`](INSTALL.md)，再识别平台、下载 Release、校验 SHA256、完成用户目录安装和插件注册。重启桌面端并开启新任务后，说“打开 Esse 设置”，在 Esse 里配置 Provider、API Key 和默认模型。不要把 API Key 发到聊天里。

也可以从 [GitHub Releases](https://github.com/renoir1220/esse/releases) 下载对应平台的 Plugin ZIP，解压后运行 `install.ps1` 或 `install.sh`。

## 安装到 WorkBuddy 等 Agent

从 [GitHub Releases](https://github.com/renoir1220/esse/releases) 下载 `esse-agent-sidecar-windows-x64-*.exe`，核对 `sidecar-latest.json` 或 `checksums.txt` 后安装并打开 Esse。在 Esse 的设置页：

1. 选择内置的兔子 Provider 预设或添加 OpenAI 兼容 Provider。
2. 在 Esse 内填写 API Key、测试连接并保存默认模型。
3. 复制 MCP 配置并粘贴到 Agent 的用户级 HTTP MCP 配置中。

之后直接对 Agent 说“用 Esse 生成图片”。Agent 把任务交给 Esse 后应立即返回；除非用户明确要求查看或导出结果，否则不应把产物复制回聊天工作区，也不应反复播报价格和进度。

## 本地数据

- Codex Plugin：Windows `%LOCALAPPDATA%\esse`；macOS `~/Library/Application Support/esse`
- Agent Sidecar：Windows `%LOCALAPPDATA%\esse-agent-sidecar`

两个目录刻意隔离。迁移仓库不会移动、覆盖或删除旧 `esse-desktop` 数据。Windows API Key 由当前用户 DPAPI 保护；macOS Plugin 使用系统 Keychain。

## 代码签名

Windows Agent Sidecar 的签名发行产物遵循仓库公开的 [Code signing policy](CODE_SIGNING.md)。发布工作流会同时验证应用程序和安装程序的 Authenticode 签名；`v0.3.0-alpha.2` 是等待 SignPath Foundation 审批期间唯一明确允许的未签名预发布版本，并在 Release 中保留醒目警告。

## 仓库结构

```text
plugins/codex/       Codex Plugin
sidecars/agent/      面向本地 Agent 的 Sidecar
apps/standalone/     未来独立应用占位
docs/                路线图、协议和开发文档
```

暂时不抽取共享 Core。两个运行形态必须独立构建，不得相互产生运行时依赖；有意义的行为移植记录在 [`SYNC.md`](SYNC.md)。

## 开发

Codex Plugin：

```bash
cd plugins/codex
npm install
npm run check
```

Agent Sidecar（当前仅在 Windows x64 发布）：

```bash
cd sidecars/agent
npm install
npm run typecheck
npm test
npm run make
```

MIT License，见 [`LICENSE`](LICENSE)。
