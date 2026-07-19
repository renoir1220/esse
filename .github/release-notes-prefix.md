[简体中文](#简体中文) | [English](#english)

## 简体中文

### Esse 0.2.2-beta.2

- 修复 macOS 打开 Esse 时可能出现的 `Resource ui://esse/local-v2-....html not found`。macOS 宿主可能用上一 MCP 进程返回的 Widget URI 向新进程读取资源；新进程现在会兼容这些旧 URI，并使用当前进程的 localhost 媒体端口返回 Widget 与 CSP。
- 保留 beta.1 的原图直读设计：大图仍直接读取原文件，直读失败会明确报错，不回退到 2400px Base64 预览。

这是用于 Windows 与 macOS 实机验证的预发布版本。多缩略图冷加载优化继续在 [#15](../../issues/15) 跟踪。

[查看 v0.2.2-beta.1...v0.2.2-beta.2 完整变更](../../compare/v0.2.2-beta.1...v0.2.2-beta.2)

## English

### Esse 0.2.2-beta.2

- Fixed `Resource ui://esse/local-v2-....html not found` when opening Esse on macOS. The macOS host may read a Widget URI returned by a previous MCP process from a new process. New processes now accept those prior URIs and return the Widget with the current process's localhost media origin in its CSP.
- Preserved the beta.1 direct-original design: the lightbox still reads the original file directly, and direct-media failures remain explicit instead of falling back to a 2400px Base64 preview.

This is a prerelease for real Windows and macOS validation. Cold multi-thumbnail loading remains tracked in [#15](../../issues/15).

[View the full v0.2.2-beta.1...v0.2.2-beta.2 changelog](../../compare/v0.2.2-beta.1...v0.2.2-beta.2)

---

## 自动生成的变更记录 / Auto-generated changelog
