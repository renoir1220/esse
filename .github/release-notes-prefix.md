## 简体中文

### Esse 0.3.2

- Agent 批次现在按任务隔离 Prompt、参考图和请求大小。多个任务仍可并发执行，但不会再把不同任务的参考图合并进同一次图片服务请求，从而避免单任务未超限却因批次总量触发 `request body too large`。
- 修复 `fast-uri` 的高危 URI authority 混淆漏洞，并更新 Sidecar 构建与测试工具链，消除多项已知的开发依赖安全问题。

#### Agent Sidecar（Windows x64、macOS arm64/x64）

- 新增原生 macOS Agent Sidecar，复用与 Windows 相同的 Provider、批次、图片库、后台任务和本地 HTTP MCP 核心；macOS 仅适配应用数据路径、Keychain、原生窗口生命周期及打包签名。
- 提供 Apple Silicon 与 Intel 两种 DMG。正式发布包必须通过 Developer ID 签名、Apple 公证、Gatekeeper、架构和打包后启动检查，不要求用户绕过系统安全设置。
- Windows 安装器、主程序、标题栏以及 macOS 应用与 DMG 统一使用 Esse 图标；Windows Sidecar 安装目录、Sidecar 数据目录和 Codex Plugin 数据目录也已完全分离。
- `sidecar-latest.json` 和 `checksums.txt` 同时提供 Windows x64、macOS arm64 与 macOS x64 产物的独立 SHA256。

[查看 v0.3.0...v0.3.2 完整变更](../../compare/v0.3.0...v0.3.2)

## English

### Esse 0.3.2

- Agent batches now isolate each job's prompt, references, and request-size budget. Independent jobs can still run concurrently, but references from different jobs are never combined into one image-service request, preventing `request body too large` when every individual job is below the limit.
- Fixes the high-severity `fast-uri` URI authority confusion vulnerability and updates the Sidecar build and test toolchain to remove multiple known development-dependency security issues.

#### Agent Sidecar (Windows x64, macOS arm64/x64)

- Adds a native macOS Agent Sidecar backed by the same Provider, batch, image-library, background-task, and local HTTP MCP core as Windows. Only application-data paths, Keychain, native window lifecycle, packaging, and signing are platform adapters.
- Ships separate Apple Silicon and Intel DMGs. Published builds must pass Developer ID signing, Apple notarization, Gatekeeper, architecture, and packaged-startup checks without asking users to bypass system security.
- Uses the Esse icon consistently for the Windows installer, executable, and title bar, plus the macOS application and DMG. The Windows Sidecar installation root, Sidecar data root, and Codex Plugin data root are also fully separated.
- Extends `sidecar-latest.json` and `checksums.txt` with independent SHA256 entries for Windows x64, macOS arm64, and macOS x64 artifacts.

[View the full v0.3.0...v0.3.2 changelog](../../compare/v0.3.0...v0.3.2)
