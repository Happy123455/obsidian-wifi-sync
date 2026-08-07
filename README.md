# ⚡ Obsidian Wi-Fi & Live Sync

An ultra-fast, local, private, non-destructive synchronization plugin and companion Desktop application for **Obsidian** (Mac & Android / Mobile). Features **100ms real-time Live Typing Streaming**, **Mobile Data Priority**, **Zero Auto-Deletions**, and **Offline QR Code Sync**.

---

## ✨ Key Features

### ⚡ 100ms Live Mode Streaming
- **Real-Time Keystroke & Cursor Replication**: Whatever you type on your phone or Mac streams live to the other device character-by-character.
- **Physical Keyboard Lock**: Remote cursor only updates when active physical typing occurs on a keyboard—no unwanted cursor jumping or resetting.
- **Synchronized Mode Switching**: Toggle between **⚡ Live Mode** and **⚪ Standard Mode** using the status bar button or ribbon icon—both devices shift mode simultaneously across Wi-Fi.

### 🛡️ Mobile Data Priority & Zero Auto-Deletions
- **Mobile First**: Your mobile notes are treated as the primary source of truth and will never be overwritten by stale or blank data.
- **Safe Non-Destructive Sync**: Disables automatic background file deletions. Files are never removed automatically during sync.
- **Empty Payload Protection**: Zero-byte network streams are guarded to prevent file truncation.

### 🔍 Obsidian Search Panel
- Mini calendar filter widget (shows file modification heatmaps by date).
- Live search bar across notes, canvas files, text, and JSON snippet highlights.

### 📱 Multiple Sync Modes
1. **Wi-Fi Live Streaming**: Instant bidirectional socket/HTTP sync over local Wi-Fi.
2. **USB Sync**: High-speed ADB file sync over USB cable for initial bulk syncing.
3. **Offline QR Code Sync**: Sync notes between devices using camera QR code carousels without network or internet access.

---

## 🚀 Quick Setup Guide

### 1. Installation on Mac
1. Clone this repository:
   ```bash
   git clone https://github.com/Happy123455/obsidian-wifi-sync.git
   cd obsidian-wifi-sync
   ```
2. Install dependencies and build:
   ```bash
   npm install
   npm run package
   ```
3. Copy the plugin to your Mac Obsidian Vault:
   ```bash
   mkdir -p "~/Desktop/ultimate daily/Daily/.obsidian/plugins/obsidian-wifi-sync"
   cp obsidian-plugin/main.js obsidian-plugin/manifest.json "~/Desktop/ultimate daily/Daily/.obsidian/plugins/obsidian-wifi-sync/"
   ```

### 2. Installation on Android (S23 Ultra / Mobile)
- Connect your phone via USB with USB Debugging enabled, then push the plugin directly:
  ```bash
  adb push obsidian-plugin/main.js /sdcard/Daily/Daily/.obsidian/plugins/obsidian-wifi-sync/main.js
  adb push obsidian-plugin/manifest.json /sdcard/Daily/Daily/.obsidian/plugins/obsidian-wifi-sync/manifest.json
  ```
- In Obsidian Mobile: Go to **Settings → Community Plugins → Enable "Obsidian Wi-Fi Sync"**.

---

## 🎮 How to Use Live Mode

1. **Toggle Live Mode**:
   - Click **`⚡ Live Mode`** in the status bar (bottom right) or click the **`⚡` Ribbon Icon** on either Mac or Mobile.
   - Both devices will instantly shift to **Live Mode**.
2. **Type Seamlessly**:
   - Start typing on your phone or Mac—the note will open automatically on the remote device, and text/cursor will follow live in real-time!

---

## 🔒 Privacy & Security

- **100% Local**: No third-party cloud servers or external telemetry. All communication happens strictly over your local Wi-Fi or USB connection.
- **Basic Auth Secured**: Local server requests are authenticated via Basic Auth tokens over your private network.

---

## 📜 License

MIT License. Designed and crafted for private personal vault synchronization.
