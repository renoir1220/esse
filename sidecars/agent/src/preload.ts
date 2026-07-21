import { contextBridge, ipcRenderer } from 'electron';
import type { EsseDesktopBridge, ModifyBatchInput, SaveProviderInput } from './types';

const bridge: EsseDesktopBridge = {
  platform: process.platform,
  getState: () => ipcRenderer.invoke('state:get'),
  refresh: () => ipcRenderer.invoke('state:get'),
  saveProvider: (input: SaveProviderInput) => ipcRenderer.invoke('providers:save', input),
  deleteProvider: (id: string) => ipcRenderer.invoke('providers:delete', id),
  testProvider: (input) => ipcRenderer.invoke('providers:test', input),
  modifyBatch: (input: ModifyBatchInput) => ipcRenderer.invoke('batches:modify', input),
  activateBatch: (batchId: string) => ipcRenderer.invoke('batches:activate', batchId),
  cancelQueued: (batchId: string) => ipcRenderer.invoke('batches:cancel-queued', batchId),
  retryJobs: (batchId: string, jobIds: string[], allowUnknownCharge = false) => ipcRenderer.invoke('batches:retry', batchId, jobIds, allowUnknownCharge),
  deleteImages: (batchId: string, imageIds: string[]) => ipcRenderer.invoke('batches:delete-images', batchId, imageIds),
  deleteBatch: (batchId: string) => ipcRenderer.invoke('batches:delete', batchId),
  setDefaultOffering: (offeringId: string) => ipcRenderer.invoke('settings:set-default-offering', offeringId),
  openImage: (id: string) => ipcRenderer.invoke('images:open', id),
  revealImage: (id: string) => ipcRenderer.invoke('images:reveal', id),
  getImageMetadata: (id: string) => ipcRenderer.invoke('images:metadata', id),
  copyImage: (id: string) => ipcRenderer.invoke('images:copy', id),
  saveImage: (id: string) => ipcRenderer.invoke('images:save', id),
  openBatchFolder: (batchId: string) => ipcRenderer.invoke('batches:open-folder', batchId),
  copyWorkBuddyConfig: () => ipcRenderer.invoke('mcp:copy-workbuddy-config'),
  onStateChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: Awaited<ReturnType<EsseDesktopBridge['getState']>>) => callback(state);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },
  onNavigate: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, input: { tab: 'batches' | 'settings'; batchId?: string }) => callback(input);
    ipcRenderer.on('navigation:requested', listener);
    return () => ipcRenderer.removeListener('navigation:requested', listener);
  },
  reportReady: (details) => ipcRenderer.send('smoke:ready', details),
};

contextBridge.exposeInMainWorld('esse', bridge);
