import { afterAll, describe, expect, test } from 'bun:test';
import type { DeclarationValidator } from '../../source/engine/adapters/declaration-validator';
import { FakeEFactura } from './fakes/efactura';
import { invoiceXml } from './fixtures/invoice';
import { sellerDetails } from './fixtures/sales';
import { scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

const accept: DeclarationValidator = {
  id: 'validator de test',
  validate: async () => ({ ok: true, messages: [] }),
  pdf: async () => ({ ok: false, messages: [] }),
};

const cui = '18547290';

type Check = {
  rows: { element: string; declared: number; prefilled: number; significant: boolean }[];
  significant: number;
  documents: { notBooked: { number: string }[]; outsideEfactura: { number: string }[] };
};

describe('RO e-TVA', () => {
  test("finds the return's significant differences and the invoices behind them", async () => {
    const fake = new FakeEFactura();
    fake.now = Date.parse('2026-10-31T10:00:00Z');
    const s = await scenario({
      cui,
      efactura: fake,
      clock: () => fake.now,
      declarationValidator: accept,
    });
    open.push(s);
    await s.invoke(s.owner, 'profile.record', {
      axis: 'vat.status',
      value: 'normal_vat',
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence('certificat.pdf')).id,
    });
    await s.invoke(s.owner, 'sales.seller.record', {
      details: { ...sellerDetails, vatId: `RO${cui}` },
    });
    // A purchase ANAF holds through e-Factura, not booked yet.
    fake.deliver(
      cui,
      invoiceXml({
        company: cui,
        number: 'F-SPV',
        date: '2026-10-05',
        net: '10000.00',
        tax: '2100.00',
        gross: '12100.00',
      }),
    );
    await s.invoke(s.owner, 'spv.sync', {
      from: '2026-10-01T00:00:00Z',
      to: new Date(fake.now).toISOString(),
    });
    // A purchase booked from a file received outside e-Factura.
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'F-MAN.xml',
      mediaType: 'application/xml',
      base64: Buffer.from(
        invoiceXml({ company: cui, number: 'F-MAN', date: '2026-10-07' }),
      ).toString('base64'),
    });
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId: id });
    await s.book('invoices.recognize', { documentId: document.id, account: '628' });

    const check = (prefilled: Record<string, number>) =>
      s.invoke<Check>(s.owner, 'vat.etva.check', { period: '2026-10', prefilled });
    expect((await s.refused(check({})))?.code).toBe('D300_MISSING');
    await s.invoke(s.owner, 'declarations.prepare', {
      kind: 'D300',
      period: '2026-10',
      options: {
        declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
        caen: '6201',
        bank: 'Banca Exemplu',
        account: 'RO49AAAA1B31007593840000',
      },
    });
    // The pre-filled return holds the e-Factura purchase; the books hold the other one.
    const result = await check({ R22_1: 10000, R22_2: 2100 });
    expect(result.rows.find((row) => row.element === 'R22_2')).toMatchObject({
      declared: 21,
      prefilled: 2100,
      significant: true,
    });
    expect(result.significant).toBe(1);
    expect(result.documents.notBooked.map((item) => item.number)).toEqual(['F-SPV']);
    expect(result.documents.outsideEfactura.map((item) => item.number)).toEqual(['F-MAN']);
  });
});
