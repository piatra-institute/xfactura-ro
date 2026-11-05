import { afterAll, describe, expect, test } from 'bun:test';
import * as taxAgent from 'xfactura-core/ro/taxaccount/agent';
import { questionKindIds } from 'xfactura-core/questions/kinds';
import type { DeclarationValidator } from '../../source/engine/adapters/declaration-validator';
import type { ActionView } from '../../source/engine/kernel/actions';
import { workKinds } from '../../source/engine/kernel/work';
import type { ProposalView } from '../../source/engine/kernel/views';
import { iban } from './fixtures/bank';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { pdfDocument, show } from './fixtures/pdf';
import { journal, scenario, type Scenario } from './scenario';

// Synthetic company, statements and decisions. Expected amounts by hand from Codul de procedură
// fiscală art. 163 alin. (3)–(5), art. 165, art. 156 alin. (1), art. 174 alin. (5) and art. 176
// alin. (2), and OPANAF nr. 551/2021 (VAT is not paid into the single account).
const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

const cui = '18547290';
type Movement = { id: string; amount: string; bookingDate: string; reference: string };

/** An MT940 statement of November 2026 from 100,000 lei, with the movements given. */
function statement(
  movements: { day: string; side: 'D' | 'C'; amount: string; ref: string; text: string }[],
) {
  let balance = 10_000_000n;
  const rows = movements.map((item) => {
    const bani = BigInt(item.amount.replace('.', ''));
    balance += item.side === 'C' ? bani : -bani;
    const amount = item.amount.replace('.', ',');
    return `:61:2611${item.day}11${item.day}${item.side}${amount}NTRFNONREF//${item.ref}\n:86:${item.text} ${item.ref}`;
  });
  const closing = `${balance / 100n},${String(balance % 100n).padStart(2, '0')}`;
  return `:20:NOV2026\n:25:${iban}\n:28C:001/001\n:60F:C261101RON100000,00\n${rows.join('\n')}\n:62F:C261130RON${closing}`;
}

const accept: DeclarationValidator = {
  id: 'validator de test',
  validate: async () => ({ ok: true, messages: [] }),
  pdf: async () => ({ ok: false, messages: [] }),
};

async function company(movements: Parameters<typeof statement>[0]) {
  const s = await scenario({
    cui,
    clock: () => Date.parse('2026-12-29T10:00:00Z'),
    declarationValidator: accept,
  });
  open.push(s);
  const fact = async (axis: string, value: string) =>
    s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence(`${axis}.pdf`)).id,
    });
  await fact('vat.status', 'normal_vat');
  const anaf = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
    kind: 'ro_public_institution',
    country: 'RO',
    name: 'ANAF',
  });
  await s.invoke(s.owner, 'treasury.createAccount', {
    kind: 'bank',
    name: 'Cont curent',
    iban,
    currency: 'RON',
    ledgerAccount: '5121',
    openedOn: '2026-01-01',
  });
  await s.book(
    'ledger.general',
    journal(
      (await s.evidence('deschidere.pdf')).id,
      [
        { account: '5121', side: 'D', amount: '100000.00' },
        { account: '1012', side: 'C', amount: '100000.00' },
      ],
      { date: '2026-01-01', purpose: 'opening' },
    ),
  );
  /** An obligation to ANAF on `account`, due on `due`. */
  const owe = async (account: string, amount: string, due: string, date = '2026-10-31') => {
    const posted = await s.book(
      'ledger.general',
      journal(
        (await s.evidence(`obligatie-${account}-${due}.pdf`)).id,
        [
          { account: '6588', side: 'D', amount },
          { account, side: 'C', amount, newItem: 'o' },
        ],
        { date, newItems: [{ ref: 'o', partyId: anaf.id, dueDate: due }] },
      ),
    );
    return posted.effect!.openItems[0]!.id;
  };
  const { id: file } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
    filename: 'extras-noiembrie.sta',
    mediaType: 'text/plain',
    base64: Buffer.from(statement(movements)).toString('base64'),
  });
  await s.invoke(s.owner, 'bank.import', { evidenceId: file, financialYearId: s.year.id });
  const all = await s.list<Movement>(s.owner, 'bank.movements', {});
  const movement = (reference: string) => all.find((item) => item.reference.includes(reference))!;
  return { s, anaf: anaf.id, fact, owe, movement };
}

const lines = (proposal: ProposalView) =>
  proposal.effect!.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);
type Allocation = { obligation: string; stage: string; amount: string; on: string };
const distribution = (proposal: ProposalView) =>
  (proposal.effect!.explanation.details as { distribution: Allocation[] }).distribution;

/** A PDF whose lines carry the given texts, recorded as evidence. */
async function pdf(s: Scenario, name: string, texts: string[]) {
  const bytes = pdfDocument([
    { content: texts.map((text, index) => show(72, 780 - index * 20, text)).join('\n') },
  ]);
  return s.invoke<{ id: string }>(s.owner, 'evidence.record', {
    filename: name,
    mediaType: 'application/pdf',
    base64: Buffer.from(bytes).toString('base64'),
  });
}

describe('payments to the single account', () => {
  test('distributes a payment across several obligations in the legal order', async () => {
    const { s, anaf, fact, owe, movement } = await company([
      {
        day: '20',
        side: 'D',
        amount: '6200.00',
        ref: 'TAX-01',
        text: 'Plata contul unic CUI 18547290',
      },
    ]);
    await owe('4418', '1000.00', '2026-10-26');
    await owe('444', '2000.00', '2026-11-25');
    await owe('4315', '3000.00', '2026-11-25');
    await owe('4316', '1200.00', '2026-11-25');
    const input = { movementId: movement('TAX-01').id, authorityId: anaf, to: 'single' };
    // Without knowing the payment facilities, nothing is distributed: a question.
    const asked = await s.propose('tax.pay', input);
    expect(codes(asked)).toContain('TAX_FACILITIES');
    await fact('tax.facilities', 'none');
    const proposal = await s.revise('tax.pay', asked, input);
    // Due on 20.11: the overdue micro tax (1,000). Then, on 25.11, 5,200 between the budgets in
    // proportion to 2,000 (state) : 3,000 (BASS) : 1,200 (FNUASS).
    expect(
      distribution(proposal).map((item) => [item.obligation, item.stage, item.amount]),
    ).toEqual([
      ['Impozitul pe veniturile microîntreprinderilor', 'due', '1000.00'],
      ['Impozit pe veniturile din salarii și asimilate salariilor', 'later', '1677.42'],
      ['Contribuția de asigurări sociale', 'later', '2516.13'],
      ['Contribuția de asigurări sociale de sănătate', 'later', '1006.45'],
    ]);
    expect(lines(proposal)).toEqual([
      'D 4418 1000.00',
      'D 444 1677.42',
      'D 4315 2516.13',
      'D 4316 1006.45',
      'C 5121 6200.00',
    ]);
    expect(codes(proposal)).toEqual(['TAX_LATER']);
    await s.post(await s.approve(proposal));
    const position = await s.invoke<{ items: { type: string; balance: string }[] }>(
      s.owner,
      'taxaccount.position',
      { date: '2026-11-30' },
    );
    expect(position.items.map((item) => [item.type, item.balance]).sort()).toEqual([
      ['cas', '483.87'],
      ['cass', '193.55'],
      ['salary_tax', '322.58'],
    ]);
  });

  test('taxes withheld from rent and from a non-resident are paid into the single account with the others', async () => {
    const { s, anaf, fact, owe, movement } = await company([
      { day: '25', side: 'D', amount: '860.00', ref: 'TAX-WHT', text: 'Plata contul unic' },
    ]);
    await fact('tax.facilities', 'none');
    await owe('444', '500.00', '2026-11-25');
    // Rent of October paid to an individual on 20.10: 10% of 2,500 less 20% = 200 lei
    // (OPANAF nr. 874/2024, poz. 33^3).
    const landlord = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_individual',
      country: 'RO',
      name: 'Popescu Ana',
    });
    const rent = await s.book('payees.recognize', {
      kind: 'rent',
      partyId: landlord.id,
      evidenceId: (await s.evidence('contract-inchiriere.pdf')).id,
      date: '2026-10-01',
      period: '2026-10',
      amount: '2500.00',
      account: '612',
    });
    const rentTax = await s.book('payees.withhold', {
      openItem: rent.effect!.openItems[0]!.id,
      date: '2026-10-20',
      gross: '2500.00',
      authorityId: anaf,
    });
    expect(lines(rentTax)).toEqual(['D 462 200.00', 'C 446 200.00']);
    // A licence from a company outside the Union, paid on 15.10: 16% of 1,000 lei withheld
    // without a residence certificate (OPANAF nr. 551/2021, poz. 20).
    const supplier = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'non_eu',
      country: 'US',
      taxId: '12-3456789',
      name: 'Software Inc',
    });
    const licence = await s.book(
      'ledger.general',
      journal(
        (await s.evidence('factura-licenta.pdf')).id,
        [
          { account: '628', side: 'D', amount: '1000.00' },
          { account: '401', side: 'C', amount: '1000.00', newItem: 'licenta' },
        ],
        { date: '2026-10-05', newItems: [{ ref: 'licenta', partyId: supplier.id }] },
      ),
    );
    const asked = await s.invoke<{ id: string }>(s.owner, 'questions.ask', {
      kind: 'nonresident.payee',
      subject: { kind: 'party', id: supplier.id },
      params: {},
    });
    await s.invoke(s.owner, 'questions.answer', {
      questionId: asked.id,
      value: {
        income: 'royalties',
        beneficiary: 'company',
        contractEvidenceId: (await s.evidence('contract-licenta.pdf')).id,
        reason: 'Licența acordă dreptul de a reproduce și distribui programul.',
      },
    });
    const withheld = await s.invoke<ProposalView>(s.owner, 'proposals.propose', {
      treatment: 'nonresidents.withhold',
      input: {
        openItem: licence.effect!.openItems[0]!.id,
        date: '2026-10-15',
        gross: '1000.00',
        authorityId: anaf,
        noExchangeOfInformation: false,
        borneBy: 'beneficiary',
      },
      basis: { answers: [asked.id] },
    });
    expect(lines(withheld)).toEqual(['D 401 160.00', 'C 446 160.00']);
    await s.post(await s.approve(withheld, s.reviewer, ['WHT_CERTIFICATE']));

    // Each 446 item is its own obligation of the single account, due on 25.11 (art. 84^1 alin.
    // (6), art. 224 alin. (5)).
    const position = await s.invoke<{
      items: { type: string; due: string | null; singleAccount: boolean; balance: string }[];
    }>(s.owner, 'taxaccount.position', { date: '2026-11-24' });
    expect(
      position.items
        .map((item) => [item.type, item.due, item.singleAccount, item.balance])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['nonresident_royalty_tax', '2026-11-25', true, '160.00'],
      ['rent_tax', '2026-11-25', true, '200.00'],
      ['salary_tax', '2026-11-25', true, '500.00'],
    ]);
    // The payment covers them all: nothing is left undistributed.
    const paid = await s.propose('tax.pay', {
      movementId: movement('TAX-WHT').id,
      authorityId: anaf,
      to: 'single',
    });
    expect(
      distribution(paid)
        .map((item) => [item.obligation, item.stage, item.amount])
        .sort((a, b) => a[0]!.localeCompare(b[0]!)),
    ).toEqual([
      ['Impozit pe redevențele obținute din România de nerezidenți 2026-10', 'due', '160.00'],
      [
        'Impozit pe veniturile din cedarea folosinței bunurilor, reținut la sursă 2026-10',
        'due',
        '200.00',
      ],
      ['Impozit pe veniturile din salarii și asimilate salariilor', 'due', '500.00'],
    ]);
    expect(lines(paid).sort()).toEqual([
      'C 5121 860.00',
      'D 444 500.00',
      'D 446 160.00',
      'D 446 200.00',
    ]);
    expect(codes(paid)).toEqual([]);
    await s.post(await s.approve(paid));
    const after = await s.invoke<{ items: unknown[] }>(s.owner, 'taxaccount.position', {
      date: '2026-11-30',
    });
    expect(after.items).toEqual([]);
  });

  test('state aid to repay changes the order: the payment is not distributed', async () => {
    const { s, anaf, fact, owe, movement } = await company([
      { day: '20', side: 'D', amount: '1000.00', ref: 'TAX-SA', text: 'Plata contul unic' },
    ]);
    await owe('4418', '1000.00', '2026-10-26');
    await fact('tax.facilities', 'state_aid');
    const proposal = await s.propose('tax.pay', {
      movementId: movement('TAX-SA').id,
      authorityId: anaf,
      to: 'single',
    });
    const refused = proposal.issues.find((issue) => issue.code === 'TAX_FACILITIES_UNSUPPORTED');
    expect(refused?.severity).toBe('block');
    expect(refused?.message).toContain('pct. 3^1');
  });

  test('VAT is paid into its own account; the single account does not take it', async () => {
    const { s, anaf, fact, movement } = await company([
      { day: '24', side: 'D', amount: '500.00', ref: 'TAX-UNIC', text: 'Plata contul unic' },
      { day: '25', side: 'D', amount: '210.00', ref: 'TAX-TVA', text: 'Plata TVA octombrie' },
    ]);
    await fact('tax.facilities', 'none');
    const { id: xml } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'V-1.xml',
      mediaType: 'application/xml',
      base64: Buffer.from(
        invoiceXml({ company: cui, number: 'V-1', direction: 'sale', date: '2026-10-10' }),
      ).toString('base64'),
    });
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
      evidenceId: xml,
    });
    await s.book('invoices.recognize', { documentId: document.id, account: '704' });
    await s.book('vat.settle', {
      period: '2026-10',
      date: '2026-10-31',
      authorityId: anaf,
      evidenceId: (await s.evidence('decont.pdf')).id,
    });
    // Into the single account, VAT stays owed: the money is not distributed.
    const single = await s.propose('tax.pay', {
      movementId: movement('TAX-UNIC').id,
      authorityId: anaf,
      to: 'single',
    });
    expect(lines(single)).toEqual(['D 4482 500.00', 'C 5121 500.00']);
    expect(codes(single)).toEqual(['TAX_UNDISTRIBUTED']);
    // Into VAT's own account, it settles the period's VAT, due on 25.11 by the D300 deadline.
    const vat = await s.propose('tax.pay', {
      movementId: movement('TAX-TVA').id,
      authorityId: anaf,
      to: 'vat',
    });
    expect(distribution(vat)).toEqual([
      expect.objectContaining({ obligation: 'Taxa pe valoarea adăugată 2026-10', stage: 'due' }),
    ]);
    // Paying into a single-account tax's own account is refused.
    const wrong = await s
      .propose('tax.pay', {
        movementId: movement('TAX-TVA').id,
        authorityId: anaf,
        to: 'salary_tax',
      })
      .catch(() => null);
    expect(wrong === null || codes(wrong).includes('TAX_SINGLE_ACCOUNT')).toBe(true);
  });

  test('a payment before the declaration stays undistributed, then settles the obligation once due', async () => {
    const { s, anaf, fact, owe, movement } = await company([
      { day: '05', side: 'D', amount: '1500.00', ref: 'TAX-AVANS', text: 'Plata contul unic' },
    ]);
    await fact('tax.facilities', 'none');
    const paid = await s.propose('tax.pay', {
      movementId: movement('TAX-AVANS').id,
      authorityId: anaf,
      to: 'single',
    });
    expect(lines(paid)).toEqual(['D 4482 1500.00', 'C 5121 1500.00']);
    await s.post(await s.approve(paid));
    // The return is filed later: the salary tax of November, due on 28.12 (25.12 moved).
    const salary = await owe('444', '1200.00', '2026-12-28', '2026-11-30');
    const items = await s.list<{
      kind: string;
      subject: { id: string };
      next: { inputHint: unknown }[];
    }>(s.owner, 'work.list', { kinds: ['taxaccount.undistributed'] });
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'taxaccount.undistributed',
        subject: { kind: 'party', id: anaf },
      }),
    ]);
    const distributed = await s.propose('tax.distribute', {
      authorityId: anaf,
      date: '2026-12-29',
    });
    expect(lines(distributed)).toEqual(['D 444 1200.00', 'C 4482 1200.00']);
    await s.post(await s.approve(distributed));
    const position = await s.invoke<{
      items: { openItem: string; type: string; balance: string }[];
    }>(s.owner, 'taxaccount.position', {});
    expect(position.items.find((item) => item.openItem === salary)).toBeUndefined();
    expect(position.items).toEqual([
      expect.objectContaining({ type: 'undistributed', balance: '300.00' }),
    ]);
  });
});

describe("ANAF's statement of the account", () => {
  async function paid() {
    const books = await company([
      { day: '25', side: 'D', amount: '3000.00', ref: 'TAX-02', text: 'Plata contul unic' },
    ]);
    await books.fact('tax.facilities', 'none');
    await books.owe('444', '1000.00', '2026-11-25');
    await books.owe('4315', '2000.00', '2026-11-25');
    await books.s.book('tax.pay', {
      movementId: books.movement('TAX-02').id,
      authorityId: books.anaf,
      to: 'single',
    });
    return books;
  }
  const record = async (
    s: Scenario,
    name: string,
    rows: { label: string; obligation: string; kind?: string; balance: string }[],
  ) => {
    const texts = [
      'SITUATIE SINTETICA',
      `CUI: ${cui}`,
      'Data: 30.11.2026',
      ...rows.map((row) => `${row.label}: ${row.balance}`),
    ];
    const { id: evidenceId } = await pdf(s, name, texts);
    return s.invoke<{ id: string; checks: { code: string; status: string }[] }>(
      s.owner,
      'documents.record',
      {
        evidenceId,
        kind: 'tax.statement',
        body: {
          title: 'Situație sintetică',
          taxpayer: { name: 'Pilot SRL', taxId: cui },
          asOf: '2026-11-30',
          rows,
        },
        citations: {
          asOf: { page: 1, line: 3, text: 'Data: 30.11.2026' },
          'taxpayer.taxId': { page: 1, line: 2, text: `CUI: ${cui}` },
          ...Object.fromEntries(
            rows.map((row, index) => [
              `rows.${index}.balance`,
              { page: 1, line: 4 + index, text: `${row.label}: ${row.balance}` },
            ]),
          ),
        },
      },
    );
  };

  test('a statement that matches the books', async () => {
    const { s } = await paid();
    const document = await record(s, 'situatie-1.pdf', [
      { label: 'Impozit pe salarii', obligation: 'salary_tax', balance: '0.00' },
      { label: 'CAS', obligation: 'cas', balance: '0.00' },
    ]);
    expect(document.checks.find((check) => check.code === 'CITATIONS')?.status).toBe('passed');
    const result = await s.invoke<{ matched: boolean; differences: number }>(
      s.owner,
      'taxaccount.reconcile',
      {},
    );
    expect(result).toEqual(expect.objectContaining({ matched: true, differences: 0 }));
    expect(await s.list(s.owner, 'work.list', { kinds: ['taxaccount.differs'] })).toEqual([]);
  });

  test('a statement that differs: each difference explained, on the worklist and at the close', async () => {
    const { s } = await paid();
    const document = await record(s, 'situatie-2.pdf', [
      { label: 'Impozit pe salarii', obligation: 'salary_tax', balance: '0.00' },
      { label: 'CAS', obligation: 'cas', balance: '0.00' },
      {
        label: 'Dobanzi impozit pe profit',
        obligation: 'profit',
        kind: 'accessory',
        balance: '93.00',
      },
      { label: 'Impozit pe profit', obligation: 'profit', balance: '1500.00' },
    ]);
    const result = await s.invoke<{
      matched: boolean;
      items: {
        obligation: string;
        kind: string;
        matched: boolean;
        explanations: { code: string }[];
      }[];
    }>(s.owner, 'taxaccount.reconcile', { documentId: document.id });
    expect(result.matched).toBe(false);
    const explained = Object.fromEntries(
      result.items
        .filter((item) => !item.matched)
        .map((item) => [`${item.obligation}:${item.kind}`, item.explanations.map((e) => e.code)]),
    );
    expect(explained).toEqual({
      'profit:accessory': ['ACCESSORIES_UNBOOKED'],
      'profit:principal': ['NOT_IN_BOOKS'],
    });
    const [item] = await s.list<{
      kind: string;
      subject: { id: string };
      details: { differences: unknown[] };
    }>(s.owner, 'work.list', { kinds: ['taxaccount.differs'] });
    expect(item).toEqual(
      expect.objectContaining({
        kind: 'taxaccount.differs',
        subject: { kind: 'document', id: document.id },
      }),
    );
    expect(item!.details.differences).toHaveLength(2);
    const close = await s.close('2026-11');
    expect(
      (close.preview as { findings: { code: string }[] }).findings.map((finding) => finding.code),
    ).toContain('TAX_STATEMENT_DIFFERS');
  });
});

describe('ANAF decisions', () => {
  test('interest and penalties booked from the decision, due by art. 156, then paid by designation', async () => {
    const { s, anaf, fact, owe, movement } = await company([
      { day: '27', side: 'D', amount: '8.00', ref: 'TAX-ACC', text: 'Plata accesorii NEP' },
    ]);
    await fact('tax.facilities', 'none');
    await owe('4418', '1000.00', '2026-10-26');
    const texts = [
      'DECIZIE referitoare la obligatiile fiscale accesorii',
      'Nr. 4567 din 18.11.2026, comunicata la 20.11.2026',
      `CUI: ${cui}`,
      'Dobanzi impozit micro: 5,00',
      'Penalitati impozit micro: 4,00',
      'Total: 9,00',
    ];
    const { id: evidenceId } = await pdf(s, 'decizie.pdf', texts);
    const document = await s.invoke<{ id: string }>(s.owner, 'documents.record', {
      evidenceId,
      kind: 'tax.decision',
      body: {
        decision: 'accessories',
        title: 'Decizie referitoare la obligațiile fiscale accesorii',
        issuer: { name: 'AJFP Galați' },
        taxpayer: { name: 'Pilot SRL', taxId: cui },
        number: '4567',
        issueDate: '2026-11-18',
        communicatedOn: '2026-11-20',
        lines: [
          // 1,000 lei × 25 days: interest 0.02% = 5 lei, penalty 0.01% = 2.50 → 3 lei.
          {
            kind: 'interest',
            obligation: 'micro',
            period: '2026-Q3',
            label: 'Dobanzi impozit micro',
            base: '1000.00',
            days: 25,
            amount: '5.00',
          },
          {
            kind: 'late_penalty',
            obligation: 'micro',
            period: '2026-Q3',
            label: 'Penalitati impozit micro',
            base: '1000.00',
            days: 25,
            amount: '4.00',
          },
        ],
        totals: { amount: '9.00' },
      },
      citations: {
        number: { page: 1, line: 2, text: 'Nr. 4567' },
        issueDate: { page: 1, line: 2, text: 'din 18.11.2026' },
        communicatedOn: { page: 1, line: 2, text: 'comunicata la 20.11.2026' },
        'taxpayer.taxId': { page: 1, line: 3, text: `CUI: ${cui}` },
        'lines.0.amount': { page: 1, line: 4, text: 'Dobanzi impozit micro: 5,00' },
        'lines.1.amount': { page: 1, line: 5, text: 'Penalitati impozit micro: 4,00' },
        'totals.amount': { page: 1, line: 6, text: 'Total: 9,00' },
      },
    });
    // The worklist proposes the decision's booking.
    const [unproposed] = await s.list<{ next: { inputHint: { treatment?: string } }[] }>(
      s.owner,
      'work.list',
      { kinds: ['document.unproposed'] },
    );
    expect(unproposed!.next[0]!.inputHint.treatment).toBe('tax.decision');
    const proposal = await s.propose('tax.decision', {
      documentId: document.id,
      authorityId: anaf,
    });
    expect(lines(proposal)).toEqual(['D 6581 5.00', 'C 4481 5.00', 'D 6581 4.00', 'C 4481 4.00']);
    // Communicated on the 20th: due on 20 December (art. 156 alin. (1) lit. b)).
    expect(proposal.effect!.openItems.map((item) => item.dueDate)).toEqual([
      '2026-12-20',
      '2026-12-20',
    ]);
    expect(codes(proposal).sort()).toEqual(['SOURCE_EXTRACTED', 'TAX_DECISION_AMOUNT']);
    const posted = await s.post(
      await s.approve(proposal, s.reviewer, ['SOURCE_EXTRACTED', 'TAX_DECISION_AMOUNT']),
    );
    const [interest, penalty] = posted.effect!.openItems.map((item) => item.id);
    // The payer designates the decision's accessories by the payment record number.
    const payment = await s.propose('tax.pay', {
      movementId: movement('TAX-ACC').id,
      authorityId: anaf,
      to: 'single',
      designations: [
        { openItem: interest, amount: '5.00', nep: '10024012026181126000000' },
        { openItem: penalty, amount: '3.00' },
      ],
    });
    expect(lines(payment)).toEqual(['D 4481 5.00', 'D 4481 3.00', 'C 5121 8.00']);
    // The micro tax itself cannot be designated: it follows the legal order.
    const position = await s.invoke<{ items: { openItem: string; type: string }[] }>(
      s.owner,
      'taxaccount.position',
      { date: '2026-11-30' },
    );
    const micro = position.items.find((item) => item.type === 'micro')!.openItem;
    const refused = await s
      .propose('tax.pay', {
        movementId: movement('TAX-ACC').id,
        authorityId: anaf,
        to: 'single',
        designations: [{ openItem: micro, amount: '8.00' }],
      })
      .catch((error) => error);
    expect(refused instanceof Error || codes(refused).includes('TAX_DESIGNATION')).toBe(true);
  });
});

describe('VAT refunds and offsets', () => {
  test('a refund decision offsets an obligation, and the bank receipt settles the rest', async () => {
    const { s, anaf, fact, owe, movement } = await company([
      { day: '28', side: 'C', amount: '5300.00', ref: 'RAMB-01', text: 'Rambursare TVA' },
    ]);
    await fact('tax.facilities', 'none');
    const micro = await owe('4418', '1000.00', '2026-10-26');
    // A purchase whose VAT exceeds the month's output: 6,300 lei to recover for October.
    const { id: xml } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'F-1.xml',
      mediaType: 'application/xml',
      base64: Buffer.from(
        invoiceXml({
          company: cui,
          number: 'F-1',
          date: '2026-10-10',
          net: '30000.00',
          tax: '6300.00',
          gross: '36300.00',
        }),
      ).toString('base64'),
    });
    const purchase = await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
      evidenceId: xml,
    });
    await s.book('invoices.recognize', { documentId: purchase.id, account: '628' });
    await s.book('vat.settle', {
      period: '2026-10',
      date: '2026-10-31',
      authorityId: anaf,
      evidenceId: (await s.evidence('decont-10.pdf')).id,
    });
    const texts = [
      'DECIZIE DE RAMBURSARE A TAXEI PE VALOAREA ADAUGATA',
      'Nr. 77 din 25.11.2026, comunicata la 25.11.2026',
      `CUI: ${cui}`,
      'TVA aprobata la rambursare: 6.300,00',
      'Compensat impozit micro: 1.000,00',
      'Total: 6.300,00',
    ];
    const { id: evidenceId } = await pdf(s, 'decizie-rambursare.pdf', texts);
    const document = await s.invoke<{ id: string }>(s.owner, 'documents.record', {
      evidenceId,
      kind: 'tax.decision',
      body: {
        decision: 'refund',
        title: 'Decizie de rambursare a taxei pe valoarea adăugată',
        issuer: { name: 'AJFP Galați' },
        taxpayer: { name: 'Pilot SRL', taxId: cui },
        number: '77',
        issueDate: '2026-11-25',
        communicatedOn: '2026-11-25',
        lines: [
          {
            kind: 'refund',
            label: 'TVA aprobată la rambursare',
            amount: '6300.00',
            source: { kind: 'vat_refund', period: '2026-10' },
          },
          {
            kind: 'offset',
            obligation: 'micro',
            period: null,
            label: 'Compensat impozit micro',
            amount: '1000.00',
            source: { kind: 'vat_refund', period: '2026-10' },
          },
        ],
        totals: { amount: '6300.00' },
      },
    });
    const offset = await s.propose('tax.decision', { documentId: document.id, authorityId: anaf });
    expect(lines(offset)).toEqual(['D 4418 1000.00', 'C 4424 1000.00']);
    await s.post(await s.approve(offset, s.reviewer, ['SOURCE_EXTRACTED']));
    // The receipt equals what is left to recover: it settles it.
    const receipt = await s.propose('tax.pay', {
      movementId: movement('RAMB-01').id,
      authorityId: anaf,
      to: 'single',
    });
    expect(lines(receipt)).toEqual(['D 5121 5300.00', 'C 4424 5300.00']);
    await s.post(await s.approve(receipt));
    const position = await s.invoke<{ items: { openItem: string }[] }>(
      s.owner,
      'taxaccount.position',
      {},
    );
    expect(position.items.map((item) => item.openItem)).not.toContain(micro);
    expect(position.items).toEqual([]);
  });
});

describe('templates and the agent-ready contract', () => {
  test('a payment template fixes where the money goes; the engine distributes', async () => {
    const { s, anaf, fact, owe, movement } = await company([
      { day: '25', side: 'D', amount: '1000.00', ref: 'TAX-T1', text: 'Plata contul unic' },
    ]);
    await fact('tax.facilities', 'none');
    await owe('444', '1000.00', '2026-11-25');
    const request = await s.invoke<{ id: string; previewHash: string }>(
      s.owner,
      'templates.request',
      {
        name: 'Plăți ANAF în contul unic',
        scope: {
          treatment: 'tax.pay',
          partyId: anaf,
          documentKind: 'movement.paid',
          linePattern: 'contul unic',
        },
        mapping: { to: 'single' },
      },
    );
    await s.invoke(s.reviewer, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    const executed = await s.invoke<{ result: { templateId: string } }>(
      s.reviewer,
      'actions.execute',
      { id: request.id },
    );
    const template = { id: executed.result.templateId, version: 1 };
    const proposal = await s.invoke<ProposalView>(s.owner, 'proposals.propose', {
      treatment: 'tax.pay',
      input: { movementId: movement('TAX-T1').id, authorityId: anaf, to: 'single' },
      basis: { answers: [], template: template.id },
    });
    expect(lines(proposal)).toEqual(['D 444 1000.00', 'C 5121 1000.00']);
    // A template without the authority is refused.
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'templates.request', {
            name: 'Fără autoritate',
            scope: { treatment: 'tax.pay', documentKind: 'movement.paid' },
            mapping: { to: 'single' },
          }),
        )
      )?.code,
    ).toBe('VALIDATION');
  });

  test('agent.ts names kinds the engine knows', () => {
    for (const detector of taxAgent.detectors)
      expect(workKinds as readonly string[]).toContain(detector.kind);
    for (const question of taxAgent.questions)
      expect(questionKindIds as readonly string[]).toContain(question.kind);
    expect(taxAgent.templates).toEqual(['to']);
  });
});

describe('the VAT return and the payments matched to it', () => {
  const options = {
    declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
    caen: '6201',
    bank: 'Banca Exemplu',
    account: iban,
  };
  type Artifact = { id: string; steps: { detail: string | null }[] };
  const summary = (artifact: Artifact) =>
    JSON.parse(artifact.steps[0]!.detail!) as {
      rows: Record<string, number>;
      refundRequested: boolean;
    };
  async function vatCompany(movements: Parameters<typeof statement>[0]) {
    const books = await company(movements);
    await books.fact('tax.facilities', 'none');
    await books.s.invoke(books.s.owner, 'sales.seller.record', {
      details: {
        name: 'Exemplu Servicii SRL',
        vatId: `RO${cui}`,
        address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
      },
    });
    const invoice = async (input: XmlInput, account: string) => {
      const { id } = await books.s.invoke<{ id: string }>(books.s.owner, 'evidence.record', {
        filename: `${input.number}.xml`,
        mediaType: 'application/xml',
        base64: Buffer.from(invoiceXml(input)).toString('base64'),
      });
      const document = await books.s.invoke<{ id: string }>(books.s.owner, 'invoices.import', {
        evidenceId: id,
      });
      await books.s.book('invoices.recognize', { documentId: document.id, account });
    };
    const prepare = (period: string, extra: Record<string, unknown> = {}) =>
      books.s.invoke<Artifact>(books.s.owner, 'declarations.prepare', {
        kind: 'D300',
        period,
        options: { ...options, ...extra },
      });
    return { ...books, invoice, prepare };
  }

  test("a negative balance of at least 5,000 lei waits for the refund choice, a person's answer", async () => {
    const { s, invoice, prepare } = await vatCompany([]);
    await invoice(
      {
        company: cui,
        number: 'F-5',
        date: '2026-09-10',
        net: '30000.00',
        tax: '6300.00',
        gross: '36300.00',
      },
      '628',
    );
    expect((await s.refused(prepare('2026-09')))?.code).toBe('VAT_REFUND_CHOICE');
    const question = await s.invoke<{ id: string }>(s.owner, 'questions.ask', {
      kind: 'vat.refund',
      subject: { kind: 'vatPeriod', id: '2026-09' },
      params: { balance: '6300' },
    });
    await s.invoke(s.owner, 'questions.answer', {
      questionId: question.id,
      value: { choice: 'refund' },
    });
    expect(summary(await prepare('2026-09')).refundRequested).toBe(true);
  });

  test("rd. 38 holds what the books have not paid of the previous return's VAT", async () => {
    const { s, anaf, invoice, prepare, movement } = await vatCompany([
      { day: '25', side: 'D', amount: '21.00', ref: 'TAX-TVA', text: 'Plata TVA octombrie' },
    ]);
    // The sale's VAT: 21 lei, payable on 25.11.
    await invoice({ company: cui, number: 'V-1', direction: 'sale', date: '2026-10-10' }, '704');
    await s.book('vat.settle', {
      period: '2026-10',
      date: '2026-10-31',
      authorityId: anaf,
      evidenceId: (await s.evidence('decont.pdf')).id,
    });
    const october = await prepare('2026-10');
    const request = await s.invoke<ActionView>(s.owner, 'declarations.authorize.request', {
      artifactId: october.id,
    });
    await s.invoke(s.reviewer, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    await s.invoke(s.reviewer, 'actions.execute', { id: request.id });
    await invoice({ company: cui, number: 'V-2', direction: 'sale', date: '2026-11-10' }, '704');
    expect(summary(await prepare('2026-11')).rows.R35_2).toBe(21);
    await s.book('tax.pay', { movementId: movement('TAX-TVA').id, authorityId: anaf, to: 'vat' });
    expect(summary(await prepare('2026-11')).rows.R35_2).toBeUndefined();
  });
});
