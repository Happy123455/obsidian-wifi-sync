/// <reference types="vite/client" />

interface Window {
  api: {
    checkAdbAndDevice: () => Promise<{
      success: boolean;
      status?: string;
      message: string;
      device?: { serial: string; model: string; status: string };
      adbResolvedPath: string;
      error?: string;
    }>;
    startSync: (settings: { source: string; dest: string; adbPath?: string }) => Promise<{
      success: boolean;
      message: string;
    }>;
    getSettings: () => Promise<{
      source: string;
      dest: string;
      adbPath: string;
      autoLaunch?: boolean;
      autoSyncOnConnect?: boolean;
    }>;
    saveSettings: (settings: { source: string; dest: string; adbPath: string; autoLaunch?: boolean; autoSyncOnConnect?: boolean }) => Promise<boolean>;
    openDestFolder: () => Promise<boolean>;
    searchFiles: (query: string, date: string | null) => Promise<{ relPath: string; fullPath: string; mtime: number; size: number; snippet: string }[]>;
    getFileCalendar: (year: number, month: number) => Promise<Record<string, number>>;
    openFile: (fullPath: string) => Promise<boolean>;
    pushToPhone: () => Promise<{ success: boolean; message: string }>;
    checkPushEligibility: () => Promise<{ eligible: boolean; remainingSeconds: number; message: string }>;
    installObsidianPlugin: () => Promise<{ success: boolean; message: string }>;
    applyOfflineFile: (path: string, contentB64: string) => Promise<{ success: boolean; message: string }>;
    getOfflineSyncPayload: (lastSyncTimeSeconds: number) => Promise<string[]>;
    onPushCompleted: (callback: (status: { success: boolean; message: string }) => void) => () => void;
    getWebdavInfo: () => Promise<{ ip: string; port: number; url: string; state: 'viewing' | 'requesting-pull' | 'editing' | 'requesting-push' | 'locked'; lastSync: number; isMobileActive: boolean }>;
    setMacEditState: (state: 'viewing' | 'requesting-pull' | 'editing' | 'requesting-push' | 'locked') => Promise<boolean>;
    onEditStateChanged: (callback: (data: { state: 'viewing' | 'requesting-pull' | 'editing' | 'requesting-push' | 'locked'; message: string }) => void) => () => void;
    onWebdavSessionActive: (callback: (active: boolean) => void) => () => void;
    onWebdavSyncCompleted: (callback: (data: { timestamp: number }) => void) => () => void;
    onWebdavActivity: (callback: (data: { timestamp: number; method: string; pathname: string }) => void) => () => void;
    onLog: (callback: (msg: string) => void) => () => void;
    onSyncCompleted: (callback: (status: { success: boolean; message: string }) => void) => () => void;
    onSyncProgress: (callback: (percentage: number) => void) => () => void;
  };
}
