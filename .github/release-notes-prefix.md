[简体中文](#简体中文) | [English](#english)

## 简体中文

### Esse 0.2.3-beta.5

- 改善中国大陆未开启 VPN 时的生成结果下载。跨域图片域名现在依次使用 AliDNS、DNSPod Public DNS、Cloudflare 和 Google 进行可信解析；当海外 DoH 不可达时，可优先通过国内解析器完成下载，无需用户开启 VPN、关闭 TUN 或修改代理配置。
- 保留并强化 SSRF 防护：显式拒绝 Clash Fake-IP 使用的 `198.18.0.0/15`，继续校验全部 A/AAAA 地址为公网地址、将验证结果固定到实际 HTTPS 连接，并对每次重定向重新解析和验证。

[查看 v0.2.3-beta.4...v0.2.3-beta.5 完整变更](../../compare/v0.2.3-beta.4...v0.2.3-beta.5)

## English

### Esse 0.2.3-beta.5

- Improved generated-image downloads for users in mainland China without a VPN. Cross-origin image hosts now resolve through AliDNS, DNSPod Public DNS, Cloudflare, and Google in that order. Domestic resolvers can complete the download when overseas DoH is unreachable, without requiring users to enable a VPN, disable TUN, or change proxy settings.
- Preserved and strengthened SSRF protection by explicitly rejecting Clash's `198.18.0.0/15` Fake-IP range, continuing to validate every A/AAAA result as public, pinning validated addresses to the actual HTTPS connection, and resolving and validating every redirect again.

[View the full v0.2.3-beta.4...v0.2.3-beta.5 changelog](../../compare/v0.2.3-beta.4...v0.2.3-beta.5)
