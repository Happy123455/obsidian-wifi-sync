import React, { useState, useEffect, useRef } from 'react';
import { SettingsModal } from './components/SettingsModal';
import { SearchPanel } from './components/SearchPanel';
import QRCode from 'qrcode';
import { Html5Qrcode } from 'html5-qrcode';

type SyncStatus = 'idle' | 'checking' | 'syncing' | 'success' | 'error';
type PushStatus = 'idle' | 'pushing' | 'success' | 'error';
type DeviceStatus = 'scanning' | 'connected' | 'unauthorized' | 'offline' | 'none';

interface LogLine {
  text: string;
  type: 'info' | 'success' | 'warn' | 'error' | 'progress';
}

const App: React.FC = () => {
  console.log('App component rendering started');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus>('scanning');
  const [deviceMessage, setDeviceMessage] = useState('Checking ADB...');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [settings, setSettings] = useState({ 
    source: '', 
    dest: '', 
    adbPath: '', 
    autoLaunch: true, 
    autoSyncOnConnect: true 
  });
  const [progress, setProgress] = useState<number | null>(null);
  const [pushStatus, setPushStatus] = useState<PushStatus>('idle');
  const [pushCountdown, setPushCountdown] = useState(0);

  // WebDAV and Editing Safety state variables
  const [webdavInfo, setWebdavInfo] = useState({
    ip: '',
    port: 19000,
    url: '',
    state: 'viewing' as 'viewing' | 'requesting-pull' | 'editing' | 'requesting-push' | 'locked',
    lastSync: 0,
    isMobileActive: false
  });
  const [editTimer, setEditTimer] = useState(0); // seconds remaining in editing window

  // QR Code Setup & Offline Sync states
  const [setupQrUrl, setSetupQrUrl] = useState<string | null>(null);
  const [isQrModalOpen, setIsQrModalOpen] = useState(false);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [scanProgress, setScanProgress] = useState('');
  const [scannedChunks, setScannedChunks] = useState<Map<number, { path: string; data: string }>>(new Map());
  const [totalChunks, setTotalChunks] = useState<number | null>(null);
  const [offlineSyncQrUrl, setOfflineSyncQrUrl] = useState<string | null>(null);
  const [offlineQrIndex, setOfflineQrIndex] = useState(0);
  const [offlineQrList, setOfflineQrList] = useState<string[]>([]);
  const [isOfflineQrCarouselOpen, setIsOfflineQrCarouselOpen] = useState(false);
  
  const scannerContainerId = "mac-webcam-scanner-view";
  const html5QrcodeRef = useRef<Html5Qrcode | null>(null);

  const terminalEndRef = useRef<HTMLDivElement>(null);

  // Load settings and WebDAV info on startup
  useEffect(() => {
    window.api.getSettings().then((res) => {
      setSettings(res);
    });
    window.api.getWebdavInfo().then((info) => {
      setWebdavInfo(info);
      if (info.state === 'editing') {
        setEditTimer(1800); // 30 minutes
      }
    });
  }, []);

  // Poll device connection status
  useEffect(() => {
    const checkConnection = async () => {
      // Don't poll while actively syncing
      if (syncStatus === 'syncing') return;

      try {
        const res = await window.api.checkAdbAndDevice();
        if (res.success) {
          setDeviceStatus('connected');
          setDeviceMessage(res.message);
        } else {
          setDeviceStatus(res.error === 'ADB_NOT_FOUND' ? 'none' : res.error === 'UNAUTHORIZED_DEVICE' ? 'unauthorized' : res.error === 'DEVICE_OFFLINE' ? 'offline' : 'none');
          setDeviceMessage(res.message);
        }
      } catch (err) {
        setDeviceStatus('none');
        setDeviceMessage('Error checking device connection.');
      }
    };

    checkConnection();
    const interval = setInterval(checkConnection, 5000);

    return () => clearInterval(interval);
  }, [syncStatus]);

  // Poll WebDAV info
  useEffect(() => {
    const fetchWebdav = async () => {
      try {
        const info = await window.api.getWebdavInfo();
        setWebdavInfo(info);
      } catch (err) {
        console.error('Error fetching WebDAV info:', err);
      }
    };
    fetchWebdav();
    const interval = setInterval(fetchWebdav, 2000);
    return () => clearInterval(interval);
  }, []);

  // WebDAV Edit window countdown timer (30 minutes)
  useEffect(() => {
    if (webdavInfo.state !== 'editing') {
      setEditTimer(0);
      return;
    }
    if (editTimer <= 0) {
      if (webdavInfo.state === 'editing') {
        // Expiration: reset state back to viewing
        window.api.setMacEditState('viewing');
      }
      return;
    }
    const timer = setInterval(() => {
      setEditTimer((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [webdavInfo.state, editTimer]);

  // Listen to WebDAV IPC events
  useEffect(() => {
    const unsubscribeState = window.api.onEditStateChanged((data) => {
      setWebdavInfo((prev) => ({ ...prev, state: data.state }));
      if (data.state === 'editing') {
        setEditTimer(1800); // 30 minutes
      }
    });

    const unsubscribeWebdavSync = window.api.onWebdavSyncCompleted(() => {
      // Re-fetch info when sync finishes
      window.api.getWebdavInfo().then(setWebdavInfo);
    });

    return () => {
      unsubscribeState();
      unsubscribeWebdavSync();
    };
  }, []);

  // Handle IPC Logs and Sync Complete events
  useEffect(() => {
    const unsubscribeLog = window.api.onLog((msg) => {
      let type: LogLine['type'] = 'info';
      let text = msg;

      if (msg.startsWith('[INFO] ')) {
        type = 'info';
        text = msg.substring(7);
      } else if (msg.startsWith('[SUCCESS] ')) {
        type = 'success';
        text = msg.substring(10);
      } else if (msg.startsWith('[WARN] ')) {
        type = 'warn';
        text = msg.substring(7);
      } else if (msg.startsWith('[ERROR] ')) {
        type = 'error';
        text = msg.substring(8);
      } else if (msg.startsWith('[WEBDAV] ')) {
        type = 'info';
        text = '📱 WebDAV: ' + msg.substring(9);
      } else if (msg.includes('pulling') || msg.includes('pull:') || msg.match(/^\s*\[\s*\d+%/)) {
        type = 'progress';
      }

      setLogs((prev) => [...prev.slice(-400), { text, type }]);
    });

    const unsubscribeWebdavActivity = window.api.onWebdavActivity((data) => {
      setWebdavInfo((prev) => ({ ...prev, isMobileActive: true, lastSync: data.timestamp }));
    });

    const unsubscribeSync = window.api.onSyncCompleted((status) => {
      if (status.success) {
        setSyncStatus('success');
        setProgress(100);
      } else {
        setSyncStatus('error');
      }

      // Hide progress bar after 2 seconds
      setTimeout(() => {
        setProgress(null);
      }, 2000);

      // Reset button back to idle after 4 seconds
      setTimeout(() => {
        setSyncStatus('idle');
      }, 4000);

      // Start push countdown if sync was successful
      if (status.success) {
        setPushCountdown(30);
      }
    });

    const unsubscribeProgress = window.api.onSyncProgress((pct) => {
      setProgress(pct);
    });

    const unsubscribePush = window.api.onPushCompleted((status) => {
      if (status.success) {
        setPushStatus('success');
        setProgress(100);
      } else {
        setPushStatus('error');
      }
      setTimeout(() => setProgress(null), 2000);
      setTimeout(() => {
        setPushStatus('idle');
        setPushCountdown(0);
      }, 4000);
    });

    return () => {
      unsubscribeLog();
      unsubscribeWebdavActivity();
      unsubscribeSync();
      unsubscribeProgress();
      unsubscribePush();
    };
  }, []);

  // Auto-scroll terminal to bottom when new logs arrive
  useEffect(() => {
    if (terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // Push countdown timer
  useEffect(() => {
    if (pushCountdown <= 0) return;
    const timer = setInterval(() => {
      setPushCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [pushCountdown > 0]); // only re-run when crossing the 0 boundary

  // Keyboard shortcut listener (Cmd + S or Ctrl + S to Sync, Cmd + F to Search)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCmdOrCtrl = e.metaKey || e.ctrlKey;

      // Cmd+F — open search panel
      if (isCmdOrCtrl && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }

      if (settingsOpen || searchOpen || syncStatus === 'syncing' || syncStatus === 'checking') return;

      const isS = e.key.toLowerCase() === 's';
      const isEnter = e.key === 'Enter';

      if (isCmdOrCtrl && (isS || isEnter)) {
        e.preventDefault();
        handleSyncClick();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [settingsOpen, searchOpen, syncStatus, settings]);

  const handleSyncClick = async () => {
    if (syncStatus === 'syncing') return;

    // Check device connection before syncing
    setSyncStatus('checking');
    setLogs([]);
    setLogs([{ text: 'Checking device status...', type: 'info' }]);

    try {
      const conn = await window.api.checkAdbAndDevice();
      if (!conn.success) {
        setSyncStatus('error');
        setProgress(null);
        setLogs((prev) => [
          ...prev,
          { text: conn.message, type: 'error' },
          { text: 'Sync aborted. Check connection.', type: 'error' }
        ]);
        setTimeout(() => setSyncStatus('idle'), 4000);
        return;
      }

      // Device connected, launch sync process
      setSyncStatus('syncing');
      setProgress(0);
      await window.api.startSync(settings);
    } catch (err: any) {
      setSyncStatus('error');
      setProgress(null);
      setLogs((prev) => [...prev, { text: `Failed to trigger sync: ${err.message}`, type: 'error' }]);
      setTimeout(() => setSyncStatus('idle'), 4000);
    }
  };

  const getButtonText = () => {
    switch (syncStatus) {
      case 'checking':
        return 'Checking...';
      case 'syncing':
        return 'Syncing...';
      case 'success':
        return 'Synced!';
      case 'error':
        return 'Failed';
      case 'idle':
      default:
        return 'Sync Vault';
    }
  };

  const handlePushClick = async () => {
    if (pushStatus === 'pushing' || pushCountdown <= 0) return;
    setPushStatus('pushing');
    setProgress(0);
    setLogs((prev) => [...prev, { text: '⬆️ Initiating Mac → Phone push...', type: 'info' }]);
    try {
      await window.api.pushToPhone();
    } catch (err: any) {
      setPushStatus('error');
      setProgress(null);
      setLogs((prev) => [...prev, { text: `Push failed: ${err.message}`, type: 'error' }]);
      setTimeout(() => setPushStatus('idle'), 4000);
    }
  };

  const handleRequestEdit = async () => {
    setLogs((prev) => [...prev, { text: '🔄 Requesting edit mode. Waiting for S23 Ultra to pull/sync...', type: 'info' }]);
    await window.api.setMacEditState('requesting-pull');
    const info = await window.api.getWebdavInfo();
    setWebdavInfo(info);
  };

  const handleCancelEditRequest = async () => {
    setLogs((prev) => [...prev, { text: '❌ Edit request cancelled.', type: 'warn' }]);
    await window.api.setMacEditState('viewing');
    const info = await window.api.getWebdavInfo();
    setWebdavInfo(info);
  };

  const handleFinishEditing = async () => {
    setLogs((prev) => [...prev, { text: '🔄 Mac edits completed. Waiting for S23 Ultra sync to push changes...', type: 'info' }]);
    await window.api.setMacEditState('requesting-push');
    const info = await window.api.getWebdavInfo();
    setWebdavInfo(info);
  };

  const handleUnlockViewing = async () => {
    setLogs((prev) => [...prev, { text: '🔓 Safe Viewing lock deactivated.', type: 'success' }]);
    await window.api.setMacEditState('viewing');
    const info = await window.api.getWebdavInfo();
    setWebdavInfo(info);
  };

  const handleCopyUrl = () => {
    navigator.clipboard.writeText(webdavInfo.url);
    setLogs((prev) => [...prev, { text: '📋 WebDAV URL copied to clipboard!', type: 'success' }]);
  };

  const handleInstallPluginClick = async () => {
    setLogs((prev) => [...prev, { text: '🔄 Installing custom Obsidian Wi-Fi Sync Plugin...', type: 'info' }]);
    try {
      const res = await window.api.installObsidianPlugin();
      if (res.success) {
        setLogs((prev) => [...prev, { text: `✔ ${res.message}`, type: 'success' }]);
      } else {
        setLogs((prev) => [...prev, { text: `✖ ${res.message}`, type: 'error' }]);
      }
    } catch (err: any) {
      setLogs((prev) => [...prev, { text: `✖ Installation failed: ${err.message}`, type: 'error' }]);
    }
  };

  // QR Setup and Offline Sync Handlers
  const handleGenerateSetupQr = async () => {
    try {
      // Connect to happys-MacBook-Pro.local as permanent URL
      const data = JSON.stringify({
        url: `http://happys-MacBook-Pro.local:19000/`,
        user: 'obsidian',
        pass: 'sync'
      });
      const dataUrl = await QRCode.toDataURL(data, { margin: 2, scale: 6 });
      setSetupQrUrl(dataUrl);
      setIsQrModalOpen(true);
    } catch (err: any) {
      setLogs((prev) => [...prev, { text: `✖ Failed to generate Setup QR: ${err.message}`, type: 'error' }]);
    }
  };

  const startWebcamScanner = async () => {
    setScannedChunks(new Map());
    setTotalChunks(null);
    setScanProgress('Initializing camera...');
    setIsScannerOpen(true);

    setTimeout(async () => {
      try {
        const html5Qrcode = new Html5Qrcode(scannerContainerId);
        html5QrcodeRef.current = html5Qrcode;

        await html5Qrcode.start(
          { facingMode: "environment" },
          {
            fps: 15,
            qrbox: { width: 250, height: 250 }
          },
          async (decodedText) => {
            // Format: globalIndex/globalTotal|filePath|restPayload (fileChunkIdx/fileTotal|data)
            const match = decodedText.match(/^(\d+)\/(\d+)\|([^|]+)\|(.*)$/);
            if (match) {
              const globalIndex = parseInt(match[1]);
              const globalTotal = parseInt(match[2]);
              const filePath = match[3];
              const restPayload = match[4];

              setTotalChunks(globalTotal);
              setScannedChunks((prev) => {
                const next = new Map(prev);
                if (!next.has(globalIndex)) {
                  next.set(globalIndex, { path: filePath, data: restPayload });
                  setScanProgress(`Scanned ${next.size} of ${globalTotal} chunks...`);

                  if (next.size === globalTotal) {
                    stopWebcamScanner();
                    reconstructOfflineSync(next);
                  }
                }
                return next;
              });
            }
          },
          () => {}
        );
      } catch (err: any) {
        setScanProgress(`Camera access failed: ${err.message || err}`);
      }
    }, 300);
  };

  const stopWebcamScanner = async () => {
    if (html5QrcodeRef.current && html5QrcodeRef.current.isScanning) {
      try {
        await html5QrcodeRef.current.stop();
      } catch (e) {}
    }
    html5QrcodeRef.current = null;
    setIsScannerOpen(false);
  };

  const reconstructOfflineSync = async (chunksMap: Map<number, { path: string; data: string }>) => {
    setLogs((prev) => [...prev, { text: '🔄 Reconstructing files from offline QR sync...', type: 'info' }]);
    const sortedEntries = Array.from(chunksMap.entries()).sort((a, b) => a[0] - b[0]);
    
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

    let successCount = 0;
    let failCount = 0;

    for (const [filePath, chunks] of fileChunksMap.entries()) {
      chunks.sort((a, b) => a.chunkIdx - b.chunkIdx);
      const fullBase64 = chunks.map(c => c.chunkData).join('');
      
      try {
        const res = await window.api.applyOfflineFile(filePath, fullBase64);
        if (res.success) {
          successCount++;
          setLogs((prev) => [...prev, { text: `✔ Offline applied: ${filePath}`, type: 'success' }]);
        } else {
          failCount++;
          setLogs((prev) => [...prev, { text: `✖ Offline failed: ${filePath} (${res.message})`, type: 'error' }]);
        }
      } catch (err: any) {
        failCount++;
        setLogs((prev) => [...prev, { text: `✖ Error writing ${filePath}: ${err.message}`, type: 'error' }]);
      }
    }

    setLogs((prev) => [...prev, { text: `🎉 Offline QR Sync complete! Applied: ${successCount}, Failed: ${failCount}`, type: 'success' }]);
  };

  const handleGenerateMacOfflineQr = async () => {
    setLogs((prev) => [...prev, { text: '🔄 Generating offline sync QR codes...', type: 'info' }]);
    try {
      const payload = await window.api.getOfflineSyncPayload(webdavInfo.lastSync / 1000);
      
      if (payload.length === 0) {
        setLogs((prev) => [...prev, { text: '✔ No modified files to sync offline!', type: 'success' }]);
        alert('No modified files found since your last sync!');
        return;
      }

      setOfflineQrList(payload);
      setOfflineQrIndex(0);
      setIsOfflineQrCarouselOpen(true);
      
      const dataUrl = await QRCode.toDataURL(payload[0], { margin: 2, scale: 6 });
      setOfflineSyncQrUrl(dataUrl);
    } catch (err: any) {
      setLogs((prev) => [...prev, { text: `✖ Failed to generate offline QR: ${err.message}`, type: 'error' }]);
    }
  };

  const handleNextOfflineQr = async () => {
    if (offlineQrIndex < offlineQrList.length - 1) {
      const nextIdx = offlineQrIndex + 1;
      setOfflineQrIndex(nextIdx);
      const dataUrl = await QRCode.toDataURL(offlineQrList[nextIdx], { margin: 2, scale: 6 });
      setOfflineSyncQrUrl(dataUrl);
    }
  };

  const handlePrevOfflineQr = async () => {
    if (offlineQrIndex > 0) {
      const prevIdx = offlineQrIndex - 1;
      setOfflineQrIndex(prevIdx);
      const dataUrl = await QRCode.toDataURL(offlineQrList[prevIdx], { margin: 2, scale: 6 });
      setOfflineSyncQrUrl(dataUrl);
    }
  };

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="app-container">
      {/* Draggable Title Bar */}
      <header className="titlebar">
        <span className="titlebar-title">Obsidian Sync</span>
        <div className="titlebar-actions">
          {/* Status Indicator */}
          <div className="status-pill" title={deviceMessage}>
            <span className={`status-dot ${
              deviceStatus === 'connected' ? 'connected' : 
              deviceStatus === 'scanning' ? 'warn' : 
              deviceStatus === 'unauthorized' ? 'warn' : 'danger'
            }`} />
            <span>
              {deviceStatus === 'connected' ? 'Connected' : 
               deviceStatus === 'scanning' ? 'Scanning...' : 
               deviceStatus === 'unauthorized' ? 'Unauthorized' : 'No USB Device'}
            </span>
          </div>

          {/* Search Button */}
          <button 
            className="folder-btn" 
            onClick={() => setSearchOpen(true)}
            aria-label="Search Vault"
            title="Search synced vault (⌘F)"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </button>

          {/* Open Mac Folder Button */}
          <button 
            className="folder-btn" 
            onClick={() => window.api.openDestFolder()}
            aria-label="Open Destination Folder"
            title="Open backup folder on Mac"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </button>

          {/* Settings Trigger */}
          <button 
            className="settings-btn" 
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        </div>
      </header>

      {/* Main Content Pane */}
      <main className="main-content">
        {/* Local Wi-Fi Sync (WebDAV) Status Grid */}
        <div className="webdav-dashboard-grid">
          
          {/* Card 1: WebDAV Server Connection Details */}
          <div className="dashboard-card webdav-info-card">
            <div className="card-header">
              <div className="card-title">
                <span className="wifi-icon">📶</span>
                <span>Local Wi-Fi Sync (WebDAV)</span>
              </div>
              <div className="device-status-indicator">
                <span className={`pulse-dot ${webdavInfo.isMobileActive ? 'active' : 'inactive'}`} />
                <span>S23 Ultra {webdavInfo.isMobileActive ? 'Active' : 'Inactive'}</span>
              </div>
            </div>
            
            <div className="card-body">
              <p className="card-desc">No Developer Options needed. In Obsidian on your phone, set Remotely Save plugin to WebDAV with these credentials:</p>
              
              <div className="webdav-fields">
                <div className="webdav-field">
                  <span className="field-label">Server URL</span>
                  <div className="field-value-wrap">
                    <code className="field-value">{webdavInfo.url || 'http://resolving-ip...'}</code>
                    <button className="copy-btn" onClick={handleCopyUrl} style={{ marginRight: '6px' }} title="Copy WebDAV URL">Copy</button>
                    <button className="copy-btn" onClick={handleGenerateSetupQr} title="Show Connection Setup QR Code">QR Setup</button>
                  </div>
                </div>
                
                <div className="webdav-auth-row">
                  <div className="webdav-field half">
                    <span className="field-label">Username</span>
                    <code className="field-value">obsidian</code>
                  </div>
                  <div className="webdav-field half">
                    <span className="field-label">Password</span>
                    <code className="field-value">sync</code>
                  </div>
                </div>
              </div>

              <div className="plugin-install-section" style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px solid rgba(255, 255, 255, 0.06)' }}>
                <span className="field-label" style={{ marginBottom: '6px', display: 'block' }}>Or use our custom Wi-Fi Sync plugin:</span>
                <button className="copy-btn" style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '10px' }} onClick={handleInstallPluginClick}>
                  📲 Install Wi-Fi Sync Plugin
                </button>
              </div>
            </div>
          </div>

          {/* Card 2: Mac Editing Safety Guard Control (Conflict Prevention) */}
          <div className={`dashboard-card guard-card state-${webdavInfo.state}`}>
            <div className="card-header">
              <div className="card-title">
                <span className="guard-icon">🛡️</span>
                <span>Mac Edit Safety Cover</span>
              </div>
              <div className="guard-state-badge">
                {webdavInfo.state === 'viewing' && '🟢 Safe Viewing'}
                {webdavInfo.state === 'requesting-pull' && '🟡 Waiting for Pull'}
                {webdavInfo.state === 'editing' && '🟢 Safe to Edit'}
                {webdavInfo.state === 'requesting-push' && '🟡 Waiting for Push'}
                {webdavInfo.state === 'locked' && '🔴 Locked'}
              </div>
            </div>

            <div className="card-body guard-body">
              {webdavInfo.state === 'viewing' && (
                <>
                  <p className="guard-text">Safety Lock is active. Files are protected. You can safely read your notes on this Mac. Click below to start editing on Mac.</p>
                  <button className="btn-guard btn-request" onClick={handleRequestEdit}>
                    🔓 Request Edit Mode on Mac
                  </button>
                </>
              )}

              {webdavInfo.state === 'requesting-pull' && (
                <>
                  <p className="guard-text progress-pulse">
                    Pulling latest S23 Ultra changes before you edit... Please open Obsidian on your phone to trigger a sync.
                  </p>
                  <button className="btn-guard btn-cancel" onClick={handleCancelEditRequest}>
                    Cancel Request
                  </button>
                </>
              )}

              {webdavInfo.state === 'editing' && (
                <>
                  <div className="guard-timer-wrap">
                    <p className="guard-text font-bold">🟢 Unlocked: Safe to edit notes inside Obsidian on this Mac now.</p>
                    {editTimer > 0 && (
                      <div className="edit-countdown">
                        Timer: <span className="timer-val">{formatTimer(editTimer)}</span>
                      </div>
                    )}
                  </div>
                  <button className="btn-guard btn-finish" onClick={handleFinishEditing}>
                    🔒 Done Editing (Push & Lock)
                  </button>
                </>
              )}

              {webdavInfo.state === 'requesting-push' && (
                <>
                  <p className="guard-text progress-pulse">
                    Mac changes saved. Waiting for phone to fetch them. Please open Obsidian on your S23 Ultra to complete the sync.
                  </p>
                  <button className="btn-guard btn-cancel" onClick={handleCancelEditRequest}>
                    Cancel Push
                  </button>
                </>
              )}

              {webdavInfo.state === 'locked' && (
                <>
                  <p className="guard-text warning-text font-bold">
                    🔴 Mac changes pushed successfully. Please do NOT edit on Mac right now to prevent data clashes.
                  </p>
                  <button className="btn-guard btn-unlock" onClick={handleUnlockViewing}>
                    🔓 Return to Safe Viewing
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Card 3: Offline QR Sync Card */}
          <div className="dashboard-card offline-qr-card">
            <div className="card-header">
              <div className="card-title">
                <span className="qr-icon">📶</span>
                <span>Offline QR Sync (No Network)</span>
              </div>
            </div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px', height: '100%', justifyContent: 'center' }}>
              <p className="card-desc" style={{ marginBottom: '6px' }}>No Wi-Fi or USB? Sync your vaults offline by scanning swipeable QR codes using your device cameras!</p>
              
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-guard btn-request" style={{ flex: 1, padding: '10px', background: 'rgba(52, 199, 89, 0.1)', borderColor: 'var(--success)', color: 'var(--success)' }} onClick={startWebcamScanner}>
                  🎥 Scan Phone QR Code
                </button>
                <button className="btn-guard btn-finish" style={{ flex: 1, padding: '10px' }} onClick={handleGenerateMacOfflineQr}>
                  📲 Generate Mac QR Sync
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Fallback USB Sync controls (shown smaller/discreetly) */}
        <div className="usb-fallback-accordion">
          <div className="usb-accordion-header">
            <span>🔌 Fallback USB Sync (Requires Developer Options / ADB)</span>
          </div>
          <div className="usb-accordion-content">
            <div className="usb-sync-row">
              <button 
                className={`sync-button-small ${syncStatus}`}
                onClick={handleSyncClick}
                disabled={syncStatus === 'syncing' || syncStatus === 'checking'}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: syncStatus === 'syncing' ? 'spin 3s linear infinite' : 'none' }}>
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
                </svg>
                <span>{getButtonText()}</span>
              </button>
              
              <div className="usb-sync-meta">
                <span>{deviceStatus === 'connected' ? deviceMessage : 'USB unplugged'}</span>
              </div>

              {pushCountdown > 0 && (
                <button
                  className={`push-button-small ${pushStatus}`}
                  onClick={handlePushClick}
                  disabled={pushStatus === 'pushing' || pushCountdown <= 0}
                >
                  <span>Push to Phone ({pushCountdown}s)</span>
                </button>
              )}
            </div>
            {progress !== null && (
              <div className="progress-container-small">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
            )}
          </div>
        </div>

        {/* Live Logs Console */}
        <section className="console-panel">
          <div className="console-header">
            <div className="console-title">
              <span className="console-dot" style={{ backgroundColor: webdavInfo.isMobileActive ? 'var(--success)' : 'var(--text-muted)' }} />
              <span>Sync Output Console</span>
            </div>
            {logs.length > 0 && (
              <button className="console-clear-btn" onClick={() => setLogs([])}>
                Clear
              </button>
            )}
          </div>
          <div className="console-body">
            {logs.length === 0 ? (
              <div className="console-line" style={{ color: 'var(--text-muted)' }}>
                System ready. Local Wi-Fi WebDAV server running on port {webdavInfo.port}.
              </div>
            ) : (
              logs.map((line, index) => (
                <div key={index} className={`console-line log-${line.type}`}>
                  {line.type === 'info' && '➔ '}
                  {line.type === 'success' && '✔ '}
                  {line.type === 'error' && '✖ '}
                  {line.type === 'warn' && '⚠ '}
                  {line.text}
                </div>
              ))
            )}
            <div ref={terminalEndRef} />
          </div>
        </section>
      </main>

      {/* Settings Modal */}
      <SettingsModal 
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSave={(newSettings) => setSettings(newSettings)}
      />

      {/* Search Panel */}
      <SearchPanel
        isOpen={searchOpen}
        onClose={() => setSearchOpen(false)}
      />

      {/* Setup QR Code Modal */}
      {isQrModalOpen && setupQrUrl && (
        <div className="settings-modal-backdrop" onClick={() => setIsQrModalOpen(false)}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '340px', textAlign: 'center' }}>
            <div className="modal-header">
              <h3 style={{ margin: 0, color: 'var(--text-light)' }}>QR & Text Setup Config</h3>
              <button className="close-button" onClick={() => setIsQrModalOpen(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '20px 10px' }}>
              <p className="card-desc" style={{ marginBottom: '16px', fontSize: '13px' }}>Scan with camera OR copy the setup payload text to paste into Obsidian S23 Ultra:</p>
              <img src={setupQrUrl} alt="Setup QR" style={{ width: '180px', height: '180px', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.1)' }} />
              <div style={{ marginTop: '14px', width: '100%' }}>
                <span className="field-label" style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)' }}>Permanent Address:</span>
                <code className="field-value" style={{ marginTop: '4px', fontSize: '12px', wordBreak: 'break-all' }}>happys-MacBook-Pro.local</code>
              </div>
              <button className="copy-btn" style={{ marginTop: '12px', width: '100%', padding: '8px', fontWeight: 'bold' }} onClick={() => {
                navigator.clipboard.writeText(JSON.stringify({ url: `http://${bonjourHostname}:19000/`, user: 'obsidian', pass: 'sync' }));
                alert('Copied Setup Payload JSON to Clipboard!');
              }}>
                📋 Copy Setup JSON Payload
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mac Webcam Scanner Modal */}
      {isScannerOpen && (
        <div className="settings-modal-backdrop" onClick={stopWebcamScanner}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '380px', textAlign: 'center' }}>
            <div className="modal-header">
              <h3 style={{ margin: 0, color: 'var(--text-light)' }}>Scan / Input Phone Payload</h3>
              <button className="close-button" onClick={stopWebcamScanner}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '16px 10px' }}>
              <p className="card-desc" style={{ marginBottom: '12px', fontSize: '13px' }}>Point S23 Ultra's screen (showing QR carousel) to your Mac's camera:</p>
              <div id={scannerContainerId} style={{ width: '320px', height: '200px', overflow: 'hidden', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.1)', background: '#000' }} />
              <div style={{ marginTop: '8px', fontSize: '13px', color: 'var(--success)', fontWeight: 'bold' }}>
                {scanProgress}
              </div>
              <div style={{ marginTop: '14px', width: '100%', textAlign: 'left', borderTop: '1px solid rgba(255, 255, 255, 0.1)', paddingTop: '10px' }}>
                <span className="field-label" style={{ fontSize: '11px', display: 'block', marginBottom: '4px' }}>Or paste phone text payload here:</span>
                <textarea
                  id="mac-manual-paste-area"
                  placeholder="Paste payload chunk line here..."
                  style={{ width: '100%', height: '60px', borderRadius: '4px', border: '1px solid rgba(255, 255, 255, 0.1)', background: 'rgba(0, 0, 0, 0.3)', color: 'var(--text-light)', fontFamily: 'monospace', fontSize: '11px', padding: '6px', resize: 'none' }}
                />
                <button className="copy-btn" style={{ marginTop: '6px', width: '100%', padding: '8px', fontWeight: 'bold' }} onClick={() => {
                  const el = document.getElementById('mac-manual-paste-area') as HTMLTextAreaElement;
                  if (el && el.value.trim()) {
                    handleQrScanResult(el.value.trim());
                    el.value = '';
                  }
                }}>
                  Submit Text Payload
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mac Sync QR Carousel & Text Payload Modal */}
      {isOfflineQrCarouselOpen && offlineSyncQrUrl && (
        <div className="settings-modal-backdrop" onClick={() => setIsOfflineQrCarouselOpen(false)}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '380px', textAlign: 'center' }}>
            <div className="modal-header">
              <h3 style={{ margin: 0, color: 'var(--text-light)' }}>Mac Sync Payload & QR Carousel</h3>
              <button className="close-button" onClick={() => setIsOfflineQrCarouselOpen(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '16px 10px' }}>
              <p className="card-desc" style={{ marginBottom: '12px', fontSize: '13px' }}>Option A: Copy payload text to paste in Mobile Obsidian.<br/>Option B: Scan QR code with system camera.</p>
              <img src={offlineSyncQrUrl} alt="Sync QR Chunk" style={{ width: '180px', height: '180px', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.1)', background: '#fff', padding: '8px' }} />
              <div style={{ marginTop: '10px', fontSize: '13px', fontWeight: 'bold', color: 'var(--text-light)' }}>
                QR Code {offlineQrIndex + 1} of {offlineQrList.length}
              </div>
              <div style={{ display: 'flex', gap: '8px', width: '100%', marginTop: '10px' }}>
                <button className="copy-btn" style={{ flex: 1, padding: '8px' }} onClick={handlePrevOfflineQr} disabled={offlineQrIndex === 0}>
                  ◀ Previous
                </button>
                <button className="copy-btn" style={{ flex: 1, padding: '8px' }} onClick={handleNextOfflineQr} disabled={offlineQrIndex === offlineQrList.length - 1}>
                  Next ▶
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', marginTop: '14px', borderTop: '1px solid rgba(255, 255, 255, 0.1)', paddingTop: '12px' }}>
                <button className="copy-btn" style={{ width: '100%', padding: '8px', fontSize: '12px', fontWeight: 'bold' }} onClick={() => {
                  navigator.clipboard.writeText(offlineQrList.join('\n'));
                  alert('Copied ALL Payload Text to Clipboard! Now paste it in Obsidian on your phone.');
                }}>
                  📋 Copy ALL Payload Text for Mobile Paste
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <style dangerouslySetInnerHTML={{__html: `
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}} />
    </div>
  );
};

export default App;
