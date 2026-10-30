import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, unlink, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { requireCondition } from 'xfactura-core/errors';
import { idSchema } from '../kernel/commands';

export const sha256 = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
export interface ObjectStore {
  put(companyId: string, data: Uint8Array, maxBytes?: number): Promise<string>;
  get(companyId: string, hash: string): Promise<Buffer>;
  /**
   * Keeps data derived from a company's evidence (its text layer), under the evidence's hash
   * and the deriving reader's version (`kind`). Replaces what was kept under both: a reader
   * derives the same data from the same bytes.
   */
  putDerivative(companyId: string, hash: string, kind: string, data: Uint8Array): Promise<void>;
  /** The derived data, or undefined when none is kept or it fails its check. */
  getDerivative(companyId: string, hash: string, kind: string): Promise<Uint8Array | undefined>;
}

/** A deriving reader's version: lowercase letters, digits, dots and dashes. */
const derivativeKind = /^[a-z][a-z0-9.-]{0,99}$/;
const derivativeFormat = 'xfactura-derivative-v1';
const derivativeLimit = 32 * 1024 * 1024;

/**
 * Files under `<root>/<company>/`: evidence as `<sha256>`, named by its own hash and checked
 * against it on every read; derived data as `derivatives/<evidence sha256>/<kind>`. A derived
 * file is never evidence: it lives under a name no evidence path can take, starts with a header
 * binding it to its evidence hash, kind and own hash, and is outside the backup manifest (it is
 * derived again after a restore).
 */
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

  private derivative(company: string, hash: string, kind: string) {
    this.path(company, hash);
    requireCondition(derivativeKind.test(kind), 'OBJECT_KEY', 'Identificator de document invalid.');
    const directory = join(this.root, company, 'derivatives', hash);
    return { directory, path: join(directory, kind) };
  }
  async putDerivative(company: string, hash: string, kind: string, data: Uint8Array) {
    requireCondition(
      data.length <= derivativeLimit,
      'FILE_LIMIT',
      'Fișierul depășește limita permisă.',
    );
    const { directory, path } = this.derivative(company, hash, kind);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const header = JSON.stringify({
      format: derivativeFormat,
      evidence: hash,
      kind,
      sha256: sha256(data),
      size: data.length,
    });
    const temporary = join(directory, `.derive-${randomUUID()}`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(Buffer.concat([Buffer.from(`${header}\n`), data]));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  async getDerivative(company: string, hash: string, kind: string) {
    const { path } = this.derivative(company, hash, kind);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const end = bytes.indexOf(0x0a);
    if (end < 0) return undefined;
    const data = bytes.subarray(end + 1);
    try {
      const header = JSON.parse(bytes.subarray(0, end).toString('utf8')) as Record<string, unknown>;
      const intact =
        header.format === derivativeFormat &&
        header.evidence === hash &&
        header.kind === kind &&
        header.size === data.length &&
        header.sha256 === sha256(data);
      return intact ? new Uint8Array(data) : undefined;
    } catch {
      return undefined;
    }
  }
}
