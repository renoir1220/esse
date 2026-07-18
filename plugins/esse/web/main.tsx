import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { bridge } from "./bridge";
import type { BatchSnapshot, JobBackupSnapshot, JobSnapshot, OfferingConfig, ProviderProfile, ToolResult, WorkbenchState } from "./types";
import "./styles.css";

type Tab = "batches" | "settings";
type ProviderDraft = Omit<ProviderProfile, "id" | "hasApiKey" | "createdAt" | "updatedAt"> & { id?: string; apiKey: string; hasApiKey: boolean };

function initialState(): WorkbenchState {
  const direct = window.__ESSE_PREVIEW__ || window.openai?.toolOutput?.state;
  if (direct) return direct;
  const batch = window.openai?.toolOutput?.batch;
  return {
    view: { tab: batch ? "batches" : "settings", batchId: batch?.id },
    providers: [],
    offerings: [],
    batches: batch ? [batch] : [],
    activeBatch: batch,
    platform: "unknown",
    secureStorage: "Local secure storage"
  };
}

function App() {
  const [state, setState] = useState<WorkbenchState>(initialState);
  const [tab, setTab] = useState<Tab>(() => window.openai?.widgetState?.tab || initialState().view.tab);
  const [activeBatchId, setActiveBatchId] = useState<string | undefined>(() => window.openai?.widgetState?.batchId || initialState().view.batchId || initialState().activeBatch?.id || initialState().batches[0]?.id);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(window.openai?.widgetState?.selectedJobIds || []));
  const [modificationRequest, setModificationRequest] = useState(() => window.openai?.widgetState?.modificationRequest || "");
  const [displayMode, setDisplayMode] = useState(window.openai?.displayMode || "inline");
  const [notice, setNotice] = useState<string>();
  const isPreview = Boolean(window.__ESSE_PREVIEW__);

  const applyResult = useCallback((result: ToolResult) => {
    if (result.structuredContent?.state) {
      setState(result.structuredContent.state);
      setActiveBatchId(result.structuredContent.state.activeBatch?.id || result.structuredContent.state.batches[0]?.id);
      return;
    }
    const batch = result.structuredContent?.batch;
    if (batch) {
      setState((current) => ({
        ...current,
        batches: [batch, ...current.batches.filter((entry) => entry.id !== batch.id)],
        activeBatch: batch,
        view: { tab: "batches", batchId: batch.id }
      }));
      setActiveBatchId(batch.id);
      setTab("batches");
    }
  }, []);

  useEffect(() => bridge.subscribe(applyResult), [applyResult]);

  useEffect(() => {
    if (isPreview) return;
    void bridge.callTool("ui_get_local_state", { batchId: activeBatchId }).then(applyResult).catch((error) => setNotice(errorMessage(error)));
  }, []);

  useEffect(() => {
    const listener = (event: Event) => {
      const globals = (event as CustomEvent<{ globals?: { displayMode?: "inline" | "pip" | "fullscreen"; theme?: "light" | "dark" } }>).detail?.globals;
      if (globals?.displayMode) setDisplayMode(globals.displayMode);
      if (globals?.theme) document.documentElement.dataset.theme = globals.theme;
    };
    window.addEventListener("openai:set_globals", listener as EventListener, { passive: true });
    if (window.openai?.theme) document.documentElement.dataset.theme = window.openai.theme;
    return () => window.removeEventListener("openai:set_globals", listener as EventListener);
  }, []);

  const activeBatch = state.activeBatch?.id === activeBatchId
    ? state.activeBatch
    : state.batches.find((batch) => batch.id === activeBatchId) || state.batches[0];

  useEffect(() => {
    if (isPreview) return;
    let canceled = false;
    let inFlight = false;
    const refresh = async () => {
      if (canceled || inFlight) return;
      inFlight = true;
      try { applyResult(await bridge.callTool("ui_get_local_state", { batchId: activeBatch?.id })); }
      catch (error) { if (!canceled) setNotice(errorMessage(error)); }
      finally { inFlight = false; }
    };
    const timer = window.setInterval(refresh, 2000);
    void refresh();
    return () => { canceled = true; window.clearInterval(timer); };
  }, [activeBatch?.id, applyResult, isPreview]);

  useEffect(() => {
    bridge.persistState({ tab, batchId: activeBatch?.id, selectedJobIds: [...selected], modificationRequest });
  }, [tab, activeBatch?.id, selected, modificationRequest]);

  useEffect(() => {
    if (!activeBatch || isPreview) return;
    const timer = window.setTimeout(() => {
      const ids = [...selected];
      void bridge.updateModelContext(ids.length
        ? `用户在本地图片批次 ${activeBatch.id} 中选择了 job IDs: ${ids.join(", ")}。等待用户给出修改要求。`
        : `用户当前没有在本地图片批次 ${activeBatch.id} 中选择图片。`).catch(() => undefined);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [activeBatch?.id, selected, isPreview]);

  const switchTab = (next: Tab) => { setTab(next); setNotice(undefined); };
  const switchBatch = (id: string) => { setActiveBatchId(id); setSelected(new Set()); setModificationRequest(""); setTab("batches"); };
  const requestFullscreen = async () => {
    await bridge.requestFullscreen();
    if (isPreview) setDisplayMode(document.body.classList.contains("standalone-fullscreen") ? "fullscreen" : "inline");
  };

  return (
    <main className="app-shell" data-display-mode={displayMode}>
      <header className="app-header">
        <div className="brand"><span className="brand-mark"><ImageIcon /></span><div><strong>esse</strong><span>图片工作台</span></div></div>
        <nav className="tabs" aria-label="图片工作台导航">
          <button className={tab === "batches" ? "is-active" : ""} onClick={() => switchTab("batches")}>任务</button>
          <button className={tab === "settings" ? "is-active" : ""} onClick={() => switchTab("settings")}>设置</button>
        </nav>
        <button className="icon-button" onClick={() => void requestFullscreen()} aria-label={displayMode === "fullscreen" ? "收起预览" : "展开全屏"}><ExpandIcon /></button>
      </header>

      {notice && <div className="notice" role="status"><span>{notice}</span><button onClick={() => setNotice(undefined)} aria-label="关闭">×</button></div>}

      {tab === "settings" ? (
        <SettingsView state={state} applyResult={applyResult} onNotice={setNotice} />
      ) : (
        <BatchesView
          state={state}
          batch={activeBatch}
          selected={selected}
          setSelected={setSelected}
          modificationRequest={modificationRequest}
          setModificationRequest={setModificationRequest}
          displayMode={displayMode}
          isPreview={isPreview}
          onSwitchBatch={switchBatch}
          applyResult={applyResult}
          onNotice={setNotice}
          onOpenSettings={() => switchTab("settings")}
        />
      )}
    </main>
  );
}

function SettingsView(props: { state: WorkbenchState; applyResult: (result: ToolResult) => void; onNotice: (message?: string) => void }) {
  const [draft, setDraft] = useState<ProviderDraft>(() => props.state.providers[0] ? providerDraftFromProfile(props.state.providers[0]) : newRabbitDraft());
  const [busy, setBusy] = useState<string>();
  const [models, setModels] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const editing = Boolean(draft.id);

  const editProvider = (profile: ProviderProfile) => {
    setDraft(providerDraftFromProfile(profile));
    setModels([]);
    setConfirmDelete(false);
  };

  const save = async () => {
    setBusy("save");
    try {
      const result = await bridge.callTool("ui_save_provider_profile", {
        id: draft.id,
        displayName: draft.displayName,
        tierName: draft.tierName,
        baseUrl: draft.baseUrl,
        adapterId: draft.adapterId,
        concurrency: draft.concurrency,
        apiKey: draft.apiKey || undefined,
        offerings: draft.offerings,
        makeDefault: props.state.providers.length === 0
      });
      props.applyResult(result);
      props.onNotice("Provider 配置已保存在本机；API Key 不会进入 GPT 上下文。");
      const state = result.structuredContent?.state;
      const saved = state?.providers.find((entry) => entry.displayName === draft.displayName && entry.tierName === draft.tierName);
      if (saved) editProvider(saved);
    } catch (error) { props.onNotice(errorMessage(error)); }
    finally { setBusy(undefined); }
  };

  const test = async () => {
    setBusy("test");
    try {
      const result = await bridge.callTool("ui_test_provider_profile", { baseUrl: draft.baseUrl, profileId: draft.id, apiKey: draft.apiKey || undefined });
      const discovered = Array.isArray(result._meta?.models) ? result._meta.models.filter((entry): entry is string => typeof entry === "string") : [];
      setModels(discovered);
      props.onNotice(`连接成功，发现 ${discovered.length} 个模型。`);
    } catch (error) { props.onNotice(errorMessage(error)); }
    finally { setBusy(undefined); }
  };

  const remove = async () => {
    if (!draft.id) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setBusy("delete");
    try {
      props.applyResult(await bridge.callTool("ui_delete_provider_profile", { id: draft.id }));
      setDraft(newRabbitDraft());
      props.onNotice("Provider 配置和对应的本地密钥已删除。");
    } catch (error) { props.onNotice(errorMessage(error)); }
    finally { setBusy(undefined); setConfirmDelete(false); }
  };

  const updateOffering = (index: number, patch: Partial<OfferingConfig>) => setDraft((current) => ({
    ...current,
    offerings: current.offerings.map((offering, offeringIndex) => offeringIndex === index ? { ...offering, ...patch } : offering)
  }));

  return (
    <section className="settings-layout">
      <aside className="provider-list">
        <div className="section-title"><div><strong>Provider</strong><span>本机保存的服务配置</span></div><button className="small-button" onClick={() => setDraft(newRabbitDraft())}>＋ 新建</button></div>
        {props.state.providers.length === 0 && <div className="empty-mini">尚未配置 Provider。使用右侧的兔子预设开始。</div>}
        {props.state.providers.map((profile) => (
          <button key={profile.id} className={`provider-item ${draft.id === profile.id ? "is-active" : ""}`} onClick={() => editProvider(profile)}>
            <span className="provider-avatar">{profile.displayName.slice(0, 1)}</span>
            <span><strong>{profile.displayName}</strong><small>{profile.tierName} · {profile.adapterId}</small></span>
            <i className={profile.hasApiKey ? "status-ok" : "status-missing"} />
          </button>
        ))}
        <div className="secure-note"><LockIcon /><span>密钥保存：{props.state.secureStorage}</span></div>
      </aside>

      <div className="provider-editor">
        <div className="editor-heading"><div><span className="eyebrow">{editing ? "编辑配置" : "新建配置"}</span><h1>{draft.displayName || "Provider"} · {draft.tierName || "档位"}</h1></div><span className="local-pill">仅本机</span></div>
        <div className="form-grid">
          <Field label="服务商名称"><input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field>
          <Field label="档位名称"><input value={draft.tierName} onChange={(event) => setDraft({ ...draft, tierName: event.target.value })} /></Field>
          <Field label="API 地址" wide><input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></Field>
          <Field label="接口格式"><select value={draft.adapterId} onChange={(event) => setDraft({ ...draft, adapterId: event.target.value as ProviderDraft["adapterId"] })}><option value="tuzi-json-images">兔子 JSON Images</option><option value="openai-images">OpenAI Images</option></select></Field>
          <Field label="并发数"><input type="number" min="1" max="12" value={draft.concurrency} onChange={(event) => setDraft({ ...draft, concurrency: Number(event.target.value) })} /></Field>
          <Field label="API Key" wide hint={draft.hasApiKey ? "留空可保留已保存的密钥" : "直接写入系统安全存储，不交给 GPT"}>
            <div className="secret-input"><input type="password" autoComplete="off" placeholder={draft.hasApiKey ? "•••••••• 已安全保存" : "粘贴 API Key"} value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /><button onClick={() => void test()} disabled={Boolean(busy)}>{busy === "test" ? "测试中…" : "测试连接"}</button></div>
          </Field>
        </div>

        {models.length > 0 && <div className="models-found"><strong>已发现模型</strong><div>{models.slice(0, 20).map((model) => <button key={model} onClick={() => updateOffering(0, { providerModelId: model, canonicalModelId: model, displayName: model })}>{model}</button>)}</div></div>}

        <div className="offerings-heading"><div><strong>模型</strong><span>不同价格档使用独立配置，避免混用凭据和接口</span></div><button className="small-button" onClick={() => setDraft((current) => ({ ...current, offerings: [...current.offerings, blankOffering()] }))}>＋ 添加模型</button></div>
        <div className="offering-list">
          {draft.offerings.map((offering, index) => (
            <article className="offering-editor" key={offering.id || index}>
              <div className="offering-number">{String(index + 1).padStart(2, "0")}</div>
              <div className="offering-fields">
                <Field label="显示名称"><input value={offering.displayName} onChange={(event) => updateOffering(index, { displayName: event.target.value })} /></Field>
                <Field label="服务商模型 ID"><input value={offering.providerModelId} onChange={(event) => updateOffering(index, { providerModelId: event.target.value })} /></Field>
                <Field label="标准模型 ID"><input value={offering.canonicalModelId} onChange={(event) => updateOffering(index, { canonicalModelId: event.target.value })} /></Field>
                <Field label="计费"><div className="price-row"><select value={offering.price.mode} onChange={(event) => updateOffering(index, { price: { ...offering.price, mode: event.target.value as OfferingConfig["price"]["mode"] } })}><option value="per_request">按次</option><option value="token">按 Token</option><option value="unknown">未知</option></select><input type="number" step="0.001" placeholder="价格" value={offering.price.amount ?? ""} onChange={(event) => updateOffering(index, { price: { ...offering.price, amount: event.target.value ? Number(event.target.value) : undefined } })} /><input className="currency" value={offering.price.currency} onChange={(event) => updateOffering(index, { price: { ...offering.price, currency: event.target.value } })} /></div></Field>
              </div>
              {draft.offerings.length > 1 && <button className="remove-offering" onClick={() => setDraft((current) => ({ ...current, offerings: current.offerings.filter((_, offeringIndex) => offeringIndex !== index) }))} aria-label="删除模型">×</button>}
            </article>
          ))}
        </div>

        <footer className="settings-actions">
          <div>{editing && <button className={`danger-button ${confirmDelete ? "confirm" : ""}`} onClick={() => void remove()} disabled={Boolean(busy)}>{confirmDelete ? "再次点击确认删除" : "删除配置"}</button>}</div>
          <button className="primary-button" onClick={() => void save()} disabled={Boolean(busy) || !draft.displayName || !draft.baseUrl || draft.offerings.some((offering) => !offering.providerModelId)}>{busy === "save" ? "保存中…" : "保存"}</button>
        </footer>
      </div>
    </section>
  );
}

function BatchesView(props: {
  state: WorkbenchState;
  batch?: BatchSnapshot;
  selected: Set<string>;
  setSelected: (value: Set<string> | ((current: Set<string>) => Set<string>)) => void;
  modificationRequest: string;
  setModificationRequest: (value: string) => void;
  displayMode: string;
  isPreview: boolean;
  onSwitchBatch: (id: string) => void;
  applyResult: (result: ToolResult) => void;
  onNotice: (message?: string) => void;
  onOpenSettings: () => void;
}) {
  if (!props.batch) return <EmptyBatches configured={props.state.providers.length > 0} onOpenSettings={props.onOpenSettings} />;
  return (
    <section className="batches-layout">
      {props.state.batches.length > 1 && <div className="batch-strip">{props.state.batches.slice(0, 8).map((batch) => <button key={batch.id} className={batch.id === props.batch?.id ? "is-active" : ""} onClick={() => props.onSwitchBatch(batch.id)}><span className={`batch-dot status-${batch.status}`} /><span><strong>{batch.title}</strong><small>{batch.succeeded}/{batch.total} 完成</small></span></button>)}</div>}
      <BatchPanel {...props} batch={props.batch} />
    </section>
  );
}

type ImageAsset = {
  id: string;
  name: string;
  outputPath?: string;
  inputPath?: string;
  kind: "job" | "backup";
  job?: JobSnapshot;
  backup?: JobBackupSnapshot;
};

type CachedPreview = { path: string; dataUrl: string };

function BatchPanel(props: Omit<Parameters<typeof BatchesView>[0], "state" | "onSwitchBatch" | "onOpenSettings"> & { batch: BatchSnapshot }) {
  const { batch } = props;
  const [previews, setPreviews] = useState<Record<string, CachedPreview>>(() => Object.fromEntries(batch.jobs.filter((job) => job.previewUrl && (job.outputPath || job.inputPath)).map((job) => [job.id, { path: (job.outputPath || job.inputPath)!, dataUrl: job.previewUrl! }])));
  const [previewAsset, setPreviewAsset] = useState<ImageAsset>();
  const [previewFull, setPreviewFull] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [confirmRetryId, setConfirmRetryId] = useState<string>();
  const [confirmDeleteBatch, setConfirmDeleteBatch] = useState(false);
  const completed = useMemo(() => batch.jobs.filter((job) => job.status === "succeeded" && job.outputPath), [batch.jobs]);
  const selectedCompleted = completed.filter((job) => props.selected.has(job.id));
  const assets = useMemo<ImageAsset[]>(() => batch.jobs.flatMap((job) => [
    { id: job.id, name: job.name, outputPath: job.outputPath, inputPath: job.inputPath, kind: "job" as const, job },
    ...(job.backups || []).map((backup) => ({ id: backup.id, name: backup.name, outputPath: backup.outputPath, kind: "backup" as const, backup }))
  ]), [batch.jobs]);
  const assetsToShow = props.displayMode === "fullscreen" || document.body.classList.contains("standalone-fullscreen") ? assets : assets.slice(0, 8);

  useEffect(() => {
    let canceled = false;
    const load = async () => {
      for (const asset of assetsToShow) {
        const filePath = asset.outputPath || asset.inputPath;
        if (canceled || !filePath || previews[asset.id]?.path === filePath) continue;
        try {
          const result = await bridge.callTool("ui_get_image_preview", { batchId: batch.id, jobId: asset.id, full: false });
          const dataUrl = typeof result._meta?.dataUrl === "string" ? result._meta.dataUrl : undefined;
          if (dataUrl && !canceled) setPreviews((current) => ({ ...current, [asset.id]: { path: filePath, dataUrl } }));
        } catch { /* Keep a neutral placeholder. */ }
      }
    };
    void load();
    return () => { canceled = true; };
  }, [batch.id, assetsToShow.map((asset) => `${asset.id}:${asset.outputPath || asset.inputPath || ""}`).join("|")]);

  useEffect(() => {
    if (!previewAsset) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setPreviewAsset(undefined); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [previewAsset]);

  const toggle = (job: JobSnapshot) => {
    if (job.status !== "succeeded" || !job.outputPath) return;
    props.setSelected((current) => {
      const next = new Set(current);
      if (next.has(job.id)) next.delete(job.id); else next.add(job.id);
      return next;
    });
  };
  const selectAll = () => props.setSelected(selectedCompleted.length === completed.length && completed.length ? new Set() : new Set(completed.map((job) => job.id)));
  const fullDataUrl = async (asset: ImageAsset) => {
    const result = await bridge.callTool("ui_get_image_preview", { batchId: batch.id, jobId: asset.id, full: true });
    const dataUrl = typeof result._meta?.dataUrl === "string" ? result._meta.dataUrl : undefined;
    if (!dataUrl) throw new Error("无法读取本地原图。");
    return dataUrl;
  };
  const openPreview = async (asset: ImageAsset) => {
    setPreviewAsset(asset);
    setPreviewFull(undefined);
    try { setPreviewFull(await fullDataUrl(asset)); }
    catch (error) { props.onNotice(errorMessage(error)); }
  };
  const saveImage = async (asset: ImageAsset) => {
    try {
      const dataUrl = await fullDataUrl(asset);
      const extension = /^data:image\/([^;,]+)/.exec(dataUrl)?.[1]?.replace("jpeg", "jpg") || "png";
      const anchor = document.createElement("a");
      anchor.href = dataUrl;
      anchor.download = `${asset.name}.${extension}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) { props.onNotice(errorMessage(error)); }
  };
  const retry = async (job: JobSnapshot) => {
    const unknownCharge = job.chargeState === "unknown";
    if (unknownCharge && confirmRetryId !== job.id) {
      setConfirmRetryId(job.id);
      props.onNotice(`${job.name} 的扣费状态未知，再点一次“确认重试”可能产生重复费用。`);
      return;
    }
    setBusy(`retry:${job.id}`);
    try {
      props.applyResult(await bridge.callTool("ui_retry_jobs", { batchId: batch.id, jobIds: [job.id], allowUnknownCharge: unknownCharge }));
      setConfirmRetryId(undefined);
    } catch (error) { props.onNotice(errorMessage(error)); }
    finally { setBusy(undefined); }
  };
  const sendSelection = async () => {
    const request = props.modificationRequest.trim();
    if (!selectedCompleted.length) { props.onNotice("请先勾选至少一张已完成的主图。"); return; }
    if (!request) { props.onNotice("请先填写具体的修改要求。"); return; }
    setBusy("modify");
    const ids = selectedCompleted.map((job) => job.id);
    try {
      await bridge.updateModelContext(`用户准备修改本地图片批次 ${batch.id} 的 job IDs: ${ids.join(", ")}。修改要求：${request}。修改必须留在同一批次，并为每张原图建立中文版本备份。`);
      await bridge.sendMessage(`请修改本地图片批次 ${batch.id} 中选中的 ${ids.length} 张图片（job IDs: ${ids.join(", ")}）。修改要求：${request}\n\n请直接调用 modify_selected_images，在同一批次更新主图并保留中文版本备份。`);
      props.onNotice(`已向 GPT 提交 ${ids.length} 张图片的修改任务。`);
    } catch (error) { props.onNotice(errorMessage(error)); }
    finally { setBusy(undefined); }
  };
  const cancel = async () => {
    setBusy("cancel");
    try { props.applyResult(await bridge.callTool("ui_cancel_queued_jobs", { batchId: batch.id })); }
    catch (error) { props.onNotice(errorMessage(error)); }
    finally { setBusy(undefined); }
  };
  const deleteBatch = async () => {
    if (!confirmDeleteBatch) { setConfirmDeleteBatch(true); return; }
    setBusy("delete-batch");
    try {
      props.applyResult(await bridge.callTool("ui_delete_image_batch", { batchId: batch.id }));
      props.setSelected(new Set());
      props.onNotice("批次记录、生成图和版本备份已从本机删除。");
    } catch (error) { props.onNotice(errorMessage(error)); }
    finally { setBusy(undefined); setConfirmDeleteBatch(false); }
  };

  return (
    <div className="batch-panel">
      <header className="batch-heading"><div><span className="eyebrow"><i className="provider-dot" />{batch.offering.providerName}</span><h1>{batch.title}</h1><p>{batch.offering.displayName} · {batch.succeeded}/{batch.total} 完成{batch.running ? ` · ${batch.running} 生成中` : ""}{batch.queued ? ` · ${batch.queued} 排队` : ""}</p></div><div className="batch-heading-actions"><span className={`status-badge status-${batch.status}`}>{batchStatusLabel(batch)}</span><button className={`delete-batch-button ${confirmDeleteBatch ? "confirm" : ""}`} onClick={() => void deleteBatch()} disabled={Boolean(busy) || batch.running > 0 || batch.queued > 0}>{confirmDeleteBatch ? "确认删除" : "删除"}</button></div></header>
      <details className="batch-details"><summary>任务详情</summary><div><span>{priceLabel(batch)}</span><span>{batch.offering.tierName} · {batch.offering.concurrency} 路并发</span><span className="path-label" title={batch.outputDirectory}>输出：{batch.outputDirectory}</span></div></details>
      <div className={`batch-workspace ${assetsToShow.length === 1 ? "is-single" : ""}`}>
        <section className="gallery-panel" aria-label="批次图片">
          <div className="selection-bar"><div><strong>图片</strong><span>{selectedCompleted.length ? `已选 ${selectedCompleted.length} 张` : "勾选主图后可修改"}</span></div><button className="text-button" onClick={selectAll} disabled={!completed.length}>{selectedCompleted.length === completed.length && completed.length ? "取消全选" : "全选"}</button></div>
          <section className="image-grid">{assetsToShow.map((asset) => <JobCard key={asset.id} asset={asset} preview={previews[asset.id]?.path === (asset.outputPath || asset.inputPath) ? previews[asset.id]?.dataUrl : undefined} selected={asset.job ? props.selected.has(asset.job.id) : false} confirmRetry={confirmRetryId === asset.id} busy={busy === `retry:${asset.id}`} onSelect={asset.job ? () => toggle(asset.job!) : undefined} onPreview={() => void openPreview(asset)} onSave={() => void saveImage(asset)} onRetry={asset.job ? () => void retry(asset.job!) : undefined} />)}</section>
          {assets.length > assetsToShow.length && <div className="show-more">展开后可查看全部 {assets.length} 张图片</div>}
        </section>
        <section className="modify-composer" aria-label="修改所选图片">
          <div className="modify-heading"><div><strong>修改所选图片</strong><span>写清楚要改什么，原图会自动保留为版本备份。</span></div><b>{selectedCompleted.length ? `${selectedCompleted.length} 张` : "未选择"}</b></div>
          <textarea value={props.modificationRequest} onChange={(event) => props.setModificationRequest(event.target.value)} placeholder="例如：只保留一支向日葵，其他构图和光线不变。" rows={4} maxLength={1200} aria-label="修改要求" />
          <div className="modify-actions"><span>{!selectedCompleted.length ? "先在图片右上角勾选" : !props.modificationRequest.trim() ? "请输入修改要求" : "已准备好提交"}</span><button className="primary-button" onClick={() => void sendSelection()} disabled={!selectedCompleted.length || !props.modificationRequest.trim() || Boolean(busy)}>{busy === "modify" ? "正在提交…" : "开始修改"}</button></div>
        </section>
      </div>
      {batch.queued > 0 && <footer className="batch-actions"><button className="secondary-button" onClick={() => void cancel()} disabled={Boolean(busy)}>取消排队</button></footer>}
      {previewAsset && <div className="lightbox" role="dialog" aria-modal="true" aria-label={previewAsset.name} onClick={() => setPreviewAsset(undefined)}><button className="lightbox-close" onClick={() => setPreviewAsset(undefined)} aria-label="关闭预览">×</button>{previewFull ? <img src={previewFull} alt={previewAsset.name} onClick={(event) => event.stopPropagation()} /> : <span className="spinner large" />}<div className="lightbox-caption" onClick={(event) => event.stopPropagation()}><strong>{previewAsset.name}</strong><button onClick={() => void saveImage(previewAsset)}>保存原图</button></div></div>}
    </div>
  );
}

function JobCard(props: { asset: ImageAsset; preview?: string; selected: boolean; confirmRetry: boolean; busy: boolean; onSelect?: () => void; onPreview: () => void; onSave: () => void; onRetry?: () => void }) {
  const job = props.asset.job;
  const hasImage = Boolean(props.asset.outputPath || props.asset.inputPath);
  const canSave = Boolean(props.asset.outputPath);
  const selectable = Boolean(job?.status === "succeeded" && job.outputPath && props.onSelect);
  const status = props.asset.kind === "backup" ? "备份" : job ? jobStatusLabel(job) : "完成";
  const statusClass = props.asset.kind === "backup" ? "succeeded" : job?.status || "succeeded";
  const canRetry = job?.status === "failed" && job.retryable && Boolean(props.onRetry);
  const selectFromCopy = (event: React.KeyboardEvent<HTMLDivElement>) => { if ((event.key === "Enter" || event.key === " ") && props.onSelect) { event.preventDefault(); props.onSelect(); } };
  return <article className={`job-card ${props.selected ? "is-selected" : ""} ${props.asset.kind === "backup" ? "is-backup" : ""}`}><button className="image-button" disabled={!hasImage} onClick={hasImage ? props.onPreview : undefined} aria-label={hasImage ? `预览 ${props.asset.name}` : props.asset.name}>{props.preview ? <img src={props.preview} alt={props.asset.name} /> : job ? <JobPlaceholder job={job} /> : <div className="placeholder"><span className="spinner" /><strong>读取备份</strong></div>}</button><div className="card-overlay"><span className={`status-pill status-${statusClass}`}>{status}</span>{selectable && <label className="select-control" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={props.selected} onChange={props.onSelect} aria-label={`选择 ${props.asset.name}`} /><span>{props.selected ? "已选" : "选择"}</span></label>}</div>{(canSave || canRetry) && <div className="card-tools">{canSave && <button onClick={(event) => { event.stopPropagation(); props.onSave(); }}>保存</button>}{canRetry && <button className={props.confirmRetry ? "confirm" : ""} onClick={(event) => { event.stopPropagation(); props.onRetry?.(); }} disabled={props.busy}>{props.busy ? "重试中…" : props.confirmRetry ? "确认重试" : "重试"}</button>}</div>}<div className={`card-copy ${selectable ? "is-selectable" : ""}`} onClick={selectable ? props.onSelect : undefined} onKeyDown={selectable ? selectFromCopy : undefined} role={selectable ? "button" : undefined} tabIndex={selectable ? 0 : undefined} aria-pressed={selectable ? props.selected : undefined}><strong title={props.asset.name}>{props.asset.name}</strong><span>{props.asset.kind === "backup" ? "历史版本" : job?.durationMs ? `${Math.round(job.durationMs / 1000)} 秒` : job?.status === "queued" ? "等待并发位" : job?.status === "running" ? "处理中" : `第 ${job?.attempt || 1} 次`}</span></div>{job?.error && <p className="error-copy" title={job.error}>{job.error}</p>}</article>;
}

function JobPlaceholder({ job }: { job: JobSnapshot }) {
  return <div className="placeholder">{job.status === "running" ? <span className="spinner" /> : <span className="placeholder-symbol">{job.status === "failed" ? "!" : "…"}</span>}<strong>{jobStatusLabel(job)}</strong>{job.status === "running" && <span>{Math.max(15, job.progress)}%</span>}</div>;
}

function EmptyBatches({ configured, onOpenSettings }: { configured: boolean; onOpenSettings: () => void }) {
  return <div className="empty-state"><span className="empty-art"><ImageIcon /></span><h1>{configured ? "还没有图片任务" : "先配置一个 Provider"}</h1><p>{configured ? "告诉 GPT 要处理的本地文件夹和修改目标，任务会在这里并行运行。" : "API Key 只会写入这台电脑的安全存储，不会进入聊天内容。"}</p>{!configured && <button className="primary-button" onClick={onOpenSettings}>配置 Provider</button>}</div>;
}

function Field({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: React.ReactNode }) {
  return <label className={`field ${wide ? "wide" : ""}`}><span>{label}{hint && <small>{hint}</small>}</span>{children}</label>;
}

function providerDraftFromProfile(profile: ProviderProfile): ProviderDraft {
  return {
    id: profile.id,
    displayName: profile.displayName,
    tierName: profile.tierName,
    baseUrl: profile.baseUrl,
    adapterId: profile.adapterId,
    concurrency: profile.concurrency,
    offerings: profile.offerings.map((offering) => ({ ...offering })),
    apiKey: "",
    hasApiKey: profile.hasApiKey
  };
}

function newRabbitDraft(): ProviderDraft {
  return { displayName: "兔子", tierName: "default", baseUrl: "https://api.tu-zi.com", adapterId: "tuzi-json-images", concurrency: 3, apiKey: "", hasApiKey: false, offerings: [rabbitOffering()] };
}

function rabbitOffering(): OfferingConfig {
  return { id: "", canonicalModelId: "gpt-image-2", providerModelId: "gpt-image-2", displayName: "GPT-Image 2", price: { mode: "per_request", amount: 0.035, currency: "CNY", observedAt: "2026-07-18" }, supportsTextToImage: true, supportsImageToImage: true, sizes: ["auto", "1024x1024", "1536x1024", "1024x1536"], qualities: ["auto", "low", "medium", "high"] };
}

function blankOffering(): OfferingConfig {
  return { id: "", canonicalModelId: "", providerModelId: "", displayName: "", price: { mode: "unknown", currency: "CNY" }, supportsTextToImage: true, supportsImageToImage: true, sizes: [], qualities: [] };
}

function priceLabel(batch: BatchSnapshot): string {
  if (typeof batch.estimatedCost === "number") return `预计 ${batch.currency === "CNY" ? "¥" : ""}${batch.estimatedCost.toFixed(3)}`;
  if (batch.offering.price.mode === "token") return "按 Token 计费";
  return "价格未配置";
}

function batchStatusLabel(batch: BatchSnapshot): string {
  if (batch.status === "completed") return "全部完成";
  if (batch.status === "partial") return "部分完成";
  if (batch.status === "failed") return "任务失败";
  if (batch.status === "canceled") return "已取消";
  if (batch.status === "queued") return "等待并发位";
  return "正在并行生成";
}

function jobStatusLabel(job: JobSnapshot): string {
  if (job.status === "succeeded") return "完成";
  if (job.status === "running") return "生成中";
  if (job.status === "queued") return "排队";
  if (job.status === "failed") return job.retryable ? "可重试" : "失败";
  return "已取消";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return "本地插件操作失败。";
}

function ImageIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m5.5 18 5-5 3.2 3 2.3-2.2 2.5 4.2"/></svg>; }
function ExpandIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/></svg>; }
function LockIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>; }

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
