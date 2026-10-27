import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { idSchema, requireCondition } from './domain';

export const sha256 = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
export interface ObjectStore {
  put(companyId: string, data: Uint8Array, maxBytes?: number): Promise<string>;
  get(companyId: string, hash: string): Promise<Buffer>;
}
export class LocalObjectStore implements ObjectStore {
  constructor(readonly root: string) {}
  private path(company: string, hash: string) {
    idSchema.parse(company);
    requireCondition(
      /^[a-f0-9]{64}$/.test(hash),
      'OBJECT_KEY',
      'Identificator de document invalid.',
    );
    return join(this.root, company, hash);
  }
  async put(company: string, bytes: Uint8Array, maxBytes = 10 * 1024 * 1024) {
    requireCondition(
      bytes.length > 0 && bytes.length <= maxBytes,
      'FILE_LIMIT',
      'Fișierul depășește limita permisă.',
    );
    const hash = sha256(bytes),
      path = this.path(company, hash),
      dir = join(this.root, company);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = join(dir, `.upload-${randomUUID()}`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.get(company, hash);
      }
      const directory = await open(dir, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return hash;
  }
  async get(company: string, hash: string) {
    const bytes = await readFile(this.path(company, hash));
    requireCondition(
      sha256(bytes) === hash,
      'EVIDENCE_INTEGRITY',
      'Integritatea documentului nu poate fi confirmată.',
      500,
    );
    return bytes;
  }
}
