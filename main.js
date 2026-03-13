const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const http = require('http');
const WebSocket = require('ws');

// ── Fixed install paths ────────────────────────────────────
const DATA_DIR  = 'C:\\FSE-Cast\\Control';
const LOG_DIR   = path.join(DATA_DIR, 'Logs');
const DATA_FILE = path.join(DATA_DIR, 'fse-cast-control-data.json');

function ensureDirs() {
  [DATA_DIR, LOG_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
}

let mainWindow;
let wss = null, httpServer = null;
const players = new Map(); // id -> player object

// ── Storage ───────────────────────────────────────────────
function loadStorage() {
  ensureDirs();
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) {}
  return { playlists: [], schedules: [], settings: { port: 9900 } };
}
function saveStorage(data) {
  ensureDirs();
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8'); } catch(e) {}
}

// ── Per-day POPlog ────────────────────────────────────────
function getLogPath(screenName) {
  ensureDirs();
  const safe = (screenName || 'control').replace(/[^a-z0-9]/gi, '-');
  return path.join(LOG_DIR, `pop-${safe}-${new Date().toISOString().slice(0, 10)}.csv`);
}
function appendLog(entry, screenName) {
  const logPath = getLogPath(screenName);
  const header = 'Screen,Timestamp,File,Type,Playlist,Duration(s),Resolution,Trigger,Result\n';
  const row = [screenName || 'control', entry.ts, entry.file, entry.type, entry.playlist,
    entry.duration, entry.resolution, entry.trigger, entry.result]
    .map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',') + '\n';
  if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, header, 'utf8');
  fs.appendFileSync(logPath, row, 'utf8');
}

// ── Player helpers ────────────────────────────────────────
function getPlayerInfo(id) {
  const p = players.get(id);
  if (!p) return null;
  return {
    id, name: p.name, connected: p.connected,
    nowPlaying: p.nowPlaying, playlistName: p.playlistName,
    playing: p.playing, timecode: p.timecode, duration: p.duration,
    uptime: p.uptime, anchorMode: p.anchorMode,
    resolution: p.resolution, overlayCount: p.overlayCount,
    files: p.files, lastSeen: p.lastSeen
  };
}

// Find existing player slot by name — prevents ghost cards on reconnect
function findSlotByName(name) {
  for (const [id, p] of players) {
    if (p.name === name) return id;
  }
  return null;
}

// Remove players that have been disconnected for more than 60 seconds
// and have never successfully registered a name
function pruneGhosts() {
  const cutoff60 = Date.now() - 60000;
  const cutoff10 = Date.now() - 10000;
  for (const [id, p] of players) {
    // Remove disconnected unknowns after 60s
    if (!p.connected && p.lastSeen < cutoff60 && p.name === 'Unknown') {
      players.delete(id); continue;
    }
    // Remove connected unknowns that never registered within 10s — stale TCP
    if (p.connected && p.name === 'Unknown' && p.lastSeen < cutoff10) {
      try { p.ws.terminate(); } catch(e) {}
      players.delete(id); continue;
    }
  }
  mainWindow?.webContents.send('players-pruned');
}

// ── WebSocket Server ──────────────────────────────────────
function startServer(port) {
  if (wss) { wss.close(); wss = null; }
  if (httpServer) { httpServer.close(); httpServer = null; }
  httpServer = http.createServer();
  wss = new WebSocket.Server({ server: httpServer });

  // Prune ghost connections every 30 seconds
  const pruneInterval = setInterval(pruneGhosts, 10000); // every 10s to kill stale unknowns quickly
  wss.on('close', () => clearInterval(pruneInterval));

  wss.on('connection', sock => {
    // Temporary socket-level id — replaced by name-keyed id on register
    const socketId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    let playerId = socketId; // will be reassigned on register if name matches

    // Placeholder entry for this socket — stays 'Unknown' until register arrives
    players.set(playerId, {
      ws: sock, name: 'Unknown', id: playerId, connected: true,
      nowPlaying: null, playing: false, timecode: 0, duration: 0,
      uptime: 0, anchorMode: 'contain', resolution: '1920×1080',
      overlayCount: 0, files: [], lastSeen: Date.now()
    });

    sock.send(JSON.stringify({ type: 'welcome', id: playerId }));

    sock.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());
        players.get(playerId) && (players.get(playerId).lastSeen = Date.now());

        if (msg.type === 'register') {
          const name = msg.name || 'Screen';

          // Check if a player with this name already exists (reconnect scenario)
          const existingId = findSlotByName(name);
          if (existingId && existingId !== playerId) {
            // Reuse the existing slot — drop the temp placeholder
            players.delete(playerId);
            playerId = existingId;
          }

          const p = players.get(playerId);
          if (!p) {
            // Shouldn't happen, but guard against it
            players.set(playerId, {
              ws: sock, name, id: playerId, connected: true,
              nowPlaying: null, playing: false, timecode: 0, duration: 0,
              uptime: 0, anchorMode: msg.anchorMode || 'contain', resolution: '1920×1080',
              overlayCount: 0, files: [], lastSeen: Date.now(), mediaRoot: msg.mediaRoot || ''
            });
          } else {
            // Update the existing slot with fresh connection
            p.ws         = sock;
            p.id         = playerId;
            p.name       = name;
            p.connected  = true;
            p.anchorMode = msg.anchorMode || p.anchorMode;
            p.mediaRoot  = msg.mediaRoot  || p.mediaRoot || '';
            p.lastSeen   = Date.now();
          }

          mainWindow?.webContents.send('player-update', getPlayerInfo(playerId));
          mainWindow?.webContents.send('player-connected', { id: playerId, name });
        }

        if (msg.type === 'heartbeat') {
          const p = players.get(playerId);
          if (p) {
            p.nowPlaying   = msg.nowPlaying;
            p.playlistName = msg.playlistName;
            p.timecode     = msg.timecode;
            p.duration     = msg.duration;
            p.playing      = msg.playing;
            p.uptime       = msg.uptime;
            p.resolution   = msg.resolution;
            p.anchorMode   = msg.anchorMode || p.anchorMode;
            p.overlayCount = msg.overlayCount || 0;
            mainWindow?.webContents.send('player-heartbeat', { id: playerId, ...msg });
          }
        }

        if (msg.type === 'file-list') {
          const p = players.get(playerId);
          if (p) {
            p.files = msg.files || [];
            mainWindow?.webContents.send('player-files', { id: playerId, name: p.name, files: p.files });
          }
        }

        if (msg.type === 'pop') {
          const p = players.get(playerId);
          if (p) {
            appendLog(msg.entry, p.name);
            mainWindow?.webContents.send('pop-entry', { screenName: p.name, entry: msg.entry });
          }
        }

        if (msg.type === 'error') {
          const p = players.get(playerId);
          if (p) mainWindow?.webContents.send('player-error', { id: playerId, name: p.name, message: msg.message, ts: msg.ts });
        }

        if (msg.type === 'loopback-result') {
          const p = players.get(playerId);
          if (p) mainWindow?.webContents.send('player-loopback', { id: playerId, name: p.name, filename: msg.filename, status: msg.status, ts: msg.ts });
        }

        if (msg.type === 'log-collection') {
          const p = players.get(playerId);
          if (p) mainWindow?.webContents.send('player-log-collection', { id: playerId, name: p.name, logDir: msg.logDir, ts: msg.ts });
        }

      } catch(e) {}
    });

    sock.on('close', () => {
      const p = players.get(playerId);
      if (p) {
        p.connected = false;
        p.lastSeen  = Date.now();
        mainWindow?.webContents.send('player-disconnected', { id: playerId, name: p.name });
      }
    });

    sock.on('error', () => {});
    // Don't fire player-update here — wait for register message
    // so Unknown placeholder entries never reach the renderer
  });

  httpServer.listen(port, '0.0.0.0', () => {
    mainWindow?.webContents.send('server-status', { state: 'listening', port });
  });
  httpServer.on('error', err => {
    mainWindow?.webContents.send('server-status', { state: 'error', message: err.message });
  });
}

function stopServer() {
  if (wss) { wss.close(); wss = null; }
  if (httpServer) { httpServer.close(); httpServer = null; }
  players.clear();
}

function sendToPlayer(id, payload) {
  const p = players.get(id);
  if (p && p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(payload));
}
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  players.forEach(p => { if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(msg); });
}

// ── IPC ───────────────────────────────────────────────────
ipcMain.handle('storage-load',    ()             => loadStorage());
ipcMain.handle('storage-save',    (e, data)      => { saveStorage(data); return true; });
ipcMain.handle('get-players',     ()             => [...players.values()].map(p => getPlayerInfo(p.id)));
ipcMain.handle('start-server',    (e, port)      => { startServer(port); return true; });
ipcMain.handle('stop-server',     ()             => { stopServer(); return true; });
ipcMain.on('send-to-player',      (e, {id, payload}) => sendToPlayer(id, payload));
ipcMain.on('broadcast',           (e, payload)   => broadcast(payload));
ipcMain.handle('export-log-csv',  async (e, csv) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Log',
    defaultPath: path.join(LOG_DIR, `pop-export-${new Date().toISOString().slice(0, 10)}.csv`),
    filters: [{ name: 'CSV Files', extensions: ['csv'] }]
  });
  if (filePath) { fs.writeFileSync(filePath, csv, 'utf8'); return true; }
  return false;
});
ipcMain.handle('open-data-folder', () => shell.openPath(DATA_DIR));

// ── Window ────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1100, minHeight: 700,
    title: 'FSE-Cast // Control',
    backgroundColor: '#0a0c0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: false
    }
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => { stopServer(); mainWindow = null; });
}

Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: 'FSE-Cast // Control', submenu: [
    { label: 'Open Data Folder  (C:\\FSE-Cast\\Control)', click: () => shell.openPath(DATA_DIR) },
    { label: 'Open Logs Folder  (C:\\FSE-Cast\\Control\\Logs)', click: () => shell.openPath(LOG_DIR) },
    { type: 'separator' },
    { role: 'quit', label: 'Quit FSE-Cast // Control' }
  ]},
  { label: 'View', submenu: [
    { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
    { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'toggleDevTools' }
  ]}
]));

app.whenReady().then(() => {
  ensureDirs();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
