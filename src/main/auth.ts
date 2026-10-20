// Password hashing, sessions and brute-force protection for the file server.
import * as crypto from 'crypto';
import type { IncomingSession } from '../shared/types';

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return { hash: hash.toString('base64'), salt: salt.toString('base64') };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, SCRYPT_OPTS);
  return crypto.timingSafeEqual(expected, actual);
}

export function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('base64');
}

interface Session {
  id: string;
  clientId: string;
  clientName: string;
  ip: string;
  created: number;
  lastUsed: number;
}

const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;

export class SessionStore {
  private sessions = new Map<string, Session>();

  create(clientId: string, clientName: string, ip: string): string {
    const token = randomToken();
    const now = Date.now();
    this.sessions.set(token, { id: crypto.randomUUID(), clientId, clientName, ip, created: now, lastUsed: now });
    return token;
  }

  validate(token: string | undefined): Session | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (Date.now() - s.lastUsed > SESSION_IDLE_MS) {
      this.sessions.delete(token);
      return null;
    }
    s.lastUsed = Date.now();
    return s;
  }

  revokeToken(token: string): void {
    this.sessions.delete(token);
  }

  revokeById(id: string): void {
    for (const [token, s] of this.sessions) if (s.id === id) this.sessions.delete(token);
  }

  revokeAll(): void {
    this.sessions.clear();
  }

  list(): IncomingSession[] {
    // One entry per connected PC (a PC can hold several tokens).
    const byClient = new Map<string, IncomingSession>();
    for (const s of this.sessions.values()) {
      if (!byClient.has(s.clientId)) {
        byClient.set(s.clientId, { id: s.id, clientName: s.clientName, ip: s.ip, since: s.created });
      }
    }
    return [...byClient.values()];
  }
}

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

export class Lockout {
  private attempts = new Map<string, { count: number; until: number }>();

  /** Milliseconds this IP must still wait, or 0 if it may try. */
  remaining(ip: string): number {
    const a = this.attempts.get(ip);
    if (!a || a.until === 0) return 0;
    const left = a.until - Date.now();
    if (left <= 0) {
      this.attempts.delete(ip);
      return 0;
    }
    return left;
  }

  fail(ip: string): void {
    const a = this.attempts.get(ip) ?? { count: 0, until: 0 };
    a.count++;
    if (a.count >= MAX_ATTEMPTS) a.until = Date.now() + LOCKOUT_MS;
    this.attempts.set(ip, a);
  }

  succeed(ip: string): void {
    this.attempts.delete(ip);
  }
}
