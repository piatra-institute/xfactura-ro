import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { ActionView } from '../../source/engine/kernel/actions';
import type { DeclarationValidator } from '../../source/engine/adapters/declaration-validator';
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

/** A minimal PDF attaching `xml`, as ANAF's tool does; `signed` appends a signature dictionary
 * the way a signer's incremental update does. */
function pdfWith(xml: Uint8Array, signed = false) {
  const head = `%PDF-1.4\n1 0 obj\n<< /Type /EmbeddedFile /Length ${xml.length} >>\nstream\n`;
  const tail =
    '\nendstream\nendobj\n2 0 obj\n<< /Type /Filespec /F (t300.xml) /UF (t300.xml) /EF << /F 1 0 R /UF 1 0 R >> >>\nendobj\n' +
    (signed ? '3 0 obj\n<< /Type /Sig /ByteRange [0 0 0 0] /Contents <00> >>\nendobj\n' : '') +
    '%%EOF\n';
  return new Uint8Array([
    ...new TextEncoder().encode(head),
    ...xml,
    ...new TextEncoder().encode(tail),
  ]);
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

  test('the signed PDF must carry the authorized XML; the filing and the answer are recorded', async () => {
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
    expect((await s.refused(importSigned(pdfWith(xml), 'nesemnat.pdf')))?.code).toBe('NOT_SIGNED');
    const other = new TextEncoder().encode('<t300 period="2026-10" entries="9"/>');
    expect((await s.refused(importSigned(pdfWith(other, true), 'altul.pdf')))?.code).toBe(
      'SIGNED_MISMATCH',
    );
    await importSigned(pdfWith(xml, true), 'semnat.pdf');
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
    const [filed] = await s.invoke<Artifact[]>(s.owner, 'declarations.list');
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
      await s.invoke<{ id: string; number: string }[]>(s.owner, 'documents.list')
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
    const all = await s.invoke<Artifact[]>(s.owner, 'declarations.list');
    expect(all.find((item) => item.id === prepared.id)?.state).toBe('superseded');
  });

  test('a period without a pinned format is a format gap, and only people authorize', async () => {
    const { s, prepare } = await company();
    expect((await s.refused(prepare('2025-12')))?.code).toBe('FORMAT_GAP');
    const operation = s.engine.operations.get('declarations.authorize.request');
    expect([operation.agent, operation.permission]).toEqual([false, 'review']);
  });
});
