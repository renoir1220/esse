[简体中文](#简体中文) | [English](#english)

## 简体中文

### Esse 0.2.3-beta.2

- 新版本提示改为“设置”右侧低调的“有新版本”文字入口，不再使用占据内容区的醒目提示框；仍只在检测到可信的新稳定版时显示。
- 修复插件安装或升级后旧任务的 MCP 连接已经关闭、Esse 却继续轮询并反复弹出 `Transport closed` 错误的问题。现在连接永久关闭后只提示一次，并停止本地状态和批次状态的后台轮询；普通临时错误仍会继续重试。

这是针对 `v0.2.3-beta.1` 的交互与连接容错修订，不改变图片生成、Provider 配置或本地批次数据。

[查看 v0.2.3-beta.1...v0.2.3-beta.2 完整变更](../../compare/v0.2.3-beta.1...v0.2.3-beta.2)

## English

### Esse 0.2.3-beta.2

- The update notification is now a quiet `有新版本` link beside Settings instead of a prominent banner occupying the content area. It still appears only when a trusted newer stable release is detected.
- Fixed repeated `Transport closed` errors after a plugin install or upgrade left an old task with a permanently closed MCP connection. Esse now shows one notice and stops both local-state and batch-state background polling; ordinary transient failures remain retryable.

This is a focused interaction and connection-resilience follow-up to `v0.2.3-beta.1`. It does not change image generation, Provider configuration, or local batch data.

[View the full v0.2.3-beta.1...v0.2.3-beta.2 changelog](../../compare/v0.2.3-beta.1...v0.2.3-beta.2)

---

## 自动生成的变更记录 / Auto-generated changelog
