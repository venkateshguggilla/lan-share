// HTTPS file server: lets authenticated PCs browse shared folders, download and upload files.
import { app } from 'electron';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as https from 'https';
import type { IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { generate } from 'selfsigned';
import { getConfig, saveConfig } from './config';
import { Lockout, SessionStore, randomToken, sha256, verifyPassword } from './auth';
import { isValidName, listDir, resolveInside, uniquePath } from './files';
import type { ApprovalDecision, ApprovalRequest } from '../shared/types';

export const DEFAULT_PORT = 47821;
const MAX_JSON_BODY = 64 * 1024;
const CHUNK = 1024 * 1024; // File read/write size; Node's 64 KB default caps throughput.
const TICKET_MS = 5 * 60 * 1000;
// A connection that sends or receives nothing for this long is closed. There is no limit on a whole
// request: Node's default (5 minutes) cut off big uploads partway through.
const IDLE_TIMEOUT_MS = 60000;
// Clients keep connections open between requests (keep-alive) and close idle ones after 15 s
// (client.ts POOL_IDLE_MS); the server waits longer, so it never closes one a client is reusing.
const KEEP_ALIVE_MS = 30000;

// The phone web page (static/mobile), served to browsers that open https://<this-pc>:<port>/.
const MOBILE_DIR = path.join(__dirname, '..', '..', 'static', 'mobile');
const MOBILE_FILES: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/m/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/m/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/m/icon.png': ['icon.png', 'image/png'],
};
const PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** A short-lived link that lets a browser download one file without sending the session token in a header. */
interface Ticket {
  token: string;
  root: string;
  path: string;
  expires: number;
}

class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** Asks the person at this PC whether a device may connect. Resolves 'timeout' if nobody answers. */
export type Approver = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision | 'timeout'>;

const MAX_PENDING_APPROVALS = 3;

export class FileServer extends EventEmitter {
  private server: https.Server | null = null;
  readonly sessions = new SessionStore();
  private lockout = new Lockout();
  private tickets = new Map<string, Ticket>();
  private pendingApprovals = new Set<string>(); // client ids waiting for an answer
  port: number | null = null;
  // Set by the app; without it (tests, no UI) devices are let in after the password alone.
  approve: Approver | null = null;

  async ensureCertificate(): Promise<void> {
    const cfg = getConfig();
    if (cfg.tls) return;
    const notAfterDate = new Date();
    notAfterDate.setFullYear(notAfterDate.getFullYear() + 20);
    const pems = await generate([{ name: 'commonName', value: `lanshare-${cfg.deviceId}` }], {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notAfterDate,
    });
    cfg.tls = { key: pems.private, cert: pems.cert };
    saveConfig();
  }

  async start(): Promise<void> {
    if (this.server) return;
    await this.ensureCertificate();
    const { key, cert } = getConfig().tls!;
    const server = https.createServer({ key, cert, requestTimeout: 0 }, (req, res) => {
      this.handle(req, res).catch((err) => this.sendError(res, err));
    });
    server.setTimeout(IDLE_TIMEOUT_MS);
    server.keepAliveTimeout = KEEP_ALIVE_MS;
    for (let port = DEFAULT_PORT; port < DEFAULT_PORT + 10; port++) {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '0.0.0.0', () => {
            server.off('error', reject);
            resolve();
          });
        });
        this.server = server;
        this.port = port;
        this.emit('status');
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      }
    }
    throw new Error('No free port available for the file server');
  }

  stop(): void {
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = null;
    this.port = null;
    this.sessions.revokeAll();
    this.emit('sessions');
    this.emit('status');
  }

  get running(): boolean {
    return this.server !== null;
  }

  revokeSession(id: string): void {
    this.sessions.revokeById(id);
    this.emit('sessions');
  }

  /** Called when the password changes: every session and remembered login stops working. */
  revokeEverything(): void {
    this.sessions.revokeAll();
    getConfig().rememberedClients = [];
    saveConfig();
    this.emit('sessions');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'https://localhost');
    const route = `${req.method} ${url.pathname}`;
    const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    const cfg = getConfig();

    if (req.method === 'GET' && MOBILE_FILES[url.pathname]) return this.serveMobile(res, url.pathname);

    if (route === 'GET /api/info') {
      return this.json(res, 200, {
        app: 'lanshare',
        id: cfg.deviceId,
        name: cfg.deviceName,
        platform: process.platform,
        version: app.getVersion(),
      });
    }

    if (route === 'POST /api/auth') return this.authenticate(req, res, ip);

    if (route === 'GET /api/download' && url.searchParams.has('ticket')) {
      const ticket = this.tickets.get(url.searchParams.get('ticket') ?? '');
      if (!ticket || ticket.expires < Date.now() || !this.sessions.validate(ticket.token)) {
        throw new HttpError(401, 'This download link has expired. Go back and tap the file again.');
      }
      const ticketUrl = new URL(`/?${new URLSearchParams({ root: ticket.root, path: ticket.path })}`, 'https://localhost');
      return this.download(req, res, ticketUrl);
    }

    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!this.sessions.validate(token)) throw new HttpError(401, 'Not authenticated');

    switch (route) {
      case 'POST /api/logout':
        this.sessions.revokeToken(token);
        this.emit('sessions');
        return this.json(res, 200, { ok: true });
      case 'GET /api/roots':
        return this.json(res, 200, {
          roots: cfg.sharedFolders.map((f) => ({ id: f.id, name: f.name, readOnly: f.readOnly })),
        });
      case 'GET /api/list': {
        const { dir, folder } = await this.target(url, 'path');
        if (!(await fs.promises.stat(dir)).isDirectory()) throw new HttpError(400, 'Not a folder');
        return this.json(res, 200, { entries: await listDir(dir), readOnly: folder.readOnly });
      }
      case 'GET /api/download':
        return this.download(req, res, url);
      case 'POST /api/ticket': {
        const { dir: file } = await this.target(url, 'path');
        if (!(await fs.promises.stat(file)).isFile()) throw new HttpError(400, 'Not a file');
        for (const [id, t] of this.tickets) if (t.expires < Date.now()) this.tickets.delete(id);
        const id = randomToken();
        this.tickets.set(id, {
          token,
          root: url.searchParams.get('root') ?? '',
          path: url.searchParams.get('path') ?? '',
          expires: Date.now() + TICKET_MS,
        });
        return this.json(res, 200, { url: `/api/download?ticket=${id}` });
      }
      case 'PUT /api/upload':
        return this.upload(req, res, url);
      case 'POST /api/mkdir': {
        const { dir, folder } = await this.target(url, 'path');
        if (folder.readOnly) throw readOnlyError(folder.name);
        const name = url.searchParams.get('name') ?? '';
        if (!isValidName(name)) throw new HttpError(400, 'Invalid folder name');
        const created = uniquePath(dir, name);
        await fs.promises.mkdir(created);
        return this.json(res, 200, { name: path.basename(created) });
      }
    }
    throw new HttpError(404, 'Not found');
  }

  private async authenticate(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    const cfg = getConfig();
    if (!cfg.passwordHash || !cfg.passwordSalt) {
      throw new HttpError(403, 'This PC has not set a password yet, so it does not accept connections');
    }
    const wait = this.lockout.remaining(ip);
    if (wait > 0) {
      throw new HttpError(429, `Too many wrong attempts. Try again in ${Math.ceil(wait / 60000)} min`, {
        retryAfter: wait,
      });
    }

    const body = await readJson(req);
    const clientId = String(body.clientId ?? '').slice(0, 64);
    const clientName = String(body.clientName ?? 'Unknown PC').slice(0, 64);
    if (!clientId) throw new HttpError(400, 'Missing client id');

    let ok = false;
    let fromRemembered = false;
    if (typeof body.rememberToken === 'string') {
      const hash = sha256(body.rememberToken);
      ok = cfg.rememberedClients.some((c) => c.tokenHash === hash && c.clientId === clientId);
      fromRemembered = true;
    } else if (typeof body.password === 'string') {
      ok = verifyPassword(body.password, cfg.passwordHash, cfg.passwordSalt);
    }

    if (!ok) {
      this.lockout.fail(ip);
      throw new HttpError(401, fromRemembered ? 'Saved login is no longer valid' : 'Incorrect password');
    }
    this.lockout.succeed(ip);

    // Right password; now the person at this PC accepts or rejects devices it doesn't know yet.
    const known = cfg.approvedDevices.some((d) => d.clientId === clientId);
    if (cfg.askBeforeConnect && !known && this.approve) {
      await this.waitForApproval(req, clientId, clientName, ip, body.kind === 'phone' ? 'phone' : 'pc');
    }

    const token = this.sessions.create(clientId, clientName, ip);
    let rememberToken: string | undefined;
    if (body.remember === true && !fromRemembered) {
      rememberToken = randomToken();
      cfg.rememberedClients = cfg.rememberedClients.filter((c) => c.clientId !== clientId);
      cfg.rememberedClients.push({ tokenHash: sha256(rememberToken), clientId, clientName, created: Date.now() });
      saveConfig();
    }
    this.emit('sessions');
    this.emit('connected', clientName, ip);
    this.json(res, 200, { token, rememberToken, name: cfg.deviceName });
  }

  private async waitForApproval(
    req: IncomingMessage, clientId: string, clientName: string, ip: string, kind: ApprovalRequest['kind'],
  ): Promise<void> {
    const pc = getConfig().deviceName;
    if (this.pendingApprovals.has(clientId)) throw new HttpError(409, `Already waiting for ${pc} to accept this device`);
    if (this.pendingApprovals.size >= MAX_PENDING_APPROVALS) {
      throw new HttpError(429, 'Too many devices are waiting to connect. Try again in a minute');
    }
    this.pendingApprovals.add(clientId);
    // If the device gives up (closes the connection), the question on this PC goes away.
    const controller = new AbortController();
    const onClose = () => controller.abort();
    req.socket.once('close', onClose);
    req.socket.setTimeout(0); // Answering can take longer than the idle timeout.
    try {
      const decision = await this.approve!({ id: randomToken(), clientName, ip, kind }, controller.signal);
      if (decision === 'reject') throw new HttpError(403, `${pc} declined the connection`);
      if (decision === 'timeout') {
        throw new HttpError(403, `Nobody accepted the connection on ${pc} in time. Ask someone at that PC to click Allow, then try again`);
      }
      if (decision === 'always') {
        const cfg = getConfig();
        cfg.approvedDevices = cfg.approvedDevices.filter((d) => d.clientId !== clientId);
        cfg.approvedDevices.push({ clientId, clientName, approvedAt: Date.now() });
        saveConfig();
        this.emit('approved');
      }
    } finally {
      this.pendingApprovals.delete(clientId);
      req.socket.off('close', onClose);
      if (!req.socket.destroyed) req.socket.setTimeout(IDLE_TIMEOUT_MS);
    }
  }

  /** Resolves ?root=&<param>= to an existing path inside a shared folder. */
  private async target(url: URL, param: string) {
    const folder = getConfig().sharedFolders.find((f) => f.id === url.searchParams.get('root'));
    if (!folder) throw new HttpError(404, 'Shared folder not found');
    const dir = await resolveInside(folder.path, url.searchParams.get(param) ?? '');
    if (!dir) throw new HttpError(404, 'Path not found');
    return { dir, folder };
  }

  private async download(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { dir: file } = await this.target(url, 'path');
    const st = await fs.promises.stat(file);
    if (!st.isFile()) throw new HttpError(400, 'Not a file');

    let start = 0;
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    if (range) start = Math.min(Number(range[1]), st.size);

    const name = path.basename(file);
    const asciiName = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': st.size - start,
      ...(range ? { 'Content-Range': `bytes ${start}-${st.size - 1}/${st.size}` } : {}),
    });
    await pipeline(fs.createReadStream(file, { start, highWaterMark: CHUNK }), res).catch(() => {
      // Client cancelled or connection dropped; nothing else to do.
    });
  }

  private async upload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { dir, folder } = await this.target(url, 'path');
    if (folder.readOnly) throw readOnlyError(folder.name);
    if (!(await fs.promises.stat(dir)).isDirectory()) throw new HttpError(400, 'Not a folder');
    const name = url.searchParams.get('name') ?? '';
    if (!isValidName(name)) throw new HttpError(400, 'Invalid file name');
    const expected = Number(req.headers['content-length']);
    if (!Number.isFinite(expected)) throw new HttpError(411, 'Content-Length required');

    const temp = path.join(dir, `.${name}.${randomToken().slice(0, 8)}.lanshare-part`);
    try {
      await pipeline(req, fs.createWriteStream(temp, { flags: 'wx', highWaterMark: CHUNK }));
      const written = (await fs.promises.stat(temp)).size;
      if (written !== expected) throw new HttpError(400, 'Upload incomplete');
      const final = uniquePath(dir, name);
      await fs.promises.rename(temp, final);
      this.json(res, 200, { name: path.basename(final) });
    } catch (err) {
      await fs.promises.rm(temp, { force: true });
      throw err;
    }
  }

  private async serveMobile(res: ServerResponse, pathname: string): Promise<void> {
    const [file, type] = MOBILE_FILES[pathname];
    const body = await fs.promises.readFile(path.join(MOBILE_DIR, file));
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache', ...PAGE_HEADERS });
    res.end(body);
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }

  private sendError(res: ServerResponse, err: unknown): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof HttpError) return this.json(res, err.status, { error: err.message, ...err.extra });
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return this.json(res, 404, { error: 'Not found' });
    if (code === 'EACCES' || code === 'EPERM') return this.json(res, 403, { error: 'Access denied by Windows' });
    if (code === 'EBUSY') return this.json(res, 409, { error: 'File is in use by another program' });
    console.error('Server error:', err);
    this.json(res, 500, { error: 'Internal error' });
  }
}

function readOnlyError(folderName: string): HttpError {
  const pc = getConfig().deviceName;
  return new HttpError(
    403,
    `${pc} shares "${folderName}" as read-only. To send files here, open Settings on ${pc} and set this folder to Read & write.`,
  );
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Fall through.
  }
  throw new HttpError(400, 'Invalid JSON');
}
