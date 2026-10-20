// Electron entry point: wires the file server, discovery, client and transfers to the UI.
import { BrowserWindow, Notification, app, dialog, ipcMain, shell } from 'electron';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { getConfig, loadConfig, saveConfig } from './config';
import { hashPassword } from './auth';
import { FileServer } from './server';
import { Discovery, lanInterfaces } from './discovery';
import { RemoteClient, friendlyError } from './client';
import { TransferManager } from './transfers';
import { listDir, listDrives } from './files';
import { publicNetworks } from './netprofile';
import * as QRCode from 'qrcode';
import type { AppInfo, Device, PhoneLink, PublicNetwork, Settings, SettingsUpdate } from '../shared/types';

// LANSHARE_PROFILE lets you run a second copy on one PC for testing (separate settings).
const profile = process.env.LANSHARE_PROFILE;
if (profile) app.setPath('userData', path.join(app.getPath('appData'), `LAN Share (${profile})`));
else if (!app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;
const server = new FileServer();
let discovery: Discovery;
let client: RemoteClient;
let transfers: TransferManager;
let publicNets: PublicNetwork[] = [];

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function settings(): Settings {
  const cfg = getConfig();
  return {
    deviceId: cfg.deviceId,
    deviceName: cfg.deviceName,
    hasPassword: !!cfg.passwordHash,
    allowConnections: cfg.allowConnections,
    sharedFolders: cfg.sharedFolders,
  };
}

function info(): AppInfo {
  const cfg = getConfig();
  return {
    deviceId: cfg.deviceId,
    deviceName: cfg.deviceName,
    addresses: lanInterfaces().map((i) => i.address),
    port: server.port,
    serverRunning: server.running,
    hasPassword: !!cfg.passwordHash,
    publicNetworks: publicNets,
  };
}

// Virtual adapters (WSL, Hyper-V, VPNs) whose addresses a phone on the Wi-Fi can't reach.
const VIRTUAL_ADAPTER = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Tailscale|ZeroTier|Hamachi|Bluetooth|Loopback|docker|VPN/i;

/** Addresses a phone on the same network can open, best first, each with a QR code. */
async function phoneLinks(): Promise<PhoneLink[]> {
  if (!server.port) return [];
  const all: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal && !ni.address.startsWith('169.254.')) all.push({ name, address: ni.address });
    }
  }
  const real = all.filter((a) => !VIRTUAL_ADAPTER.test(a.name));
  const ranked = [...real.filter((a) => /wi-?fi|wlan|wireless/i.test(a.name)), ...real.filter((a) => !/wi-?fi|wlan|wireless/i.test(a.name))];
  const chosen = ranked.length ? ranked : all;
  return Promise.all(
    chosen.map(async (a) => {
      const url = `https://${a.address}:${server.port}/`;
      return { url, interfaceName: a.name, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 260 }) };
    }),
  );
}

/** Re-checks whether any network is set to Public and tells the UI when that changes. */
async function checkNetworkProfiles(): Promise<void> {
  const nets = await publicNetworks();
  if (JSON.stringify(nets) === JSON.stringify(publicNets)) return;
  publicNets = nets;
  send('info', info());
}

function devices(): Device[] {
  const cfg = getConfig();
  const byId = new Map<string, Device>();
  const add = (d: { id: string; name: string; host: string; port: number; platform?: string; lastSeen?: number }, manual: boolean) =>
    byId.set(d.id, {
      id: d.id,
      name: d.name,
      host: d.host,
      port: d.port,
      platform: d.platform ?? '',
      lastSeen: d.lastSeen ?? Date.now(),
      manual,
      connected: client.isConnected(d.id),
      hasSavedLogin: !!cfg.savedLogins[d.id],
    });
  for (const t of client.manualTargets.values()) add(t, true);
  for (const p of discovery.peers.values()) add(p, false);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function applyServerState(): Promise<void> {
  const cfg = getConfig();
  if (cfg.allowConnections && !server.running) await server.start();
  if (!cfg.allowConnections && server.running) server.stop();
  discovery.sendHello();
  send('sessions', server.sessions.list());
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    title: 'LAN Share',
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', '..', 'static', 'index.html'));
  // This app never navigates or opens external windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function registerIpc(): void {
  ipcMain.handle('getInfo', () => info());
  ipcMain.handle('phoneLinks', () => phoneLinks());
  ipcMain.handle('openNetworkSettings', () => shell.openExternal('ms-settings:network-status'));
  ipcMain.handle('getSettings', () => settings());

  ipcMain.handle('saveSettings', async (_e, update: SettingsUpdate) => {
    const cfg = getConfig();
    const name = String(update.deviceName).trim().slice(0, 64);
    if (name) cfg.deviceName = name;
    if (cfg.allowConnections && !update.allowConnections) discovery.sendHello(true); // Say goodbye first.
    cfg.allowConnections = !!update.allowConnections;
    cfg.sharedFolders = update.sharedFolders.map((f) => ({
      id: f.id || crypto.randomUUID(),
      name: String(f.name || path.basename(f.path) || f.path).slice(0, 64),
      path: f.path,
      readOnly: !!f.readOnly,
    }));
    saveConfig();
    await applyServerState();
    return settings();
  });

  ipcMain.handle('setPassword', (_e, password: string) => {
    if (typeof password !== 'string' || password.length < 6) {
      return { ok: false, error: 'Password must be at least 6 characters' };
    }
    const cfg = getConfig();
    const { hash, salt } = hashPassword(password);
    cfg.passwordHash = hash;
    cfg.passwordSalt = salt;
    saveConfig();
    server.revokeEverything();
    return { ok: true };
  });

  ipcMain.handle('pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: 'Choose a folder to share' });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('listSessions', () => server.sessions.list());
  ipcMain.handle('revokeSession', (_e, id: string) => server.revokeSession(id));

  ipcMain.handle('listDevices', () => devices());
  ipcMain.handle('addManualDevice', async (_e, host: string, port: number) => {
    try {
      await client.probe(host.trim(), port);
      send('devices', devices());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  });

  ipcMain.handle('connect', async (_e, id: string, password: string, remember: boolean) => {
    const r = await client.connect(id, { password }, remember);
    send('devices', devices());
    return r;
  });
  ipcMain.handle('connectSaved', async (_e, id: string) => {
    const r = await client.connectSaved(id);
    send('devices', devices());
    return r;
  });
  ipcMain.handle('disconnect', async (_e, id: string) => {
    await client.disconnect(id);
    send('devices', devices());
  });
  ipcMain.handle('forgetIdentity', (_e, id: string) => {
    client.forgetIdentity(id);
    send('devices', devices());
  });
  ipcMain.handle('remoteRoots', (_e, id: string) => client.roots(id));
  ipcMain.handle('remoteList', (_e, id: string, root: string, p: string) => client.list(id, root, p));

  ipcMain.handle('localList', async (_e, p: string) => ({ entries: p ? await listDir(p) : listDrives() }));
  ipcMain.handle('localHome', () => os.homedir());
  ipcMain.handle('openLocal', (_e, p: string) => shell.openPath(p));

  ipcMain.handle('download', (_e, id, root, remoteDir, items, localDir) =>
    transfers.download(id, root, remoteDir, items, localDir || app.getPath('downloads')),
  );
  ipcMain.handle('upload', (_e, id, root, remoteDir, localPaths) => transfers.upload(id, root, remoteDir, localPaths));
  ipcMain.handle('cancelTransfer', (_e, id: string) => transfers.cancel(id));
  ipcMain.handle('clearTransfers', () => transfers.clearFinished());
}

app.whenReady().then(async () => {
  loadConfig();

  discovery = new Discovery(getConfig().deviceId, () => {
    const cfg = getConfig();
    if (!cfg.allowConnections || !server.port) return null;
    return { id: cfg.deviceId, name: cfg.deviceName, port: server.port, platform: process.platform };
  });
  client = new RemoteClient((id) => {
    const p = discovery.peers.get(id);
    return p ? { id: p.id, name: p.name, host: p.host, port: p.port } : null;
  });
  transfers = new TransferManager(client);

  discovery.on('change', () => send('devices', devices()));
  client.on('disconnected', (id) => {
    send('disconnected', id);
    send('devices', devices());
  });
  transfers.on('change', (list) => send('transfers', list));
  server.on('sessions', () => send('sessions', server.sessions.list()));
  server.on('connected', (name: string, ip: string) => {
    if (Notification.isSupported()) {
      new Notification({ title: 'LAN Share', body: `${name} (${ip}) connected to this PC` }).show();
    }
  });

  registerIpc();
  createWindow();
  checkNetworkProfiles();
  setInterval(checkNetworkProfiles, 10000);
  discovery.start();
  try {
    await applyServerState();
  } catch (err) {
    dialog.showErrorBox('LAN Share', `Could not start the file server: ${(err as Error).message}`);
  }
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('before-quit', () => discovery?.stop());
app.on('window-all-closed', () => app.quit());
