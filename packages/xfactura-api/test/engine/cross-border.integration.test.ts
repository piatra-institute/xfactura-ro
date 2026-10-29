import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import type { ProposalView } from '../../source/engine/kernel/views';
import { DukIntegrator } from '../../source/engine/adapters/declaration-validator';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

// Synthetic documents; expected amounts computed by hand:
//   100.00 EUR at 4.9765 = 497.65 lei; self-assessed VAT 21% = 104.5065 → 104.51.
const bnr = `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher><PublishingDate>2026-10-15</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
<Cube date="2026-10-14"><Rate currency="EUR">4.9765</Rate></Cube>
</Body></DataSet>`;

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});
const dist = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
const official = DukIntegrator.available(dist) && Bun.which('java') ? test : test.skip;
const cui = '18547290';

async function company(validator?: DukIntegrator) {
  const s = await scenario({ cui, ...(validator ? { declarationValidator: validator } : {}) });
  open.push(s);
  const file = async (filename: string, text: string) =>
    (
      await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
        filename,
        mediaType: 'application/xml',
        base64: Buffer.from(text).toString('base64'),
      })
    ).id;
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
    evidenceId: (await s.evidence('certificat.pdf')).id,
  });
  await s.invoke(s.owner, 'fx.importBnr', { evidenceId: await file('nbrfxrates.xml', bnr) });
  const document = async (input: XmlInput) =>
    s.invoke<{ id: string }>(s.owner, 'invoices.import', {
      evidenceId: await file(`${input.number}.xml`, invoiceXml({ company: cui, ...input })),
    });
  const crossBorder = async (input: XmlInput, account: string, deduction?: 'full' | 'none') =>
    s.propose('invoices.crossBorder', {
      documentId: (await document(input)).id,
      account,
      supply: 'services_general_rule',
      ...(deduction ? { deduction } : {}),
    });
  return { s, document, crossBorder };
}

const foreign = (extra: XmlInput): XmlInput => ({
  category: 'AE',
  rate: '0',
  tax: '0.00',
  net: '100.00',
  gross: '100.00',
  date: '2026-10-15',
  ...extra,
});
const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const taxes = (proposal: ProposalView) =>
  proposal.effect?.taxEntries.map(
    (entry) => `${entry.direction} ${entry.code} ${entry.base} ${entry.amount}`,
  );

describe('services across the border', () => {
  test('an EU supplier: the expense, and Romanian VAT self-assessed and deducted', async () => {
    const { crossBorder } = await company();
    const proposal = await crossBorder(
      foreign({ number: 'IE-1', country: 'IE', counterparty: 'IE6388047V', currency: 'EUR' }),
      '628',
    );
    expect(lines(proposal)).toEqual([
      'D 628 497.65',
      'C 401 497.65',
      'C 4427 104.51',
      'D 4426 104.51',
    ]);
    expect(taxes(proposal)).toEqual([
      'output RC-EU-SERV 497.65 104.51',
      'input RC-EU-SERV 497.65 104.51',
    ]);
  });

  test('without deduction, the self-assessed VAT is an expense', async () => {
    const { crossBorder } = await company();
    const proposal = await crossBorder(
      foreign({ number: 'US-1', country: 'US', counterparty: '941234567' }),
      '628',
      'none',
    );
    expect(lines(proposal)).toEqual([
      'D 628 100.00',
      'C 401 100.00',
      'C 4427 21.00',
      'D 628 21.00',
    ]);
    expect(taxes(proposal)).toEqual([
      'output RC-NONEU-SERV 100.00 21.00',
      'input RC-NONEU-SERV 100.00 21.00',
    ]);
  });

  test('a sale to an EU business carries no Romanian VAT; a customer without a VAT code is refused', async () => {
    const { crossBorder } = await company();
    const sale = await crossBorder(
      foreign({ number: 'X-1', direction: 'sale', country: 'DE', counterparty: 'DE123456788' }),
      '704',
    );
    expect(lines(sale)).toEqual(['D 4111 100.00', 'C 704 100.00']);
    expect(taxes(sale)).toEqual(['output EXP-EU-SERV 100.00 0.00']);
    const noVatId = await crossBorder(
      foreign({ number: 'X-2', direction: 'sale', country: 'DE', counterparty: 'HRB12345' }),
      '704',
    );
    expect(noVatId.issues.map((issue) => issue.code)).toContain('CUSTOMER_VAT_ID');
  });

  test('refuses domestic partners and invoices already charging VAT', async () => {
    const { crossBorder } = await company();
    expect(
      (await crossBorder(foreign({ number: 'RO-1' }), '628')).issues.map((issue) => issue.code),
    ).toContain('DOMESTIC');
    const charged = await crossBorder(
      { number: 'IE-2', country: 'IE', counterparty: 'IE6388047V', date: '2026-10-15' },
      '628',
    );
    expect(charged.issues.map((issue) => issue.code)).toContain('VAT_CHARGED');
  });

  official(
    "the D390 lists each EU partner and passes ANAF's validator",
    async () => {
      const { s, crossBorder } = await company(new DukIntegrator(dist));
      await s.invoke(s.owner, 'sales.seller.record', {
        details: {
          name: 'Exemplu Servicii SRL',
          vatId: `RO${cui}`,
          address: {
            lines: ['Str. Lungă 10'],
            city: 'Galați',
            subdivision: 'RO-GL',
            country: 'RO',
          },
        },
      });
      for (const proposal of [
        await crossBorder(
          foreign({ number: 'IE-4', country: 'IE', counterparty: 'IE6388047V', currency: 'EUR' }),
          '628',
        ),
        await crossBorder(
          foreign({ number: 'X-4', direction: 'sale', country: 'DE', counterparty: 'DE123456788' }),
          '704',
        ),
        await crossBorder(
          foreign({
            number: 'X-5',
            direction: 'sale',
            country: 'DE',
            counterparty: 'DE123456788',
            net: '50.00',
            gross: '50.00',
          }),
          '704',
        ),
        await crossBorder(
          foreign({ number: 'US-2', country: 'US', counterparty: '941234567' }),
          '628',
        ),
      ])
        await s.post(await s.approve(proposal));
      const prepared = await s.invoke<{ state: string; steps: { detail: string | null }[] }>(
        s.owner,
        'declarations.prepare',
        {
          kind: 'D390',
          period: '2026-10',
          options: { declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' } },
        },
      );
      expect(JSON.parse(prepared.steps[0]!.detail!).operations).toEqual([
        { type: 'S', country: 'IE', code: '6388047V', name: 'Companie IE6388047V', base: 498 },
        { type: 'P', country: 'DE', code: '123456788', name: 'Companie DE123456788', base: 150 },
      ]);
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
    },
    120_000,
  );

  official(
    "the D300 reports them on rows 7, 7.1 and 3.1 and passes ANAF's validator",
    async () => {
      const { s, crossBorder } = await company(new DukIntegrator(dist));
      await s.invoke(s.owner, 'sales.seller.record', {
        details: {
          name: 'Exemplu Servicii SRL',
          vatId: `RO${cui}`,
          address: {
            lines: ['Str. Lungă 10'],
            city: 'Galați',
            subdivision: 'RO-GL',
            country: 'RO',
          },
        },
      });
      for (const proposal of [
        await crossBorder(
          foreign({ number: 'IE-3', country: 'IE', counterparty: 'IE6388047V', currency: 'EUR' }),
          '628',
        ),
        await crossBorder(
          foreign({ number: 'X-3', direction: 'sale', country: 'DE', counterparty: 'DE123456788' }),
          '704',
        ),
      ])
        await s.post(await s.approve(proposal));
      const prepared = await s.invoke<{ state: string; steps: { detail: string | null }[] }>(
        s.owner,
        'declarations.prepare',
        {
          kind: 'D300',
          period: '2026-10',
          options: {
            declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
            caen: '6201',
            bank: 'Banca Exemplu',
            account: 'RO49AAAA1B31007593840000',
          },
        },
      );
      expect(JSON.parse(prepared.steps[0]!.detail!).rows).toEqual({
        R7_1: 498,
        R7_2: 105,
        R7_1_1: 498,
        R7_1_2: 105,
        R3_1: 100,
        R3_1_1: 100,
        R28_2: 105,
      });
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
    },
    120_000,
  );
});
