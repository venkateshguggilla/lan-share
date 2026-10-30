// Transfer queue: downloads from and uploads to remote PCs, with progress and cancel.
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as fs from 'fs';
import type { ClientRequest } from 'http';
import * as path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { RemoteClient, RemoteError, friendlyError, openRequest, query, readJsonResponse, waitResponse } from './client';
import { uniquePath } from './files';
import type { RemoteItem, Transfer } from '../shared/types';

const CONCURRENCY = 2;
const IDLE_TIMEOUT_MS = 60000;

interface Job {
  info: Transfer;
  run: (job: Job) => Promise<void>;
  req?: ClientRequest;
  cancelled?: boolean;
}

function joinRemote(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export class TransferManager extends EventEmitter {
  private jobs: Job[] = [];
  private active = 0;
  private emitTimer: NodeJS.Timeout | null = null;

  constructor(private client: RemoteClient) {
    super();
  }

  list(): Transfer[] {
    return this.jobs.map((j) => ({ ...j.info }));
  }

  cancel(id: string): void {
    const job = this.jobs.find((j) => j.info.id === id);
    if (!job || (job.info.status !== 'queued' && job.info.status !== 'active')) return;
    job.cancelled = true;
    job.req?.destroy(new Error('Cancelled'));
    if (job.info.status === 'queued') job.info.status = 'cancelled';
    this.changed();
  }

  clearFinished(): void {
    this.jobs = this.jobs.filter((j) => j.info.status === 'queued' || j.info.status === 'active');
    this.changed(true);
  }

  // ---------- Downloads ----------

  async download(deviceId: string, root: string, remoteDir: string, items: RemoteItem[], localDir: string): Promise<void> {
    const deviceName = this.client.target(deviceId).name;
    for (const item of items) {
      const remotePath = joinRemote(remoteDir, item.name);
      if (item.isDir) {
        this.downloadFolder(deviceId, deviceName, root, remotePath, item.name, localDir).catch((err) =>
          this.failedEntry('download', item.name, deviceName, err),
        );
      } else {
        // Size is filled in from the response headers.
        this.addDownload(deviceId, deviceName, root, remotePath, item.name, 0, localDir);
      }
    }
  }

  private async downloadFolder(
    deviceId: string, deviceName: string, root: string, remotePath: string, name: string, localDir: string,
  ): Promise<void> {
    const target = uniquePath(localDir, name);
    await fs.promises.mkdir(target, { recursive: true });
    const { entries } = await this.client.list(deviceId, root, remotePath);
    for (const e of entries) {
      const child = joinRemote(remotePath, e.name);
      if (e.isDir) await this.downloadFolder(deviceId, deviceName, root, child, e.name, target);
      else this.addDownload(deviceId, deviceName, root, child, e.name, e.size, target);
    }
  }

  private addDownload(
    deviceId: string, deviceName: string, root: string, remotePath: string, name: string, size: number, localDir: string,
  ): void {
    this.enqueue('download', name, deviceName, size, async (job) => {
      const req = await openRequest(this.client.target(deviceId), 'GET', `/api/download?${query({ root, path: remotePath })}`, {
        Authorization: `Bearer ${this.client.token(deviceId)}`,
      });
      job.req = req;
      if (job.cancelled) req.destroy(new Error('Cancelled'));
      const res = await waitResponse(req);
      if (res.statusCode !== 200) await readJsonResponse(res); // Throws with the server's message.
      job.info.total = Number(res.headers['content-length']) || job.info.total;
      req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error('Connection stalled')));

      const temp = path.join(localDir, `.${name}.${crypto.randomBytes(4).toString('hex')}.lanshare-part`);
      try {
        await pipeline(res, this.counter(job), fs.createWriteStream(temp, { flags: 'wx' }));
        if (job.info.done !== job.info.total) throw new Error('Download incomplete');
        await fs.promises.rename(temp, uniquePath(localDir, name));
      } catch (err) {
        await fs.promises.rm(temp, { force: true });
        throw err;
      }
    });
  }

  // ---------- Uploads ----------

  async upload(deviceId: string, root: string, remoteDir: string, localPaths: string[]): Promise<void> {
    const deviceName = this.client.target(deviceId).name;
    for (const p of localPaths) {
      const name = path.basename(p);
      try {
        const st = await fs.promises.stat(p);
        if (st.isDirectory()) {
          this.uploadFolder(deviceId, deviceName, root, remoteDir, p).catch((err) =>
            this.failedEntry('upload', name, deviceName, err),
          );
        } else {
          this.addUpload(deviceId, deviceName, root, remoteDir, p, st.size);
        }
      } catch (err) {
        this.failedEntry('upload', name, deviceName, err);
      }
    }
  }

  private async uploadFolder(deviceId: string, deviceName: string, root: string, remoteDir: string, localPath: string): Promise<void> {
    const created = await this.client.mkdir(deviceId, root, remoteDir, path.basename(localPath));
    const remotePath = joinRemote(remoteDir, created);
    const dirents = await fs.promises.readdir(localPath, { withFileTypes: true });
    for (const d of dirents) {
      const child = path.join(localPath, d.name);
      if (d.isDirectory()) await this.uploadFolder(deviceId, deviceName, root, remotePath, child);
      else if (d.isFile()) this.addUpload(deviceId, deviceName, root, remotePath, child, (await fs.promises.stat(child)).size);
    }
  }

  private addUpload(deviceId: string, deviceName: string, root: string, remoteDir: string, localPath: string, size: number): void {
    const name = path.basename(localPath);
    this.enqueue('upload', name, deviceName, size, async (job) => {
      const req = await openRequest(this.client.target(deviceId), 'PUT', `/api/upload?${query({ root, path: remoteDir, name })}`, {
        Authorization: `Bearer ${this.client.token(deviceId)}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
      });
      job.req = req;
      if (job.cancelled) req.destroy(new Error('Cancelled'));
      req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error('Connection stalled')));
      const response = new Promise<unknown>((resolve, reject) => {
        req.on('response', (res) => readJsonResponse(res).then(resolve, reject));
        req.on('error', reject);
      });
      response.catch(() => {}); // Awaited below; the connection can fail before the upload finishes.
      const sendError = await pipeline(fs.createReadStream(localPath), this.counter(job), req).then(
        () => null,
        (err: unknown) => err,
      );
      await response; // Prefer the server's error message over the pipe error.
      if (sendError) throw sendError;
    });
  }

  // ---------- Queue ----------

  private enqueue(direction: Transfer['direction'], name: string, deviceName: string, total: number, run: Job['run']): void {
    this.jobs.push({
      info: { id: crypto.randomUUID(), direction, name, deviceName, total, done: 0, speed: 0, status: 'queued' },
      run,
    });
    this.changed();
    this.pump();
  }

  private failedEntry(direction: Transfer['direction'], name: string, deviceName: string, err: unknown): void {
    this.jobs.push({
      info: {
        id: crypto.randomUUID(), direction, name, deviceName, total: 0, done: 0, speed: 0,
        status: 'error', error: friendlyError(err),
      },
      run: async () => {},
    });
    this.changed();
  }

  private pump(): void {
    while (this.active < CONCURRENCY) {
      const job = this.jobs.find((j) => j.info.status === 'queued');
      if (!job) return;
      this.active++;
      job.info.status = 'active';
      this.changed();
      job
        .run(job)
        .then(() => {
          job.info.status = 'done';
          job.info.done = job.info.total;
        })
        .catch((err) => {
          if (job.cancelled) {
            job.info.status = 'cancelled';
          } else {
            job.info.status = 'error';
            job.info.error = friendlyError(err);
            if (err instanceof RemoteError && err.status === 401) job.info.error = 'Session expired; reconnect and retry';
          }
        })
        .finally(() => {
          job.info.speed = 0;
          job.req = undefined;
          this.active--;
          this.changed(true);
          this.pump();
        });
    }
  }

  /** A pass-through stream that records progress and speed on the job. */
  private counter(job: Job): Transform {
    let windowStart = Date.now();
    let windowBytes = 0;
    return new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        job.info.done += chunk.length;
        windowBytes += chunk.length;
        const elapsed = Date.now() - windowStart;
        if (elapsed >= 1000) {
          job.info.speed = (windowBytes * 1000) / elapsed;
          windowStart = Date.now();
          windowBytes = 0;
        }
        this.changed();
        cb(null, chunk);
      },
    });
  }

  /** Throttles UI updates to a few per second. */
  private changed(immediate = false): void {
    if (immediate) {
      if (this.emitTimer) clearTimeout(this.emitTimer);
      this.emitTimer = null;
      this.emit('change', this.list());
      return;
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('change', this.list());
    }, 250);
  }
}
