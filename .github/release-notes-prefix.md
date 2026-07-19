[简体中文](#简体中文) | [English](#english)

## 简体中文

### Esse 0.2.2-beta.1

- 大图预览现在由 Esse 的本机媒体服务直接读取原图，不再先生成并传输 2400px Base64 预览，首次打开更快，也保留原图查看、缩放和保存能力。
- 修复本机媒体端口变化后 Widget 可能继续使用旧 CSP 的问题；每个媒体服务实例都会使用与当前 localhost 端口绑定的新资源 URI。
- 本机原图直读是必需能力。服务启动或浏览器连接失败时会给出明确、可重试的异常提示，不会静默退回慢速大图链路。
- 原图响应不再持久缓存；图片被删除后返回 `410 Gone`，避免浏览器长期保留已删除图片。
- 移除仅用于 PoC 验证的媒体诊断工具，并保证预发布标签不会取代稳定版 `0.2.1` 的 GitHub Latest 状态。

这是预发布版本，重点用于 Windows 与 macOS 实机验证。多缩略图冷加载优化继续在 [#15](../../issues/15) 跟踪。

[查看 v0.2.1...v0.2.2-beta.1 完整变更](../../compare/v0.2.1...v0.2.2-beta.1)

## English

### Esse 0.2.2-beta.1

- The full-size lightbox now reads the original image directly from Esse's local media service instead of generating and transporting a 2400px Base64 preview. First open is faster while original-image viewing, zooming, and saving remain available.
- Fixed stale Widget CSP after a local media port change. Each media service instance now gets a resource URI bound to its current localhost origin.
- Direct local media is required. Service startup or browser connection failures now show actionable, retryable errors instead of silently returning to the slow full-preview path.
- Original-image responses are no longer stored persistently. Deleted images return `410 Gone` so the browser cannot keep serving them from a long-lived cache.
- Removed the PoC-only media diagnostics tool and ensured prerelease tags do not replace stable `0.2.1` as GitHub Latest.

This prerelease focuses on real Windows and macOS validation. Cold multi-thumbnail loading remains tracked in [#15](../../issues/15).

[View the full v0.2.1...v0.2.2-beta.1 changelog](../../compare/v0.2.1...v0.2.2-beta.1)

---

## 自动生成的变更记录 / Auto-generated changelog
