import { zipSync, strToU8, type Zippable } from 'fflate';
import { invoiceXml } from './invoice';

export const signatureXml =
  '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignatureValue>U1lOVEhFVElDLU5PVC1BLVJFQUwtU0lHTkFUVVJF</ds:SignatureValue></ds:Signature>';
export const rejectionXml =
  '<header xmlns="mfp:anaf:dgti:efactura:mesajErori:v1"><Error>Independent synthetic rejection response</Error></header>';
export const invoiceZip = (
  files: Record<string, string | Uint8Array> = {
    'invoice.xml': invoiceXml(),
    'signature.xml': signatureXml,
  },
  level: 0 | 6 = 6,
) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [
        name,
        typeof bytes === 'string' ? strToU8(bytes) : bytes,
      ]),
    ) as Zippable,
    { level, mtime: new Date('2026-01-01T00:00:00Z') },
  );

/** Test-only corruption of central-directory metadata, independent of the production ZIP reader. */
export function corruptEntry(
  bytes: Uint8Array,
  mutate: (data: Buffer, offset: number) => void,
  index = 0,
) {
  const copy = Buffer.from(bytes),
    end = copy.length - 22;
  let offset = copy.readUInt32LE(end + 16);
  for (let i = 0; i < index; i++)
    offset +=
      46 +
      copy.readUInt16LE(offset + 28) +
      copy.readUInt16LE(offset + 30) +
      copy.readUInt16LE(offset + 32);
  if (copy.readUInt32LE(offset) !== 0x02014b50)
    throw new Error('Fixture central directory is missing');
  mutate(copy, offset);
  return copy;
}
