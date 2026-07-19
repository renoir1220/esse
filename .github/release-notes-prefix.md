[简体中文](#简体中文) | [English](#english)

## 简体中文

### Esse 0.2.2-beta.4

- 原图预览改用标准 MCP Apps `resources/read` 二进制资源，完全移除本地 HTTP 服务，规避 macOS Chromium 对嵌入式页面访问回环地址的限制。
- 原始文件字节和 MIME 类型会原样传输并显示，不缩放、不转码，也不增加 2400px Base64 或 MCP 高清回退。
- macOS 与 Windows 统一使用同一条资源通道，并保留旧 Widget URI 兼容；资源令牌短期有效，读取时会校验文件大小、修改时间和 60 MB 上限。

该方案已通过 macOS Codex 桌面端真实用户链路验证。多缩略图冷加载优化继续在 [#15](../../issues/15) 跟踪。

[查看 v0.2.2-beta.3...v0.2.2-beta.4 完整变更](../../compare/v0.2.2-beta.3...v0.2.2-beta.4)

## English

### Esse 0.2.2-beta.4

- Original-image viewing now uses standard MCP Apps `resources/read` binary resources and removes the local HTTP server entirely, avoiding macOS Chromium restrictions on loopback access from embedded pages.
- Original file bytes and MIME types are transferred and displayed unchanged, with no resizing, re-encoding, 2400px Base64 fallback, or MCP high-resolution fallback.
- macOS and Windows now share the same resource path while stale Widget URIs remain compatible. Resource tokens are short-lived, and reads validate file size, modification time, and a 60 MB limit.

This path was validated end to end in the Codex desktop app on macOS. Cold multi-thumbnail loading remains tracked in [#15](../../issues/15).

[View the full v0.2.2-beta.3...v0.2.2-beta.4 changelog](../../compare/v0.2.2-beta.3...v0.2.2-beta.4)

---

## 自动生成的变更记录 / Auto-generated changelog
