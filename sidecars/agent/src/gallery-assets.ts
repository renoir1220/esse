import type { BatchJob, BatchSnapshot, JobBackup, OfferingSummary, SavedImage } from './types';

export interface GalleryAsset {
  id: string;
  name: string;
  kind: 'job' | 'backup';
  job: BatchJob;
  backup?: JobBackup;
  image?: SavedImage;
  imageId?: string;
  prompt: string;
  referenceImageIds: string[];
  offering: OfferingSummary;
}

export function galleryAssets(batch: BatchSnapshot, imagesById: Map<string, SavedImage>): GalleryAsset[] {
  return batch.jobs.flatMap((job) => {
    const backupIds = new Set(job.backups.map((backup) => backup.imageId));
    const failedSourceId = job.status === 'failed' && !job.outputImageId
      ? job.referenceImageIds.find((id) => imagesById.has(id) && !backupIds.has(id))
      : undefined;
    const imageId = job.outputImageId || failedSourceId;
    const current: GalleryAsset = {
      id: job.id,
      name: job.name,
      kind: 'job',
      job,
      imageId,
      image: imageId ? imagesById.get(imageId) : undefined,
      prompt: job.prompt,
      referenceImageIds: [...job.referenceImageIds],
      offering: job.offering || batch.offering,
    };
    const backups: GalleryAsset[] = job.backups.map((backup) => ({
      id: backup.id,
      name: backup.name,
      kind: 'backup',
      job,
      backup,
      imageId: backup.imageId,
      image: imagesById.get(backup.imageId),
      prompt: backup.prompt,
      referenceImageIds: [...(backup.referenceImageIds ?? [])],
      offering: backup.offering || job.offering || batch.offering,
    }));
    return [current, ...backups];
  });
}

export function selectableAssets(assets: GalleryAsset[]): GalleryAsset[] {
  return assets.filter((asset) => Boolean(asset.imageId && asset.image));
}
