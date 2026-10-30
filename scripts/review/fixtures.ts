// Test fixtures for the review round trip: a reviewer's answers filled into a packet's form, and
// a FAKE signature dictionary appended as an incremental update, shaped like a PAdES signature
// (/Type /Sig, /ByteRange over the whole file, /Contents) but holding no cryptography. Never use
// it outside tests: the importer records any signature as "present, not verified".
import { PDFDocument } from 'pdf-lib';
import { answerField, reviewerFields, SIGNATURE_FIELD, textField } from './render';

export async function fillAnswers(
  bytes: Uint8Array,
  answers: readonly ('A' | 'B' | 'C')[],
  reviewer: { name: string; ceccar: string; role: string },
  texts: Record<number, string> = {},
) {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = document.getForm();
  answers.forEach((choice, index) => {
    form.getRadioGroup(answerField(index)).select(choice);
    if (texts[index]) form.getTextField(textField(index)).setText(texts[index]);
  });
  form.getTextField(reviewerFields.name).setText(reviewer.name);
  form.getTextField(reviewerFields.ceccar).setText(reviewer.ceccar);
  form.getTextField(reviewerFields.role).setText(reviewer.role);
  return document.save({ useObjectStreams: false });
}

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

/** Appends a fake signature on the packet's signature field, signed on `date` (YYYY-MM-DD). */
export function appendFakeSignature(bytes: Uint8Array, date: string) {
  const text = latin1(bytes);
  const prev = Number([...text.matchAll(/startxref\s+(\d+)/g)].at(-1)![1]);
  const trailer = [...text.matchAll(/trailer\s*<<([\s\S]*?)>>\s*startxref/g)].at(-1)![1]!;
  const size = Number(/\/Size\s+(\d+)/.exec(trailer)![1]);
  const root = /\/Root\s+(\d+\s+\d+\s+R)/.exec(trailer)![1];
  const info = /\/Info\s+(\d+\s+\d+\s+R)/.exec(trailer)?.[1];
  // The signature field, as last written: a dictionary object, not a stream.
  const objects = [...text.matchAll(/(\d+)\s+0\s+obj\b/g)].map((match) => {
    const body = text.slice(match.index + match[0].length, text.indexOf('endobj', match.index));
    return [match[1]!, body.trim().replace(/^<<|>>$/g, '')] as const;
  });
  const [fieldId, fieldBody] = objects
    .filter(
      ([, body]) =>
        /\/FT\s*\/Sig\b/.test(body) &&
        body.includes(`(${SIGNATURE_FIELD})`) &&
        !/\bstream\b/.test(body),
    )
    .at(-1)!;
  const signature = size;
  const stamp = `D:${date.replaceAll('-', '')}120000+02'00'`;
  const contents = `<${'0'.repeat(1024)}>`;
  const placeholder = '[0 ********** ********** **********]';
  let update = `\n${signature} 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /Name (Test fixture, not a signature) /M (${stamp}) /ByteRange ${placeholder} /Contents ${contents} >>\nendobj\n`;
  const fieldOffset = bytes.length + update.length;
  update += `${fieldId} 0 obj\n<<${fieldBody.replace(/\/V\s+\d+\s+0\s+R/, '')} /V ${signature} 0 R >>\nendobj\n`;
  const xref = bytes.length + update.length;
  const entry = (offset: number) => `${String(offset).padStart(10, '0')} 00000 n \n`;
  update +=
    `xref\n0 1\n0000000000 65535 f \n${signature} 1\n${entry(bytes.length + 1)}${fieldId} 1\n${entry(fieldOffset)}` +
    `trailer\n<< /Size ${size + 1} /Root ${root}${info ? ` /Info ${info}` : ''} /Prev ${prev} >>\nstartxref\n${xref}\n%%EOF\n`;
  const whole = text + update;
  const start = whole.lastIndexOf(contents);
  const end = start + contents.length;
  const numbers = [start, end, whole.length - end].map((n) => String(n).padStart(10, ' '));
  const signed = whole.replace(placeholder, `[0 ${numbers.join(' ')}]`);
  return new Uint8Array(Buffer.from(signed, 'latin1'));
}
