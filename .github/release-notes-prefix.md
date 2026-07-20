[简体中文](#简体中文) | [English](#english)

## 简体中文

### Esse 0.2.3-beta.4

- 修复 Clash TUN/Fake-IP 环境下，Provider 返回的跨域图片链接被误判为本地或私网地址的问题。Esse 现在使用独立可信 DNS 解析并校验全部公网 A/AAAA 地址，再将同一解析结果固定到实际连接；每次重定向都会重新校验，用户无需关闭 TUN，也不依赖写死的 Provider 或 CDN 域名列表。
- 新增向现有批次直接追加生成任务的能力。运行中或已完成的批次都可以继续增加图片，并可为追加任务指定另一模型、独立 Prompt、参考图和幂等键；不会再通过“新建临时批次后合并”模拟追加。
- 精简 Esse 技能的费用沟通：价格元数据只作为预估，常规生成不再主动或重复强调；仅在用户询价、比较模型或上层策略要求确认时简短说明。
- 混合模型批次的预估费用现在按每个任务实际选用的模型分别汇总，避免沿用批次初始模型造成错误估算。

[查看 v0.2.3-beta.2...v0.2.3-beta.4 完整变更](../../compare/v0.2.3-beta.2...v0.2.3-beta.4)

## English

### Esse 0.2.3-beta.4

- Fixed cross-origin Provider image URLs being misclassified as local or private addresses under Clash TUN/Fake-IP networking. Esse now resolves through independent trusted DNS, validates every public A/AAAA address, and pins that same result to the actual connection. Every redirect is revalidated, without requiring users to disable TUN or relying on hard-coded Provider/CDN domains.
- Added native generation-job append for existing batches. Active and completed batches can receive more images with an optional different model, per-job prompts, references, and an idempotency key; append no longer needs a temporary batch followed by a merge.
- Reduced price narration in the Esse skill. Price metadata is treated as an estimate, stays quiet during routine generation, and is mentioned briefly only when the user asks about cost, compares models, or a higher-level policy requires confirmation.
- Mixed-model batch estimates now sum the model selected for each job instead of incorrectly applying the batch's initial model to every image.

[View the full v0.2.3-beta.2...v0.2.3-beta.4 changelog](../../compare/v0.2.3-beta.2...v0.2.3-beta.4)

---

## 自动生成的变更记录 / Auto-generated changelog
