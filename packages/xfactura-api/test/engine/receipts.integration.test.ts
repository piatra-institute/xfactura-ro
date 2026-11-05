import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import * as receiptsAgent from 'xfactura-core/ro/receipts/agent';
import {
  AnafKits,
  DukIntegrator,
  saftKitId,
  type DeclarationValidator,
} from '../../source/engine/adapters/declaration-validator';
import type { ProposalView } from '../../source/engine/kernel/views';
import { camt, camtEntry, iban } from './fixtures/bank';
import { invoiceXml } from './fixtures/invoice';
import type { Issued, Preview } from './fixtures/sales';
import { journal, scenario, type Scenario } from './scenario';

// Receipts and the domestic reverse charge (V3) from the books to the returns. Amounts by hand:
//   fuel 300,00 lei at 21%: VAT 52,07 (300 × 21 / 121), net 247,93; half deducted 26,04.
//   100 euro at BNR's 5,0815 of 16.10.2026 = 508,15 lei, the limit of a receipt of 18.10.2026.
//   waste bought 10.000,00 lei: VAT self-assessed 2.100,00, collected and deducted.
//   waste sold 5.000,00 lei: no VAT, rd. 13.

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});
const dist = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
const official = DukIntegrator.available(dist) && Bun.which('java') ? test : test.skip;
// D406 runs on ANAF's SAF-T kit only; without it the D406 part is skipped, never passed.
const saftDist = path.join(
  import.meta.dir,
  '../../../..',
  '.validators/anaf-saft/duk_SAFT_an_luna/dist',
);
const saftInstalled = DukIntegrator.available(saftDist) && Bun.which('java') !== null;
const cui = '18547290';
const plate = 'B-123-XFA';
const bnr = (days: string[]) => `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher><PublishingDate>${days.at(-1)}</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
${days.map((day) => `<Cube date="${day}"><Rate currency="EUR">5.0815</Rate></Cube>`).join('\n')}
</Body></DataSet>`;
const d300Options = {
  declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
  caen: '6201',
  bank: 'Banca Exemplu',
  account: 'RO49AAAA1B31007593840000',
};
const d394Options = {
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
type Artifact = {
  id: string;
  state: string;
  evidenceId: string;
  steps: { state: string; detail: string | null }[];
};
type Item = {
  id: string;
  partyId: string;
  document: string | null;
  balance: string;
  account: string;
};
type WorkItem = {
  kind: string;
  subject: { id: string };
  next: { operation: string; inputHint: Record<string, unknown> }[];
};
const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);

async function company(validator?: DeclarationValidator) {
  const s = await scenario({ cui, ...(validator ? { declarationValidator: validator } : {}) });
  open.push(s);
  const file = async (filename: string, mediaType: string, bytes: string) =>
    (
      await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
        filename,
        mediaType,
        base64: Buffer.from(bytes).toString('base64'),
      })
    ).id;
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
  await s.invoke(s.owner, 'fx.importBnr', {
    evidenceId: await file(
      'nbrfxrates.xml',
      'application/xml',
      bnr(['2026-08-14', '2026-09-18', '2026-10-16']),
    ),
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
        { account: '5311', side: 'D', amount: '2000.00' },
        { account: '1012', side: 'C', amount: '7000.00' },
      ],
      { date: '2026-01-01', purpose: 'opening' },
    ),
  );
  let photos = 0;
  /** A fuel receipt read from a photo: 300,00 lei at 21% unless said otherwise. */
  const receipt = async (
    number: string,
    extra: Record<string, unknown> = {},
    date = '2026-10-18',
  ) =>
    s.invoke<{ id: string; partyId: string }>(s.owner, 'documents.record', {
      evidenceId: await file(`bon-${number}.png`, 'image/png', `photo-${++photos}`),
      kind: 'receipt.received',
      body: {
        seller: { name: 'Benzinăria Exemplu SRL', taxId: 'RO29031773', country: 'RO' },
        buyerTaxId: `RO${cui}`,
        number,
        register: '4400012345',
        issueDate: date,
        currency: 'RON',
        lines: [{ description: 'Motorină standard', gross: '300.00', vatRate: '21' }],
        taxes: [{ rate: '21', gross: '300.00', tax: '52.07' }],
        totals: { gross: '300.00', tax: '52.07' },
        payment: 'card',
        ...extra,
      },
    });
  /** Proposes and posts, acknowledging the warnings a reviewer confirms. */
  const post = async (proposal: ProposalView) => {
    expect(proposal.issues.filter((issue) => issue.severity === 'block')).toEqual([]);
    const acknowledge = proposal.issues
      .filter((issue) => issue.severity === 'ack')
      .map((issue) => issue.code);
    return s.post(await s.approve(proposal, s.reviewer, acknowledge));
  };
  const book = async (treatment: string, input: unknown, basis?: { answers: string[] }) =>
    post(
      await s.invoke<ProposalView>(s.owner, 'proposals.propose', {
        treatment,
        input,
        ...(basis ? { basis } : {}),
      }),
    );
  const items = () => s.list<Item>(s.owner, 'openItems.list', {});
  const prepare = (kind: 'D300' | 'D394', period = '2026-10') =>
    s.invoke<Artifact>(s.owner, 'declarations.prepare', {
      kind,
      period,
      options: kind === 'D300' ? d300Options : d394Options,
    });
  const work = async () =>
    (
      await s.invoke<{ items: WorkItem[] }>(s.owner, 'work.list', {
        kinds: ['document.unproposed'],
      })
    ).items;
  return { s, file, receipt, post, book, items, prepare, work };
}

const summary = (artifact: Artifact) => JSON.parse(artifact.steps[0]!.detail!);

describe('receipts.recognize', () => {
  test('a fuel receipt with the CUI, within the limit, through the vehicle question, paid by card', async () => {
    const { s, receipt, post, book, items, prepare, work } = await company();
    const document = await receipt('0042');
    // The worklist offers its booking.
    const [item] = (await work()).filter((entry) => entry.subject.id === document.id);
    expect(item!.next[0]).toMatchObject({
      operation: 'proposals.propose',
      inputHint: { treatment: 'receipts.recognize', input: { documentId: document.id } },
    });
    const input = {
      documentId: document.id,
      account: '6022',
      vehicle: plate,
      deduction: 'limited',
      payment: { method: 'card' },
    };
    const asked = await s.propose('receipts.recognize', input);
    expect(asked.status).toBe('blocked');
    expect(asked.issues.map((issue) => issue.code)).toContain('VEHICLE_USE');
    const question = await s.invoke<{ id: string }>(s.owner, 'questions.ask', {
      kind: 'vehicle.use',
      subject: { kind: 'vehicle', id: plate },
      params: { documentId: document.id, date: '2026-10-18' },
    });
    await s.invoke(s.owner, 'questions.answer', {
      questionId: question.id,
      value: { use: 'mixed', from: '2026-01-01' },
    });
    const posted = await post(
      await s.invoke<ProposalView>(s.owner, 'proposals.revise', {
        proposalId: asked.id,
        version: asked.version,
        input,
        basis: { answers: [question.id] },
      }),
    );
    expect(posted.status).toBe('posted');
    expect(lines(posted)).toEqual(['D 6022 273.96', 'D 4426 26.04', 'C 401 300.00']);
    // The card payment the bank reports settles the seller's payable.
    const { id: statement } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'extras.xml',
      mediaType: 'application/xml',
      base64: Buffer.from(
        camt({
          opening: '5000.00',
          closing: '4700.00',
          from: '2026-10-01',
          to: '2026-10-31',
          entries: camtEntry({
            amount: '300.00',
            date: '2026-10-19',
            bankRef: 'POS-1019',
            text: 'Plata card POS Benzinaria Exemplu',
          }),
        }),
      ).toString('base64'),
    });
    await s.invoke(s.owner, 'bank.import', { evidenceId: statement, financialYearId: s.year.id });
    const [movement] = await s.list<{ id: string }>(s.owner, 'bank.movements', {});
    const payable = (await items()).find((entry) => entry.document === '0042')!;
    expect(payable.balance).toBe('-300.00');
    await book('bank.settle', {
      movementId: movement!.id,
      allocations: [{ openItem: payable.id, amount: '300.00' }],
    });
    expect((await items()).find((entry) => entry.id === payable.id)).toBeUndefined();
    // Booked once: a second proposal of the same receipt is refused.
    expect(
      (await s.refused(s.propose('receipts.recognize', { ...input, deduction: 'full' })))?.code,
    ).toBe('SUBJECT_EXISTS');
    // D300: the purchase at 21% with all its VAT, half of it deducted.
    const d300 = summary(await prepare('D300'));
    expect([d300.rows.R22_1, d300.rows.R22_2, d300.rows.R28_2]).toEqual([248, 52, 26]);
  });

  test('without the CUI, or over the limit, the VAT stays in the expense and no return lists it', async () => {
    const { receipt, book, post, prepare, s } = await company();
    const plain = await receipt('0043', { buyerTaxId: null });
    const refused = await s.propose('receipts.recognize', {
      documentId: plain.id,
      account: '6022',
      payment: { method: 'card' },
    });
    expect(refused.issues.map((issue) => issue.code)).toContain('DEDUCTION');
    const none = await post(
      await s.revise('receipts.recognize', refused, {
        documentId: plain.id,
        account: '6022',
        deduction: 'none',
        payment: { method: 'card' },
      }),
    );
    expect(lines(none)).toEqual(['D 6022 300.00', 'C 401 300.00']);
    const large = await receipt('0044', {
      lines: [{ description: 'Motorină standard', gross: '520.00', vatRate: '21' }],
      taxes: [{ rate: '21', gross: '520.00', tax: '90.25' }],
      totals: { gross: '520.00', tax: '90.25' },
    });
    const over = await book('receipts.recognize', {
      documentId: large.id,
      account: '6022',
      deduction: 'none',
      payment: { method: 'card' },
    });
    expect(over.issues.map((issue) => issue.code)).toContain('RECEIPT_INVOICE_EXPECTED');
    expect(over.effect!.taxEntries).toEqual([]);
    expect(summary(await prepare('D300')).rows.R22_1).toBeUndefined();
  });

  test('cash from the cash desk, and an employee from an advance or their own money', async () => {
    const { s, receipt, book, items } = await company();
    // Cash: one entry, the receipt in the cash register.
    const cash = await receipt('0045', { payment: 'cash' });
    const paid = await book('receipts.recognize', {
      documentId: cash.id,
      account: '6022',
      deduction: 'limited',
      payment: { method: 'cash', account: '5311' },
    });
    // The limited share without a named vehicle, confirmed: 52,07 × 50% = 26,035, half up 26,04.
    expect(paid.issues.map((issue) => issue.code)).toContain('VEHICLE_UNNAMED');
    expect(lines(paid)).toEqual(['D 6022 273.96', 'D 4426 26.04', 'C 5311 300.00']);
    const register = await s.invoke<{
      days: { movements: { document: string; payment: string | null }[] }[];
    }>(s.owner, 'cash.register', { account: '5311', from: '2026-10-01', to: '2026-10-31' });
    expect(register.days.flatMap((day) => day.movements)).toEqual([
      expect.objectContaining({ document: 'BF 0045', payment: '300.00' }),
    ]);
    // An advance of 500,00 lei to an employee, justified by a receipt and an expense report.
    const employee = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_individual',
      country: 'RO',
      name: 'Ionescu Maria',
    });
    await book('cash.record', {
      account: '5311',
      date: '2026-10-17',
      direction: 'payment',
      number: 'DP-1',
      partyId: employee.id,
      evidenceId: (await s.evidence('dispozitie-plata.pdf')).id,
      opens: [{ account: '542', amount: '500.00' }],
    });
    const advance = (await items()).find((entry) => entry.account === '542')!;
    const report = (await s.evidence('decont.pdf')).id;
    const spent = await receipt('0046');
    const settled = await book('receipts.recognize', {
      documentId: spent.id,
      account: '6022',
      deduction: 'limited',
      payment: { method: 'advance', advanceId: advance.id },
      reportEvidenceId: report,
    });
    expect(lines(settled)).toEqual(['D 6022 273.96', 'D 4426 26.04', 'C 542 300.00']);
    expect((await items()).find((entry) => entry.id === advance.id)!.balance).toBe('200.00');
    // Paid from her own money: owed to her on 542, repaid from the cash desk.
    const own = await receipt('0047');
    const owed = await book('receipts.recognize', {
      documentId: own.id,
      account: '6022',
      deduction: 'limited',
      payment: { method: 'employee', partyId: employee.id },
      reportEvidenceId: report,
    });
    expect(lines(owed)).toEqual(['D 6022 273.96', 'D 4426 26.04', 'C 542 300.00']);
    const debt = (await items()).find((entry) => entry.document === '0047')!;
    expect([debt.account, debt.balance]).toEqual(['542', '-300.00']);
    await book('cash.record', {
      account: '5311',
      date: '2026-10-20',
      direction: 'payment',
      number: 'DP-2',
      partyId: employee.id,
      evidenceId: (await s.evidence('dispozitie-plata-2.pdf')).id,
      allocations: [{ openItem: debt.id, amount: '300.00' }],
    });
    expect((await items()).find((entry) => entry.id === debt.id)).toBeUndefined();
  });

  test('receipts of one station recurring by card earn a template', async () => {
    const { s, receipt, book } = await company();
    const question = await s.invoke<{ id: string }>(s.owner, 'questions.ask', {
      kind: 'vehicle.use',
      subject: { kind: 'vehicle', id: plate },
      params: {},
    });
    await s.invoke(s.owner, 'questions.answer', {
      questionId: question.id,
      value: { use: 'mixed', from: '2026-01-01' },
    });
    for (const [number, date] of [
      ['0101', '2026-08-15'],
      ['0102', '2026-09-19'],
      ['0103', '2026-10-18'],
    ] as const) {
      const document = await receipt(number, {}, date);
      await book(
        'receipts.recognize',
        {
          documentId: document.id,
          account: '6022',
          vehicle: plate,
          deduction: 'limited',
          payment: { method: 'card' },
        },
        { answers: [question.id] },
      );
    }
    const [candidate] = (
      await s.invoke<{ items: WorkItem[] }>(s.owner, 'work.list', { kinds: ['template.candidate'] })
    ).items;
    expect(candidate!.next[0]!.inputHint).toMatchObject({
      scope: { treatment: 'receipts.recognize', documentKind: 'receipt.received' },
      mapping: { account: '6022', vehicle: plate, payment: { method: 'card' } },
    });
    const request = await s.invoke<{ preview: { backtest: unknown } }>(
      s.owner,
      'templates.request',
      {
        ...candidate!.next[0]!.inputHint,
        name: 'Motorină Benzinăria Exemplu',
      },
    );
    expect(request.preview.backtest).toMatchObject({ posted: 3, matching: 3, differing: 0 });
  });
});

describe('invoices.reverseCharge and the returns', () => {
  official(
    "a domestic reverse-charge purchase and sale, with a receipt: D300 and D394 pass ANAF's validator",
    async () => {
      const { s, file, receipt, post, book, prepare, work } = await company(
        new AnafKits({
          general: new DukIntegrator(dist),
          ...(saftInstalled ? { saft: new DukIntegrator(saftDist, saftKitId) } : {}),
        }),
      );
      // Bought: ferrous waste on an invoice in category AE, without VAT.
      const imported = await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
        evidenceId: await file(
          'TI-1.xml',
          'application/xml',
          invoiceXml({
            company: cui,
            number: 'TI-1',
            date: '2026-10-10',
            counterparty: 'RO13548146',
            category: 'AE',
            rate: '0',
            net: '10000.00',
            tax: '0.00',
            gross: '10000.00',
          }),
        ),
      });
      const [listed] = (await work()).filter((entry) => entry.subject.id === imported.id);
      expect(listed!.next[0]!.inputHint).toMatchObject({ treatment: 'invoices.reverseCharge' });
      const bought = await book('invoices.reverseCharge', {
        documentId: imported.id,
        parts: [{ category: 'waste', account: '6028', amount: '10000.00' }],
      });
      expect(lines(bought)).toEqual([
        'D 6028 10000.00',
        'C 401 10000.00',
        'C 4427 2100.00',
        'D 4426 2100.00',
      ]);
      // Sold: waste issued in category AE, «taxare inversă», no VAT.
      const buyer = await s.party('Reciclare Exemplu SRL', '14399840');
      await s.invoke(s.owner, 'parties.recordDetails', {
        partyId: buyer.id,
        details: {
          name: 'Reciclare Exemplu SRL',
          vatId: 'RO14399840',
          address: { lines: ['Bd. Unirii 5'], city: 'Brașov', subdivision: 'RO-BV', country: 'RO' },
        },
      });
      const series = await s.invoke<{ id: string }>(s.owner, 'sales.series.create', {
        code: 'XF',
        prefix: 'XF',
        width: 4,
        // Waste is a residual product (703, OMFP nr. 1.802/2014): goods for D406.
        revenueAccount: '703',
      });
      const line = (vat: Record<string, string>) => ({
        name: 'Deșeuri feroase',
        quantity: '1',
        unitCode: 'C62',
        price: '5000',
        vat,
      });
      const ae = {
        category: 'AE',
        exemptionCode: 'VATEX-EU-AE',
        exemptionReason: 'Taxare inversă',
      };
      const sale = { seriesId: series.id, buyerId: buyer.id, issueDate: '2026-10-12' };
      const unnamed = await s.invoke<Preview>(s.owner, 'sales.preview', {
        ...sale,
        lines: [line({ category: 'AE', exemptionCode: 'VATEX-EU-AE' })],
      });
      expect(unnamed.problems.map((problem) => problem.code)).toEqual(['REVERSE_CHARGE_CATEGORY']);
      const unmentioned = await s.invoke<Preview>(s.owner, 'sales.preview', {
        ...sale,
        lines: [line({ category: 'AE', exemptionCode: 'VATEX-EU-AE' })],
        reverseCharge: { category: 'waste' },
      });
      expect(unmentioned.problems.map((problem) => problem.code)).toEqual([
        'REVERSE_CHARGE_MENTION',
      ]);
      const issued = await s.invoke<Issued>(s.owner, 'sales.issue', {
        ...sale,
        lines: [line(ae)],
        reverseCharge: { category: 'waste' },
      });
      const recognized = await s.invoke<ProposalView>(s.owner, 'proposals.get', {
        id: issued.recognition.proposalId,
      });
      expect(recognized.treatment).toBe('invoices.reverseCharge');
      expect(lines(await post(recognized))).toEqual(['D 4111 5000.00', 'C 703 5000.00']);
      // And a fuel receipt with the CUI, deducted in full.
      const fuel = await receipt('0048');
      await book('receipts.recognize', {
        documentId: fuel.id,
        account: '6022',
        deduction: 'full',
        payment: { method: 'card' },
      });

      const d300 = await prepare('D300');
      expect(summary(d300).rows).toMatchObject({
        R12_1: 10000,
        R12_2: 2100,
        R12_1_1: 10000,
        R12_1_2: 2100,
        R13_1: 5000,
        R22_1: 248,
        R22_2: 52,
        R28_2: 2152,
      });
      expect([d300.state, d300.steps.at(-1)?.detail ?? null]).toEqual(['validated_official', null]);
      const d394 = await prepare('D394');
      expect(summary(d394).operations).toEqual([
        { type: 'C', rate: '21', partner: '13548146', invoices: 1, base: 10000, vat: 2100 },
        { type: 'V', rate: '0', partner: '14399840', invoices: 1, base: 5000, vat: 0 },
      ]);
      expect([d394.state, d394.steps.at(-1)?.detail ?? null]).toEqual(['validated_official', null]);

      // D406: the acquisition reported once, with its deduction (Achizitii ded 100% 300906, the
      // collected side without a code of its own), the sale without VAT (Livrari 310312).
      if (!saftInstalled) return;
      await s.invoke(s.owner, 'profile.record', {
        axis: 'vat.period',
        value: 'monthly',
        effectiveFrom: '2026-01-01',
        evidenceId: (await s.evidence('decont-lunar.pdf')).id,
      });
      const address = { lines: ['Str. Industriei 3'], city: 'Galați', subdivision: 'RO-GL' };
      for (const [partyId, name, vatId] of [
        [
          (await s.invoke<{ partyId: string }>(s.owner, 'documents.get', { id: imported.id }))
            .partyId,
          'Metale Exemplu SRL',
          'RO13548146',
        ],
        [fuel.partyId, 'Benzinăria Exemplu SRL', 'RO29031773'],
      ] as const)
        await s.invoke(s.owner, 'parties.recordDetails', {
          partyId,
          details: { name, vatId, address: { ...address, country: 'RO' } },
        });
      const saft = await s.invoke<Artifact>(s.owner, 'declarations.prepare', {
        kind: 'D406',
        period: '2026-10',
        options: { contact: { firstName: 'Ana', lastName: 'Popescu', phone: '0236000000' } },
      });

      expect([saft.state, saft.steps.at(-1)?.detail ?? null]).toEqual(['validated_official', null]);
      const { base64 } = await s.invoke<{ base64: string }>(s.owner, 'evidence.get', {
        id: saft.evidenceId,
      });
      const codes = [
        ...Buffer.from(base64, 'base64')
          .toString()
          .matchAll(/<nsSAFT:TaxCodeDetails>\s*<nsSAFT:TaxCode>(\d+)</g),
      ].map((match) => match[1]);
      expect(codes).toEqual(['300906', '301104', '310312']);
    },
    120_000,
  );

  test('the agent module names the treatments it drives and the rules they enforce', () => {
    expect(receiptsAgent.documentTypes.map((item) => item.id)).toEqual([
      'receipt',
      'expense.report',
      'vehicle.log',
      'reverse.charge.invoice',
      'trader.declaration',
    ]);
    expect(receiptsAgent.questions.map((item) => item.kind)).toEqual([
      'vehicle.use',
      'profile.fact',
    ]);
    expect(receiptsAgent.detectors[0]!.next[0]).toEqual({
      operation: 'proposals.propose',
      by: 'agent',
    });
  });
});
