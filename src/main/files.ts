// File-system helpers: safe path resolution inside shared folders and directory listing.
import * as fs from 'fs';
import * as path from 'path';
import type { FileEntry } from '../shared/types';

/** Splits a client-supplied relative path into safe segments, or returns null if it is suspicious. */
export function safeSegments(rel: string): string[] | null {
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  for (const p of parts) {
    if (p === '.' || p === '..' || p.includes(':') || p.includes('\0')) return null;
  }
  return parts;
}

/** Resolves `rel` inside `root`; returns null if the result would escape the root (incl. via links). */
export async function resolveInside(root: string, rel: string): Promise<string | null> {
  const parts = safeSegments(rel);
  if (!parts) return null;
  const full = path.resolve(root, ...parts);
  if (!isWithin(root, full)) return null;
  try {
    const [realRoot, realFull] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(full)]);
    if (!isWithin(realRoot, realFull)) return null;
  } catch {
    return null; // Doesn't exist.
  }
  return full;
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** A valid single file or folder name for creating on this machine. */
export function isValidName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !/[\\/:*?"<>|\0]/.test(name) &&
    name !== '.' &&
    name !== '..' &&
    !/[. ]$/.test(name)
  );
}

export async function listDir(dir: string): Promise<FileEntry[]> {
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  const entries: FileEntry[] = [];
  await Promise.all(
    dirents.map(async (d) => {
      if (d.name.endsWith('.lanshare-part')) return; // In-progress upload.
      try {
        const st = await fs.promises.stat(path.join(dir, d.name));
        entries.push({ name: d.name, isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs });
      } catch {
        // Skip entries we can't stat (system files, broken links, permission denied).
      }
    }),
  );
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.isDir ? -1 : 1));
  return entries;
}

/** Lists available drive roots (Windows) or "/" elsewhere. */
export function listDrives(): FileEntry[] {
  if (process.platform !== 'win32') return [{ name: '/', isDir: true, size: 0, mtime: 0 }];
  const drives: FileEntry[] = [];
  for (let c = 67; c <= 90; c++) {
    // C: to Z: (skip floppy letters, which can hang).
    const root = String.fromCharCode(c) + ':\\';
    if (fs.existsSync(root)) drives.push({ name: root, isDir: true, size: 0, mtime: 0 });
  }
  return drives;
}

/** Returns a path that doesn't exist yet, adding " (1)", " (2)"... before the extension. */
export function uniquePath(dir: string, name: string): string {
  let candidate = path.join(dir, name);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}
