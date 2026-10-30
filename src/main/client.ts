// Client side: talks to other PCs' file servers over HTTPS with pinned certificates.
import { EventEmitter } from 'events';
import * as https from 'https';
import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders } from 'http';
import type { TLSSocket } from 'tls';
import { decryptSecret, encryptSecret, getConfig, saveConfig } from './config';
import type { ConnectResult, ListResult, RemoteRoot } from '../shared/types';

export interface Target {
  id: string;
  name: string;
  host: string;
  port: number;
}

export class RemoteError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class IdentityError extends Error {
  constructor() {
    super(
      'Security warning: this PC is presenting a different identity than last time. ' +
        'If it was reinstalled, you can choose to trust it again.',
    );
  }
}

const CONNECT_TIMEOUT_MS = 10000;
const MAX_JSON_RESPONSE = 20 * 1024 * 1024;
// Idle pooled connections close after this, before the server's keep-alive timeout
// (server.ts KEEP_ALIVE_MS), so a request never goes out on a connection the server just closed.
const POOL_IDLE_MS = 15000;

// One pool of keep-alive connections per remote PC: many small files no longer each pay for a
// new TCP + TLS handshake. Only used for pinned requests.
const pools = new Map<string, { key: string; agent: https.Agent }>();
// Connections whose TLS handshake has finished (reused connections are already encrypted).
const handshaken = new WeakSet<TLSSocket>();

function poolFor(target: Target): https.Agent {
  const key = `${target.host}:${target.port}`;
  const current = pools.get(target.id);
  if (current?.key === key) return current.agent;
  current?.agent.destroy();
  const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 8,
    maxFreeSockets: 8,
    timeout: POOL_IDLE_MS,
    // The certificate is self-signed; its fingerprint is checked on every request below.
    rejectUnauthorized: false,
  });
  pools.set(target.id, { key, agent });
  return agent;
}

/** Closes pooled connections to a PC (on disconnect, or when its identity is forgotten). */
export function closeConnections(deviceId: string): void {
  pools.get(deviceId)?.agent.destroy();
  pools.delete(deviceId);
}

/**
 * Opens an HTTPS request and resolves once the TLS handshake is done and the server's
 * certificate matches the one we pinned for `target.id` (trust on first use). The check runs
 * for every request, also on reused connections, and nothing is sent before it, so passwords
 * never reach an impostor.
 */
export function openRequest(
  target: Target,
  method: string,
  urlPath: string,
  headers: OutgoingHttpHeaders = {},
  pin = true,
): Promise<ClientRequest> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: target.host,
      port: target.port,
      method,
      path: urlPath,
      headers,
      agent: pin ? poolFor(target) : false,
      rejectUnauthorized: false,
    });
    req.on('error', reject);
    // Socket idle timeouts don't cover the TCP connect phase, so use a plain timer for the handshake.
    const timer = setTimeout(() => {
      const err: NodeJS.ErrnoException = new Error('Timed out');
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    }, CONNECT_TIMEOUT_MS);
    req.on('close', () => clearTimeout(timer));
    const verify = (socket: TLSSocket) => {
      clearTimeout(timer);
      handshaken.add(socket);
      if (pin) {
        const fingerprint = socket.getPeerCertificate().fingerprint256;
        const known = getConfig().knownHosts[target.id];
        if (!known) {
          getConfig().knownHosts[target.id] = fingerprint;
          saveConfig();
        } else if (known !== fingerprint) {
          req.destroy(new IdentityError()); // Also closes the connection, so the pool never reuses it.
          return;
        }
      }
      resolve(req);
    };
    req.on('socket', (s) => {
      const socket = s as TLSSocket;
      if (handshaken.has(socket)) verify(socket); // Reused keep-alive connection.
      else socket.once('secureConnect', () => verify(socket));
    });
  });
}

export function waitResponse(req: ClientRequest, body?: Buffer): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    req.on('response', resolve);
    req.on('error', reject);
    req.end(body);
  });
}

export async function readJsonResponse(res: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > MAX_JSON_RESPONSE) throw new Error('Response too large');
    chunks.push(chunk);
  }
  let data: any = {};
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // Non-JSON error body.
  }
  if ((res.statusCode ?? 500) >= 400) throw new RemoteError(res.statusCode ?? 500, data.error ?? `Error ${res.statusCode}`);
  return data;
}

export function query(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

export class RemoteClient extends EventEmitter {
  private tokens = new Map<string, string>();
  readonly manualTargets = new Map<string, Target>();

  constructor(private resolveTarget: (deviceId: string) => Target | null) {
    super();
  }

  target(deviceId: string): Target {
    const t = this.resolveTarget(deviceId) ?? this.manualTargets.get(deviceId);
    if (!t) throw new Error('This PC is no longer on the network');
    return t;
  }

  isConnected(deviceId: string): boolean {
    return this.tokens.has(deviceId);
  }

  token(deviceId: string): string {
    const token = this.tokens.get(deviceId);
    if (!token) throw new RemoteError(401, 'Not connected');
    return token;
  }

  async request(deviceId: string, method: string, urlPath: string, body?: unknown, auth = true): Promise<any> {
    const target = this.target(deviceId);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers: OutgoingHttpHeaders = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    if (auth) headers.Authorization = `Bearer ${this.token(deviceId)}`;
    const req = await openRequest(target, method, urlPath, headers);
    try {
      return await readJsonResponse(await waitResponse(req, payload));
    } catch (err) {
      if (auth && err instanceof RemoteError && err.status === 401) this.dropSession(deviceId);
      throw err;
    }
  }

  dropSession(deviceId: string): void {
    closeConnections(deviceId);
    if (this.tokens.delete(deviceId)) this.emit('disconnected', deviceId);
  }

  /** Looks up a PC by address (for networks where broadcast discovery is blocked). */
  async probe(host: string, port: number): Promise<Target> {
    const probeTarget = { id: '', name: host, host, port };
    const req = await openRequest(probeTarget, 'GET', '/api/info', {}, false);
    const info = await readJsonResponse(await waitResponse(req));
    if (info.app !== 'lanshare' || typeof info.id !== 'string') throw new Error('That address is not running LAN Share');
    const target = { id: info.id, name: String(info.name), host, port };
    this.manualTargets.set(target.id, target);
    return target;
  }

  async connect(deviceId: string, credentials: { password?: string; rememberToken?: string }, remember: boolean): Promise<ConnectResult> {
    const cfg = getConfig();
    try {
      const res = await this.request(
        deviceId,
        'POST',
        '/api/auth',
        { ...credentials, remember, clientId: cfg.deviceId, clientName: cfg.deviceName },
        false,
      );
      this.tokens.set(deviceId, res.token);
      if (res.rememberToken) {
        cfg.savedLogins[deviceId] = encryptSecret(res.rememberToken);
        saveConfig();
      }
      return { ok: true };
    } catch (err) {
      if (err instanceof IdentityError) return { ok: false, identityChanged: true, error: err.message };
      return { ok: false, error: friendlyError(err) };
    }
  }

  async connectSaved(deviceId: string): Promise<ConnectResult> {
    const cfg = getConfig();
    const stored = cfg.savedLogins[deviceId];
    const rememberToken = stored ? decryptSecret(stored) : null;
    if (!rememberToken) return { ok: false, error: 'No saved login' };
    const result = await this.connect(deviceId, { rememberToken }, false);
    if (!result.ok && !result.identityChanged && /no longer valid/.test(result.error ?? '')) {
      delete cfg.savedLogins[deviceId];
      saveConfig();
    }
    return result;
  }

  async disconnect(deviceId: string): Promise<void> {
    try {
      await this.request(deviceId, 'POST', '/api/logout');
    } catch {
      // Already gone; we drop the session locally either way.
    }
    this.dropSession(deviceId);
  }

  forgetIdentity(deviceId: string): void {
    closeConnections(deviceId);
    const cfg = getConfig();
    delete cfg.knownHosts[deviceId];
    delete cfg.savedLogins[deviceId];
    saveConfig();
  }

  async roots(deviceId: string): Promise<RemoteRoot[]> {
    return (await this.request(deviceId, 'GET', '/api/roots')).roots;
  }

  async list(deviceId: string, root: string, path: string): Promise<ListResult> {
    return this.request(deviceId, 'GET', `/api/list?${query({ root, path })}`);
  }

  async mkdir(deviceId: string, root: string, path: string, name: string): Promise<string> {
    return (await this.request(deviceId, 'POST', `/api/mkdir?${query({ root, path, name })}`)).name;
  }
}

export function friendlyError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ECONNREFUSED') return 'That PC is not accepting connections (is LAN Share running there?)';
  if (code === 'ETIMEDOUT') {
    return (
      'That PC did not respond. Its firewall is probably blocking LAN Share: on Windows the network may be set to ' +
      '"Public"; on RudramOS the network must be Home and LAN Share must be allowed. ' +
      'Open LAN Share on that PC and follow its network warning.'
    );
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'That PC cannot be reached on this network';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'The connection was interrupted';
  return err instanceof Error ? err.message : String(err);
}
