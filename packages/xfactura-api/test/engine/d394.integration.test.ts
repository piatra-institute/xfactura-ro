import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { DukIntegrator } from '../../source/engine/adapters/declaration-validator';
import { readViesAnswer } from '../../source/engine/adapters/vies';
import type { TaxLedgerEntry } from 'xfactura-core/kernel';
import { reversedAttributes } from 'xfactura-core/ro/treatments/ledger';
import { cashRegisterSections } from '../../source/engine/modules/retail';
import type { ProposalView } from '../../source/engine/kernel/views';
import { invoiceXml } from './fixtures/invoice';
import { service, type Issued } from './fixtures/sales';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});
const dist = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
const official = DukIntegrator.available(dist) && Bun.which('java') ? test : test.skip;
const cui = '18547290';

/** Synthetic partners: CUIs with valid control digits. */
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
  const buyer = async (name: string, code: string, vat: boolean) => {
    const party = await s.party(name, code);
    await s.invoke(s.owner, 'parties.recordDetails', {
      partyId: party.id,
      details: {
        name,
        ...(vat ? { vatId: `RO${code}` } : { legalId: code }),
        address: { lines: ['Bd. Unirii 5'], city: 'Brașov', subdivision: 'RO-BV', country: 'RO' },
      },
    });
    return party;
  };
  const series = await s.invoke<{ id: string }>(s.owner, 'sales.series.create', {
    code: 'XF',
    prefix: 'XF',
    width: 4,
    revenueAccount: '704',
  });
  const sell = async (buyerId: string, lines: unknown[], extra: Record<string, unknown> = {}) => {
    const issued = await s.invoke<Issued>(s.owner, 'sales.issue', {
      seriesId: series.id,
      buyerId,
      issueDate: '2026-10-10',
      lines,
      ...extra,
    });
    const proposal = await s.invoke<ProposalView>(s.owner, 'proposals.get', {
      id: issued.recognition.proposalId,
    });
    // A reduced rate asks the reviewer to confirm the supply qualifies for it.
    const acknowledge = proposal.issues
      .filter((issue) => issue.code === 'REDUCED_RATE')
      .map((issue) => issue.code);
    await s.post(await s.approve(proposal, s.reviewer, acknowledge));
    return issued;
  };
  const buy = async (number: string, supplier: string, amounts: Record<string, string> = {}) => {
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: `${number}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(
        invoiceXml({
          company: cui,
          number,
          counterparty: supplier,
          date: '2026-10-05',
          ...amounts,
        }),
      ).toString('base64'),
    });
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId: id });
    await s.book('invoices.recognize', { documentId: document.id, account: '628' });
  };
  return { s, buyer, sell, buy };
}

const options = {
  caen: '6201',
  phone: '0236123456',
  representative: { name: 'Popescu Ana', role: 'Administrator', address: 'Galați, Str. Lungă 10' },
  preparer: {
    kind: 'company',
    cui: '14399840',
    name: 'Contabil Exemplu SRL',
    capacity: 'Împuternicit',
  },
  consultation: true,
  affiliates: false,
};
type Artifact = { state: string; steps: { state: string; detail: string | null }[] };
const prepare = (s: Scenario, extra: Record<string, unknown> = {}) =>
  s.invoke<Artifact>(s.owner, 'declarations.prepare', {
    kind: 'D394',
    period: '2026-10',
    options: { ...options, ...extra },
  });

describe('D394 from the books', () => {
  official(
    "lists each partner's invoices by type and rate, the series issued, and passes ANAF's validator",
    async () => {
      const { s, buyer, sell, buy } = await company(new DukIntegrator(dist));
      const registered = await buyer('Client Unu SRL', '14399840', true);
      const other = await buyer('Client Doi SRL', '26000004', true);
      const notRegistered = await buyer('Asociația Trei', '26000012', false);
      await sell(registered.id, [service('100')]);
      await sell(registered.id, [service('200')]);
      await sell(other.id, [service('50', '11')], {
        reducedRateBasis: 'art. 291 alin. (2) lit. h): cazare în sectorul hotelier',
      });
      await sell(notRegistered.id, [service('100')]);
      await buy('F-1', 'RO26000020');
      const prepared = await prepare(s);
      const summary = JSON.parse(prepared.steps[0]!.detail!);
      expect(summary.operations).toEqual([
        { type: 'L', rate: '21', partner: '14399840', invoices: 2, base: 300, vat: 63 },
        { type: 'L', rate: '11', partner: '26000004', invoices: 1, base: 50, vat: 6 },
        { type: 'L', rate: '21', partner: 'Asociația Trei', invoices: 1, base: 100, vat: 21 },
        { type: 'A', rate: '21', partner: '26000020', invoices: 1, base: 100, vat: 21 },
      ]);
      expect(summary.issuedInvoices).toBe(4);
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
    },
    120_000,
  );

  official(
    'services bought outside the Union are C with partners of type 4, a customer abroad type 3, an invoice at two rates counts once',
    async () => {
      const { s, buyer, sell } = await company(new DukIntegrator(dist));
      const registered = await buyer('Client Unu SRL', '14399840', true);
      // One invoice at 21% and 11%: it counts for the 21% (VAT 21 lei against 5.50 lei).
      await sell(registered.id, [service('100'), service('50', '11')], {
        reducedRateBasis: 'art. 291 alin. (2) lit. h): cazare în sectorul hotelier',
      });
      const file = async (number: string, xml: string) =>
        (
          await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
            filename: `${number}.xml`,
            mediaType: 'application/xml',
            base64: Buffer.from(xml).toString('base64'),
          })
        ).id;
      // A purchase at 21% and 11%: it counts for the 11% (VAT 22 lei against 21 lei).
      const twoRates = await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
        evidenceId: await file(
          'F-3',
          invoiceXml({
            company: cui,
            number: 'F-3',
            counterparty: 'RO26000020',
            date: '2026-10-05',
            taxes: [
              { rate: '21', net: '100.00', tax: '21.00' },
              { rate: '11', net: '200.00', tax: '22.00' },
            ],
            net: '300.00',
            tax: '43.00',
            gross: '343.00',
          }),
        ),
      });
      const purchase = await s.propose('invoices.recognize', {
        documentId: twoRates.id,
        account: '628',
      });
      await s.post(
        await s.approve(
          purchase,
          s.reviewer,
          purchase.issues.filter((issue) => issue.code === 'REDUCED_RATE').map((i) => i.code),
        ),
      );
      // A German company buying with Romanian VAT: a taxable person established in another
      // Member State, by its VAT code there.
      const german = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
        kind: 'eu_taxable',
        country: 'DE',
        taxId: 'DE123456789',
        name: 'Beispiel GmbH',
      });
      await s.invoke(s.owner, 'parties.recordDetails', {
        partyId: german.id,
        details: {
          name: 'Beispiel GmbH',
          vatId: 'DE123456789',
          address: { lines: ['Hauptstraße 1'], city: 'Berlin', country: 'DE' },
        },
      });
      await sell(german.id, [service('400')]);
      // Services from a company established outside the Union, the VAT self-assessed: C with
      // the partner of type 4, at the standard rate.
      const abroad = await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
        evidenceId: await file(
          'US-1',
          invoiceXml({
            company: cui,
            number: 'US-1',
            country: 'US',
            counterparty: '94-1234567',
            category: 'AE',
            rate: '0',
            tax: '0.00',
            net: '500.00',
            gross: '500.00',
            date: '2026-10-15',
          }),
        ),
      });
      await s.book('invoices.crossBorder', {
        documentId: abroad.id,
        account: '628',
        supply: 'services_general_rule',
      });
      const prepared = await prepare(s);
      const summary = JSON.parse(prepared.steps[0]!.detail!);
      expect(summary.operations).toEqual([
        { type: 'L', rate: '21', partner: '14399840', invoices: 1, base: 100, vat: 21 },
        { type: 'L', rate: '11', partner: '14399840', invoices: 0, base: 50, vat: 6 },
        { type: 'A', rate: '21', partner: '26000020', invoices: 0, base: 100, vat: 21 },
        { type: 'A', rate: '11', partner: '26000020', invoices: 1, base: 200, vat: 22 },
        { type: 'L', rate: '21', partner: 'DE123456789', invoices: 1, base: 400, vat: 84 },
        { type: 'C', rate: '21', partner: '94-1234567', invoices: 1, base: 500, vat: 105 },
      ]);
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
    },
    120_000,
  );

  test('invoices issued outside the series in the books need their ranges declared', async () => {
    const { s } = await company();
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'vechi.xml',
      mediaType: 'application/xml',
      base64: Buffer.from(
        invoiceXml({
          company: cui,
          number: 'FV 0099',
          direction: 'sale',
          counterparty: 'RO14399840',
          date: '2026-10-03',
        }),
      ).toString('base64'),
    });
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId: id });
    await s.book('invoices.recognize', { documentId: document.id, account: '704' });
    const blocked = await s.refused(prepare(s));
    expect(JSON.stringify(blocked)).toContain('D394_SERIES');
    const prepared = await prepare(s, {
      outsideSeries: {
        allocated: [{ series: 'FV', first: '0001' }],
        issued: [{ series: 'FV', first: '0099', last: '0099' }],
        invoices: 1,
      },
    });
    expect(JSON.parse(prepared.steps[0]!.detail!).issuedInvoices).toBe(1);
  });

  test('a purchase outside the scope of VAT from a supplier abroad is not listed', async () => {
    const { s, buy } = await company();
    // A hotel night in Germany: the place of supply is not in Romania, and with partners not
    // established here only taxable operations whose VAT the company owes are declared (OPANAF
    // nr. 3.769/2015 anexa nr. 2 secțiunea 1 lit. E–F pct. 10); N is for persons not registered.
    await buy('DE-7', 'DE811569869', {
      country: 'DE',
      category: 'O',
      tax: '0.00',
      gross: '100.00',
    });
    const prepared = await prepare(s);
    expect(JSON.parse(prepared.steps[0]!.detail!).operations).toEqual([]);
  });

  test('a supplier charging VAT without a VAT code, and a quarter for a monthly payer, are refused', async () => {
    const { s, buy } = await company();
    await buy('F-2', '26000039');
    expect(JSON.stringify(await s.refused(prepare(s)))).toContain('D394_SUPPLIER');
    expect(
      JSON.stringify(
        await s.refused(
          s.invoke(s.owner, 'declarations.prepare', { kind: 'D394', period: '2026-Q4', options }),
        ),
      ),
    ).toContain('VAT_PERIOD');
  });
});

describe('D394 with intra-community acquisitions', () => {
  const d394Options = {
    caen: '4779',
    phone: '0236123456',
    representative: {
      name: 'Popescu Ana',
      role: 'Administrator',
      address: 'Galați, Str. Lungă 10',
    },
    preparer: {
      kind: 'company',
      cui: '14399840',
      name: 'Contabil Exemplu SRL',
      capacity: 'Împuternicit',
    },
    consultation: true,
    affiliates: false,
  };
  const summary = (artifact: Artifact) => JSON.parse(artifact.steps[0]!.detail!);

  // An intra-community acquisition of goods (AIC-…) is D390's (type A), not a domestic
  // operation: D394 leaves it out and is prepared.
  test('an intra-community acquisition in the period leaves D394 preparable', async () => {
    const vies = {
      async check(query: { countryCode: string; vatNumber: string }) {
        const raw = new TextEncoder().encode(
          JSON.stringify({
            countryCode: query.countryCode,
            vatNumber: query.vatNumber,
            requestDate: '2026-10-08T10:00:00.000Z',
            valid: true,
            requestIdentifier: 'WAPIAAAAX4X2K9L',
            name: 'Companie DE123456788',
            address: 'Hauptstraße 1, Berlin',
          }),
        );
        return { raw, result: readViesAnswer(raw, query as never) };
      },
    };
    const s = await scenario({
      cui,
      clock: () => Date.parse('2026-11-05T09:00:00Z'),
      vies: vies as never,
    });
    open.push(s);
    const file = async (filename: string, text: string) =>
      (
        await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
          filename,
          mediaType: 'application/xml',
          base64: Buffer.from(text).toString('base64'),
        })
      ).id;
    for (const [axis, value] of Object.entries({
      'vat.status': 'normal_vat',
      'vat.period': 'monthly',
      'policy.stock.valuation': 'fifo',
      'policy.stock.inventory': 'permanent',
      'policy.stock.negative': 'refuse',
    }))
      await s.invoke(s.owner, 'profile.record', {
        axis,
        value,
        effectiveFrom: '2026-01-01',
        evidenceId: (await s.evidence(`${axis}.pdf`)).id,
      });
    await s.invoke(s.owner, 'fx.importBnr', {
      evidenceId: await file(
        'nbr.xml',
        `<?xml version="1.0" encoding="utf-8"?>
  <DataSet xmlns="http://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher><PublishingDate>2026-10-15</PublishingDate><MessageType>DR</MessageType></Header>
  <Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
  <Cube date="2026-10-07"><Rate currency="EUR">5.0800</Rate></Cube>
  </Body></DataSet>`,
      ),
    });
    await s.invoke(s.owner, 'sales.seller.record', {
      details: {
        name: 'Exemplu Comerț SRL',
        vatId: `RO${cui}`,
        address: {
          lines: ['Str. Portului 3'],
          city: 'Galați',
          subdivision: 'RO-GL',
          country: 'RO',
        },
      },
    });
    await s.book(
      'ledger.general',
      journal(
        (await s.evidence('deschidere.pdf')).id,
        [
          { account: '5121', side: 'D', amount: '20000.00' },
          { account: '1012', side: 'C', amount: '20000.00' },
        ],
        { date: '2026-01-01', purpose: 'opening' },
      ),
    );
    const warehouse = await s.invoke<{ id: string }>(s.owner, 'stock.warehouses.create', {
      code: 'D1',
      name: 'Depozit',
      keeper: 'Ionescu Maria',
    });
    const coffee = await s.invoke<{ id: string }>(s.owner, 'stock.items.create', {
      code: 'CAF-1',
      name: 'Cafea verde',
      unit: 'KGM',
      account: '371',
      nc8: '09011100',
    });
    const xml = invoiceXml({
      company: cui,
      number: 'DE-77',
      date: '2026-10-07',
      deliveryDate: '2026-10-05',
      direction: 'purchase',
      currency: 'EUR',
      category: 'K',
      country: 'DE',
      counterparty: 'DE123456788',
      rate: '0',
      tax: '0.00',
      gross: '1000.00',
      net: '1000.00',
      lines: [{ rate: '0', net: '1000.00', name: 'Cafea verde' }],
    }).replace(
      /(<cac:TaxSubtotal>.*?<cac:TaxCategory><cbc:ID>[EKG]<\/cbc:ID><cbc:Percent>0<\/cbc:Percent>)/,
      `$1<cbc:TaxExemptionReasonCode>VATEX-EU-IC</cbc:TaxExemptionReasonCode>`,
    );
    const bought = await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
      evidenceId: await file('DE-77.xml', xml),
    });
    const acquisition = await s.propose('goods.euAcquisition', {
      documentId: bought.id,
      account: '371',
      arrangement: 'standard',
      rate: 'standard',
      deduction: 'full',
      stock: {
        warehouseId: warehouse.id,
        lines: [{ line: '1', itemId: coffee.id, quantity: '10' }],
      },
    });
    expect(acquisition.issues.filter((issue) => issue.severity === 'block')).toEqual([]);
    await s.post(
      await s.approve(
        acquisition,
        s.reviewer,
        acquisition.issues.filter((i) => i.severity === 'ack').map((i) => i.code),
      ),
    );
    const d394 = await s.invoke<Artifact>(s.owner, 'declarations.prepare', {
      kind: 'D394',
      period: '2026-10',
      options: d394Options,
    });
    expect(summary(d394).operations).toEqual([]);
  });
});

describe('D394 op2 after a storno of a Z report', () => {
  // A Z report's tax entries share its count of receipts; a storno mirrors them with the count
  // negated (`signedAttributes`), as ledger.reverse writes them.
  const report = (
    entryId: string,
    documentId: string,
    register: string,
    receipts: string,
    base: bigint,
    tax: bigint,
  ): TaxLedgerEntry => ({
    entryId,
    seq: 1,
    taxNo: 1,
    key: 'vat',
    direction: 'output',
    code: 'S-21',
    baseBani: base,
    taxBani: tax,
    deductibleBani: 0n,
    ledgerBani: tax,
    taxPoint: '2026-10-05' as TaxLedgerEntry['taxPoint'],
    exigibility: '2026-10-05' as TaxLedgerEntry['taxPoint'],
    documentId,
    partyId: null,
    originTaxEntry: null,
    attributes: { documentType: 'zreport', register, number: '1', receipts },
  });
  const storno = (entry: TaxLedgerEntry, entryId: string): TaxLedgerEntry => ({
    ...entry,
    entryId,
    key: `reversal:${entry.key}`,
    baseBani: -entry.baseBani,
    taxBani: -entry.taxBani,
    ledgerBani: -entry.ledgerBani,
    originTaxEntry: `${entry.entryId}:${entry.key}`,
    attributes: reversedAttributes(entry.attributes),
  });
  const leu = (bani: bigint) => bani / 100n;

  test('a reversed report counts neither its receipts nor its register', () => {
    const first = report('e1', 'z1', '4400000001', '3', 100000n, 21000n);
    const second = report('e2', 'z2', '4400000002', '5', 50000n, 10500n);
    const months = cashRegisterSections([first, second, storno(first, 'e3')], leu, []);
    expect(months).toEqual([
      expect.objectContaining({ month: 10, registers: 1, receipts: 5, total: 605 }),
    ]);
    // Reversed alone, the month holds nothing to declare.
    expect(cashRegisterSections([first, storno(first, 'e3')], leu, [])).toEqual([]);
  });
});
