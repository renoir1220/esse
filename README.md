# esse

这是面向 ChatGPT 桌面端 Work/Codex 的完全本地插件包。插件通过本地 `stdio MCP` 运行，不需要云端服务、HTTPS 隧道、`.env` 或 `npm start`。

只有生图请求会从用户电脑发往其选择的 Provider；Provider Key、任务记录、输入路径和输出图片都保留在本机。

## 普通用户安装

下载并解压与你系统匹配的安装包：

- `esse-windows-x64-v0.1.0.zip`
- `esse-macos-arm64-v0.1.0.zip`
- `esse-macos-x64-v0.1.0.zip`

Windows：右键用 PowerShell 运行 `install.ps1`，或执行：

```powershell
.\install.ps1
```

macOS：

```bash
bash ./install.sh
```

安装脚本只注册当前解压目录中的本地 marketplace，并安装 `esse` 插件。随后重启 ChatGPT 桌面端并开启一个新对话。

第一次使用时说“打开 esse”，在 Provider 页粘贴 API Key、测试连接并保存。以后直接说 `esse` 即可。

## 本地数据

- Windows：`%LOCALAPPDATA%\esse`
- macOS：`~/Library/Application Support/esse`

Windows Key 使用当前用户 DPAPI 加密；macOS Key 写入系统 Keychain。生成结果默认写入源文件夹下的 `esse Output/<batch-id>/`，不会覆盖原图。

## 开发

插件源码位于 [`plugins/esse`](plugins/esse)。

```bash
cd plugins/esse
npm install
npm run check
```

生成三个自带运行时的安装包：

```bash
npm run package:releases
```

开发阶段的 `npm run preview` 只用于浏览器视觉验收，不是插件运行架构。
