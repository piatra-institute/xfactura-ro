import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import type { ActionView } from '../../source/engine/kernel/actions';
import { DukIntegrator } from '../../source/engine/adapters/declaration-validator';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

const dist = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
const official = DukIntegrator.available(dist) && Bun.which('java') ? test : test.skip;
const cui = '18547290';
const options = {
  declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
  caen: '6201',
  bank: 'Banca Exemplu',
  account: 'RO49AAAA1B31007593840000',
};
type Artifact = { id: string; state: string; steps: { state: string; detail: string | null }[] };

async function company(validator?: DukIntegrator) {
  const s = await scenario({ cui, ...(validator ? { declarationValidator: validator } : {}) });
  open.push(s);
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
    evidenceId: (await s.evidence('certificat.pdf')).id,
  });
  await s.invoke(s.owner, 'sales.seller.record', {
    details: {
      name: 'Exemplu Servicii SRL',
      vatId: `RO${cui}`,
      address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
    },
  });
  const book = async (input: XmlInput, account: string, deduction?: 'full' | 'none') => {
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: `${input.number}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(invoiceXml({ company: cui, ...input })).toString('base64'),
    });
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId: id });
    return s.book('invoices.recognize', {
      documentId: document.id,
      account,
      ...(deduction ? { deduction } : {}),
    });
  };
  const prepare = (period = '2026-10') =>
    s.invoke<Artifact>(s.owner, 'declarations.prepare', { kind: 'D300', period, options });
  return { s, book, prepare };
}

const rows = (artifact: Artifact) =>
  (JSON.parse(artifact.steps[0]!.detail!) as { rows: Record<string, number> }).rows;

describe('D300 from the books', () => {
  test('collected VAT by rate, purchases with all their VAT, and the VAT deducted, in whole lei', async () => {
    const { book, prepare } = await company();
    await book(
      { number: 'V-1', direction: 'sale', net: '1000.40', tax: '210.08', gross: '1210.48' },
      '704',
    );
    await book({ number: 'F-1', net: '500.00', tax: '105.00', gross: '605.00' }, '628');
    await book({ number: 'F-2', net: '100.00', tax: '21.00', gross: '121.00' }, '623', 'none');
    const prepared = await prepare();
    expect(prepared.state).toBe('prepared');
    expect(rows(prepared)).toEqual({ R9_1: 1000, R9_2: 210, R22_1: 600, R22_2: 126, R28_2: 105 });
  });

  test('refuses a period of the wrong kind or a company without its details', async () => {
    const { s, book, prepare } = await company();
    await book({ number: 'V-2', direction: 'sale' }, '704');
    expect((await s.refused(prepare('2026-Q4')))?.code).toBe('VAT_PERIOD');
    expect((await s.refused(prepare('2025-06')))?.code).toBe('FORMAT_GAP');
  });

  official(
    "passes ANAF's validator, is authorized on its exact XML and exports the PDF to sign",
    async () => {
      const { s, book, prepare } = await company(new DukIntegrator(dist));
      await book({ number: 'V-3', direction: 'sale' }, '704');
      await book({ number: 'F-3', net: '50.00', tax: '10.50', gross: '60.50' }, '628');
      const prepared = await prepare();
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
      const request = await s.invoke<ActionView>(s.owner, 'declarations.authorize.request', {
        artifactId: prepared.id,
      });
      await s.invoke(s.reviewer, 'actions.approve', {
        id: request.id,
        previewHash: request.previewHash,
      });
      await s.invoke(s.reviewer, 'actions.execute', { id: request.id });
      const exported = await s.invoke<Artifact & { steps: { state: string }[] }>(
        s.owner,
        'declarations.pdf',
        {
          artifactId: prepared.id,
        },
      );
      expect(exported.state).toBe('exported_for_signing');
    },
    120_000,
  );
});
