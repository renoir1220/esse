import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, net, protocol, shell } from 'electron';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import started from 'electron-squirrel-startup';
import { EsseApiClient } from './api-client';
import { BatchManager } from './batch-manager';
import { BatchStore } from './batch-store';
import { CredentialStore } from './credential-store';
import { DesktopSettingsStore } from './desktop-settings';
import { configureWorkBuddyForDevelopment } from './dev-bootstrap';
import { ImageStore } from './image-store';
import { McpPairingStore } from './mcp-pairing-store';
import { DEFAULT_MCP_PORT, startDesktopMcpServer, type RunningDesktopMcpServer } from './mcp-server';
import { ProviderSettingsStore } from './provider-settings';
import { WORKBUDDY_AGENT_OFFERING, type DesktopState, type ModifyBatchInput, type SaveProviderInput } from './types';
import { desktopWindowChrome, shouldRemoveWindowMenu } from './window-chrome';
import { resolveSidecarUserDataPath, shouldQuitWhenAllWindowsClose } from './platform';

const smokeMode = process.env.ESSE_SMOKE_TEST === '1';
const qaCapturePath = process.env.ESSE_QA_CAPTURE_PATH;
const qaFixture = process.env.ESSE_QA_FIXTURE;
const qaViewport = parseQaViewport(process.env.ESSE_QA_VIEWPORT);
const qaUserDataPath = process.env.ESSE_QA_USER_DATA_PATH;

app.setName('Esse');
if (qaUserDataPath) {
  app.setPath('userData', path.resolve(qaUserDataPath));
} else {
  app.setPath('userData', resolveSidecarUserDataPath());
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'esse-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

if (started) app.quit();
if (smokeMode || qaCapturePath) app.disableHardwareAcceleration();

let mainWindow: BrowserWindow | undefined;
let credentialStore: CredentialStore;
let providerSettings: ProviderSettingsStore;
let imageStore: ImageStore;
let batchManager: BatchManager;
let desktopSettings: DesktopSettingsStore;
let mcpPairingStore: McpPairingStore;
let mcpServer: RunningDesktopMcpServer | undefined;
let mcpError: string | undefined;
let smokeTimer: NodeJS.Timeout | undefined;
let smokeReported = false;

const hasSingleInstanceLock = smokeMode || Boolean(qaCapturePath) || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.setIcon(resolveRuntimeIconPath());
  const userData = app.getPath('userData');
  credentialStore = new CredentialStore(userData);
  providerSettings = new ProviderSettingsStore(path.join(userData, 'providers.json'), credentialStore);
  imageStore = new ImageStore(userData);
  desktopSettings = new DesktopSettingsStore(path.join(userData, 'settings.json'));
  mcpPairingStore = new McpPairingStore(userData);
  batchManager = new BatchManager({
    store: new BatchStore(path.join(userData, 'batches')),
    imageStore,
    createApiClient: createApiClient,
    getDefaultOfferingId: () => desktopSettings.getDefaultOfferingId(),
    onChanged: broadcastState,
  });
  await batchManager.initialize();
  protocol.handle('esse-media', (request) => {
    const filePath = imageStore.resolveMediaRequest(request.url);
    return net.fetch(pathToFileURL(filePath).toString());
  });
  await startMcpBridge();
  registerIpc();
  createWindow();
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: qaViewport?.width ?? 1320,
    height: qaViewport?.height ?? 860,
    minHeight: qaViewport ? 640 : 640,
    show: !smokeMode && !qaCapturePath,
    title: 'Esse',
    icon: resolveRuntimeIconPath(),
    backgroundColor: '#ffffff',
    ...desktopWindowChrome(process.platform),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  if (shouldRemoveWindowMenu(process.platform)) mainWindow.removeMenu();

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  if (qaCapturePath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        try {
          let stableFrames = 0;
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const ready = await mainWindow.webContents.executeJavaScript("Boolean(document.querySelector('.connect-screen') || (document.querySelector('.app-shell') && Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0)))");
            stableFrames = ready ? stableFrames + 1 : 0;
            if (stableFrames >= 4) break;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          await new Promise((resolve) => setTimeout(resolve, 900));
          if (process.env.ESSE_QA_SKIP_INTERACTIONS !== '1') {
            const overlayResult = await mainWindow.webContents.executeJavaScript(`(async () => {
            const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
            const outside = document.querySelector('.batch-workspace');
            const batchTrigger = document.querySelector('.current-batch-trigger');
            const moreTrigger = document.querySelector('.header-more .header-icon-action');
            if (!outside || !batchTrigger || !moreTrigger) return { batchPicker: false, headerMenu: false };
            batchTrigger.click();
            await settle();
            const batchOpened = Boolean(document.querySelector('.current-batch-menu'));
            outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            await settle();
            const batchClosed = !document.querySelector('.current-batch-menu');
            moreTrigger.click();
            await settle();
            const menuOpened = Boolean(document.querySelector('.header-menu'));
            outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            await settle();
            const menuClosed = !document.querySelector('.header-menu');
            const imageTrigger = document.querySelector('.image-card-stage:not(:disabled)');
            imageTrigger?.click();
            await new Promise((resolve) => setTimeout(resolve, 260));
            const lightboxOpened = Boolean(document.querySelector('.lightbox'));
            document.querySelector('.lightbox-stage')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            await settle();
            const lightboxClosed = !document.querySelector('.lightbox');
            outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            await settle();
            const finalOverlaysClosed = !document.querySelector('.current-batch-menu, .header-menu, .image-context-menu, .lightbox');
            return { batchPicker: batchOpened && batchClosed, headerMenu: menuOpened && menuClosed, lightboxMask: lightboxOpened && lightboxClosed, finalOverlaysClosed };
            })()`);
            if (!overlayResult.batchPicker || !overlayResult.headerMenu || !overlayResult.lightboxMask || !overlayResult.finalOverlaysClosed) throw new Error(`Overlay dismissal assertion failed: ${JSON.stringify(overlayResult)}`);
            console.log(`ESSE_QA_OVERLAYS=${JSON.stringify(overlayResult)}`);
          }
          const renderedState = await mainWindow.webContents.executeJavaScript("JSON.stringify({ bridge: typeof window.esse, shell: Boolean(document.querySelector('.app-shell')), connect: Boolean(document.querySelector('.connect-screen')), splash: Boolean(document.querySelector('.splash')), images: Array.from(document.images).map((image) => ({ complete: image.complete, width: image.naturalWidth })) })");
          console.log(`ESSE_QA_STATE=${renderedState}`);
          mainWindow.webContents.invalidate();
          await new Promise((resolve) => setTimeout(resolve, 250));
          const image = await mainWindow.webContents.capturePage();
          await mkdir(path.dirname(qaCapturePath), { recursive: true });
          await writeFile(qaCapturePath, image.toPNG());
          console.log(`ESSE_QA_CAPTURE=${qaCapturePath}`);
          app.exit(0);
        } catch (error) {
          console.error('Esse QA capture failed', error instanceof Error ? error.message : 'unknown error');
          app.exit(1);
        }
      }, 350);
    });
  }

  if (smokeMode) {
    smokeTimer = setTimeout(() => {
      console.error('ESSE_SMOKE_RESULT={"ok":false,"reason":"renderer-timeout"}');
      app.exit(1);
    }, 30_000);
  }
}

function registerIpc(): void {
  ipcMain.handle('state:get', () => loadState());
  ipcMain.handle('providers:save', async (_event, input: SaveProviderInput) => {
    const saved = await providerSettings.saveProvider(input);
    const currentDefault = await desktopSettings.getDefaultOfferingId();
    if (!currentDefault && saved.offerings[0]) await desktopSettings.setDefaultOfferingId(saved.offerings[0].id);
    batchManager.resume();
    return loadState();
  });
  ipcMain.handle('providers:delete', async (_event, id: unknown) => {
    const profileId = requiredId(id, 'Provider');
    const removed = await providerSettings.getProfile(profileId);
    await providerSettings.deleteProvider(profileId);
    const currentDefault = await desktopSettings.getDefaultOfferingId();
    if (currentDefault && removed.offerings.some((offering) => offering.id === currentDefault)) {
      await desktopSettings.setDefaultOfferingId(WORKBUDDY_AGENT_OFFERING.id);
    }
    return loadState();
  });
  ipcMain.handle('providers:test', async (_event, input: { baseUrl: string; profileId?: string; apiKey?: string }) => providerSettings.testProvider(input));
  ipcMain.handle('batches:modify', async (_event, input: ModifyBatchInput) => {
    await batchManager.modify(input);
    return loadState();
  });
  ipcMain.handle('batches:activate', async (_event, batchId: unknown) => {
    await batchManager.activate(requiredId(batchId, 'batch'));
    return loadState();
  });
  ipcMain.handle('batches:cancel-queued', async (_event, batchId: unknown) => {
    await batchManager.cancelQueued(requiredId(batchId, 'batch'));
    return loadState();
  });
  ipcMain.handle('batches:retry', async (_event, batchId: unknown, jobIds: unknown, allowUnknownCharge: unknown) => {
    if (!Array.isArray(jobIds) || !jobIds.every((id) => typeof id === 'string')) throw new Error('Invalid job IDs.');
    if (allowUnknownCharge !== undefined && typeof allowUnknownCharge !== 'boolean') throw new Error('Invalid retry confirmation.');
    await batchManager.retry(requiredId(batchId, 'batch'), jobIds, allowUnknownCharge === true);
    return loadState();
  });
  ipcMain.handle('batches:delete-images', async (_event, batchId: unknown, imageIds: unknown) => {
    if (!Array.isArray(imageIds) || !imageIds.every((id) => typeof id === 'string')) throw new Error('Invalid image IDs.');
    await batchManager.deleteImages(requiredId(batchId, 'batch'), imageIds);
    return loadState();
  });
  ipcMain.handle('batches:delete', async (_event, batchId: unknown) => {
    await batchManager.deleteBatch(requiredId(batchId, 'batch'));
    return loadState();
  });
  ipcMain.handle('settings:set-default-offering', async (_event, offeringId: unknown) => {
    if (typeof offeringId !== 'string') throw new Error('Invalid model ID.');
    const offerings = await batchManager.offerings();
    if (!offerings.some((offering) => offering.id === offeringId && offering.configured)) throw new Error('Model is not available or its Provider has no API Key.');
    await desktopSettings.setDefaultOfferingId(offeringId);
    return loadState();
  });
  ipcMain.handle('images:open', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid image ID.');
    const error = await shell.openPath(await imageStore.pathForId(id));
    if (error) throw new Error(error);
  });
  ipcMain.handle('images:reveal', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid image ID.');
    shell.showItemInFolder(await imageStore.pathForId(id));
  });
  ipcMain.handle('images:metadata', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid image ID.');
    const imagePath = await imageStore.pathForId(id);
    const [details, image] = await Promise.all([stat(imagePath), Promise.resolve(nativeImage.createFromPath(imagePath))]);
    if (image.isEmpty()) return { available: false, sizeBytes: details.size };
    const size = image.getSize();
    return { available: true, width: size.width, height: size.height, sizeBytes: details.size };
  });
  ipcMain.handle('images:copy', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid image ID.');
    const image = nativeImage.createFromPath(await imageStore.pathForId(id));
    if (image.isEmpty()) throw new Error('The local image could not be copied.');
    clipboard.writeImage(image);
  });
  ipcMain.handle('images:save', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid image ID.');
    const image = await imageStore.get(id);
    if (!image) throw new Error('Image not found.');
    const options = {
      title: '保存图片',
      defaultPath: image.fileName,
      filters: [{ name: '图片', extensions: [path.extname(image.fileName).replace(/^\./, '') || 'png'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'] as Array<'showOverwriteConfirmation' | 'createDirectory'>,
    };
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return undefined;
    const source = await imageStore.pathForId(id);
    if (path.resolve(source) !== path.resolve(result.filePath)) await copyFile(source, result.filePath);
    return result.filePath;
  });
  ipcMain.handle('batches:open-folder', async (_event, batchId: unknown) => {
    const batch = batchManager.get(requiredId(batchId, 'batch'));
    const images = batch.jobs.flatMap((job) => [
      ...(job.outputImageId ? [{ id: job.outputImageId, name: job.name }] : []),
      ...job.backups.map((backup) => ({ id: backup.imageId, name: backup.name })),
    ]);
    const batchFolder = await imageStore.prepareBatchFolder(batch.id, batch.title, images);
    const error = await shell.openPath(batchFolder);
    if (error) throw new Error(error);
  });
  ipcMain.handle('mcp:copy-workbuddy-config', async () => {
    if (!mcpServer) throw new Error(mcpError || 'Esse MCP is unavailable.');
    const pairingToken = await mcpPairingStore.getOrCreate();
    clipboard.writeText(JSON.stringify({
      type: 'http',
      url: mcpServer.endpoint,
      headers: { Authorization: `Bearer ${pairingToken}` },
      description: 'Esse local image generation',
    }, null, 2));
  });
  ipcMain.on('smoke:ready', (_event, details: unknown) => {
    if (!smokeMode || smokeReported) return;
    smokeReported = true;
    if (smokeTimer) clearTimeout(smokeTimer);
    const valid = Boolean(details && typeof details === 'object' && (details as { bridgeAvailable?: unknown }).bridgeAvailable === true);
    console.log(`ESSE_SMOKE_RESULT=${JSON.stringify({ ok: valid, platform: process.platform, arch: process.arch, details })}`);
    app.exit(valid ? 0 : 1);
  });
}

async function loadState(): Promise<DesktopState> {
  const batches = batchManager?.list() ?? [];
  const images = await imageStore.list();
  const visibleIds = new Set(images.map((image) => image.id));
  const referenceIds = batches.flatMap((batch) => batch.jobs.flatMap((job) => [
    ...job.referenceImageIds,
    ...job.backups.flatMap((backup) => backup.referenceImageIds ?? []),
  ]));
  for (const imageId of [...new Set(referenceIds)]) {
    if (visibleIds.has(imageId)) continue;
    const image = await imageStore.get(imageId);
    if (image) { images.push(image); visibleIds.add(image.id); }
  }
  const mcp = {
    available: Boolean(mcpServer),
    endpoint: mcpServer?.endpoint || `http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`,
    ...(mcpError ? { error: mcpError } : {}),
  };
  try {
    const [providers, offerings] = await Promise.all([providerSettings.listProfiles(), batchManager.offerings()]);
    const configuredDefault = await desktopSettings.getDefaultOfferingId();
    const defaultOfferingId = offerings.some((offering) => offering.id === configuredDefault && offering.configured)
      ? configuredDefault
      : offerings.filter((offering) => offering.configured).length === 1 ? offerings.find((offering) => offering.configured)?.id : undefined;
    return applyQaFixture({
      configured: true,
      providers,
      offerings,
      defaultOfferingId,
      images,
      batches,
      activeBatchId: batchManager?.getActiveId(),
      mcp,
      platform: process.platform,
      secureStorage: 'OS protected storage',
    });
  } catch (error) {
    return {
      configured: true,
      providers: [],
      offerings: [],
      images,
      batches,
      activeBatchId: batchManager?.getActiveId(),
      mcp,
      platform: process.platform,
      secureStorage: 'OS protected storage',
      error: error instanceof Error ? error.message : 'Unable to load Esse state.',
    };
  }
}

async function startMcpBridge(): Promise<void> {
  try {
    const pairingToken = await mcpPairingStore.getOrCreate();
    mcpServer = await startDesktopMcpServer({
      pairingToken,
      port: smokeMode || Boolean(qaCapturePath) ? 0 : DEFAULT_MCP_PORT,
      batchManager,
      imageStore,
      createImagePreview: createNativeImagePreview,
      onOpenRequested: async ({ tab, batchId }) => {
        if (mainWindow?.isMinimized()) mainWindow.restore();
        mainWindow?.show();
        mainWindow?.focus();
        mainWindow?.webContents.send('navigation:requested', { tab, batchId });
      },
    });
    if (!app.isPackaged && process.env.ESSE_DEV_CONFIGURE_WORKBUDDY === '1') {
      await configureWorkBuddyForDevelopment({ endpoint: mcpServer.endpoint, pairingToken });
    }
  } catch (error) {
    mcpError = error instanceof Error ? error.message : 'Unable to start the local MCP server.';
    console.error('Esse MCP unavailable', mcpError);
  }
}

async function createNativeImagePreview(filePath: string, maxDimension: number): Promise<{ data: string; mimeType: string } | undefined> {
  const source = nativeImage.createFromPath(filePath);
  if (source.isEmpty()) return undefined;
  const size = source.getSize();
  const ratio = Math.min(1, maxDimension / Math.max(size.width, size.height));
  const resized = ratio < 1
    ? source.resize({ width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)), quality: 'good' })
    : source;
  return { data: resized.toPNG().toString('base64'), mimeType: 'image/png' };
}

async function broadcastState(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('state:changed', await loadState());
}

async function createApiClient(): Promise<EsseApiClient> {
  return new EsseApiClient(providerSettings);
}

function requiredId(value: unknown, kind: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid ${kind} ID.`);
  return value;
}

function applyQaFixture(state: DesktopState): DesktopState {
  if (!qaCapturePath || qaFixture !== 'three-images') return state;
  const baseImage = state.images[0];
  const baseBatch = state.batches[0];
  if (!baseImage || !baseBatch || !baseBatch.jobs[0]) return state;
  const imageIds = [baseImage.id, '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
  const images = imageIds.map((id, index) => ({
    ...baseImage,
    id,
    fileName: `qa-image-${index + 1}.png`,
    prompt: ['巨型黑色长角甲虫的微距摄影', '金色甲虫在叶片上的微距摄影', '蓝色甲虫在森林中的微距摄影'][index],
  }));
  const now = new Date().toISOString();
  const jobs = imageIds.map((outputImageId, index) => ({
    ...structuredClone(baseBatch.jobs[0]),
    id: `10000000-0000-4000-8000-00000000000${index + 1}`,
    index,
    name: `图${index + 1}`,
    prompt: images[index].prompt,
    outputImageId,
    status: 'succeeded' as const,
    progress: 100,
    chargeState: 'charged' as const,
    backups: [],
    referenceImageIds: [],
  }));
  const batch = {
    ...baseBatch,
    title: '三种不同的甲虫',
    jobs,
    status: 'completed' as const,
    total: 3,
    queued: 0,
    running: 0,
    succeeded: 3,
    failed: 0,
    canceled: 0,
    updatedAt: now,
  };
  return { ...state, images, batches: [batch], activeBatchId: batch.id };
}

function parseQaViewport(value: string | undefined): { width: number; height: number } | undefined {
  if (!value || app.isPackaged) return undefined;
  const match = value.match(/^(\d{3,4})x(\d{3,4})$/);
  if (!match) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function resolveRuntimeIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'esse.png')
    : path.join(app.getAppPath(), 'assets', 'esse.png');
}

app.on('window-all-closed', () => {
  if (shouldQuitWhenAllWindowsClose()) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('will-quit', () => {
  void mcpServer?.stop();
});
