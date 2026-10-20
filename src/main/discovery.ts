// LAN discovery: each PC broadcasts a small UDP "hello" every few seconds and listens for others.
import * as dgram from 'dgram';
import { EventEmitter } from 'events';
import * as os from 'os';

export const DISCOVERY_PORT = 47820;
const ANNOUNCE_MS = 3000;
const EXPIRE_MS = 10000;

export interface Announcement {
  app: 'lanshare';
  v: 1;
  id: string;
  name: string;
  port: number;
  platform: string;
  bye?: boolean;
}

export interface Peer {
  id: string;
  name: string;
  host: string;
  port: number;
  platform: string;
  lastSeen: number;
}

/** IPv4 addresses of this machine's LAN interfaces, with their broadcast addresses. */
export function lanInterfaces(): { address: string; broadcast: string }[] {
  const result: { address: string; broadcast: string }[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const addr = ni.address.split('.').map(Number);
      const mask = ni.netmask.split('.').map(Number);
      const broadcast = addr.map((a, i) => (a & mask[i]) | (~mask[i] & 255)).join('.');
      result.push({ address: ni.address, broadcast });
    }
  }
  return result;
}

export class Discovery extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  readonly peers = new Map<string, Peer>();

  /** `announce` returns our current hello, or null when we shouldn't be visible. */
  constructor(private ownId: string, private announce: () => Omit<Announcement, 'app' | 'v'> | null) {
    super();
  }

  start(): void {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (err) => console.error('Discovery socket error:', err));
    socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo.address));
    socket.bind(DISCOVERY_PORT, () => {
      socket.setBroadcast(true);
      this.sendHello();
    });
    this.socket = socket;
    this.timer = setInterval(() => {
      this.sendHello();
      this.prune();
    }, ANNOUNCE_MS);
  }

  stop(): void {
    this.sendHello(true);
    if (this.timer) clearInterval(this.timer);
    const socket = this.socket;
    this.socket = null;
    // Give the goodbye packet a moment to leave.
    setTimeout(() => socket?.close(), 100);
  }

  /** Re-announce right away, e.g. after the device name changes. */
  sendHello(bye = false): void {
    const hello = this.announce();
    if (!this.socket || !hello) return;
    const msg = Buffer.from(JSON.stringify({ app: 'lanshare', v: 1, ...hello, ...(bye ? { bye: true } : {}) }));
    const targets = new Set(['255.255.255.255', ...lanInterfaces().map((i) => i.broadcast)]);
    for (const target of targets) {
      this.socket.send(msg, DISCOVERY_PORT, target, () => {
        // Ignore send errors (e.g. an interface went down).
      });
    }
  }

  private onMessage(msg: Buffer, host: string): void {
    let a: Announcement;
    try {
      a = JSON.parse(msg.toString('utf8'));
    } catch {
      return;
    }
    if (a.app !== 'lanshare' || typeof a.id !== 'string' || a.id === this.ownId) return;
    if (a.bye) {
      if (this.peers.delete(a.id)) this.emit('change');
      return;
    }
    const prev = this.peers.get(a.id);
    const peer: Peer = {
      id: a.id,
      name: String(a.name).slice(0, 64),
      host,
      port: Number(a.port),
      platform: String(a.platform),
      lastSeen: Date.now(),
    };
    this.peers.set(a.id, peer);
    if (!prev || prev.name !== peer.name || prev.host !== peer.host || prev.port !== peer.port) this.emit('change');
  }

  private prune(): void {
    let changed = false;
    for (const [id, p] of this.peers) {
      if (Date.now() - p.lastSeen > EXPIRE_MS) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit('change');
  }
}
