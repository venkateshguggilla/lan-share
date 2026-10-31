// Electron entry point: wires the file server, discovery, client and transfers to the UI.
import { BrowserWindow, Menu, Notification, Tray, app, dialog, ipcMain, nativeImage, shell } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getConfig, loadConfig, saveConfig } from './config';
import { hashPassword } from './auth';
import { FileServer } from './server';
import { Discovery, lanInterfaces } from './discovery';
import { RemoteClient, friendlyError } from './client';
import { TransferManager } from './transfers';
import { listDir, listDrives } from './files';
import { PCOS_NETWORK, RUDRAMOS_SERVICE, isRudramOS, networkIssue } from './netprofile';
import { execFile } from 'child_process';
import * as QRCode from 'qrcode';
import type {
  AppInfo, ApprovalDecision, ApprovalRequest, Device, NetworkFix, NetworkIssue, PhoneLink, Settings, SettingsUpdate,
} from '../shared/types';

// LANSHARE_PROFILE lets you run a second copy on one PC for testing (separate settings).
const profile = process.env.LANSHARE_PROFILE;
if (profile) app.setPath('userData', path.join(app.getPath('appData'), `LAN Share (${profile})`));
else if (!app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let toldAboutTray = false;
const server = new FileServer();
let discovery: Discovery;
let client: RemoteClient;
let transfers: TransferManager;
let netIssue: NetworkIssue | null = null;
let networkChecked = false;

// Started by the sign-in entry: stay in the tray until the user opens LAN Share.
const startHidden = process.argv.includes('--hidden');
// Start-at-login points at the installed app; running from source would register electron.exe.
const canStartAtLogin = app.isPackaged && !profile;
const APPROVAL_TIMEOUT_MS = 60000;
const STATIC = path.join(__dirname, '..', '..', 'static');
const WEB_PREFERENCES = {
  preload: path.join(__dirname, '..', 'preload', 'preload.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
};

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
    runInBackground: cfg.runInBackground,
    startAtLogin: cfg.startAtLogin,
    canStartAtLogin,
    askBeforeConnect: cfg.askBeforeConnect,
    approvedDevices: cfg.approvedDevices,
  };
}

// ---------- Background: tray, start at sign-in ----------

function showWindow(): void {
  if (!win || win.isDestroyed()) createWindow(true);
  else {
    if (win.isMinimized()) win.restore();
    win.show();
  }
  win!.focus();
}

function quit(): void {
  quitting = true;
  app.quit();
}

function createTray(): void {
  const icon = nativeImage.createFromPath(path.join(STATIC, 'mobile', 'icon.png'));
  tray = new Tray(icon.resize({ width: process.platform === 'win32' ? 16 : 22 }));
  tray.on('click', showWindow);
  updateTray();
}

function updateTray(): void {
  if (!tray) return;
  const cfg = getConfig();
  const status = !cfg.allowConnections ? 'Sharing paused' : server.running ? 'Other devices can connect' : 'Not sharing';
  tray.setToolTip(`LAN Share: ${status}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open LAN Share', click: showWindow },
      { label: status, enabled: false },
      {
        label: 'Allow other devices to connect',
        type: 'checkbox',
        checked: cfg.allowConnections,
        click: (item) => setAllowConnections(item.checked).catch(() => {}),
      },
      { type: 'separator' },
      { label: 'Quit LAN Share', click: quit },
    ]),
  );
}

async function setAllowConnections(allow: boolean): Promise<void> {
  const cfg = getConfig();
  if (cfg.allowConnections && !allow) discovery.sendHello(true); // Say goodbye first.
  cfg.allowConnections = allow;
  saveConfig();
  await applyServerState();
}

/** Registers or removes LAN Share as a program that starts (hidden) when the user signs in. */
function applyStartAtLogin(): void {
  if (!canStartAtLogin) return;
  const enabled = getConfig().startAtLogin;
  try {
    if (process.platform === 'linux') {
      const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');
      const file = path.join(dir, 'lan-share.desktop');
      if (!enabled) return void fs.rmSync(file, { force: true });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        file,
        [
          '[Desktop Entry]',
          'Type=Application',
          'Name=LAN Share',
          'Comment=Lets other devices on your network find this PC',
          `Exec="${process.execPath}" --hidden`,
          'Icon=lan-share',
          'Terminal=false',
          'X-GNOME-Autostart-enabled=true',
          '',
        ].join('\n'),
      );
    } else {
      app.setLoginItemSettings({ openAtLogin: enabled, name: 'LAN Share', path: process.execPath, args: ['--hidden'] });
    }
  } catch (err) {
    console.error('Could not change start at sign-in:', err);
  }
}

/**
 * Applies the choices made in the Windows installer (install-options.json next to the app):
 * once per user, and again whenever the app is reinstalled.
 */
function applyInstallOptions(): void {
  if (!app.isPackaged || profile) return;
  const file = path.join(path.dirname(process.execPath), 'install-options.json');
  let stamp: string;
  try {
    stamp = String(fs.statSync(file).mtimeMs);
  } catch {
    return; // Not installed by the Windows installer (Linux, RudramOS, portable).
  }
  const cfg = getConfig();
  if (cfg.installOptionsApplied === stamp) return;
  try {
    const options = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof options.askBeforeConnect === 'boolean') cfg.askBeforeConnect = options.askBeforeConnect;
  } catch {
    // Unreadable file: keep the current settings.
  }
  cfg.installOptionsApplied = stamp;
  saveConfig();
}

// ---------- Accept / reject popup ----------

const prompts = new Map<string, { request: ApprovalRequest; finish: (d: ApprovalDecision | 'timeout') => void }>();

/** Shows a small always-on-top window asking whether a device may connect (even if LAN Share is in the tray). */
function askApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision | 'timeout'> {
  return new Promise((resolve) => {
    const popup = new BrowserWindow({
      width: 460,
      height: 270,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      show: false,
      title: 'LAN Share',
      autoHideMenuBar: true,
      backgroundColor: '#f5f6f8',
      webPreferences: WEB_PREFERENCES,
    });
    let done = false;
    const finish = (decision: ApprovalDecision | 'timeout') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      prompts.delete(request.id);
      if (!popup.isDestroyed()) popup.destroy();
      resolve(decision);
    };
    const timer = setTimeout(() => finish('timeout'), APPROVAL_TIMEOUT_MS);
    signal.addEventListener('abort', () => finish('timeout'), { once: true }); // The device gave up.
    prompts.set(request.id, { request, finish });
    popup.on('closed', () => finish('reject')); // Closing the popup counts as Reject.
    popup.webContents.on('will-navigate', (e) => e.preventDefault());
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    popup.once('ready-to-show', () => {
      popup.show();
      popup.focus();
      popup.flashFrame(true);
    });
    popup.loadFile(path.join(STATIC, 'approval.html'), { query: { id: request.id } });
  });
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
    networkIssue: netIssue,
  };
}

// Virtual adapters (WSL, Hyper-V, VPNs) whose addresses a phone on the Wi-Fi can't reach.
// Windows adapter names, then Linux interface names (virbr, veth, podman, tun, wg...).
const VIRTUAL_ADAPTER =
  /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Tailscale|ZeroTier|Hamachi|Bluetooth|Loopback|docker|VPN|^(lo|virbr|veth|br-|podman|cni|flannel|tun|tap|wg|zt)/i;
const WIFI_ADAPTER = /wi-?fi|wlan|wireless|^wl/i;

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
  const ranked = [...real.filter((a) => WIFI_ADAPTER.test(a.name)), ...real.filter((a) => !WIFI_ADAPTER.test(a.name))];
  const chosen = ranked.length ? ranked : all;
  return Promise.all(
    chosen.map(async (a) => {
      const url = `https://${a.address}:${server.port}/`;
      return { url, interfaceName: a.name, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 260 }) };
    }),
  );
}

/** Re-checks whether the network lets other devices in, and tells the UI when that changes. */
async function checkNetwork(): Promise<void> {
  const issue = await networkIssue();
  const firstCheck = !networkChecked;
  networkChecked = true;
  if (!firstCheck && JSON.stringify(issue) === JSON.stringify(netIssue)) return;
  const wasHidden = isRudramOS() && (firstCheck || netIssue !== null);
  netIssue = issue;
  send('info', info());
  if (wasHidden && !issue) discovery.sendHello(); // RudramOS: announce right away once reachable.
}

/** Runs pcos-network through pkexec, so RudramOS asks for admin approval like Control Center does. */
function pcosNetwork(args: string[]): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile('pkexec', [PCOS_NETWORK, ...args], { timeout: 5 * 60 * 1000 }, (err, _out, stderr) => {
      if (!err) return resolve({ ok: true });
      const code = (err as { code?: number | string }).code; // Exit code: 126 dismissed, 127 not authorized.
      if (code === 126 || code === 127) return resolve({ ok: false, error: 'Admin approval was cancelled or denied' });
      resolve({ ok: false, error: String(stderr).trim() || err.message });
    });
  });
}

async function fixNetwork(fix: NetworkFix): Promise<{ ok: boolean; error?: string }> {
  let result: { ok: boolean; error?: string } = { ok: true };
  if (fix === 'windows-settings') await shell.openExternal('ms-settings:network-status');
  else if (fix === 'rudramos-share') result = await pcosNetwork(['share', RUDRAMOS_SERVICE, 'on']);
  else if (fix === 'rudramos-trust') {
    const network = netIssue?.kind === 'public' ? netIssue.networks[0] : undefined;
    if (!network) return { ok: false, error: 'No Public network to change' };
    result = await pcosNetwork(['trust', network, 'home']);
  }
  await checkNetwork();
  return result;
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
  send('info', info());
  updateTray();
}

function createWindow(show: boolean): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    title: 'LAN Share',
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    show,
    webPreferences: WEB_PREFERENCES,
  });
  win.loadFile(path.join(STATIC, 'index.html'));
  // This app never navigates or opens external windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Closing the window keeps LAN Share running in the tray, so other devices can still find this PC.
  win.on('close', (e) => {
    if (quitting || !getConfig().runInBackground || !tray) return;
    e.preventDefault();
    win?.hide();
    if (!toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true;
      new Notification({
        title: 'LAN Share is still running',
        body: 'Other devices can still find this PC. Use the LAN Share icon in the taskbar tray to open or quit it.',
      }).show();
    }
  });
}

function registerIpc(): void {
  ipcMain.handle('getInfo', () => info());
  ipcMain.handle('phoneLinks', () => phoneLinks());
  ipcMain.handle('fixNetwork', (_e, fix: NetworkFix) => fixNetwork(fix));
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
    cfg.runInBackground = !!update.runInBackground;
    cfg.askBeforeConnect = !!update.askBeforeConnect;
    const loginChanged = cfg.startAtLogin !== !!update.startAtLogin;
    cfg.startAtLogin = !!update.startAtLogin;
    saveConfig();
    if (loginChanged) applyStartAtLogin();
    await applyServerState();
    return settings();
  });

  ipcMain.handle('forgetApprovedDevice', (_e, clientId: string) => {
    const cfg = getConfig();
    cfg.approvedDevices = cfg.approvedDevices.filter((d) => d.clientId !== clientId);
    saveConfig();
    return settings();
  });

  ipcMain.handle('approvalInfo', (_e, id: string) => prompts.get(id)?.request ?? null);
  ipcMain.handle('approvalRespond', (_e, id: string, decision: ApprovalDecision) => {
    if (decision === 'once' || decision === 'always' || decision === 'reject') prompts.get(id)?.finish(decision);
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
  applyInstallOptions();

  discovery = new Discovery(getConfig().deviceId, () => {
    const cfg = getConfig();
    if (!cfg.allowConnections || !server.port) return null;
    // RudramOS stealth mode: stay silent unless this network is Home and LAN Share is allowed on it.
    if (isRudramOS() && (!networkChecked || netIssue)) return null;
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
  server.approve = askApproval;

  registerIpc();
  createTray();
  // Started at sign-in: stay in the tray. Without a tray (rare Linux desktops) show the window.
  createWindow(!startHidden || !tray);
  applyStartAtLogin();
  checkNetwork();
  setInterval(checkNetwork, 10000);
  discovery.start();
  try {
    await applyServerState();
  } catch (err) {
    dialog.showErrorBox('LAN Share', `Could not start the file server: ${(err as Error).message}`);
  }
});

// Opening LAN Share again (Start menu, desktop icon) shows the window of the copy already running.
app.on('second-instance', () => {
  if (app.isReady()) showWindow();
});

app.on('before-quit', () => {
  quitting = true;
  discovery?.stop();
});
// Only reached when running in the background is off (otherwise the window just hides).
app.on('window-all-closed', () => quit());
