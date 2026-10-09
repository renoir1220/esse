# Google Gemini 官方生图

这项支持使用 Google Gemini Developer API，复用 Esse 的本地 Provider 配置、安全凭据存储、批次队列和结果保存。API Key 只在 Esse 设置页输入；不要发到聊天或写入仓库。Google 的 Vertex AI 认证不在本适配器范围内。

## 设置

在包含此功能的版本中，打开 Esse 设置 → Provider → 添加 → **Google Gemini · 官方**。API 地址、接口格式和默认模型已经填好，只需填写自己的 Google API Key，保存并选择默认模型。**测试连接**只读取模型列表，不会提交生图。

预设默认使用 `gemini-nano-banana-2.1`；模型菜单另有 `gemini-3.1-flash-image`、`gemini-3-pro-image`、`gemini-2.5-flash-image`。实际可用模型、地区和额度以自己的 Google 项目为准。价格保持“未知”，以官方实际账单为准，没有推算为固定按次价格。

若使用“自定义”，填写：

| 设置字段 | 值 |
| --- | --- |
| 服务商名称 | Google Gemini |
| 档位名称 | 官方 |
| API 地址 | `https://generativelanguage.googleapis.com/v1beta` |
| 接口格式 | Google Gemini 原生 |
| 并发数 | 1（可按项目限额调整） |
| API Key | 仅在本机设置 UI 输入 |
| 显示名称 | Nano Banana 2.1 |
| 服务商模型 ID、标准模型 ID | `gemini-nano-banana-2.1` |
| 文生图、图生图 | 开启 |
| 尺寸 | 比例，例如 `9:16`、`16:9`、`1:1` |
| 分辨率（quality） | `1K`、`2K`、`4K` |
| 计费 | 未知，USD |

Gemini 2.5 Flash Image 使用默认 1K，不发送 imageSize；不支持 2K/4K。`512` 仅用于 Gemini 3.1 Flash Image。每个任务提交一次生成请求；若需要多次生成，使用 Esse 批次执行。若同一响应返回多张最终图片，全部保留：首张为主结果，其余显示为“同次生成结果”，可以独立查看、修改、删除和随批次合并，共用原调用记录。Esse 对 2.5 的参考图数限制为三张；其他预设限制为十四张；单次内联 JSON 请求必须小于 20 MB（包含 base64 和提示词）。参考图随本次请求上传原始文件内容，Esse 此适配器支持 PNG、JPEG、WebP；Google API 另支持 HEIC/HEIF，但现有工作台未接入，不宣称端到端支持。兼容旧工具的像素尺寸（如 1024x1024）只归一化为比例，输出分辨率仍由 quality 明确指定；不保证任意精确像素宽高。2.5 和 Pro 不支持 1:4、4:1、1:8、8:1，Nano Banana 2.1 和 Flash 支持。当前实现是独立的单轮生成/编辑，不传递多轮对话、thought signatures，也不自动添加搜索 grounding 工具。

## 请求合同

`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`

Headers 为 `x-goog-api-key` 和 `Content-Type: application/json`。Key 不放在 URL 查询参数中；生成和连接测试均拒绝重定向，避免将 Key 转发到另一个站点。9:16、2K、带参考图的请求体结构：

```json
{
  "contents": [{
    "role": "user",
    "parts": [
      {"text": "用户的生成或修改提示词"},
      {"inlineData": {"mimeType": "image/png", "data": "原始参考图的 base64"}}
    ]
  }],
  "generationConfig": {
    "responseModalities": ["TEXT", "IMAGE"],
    "imageConfig": {"aspectRatio": "9:16", "imageSize": "2K"}
  }
}
```

返回从 `candidates[0].content.parts[].inlineData` 解析原图，跳过 `thought: true` 的思考图，保留 `responseId`。网络中断、503、安全阻止、成功响应但缺少最终图片等结果保持扣费未知；不自动重发 POST。请求前发现不支持的比例、分辨率、数量或参考图格式时，不发送请求并标记未扣费。Google API Key 出现在错误文本时会被脱敏。

## beta.8 现状与兼容接口

已发布的私有 beta.8 不包含此功能。其自定义 Provider 只有 Tuzi JSON Images 与 OpenAI Images；会追加 `/v1/images/generations`、`/v1/models`，没有自定义 headers/body 模板。这使 Google 官方 `https://generativelanguage.googleapis.com/v1beta/openai/` 兼容入口的请求路径不匹配，不能通过普通设置配通。

Google 官方确实提供 OpenAI Images 文生图兼容接口，Bearer key 认证及 `data[].b64_json` 返回也与已有适配器相同。然而其文档没有定义 Esse 改图使用的 multipart `/images/edits`，且未列出的 `quality` 会被忽略；只修 URL 无法覆盖参考图和明确分辨率。因此新增的是现有 Provider 结构中的原生适配器，没有新建通用模板框架，既有 Tuzi、Subrouter 和 OpenAI 自定义配置的分发不变。

本功能的合同测试仅使用虚构 key 和离线响应。未读取已有密钥，未调用真实 Google 生图，未验证真实图像效果、项目权限或付费扣款。源码合入不代表已发布 beta.8 获得此功能；本次不创建新版本或覆盖 beta.8。

协议依据（2026-10-08 核对）：[Google GenerateContent API schema](https://ai.google.dev/api/generate-content)、[官方 GenerateContent 生图与参考图说明](https://ai.google.dev/gemini-api/docs/generate-content/image-generation)、[官方 OpenAI 兼容接口](https://ai.google.dev/gemini-api/docs/openai)、[当前生图模型说明](https://ai.google.dev/gemini-api/docs/image-generation)。
