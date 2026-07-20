# Esse

**语言：简体中文 | [English](README.en.md)**

Esse 是面向 Codex 和 ChatGPT Work 的本地图片工作台。它以本机 `stdio MCP` 作为插件入口，并由用户级单实例 Esse Core 持有批次与 Provider 调度；多个任务不会各自写同一份状态，单个 stdio 连接中断也不会终止已提交的 Provider 请求。它不需要云端 Esse 服务、HTTPS 隧道、`.env` 或 `npm start`。

只有实际生图或改图请求会把所选参考图发往当前 Agent 的图像模型或用户选择的 Provider。Provider Key、任务记录、输入路径和输出图片都保留在本机。

## 让 Codex 安装

只需要把下面这句话发给 Codex：

> 安装这个插件：https://github.com/renoir1220/esse

Codex 应先阅读仓库中的 [`INSTALL.md`](INSTALL.md)，再完成平台识别、Release 下载、SHA256 校验、用户目录安装、插件注册和安装验证。用户不需要手动选择安装包或解压目录。

安装成功后，Codex 会提示重启桌面端。重启后开启一个新任务，说“打开 Esse 设置”，可以直接选择“Codex 生成”，也可以配置 Provider、API Key 和默认模型。不要把 API Key 发到聊天里。

支持的平台：

- Windows x64
- macOS Apple Silicon
- macOS Intel

macOS Release 不再包含 Esse 自行编译的 Mach-O 可执行文件，而是通过一个可审阅的 Bash 启动器使用 Codex/ChatGPT 管理的已签名 Node.js 运行时。用户无需自行安装 Node，也无需申请 Apple 开发者认证。安装器只调用通过 Gatekeeper 检查的桌面 App 内置 Codex，不会执行 `PATH` 中来源不明的同名命令，也不会要求绕过系统安全设置。

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

Release 工作流在各原生 Runner 上生成 Windows 自带运行时包和两个 macOS 安全启动包，再汇总 Release 元数据：

```bash
npm run package:releases
```

开发阶段的 `npm run preview` 只用于浏览器视觉验收，不是插件运行架构。
