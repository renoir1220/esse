import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowsOutSimple, CaretDown, CaretLeft, CaretRight, Check, DotsThree, DownloadSimple, FolderSimple, ImageSquare, Info, Lightning, LockSimple, Plus, SlidersHorizontal, SquaresFour, Trash, X } from "@phosphor-icons/react";
import { bridge } from "./bridge";
import { formatImageFileSize, formatImageResolution } from "./image-metadata";
import type { ImageMetadata } from "./image-metadata";
import { initialImageZoom, zoomImageAtPoint } from "./image-zoom";
import { providerSavePayload } from "./provider-payload";
import { offeringPriceLabel } from "./pricing";
import { imagesMentionedInRequest, selectableImages, selectionModelContext } from "./selection-context";
import type { SelectableImage } from "./selection-context";
import { batchIdAfterUpdate, batchPollDelay, keepSelectedBatchId, mergeBatchWithoutReordering } from "./workbench-state";
import type { BatchSnapshot, JobBackupSnapshot, JobCallSnapshot, JobSnapshot, OfferingConfig, ProviderDraft, ProviderProfile, PublicOffering, ToolResult, WorkbenchState } from "./types";
import "./styles.css";

type Tab = "batches" | "settings";
type PersistedWidgetState = NonNullable<NonNullable<Window["openai"]>["widgetState"]>;

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

function persistedWidgetState(): PersistedWidgetState {
  let stored: PersistedWidgetState = {};
  try { stored = JSON.parse(window.sessionStorage.getItem("esse:widget-state") || "{}"); }
  catch { /* A corrupt optional session value should not block the widget. */ }
  return { ...stored, ...(window.openai?.widgetState || {}) };
}

function App() {
  const [startingState] = useState<WorkbenchState>(initialState);
  const [persistedState] = useState<PersistedWidgetState>(persistedWidgetState);
  const [state, setState] = useState<WorkbenchState>(startingState);
  const [tab, setTab] = useState<Tab>(() => persistedState.tab || startingState.view.tab);
  const [activeBatchId, setActiveBatchId] = useState<string | undefined>(() => persistedState.batchId || startingState.view.batchId || startingState.activeBatch?.id || startingState.batches[0]?.id);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(persistedState.selectedImageIds || persistedState.selectedJobIds || []));
  const [modificationRequest, setModificationRequest] = useState(() => persistedState.modificationRequest || "");
  const [displayMode, setDisplayMode] = useState(window.openai?.displayMode || "inline");
  const [notice, setNotice] = useState<string>();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [batchSwitcherOpen, setBatchSwitcherOpen] = useState(false);
  const [batchMenuOpen, setBatchMenuOpen] = useState(false);
  const [confirmDeleteBatch, setConfirmDeleteBatch] = useState(false);
  const [headerBusy, setHeaderBusy] = useState<string>();
  const isPreview = Boolean(window.__ESSE_PREVIEW__);

  const applyResult = useCallback((result: ToolResult) => {
    if (result.structuredContent?.state) {
      const incoming = result.structuredContent.state;
      setState(incoming);
      setActiveBatchId((current) => keepSelectedBatchId(current, incoming));
      return;
    }
    const batch = result.structuredContent?.batch;
    if (batch) {
      setState((current) => mergeBatchWithoutReordering(current, batch));
      const activateBatchId = result.structuredContent?.activateBatchId;
      setActiveBatchId((current) => batchIdAfterUpdate(current, batch, activateBatchId));
      if (activateBatchId === batch.id) {
        setTab("batches");
        setSelected(new Set());
        setModificationRequest("");
        setBatchSwitcherOpen(false);
        setBatchMenuOpen(false);
      }
    }
  }, []);

  useEffect(() => bridge.subscribe(applyResult), [applyResult]);

  useEffect(() => {
    if (isPreview) return;
    void bridge.callTool("ui_get_local_state", { batchId: activeBatchId }).then(applyResult).catch((error) => setNotice(errorMessage(error)));
  }, []);

  useEffect(() => {
    if (isPreview) return;
    void bridge.requestFullscreen().catch(() => undefined);
  }, [isPreview]);

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
  const headerBatches = useMemo(() => {
    const recent = state.batches.slice(0, 8);
    if (!activeBatch || recent.some((batch) => batch.id === activeBatch.id)) return recent;
    return [activeBatch, ...recent.slice(0, 7)];
  }, [activeBatch, state.batches]);

  useEffect(() => {
    if (isPreview) return;
    let canceled = false;
    let timer: number | undefined;
    const schedule = (delay: number) => {
      if (canceled || document.hidden) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), delay);
    };
    const refresh = async () => {
      if (canceled || document.hidden || !activeBatchId) return;
      let nextDelay = batchPollDelay(activeBatch);
      try {
        const result = await bridge.callTool("ui_get_batch_state", { batchId: activeBatchId });
        if (canceled || result.structuredContent?.batch?.id !== activeBatchId) return;
        applyResult(result);
        nextDelay = batchPollDelay(result.structuredContent.batch);
      }
      catch (error) { if (!canceled) setNotice(errorMessage(error)); }
      finally { if (!canceled) schedule(nextDelay); }
    };
    const onVisibilityChange = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange, { passive: true });
    schedule(Math.min(750, batchPollDelay(activeBatch)));
    return () => {
      canceled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [activeBatchId, applyResult, isPreview]);

  useEffect(() => {
    bridge.persistState({ tab, batchId: activeBatch?.id, selectedImageIds: [...selected], modificationRequest });
  }, [tab, activeBatch?.id, selected, modificationRequest]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(undefined), 3600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!activeBatch || isPreview) return;
    const timer = window.setTimeout(() => {
      void bridge.updateModelContext(selectionModelContext(activeBatch, selected)).catch(() => undefined);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [activeBatch?.id, activeBatch?.updatedAt, selected, isPreview]);

  const switchTab = (next: Tab) => { setTab(next); setNotice(undefined); setBatchSwitcherOpen(false); setBatchMenuOpen(false); setConfirmDeleteBatch(false); };
  const switchBatch = (id: string) => { setActiveBatchId(id); setSelected(new Set()); setModificationRequest(""); setTab("batches"); setBatchSwitcherOpen(false); setBatchMenuOpen(false); setConfirmDeleteBatch(false); };
  const requestFullscreen = async () => {
    await bridge.requestFullscreen();
    if (isPreview) setDisplayMode(document.body.classList.contains("standalone-fullscreen") ? "fullscreen" : "inline");
  };
  const deleteActiveBatch = async () => {
    if (!activeBatch) return;
    if (!confirmDeleteBatch) { setConfirmDeleteBatch(true); return; }
    setHeaderBusy("delete-batch");
    try {
      applyResult(await bridge.callTool("ui_delete_image_batch", { batchId: activeBatch.id }));
      setSelected(new Set());
      setModificationRequest("");
      setBatchMenuOpen(false);
      setNotice("批次已删除");
    } catch (error) { setNotice(errorMessage(error)); }
    finally { setHeaderBusy(undefined); setConfirmDeleteBatch(false); }
  };
  const openActiveBatchFolder = async () => {
    if (!activeBatch) return;
    setHeaderBusy("open-folder");
    try {
      const result = await bridge.callTool("ui_open_batch_folder", { batchId: activeBatch.id });
      setNotice(`已在文件夹中打开 ${String(result.structuredContent?.path || activeBatch.outputDirectory)}`);
      setBatchMenuOpen(false);
    } catch (error) { setNotice(errorMessage(error)); }
    finally { setHeaderBusy(undefined); }
  };

  return (
    <main className="app-shell" data-display-mode={displayMode}>
      <header className="app-header">
        <div className="header-context">
          {tab === "settings" && <span className="header-context-icon"><SlidersHorizontal size={17} /></span>}
          {tab === "batches" && activeBatch ? <div className="current-batch-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setBatchSwitcherOpen(false); }} onKeyDown={(event) => { if (event.key === "Escape") setBatchSwitcherOpen(false); }}>
            <button
              type="button"
              className="current-batch-trigger"
              aria-label="切换当前批次"
              aria-haspopup="listbox"
              aria-expanded={batchSwitcherOpen}
              onClick={() => { setBatchMenuOpen(false); setConfirmDeleteBatch(false); setBatchSwitcherOpen((open) => !open); }}
            >
              <span>{activeBatch.title}</span>
              <CaretDown size={13} />
            </button>
            {batchSwitcherOpen && <div className="current-batch-menu" role="listbox" aria-label="最近批次">
              {headerBatches.map((batch) => <button key={batch.id} type="button" role="option" aria-selected={batch.id === activeBatch.id} onClick={() => switchBatch(batch.id)}>
                <Check size={14} weight="bold" />
                <span>{batch.title}</span>
              </button>)}
            </div>}
          </div> : <strong>{tab === "settings" ? "Esse 设置" : "Esse"}</strong>}
          {tab === "batches" && activeBatch && <div className="header-more" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) { setBatchMenuOpen(false); setConfirmDeleteBatch(false); } }}>
            <button className="header-icon-action" onClick={() => { setBatchSwitcherOpen(false); setBatchMenuOpen((open) => !open); }} aria-label="当前批次操作" aria-expanded={batchMenuOpen}><DotsThree size={18} weight="bold" /></button>
            {batchMenuOpen && <div className="header-menu" role="menu">
              <button role="menuitem" onClick={() => void openActiveBatchFolder()} disabled={Boolean(headerBusy)}><FolderSimple size={14} />在文件夹中打开</button>
              <button className={confirmDeleteBatch ? "is-danger" : ""} role="menuitem" onClick={() => void deleteActiveBatch()} disabled={Boolean(headerBusy) || activeBatch.running > 0 || activeBatch.queued > 0}><Trash size={14} />{confirmDeleteBatch ? "确认删除批次" : "删除当前批次"}</button>
            </div>}
          </div>}
        </div>
        <div className="header-actions">
          <button className={tab === "batches" ? "is-active" : ""} onClick={() => switchTab("batches")}><ImageSquare size={15} /><span>任务</span></button>
          <button onClick={() => setLibraryOpen(true)} disabled={!activeBatch}><SquaresFour size={15} /><span>浏览</span></button>
          <button className={tab === "settings" ? "is-active" : ""} onClick={() => switchTab("settings")}><SlidersHorizontal size={15} /><span>设置</span></button>
          <button className="header-icon-action" onClick={() => void requestFullscreen()} aria-label={displayMode === "fullscreen" ? "收起预览" : "在侧边栏展开"} title="在侧边栏展开"><ArrowsOutSimple size={16} /></button>
        </div>
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
          applyResult={applyResult}
          onNotice={setNotice}
          onOpenSettings={() => switchTab("settings")}
        />
      )}
      {libraryOpen && activeBatch && <BatchBrowserDialog activeBatchId={activeBatch.id} applyResult={applyResult} onSwitchBatch={switchBatch} onNotice={setNotice} onClose={() => setLibraryOpen(false)} />}
    </main>
  );
}

function SettingsView(props: { state: WorkbenchState; applyResult: (result: ToolResult) => void; onNotice: (message?: string) => void }) {
  const [draft, setDraft] = useState<ProviderDraft>(() => props.state.providers[0] ? providerDraftFromProfile(props.state.providers[0]) : newRabbitDraft());
  const [busy, setBusy] = useState<string>();
  const [models, setModels] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const editing = Boolean(draft.id);

  const setDefaultOffering = async (offeringId: string) => {
    if (!offeringId || offeringId === props.state.defaultOfferingId) return;
    setBusy("default");
    try {
      const result = await bridge.callTool("ui_set_default_offering", { offeringId });
      props.applyResult(result);
      const offering = props.state.offerings.find((entry) => entry.id === offeringId);
      props.onNotice(`默认模型已设置为 ${offering?.displayName || offeringId}；未明确指定时会自动使用它。`);
    } catch (error) { props.onNotice(errorMessage(error)); }
    finally { setBusy(undefined); }
  };

  const editProvider = (profile: ProviderProfile) => {
    setDraft(providerDraftFromProfile(profile));
    setModels([]);
    setConfirmDelete(false);
  };

  const save = async () => {
    setBusy("save");
    try {
      const result = await bridge.callTool("ui_save_provider_profile", providerSavePayload(draft));
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
      <div className="default-model-panel">
        <div><strong>默认模型</strong><span>未指定模型时使用</span></div>
        <SettingsSelect
          ariaLabel="默认模型"
          value={props.state.defaultOfferingId || ""}
          options={[
            ...(!props.state.defaultOfferingId ? [{ value: "", label: "请选择默认模型" }] : []),
            ...props.state.offerings.map((offering) => ({
              value: offering.id,
              label: offering.adapterId === "agent-generation"
                ? `${offering.displayName} · ${offeringPriceLabel(offering.price)}`
                : `${offering.displayName} · ${offering.providerName}/${offering.tierName}`
            }))
          ]}
          onChange={(value) => void setDefaultOffering(value)}
          disabled={!props.state.offerings.length || Boolean(busy)}
        />
      </div>
      <aside className="provider-list">
        <div className="section-title"><strong>Provider</strong><button className="compact-icon-button" onClick={() => setDraft(newRabbitDraft())} aria-label="新建 Provider" title="新建 Provider"><Plus size={15} /></button></div>
        {props.state.providers.length === 0 && <div className="empty-mini">尚未配置 Provider</div>}
        {props.state.providers.map((profile) => (
          <button key={profile.id} className={`provider-item ${draft.id === profile.id ? "is-active" : ""}`} onClick={() => editProvider(profile)}>
            <span className="provider-avatar">{profile.displayName.slice(0, 1)}</span>
            <span><strong>{profile.displayName}</strong><small>{profile.tierName} · {adapterDisplayName(profile.adapterId)}</small></span>
            <i className={profile.hasApiKey ? "status-ok" : "status-missing"} />
          </button>
        ))}
        <div className="secure-note"><LockSimple size={14} /><span>{props.state.secureStorage}</span></div>
      </aside>

      <div className="provider-editor">
        <div className="editor-heading"><h1>{draft.displayName || "Provider"} · {draft.tierName || "档位"}</h1></div>
        <section className="settings-section">
          <div className="settings-section-heading"><strong>连接</strong></div>
          <div className="form-grid">
            <Field label="服务商名称"><input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></Field>
            <Field label="档位名称"><input value={draft.tierName} onChange={(event) => setDraft({ ...draft, tierName: event.target.value })} /></Field>
            <Field label="API 地址" wide><input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></Field>
            <Field label="接口格式" labelAccessory={<InfoTip label="查看兔子分组与接口格式的对应关系"><strong>兔子分组对应关系</strong><span><b>default</b> → 兔子 JSON Images</span><span><b>codex / openai / 原价</b> → OpenAI Images</span></InfoTip>}><SettingsSelect ariaLabel="接口格式" value={draft.adapterId} options={[{ value: "tuzi-json-images", label: "兔子 JSON Images" }, { value: "openai-images", label: "OpenAI Images" }]} onChange={(value) => setDraft({ ...draft, adapterId: value as ProviderDraft["adapterId"] })} /></Field>
            <Field label="并发数"><input type="number" min="1" max="12" value={draft.concurrency} onChange={(event) => setDraft({ ...draft, concurrency: Number(event.target.value) })} /></Field>
            <Field label="API Key" wide hint={draft.hasApiKey ? "留空保留现有密钥" : "安全存储在本机"}>
              <div className="secret-input"><input type="password" autoComplete="off" placeholder={draft.hasApiKey ? "•••••••• 已安全保存" : "粘贴 API Key"} value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /><button onClick={() => void test()} disabled={Boolean(busy)}>{busy === "test" ? "测试中…" : "测试连接"}</button></div>
            </Field>
          </div>
        </section>

        {models.length > 0 && <div className="models-found"><strong>已发现模型</strong><div>{models.slice(0, 20).map((model) => <button key={model} onClick={() => updateOffering(0, { providerModelId: model, canonicalModelId: model, displayName: model })}>{model}</button>)}</div></div>}

        <section className="settings-section models-section">
          <div className="offerings-heading"><strong>模型</strong><button className="compact-icon-button" onClick={() => setDraft((current) => ({ ...current, offerings: [...current.offerings, blankOffering()] }))} aria-label="添加模型" title="添加模型"><Plus size={15} /></button></div>
          <div className="offering-list">
            {draft.offerings.map((offering, index) => (
              <article className="offering-editor" key={offering.id || index}>
                <div className="offering-number">{String(index + 1).padStart(2, "0")}</div>
                <div className="offering-fields">
                  <Field label="显示名称"><input value={offering.displayName} onChange={(event) => updateOffering(index, { displayName: event.target.value })} /></Field>
                  <Field label="服务商模型 ID"><input value={offering.providerModelId} onChange={(event) => updateOffering(index, { providerModelId: event.target.value })} /></Field>
                  <Field label="标准模型 ID"><input value={offering.canonicalModelId} onChange={(event) => updateOffering(index, { canonicalModelId: event.target.value })} /></Field>
                  <Field label="计费"><div className="price-row"><SettingsSelect ariaLabel={`计费方式 ${index + 1}`} value={offering.price.mode} options={[{ value: "per_request", label: "按次" }, { value: "token", label: "按 Token" }, { value: "unknown", label: "未知" }]} onChange={(value) => updateOffering(index, { price: { ...offering.price, mode: value as OfferingConfig["price"]["mode"] } })} /><input type="number" step="0.001" placeholder="价格" value={offering.price.amount ?? ""} onChange={(event) => updateOffering(index, { price: { ...offering.price, amount: event.target.value ? Number(event.target.value) : undefined } })} /><input className="currency" value={offering.price.currency} onChange={(event) => updateOffering(index, { price: { ...offering.price, currency: event.target.value } })} /></div></Field>
                </div>
                {draft.offerings.length > 1 && <button className="remove-offering" onClick={() => setDraft((current) => ({ ...current, offerings: current.offerings.filter((_, offeringIndex) => offeringIndex !== index) }))} aria-label={`删除模型 ${index + 1}`} title="删除模型"><Trash size={14} /></button>}
              </article>
            ))}
          </div>
        </section>

        <footer className="settings-actions">
          <div>{editing && <button className={`danger-button ${confirmDelete ? "confirm" : ""}`} onClick={() => void remove()} disabled={Boolean(busy)}>{confirmDelete ? "再次点击确认删除" : "删除配置"}</button>}</div>
          <button className="primary-button" onClick={() => void save()} disabled={Boolean(busy) || !draft.displayName || !draft.baseUrl || draft.offerings.some((offering) => !offering.providerModelId)}>{busy === "save" ? "保存中…" : "保存"}</button>
        </footer>
      </div>
    </section>
  );
}

function SettingsSelect(props: { ariaLabel: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const selected = props.options.find((option) => option.value === props.value) || props.options[0];
  return <div className="settings-select" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
    <button type="button" className="settings-select-trigger" aria-label={props.ariaLabel} aria-haspopup="listbox" aria-expanded={open} disabled={props.disabled} onClick={() => setOpen((current) => !current)}>
      <span>{selected?.label || "请选择"}</span><CaretDown size={13} />
    </button>
    {open && <div className="settings-select-menu" role="listbox" aria-label={props.ariaLabel}>
      {props.options.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === props.value} onClick={() => { props.onChange(option.value); setOpen(false); }}>
        <Check size={13} weight="bold" /><span>{option.label}</span>
      </button>)}
    </div>}
  </div>;
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
  applyResult: (result: ToolResult) => void;
  onNotice: (message?: string) => void;
  onOpenSettings: () => void;
}) {
  if (!props.batch) return <EmptyBatches state={props.state} onOpenSettings={props.onOpenSettings} onNotice={props.onNotice} />;
  return (
    <section className="batches-layout">
      <BatchPanel key={props.batch.id} {...props} batch={props.batch} offerings={props.state.offerings} />
    </section>
  );
}

type BatchLibraryPage = {
  batches: BatchSnapshot[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

function BatchBrowserDialog(props: {
  activeBatchId: string;
  applyResult: (result: ToolResult) => void;
  onSwitchBatch: (id: string) => void;
  onNotice: (message?: string) => void;
  onClose: () => void;
}) {
  const [requestedPage, setRequestedPage] = useState(1);
  const [pageData, setPageData] = useState<BatchLibraryPage>({ batches: [], page: 1, pageSize: 8, total: 0, totalPages: 1 });
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [openingBatchId, setOpeningBatchId] = useState<string>();

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    void bridge.callTool("ui_list_image_batches", { page: requestedPage, pageSize: 8 }).then((result) => {
      if (canceled) return;
      const value = result.structuredContent as Partial<BatchLibraryPage> | undefined;
      const batches = Array.isArray(value?.batches) ? value.batches : [];
      const normalized = {
        batches,
        page: typeof value?.page === "number" ? value.page : requestedPage,
        pageSize: typeof value?.pageSize === "number" ? value.pageSize : 8,
        total: typeof value?.total === "number" ? value.total : batches.length,
        totalPages: typeof value?.totalPages === "number" ? value.totalPages : 1
      };
      setPageData(normalized);
      if (normalized.page !== requestedPage) setRequestedPage(normalized.page);
    }).catch((error) => {
      if (!canceled) props.onNotice(errorMessage(error));
    }).finally(() => {
      if (!canceled) setLoading(false);
    });
    return () => { canceled = true; };
  }, [requestedPage]);

  useEffect(() => {
    let canceled = false;
    const load = async () => {
      const entries = pageData.batches.flatMap((batch) => batch.jobs
        .filter((job) => Boolean(job.outputPath))
        .slice(0, 3)
        .map((job) => ({ batch, job })));
      await Promise.all(entries.map(async ({ batch, job }) => {
        const key = batchPreviewKey(batch.id, job.id);
        if (previews[key]) return;
        if (job.previewUrl) {
          if (!canceled) setPreviews((current) => ({ ...current, [key]: job.previewUrl! }));
          return;
        }
        try {
          const result = await bridge.callTool("ui_get_image_preview", { batchId: batch.id, jobId: job.id, full: false });
          const dataUrl = typeof result._meta?.dataUrl === "string" ? result._meta.dataUrl : undefined;
          if (dataUrl && !canceled) setPreviews((current) => ({ ...current, [key]: dataUrl }));
        } catch { /* A missing cover should not block browsing the batch list. */ }
      }));
    };
    void load();
    return () => { canceled = true; };
  }, [pageData.batches]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.onClose]);

  const openBatch = async (batch: BatchSnapshot) => {
    if (batch.id === props.activeBatchId) { props.onClose(); return; }
    setOpeningBatchId(batch.id);
    try {
      const result = await bridge.callTool("ui_get_batch_state", { batchId: batch.id });
      props.applyResult(result);
      props.onSwitchBatch(batch.id);
      props.onClose();
    } catch (error) { props.onNotice(errorMessage(error)); }
    finally { setOpeningBatchId(undefined); }
  };

  return (
    <div className="batch-library-backdrop" onClick={props.onClose}>
      <section className="batch-library-dialog" role="dialog" aria-modal="true" aria-label="浏览全部批次" onClick={(event) => event.stopPropagation()}>
        <header className="batch-library-header">
          <div><FolderSimple size={16} /><h2>浏览批次</h2></div>
          <button onClick={props.onClose} aria-label="关闭批次浏览"><X size={15} /></button>
        </header>
        <div className="batch-library-list" aria-live="polite">
          {loading && !pageData.batches.length ? <div className="batch-library-loading"><span className="spinner" /><span>读取批次</span></div> : pageData.batches.map((batch) => {
            const coverJobs = batch.jobs.filter((job) => Boolean(job.outputPath)).slice(0, 3);
            return (
              <button key={batch.id} className={`batch-library-item ${batch.id === props.activeBatchId ? "is-active" : ""}`} onClick={() => void openBatch(batch)} disabled={Boolean(openingBatchId)} aria-current={batch.id === props.activeBatchId ? "page" : undefined}>
                <span className={`batch-library-thumbs count-${Math.max(1, coverJobs.length)}`}>
                  {Array.from({ length: Math.max(1, coverJobs.length) }, (_, index) => {
                    const job = coverJobs[index];
                    const preview = job ? previews[batchPreviewKey(batch.id, job.id)] || job.previewUrl : undefined;
                    return <span className="batch-library-thumb" key={job?.id || index}>{preview ? <img src={preview} alt="" /> : <ImageSquare size={18} />}</span>;
                  })}
                </span>
                <span className="batch-library-copy">
                  <span className="batch-library-title"><strong>{batch.title}</strong></span>
                  <time dateTime={batch.updatedAt}>{formatBatchDate(batch.updatedAt)}</time>
                </span>
                <span className="batch-library-open" aria-hidden="true">{openingBatchId === batch.id ? <span className="spinner" /> : batch.id === props.activeBatchId ? <Check size={15} weight="bold" /> : <CaretRight size={15} />}</span>
              </button>
            );
          })}
          {!loading && !pageData.batches.length && <div className="batch-library-loading"><FolderSimple size={18} /><span>还没有批次</span></div>}
        </div>
        <footer className="batch-library-pagination">
          <span>{pageData.page} / {pageData.totalPages}</span>
          <button onClick={() => setRequestedPage((page) => Math.max(1, page - 1))} disabled={loading || pageData.page <= 1} aria-label="上一页" title="上一页"><CaretLeft size={14} /></button>
          <button onClick={() => setRequestedPage((page) => Math.min(pageData.totalPages, page + 1))} disabled={loading || pageData.page >= pageData.totalPages} aria-label="下一页" title="下一页"><CaretRight size={14} /></button>
        </footer>
      </section>
    </div>
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
  selectableImage?: SelectableImage;
};

type CachedPreview = { path: string; dataUrl: string };

type ModificationOffering = Pick<PublicOffering, "id" | "displayName" | "providerName" | "tierName" | "adapterId" | "price">;

function BatchPanel(props: Omit<Parameters<typeof BatchesView>[0], "state" | "onOpenSettings"> & { batch: BatchSnapshot; offerings: PublicOffering[] }) {
  const { batch } = props;
  const modificationTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [previews, setPreviews] = useState<Record<string, CachedPreview>>(() => Object.fromEntries(batch.jobs.filter((job) => job.previewUrl && (job.outputPath || job.inputPath)).map((job) => [job.id, { path: (job.outputPath || job.inputPath)!, dataUrl: job.previewUrl! }])));
  const [previewAsset, setPreviewAsset] = useState<ImageAsset>();
  const [previewFull, setPreviewFull] = useState<string>();
  const [previewZoom, setPreviewZoom] = useState(initialImageZoom);
  const [detailAsset, setDetailAsset] = useState<ImageAsset>();
  const [detailMetadata, setDetailMetadata] = useState<ImageMetadata>();
  const [busy, setBusy] = useState<string>();
  const modificationOfferings = useMemo<ModificationOffering[]>(() => {
    const configured = props.offerings
      .filter((offering) => offering.configured && offering.supportsImageToImage)
      .map(({ id, displayName, providerName, tierName, adapterId, price }) => ({ id, displayName, providerName, tierName, adapterId, price }));
    if (!configured.some((offering) => offering.id === batch.offering.id)) {
      configured.unshift({
        id: batch.offering.id,
        displayName: batch.offering.displayName,
        providerName: batch.offering.providerName,
        tierName: batch.offering.tierName,
        adapterId: batch.offering.adapterId,
        price: batch.offering.price
      });
    }
    return configured;
  }, [props.offerings, batch.offering.id]);
  const [selectedOfferingId, setSelectedOfferingId] = useState(batch.offering.id);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const selectedOffering = modificationOfferings.find((offering) => offering.id === selectedOfferingId) || modificationOfferings[0]!;
  const availableImages = useMemo(() => selectableImages(batch), [batch.jobs]);
  const selectableById = useMemo(() => new Map(availableImages.map((image) => [image.id, image])), [availableImages]);
  const selectedImages = availableImages.filter((image) => props.selected.has(image.id));
  const mentionedImages = useMemo(() => imagesMentionedInRequest(batch, props.modificationRequest), [batch.jobs, props.modificationRequest]);
  const resolvedTargets = mentionedImages.length ? mentionedImages : selectedImages;
  const assets = useMemo<ImageAsset[]>(() => batch.jobs.flatMap((job) => [
    { id: job.id, name: job.name, outputPath: job.outputPath, inputPath: selectableById.get(job.id)?.path || job.inputPath, kind: "job" as const, job, selectableImage: selectableById.get(job.id) },
    ...(job.backups || []).map((backup) => ({ id: backup.id, name: backup.name, outputPath: backup.outputPath, kind: "backup" as const, backup, selectableImage: selectableById.get(backup.id) }))
  ]), [batch.jobs, selectableById]);
  const previewableAssets = useMemo(
    () => assets.filter((asset) => !asset.job || !isProcessing(asset.job)),
    [assets],
  );
  const assetsToShow = props.displayMode === "fullscreen" || document.body.classList.contains("standalone-fullscreen") ? assets : assets.slice(0, 8);

  useLayoutEffect(() => {
    const textarea = modificationTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const nextHeight = Math.min(180, Math.max(34, textarea.scrollHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 180 ? "auto" : "hidden";
  }, [props.modificationRequest]);

  useEffect(() => {
    let canceled = false;
    const load = async () => {
      for (const asset of assetsToShow) {
        const processingPaths = asset.job ? processingSourcePaths(asset.job) : [];
        if (processingPaths.length && asset.job && isProcessing(asset.job)) {
          for (const [sourceIndex, filePath] of processingPaths.slice(0, 4).entries()) {
            const key = sourcePreviewKey(asset.id, sourceIndex);
            if (canceled || previews[key]?.path === filePath) continue;
            try {
              const result = await bridge.callTool("ui_get_image_preview", { batchId: batch.id, jobId: asset.id, sourceIndex, full: false });
              const dataUrl = typeof result._meta?.dataUrl === "string" ? result._meta.dataUrl : undefined;
              if (dataUrl && !canceled) setPreviews((current) => ({ ...current, [key]: { path: filePath, dataUrl } }));
            } catch { /* Keep the reference cell neutral while loading. */ }
          }
          continue;
        }
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
  }, [batch.id, assetsToShow.map((asset) => `${asset.id}:${asset.outputPath || asset.inputPath || ""}:${asset.job ? processingSourcePaths(asset.job).join(",") : ""}`).join("|")]);

  const detailReferencePaths = detailAsset ? referencePathsForAsset(detailAsset) : [];
  useEffect(() => {
    if (!detailAsset || !detailReferencePaths.length) return;
    let canceled = false;
    const load = async () => {
      for (const [sourceIndex, filePath] of detailReferencePaths.entries()) {
        const key = sourcePreviewKey(detailAsset.id, sourceIndex);
        if (canceled || previews[key]?.path === filePath) continue;
        try {
          const result = await bridge.callTool("ui_get_image_preview", { batchId: batch.id, jobId: detailAsset.id, sourceIndex, full: false });
          const dataUrl = typeof result._meta?.dataUrl === "string" ? result._meta.dataUrl : undefined;
          if (dataUrl && !canceled) setPreviews((current) => ({ ...current, [key]: { path: filePath, dataUrl } }));
        } catch { /* Keep the path visible when a reference thumbnail is unavailable. */ }
      }
    };
    void load();
    return () => { canceled = true; };
  }, [batch.id, detailAsset?.id, detailReferencePaths.join("|")]);

  useEffect(() => {
    if (!detailAsset) { setDetailMetadata(undefined); return; }
    let canceled = false;
    setDetailMetadata(undefined);
    void bridge.callTool("ui_get_image_metadata", { batchId: batch.id, jobId: detailAsset.id }).then((result) => {
      if (canceled) return;
      const content = result.structuredContent || {};
      setDetailMetadata({
        available: content.available === true,
        width: typeof content.width === "number" ? content.width : undefined,
        height: typeof content.height === "number" ? content.height : undefined,
        sizeBytes: typeof content.sizeBytes === "number" ? content.sizeBytes : undefined
      });
    }).catch(() => { if (!canceled) setDetailMetadata({ available: false }); });
    return () => { canceled = true; };
  }, [batch.id, detailAsset?.id]);

  useEffect(() => {
    if (!detailAsset) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setDetailAsset(undefined); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [detailAsset?.id]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setModelMenuOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [modelMenuOpen]);

  const toggle = (image: SelectableImage) => {
    props.setSelected((current) => {
      const next = new Set(current);
      if (next.has(image.id)) next.delete(image.id); else next.add(image.id);
      return next;
    });
  };
  const fullDataUrl = async (asset: ImageAsset) => {
    const result = await bridge.callTool("ui_get_image_preview", { batchId: batch.id, jobId: asset.id, full: true });
    const dataUrl = typeof result._meta?.dataUrl === "string" ? result._meta.dataUrl : undefined;
    if (!dataUrl) throw new Error("无法读取本地原图。");
    return dataUrl;
  };
  const openPreview = (asset: ImageAsset) => setPreviewAsset(asset);
  const previewIndex = previewAsset ? previewableAssets.findIndex((asset) => asset.id === previewAsset.id) : -1;
  const movePreview = (direction: -1 | 1) => {
    if (previewIndex < 0 || previewableAssets.length < 2) return;
    setPreviewAsset(previewableAssets[(previewIndex + direction + previewableAssets.length) % previewableAssets.length]);
  };

  useEffect(() => {
    if (!previewAsset) return;
    let canceled = false;
    setPreviewFull(undefined);
    setPreviewZoom(initialImageZoom);
    void fullDataUrl(previewAsset).then((dataUrl) => { if (!canceled) setPreviewFull(dataUrl); }).catch((error) => { if (!canceled) props.onNotice(errorMessage(error)); });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewAsset(undefined);
      if (event.key === "ArrowLeft") { event.preventDefault(); movePreview(-1); }
      if (event.key === "ArrowRight") { event.preventDefault(); movePreview(1); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { canceled = true; window.removeEventListener("keydown", onKeyDown); };
  }, [previewAsset?.id, previewIndex, previewableAssets.length]);
  const zoomPreview = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const pointX = event.clientX - (rect.left + rect.width / 2);
    const pointY = event.clientY - (rect.top + rect.height / 2);
    setPreviewZoom((current) => zoomImageAtPoint(current, event.deltaY, pointX, pointY, event.deltaMode, rect.height));
  };
  const saveImage = async (asset: ImageAsset) => {
    try {
      const result = await bridge.callTool("ui_save_image_as", { batchId: batch.id, jobId: asset.id });
      if (result.structuredContent?.saved) props.onNotice(`已保存到 ${String(result.structuredContent.path || "所选位置")}`);
    } catch (error) { props.onNotice(errorMessage(error)); }
  };
  const retry = async (job: JobSnapshot) => {
    const unknownCharge = job.chargeState === "unknown";
    setBusy(`retry:${job.id}`);
    try {
      props.applyResult(await bridge.callTool("ui_retry_jobs", { batchId: batch.id, jobIds: [job.id], allowUnknownCharge: unknownCharge }));
      if (unknownCharge) props.onNotice(`${job.name} 已重试；上一次调用的扣费状态未知。`);
    } catch (error) { props.onNotice(errorMessage(error)); }
    finally { setBusy(undefined); }
  };
  const sendSelection = async () => {
    const request = props.modificationRequest.trim();
    if (!request) { props.onNotice("请先填写具体的修改要求。"); return; }
    if (!resolvedTargets.length) { props.onNotice("请双击选择图片，或在修改要求中输入图像名称，例如“图1”或“图2-1”。"); return; }
    setBusy("modify");
    try {
      const targets = resolvedTargets.map((image) => `${image.name}（image ID: ${image.id}；本地路径: ${image.path}；类型: ${image.kind}）`).join("、");
      await bridge.sendMessage(`这是用户从 Esse 修改框提交的请求。请修改批次“${batch.title}”（batchId: ${batch.id}）中的目标图片：${targets}。用户已明确选择模型“${selectedOffering.displayName}”（offeringId: ${selectedOffering.id}）。修改要求：${request}\n目标已由 Esse 按双击选择和图像名称解析，无需再次询问。当前结果图可调用 modify_selected_images；历史备份或失败任务原图必须作为准确参考图创建新任务，不得替换成同批次的其他图片。`);
      props.setSelected(new Set());
      props.setModificationRequest("");
      props.onNotice(`已将 ${resolvedTargets.length} 张图片的修改要求交给当前 Agent`);
    } catch (error) { props.onNotice(errorMessage(error)); }
    finally { setBusy(undefined); }
  };
  const cancel = async () => {
    setBusy("cancel");
    try { props.applyResult(await bridge.callTool("ui_cancel_queued_jobs", { batchId: batch.id })); }
    catch (error) { props.onNotice(errorMessage(error)); }
    finally { setBusy(undefined); }
  };
  const sourcePreviewsFor = (asset: ImageAsset): Array<string | undefined> => {
    if (!asset.job || !isProcessing(asset.job)) return [];
    return processingSourcePaths(asset.job).slice(0, 4).map((filePath, sourceIndex) => {
      const cached = previews[sourcePreviewKey(asset.id, sourceIndex)];
      return cached?.path === filePath ? cached.dataUrl : undefined;
    });
  };

  return (
    <div className="batch-panel">
      <div className={`batch-workspace ${assetsToShow.length === 1 ? "is-single" : ""}`}>
        <section className="gallery-panel" aria-label="批次图片">
          <div className="selection-bar"><strong>图片</strong></div>
          <section className="image-grid">{assetsToShow.map((asset) => <JobCard key={asset.id} asset={asset} preview={asset.job && isProcessing(asset.job) ? undefined : previews[asset.id]?.path === (asset.outputPath || asset.inputPath) ? previews[asset.id]?.dataUrl : undefined} sourcePreviews={sourcePreviewsFor(asset)} selected={Boolean(asset.selectableImage && props.selected.has(asset.selectableImage.id))} busy={busy === `retry:${asset.id}`} onSelect={asset.selectableImage ? () => toggle(asset.selectableImage!) : undefined} onPreview={() => openPreview(asset)} onDetail={() => setDetailAsset(asset)} onSave={() => void saveImage(asset)} onRetry={asset.job ? () => void retry(asset.job!) : undefined} />)}</section>
          {assets.length > assetsToShow.length && <div className="show-more">展开后可查看全部 {assets.length} 张图片</div>}
        </section>
        <section className="modify-composer" aria-label="修改选定图片">
          <div className="modify-entry">
            {selectedImages.length > 0 && <div className="modify-attachments" aria-label="待修改图片">
              {selectedImages.map((image) => {
                const attachmentPreview = previews[image.id]?.dataUrl;
                return <div className="modify-attachment" key={image.id} title={image.name}>
                  {attachmentPreview ? <img src={attachmentPreview} alt={image.name} /> : <ImageSquare size={18} />}
                  <button type="button" onClick={() => toggle(image)} aria-label={`移除 ${image.name}`} title="移除"><X size={10} weight="bold" /></button>
                </div>;
              })}
            </div>}
            <textarea ref={modificationTextareaRef} value={props.modificationRequest} onChange={(event) => props.setModificationRequest(event.target.value)} placeholder={selectedImages.length ? "描述你希望如何修改这些图片…" : "双击选择想要编辑的图片"} rows={1} maxLength={1200} aria-label="修改要求" />
          </div>
          <div className="modify-toolbar">
            <div className="modify-model-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setModelMenuOpen(false); }}>
              <button type="button" className="modify-model-trigger" onClick={() => setModelMenuOpen((open) => !open)} aria-haspopup="listbox" aria-expanded={modelMenuOpen} aria-label={`选择生图模型，当前 ${selectedOffering.displayName}，${offeringPriceLabel(selectedOffering.price)}`} disabled={Boolean(busy)}>
                <Lightning size={13} weight="fill" /><span>{selectedOffering.displayName}</span><small>{offeringPriceLabel(selectedOffering.price)}</small><CaretDown size={12} />
              </button>
              {modelMenuOpen && <div className="modify-model-menu" role="listbox" aria-label="选择生图模型">
                {modificationOfferings.map((offering) => <button type="button" role="option" aria-selected={offering.id === selectedOffering.id} key={offering.id} onClick={() => { setSelectedOfferingId(offering.id); setModelMenuOpen(false); }}>
                  <span><strong>{offering.displayName}</strong><small>{offering.providerName} · {offering.tierName}</small></span>
                  <b>{offeringPriceLabel(offering.price)}</b>
                  <Check size={13} weight="bold" />
                </button>)}
              </div>}
            </div>
            <button type="button" className="modify-submit-button" onClick={() => void sendSelection()} disabled={!props.modificationRequest.trim() || Boolean(busy)} aria-busy={busy === "modify"}>提交修改</button>
          </div>
        </section>
      </div>
      {batch.queued > 0 && <footer className="batch-actions"><button className="secondary-button" onClick={() => void cancel()} disabled={Boolean(busy)}>取消排队</button></footer>}
      {previewAsset && <div className="lightbox" role="dialog" aria-modal="true" aria-label={previewAsset.name}><button className="lightbox-close" onClick={() => setPreviewAsset(undefined)} aria-label="关闭预览">×</button>{previewableAssets.length > 1 && <><button className="lightbox-nav previous" onClick={() => movePreview(-1)} aria-label="上一张" title="上一张（←）"><CaretLeft size={24} /></button><button className="lightbox-nav next" onClick={() => movePreview(1)} aria-label="下一张" title="下一张（→）"><CaretRight size={24} /></button></>}<div className="lightbox-stage" onClick={() => setPreviewAsset(undefined)} onWheel={zoomPreview}>{previewFull ? <img className={previewZoom.scale > 1.0001 ? "is-zoomed" : ""} src={previewFull} alt={previewAsset.name} style={{ transform: `translate3d(${previewZoom.x}px, ${previewZoom.y}px, 0) scale(${previewZoom.scale})` }} onClick={(event) => event.stopPropagation()} onDoubleClick={() => setPreviewZoom(initialImageZoom)} /> : <span className="spinner large lightbox-spinner" />}</div><div className="lightbox-caption"><strong>{previewAsset.name}</strong><span>{previewIndex + 1}/{previewableAssets.length}</span><span>{Math.round(previewZoom.scale * 100)}%</span><button className="lightbox-save" onClick={() => void saveImage(previewAsset)} aria-label="保存原图" title="保存原图"><DownloadSimple size={17} /></button></div></div>}
      {detailAsset && <TaskDetailDialog asset={detailAsset} metadata={detailMetadata} referencePaths={detailReferencePaths} previews={previews} onClose={() => setDetailAsset(undefined)} />}
    </div>
  );
}

function JobCard(props: { asset: ImageAsset; preview?: string; sourcePreviews: Array<string | undefined>; selected: boolean; busy: boolean; onSelect?: () => void; onPreview: () => void; onDetail: () => void; onSave: () => void; onRetry?: () => void }) {
  const previewTimer = useRef<number>();
  const job = props.asset.job;
  const processing = Boolean(job && (job.status === "queued" || job.status === "running"));
  const hasImage = !processing && Boolean(props.asset.outputPath || props.asset.inputPath);
  const canSave = !processing && Boolean(props.asset.outputPath);
  const selectable = Boolean(props.asset.selectableImage && props.onSelect);
  const canRetry = job?.status === "failed" && job.retryable && Boolean(props.onRetry);
  useEffect(() => () => { if (previewTimer.current !== undefined) window.clearTimeout(previewTimer.current); }, []);
  const previewOnSingleClick = () => {
    if (!hasImage) return;
    if (previewTimer.current !== undefined) window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => { previewTimer.current = undefined; props.onPreview(); }, selectable ? 280 : 0);
  };
  const attachOnDoubleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!selectable || !props.onSelect) return;
    event.preventDefault();
    if (previewTimer.current !== undefined) window.clearTimeout(previewTimer.current);
    previewTimer.current = undefined;
    props.onSelect();
  };
  const attachmentAction = props.selected ? "从修改输入框移除" : "添加到修改输入框";
  return <article className={`job-card ${props.asset.kind === "backup" ? "is-backup" : ""}`}>
    <button className={`image-button ${selectable ? "is-attachable" : ""}`} disabled={!hasImage} onClick={previewOnSingleClick} onDoubleClick={attachOnDoubleClick} aria-label={hasImage ? selectable ? `预览 ${props.asset.name}；双击${attachmentAction}` : `预览 ${props.asset.name}` : props.asset.name} title={selectable ? `双击${attachmentAction}` : undefined}>{processing && job ? <ProcessingPreview job={job} previews={props.sourcePreviews} /> : props.preview ? <img src={props.preview} alt={props.asset.name} /> : job ? <JobPlaceholder job={job} /> : <div className="placeholder"><span className="spinner" /><strong>读取备份</strong></div>}</button>
    <div className="card-tools">
      <button className="card-icon-button" onClick={(event) => { event.stopPropagation(); props.onDetail(); }} aria-label={`查看 ${props.asset.name} 详情`} title="任务详情"><Info size={13} /></button>
      {canSave && <button className="card-icon-button" onClick={(event) => { event.stopPropagation(); props.onSave(); }} aria-label={`保存 ${props.asset.name}`} title="保存图片"><DownloadSimple size={13} /></button>}
      {canRetry && <button onClick={(event) => { event.stopPropagation(); props.onRetry?.(); }} disabled={props.busy}>{props.busy ? "重试中…" : "重试"}</button>}
    </div>
    <div className="card-copy"><strong title={props.asset.name}>{props.asset.name}</strong></div>
    {job?.error && <p className="error-copy" title={job.error}>{job.error}</p>}
  </article>;
}

function TaskDetailDialog({ asset, metadata, referencePaths, previews, onClose }: { asset: ImageAsset; metadata?: ImageMetadata; referencePaths: string[]; previews: Record<string, CachedPreview>; onClose: () => void }) {
  const prompt = asset.job?.prompt || asset.backup?.prompt || "未记录 Prompt";
  const status = asset.backup ? "历史版本" : asset.job ? jobStatusLabel(asset.job) : "任务";
  const offering = asset.job?.offering || asset.backup?.offering;
  const calls = callHistoryFor(asset.job);
  const succeededCalls = calls.filter((call) => call.status === "succeeded").length;
  const totalDuration = calls.reduce((total, call) => total + (call.durationMs || 0), 0);
  return <div className="task-detail-backdrop" onClick={onClose}>
    <section className="task-detail-dialog" role="dialog" aria-modal="true" aria-label={`${asset.name} 任务详情`} onClick={(event) => event.stopPropagation()}>
      <header className="task-detail-header"><div><span className="eyebrow">任务详情</span><h2>{asset.name}</h2></div><button onClick={onClose} aria-label="关闭任务详情">×</button></header>
      <div className="task-detail-meta"><span>{status}</span>{offering && <span>{offering.displayName} · {offeringPriceLabel(offering.price)}</span>}{asset.job && <><span>当前第 {asset.job.attempt} 次尝试</span><span>{referencePaths.length} 张参考图</span></>}</div>
      <section className="task-detail-section"><strong>图片信息</strong><div className="image-metadata-grid"><div><span>分辨率</span><b>{formatImageResolution(metadata)}</b></div><div title={metadata?.sizeBytes === undefined ? undefined : `${metadata.sizeBytes.toLocaleString()} 字节`}><span>文件大小</span><b>{formatImageFileSize(metadata)}</b></div></div></section>
      <section className="task-detail-section"><strong>Prompt</strong><p>{prompt}</p></section>
      {asset.job && <section className="task-detail-section"><strong>调用记录</strong>
        <div className="call-history-summary"><span>{calls.length} 次调用</span><span>{succeededCalls} 次成功</span><span>累计 {formatDuration(totalDuration)}</span></div>
        {calls.length ? <div className="call-history-list">{[...calls].reverse().map((call) => <article className={`call-history-item is-${call.status}`} key={call.id}>
          <header><span className="call-status-dot" /><strong>第 {call.sequence} 次 · {callStatusLabel(call.status)}</strong><time dateTime={call.startedAt}>{formatCallTime(call.startedAt)}</time></header>
          <div className="call-history-meta"><span>{call.source === "agent" ? "当前 Agent" : `${call.offering.providerName} · ${call.offering.tierName}`}</span><span>{call.offering.displayName}</span><span>{call.status === "running" ? "进行中" : formatDuration(call.durationMs || 0)}</span>{call.providerRequestId && <code title={call.providerRequestId}>{call.providerRequestId}</code>}</div>
          {call.error && <p>{call.error}</p>}
        </article>)}</div> : <div className="call-history-empty">任务尚未发起模型调用</div>}
      </section>}
      <section className="task-detail-section"><strong>参考图</strong>
        {referencePaths.length ? <div className="task-reference-grid">{referencePaths.map((filePath, index) => {
          const cached = previews[sourcePreviewKey(asset.id, index)];
          const preview = cached?.path === filePath ? cached.dataUrl : undefined;
          return <article key={`${filePath}:${index}`}><div className="task-reference-image">{preview ? <img src={preview} alt={`参考图 ${index + 1}`} /> : <ImageSquare size={22} />}</div><div><b>参考图 {index + 1}</b><span title={filePath}>{fileName(filePath)}</span><code title={filePath}>{filePath}</code></div></article>;
        })}</div> : <div className="task-reference-empty"><ImageSquare size={20} /><span>无参考图，使用纯文本生成</span></div>}
      </section>
    </section>
  </div>;
}

function JobPlaceholder({ job }: { job: JobSnapshot }) {
  return <div className="placeholder"><span className="placeholder-symbol">{job.status === "failed" ? "!" : "…"}</span><strong>{jobStatusLabel(job)}</strong></div>;
}

function ProcessingPreview({ job, previews }: { job: JobSnapshot; previews: Array<string | undefined> }) {
  const modifying = Boolean(job.generationInputPath || job.generationInputPaths?.length);
  const cells = previews.length ? previews : [undefined];
  return <div className="processing-preview"><div className={`reference-grid count-${Math.min(4, cells.length)}`}>{cells.map((preview, index) => <span className={`reference-cell ${preview ? "" : "is-loading"}`} key={index}>{preview && <img src={preview} alt={`参考图 ${index + 1}`} />}</span>)}</div><div className="processing-mask"><span className="spinner processing-spinner" /><strong>{modifying ? "修改中" : job.status === "queued" ? "等待生成" : "生成中"}</strong>{job.status === "running" && <span>{Math.max(15, job.progress)}%</span>}</div></div>;
}

function EmptyBatches({ state, onOpenSettings, onNotice }: { state: WorkbenchState; onOpenSettings: () => void; onNotice: (message?: string) => void }) {
  const offerings = state.offerings.filter((offering) => offering.configured && offering.supportsTextToImage);
  const [prompt, setPrompt] = useState("");
  const [selectedOfferingId, setSelectedOfferingId] = useState(() => state.defaultOfferingId || "");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const selectedOffering = offerings.find((offering) => offering.id === selectedOfferingId);

  useEffect(() => {
    if (selectedOfferingId && offerings.some((offering) => offering.id === selectedOfferingId)) return;
    setSelectedOfferingId(state.defaultOfferingId && offerings.some((offering) => offering.id === state.defaultOfferingId) ? state.defaultOfferingId : "");
  }, [state.defaultOfferingId, offerings.map((offering) => offering.id).join("|")]);

  const submit = async () => {
    const request = prompt.trim();
    if (!selectedOffering) { onNotice("请先选择本次使用的模型。"); return; }
    if (!request) { onNotice("请先描述想生成什么图片。"); return; }
    setBusy(true);
    try {
      await bridge.sendMessage(`请使用 Esse 创建一个新的图片批次。用户已在 Esse 中明确选择模型“${selectedOffering.displayName}”（offeringId: ${selectedOffering.id}）。生成要求：${request}`);
      setPrompt("");
      onNotice("已将新批次要求交给当前 Agent");
    } catch (error) { onNotice(errorMessage(error)); }
    finally { setBusy(false); }
  };

  return <section className="empty-batches-layout">
    <div className="empty-state"><span className="empty-art"><ImageSquare size={28} /></span><h1>开始第一个图片任务</h1><p>描述想生成的图片并选择模型；Agent 创建批次后，Esse 会自动切换过去。</p>{!offerings.length && <button className="primary-button" onClick={onOpenSettings}>打开模型设置</button>}</div>
    <section className="modify-composer empty-generate-composer" aria-label="新建图片任务">
      <div className="modify-entry"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="描述你想生成的图片…" rows={1} maxLength={1200} aria-label="新批次生成要求" /></div>
      <div className="modify-toolbar">
        <div className="modify-model-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setModelMenuOpen(false); }}>
          <button type="button" className="modify-model-trigger" onClick={() => setModelMenuOpen((open) => !open)} aria-haspopup="listbox" aria-expanded={modelMenuOpen} aria-label={selectedOffering ? `选择生图模型，当前 ${selectedOffering.displayName}` : "选择生图模型"} disabled={busy || !offerings.length}>
            <Lightning size={13} weight="fill" /><span>{selectedOffering?.displayName || "选择模型"}</span>{selectedOffering && <small>{offeringPriceLabel(selectedOffering.price)}</small>}<CaretDown size={12} />
          </button>
          {modelMenuOpen && <div className="modify-model-menu" role="listbox" aria-label="选择新批次模型">{offerings.map((offering) => <button type="button" role="option" aria-selected={offering.id === selectedOfferingId} key={offering.id} onClick={() => { setSelectedOfferingId(offering.id); setModelMenuOpen(false); }}><span><strong>{offering.displayName}</strong><small>{offering.providerName} · {offering.tierName}</small></span><b>{offeringPriceLabel(offering.price)}</b><Check size={13} weight="bold" /></button>)}</div>}
        </div>
        <button type="button" className="modify-submit-button" onClick={() => void submit()} disabled={!selectedOffering || !prompt.trim() || busy} aria-busy={busy}>{busy ? "发送中…" : "开始生成"}</button>
      </div>
    </section>
  </section>;
}

function Field({ label, labelAccessory, hint, wide, children }: { label: string; labelAccessory?: React.ReactNode; hint?: string; wide?: boolean; children: React.ReactNode }) {
  return <label className={`field ${wide ? "wide" : ""}`}><span><span className="field-label-copy">{label}{labelAccessory}</span>{hint && <small>{hint}</small>}</span>{children}</label>;
}

function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  return <span className="info-tip" tabIndex={0} aria-label={label} onClick={(event) => { event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); }}><Info size={13} /><span className="info-tooltip" role="tooltip">{children}</span></span>;
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

function adapterDisplayName(adapterId: ProviderDraft["adapterId"]): string {
  if (adapterId === "tuzi-json-images") return "兔子 JSON Images";
  if (adapterId === "openai-images") return "OpenAI Images";
  return "Codex 生成";
}

function callHistoryFor(job: JobSnapshot | undefined): JobCallSnapshot[] {
  if (!job) return [];
  if (job.callHistory?.length) return job.callHistory;
  if (!job.offering || (!job.startedAt && job.durationMs === undefined && !job.error)) return [];
  return [{
    id: `legacy-${job.id}`,
    sequence: 1,
    attempt: job.attempt,
    source: job.offering.adapterId === "agent-generation" ? "agent" : "provider",
    offering: job.offering,
    status: job.status === "queued" ? "canceled" : job.status,
    chargeState: job.chargeState,
    startedAt: job.startedAt || job.createdAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    error: job.error,
    providerRequestId: job.providerRequestId
  }];
}

function callStatusLabel(status: JobCallSnapshot["status"]): string {
  if (status === "succeeded") return "成功";
  if (status === "failed") return "失败";
  if (status === "canceled") return "已取消";
  return "调用中";
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))} 毫秒`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} 秒`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes} 分 ${seconds} 秒`;
}

function formatCallTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function formatBatchDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function batchPreviewKey(batchId: string, jobId: string): string {
  return `${batchId}:${jobId}`;
}

function jobStatusLabel(job: JobSnapshot): string {
  if (job.status === "succeeded") return "完成";
  if (job.status === "running") return "生成中";
  if (job.status === "queued") return "排队";
  if (job.status === "failed") return job.retryable ? "可重试" : "失败";
  return "已取消";
}

function isProcessing(job: JobSnapshot): boolean {
  return job.status === "queued" || job.status === "running";
}

function processingSourcePaths(job: JobSnapshot): string[] {
  if (job.referenceImagePaths?.length) return [...new Set(job.referenceImagePaths)];
  if (job.generationInputPaths?.length) return [...new Set(job.generationInputPaths)];
  if (job.generationInputPath) return [job.generationInputPath];
  if (job.inputPaths?.length) return [...new Set(job.inputPaths)];
  return job.inputPath ? [job.inputPath] : [];
}

function referencePathsForAsset(asset: ImageAsset): string[] {
  if (asset.job) return processingSourcePaths(asset.job);
  return [...new Set(asset.backup?.referenceImagePaths || [])];
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
}

function sourcePreviewKey(jobId: string, sourceIndex: number): string {
  return `${jobId}:source:${sourceIndex}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return "本地插件操作失败。";
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
