// The API exposed to the renderer by the preload script (window.api).
import type {
  AppInfo, ConnectResult, PhoneLink, Device, IncomingSession, ListResult, RemoteItem,
  RemoteRoot, Settings, SettingsUpdate, Transfer,
} from './types';

export interface Api {
  getInfo(): Promise<AppInfo>;
  openNetworkSettings(): Promise<void>;
  phoneLinks(): Promise<PhoneLink[]>;

  getSettings(): Promise<Settings>;
  saveSettings(update: SettingsUpdate): Promise<Settings>;
  setPassword(password: string): Promise<{ ok: boolean; error?: string }>;
  pickFolder(): Promise<string | null>;

  listSessions(): Promise<IncomingSession[]>;
  revokeSession(id: string): Promise<void>;

  listDevices(): Promise<Device[]>;
  addManualDevice(host: string, port: number): Promise<{ ok: boolean; error?: string }>;

  connect(deviceId: string, password: string, remember: boolean): Promise<ConnectResult>;
  connectSaved(deviceId: string): Promise<ConnectResult>;
  disconnect(deviceId: string): Promise<void>;
  forgetIdentity(deviceId: string): Promise<void>;
  remoteRoots(deviceId: string): Promise<RemoteRoot[]>;
  remoteList(deviceId: string, root: string, path: string): Promise<ListResult>;

  localList(path: string): Promise<ListResult>;
  localHome(): Promise<string>;
  openLocal(path: string): Promise<void>;
  pathForFile(file: File): string;

  download(deviceId: string, root: string, remoteDir: string, items: RemoteItem[], localDir: string): Promise<void>;
  upload(deviceId: string, root: string, remoteDir: string, localPaths: string[]): Promise<void>;
  cancelTransfer(id: string): Promise<void>;
  clearTransfers(): Promise<void>;

  onInfo(cb: (info: AppInfo) => void): void;
  onDevices(cb: (devices: Device[]) => void): void;
  onTransfers(cb: (transfers: Transfer[]) => void): void;
  onSessions(cb: (sessions: IncomingSession[]) => void): void;
  onDisconnected(cb: (deviceId: string) => void): void;
}
