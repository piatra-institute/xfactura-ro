import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { DukIntegrator } from '../../source/engine/adapters/declaration-validator';
import type { ProposalView } from '../../source/engine/kernel/views';
import { iban as ronIban } from './fixtures/bank';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

// Synthetic contracts, statements, rates and invoices. Every expected amount below is computed by
// hand from them, independently of the engine.

const dist = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
const official = DukIntegrator.available(dist) && Bun.which('java') ? test : test.skip;

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

/** A valid Romanian IBAN for a synthetic bank code (ISO 7064 mod 97-10 check digits). */
function iban(bank: string, account: string) {
  const bban = `${bank}${account}`;
  const digits = `${bban}RO00`.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  const check = 98n - (BigInt(digits) % 97n);
  return `RO${String(check).padStart(2, '0')}${bban}`;
}
const eurIban = iban('BBBB', '1B31007593840001');

const bnr = `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Header><Publisher>National Bank of Romania</Publisher><PublishingDate>2026-04-30</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
<Cube date="2026-03-02"><Rate currency="EUR">5.0000</Rate></Cube>
<Cube date="2026-03-16"><Rate currency="EUR">5.0000</Rate></Cube>
<Cube date="2026-03-31"><Rate currency="EUR">5.0500</Rate></Cube>
<Cube date="2026-04-01"><Rate currency="EUR">5.0400</Rate></Cube>
<Cube date="2026-04-30"><Rate currency="EUR">5.0600</Rate></Cube>
</Body></DataSet>`;

/** One statement of an account opened at zero, with its entries in order. */
function statement(
  account: string,
  currency: string,
  entries: { date: string; amount: string; reference: string }[],
) {
  const yymmdd = (date: string) => date.slice(2).replaceAll('-', '');
  const cents = (amount: string) => BigInt(amount.replace('-', '').replace('.', ''));
  let balance = 0n;
  const lines = entries.map(({ date, amount, reference }) => {
    const credit = !amount.startsWith('-');
    balance += credit ? cents(amount) : -cents(amount);
    return `:61:${yymmdd(date)}${yymmdd(date).slice(2)}${credit ? 'C' : 'D'}${amount.replace('-', '').replace('.', ',')}NTRF${reference}//${reference}-B\n:86:${reference}`;
  });
  const closing = `${balance / 100n},${String(balance % 100n).padStart(2, '0')}`;
  return `:20:${currency}2026\n:25:${account}\n:28C:001/001\n:60F:C${yymmdd(entries[0]!.date.slice(0, 8) + '01')}${currency}0,00\n${lines.join('\n')}\n:62F:C${yymmdd(entries.at(-1)!.date)}${currency}${closing}`;
}

/** A VAT payer with its invoicing details, BNR rates, a lei and a euro bank account. */
/** The owner's answer that the car is used privately too (Codul fiscal art. 298), which the
 * proposals booking its lease cite: its VAT is half deducted. */
async function usedPrivately(s: Scenario, plate: string) {
  const asked = await s.invoke<{ id: string }>(s.owner, 'questions.ask', {
    kind: 'vehicle.use',
    subject: { kind: 'vehicle', id: plate },
    params: {},
  });
  await s.invoke(s.owner, 'questions.answer', {
    questionId: asked.id,
    value: { use: 'mixed', from: '2026-01-01' },
  });
  return { answers: [asked.id] };
}

async function company(validator?: DukIntegrator) {
  const s = await scenario({
    cui: '18547290',
    ...(validator ? { declarationValidator: validator } : {}),
  });
  open.push(s);
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
    evidenceId: (await s.evidence('certificat-tva.pdf')).id,
  });
  await s.invoke(s.owner, 'sales.seller.record', {
    details: {
      name: 'Exemplu Servicii SRL',
      vatId: 'RO18547290',
      address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
    },
  });
  const file = async (filename: string, text: string, mediaType = 'application/xml') =>
    s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename,
      mediaType,
      base64: Buffer.from(text).toString('base64'),
    });
  await s.invoke(s.owner, 'fx.importBnr', { evidenceId: (await file('bnr.xml', bnr)).id });
  for (const [currency, accountIban, ledgerAccount] of [
    ['RON', ronIban, '5121'],
    ['EUR', eurIban, '5124'],
  ] as const)
    await s.invoke(s.owner, 'treasury.createAccount', {
      kind: 'bank',
      name: `Cont ${currency}`,
      iban: accountIban,
      currency,
      ledgerAccount,
      openedOn: '2026-01-01',
    });
  /** Imports a statement and returns its movements by booking date. */
  const bank = async (
    currency: 'RON' | 'EUR',
    entries: { date: string; amount: string; reference: string }[],
  ) => {
    const text = statement(currency === 'RON' ? ronIban : eurIban, currency, entries);
    await s.invoke(s.owner, 'bank.import', {
      evidenceId: (await file(`extras-${currency}.sta`, text, 'text/plain')).id,
      financialYearId: s.year.id,
    });
    const movements = await s.list<{ id: string; bookingDate: string; currency: string }>(
      s.owner,
      'bank.movements',
      {},
    );
    return (date: string) =>
      movements.find((item) => item.bookingDate === date && item.currency === currency)!.id;
  };
  const party = (kind: string, name: string, taxId?: string) =>
    s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind,
      country: 'RO',
      name,
      ...(taxId ? { taxId } : {}),
    });
  const invoice = async (input: XmlInput) => {
    const { id } = await file(`${input.number}.xml`, invoiceXml({ company: '18547290', ...input }));
    return s.invoke<{ id: string; partyId: string }>(s.owner, 'invoices.import', {
      evidenceId: id,
    });
  };
  return { s, bank, party, invoice, file };
}

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map(
    (line) =>
      `${line.side} ${line.account} ${line.amount}${line.currency ? ` [${line.currency.code} ${line.currency.amount}]` : ''}`,
  );
const closing = async (s: Scenario, account: string) =>
  (await s.trialBalance()).rows.find((row) => row.account === account)?.closing;
const findings = async (s: Scenario, month: string) =>
  ((await s.close(month)).preview as { findings: { code: string; severity: string }[] }).findings;
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);

describe('a bank loan in lei', () => {
  test('is received with its schedule, accrues interest by the day and is repaid through the bank', async () => {
    const { s, bank, party } = await company();
    const lender = await party('ro_legal_entity', 'Banca Exemplu SA', '14399840');
    const movement = await bank('RON', [
      { date: '2026-03-16', amount: '24000.00', reference: 'CREDIT-1' },
      { date: '2026-04-16', amount: '-1180.00', reference: 'RATA-1' },
    ]);
    const contract = (await s.evidence('contract-credit.pdf')).id;
    // 24,000.00 at 9% a year, 24 equal principal parts of 1,000.00 from 16 April 2026.
    const terms = { method: 'linear', rate: '9', months: 24, firstDue: '2026-04-16' };
    const wrong = await s.propose('loans.receive', {
      movementId: movement('2026-03-16'),
      account: '1621',
      partyId: lender.id,
      evidenceId: contract,
      instalments: [{ due: '2027-04-16', principal: '23000.00' }],
    });
    expect(codes(wrong)).toEqual(['SCHEDULE_PRINCIPAL']);
    const received = await s.revise('loans.receive', wrong, {
      movementId: movement('2026-03-16'),
      account: '1621',
      partyId: lender.id,
      evidenceId: contract,
      terms,
    });
    expect(codes(received)).toEqual([]);
    expect(lines(received)).toEqual(['D 5121 24000.00', 'C 1621 24000.00']);
    const schedule = received.effect!.schedules[0]!;
    expect(schedule.rows).toHaveLength(48);
    // 24,000 × 9% / 12 = 180.00 for 16 March–16 April; 23,000 × 0.75% = 172.50 after.
    expect(
      schedule.rows.slice(0, 4).map((row) => `${row.key} ${row.amount} ${row.counterAccount}`),
    ).toEqual([
      'interest:2026-03-16/2026-04-16 180.00 1682',
      'principal:2026-04-16 1000.00 1621',
      'interest:2026-04-16/2026-05-16 172.50 1682',
      'principal:2026-05-16 1000.00 1621',
    ]);
    const loan = (await s.post(await s.approve(received))).effect!.openItems[0]!;

    // March: 15 of the period's 31 days, 180.00 × 15 / 31 = 87.0967 → 87.10.
    expect((await findings(s, '2026-03')).map((item) => item.code)).toContain('LOAN_INTEREST_DUE');
    const march = await s.propose('loans.accrue', { month: '2026-03' });
    expect(lines(march)).toEqual(['D 666 87.10', 'C 1682 87.10']);
    const accrued = await s.post(await s.approve(march));
    const interest = accrued.effect!.openItems[0]!;
    expect((await findings(s, '2026-03')).map((item) => item.code)).not.toContain(
      'LOAN_INTEREST_DUE',
    );
    expect(codes(await s.propose('loans.accrue', { month: '2026-03', round: 2 }))).toEqual([
      'NOTHING_TO_ACCRUE',
    ]);

    // 16 April: the bank takes 1,000.00 principal and the period's 180.00 interest.
    const paid = await s.book('bank.settle', {
      movementId: movement('2026-04-16'),
      allocations: [
        { openItem: loan.id, amount: '1000.00' },
        { openItem: interest.id, amount: '180.00' },
      ],
    });
    expect(lines(paid)).toEqual(['C 5121 1180.00', 'D 1621 1000.00', 'D 1682 180.00']);

    // The bank resets the rate to 10% from the next period: 23,000 × 10% / 12 = 191.666 → 191.67.
    const reset = await s.propose('loans.schedule', {
      openItem: loan.id,
      date: '2026-04-20',
      evidenceId: (await s.evidence('act-aditional.pdf')).id,
      terms: { method: 'linear', rate: '10', months: 23, firstDue: '2026-05-16' },
    });
    expect(codes(reset)).toEqual([]);
    expect(reset.effect!.journalClass).toBe('memo');
    expect(reset.effect!.schedules[0]!.version).toBe(2);
    expect(
      reset.effect!.schedules[0]!.rows.slice(2, 4).map((row) => `${row.key} ${row.amount}`),
    ).toEqual(['interest:2026-04-16/2026-05-16 191.67', 'principal:2026-05-16 1000.00']);
    await s.post(await s.approve(reset));

    // April: 180.00 in full and 14 of 30 days at the new rate, 191.67 × 14 / 30 = 89.446 →
    // 89.45; 269.45 less the 87.10 accrued.
    const april = await s.propose('loans.accrue', { month: '2026-04' });
    expect(lines(april)).toEqual(['D 666 182.35', 'C 1682 182.35']);
    await s.post(await s.approve(april));
    expect(await closing(s, '1621')).toEqual({ debit: '0.00', credit: '23000.00' });
    // Accrued and not yet paid: 269.45 − 180.00, 16–30 April's share.
    expect(await closing(s, '1682')).toEqual({ debit: '0.00', credit: '89.45' });
    expect(await closing(s, '666')).toEqual({ debit: '269.45', credit: '0.00' });

    // May's instalment is not paid by its end: a warning, beside the interest to accrue.
    const may = await findings(s, '2026-05');
    expect(may).toContainEqual(expect.objectContaining({ code: 'LOAN_OVERDUE', severity: 'warn' }));
    expect(may).toContainEqual(
      expect.objectContaining({ code: 'LOAN_INTEREST_DUE', severity: 'block' }),
    );

    // At the year's end: 23,000.00 owed, of which 2027's twelve instalments and the eight
    // overdue of 2026 are due within the year.
    const [view] = await s.list<Record<string, unknown>>(s.owner, 'loans.list', {
      at: '2026-12-31',
    });
    expect(view).toMatchObject({
      kind: 'loan',
      account: '1621',
      interestAccount: '1682',
      currency: 'RON',
      owed: '23000.00',
      withinYear: '20000.00',
    });
  });
});

describe('a bank loan in euro', () => {
  test('is booked at the day’s rate, accrues interest in euro and is revalued at month end', async () => {
    const { s, bank, party } = await company();
    const lender = await party('ro_legal_entity', 'Banca Exemplu SA', '14399840');
    const movement = await bank('EUR', [
      { date: '2026-03-16', amount: '10000.00', reference: 'CREDIT-EUR' },
    ]);
    const received = await s.propose('loans.receive', {
      movementId: movement('2026-03-16'),
      account: '1621',
      partyId: lender.id,
      evidenceId: (await s.evidence('contract-credit-eur.pdf')).id,
      instalments: [
        // 16 March–16 September 2026: 184 days.
        { due: '2026-09-16', principal: '3000.00', interest: '250.00' },
        { due: '2027-03-16', principal: '3000.00', interest: '175.00' },
        { due: '2027-09-16', principal: '4000.00', interest: '100.00' },
      ],
    });
    expect(codes(received)).toEqual([]);
    // 10,000.00 EUR × 5.0000.
    expect(lines(received)).toEqual([
      'D 5124 50000.00 [EUR 10000.00]',
      'C 1621 50000.00 [EUR 10000.00]',
    ]);
    await s.post(await s.approve(received));
    // 250.00 × 15 / 184 = 20.3804 → 20.38 EUR, × 5.0500 = 102.919 → 102.92 lei.
    const march = await s.propose('loans.accrue', { month: '2026-03' });
    expect(lines(march)).toEqual(['D 666 102.92', 'C 1682 102.92 [EUR 20.38]']);
    await s.post(await s.approve(march));
    // At 5.0500: the loan 50,500.00 (+500.00, a loss), the bank 50,500.00 (+500.00, a gain); the
    // interest was accrued at that rate.
    expect((await findings(s, '2026-03')).map((item) => item.code)).toContain('FX_NOT_REVALUED');
    const revalued = await s.propose('fx.revalue', { date: '2026-03-31' });
    expect(lines(revalued)).toEqual([
      'C 1621 500.00 [EUR 0.00]',
      'D 5124 500.00 [EUR 0.00]',
      'C 7651 500.00',
      'D 6651 500.00',
    ]);
    await s.post(await s.approve(revalued));
    expect(await closing(s, '1621')).toEqual({ debit: '0.00', credit: '50500.00' });
    const [view] = await s.list<Record<string, unknown>>(s.owner, 'loans.list', {
      at: '2026-03-31',
    });
    // Due by 31 March 2027: the first two instalments.
    expect(view).toMatchObject({ currency: 'EUR', owed: '10000.00', withinYear: '6000.00' });
  });

  test('on 519 asks to confirm a term over a year', async () => {
    const { s, bank, party } = await company();
    const lender = await party('ro_legal_entity', 'Banca Exemplu SA', '14399840');
    const movement = await bank('EUR', [
      { date: '2026-03-16', amount: '10000.00', reference: 'CREDIT-EUR' },
    ]);
    const received = await s.propose('loans.receive', {
      movementId: movement('2026-03-16'),
      account: '5191',
      partyId: lender.id,
      evidenceId: (await s.evidence('contract.pdf')).id,
      instalments: [{ due: '2027-09-16', principal: '10000.00', interest: '800.00' }],
    });
    expect(received.issues.map((issue) => `${issue.severity} ${issue.code}`)).toEqual([
      'ack LOAN_TERM',
    ]);
    expect(received.effect!.schedules[0]!.rows.map((row) => row.counterAccount)).toEqual([
      '5198',
      '5191',
    ]);
  });
});

describe('an associate’s loan', () => {
  /** A synthetic CNP with a valid control digit. */
  const cnp = (body: string) => {
    const weights = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
    const control =
      weights.reduce((sum, weight, index) => sum + weight * Number(body[index]), 0) % 11;
    return `${body}${control === 10 ? 1 : control}`;
  };

  official(
    'bears interest, taxed at 10% when paid, declared in D100 (605) and D205 (09)',
    async () => {
      const { s, bank, party } = await company(new DukIntegrator(dist));
      const anaf = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
        kind: 'ro_public_institution',
        country: 'RO',
        name: 'ANAF',
      });
      const associate = await party('ro_individual', 'Ionescu Maria');
      await s.invoke(s.owner, 'parties.recordCnp', {
        partyId: associate.id,
        cnp: cnp('285072217002'),
      });
      const movement = await bank('RON', [
        { date: '2026-02-02', amount: '50000.00', reference: 'IMPRUMUT-ASOCIAT' },
        { date: '2026-08-03', amount: '-900.00', reference: 'DOBANDA-ASOCIAT' },
      ]);
      // The money arrives on 4551, as any associate's money does.
      const received = await s.book('bank.settle', {
        movementId: movement('2026-02-02'),
        opens: [{ account: '4551', partyId: associate.id, amount: '50000.00' }],
      });
      const loan = received.effect!.openItems[0]!;
      // The loan contract: 4% a year, interest every six months, repaid after a year.
      const plan = await s.propose('loans.schedule', {
        openItem: loan.id,
        date: '2026-02-28',
        evidenceId: (await s.evidence('contract-imprumut.pdf')).id,
        start: '2026-02-02',
        instalments: [
          { due: '2026-08-02', interest: '1000.00' },
          { due: '2027-02-02', principal: '50000.00', interest: '1000.00' },
        ],
      });
      expect(codes(plan)).toEqual([]);
      await s.post(await s.approve(plan));
      // Accrued through July in one catch-up: 1,000.00 × 179 / 181 = 988.950 → 988.95, on 4558.
      const july = await s.propose('loans.accrue', { month: '2026-07' });
      expect(lines(july)).toEqual(['D 666 988.95', 'C 4558 988.95']);
      const interest = (await s.post(await s.approve(july))).effect!.openItems[0]!;

      // 3 August: 1,000.00 paid, 10% withheld, the net 900.00 through the bank.
      const withheld = await s.propose('loans.withhold', {
        openItem: interest.id,
        date: '2026-08-03',
        gross: '1000.00',
        authorityId: anaf.id,
      });
      expect(lines(withheld)).toEqual(['D 4558 100.00', 'C 446 100.00']);
      expect(withheld.rules.used.map((rule) => rule.id)).toEqual([
        'ro.declaration.rounding/2016-01-01',
        'ro.interest.tax_rate/individual/2026-01-01',
      ]);
      await s.post(await s.approve(withheld));
      await s.book('bank.settle', {
        movementId: movement('2026-08-03'),
        allocations: [{ openItem: interest.id, amount: '900.00' }],
      });
      // August: the first period in full, and 29 of the second's 184 days, 157.6087 → 157.61.
      const august = await s.propose('loans.accrue', { month: '2026-08' });
      expect(lines(august)).toEqual(['D 666 168.66', 'C 4558 168.66']);
      await s.post(await s.approve(august));
      expect(await closing(s, '4558')).toEqual({ debit: '0.00', credit: '157.61' });
      expect(await closing(s, '446')).toEqual({ debit: '0.00', credit: '100.00' });

      const declarant = { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' };
      const d100 = await s.invoke<{ state: string; steps: { detail: string | null }[] }>(
        s.owner,
        'declarations.prepare',
        { kind: 'D100', period: '2026-08', options: { declarant } },
      );
      expect(JSON.parse(d100.steps[0]!.detail!).obligations).toEqual(['interest']);
      expect(d100.state).toBe('validated_official');
      const d205 = await s.invoke<{ state: string; steps: { detail: string | null }[] }>(
        s.owner,
        'declarations.prepare',
        { kind: 'D205', period: '2026', options: { declarant, paidAs: 'gross' } },
      );
      expect(JSON.parse(d205.steps[0]!.detail!)).toEqual({
        year: '2026',
        individuals: 1,
        companies: 0,
      });
      expect([d205.state, d205.steps.at(-1)?.detail ?? null]).toEqual(['validated_official', null]);
    },
    120_000,
  );

  test('withholds no tax on interest owed to a company, and refuses a schedule without its start', async () => {
    const { s, bank, party } = await company();
    const anaf = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_public_institution',
      country: 'RO',
      name: 'ANAF',
    });
    const holding = await party('ro_legal_entity', 'Holding Exemplu SRL', '14399840');
    const movement = await bank('RON', [
      { date: '2026-02-02', amount: '10000.00', reference: 'IMPRUMUT' },
    ]);
    const received = await s.book('loans.receive', {
      movementId: movement('2026-02-02'),
      account: '167',
      partyId: holding.id,
      evidenceId: (await s.evidence('contract.pdf')).id,
      instalments: [{ due: '2026-03-02', principal: '10000.00', interest: '50.00' }],
    });
    expect(received.effect!.schedules[0]!.rows.map((row) => row.counterAccount)).toEqual([
      '1687',
      '167',
    ]);
    const accrued = await s.book('loans.accrue', { month: '2026-03' });
    expect(lines(accrued)).toEqual(['D 666 50.00', 'C 1687 50.00']);
    const tax = await s.propose('loans.withhold', {
      openItem: accrued.effect!.openItems[0]!.id,
      date: '2026-03-02',
      gross: '50.00',
      authorityId: anaf.id,
    });
    expect(codes(tax)).toEqual(['BENEFICIARY']);
    const again = await s.propose('loans.schedule', {
      openItem: received.effect!.openItems[0]!.id,
      date: '2026-02-01',
      evidenceId: (await s.evidence('act.pdf')).id,
      instalments: [{ due: '2026-04-02', principal: '10000.00', interest: '100.00' }],
    });
    // The schedule cannot predate the loan, nor change rows already due.
    expect(codes(again)).toEqual(['DATE']);
  });
});

describe('a finance lease of a car in euro, invoiced in lei', () => {
  test('brings the asset in at the day’s rate, depreciates it, splits each instalment and revalues the liability', async () => {
    const { s, party, invoice } = await company();
    // The lessor is the invoices' supplier (fiscal code 87654321).
    const lessor = await party('ro_legal_entity', 'Leasing Exemplu IFN SA', '87654321');
    const record = (await s.evidence('pv-predare-primire.pdf')).id;
    // 20,000.00 EUR × 5.0000 on 2 March.
    const car = await s.invoke<{ id: string }>(s.owner, 'assets.register', {
      number: 'MF-1',
      name: 'Autoturism',
      catalogCode: '2.3.2.1.1',
      account: '2133',
      depreciationAccount: '2813',
      expenseAccount: '6811',
      value: '100000.00',
      lifeMonths: 60,
      fiscalLifeMonths: 60,
      commissionedOn: '2026-03-02',
      evidenceId: record,
    });
    const terms = (value: string, residual: string) => ({
      date: '2026-03-02',
      lessorId: lessor.id,
      evidenceId: record,
      assetId: car.id,
      currency: 'EUR',
      value,
      settlement: 'lei',
      instalments: [
        // The advance, then two instalments, then the residual value.
        { due: '2026-03-02', principal: '4000.00' },
        { due: '2026-04-01', principal: '300.00', interest: '80.00' },
        { due: '2026-05-01', principal: '301.20', interest: '78.80' },
        { due: '2029-03-01', principal: residual },
      ],
    });
    // 19,000.00 EUR would be 95,000.00 lei, not the card's value.
    const misvalued = await s.propose('leases.commence', terms('19000.00', '14398.80'));
    expect(codes(misvalued)).toEqual(['ASSET_VALUE']);
    const commenced = await s.revise('leases.commence', misvalued, terms('20000.00', '15398.80'));
    expect(codes(commenced)).toEqual([]);
    expect(lines(commenced)).toEqual(['D 2133 100000.00', 'C 167 100000.00 [EUR 20000.00]']);
    expect(commenced.effect!.schedules[0]!.method).toBe('lease.indexed');
    const lease = (await s.post(await s.approve(commenced))).effect!.openItems[0]!;
    // A finance lease's interest comes with the lessor's invoice: nothing to accrue.
    expect(codes(await s.propose('loans.accrue', { month: '2026-03' }))).toEqual([
      'NOTHING_TO_ACCRUE',
    ]);

    // The advance invoice: 4,000.00 EUR × 5.0000 = 20,000.00 lei and 21% VAT, half deducted for
    // a car not used only for the business (art. 298); the other half is an expense.
    const advance = await invoice({
      number: 'LS-AVANS',
      date: '2026-03-02',
      net: '20000.00',
      tax: '4200.00',
      gross: '24200.00',
    });
    const basis = await usedPrivately(s, 'GL-10-LSG');
    const leasePart = (amount: string, principal: string) => ({
      account: '167',
      vat: 'S-21',
      amount,
      lease: lease.id,
      principal,
      deduction: 'limited',
      vehicle: 'GL-10-LSG',
      vatExpense: '635',
    });
    const unnamed = await s.propose('invoices.recognize', {
      documentId: advance.id,
      allocations: [{ account: '167', vat: 'S-21', amount: '20000.00', deduction: 'full' }],
    });
    expect(codes(unnamed)).toEqual(['LEASE']);
    const advanced = await s.invoke<ProposalView>(s.owner, 'proposals.revise', {
      proposalId: unnamed.id,
      version: unnamed.version,
      input: { documentId: advance.id, allocations: [leasePart('20000.00', '4000.00')] },
      basis,
    });
    expect(codes(advanced)).toEqual([]);
    expect(lines(advanced)).toEqual([
      'D 167 20000.00 [EUR 4000.00]',
      'D 635 2100.00',
      'D 4426 2100.00',
      'C 404 24200.00',
    ]);
    await s.post(await s.approve(advanced));

    // March's end at 5.0500: the 16,000.00 EUR left, carried at 80,000.00, is 80,800.00; a lease
    // settled in lei at the euro's rate takes the difference to 668.
    const march = await s.propose('fx.revalue', { date: '2026-03-31' });
    expect(lines(march)).toEqual(['C 167 800.00 [EUR 0.00]', 'D 668 800.00']);
    await s.post(await s.approve(march));
    // Depreciation from April: 100,000.00 over 60 months.
    expect(lines(await s.book('assets.depreciate', { month: '2026-04' }))).toEqual([
      'D 6811 1666.67',
      'C 2813 1666.67',
    ]);

    // April's instalment at 5.0400: principal 300.00 EUR = 1,512.00 lei, interest 80.00 EUR =
    // 403.20 lei, VAT 21% of 1,915.20 = 402.19. The VAT splits 317.52 / 84.67 by the parts, half
    // deducted (158.76, 42.34). The principal releases 300/16,000 of 80,800.00 = 1,515.00 from
    // 167: 3.00 less is a gain on 768.
    const instalment = await invoice({
      number: 'LS-0001',
      date: '2026-04-01',
      net: '1915.20',
      tax: '402.19',
      gross: '2317.39',
      lines: [
        { rate: '21', net: '1512.00', name: 'Rata de capital' },
        { rate: '21', net: '403.20', name: 'Dobânda' },
      ],
    });
    const split = await s.invoke<ProposalView>(s.owner, 'proposals.propose', {
      treatment: 'invoices.recognize',
      input: {
        documentId: instalment.id,
        allocations: [
          leasePart('1512.00', '300.00'),
          {
            account: '666',
            vat: 'S-21',
            amount: '403.20',
            deduction: 'limited',
            vehicle: 'GL-10-LSG',
          },
        ],
      },
      basis,
    });
    expect(codes(split)).toEqual([]);
    expect(lines(split)).toEqual([
      'D 167 1515.00 [EUR 300.00]',
      'D 635 158.76',
      'C 768 3.00',
      'D 666 445.53',
      'D 4426 201.10',
      'C 404 2317.39',
    ]);
    expect(split.effect!.taxEntries[0]).toMatchObject({
      base: '1915.20',
      amount: '402.19',
      deductible: '201.10',
    });
    await s.post(await s.approve(split));

    // April's end at 5.0600: 15,700.00 EUR carried at 79,285.00 is 79,442.00.
    expect(lines(await s.book('fx.revalue', { date: '2026-04-30' }))).toEqual([
      'C 167 157.00 [EUR 0.00]',
      'D 668 157.00',
    ]);
    expect(await closing(s, '167')).toEqual({ debit: '0.00', credit: '79442.00' });
    expect(await closing(s, '2133')).toEqual({ debit: '100000.00', credit: '0.00' });
    expect((await findings(s, '2026-04')).map((item) => item.code)).not.toContain(
      'LEASE_INSTALMENT_DUE',
    );
    // May's instalment, due on 1 May, has not been invoiced by the month's end.
    expect(await findings(s, '2026-05')).toContainEqual(
      expect.objectContaining({ code: 'LEASE_INSTALMENT_DUE', severity: 'warn' }),
    );
    const [view] = await s.list<Record<string, unknown>>(s.owner, 'loans.list', {
      at: '2026-04-30',
    });
    expect(view).toMatchObject({
      kind: 'lease',
      account: '167',
      interestAccount: '666',
      owed: '15700.00',
      owedLei: '79442.00',
      // May's 301.20 EUR is due within the year; the residual value in 2029.
      withinYear: '301.20',
      interestToAccrue: null,
      nextDue: '2026-05-01',
    });
  });
});

describe('a finance lease invoiced in euro', () => {
  test('takes its exchange differences to 665 and 765', async () => {
    const { s, party, file } = await company();
    const lessor = await party('ro_legal_entity', 'Leasing Exemplu IFN SA', '87654321');
    const record = (await s.evidence('pv-predare-primire.pdf')).id;
    // 10,000.00 EUR × 5.0000.
    const machine = await s.invoke<{ id: string }>(s.owner, 'assets.register', {
      number: 'MF-2',
      name: 'Utilaj',
      catalogCode: '2.1.16.1',
      account: '2131',
      depreciationAccount: '2813',
      expenseAccount: '6811',
      value: '50000.00',
      lifeMonths: 96,
      fiscalLifeMonths: 96,
      commissionedOn: '2026-03-02',
      evidenceId: record,
    });
    const commenced = await s.book('leases.commence', {
      date: '2026-03-02',
      lessorId: lessor.id,
      evidenceId: record,
      assetId: machine.id,
      currency: 'EUR',
      value: '10000.00',
      settlement: 'currency',
      instalments: [
        { due: '2026-04-01', principal: '1000.00', interest: '50.00' },
        { due: '2027-04-01', principal: '9000.00' },
      ],
    });
    expect(commenced.effect!.schedules[0]!.method).toBe('lease');
    const lease = commenced.effect!.openItems[0]!;
    expect(lines(await s.book('fx.revalue', { date: '2026-03-31' }))).toEqual([
      'C 167 500.00 [EUR 0.00]',
      'D 6651 500.00',
    ]);
    // 1,050.00 EUR at 5.0400 = 5,292.00 lei: 5,040.00 principal and 252.00 interest; VAT 220.50
    // EUR stated as 1,111.32 lei. The principal releases a tenth of 50,500.00 = 5,050.00.
    const xml = invoiceXml({
      company: '18547290',
      currency: 'EUR',
      number: 'LS-EUR-1',
      date: '2026-04-01',
      net: '1050.00',
      tax: '220.50',
      gross: '1270.50',
      lines: [
        { rate: '21', net: '1000.00', name: 'Rata de capital' },
        { rate: '21', net: '50.00', name: 'Dobânda' },
      ],
    })
      .replace(
        '</cbc:DocumentCurrencyCode>',
        '</cbc:DocumentCurrencyCode><cbc:TaxCurrencyCode>RON</cbc:TaxCurrencyCode>',
      )
      .replace(
        '<cac:LegalMonetaryTotal>',
        '<cac:TaxTotal><cbc:TaxAmount currencyID="RON">1111.32</cbc:TaxAmount></cac:TaxTotal><cac:LegalMonetaryTotal>',
      );
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
      evidenceId: (await file('LS-EUR-1.xml', xml)).id,
    });
    const split = await s.propose('invoices.recognize', {
      documentId: document.id,
      allocations: [
        { account: '167', vat: 'S-21', amount: '1000.00', lease: lease.id },
        { account: '666', vat: 'S-21', amount: '50.00' },
      ],
    });
    expect(codes(split)).toEqual([]);
    expect(lines(split)).toEqual([
      'D 167 5050.00 [EUR 1000.00]',
      'C 7651 10.00',
      'D 666 252.00 [EUR 50.00]',
      'D 4426 1111.32 [EUR 220.50]',
      'C 404 6403.32 [EUR 1270.50]',
    ]);
    await s.post(await s.approve(split));
    expect(await closing(s, '167')).toEqual({ debit: '0.00', credit: '45450.00' });
  });
});

describe('an operating lease', () => {
  test('is an expense on 612, its VAT half deducted for a car not used only for the business', async () => {
    const { s, invoice } = await company();
    const rent = await invoice({
      number: 'OL-0001',
      date: '2026-04-05',
      net: '1000.00',
      tax: '210.00',
      gross: '1210.00',
    });
    const input = { documentId: rent.id, account: '612', deduction: 'limited' };
    // Naming no car, the reviewer confirms the deduction; naming it, the owner's answer decides.
    const unnamed = await s.propose('invoices.recognize', input);
    const named = { ...input, vehicle: 'B-77-OPL' };
    expect(codes(unnamed)).toEqual(['VEHICLE_UNNAMED']);
    const asking = await s.revise('invoices.recognize', unnamed, named);
    expect(codes(asking)).toEqual(['VEHICLE_USE']);
    const proposal = await s.invoke<ProposalView>(s.owner, 'proposals.revise', {
      proposalId: asking.id,
      version: asking.version,
      input: named,
      basis: await usedPrivately(s, 'B 77 OPL'),
    });
    expect(codes(proposal)).toEqual([]);
    expect(lines(proposal)).toEqual(['D 612 1105.00', 'D 4426 105.00', 'C 401 1210.00']);
    expect(proposal.effect!.taxEntries[0]).toMatchObject({
      amount: '210.00',
      deductible: '105.00',
    });
  });
});
