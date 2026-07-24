import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import {
  ArrowClockwise,
  ArrowsOutSimple,
  CalendarBlank,
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  CheckCircle,
  Copy,
  DotsThree,
  DownloadSimple,
  FolderSimple,
  FunnelSimple,
  ImageSquare,
  Info,
  Lightning,
  LockSimple,
  MagnifyingGlass,
  Plus,
  SlidersHorizontal,
  SquaresFour,
  Trash,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import './index.css';
import { retryAllFailedSelection } from './batch-actions';
import { batchLibraryProgress, batchLibraryState, filterAndGroupBatches, type BatchLibraryState } from './batch-library';
import { errorOriginLabel } from './error-display';
import { galleryAssets, selectableAssets, type GalleryAsset } from './gallery-assets';
import { initialImageZoom, zoomImageAtPoint } from './image-zoom';
import { shouldDismissOverlay } from './overlay-dismiss';
import { PENDING_TASK_HOVER_DELAY_MS, pendingTaskPeekPosition, type PeekPosition } from './pending-task-peek';
import { blankOffering, createCustomProviderDraft, createTuziProviderDraft, offeringFromTuziModel, TUZI_PROVIDER_PRESETS, tuziProviderPresetForDraft } from './provider-catalog';
import type { BatchSnapshot, DesktopState, ImageMetadata, OfferingConfig, OfferingSummary, ProviderDraft, ProviderProfile, SavedImage, SaveProviderInput } from './types';
import { formatWindowTitle } from './window-title';
import packageMetadata from '../package.json';
import product from '../product.json';

const esseIconUrl = new URL('../assets/esse.png', import.meta.url).href;
const windowTitle = formatWindowTitle(product.displayName, packageMetadata.version);

type Tab = 'batches' | 'browse' | 'settings';

const emptyState: DesktopState = {
  configured: false,
  providers: [],
  offerings: [],
  images: [],
  batches: [],
  mcp: { available: false, endpoint: '' },
  platform: 'unknown',
  secureStorage: 'OS protected storage',
};

function App() {
  const [state, setState] = useState<DesktopState>(emptyState);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>('batches');
  const [activeBatchId, setActiveBatchId] = useState<string>();
  const [selectedImageIds, setSelectedImageIds] = useState<Set<string>>(new Set());
  const [viewerImageId, setViewerImageId] = useState<string>();
  const [batchMenuOpen, setBatchMenuOpen] = useState(false);
  const [batchPickerOpen, setBatchPickerOpen] = useState(false);
  const [imageMenu, setImageMenu] = useState<{ imageId: string; x: number; y: number }>();
  const [notice, setNotice] = useState<string>();
  const clickTimer = useRef<number | undefined>(undefined);
  const lastDesktopActivation = useRef<string | undefined>(undefined);

  useEffect(() => {
    document.title = windowTitle;
    window.esse.reportReady({ title: document.title, bridgeAvailable: typeof window.esse?.getState === 'function' });
    void window.esse.getState().then((next) => {
      setState(next);
      setActiveBatchId(next.activeBatchId || next.batches[0]?.id);
      lastDesktopActivation.current = next.activeBatchId;
      setError(next.error);
    }).catch((cause) => setError(cleanError(cause))).finally(() => setLoading(false));
    const unsubscribeState = window.esse.onStateChanged((next) => {
      setState(next);
      setError(next.error);
      if (next.activeBatchId && next.activeBatchId !== lastDesktopActivation.current) {
        lastDesktopActivation.current = next.activeBatchId;
        setActiveBatchId(next.activeBatchId);
        setTab('batches');
        setSelectedImageIds(new Set());
      } else {
        setActiveBatchId((current) => next.batches.some((batch) => batch.id === current) ? current : next.activeBatchId || next.batches[0]?.id);
      }
    });
    const unsubscribeNavigation = window.esse.onNavigate(({ tab: nextTab, batchId }) => {
      setTab(nextTab);
      if (batchId) setActiveBatchId(batchId);
    });
    return () => { unsubscribeState(); unsubscribeNavigation(); };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(undefined), 3600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (shouldDismissOverlay(event.target, '.current-batch-picker')) setBatchPickerOpen(false);
      if (shouldDismissOverlay(event.target, '.header-more')) setBatchMenuOpen(false);
      if (shouldDismissOverlay(event.target, '.image-context-menu')) setImageMenu(undefined);
    };
    const closeTransientOverlays = () => { setBatchPickerOpen(false); setBatchMenuOpen(false); setImageMenu(undefined); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (batchPickerOpen || batchMenuOpen || imageMenu) {
        closeTransientOverlays();
        return;
      }
      if (viewerImageId || document.querySelector('.task-detail-backdrop')) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (tab === 'batches') {
        event.preventDefault();
        setTab('browse');
      }
    };
    document.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', closeTransientOverlays);
    window.addEventListener('resize', closeTransientOverlays);
    document.addEventListener('scroll', closeTransientOverlays, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', closeTransientOverlays);
      window.removeEventListener('resize', closeTransientOverlays);
      document.removeEventListener('scroll', closeTransientOverlays, true);
    };
  }, [batchMenuOpen, batchPickerOpen, imageMenu, tab, viewerImageId]);

  const activeBatch = useMemo(
    () => state.batches.find((batch) => batch.id === activeBatchId) || state.batches[0],
    [activeBatchId, state.batches],
  );
  const imagesById = useMemo(() => new Map(state.images.map((image) => [image.id, image])), [state.images]);
  const viewerImage = viewerImageId ? imagesById.get(viewerImageId) : undefined;
  const activeAssets = useMemo(() => activeBatch ? galleryAssets(activeBatch, imagesById) : [], [activeBatch, imagesById]);
  const viewerImages = useMemo(() => uniqueImages(selectableAssets(activeAssets).flatMap((asset) => asset.image ? [asset.image] : [])), [activeAssets]);
  const hasActiveBatches = useMemo(() => state.batches.some((batch) => batchLibraryState(batch) === 'active'), [state.batches]);

  async function apply(action: () => Promise<DesktopState>, success?: string) {
    setBusy(true);
    setError(undefined);
    try {
      const next = await action();
      setState(next);
      setActiveBatchId(next.activeBatchId || activeBatchId || next.batches[0]?.id);
      if (success) setNotice(success);
      return true;
    } catch (cause) {
      setError(cleanError(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function switchBatch(id: string) {
    setActiveBatchId(id);
    setSelectedImageIds(new Set());
    setBatchPickerOpen(false);
    setTab('batches');
    await apply(() => window.esse.activateBatch(id));
  }

  async function copyBatchReference(batch: BatchSnapshot) {
    try {
      await window.esse.copyBatchReference(batch.id);
      setNotice('已复制批次名称和 ID');
    } catch (cause) {
      setError(cleanError(cause));
    }
  }

  function openImageSoon(id: string) {
    window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(() => setViewerImageId(id), 180);
  }

  function toggleSelected(id: string) {
    window.clearTimeout(clickTimer.current);
    setSelectedImageIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (loading) return <div className="splash"><span className="spinner" /><p>正在打开 Esse 工作台…</p></div>;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="header-context">
          {tab === 'browse' ? <><span className="header-context-icon"><SquaresFour size={17} /></span><strong>浏览批次</strong></> : tab === 'settings' ? <span className="header-context-icon"><SlidersHorizontal size={17} /></span> : (
            <div className="current-batch-picker">
              <button className="current-batch-trigger" onClick={() => { setBatchMenuOpen(false); setBatchPickerOpen((open) => !open); }} aria-expanded={batchPickerOpen} disabled={!state.batches.length}>
                <span>{activeBatch ? `${activeBatch.title} · ${activeBatch.offering.displayName}` : 'Esse 图片工作台'}</span><CaretDown size={14} />
              </button>
              {batchPickerOpen ? <div className="current-batch-menu">{state.batches.slice(0, 8).map((batch) => (
                <button key={batch.id} aria-selected={batch.id === activeBatch?.id} onClick={() => void switchBatch(batch.id)}><Check size={13} /><span>{batch.title}</span></button>
              ))}</div> : null}
            </div>
          )}
          {activeBatch && tab === 'batches' ? <button type="button" className="batch-reference-copy" onClick={() => void copyBatchReference(activeBatch)} aria-label="复制批次名称和 ID" title="复制批次名称和 ID"><Copy size={14} /></button> : null}
          {tab === 'settings' ? <strong>设置</strong> : null}
          {activeBatch && tab === 'batches' ? <div className="header-more">
            <button className="header-icon-action" onClick={() => { setBatchPickerOpen(false); setBatchMenuOpen((open) => !open); }} aria-label="批次菜单"><DotsThree size={18} weight="bold" /></button>
            {batchMenuOpen ? <div className="header-menu">
              <button onClick={() => void window.esse.openBatchFolder(activeBatch.id)}><FolderSimple size={15} />打开输出文件夹</button>
              <button className="is-danger" disabled={!isTerminal(activeBatch)} onClick={() => {
                if (window.confirm(`删除批次“${activeBatch.title}”？原始图片文件仍会保留在本地。`)) void apply(() => window.esse.deleteBatch(activeBatch.id), '批次已删除');
                setBatchMenuOpen(false);
              }}><Trash size={15} />删除批次记录</button>
            </div> : null}
          </div> : null}
        </div>
        <nav className="header-actions" aria-label="Esse 页面">
          <button className={tab === 'batches' ? 'is-active' : ''} onClick={() => setTab('batches')}><img className="esse-nav-icon" src={esseIconUrl} alt="" /><span>首页</span></button>
          <button className={`nav-shortcut ${tab === 'browse' ? 'is-active' : ''}`} onClick={() => setTab('browse')} aria-keyshortcuts="Escape">
            {hasActiveBatches ? <span className="nav-progress-spinner spinner" aria-hidden="true" /> : <SquaresFour size={16} />}
            <span>浏览</span>
            <span className="nav-shortcut-tooltip" role="tooltip">浏览批次 <kbd>Esc</kbd></span>
          </button>
          <button className={tab === 'settings' ? 'is-active' : ''} onClick={() => setTab('settings')}><SlidersHorizontal size={16} /><span>设置</span></button>
        </nav>
      </header>

      {notice ? <div className="notice"><span>{notice}</span><button onClick={() => setNotice(undefined)}><X size={14} /></button></div> : null}
      {error ? <div className="error-banner"><span>{error}</span><button onClick={() => setError(undefined)}><X size={14} /></button></div> : null}

      {tab === 'batches' ? (
        activeBatch ? <BatchWorkspace
          batch={activeBatch}
          imagesById={imagesById}
          selectedImageIds={selectedImageIds}
          offerings={state.offerings.filter((offering) => offering.configured)}
          defaultOfferingId={state.defaultOfferingId}
          busy={busy}
          onOpenImage={openImageSoon}
          onToggleSelected={toggleSelected}
          onImageContextMenu={(event, imageId) => {
            event.preventDefault();
            setBatchPickerOpen(false);
            setBatchMenuOpen(false);
            setImageMenu({ imageId, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 184)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 232)) });
          }}
          onModify={(input) => apply(() => window.esse.modifyBatch(input), '修改任务已交给 Esse 后台')}
          onCancel={() => apply(() => window.esse.cancelQueued(activeBatch.id), '已取消排队任务')}
          onRetry={(asset) => {
            const unknown = asset.job.chargeState === 'unknown';
            return apply(
              () => window.esse.retryJobs(activeBatch.id, [asset.job.id], unknown),
              unknown ? '任务已重新排队；上一次调用的扣费状态未知' : '任务已重新排队',
            );
          }}
          onRetryAll={(jobIds, includesUnknownCharge) => apply(
            () => window.esse.retryJobs(activeBatch.id, jobIds, includesUnknownCharge),
            includesUnknownCharge ? '失败任务已重新排队；部分上次调用的扣费状态未知' : '失败任务已重新排队',
          )}
        /> : <EmptyState title="还没有图片批次" copy="请从 Agent 向 Esse 提交第一个图片任务。" />
      ) : null}

      {tab === 'browse' ? <BatchLibrary
        batches={state.batches}
        imagesById={imagesById}
        busy={busy}
        onOpen={(id) => void switchBatch(id)}
        onRetry={(batch, jobIds, includesUnknownCharge) => apply(
          () => window.esse.retryJobs(batch.id, jobIds, includesUnknownCharge),
          includesUnknownCharge ? `“${batch.title}”的失败任务已重新排队；部分上次调用的扣费状态未知` : `“${batch.title}”的失败任务已重新排队`,
        )}
      /> : null}
      {tab === 'settings' ? <Settings state={state} busy={busy} apply={apply} onNotice={setNotice} /> : null}

      {imageMenu && activeBatch ? <ImageContextMenu batchId={activeBatch.id} imageId={imageMenu.imageId} x={imageMenu.x} y={imageMenu.y} selected={selectedImageIds.has(imageMenu.imageId)} onToggle={() => toggleSelected(imageMenu.imageId)} onClose={() => setImageMenu(undefined)} onNotice={setNotice} onDelete={() => deleteImage(activeBatch.id, imageMenu.imageId)} /> : null}
      {viewerImage && activeBatch ? <ImageViewer image={viewerImage} images={viewerImages} onNavigate={setViewerImageId} onClose={() => setViewerImageId(undefined)} onNotice={setNotice} onDelete={() => deleteImage(activeBatch.id, viewerImage.id)} /> : null}
    </main>
  );

  async function deleteImage(batchId: string, imageId: string) {
    if (!window.confirm('删除这张图片及其关联的本地版本？文件会移入 Esse 的可恢复回收目录。')) return;
    setImageMenu(undefined);
    setViewerImageId(undefined);
    setSelectedImageIds((current) => { const next = new Set(current); next.delete(imageId); return next; });
    await apply(() => window.esse.deleteImages(batchId, [imageId]), '图片已移入 Esse 回收目录');
  }
}

function BatchWorkspace(props: {
  batch: BatchSnapshot;
  imagesById: Map<string, SavedImage>;
  selectedImageIds: Set<string>;
  offerings: OfferingSummary[];
  defaultOfferingId?: string;
  busy: boolean;
  onOpenImage: (id: string) => void;
  onToggleSelected: (id: string) => void;
  onImageContextMenu: (event: React.MouseEvent, id: string) => void;
  onModify: (input: Parameters<typeof window.esse.modifyBatch>[0]) => Promise<boolean>;
  onCancel: () => Promise<boolean>;
  onRetry: (asset: GalleryAsset) => Promise<boolean>;
  onRetryAll: (jobIds: string[], includesUnknownCharge: boolean) => Promise<boolean>;
}) {
  const { batch } = props;
  const [prompt, setPrompt] = useState('');
  const [detailAssetId, setDetailAssetId] = useState<string>();
  const [offeringId, setOfferingId] = useState(batch.offering.id || props.defaultOfferingId || props.offerings[0]?.id || '');
  const offering = props.offerings.find((item) => item.id === offeringId) || batch.offering;
  const assets = useMemo(() => galleryAssets(batch, props.imagesById), [batch, props.imagesById]);
  const selectable = useMemo(() => selectableAssets(assets), [assets]);
  const targetIds = props.selectedImageIds.size ? [...props.selectedImageIds] : selectable.length === 1 && selectable[0].imageId ? [selectable[0].imageId] : [];
  const detailAsset = detailAssetId ? assets.find((asset) => asset.id === detailAssetId) : undefined;
  const active = batch.queued + batch.running > 0;
  const retrySelection = retryAllFailedSelection(batch);

  useEffect(() => { setOfferingId(batch.offering.id); setDetailAssetId(undefined); }, [batch.id, batch.offering.id]);

  return <div className="batch-page">
    <div className="section-heading">
      <div><strong>{statusLabel(batch)}</strong>{batch.failed ? <button type="button" className="retry-all-button" title={retrySelection.jobIds.length ? '重新排队失败任务' : 'Agent 任务需由当前 Agent 重新发起'} disabled={props.busy || !retrySelection.jobIds.length} onClick={() => void props.onRetryAll(retrySelection.jobIds, retrySelection.includesUnknownCharge)}><ArrowClockwise size={13} weight="bold" />重试失败任务</button> : null}</div>
    </div>
    <section className={`batch-workspace ${assets.length === 1 ? 'is-single' : ''}`}>
      <div className="image-grid">
        {assets.map((asset) => <JobCard
          key={asset.id}
          asset={asset}
          referenceImages={asset.referenceImageIds.flatMap((id) => props.imagesById.get(id) ? [props.imagesById.get(id)!] : [])}
          selected={Boolean(asset.imageId && props.selectedImageIds.has(asset.imageId))}
          onOpen={props.onOpenImage}
          onToggle={props.onToggleSelected}
          onContextMenu={props.onImageContextMenu}
          onDetails={() => setDetailAssetId(asset.id)}
          onRetry={() => props.onRetry(asset)}
        />)}
      </div>
      {assets.length === 0 ? <EmptyState title="这个批次还没有图片" copy="请从 Agent 向这个批次追加任务。" /> : null}
    </section>
    <form className="modify-composer" onSubmit={(event) => {
      event.preventDefault();
      if (!prompt.trim() || !targetIds.length) return;
      void props.onModify({
        batchId: batch.id,
        imageIds: targetIds,
        prompt,
        offeringId: offering.id,
        requestKey: crypto.randomUUID(),
      }).then((accepted) => { if (accepted) setPrompt(''); });
    }}>
      {targetIds.length ? <div className="composer-attachments">{targetIds.map((id) => {
        const image = props.imagesById.get(id);
        return image ? <button key={id} type="button" title="移除这张图片" onClick={() => props.onToggleSelected(id)}><img src={image.mediaUrl} alt="" /><X size={11} /></button> : null;
      })}</div> : null}
      <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }} placeholder={selectable.length > 1 && !targetIds.length ? '双击选择想要编辑的图片' : '描述你想如何修改图片'} maxLength={20_000} />
      <div className="modify-toolbar">
        <label className="model-select"><Lightning size={14} weight="fill" /><select value={offeringId} onChange={(event) => setOfferingId(event.target.value)}>{props.offerings.map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.providerName}</option>)}</select><CaretDown size={12} /></label>
        <div className="composer-actions">
          {active ? <button type="button" className="subtle-button" disabled={props.busy || !batch.queued} onClick={() => void props.onCancel()}>取消排队</button> : null}
          <button className="primary-button" disabled={props.busy || !prompt.trim() || !targetIds.length}>提交修改</button>
        </div>
      </div>
    </form>
    {detailAsset ? <TaskDetailDialog asset={detailAsset} imagesById={props.imagesById} onClose={() => setDetailAssetId(undefined)} /> : null}
  </div>;
}

function JobCard(props: { asset: GalleryAsset; referenceImages: SavedImage[]; selected: boolean; onOpen: (id: string) => void; onToggle: (id: string) => void; onContextMenu: (event: React.MouseEvent, id: string) => void; onDetails: () => void; onRetry: () => Promise<boolean> }) {
  const { asset } = props;
  const { job, image } = asset;
  const pending = asset.kind === 'job' && (job.status === 'running' || job.status === 'queued');
  const peekId = useId();
  const [peekPosition, setPeekPosition] = useState<PeekPosition>();
  const peekOpenTimer = useRef<number | undefined>(undefined);
  const peekCloseTimer = useRef<number | undefined>(undefined);
  const cancelPeekOpen = () => {
    if (peekOpenTimer.current !== undefined) window.clearTimeout(peekOpenTimer.current);
    peekOpenTimer.current = undefined;
  };
  const keepPeekOpen = () => {
    if (peekCloseTimer.current !== undefined) window.clearTimeout(peekCloseTimer.current);
    peekCloseTimer.current = undefined;
  };
  const closePeekSoon = () => {
    cancelPeekOpen();
    keepPeekOpen();
    peekCloseTimer.current = window.setTimeout(() => setPeekPosition(undefined), 140);
  };
  const showPeek = (element: HTMLElement) => {
    if (!pending) return;
    cancelPeekOpen();
    keepPeekOpen();
    const rect = element.getBoundingClientRect();
    setPeekPosition(pendingTaskPeekPosition(rect, { width: window.innerWidth, height: window.innerHeight }));
  };
  const schedulePeek = (element: HTMLElement) => {
    if (!pending) return;
    cancelPeekOpen();
    keepPeekOpen();
    peekOpenTimer.current = window.setTimeout(() => showPeek(element), PENDING_TASK_HOVER_DELAY_MS);
  };
  useEffect(() => {
    if (!peekPosition) return;
    const close = () => setPeekPosition(undefined);
    window.addEventListener('resize', close);
    return () => window.removeEventListener('resize', close);
  }, [peekPosition]);
  useEffect(() => () => {
    cancelPeekOpen();
    keepPeekOpen();
  }, []);
  useEffect(() => {
    if (!pending) {
      cancelPeekOpen();
      keepPeekOpen();
      setPeekPosition(undefined);
    }
  }, [pending]);
  return <article
    className={`image-card ${props.selected ? 'is-selected' : ''} is-${asset.kind === 'backup' ? 'backup' : job.status}`}
    data-pending-task={pending ? 'true' : undefined}
    tabIndex={pending ? 0 : undefined}
    aria-label={pending ? `${asset.name}${job.status === 'queued' ? '等待中' : '生成中'}。提示词：${asset.prompt}。参考图 ${props.referenceImages.length} 张。` : undefined}
    aria-describedby={peekPosition ? peekId : undefined}
    onPointerEnter={(event) => schedulePeek(event.currentTarget)}
    onPointerLeave={closePeekSoon}
    onFocus={(event) => showPeek(event.currentTarget)}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { cancelPeekOpen(); setPeekPosition(undefined); } }}
  >
    <button className="image-card-stage" disabled={!image} onClick={() => image && props.onOpen(image.id)} onDoubleClick={(event) => { event.preventDefault(); if (image) props.onToggle(image.id); }} onContextMenu={(event) => image && props.onContextMenu(event, image.id)}>
      {pending ? <ProcessingPreview images={props.referenceImages} prompt={asset.prompt} /> : image ? <img src={image.mediaUrl} alt={asset.prompt} /> : <JobPlaceholder prompt={asset.prompt} failed={job.status === 'failed'} />}
      <span className="image-name">{asset.name}</span>
      {props.selected ? <span className="selected-check"><Check size={13} weight="bold" /></span> : null}
      {pending ? <span className="status-overlay"><span className="spinner" />{job.status === 'queued' ? '等待中' : `生成中 ${Math.max(1, job.progress)}%`}</span> : null}
    </button>
    <div className="card-meta"><span>{asset.kind === 'backup' ? '历史版本' : job.status === 'succeeded' ? asset.offering.displayName : statusText(job.status)}</span><div className="card-tools"><button title="任务详情" onClick={props.onDetails}><Info size={14} /></button>{image ? <button title="另存为" onClick={() => void window.esse.saveImage(image.id)}><DownloadSimple size={14} /></button> : null}</div></div>
    {asset.kind === 'job' && job.status === 'failed' ? <div className="job-error"><p><span className="error-origin">{jobErrorOriginLabel(job, asset.offering.providerName)}</span>{job.error || '生成失败'}</p>{job.operation !== 'agent' ? <button onClick={() => void props.onRetry()}>重试</button> : <span>需由 Agent 重新发起</span>}</div> : null}
    {pending && peekPosition ? createPortal(<PendingTaskPeek id={peekId} prompt={asset.prompt} images={props.referenceImages} position={peekPosition} onPointerEnter={keepPeekOpen} onPointerLeave={closePeekSoon} />, document.body) : null}
  </article>;
}

function PendingTaskPeek({ id, prompt, images, position, onPointerEnter, onPointerLeave }: { id: string; prompt: string; images: SavedImage[]; position: PeekPosition; onPointerEnter: () => void; onPointerLeave: () => void }) {
  return <aside id={id} className="pending-task-peek" role="tooltip" data-placement={position.placement} style={{ left: position.left, top: position.top }} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
    <div className="pending-task-peek-heading"><strong>提示词</strong>{images.length ? <span>{images.length} 张参考图</span> : <span>无参考图</span>}</div>
    <p>{prompt}</p>
    {images.length ? <div className="pending-task-references">{images.slice(0, 4).map((image) => <img key={image.id} src={image.mediaUrl} alt={image.sourceFileName || image.fileName} />)}{images.length > 4 ? <span>另有 {images.length - 4} 张</span> : null}</div> : null}
  </aside>;
}

function ProcessingPreview({ images, prompt }: { images: SavedImage[]; prompt: string }) {
  if (!images.length) return <JobPlaceholder prompt={prompt} failed={false} />;
  return <div className={`processing-preview count-${Math.min(images.length, 4)}`}>{images.slice(0, 4).map((image) => <img key={image.id} src={image.mediaUrl} alt="参考图" />)}<span className="processing-tint" /></div>;
}

function JobPlaceholder({ prompt, failed }: { prompt: string; failed: boolean }) {
  return <div className="job-placeholder"><ImageSquare size={30} /><strong>{failed ? '未生成图片' : 'Esse 正在处理'}</strong><span>{prompt}</span></div>;
}

function TaskDetailDialog({ asset, imagesById, onClose }: { asset: GalleryAsset; imagesById: Map<string, SavedImage>; onClose: () => void }) {
  const [metadata, setMetadata] = useState<ImageMetadata>({ available: false });
  const { job } = asset;
  useEffect(() => {
    let active = true;
    if (!asset.imageId) { setMetadata({ available: false }); return; }
    void window.esse.getImageMetadata(asset.imageId).then((next) => { if (active) setMetadata(next); });
    return () => { active = false; };
  }, [asset.imageId]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  const references = asset.referenceImageIds.flatMap((id) => imagesById.get(id) ? [imagesById.get(id)!] : []);
  return <div className="task-detail-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="task-detail-dialog" role="dialog" aria-modal="true" aria-label={`${asset.name}任务详情`}>
      <header><div><span>{asset.kind === 'backup' ? '历史版本' : '任务详情'}</span><h2>{asset.name}</h2></div><button onClick={onClose} aria-label="关闭"><X size={17} /></button></header>
      <div className="detail-summary">
        <div><span>状态</span><strong>{asset.kind === 'backup' ? '已保留' : statusText(job.status)}</strong></div>
        <div><span>模型</span><strong>{asset.offering.displayName}</strong></div>
        <div><span>单价</span><strong>{offeringPriceLabel(asset.offering)}</strong></div>
        <div><span>调用</span><strong>{job.callHistory.length} 次</strong></div>
        {metadata.available ? <><div><span>尺寸</span><strong>{metadata.width} × {metadata.height}</strong></div><div><span>文件</span><strong>{formatBytes(metadata.sizeBytes || 0)}</strong></div></> : null}
      </div>
      <div className="detail-section"><h3>提示词</h3><p>{asset.prompt}</p></div>
      {references.length ? <div className="detail-section"><h3>参考图片 · {references.length}</h3><div className="detail-reference-grid">{references.map((image) => <figure key={image.id}><img src={image.mediaUrl} alt={image.sourceFileName || image.fileName} /><figcaption title={image.sourceFileName || image.fileName}>{image.sourceFileName || image.fileName}</figcaption></figure>)}</div></div> : null}
      <div className="detail-section"><h3>调用记录</h3>{job.callHistory.length ? <div className="call-history">{job.callHistory.map((call, index) => <article key={call.id}>
        <div><strong>#{call.sequence || index + 1} · {call.status === 'succeeded' ? '成功' : call.status === 'failed' ? '失败' : call.status === 'running' ? '进行中' : '已取消'}</strong><span>{callSourceLabel(call.source, call.offering?.providerName || asset.offering.providerName)}</span></div>
        <dl><dt>模型</dt><dd>{call.offering?.displayName || asset.offering.displayName}</dd><dt>扣费</dt><dd>{chargeText(call.chargeState)}</dd><dt>耗时</dt><dd>{formatDuration(call.durationMs)}</dd><dt>开始</dt><dd>{new Date(call.startedAt).toLocaleString()}</dd>{call.requestId ? <><dt>Request ID</dt><dd><code>{call.requestId}</code></dd></> : null}</dl>
        {call.error ? <p className="call-error"><span className="error-origin">{errorOriginLabel({ origin: call.errorOrigin, source: call.source, providerName: call.offering?.providerName || asset.offering.providerName, showProviderIdentity: product.errorAttribution.showProviderIdentity })}</span>{call.error}</p> : null}
      </article>)}</div> : <p className="detail-muted">尚未调用模型。</p>}</div>
    </section>
  </div>;
}

function BatchLibrary(props: {
  batches: BatchSnapshot[];
  imagesById: Map<string, SavedImage>;
  busy: boolean;
  onOpen: (id: string) => void;
  onRetry: (batch: BatchSnapshot, jobIds: string[], includesUnknownCharge: boolean) => Promise<boolean>;
}) {
  const [query, setQuery] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const groups = useMemo(() => filterAndGroupBatches(props.batches, { query, from, to }), [from, props.batches, query, to]);
  const hasFilters = Boolean(query.trim() || from || to);
  const hasMatches = groups.recent.length + groups.older.length > 0;
  const clearFilters = () => { setQuery(''); setFrom(''); setTo(''); };

  return <section className="library-page">
    <div className="library-toolbar">
      <div className="library-search">
        <MagnifyingGlass size={16} aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索批次" aria-label="按中文模糊搜索批次" />
        {query ? <button type="button" onClick={() => setQuery('')} aria-label="清除搜索"><X size={13} /></button> : null}
      </div>
      <button type="button" className={filterOpen || from || to ? 'library-filter-trigger is-active' : 'library-filter-trigger'} onClick={() => setFilterOpen((open) => !open)} aria-expanded={filterOpen} aria-controls="batch-date-filter"><FunnelSimple size={15} /><span>日期</span></button>
    </div>
    {filterOpen ? <div className="library-filter-panel" id="batch-date-filter">
      <CalendarBlank size={17} aria-hidden="true" />
      <label><span>从</span><input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} /></label>
      <span className="date-range-separator" aria-hidden="true">—</span>
      <label><span>至</span><input type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} /></label>
      {from || to ? <button type="button" className="library-clear-dates" onClick={() => { setFrom(''); setTo(''); }}>清除日期</button> : null}
    </div> : null}
    {props.batches.length && hasMatches ? <>
      {groups.recent.length ? <BatchLibraryGroup {...props} batches={groups.recent} recent /> : null}
      {groups.recent.length && groups.older.length ? <div className="batch-library-divider" role="separator" /> : null}
      {groups.older.length ? <BatchLibraryGroup {...props} batches={groups.older} recent={false} /> : null}
    </> : props.batches.length ? <div className="library-empty-filter"><MagnifyingGlass size={20} /><strong>没有符合条件的批次</strong>{hasFilters ? <button type="button" onClick={clearFilters}>清除筛选</button> : null}</div> : <EmptyState title="还没有图片批次" copy="请从 Agent 向 Esse 提交第一个图片任务。" />}
  </section>;
}

function BatchLibraryGroup(props: {
  batches: BatchSnapshot[];
  imagesById: Map<string, SavedImage>;
  busy: boolean;
  recent: boolean;
  onOpen: (id: string) => void;
  onRetry: (batch: BatchSnapshot, jobIds: string[], includesUnknownCharge: boolean) => Promise<boolean>;
}) {
  return <div className={`batch-library-group ${props.recent ? 'is-recent' : ''}`}>
    <div className="batch-library-grid">{props.batches.map((batch) => <BatchLibraryCard key={batch.id} {...props} batch={batch} />)}</div>
  </div>;
}

function BatchLibraryCard(props: {
  batch: BatchSnapshot;
  imagesById: Map<string, SavedImage>;
  busy: boolean;
  recent: boolean;
  onOpen: (id: string) => void;
  onRetry: (batch: BatchSnapshot, jobIds: string[], includesUnknownCharge: boolean) => Promise<boolean>;
}) {
  const { batch } = props;
  const previews = batch.jobs.flatMap((job) => job.outputImageId ? [props.imagesById.get(job.outputImageId)] : []).filter(Boolean) as SavedImage[];
  const state = batchLibraryState(batch);
  const progress = batchLibraryProgress(batch);
  const retrySelection = retryAllFailedSelection(batch);
  const status = batchLibraryStatusLabel(state);
  return <article className={`batch-library-card is-${state} ${props.recent ? 'is-recent' : ''}`}>
    <button type="button" className="batch-library-open" onClick={() => props.onOpen(batch.id)}>
      <div className={`batch-thumbs count-${Math.min(3, previews.length)}`} style={{ '--batch-progress': `${progress.percent}%` } as React.CSSProperties}>
        {previews.slice(0, 3).map((image) => <span className="batch-thumb-cell" key={image.id}><img src={image.mediaUrl} alt="" /></span>)}
        {!previews.length ? <span className="batch-thumb-cell empty-thumb"><ImageSquare size={22} /></span> : null}
        <span className="batch-state-mask">
          <span className="batch-state-label">{state === 'active' ? <span className="spinner" /> : state === 'error' ? <WarningCircle size={16} weight="fill" /> : <CheckCircle size={16} weight="fill" />}<strong>{status}</strong></span>
        </span>
        <span className="batch-progress-track" aria-hidden="true"><i /></span>
      </div>
      <div className="batch-library-copy">
        <strong title={batch.title}>{batch.title}</strong>
        <span>{batch.offering.displayName}</span>
        <div className="batch-progress-copy"><strong>{progress.current} / {progress.total}</strong><span>{status}</span><time dateTime={batch.updatedAt}>{formatLibraryDate(batch.updatedAt)}</time></div>
      </div>
    </button>
    {state === 'error' && retrySelection.jobIds.length ? <button type="button" className="batch-library-retry" disabled={props.busy} onClick={() => void props.onRetry(batch, retrySelection.jobIds, retrySelection.includesUnknownCharge)} aria-label={`重试“${batch.title}”的所有失败任务`} title="重试所有失败任务"><ArrowClockwise size={15} weight="bold" /></button> : null}
  </article>;
}

function batchLibraryStatusLabel(state: BatchLibraryState): string {
  if (state === 'active') return '进行中';
  if (state === 'error') return '完成有错';
  return '已完成';
}

function formatLibraryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) {
    return `今日 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  }
  return date.toLocaleDateString('zh-CN', { year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric', month: 'numeric', day: 'numeric' });
}

function Settings(props: { state: DesktopState; busy: boolean; apply: (action: () => Promise<DesktopState>, success?: string) => Promise<boolean>; onNotice: (message?: string) => void }) {
  const [draft, setDraft] = useState<ProviderDraft>(() => props.state.providers[0] ? providerDraftFromProfile(props.state.providers[0]) : createTuziProviderDraft('tuzi-default'));
  const [busyAction, setBusyAction] = useState<string>();
  const [models, setModels] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const activePreset = tuziProviderPresetForDraft(draft);
  const configuredPresetIds = new Set(props.state.providers.flatMap((profile) => {
    const preset = tuziProviderPresetForDraft(providerDraftFromProfile(profile));
    return preset ? [preset.id] : [];
  }));

  useEffect(() => {
    const saved = draft.id
      ? props.state.providers.find((profile) => profile.id === draft.id)
      : props.state.providers.find((profile) => profile.displayName === draft.displayName && profile.tierName === draft.tierName);
    if (saved && !draft.id) setDraft(providerDraftFromProfile(saved));
  }, [props.state.providers]);

  const updateOffering = (index: number, patch: Partial<OfferingConfig>) => setDraft((current) => ({
    ...current,
    offerings: current.offerings.map((offering, offeringIndex) => offeringIndex === index ? { ...offering, ...patch } : offering),
  }));

  const startDraft = (choice: string) => {
    const preset = TUZI_PROVIDER_PRESETS.find((entry) => entry.id === choice);
    setDraft(preset ? createTuziProviderDraft(preset.id) : createCustomProviderDraft());
    setModels([]);
    setConfirmDelete(false);
  };

  const addOffering = (choice: string) => {
    const presetModel = activePreset?.models.find((entry) => entry.catalogId === choice);
    setDraft((current) => ({ ...current, offerings: [...current.offerings, presetModel ? offeringFromTuziModel(presetModel) : blankOffering()] }));
  };

  const save = async () => {
    setBusyAction('save');
    try {
      const saved = await props.apply(() => window.esse.saveProvider(providerSavePayload(draft)), 'Provider 配置已保存在本机；API Key 不会进入 Agent 上下文');
      if (saved && draft.id) setDraft((current) => ({ ...current, apiKey: '', hasApiKey: current.hasApiKey || Boolean(current.apiKey.trim()) }));
    } finally { setBusyAction(undefined); }
  };

  const test = async () => {
    setBusyAction('test');
    try {
      const result = await window.esse.testProvider({ baseUrl: draft.baseUrl, profileId: draft.id, apiKey: draft.apiKey || undefined });
      setModels(result.models);
      props.onNotice(`连接成功，发现 ${result.models.length} 个模型`);
    } catch (error) { props.onNotice(cleanError(error)); }
    finally { setBusyAction(undefined); }
  };

  const remove = async () => {
    if (!draft.id) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setBusyAction('delete');
    try {
      await props.apply(() => window.esse.deleteProvider(draft.id!), 'Provider 配置和对应的本地密钥已删除');
      setDraft(createTuziProviderDraft('tuzi-default'));
    } finally { setBusyAction(undefined); setConfirmDelete(false); }
  };

  const availableOfferings = props.state.offerings.filter((offering) => offering.configured);
  return <section className="provider-settings-layout">
    <div className="default-model-panel">
      <div><strong>默认模型</strong><span>Agent 未明确指定模型时使用</span></div>
      <select value={props.state.defaultOfferingId || ''} disabled={!availableOfferings.length || props.busy} onChange={(event) => void props.apply(() => window.esse.setDefaultOffering(event.target.value), '默认模型已更新')}>
        {!props.state.defaultOfferingId ? <option value="">请选择默认模型</option> : null}
        {availableOfferings.map((offering) => <option key={offering.id} value={offering.id}>{offering.displayName} · {offering.providerType === 'agent-generation' ? offering.providerName : `${offering.providerName}/${offering.tierName}`}</option>)}
      </select>
    </div>

    <aside className="provider-list">
      <div className="provider-list-heading"><strong>Provider</strong><label className="compact-add"><Plus size={14} /><select value="" aria-label="添加 Provider" onChange={(event) => { if (event.target.value) startDraft(event.target.value); event.target.value = ''; }}><option value="">添加</option>{TUZI_PROVIDER_PRESETS.map((preset) => <option key={preset.id} value={preset.id} disabled={configuredPresetIds.has(preset.id)}>{preset.label}{configuredPresetIds.has(preset.id) ? '（已配置）' : ''}</option>)}<option value="custom">自定义</option></select></label></div>
      {!props.state.providers.length ? <div className="empty-mini">尚未配置 Provider</div> : null}
      {props.state.providers.map((profile) => <button key={profile.id} className={`provider-item ${draft.id === profile.id ? 'is-active' : ''}`} onClick={() => { setDraft(providerDraftFromProfile(profile)); setModels([]); setConfirmDelete(false); }}><span className="provider-avatar">{profile.displayName.slice(0, 1)}</span><span><strong>{profile.displayName}</strong><small>{profile.tierName} · {adapterDisplayName(profile.adapterId)}</small></span><i className={profile.hasApiKey ? 'status-ok' : 'status-missing'} /></button>)}
      <div className="secure-note"><LockSimple size={14} /><span>{props.state.secureStorage}</span></div>
      <div className="mcp-settings"><strong>Agent MCP</strong><code>{props.state.mcp.endpoint}</code><button className="subtle-button" disabled={!props.state.mcp.available} onClick={() => void window.esse.copyAgentSetupPrompt().then(() => { setCopied(true); props.onNotice('已复制 Agent 配置提示词，粘贴后直接发送即可'); window.setTimeout(() => setCopied(false), 2400); })}><Copy size={14} />{copied ? '已复制' : '复制给 Agent'}</button></div>
    </aside>

    <div className="provider-editor">
      <header><h1>{draft.displayName || 'Provider'} · {draft.tierName || '档位'}</h1></header>
      {activePreset ? <div className="preset-config-banner"><strong>预制配置 · {activePreset.label}</strong><span>接口与模型已填好；目录价格记录于 2026-07-19，请以 Provider 当前价格为准。每个分组独立保存 API Key。</span></div> : null}
      <section className="provider-form-section"><h2>连接</h2><div className="form-grid">
        <Field label="服务商名称"><input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field>
        <Field label="档位名称"><input value={draft.tierName} onChange={(event) => setDraft({ ...draft, tierName: event.target.value })} /></Field>
        <Field label="API 地址" wide><input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></Field>
        <Field label="接口格式"><select value={draft.adapterId} onChange={(event) => setDraft({ ...draft, adapterId: event.target.value as ProviderDraft['adapterId'] })}><option value="tuzi-json-images">兔子 JSON Images</option><option value="openai-images">OpenAI Images</option></select></Field>
        <Field label="并发数"><input type="number" min="1" max="12" value={draft.concurrency} onChange={(event) => setDraft({ ...draft, concurrency: Number(event.target.value) })} /></Field>
        <Field label="API Key" wide hint={draft.hasApiKey ? '留空保留现有密钥' : '只保存在当前系统用户的安全存储中'}><div className="secret-input"><input type="password" autoComplete="off" placeholder={draft.hasApiKey ? '•••••••• 已安全保存' : '粘贴 API Key'} value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /><button type="button" onClick={() => void test()} disabled={Boolean(busyAction) || !draft.baseUrl || (!draft.hasApiKey && !draft.apiKey.trim())}>{busyAction === 'test' ? '测试中…' : '测试连接'}</button></div></Field>
      </div></section>

      {models.length && !activePreset ? <div className="models-found"><strong>已发现模型</strong><div>{models.slice(0, 20).map((model) => <button key={model} onClick={() => updateOffering(0, { providerModelId: model, canonicalModelId: model, displayName: model })}>{model}</button>)}</div></div> : null}

      <section className="provider-form-section models-section"><div className="offerings-heading"><span><strong>模型</strong>{activePreset ? <small>价格仅供参考</small> : null}</span><label className="compact-add"><Plus size={14} /><select value="" aria-label="添加模型" onChange={(event) => { if (event.target.value) addOffering(event.target.value); event.target.value = ''; }}><option value="">添加</option>{activePreset?.models.map((model) => <option key={model.catalogId} value={model.catalogId} disabled={draft.offerings.some((offering) => offering.providerModelId === model.providerModelId)}>{model.displayName}</option>)}<option value="custom">自定义</option></select></label></div>
        <div className="offering-list">{draft.offerings.map((offering, index) => <article className="offering-editor" key={offering.id || index}><span className="offering-number">{String(index + 1).padStart(2, '0')}</span><div className="offering-fields">
          <Field label="显示名称"><input value={offering.displayName} onChange={(event) => updateOffering(index, { displayName: event.target.value })} /></Field>
          <Field label="服务商模型 ID"><input value={offering.providerModelId} onChange={(event) => updateOffering(index, { providerModelId: event.target.value })} /></Field>
          <Field label="标准模型 ID"><input value={offering.canonicalModelId} onChange={(event) => updateOffering(index, { canonicalModelId: event.target.value })} /></Field>
          <Field label="计费"><div className="price-row"><select value={offering.price.mode} onChange={(event) => updateOffering(index, { price: { ...offering.price, mode: event.target.value as OfferingConfig['price']['mode'] } })}><option value="per_request">按次</option><option value="token">按 Token</option><option value="unknown">未知</option></select><input type="number" step="0.001" placeholder="价格" value={offering.price.amount ?? ''} onChange={(event) => updateOffering(index, { price: { ...offering.price, amount: event.target.value ? Number(event.target.value) : undefined } })} /><input className="currency" value={offering.price.currency} onChange={(event) => updateOffering(index, { price: { ...offering.price, currency: event.target.value } })} /></div></Field>
        </div>{draft.offerings.length > 1 ? <button className="remove-offering" onClick={() => setDraft((current) => ({ ...current, offerings: current.offerings.filter((_, offeringIndex) => offeringIndex !== index) }))}><Trash size={14} /></button> : null}</article>)}</div>
      </section>
      <footer className="provider-actions"><div>{draft.id ? <button className={`subtle-button is-danger ${confirmDelete ? 'confirm' : ''}`} onClick={() => void remove()} disabled={Boolean(busyAction)}>{confirmDelete ? '再次点击确认删除' : '删除配置'}</button> : null}</div><button className="primary-button" onClick={() => void save()} disabled={Boolean(busyAction) || !draft.displayName || !draft.baseUrl || (!draft.id && !draft.apiKey.trim()) || draft.offerings.some((offering) => !offering.providerModelId)}>{busyAction === 'save' ? '保存中…' : '保存'}</button></footer>
    </div>
  </section>;
}

function Field(props: { label: string; wide?: boolean; hint?: string; children: React.ReactNode }) {
  return <label className={`provider-field ${props.wide ? 'wide' : ''}`}><span><strong>{props.label}</strong>{props.hint ? <small>{props.hint}</small> : null}</span>{props.children}</label>;
}

function providerDraftFromProfile(profile: ProviderProfile): ProviderDraft {
  return { id: profile.id, displayName: profile.displayName, tierName: profile.tierName, baseUrl: profile.baseUrl, adapterId: profile.adapterId, concurrency: profile.concurrency, offerings: profile.offerings.map((offering) => structuredClone(offering)), apiKey: '', hasApiKey: profile.hasApiKey };
}

function providerSavePayload(draft: ProviderDraft): SaveProviderInput {
  const baseUrl = draft.baseUrl.trim();
  try { new URL(baseUrl); } catch { throw new Error('请填写有效的 API 地址。'); }
  return { ...(draft.id ? { id: draft.id } : {}), displayName: draft.displayName.trim(), tierName: draft.tierName.trim(), baseUrl, adapterId: draft.adapterId, concurrency: Math.max(1, Math.min(12, Math.trunc(draft.concurrency || 1))), ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}), offerings: draft.offerings.map((offering) => structuredClone(offering)) };
}

function adapterDisplayName(adapterId: ProviderDraft['adapterId']): string {
  return adapterId === 'tuzi-json-images' ? '兔子 JSON Images' : 'OpenAI Images';
}

function ImageContextMenu(props: { batchId: string; imageId: string; x: number; y: number; selected: boolean; onToggle: () => void; onClose: () => void; onNotice: (message: string) => void; onDelete: () => Promise<void> }) {
  const run = async (action: () => Promise<unknown>, success?: string) => {
    props.onClose();
    try {
      await action();
      if (success) props.onNotice(success);
    } catch (cause) {
      props.onNotice(cleanError(cause));
    }
  };
  return <div className="image-context-menu" style={{ left: props.x, top: props.y }} role="menu">
    <button onClick={() => { props.onToggle(); props.onClose(); }}><Check size={15} />{props.selected ? '取消选择' : '选择图片'}</button>
    <span className="menu-separator" />
    <button onClick={() => void run(() => window.esse.copyImage(props.imageId), '图片已复制到剪贴板')}><Copy size={15} />复制图片</button>
    <button onClick={() => void run(() => window.esse.copyImageId(props.batchId, props.imageId), '已复制图片 ID')}><Copy size={15} />复制图片 ID</button>
    <button onClick={() => void run(() => window.esse.saveImage(props.imageId))}><DownloadSimple size={15} />另存为</button>
    <button onClick={() => void run(() => window.esse.revealImage(props.imageId))}><FolderSimple size={15} />在文件夹中显示</button>
    <span className="menu-separator" />
    <button className="is-danger" onClick={() => void props.onDelete()}><Trash size={15} />删除图片</button>
  </div>;
}

function ImageViewer({ image, images, onNavigate, onClose, onNotice, onDelete }: { image: SavedImage; images: SavedImage[]; onNavigate: (id: string) => void; onClose: () => void; onNotice: (message: string) => void; onDelete: () => Promise<void> }) {
  const [zoom, setZoom] = useState(initialImageZoom);
  const stageRef = useRef<HTMLDivElement>(null);
  const index = Math.max(0, images.findIndex((candidate) => candidate.id === image.id));
  const navigate = (offset: number) => {
    if (images.length < 2) return;
    onNavigate(images[(index + offset + images.length) % images.length].id);
  };
  useEffect(() => setZoom(initialImageZoom), [image.id]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft') navigate(-1);
      if (event.key === 'ArrowRight') navigate(1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });
  return <div className="lightbox" role="dialog" aria-modal="true" onPointerDown={(event) => {
    if (shouldDismissOverlay(event.target, 'button, img, .lightbox-caption')) onClose();
  }}>
    <button className="lightbox-close" onClick={onClose} aria-label="关闭预览" title="关闭预览"><X size={18} /></button>
    {images.length > 1 ? <><button className="lightbox-nav is-previous" onClick={() => navigate(-1)} aria-label="上一张"><CaretLeft size={22} /></button><button className="lightbox-nav is-next" onClick={() => navigate(1)} aria-label="下一张"><CaretRight size={22} /></button></> : null}
    <div ref={stageRef} className={`lightbox-stage ${zoom.scale > 1 ? 'is-zoomed' : ''}`} onWheel={(event) => {
      event.preventDefault();
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      setZoom((current) => zoomImageAtPoint(current, event.deltaY, event.clientX - (rect.left + rect.width / 2), event.clientY - (rect.top + rect.height / 2), event.deltaMode, rect.height));
    }} onDoubleClick={() => setZoom(initialImageZoom)}>
      <img src={image.mediaUrl} alt={image.prompt} style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }} />
    </div>
    <div className="lightbox-caption"><strong>{image.fileName}</strong><span>{image.model} · {index + 1}/{Math.max(1, images.length)} · {Math.round(zoom.scale * 100)}%</span><button onClick={() => void window.esse.openImage(image.id)} title="打开原图"><ArrowsOutSimple size={16} /></button><button onClick={() => void window.esse.copyImage(image.id).then(() => onNotice('图片已复制到剪贴板'))} title="复制图片"><Copy size={16} /></button><button onClick={() => void window.esse.saveImage(image.id)} title="另存为"><DownloadSimple size={16} /></button><button onClick={() => void window.esse.revealImage(image.id)} title="在文件夹中显示"><FolderSimple size={16} /></button><button className="is-danger" onClick={() => void onDelete()} title="删除图片"><Trash size={16} /></button><button className="lightbox-caption-close" onClick={onClose} aria-label="关闭预览" title="关闭预览"><X size={16} /></button></div>
  </div>;
}

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return <div className="empty-state"><div className="empty-art"><ImageSquare size={26} /></div><h1>{title}</h1><p>{copy}</p></div>;
}

function WindowTitlebar() {
  if (window.esse.platform !== 'win32') return null;
  return <div className="window-titlebar" aria-hidden="true"><img src={esseIconUrl} alt="" /><span>{windowTitle}</span></div>;
}

function isTerminal(batch: BatchSnapshot) { return batch.queued === 0 && batch.running === 0; }
function statusLabel(batch: BatchSnapshot) { if (batch.running) return `${batch.running}个生成中`; if (batch.queued) return `${batch.queued}个等待中`; if (batch.failed) return batch.succeeded ? `${batch.succeeded}成功 · ${batch.failed}失败` : `${batch.failed}个失败`; return `${batch.succeeded}张图片`; }
function statusText(status: BatchSnapshot['jobs'][number]['status']) { return ({ queued: '等待中', running: '生成中', succeeded: '已完成', failed: '失败', canceled: '已取消' })[status]; }
function chargeText(state: BatchSnapshot['jobs'][number]['chargeState']) { return ({ charged: '已扣费', not_charged: '未扣费', unknown: '待复核' })[state]; }
function jobErrorOriginLabel(job: BatchSnapshot['jobs'][number], providerName: string) { return errorOriginLabel({ origin: job.errorOrigin, source: job.operation === 'agent' ? 'agent' : 'provider', providerName, showProviderIdentity: product.errorAttribution.showProviderIdentity }); }
function callSourceLabel(source: 'provider' | 'agent' | undefined, providerName: string) { if (source === 'agent') return 'Agent'; return product.errorAttribution.showProviderIdentity ? providerName : '图片服务'; }
function formatDuration(value?: number) { if (value === undefined) return '—'; return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`; }
function formatBytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`; return `${(value / 1024 ** 2).toFixed(1)} MB`; }
function uniqueImages(images: SavedImage[]) { return [...new Map(images.map((image) => [image.id, image])).values()]; }
function offeringPriceLabel(offering: OfferingSummary): string { return offering.price.mode === 'per_request' && Number.isFinite(offering.price.amount) ? `${offering.currency === 'CNY' ? '¥' : `${offering.currency} `}${formatCny(offering.priceMicros)}` : '—'; }
function formatCny(micros: number): string { return (micros / 1_000_000).toFixed(2); }
function cleanError(value: unknown): string { return (value instanceof Error ? value.message : String(value)).replace(/^Error invoking remote method '[^']+': Error: /, ''); }

const root = document.getElementById('root');
if (!root) throw new Error('Renderer root is missing.');
createRoot(root).render(<React.StrictMode><WindowTitlebar /><App /></React.StrictMode>);
