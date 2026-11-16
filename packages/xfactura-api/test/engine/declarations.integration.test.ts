import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { z } from 'zod';
import { sha256Hex } from 'xfactura-core/hash';
import { sha256 } from '../../source/engine/adapters/object-store';
import type { ActionView } from '../../source/engine/kernel/actions';
import {
  DukIntegrator,
  dukConfigFolder,
  type DeclarationValidator,
} from '../../source/engine/adapters/declaration-validator';
import type { DeclarationKind } from '../../source/engine/modules/declarations';
import { loadState } from '../../source/engine/kernel/state';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

/** A stand-in return over the VAT ledger of a month; the D300 tests use the real one. */
const testReturn: DeclarationKind = {
  kind: 'T300',
  description: 'Declarație de test',
  tax: 'VAT',
  period: z.string().regex(/^\d{4}-\d{2}$/),
  format: (period) => (period >= '2026-01' ? 'T300-1' : null),
  inputs: async (tx, companyId, period) =>
    (await loadState(tx, companyId, { taxPeriods: [{ tax: 'VAT', period }] })).readSet,
  async prepare(tx, companyId, period, options) {
    const { loaded, readSet } = await loadState(tx, companyId, {
      taxPeriods: [{ tax: 'VAT', period }],
    });
    const entries = loaded.taxLedger.get(`VAT|${period}`)?.entries.length ?? 0;
    return {
      xml: `<t300 period="${period}" entries="${entries}"${options.broken ? ' broken="1"' : ''}/>`,
      inputs: readSet,
      problems: [],
      summary: { entries },
    };
  },
  options: z.object({ broken: z.boolean().default(false) }).strict(),
};
const validator: DeclarationValidator = {
  id: 'validator de test',
  validate: async (_kind, xml) =>
    new TextDecoder().decode(xml).includes('broken')
      ? { ok: false, messages: ['E: câmp invalid'] }
      : { ok: true, messages: [] },
  pdf: async (_kind, xml) => ({ ok: true, messages: [], pdf: pdfWith(xml) }),
};

/** A minimal valid PDF attaching `xml`, as ANAF's tool does; `signed` appends a signature
 * dictionary the way a signer's incremental update does. */
function pdfWith(xml: Uint8Array, signed = false) {
  const objects = [
    Buffer.concat([
      Buffer.from(`1 0 obj\n<< /Type /EmbeddedFile /Length ${xml.length} >>\nstream\n`),
      xml,
      Buffer.from('\nendstream\nendobj\n'),
    ]),
    Buffer.from(
      '2 0 obj\n<< /Type /Filespec /F (t300.xml) /UF (t300.xml) /EF << /F 1 0 R /UF 1 0 R >> >>\nendobj\n',
    ),
    Buffer.from('3 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n'),
    Buffer.from('4 0 obj\n<< /Type /Page /Parent 3 0 R /MediaBox [0 0 100 100] >>\nendobj\n'),
    Buffer.from(
      '5 0 obj\n<< /Type /Catalog /Pages 3 0 R /Names << /EmbeddedFiles << /Names [(t300.xml) 2 0 R] >> >> >>\nendobj\n',
    ),
  ];
  const header = Buffer.from('%PDF-1.4\n');
  let offset = header.length;
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(offset);
    offset += obj.length;
  }
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 5 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return new Uint8Array(
    Buffer.concat([
      header,
      ...objects,
      Buffer.from(xref),
      ...(signed
        ? [
            Buffer.from(
              '\n99 0 obj\n<< /Type /Sig /ByteRange [0 0 0 0] /Contents <00> >>\nendobj\n%%EOF\n',
            ),
          ]
        : []),
    ]),
  );
}

type Artifact = {
  id: string;
  state: string;
  evidenceId: string;
  steps: {
    state: string;
    actor: string | null;
    detail: string | null;
    evidenceId: string | null;
  }[];
};

async function company() {
  const s = await scenario({ declarations: [testReturn], declarationValidator: validator });
  open.push(s);
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
    evidenceId: (await s.evidence('certificat.pdf')).id,
  });
  const sale = async (input: XmlInput) => {
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: `${input.number}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(invoiceXml({ direction: 'sale', ...input })).toString('base64'),
    });
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId: id });
    return s.propose('invoices.recognize', { documentId: document.id, account: '704' });
  };
  const prepare = (period = '2026-10', options = {}) =>
    s.invoke<Artifact>(s.owner, 'declarations.prepare', { kind: 'T300', period, options });
  const authorize = async (artifactId: string) => {
    const request = await s.invoke<ActionView>(s.owner, 'declarations.authorize.request', {
      artifactId,
    });
    return request;
  };
  return { s, sale, prepare, authorize };
}

/** Approves and executes a reviewed action as the reviewer. */
async function authorized(s: Scenario, request: ActionView) {
  await s.invoke(s.reviewer, 'actions.approve', {
    id: request.id,
    previewHash: request.previewHash,
  });
  return s.invoke(s.reviewer, 'actions.execute', { id: request.id });
}

describe('declarations', () => {
  test('a validated return, authorized on its exact XML, locks its tax period', async () => {
    const { s, sale, prepare, authorize } = await company();
    await s.post(await s.approve(await sale({ number: 'V-1' })));
    const prepared = await prepare();
    expect(prepared.state).toBe('validated_official');
    expect(prepared.steps.at(-1)?.actor).toBe('validator de test');
    const request = await authorize(prepared.id);
    await s.invoke(s.reviewer, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    await s.invoke(s.reviewer, 'actions.execute', { id: request.id });
    const late = await sale({ number: 'V-2', date: '2026-10-20' });
    expect(late.issues.map((issue) => issue.code)).toContain('TAX_PERIOD_LOCKED');

    const exported = await s.invoke<Artifact>(s.owner, 'declarations.pdf', {
      artifactId: prepared.id,
    });
    expect(exported.state).toBe('exported_for_signing');
  });

  test('a return whose books changed after preparation cannot be authorized', async () => {
    const { s, sale, prepare, authorize } = await company();
    await s.post(await s.approve(await sale({ number: 'V-3' })));
    const prepared = await prepare();
    await s.post(await s.approve(await sale({ number: 'V-4', date: '2026-10-21' })));
    const request = await authorize(prepared.id);
    expect(
      (request.preview as { findings: { code: string }[] }).findings.map((item) => item.code),
    ).toEqual(['STALE']);
    expect(
      (
        await s.refused(
          s.invoke(s.reviewer, 'actions.approve', {
            id: request.id,
            previewHash: request.previewHash,
          }),
        )
      )?.code,
    ).toBeDefined();
  });

  test("a return ANAF's validator rejects keeps its messages and cannot be authorized", async () => {
    const { prepare, authorize } = await company();
    const failed = await prepare('2026-10', { broken: true });
    expect(failed.state).toBe('validation_failed');
    expect(failed.steps.at(-1)?.detail).toBe('E: câmp invalid');
    const request = await authorize(failed.id);
    expect(
      (request.preview as { findings: { code: string }[] }).findings.map((item) => item.code),
    ).toEqual(['NOT_VALIDATED']);
  });

  test.each([false, true])(
    'the signed PDF must carry the authorized XML; object streams: %s',
    async (objectStreams) => {
      const { s, sale, prepare, authorize } = await company();
      await s.post(await s.approve(await sale({ number: 'V-7' })));
      const prepared = await prepare();
      await authorized(s, await authorize(prepared.id));
      await s.invoke(s.owner, 'declarations.pdf', { artifactId: prepared.id });
      const xml = (await s.engine.evidence.read(s.owner, prepared.evidenceId)).bytes;
      const pdf = async (bytes: Uint8Array, name: string) =>
        (
          await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
            filename: name,
            mediaType: 'application/pdf',
            base64: Buffer.from(bytes).toString('base64'),
          })
        ).id;
      const importSigned = async (bytes: Uint8Array, name: string) =>
        s.invoke(s.owner, 'declarations.importSigned', {
          artifactId: prepared.id,
          evidenceId: await pdf(bytes, name),
        });
      const signedPdf = async (content: Uint8Array, signed = true) => {
        if (!objectStreams) return pdfWith(content, signed);
        const document = await PDFDocument.create();
        document.addPage();
        await document.attach(content, 't300.xml');
        return Buffer.concat([
          await document.save({ useObjectStreams: true }),
          Buffer.from(
            signed ? '\n99 0 obj\n<< /Type /Sig /ByteRange [0 0 0 0] >>\nendobj\n%%EOF\n' : '',
          ),
        ]);
      };
      expect(
        (await s.refused(importSigned(await signedPdf(xml, false), 'nesemnat.pdf')))?.code,
      ).toBe('NOT_SIGNED');
      const other = new TextEncoder().encode('<t300 period="2026-10" entries="9"/>');
      expect((await s.refused(importSigned(await signedPdf(other), 'altul.pdf')))?.code).toBe(
        'SIGNED_MISMATCH',
      );
      await importSigned(await signedPdf(xml), 'semnat.pdf');
      await s.invoke(s.owner, 'declarations.recordSubmission', {
        artifactId: prepared.id,
        registrationNumber: 'INTERNT-123456789-2026',
        submittedOn: '2026-11-20',
        receiptEvidenceId: (await s.evidence('recipisa.pdf')).id,
      });
      await s.invoke(s.owner, 'declarations.recordOutcome', {
        artifactId: prepared.id,
        outcome: 'accepted',
        evidenceId: (await s.evidence('confirmare.pdf')).id,
      });
      const [filed] = await s.list<Artifact>(s.owner, 'declarations.list');
      expect(filed!.steps.map((step) => step.state)).toEqual([
        'prepared',
        'validated_official',
        'authorized',
        'exported_for_signing',
        'signed_imported',
        'submitted',
        'accepted',
      ]);
      expect(filed!.steps[5]!.actor).toBe('INTERNT-123456789-2026');
    },
  );

  test.each(['empty', 'extra', 'same-name', 'page-annotation', 'orphan'] as const)(
    'signed import refuses the attachment failure: %s',
    async (kind) => {
      for (const objectStreams of [false, true]) {
        const { s, prepare, authorize } = await company();
        const prepared = await prepare();
        await authorized(s, await authorize(prepared.id));
        await s.invoke(s.owner, 'declarations.pdf', { artifactId: prepared.id });
        const xml = (await s.engine.evidence.read(s.owner, prepared.evidenceId)).bytes;
        const other = Buffer.from('<evil/>');
        const document = await PDFDocument.create();
        const page = document.addPage();
        if (kind === 'empty') {
          // PDF without attachments.
        } else if (kind === 'orphan') {
          await document.attach(other, 't300.xml');
          const orphanStream = document.context.register(
            document.context.flateStream(xml, { Type: 'EmbeddedFile' }),
          );
          document.context.register(
            document.context.obj({
              Type: 'Filespec',
              F: PDFString.of('orphan.xml'),
              EF: { F: orphanStream },
            }),
          );
        } else if (kind === 'page-annotation') {
          await document.attach(xml, 't300.xml');
          const ef = document.context.register(
            document.context.flateStream(Buffer.from('extra'), { Type: 'EmbeddedFile' }),
          );
          const fs = document.context.register(
            document.context.obj({ Type: 'Filespec', F: PDFString.of('annot.txt'), EF: { F: ef } }),
          );
          const annot = document.context.register(
            document.context.obj({
              Type: 'Annot',
              Subtype: 'FileAttachment',
              Rect: [0, 0, 12, 12],
              FS: fs,
            }),
          );
          page.node.set(PDFName.of('Annots'), document.context.obj([annot]));
        } else if (kind === 'same-name') {
          await document.attach(xml, 't300.xml');
          const ef = document.context.register(
            document.context.flateStream(other, { Type: 'EmbeddedFile' }),
          );
          const fs = document.context.register(
            document.context.obj({ Type: 'Filespec', F: PDFString.of('t300.xml'), EF: { F: ef } }),
          );
          const annot = document.context.register(
            document.context.obj({
              Type: 'Annot',
              Subtype: 'FileAttachment',
              Rect: [0, 0, 12, 12],
              FS: fs,
            }),
          );
          page.node.set(PDFName.of('Annots'), document.context.obj([annot]));
        } else {
          await document.attach(xml, 't300.xml');
          await document.attach(other, 'extra.xml');
        }
        const content = Buffer.concat([
          await document.save({ useObjectStreams: objectStreams }),
          Buffer.from('\n99 0 obj\n<< /Type /Sig /ByteRange [0 0 0 0] >>\nendobj\n%%EOF\n'),
        ]);
        const evidence = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
          filename: 'attack.pdf',
          mediaType: 'application/pdf',
          base64: content.toString('base64'),
        });
        const refusal = await s.refused(
          s.invoke(s.owner, 'declarations.importSigned', {
            artifactId: prepared.id,
            evidenceId: evidence.id,
          }),
        );
        if (kind === 'empty' || kind === 'orphan') {
          expect(refusal?.code).toBe('SIGNED_MISMATCH');
        } else {
          expect(refusal?.code).toBe('SIGNED_EXTRA_ATTACHMENT');
          expect(refusal?.message).toContain('1');
          expect(refusal?.message).toContain(
            kind === 'same-name'
              ? 't300.xml'
              : kind === 'page-annotation'
                ? 'annot.txt'
                : 'extra.xml',
          );
        }
      }
    },
  );

  test('listed forms accept ANAF extra attachments and record their hashes; unlisted extras are refused', async () => {
    const s1005Test: DeclarationKind = {
      ...testReturn,
      kind: 'S1005',
      description: 'Situație anuală de test',
      tax: null,
      period: z.string().regex(/^\d{4}$/),
      format: (period) => (period === '2025' ? 'S1005-1' : null),
      inputs: async () => [],
      async prepare(_tx, _companyId, period) {
        return {
          xml: `<s1005 an="${period}"/>`,
          inputs: [],
          problems: [],
          summary: null,
        };
      },
    };
    const buildSigned = async (attachments: [string, Uint8Array][]) => {
      const doc = await PDFDocument.create();
      doc.addPage();
      for (const [name, content] of attachments) await doc.attach(content, name);
      return Buffer.concat([
        await doc.save({ useObjectStreams: true }),
        Buffer.from('\n99 0 obj\n<< /Type /Sig /ByteRange [0 0 0 0] >>\nendobj\n%%EOF\n'),
      ]);
    };
    const signAndImport = async (mode: 'xml-only' | 'xml-and-zip' | 'xml-zip-and-extra') => {
      const s = await scenario({ declarations: [s1005Test], declarationValidator: validator });
      open.push(s);
      const prepared = await s.invoke<Artifact>(s.owner, 'declarations.prepare', {
        kind: 'S1005',
        period: '2025',
      });
      await authorized(
        s,
        await s.invoke<ActionView>(s.owner, 'declarations.authorize.request', {
          artifactId: prepared.id,
        }),
      );
      await s.invoke(s.owner, 'declarations.pdf', { artifactId: prepared.id });
      const xml = (await s.engine.evidence.read(s.owner, prepared.evidenceId)).bytes;
      const zipBytes = Buffer.from('PK\x03\x04synthetic-zip');
      const entries: [string, Uint8Array][] = [['s1005.xml', xml]];
      if (mode !== 'xml-only') entries.push(['anexe.zip', zipBytes]);
      if (mode === 'xml-zip-and-extra') entries.push(['extra.txt', Buffer.from('unexpected')]);
      const pdfBytes = await buildSigned(entries);
      const { id: evidenceId } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
        filename: 's1005-semnat.pdf',
        mediaType: 'application/pdf',
        base64: pdfBytes.toString('base64'),
      });
      return { s, prepared, zipBytes, evidenceId };
    };

    const xmlOnly = await signAndImport('xml-only');
    await xmlOnly.s.invoke(xmlOnly.s.owner, 'declarations.importSigned', {
      artifactId: xmlOnly.prepared.id,
      evidenceId: xmlOnly.evidenceId,
    });

    const withZip = await signAndImport('xml-and-zip');
    await withZip.s.invoke(withZip.s.owner, 'declarations.importSigned', {
      artifactId: withZip.prepared.id,
      evidenceId: withZip.evidenceId,
    });
    const [imported] = await withZip.s.list<Artifact>(withZip.s.owner, 'declarations.list');
    const step = imported!.steps.find((item) => item.state === 'signed_imported');
    expect(step?.detail).toContain('anexe.zip');
    expect(step?.detail).toContain(sha256(withZip.zipBytes));

    const withExtra = await signAndImport('xml-zip-and-extra');
    const refusal = await withExtra.s.refused(
      withExtra.s.invoke(withExtra.s.owner, 'declarations.importSigned', {
        artifactId: withExtra.prepared.id,
        evidenceId: withExtra.evidenceId,
      }),
    );
    expect(refusal?.code).toBe('SIGNED_EXTRA_ATTACHMENT');
    expect(refusal?.message).toContain('1');
    expect(refusal?.message).toContain('extra.txt');
  });

  test('S1005 refuses a .zip without an archive signature, and S1003 accepts a RAR named .zip', async () => {
    const s1005Kind: DeclarationKind = {
      ...testReturn,
      kind: 'S1005',
      description: 'Situație anuală de test',
      tax: null,
      period: z.string().regex(/^\d{4}$/),
      format: (period) => (period === '2025' ? 'S1005-1' : null),
      inputs: async () => [],
      async prepare(_tx, _companyId, period) {
        return { xml: `<s1005 an="${period}"/>`, inputs: [], problems: [], summary: null };
      },
    };
    const s1003Kind: DeclarationKind = {
      ...s1005Kind,
      kind: 'S1003',
      format: (period) => (period === '2025' ? 'S1003-1' : null),
      async prepare(_tx, _companyId, period) {
        return { xml: `<s1003 an="${period}"/>`, inputs: [], problems: [], summary: null };
      },
    };
    const buildSigned = async (attachments: [string, Uint8Array][]) => {
      const doc = await PDFDocument.create();
      doc.addPage();
      for (const [name, content] of attachments) await doc.attach(content, name);
      return Buffer.concat([
        await doc.save({ useObjectStreams: true }),
        Buffer.from('\n99 0 obj\n<< /Type /Sig /ByteRange [0 0 0 0] >>\nendobj\n%%EOF\n'),
      ]);
    };

    const s5 = await scenario({ declarations: [s1005Kind], declarationValidator: validator });
    open.push(s5);
    const prep5 = await s5.invoke<Artifact>(s5.owner, 'declarations.prepare', {
      kind: 'S1005',
      period: '2025',
    });
    await authorized(
      s5,
      await s5.invoke<ActionView>(s5.owner, 'declarations.authorize.request', {
        artifactId: prep5.id,
      }),
    );
    await s5.invoke(s5.owner, 'declarations.pdf', { artifactId: prep5.id });
    const xml5 = (await s5.engine.evidence.read(s5.owner, prep5.evidenceId)).bytes;
    const spoofedZipPdf = await buildSigned([
      ['s1005.xml', xml5],
      ['anexe.ZIP', Buffer.from('<s1005 an="2025" spoof="1"/>')],
    ]);
    const spoofedEvidence = await s5.invoke<{ id: string }>(s5.owner, 'evidence.record', {
      filename: 'spoof.pdf',
      mediaType: 'application/pdf',
      base64: spoofedZipPdf.toString('base64'),
    });
    const refused = await s5.refused(
      s5.invoke(s5.owner, 'declarations.importSigned', {
        artifactId: prep5.id,
        evidenceId: spoofedEvidence.id,
      }),
    );
    expect(refused?.code).toBe('SIGNED_EXTRA_ATTACHMENT');
    expect(refused?.message).toContain('anexe.ZIP');

    const s3 = await scenario({ declarations: [s1003Kind], declarationValidator: validator });
    open.push(s3);
    const prep3 = await s3.invoke<Artifact>(s3.owner, 'declarations.prepare', {
      kind: 'S1003',
      period: '2025',
    });
    await authorized(
      s3,
      await s3.invoke<ActionView>(s3.owner, 'declarations.authorize.request', {
        artifactId: prep3.id,
      }),
    );
    await s3.invoke(s3.owner, 'declarations.pdf', { artifactId: prep3.id });
    const xml3 = (await s3.engine.evidence.read(s3.owner, prep3.evidenceId)).bytes;
    const rarBytes = Buffer.from('Rar!\x1a\x07\x00synthetic-rar');
    const rarPdf = await buildSigned([
      ['s1003.xml', xml3],
      ['anexe.zip', rarBytes],
    ]);
    const rarEvidence = await s3.invoke<{ id: string }>(s3.owner, 'evidence.record', {
      filename: 's1003.pdf',
      mediaType: 'application/pdf',
      base64: rarPdf.toString('base64'),
    });
    await s3.invoke(s3.owner, 'declarations.importSigned', {
      artifactId: prep3.id,
      evidenceId: rarEvidence.id,
    });
    const [imported3] = await s3.list<Artifact>(s3.owner, 'declarations.list');
    const step3 = imported3!.steps.find((item) => item.state === 'signed_imported');
    expect(step3?.detail).toContain('anexe.zip');
    expect(step3?.detail).toContain(sha256(rarBytes));
  });

  test('importSigned replays the same key and input, refuses different input, and checks ambiguous, duplicate-location and 20-file messages', async () => {
    const { s, prepare, authorize } = await company();
    const prepared = await prepare();
    await authorized(s, await authorize(prepared.id));
    await s.invoke(s.owner, 'declarations.pdf', { artifactId: prepared.id });
    const xml = (await s.engine.evidence.read(s.owner, prepared.evidenceId)).bytes;

    // 1. Ambiguous PDF (collapsed name-tree entries) is refused with SIGNED_PDF_AMBIGUOUS.
    const utf16Key = PDFHexString.fromText('t300.xml').toString();
    const ambigObjects = [
      Buffer.concat([
        Buffer.from(`1 0 obj\n<< /Type /EmbeddedFile /Length ${xml.length} >>\nstream\n`),
        xml,
        Buffer.from('\nendstream\nendobj\n'),
      ]),
      Buffer.from(
        '2 0 obj\n<< /Type /Filespec /F (t300.xml) /UF (t300.xml) /EF << /F 1 0 R /UF 1 0 R >> >>\nendobj\n',
      ),
      Buffer.from('3 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n'),
      Buffer.from('4 0 obj\n<< /Type /Page /Parent 3 0 R /MediaBox [0 0 100 100] >>\nendobj\n'),
      Buffer.from(
        `5 0 obj\n<< /Type /Catalog /Pages 3 0 R /Names << /EmbeddedFiles << /Names [(t300.xml) 2 0 R ${utf16Key} 6 0 R] >> >> >>\nendobj\n`,
      ),
      Buffer.from(
        '6 0 obj\n<< /Type /Filespec /F (t300.xml) /UF (t300.xml) /EF << /F 7 0 R /UF 7 0 R >> >>\nendobj\n',
      ),
      Buffer.from(
        '7 0 obj\n<< /Type /EmbeddedFile /Length 7 >>\nstream\n<evil/>\nendstream\nendobj\n',
      ),
    ];
    let offset = Buffer.byteLength('%PDF-1.4\n');
    const ambigOffsets: number[] = [];
    for (const obj of ambigObjects) {
      ambigOffsets.push(offset);
      offset += obj.length;
    }
    const ambigPdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      ...ambigObjects,
      Buffer.from(
        `xref\n0 8\n0000000000 65535 f \n${ambigOffsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 5 0 R >>\nstartxref\n${offset}\n%%EOF\n\n99 0 obj\n<< /Type /Sig /ByteRange [0 0 0 0] >>\nendobj\n%%EOF\n`,
      ),
    ]);
    const ambigEv = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'ambig.pdf',
      mediaType: 'application/pdf',
      base64: ambigPdf.toString('base64'),
    });
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'declarations.importSigned', {
            artifactId: prepared.id,
            evidenceId: ambigEv.id,
          }),
        )
      )?.code,
    ).toBe('SIGNED_PDF_AMBIGUOUS');

    // 2. Twenty extras trigger Romanian "20 de atașamente suplimentare nepermise" agreement.
    const twentyDoc = await PDFDocument.create();
    twentyDoc.addPage();
    await twentyDoc.attach(xml, 't300.xml');
    for (let i = 0; i < 20; i++) await twentyDoc.attach(Buffer.from(`e-${i}`), `extra-${i}.txt`);
    const twentyPdf = Buffer.concat([
      await twentyDoc.save({ useObjectStreams: true }),
      Buffer.from('\n99 0 obj\n<< /Type /Sig /ByteRange [0 0 0 0] >>\nendobj\n%%EOF\n'),
    ]);
    const twentyEv = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'twenty.pdf',
      mediaType: 'application/pdf',
      base64: twentyPdf.toString('base64'),
    });
    const twentyRefused = await s.refused(
      s.invoke(s.owner, 'declarations.importSigned', {
        artifactId: prepared.id,
        evidenceId: twentyEv.id,
      }),
    );
    expect(twentyRefused?.code).toBe('SIGNED_EXTRA_ATTACHMENT');
    expect(twentyRefused?.message).toContain('20 de atașamente suplimentare nepermise');

    // 3. Same file reached from both EmbeddedFiles and a page annotation (same name and bytes) is accepted.
    const sharedDoc = await PDFDocument.create();
    const sharedPage = sharedDoc.addPage();
    const sharedStream = sharedDoc.context.register(
      sharedDoc.context.flateStream(xml, { Type: 'EmbeddedFile' }),
    );
    const sharedSpec = sharedDoc.context.register(
      sharedDoc.context.obj({
        Type: 'Filespec',
        F: PDFString.of('t300.xml'),
        UF: PDFString.of('t300.xml'),
        EF: { F: sharedStream, UF: sharedStream },
      }),
    );
    sharedDoc.catalog.set(
      PDFName.of('Names'),
      sharedDoc.context.obj({
        EmbeddedFiles: { Names: [PDFString.of('t300.xml'), sharedSpec] },
      }),
    );
    const sharedAnnot = sharedDoc.context.register(
      sharedDoc.context.obj({
        Type: 'Annot',
        Subtype: 'FileAttachment',
        Rect: [0, 0, 12, 12],
        FS: sharedSpec,
      }),
    );
    sharedPage.node.set(PDFName.of('Annots'), sharedDoc.context.obj([sharedAnnot]));
    const sharedPdf = Buffer.concat([
      await sharedDoc.save({ useObjectStreams: true }),
      Buffer.from('\n99 0 obj\n<< /Type /Sig /ByteRange [0 0 0 0] >>\nendobj\n%%EOF\n'),
    ]);
    const sharedEv = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'shared.pdf',
      mediaType: 'application/pdf',
      base64: sharedPdf.toString('base64'),
    });
    const otherEv = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'other.pdf',
      mediaType: 'application/pdf',
      base64: Buffer.from(pdfWith(xml, true)).toString('base64'),
    });

    const idempotencyKey = 'import-signed-replay-key';
    const first = await s.invoke<{ artifactId: string }>(
      s.owner,
      'declarations.importSigned',
      { artifactId: prepared.id, evidenceId: sharedEv.id },
      idempotencyKey,
    );
    expect(first).toEqual({ artifactId: prepared.id });

    // 4. Replay with the same key and same input returns the stored result even after signed_imported.
    const replay = await s.invoke<{ artifactId: string }>(
      s.owner,
      'declarations.importSigned',
      { artifactId: prepared.id, evidenceId: sharedEv.id },
      idempotencyKey,
    );
    expect(replay).toEqual(first);

    // 5. Different input under the same key gives IDEMPOTENCY_CONFLICT.
    expect(
      (
        await s.refused(
          s.invoke(
            s.owner,
            'declarations.importSigned',
            { artifactId: prepared.id, evidenceId: otherEv.id },
            idempotencyKey,
          ),
        )
      )?.code,
    ).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('a filed period reopens only by review, and its rectification supersedes the return', async () => {
    const { s, sale, prepare, authorize } = await company();
    await s.post(await s.approve(await sale({ number: 'V-8' })));
    const prepared = await prepare();
    await authorized(s, await authorize(prepared.id));
    const blocked = await sale({ number: 'V-9', date: '2026-10-25' });
    expect(blocked.issues.map((issue) => issue.code)).toContain('TAX_PERIOD_LOCKED');
    const reopen = await s.invoke<ActionView>(s.owner, 'declarations.reopen.request', {
      artifactId: prepared.id,
      reason: 'Factura V-9 lipsea din decont',
    });
    await authorized(s, reopen);
    const [document] = (
      await s.list<{ id: string; number: string }>(s.owner, 'documents.list')
    ).filter((item) => item.number === 'V-9');
    const late = await s.revise('invoices.recognize', blocked, {
      documentId: document!.id,
      account: '704',
    });
    expect(late.issues.map((issue) => issue.code)).not.toContain('TAX_PERIOD_LOCKED');
    await s.post(await s.approve(late));
    const rectification = await s.invoke<Artifact>(s.owner, 'declarations.prepare', {
      kind: 'T300',
      period: '2026-10',
      supersedesId: prepared.id,
    });
    expect(rectification.state).toBe('validated_official');
    const all = await s.list<Artifact>(s.owner, 'declarations.list');
    expect(all.find((item) => item.id === prepared.id)?.state).toBe('superseded');
  });

  test('a period without a pinned format is a format gap, and only people authorize', async () => {
    const { s, prepare } = await company();
    expect((await s.refused(prepare('2025-12')))?.code).toBe('FORMAT_GAP');
    const operation = s.engine.operations.get('declarations.authorize.request');
    expect([operation.agent, operation.permission]).toEqual([false, 'review']);
  });
});

describe("ANAF's DUKIntegrator", () => {
  const files = { input: '/in/D300.xml', result: '/out/result.txt', output: '/out/D300.pdf' };

  test('runs with its config folder, given first, as DUKIntegrator reads it', () => {
    expect(DukIntegrator.command('/kit', '/config', '-v', 'D300', files)).toEqual([
      '-Djava.awt.headless=true',
      '-jar',
      '/kit/DUKIntegrator.jar',
      '-c',
      '/config',
      '-v',
      'D300',
      '/in/D300.xml',
      '/out/result.txt',
    ]);
    expect(DukIntegrator.command('/kit', '/config', '-p', 'D300', files).slice(3)).toEqual([
      '-c',
      '/config',
      '-p',
      'D300',
      '/in/D300.xml',
      '/out/result.txt',
      '0',
      '0',
      '/out/D300.pdf',
    ]);
  });

  test("the kit's config, without the wait before exit, outside the kit and private", async () => {
    const kit = await mkdtemp(path.join(tmpdir(), 'xfactura-kit-'));
    try {
      await mkdir(path.join(kit, 'config'));
      const own = `proxy=auto\ntipDeclaratie=D112\nkit=${kit}\n`;
      await writeFile(path.join(kit, 'config', 'config.properties'), own);
      const folder = await dukConfigFolder(kit);
      expect(await dukConfigFolder(kit)).toBe(folder);
      expect(path.relative(kit, folder).startsWith('..')).toBe(true);
      expect(await readFile(path.join(folder, 'config.properties'), 'utf8')).toBe(
        `${own}\nmaxWaitBeforeExitMillis=0\n`,
      );
      expect(await readFile(path.join(kit, 'config', 'config.properties'), 'utf8')).toBe(own);
      expect((await stat(folder)).mode & 0o077).toBe(0);
      // Removed by a cleaning of the temporary directory, it is made again.
      await rm(folder, { recursive: true, force: true });
      expect(await dukConfigFolder(kit)).toBe(folder);
      expect(await readFile(path.join(folder, 'config.properties'), 'utf8')).toBe(
        `${own}\nmaxWaitBeforeExitMillis=0\n`,
      );
      await rm(folder, { recursive: true, force: true });

      // A folder of that name others may write to is not used.
      const other = path.join(kit, 'other');
      await mkdir(path.join(other, 'config'), { recursive: true });
      const theirs = `kit=${other}\n`;
      await writeFile(path.join(other, 'config', 'config.properties'), theirs);
      const properties = `${theirs}\nmaxWaitBeforeExitMillis=0\n`;
      const shared = path.join(
        tmpdir(),
        `xfactura-duk-config-${sha256Hex(`${process.getuid?.() ?? ''}\n${properties}`).slice(0, 16)}`,
      );
      await mkdir(shared);
      await chmod(shared, 0o777);
      const used = await dukConfigFolder(other);
      expect(used).not.toBe(shared);
      expect(await readFile(path.join(used, 'config.properties'), 'utf8')).toBe(properties);
      await Promise.all([shared, used].map((dir) => rm(dir, { recursive: true, force: true })));
    } finally {
      await rm(kit, { recursive: true, force: true });
    }
  });
});
