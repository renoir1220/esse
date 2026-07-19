[简体中文](#简体中文) | [English](#english)

## 简体中文

### Esse 0.2.2-beta.3

- 修复 macOS 原图直读失败：Node 在 macOS 上可能把 `localhost` 仅绑定到 IPv6 `::1`，而嵌入式图片加载器通过 IPv4 访问。Esse 现在明确监听并返回 `127.0.0.1` 地址，Widget CSP 也与该地址保持一致。
- 保持单一原图直读路径，不增加 2400px Base64 或 MCP 高清回退。连接问题仍会明确报错。
- 保留 beta.2 对旧 Widget URI 的兼容，避免 MCP 进程切换后出现资源读取失败。

beta.3 取代 beta.1 和 beta.2，恢复 macOS 预发布测试。多缩略图冷加载优化继续在 [#15](../../issues/15) 跟踪。

[查看 v0.2.2-beta.2...v0.2.2-beta.3 完整变更](../../compare/v0.2.2-beta.2...v0.2.2-beta.3)

## English

### Esse 0.2.2-beta.3

- Fixed direct original-image access on macOS. Node could bind `localhost` only to IPv6 `::1` while the embedded image loader connected over IPv4. Esse now explicitly listens on and returns `127.0.0.1`, with matching Widget CSP metadata.
- Kept one direct-original path. This release does not add a 2400px Base64 or MCP high-resolution fallback, and connection failures remain explicit.
- Retained beta.2 compatibility for stale Widget resource URIs across MCP process changes.

beta.3 supersedes beta.1 and beta.2 and resumes macOS prerelease testing. Cold multi-thumbnail loading remains tracked in [#15](../../issues/15).

[View the full v0.2.2-beta.2...v0.2.2-beta.3 changelog](../../compare/v0.2.2-beta.2...v0.2.2-beta.3)

---

## 自动生成的变更记录 / Auto-generated changelog
