import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** Spec §4: the allowed mime list. A map, not a set, so an accepted file always gets an extension. */
export const ALLOWED_MIME: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'text/plain': 'txt',
};

/** `documents/<tenant uuid>/<year>/<document uuid>.<ext>` and nothing else may reach the disk. */
const KEY_RE = /^documents\/[0-9a-f-]{36}\/\d{4}\/[0-9a-f-]{36}\.[a-z0-9]{1,8}$/;

export function documentStorageKey(tenantId: string, documentId: string, mime: string, at: Date): string {
  const ext = ALLOWED_MIME[mime];
  if (!ext) throw new Error(`unsupported mime: ${mime}`);
  return `documents/${tenantId}/${at.getUTCFullYear()}/${documentId}.${ext}`;
}

/**
 * A Cyrillic file name survives in `filename*`; the ASCII `filename` is the fallback for clients
 * that ignore RFC 5987, and it is sanitised so a quote or a semicolon cannot break out of the header.
 */
export function contentDisposition(fileName: string, type: 'attachment' | 'inline' = 'attachment'): string {
  const ascii = fileName.replace(/[^A-Za-z0-9_.-]/g, '_') || 'document';
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export interface StoredFile { sizeBytes: number; sha256: string }

/** The seam an S3-compatible driver slots into later (spec §4); the API never touches `fs` directly. */
export interface DocumentStore {
  put(key: string, data: Readable): Promise<StoredFile>;
  open(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
}

export class LocalDiskStore implements DocumentStore {
  constructor(private readonly root: string) {}

  /** Two gates, on purpose: the shape of the key, and the resolved path staying inside the root. */
  private pathOf(key: string): string {
    if (!KEY_RE.test(key)) throw new Error(`invalid storage key: ${key}`);
    const root = resolve(this.root);
    const abs = resolve(root, key);
    if (!abs.startsWith(root + sep)) throw new Error(`storage key escapes the data directory: ${key}`);
    return abs;
  }

  /** Streams and hashes in one pass; nothing is buffered whole (spec §11). `wx` refuses to overwrite. */
  async put(key: string, data: Readable): Promise<StoredFile> {
    const abs = this.pathOf(key);
    await mkdir(dirname(abs), { recursive: true });
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) { hash.update(chunk); sizeBytes += chunk.length; cb(null, chunk); },
    });
    await pipeline(data, meter, createWriteStream(abs, { flags: 'wx', mode: 0o600 }));
    return { sizeBytes, sha256: hash.digest('hex') };
  }

  async open(key: string): Promise<Readable> {
    const abs = this.pathOf(key);
    await stat(abs); // throws before a reply is started, so a missing file is a 500 and not a broken stream
    return createReadStream(abs);
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }
}
