import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  checkAdbAndDevice: () => ipcRenderer.invoke('check-adb-and-device'),
  startSync: (settings: { source: string; dest: string; adbPath?: string }) => 
    ipcRenderer.invoke('start-sync', settings),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: { source: string; dest: string; adbPath?: string }) => 
    ipcRenderer.invoke('save-settings', settings),
  openDestFolder: () => ipcRenderer.invoke('open-dest-folder'),
  searchFiles: (query: string, date: string | null) =>
    ipcRenderer.invoke('search-files', { query, date }),
  getFileCalendar: (year: number, month: number) =>
    ipcRenderer.invoke('get-file-calendar', { year, month }),
  openFile: (fullPath: string) =>
    ipcRenderer.invoke('open-file', fullPath),
  pushToPhone: () =>
    ipcRenderer.invoke('push-to-phone'),
  checkPushEligibility: () =>
    ipcRenderer.invoke('check-push-eligibility'),
  installObsidianPlugin: () =>
    ipcRenderer.invoke('install-obsidian-plugin'),
  applyOfflineFile: (path: string, contentB64: string) =>
    ipcRenderer.invoke('apply-offline-file', { path, contentB64 }),
  getOfflineSyncPayload: (lastSyncTimeSeconds: number) =>
    ipcRenderer.invoke('get-offline-sync-payload', lastSyncTimeSeconds),
  onPushCompleted: (callback: (status: { success: boolean; message: string }) => void) => {
    const listener = (_event: any, status: { success: boolean; message: string }) => callback(status);
    ipcRenderer.on('push-completed', listener);
    return () => ipcRenderer.removeListener('push-completed', listener);
  },
  getWebdavInfo: () =>
    ipcRenderer.invoke('get-webdav-info'),
  setMacEditState: (state: 'viewing' | 'requesting-pull' | 'editing' | 'requesting-push' | 'locked') =>
    ipcRenderer.invoke('set-mac-edit-state', state),
  onEditStateChanged: (callback: (data: { state: string; message: string }) => void) => {
    const listener = (_event: any, data: { state: string; message: string }) => callback(data);
    ipcRenderer.on('edit-state-changed', listener);
    return () => ipcRenderer.removeListener('edit-state-changed', listener);
  },
  onWebdavSessionActive: (callback: (active: boolean) => void) => {
    const listener = (_event: any, active: boolean) => callback(active);
    ipcRenderer.on('webdav-session-active', listener);
    return () => ipcRenderer.removeListener('webdav-session-active', listener);
  },
  onWebdavSyncCompleted: (callback: (data: { timestamp: number }) => void) => {
    const listener = (_event: any, data: { timestamp: number }) => callback(data);
    ipcRenderer.on('webdav-sync-completed', listener);
    return () => ipcRenderer.removeListener('webdav-sync-completed', listener);
  },
  onWebdavActivity: (callback: (data: { timestamp: number; method: string; pathname: string }) => void) => {
    const listener = (_event: any, data: { timestamp: number; method: string; pathname: string }) => callback(data);
    ipcRenderer.on('webdav-activity', listener);
    return () => ipcRenderer.removeListener('webdav-activity', listener);
  },
  onLog: (callback: (msg: string) => void) => {
    const listener = (_event: any, msg: string) => callback(msg);
    ipcRenderer.on('log-message', listener);
    return () => ipcRenderer.removeListener('log-message', listener);
  },
  onSyncCompleted: (callback: (status: { success: boolean; message: string }) => void) => {
    const listener = (_event: any, status: { success: boolean; message: string }) => callback(status);
    ipcRenderer.on('sync-completed', listener);
    return () => ipcRenderer.removeListener('sync-completed', listener);
  },
  onSyncProgress: (callback: (percentage: number) => void) => {
    const listener = (_event: any, percentage: number) => callback(percentage);
    ipcRenderer.on('sync-progress', listener);
    return () => ipcRenderer.removeListener('sync-progress', listener);
  }
});

