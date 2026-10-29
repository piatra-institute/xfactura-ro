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
  pdf: async () => ({ ok: true, messages: [], pdf: new TextEncoder().encode('%PDF-1.4 test') }),
};

type Artifact = {
  id: string;
  state: string;
  steps: { state: string; actor: string | null; detail: string | null }[];
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

  test('a period without a pinned format is a format gap, and only people authorize', async () => {
    const { s, prepare } = await company();
    expect((await s.refused(prepare('2025-12')))?.code).toBe('FORMAT_GAP');
    const operation = s.engine.operations.get('declarations.authorize.request');
    expect([operation.agent, operation.permission]).toEqual([false, 'review']);
  });
});
