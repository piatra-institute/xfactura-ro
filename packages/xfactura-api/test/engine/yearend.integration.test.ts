import { afterAll, describe, expect, test } from 'bun:test';
import type { ActionView } from '../../source/engine/kernel/actions';
import type { ProposalView } from '../../source/engine/kernel/views';
import * as yearEndAgent from 'xfactura-core/ro/yearend/agent';
import { questionKindIds } from 'xfactura-core/questions/kinds';
import { workKinds } from '../../source/engine/kernel/work';
import { invoiceXml } from './fixtures/invoice';
import { journal, scenario, type Scenario } from './scenario';

// The year-end in full (Y1): a services SRL's FY2026 close, every amount computed by hand.
//   Opening 1 January: 30,000.00 lei in 5121 against the capital, 1,000.00 EUR in 5124 at 5.0800
//   (5,080.00 lei) against 1012 too.
//   A sale of 10,000.00 + 2,100.00 VAT on 10.03.2026 to a customer that went insolvent: 296 days
//   overdue at 31.12.2026, 40% recoverable: impairment 60% × 12,100.00 = 7,260.00 (art. 26 alin.
//   (1) lit. c): unpaid over 270 days, not guaranteed, not affiliated).
//   A laptop of 6,000.00 lei, 36 months, in use from 15.06.2026: July–December 6 × 166.67/166.66
//   = 1,000.00.
//   A subscription of 1,200.00 lei for October 2026 – September 2027: 300.00 released in 2026,
//   900.00 left on 471 at the year's end.
//   1,000.00 lei taken to the cash desk; 850.00 counted at the year's end: 150.00 imputed to the
//   cashier (4282 = 5311).
//   5124 revalued at the year's 5.1000: 5,100.00, a gain of 20.00.
//   Untaken leave measured on the payroll: 1,000.00 + CAM 22.50 = 1,022.50 (641 = 4281); a lawsuit
//   estimated at 3,000.00 (6812 = 1511).

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

const bnr = `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Header><Publisher>National Bank of Romania</Publisher><PublishingDate>2026-12-31</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
<Cube date="2025-12-31"><Rate currency="EUR">5.0800</Rate></Cube>
<Cube date="2026-12-31"><Rate currency="EUR">5.1000</Rate></Cube>
</Body></DataSet>`;

function iban(bank: string, account: string) {
  const bban = `${bank}${account}`;
  const digits = `${bban}RO00`.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  const check = 98n - (BigInt(digits) % 97n);
  return `RO${String(check).padStart(2, '0')}${bban}`;
}
function cnp(body: string) {
  const weights = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
  const control =
    weights.reduce((sum, weight, index) => sum + weight * Number(body[index]), 0) % 11;
  return `${body}${control === 10 ? 1 : control}`;
}

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);
const at = (date: string) => () => Date.parse(`${date}T10:00:00Z`);

type Review = { closed: boolean; items: { id: string; check: string; severity: string }[] };

/** The FY2026 books of a services SRL, before its year-end entries. */
async function company() {
  const s = await scenario({ clock: at('2027-02-20') });
  open.push(s);
  const fact = async (axis: string, value: string, from = '2026-01-01') =>
    s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: from,
      evidenceId: (await s.evidence(`${axis}.pdf`)).id,
    });
  await fact('vat.status', 'normal_vat');
  await fact('income_tax', 'micro');
  await fact('employer', 'yes');
  await fact('policy.assets.disposal_month', 'excluded');
  const file = async (filename: string, text: string, mediaType = 'application/xml') =>
    s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename,
      mediaType,
      base64: Buffer.from(text).toString('base64'),
    });
  await s.invoke(s.owner, 'fx.importBnr', { evidenceId: (await file('bnr.xml', bnr)).id });
  await s.invoke(s.owner, 'treasury.createAccount', {
    kind: 'bank',
    name: 'Cont EUR',
    iban: iban('BBBB', '1B31007593840001'),
    currency: 'EUR',
    ledgerAccount: '5124',
    openedOn: '2026-01-01',
  });
  await s.book(
    'ledger.general',
    journal(
      (await s.evidence('balanta-deschidere.pdf')).id,
      [
        { account: '5121', side: 'D', amount: '30000.00' },
        {
          account: '5124',
          side: 'D',
          amount: '5080.00',
          currency: {
            code: 'EUR',
            amount: '1000.00',
            rate: '5.0800',
            rateId: 'BNR/EUR/2025-12-31',
          },
        },
        { account: '1012', side: 'C', amount: '35080.00' },
      ],
      { date: '2026-01-01', purpose: 'opening' },
    ),
  );
  const invoice = async (input: Parameters<typeof invoiceXml>[0], account: string) => {
    const document = await s.invoke<{ id: string; partyId: string; evidenceId: string }>(
      s.owner,
      'invoices.import',
      { evidenceId: (await file(`${input?.number}.xml`, invoiceXml(input))).id },
    );
    const booked = await s.book('invoices.recognize', { documentId: document.id, account });
    return { document, booked };
  };
  // The customer who became insolvent.
  const sale = await invoice(
    {
      direction: 'sale',
      number: 'V-17',
      date: '2026-03-10',
      net: '10000.00',
      tax: '2100.00',
      gross: '12100.00',
    },
    '704',
  );
  const customer = sale.booked.effect!.openItems[0]!;
  // The laptop, paid from the bank.
  const laptop = await s.invoke<{ id: string }>(s.owner, 'assets.register', {
    number: 'MF-1',
    name: 'Laptop',
    catalogCode: '2.2.9',
    account: '214',
    depreciationAccount: '2814',
    value: '6000.00',
    lifeMonths: 36,
    fiscalLifeMonths: 36,
    commissionedOn: '2026-06-15',
    evidenceId: (await s.evidence('pv-punere-in-functiune.pdf')).id,
  });
  await s.book(
    'ledger.general',
    journal(
      (await s.evidence('op-laptop.pdf')).id,
      [
        { account: '214', side: 'D', amount: '6000.00' },
        { account: '5121', side: 'C', amount: '6000.00' },
      ],
      { date: '2026-06-15' },
    ),
  );
  await s.book(
    'ledger.general',
    journal(
      (await s.evidence('cec-numerar.pdf')).id,
      [
        { account: '5311', side: 'D', amount: '1000.00' },
        { account: '5121', side: 'C', amount: '1000.00' },
      ],
      { date: '2026-06-20' },
    ),
  );
  // The subscription, deferred over twelve months from October.
  const subscription = await invoice(
    {
      number: 'AB-9',
      date: '2026-10-01',
      net: '1200.00',
      tax: '252.00',
      gross: '1452.00',
      counterparty: '11223344',
    },
    '628',
  );
  await s.book('deferrals.defer', {
    date: '2026-10-01',
    account: '628',
    amount: '1200.00',
    from: '2026-10',
    months: 12,
    partyId: subscription.document.partyId,
    documentId: subscription.document.id,
    evidenceId: subscription.document.evidenceId,
  });
  // The employee, whose untaken leave is asked at the year's end.
  const employee = await s.invoke<{ id: string; partyId: string }>(
    s.owner,
    'payroll.employees.record',
    { lastName: 'Ionescu', firstName: 'Dan', cnp: cnp('190010112345'), healthFund: 'RO-GL' },
  );
  await s.invoke(s.owner, 'payroll.contracts.record', {
    employeeId: employee.id,
    number: 'CIM-1',
    startDate: '2026-01-05',
    effectiveFrom: '2026-01-05',
    dailyHours: 8,
    mainJob: true,
    occupation: '251201',
    baseSalary: '6000',
  });
  return { s, fact, file, customer, laptop, employee };
}

/** Asks a question and answers it as the owner; returns the question's id. */
async function answered(
  s: Scenario,
  kind: string,
  subject: { kind: string; id: string },
  params: Record<string, unknown>,
  value: unknown,
) {
  const question = await s.invoke<{ id: string }>(s.owner, 'questions.ask', {
    kind,
    subject,
    params,
  });
  await s.invoke(s.owner, 'questions.answer', { questionId: question.id, value });
  return question.id;
}

/** The inventory's list of 31.12.2026, recorded from a PDF with a text layer. */
async function inventoryList(
  s: Scenario,
  file: Awaited<ReturnType<typeof company>>['file'],
  body: Record<string, unknown>,
) {
  const evidence = await file(
    'liste-inventariere-2026.txt',
    'Lista de inventariere 31.12.2026',
    'text/plain',
  );
  return s.invoke<{ id: string; checks: { code: string; status: string }[] }>(
    s.owner,
    'documents.record',
    {
      evidenceId: evidence.id,
      kind: 'inventory.list',
      body: {
        title: 'Lista de inventariere la 31.12.2026',
        company: { name: 'Pilot SRL', taxId: '12345678' },
        date: '2026-12-31',
        commission: { decision: '45', decisionDate: '2026-12-01', members: ['Pop Ion', 'Rus Ana'] },
        ...body,
      },
    },
  );
}

const review = (s: Scenario) =>
  s.invoke<Review>(s.owner, 'yearend.review', { financialYearId: s.year.id });

describe('the FY2026 close of a services SRL', () => {
  test('inventory, impairment, provisions, cut-off, the closing journal, the year lock and the 2027 opening', async () => {
    const { s, fact, file, customer, employee } = await company();
    // Before anything: the review lists what the year's end waits on.
    const before = await review(s);
    expect(before.closed).toBe(false);
    expect(new Set(before.items.map((item) => item.check))).toEqual(
      new Set(['inventory.lists', 'impairment.receivables', 'provisions', 'cutoff', 'result']),
    );
    const work = await s.list<{ kind: string; details: { check: string } }>(s.owner, 'work.list', {
      kinds: ['yearend.review'],
    });
    expect(work.length).toBeGreaterThan(0);

    // The year's depreciation and releases, month by month.
    for (const month of ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12'])
      await s.book('assets.depreciate', { month });
    for (const month of ['2026-10', '2026-11', '2026-12'])
      await s.book('deferrals.release', { month });

    // The inventory: the cash desk is 150.00 short; the customer did not reply.
    const list = await inventoryList(s, file, {
      assets: [{ number: 'MF-1', name: 'Laptop', found: true }],
      cash: [{ account: '5311', currency: 'RON', counted: '850.00' }],
      bank: [
        { account: '5121', currency: 'RON', balance: '23000.00' },
        { account: '5124', currency: 'EUR', balance: '1000.00' },
      ],
      partners: [
        {
          name: 'Companie 87654321',
          taxId: '87654321',
          account: '4111',
          currency: 'RON',
          status: 'no_reply',
        },
      ],
    });
    expect(list.checks.find((check) => check.code === 'TOTALS')?.status).toBe('passed');
    const compared = await s.invoke<{
      differences: { kind: string; book?: string; found?: string }[];
      gaps: unknown[];
    }>(s.owner, 'inventory.compare', { date: '2026-12-31' });
    expect(compared.gaps).toEqual([]);
    expect(compared.differences).toEqual([
      expect.objectContaining({ kind: 'cash', book: '1000.00', found: '850.00' }),
      expect.objectContaining({ kind: 'partner', status: 'no_reply', book: '12100.00' }),
    ]);
    const decision = (await s.evidence('decizie-administrator.pdf')).id;
    const differences = await s.propose('inventory.differences', {
      date: '2026-12-31',
      documentIds: [list.id],
      evidenceId: decision,
      imputations: [
        { kind: 'cash', ref: '5311', partyId: employee.partyId, employee: true, amount: '150.00' },
      ],
    });
    expect(lines(differences)).toEqual(['D 4282 150.00', 'C 5311 150.00']);
    expect(codes(differences)).toContain('INVENTORY_DECISION');
    await s.post(
      await s.approve(
        differences,
        s.reviewer,
        differences.issues.filter((issue) => issue.severity === 'ack').map((issue) => issue.code),
      ),
    );

    // The doubtful customer: the policy tests receivables overdue over 180 days, and the answer
    // says it is insolvent with 40% recoverable.
    const blockedImpairment = await s.propose('impairment.receivables', {
      yearEnd: '2026-12-31',
      evidenceId: decision,
    });
    expect(codes(blockedImpairment)).toEqual(['POLICY_MISSING']);
    await s.invoke(s.owner, 'proposals.withdraw', {
      proposalId: blockedImpairment.id,
      reason: 'Politica contabilă lipsea',
    });
    await fact('policy.impairment.receivables', 'overdue_180');
    const asked = await s.propose('impairment.receivables', {
      yearEnd: '2026-12-31',
      evidenceId: decision,
    });
    expect(codes(asked)).toEqual(['RECEIVABLE_COLLECTIBILITY']);
    const collectibility = await answered(
      s,
      'receivable.collectibility',
      { kind: 'party', id: customer.partyId },
      { yearEnd: '2026-12-31' },
      {
        status: 'insolvency',
        recoverable: '40',
        guaranteed: false,
        affiliated: false,
        evidenceIds: [(await s.evidence('notificare-insolventa.pdf')).id],
      },
    );
    const impairment = await s.invoke<ProposalView>(s.owner, 'impairment.receivables.revise', {
      proposalId: asked.id,
      version: asked.version,
      input: { yearEnd: '2026-12-31', evidenceId: decision },
      basis: { answers: [collectibility] },
    });
    expect(codes(impairment)).toEqual([]);
    expect(lines(impairment)).toEqual(['C 491 7260.00', 'D 6814 7260.00']);
    await s.post(await s.approve(impairment));

    // Provisions: the untaken leave measured on the payroll is a debt to the staff; a lawsuit.
    const leave = await answered(
      s,
      'leave.untaken',
      { kind: 'company', id: 'company' },
      { year: 2026 },
      {
        days: 5,
        amount: '1000.00',
        contributions: '22.50',
        measured: true,
        evidenceId: (await s.evidence('calcul-concedii.pdf')).id,
      },
    );
    const debt = await s.invoke<ProposalView>(s.owner, 'proposals.propose', {
      treatment: 'provisions.record',
      input: {
        date: '2026-12-31',
        kind: 'leave',
        reference: 'concedii-2026',
        amount: '1022.50',
        evidenceId: decision,
      },
      basis: { answers: [leave] },
    });
    expect(lines(debt)).toEqual(['D 641 1022.50', 'C 4281 1022.50']);
    await s.post(await s.approve(debt));
    const lawsuit = (await s.evidence('opinie-avocat.pdf')).id;
    const reviewAnswer = await answered(
      s,
      'provisions.review',
      { kind: 'company', id: 'company' },
      { year: 2026 },
      {
        obligations: [
          { kind: 'litigation', reference: 'dosar-123', amount: '3000.00', evidenceId: lawsuit },
        ],
      },
    );
    const provision = await s.invoke<ProposalView>(s.owner, 'proposals.propose', {
      treatment: 'provisions.record',
      input: {
        date: '2026-12-31',
        kind: 'litigation',
        reference: 'dosar-123',
        amount: '3000.00',
        evidenceId: lawsuit,
      },
      basis: { answers: [reviewAnswer] },
    });
    expect(lines(provision)).toEqual(['D 6812 3000.00', 'C 1511 3000.00']);
    await s.post(await s.approve(provision));

    // The cut-off: 5124 at the closing rate; the review now waits on the result alone.
    const fx = await s.book('fx.revalue', { date: '2026-12-31' });
    expect(lines(fx)).toEqual(['D 5124 20.00', 'C 7651 20.00']);
    expect(
      (await review(s)).items.filter((item) => item.severity === 'block').map((item) => item.id),
    ).toEqual(['result|close']);
    const closing = await s.book('year.closeResult', {
      yearEnd: '2026-12-31',
      evidenceId: (await s.evidence('nota-inchidere.pdf')).id,
    });
    expect(closing.effect?.lines.find((line) => line.account === '121')).toMatchObject({
      side: 'D',
      amount: '2562.50',
    });
    // 10,000.00 + 20.00 revenue, against 300.00 + 1,000.00 + 1,022.50 + 3,000.00 + 7,260.00.
    const remaining = await review(s);
    expect(remaining.items.filter((item) => item.severity === 'block')).toEqual([]);
    expect(remaining.items.map((item) => item.check)).toEqual(['inventory.partners']);

    // What the profit tax would read of the year (art. 26): the impairment's base for 30%.
    const determinations = await s.invoke<{
      items: { account: string; rule: string; amount: string; clause: string }[];
    }>(s.owner, 'yearend.profitDeterminations', { year: 2026 });
    expect(determinations.items).toEqual([
      expect.objectContaining({
        account: '6814',
        rule: 'receivables',
        amount: '7260.00',
        clause: 'art.26(1)(c)',
      }),
    ]);

    // Every month closes; December shows no year-end warning any more, then the year closes.
    for (let month = 1; month <= 12; month++) {
      const closed = await s.closeApproved(`2026-${String(month).padStart(2, '0')}`);
      expect(closed.status).toBe('executed');
    }
    const request = await s.invoke<ActionView>(s.owner, 'years.close.request', {
      financialYearId: s.year.id,
    });
    const preview = request.preview as {
      findings: { code: string; severity: string }[];
      snapshot: { hash: string; accounts: number; items: number; assets: number };
    };
    expect(preview.findings.filter((item) => item.severity === 'block')).toEqual([]);
    expect(preview.snapshot.assets).toBe(1);
    await s.invoke(s.reviewer, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    const executed = await s.invoke<ActionView>(s.reviewer, 'actions.execute', { id: request.id });
    expect(executed.result).toMatchObject({
      yearEnd: '2026-12-31',
      snapshotHash: preview.snapshot.hash,
    });
    expect((await review(s)).closed).toBe(true);

    // The lock: a month of the closed year does not reopen, and nothing posts into it.
    const reopen = await s.invoke<ActionView>(s.owner, 'periods.reopen.request', {
      month: '2026-12',
      reason: 'Corectăm o înregistrare de sfârșit de an',
    });
    expect(
      (reopen.preview as { findings: { code: string }[] }).findings.map((item) => item.code),
    ).toContain('YEAR_CLOSED');

    // The 2027 opening is the closing, per account, open item and asset.
    const next = await s.invoke<{ id: string }>(s.owner, 'years.create', {
      kind: 'financial',
      label: '2027',
      from: '2027-01-01',
      to: '2027-12-31',
    });
    await s.book('deferrals.release', { month: '2027-01' });
    const opening = await s.invoke<{ matches: boolean; differences: unknown[]; closed: boolean }>(
      s.owner,
      'years.opening',
      { financialYearId: next.id },
    );
    expect(opening).toMatchObject({ closed: true, matches: true, differences: [] });
    // An opening entry (DESCHIDERE) would count the 2026 balances twice: the check names it,
    // and January does not close until it is reversed.
    const duplicate = await s.book(
      'ledger.general',
      journal(
        (await s.evidence('deschidere-dubla.pdf')).id,
        [
          { account: '5121', side: 'D', amount: '23000.00' },
          { account: '1012', side: 'C', amount: '23000.00' },
        ],
        { date: '2027-01-01', purpose: 'opening' },
      ),
    );
    const duplicated = await s.invoke<{ matches: boolean; openings: string[] }>(
      s.owner,
      'years.opening',
      { financialYearId: next.id },
    );
    expect(duplicated).toMatchObject({ matches: false, openings: [duplicate.entry!.id] });
    expect(
      ((await s.close('2027-01')).preview as { findings: { code: string }[] }).findings.map(
        (item) => item.code,
      ),
    ).toContain('YEAR_OPENING_DUPLICATE');
    await s.book('ledger.reverse', {
      entryId: duplicate.entry!.id,
      date: '2027-01-01',
      reason: 'Deschiderea dublează soldurile din 2026',
      evidenceId: (await s.evidence('storno.pdf')).id,
      method: 'red',
    });
    const january = await s.closeApproved('2027-01');
    expect(january.status).toBe('executed');

    // FY2026's statements wait on ANAF's package (FORMAT_GAP); FY2025's path is unchanged
    // (s1005.integration.test.ts).
    const prepared = await s.refused(
      s.invoke(s.owner, 'declarations.prepare', {
        kind: 'S1005',
        period: '2026',
        options: {
          entity: {
            tradeRegister: 'J17/123/2010',
            ownership: 35,
            caen: '6210',
            caenActual: '6210',
            caenVersion: 2025,
            largeTaxpayer: false,
            branch: false,
            economicInterestGroup: false,
            netAssetsBelowHalfCapital: false,
            phone: '0236000000',
          },
          administrator: 'Popescu Ana',
          preparer: { name: 'Ionescu Maria', quality: 22, membership: '12345', cif: '14399840' },
          approved: true,
          rows: {},
        },
      }),
    );
    expect(prepared?.code).toBe('FORMAT_GAP');

    // Reopening the year, with its reason, unlocks its months again.
    const reopenYear = await s.invoke<ActionView>(s.owner, 'years.reopen.request', {
      financialYearId: s.year.id,
      reason: 'Hotărârea AGA cere o corectură înainte de aprobare',
    });
    await s.invoke(s.reviewer, 'actions.approve', {
      id: reopenYear.id,
      previewHash: reopenYear.previewHash,
    });
    await s.invoke(s.reviewer, 'actions.execute', { id: reopenYear.id });
    const again = await s.invoke<ActionView>(s.owner, 'periods.reopen.request', {
      month: '2026-12',
      reason: 'Corectăm o înregistrare de sfârșit de an',
    });
    expect(
      (again.preview as { findings: { code: string }[] }).findings.map((item) => item.code),
    ).not.toContain('YEAR_CLOSED');
  }, 120_000);
});

describe('a PFA year-end', () => {
  test('single entry: the inventory of its register, no allowances or provisions, the year closed', async () => {
    const s = await scenario({ clock: at('2027-02-20') });
    open.push(s);
    const fact = async (axis: string, value: string) =>
      s.invoke(s.owner, 'profile.record', {
        axis,
        value,
        effectiveFrom: '2026-01-01',
        evidenceId: (await s.evidence(`${axis}.pdf`)).id,
      });
    await fact('entity.form', 'pfa');
    await s.book(
      'ledger.general',
      journal(
        (await s.evidence('registru-inventar-deschidere.pdf')).id,
        [
          { account: '5121', side: 'D', amount: '8000.00' },
          { account: '1012', side: 'C', amount: '8000.00' },
        ],
        { date: '2026-01-01', purpose: 'opening' },
      ),
    );
    const before = await review(s);
    expect(before.items.map((item) => item.check)).toEqual(['inventory.lists']);
    const evidence = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'inventar-pfa.txt',
      mediaType: 'text/plain',
      base64: Buffer.from('Inventar 31.12.2026').toString('base64'),
    });
    await s.invoke(s.owner, 'documents.record', {
      evidenceId: evidence.id,
      kind: 'inventory.list',
      body: {
        title: 'Registrul-inventar 2026',
        company: { name: 'Pilot PFA', taxId: '12345678' },
        date: '2026-12-31',
        commission: { decision: '1', decisionDate: '2026-12-15', members: ['Popescu Ana'] },
        bank: [{ account: '5121', currency: 'RON', balance: '8000.00' }],
      },
    });
    expect((await review(s)).items).toEqual([]);
    const inventory = await s.invoke<{ date: string; sections: unknown[] }>(
      s.owner,
      'pfa.inventory',
      { occasion: 'year_end', year: 2026 },
    );
    expect(inventory.date).toBe('2026-12-31');
    // Allowances and provisions are double entry's.
    expect(
      codes(
        await s.propose('impairment.receivables', {
          yearEnd: '2026-12-31',
          evidenceId: evidence.id,
        }),
      ),
    ).toContain('SINGLE_ENTRY_EXCLUDED');
    for (let month = 1; month <= 12; month++)
      expect((await s.closeApproved(`2026-${String(month).padStart(2, '0')}`)).status).toBe(
        'executed',
      );
    const request = await s.invoke<ActionView>(s.owner, 'years.close.request', {
      financialYearId: s.year.id,
    });
    await s.invoke(s.reviewer, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    expect(
      (await s.invoke<ActionView>(s.reviewer, 'actions.execute', { id: request.id })).status,
    ).toBe('executed');
  }, 60_000);
});

describe('agent-ready', () => {
  test('its detector is a worklist kind, its questions question kinds', () => {
    expect(workKinds as readonly string[]).toContain('yearend.review');
    for (const detector of yearEndAgent.detectors)
      expect(workKinds as readonly string[]).toContain(detector.kind);
    for (const question of yearEndAgent.questions)
      expect(questionKindIds as readonly string[]).toContain(question.kind);
    expect(yearEndAgent.documentTypes.map((item) => item.id)).toContain('inventory.list');
  });
});
