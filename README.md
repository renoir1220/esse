# Esse

Esse 是面向 Codex 和 ChatGPT Work 的本地图片工作台。它通过本机 `stdio MCP` 运行，不需要云端 Esse 服务、HTTPS 隧道、`.env` 或 `npm start`。

只有实际生图或改图请求会从用户电脑发往其选择的 Provider。Provider Key、任务记录、输入路径和输出图片都保留在本机。

## 让 Codex 安装

只需要把下面这句话发给 Codex：

> 安装这个插件：https://github.com/renoir1220/esse

Codex 应先阅读仓库中的 [`INSTALL.md`](INSTALL.md)，再完成平台识别、Release 下载、SHA256 校验、用户目录安装、插件注册和安装验证。用户不需要手动选择安装包或解压目录。

安装成功后，Codex 会提示重启桌面端。重启后开启一个新任务，说“打开 Esse 设置”，在 Esse 界面中配置 Provider、API Key 和默认模型。不要把 API Key 发到聊天里。

支持的平台：

- Windows x64
- macOS Apple Silicon
- macOS Intel

当前 `v0.1.2` 是未签名 Public Beta；Windows SmartScreen 或 macOS Gatekeeper 可能显示系统安全提醒。

## 手动安装

如果不通过 Codex，可以从 [GitHub Releases](https://github.com/renoir1220/esse/releases/latest) 下载对应平台的 ZIP，解压后运行：

Windows：

```powershell
.\install.ps1
```

macOS：

```bash
bash ./install.sh
```

安装器是幂等的。再次运行会安装或切换到该版本；直接运行仓库里的安装器会下载并校验最新正式 Release。

## 本地数据

- Windows：`%LOCALAPPDATA%\esse`
- macOS：`~/Library/Application Support/esse`

Windows Key 使用当前用户 DPAPI 加密；macOS Key 写入系统 Keychain。生成结果默认写入源文件夹下的 `esse Output/<batch-id>/`，不会覆盖原图。

插件运行时安装在：

- Windows：`%LOCALAPPDATA%\esse\plugin`
- macOS：`~/Library/Application Support/esse/plugin`

## 开发

插件源码位于 [`plugins/esse`](plugins/esse)。

```bash
cd plugins/esse
npm install
npm run check
```

生成三个自带运行时的安装包和 Release 元数据：

```bash
npm run package:releases
```

开发阶段的 `npm run preview` 只用于浏览器视觉验收，不是插件运行架构。
