import { promises as fs } from 'fs';
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
  async deletePrefix(prefix: string) {
    await fs.rm(this.path(prefix.replace(/\/$/, '')), { recursive: true, force: true });
  }
}
