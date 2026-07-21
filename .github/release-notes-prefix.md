## 简体中文

### Esse 0.3.1

#### Agent Sidecar（Windows x64、macOS arm64/x64）

- 新增原生 macOS Agent Sidecar，使用与 Windows 完全相同的 Provider、批次、图片库、后台任务和本地 HTTP MCP 核心；macOS 仅适配应用数据路径、Keychain、原生窗口生命周期及打包签名。
- 提供 Apple Silicon 与 Intel 两种 DMG。正式发布包必须通过 Developer ID 签名、Apple 公证、Gatekeeper、架构和打包后启动检查，不要求用户绕过系统安全设置。
- Windows 安装器、主程序、标题栏以及 macOS 应用与 DMG 统一使用 Esse 图标，不再出现 Electron 默认图标。
- Windows Sidecar 安装目录、Sidecar 数据目录和 Codex Plugin 数据目录现在完全分离，避免安装或升级 Sidecar 时覆盖插件历史图片与设置。
- `sidecar-latest.json` 和 `checksums.txt` 同时提供 Windows x64、macOS arm64 与 macOS x64 产物的独立 SHA256。

[查看 v0.3.0...v0.3.1 完整变更](../../compare/v0.3.0...v0.3.1)

## English

### Esse 0.3.1

#### Agent Sidecar (Windows x64, macOS arm64/x64)

- Adds a native macOS Agent Sidecar backed by the exact same Provider, batch, image-library, background-task, and local HTTP MCP core as Windows. Only application-data paths, Keychain, native window lifecycle, packaging, and signing are platform adapters.
- Ships separate Apple Silicon and Intel DMGs. Published builds must pass Developer ID signing, Apple notarization, Gatekeeper, architecture, and packaged-startup checks without asking users to bypass system security.
- Uses the Esse icon consistently for the Windows installer, executable, and title bar, plus the macOS application and DMG, replacing Electron defaults.
- Fully separates the Windows Sidecar installation root, Sidecar data root, and Codex Plugin data root so Sidecar installation or upgrades cannot overwrite Plugin history or settings.
- Extends `sidecar-latest.json` and `checksums.txt` with independent SHA256 entries for Windows x64, macOS arm64, and macOS x64 artifacts.

[View the full v0.3.0...v0.3.1 changelog](../../compare/v0.3.0...v0.3.1)
