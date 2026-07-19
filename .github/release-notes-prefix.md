[简体中文](#简体中文) | [English](#english)

## 简体中文

> [!WARNING]
> **macOS 暂停更新（影响 `v0.2.2-beta.1` 和 `v0.2.2-beta.2`）**
>
> macOS 浏览大图时可能提示“原图直读连接失败。请确认 Codex/ChatGPT 可以访问 localhost，然后完全重启桌面应用。”，导致原图无法打开。在该问题修复并通过 macOS 实机验证前，macOS 用户请不要安装或更新到这两个 Beta；请继续使用稳定版 `v0.2.1`。Windows 用户可以继续参与 Beta 验证。

### Esse 0.2.2-beta.2

- 修复 macOS 打开 Esse 时可能出现的 `Resource ui://esse/local-v2-....html not found`。macOS 宿主可能用上一 MCP 进程或旧稳定版返回的 Widget URI 向新进程读取资源；新进程现在会兼容这些旧 URI，并使用当前进程的 localhost 媒体端口返回 Widget 与 CSP。
- 保留 beta.1 的原图直读设计：大图仍直接读取原文件，直读失败会明确报错，不回退到 2400px Base64 预览。

这是用于 Windows 实机验证的预发布版本。macOS 更新已因上述已知问题暂停。多缩略图冷加载优化继续在 [#15](../../issues/15) 跟踪。

[查看 v0.2.2-beta.1...v0.2.2-beta.2 完整变更](../../compare/v0.2.2-beta.1...v0.2.2-beta.2)

## English

> [!WARNING]
> **macOS updates are paused for `v0.2.2-beta.1` and `v0.2.2-beta.2`.**
>
> Opening a full-size image on macOS may report a direct-original localhost connection failure and leave the original image unavailable. Until this is fixed and verified on real macOS hardware, macOS users should not install or update to either Beta and should remain on stable `v0.2.1`. Windows users may continue Beta validation.

### Esse 0.2.2-beta.2

- Fixed `Resource ui://esse/local-v2-....html not found` when opening Esse on macOS. The macOS host may read a Widget URI returned by a previous MCP process or older stable release from a new process. New processes now accept those prior URIs and return the Widget with the current process's localhost media origin in its CSP.
- Preserved the beta.1 direct-original design: the lightbox still reads the original file directly, and direct-media failures remain explicit instead of falling back to a 2400px Base64 preview.

This prerelease is for real Windows validation. macOS updates are paused because of the known issue above. Cold multi-thumbnail loading remains tracked in [#15](../../issues/15).

[View the full v0.2.2-beta.1...v0.2.2-beta.2 changelog](../../compare/v0.2.2-beta.1...v0.2.2-beta.2)

---

## 自动生成的变更记录 / Auto-generated changelog
