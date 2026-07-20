[简体中文](#简体中文) | [English](#english)

## 简体中文

### Esse 0.2.3-beta.1

- 原图查看统一改用标准 MCP Apps `resources/read` 资源，移除本地 HTTP 服务；Windows、macOS arm64 与 macOS x64 均可读取未缩放、未转码的原始图片，并校验短期令牌、文件状态和 60 MB 上限。
- 修复批次删除与异步保存竞争导致记录复活的问题；损坏的批次记录会被隔离而不再阻止 Esse 启动，生成尺寸与质量也会在重启和手动重试后保留。
- Provider 响应、参考图与生成图增加明确的数量和字节边界；生成结果按实际图片签名识别，并限制不安全的私网 URL 与重定向。
- Windows 与 macOS 安装器现在会校验并自检实际安装副本、修复同版本损坏文件并清理无用旧版本；Windows 安装器同时兼容 PowerShell 5 的系统代码页和精简运行环境。
- 缩略图采用渐进式小批加载并限制磁盘缓存；Windows x64、macOS arm64 与 macOS x64 CI 会记录 8 图冷/热加载基准。消除缩略图 Base64 传输的后续工作继续在 [#15](../../issues/15) 跟踪。
- 新增完整 Windows 用户安装链路 E2E，macOS 两种架构运行完整测试与安装修复验证；发布工作流固定第三方 Action、收紧权限，并对 GitHub Release 临时故障执行幂等重试。

`v0.2.2-beta.4` 标签因 GitHub Release API 临时故障未生成可下载的 Release；本 beta 是首个向测试者交付这些变更的完整预发布包。

[查看 v0.2.2-beta.3...v0.2.3-beta.1 完整变更](../../compare/v0.2.2-beta.3...v0.2.3-beta.1)

## English

### Esse 0.2.3-beta.1

- Original-image viewing now uses standard MCP Apps `resources/read` resources without a local HTTP server. Windows, macOS arm64, and macOS x64 read the unchanged original bytes while enforcing short-lived tokens, file-state checks, and a 60 MB limit.
- Fixed a delete-versus-save race that could resurrect batch records. Corrupt records are quarantined instead of blocking startup, and generation size and quality survive restarts and manual retries.
- Provider responses, reference images, and generated images now have explicit count and byte limits. Outputs are identified by their actual image signatures, with unsafe private-network URLs and redirects restricted.
- Windows and macOS installers verify and self-test the installed copy, repair same-version drift, and remove unused versions. The Windows installer also supports PowerShell 5 system code pages and reduced module environments.
- Thumbnails load in progressive small batches with a bounded disk cache. CI records eight-image cold and warm benchmarks on Windows x64, macOS arm64, and macOS x64. Removing thumbnail Base64 transport remains tracked in [#15](../../issues/15).
- Added a complete Windows user-install E2E and full macOS checks plus installer-repair validation on both architectures. Release workflows pin third-party Actions, narrow permissions, and retry transient GitHub Release failures idempotently.

The `v0.2.2-beta.4` tag did not produce a downloadable Release because of a transient GitHub Release API failure. This beta is the first complete prerelease package that delivers those changes to testers.

[View the full v0.2.2-beta.3...v0.2.3-beta.1 changelog](../../compare/v0.2.2-beta.3...v0.2.3-beta.1)

---

## 自动生成的变更记录 / Auto-generated changelog
