// Detects Windows networks set to "Public", where the firewall blocks incoming LAN Share connections.
import { execFile } from 'child_process';
import type { PublicNetwork } from '../shared/types';

const CATEGORY_PUBLIC = 0; // NetworkCategory enum: 0 Public, 1 Private, 2 DomainAuthenticated.

export function publicNetworks(): Promise<PublicNetwork[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const script =
    'Get-NetConnectionProfile | Select-Object Name, InterfaceAlias, @{n="Category";e={[int]$_.NetworkCategory}} | ConvertTo-Json -Compress';
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15000 },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve([]);
        try {
          const parsed = JSON.parse(stdout);
          const list: { Name: string; InterfaceAlias: string; Category: number }[] = Array.isArray(parsed) ? parsed : [parsed];
          resolve(
            list
              .filter((p) => p.Category === CATEGORY_PUBLIC)
              .map((p) => ({ name: String(p.Name), interfaceAlias: String(p.InterfaceAlias) })),
          );
        } catch {
          resolve([]);
        }
      },
    );
  });
}
