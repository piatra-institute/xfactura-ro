import { strToU8, zipSync } from 'fflate';
import {
  EFacturaUnavailable,
  type EFacturaPort,
  type SpvMessage,
  type UploadStatus,
} from '../../../source/engine/adapters/efactura';

/**
 * How ANAF treats the next upload:
 * - `accept`/`reject`: processed at once, with a sent message or an error report;
 * - `slow`: processing until `finishProcessing`;
 * - `lost_response`: accepted, but the answer never reaches the caller;
 * - `refused`: the request never reaches ANAF.
 */
export type Behaviour = 'accept' | 'reject' | 'slow' | 'lost_response' | 'refused';

type Upload = {
  cif: string;
  xml: Uint8Array;
  uploadId: string;
  state: 'processing' | 'ok' | 'nok';
  messageId?: string;
};

const signature = (uploadId: string) =>
  strToU8(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/><SignatureValue>${uploadId}</SignatureValue></Signature>\n`,
  );
const errorReport = (uploadId: string, cif: string) =>
  strToU8(
    `<?xml version="1.0" encoding="UTF-8"?>\n<header xmlns="mfp:anaf:dgti:efactura:mesajEroriFactuta:v1" Index_incarcare="${uploadId}" Cif_emitent="${cif}"><Error errorMessage="E: validari globale  eroare: [BR-RO-100] test"/></header>\n`,
  );

/** A deterministic ANAF e-Factura service with one clock, inboxes per CIF and archives. */
export class FakeEFactura implements EFacturaPort {
  now = Date.parse('2026-03-10T10:00:00Z');
  /** Behaviours of the next uploads, in order; `accept` once it is empty. */
  script: Behaviour[] = [];
  /** Repeat the last message of each page at the start of the next, as listings may. */
  duplicateListing = false;
  pageSize = 2;
  readonly uploads: Upload[] = [];
  private readonly inbox: (SpvMessage & { cif: string })[] = [];
  private readonly archives = new Map<string, Uint8Array>();
  private next = 4_000_000_000;

  advance(milliseconds: number) {
    this.now += milliseconds;
  }

  async upload({ cif, xml }: { cif: string; xml: Uint8Array }) {
    const behaviour = this.script.shift() ?? 'accept';
    if (behaviour === 'refused') throw new EFacturaUnavailable('connection refused');
    const upload: Upload = { cif, xml, uploadId: String(this.next++), state: 'processing' };
    this.uploads.push(upload);
    if (behaviour !== 'slow') this.process(upload, behaviour === 'reject');
    if (behaviour === 'lost_response') throw new EFacturaUnavailable('timeout after 30 s');
    return { uploadId: upload.uploadId };
  }

  finishProcessing() {
    for (const upload of this.uploads)
      if (upload.state === 'processing') this.process(upload, false);
  }

  /** An invoice another company sent to `cif`. */
  deliver(cif: string, xml: string) {
    this.message(cif, 'received', String(this.next++), { invoice: strToU8(xml) });
  }

  /** An invoice `cif` uploaded some other way, such as the previous invoicer. */
  sentElsewhere(cif: string, xml: string) {
    this.message(cif, 'sent', String(this.next++), { invoice: strToU8(xml) });
  }

  async status({ uploadId }: { cif: string; uploadId: string }): Promise<UploadStatus> {
    const upload = this.uploads.find((item) => item.uploadId === uploadId);
    if (!upload) return { state: 'unknown' };
    return upload.state === 'processing'
      ? { state: 'processing' }
      : { state: upload.state, messageId: upload.messageId! };
  }

  async messages({ cif, from, to, page }: { cif: string; from: number; to: number; page: number }) {
    const all = this.inbox.filter(
      (message) => message.cif === cif && message.createdAt >= from && message.createdAt < to,
    );
    const pages = Math.max(1, Math.ceil(all.length / this.pageSize));
    const start = (page - 1) * this.pageSize;
    const slice = all.slice(
      this.duplicateListing && page > 1 ? start - 1 : start,
      start + this.pageSize,
    );
    return { messages: slice.map(({ cif: _cif, ...message }) => message), pages };
  }

  async download({ messageId }: { cif: string; messageId: string }) {
    const archive = this.archives.get(messageId);
    if (!archive) throw new Error(`No message ${messageId}.`);
    return archive;
  }

  private process(upload: Upload, reject: boolean) {
    upload.state = reject ? 'nok' : 'ok';
    upload.messageId = this.message(upload.cif, reject ? 'error' : 'sent', upload.uploadId, {
      invoice: reject ? undefined : upload.xml,
    });
  }

  private message(
    cif: string,
    kind: SpvMessage['kind'],
    uploadId: string,
    content: { invoice?: Uint8Array | undefined },
  ) {
    const id = String(this.next++);
    this.archives.set(
      id,
      zipSync(
        content.invoice
          ? {
              [`${uploadId}.xml`]: content.invoice,
              [`semnatura_${uploadId}.xml`]: signature(uploadId),
            }
          : { [`${uploadId}.xml`]: errorReport(uploadId, cif) },
      ),
    );
    this.inbox.push({
      id,
      uploadId,
      kind,
      createdAt: this.now,
      details: `${kind} ${uploadId}`,
      cif,
    });
    this.now += 60_000;
    return id;
  }
}
