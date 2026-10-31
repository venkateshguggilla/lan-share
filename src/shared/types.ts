// Types shared between the main process, preload and renderer.

export interface SharedFolder {
  id: string;
  name: string;
  path: string;
  readOnly: boolean;
}

export interface Settings {
  deviceId: string;
  deviceName: string;
  hasPassword: boolean;
  allowConnections: boolean;
  sharedFolders: SharedFolder[];
  runInBackground: boolean;
  startAtLogin: boolean;
  // False when running from source (start-at-login only works for the installed app).
  canStartAtLogin: boolean;
  askBeforeConnect: boolean;
  approvedDevices: { clientId: string; clientName: string; approvedAt: number }[];
}

export interface SettingsUpdate {
  deviceName: string;
  allowConnections: boolean;
  sharedFolders: SharedFolder[];
  runInBackground: boolean;
  startAtLogin: boolean;
  askBeforeConnect: boolean;
}

/** A device that entered the right password and is waiting for this PC to accept it. */
export interface ApprovalRequest {
  id: string;
  clientName: string;
  ip: string;
  kind: 'pc' | 'phone';
}

export type ApprovalDecision = 'once' | 'always' | 'reject';

export interface AppInfo {
  deviceId: string;
  deviceName: string;
  addresses: string[];
  port: number | null;
  serverRunning: boolean;
  hasPassword: boolean;
  networkIssue: NetworkIssue | null;
}

export interface PhoneLink {
  url: string;
  interfaceName: string;
  qrDataUrl: string;
}

/** Why other devices can't reach this PC, if they can't. */
export interface NetworkIssue {
  os: 'windows' | 'rudramos';
  // public: the network is Public. sharing-off: RudramOS Home network, but LAN Share isn't allowed.
  kind: 'public' | 'sharing-off';
  networks: string[];
}

export type NetworkFix = 'windows-settings' | 'rudramos-trust' | 'rudramos-share';

export interface Device {
  id: string;
  name: string;
  host: string;
  port: number;
  platform: string;
  lastSeen: number;
  manual: boolean;
  connected: boolean;
  hasSavedLogin: boolean;
}

export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export interface RemoteRoot {
  id: string;
  name: string;
  readOnly: boolean;
}

export interface ListResult {
  entries: FileEntry[];
  readOnly?: boolean;
}

export type TransferStatus = 'queued' | 'active' | 'done' | 'error' | 'cancelled';

export interface Transfer {
  id: string;
  direction: 'download' | 'upload';
  name: string;
  deviceName: string;
  total: number;
  done: number;
  speed: number;
  status: TransferStatus;
  error?: string;
}

export interface IncomingSession {
  id: string;
  clientName: string;
  ip: string;
  since: number;
}

export interface ConnectResult {
  ok: boolean;
  error?: string;
  identityChanged?: boolean;
}

export interface RemoteItem {
  name: string;
  isDir: boolean;
}
