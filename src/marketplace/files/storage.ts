import { createHash } from 'crypto';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import { dirname, join, normalize, sep } from 'path';

/**
 * Obyekt saqlash abstraksiyasi. Haqiqiy S3-mos adapter (presigned multipart) YOZILMAGAN — KNOWN_GAPS.md.
 * LocalDiskStorage lokal/dev uchun; imzolangan URL'lar FilesController orqali xizmat qiladi (signing.ts).
 */
export interface ObjectStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  size(key: string): Promise<number>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  /** Bo'laklarni xotiraga yuklamasdan bitta faylga ulaydi (katta fayllar uchun); hajm va sha256 qaytaradi. */
  concat(keys: string[], destKey: string): Promise<{ size: number; sha256: string }>;
  /** Fayl (yoki uning [start,end] oralig'i) oqimi: Range so'rovlari uchun. */
  stream(key: string, range?: { start: number; end: number }): NodeJS.ReadableStream;
  /** Diskdagi jami/bo'sh joy (bayt). S3 kabi saqlagichlarda bo'lmasligi mumkin. */
  diskStats?(): Promise<{ totalBytes: number; freeBytes: number }>;
}

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export class LocalDiskStorage implements ObjectStorage {
  private root: string;
  constructor(root: string) {
    this.root = normalize(root);
  }

  /** Kalit ichida '..' yoki mutlaq yo'l bo'lishi mumkin emas (path traversal). */
  private path(key: string): string {
    if (!/^[A-Za-z0-9_\-/.]+$/.test(key) || key.includes('..') || key.startsWith('/')) throw new Error('Invalid storage key');
    const p = normalize(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return p;
  }

  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await fs.mkdir(dirname(p), { recursive: true });
    await fs.writeFile(p, data);
  }
  get(key: string) {
    return fs.readFile(this.path(key));
  }
  async exists(key: string) {
    return fs.access(this.path(key)).then(() => true, () => false);
  }
  async size(key: string) {
    return (await fs.stat(this.path(key))).size;
  }
  async list(prefix: string) {
    const dir = this.path(prefix.replace(/\/$/, ''));
    try {
      return (await fs.readdir(dir)).map((n) => `${prefix.replace(/\/$/, '')}/${n}`);
    } catch {
      return [];
    }
  }
  async delete(key: string) {
    await fs.rm(this.path(key), { force: true });
  }
  async diskStats() {
    await fs.mkdir(this.root, { recursive: true });
    const st = await fs.statfs(this.root);
    return { totalBytes: Number(st.blocks) * Number(st.bsize), freeBytes: Number(st.bavail) * Number(st.bsize) };
  }
  async concat(keys: string[], destKey: string) {
    const dest = this.path(destKey);
    await fs.mkdir(dirname(dest), { recursive: true });
    const out = createWriteStream(dest);
    const hash = createHash('sha256');
    let size = 0;
    try {
      for (const k of keys) {
        await new Promise<void>((resolve, reject) => {
          const rs = createReadStream(this.path(k));
          rs.on('data', (c) => { hash.update(c); size += (c as Buffer).length; });
          rs.on('error', reject);
          rs.on('end', resolve);
          rs.pipe(out, { end: false });
        });
      }
    } finally {
      await new Promise<void>((resolve) => out.end(resolve));
    }
    return { size, sha256: hash.digest('hex') };
  }
  stream(key: string, range?: { start: number; end: number }) {
    return createReadStream(this.path(key), range ? { start: range.start, end: range.end } : undefined);
  }
  async deletePrefix(prefix: string) {
    await fs.rm(this.path(prefix.replace(/\/$/, '')), { recursive: true, force: true });
  }
}
