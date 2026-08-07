import { Plugin, PluginSettingTab, App, Setting, Notice, requestUrl, Modal, TFile, Platform } from 'obsidian';
import { Html5Qrcode } from 'html5-qrcode';
import QRCode from 'qrcode';

interface WifiSyncSettings {
  macUrl: string;
  lastSyncTime: number;
  syncMode: 'standard' | 'live';
}

const syncLogs: string[] = [];

function logSyncEvent(device: string, category: string, details: string) {
  const now = new Date();
  const timestamp = now.toISOString().split('T')[1].slice(0, 12); // HH:mm:ss.SSS
  const logLine = `[${timestamp}] [${device}] [${category}] ${details}`;
  syncLogs.push(logLine);
  if (syncLogs.length > 500) syncLogs.shift();
  console.log(`⚡ ${logLine}`);
}

function smartMergeNote(macContent: string, mobileContent: string): string {
  if (macContent === mobileContent) return macContent;
  if (!macContent.trim()) return mobileContent;
  if (!mobileContent.trim()) return macContent;

  const headingRegex = /^(####\s+\(<span style="color:\s*red;?">\s*•🏵️\s*<\/span>\)\s*\.)(.*)$/i;

  const parseSections = (text: string) => {
    const lines = text.split('\n');
    const sections: { canonicalHeading: string; textLines: string[] }[] = [];
    let currentHeading = '';
    let currentTextLines: string[] = [];

    for (const line of lines) {
      const match = line.match(headingRegex);
      if (match) {
        if (currentHeading || currentTextLines.length > 0 || sections.length > 0) {
          sections.push({ canonicalHeading: currentHeading, textLines: currentTextLines });
        }
        currentHeading = match[1]; // Always "#### (<span style="color:red;"> •🏵️ </span>)  ."
        currentTextLines = [];
        const inlineText = match[2];
        if (inlineText) {
          currentTextLines.push(inlineText);
        }
      } else if (line.trim().startsWith('#') && !headingRegex.test(line.trim())) {
        if (currentHeading || currentTextLines.length > 0 || sections.length > 0) {
          sections.push({ canonicalHeading: currentHeading, textLines: currentTextLines });
        }
        currentHeading = line;
        currentTextLines = [];
      } else {
        currentTextLines.push(line);
      }
    }
    sections.push({ canonicalHeading: currentHeading, textLines: currentTextLines });
    return sections;
  };

  const macSecs = parseSections(macContent);
  const mobSecs = parseSections(mobileContent);

  const mergedSecs: { canonicalHeading: string; textLines: string[] }[] = [];
  const maxLen = Math.max(macSecs.length, mobSecs.length);

  for (let i = 0; i < maxLen; i++) {
    const macS = macSecs[i];
    const mobS = mobSecs[i];

    if (!macS) {
      mergedSecs.push(mobS);
      continue;
    }
    if (!mobS) {
      mergedSecs.push(macS);
      continue;
    }

    const heading = mobS.canonicalHeading || macS.canonicalHeading;
    const macBodyStr = macS.textLines.join('\n').trim();
    const mobBodyStr = mobS.textLines.join('\n').trim();

    let mergedLines: string[] = [];

    if (!macBodyStr) {
      mergedLines = mobS.textLines;
    } else if (!mobBodyStr) {
      mergedLines = macS.textLines;
    } else if (macBodyStr === mobBodyStr) {
      mergedLines = macS.textLines;
    } else {
      // Both devices wrote text under this section: combine non-duplicate lines cleanly
      const combined = [...mobS.textLines];
      const existingClean = combined.map(l => l.trim());
      for (const line of macS.textLines) {
        if (line.trim() && !existingClean.includes(line.trim())) {
          if (combined.length > 0 && combined[combined.length - 1].trim() !== '') {
            combined.push('');
          }
          combined.push(line);
          existingClean.push(line.trim());
        }
      }
      mergedLines = combined;
    }

    mergedSecs.push({ canonicalHeading: heading, textLines: mergedLines });
  }

  // Reassemble final document
  const resultLines: string[] = [];
  for (const sec of mergedSecs) {
    if (sec.canonicalHeading) {
      const heading = sec.canonicalHeading;
      const firstLine = sec.textLines[0];
      
      if (headingRegex.test(heading) && firstLine !== undefined) {
        resultLines.push(heading + firstLine);
        for (let j = 1; j < sec.textLines.length; j++) {
          resultLines.push(sec.textLines[j]);
        }
      } else {
        resultLines.push(heading);
        resultLines.push(...sec.textLines);
      }
    } else {
      resultLines.push(...sec.textLines);
    }
  }

  return resultLines.join('\n');
}

const DEFAULT_SETTINGS: WifiSyncSettings = {
  macUrl: 'http://happys-MacBook-Pro.local:19000/',
  lastSyncTime: 0,
  syncMode: 'standard'
}

export default class WifiSyncPlugin extends Plugin {
  settings: WifiSyncSettings;
  statusBarItem: HTMLElement;
  liveDebounceTimer: any = null;
  isRemoteUpdating = false;
  macLiveState: { path: string; content: string; mtime: number } | null = null;
  lastSeenMacLiveMtime = 0;

  async onload() {
    console.log('Loading Obsidian Wi-Fi Sync Plugin');
    await this.loadSettings();

    // Add status bar item to show lock state & allow click to toggle mode
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar(this.settings.syncMode === 'live' ? '⚡ Live Mode' : '⚪ Standard');
    this.statusBarItem.setAttr('title', 'Click to switch between Live Mode & Standard Mode');
    this.statusBarItem.addClass('mod-clickable');
    (this.statusBarItem as HTMLElement).style.cursor = 'pointer';
    this.statusBarItem.addEventListener('click', async () => {
      await this.toggleSyncMode();
    });

    // Live Mode Editor Listener
    this.registerEvent(
      this.app.workspace.on('editor-change', (editor, view) => {
        if (this.settings.syncMode === 'live' && view && view.file) {
          this.handleLiveEditorChange(view.file.path, editor.getValue(), editor.getCursor());
        }
      })
    );

    // Auto-pull live state when opening/switching notes on mobile
    this.registerEvent(
      this.app.workspace.on('file-open', async () => {
        if (this.settings.syncMode === 'live' && !Platform.isDesktopApp) {
          await this.pollMacLiveStream();
        }
      })
    );

    // Start Live Polling if active
    this.startLivePolling();

    // Add ribbon icon to toggle Live / Standard mode
    this.addRibbonIcon('zap', 'Toggle Live / Standard Sync Mode', async () => {
      await this.toggleSyncMode();
    });

    // Add ribbon icon for instant sync
    this.addRibbonIcon('sync', 'Sync Vault with Mac', async () => {
      await this.runSync();
    });

    // Add commands
    this.addCommand({
      id: 'trigger-wifi-sync',
      name: 'Sync Vault over Wi-Fi',
      callback: async () => {
        await this.runSync();
      }
    });

    this.addCommand({
      id: 'scan-mac-config-qr',
      name: 'Scan Mac Connection Setup QR',
      callback: () => {
        this.openConfigScanner();
      }
    });

    this.addCommand({
      id: 'offline-qr-sync-pull',
      name: 'Offline QR Sync: Scan Mac Screen (Pull)',
      callback: () => {
        this.openOfflinePullScanner();
      }
    });

    this.addCommand({
      id: 'offline-qr-sync-push',
      name: 'Offline QR Sync: Show Phone Carousel (Push)',
      callback: async () => {
        await this.showPushQrCarousel();
      }
    });

    this.addCommand({
      id: 'show-sync-logs',
      name: 'Show Real-Time Live Sync Diagnostic Logs',
      callback: () => {
        new SyncLogModal(this.app).open();
      }
    });

    this.addCommand({
      id: 'toggle-sync-mode',
      name: 'Toggle Sync Mode (Standard <-> Live)',
      callback: async () => {
        await this.toggleSyncMode();
      }
    });

    // Add settings tab
    this.addSettingTab(new WifiSyncSettingTab(this.app, this));

    // Poll Mac state every 5 seconds to show safety indicator in status bar
    this.registerInterval(
      window.setInterval(async () => {
        await this.checkMacState();
      }, 5000)
    );

    // Start direct Obsidian-to-Obsidian Wi-Fi WebDAV server if running on Mac Desktop
    if (Platform.isDesktopApp) {
      this.startDesktopServer();
    }
  }

  livePollIntervalHandle: any = null;

  lastSeenMobileLiveMtime = 0;

  startLivePolling() {
    if (this.livePollIntervalHandle) {
      clearInterval(this.livePollIntervalHandle);
      this.livePollIntervalHandle = null;
    }

    if (this.settings.syncMode === 'live') {
      this.livePollIntervalHandle = window.setInterval(async () => {
        if (Platform.isDesktopApp) {
          await this.pollMobileLiveStream();
        } else {
          await this.pollMacLiveStream();
        }
      }, 100);
      this.registerInterval(this.livePollIntervalHandle);
    }
  }

  async setSyncMode(newMode: 'live' | 'standard', broadcast: boolean = true) {
    if (this.settings.syncMode === newMode && !broadcast) return;

    this.settings.syncMode = newMode;
    await this.saveSettings();
    this.startLivePolling();

    const modeLabel = newMode === 'live'
      ? '⚡ Live Mode (Real-Time Typing Active)'
      : '⚪ Standard Mode (Manual Sync)';

    this.updateStatusBar(newMode === 'live' ? '⚡ Live Mode' : '⚪ Standard');
    new Notice(`Sync Mode shifted to: ${modeLabel}`);

    if (broadcast) {
      try {
        if (Platform.isDesktopApp) {
          if (this.macLiveState) {
            this.macLiveState.syncMode = newMode;
          }
          await requestUrl({
            url: `http://127.0.0.1:19000/api/set-mode?mode=${newMode}`,
            method: 'POST',
            headers: { 'Authorization': 'Basic ' + btoa('obsidian:sync') }
          });
        } else {
          const baseUrl = this.settings.macUrl.replace(/\/$/, '');
          await requestUrl({
            url: `${baseUrl}/api/set-mode?mode=${newMode}`,
            method: 'POST',
            headers: { 'Authorization': 'Basic ' + btoa('obsidian:sync') }
          });
        }
      } catch (e) {}
    }
  }

  async toggleSyncMode() {
    const nextMode = this.settings.syncMode === 'live' ? 'standard' : 'live';
    await this.setSyncMode(nextMode, true);
  }

  isSelfEditing = false;
  isMobileWriting = false;
  mobileWritingTimer: any = null;
  isSendingLiveUpdate = false;
  lastMacTypedContent = '';

  async handleLiveEditorChange(filePath: string, content: string, cursor?: { line: number; ch: number }) {
    if (this.isRemoteUpdating) return;
    // On Mac, if mobile is actively writing, this editor-change was triggered by
    // Obsidian's file watcher reloading the file that Electron wrote to disk.
    // Do NOT treat it as a Mac edit — it would contaminate macLiveState and block
    // pollMobileLiveStream, causing cursor swap after 2.5s.
    if (Platform.isDesktopApp && this.isMobileWriting) return;

    const parts = filePath.split('/');
    if (parts.some(part => part.toLowerCase() === 'photos' || part.startsWith('.'))) return;
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    if (['blend', 'blend1', 'blend2', 'blend3', 'fbx', 'obj', 'stl', 'psd', 'ai', 'exe', 'dmg', 'iso'].includes(ext)) return;

    try {
      this.isSelfEditing = true;

      if (Platform.isDesktopApp) {
        // Only treat as a genuine Mac keyboard edit if text content actually changed!
        // This prevents background rescan/auto-save/focus events from mistaking disk reloads as Mac typing!
        if (content === this.lastMacTypedContent) return;
        this.lastMacTypedContent = content;

        logSyncEvent('MAC', 'LOCAL_EDIT', `Path=${filePath}, len=${content.length}, cursor=${JSON.stringify(cursor)}`);

        // Mac is writing: record state for mobile fast poll
        this.macLiveState = {
          path: filePath,
          content: content,
          mtime: Date.now(),
          isActivelyWriting: true,
          cursor: cursor,
          sender: 'mac'
        };
        this.updateStatusBar('🔴 Live: Mac Writing (Phone Locked)');

        try {
          await requestUrl({
            url: `http://127.0.0.1:19000/api/live-post`,
            method: 'POST',
            headers: {
              'Authorization': 'Basic ' + btoa('obsidian:sync'),
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(this.macLiveState)
          });
        } catch (e) {}
      } else {
        // Mobile is writing: send non-blocking PUT to Mac (no request queueing lag!)
        if (!this.isSendingLiveUpdate) {
          this.isSendingLiveUpdate = true;
          logSyncEvent('MOBILE', 'LOCAL_EDIT', `Path=${filePath}, len=${content.length}, cursor=${JSON.stringify(cursor)}`);
          this.updateStatusBar('🔴 Live: Phone Writing (Mac Locked)');

          const baseUrl = this.settings.macUrl.replace(/\/$/, '');
          const encoder = new TextEncoder();
          const binaryData = encoder.encode(content).buffer;

          requestUrl({
            url: `${baseUrl}/${encodeURIComponent(filePath).replace(/%2F/g, '/')}`,
            method: 'PUT',
            headers: {
              'Authorization': 'Basic ' + btoa('obsidian:sync'),
              'Content-Type': 'text/markdown; charset=utf-8',
              'X-Live-Sender': 'mobile',
              'X-Cursor-Line': String(cursor?.line ?? 0),
              'X-Cursor-Ch': String(cursor?.ch ?? 0)
            },
            body: binaryData
          }).finally(() => {
            this.isSendingLiveUpdate = false;
          });
        }
      }

      if (this.liveDebounceTimer) clearTimeout(this.liveDebounceTimer);
      this.liveDebounceTimer = setTimeout(() => {
        this.isSelfEditing = false;
        this.liveDebounceTimer = null;
        if (this.macLiveState) {
          this.macLiveState.isActivelyWriting = false;
          this.macLiveState.cursor = null;
        }
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        this.updateStatusBar(`🟢 Live: Idle (${timeStr})`);
      }, 2500);
    } catch (e) {
      console.error('Live stream error:', e);
    }
  }

  async pollMacLiveStream() {
    if (this.isSelfEditing) return; // Mobile user is typing!

    try {
      const baseUrl = this.settings.macUrl.replace(/\/$/, '');
      const res = await requestUrl({
        url: `${baseUrl}/api/live-stream-poll`,
        method: 'GET',
        headers: { 'Authorization': 'Basic ' + btoa('obsidian:sync') }
      });

      if (res.status === 200) {
        const data = res.json;
        if (data && data.syncMode && data.syncMode !== this.settings.syncMode) {
          await this.setSyncMode(data.syncMode, false);
        }
        const cLine = data.cursor?.line ?? -1;
        const cCh = data.cursor?.ch ?? -1;
        const hasCursorMoved = cLine !== this.lastSeenMacCursorLine || cCh !== this.lastSeenMacCursorCh;
        const hasContentChanged = data.content !== undefined && (data.mtime > this.lastSeenMacLiveMtime || hasCursorMoved);

        if (data && data.path && data.sender === 'mac' && data.isActivelyWriting === true && hasContentChanged) {
          this.lastSeenMacLiveMtime = data.mtime;
          this.lastSeenMacCursorLine = cLine;
          this.lastSeenMacCursorCh = cCh;

          let activeFile = this.app.workspace.getActiveFile();
          const activeView = this.app.workspace.getActiveViewOfType(require('obsidian').MarkdownView);
          const currentContent = activeView?.editor ? activeView.editor.getValue() : null;
          const hasMobileEditorFocus = activeView?.editor && (activeView.editor as any).hasFocus ? (activeView.editor as any).hasFocus() : false;

          logSyncEvent('MOBILE', 'RECEIVE_MAC_STREAM', `Path=${data.path}, activeWriting=${data.isActivelyWriting}, mobileFocus=${hasMobileEditorFocus}, cursor=${JSON.stringify(data.cursor)}`);

          // 1. ONLY write file to disk if Mac was the author AND content actually changed!
          if (data.sender === 'mac' && data.content !== currentContent) {
            this.isRemoteUpdating = true;
            if (await this.app.vault.adapter.exists(data.path)) {
              await this.app.vault.adapter.write(data.path, data.content);
            } else {
              await this.app.vault.create(data.path, data.content);
            }
            this.isRemoteUpdating = false;
          }

          // 2. ONLY auto-open on mobile if Mac is ACTIVELY writing right now!
          if (data.isActivelyWriting && data.sender === 'mac' && (!activeFile || activeFile.path !== data.path)) {
            const targetFile = this.app.vault.getAbstractFileByPath(data.path);
            if (targetFile && targetFile instanceof TFile) {
              const leaf = this.app.workspace.getLeaf(false);
              await leaf.openFile(targetFile, { active: true });
              activeFile = targetFile;
            }
          }

          // 3. ONLY update editor / cursor on mobile if Mac user is ACTIVELY writing AND Mobile user is not currently focused editing!
          if (data.isActivelyWriting && data.sender === 'mac' && !hasMobileEditorFocus && activeFile && activeFile.path === data.path) {
            if (activeView && activeView.editor) {
              this.isRemoteUpdating = true;
              const normRemote = data.content.replace(/\r\n/g, '\n').trim();
              const normLocal = activeView.editor.getValue().replace(/\r\n/g, '\n').trim();

              if (normRemote !== normLocal) {
                logSyncEvent('MOBILE', 'SET_VALUE', `Updating content from Mac len=${data.content.length}`);
                activeView.editor.setValue(data.content);
              }
              if (data.cursor) {
                const pos = { line: data.cursor.line, ch: data.cursor.ch };
                logSyncEvent('MOBILE', 'SET_CURSOR', `Moving mobile cursor to line=${pos.line}, ch=${pos.ch}`);
                activeView.editor.setCursor(pos);
                if (typeof (activeView.editor as any).setSelection === 'function') {
                  activeView.editor.setSelection(pos, pos);
                }
                if (typeof (activeView.editor as any).scrollIntoView === 'function') {
                  (activeView.editor as any).scrollIntoView({ from: pos, to: pos }, true);
                }
              }
              setTimeout(() => {
                this.isRemoteUpdating = false;
              }, 500);
            }
          } else if (hasMobileEditorFocus) {
            logSyncEvent('MOBILE', 'SHIELD_MOBILE_CURSOR', `Mobile editor has focus. Overwrite skipped to protect mobile cursor.`);
          }

          this.isRemoteUpdating = false;
          this.updateStatusBar('🔴 Live: Mac Writing (Phone Locked)');

          if (this.liveDebounceTimer) clearTimeout(this.liveDebounceTimer);
          this.liveDebounceTimer = setTimeout(() => {
            const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            this.updateStatusBar(`🟢 Live: Idle (${timeStr})`);
          }, 2500);
        }
      }
    } catch (e) {
      // Ignore offline poll errors
    }
  }

  lastSeenMobileCursorLine = -1;
  lastSeenMobileCursorCh = -1;
  lastSeenMacCursorLine = -1;
  lastSeenMacCursorCh = -1;

  async pollMobileLiveStream() {
    if (this.isSelfEditing) return; // Mac user is typing!

    try {
      const res = await requestUrl({
        url: `http://127.0.0.1:19000/api/mobile-live-poll`,
        method: 'GET',
        headers: { 'Authorization': 'Basic ' + btoa('obsidian:sync') }
      });

      if (res.status === 200) {
        const data = res.json;
        if (data && data.syncMode && data.syncMode !== this.settings.syncMode) {
          await this.setSyncMode(data.syncMode, false);
        }

        const cLine = data.cursor?.line ?? -1;
        const cCh = data.cursor?.ch ?? -1;
        const hasCursorMoved = cLine !== this.lastSeenMobileCursorLine || cCh !== this.lastSeenMobileCursorCh;
        const hasContentChanged = data.content !== undefined && (data.mtime > this.lastSeenMobileLiveMtime || hasCursorMoved);

        if (data && data.path && hasContentChanged) {
          this.lastSeenMobileLiveMtime = data.mtime;
          this.lastSeenMobileCursorLine = cLine;
          this.lastSeenMobileCursorCh = cCh;

          // 1. Auto-open note on Mac if not currently open!
          let activeFile = this.app.workspace.getActiveFile();
          if (data.isActivelyWriting && (!activeFile || activeFile.path !== data.path)) {
            const targetFile = this.app.vault.getAbstractFileByPath(data.path);
            if (targetFile && targetFile instanceof TFile) {
              const leaf = this.app.workspace.getLeaf(false);
              await leaf.openFile(targetFile, { active: true });
              activeFile = targetFile;
            }
          }

          // Track that mobile is actively writing — suppress Mac editor-change echo
          if (data.isActivelyWriting) {
            this.isMobileWriting = true;
            if (this.mobileWritingTimer) clearTimeout(this.mobileWritingTimer);
            this.mobileWritingTimer = setTimeout(() => {
              this.isMobileWriting = false;
              this.mobileWritingTimer = null;
            }, 3000);
          }

          // 2. Update editor content, cursor position, focus, and auto-scroll Mac view into view!
          if (activeFile && activeFile.path === data.path) {
            const activeView = this.app.workspace.getActiveViewOfType(require('obsidian').MarkdownView);
            if (activeView && activeView.editor) {
              this.isRemoteUpdating = true;
              if (activeView.editor.getValue() !== data.content) {
                activeView.editor.setValue(data.content);
              }
              // ONLY move cursor on Mac if Mobile user is ACTIVELY writing right now!
              if (data.isActivelyWriting && data.cursor && data.cursor.line !== undefined) {
                const pos = { line: data.cursor.line, ch: data.cursor.ch };
                activeView.editor.setCursor(pos);
                if (typeof (activeView.editor as any).setSelection === 'function') {
                  activeView.editor.setSelection(pos, pos);
                }
                if (typeof (activeView.editor as any).scrollIntoView === 'function') {
                  (activeView.editor as any).scrollIntoView({ from: pos, to: pos }, true);
                }
              }
              setTimeout(() => {
                this.isRemoteUpdating = false;
              }, 500);
            }
          }

          this.updateStatusBar('🔴 Live: Phone Writing (Mac Locked)');

          if (this.liveDebounceTimer) clearTimeout(this.liveDebounceTimer);
          this.liveDebounceTimer = setTimeout(() => {
            const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            this.updateStatusBar(`🟢 Live: Idle (${timeStr})`);
          }, 2500);
        }
      }
    } catch (e) {
      // Ignore poll errors
    }
  }

  pluginServer: any = null;

  startDesktopServer() {
    if (!Platform.isDesktopApp) return;

    try {
      const http = require('http');

      if (this.pluginServer) {
        try { this.pluginServer.close(); } catch (e) {}
      }

      const serverPort = 19000;

      this.pluginServer = http.createServer(async (req: any, res: any) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Basic ')) {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Obsidian Plugin"' });
          res.end('Unauthorized');
          return;
        }

        const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf-8');
        if (credentials !== 'obsidian:sync') {
          res.writeHead(401);
          res.end('Invalid credentials');
          return;
        }

        const parsedUrl = new URL(req.url || '/', `http://localhost:${serverPort}`);
        const pathname = decodeURIComponent(parsedUrl.pathname || '/');

        if (pathname === '/api/state') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ state: 'viewing', isMobileActive: true }));
          return;
        }

        const isIgnored = (filePath: string) => {
          const parts = filePath.split('/');
          if (parts.some(part => part.toLowerCase() === 'photos' || part.startsWith('.'))) {
            return true;
          }
          const ext = filePath.split('.').pop()?.toLowerCase() || '';
          if (['blend', 'blend1', 'blend2', 'blend3', 'fbx', 'obj', 'stl', 'psd', 'ai', 'exe', 'dmg', 'iso'].includes(ext)) {
            return true;
          }
          return false;
        };

        if (pathname === '/api/files') {
          const files = this.app.vault.getFiles();
          const filesArray = [];

          for (const f of files) {
            const p = f.path;
            if (isIgnored(p)) {
              continue;
            }
            filesArray.push({
              path: p,
              mtime: Math.floor(f.stat.mtime / 1000),
              size: f.stat.size
            });
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ files: filesArray }));
          return;
        }

        if (pathname === '/api/set-mode') {
          const newMode = (parsedUrl.searchParams.get('mode') as 'live' | 'standard') || 'live';
          await this.setSyncMode(newMode, false);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', mode: newMode }));
          return;
        }

        if (pathname === '/api/live-stream-poll') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...(this.macLiveState || { mtime: 0 }), syncMode: this.settings.syncMode }));
          return;
        }

        let relPath = pathname.replace(/^\//, '');
        if (relPath.startsWith('Daily/')) {
          relPath = relPath.substring(6);
        }

        if (isIgnored(relPath)) {
          res.writeHead(403);
          res.end('Ignored file path');
          return;
        }

        if (req.method === 'GET') {
          const fileObj = this.app.vault.getAbstractFileByPath(relPath);
          if (!fileObj || !(fileObj instanceof TFile)) {
            res.writeHead(404);
            res.end('Not Found');
            return;
          }
          const data = await this.app.vault.readBinary(fileObj);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': data.byteLength
          });
          res.end(Buffer.from(data));
          return;
        }

        if (req.method === 'PUT') {
          const chunks: any[] = [];
          req.on('data', (chunk: any) => chunks.push(chunk));
          req.on('end', async () => {
            const bodyBuffer = Buffer.concat(chunks);
            try {
              const parts = relPath.split('/');
              if (parts.length > 1) {
                const parentDir = parts.slice(0, -1).join('/');
                if (!(await this.app.vault.adapter.exists(parentDir))) {
                  await this.app.vault.createFolder(parentDir);
                }
              }

              if (await this.app.vault.adapter.exists(relPath)) {
                await this.app.vault.adapter.writeBinary(relPath, bodyBuffer.buffer);
              } else {
                await this.app.vault.createBinary(relPath, bodyBuffer.buffer);
              }

              const sender = req.headers['x-live-sender'];
              if (sender === 'mobile') {
                // Track that mobile is writing — suppress editor-change echo
                this.isMobileWriting = true;
                if (this.mobileWritingTimer) clearTimeout(this.mobileWritingTimer);
                this.mobileWritingTimer = setTimeout(() => {
                  this.isMobileWriting = false;
                  this.mobileWritingTimer = null;
                }, 3000);
                this.updateStatusBar('🔴 Live: Phone Writing (Mac Locked)');

                // 1. Auto-open note on Mac if not currently open!
                let activeFile = this.app.workspace.getActiveFile();
                if (!activeFile || activeFile.path !== relPath) {
                  const targetFile = this.app.vault.getAbstractFileByPath(relPath);
                  if (targetFile && targetFile instanceof TFile) {
                    const leaf = this.app.workspace.getLeaf(false);
                    await leaf.openFile(targetFile, { active: true });
                    activeFile = targetFile;
                  }
                }

                // 2. Update content, set cursor, and scroll Mac editor into view!
                if (activeFile && activeFile.path === relPath) {
                  const activeView = this.app.workspace.getActiveViewOfType(require('obsidian').MarkdownView);
                  if (activeView && activeView.editor) {
                    const contentStr = bodyBuffer.toString('utf-8');
                    const cLineStr = req.headers['x-cursor-line'] as string;
                    const cChStr = req.headers['x-cursor-ch'] as string;
                    const cLine = cLineStr !== undefined ? parseInt(cLineStr, 10) : NaN;
                    const cCh = cChStr !== undefined ? parseInt(cChStr, 10) : NaN;

                    this.isRemoteUpdating = true;
                    if (activeView.editor.getValue() !== contentStr) {
                      activeView.editor.setValue(contentStr);
                    }
                    this.lastMacTypedContent = contentStr; // Synchronize Mac's content buffer so background rescan won't trigger false Mac edit!
                    if (!isNaN(cLine) && !isNaN(cCh)) {
                      const pos = { line: cLine, ch: cCh };
                      activeView.editor.setCursor(pos);
                      if (typeof (activeView.editor as any).setSelection === 'function') {
                        (activeView.editor as any).setSelection(pos, pos);
                      }
                      if (typeof (activeView.editor as any).scrollIntoView === 'function') {
                        (activeView.editor as any).scrollIntoView({ from: pos, to: pos }, true);
                      }
                      this.macLiveState = {
                        path: relPath,
                        content: contentStr,
                        mtime: Date.now(),
                        isActivelyWriting: false,
                        cursor: pos,
                        sender: 'mobile'
                      };
                    }
                    setTimeout(() => {
                      this.isRemoteUpdating = false;
                    }, 500);
                  }
                }
                if (this.liveDebounceTimer) clearTimeout(this.liveDebounceTimer);
                this.liveDebounceTimer = setTimeout(() => {
                  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                  this.updateStatusBar(`🟢 Live: Idle (${timeStr})`);
                }, 2500);
              }

              res.writeHead(200);
              res.end('OK');
            } catch (e: any) {
              res.writeHead(500);
              res.end(e.message);
            }
          });
          return;
        }

        if (req.method === 'DELETE') {
          const fileObj = this.app.vault.getAbstractFileByPath(relPath);
          if (fileObj) {
            await this.app.vault.delete(fileObj);
          }
          res.writeHead(200);
          res.end('OK');
          return;
        }

        res.writeHead(405);
        res.end('Method Not Allowed');
      });

      this.pluginServer.listen(serverPort, () => {
        console.log(`Obsidian Mac Plugin WebDAV Server listening on dual-stack port ${serverPort}`);
        new Notice(`🟢 Mac Obsidian Plugin WebDAV Server active on port ${serverPort}!`);
      });
    } catch (err) {
      console.error('Failed to start Desktop Plugin Server:', err);
    }
  }

  async onunload() {
    console.log('Unloading Obsidian Wi-Fi Sync Plugin');
    if (this.livePollIntervalHandle) {
      clearInterval(this.livePollIntervalHandle);
      this.livePollIntervalHandle = null;
    }
    if (this.liveDebounceTimer) {
      clearTimeout(this.liveDebounceTimer);
      this.liveDebounceTimer = null;
    }
    if (this.mobileWritingTimer) {
      clearTimeout(this.mobileWritingTimer);
      this.mobileWritingTimer = null;
    }
    if (this.pluginServer) {
      try { this.pluginServer.close(); } catch (e) {}
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  updateStatusBar(text: string, tooltip = '') {
    this.statusBarItem.setText(`Sync: ${text}`);
    if (tooltip) {
      this.statusBarItem.setAttribute('title', tooltip);
    }
  }

  // Get current safety state of Mac app
  async checkMacState() {
    try {
      const url = `${this.settings.macUrl.replace(/\/$/, '')}/api/state`;
      const res = await requestUrl({
        url,
        method: 'GET',
        headers: { 'Authorization': 'Basic ' + btoa('obsidian:sync') }
      });
      
      if (res.status === 200) {
        const data = res.json;
        if (data.state === 'viewing') {
          this.updateStatusBar('🟢 Safe (Viewing)', 'Mac is in viewing mode. Safe to write on phone.');
        } else if (data.state === 'editing') {
          this.updateStatusBar('🟡 Unlocked (Mac)', 'Mac is being edited. Avoid editing on phone now.');
        } else if (data.state === 'locked') {
          this.updateStatusBar('🔴 Mac Locked', 'Mac changes pushed. Please sync to receive updates.');
        } else {
          this.updateStatusBar('🟢 Connected');
        }
      }
    } catch (err) {
      this.updateStatusBar('⚪ Offline', 'Mac app is not reachable. Connect to same Wi-Fi.');
    }
  }

  // Helper to process items in parallel batches
  async batchProcess<T>(items: T[], fn: (item: T) => Promise<void>, batchSize = 35) {
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await Promise.all(batch.map(fn));
    }
  }

  // Core Sync Algorithm (Wi-Fi)
  async runSync() {
    new Notice('🔄 Inspecting Vault Differences...');
    this.updateStatusBar('🔄 Inspecting...');

    try {
      const baseUrl = this.settings.macUrl.replace(/\/$/, '');
      
      // 1. Fetch Mac state
      const stateRes = await requestUrl({
        url: `${baseUrl}/api/state`,
        method: 'GET',
        headers: { 'Authorization': 'Basic ' + btoa('obsidian:sync') }
      });

      // 2. Fetch Mac file list
      const filesRes = await requestUrl({
        url: `${baseUrl}/api/files`,
        method: 'GET',
        headers: { 'Authorization': 'Basic ' + btoa('obsidian:sync') }
      });
      const macFilesList = filesRes.json.files as { path: string; mtime: number; size: number }[];

      const isIgnored = (filePath: string) => {
        const parts = filePath.split('/');
        if (parts.some(part => part.toLowerCase() === 'photos' || part.startsWith('.'))) {
          return true;
        }
        const ext = filePath.split('.').pop()?.toLowerCase() || '';
        if (['blend', 'blend1', 'blend2', 'blend3', 'fbx', 'obj', 'stl', 'psd', 'ai', 'exe', 'dmg', 'iso'].includes(ext)) {
          return true;
        }
        return false;
      };

      // Map Mac files by normalized lowercase path for case-insensitive matching
      const macFilesLowerMap = new Map<string, { path: string; mtime: number; size: number }>();
      const macFilesMap = new Map<string, { path: string; mtime: number; size: number }>();

      for (const f of macFilesList) {
        if (!isIgnored(f.path)) {
          macFilesMap.set(f.path, f);
          macFilesLowerMap.set(f.path.toLowerCase(), f);
        }
      }

      // 3. Scan phone local files
      const localFiles = this.app.vault.getFiles();
      const localFilesMap = new Map<string, { path: string; mtime: number; size: number }>();
      const localFilesLowerMap = new Map<string, { path: string; mtime: number; size: number }>();

      for (const file of localFiles) {
        const p = file.path;
        if (!isIgnored(p)) {
          const item = {
            path: p,
            mtime: Math.floor(file.stat.mtime / 1000),
            size: file.stat.size
          };
          localFilesMap.set(p, item);
          localFilesLowerMap.set(p.toLowerCase(), item);
        }
      }

      const toUpload: { path: string; size: number }[] = [];
      const toDownload: { path: string; size: number }[] = [];
      const toMerge: { path: string; size: number }[] = [];
      const toDeleteLocal: string[] = [];
      const toDeleteMac: string[] = [];

      // 4. Safe Non-Destructive Comparison (Case-Insensitive & Zero Auto-Deletions)
      for (const [path, localFile] of localFilesMap.entries()) {
        const macFile = macFilesLowerMap.get(path.toLowerCase());
        
        if (!macFile) {
          // File exists on Mobile only -> Safe Upload to Mac (Never auto-delete!)
          toUpload.push({ path, size: localFile.size });
        } else {
          // File exists on BOTH devices: check if size matches
          if (localFile.size === macFile.size) {
            continue; // 100% identical size in bytes -> Skip!
          }

          // Markdown note modified on both sides -> Smart Section Merge!
          if (path.endsWith('.md')) {
            toMerge.push({ path, size: Math.max(localFile.size, macFile.size) });
          } else {
            const timeDiff = localFile.mtime - macFile.mtime;
            if (timeDiff > 5) {
              toUpload.push({ path, size: localFile.size });
            } else if (timeDiff < -5) {
              toDownload.push({ path: macFile.path, size: macFile.size });
            }
          }
        }
      }

      for (const [path, macFile] of macFilesMap.entries()) {
        const localFile = localFilesLowerMap.get(path.toLowerCase());
        if (!localFile) {
          // File exists on Mac only -> Safe Download to Mobile (Never auto-delete!)
          toDownload.push({ path: macFile.path, size: macFile.size });
        }
      }

      const totalOps = toUpload.length + toDownload.length + toMerge.length + toDeleteLocal.length + toDeleteMac.length;

      if (totalOps === 0) {
        new Notice('🟢 Vault is 100% Up to Date!');
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        this.updateStatusBar(`🟢 Synced (${timeStr})`, `Last synced at ${timeStr}`);
        return;
      }

      // Check if permission alert is required (> 2 files or contains media/pdf/large files)
      const heavyExtensions = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.zip'];
      const hasHeavyFile = [...toDownload, ...toUpload, ...toMerge].some(f => 
        heavyExtensions.some(ext => f.path.toLowerCase().endsWith(ext)) || f.size > 500 * 1024
      );

      const requiresPermission = totalOps > 2 || hasHeavyFile;

      const executeSync = async () => {
        new Notice(`⚡ Parallel Syncing ${totalOps} file(s)...`);

        // Execute Smart Section Merges for notes modified on both sides
        if (toMerge.length > 0) {
          this.updateStatusBar(`🔄 Merging Sections (${toMerge.length})...`);
          await this.batchProcess(toMerge.map(f => f.path), async (filePath) => {
            try {
              // 1. Get Mac content
              const url = `${baseUrl}/${encodeURIComponent(filePath).replace(/%2F/g, '/')}`;
              const macRes = await requestUrl({
                url,
                method: 'GET',
                headers: { 'Authorization': 'Basic ' + btoa('obsidian:sync') }
              });
              const macText = macRes.text;

              // 2. Get Mobile content
              let mobText = '';
              if (await this.app.vault.adapter.exists(filePath)) {
                mobText = await this.app.vault.adapter.read(filePath);
              }

              // 3. Smart Merge
              const mergedText = smartMergeNote(macText, mobText);

              // 4. Update Mobile if changed
              if (mergedText !== mobText) {
                if (await this.app.vault.adapter.exists(filePath)) {
                  await this.app.vault.adapter.write(filePath, mergedText);
                } else {
                  await this.app.vault.create(filePath, mergedText);
                }
              }

              // 5. Update Mac if changed
              if (mergedText !== macText) {
                const encoder = new TextEncoder();
                const binaryData = encoder.encode(mergedText).buffer;
                await requestUrl({
                  url,
                  method: 'PUT',
                  headers: {
                    'Authorization': 'Basic ' + btoa('obsidian:sync'),
                    'Content-Type': 'text/markdown; charset=utf-8'
                  },
                  body: binaryData
                });
              }
            } catch (err) {
              console.error('Error merging section note:', filePath, err);
            }
          });
        }

        if (toUpload.length > 0) {
          this.updateStatusBar(`🔄 Uploading (${toUpload.length})...`);
          await this.batchProcess(toUpload.map(f => f.path), path => this.uploadFile(path));
        }
        
        if (toDownload.length > 0) {
          this.updateStatusBar(`🔄 Downloading (${toDownload.length})...`);
          await this.batchProcess(toDownload.map(f => f.path), path => this.downloadFile(path));
        }
        
        if (toDeleteLocal.length > 0) {
          await this.batchProcess(toDeleteLocal, async path => {
            const fileObj = this.app.vault.getAbstractFileByPath(path);
            if (fileObj) await this.app.vault.delete(fileObj);
          });
        }
        
        if (toDeleteMac.length > 0) {
          await this.batchProcess(toDeleteMac, path => this.deleteMacFile(path));
        }

        this.settings.lastSyncTime = Math.floor(Date.now() / 1000) + 10;
        await this.saveSettings();

        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        this.updateStatusBar(`🟢 Synced (${timeStr})`, `Last synced at ${timeStr}`);

        let reportLines: string[] = [`✅ Sync Complete at ${timeStr}`];
        if (toDownload.length > 0) {
          reportLines.push(`\n📥 Received from Mac (${toDownload.length}):`);
          toDownload.forEach(f => reportLines.push(`  • ${f.path}`));
        }
        if (toUpload.length > 0) {
          reportLines.push(`\n📤 Sent to Mac (${toUpload.length}):`);
          toUpload.forEach(f => reportLines.push(`  • ${f.path}`));
        }
        if (toMerge.length > 0) {
          reportLines.push(`\n🧩 Merged Sections (${toMerge.length}):`);
          toMerge.forEach(f => reportLines.push(`  • ${f.path}`));
        }
        new Notice(reportLines.join('\n'), 12000);
      };

      if (requiresPermission) {
        new ConfirmSyncModal(this.app, toUpload, toDownload, toDeleteLocal, toDeleteMac, executeSync).open();
      } else {
        await executeSync();
      }
    } catch (err: any) {
      console.error('Sync failed:', err);
      new Notice(`❌ Sync Failed: ${err.message || err}`);
      this.updateStatusBar('⚠️ Sync Failed');
    }
  }

  async uploadFile(filePath: string) {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (file) {
      const binaryData = await this.app.vault.adapter.readBinary(filePath);
      const url = `${this.settings.macUrl.replace(/\/$/, '')}/${encodeURIComponent(filePath).replace(/%2F/g, '/')}`;
      await requestUrl({
        url,
        method: 'PUT',
        headers: {
          'Authorization': 'Basic ' + btoa('obsidian:sync'),
          'Content-Type': 'application/octet-stream'
        },
        body: binaryData
      });
    }
  }

  async downloadFile(filePath: string) {
    const url = `${this.settings.macUrl.replace(/\/$/, '')}/${encodeURIComponent(filePath).replace(/%2F/g, '/')}`;
    const res = await requestUrl({
      url,
      method: 'GET',
      headers: { 'Authorization': 'Basic ' + btoa('obsidian:sync') }
    });

    const parts = filePath.split('/');
    if (parts.length > 1) {
      const parentDir = parts.slice(0, -1).join('/');
      if (!await this.app.vault.adapter.exists(parentDir)) {
        await this.app.vault.createFolder(parentDir);
      }
    }

    if (await this.app.vault.adapter.exists(filePath)) {
      await this.app.vault.adapter.writeBinary(filePath, res.arrayBuffer);
    } else {
      await this.app.vault.createBinary(filePath, res.arrayBuffer);
    }
  }

  async deleteMacFile(filePath: string) {
    const url = `${this.settings.macUrl.replace(/\/$/, '')}/${encodeURIComponent(filePath).replace(/%2F/g, '/')}`;
    await requestUrl({
      url,
      method: 'DELETE',
      headers: { 'Authorization': 'Basic ' + btoa('obsidian:sync') }
    });
  }

  // QR CODE FEATURES
  openConfigScanner() {
    new CameraScannerModal(this.app, 'Scan Connection Setup QR', (text) => {
      try {
        const config = JSON.parse(text);
        if (config.url && config.user && config.pass) {
          this.settings.macUrl = config.url;
          this.saveSettings();
          new Notice(`✅ Configuration Setup Successful!\nURL: ${config.url}`);
          this.checkMacState();
        } else {
          new Notice('❌ Invalid Setup QR Code format.');
        }
      } catch (e) {
        new Notice('❌ Failed to parse QR Code data.');
      }
    }).open();
  }

  openOfflinePullScanner() {
    new CameraScannerModal(this.app, 'Scan Mac Sync QR Carousel', (text, scannerModal) => {
      // Chunk format: globalIdx/globalTotal|filePath|fileChunkIdx/fileTotal|data
      const match = text.match(/^(\d+)\/(\d+)\|([^|]+)\|(.*)$/);
      if (match) {
        const globalIdx = parseInt(match[1]);
        const globalTotal = parseInt(match[2]);
        const filePath = match[3];
        const payloadData = match[4];

        scannerModal.registerChunk(globalIdx, globalTotal, filePath, payloadData);
      }
    }, async (scannedChunks) => {
      new Notice('🔄 Reconstructing offline pulled files...');
      const sortedEntries = Array.from(scannedChunks.entries()).sort((a, b) => a[0] - b[0]);
      
      const fileChunksMap = new Map<string, { chunkIdx: number; total: number; chunkData: string }[]>();
      for (const [_, item] of sortedEntries) {
        const match = item.data.match(/^(\d+)\/(\d+)\|(.*)$/);
        if (match) {
          const fileChunkIdx = parseInt(match[1]);
          const fileTotal = parseInt(match[2]);
          const data = match[3];

          if (!fileChunksMap.has(item.path)) {
            fileChunksMap.set(item.path, []);
          }
          fileChunksMap.get(item.path)!.push({ chunkIdx: fileChunkIdx, total: fileTotal, chunkData: data });
        }
      }

      let count = 0;
      for (const [filePath, chunks] of fileChunksMap.entries()) {
        chunks.sort((a, b) => a.chunkIdx - b.chunkIdx);
        const fullBase64 = chunks.map(c => c.chunkData).join('');
        
        try {
          // Ensure parent directories exist
          const parts = filePath.split('/');
          if (parts.length > 1) {
            const parentDir = parts.slice(0, -1).join('/');
            if (!await this.app.vault.adapter.exists(parentDir)) {
              await this.app.vault.createFolder(parentDir);
            }
          }

          const arrayBuffer = Uint8Array.from(atob(fullBase64), c => c.charCodeAt(0)).buffer;
          if (await this.app.vault.adapter.exists(filePath)) {
            await this.app.vault.adapter.writeBinary(filePath, arrayBuffer);
          } else {
            await this.app.vault.createBinary(filePath, arrayBuffer);
          }
          count++;
        } catch (e) {
          console.error(`Failed to write offline file ${filePath}`, e);
        }
      }

      this.settings.lastSyncTime = Math.floor(Date.now() / 1000);
      await this.saveSettings();
      new Notice(`✅ Offline Pull Complete! Reconstructed: ${count} file(s).`);
    }, true).open();
  }

  async showPushQrCarousel() {
    new Notice('🔄 Preparing offline files list...');
    
    const localFiles = this.app.vault.getFiles();
    const changedFiles: { path: string; contentB64: string }[] = [];

    for (const file of localFiles) {
      const p = file.path;
      const parts = p.split('/');
      if (parts.some(part => part.toLowerCase() === 'photos' || part.startsWith('.'))) {
        continue;
      }
      
      const mtime = Math.floor(file.stat.mtime / 1000);
      if (mtime > this.settings.lastSyncTime) {
        const binaryData = await this.app.vault.adapter.readBinary(p);
        // Convert arrayBuffer to base64
        const bytes = new Uint8Array(binaryData);
        let binaryStr = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binaryStr += String.fromCharCode(bytes[i]);
        }
        const b64 = btoa(binaryStr);
        changedFiles.push({ path: p, contentB64: b64 });
      }
    }

    if (changedFiles.length === 0) {
      new Notice('✔ No files modified since last sync!');
      return;
    }

    const CHUNK_SIZE = 1200;
    const allChunks: { path: string; chunkIndex: number; totalChunksForFile: number; chunkData: string }[] = [];
    
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

    const formattedPayloads = allChunks.map((c, idx) => {
      return `${idx + 1}/${allChunks.length}|${c.path}|${c.chunkIndex}/${c.totalChunksForFile}|${c.chunkData}`;
    });

    new QrCarouselModal(this.app, formattedPayloads).open();
  }
}

class ConfirmSyncModal extends Modal {
  toUpload: { path: string; size: number }[];
  toDownload: { path: string; size: number }[];
  toDeleteLocal: string[];
  toDeleteMac: string[];
  onConfirm: () => void;

  constructor(
    app: App,
    toUpload: { path: string; size: number }[],
    toDownload: { path: string; size: number }[],
    toDeleteLocal: string[],
    toDeleteMac: string[],
    onConfirm: () => void
  ) {
    super(app);
    this.toUpload = toUpload;
    this.toDownload = toDownload;
    this.toDeleteLocal = toDeleteLocal;
    this.toDeleteMac = toDeleteMac;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: '⚠️ Storage & Sync Permission Alert' });

    const totalDownloadBytes = this.toDownload.reduce((acc, f) => acc + f.size, 0);
    const totalUploadBytes = this.toUpload.reduce((acc, f) => acc + f.size, 0);

    const formatSize = (b: number) => {
      if (b < 1024) return `${b} B`;
      if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
      return `${(b / (1024 * 1024)).toFixed(2)} MB`;
    };

    contentEl.createEl('p', {
      text: `Sync action detected: Download ${formatSize(totalDownloadBytes)} (${this.toDownload.length} files) and upload ${formatSize(totalUploadBytes)} (${this.toUpload.length} files). Do you approve?`,
      style: 'font-size: 13px; color: var(--text-normal); margin-bottom: 12px;'
    });

    const scrollBox = contentEl.createDiv({
      style: 'max-height: 200px; overflow-y: auto; border: 1px solid var(--background-modifier-border); border-radius: 6px; padding: 10px; background: var(--background-primary); font-family: monospace; font-size: 11px; margin-bottom: 16px;'
    });

    if (this.toDownload.length > 0) {
      scrollBox.createEl('div', { text: '📥 DOWNLOADING FROM MAC:', style: 'font-weight: bold; color: var(--text-accent); margin-bottom: 4px;' });
      this.toDownload.forEach(f => {
        scrollBox.createEl('div', { text: `  • ${f.path} (${formatSize(f.size)})`, style: 'margin-bottom: 2px;' });
      });
    }

    if (this.toUpload.length > 0) {
      scrollBox.createEl('div', { text: '📤 UPLOADING TO MAC:', style: 'font-weight: bold; color: var(--text-accent); margin-top: 8px; margin-bottom: 4px;' });
      this.toUpload.forEach(f => {
        scrollBox.createEl('div', { text: `  • ${f.path} (${formatSize(f.size)})`, style: 'margin-bottom: 2px;' });
      });
    }

    if (this.toDeleteLocal.length > 0 || this.toDeleteMac.length > 0) {
      scrollBox.createEl('div', { text: '🗑️ DELETIONS:', style: 'font-weight: bold; color: var(--text-warning); margin-top: 8px; margin-bottom: 4px;' });
      this.toDeleteLocal.forEach(p => scrollBox.createEl('div', { text: `  • Delete local: ${p}` }));
      this.toDeleteMac.forEach(p => scrollBox.createEl('div', { text: `  • Delete on Mac: ${p}` }));
    }

    const btnRow = contentEl.createDiv({
      style: 'display: flex; gap: 10px; width: 100%;'
    });

    const cancelBtn = btnRow.createEl('button', {
      text: '❌ Cancel Sync',
      style: 'flex: 1; padding: 10px; font-weight: bold;'
    });

    const confirmBtn = btnRow.createEl('button', {
      text: '✅ Approve & Sync',
      style: 'flex: 1; padding: 10px; font-weight: bold; background: var(--interactive-accent); color: var(--text-on-accent);'
    });

    cancelBtn.addEventListener('click', () => {
      new Notice('Sync cancelled by user.');
      this.close();
    });

    confirmBtn.addEventListener('click', () => {
      this.close();
      this.onConfirm();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class CameraScannerModal extends Modal {
  title: string;
  onScanComplete: (text: string, modal: CameraScannerModal) => void;
  onAllComplete?: (scanned: Map<number, { path: string; data: string }>) => void;
  isMultiScan: boolean;
  scanner: Html5Qrcode | null = null;
  
  scannedChunks = new Map<number, { path: string; data: string }>();
  totalChunks: number | null = null;
  statusDiv: HTMLDivElement;

  constructor(
    app: App, 
    title: string, 
    onScanComplete: (text: string, modal: CameraScannerModal) => void,
    onAllComplete?: (scanned: Map<number, { path: string; data: string }>) => void,
    isMultiScan = false
  ) {
    super(app);
    this.title = title;
    this.onScanComplete = onScanComplete;
    this.onAllComplete = onAllComplete;
    this.isMultiScan = isMultiScan;
  }

  registerChunk(index: number, total: number, path: string, data: string) {
    this.totalChunks = total;
    if (!this.scannedChunks.has(index)) {
      this.scannedChunks.set(index, { path, data });
      this.statusDiv.setText(`Scanned ${this.scannedChunks.size} of ${total} QR codes...`);

      if (this.scannedChunks.size === total) {
        this.close();
        if (this.onAllComplete) {
          this.onAllComplete(this.scannedChunks);
        }
      }
    }
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: this.title });
    contentEl.createEl('p', { text: 'Point S23 Ultra\'s camera directly at the screen:' });

    const scannerDiv = contentEl.createDiv({
      style: 'width: 100%; max-width: 320px; height: 240px; border-radius: 8px; border: 1px solid var(--background-modifier-border); overflow: hidden; background: #000; margin: 12px auto;'
    });
    scannerDiv.id = 'obsidian-camera-scanner-view';

    this.statusDiv = contentEl.createDiv({
      text: 'Accessing camera...',
      style: 'text-align: center; margin-top: 10px; font-weight: bold; color: var(--text-accent);'
    });

    const manualInputDiv = contentEl.createDiv({
      style: 'margin-top: 16px; width: 100%; display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--background-modifier-border); padding-top: 12px;'
    });
    manualInputDiv.createEl('span', {
      text: 'Or paste QR text payload here:',
      style: 'font-size: 12px; color: var(--text-muted); font-weight: bold;'
    });
    const textarea = manualInputDiv.createEl('textarea', {
      placeholder: 'Paste globalIndex/total|filePath|chunkIdx/totalChunksForFile|data OR config JSON...',
      style: 'width: 100%; height: 80px; border-radius: 4px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); color: var(--text-normal); font-family: monospace; font-size: 11px; padding: 6px; resize: none;'
    });
    const submitBtn = manualInputDiv.createEl('button', {
      text: 'Submit Text Payload',
      style: 'padding: 8px; font-weight: bold; background: var(--interactive-accent); color: var(--text-on-accent); cursor: pointer;'
    });
    submitBtn.addEventListener('click', () => {
      const text = textarea.value.trim();
      if (text) {
        this.onScanComplete(text, this);
        textarea.value = '';
        if (!this.isMultiScan) {
          this.close();
        }
      }
    });

    setTimeout(() => {
      try {
        const scanner = new Html5Qrcode(scannerDiv.id);
        this.scanner = scanner;

        scanner.start(
          { facingMode: 'environment' },
          { fps: 15, qrbox: { width: 220, height: 220 } },
          (decodedText) => {
            this.onScanComplete(decodedText, this);
            if (!this.isMultiScan) {
              this.close();
            }
          },
          () => {}
        ).then(() => {
          this.statusDiv.setText('Camera active. Scanning...');
        }).catch((err) => {
          this.statusDiv.setText(`Camera error (No access). Please use manual text paste below!`);
        });
      } catch (err: any) {
        this.statusDiv.setText(`Camera error (No access). Please use manual text paste below!`);
      }
    }, 300);
  }

  onClose() {
    if (this.scanner && this.scanner.isScanning) {
      this.scanner.stop().catch(() => {});
    }
    this.contentEl.empty();
  }
}

class QrCarouselModal extends Modal {
  payloads: string[];
  currentIndex = 0;
  qrImg: HTMLImageElement;
  progressText: HTMLDivElement;

  constructor(app: App, payloads: string[]) {
    super(app);
    this.payloads = payloads;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Phone Sync QR Carousel' });
    contentEl.createEl('p', { text: 'Scan these QR codes one-by-one using the Mac Webcam:' });

    const container = contentEl.createDiv({
      style: 'display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; margin-top: 10px;'
    });

    this.qrImg = container.createEl('img', {
      style: 'width: 200px; height: 200px; border-radius: 8px; border: 1px solid var(--background-modifier-border); background: #fff; padding: 10px;'
    });

    this.progressText = container.createDiv({
      style: 'font-weight: bold; font-size: 14px; margin-top: 4px;'
    });

    const btnRow = container.createDiv({
      style: 'display: flex; gap: 10px; width: 100%; margin-top: 10px;'
    });

    const prevBtn = btnRow.createEl('button', {
      text: '◀ Prev',
      style: 'flex: 1; padding: 10px;'
    });
    const nextBtn = btnRow.createEl('button', {
      text: 'Next ▶',
      style: 'flex: 1; padding: 10px;'
    });

    await this.loadQrCode();

    prevBtn.addEventListener('click', async () => {
      if (this.currentIndex > 0) {
        this.currentIndex--;
        await this.loadQrCode();
      }
    });

    nextBtn.addEventListener('click', async () => {
      if (this.currentIndex < this.payloads.length - 1) {
        this.currentIndex++;
        await this.loadQrCode();
      }
    });
  }

  async loadQrCode() {
    try {
      const dataUrl = await QRCode.toDataURL(this.payloads[this.currentIndex], { margin: 2, scale: 6 });
      this.qrImg.src = dataUrl;
      this.progressText.setText(`QR Code ${this.currentIndex + 1} of ${this.payloads.length}`);
    } catch (e) {
      this.progressText.setText('Failed to generate QR code');
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class WifiSyncSettingTab extends PluginSettingTab {
  plugin: WifiSyncPlugin;

  constructor(app: App, plugin: WifiSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Obsidian Wi-Fi Sync Settings' });

    new Setting(containerEl)
      .setName('Mac App URL')
      .setDesc('Enter the Server URL displayed on your Mac App.')
      .addText(text => text
        .setPlaceholder('http://happys-MacBook-Pro.local:19000/')
        .setValue(this.plugin.settings.macUrl)
        .onChange(async (value) => {
          this.plugin.settings.macUrl = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Sync Mode')
      .setDesc('Choose between Standard (Smart Section Merge) or Live Mode (Real-Time Stream & Active Lock).')
      .addDropdown(drop => drop
        .addOption('standard', 'Standard Mode (Smart Section Merge)')
        .addOption('live', 'Live Mode (Real-Time Live Stream & Lock)')
        .setValue(this.plugin.settings.syncMode || 'standard')
        .onChange(async (value: 'standard' | 'live') => {
      this.plugin.settings.syncMode = value;
          await this.plugin.saveSettings();
          this.plugin.updateStatusBar(value === 'live' ? '⚡ Live Mode' : '⚪ Ready');
          new Notice(`Sync Mode: ${value === 'live' ? '⚡ Live Mode (Active Stream & Lock)' : '🛡️ Standard Mode (Smart Section Merge)'}`);
        }));

    new Setting(containerEl)
      .setName('Scan Setup QR')
      .setDesc('Configure connection settings instantly by scanning the Mac app\'s setup QR code.')
      .addButton(btn => btn
        .setButtonText('Scan Setup QR')
        .onClick(() => {
          this.plugin.openConfigScanner();
        }));

    new Setting(containerEl)
      .setName('Connection Status')
      .setDesc('Test connection to the Mac application.')
      .addButton(btn => btn
        .setButtonText('Test Connection')
        .onClick(async () => {
          try {
            await this.plugin.checkMacState();
            new Notice('✅ Connection Successful!');
          } catch (e) {
            new Notice('❌ Connection Failed. Check IP and Wi-Fi.');
          }
        }));
  }
}

class SyncLogModal extends Modal {
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '⚡ Live Sync Microsecond Diagnostic Logs' });
    contentEl.createEl('p', { text: `Total high-precision events recorded: ${syncLogs.length}` });

    const logContainer = contentEl.createEl('pre', {
      style: 'background: #1e1e1e; color: #00ff66; padding: 12px; border-radius: 6px; max-height: 450px; overflow-y: auto; font-family: monospace; font-size: 11px; white-space: pre-wrap;'
    });

    logContainer.setText(syncLogs.length > 0 ? syncLogs.join('\n') : 'No sync events logged yet.');

    const btn = contentEl.createEl('button', { text: 'Refresh Logs' });
    btn.onclick = () => {
      logContainer.setText(syncLogs.length > 0 ? syncLogs.join('\n') : 'No sync events logged yet.');
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}
