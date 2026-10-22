// Detects network settings that stop other devices from reaching LAN Share:
//  - Windows: a network set to "Public" (the installer's firewall rule only covers Private/Domain).
//  - RudramOS: every network is Public (all incoming traffic dropped) until an admin marks it as
//    Home, and even then LAN Share must be allowed with `pcos-network share lan-share on`.
import { execFile } from 'child_process';
import * as fs from 'fs';
import type { NetworkIssue } from '../shared/types';

const CATEGORY_PUBLIC = 0; // Windows NetworkCategory enum: 0 Public, 1 Private, 2 DomainAuthenticated.
export const PCOS_NETWORK = '/usr/bin/pcos-network';
export const RUDRAMOS_SERVICE = 'lan-share'; // Name used by `pcos-network share`.

export const isRudramOS = (): boolean => process.platform === 'linux' && fs.existsSync(PCOS_NETWORK);

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

export async function networkIssue(): Promise<NetworkIssue | null> {
  if (process.platform === 'win32') return windowsIssue();
  if (isRudramOS()) return rudramosIssue();
  return null;
}

async function windowsIssue(): Promise<NetworkIssue | null> {
  const script =
    'Get-NetConnectionProfile | Select-Object Name, @{n="Category";e={[int]$_.NetworkCategory}} | ConvertTo-Json -Compress';
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (!out?.trim()) return null;
  try {
    const parsed = JSON.parse(out);
    const list: { Name: string; Category: number }[] = Array.isArray(parsed) ? parsed : [parsed];
    const names = list.filter((p) => p.Category === CATEGORY_PUBLIC).map((p) => String(p.Name));
    return names.length ? { os: 'windows', kind: 'public', networks: names } : null;
  } catch {
    return null;
  }
}

async function rudramosIssue(): Promise<NetworkIssue | null> {
  const out = await run(PCOS_NETWORK, ['status']);
  return out === null ? null : parseRudramOSStatus(out);
}

/**
 * Parses `pcos-network status`:
 *   Networks now:
 *     Home Wi-Fi (wlp2s0): Home (trusted)
 *     Cafe (wlp3s0): Public
 *   Sharing on Home networks:
 *     lan-share: on
 */
export function parseRudramOSStatus(out: string): NetworkIssue | null {
  const home: string[] = [];
  const pub: string[] = [];
  let sharing = false;
  let section = '';
  for (const line of out.split(/\r?\n/)) {
    if (/^Networks now:/.test(line)) section = 'networks';
    else if (/^Sharing on Home networks:/.test(line)) section = 'sharing';
    else if (section === 'networks') {
      const m = /^\s+(.*) \(([^()]+)\): (Public|Home \(trusted\))\s*$/.exec(line);
      if (m) (m[3] === 'Public' ? pub : home).push(m[1]);
    } else if (section === 'sharing' && new RegExp(`^\\s+${RUDRAMOS_SERVICE}: on\\s*$`).test(line)) {
      sharing = true;
    }
  }
  if (home.length) return sharing ? null : { os: 'rudramos', kind: 'sharing-off', networks: home };
  if (pub.length) return { os: 'rudramos', kind: 'public', networks: pub };
  return null;
}
