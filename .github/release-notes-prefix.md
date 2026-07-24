## 简体中文

### Esse Community 0.3.3-alpha.1

- 重新设计多批次浏览体验：按 `Esc` 可从批次明细进入浏览页，浏览按钮悬停显示快捷键；只要有任务排队或运行，浏览按钮就会实时显示旋转状态。
- 批次卡片现在实时展示已完成任务数与总任务数，并用遮罩区分“进行中”“完成有错”和“已完成”。重新生成成功后会清除历史失败状态，应用中断遗留的任务仍会标记为有错。
- 支持直接重试一个批次中的全部失败任务，并新增中文模糊搜索与可选日期范围。今天更新过的批次会自然聚集在前方，更早批次仅用分隔元素区分。
- 浏览页标题已移到批次标题区域，不再混杂当前批次名称或无意义的说明文字。
- 图片库、参考图、附件和批次封面缩略图均完整显示原图；非正方形图片使用留白，不再裁剪内容。
- 本 Alpha 的 Windows 与 macOS Agent Sidecar 产物未做发布者签名或 Apple 公证；Release 继续提供 SHA256 校验。Windows 可能显示未知发布者，macOS Gatekeeper 可能拒绝打开，请勿关闭系统安全机制。

[查看 v0.3.2...v0.3.3-alpha.1 完整变更](../../compare/v0.3.2...v0.3.3-alpha.1)

## English

### Esse Community 0.3.3-alpha.1

- Redesigns multi-batch browsing. Press `Esc` from batch details to open the browser, hover the Browse button to see the shortcut, and watch that button show a live spinner whenever any task is queued or running.
- Batch cards now show completed versus total task counts in real time and distinguish In Progress, Completed with Errors, and Completed states with thumbnail overlays. A successful retry clears historical failures, while work interrupted by an application exit remains an error.
- Adds one-click retry for all failed tasks in a batch, Chinese fuzzy search, and an optional date range. Batches updated today stay naturally grouped at the top, with older work separated only by a subtle divider.
- Moves the Browse heading into the normal batch-title position and removes the conflicting current-batch title and unnecessary explanatory copy.
- Shows complete images throughout gallery, reference, attachment, and batch-cover thumbnails. Non-square images are letterboxed instead of cropped.
- Windows and macOS Agent Sidecar artifacts in this Alpha are not publisher-signed or Apple-notarized. SHA256 checksums remain available. Windows may show an unknown-publisher warning, and macOS Gatekeeper may reject the app; do not disable platform security.

[View the full v0.3.2...v0.3.3-alpha.1 changelog](../../compare/v0.3.2...v0.3.3-alpha.1)
