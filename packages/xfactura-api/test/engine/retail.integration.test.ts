import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import * as retailAgent from 'xfactura-core/ro/retail/agent';
import { addWorkingDays } from 'xfactura-core/ro/calendar';
import type { LocalDate } from 'xfactura-core/time';
import {
  AnafKits,
  DukIntegrator,
  type DeclarationValidator,
} from '../../source/engine/adapters/declaration-validator';
import type { ProposalView } from '../../source/engine/kernel/views';
import { camt, camtEntry, iban } from './fixtures/bank';
import { invoiceXml } from './fixtures/invoice';
import type { Issued } from './fixtures/sales';
import { journal, scenario, type Scenario } from './scenario';

// A shop's last ten days of October 2026 (G2), from its register's Z reports. Amounts by hand:
//   each day: 4 bags of coffee at 30,25 (121,00 at 21%, VAT 21,00) and 2 bars of chocolate at
//   11,10 (22,20 at 11%, VAT 2,20), 5 receipts, paid 43,20 in cash and 100,00 by card;
//   bought on 1 October: 50 bags at 10,00 (500,00 + 105,00) and 50 bars at 8,00 (400,00 + 44,00);
//   sold, FIFO: 40,00 of coffee and 16,00 of chocolate a day;
//   the register opened on 22 October; the shop was closed on 26 October (no report);
//   the acquirer settles three days of cards, 300,00, less its fee of 3,00: 297,00;
//   an invoice at a buyer's request for receipt 0003 of 24 October: 25,00 + 5,25, one sale with
//   the Z report: D300 counts it once, D394 lists it among the supplies and takes it out of op2;
//   a B2C invoice to a person giving her CNP: 100,00 + 21,00 of services.
// October's returns: D300 rd. 9 1.000 / 210, rd. 10 180 / 20 (19,80), rd. 24 500 / 105, rd. 25
// 400 / 44; D394 op2: 44 receipts, 875 + 184 at 21%, 180 + 20 at 11%, 1.259 collected.

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});
const dist = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
const installed = DukIntegrator.available(dist) && Bun.which('java') !== null;
const cui = '18547290';
const cnp = '1800101221144';
const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);
type Artifact = {
  state: string;
  evidenceId: string;
  steps: { state: string; detail: string | null }[];
};
const summary = (artifact: Artifact) => JSON.parse(artifact.steps[0]!.detail!);
const d394Options = {
  caen: '4711',
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
const d300Options = {
  declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
  caen: '4711',
  bank: 'Banca Exemplu',
  account: iban,
};

async function company(policies: Record<string, string>, validator?: DeclarationValidator) {
  const s = await scenario({
    cui,
    clock: () => Date.parse('2026-11-10T10:00:00Z'),
    ...(validator ? { declarationValidator: validator } : {}),
  });
  open.push(s);
  for (const [axis, value] of Object.entries({
    'vat.status': 'normal_vat',
    'vat.period': 'monthly',
    ...policies,
  }))
    await s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence(`${axis}.pdf`)).id,
    });
  await s.invoke(s.owner, 'sales.seller.record', {
    details: {
      name: 'Magazin Exemplu SRL',
      vatId: `RO${cui}`,
      address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
    },
  });
  for (const [kind, name, ledgerAccount] of [
    ['bank', 'Cont curent', '5121'],
    ['cash', 'Casierie', '5311'],
  ] as const)
    await s.invoke(s.owner, 'treasury.createAccount', {
      kind,
      name,
      ...(kind === 'bank' ? { iban } : {}),
      currency: 'RON',
      ledgerAccount,
      openedOn: '2026-01-01',
    });
  await s.book(
    'ledger.general',
    journal(
      (await s.evidence('balanta-deschidere.pdf')).id,
      [
        { account: '5121', side: 'D', amount: '5000.00' },
        { account: '1012', side: 'C', amount: '5000.00' },
      ],
      { date: '2026-01-01', purpose: 'opening' },
    ),
  );
  const file = async (filename: string, mediaType: string, bytes: string | Uint8Array) =>
    (
      await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
        filename,
        mediaType,
        base64: Buffer.from(bytes).toString('base64'),
      })
    ).id;
  const post = async (proposal: ProposalView) => {
    expect(proposal.issues.filter((issue) => issue.severity === 'block')).toEqual([]);
    return s.post(
      await s.approve(
        proposal,
        s.reviewer,
        proposal.issues.filter((issue) => issue.severity === 'ack').map((issue) => issue.code),
      ),
    );
  };
  const findings = async (month: string) =>
    ((await s.close(month)).preview as { findings: { code: string; items?: string[] }[] }).findings;
  return { s, file, post, findings };
}

/** A day's Z report as an agent reads it from its photo. */
const zBody = (number: number, date: string, cumulative: string | null) => ({
  seller: { name: 'Magazin Exemplu SRL', taxId: `RO${cui}`, country: 'RO' },
  register: '4400012345',
  number: String(number),
  issueDate: date,
  time: '21:05:00',
  receipts: 5,
  currency: 'RON',
  taxes: [
    { rate: '21', gross: '121.00', tax: '21.00' },
    { rate: '11', gross: '22.20', tax: '2.20' },
  ],
  totals: { gross: '143.20', tax: '23.20' },
  payments: [
    { method: 'cash', amount: '43.20', currency: 'RON' },
    { method: 'card', amount: '100.00', currency: 'RON' },
  ],
  cumulative: cumulative === null ? null : { gross: cumulative },
  items: [
    { code: 'CAF-1', name: 'Cafea boabe', quantity: '4', unit: 'H87', gross: '121.00', rate: '21' },
    { code: 'CIO-1', name: 'Ciocolată', quantity: '2', unit: 'H87', gross: '22.20', rate: '11' },
  ],
});

/** The same day as the register exports it (A4203), without its articles. */
const a4203 = (number: number, date: string) => {
  const compact = date.replaceAll('-', '');
  const id = `4400012345${compact}210500${String(number).padStart(4, '0')}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<msj xmlns="mfp:anaf:dgti:a4203:declaratie:v1" idM="${id}" cif="${cui}">
<rB idR="${id}" nrAv="0" nrB="5" totB="143.20" nrBC="0" totBC="0" nrA="0" totA="0" nrR="0" totR="0" nrM="0" totM="0" totTva="23.20" totTvaC="0" totTaxe="0" totNet="0" sume_serv_in="100" sume_serv_out="100" monRef="RON">
<pl tipP="3" valPl="43.20" monPl="RON"/><pl tipP="1" valPl="100.00" monPl="RON"/>
<coteZ cota="21" valOp="121.00" tva="21.00"/><coteZ cota="11" valOp="22.20" tva="2.20"/>
</rB></msj>`;
};

describe('a shop at cost (G1) with its cash register', () => {
  test('a month of Z reports: goods out by item, cards settled net of the fee, a missing day, B2C, D300 and D394', async () => {
    const { s, file, post, findings } = await company(
      {
        'policy.stock.valuation': 'fifo',
        'policy.stock.inventory': 'permanent',
        'policy.stock.negative': 'refuse',
        'policy.stock.retail': 'cost',
      },
      installed ? new AnafKits({ general: new DukIntegrator(dist) }) : undefined,
    );
    const coffee = await s.invoke<{ id: string }>(s.owner, 'stock.items.create', {
      code: 'CAF-1',
      name: 'Cafea boabe',
      unit: 'H87',
      account: '371',
      vatCategory: 'standard',
    });
    const chocolate = await s.invoke<{ id: string }>(s.owner, 'stock.items.create', {
      code: 'CIO-1',
      name: 'Ciocolată',
      unit: 'H87',
      account: '371',
      vatCategory: 'reduced',
    });
    const store = await s.invoke<{ id: string }>(s.owner, 'stock.warehouses.create', {
      code: 'M1',
      name: 'Magazin',
      keeper: 'Ionescu Maria',
    });
    const purchase = await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
      evidenceId: await file(
        'F-1.xml',
        'application/xml',
        invoiceXml({
          company: cui,
          number: 'F-1',
          date: '2026-10-01',
          counterparty: 'RO13548146',
          taxes: [
            { rate: '21', net: '500.00', tax: '105.00' },
            { rate: '11', net: '400.00', tax: '44.00' },
          ],
          net: '900.00',
          tax: '149.00',
          gross: '1049.00',
          lines: [
            { rate: '21', net: '500.00', name: 'Cafea boabe' },
            { rate: '11', net: '400.00', name: 'Ciocolată' },
          ],
        }),
      ),
    });
    await post(
      await s.propose('invoices.recognize', {
        documentId: purchase.id,
        allocations: [
          { account: '371', vat: 'S-21', amount: '500.00' },
          { account: '371', vat: 'S-11', amount: '400.00' },
        ],
        stock: {
          warehouseId: store.id,
          lines: [
            { line: '1', itemId: coffee.id, quantity: '50' },
            { line: '2', itemId: chocolate.id, quantity: '50' },
          ],
        },
      }),
    );

    // The register, tracked: its fiscalization recorded, its ANAF registration not yet.
    const register = await s.invoke<{ id: string }>(s.owner, 'retail.registers.record', {
      code: '4400012345',
      fiscalSeries: 'AB1234567',
      location: 'Galați, Str. Lungă 10',
      warehouseId: store.id,
      activeFrom: '2026-10-22',
      evidenceId: await file('fiscalizare.pdf', 'application/pdf', 'fiscalizare'),
    });
    const pending = (
      await s.invoke<{ items: { kind: string; details: { pending: string[] } }[] }>(
        s.owner,
        'work.list',
        {
          kinds: ['retail.register'],
        },
      )
    ).items;
    expect(pending[0]!.details.pending).toEqual(['anaf.registration', 'service']);
    await s.invoke(s.owner, 'retail.registers.event', {
      registerId: register.id,
      kind: 'anaf_registered',
      date: '2026-10-22',
      reference: 'ANAF-AMEF-1',
      evidenceId: await file('anaf.pdf', 'application/pdf', 'anaf'),
    });

    // The days: photos with their articles, one export from the register. Z 5 (27 October) is
    // recorded late; 26 October has no report.
    const days: [number, string][] = [
      [1, '2026-10-22'],
      [2, '2026-10-23'],
      [3, '2026-10-24'],
      [4, '2026-10-25'],
      [5, '2026-10-27'],
      [6, '2026-10-28'],
      [7, '2026-10-29'],
      [8, '2026-10-30'],
      [9, '2026-10-31'],
    ];
    const reports = new Map<number, string>();
    const record = async (number: number, date: string, cumulative: string | null) =>
      s.invoke<{ id: string }>(s.owner, 'documents.record', {
        evidenceId: await file(`z-${number}.png`, 'image/png', `z-photo-${number}-${cumulative}`),
        kind: 'zreport',
        body: zBody(number, date, cumulative),
      });
    const bookPhoto = async (id: string) =>
      post(
        await s.propose('retail.zReport', {
          documentId: id,
          cash: '5311',
          card: '5125',
          account: '707',
          stock: {
            warehouseId: store.id,
            lines: [
              { line: '1', itemId: coffee.id },
              { line: '2', itemId: chocolate.id },
            ],
          },
        }),
      );
    for (const [number, date] of days) {
      if (number === 5 || number === 8) continue;
      // Z 7's photo is read with a wrong running total first.
      const cumulative = number === 7 ? '1000.00' : (143.2 * number).toFixed(2);
      reports.set(number, (await record(number, date, cumulative)).id);
    }
    const before = await findings('2026-10');
    const finding = (code: string) => before.find((item) => item.code === code);
    expect(finding('ZREPORT_GAP')!.items).toEqual(['4400012345: 5, 8']);
    expect(finding('ZREPORT_CUMULATIVE')!.items).toEqual([
      '4400012345 Z 7: 1000.00 în loc de 1002.40',
    ]);
    expect(finding('ZREPORT_DAY')!.items).toEqual([
      '4400012345 2026-10-26',
      '4400012345 2026-10-27',
      '4400012345 2026-10-30',
    ]);
    expect(finding('ZREPORT_UNBOOKED')!.items).toHaveLength(7);
    // The photo corrected, then booked; Z 5 recorded.
    const corrected = await s.invoke<{ id: string }>(s.owner, 'documents.supersede', {
      documentId: reports.get(7),
      body: zBody(7, '2026-10-29', '1002.40'),
    });
    reports.set(7, corrected.id);
    reports.set(5, (await record(5, '2026-10-27', '716.00')).id);
    const booked = new Map<number, ProposalView>();
    for (const [number] of days) {
      if (number === 8) continue;
      booked.set(number, await bookPhoto(reports.get(number)!));
    }
    expect(lines(booked.get(1)!)).toEqual([
      'C 707 100.00',
      'C 707 20.00',
      'C 4427 21.00',
      'C 4427 2.20',
      'D 5311 43.20',
      'D 5125 100.00',
      'C 371 40.00',
      'C 371 16.00',
      'D 607 56.00',
    ]);

    // Z 8 from the register's export: only totals, so the goods sold are asked.
    const imported = await s.invoke<{ documentId: string; created: boolean }>(
      s.owner,
      'retail.importZ',
      {
        evidenceId: await file('Z_4400012345_0008.xml', 'application/xml', a4203(8, '2026-10-30')),
      },
    );
    expect(imported.created).toBe(true);
    const zInput = { documentId: imported.documentId, cash: '5311', card: '5125', account: '707' };
    const asked = await s.propose('retail.zReport', zInput);
    expect(codes(asked)).toContain('ZREPORT_GOODS');
    const question = await s.invoke<{ id: string }>(s.owner, 'questions.ask', {
      kind: 'retail.goods',
      subject: { kind: 'document', id: imported.documentId },
      params: { date: '2026-10-30' },
    });
    await s.invoke(s.owner, 'questions.answer', {
      questionId: question.id,
      value: {
        warehouseId: store.id,
        lines: [
          { itemId: coffee.id, quantity: '4' },
          { itemId: chocolate.id, quantity: '2' },
        ],
        evidenceId: await file('raport-gestiune.pdf', 'application/pdf', 'raport'),
      },
    });
    const answered = await post(
      await s.invoke<ProposalView>(s.owner, 'proposals.revise', {
        proposalId: asked.id,
        version: asked.version,
        input: zInput,
        basis: { answers: [question.id] },
      }),
    );
    expect(lines(answered)).toContain('D 607 56.00');
    reports.set(8, imported.documentId);

    // The register's month: no gap, the running total consistent, 26 October without a report.
    const after = await findings('2026-10');
    expect(
      after
        .filter((item) => item.code.startsWith('ZREPORT'))
        .map((item) => [item.code, item.items]),
    ).toEqual([['ZREPORT_DAY', ['4400012345 2026-10-26']]]);
    // FIFO: 36 bags and 18 bars sold of 50 each.
    const position = await s.invoke<{
      positions: { code: string; quantity: string; value: string }[];
    }>(s.owner, 'stock.register', { date: '2026-10-31' });
    expect(position.positions.map((row) => [row.code, row.quantity, row.value])).toEqual([
      ['CAF-1', '14.000', '140.00'],
      ['CIO-1', '32.000', '256.00'],
    ]);

    // The acquirer settles three days of cards, less its fee.
    await s.invoke(s.owner, 'bank.import', {
      evidenceId: await file(
        'extras.xml',
        'application/xml',
        camt({
          opening: '5000.00',
          closing: '5297.00',
          from: '2026-10-01',
          to: '2026-10-31',
          entries: camtEntry({
            amount: '297.00',
            date: '2026-10-27',
            direction: 'CRDT',
            bankRef: 'POS-SETTLE',
            text: 'Decontare POS',
          }),
        }),
      ),
      financialYearId: s.year.id,
    });
    const [movement] = await s.list<{ id: string }>(s.owner, 'bank.movements', {});
    const settled = await post(
      await s.propose('bank.settle', {
        movementId: movement!.id,
        cards: {
          account: '5125',
          settles: [1, 2, 3].map((number) => ({
            documentId: reports.get(number)!,
            amount: '100.00',
          })),
          fee: '3.00',
          feeAccount: '627',
        },
      }),
    );
    expect(lines(settled)).toEqual([
      'D 5121 297.00',
      'C 5125 100.00',
      'C 5125 100.00',
      'C 5125 100.00',
      'D 627 3.00',
    ]);

    // B2C: an invoice at a buyer's request for receipt 0003, without a code; one with a CNP.
    const series = await s.invoke<{ id: string }>(s.owner, 'sales.series.create', {
      code: 'XF',
      prefix: 'XF',
      width: 4,
      revenueAccount: '704',
    });
    const person = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_individual',
      country: 'RO',
      name: 'Ion Popescu',
    });
    await s.invoke(s.owner, 'parties.recordDetails', {
      partyId: person.id,
      details: {
        name: 'Ion Popescu',
        address: { lines: ['Str. Brăilei 3'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
      },
    });
    const sale = {
      seriesId: series.id,
      buyerId: person.id,
      issueDate: '2026-10-24',
      revenueAccount: '707',
      lines: [
        {
          name: 'Cafea boabe',
          quantity: '1',
          unitCode: 'H87',
          price: '25',
          vat: { category: 'S', rate: '21' },
        },
      ],
      receipt: { zReportId: reports.get(3)!, receipts: ['0003'] },
    };
    const unidentified = await s.invoke<{ problems: { code: string }[] }>(
      s.owner,
      'sales.preview',
      sale,
    );
    expect(unidentified.problems.map((problem) => problem.code)).toEqual(['B2C_IDENTIFICATION']);
    const forReceipt = await s.invoke<Issued>(s.owner, 'sales.issue', {
      ...sale,
      b2c: { identification: 'none' },
    });
    const xml = async (evidenceId: string) =>
      Buffer.from(
        (await s.invoke<{ base64: string }>(s.owner, 'evidence.get', { id: evidenceId })).base64,
        'base64',
      ).toString('utf8');
    expect(await xml(forReceipt.evidenceId)).toContain(
      '<cbc:CompanyID>0000000000000</cbc:CompanyID>',
    );
    expect(await xml(forReceipt.evidenceId)).toContain(
      'Conform bon fiscal nr. 0003 din 2026-10-24',
    );
    const recognized = await s.invoke<ProposalView>(s.owner, 'proposals.get', {
      id: forReceipt.recognition.proposalId!,
    });
    expect((recognized as unknown as { treatment: string }).treatment).toBe(
      'retail.receiptInvoice',
    );
    expect(recognized.effect!.lines).toEqual([]);
    await post(recognized);

    const customer = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_individual',
      country: 'RO',
      name: 'Maria Ionescu',
    });
    await s.invoke(s.owner, 'parties.recordDetails', {
      partyId: customer.id,
      details: {
        name: 'Maria Ionescu',
        address: {
          lines: ['Str. Domnească 7'],
          city: 'Galați',
          subdivision: 'RO-GL',
          country: 'RO',
        },
      },
    });
    const service = {
      seriesId: series.id,
      buyerId: customer.id,
      issueDate: '2026-10-28',
      lines: [
        {
          name: 'Montaj',
          quantity: '1',
          unitCode: 'C62',
          price: '100',
          vat: { category: 'S', rate: '21' },
        },
      ],
      b2c: { identification: 'cnp' },
    };
    expect(
      (
        await s.invoke<{ problems: { code: string }[] }>(s.owner, 'sales.preview', service)
      ).problems.map((problem) => problem.code),
    ).toEqual(['B2C_CNP']);
    await s.invoke(s.owner, 'parties.recordCnp', { partyId: customer.id, cnp });
    const preview = await s.invoke<{ xml: string | null }>(s.owner, 'sales.preview', service);
    expect(preview.xml).not.toContain(cnp);
    const withCnp = await s.invoke<Issued>(s.owner, 'sales.issue', service);
    expect(await xml(withCnp.evidenceId)).toContain(`<cbc:CompanyID>${cnp}</cbc:CompanyID>`);
    await post(
      await s.invoke<ProposalView>(s.owner, 'proposals.get', {
        id: withCnp.recognition.proposalId!,
      }),
    );

    // Both B2C invoices are due to RO e-Factura within 5 working days of their issue.
    const due = (
      await s.invoke<{
        items: { kind: string; severity: string; due: string; details: { number: string } }[];
      }>(s.owner, 'work.list', { kinds: ['efactura.due'] })
    ).items;
    expect(due.map((item) => [item.details.number, item.due, item.severity]).sort()).toEqual([
      ['XF0001', addWorkingDays('2026-10-24' as LocalDate, 5), 'block'],
      ['XF0002', addWorkingDays('2026-10-28' as LocalDate, 5), 'block'],
    ]);

    // October's returns: the receipts' VAT once, with the Z reports.
    const prepare = (kind: 'D300' | 'D394') =>
      s.invoke<Artifact>(s.owner, 'declarations.prepare', {
        kind,
        period: '2026-10',
        options: kind === 'D300' ? d300Options : d394Options,
      });
    const d300 = await prepare('D300');
    expect(summary(d300).rows).toMatchObject({ R9_1: 1000, R9_2: 210, R10_1: 180, R10_2: 20 });
    const d394 = await prepare('D394');
    expect(summary(d394).operations).toEqual(
      expect.arrayContaining([
        { type: 'A', rate: '21', partner: '13548146', invoices: 1, base: 500, vat: 105 },
        { type: 'L', rate: '21', partner: 'Ion Popescu', invoices: 1, base: 25, vat: 5 },
        { type: 'L', rate: '21', partner: 'Maria Ionescu', invoices: 1, base: 100, vat: 21 },
      ]),
    );
    if (installed) {
      expect([d300.state, d300.steps.at(-1)?.detail ?? null]).toEqual(['validated_official', null]);
      expect([d394.state, d394.steps.at(-1)?.detail ?? null]).toEqual(['validated_official', null]);
    }
    const written = await xml(d394.evidenceId);
    expect(written).toMatch(
      /<op2 tip_op2="I1" luna="10" nrAMEF="1" nrBF="44" total="1259"[^>]*baza21="875"[^>]*TVA21="184"/,
    );
    expect(written).toContain('nr_BF_i1="44" incasari_i1="1259"');
  });
});

describe('a shop at retail price (OMFP 1802/2014 pct. 286 alin. (8))', () => {
  test('received at sale price, sold on Z reports, repriced, counted, discharged by the coefficient', async () => {
    const { s, file, post, findings } = await company({
      'policy.stock.retail': 'retail',
      'policy.stock.inventory': 'permanent',
    });
    const store = await s.invoke<{ id: string }>(s.owner, 'stock.warehouses.create', {
      code: 'M2',
      name: 'Magazin centru',
      keeper: 'Ionescu Maria',
    });
    const accounts = await s.invoke<{ accounts: string[] }>(s.owner, 'retail.setup', {
      warehouseId: store.id,
      rates: ['21', '11'],
    });
    expect(accounts.accounts).toEqual([
      '371.M2-21',
      '371.M2-11',
      '378.M2',
      '4428.M2-21',
      '4428.M2-11',
    ]);
    // A general entry cannot reach the goods at retail price.
    const journalled = await s.propose(
      'ledger.general',
      journal((await s.evidence('nota.pdf')).id, [
        { account: '371.M2-21', side: 'D', amount: '10.00' },
        { account: '5121', side: 'C', amount: '10.00' },
      ]),
    );
    expect(codes(journalled)).toContain('RETAIL_ACCOUNT');
    await s.invoke(s.owner, 'proposals.withdraw', {
      proposalId: journalled.id,
      reason: 'Cont la preț cu amănuntul',
    });

    // Received at sale price: 1.000,00 cost, 1.815,00 with VAT on the shelf.
    const invoice = await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
      evidenceId: await file(
        'F-2.xml',
        'application/xml',
        invoiceXml({
          company: cui,
          number: 'F-2',
          date: '2026-10-05',
          counterparty: 'RO13548146',
          net: '1000.00',
          tax: '210.00',
          gross: '1210.00',
        }),
      ),
    });
    const received = await post(
      await s.propose('invoices.recognize', {
        documentId: invoice.id,
        account: '371.M2-21',
        retail: {
          warehouseId: store.id,
          evidenceId: await file('nir.pdf', 'application/pdf', 'nir'),
          prices: [{ account: '371.M2-21', sale: '1815.00' }],
        },
      }),
    );
    expect(lines(received)).toEqual([
      'D 371.M2-21 1000.00',
      'D 4426 210.00',
      'C 401 1210.00',
      'D 371.M2-21 315.00',
      'C 4428.M2-21 315.00',
      'D 371.M2-21 500.00',
      'C 378.M2 500.00',
    ]);

    // Sold on 20 October: 605,00 with VAT, out at sale price.
    const z = await s.invoke<{ id: string }>(s.owner, 'documents.record', {
      evidenceId: await file('z-m2.png', 'image/png', 'z-m2'),
      kind: 'zreport',
      body: {
        seller: { name: 'Magazin Exemplu SRL', taxId: `RO${cui}`, country: 'RO' },
        register: '4400099999',
        number: '1',
        issueDate: '2026-10-20',
        receipts: 12,
        currency: 'RON',
        taxes: [{ rate: '21', gross: '605.00', tax: '105.00' }],
        totals: { gross: '605.00', tax: '105.00' },
        payments: [{ method: 'cash', amount: '605.00', currency: 'RON' }],
      },
    });
    const sold = await post(
      await s.propose('retail.zReport', {
        documentId: z.id,
        cash: '5311',
        account: '707',
        goods: { warehouseId: store.id },
      }),
    );
    expect(lines(sold)).toEqual([
      'C 707 500.00',
      'C 4427 105.00',
      'D 5311 605.00',
      'C 371.M2-21 605.00',
      'D 607 605.00',
    ]);
    // Higher prices from 25 October: +121,00 with VAT, the markup recalculated.
    const repriced = await post(
      await s.propose('retail.reprice', {
        date: '2026-10-25',
        warehouseId: store.id,
        evidenceId: await file('preturi.pdf', 'application/pdf', 'preturi'),
        changes: [{ rate: '21', amount: '121.00' }],
      }),
    );
    expect(lines(repriced)).toEqual([
      'D 371.M2-21 121.00',
      'C 4428.M2-21 21.00',
      'C 378.M2 100.00',
    ]);
    expect((await findings('2026-10')).map((item) => item.code)).toContain(
      'RETAIL_DISCHARGE_MISSING',
    );
    // Counted on 31 October at sale price: 1.301,00 against 1.331,00, unimputable. The
    // coefficient (500 + 100) ÷ (1.936 − 336) = 37,5%: the shortage's cost 24,79 − 9,30 = 15,49,
    // its deducted VAT 3,25.
    const counted = await post(
      await s.propose('retail.count', {
        date: '2026-10-31',
        warehouseId: store.id,
        evidenceId: await file('inventar.pdf', 'application/pdf', 'inventar'),
        rows: [{ rate: '21', counted: '1301.00' }],
        cause: 'unimputable',
      }),
    );
    expect(lines(counted)).toEqual([
      'C 371.M2-21 30.00',
      'D 607 30.00',
      'D 635 3.25',
      'C 4426 3.25',
    ]);
    // The month's discharge: exits 635,00, their VAT 110,21, the markup 524,79 × 37,5% = 196,80.
    const discharged = await post(
      await s.propose('retail.discharge', { month: '2026-10', warehouseId: store.id }),
    );
    expect(lines(discharged)).toEqual([
      'D 378.M2 196.80',
      'C 607 196.80',
      'D 4428.M2-21 110.21',
      'C 607 110.21',
    ]);
    expect((await findings('2026-10')).map((item) => item.code)).not.toContain(
      'RETAIL_DISCHARGE_MISSING',
    );
    const position = await s.invoke<{
      rates: { rate: string; goods: string; vat: string }[];
      markup: string;
      cost: string;
    }>(s.owner, 'retail.position', { warehouseId: store.id, date: '2026-10-31' });
    expect(position).toMatchObject({
      rates: [{ rate: '21', goods: '1301.00', vat: '225.79' }],
      markup: '403.20',
      cost: '672.01',
    });

    // The month's D406: the reception's VAT on its cost's line, not on the VAT included and the
    // markup added on top; the count's adjustment on 635; the discharge in the general journal;
    // the warehouse's analytics numbered as the company's chart numbers them; no customer.
    await s.invoke(s.owner, 'parties.recordDetails', {
      partyId: (await s.invoke<{ partyId: string }>(s.owner, 'documents.get', { id: invoice.id }))
        .partyId,
      details: {
        name: 'Furnizor Exemplu SRL',
        vatId: 'RO13548146',
        address: {
          lines: ['Str. Portului 3'],
          city: 'Brăila',
          subdivision: 'RO-BR',
          country: 'RO',
        },
      },
    });
    const saft = await s.invoke<{ state: string; evidenceId: string }>(
      s.owner,
      'declarations.prepare',
      {
        kind: 'D406',
        period: '2026-10',
        options: {
          contact: { firstName: 'Ana', lastName: 'Popescu', phone: '0236000000' },
          accounts: { '635': '635' },
          accountIds: { '371.M2-21': '3712021', '378.M2': '37802', '4428.M2-21': '44282021' },
        },
      },
    );
    expect(saft.state).toBe('prepared');
    const written = Buffer.from(
      (await s.invoke<{ base64: string }>(s.owner, 'evidence.get', { id: saft.evidenceId })).base64,
      'base64',
    ).toString('utf8');
    expect(written).toContain('<nsSAFT:AccountID>3712021</nsSAFT:AccountID>');
    expect(written).toContain('<nsSAFT:Customers/>');
  });
});

/** A shop's warehouse M2 at retail price (21%): received at sale price, sold on Z reports. */
async function retailShop(
  policies: Record<string, string> = {
    'policy.stock.retail': 'retail',
    'policy.stock.inventory': 'permanent',
  },
) {
  const c = await company(policies);
  const { s, file, post } = c;
  const store = await s.invoke<{ id: string }>(s.owner, 'stock.warehouses.create', {
    code: 'M2',
    name: 'Magazin centru',
    keeper: 'Ionescu Maria',
  });
  await s.invoke(s.owner, 'retail.setup', { warehouseId: store.id, rates: ['21'] });
  /** A purchase of 1.000 + 210 VAT received at a sale price with VAT. */
  const receive = async (number: string, date: string, sale: string) => {
    const invoice = await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
      evidenceId: await file(
        `${number}.xml`,
        'application/xml',
        invoiceXml({
          company: cui,
          number,
          date,
          counterparty: 'RO13548146',
          net: '1000.00',
          tax: '210.00',
          gross: '1210.00',
        }),
      ),
    });
    return post(
      await s.propose('invoices.recognize', {
        documentId: invoice.id,
        account: '371.M2-21',
        retail: {
          warehouseId: store.id,
          evidenceId: await file(`nir-${number}.pdf`, 'application/pdf', number),
          prices: [{ account: '371.M2-21', sale }],
        },
      }),
    );
  };
  /** A Z report of the shop's register selling goods at 21%, paid in cash. */
  const zReport = async (number: number, date: string, gross: string, tax: string) =>
    s.invoke<{ id: string }>(s.owner, 'documents.record', {
      evidenceId: await file(`z-m2-${number}.png`, 'image/png', `z-m2-${number}`),
      kind: 'zreport',
      body: {
        seller: { name: 'Magazin Exemplu SRL', taxId: `RO${cui}`, country: 'RO' },
        register: '4400099999',
        number: String(number),
        issueDate: date,
        receipts: 3,
        currency: 'RON',
        taxes: [{ rate: '21', gross, tax }],
        totals: { gross, tax },
        payments: [{ method: 'cash', amount: gross, currency: 'RON' }],
      },
    });
  const sell = async (number: number, date: string, gross: string, tax: string) =>
    post(
      await s.propose('retail.zReport', {
        documentId: (await zReport(number, date, gross, tax)).id,
        cash: '5311',
        account: '707',
        goods: { warehouseId: store.id },
      }),
    );
  return { ...c, store, receive, zReport, sell };
}

// The review of November 2026 (review-findings.integration.test.ts), fixed.
describe('the retail price method’s discharge (pct. 286 alin. (4))', () => {
  // The year basis applied the coefficient cumulated from the year's start to the month's exits
  // alone, without taking off what earlier months discharged.
  test('the year basis discharges what a warehouse emptied each month holds', async () => {
    const { s, store, receive, sell, post } = await retailShop();
    // September: cost 1.000, sale 1.100 + 231 VAT (markup 100), all sold.
    await receive('F-9', '2026-09-05', '1331.00');
    await sell(1, '2026-09-20', '1331.00', '231.00');
    const september = await post(
      await s.propose('retail.discharge', { month: '2026-09', warehouseId: store.id }),
    );
    expect(lines(september)).toEqual([
      'D 378.M2 100.00',
      'C 607 100.00',
      'D 4428.M2-21 231.00',
      'C 607 231.00',
    ]);
    // October: cost 1.000, sale 1.500 + 315 VAT (markup 500), all sold: nothing is left, so the
    // whole 500 is discharged and 607 holds the two costs.
    await receive('F-10', '2026-10-05', '1815.00');
    await sell(2, '2026-10-20', '1815.00', '315.00');
    const october = await s.propose('retail.discharge', {
      month: '2026-10',
      warehouseId: store.id,
    });
    expect(lines(october)).toEqual([
      'D 378.M2 500.00',
      'C 607 500.00',
      'D 4428.M2-21 315.00',
      'C 607 315.00',
    ]);
  });

  // Exits were read as the credit turnover of 371 and entries as its debits: a black storno swaps
  // the sides, so a reversed reception read as goods sold, its markup and VAT discharged onto 607
  // (D 378 500 / C 607 500, D 4428 315 / C 607 315).
  test('a reception reversed by black storno is not an exit', async () => {
    const { s, store, receive, findings } = await retailShop();
    const received = await receive('F-1', '2026-10-05', '1815.00');
    await s.book('ledger.reverse', {
      entryId: received.entry!.id,
      date: '2026-10-10',
      reason: 'Recepție înregistrată din greșeală.',
      evidenceId: (await s.evidence('storno.pdf')).id,
      method: 'black',
    });
    const discharge = await s.propose('retail.discharge', {
      month: '2026-10',
      warehouseId: store.id,
    });
    expect(discharge.effect).toBeNull();
    expect(codes(discharge)).toEqual(['RETAIL_NO_EXITS']);
    // The close reads the month's exits the same way: none, so no discharge is asked for.
    expect((await findings('2026-10')).map((item) => item.code)).not.toContain(
      'RETAIL_DISCHARGE_MISSING',
    );
  });

  test('a Z report reversed by black storno is a negative exit, not an entry', async () => {
    const { s, store, receive, sell, post } = await retailShop();
    // Cost 1.000, sale 1.500 + 315 VAT; 605 sold, then 605 more, the second reversed in black.
    await receive('F-1', '2026-10-05', '1815.00');
    await sell(1, '2026-10-20', '605.00', '105.00');
    const wrong = await sell(2, '2026-10-21', '605.00', '105.00');
    await s.book('ledger.reverse', {
      entryId: wrong.entry!.id,
      date: '2026-10-22',
      reason: 'Raport Z înregistrat de două ori.',
      evidenceId: (await s.evidence('storno-z.pdf')).id,
      method: 'black',
    });
    // One exit of 605 (500 without VAT) at K = 500 ÷ 1.500: 166,67 of markup, 105 of VAT.
    const discharged = await post(
      await s.propose('retail.discharge', { month: '2026-10', warehouseId: store.id }),
    );
    expect(lines(discharged)).toEqual([
      'D 378.M2 166.67',
      'C 607 166.67',
      'D 4428.M2-21 105.00',
      'C 607 105.00',
    ]);
  });
});

// One shop, two warehouses: M1 by item at cost (FIFO), M2 at retail price. The method is each
// warehouse's dated fact (`policy.stock.retail.<warehouseId>`), the company's
// `policy.stock.retail` the default (OMFP 1802/2014 pct. 286 alin. (8), 287 alin. (3)).
describe('a warehouse at cost beside one at retail price', () => {
  test('each warehouse keeps its method: quantities at cost in one, sale price in the other', async () => {
    const { s, file, post, store, receive, sell } = await retailShop({
      'policy.stock.retail': 'retail',
      'policy.stock.inventory': 'permanent',
      'policy.stock.valuation': 'fifo',
      'policy.stock.negative': 'refuse',
    });
    const counter = await s.invoke<{ id: string }>(s.owner, 'stock.warehouses.create', {
      code: 'M1',
      name: 'Magazin vechi',
      keeper: 'Popa Ion',
    });
    const coffee = await s.invoke<{ id: string }>(s.owner, 'stock.items.create', {
      code: 'CAF-1',
      name: 'Cafea boabe',
      unit: 'H87',
      account: '371',
      vatCategory: 'standard',
    });
    const supplier = await s.party('Furnizor Cafea SRL', '14399840');
    const receipt = async (warehouseId: string, reference: string) => ({
      date: '2026-10-02',
      warehouseId,
      supplierId: supplier.id,
      reference,
      evidenceId: (await s.evidence(`${reference}.pdf`)).id,
      lines: [{ itemId: coffee.id, quantity: '10', value: '100.00' }],
    });
    // The company's fact keeps M1 at retail price too, until its own says otherwise.
    const early = await s.propose('stock.receive', await receipt(counter.id, 'AV-0'));
    expect(codes(early)).toEqual(['STOCK_RETAIL_METHOD']);
    await s.invoke(s.owner, 'proposals.withdraw', {
      proposalId: early.id,
      reason: 'Gestiunea M1 se ține la cost',
    });
    const policy = (await s.evidence('politici-gestiuni.pdf')).id;
    const fact = (warehouseId: string, value: string) =>
      s.invoke(s.owner, 'profile.record', {
        axis: `policy.stock.retail.${warehouseId}`,
        value,
        effectiveFrom: '2026-01-01',
        evidenceId: policy,
      });
    // A warehouse the company has, at cost or at retail price.
    expect((await s.refused(fact(crypto.randomUUID(), 'cost')))?.code).toBe('WAREHOUSE');
    expect(await s.refused(fact(counter.id, 'fifo'))).toBeDefined();
    await fact(counter.id, 'cost');

    // M1: by quantity, FIFO, out on its register's Z report by article.
    const received = await s.book('stock.receive', await receipt(counter.id, 'AV-1'));
    expect(lines(received)).toEqual(['D 371 100.00', 'C 408 100.00']);
    const z1 = await s.invoke<{ id: string }>(s.owner, 'documents.record', {
      evidenceId: await file('z-m1-1.png', 'image/png', 'z-m1-1'),
      kind: 'zreport',
      body: {
        seller: { name: 'Magazin Exemplu SRL', taxId: `RO${cui}`, country: 'RO' },
        register: '4400011111',
        number: '1',
        issueDate: '2026-10-20',
        receipts: 4,
        currency: 'RON',
        taxes: [{ rate: '21', gross: '121.00', tax: '21.00' }],
        totals: { gross: '121.00', tax: '21.00' },
        payments: [{ method: 'cash', amount: '121.00', currency: 'RON' }],
        items: [
          {
            code: 'CAF-1',
            name: 'Cafea boabe',
            quantity: '4',
            unit: 'H87',
            gross: '121.00',
            rate: '21',
          },
        ],
      },
    });
    const atCost = (warehouseId: string) => ({
      documentId: z1.id,
      cash: '5311',
      account: '707',
      stock: { warehouseId, lines: [{ line: '1', itemId: coffee.id }] },
    });
    // Not out of M2: its goods are kept by value at sale price.
    const fromShop = await s.propose('retail.zReport', atCost(store.id));
    expect(codes(fromShop)).toContain('RETAIL_POLICY');
    const z1Booked = await s.revise('retail.zReport', fromShop, atCost(counter.id));
    expect(lines(z1Booked)).toEqual([
      'C 707 100.00',
      'C 4427 21.00',
      'D 5311 121.00',
      'C 371 40.00',
      'D 607 40.00',
    ]);
    await post(z1Booked);

    // M2: at sale price, its quantity treatments refused, its Z report discharged monthly.
    expect(codes(await s.propose('stock.receive', await receipt(store.id, 'AV-2')))).toEqual([
      'STOCK_RETAIL_METHOD',
    ]);
    await receive('F-2', '2026-10-05', '1815.00');
    await sell(1, '2026-10-21', '605.00', '105.00');
    expect(
      codes(await s.propose('retail.discharge', { month: '2026-10', warehouseId: counter.id })),
    ).toContain('RETAIL_POLICY');
    const discharged = await post(
      await s.propose('retail.discharge', { month: '2026-10', warehouseId: store.id }),
    );
    expect(lines(discharged)).toEqual([
      'D 378.M2 166.67',
      'C 607 166.67',
      'D 4428.M2-21 105.00',
      'C 607 105.00',
    ]);
    const register = await s.invoke<{ positions: { code: string; quantity: string }[] }>(
      s.owner,
      'stock.register',
      {},
    );
    expect(register.positions.map((row) => `${row.code} ${row.quantity}`)).toEqual(['CAF-1 6.000']);
  });

  test('the company at cost, its shop’s warehouse at retail price by its own fact', async () => {
    const c = await company({
      'policy.stock.retail': 'cost',
      'policy.stock.inventory': 'permanent',
      'policy.stock.valuation': 'fifo',
      'policy.stock.negative': 'refuse',
    });
    const store = await c.s.invoke<{ id: string }>(c.s.owner, 'stock.warehouses.create', {
      code: 'M2',
      name: 'Magazin centru',
      keeper: 'Ionescu Maria',
    });
    await c.s.invoke(c.s.owner, 'retail.setup', { warehouseId: store.id, rates: ['21'] });
    const discharge = () =>
      c.s.propose('retail.discharge', { month: '2026-10', warehouseId: store.id });
    const refused = await discharge();
    expect(codes(refused)).toContain('RETAIL_POLICY');
    await c.s.invoke(c.s.owner, 'proposals.withdraw', {
      proposalId: refused.id,
      reason: 'Gestiunea M2 se ține la preț cu amănuntul',
    });
    await c.s.invoke(c.s.owner, 'profile.record', {
      axis: `policy.stock.retail.${store.id}`,
      value: 'retail',
      effectiveFrom: '2026-10-01',
      evidenceId: (await c.s.evidence('politica-m2.pdf')).id,
    });
    expect(codes(await discharge())).toEqual(['RETAIL_NO_EXITS']);
  });
});

describe('agent-ready', () => {
  test('its documents, its question, its detectors and operations', async () => {
    const { s } = await company({ 'policy.stock.inventory': 'permanent' });
    expect(retailAgent.documentTypes.map((item) => item.id)).toContain('retail.zreport');
    expect(retailAgent.questions.map((item) => item.kind)).toContain('retail.goods');
    expect(retailAgent.detectors.map((item) => item.kind)).toEqual([
      'close.finding',
      'question.needed',
      'document.unproposed',
      'efactura.due',
      'retail.register',
    ]);
    for (const id of [
      'retail.zReport.propose',
      'retail.discharge.propose',
      'retail.count.propose',
      'retail.importZ',
      'retail.registers.event',
    ])
      expect(s.engine.operations.get(id).agent).toBe(true);
    expect(s.engine.operations.get('retail.registers.record').agent).toBe(false);
  });
});
