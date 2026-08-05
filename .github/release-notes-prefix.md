## 简体中文

### Esse Community 0.3.3-alpha.2

- 图片网格、参考图和批次浏览现在使用最长边 512 像素的可丢弃缓存预览，不再把 2K/4K 原图直接当作缩略图解码。原图保持不变，仅在查看大图、下载、复制、导出或提交参考图时读取。
- 缩略图只在接近可视区域时加载，离开较远区域后会主动卸载；离屏卡片也会跳过绘制。包含 120 个高分辨率历史批次的压力测试会验证加载数量始终有界，并拒绝任何批量原图请求。
- 预览生成按顺序执行并自动合并重复请求，磁盘缓存限制为约 256 MB；缓存缺失或原图变化时会自动重建，预览损坏或读取失败也不会影响原图使用。
- 更新网络边界相关依赖，修复上游已披露的 SSRF 分类绕过、HTTP 客户端解析与缓存问题，以及本地服务 CORS 正则拒绝服务问题。
- 本 Alpha 的 Windows 产物仍未进行发布者签名；macOS 应用使用经过结构校验的 ad-hoc 签名，但未进行 Developer ID 签名或 Apple 公证。

[查看 v0.3.3-alpha.1...v0.3.3-alpha.2 完整变更](../../compare/v0.3.3-alpha.1...v0.3.3-alpha.2)

## English

### Esse Community 0.3.3-alpha.2

- Gallery grids, reference lists, and the batch browser now use disposable previews capped at a 512-pixel long edge instead of decoding 2K/4K originals as thumbnails. Originals remain unchanged and are read only for full-image viewing, download, copy, export, or Provider reference submission.
- Thumbnails load only near the viewport and unload again when far away, while offscreen cards skip paint work. A 120-batch high-resolution stress test keeps the loaded set bounded and rejects any bulk original-image requests.
- Preview generation is serialized and deduplicated, with an approximately 256 MB disk-cache limit. Missing or stale previews rebuild automatically, while a corrupt or unreadable preview never makes the original unavailable.
- Updates network-boundary dependencies to address disclosed upstream SSRF-classification bypasses, HTTP client parsing and cache issues, and a CORS regular-expression denial of service in the local server stack.
- Windows artifacts in this Alpha remain unsigned by a publisher. The macOS app uses a structurally verified ad-hoc signature, without Developer ID signing or Apple notarization.

[View the full v0.3.3-alpha.1...v0.3.3-alpha.2 changelog](../../compare/v0.3.3-alpha.1...v0.3.3-alpha.2)
