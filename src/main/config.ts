// Persistent app configuration, stored as JSON in the user's app-data folder.
import { app, safeStorage } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SharedFolder } from '../shared/types';

export interface RememberedClient {
  tokenHash: string;
  clientId: string;
  clientName: string;
  created: number;
}

export interface StoredConfig {
  deviceId: string;
  deviceName: string;
  passwordHash?: string;
  passwordSalt?: string;
  allowConnections: boolean;
  sharedFolders: SharedFolder[];
  tls?: { key: string; cert: string };
  // Server side: long-lived "remember me" tokens issued to other PCs (hashed).
  rememberedClients: RememberedClient[];
  // Client side: TLS certificate fingerprints of PCs we've connected to (trust on first use).
  knownHosts: Record<string, string>;
  // Client side: remember-me tokens for other PCs, encrypted with Windows DPAPI via safeStorage.
  savedLogins: Record<string, string>;
}

let configPath = '';
let config: StoredConfig;

function defaults(): StoredConfig {
  return {
    deviceId: crypto.randomUUID(),
    deviceName: os.hostname(),
    allowConnections: true,
    sharedFolders: [],
    rememberedClients: [],
    knownHosts: {},
    savedLogins: {},
  };
}

export function loadConfig(): StoredConfig {
  configPath = path.join(app.getPath('userData'), 'config.json');
  let loaded: Partial<StoredConfig> = {};
  try {
    loaded = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // First run or unreadable file: start from defaults.
  }
  config = { ...defaults(), ...loaded };
  saveConfig();
  return config;
}

export function getConfig(): StoredConfig {
  return config;
}

export function saveConfig(): void {
  const tmp = configPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, configPath);
}

export function encryptSecret(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(value).toString('base64');
  }
  return 'raw:' + value;
}

export function decryptSecret(stored: string): string | null {
  try {
    if (stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    }
    if (stored.startsWith('raw:')) return stored.slice(4);
  } catch {
    // Fall through: the secret can't be decrypted (e.g. profile moved to another machine).
  }
  return null;
}
