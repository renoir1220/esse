[简体中文](#简体中文) | [English](#english)

## 简体中文

### Esse 0.2.4-alpha.1

- 新增用户级单实例 Esse Core。多个 Codex 任务启动的 stdio 适配器通过带能力令牌和版本握手的本地 IPC 共享同一份批次状态、Provider 密钥和调度队列，避免并发进程各自写入导致状态覆盖。
- 已提交的 Provider 请求不再随某个 stdio 适配器断开而终止。Core 意外退出后会恢复持久化记录，将已发出的未完成调用标记为 `chargeState: unknown`，并禁止自动重试，减少重复扣费风险。
- 强化生成操作的幂等契约：创建、追加、修改和合并必须携带稳定 `requestKey`；相同 key 与相同参数复用原结果，相同 key 与不同参数会被明确拒绝。全部 MCP 工具同时补齐结构化输出 schema。
- 扩展发布与安装验证。Windows 发布包包含独立的 `esse-core.exe`，macOS 启动器支持 Core 入口；安装器会分别自检适配器和 Core，Windows 用户链路测试覆盖两个已安装适配器共享同一 Core。编译版缺失 Core 时会立即失败，避免递归拉起自身。

[查看 v0.2.3...v0.2.4-alpha.1 完整变更](../../compare/v0.2.3...v0.2.4-alpha.1)

## English

### Esse 0.2.4-alpha.1

- Added a per-user, single-instance Esse Core. Stdio adapters launched by multiple Codex tasks now share batch state, Provider credentials, and scheduling through local IPC protected by a capability token and version handshake, preventing cross-process state overwrites.
- Submitted Provider requests no longer terminate when one stdio adapter disconnects. After an unexpected Core exit, persisted in-flight calls recover as `chargeState: unknown` and are never retried automatically, reducing duplicate-charge risk.
- Strengthened idempotency for generation mutations. Create, append, modify, and merge operations require a stable `requestKey`; identical requests reuse the existing result, while the same key with different arguments is rejected. Every MCP tool now also publishes a structured output schema.
- Expanded release and installation validation. Windows packages include a dedicated `esse-core.exe`, the macOS launcher supports the Core entry point, installers self-test both the adapter and Core, and the Windows user-path test verifies that two installed adapters share one Core. Compiled adapters now fail fast when the Core is missing instead of recursively launching themselves.

[View the full v0.2.3...v0.2.4-alpha.1 changelog](../../compare/v0.2.3...v0.2.4-alpha.1)
