// Reads an answered (and, for the expert, signed) review packet PDF: the attached packet, as
// declarations.importSigned reads a declaration's XML (pdfAttachments, pdfHasSignature); the
// answers from its form; and where the last signature's byte range ends. The qualified
// certificate is not verified here: a signature is recorded as present, not verified.
import { PDFDocument, PDFName, PDFRadioGroup, PDFTextField } from 'pdf-lib';
import { canonical } from '../../packages/xfactura-core/src/hash';
import {
  packetIdOf,
  reviewPacketSchema,
  type ReviewPacket,
} from '../../packages/xfactura-core/src/ro/reviews';
import {
  pdfAttachments,
  pdfHasSignature,
} from '../../packages/xfactura-api/source/engine/adapters/pdf-attachments';
import { answerField, reviewerFields, textField, type PacketContext } from './render';
import { sha256 } from './snapshots';

export class ImportRefused extends Error {}

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

/** The last signature's byte range, and whether it reaches the end of the file: nothing was
 * appended after signing (a trailing end-of-line excepted). Null without a signature. */
export function signatureCoverage(bytes: Uint8Array) {
  const text = latin1(bytes);
  let last: [number, number, number, number] | undefined;
  for (const match of text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)) {
    const range = match.slice(1, 5).map(Number) as [number, number, number, number];
    if (!last || range[2] + range[3] > last[2] + last[3]) last = range;
  }
  if (!last) return null;
  const [start, first, second, length] = last;
  const end = second + length;
  const gap = text.slice(start + first, second);
  return {
    byteRange: last,
    coversWholeFile:
      start === 0 &&
      end <= bytes.length &&
      /^[\r\n]{0,2}$/.test(text.slice(end)) &&
      /^<[0-9a-fA-F\s]*>$/.test(gap),
  };
}

/** The signing day from the last signature dictionary's /M (keys come in any order), if any. */
export function signingDate(bytes: Uint8Array) {
  const text = latin1(bytes);
  const signatures = [...text.matchAll(/\d+\s+\d+\s+obj\b/g)]
    .map((match) => text.slice(match.index, text.indexOf('endobj', match.index)))
    .filter((body) => /\/ByteRange\s*\[/.test(body));
  const date = /\/M\s*\(D:(\d{4})(\d{2})(\d{2})/.exec(signatures.at(-1) ?? '');
  return date ? `${date[1]}-${date[2]}-${date[3]}` : null;
}

export interface Answer {
  key: string;
  field: string;
  choice: 'A' | 'B' | 'C' | null;
  text: string;
}

/** The radio choices and texts of the packet's questions, and the reviewer's fields. */
export async function formAnswers(bytes: Uint8Array, packet: ReviewPacket) {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = document.getForm();
  const field = (name: string) => form.getFields().find((item) => item.getName() === name);
  const text = (name: string) => {
    const item = field(name);
    return item instanceof PDFTextField ? (item.getText() ?? '').trim() : '';
  };
  const answers: Answer[] = packet.items.map((item, index) => {
    const radio = field(answerField(index));
    let choice: string | undefined;
    if (radio instanceof PDFRadioGroup) choice = radio.getSelected();
    else {
      // A reader may store the choice only on the widget's appearance state.
      const value = radio?.acroField.dict.get(PDFName.of('V'));
      choice = value instanceof PDFName ? value.decodeText() : undefined;
    }
    return {
      key: item.key,
      field: answerField(index),
      choice: choice === 'A' || choice === 'B' || choice === 'C' ? choice : null,
      text: text(textField(index)),
    };
  });
  return {
    answers,
    reviewer: {
      name: text(reviewerFields.name),
      ceccar: text(reviewerFields.ceccar),
      role: text(reviewerFields.role),
    },
  };
}

/** The packet and context attached to the file; refuses a packet that is not exactly the
 * canonical JSON of a valid packet. */
export async function attachedPacket(bytes: Uint8Array) {
  const read = await pdfAttachments(bytes);
  if (!read.ok) {
    throw new ImportRefused(
      read.reason === 'encrypted'
        ? 'The PDF is encrypted and cannot be read.'
        : read.reason === 'too_large'
          ? 'The PDF exceeds the attachment reading limits.'
          : `The PDF attachments could not be read (${read.reason}).`,
    );
  }
  const files = read.attachments;
  const packetFile = files.filter((file) => file.name === 'packet.json').at(-1);
  if (!packetFile) throw new ImportRefused('The PDF carries no packet.json attachment.');
  const json = new TextDecoder().decode(packetFile.bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ImportRefused('packet.json is not JSON.');
  }
  const result = reviewPacketSchema.safeParse(parsed);
  if (!result.success)
    throw new ImportRefused(`packet.json is not a review packet: ${result.error.message}`);
  if (canonical(parsed) !== json)
    throw new ImportRefused('packet.json is not in canonical form: it was edited.');
  if (packetIdOf(result.data.items) !== result.data.id)
    throw new ImportRefused('packet.json does not match its packet id: it was edited.');
  const contextFile = files.filter((file) => file.name === 'context.json').at(-1);
  let context: PacketContext | null = null;
  if (contextFile)
    try {
      context = JSON.parse(new TextDecoder().decode(contextFile.bytes)) as PacketContext;
    } catch {
      context = null;
    }
  return { packet: result.data, packetSha256: sha256(packetFile.bytes), context };
}

export { pdfHasSignature };
