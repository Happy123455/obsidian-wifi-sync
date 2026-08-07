import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, protocol, net, powerSaveBlocker } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, execSync } from 'child_process';
import * as os from 'os';
import * as http from 'http';
import * as url from 'url';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let isSyncingInProgress = false;
let lastSyncCompletedAt = 0;

// WebDAV server and state machine variables
let macEditState: 'viewing' | 'requesting-pull' | 'editing' | 'requesting-push' | 'locked' = 'viewing';
let lastMobileSyncTime = 0;
let webdavServer: http.Server | null = null;
const WEBDAV_PORT = 19000;
let currentSessionActive = false;
let activityTimeout: NodeJS.Timeout | null = null;


const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

interface AppSettings {
  source: string;
  dest: string;
  adbPath: string;
  autoLaunch: boolean;
  autoSyncOnConnect: boolean;
}

const defaultSettings: AppSettings = {
  source: '/sdcard/Daily/Daily',
  dest: path.join(os.homedir(), 'Desktop', 'ultimate daily', 'Daily'),
  adbPath: '',
  autoLaunch: true,
  autoSyncOnConnect: true
};

function applyAutoLaunchSetting(autoLaunch: boolean) {
  if (app.isPackaged) {
    try {
      app.setLoginItemSettings({
        openAtLogin: autoLaunch,
        openAsHidden: autoLaunch
      });
      console.log(`Auto-launch set to: ${autoLaunch}`);
    } catch (err) {
      console.error('Failed to set login item settings:', err);
    }
  }
}

let electronMacLiveState: any = null;
let mobileLiveState: any = null;
let mobileLiveDebounceTimer: any = null;

// Load settings from config.json
function loadSettings(): AppSettings {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      return { ...defaultSettings, ...parsed };
    }
  } catch (err) {
    console.error('Failed to read config file:', err);
  }
  return defaultSettings;
}

// Save settings to config.json
function saveSettings(settings: AppSettings) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(settings, null, 2), 'utf-8');
    applyAutoLaunchSetting(settings.autoLaunch);
    return true;
  } catch (err) {
    console.error('Failed to write config file:', err);
    return false;
  }
}

// Find ADB executable path
function resolveAdbPath(customPath?: string): string {
  if (customPath && customPath.trim() !== '') {
    const expanded = expandPath(customPath);
    if (fs.existsSync(expanded)) {
      return expanded;
    }
  }

  // Candidate paths on macOS
  const candidates = [
    '/opt/homebrew/bin/adb', // Apple Silicon Homebrew
    path.join(os.homedir(), 'Library', 'Android/sdk/platform-tools/adb'), // Android Studio SDK
    '/usr/local/bin/adb', // Intel Homebrew
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback to checking if it is in the PATH env
  try {
    const pathFromWhich = execSync('which adb', { encoding: 'utf-8', env: process.env }).trim();
    if (pathFromWhich && fs.existsSync(pathFromWhich)) {
      return pathFromWhich;
    }
  } catch (e) {
    // Ignore error
  }

  return 'adb'; // Default to command name, hoping it executes
}

// Helper to expand environment variables like $HOME, $USER, or ~
function expandPath(p: string): string {
  let expanded = p;
  if (expanded.startsWith('~')) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  }
  expanded = expanded.replace(/\$HOME/g, os.homedir());
  expanded = expanded.replace(/\$\{HOME\}/g, os.homedir());
  expanded = expanded.replace(/\$USER/g, os.userInfo().username);
  expanded = expanded.replace(/\$\{USER\}/g, os.userInfo().username);
  return path.resolve(expanded);
}

function createTray() {
  // Use a base64 template image so it dynamically changes color with macOS dark/light mode
  const iconBase64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAHtJREFUeNqks0EOwCAIBMH/T/VmLzUmlkL6aYIHD64C7UaMuecZBcCAWAPggBZwAGsA/YwCA1rADHSAHtADBnqQ94DwexYQ+vM87EfYAj7CHuAj7AE+wh7gkW9hEalRPbeoFbI5AnuAhC2m2wS6gB4J/8U8CjAAiA7RDTX6H6AAAAAElFTkSuQmCC';
  const trayIcon = nativeImage.createFromDataURL(`data:image/png;base64,${iconBase64}`);
  trayIcon.setTemplateImage(true);

  tray = new Tray(trayIcon);
  updateTrayMenu('Idle');
  tray.setToolTip('Obsidian Sync');
  tray.setTitle(' 🔄'); // Visible emoji text fallback for MacBooks with notches
}

function updateTrayMenu(statusText: string) {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    { label: `Obsidian USB Sync`, enabled: false },
    { label: `Device Status: ${statusText}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Sync Vault Now',
      enabled: !isSyncingInProgress,
      accelerator: 'CmdOrCtrl+Shift+S',
      click: async () => {
        const settings = loadSettings();
        await triggerSync(settings);
      }
    },
    {
      label: 'Open Obsidian Sync App',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

function createWindow() {
  const isDev = process.argv.includes('--dev');

  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0d10',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL('app://localhost/index.html');

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[RENDERER CONSOLE] Level ${level}: ${message} (at ${sourceId}:${line})`);
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.log(`[LOAD ERROR] URL: ${validatedURL}, Code: ${errorCode}, Description: ${errorDescription}`);
  });

  mainWindow.webContents.on('dom-ready', () => {
    console.log('[DOM READY]');
  });

  mainWindow.webContents.openDevTools();

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('Another instance is already running. Exiting...');
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    console.log('Second instance detected. Focusing existing window...');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });

  app.whenReady().then(() => {
    powerSaveBlocker.start('prevent-app-suspension');
    // Register custom protocol to load local files safely under privileged origin
    protocol.handle('app', (request) => {
      const url = new URL(request.url);
      const pathname = decodeURIComponent(url.pathname);
      const filePath = path.join(__dirname, '..', 'dist', pathname === '/' ? 'index.html' : pathname);
      console.log(`[CUSTOM PROTOCOL] Intercepted: ${request.url} -> ${filePath}`);
      return net.fetch(`file://${filePath}`);
    });

    // Set up IPC Listeners
    ipcMain.handle('get-settings', () => {
      return loadSettings();
    });

    ipcMain.handle('save-settings', (_event, settings: AppSettings) => {
      const success = saveSettings(settings);
      if (success) {
        startWebdavServer(settings.dest);
      }
      return success;
    });

    ipcMain.handle('get-webdav-info', () => {
      return {
        ip: getLocalIpAddress(),
        port: WEBDAV_PORT,
        url: `http://${getLocalIpAddress()}:${WEBDAV_PORT}/`,
        state: macEditState,
        lastSync: lastMobileSyncTime,
        isMobileActive: currentSessionActive || (Date.now() - lastMobileSyncTime < 120000)
      };
    });

    ipcMain.handle('set-mac-edit-state', (_event, state: any) => {
      macEditState = state;
      if (mainWindow) {
        mainWindow.webContents.send('edit-state-changed', {
          state: macEditState,
          message: macEditState === 'editing' ? '🟢 Safe to Edit on Mac' : 
                   macEditState === 'locked' ? '🔴 Locked' : 
                   macEditState === 'requesting-pull' ? '⚠️ Waiting for mobile pull...' :
                   macEditState === 'requesting-push' ? '⚠️ Waiting for mobile push...' :
                   '🟢 View Mode'
        });
      }
      return true;
    });

    ipcMain.handle('check-adb-and-device', async () => {
      const settings = loadSettings();
      const adbPath = resolveAdbPath(settings.adbPath);

      // Verify if ADB executable can be resolved or runs
      try {
        execSync(`"${adbPath}" version`, { env: process.env });
      } catch (e) {
        return {
          success: false,
          error: 'ADB_NOT_FOUND',
          message: 'Android Debug Bridge (ADB) not found. Specify a custom path in Settings or install it using Homebrew (`brew install android-platform-tools`).',
          adbResolvedPath: adbPath
        };
      }

      // Run `adb devices` to check connected devices
      try {
        const output = execSync(`"${adbPath}" devices`, { env: process.env, encoding: 'utf-8' });
        const lines = output.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        
        // First line is "List of devices attached"
        const devices = lines.slice(1).map(line => {
          const parts = line.split(/\s+/);
          return {
            serial: parts[0],
            status: parts[1] // 'device', 'unauthorized', 'offline', etc.
          };
        });

        const activeDevice = devices.find(d => d.status === 'device');

        if (activeDevice) {
          // Try to get device model name
          let model = 'Android Device';
          try {
            model = execSync(`"${adbPath}" -s ${activeDevice.serial} shell getprop ro.product.model`, { 
              env: process.env, 
              encoding: 'utf-8' 
            }).trim();
          } catch (err) {
            // ignore, default to serial
            model = activeDevice.serial;
          }

          return {
            success: true,
            status: 'CONNECTED',
            message: `Connected: ${model}`,
            device: {
              serial: activeDevice.serial,
              model: model,
              status: activeDevice.status
            },
            adbResolvedPath: adbPath
          };
        } else if (devices.length > 0) {
          // There are devices, but not in 'device' (ready) state
          const unauthorizedDevice = devices.find(d => d.status === 'unauthorized');
          if (unauthorizedDevice) {
            return {
              success: false,
              error: 'UNAUTHORIZED_DEVICE',
              message: 'Device connected but unauthorized. Please check your phone and allow USB debugging authorization dialog.',
              adbResolvedPath: adbPath
            };
          }
          return {
            success: false,
            error: 'DEVICE_OFFLINE',
            message: `Device connected in state: ${devices[0].status}. Unplug and replug the USB cable.`,
            adbResolvedPath: adbPath
          };
        } else {
          return {
            success: false,
            error: 'NO_DEVICE',
            message: 'No Android device found. Connect your Samsung Galaxy S23 Ultra via USB and make sure USB debugging is enabled in Developer Options.',
            adbResolvedPath: adbPath
          };
        }
      } catch (err: any) {
        return {
          success: false,
          error: 'ADB_ERROR',
          message: `Error executing ADB command: ${err.message}`,
          adbResolvedPath: adbPath
        };
      }
    });

    ipcMain.handle('start-sync', async (_event, settings: AppSettings) => {
      return triggerSync(settings);
    });

    ipcMain.handle('open-dest-folder', async () => {
      const settings = loadSettings();
      const destPath = expandPath(settings.dest);
      if (fs.existsSync(destPath)) {
        shell.openPath(destPath);
        return true;
      }
      return false;
    });

    ipcMain.handle('install-obsidian-plugin', async () => {
      const settings = loadSettings();
      const destPath = expandPath(settings.dest);
      
      const localPluginDir = path.join(destPath, '.obsidian', 'plugins', 'obsidian-wifi-sync');
      const pluginSrcDir = path.join(__dirname, '..', 'obsidian-plugin');
      
      // 1. Copy to Mac Local Vault
      try {
        fs.mkdirSync(localPluginDir, { recursive: true });
        fs.copyFileSync(path.join(pluginSrcDir, 'main.js'), path.join(localPluginDir, 'main.js'));
        fs.copyFileSync(path.join(pluginSrcDir, 'manifest.json'), path.join(localPluginDir, 'manifest.json'));
      } catch (err: any) {
        return { success: false, message: `Failed to install on Mac vault: ${err.message}` };
      }

      // 2. Check if phone is connected via USB to push it directly
      const adbPath = resolveAdbPath(settings.adbPath);
      let phonePushed = false;
      try {
        const output = execSync(`"${adbPath}" devices`, { env: process.env, encoding: 'utf-8' });
        const lines = output.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        
        const devices = lines.slice(1).map(line => {
          const parts = line.split(/\s+/);
          return { serial: parts[0], status: parts[1] };
        });
        
        const readyDevice = devices.find(d => d.status === 'device');
        
        if (readyDevice) {
          // Phone connected and authorized! Push plugin files directly to S23 Ultra vault
          const phonePluginDir = `${settings.source}/.obsidian/plugins/obsidian-wifi-sync`;
          execSync(`"${adbPath}" shell "mkdir -p '${phonePluginDir}'"`, { env: process.env });
          execSync(`"${adbPath}" push "${path.join(pluginSrcDir, 'main.js')}" "${phonePluginDir}/main.js"`, { env: process.env });
          execSync(`"${adbPath}" push "${path.join(pluginSrcDir, 'manifest.json')}" "${phonePluginDir}/manifest.json"`, { env: process.env });
          phonePushed = true;
        }
      } catch (e) {
        // Phone push failed or phone not connected, but Mac install succeeded
      }

      if (phonePushed) {
        return { success: true, message: 'Successfully installed Wi-Fi Sync Plugin on both Mac and S23 Ultra!' };
      } else {
        return { success: true, message: 'Installed on Mac vault! Connect your S23 Ultra via USB with authorization enabled, then click this button again to install on the phone automatically.' };
      }
    });

    ipcMain.handle('apply-offline-file', async (_event, { path: relPath, contentB64 }: { path: string; contentB64: string }) => {
      const settings = loadSettings();
      const destPath = expandPath(settings.dest);
      const targetPath = path.join(destPath, relPath);
      
      // Safety check: protect against path traversal
      if (!targetPath.startsWith(destPath)) {
        return { success: false, message: 'Access denied: Path traversal detected.' };
      }

      try {
        if (contentB64 === '__DELETE__') {
          if (fs.existsSync(targetPath)) {
            fs.unlinkSync(targetPath);
          }
          return { success: true, message: `Deleted ${relPath} offline` };
        } else {
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.writeFileSync(targetPath, Buffer.from(contentB64, 'base64'));
          return { success: true, message: `Updated ${relPath} offline` };
        }
      } catch (err: any) {
        return { success: false, message: `Failed to write offline file: ${err.message}` };
      }
    });

    ipcMain.handle('get-offline-sync-payload', async (_event, lastSyncTimeSeconds: number) => {
      const settings = loadSettings();
      const destPath = expandPath(settings.dest);
      const localFilesMap = new Map<string, { mtime: number; size: number }>();
      
      try {
        if (fs.existsSync(destPath)) {
          getLocalFilesRecursive(destPath, destPath, localFilesMap);
        }
      } catch (e) {}

      const changedFiles: { path: string; contentB64: string }[] = [];
      
      for (const [relPath, details] of localFilesMap.entries()) {
        if (details.mtime > lastSyncTimeSeconds) {
          try {
            const fullPath = path.join(destPath, relPath);
            const content = fs.readFileSync(fullPath);
            changedFiles.push({
              path: relPath,
              contentB64: content.toString('base64')
            });
          } catch (err) {}
        }
      }

      if (changedFiles.length === 0) {
        return [];
      }

      const CHUNK_SIZE = 1200; 
      let allChunks: { path: string; chunkIndex: number; totalChunksForFile: number; chunkData: string }[] = [];
      
      for (const op of changedFiles) {
        const total = Math.ceil(op.contentB64.length / CHUNK_SIZE) || 1;
        for (let i = 0; i < total; i++) {
          const chunkStr = op.contentB64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
          allChunks.push({
            path: op.path,
            chunkIndex: i + 1,
            totalChunksForFile: total,
            chunkData: chunkStr
          });
        }
      }

      return allChunks.map((c, idx) => {
        return `${idx + 1}/${allChunks.length}|${c.path}|${c.chunkIndex}/${c.totalChunksForFile}|${c.chunkData}`;
      });
    });

    // Search files in the synced destination folder
    ipcMain.handle('search-files', async (_event, params: { query: string; date: string | null }) => {
      const settings = loadSettings();
      const destPath = expandPath(settings.dest);
      if (!fs.existsSync(destPath)) return [];

      const { query, date } = params;
      const searchableExts = ['.md', '.canvas', '.txt', '.json'];
      const allExts = [...searchableExts, '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.pdf'];
      const results: { relPath: string; fullPath: string; mtime: number; size: number; snippet: string }[] = [];

      // Parse date filter boundaries
      let dateStart = 0;
      let dateEnd = Infinity;
      if (date) {
        const d = new Date(date + 'T00:00:00');
        dateStart = Math.floor(d.getTime() / 1000);
        dateEnd = dateStart + 86400; // next day
      }

      const walkDir = (dir: string) => {
        if (results.length >= 200) return;
        let items: string[];
        try {
          items = fs.readdirSync(dir);
        } catch {
          return;
        }
        for (const item of items) {
          if (results.length >= 200) return;
          const fullPath = path.join(dir, item);
          const relPath = path.relative(destPath, fullPath);

          // Skip Photos folder
          const parts = relPath.split(path.sep);
          if (parts.some(part => part.toLowerCase() === 'photos')) continue;

          let stat: fs.Stats;
          try {
            stat = fs.statSync(fullPath);
          } catch {
            continue;
          }

          if (stat.isDirectory()) {
            walkDir(fullPath);
            continue;
          }

          const ext = path.extname(item).toLowerCase();
          if (!allExts.includes(ext)) continue;

          const mtime = Math.floor(stat.mtimeMs / 1000);

          // Date filter
          if (date && (mtime < dateStart || mtime >= dateEnd)) continue;

          // Query filter
          const queryLower = (query || '').toLowerCase().trim();
          let snippet = '';

          if (queryLower) {
            // Check filename match
            const nameMatch = item.toLowerCase().includes(queryLower);

            // Check content match for text files
            let contentMatch = false;
            if (searchableExts.includes(ext)) {
              try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const idx = content.toLowerCase().indexOf(queryLower);
                if (idx !== -1) {
                  contentMatch = true;
                  // Extract snippet around match
                  const snippetStart = Math.max(0, idx - 60);
                  const snippetEnd = Math.min(content.length, idx + queryLower.length + 90);
                  snippet = (snippetStart > 0 ? '...' : '') +
                    content.substring(snippetStart, snippetEnd).replace(/\n/g, ' ').trim() +
                    (snippetEnd < content.length ? '...' : '');
                }
              } catch {
                // Can't read file content
              }
            }

            if (!nameMatch && !contentMatch) continue;
          }

          results.push({ relPath, fullPath, mtime, size: stat.size, snippet });
        }
      };

      walkDir(destPath);

      // Sort by mtime descending (newest first)
      results.sort((a, b) => b.mtime - a.mtime);
      return results;
    });

    // Get file calendar data (dates with file counts for a month)
    ipcMain.handle('get-file-calendar', async (_event, params: { year: number; month: number }) => {
      const settings = loadSettings();
      const destPath = expandPath(settings.dest);
      if (!fs.existsSync(destPath)) return {};

      const { year, month } = params;
      const dateCounts: Record<string, number> = {};

      const walkForDates = (dir: string) => {
        let items: string[];
        try {
          items = fs.readdirSync(dir);
        } catch {
          return;
        }
        for (const item of items) {
          const fullPath = path.join(dir, item);
          const relPath = path.relative(destPath, fullPath);

          // Skip Photos folder
          const parts = relPath.split(path.sep);
          if (parts.some(part => part.toLowerCase() === 'photos')) continue;

          let stat: fs.Stats;
          try {
            stat = fs.statSync(fullPath);
          } catch {
            continue;
          }

          if (stat.isDirectory()) {
            walkForDates(fullPath);
            continue;
          }

          const d = new Date(stat.mtimeMs);
          if (d.getFullYear() === year && d.getMonth() === month) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            dateCounts[dateStr] = (dateCounts[dateStr] || 0) + 1;
          }
        }
      };

      walkForDates(destPath);
      return dateCounts;
    });

    // Open a specific file in the default app
    ipcMain.handle('open-file', async (_event, fullPath: string) => {
      try {
        await shell.openPath(fullPath);
        return true;
      } catch {
        return false;
      }
    });

    // Check if push-to-phone is eligible (within 30 seconds of last successful sync)
    ipcMain.handle('check-push-eligibility', async () => {
      if (lastSyncCompletedAt === 0) {
        return { eligible: false, remainingSeconds: 0, message: 'No recent sync. Pull from phone first.' };
      }
      const elapsed = (Date.now() - lastSyncCompletedAt) / 1000;
      const remaining = Math.max(0, 30 - elapsed);
      if (remaining <= 0) {
        return { eligible: false, remainingSeconds: 0, message: 'Push window expired. Sync from phone again first.' };
      }
      return { eligible: true, remainingSeconds: Math.ceil(remaining), message: `Push available for ${Math.ceil(remaining)}s` };
    });

    // Push files from Mac back to phone (reverse sync)
    ipcMain.handle('push-to-phone', async () => {
      // Safety check: must be within 30 seconds of last successful sync
      const elapsed = (Date.now() - lastSyncCompletedAt) / 1000;
      if (elapsed > 30) {
        return { success: false, message: 'Push window expired (30s). Pull from phone first to re-enable.' };
      }

      if (isSyncingInProgress) {
        return { success: false, message: 'A sync is already in progress.' };
      }

      isSyncingInProgress = true;
      updateTrayMenu('Pushing...');
      tray?.setTitle(' ⬆️ Pushing...');

      const settings = loadSettings();
      const adbPath = resolveAdbPath(settings.adbPath);
      const sourcePath = settings.source; // Phone path
      const destPath = expandPath(settings.dest); // Mac path

      const logToWindow = (prefix: string, text: string) => {
        mainWindow?.webContents.send('log-message', `${prefix}${text}`);
      };

      logToWindow('[INFO] ', '⬆️ Starting Mac → Phone push transfer...');

      // Get remote files list (what's on phone)
      let remoteOutput = '';
      try {
        const listCmd = `"${adbPath}" shell "find '${sourcePath}' -type f -exec stat -c '%Y %s %n' {} +"`;
        remoteOutput = execSync(listCmd, { env: process.env, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
      } catch (err: any) {
        logToWindow('[ERROR] ', `Failed to read phone file list: ${err.message}`);
        mainWindow?.webContents.send('push-completed', { success: false, message: 'Failed to scan phone' });
        isSyncingInProgress = false;
        updateTrayMenu('Idle');
        tray?.setTitle(' ⚠️ Push Failed');
        setTimeout(() => tray?.setTitle(''), 4000);
        return { success: false, message: 'Failed to scan phone' };
      }

      // Parse remote files
      const remoteFiles = new Map<string, { mtime: number, size: number }>();
      const remoteLines = remoteOutput.split(/[\r\n]+/);
      for (const line of remoteLines) {
        if (line.trim().length === 0) continue;
        const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (match) {
          const mtime = parseInt(match[1]);
          const size = parseInt(match[2]);
          const fullPath = match[3];
          const relPath = path.relative(sourcePath, fullPath);
          remoteFiles.set(relPath, { mtime, size });
        }
      }

      // Scan local files (Mac side)
      const localFiles = new Map<string, { mtime: number, size: number }>();
      try {
        if (fs.existsSync(destPath)) {
          getLocalFilesRecursive(destPath, destPath, localFiles);
        }
      } catch (err: any) {
        logToWindow('[WARN] ', `Failed to scan local folder: ${err.message}`);
      }

      // Find files to push: exist on Mac but newer or not on phone
      const toPush: { relPath: string, localPath: string }[] = [];
      for (const [relPath, localFile] of localFiles.entries()) {
        const remoteFile = remoteFiles.get(relPath);
        if (!remoteFile) {
          toPush.push({ relPath, localPath: path.join(destPath, relPath) });
        } else {
          const isNewer = localFile.mtime > remoteFile.mtime + 2;
          const isSizeDifferent = localFile.size !== remoteFile.size;
          if (isNewer || isSizeDifferent) {
            toPush.push({ relPath, localPath: path.join(destPath, relPath) });
          }
        }
      }

      if (toPush.length === 0) {
        logToWindow('[SUCCESS] ', '⬆️ Phone is already up to date with Mac! Nothing to push.');
        mainWindow?.webContents.send('push-completed', { success: true, message: 'Phone already up to date' });
        isSyncingInProgress = false;
        updateTrayMenu('Idle');
        tray?.setTitle(' ✅ Up to date');
        setTimeout(() => tray?.setTitle(''), 4000);
        return { success: true, message: 'Phone already up to date' };
      }

      logToWindow('[INFO] ', `⬆️ Pushing ${toPush.length} file(s) from Mac to phone...`);

      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < toPush.length; i++) {
        const file = toPush[i];
        const remoteDest = path.posix.join(sourcePath, file.relPath);
        const remoteDir = path.posix.dirname(remoteDest);

        try {
          // Ensure remote directory exists
          execSync(`"${adbPath}" shell "mkdir -p '${remoteDir}'"`, { env: process.env });
          logToWindow('[INFO] ', `⬆️ [${i + 1}/${toPush.length}] Pushing: ${file.relPath}`);
          execSync(`"${adbPath}" push "${file.localPath}" "${remoteDest}"`, { env: process.env });
          successCount++;
          const pct = Math.round((successCount / toPush.length) * 100);
          mainWindow?.webContents.send('sync-progress', pct);
        } catch (err: any) {
          logToWindow('[ERROR] ', `Failed to push ${file.relPath}: ${err.message}`);
          failCount++;
        }
      }

      isSyncingInProgress = false;
      updateTrayMenu('Idle');

      if (failCount === 0) {
        logToWindow('[SUCCESS] ', `⬆️ Push completed! Successfully pushed ${successCount} file(s) to phone.`);
        mainWindow?.webContents.send('push-completed', { success: true, message: 'Push Completed Successfully' });
        tray?.setTitle(' ✅ Pushed');
        setTimeout(() => tray?.setTitle(''), 4000);
        return { success: true, message: 'Push completed successfully' };
      } else {
        logToWindow('[WARN] ', `⬆️ Push finished with warnings: Pushed ${successCount}, failed ${failCount}.`);
        mainWindow?.webContents.send('push-completed', { success: false, message: 'Push finished with warnings' });
        tray?.setTitle(' ⚠️ Push errors');
        setTimeout(() => tray?.setTitle(''), 4000);
        return { success: false, message: 'Push finished with errors' };
      }
    });

    createTray();
    createWindow();

    // Configure macOS Login Items auto-launch on startup (minimized to status bar)
    const currentSettings = loadSettings();
    applyAutoLaunchSetting(currentSettings.autoLaunch);
    startWebdavServer(currentSettings.dest);

    // Background USB Hot-plug connection detection (every 4 seconds)
    let lastDeviceState = false;
    setInterval(async () => {
      if (isSyncingInProgress) return;
      const settings = loadSettings();
      
      // If autoSyncOnConnect is false, do not check or trigger automatic action
      if (!settings.autoSyncOnConnect) {
        lastDeviceState = false; // Reset so that when they turn it back on, it triggers
        return;
      }

      const adbPath = resolveAdbPath(settings.adbPath);
      try {
        const output = execSync(`"${adbPath}" devices`, { env: process.env, encoding: 'utf-8' });
        const lines = output.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const devices = lines.slice(1).map(line => {
          const parts = line.split(/\s+/);
          return parts[1];
        });
        const isConnected = devices.includes('device');
        
        if (isConnected && !lastDeviceState) {
          // Samsung Galaxy phone was just plugged in!
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          } else {
            createWindow();
          }
          
          // Trigger automated incremental sync after a brief delay
          setTimeout(() => {
            triggerSync(settings);
          }, 1500);
        }
        lastDeviceState = isConnected;
      } catch (e) {
        // Ignore error
      }
    }, 4000);

    app.on('activate', () => {
      if (mainWindow) {
        mainWindow.show();
      } else {
        createWindow();
      }
    });
  });
}

async function triggerSync(settings: AppSettings): Promise<{ success: boolean; message: string }> {
  if (isSyncingInProgress) {
    return { success: false, message: 'Sync already in progress' };
  }

  isSyncingInProgress = true;
  updateTrayMenu('Syncing...');
  tray?.setTitle(' Syncing...');

  const adbPath = resolveAdbPath(settings.adbPath);
  const sourcePath = settings.source;
  const destPath = expandPath(settings.dest);

  const logToWindow = (prefix: string, text: string) => {
    mainWindow?.webContents.send('log-message', `${prefix}${text}`);
  };

  logToWindow('[INFO] ', 'Scanning phone and local folders for changes...');

  // Clean up duplicate nested Daily/Daily folder if it exists
  const duplicatePath = path.join(destPath, 'Daily');
  if (fs.existsSync(duplicatePath) && fs.statSync(duplicatePath).isDirectory()) {
    logToWindow('[INFO] ', 'Cleaning up duplicate nested Daily folder...');
    try {
      fs.rmSync(duplicatePath, { recursive: true, force: true });
      logToWindow('[SUCCESS] ', 'Duplicate nested folder cleaned up successfully.');
    } catch (err: any) {
      logToWindow('[WARN] ', `Could not clean up nested folder: ${err.message}`);
    }
  }

  // Ensure destPath parent exists
  try {
    fs.mkdirSync(destPath, { recursive: true });
  } catch (e: any) {
    logToWindow('[ERROR] ', `Failed to create destination directory: ${e.message}`);
    mainWindow?.webContents.send('sync-completed', { success: false, message: 'Failed to prepare destination path' });
    isSyncingInProgress = false;
    updateTrayMenu('Idle');
    tray?.setTitle(' ⚠️ Error');
    setTimeout(() => tray?.setTitle(''), 4000);
    return { success: false, message: 'Failed to prepare destination path' };
  }

  // Get remote files list
  let remoteOutput = '';
  try {
    const listCmd = `"${adbPath}" shell "find '${sourcePath}' -type f -exec stat -c '%Y %s %n' {} +"`;
    remoteOutput = execSync(listCmd, { env: process.env, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  } catch (err: any) {
    logToWindow('[ERROR] ', `Failed to read phone file list: ${err.message}. Make sure your phone is connected and unlocked.`);
    mainWindow?.webContents.send('sync-completed', { success: false, message: 'Failed to scan phone' });
    isSyncingInProgress = false;
    updateTrayMenu('Idle');
    tray?.setTitle(' ⚠️ Scan Failed');
    setTimeout(() => tray?.setTitle(''), 4000);
    return { success: false, message: 'Failed to scan phone' };
  }

  // Parse remote files
  const remoteFiles = new Map<string, { mtime: number, size: number, fullPath: string }>();
  const remoteLines = remoteOutput.split(/[\r\n]+/);
  for (const line of remoteLines) {
    if (line.trim().length === 0) continue;
    const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (match) {
      const mtime = parseInt(match[1]);
      const size = parseInt(match[2]);
      const fullPath = match[3];
      const relPath = path.relative(sourcePath, fullPath);
      remoteFiles.set(relPath, { mtime, size, fullPath });
    }
  }

  // Scan local files
  const localFiles = new Map<string, { mtime: number, size: number }>();
  try {
    if (fs.existsSync(destPath)) {
      getLocalFilesRecursive(destPath, destPath, localFiles);
    }
  } catch (err: any) {
    logToWindow('[WARN] ', `Failed to scan local folder: ${err.message}`);
  }

  // Compare to find files that need syncing
  const toPull: { relPath: string, fullPath: string }[] = [];
  for (const [relPath, remoteFile] of remoteFiles.entries()) {
    const localFile = localFiles.get(relPath);
    if (!localFile) {
      toPull.push({ relPath, fullPath: remoteFile.fullPath });
    } else {
      // Remote file is newer (allowing 2-sec buffer) or different size
      const isNewer = remoteFile.mtime > localFile.mtime + 2;
      const isSizeDifferent = remoteFile.size !== localFile.size;
      if (isNewer || isSizeDifferent) {
        toPull.push({ relPath, fullPath: remoteFile.fullPath });
      }
    }
  }

  if (toPull.length === 0) {
    logToWindow('[SUCCESS] ', 'Obsidian vault is already up to date! No files to sync.');
    lastSyncCompletedAt = Date.now();
    mainWindow?.webContents.send('sync-completed', { success: true, message: 'Everything up to date' });
    isSyncingInProgress = false;
    updateTrayMenu('Idle');
    tray?.setTitle(' ✅ Up to date');
    setTimeout(() => tray?.setTitle(''), 4000);
    return { success: true, message: 'Everything up to date' };
  }

  logToWindow('[INFO] ', `Sync analysis: ${toPull.length} of ${remoteFiles.size} files need updating.`);

  // Hybrid Sync Strategy
  if (toPull.length <= 150) {
    logToWindow('[INFO] ', `Pulling ${toPull.length} modified files individually...`);
    
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < toPull.length; i++) {
      const file = toPull[i];
      const localFilePath = path.join(destPath, file.relPath);
      
      // Ensure local directory exists
      fs.mkdirSync(path.dirname(localFilePath), { recursive: true });

      try {
        logToWindow('[INFO] ', `[${i + 1}/${toPull.length}] Syncing: ${file.relPath}`);
        execSync(`"${adbPath}" pull -a "${file.fullPath}" "${localFilePath}"`, { env: process.env });
        successCount++;
        // Dispatch progress percentage to UI
        const pct = Math.round((successCount / toPull.length) * 100);
        mainWindow?.webContents.send('sync-progress', pct);
      } catch (err: any) {
        logToWindow('[ERROR] ', `Failed to pull ${file.relPath}: ${err.message}`);
        failCount++;
      }
    }

    // Perform deletions of files moved/deleted on the phone, while protecting Photos
    performDeletionsAndCleanup(destPath, remoteFiles, logToWindow);

    isSyncingInProgress = false;
    updateTrayMenu('Idle');

    if (failCount === 0) {
      logToWindow('[SUCCESS] ', `Incremental sync completed! Successfully pulled ${successCount} files.`);
      lastSyncCompletedAt = Date.now();
      mainWindow?.webContents.send('sync-completed', { success: true, message: 'Sync Completed Successfully' });
      tray?.setTitle(' ✅ Synced');
      setTimeout(() => tray?.setTitle(''), 4000);
      return { success: true, message: 'Sync completed successfully' };
    } else {
      logToWindow('[WARN] ', `Sync finished with warnings: Pulled ${successCount} files, failed ${failCount} files.`);
      mainWindow?.webContents.send('sync-completed', { success: false, message: 'Sync finished with warnings' });
      tray?.setTitle(' ⚠️ Finished with errors');
      setTimeout(() => tray?.setTitle(''), 4000);
      return { success: false, message: 'Sync finished with errors' };
    }
  } else {
    // If more than 150 files are different, it is much faster to pull the whole folder in one command
    logToWindow('[INFO] ', `Large change volume detected (${toPull.length} files). Performing a full directory pull for performance...`);

    // Append '/.' to source path to pull directory contents instead of creating a nested directory
    const remoteSrc = sourcePath.endsWith('/') ? sourcePath + '.' : sourcePath + '/.';
    const adbProcess = spawn(adbPath, ['pull', '-a', remoteSrc, destPath], {
      env: process.env
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';

    const sendChunks = (buffer: string, isStderr = false) => {
      const parts = buffer.split(/[\r\n]+/);
      const lastPart = parts.pop() || '';
      for (const line of parts) {
        if (line.trim().length > 0) {
          // Parse progress percentage to send to UI
          const progressMatch = line.match(/^\s*\[\s*(\d+)%/);
          if (progressMatch) {
            const percent = parseInt(progressMatch[1]);
            mainWindow?.webContents.send('sync-progress', percent);
            continue;
          }
          const logPrefix = isStderr ? '[ERROR] ' : '';
          logToWindow(logPrefix, line);
        }
      }
      return lastPart;
    };

    adbProcess.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
      stdoutBuffer = sendChunks(stdoutBuffer);
    });

    adbProcess.stderr.on('data', (data) => {
      stderrBuffer += data.toString();
      stderrBuffer = sendChunks(stderrBuffer, true);
    });

    return new Promise((resolve) => {
      adbProcess.on('close', (code) => {
        if (stdoutBuffer.trim().length > 0) {
          logToWindow('', stdoutBuffer);
        }
        if (stderrBuffer.trim().length > 0) {
          logToWindow('[ERROR] ', stderrBuffer);
        }

        isSyncingInProgress = false;
        updateTrayMenu('Idle');

        if (code === 0) {
          // Perform deletions of files moved/deleted on the phone, while protecting Photos
          performDeletionsAndCleanup(destPath, remoteFiles, logToWindow);

          logToWindow('[SUCCESS] ', 'Full directory sync completed successfully!');
          lastSyncCompletedAt = Date.now();
          mainWindow?.webContents.send('sync-completed', { success: true, message: 'Sync Completed Successfully' });
          tray?.setTitle(' ✅ Synced');
          setTimeout(() => tray?.setTitle(''), 4000);
          resolve({ success: true, message: 'Sync completed successfully' });
        } else {
          logToWindow('[ERROR] ', `Full directory sync failed with exit code ${code}`);
          mainWindow?.webContents.send('sync-completed', { success: false, message: `Sync failed (Exit Code: ${code})` });
          tray?.setTitle(' ⚠️ Failed');
          setTimeout(() => tray?.setTitle(''), 4000);
          resolve({ success: false, message: `Sync failed (Exit Code: ${code})` });
        }
      });

      adbProcess.on('error', (err) => {
        logToWindow('[ERROR] ', `ADB Sync Spawn Error: ${err.message}`);
        mainWindow?.webContents.send('sync-completed', { success: false, message: `Spawn error: ${err.message}` });
        isSyncingInProgress = false;
        updateTrayMenu('Idle');
        tray?.setTitle(' ⚠️ Error');
        setTimeout(() => tray?.setTitle(''), 4000);
        resolve({ success: false, message: `Spawn error: ${err.message}` });
      });
    });
  }
}

// Helper to recursively list local files, excluding Photos folder (case-insensitive)
function getLocalFilesRecursive(dir: string, baseDir: string, filesMap: Map<string, { mtime: number, size: number }>) {
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const relPath = path.relative(baseDir, fullPath);
    
    // Skip checking or adding any item inside a folder named 'Photos' (case-insensitive) or any hidden/dot folder like .trash
    const parts = relPath.split(path.sep);
    if (parts.some(part => part.toLowerCase() === 'photos' || part.startsWith('.'))) {
      continue;
    }

    const ext = item.split('.').pop()?.toLowerCase() || '';
    if (['blend', 'blend1', 'blend2', 'blend3', 'fbx', 'obj', 'stl', 'psd', 'ai', 'exe', 'dmg', 'iso'].includes(ext)) {
      continue;
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      getLocalFilesRecursive(fullPath, baseDir, filesMap);
    } else {
      filesMap.set(relPath, {
        mtime: Math.floor(stat.mtimeMs / 1000),
        size: stat.size
      });
    }
  }
}

// Helper to clean empty directories, protecting the 'Photos' folder and the root destination folder
function cleanEmptyDirs(dir: string, baseDir: string) {
  const relPath = path.relative(baseDir, dir);
  const parts = relPath.split(path.sep);
  
  if (parts.some(part => part.toLowerCase() === 'photos')) {
    return;
  }

  if (!fs.existsSync(dir)) return;
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) return;

  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    if (fs.statSync(fullPath).isDirectory()) {
      cleanEmptyDirs(fullPath, baseDir);
    }
  }

  // Re-read after cleaning subdirectories
  const remaining = fs.readdirSync(dir);
  if (remaining.length === 0 && dir !== baseDir) {
    try {
      fs.rmdirSync(dir);
    } catch (e) {
      // ignore
    }
  }
}

// Safe Non-Destructive Sync: Mobile data has priority and files are NEVER auto-deleted!
function performDeletionsAndCleanup(
  destPath: string,
  remoteFiles: Map<string, any>,
  logToWindow: (prefix: string, text: string) => void
) {
  logToWindow('[INFO] ', 'Mobile Priority active: Safe non-destructive sync (Files are never deleted).');
  try {
    cleanEmptyDirs(destPath, destPath);
  } catch (err: any) {
    logToWindow('[WARN] ', `Failed to clean up empty directories: ${err.message}`);
  }
}

// Helper to escape XML characters
function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

// Find local IPv4 address
function getLocalIpAddress(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const netInterface of interfaces[name] || []) {
      if (netInterface.family === 'IPv4' && !netInterface.internal) {
        return netInterface.address;
      }
    }
  }
  return '127.0.0.1';
}

// WebDAV Activity Logger & Session Detection
function reportWebdavActivity(req: http.IncomingMessage, pathname: string) {
  lastMobileSyncTime = Date.now();

  if (mainWindow) {
    mainWindow.webContents.send('webdav-activity', {
      timestamp: lastMobileSyncTime,
      method: req.method,
      pathname
    });
    mainWindow.webContents.send('log-message', `[WEBDAV] ${req.method || 'GET'} ${pathname}`);
  }

  if (!currentSessionActive) {
    currentSessionActive = true;
    if (mainWindow) {
      mainWindow.webContents.send('log-message', `[INFO] S23 Ultra connected to WebDAV (${req.method} ${pathname})`);
      mainWindow.webContents.send('webdav-session-active', true);
    }
  }

  if (activityTimeout) {
    clearTimeout(activityTimeout);
  }

  activityTimeout = setTimeout(() => {
    currentSessionActive = false;
    lastSyncCompletedAt = Date.now();

    if (mainWindow) {
      mainWindow.webContents.send('log-message', `[SUCCESS] Mobile sync session completed successfully.`);
      mainWindow.webContents.send('webdav-session-active', false);
      mainWindow.webContents.send('webdav-sync-completed', { timestamp: Date.now() });
    }

    // Handle editing cover state transitions on sync completion
    if (macEditState === 'requesting-pull') {
      macEditState = 'editing';
      if (mainWindow) {
        mainWindow.webContents.send('edit-state-changed', {
          state: 'editing',
          message: '🟢 Safe to Edit on Mac'
        });
      }
    } else if (macEditState === 'requesting-push') {
      macEditState = 'locked';
      if (mainWindow) {
        mainWindow.webContents.send('edit-state-changed', {
          state: 'locked',
          message: '🔴 Locked'
        });
      }
    }
  }, 4000); // 4 seconds of idle time marks sync complete
}

// WebDAV HTTP handler
function handleWebdavRequest(req: http.IncomingMessage, res: http.ServerResponse, destPath: string) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Depth, User-Agent, X-File-Size, X-Requested-With, If-Modified-Since, X-File-Name, Cache-Control');
  res.setHeader('Access-Control-Expose-Headers', 'DAV, content-length, Allow');

  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'DAV': '1',
      'Allow': 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY'
    });
    res.end();
    return;
  }

  // Basic authentication check
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Obsidian Sync"'
    });
    res.end('Unauthorized');
    return;
  }

  const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf-8');
  if (credentials !== 'obsidian:sync') {
    res.writeHead(401);
    res.end('Invalid credentials');
    return;
  }

  const parsedUrl = url.parse(req.url || '/');
  let pathname = decodeURIComponent(parsedUrl.pathname || '/');

  // Custom API endpoints for custom Wi-Fi sync plugin
  if (pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      state: macEditState,
      lastSync: lastMobileSyncTime,
      isMobileActive: currentSessionActive || (Date.now() - lastMobileSyncTime < 120000)
    }));
    return;
  }

  if (pathname === '/api/live-stream-poll') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(electronMacLiveState || { mtime: 0 }));
    return;
  }

  if (pathname === '/api/set-mode') {
    const parsedUrl = new URL(req.url || '/', 'http://localhost:19000');
    const newMode = parsedUrl.searchParams.get('mode') || 'live';
    if (mobileLiveState) {
      mobileLiveState.syncMode = newMode;
    } else {
      mobileLiveState = { syncMode: newMode, mtime: Date.now() };
    }
    if (electronMacLiveState) {
      electronMacLiveState.syncMode = newMode;
    } else {
      electronMacLiveState = { syncMode: newMode, mtime: Date.now() };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', mode: newMode }));
    return;
  }

  if (pathname === '/api/mobile-live-poll') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mobileLiveState || { mtime: 0 }));
    return;
  }

  if (pathname === '/api/live-post' && req.method === 'POST') {
    const chunks: any[] = [];
    req.on('data', (c: any) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        electronMacLiveState = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (e: any) {
        res.writeHead(400);
        res.end('Bad JSON');
      }
    });
    return;
  }

  if (pathname === '/api/files') {
    const localFilesMap = new Map<string, { mtime: number; size: number }>();
    try {
      if (fs.existsSync(destPath)) {
        getLocalFilesRecursive(destPath, destPath, localFilesMap);
      }
    } catch (e) {}

    const filesArray = Array.from(localFilesMap.entries()).map(([relPath, details]) => ({
      path: relPath,
      mtime: details.mtime,
      size: details.size
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ files: filesArray }));
    return;
  }
  
  // Standardize path mapping to destPath
  let relPath = pathname.replace(/^\//, '');
  if (relPath.startsWith('Daily/')) {
    relPath = relPath.substring(6);
  }
  const targetPath = path.join(destPath, relPath);

  if (!targetPath.startsWith(destPath)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const method = req.method?.toUpperCase() || 'GET';
  const exists = fs.existsSync(targetPath);

  // GET Method
  if (method === 'GET') {
    if (!exists) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      res.writeHead(400);
      res.end('Directories cannot be read via GET');
      return;
    }
    
    reportWebdavActivity(req, pathname);
    
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Last-Modified': stat.mtime.toUTCString()
    });
    fs.createReadStream(targetPath).pipe(res);
    return;
  }

  // PUT Method (Save/Upload file)
  if (method === 'PUT') {
    reportWebdavActivity(req, pathname);
    
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const chunks: any[] = [];
    req.on('data', (c: any) => chunks.push(c));
    const writeStream = fs.createWriteStream(targetPath);
    req.pipe(writeStream);

    writeStream.on('finish', () => {
      const sender = req.headers['x-live-sender'];
      if (sender === 'mobile') {
        try {
          const bodyStr = Buffer.concat(chunks).toString('utf-8');
          const cLine = parseInt((req.headers['x-cursor-line'] as string) || '0', 10);
          const cCh = parseInt((req.headers['x-cursor-ch'] as string) || '0', 10);
          mobileLiveState = {
            path: relPath,
            content: bodyStr,
            mtime: Date.now(),
            cursor: { line: cLine, ch: cCh },
            isActivelyWriting: true
          };

          if (mobileLiveDebounceTimer) clearTimeout(mobileLiveDebounceTimer);
          mobileLiveDebounceTimer = setTimeout(() => {
            if (mobileLiveState) {
              mobileLiveState.isActivelyWriting = false;
              mobileLiveState.cursor = null;
            }
          }, 2500);
        } catch (e) {}
      }

      res.writeHead(201);
      res.end('Created');
    });

    writeStream.on('error', (err) => {
      res.writeHead(500);
      res.end('Write Error: ' + err.message);
    });
    return;
  }

  // DELETE Method
  if (method === 'DELETE') {
    if (!exists) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    
    reportWebdavActivity(req, pathname);
    
    try {
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        fs.rmSync(targetPath, { recursive: true, force: true });
      } else {
        fs.rmSync(targetPath, { force: true });
      }
      res.writeHead(200);
      res.end('Deleted');
    } catch (err: any) {
      res.writeHead(500);
      res.end('Delete Error: ' + err.message);
    }
    return;
  }

  // MKCOL Method (Make directory)
  if (method === 'MKCOL') {
    reportWebdavActivity(req, pathname);
    
    try {
      fs.mkdirSync(targetPath, { recursive: true });
      res.writeHead(201);
      res.end('Created');
    } catch (err: any) {
      res.writeHead(500);
      res.end('MKCOL Error: ' + err.message);
    }
    return;
  }

  // MOVE / COPY Methods
  if (method === 'MOVE' || method === 'COPY') {
    if (!exists) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const destinationHeader = req.headers.destination;
    if (!destinationHeader) {
      res.writeHead(400);
      res.end('Destination header missing');
      return;
    }

    reportWebdavActivity(req, pathname);

    try {
      const destUrl = url.parse(destinationHeader as string);
      const destPathname = decodeURIComponent(destUrl.pathname || '/');
      const realDestPath = path.join(destPath, destPathname);

      if (!realDestPath.startsWith(destPath)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      const destDir = path.dirname(realDestPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      if (method === 'MOVE') {
        fs.renameSync(targetPath, realDestPath);
      } else {
        fs.cpSync(targetPath, realDestPath, { recursive: true });
      }
      res.writeHead(201);
      res.end('Success');
    } catch (err: any) {
      res.writeHead(500);
      res.end('Operation Error: ' + err.message);
    }
    return;
  }

  // PROPFIND Method (Directory listing & file information)
  if (method === 'PROPFIND') {
    if (!exists) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const stat = fs.statSync(targetPath);
    const depth = req.headers.depth || '1';

    reportWebdavActivity(req, pathname);

    let xml = '<?xml version="1.0" encoding="utf-8" ?>\n';
    xml += '<D:multistatus xmlns:D="DAV:">\n';

    const addResource = (filePath: string, relUrlPath: string) => {
      const s = fs.statSync(filePath);
      const isDir = s.isDirectory();
      const displayName = path.basename(filePath);
      const size = isDir ? 0 : s.size;
      const mtime = s.mtime.toUTCString();

      let href = relUrlPath.replace(/\\/g, '/');
      if (!href.startsWith('/')) href = '/' + href;
      if (isDir && !href.endsWith('/')) href += '/';

      const escapedHref = href.split('/').map(encodeURIComponent).join('/').replace(/%2F/g, '/');

      xml += '  <D:response>\n';
      xml += `    <D:href>${escapedHref}</D:href>\n`;
      xml += '    <D:propstat>\n';
      xml += '      <D:prop>\n';
      xml += `        <D:displayname>${escapeXml(displayName)}</D:displayname>\n`;
      if (isDir) {
        xml += '        <D:resourcetype><D:collection/></D:resourcetype>\n';
      } else {
        xml += '        <D:resourcetype/>\n';
        xml += `        <D:getcontentlength>${size}</D:getcontentlength>\n`;
      }
      xml += `        <D:getlastmodified>${mtime}</D:getlastmodified>\n`;
      xml += '      </D:prop>\n';
      xml += '      <D:status>HTTP/1.1 200 OK</D:status>\n';
      xml += '    </D:propstat>\n';
      xml += '  </D:response>\n';
    };

    addResource(targetPath, pathname);

    if (depth !== '0' && stat.isDirectory()) {
      try {
        const files = fs.readdirSync(targetPath);
        for (const file of files) {
          if (file.toLowerCase() === 'photos') continue; // Exclude photos folder
          const childPath = path.join(targetPath, file);
          const childRelUrl = path.posix.join(pathname, file);
          addResource(childPath, childRelUrl);
        }
      } catch (err) {}
    }

    xml += '</D:multistatus>';

    res.writeHead(207, {
      'Content-Type': 'application/xml; charset="utf-8"'
    });
    res.end(xml);
    return;
  }

  res.writeHead(501);
  res.end('Not Implemented');
}

// Start WebDAV Server
function startWebdavServer(destPath: string) {
  if (webdavServer) {
    try {
      webdavServer.close();
    } catch (e) {}
  }
  const expanded = expandPath(destPath);
  try {
    fs.mkdirSync(expanded, { recursive: true });
  } catch (e) {}

  webdavServer = http.createServer((req, res) => {
    handleWebdavRequest(req, res, expanded);
  });

  webdavServer.listen(WEBDAV_PORT, () => {
    console.log(`WebDAV local server running on dual-stack IPv4/IPv6 port ${WEBDAV_PORT}`);
  });
}


app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || !tray) {
    app.quit();
  }
});
