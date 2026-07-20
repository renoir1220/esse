[简体中文](#简体中文) | [English](#english)

## 简体中文

### Esse 0.2.3

- 新增批次内原生追加任务。Agent 现在可以把不同模型、Prompt 和参考图的新任务直接加入现有批次，无需创建临时批次再合并；追加请求支持幂等处理，并保留每个子任务自己的生成参数。
- 改善中国大陆未开启 VPN 时的生成结果下载。跨域图片域名优先通过 AliDNS 和 DNSPod Public DNS 可信解析，并保留全球回退；无需用户开启 VPN、关闭 TUN 或修改代理配置。下载链路继续拒绝 Clash Fake-IP 和其他非公网地址、固定已验证地址到 HTTPS 连接，并重新验证每次重定向。
- 原图预览改用标准 MCP Apps 资源读取，在 Windows 与 macOS 上传输未经缩放或转码的原始文件；短期令牌、文件变更检查和 60 MB 上限避免暴露任意本地文件。
- 提升桌面端稳定性与图片加载体验：MCP Transport 关闭后停止后台轮询，避免重复错误；缩略图改为渐进加载，并限制内存与磁盘缓存，降低冷启动和大批次浏览时的峰值开销。
- 更新提示改为设置右侧的低调“有新版本”链接；安装器支持同版本文件修复、运行时自检、旧版本清理和失败回滚，Windows 用户安装链路以及 macOS arm64/x64 安全启动均纳入发布验证。

[查看 v0.2.1...v0.2.3 完整变更](../../compare/v0.2.1...v0.2.3)

## English

### Esse 0.2.3

- Added native in-batch job appending. Agents can add jobs with different models, prompts, and references directly to an existing batch without creating and merging a temporary batch. Append requests are idempotent and preserve each child job's generation options.
- Improved generated-image downloads for users in mainland China without a VPN. Cross-origin image hosts prefer trusted AliDNS and DNSPod Public DNS resolution while retaining global fallbacks, without requiring users to enable a VPN, disable TUN, or change proxy settings. The download path continues to reject Clash Fake-IP and other non-public addresses, pins validated addresses to the HTTPS connection, and revalidates every redirect.
- Moved original-image viewing to standard MCP Apps resources on Windows and macOS, transferring the original file without resizing or transcoding. Short-lived tokens, file-change checks, and a 60 MB limit prevent arbitrary local-file exposure.
- Improved desktop stability and image loading: background polling stops after the MCP transport closes to prevent repeated errors, while thumbnails load progressively with bounded memory and disk caches to reduce cold-start and large-batch peaks.
- Replaced the prominent update notice with a subtle “有新版本” link beside Settings. Installers now repair changed same-version files, self-test the runtime, clean old versions, and roll back failed registration; Windows user-path installation and macOS arm64/x64 safe launching are part of release validation.

[View the full v0.2.1...v0.2.3 changelog](../../compare/v0.2.1...v0.2.3)
