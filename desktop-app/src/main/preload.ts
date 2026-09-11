import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { DESKTOP_CHANNELS, type DesktopApi } from '../shared/contracts.ts';

const desktopApi: DesktopApi = {
  getState: () => ipcRenderer.invoke(DESKTOP_CHANNELS.getState),
  onStateChanged: listener => {
    const handler = (_event: IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on(DESKTOP_CHANNELS.stateChanged, handler);
    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.stateChanged, handler);
  },
  saveRecord: input => ipcRenderer.invoke(DESKTOP_CHANNELS.saveRecord, input),
  deleteRecord: id => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteRecord, id),
  setRecordFavorite: input => ipcRenderer.invoke(DESKTOP_CHANNELS.setRecordFavorite, input),
  saveCareerFair: input => ipcRenderer.invoke(DESKTOP_CHANNELS.saveCareerFair, input),
  deleteCareerFair: id => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteCareerFair, id),
  importJson: () => ipcRenderer.invoke(DESKTOP_CHANNELS.importJson),
  exportJson: () => ipcRenderer.invoke(DESKTOP_CHANNELS.exportJson),
  importCsv: () => ipcRenderer.invoke(DESKTOP_CHANNELS.importCsv),
  exportCsv: () => ipcRenderer.invoke(DESKTOP_CHANNELS.exportCsv),
  saveWebDav: input => ipcRenderer.invoke(DESKTOP_CHANNELS.saveWebDav, input),
  testWebDav: input => ipcRenderer.invoke(DESKTOP_CHANNELS.testWebDav, input),
  syncNow: () => ipcRenderer.invoke(DESKTOP_CHANNELS.syncNow),
  resolveConflict: choice => ipcRenderer.invoke(DESKTOP_CHANNELS.resolveConflict, choice),
  setupMobileSync: input => ipcRenderer.invoke(DESKTOP_CHANNELS.setupMobileSync, input),
  setMobileSyncEnabled: enabled => ipcRenderer.invoke(DESKTOP_CHANNELS.setMobileSyncEnabled, enabled),
  setDesktopReminderEnabled: enabled => ipcRenderer.invoke(DESKTOP_CHANNELS.setDesktopReminderEnabled, enabled),
  syncMobileNow: () => ipcRenderer.invoke(DESKTOP_CHANNELS.syncMobileNow),
  getMobilePairing: () => ipcRenderer.invoke(DESKTOP_CHANNELS.getMobilePairing),
  scanMail: () => ipcRenderer.invoke(DESKTOP_CHANNELS.scanMail),
  confirmMailReview: input => ipcRenderer.invoke(DESKTOP_CHANNELS.confirmMailReview, input),
  ignoreMailReview: reviewId => ipcRenderer.invoke(DESKTOP_CHANNELS.ignoreMailReview, reviewId),
  ignoreMailReviews: reviewIds => ipcRenderer.invoke(DESKTOP_CHANNELS.ignoreMailReviews, reviewIds),
  openExternal: url => ipcRenderer.invoke(DESKTOP_CHANNELS.openExternal, url),
};

contextBridge.exposeInMainWorld('desktopApi', desktopApi);
