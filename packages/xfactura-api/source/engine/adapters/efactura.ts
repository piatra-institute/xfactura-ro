/**
 * The ANAF e-Factura API as the engine uses it. Live clients (OAuth, the upload, status,
 * message list and download endpoints) come later; tests use a deterministic fake.
 */
export interface EFacturaPort {
  /** Uploads an XML for the company's CIF; returns ANAF's upload index (index_incarcare). */
  upload(input: { cif: string; xml: Uint8Array }): Promise<{ uploadId: string }>;
  /** The processing state of an upload, and the message to download once it is processed. */
  status(input: { cif: string; uploadId: string }): Promise<UploadStatus>;
  /** One page of the messages for a CIF created in [from, to), in epoch milliseconds. */
  messages(input: {
    cif: string;
    from: number;
    to: number;
    page: number;
  }): Promise<{ messages: SpvMessage[]; pages: number }>;
  /** The archive behind a message: the XML and the Ministry's signature, or an error report. */
  download(input: { cif: string; messageId: string }): Promise<Uint8Array>;
}

export type UploadStatus =
  { state: 'processing' } | { state: 'ok' | 'nok'; messageId: string } | { state: 'unknown' };

export type SpvMessage = {
  /** The message (download) identifier. */
  id: string;
  /** The upload the message is about (id_solicitare). */
  uploadId: string;
  /** FACTURA TRIMISA, FACTURA PRIMITA, ERORI FACTURA, MESAJ CUMPARATOR. */
  kind: 'sent' | 'received' | 'error' | 'buyer_message';
  createdAt: number;
  details: string;
};

/** A request whose outcome is unknown: it may or may not have reached ANAF. */
export class EFacturaUnavailable extends Error {}
