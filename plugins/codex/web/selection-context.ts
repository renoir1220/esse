import type { BatchSnapshot, JobSnapshot } from "./types";

export type SelectableImage = {
  id: string;
  jobId: string;
  name: string;
  path: string;
  kind: "result" | "backup" | "failed-source";
};

export function selectableImages(batch: BatchSnapshot): SelectableImage[] {
  return batch.jobs.flatMap((job) => {
    const images: SelectableImage[] = [];
    if (job.status === "succeeded" && job.outputPath) {
      images.push({ id: job.id, jobId: job.id, name: job.name, path: job.outputPath, kind: "result" });
    } else if (job.status === "failed") {
      const sourcePath = failedSourcePath(job);
      if (sourcePath) images.push({ id: job.id, jobId: job.id, name: job.name, path: sourcePath, kind: "failed-source" });
    }
    for (const backup of job.backups || []) {
      images.push({ id: backup.id, jobId: job.id, name: backup.name, path: backup.outputPath, kind: "backup" });
    }
    return images;
  });
}

export function imagesMentionedInRequest(batch: BatchSnapshot, request: string): SelectableImage[] {
  const mentioned = new Set(
    [...request.matchAll(/图\s*\d+(?:\s*-\s*\d+)?/gu)].map((match) => normalizeImageName(match[0]))
  );
  return selectableImages(batch).filter((image) => mentioned.has(normalizeImageName(image.name)));
}

export function selectionModelContext(batch: BatchSnapshot, selectedImageIds: Set<string>): string {
  const available = selectableImages(batch);
  const selected = available.filter((image) => selectedImageIds.has(image.id));
  const label = (image: SelectableImage, includePath = false) =>
    `${image.name} (image ID: ${image.id}${includePath ? `, local path: ${image.path}` : ""})`;

  if (selected.length) {
    return `用户当前在 Esse 批次“${batch.title}” (${batch.id}) 中已选择：${selected.map((image) => label(image, true)).join("、")}。当用户说“我选择的图片”或“选中的图片”时，必须把这些准确 image ID 传给 modify_selected_images 的 imageIds；其中可能包含历史备份或失败任务的原始参考图，修改仍须留在当前批次。`;
  }
  if (available.length > 1) {
    return `用户当前没有在 Esse 批次“${batch.title}” (${batch.id}) 中选择图片。可选图片有：${available.map((image) => label(image)).join("、")}。如果用户要求修改但没有明确图像名称，不得猜测；必须询问想改哪张，并提示可以输入图像名称（例如“图1”或“图2-1”），或者在 Esse 中双击选择图片。`;
  }
  if (available.length === 1) {
    return `用户当前没有在 Esse 批次“${batch.title}” (${batch.id}) 中选择图片；唯一可选图片是 ${label(available[0]!, true)}。用户未另行指定时，可将明确的修改请求应用到这张唯一图片。`;
  }
  return `Esse 当前批次“${batch.title}” (${batch.id}) 尚无可用于编辑的已完成图片、历史备份或失败任务原图。`;
}

function failedSourcePath(job: JobSnapshot): string | undefined {
  return job.referenceImagePaths?.[0]
    || job.generationInputPaths?.[0]
    || job.generationInputPath
    || job.inputPaths?.[0]
    || job.inputPath;
}

function normalizeImageName(value: string): string {
  return value.replace(/\s+/gu, "");
}
