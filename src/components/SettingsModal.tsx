import React, { useState, useEffect } from 'react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (settings: { source: string; dest: string; adbPath: string; autoLaunch: boolean; autoSyncOnConnect: boolean }) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, onSave }) => {
  const [source, setSource] = useState('/sdcard/Documents/Obsidian');
  const [dest, setDest] = useState('');
  const [adbPath, setAdbPath] = useState('');
  const [autoLaunch, setAutoLaunch] = useState(true);
  const [autoSyncOnConnect, setAutoSyncOnConnect] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      window.api.getSettings().then((currentSettings) => {
        setSource(currentSettings.source);
        setDest(currentSettings.dest);
        setAdbPath(currentSettings.adbPath);
        setAutoLaunch(currentSettings.autoLaunch ?? true);
        setAutoSyncOnConnect(currentSettings.autoSyncOnConnect ?? true);
      });
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const success = await window.api.saveSettings({ source, dest, adbPath, autoLaunch, autoSyncOnConnect });
      if (success) {
        onSave({ source, dest, adbPath, autoLaunch, autoSyncOnConnect });
        onClose();
      } else {
        alert('Failed to save settings');
      }
    } catch (err) {
      console.error(err);
      alert('Error saving settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Settings</h3>
          <button className="modal-close-btn" onClick={onClose}>&times;</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group">
              <label htmlFor="source-path">Android Vault Source Path</label>
              <input
                id="source-path"
                type="text"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="/sdcard/Documents/Obsidian"
                required
              />
              <span className="form-help">
                Usually located in internal storage (e.g., <code>/sdcard/Documents/Obsidian</code> or <code>/sdcard/Obsidian</code>).
              </span>
            </div>

            <div className="form-group">
              <label htmlFor="dest-path">macOS Destination Path</label>
              <input
                id="dest-path"
                type="text"
                value={dest}
                onChange={(e) => setDest(e.target.value)}
                placeholder="$HOME/Documents/Obsidian_Phone_Backup"
                required
              />
              <span className="form-help">
                Supports environment variables like <code>$HOME</code>.
              </span>
            </div>

            <div className="form-group">
              <label htmlFor="adb-path">Custom ADB Executable Path (Optional)</label>
              <input
                id="adb-path"
                type="text"
                value={adbPath}
                onChange={(e) => setAdbPath(e.target.value)}
                placeholder="Leave empty for automatic discovery"
              />
              <span className="form-help">
                Leave blank to automatically discover ADB (searches Homebrew, Android SDK, and system PATH).
              </span>
            </div>

            <div className="form-group-checkbox">
              <label className="checkbox-container">
                <input
                  type="checkbox"
                  checked={autoLaunch}
                  onChange={(e) => setAutoLaunch(e.target.checked)}
                />
                <span className="checkbox-label">Launch app automatically on Mac startup</span>
              </label>
              <span className="form-help">
                App starts hidden in the menu bar tray when your Mac boots.
              </span>
            </div>

            <div className="form-group-checkbox">
              <label className="checkbox-container">
                <input
                  type="checkbox"
                  checked={autoSyncOnConnect}
                  onChange={(e) => setAutoSyncOnConnect(e.target.checked)}
                />
                <span className="checkbox-label">Auto-sync vault when phone connects</span>
              </label>
              <span className="form-help">
                Automatically opens the window and triggers sync when Galaxy S23 Ultra is plugged in.
              </span>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
