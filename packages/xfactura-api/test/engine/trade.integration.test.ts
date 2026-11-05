import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { agent as tradeAgent } from 'xfactura-core/ro/trade';
import { questionKindIds } from 'xfactura-core/questions/kinds';
import {
  AnafKits,
  DukIntegrator,
  saftKitId,
} from '../../source/engine/adapters/declaration-validator';
import type { DeclarationValidator } from '../../source/engine/adapters/declaration-validator';
import { ViesLookupFailed, readViesAnswer, type ViesPort } from '../../source/engine/adapters/vies';
import { workKinds, type WorkItem } from '../../source/engine/kernel/work';
import type { ProposalView } from '../../source/engine/kernel/views';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { journal, scenario, type Scenario } from './scenario';

// Synthetic companies and documents; amounts computed by hand.
//   The acquisition: 1.000 kg of coffee at 150,00 EUR + transport 20.000,00 EUR on the same
//   invoice, 170.000,00 EUR at 5,0800 = 863.600,00 lei into stock (863,60 lei/kg); VAT 21% on the
//   same base (the invoice is the tax point, 07.10) = 181.356,00 lei. 86% of INS's 1.000.000 lei.
//   The supply: 400 kg for 400.000,00 lei, out at 400 × 863,60 = 345.440,00 lei.
//   The import: 1.000,00 USD at 4,5000 = 4.500,00 lei, duty 120,00 lei, VAT 21% of 4.670,00 =
//   980,70 lei; 100 pieces at 46,20 lei. The deferred import: 2.000,00 USD = 9.000,00 lei, duty
//   240,00, VAT 21% of 9.340,00 = 1.961,40 lei. The export: 50 pieces for 5.000,00 lei.

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

const general = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
const kit = path.join(
  import.meta.dir,
  '../../../..',
  '.validators/anaf-saft/duk_SAFT_an_luna/dist',
);
const installed =
  DukIntegrator.available(kit) && DukIntegrator.available(general) && Bun.which('java') !== null;
// ANAF's validators when installed (D300 and D390 in the general kit, D406 in the SAF-T kit);
// otherwise a stand-in that accepts every file, so the books' flow still runs while the official
// checks are skipped, never passed.
const validator: DeclarationValidator = installed
  ? new AnafKits({ general: new DukIntegrator(general), saft: new DukIntegrator(kit, saftKitId) })
  : {
      id: 'validator de test',
      validate: async () => ({ ok: true, messages: [] }),
      pdf: async () => ({ ok: true, messages: [] }),
    };
const official = installed ? test : test.skip;
const cui = '18547290';
const declarant = { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' };
const d300Options = {
  declarant,
  caen: '4637',
  bank: 'Banca Exemplu',
  account: 'RO49AAAA1B31007593840000',
};
const bnr = `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher><PublishingDate>2026-10-15</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
<Cube date="2026-10-01"><Rate currency="EUR">5.0700</Rate><Rate currency="USD">4.5000</Rate></Cube>
<Cube date="2026-10-02"><Rate currency="EUR">5.0700</Rate><Rate currency="USD">4.5100</Rate></Cube>
<Cube date="2026-10-07"><Rate currency="EUR">5.0800</Rate><Rate currency="USD">4.5200</Rate></Cube>
<Cube date="2026-10-08"><Rate currency="EUR">5.0850</Rate><Rate currency="USD">4.5200</Rate></Cube>
<Cube date="2026-10-09"><Rate currency="EUR">5.0900</Rate><Rate currency="USD">4.5300</Rate></Cube>
</Body></DataSet>`;

type Artifact = {
  id: string;
  state: string;
  evidenceId: string;
  steps: { state: string; detail: string | null }[];
};
const summary = (artifact: Artifact) => JSON.parse(artifact.steps[0]!.detail ?? 'null');
const validated = (artifact: Artifact) => {
  if (installed)
    expect([artifact.state, artifact.steps.at(-1)?.detail ?? null]).toEqual([
      'validated_official',
      null,
    ]);
};
const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const taxes = (proposal: ProposalView) =>
  proposal.effect?.taxEntries.map(
    (entry) => `${entry.direction} ${entry.code} ${entry.base} ${entry.amount}`,
  );
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);

/** A VIES that answers what the test set, as the service's JSON would carry it. */
function fakeVies(
  valid: (code: string) => boolean,
  requestDate = '2026-10-08',
): ViesPort & {
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    async check(query) {
      asked.push(
        `${query.countryCode}${query.vatNumber} by ${query.requester?.countryCode}${query.requester?.vatNumber}`,
      );
      if (query.vatNumber === 'DOWN') throw new ViesLookupFailed('MS_UNAVAILABLE');
      const raw = new TextEncoder().encode(
        JSON.stringify({
          countryCode: query.countryCode,
          vatNumber: query.vatNumber,
          requestDate: `${requestDate}T10:00:00.000Z`,
          valid: valid(`${query.countryCode}${query.vatNumber}`),
          requestIdentifier: 'WAPIAAAAX4X2K9L',
          name: 'Companie DE123456788',
          address: 'Hauptstraße 1, Berlin',
        }),
      );
      return { raw, result: readViesAnswer(raw, query) };
    },
  };
}

/** An invoice in an exempt or outside-the-scope category, with its reason (BT-121). */
const exemptXml = (input: XmlInput & { reason?: string }) => {
  const xml = invoiceXml({ rate: '0', tax: '0.00', gross: input.net, ...input });
  if (!input.reason) return xml;
  return xml.replace(
    /(<cac:TaxSubtotal>.*?<cac:TaxCategory><cbc:ID>[EKG]<\/cbc:ID><cbc:Percent>0<\/cbc:Percent>)/,
    `$1<cbc:TaxExemptionReasonCode>${input.reason}</cbc:TaxExemptionReasonCode>`,
  );
};

async function company(vies?: ViesPort) {
  const s = await scenario({
    cui,
    clock: () => Date.parse('2026-11-05T09:00:00Z'),
    declarationValidator: validator,
    ...(vies ? { vies } : {}),
  });
  open.push(s);
  const file = async (filename: string, text: string, mediaType = 'application/xml') =>
    (
      await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
        filename,
        mediaType,
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
  await s.invoke(s.owner, 'fx.importBnr', { evidenceId: await file('nbrfxrates.xml', bnr) });
  await s.invoke(s.owner, 'sales.seller.record', {
    details: {
      name: 'Exemplu Comerț SRL',
      vatId: `RO${cui}`,
      address: { lines: ['Str. Portului 3'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
    },
  });
  await s.invoke(s.owner, 'treasury.createAccount', {
    kind: 'bank',
    name: 'Cont curent',
    iban: d300Options.account,
    currency: 'RON',
    ledgerAccount: '5121',
    openedOn: '2026-01-01',
  });
  await s.book(
    'ledger.general',
    journal(
      (await s.evidence('balanta-deschidere.pdf')).id,
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
  const item = (code: string, name: string, unit: string, nc8: string) =>
    s.invoke<{ id: string }>(s.owner, 'stock.items.create', {
      code,
      name,
      unit,
      account: '371',
      nc8,
    });
  const importXml = async (input: XmlInput & { reason?: string }) =>
    s.invoke<{ id: string; partyId: string }>(s.owner, 'invoices.import', {
      evidenceId: await file(`${input.number}.xml`, exemptXml({ company: cui, ...input })),
    });
  /** Approves acknowledging every warning, and posts. */
  const post = async (proposal: ProposalView) =>
    s.post(
      await s.approve(
        proposal,
        s.reviewer,
        proposal.issues.filter((issue) => issue.severity === 'ack').map((issue) => issue.code),
      ),
    );
  const prepare = (kind: string, period: string, options: Record<string, unknown> = {}) =>
    s.invoke<Artifact>(s.owner, 'declarations.prepare', { kind, period, options });
  const partyOf = async (documentId: string) =>
    (await s.invoke<{ partyId: string }>(s.owner, 'documents.get', { id: documentId })).partyId;
  return { s, file, warehouse, item, importXml, post, prepare, partyOf };
}

describe('EU goods: an intra-community acquisition into stock and a supply out of it', () => {
  test('VIES, the transport, self-assessed VAT, D300 rd. 1, 5 and 20, D390 L and A, D406, Intrastat', async () => {
    const vies = fakeVies(() => true);
    const c = await company(vies);
    const { s } = c;
    const coffee = await c.item('CAF-1', 'Cafea verde', 'KGM', '09011100');

    // 1. The acquisition from Germany: 1.000 kg and the transport invoiced with them.
    const bought = await c.importXml({
      number: 'DE-77',
      date: '2026-10-07',
      deliveryDate: '2026-10-05',
      direction: 'purchase',
      currency: 'EUR',
      category: 'K',
      country: 'DE',
      counterparty: 'DE123456788',
      net: '170000.00',
      reason: 'VATEX-EU-IC',
      lines: [
        { rate: '0', net: '150000.00', name: 'Cafea verde' },
        { rate: '0', net: '20000.00', name: 'Transport' },
      ],
    });
    const unproposed = await s.list<WorkItem>(s.owner, 'work.list', {
      kinds: ['document.unproposed'],
    });
    expect(
      unproposed.find((item) => item.subject.id === bought.id)?.next.map((step) => step.inputHint),
    ).toContainEqual({ treatment: 'goods.euAcquisition', input: { documentId: bought.id } });
    const acquisition = await s.propose('goods.euAcquisition', {
      documentId: bought.id,
      account: '371',
      arrangement: 'standard',
      rate: 'standard',
      deduction: 'full',
      stock: {
        warehouseId: c.warehouse.id,
        lines: [{ line: '1', itemId: coffee.id, quantity: '1000' }],
      },
    });
    expect(codes(acquisition)).toContain('STOCK_CHARGES');
    expect(lines(acquisition)).toEqual([
      'D 371 863600.00',
      'C 401 863600.00',
      'C 4427 181356.00',
      'D 4426 181356.00',
    ]);
    expect(taxes(acquisition)).toEqual([
      'output AIC-21 863600.00 181356.00',
      'input AIC-21 863600.00 181356.00',
    ]);
    await c.post(acquisition);

    // INS's declaration for the month waits on 2025's arrivals, which the books do not keep:
    // asked, never assumed nil (a provider for all 2026 had they exceeded 2025's threshold).
    const calendar = await s.invoke<{
      items: { kind: string; period: string; status: string; question: { kind: string } | null }[];
    }>(s.owner, 'obligations.calendar', { from: '2026-10', to: '2026-10' });
    expect(
      calendar.items.find(
        (item) => item.kind === 'Intrastat.arrivals' && item.period === '2026-10',
      ),
    ).toMatchObject({ status: 'blocked', question: { kind: 'year.figures' } });

    // The Intrastat watch: arrivals at 86% of INS's 1.000.000 lei.
    const watched = await s.list<WorkItem>(s.owner, 'work.list', {
      kinds: ['threshold.approaching'],
    });
    expect(watched.map((item) => [item.subject.id, item.severity])).toContainEqual([
      'ro.intrastat.thresholds/2026',
      'warn',
    ]);

    // 2. The supply to the same partner: its code checked in VIES, the CMR and the insurance.
    const sold = await c.importXml({
      number: 'IC-1',
      date: '2026-10-09',
      deliveryDate: '2026-10-08',
      direction: 'sale',
      category: 'K',
      country: 'DE',
      counterparty: 'DE123456788',
      net: '400000.00',
      reason: 'VATEX-EU-IC',
      lines: [{ rate: '0', net: '400000.00', name: 'Cafea verde' }],
    });
    const checked = await s.invoke<{ documentId: string; valid: boolean; requestDate: string }>(
      s.owner,
      'parties.checkVies',
      { partyId: sold.partyId },
    );
    expect([checked.valid, checked.requestDate]).toEqual([true, '2026-10-08']);
    expect(vies.asked).toEqual(['DE123456788 by RO18547290']);
    const transport = {
      by: 'seller',
      documents: [
        {
          kind: 'cmr',
          evidenceId: (await s.evidence('cmr.pdf')).id,
          issuer: 'Transport Rapid SRL',
          independent: true,
          destination: 'DE',
          date: '2026-10-08',
        },
        {
          kind: 'insurance',
          evidenceId: (await s.evidence('asigurare.pdf')).id,
          issuer: 'Asigurări Generale SA',
          independent: true,
          destination: 'DE',
          date: '2026-10-08',
        },
      ],
    };
    const supplyInput = {
      documentId: sold.id,
      account: '707',
      arrangement: 'standard',
      viesDocumentId: checked.documentId,
      transport,
      stock: {
        warehouseId: c.warehouse.id,
        lines: [{ line: '1', itemId: coffee.id, quantity: '400' }],
      },
    };
    const triangle = await s.propose('goods.euSupply', {
      ...supplyInput,
      arrangement: 'triangular_intermediary',
    });
    expect(codes(triangle)).toContain('TRIANGULATION');
    const supply = await s.revise('goods.euSupply', triangle, supplyInput);
    expect(codes(supply)).toEqual(
      expect.arrayContaining(['TRANSPORT_PRESUMED', 'D390_REQUIRED', 'SOURCE_EXTRACTED']),
    );
    expect(lines(supply)).toEqual([
      'D 4111 400000.00',
      'C 707 400000.00',
      'C 371 345440.00',
      'D 607 345440.00',
    ]);
    expect(taxes(supply)).toEqual(['output EX-IC 400000.00 0.00']);
    await c.post(supply);

    // 3. The returns: D300 rd. 1, 5/5.1 and 20/20.1; D390 L and A; D406 with 310301 and 300204.
    const vat = await c.prepare('D300', '2026-10', d300Options);
    expect(summary(vat).rows).toMatchObject({
      R1_1: 400000,
      R5_1: 863600,
      R5_2: 181356,
      R5_1_1: 863600,
      R5_1_2: 181356,
      R28_2: 181356,
    });
    validated(vat);
    const recapitulative = await c.prepare('D390', '2026-10', { declarant });
    expect(summary(recapitulative).operations).toEqual([
      expect.objectContaining({ type: 'A', country: 'DE', code: '123456788', base: 863600 }),
      expect.objectContaining({ type: 'L', country: 'DE', code: '123456788', base: 400000 }),
    ]);
    validated(recapitulative);
    await s.invoke(s.owner, 'parties.recordDetails', {
      partyId: sold.partyId,
      details: {
        name: 'Companie DE123456788',
        vatId: 'DE123456788',
        address: { lines: ['Hauptstraße 1'], city: 'Berlin', country: 'DE' },
      },
    });
    const saft = await c.prepare('D406', '2026-10', {
      contact: { firstName: 'Ana', lastName: 'Popescu', phone: '0236000000' },
    });
    validated(saft);
    const { base64 } = await s.invoke<{ base64: string }>(s.owner, 'evidence.get', {
      id: saft.evidenceId,
    });
    const xml = Buffer.from(base64, 'base64').toString();
    expect(xml).toContain('<nsSAFT:TaxCode>300204</nsSAFT:TaxCode>');
    expect(xml).toContain('<nsSAFT:TaxCode>310301</nsSAFT:TaxCode>');

    // 4. Intrastat: the month's lines from the books, filed with INS.
    const data = await s.invoke<{ lines: { commodity: string | null; invoiceValue: string }[] }>(
      s.owner,
      'intrastat.data',
      { month: '2026-10', flow: 'dispatches' },
    );
    expect(data.lines.map((line) => [line.commodity, line.invoiceValue])).toEqual([
      ['09011100', '400000'],
    ]);

    // 5. RO e-Transport: each transport listed with its declarant and window, a UIT recorded.
    const transports = await s.invoke<{
      items: { documentId: string; status: string; declareFrom: string }[];
    }>(s.owner, 'etransport.list', { from: '2026-10', to: '2026-10' });
    expect(
      transports.items.map((item) => [item.documentId, item.status, item.declareFrom]),
    ).toEqual([
      [bought.id, 'missing', '2026-10-02'],
      [sold.id, 'missing', '2026-10-05'],
    ]);
    const uit = await s.list<WorkItem>(s.owner, 'work.list', { kinds: ['etransport.uit'] });
    expect(uit.map((item) => item.subject.id).sort()).toEqual([bought.id, sold.id].sort());
    const question = await s.invoke<{ id: string }>(s.owner, 'questions.ask', {
      kind: 'etransport.uit',
      subject: { kind: 'document', id: sold.id },
      params: { flow: 'supply', date: '2026-10-08' },
    });
    await s.invoke(s.owner, 'questions.answer', {
      questionId: question.id,
      value: {
        uit: '2026X7K9P3Q1',
        declaredOn: '2026-10-07',
        start: '2026-10-08',
        evidenceId: (await s.evidence('uit.pdf')).id,
      },
    });
    const after = await s.invoke<{ items: { documentId: string; status: string }[] }>(
      s.owner,
      'etransport.list',
      { from: '2026-10', to: '2026-10' },
    );
    expect(after.items.find((item) => item.documentId === sold.id)?.status).toBe('declared');
  });

  test('a supply without its transport yet: pending, then the proof answered', async () => {
    const c = await company(fakeVies(() => true));
    const { s } = c;
    const coffee = await c.item('CAF-2', 'Cafea', 'KGM', '09011100');
    await s.book('stock.receive', {
      date: '2026-10-02',
      warehouseId: c.warehouse.id,
      supplierId: (await s.party('Furnizor Cafea SRL', '14399840')).id,
      reference: 'AV-1',
      evidenceId: (await s.evidence('aviz.pdf')).id,
      lines: [{ itemId: coffee.id, quantity: '10', value: '1000.00' }],
    });
    const sold = await c.importXml({
      number: 'IC-2',
      date: '2026-10-09',
      deliveryDate: '2026-10-08',
      direction: 'sale',
      category: 'K',
      country: 'DE',
      counterparty: 'DE123456788',
      net: '2000.00',
      reason: 'VATEX-EU-IC',
      lines: [{ rate: '0', net: '2000.00', name: 'Cafea' }],
    });
    const checked = await s.invoke<{ documentId: string }>(s.owner, 'parties.checkVies', {
      partyId: sold.partyId,
    });
    const supply = await s.propose('goods.euSupply', {
      documentId: sold.id,
      account: '707',
      arrangement: 'standard',
      viesDocumentId: checked.documentId,
      stock: {
        warehouseId: c.warehouse.id,
        lines: [{ line: '1', itemId: coffee.id, quantity: '10' }],
      },
    });
    expect(codes(supply)).toContain('TRANSPORT_PENDING');
    await c.post(supply);
    const pending = await s.list<WorkItem>(s.owner, 'work.list', { kinds: ['goods.proof'] });
    expect(pending.map((item) => [item.subject.id, item.severity, item.due])).toEqual([
      [sold.id, 'warn', '2027-01-06'],
    ]);
    const question = await s.invoke<{ id: string }>(
      s.owner,
      'questions.ask',
      pending[0]!.next[0]!.inputHint as never,
    );
    await s.invoke(s.owner, 'questions.answer', {
      questionId: question.id,
      value: {
        basis: 'intra_eu',
        transport: {
          by: 'seller',
          documents: [
            {
              kind: 'cmr',
              evidenceId: (await s.evidence('cmr-2.pdf')).id,
              issuer: 'Transport Rapid SRL',
              independent: true,
              destination: 'DE',
              date: '2026-10-08',
            },
            {
              kind: 'carrier_invoice',
              evidenceId: (await s.evidence('factura-transport.pdf')).id,
              issuer: 'Logistic Europa GmbH',
              independent: true,
              destination: 'DE',
              date: '2026-10-10',
            },
          ],
        },
      },
    });
    expect(await s.list<WorkItem>(s.owner, 'work.list', { kinds: ['goods.proof'] })).toEqual([]);
  });

  test('an invalid code in VIES refuses the exemption; VIES unavailable records nothing', async () => {
    const c = await company(fakeVies(() => false));
    const { s } = c;
    const sold = await c.importXml({
      number: 'IC-3',
      date: '2026-10-09',
      deliveryDate: '2026-10-08',
      direction: 'sale',
      category: 'K',
      country: 'DE',
      counterparty: 'DE123456788',
      net: '1000.00',
      reason: 'VATEX-EU-IC',
      lines: [{ rate: '0', net: '1000.00', name: 'Marfă' }],
    });
    const checked = await s.invoke<{ documentId: string; valid: boolean }>(
      s.owner,
      'parties.checkVies',
      { partyId: sold.partyId },
    );
    expect(checked.valid).toBe(false);
    const supply = await s.propose('goods.euSupply', {
      documentId: sold.id,
      account: '707',
      arrangement: 'standard',
      viesDocumentId: checked.documentId,
    });
    expect(supply.status).toBe('blocked');
    expect(codes(supply)).toContain('VIES_INVALID');
    const down = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'eu_taxable',
      country: 'AT',
      taxId: 'ATDOWN',
      name: 'Offline GmbH',
    });
    expect(
      (await s.refused(s.invoke(s.owner, 'parties.checkVies', { partyId: down.id })))?.code,
    ).toBe('VIES_UNAVAILABLE');
  });
});

describe('imports and exports', () => {
  test('an import paid at customs and one deferred, an export with its exit certified; D300 and D406', async () => {
    const c = await company();
    const { s } = c;
    const chips = await c.item('CMP-1', 'Componente electronice', 'H87', '85423190');
    const customs = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_public_institution',
      country: 'RO',
      taxId: '4221306',
      name: 'Direcția Generală a Vămilor',
    });
    const declare = async (
      number: string,
      mrn: string,
      usd: string,
      customsValue: string,
      duty: string,
      vat: string,
      vatPayment: Record<string, string>,
    ) => {
      const base = (Number(customsValue) + Number(duty)).toFixed(2);
      return s.invoke<{ id: string }>(s.owner, 'documents.record', {
        evidenceId: (await s.evidence(`dvi-${number}.pdf`)).id,
        kind: 'customs.declaration',
        body: {
          procedure: 'import',
          mrn,
          acceptedOn: '2026-10-06',
          office: 'Biroul vamal Constanța Sud',
          declarant: { name: 'Exemplu Comerț SRL', taxId: cui, country: 'RO' },
          partner: { name: 'Companie CN91440300', country: 'CN' },
          invoices: [{ number, currency: 'USD', amount: usd }],
          exchangeRate: '4.5500',
          lines: [
            {
              description: 'Componente electronice',
              commodity: '85423190',
              customsValue,
              duty,
              vatBase: base,
              vatRate: '21',
              vat,
              origin: 'CN',
            },
          ],
          totals: { customsValue, duty, vatBase: base, vat },
          vatPayment,
        },
      });
    };
    const purchase = (number: string, net: string) =>
      c.importXml({
        number,
        date: '2026-10-01',
        direction: 'purchase',
        currency: 'USD',
        category: 'O',
        country: 'CN',
        counterparty: 'CN91440300',
        net,
        lines: [{ rate: '0', net, name: 'Componente electronice' }],
      });

    // 1. Paid at customs: the duty into the goods, the VAT against the customs debt (rd. 24).
    const paidInvoice = await purchase('CN-9', '1000.00');
    const paidDvi = await declare(
      'CN-9',
      '26RO1234567890ABCD',
      '1000.00',
      '4550.00',
      '120.00',
      '980.70',
      {
        mode: 'paid',
      },
    );
    const paid = await s.propose('goods.import', {
      documentId: paidInvoice.id,
      declarationId: paidDvi.id,
      account: '371',
      deduction: 'full',
      authorityId: customs.id,
      stock: {
        warehouseId: c.warehouse.id,
        lines: [{ line: '1', itemId: chips.id, quantity: '100' }],
      },
    });
    expect(codes(paid)).toEqual(expect.arrayContaining(['IMPORT_DUTY_COST', 'SOURCE_EXTRACTED']));
    expect(lines(paid)).toEqual([
      'D 371 4620.00',
      'C 401 4500.00',
      'C 446 1100.70',
      'D 4426 980.70',
    ]);
    expect(taxes(paid)).toEqual(['input IMP-21 4670.00 980.70']);
    await c.post(paid);

    // 2. Deferred under the certificate (art. 326 alin. (4) lit. a)): rd. 7 and 22.
    const deferredInvoice = await purchase('CN-10', '2000.00');
    const deferredDvi = await declare(
      'CN-10',
      '26RO1234567890ABCE',
      '2000.00',
      '9100.00',
      '240.00',
      '1961.40',
      { mode: 'deferred', certificate: 'CA-2026-17' },
    );
    const deferredInput = {
      documentId: deferredInvoice.id,
      declarationId: deferredDvi.id,
      account: '371',
      deduction: 'full',
      authorityId: customs.id,
      stock: {
        warehouseId: c.warehouse.id,
        lines: [{ line: '1', itemId: chips.id, quantity: '200' }],
      },
    };
    const uncertified = await s.propose('goods.import', deferredInput);
    expect(codes(uncertified)).toContain('DEFERRAL_CERTIFICATE');
    const deferred = await s.revise('goods.import', uncertified, {
      ...deferredInput,
      certificateEvidenceId: (await s.evidence('certificat-amanare.pdf')).id,
    });
    expect(lines(deferred)).toEqual([
      'D 371 9240.00',
      'C 401 9000.00',
      'C 446 240.00',
      'C 4427 1961.40',
      'D 4426 1961.40',
    ]);
    expect(taxes(deferred)).toEqual([
      'output IMP-DEF-21 9340.00 1961.40',
      'input IMP-DEF-21 9340.00 1961.40',
    ]);
    await c.post(deferred);

    // 3. The export: 50 pieces out of stock, the exit certified on the declaration.
    const exported = await c.importXml({
      number: 'EX-1',
      date: '2026-10-12',
      deliveryDate: '2026-10-12',
      direction: 'sale',
      category: 'G',
      country: 'US',
      counterparty: 'US5550001',
      net: '5000.00',
      reason: 'VATEX-EU-G',
      lines: [{ rate: '0', net: '5000.00', name: 'Componente electronice' }],
    });
    const exportDeclaration = await s.invoke<{ id: string }>(s.owner, 'documents.record', {
      evidenceId: (await s.evidence('dvex.pdf')).id,
      kind: 'customs.declaration',
      body: {
        procedure: 'export',
        mrn: '26RO0000000000EXP1',
        acceptedOn: '2026-10-12',
        office: 'Biroul vamal Otopeni',
        declarant: { name: 'Exemplu Comerț SRL', taxId: cui, country: 'RO' },
        partner: { name: 'Companie US5550001', country: 'US' },
        invoices: [{ number: 'EX-1', currency: 'RON', amount: '5000.00' }],
        lines: [
          {
            description: 'Componente electronice',
            commodity: '85423190',
            customsValue: '5000.00',
            duty: '0.00',
          },
        ],
        totals: { customsValue: '5000.00', duty: '0.00' },
        exit: { certifiedOn: '2026-10-14', office: 'Biroul vamal Halmeu' },
      },
    });
    const sale = await s.propose('goods.export', {
      documentId: exported.id,
      account: '707',
      declarationId: exportDeclaration.id,
      stock: {
        warehouseId: c.warehouse.id,
        lines: [{ line: '1', itemId: chips.id, quantity: '50' }],
      },
    });
    expect(codes(sale)).toContain('EXPORT_EXIT_CERTIFIED');
    // FIFO: 50 of the first lot, at 46,20 lei.
    expect(lines(sale)).toEqual([
      'D 4111 5000.00',
      'C 707 5000.00',
      'C 371 2310.00',
      'D 607 2310.00',
    ]);
    expect(taxes(sale)).toEqual(['output EX-EXPORT 5000.00 0.00']);
    await c.post(sale);

    // 4. D300: rd. 7 (R7) and 22 (R20) for the deferred import, rd. 24 (R22) for the paid one,
    // rd. 14 for the export, rd. 31 (R28_2) the deductions.
    const vat = await c.prepare('D300', '2026-10', d300Options);
    expect(summary(vat).rows).toMatchObject({
      R7_1: 9340,
      R7_2: 1961,
      R22_1: 4670,
      R22_2: 981,
      R14_1: 5000,
      R28_2: 2942,
    });
    validated(vat);

    // 5. D406: the non-EU partners by their VAT code in their state (02), as recorded.
    for (const [documentId, name, vatId] of [
      [paidInvoice.id, 'Companie CN91440300', 'CN91440300'],
      [exported.id, 'Companie US5550001', 'US5550001'],
    ] as const)
      await s.invoke(s.owner, 'parties.recordDetails', {
        partyId: await c.partyOf(documentId),
        details: {
          name,
          vatId,
          address: { lines: ['Street 1'], city: 'City', country: vatId.slice(0, 2) },
        },
      });
    const saft = await c.prepare('D406', '2026-10', {
      contact: { firstName: 'Ana', lastName: 'Popescu', phone: '0236000000' },
    });
    validated(saft);
    const { base64 } = await s.invoke<{ base64: string }>(s.owner, 'evidence.get', {
      id: saft.evidenceId,
    });
    const xml = Buffer.from(base64, 'base64').toString();
    for (const code of ['301204', '300604', '310313'])
      expect(xml).toContain(`<nsSAFT:TaxCode>${code}</nsSAFT:TaxCode>`);
  });
});

describe('agent-ready', () => {
  test('the module names its questions and worklist kinds, all of them registered', () => {
    for (const question of tradeAgent.questions)
      expect(questionKindIds as readonly string[]).toContain(question.kind);
    for (const detector of tradeAgent.detectors)
      expect(workKinds as readonly string[]).toContain(detector.kind);
  });
});

void official;
