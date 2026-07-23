## 简体中文

### Esse Community 0.3.2

- Agent 批次现在按任务隔离 Prompt、参考图和请求大小。多个任务仍可并发执行，但不会再把不同任务的参考图合并进同一次图片服务请求，从而避免单任务未超限却因批次总量触发 `request body too large`。
- 批次标题旁新增复制按钮，图片右键菜单新增复制图片 ID，可直接把准确的批次名称、批次 ID 和图片 ID 交给 Codex 或其他 Agent。
- Windows 工作台不再因原生标题栏预留高度而出现空白纵向滚动条；窗口标题同时显示产品版本，例如 `Esse Community 0.3.2`。
- 开源版在安装程序、窗口、插件、MCP 与文档中统一显示为 `Esse Community`，并保留 `esse` 技术标识和“用 Esse 生成图片”等简短日常指令的兼容性。
- 当前 Windows 与 macOS 发行包未做发布者签名或 Apple 公证；CI 会验证其确为未签名产物并继续提供 SHA256 校验。Windows 可能提示未知发布者，macOS Gatekeeper 可能拒绝打开；不得关闭系统安全机制。
- 批次和任务更新在返回成功前会等待持久化清理完成，降低退出或紧接下一步操作时看到旧状态的概率。
- Windows 与 macOS 的 Provider 请求改用独立的 Chromium 网络会话；发生网络故障后不会冒险自动重试，而会刷新连接池、DNS 和系统代理状态，让下一次用户明确提交无需重启应用，并显示不含敏感信息的诊断码。
- 修复 `fast-uri` 的高危 URI authority 混淆漏洞，并更新 Sidecar 构建与测试工具链，消除多项已知的开发依赖安全问题。

#### Agent Sidecar（Windows x64、macOS arm64/x64）

- 新增原生 macOS Agent Sidecar，复用与 Windows 相同的 Provider、批次、图片库、后台任务和本地 HTTP MCP 核心；macOS 仅适配应用数据路径、Keychain、原生窗口生命周期及打包签名。
- 提供 Apple Silicon 与 Intel 两种 DMG；始终检查架构和打包后启动，配置完整签名凭据时再验证 Developer ID、Apple 公证和 Gatekeeper，不要求用户绕过系统安全设置。
- Windows 安装器、主程序、标题栏以及 macOS 应用与 DMG 统一使用 Esse 图标；Windows Sidecar 安装目录、Sidecar 数据目录和 Codex Plugin 数据目录也已完全分离。
- `sidecar-latest.json` 和 `checksums.txt` 同时提供 Windows x64、macOS arm64 与 macOS x64 产物的独立 SHA256。

[查看 v0.3.0...v0.3.2 完整变更](../../compare/v0.3.0...v0.3.2)

## English

### Esse Community 0.3.2

- Agent batches now isolate each job's prompt, references, and request-size budget. Independent jobs can still run concurrently, but references from different jobs are never combined into one image-service request, preventing `request body too large` when every individual job is below the limit.
- Adds a copy button beside the batch title and a Copy Image ID action to the image context menu, making it easy to give Codex or another Agent the exact batch name, batch ID, and image ID.
- Removes the empty vertical scrollbar caused by native-titlebar space on Windows, and includes the product version in the window title, for example `Esse Community 0.3.2`.
- Consistently presents the open-source edition as `Esse Community` across installers, windows, plugins, MCP, and documentation while preserving the stable `esse` technical identifiers and short everyday commands such as “use Esse to generate images.”
- Current Windows and macOS artifacts are not publisher-signed or Apple-notarized. CI verifies that they are unsigned and continues to publish SHA256 checksums. Windows may show an unknown-publisher warning, and macOS Gatekeeper may reject the app; platform security must not be disabled.
- Waits for persistence cleanup before reporting batch and job updates as successful, reducing stale state after exit or an immediately following action.
- Routes Windows and macOS Provider traffic through an isolated Chromium network session. After a transport failure it does not risk an automatic retry, but refreshes pooled connections, DNS, and system proxy state so the next explicit submission does not require an app restart, while exposing only a safe diagnostic code.
- Fixes the high-severity `fast-uri` URI authority confusion vulnerability and updates the Sidecar build and test toolchain to remove multiple known development-dependency security issues.

#### Agent Sidecar (Windows x64, macOS arm64/x64)

- Adds a native macOS Agent Sidecar backed by the same Provider, batch, image-library, background-task, and local HTTP MCP core as Windows. Only application-data paths, Keychain, native window lifecycle, packaging, and signing are platform adapters.
- Ships separate Apple Silicon and Intel DMGs. Architecture and packaged-startup checks always run; Developer ID, Apple notarization, and Gatekeeper verification run when a complete signing credential set is configured, without asking users to bypass system security.
- Uses the Esse icon consistently for the Windows installer, executable, and title bar, plus the macOS application and DMG. The Windows Sidecar installation root, Sidecar data root, and Codex Plugin data root are also fully separated.
- Extends `sidecar-latest.json` and `checksums.txt` with independent SHA256 entries for Windows x64, macOS arm64, and macOS x64 artifacts.

[View the full v0.3.0...v0.3.2 changelog](../../compare/v0.3.0...v0.3.2)
