import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ProposalView } from '../../source/engine/kernel/views';
import type { ActionView } from '../../source/engine/kernel/actions';
import {
  AnafKits,
  DukIntegrator,
  saftKitId,
  type DeclarationValidator,
} from '../../source/engine/adapters/declaration-validator';
import { defaultRegister } from '../../source/engine/engine';
import { ParameterRegister, type ParameterVersion } from 'xfactura-core/rules';
import { parseLocalDate } from 'xfactura-core/time';
import { iban } from './fixtures/bank';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

// A synthetic PFA's 2026, VAT payer. Every expected amount below is computed by hand:
//   bank: 20,000.00 contributed + 60,500.00 (SALE-1: 50,000 + 21%) − 2,420.00 (half of INV-1:
//   4,000 + 840) − 15.00 fee = 78,065.00 at the end of March; − 14,520.00 (laptop: 12,000 +
//   2,520) = 63,545.00 at the end of April.
//   cash: 1,000.00 contributed; − 605.00 fuel (500 + 105, half the VAT deducted) − 200.00 fine
//   = 195.00 at the end of April.
const statement = `:20:PFA032026
:25:${iban}
:28C:001/001
:60F:C260301RON0,00
:61:2603030303C20000,00NTRFAPORT//PFA-IN-01
:86:Aport titular
:61:2603200320C60500,00NTRFSALE-1//PFA-IN-02
:86:Incasare SALE-1
:61:2603250325D2420,00NTRFINV-1//PFA-PAY-01
:86:Plata partiala INV-1
:61:2603310331D15,00NCHGNONREF//PFA-FEE-01
:86:Comision bancar
:61:2604100410D14520,00NTRFLAP-1//PFA-PAY-02
:86:Plata LAP-1
:62F:C260430RON63545,00`;

type Journal = {
  rows: {
    nr: number;
    date: string;
    account: string;
    document: { type: string; number: string | null } | null;
    explanation: string;
    receipts: { cash: string | null; bank: string | null };
    payments: { cash: string | null; bank: string | null };
    currency?: { code: string; amount: string; rate: string };
    natures: { nature: string; amount: string }[];
  }[];
  months: {
    month: string;
    receipts: { cash: string; bank: string };
    payments: { cash: string; bank: string };
  }[];
  accounts: {
    account: string;
    opening: string;
    months: {
      month: string;
      opening: string;
      receipts: string;
      payments: string;
      closing: string;
    }[];
    closing: string;
  }[];
  issues: { code: string }[];
};

const cents = (amount: string) => BigInt(amount.replace('.', ''));

/** A PFA in the real system, VAT payer, keeping single-entry books from 1 January of a year
 * (2026 unless given). */
async function pfa(
  options: {
    year?: number;
    register?: ParameterRegister;
    declarationValidator?: DeclarationValidator;
  } = {},
) {
  const y = options.year ?? 2026;
  const s = await scenario({
    year: y,
    ...(options.register ? { register: options.register } : {}),
    ...(options.declarationValidator ? { declarationValidator: options.declarationValidator } : {}),
  });
  open.push(s);
  const { id: certificate } = await s.evidence('certificat-inregistrare.pdf');
  const fact = (axis: string, value: string) =>
    s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: `${y}-01-01`,
      evidenceId: certificate,
    });
  await fact('entity.form', 'pfa');
  await fact('books.system', 'single');
  await fact('vat.status', 'normal_vat');
  await fact('cas.status', 'liable');
  await fact('cass.exception', 'none');
  const source = await s.invoke<{ sourceId: string }>(s.owner, 'pfa.sources.record', {
    effectiveFrom: `${y}-01-01`,
    name: 'Activități de realizare a software-ului la comandă',
    caen: '6201',
    place: 'Str. Exemplu nr. 1, Cluj-Napoca',
    county: 'CJ',
    authorization: { number: `F12/345/${y}`, date: `${y - 1}-12-20` },
    startedOn: `${y}-01-01`,
    liberal: false,
    method: 'sistem_real',
    realBasis: 'required',
    evidenceId: certificate,
  });
  const document = async (input: XmlInput) => {
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: `${input.number}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(invoiceXml(input)).toString('base64'),
    });
    return s.invoke<{ id: string; partyId: string }>(s.owner, 'invoices.import', {
      evidenceId: id,
    });
  };
  const person = (kind: string, name: string) =>
    s.invoke<{ id: string }>(s.owner, 'parties.create', { kind, country: 'RO', name });
  return { s, certificate, source, document, person };
}

/** The year's operations: invoices issued and received, bank and cash receipts and payments, a
 * fixed asset, a non-deductible fine and a vehicle at 50%. */
async function year() {
  const context = await pfa();
  const { s, document, person } = context;
  const owner = await person('ro_individual', 'Popescu Ion (titular)');
  const town = await person('ro_public_institution', 'Primăria Cluj-Napoca');
  await s.invoke(s.owner, 'accounts.create', {
    code: '6022.VEH50',
    name: 'Combustibil autoturism folosit și în scop personal',
    validFrom: '2026-01-01',
  });
  const sale = await document({
    number: 'SALE-1',
    direction: 'sale',
    date: '2026-03-10',
    net: '50000.00',
    tax: '10500.00',
    gross: '60500.00',
  });
  const services = await document({
    number: 'INV-1',
    date: '2026-03-12',
    net: '4000.00',
    tax: '840.00',
    gross: '4840.00',
  });
  const laptop = await document({
    number: 'LAP-1',
    date: '2026-04-01',
    net: '12000.00',
    tax: '2520.00',
    gross: '14520.00',
  });
  const fuel = await document({
    number: 'FUEL-1',
    date: '2026-04-18',
    net: '500.00',
    tax: '105.00',
    gross: '605.00',
  });
  const item = (proposal: ProposalView) => proposal.effect!.openItems[0]!.id;
  const receivable = item(
    await s.book('invoices.recognize', { documentId: sale.id, account: '704' }),
  );
  const payable = item(
    await s.book('invoices.recognize', { documentId: services.id, account: '628' }),
  );
  const assetPayable = item(
    await s.book('invoices.recognize', { documentId: laptop.id, account: '2131' }),
  );
  const fuelPayable = item(
    await s.book('invoices.recognize', {
      documentId: fuel.id,
      account: '6022.VEH50',
      deduction: 'limited',
    }),
  );
  await s.invoke(s.owner, 'assets.register', {
    number: 'MF-1',
    name: 'Laptop',
    catalogCode: '2.2.9',
    account: '2131',
    depreciationAccount: '2813',
    value: '12000.00',
    lifeMonths: 36,
    fiscalLifeMonths: 36,
    commissionedOn: '2026-04-01',
    documentId: laptop.id,
    evidenceId: (await s.evidence('pv-punere-in-functiune.pdf')).id,
  });

  await s.invoke(s.owner, 'treasury.createAccount', {
    kind: 'bank',
    name: 'Cont curent',
    iban,
    currency: 'RON',
    ledgerAccount: '5121',
    openedOn: '2026-01-01',
  });
  const { id: extract } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
    filename: 'extras-martie-aprilie.sta',
    mediaType: 'text/plain',
    base64: Buffer.from(statement).toString('base64'),
  });
  await s.invoke(s.owner, 'bank.import', { evidenceId: extract, financialYearId: s.year.id });
  const movements = await s.invoke<{ id: string; amount: string }[]>(s.owner, 'bank.movements', {});
  const movement = (amount: string) =>
    movements.find((item) => item.amount.replace('-', '') === amount)!.id;
  const cash = async (input: Record<string, unknown>) =>
    s.book('cash.record', {
      account: '5311',
      evidenceId: (await s.evidence(`${String(input.number)}.pdf`)).id,
      ...input,
    });

  await cash({
    date: '2026-03-02',
    direction: 'receipt',
    number: 'C-1',
    partyId: owner.id,
    opens: [{ account: '4551', amount: '1000.00' }],
  });
  await s.book('bank.settle', {
    movementId: movement('20000.00'),
    opens: [{ account: '4551', partyId: owner.id, amount: '20000.00' }],
  });
  await s.book('bank.settle', {
    movementId: movement('60500.00'),
    allocations: [{ openItem: receivable, amount: '60500.00' }],
  });
  await s.book('bank.settle', {
    movementId: movement('2420.00'),
    allocations: [{ openItem: payable, amount: '2420.00' }],
  });
  await s.book('bank.settle', {
    movementId: movement('15.00'),
    lines: [{ account: '627', amount: '15.00' }],
  });
  await s.book('bank.settle', {
    movementId: movement('14520.00'),
    allocations: [{ openItem: assetPayable, amount: '14520.00' }],
  });
  await cash({
    date: '2026-04-20',
    direction: 'payment',
    number: 'DP-1',
    partyId: sale.partyId,
    allocations: [{ openItem: fuelPayable, amount: '605.00' }],
  });
  await cash({
    date: '2026-04-22',
    direction: 'payment',
    number: 'DP-2',
    partyId: town.id,
    lines: [{ account: '6581', amount: '200.00', memo: 'Amendă' }],
  });
  return { ...context, owner };
}

describe('PFA profile and income sources', () => {
  test('the form decides the books and the axes that apply', async () => {
    const { s, certificate } = await pfa();
    const record = (axis: string, value: string, effectiveFrom = '2026-01-01') =>
      s.refused(
        s.invoke(s.owner, 'profile.record', {
          axis,
          value,
          effectiveFrom,
          evidenceId: certificate,
        }),
      );
    // Whether a PFA may keep double entry is open: refused until the expert answers.
    expect((await record('books.system', 'double'))?.code).toBe('BOOKS_SYSTEM_FORM');
    expect((await record('income_tax', 'micro'))?.code).toBe('PROFILE_FORM');
    expect((await record('entity.form', 'srl', '2027-01-01'))?.code).toBe('ENTITY_FORM_CHANGE');
    // A change of form while the activity continues (art. 68 alin. (7^1)) is allowed.
    expect(await record('entity.form', 'ii', '2027-01-01')).toBeUndefined();

    const srl = await scenario();
    open.push(srl);
    const { id } = await srl.evidence('act-constitutiv.pdf');
    expect(
      (
        await srl.refused(
          srl.invoke(srl.owner, 'profile.record', {
            axis: 'books.system',
            value: 'single',
            effectiveFrom: '2026-01-01',
            evidenceId: id,
          }),
        )
      )?.code,
    ).toBe('BOOKS_SYSTEM_FORM');
    expect(
      (
        await srl.refused(
          srl.invoke(srl.owner, 'pfa.sources.record', {
            effectiveFrom: '2026-01-01',
            name: 'Comerț',
            caen: '4791',
            place: 'București',
            county: 'B',
            startedOn: '2026-01-01',
            liberal: false,
            method: 'sistem_real',
            realBasis: 'required',
            evidenceId: id,
          }),
        )
      )?.code,
    ).toBe('INCOME_SOURCE_FORM');
  });

  test('a norm moves to the real system by option from 1 January and keeps it 2 years', async () => {
    const { s, certificate } = await pfa();
    const base = {
      name: 'Croitorie',
      caen: '1413',
      place: 'Str. Exemplu nr. 2, Iași',
      county: 'IS',
      startedOn: '2025-03-01',
      liberal: false,
      evidenceId: certificate,
    };
    const version = (input: Record<string, unknown>) =>
      s.invoke<{ sourceId: string; seq: number }>(s.owner, 'pfa.sources.record', {
        ...base,
        ...input,
      });
    // The company is a PFA from 2026 in these books; the source started earlier.
    expect((await s.refused(version({ effectiveFrom: '2025-03-01', method: 'norma' })))?.code).toBe(
      'INCOME_SOURCE_FORM',
    );
    const first = await version({
      startedOn: '2026-02-01',
      effectiveFrom: '2026-02-01',
      method: 'norma',
    });
    const next = (input: Record<string, unknown>) =>
      s.refused(version({ ...input, startedOn: '2026-02-01', sourceId: first.sourceId }));
    expect(
      (await next({ effectiveFrom: '2026-06-01', method: 'sistem_real', realBasis: 'option' }))
        ?.code,
    ).toBe('INCOME_SOURCE_METHOD_DATE');
    expect(
      await next({ effectiveFrom: '2027-01-01', method: 'sistem_real', realBasis: 'option' }),
    ).toBeUndefined();
    // 2027 and 2028 are the option's period; 2029 starts its tacit renewal.
    expect((await next({ effectiveFrom: '2028-01-01', method: 'norma' }))?.code).toBe(
      'INCOME_SOURCE_OPTION_LOCK',
    );
    expect((await next({ effectiveFrom: '2030-01-01', method: 'norma' }))?.code).toBe(
      'INCOME_SOURCE_OPTION_LOCK',
    );
    expect(await next({ effectiveFrom: '2029-01-01', method: 'norma' })).toBeUndefined();
    const sources = await s.invoke<{ sourceId: string; versions: { method: string }[] }[]>(
      s.owner,
      'pfa.sources.list',
    );
    expect(
      sources.find((item) => item.sourceId === first.sourceId)?.versions.map((item) => item.method),
    ).toEqual(['norma', 'sistem_real', 'norma']);
  });

  test('every PFA parameter is listed with its clauses; none is reviewed', async () => {
    const { s } = await pfa();
    const parameters = await s.invoke<
      { id: string; status: string; citations: { clause: string; status: string }[] }[]
    >(s.viewer, 'rules.parameters');
    const pit = parameters.filter(
      (item) => /^ro\.(pit|cas|cass|min_wage)\./.test(item.id) || item.id.includes('/single/'),
    );
    expect(pit.map((item) => item.id).sort()).toEqual([
      'ro.cas.independent/2025-01-01',
      'ro.cas.independent/2026-01-01',
      'ro.cas.rate/2025-01-01',
      'ro.cas.rate/2026-01-01',
      'ro.cass.independent/2025-01-01',
      'ro.cass.independent/2026-01-01',
      'ro.cass.option/2025-01-01',
      'ro.cass.option/2026-01-01',
      'ro.cass.rate/2025-01-01',
      'ro.cass.rate/2026-01-01',
      'ro.fx.rate_date.accounting/single/2024-01-01',
      'ro.min_wage.contributions/2025-01-01',
      'ro.min_wage.contributions/2026-01-01',
      'ro.pit.limits/2025-01-01',
      'ro.pit.limits/2026-01-01',
      'ro.pit.loss/2025-01-01',
      'ro.pit.loss/2026-01-01',
      'ro.pit.natures/2025-01-01',
      'ro.pit.natures/2026-01-01',
      'ro.pit.norma/2026-01-01',
      'ro.pit.rate/2025-01-01',
      'ro.pit.rate/2026-01-01',
      'ro.pit.rounding/2025-01-01',
      'ro.pit.rounding/2026-01-01',
    ]);
    for (const item of pit) {
      expect(item.status).toBe('extracted');
      expect(item.citations.some((citation) => citation.status === 'located')).toBe(true);
    }
  });

  test('the treatments of a company’s double-entry books are refused, and so is S1005', async () => {
    const { s, certificate } = await pfa();
    const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);
    expect(codes(await s.propose('fx.revalue', { date: '2026-03-31' }))).toContain(
      'SINGLE_ENTRY_EXCLUDED',
    );
    expect(
      codes(
        await s.propose('year.closeResult', { yearEnd: '2026-12-31', evidenceId: certificate }),
      ),
    ).toContain('SINGLE_ENTRY_EXCLUDED');
    const authority = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_public_institution',
      country: 'RO',
      name: 'ANAF',
    });
    expect(
      codes(
        await s.propose('tax.micro', {
          quarter: '2026-Q1',
          date: '2026-03-31',
          authorityId: authority.id,
        }),
      ),
    ).toContain('SINGLE_ENTRY_EXCLUDED');
    // S1005 for 2025 (the year whose format is pinned), of a PFA since 2025.
    const earlier = await scenario({ year: 2025 });
    open.push(earlier);
    await earlier.invoke(earlier.owner, 'profile.record', {
      axis: 'entity.form',
      value: 'pfa',
      effectiveFrom: '2025-01-01',
      evidenceId: (await earlier.evidence('certificat.pdf')).id,
    });
    const statements = await earlier.refused(
      earlier.invoke(earlier.owner, 'declarations.prepare', {
        kind: 'S1005',
        period: '2025',
        options: {
          entity: {
            tradeRegister: 'F12/345/2026',
            ownership: 35,
            caen: '6201',
            caenActual: '6201',
            caenVersion: 2025,
            largeTaxpayer: false,
            branch: false,
            economicInterestGroup: false,
            netAssetsBelowHalfCapital: false,
            phone: '0264000000',
          },
          administrator: 'Popescu Ion',
          preparer: { name: 'Ionescu Maria', quality: 22, membership: '12345', cif: '14399840' },
          approved: true,
        },
      }),
    );
    expect(statements?.code).toBe('SINGLE_ENTRY_EXCLUDED');
    const calendar = await s.invoke<{ kind: string }[]>(s.owner, 'obligations.calendar', {
      from: '2026-12',
      to: '2026-12',
      today: '2026-12-31',
    });
    expect(calendar.map((item) => item.kind)).not.toContain('S1005');
  });
});

describe('PFA registers as projections of the ledger', () => {
  test('Registrul-jurnal de încasări și plăți: natures, monthly totals, each account’s change', async () => {
    const { s } = await year();
    const register = await s.invoke<Journal>(s.owner, 'pfa.journal', { year: 2026 });
    expect(register.issues).toEqual([]);
    const natures = (row: Journal['rows'][number]) =>
      row.natures.map((nature) => `${nature.nature} ${nature.amount}`);
    expect(
      register.rows.map((row) => [
        row.nr,
        row.date,
        row.document?.number,
        row.receipts.cash ?? row.receipts.bank ?? `-${row.payments.cash ?? row.payments.bank}`,
        natures(row),
      ]),
    ).toEqual([
      [1, '2026-03-02', 'C-1', '1000.00', ['excluded.contribution 1000.00']],
      [2, '2026-03-03', 'Aport titular', '20000.00', ['excluded.contribution 20000.00']],
      [
        3,
        '2026-03-20',
        'Incasare SALE-1',
        '60500.00',
        ['income.activity 50000.00', 'vat 10500.00'],
      ],
      [
        4,
        '2026-03-25',
        'Plata partiala INV-1',
        '-2420.00',
        ['expense.full -2000.00', 'vat -420.00'],
      ],
      [5, '2026-03-31', 'Comision bancar', '-15.00', ['expense.full -15.00']],
      [
        6,
        '2026-04-10',
        'Plata LAP-1',
        '-14520.00',
        ['asset.acquisition -12000.00', 'vat -2520.00'],
      ],
      [7, '2026-04-20', 'DP-1', '-605.00', ['expense.vehicle -552.50', 'vat -52.50']],
      [8, '2026-04-22', 'DP-2', '-200.00', ['excluded.fines -200.00']],
    ]);
    expect(register.rows[2]?.explanation).toContain(
      'venituri din activitate 50000.00; tva 10500.00',
    );
    expect(register.rows[6]?.explanation).toContain(
      'cheltuieli cu vehicule neutilizate exclusiv în activitate 552.50; tva 52.50',
    );
    expect(register.months).toEqual([
      {
        month: '2026-03',
        receipts: { cash: '1000.00', bank: '80500.00' },
        payments: { cash: '0.00', bank: '2435.00' },
      },
      {
        month: '2026-04',
        receipts: { cash: '0.00', bank: '0.00' },
        payments: { cash: '805.00', bank: '14520.00' },
      },
    ]);
    // P1 exit test: for each treasury account and month, receipts less payments are the change
    // of the account, and the closing balance is the ledger's.
    for (const account of register.accounts)
      for (const month of account.months) {
        expect(cents(month.receipts) - cents(month.payments)).toBe(
          cents(month.closing) - cents(month.opening),
        );
        const balance = await s.trialBalance(
          '2026-01-01',
          `${month.month}-${month.month.endsWith('04') ? '30' : '31'}`,
        );
        const row = balance.rows.find((item) => item.account === account.account)!;
        expect(cents(row.closing.debit) - cents(row.closing.credit)).toBe(cents(month.closing));
      }
    expect(register.accounts.map((account) => [account.account, account.closing])).toEqual([
      ['5121', '63545.00'],
      ['5311', '195.00'],
    ]);
    // Every row's natures add up to its amount.
    for (const row of register.rows)
      expect(row.natures.reduce((sum, nature) => sum + cents(nature.amount), 0n)).toBe(
        row.receipts.cash || row.receipts.bank
          ? cents(row.receipts.cash ?? row.receipts.bank!)
          : -cents(row.payments.cash ?? row.payments.bank!),
      );
  });

  test('a treasury line without a nature is reported and stops the month’s close', async () => {
    const { s } = await year();
    await s.book(
      'ledger.general',
      journal(
        (await s.evidence('nota-473.pdf')).id,
        [
          { account: '473', side: 'D', amount: '10.00' },
          { account: '5311', side: 'C', amount: '10.00' },
        ],
        { date: '2026-05-04' },
      ),
    );
    const register = await s.invoke<Journal>(s.owner, 'pfa.journal', {
      year: 2026,
      month: '2026-05',
    });
    expect(register.rows.map((row) => row.natures.map((nature) => nature.nature))).toEqual([
      ['unclassified'],
    ]);
    expect(register.issues.map((issue) => issue.code)).toEqual(['PFA_NATURE_MISSING']);
    const close = await s.close('2026-05');
    expect(JSON.stringify(close.preview)).toContain('PFA_NATURE_MISSING');
  });

  test('Registrul-inventar at the year’s end and at the start of activity', async () => {
    const { s } = await year();
    const inventory = await s.invoke<{
      date: string;
      sections: { title: string; rows: { nr: number; description: string; value: string }[] }[];
      totals: { assets: string; liabilities: string };
      issues: unknown[];
    }>(s.owner, 'pfa.inventory', { occasion: 'year_end', year: 2026 });
    expect(inventory.date).toBe('2026-12-31');
    expect(inventory.issues).toEqual([]);
    expect(
      inventory.sections.map((section) => [
        section.title,
        section.rows.map((row) => `${row.nr} ${row.description}: ${row.value}`),
      ]),
    ).toEqual([
      ['Imobilizări', ['1 MF-1 Laptop: 12000.00']],
      ['Stocuri', []],
      ['Creanțe', ['2 4426 TVA deductibilă: 3412.50']],
      [
        'Disponibilități',
        ['3 5121 Conturi la bănci în lei: 63545.00', '4 5311 Casa în lei: 195.00'],
      ],
      ['Datorii', ['5 401 Companie 87654321: 2420.00', '6 4427 TVA colectată: 10500.00']],
    ]);
    expect(inventory.totals).toEqual({ assets: '79152.50', liabilities: '12920.00' });
    const start = await s.invoke<{ date: string; sections: { rows: unknown[] }[] }>(
      s.owner,
      'pfa.inventory',
      { occasion: 'start' },
    );
    expect(start.date).toBe('2026-01-01');
    expect(start.sections.flatMap((section) => section.rows)).toEqual([]);
    expect(
      (await s.refused(s.invoke(s.owner, 'pfa.inventory', { occasion: 'cessation' })))?.code,
    ).toBe('CESSATION');
  });

  test('Registrul de evidență fiscală: art. 68 limits, fiscal depreciation, CASS, the tax', async () => {
    const { s } = await year();
    const register = await s.invoke<{
      final: boolean;
      sources: {
        register: { rows: { nr: string; element: string; value: string }[] };
        excluded: { nature: string; label: string; amount: string }[];
        totals: { gross: string; deductible: string; net: string; loss: string };
      }[];
      contributions: {
        cumulated: string;
        cas: { due: string; deductible: string };
        cass: { base: string; due: string; deductible: string };
      };
      tax: { recalculated: string; taxable: string; real: string; total: string };
      issues: { code: string }[];
      parameters: string[];
    }>(s.owner, 'pfa.fiscalRegister', { year: 2026 });
    expect(register.issues).toEqual([]);
    expect(register.final).toBe(true);
    const [source] = register.sources;
    // Deductible: 2,000 services + 15 fee + 276.25 (half of 552.50 fuel with its VAT kept) +
    // 2,666.67 fiscal depreciation (12,000 over 36 months, May to December) = 4,957.92 → 4,958.
    expect(source!.register.rows.map((row) => `${row.nr} ${row.value}`)).toEqual([
      '1 50000.00',
      '1.1 50000.00',
      '2 4958.00',
      '2.1 2015.00',
      '2.2 276.25',
      '2.3 2666.67',
      '3 45042.00',
    ]);
    expect(source!.excluded).toEqual([
      { nature: 'excluded.contribution', label: 'Aporturi ale titularului', amount: '21000.00' },
      {
        nature: 'asset.acquisition',
        label: 'Achiziții de bunuri amortizabile din Registrul-inventar',
        amount: '12000.00',
      },
      {
        nature: 'excluded.fines',
        label: 'Amenzi, penalități și majorări de întârziere',
        amount: '200.00',
      },
    ]);
    // 45,042 lei is under 12 minimum wages (48,600 lei): no CAS. CASS 10%, all deducted.
    expect(register.contributions).toMatchObject({
      cumulated: '45042.00',
      cas: { due: '0.00', deductible: '0.00' },
      cass: { base: '45042.00', due: '4504.00', deductible: '4504.00' },
    });
    expect(register.tax).toMatchObject({
      recalculated: '45042.00',
      taxable: '40538.00',
      real: '4054.00',
      total: '4054.00',
    });
    expect(register.parameters).toEqual(
      expect.arrayContaining([
        'ro.pit.rate/2026-01-01',
        'ro.min_wage.contributions/2026-01-01',
        'ro.cass.independent/2026-01-01',
      ]),
    );
    // 2027 has no minimum wage in the register yet: the year is not computed.
    expect((await s.refused(s.invoke(s.owner, 'pfa.fiscalRegister', { year: 2027 })))?.code).toBe(
      'RULE_GAP',
    );
  });
});

describe('PFA foreign currency', () => {
  // Synthetic BNR rates. A PFA books at the rate of the last banking day before the operation
  // (OMFP nr. 170/2015 cap. III pct. 18): the sale of 10 March at 4.9700 (9 March), 1,000.00 EUR
  // = 4,970.00 lei, VAT as the invoice states it, 1,045.07 lei (210.00 × 4.9765 on the tax
  // point); the receipt of 15 April at 4.9900 (14 April): 1,210.00 EUR = 6,037.90 lei against
  // 6,015.07 carried, 22.83 lei realized. Income on a cash basis: 6,037.90 − 1,045.07 = 4,992.83.
  const bnr = `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Header><Publisher>National Bank of Romania</Publisher><PublishingDate>2026-04-15</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
<Cube date="2026-03-09"><Rate currency="EUR">4.9700</Rate></Cube>
<Cube date="2026-03-10"><Rate currency="EUR">4.9765</Rate></Cube>
<Cube date="2026-04-14"><Rate currency="EUR">4.9900</Rate></Cube>
<Cube date="2026-04-15"><Rate currency="EUR">5.0000</Rate></Cube>
</Body></DataSet>`;
  const eurIban = 'RO13BBBB1B31007593840001';

  test('receipts in lei at the previous banking day’s rate, the difference folded into income', async () => {
    const { s } = await pfa();
    const file = async (filename: string, text: string) =>
      s.invoke<{ id: string }>(s.owner, 'evidence.record', {
        filename,
        mediaType: 'application/xml',
        base64: Buffer.from(text).toString('base64'),
      });
    await s.invoke(s.owner, 'fx.importBnr', { evidenceId: (await file('bnr.xml', bnr)).id });
    const xml = invoiceXml({
      direction: 'sale',
      currency: 'EUR',
      number: 'EXP-1',
      date: '2026-03-10',
      net: '1000.00',
      tax: '210.00',
      gross: '1210.00',
    })
      .replace(
        '</cbc:DocumentCurrencyCode>',
        '</cbc:DocumentCurrencyCode><cbc:TaxCurrencyCode>RON</cbc:TaxCurrencyCode>',
      )
      .replace(
        '<cac:LegalMonetaryTotal>',
        '<cac:TaxTotal><cbc:TaxAmount currencyID="RON">1045.07</cbc:TaxAmount></cac:TaxTotal><cac:LegalMonetaryTotal>',
      );
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
      evidenceId: (await file('EXP-1.xml', xml)).id,
    });
    const recognized = await s.book('invoices.recognize', {
      documentId: document.id,
      account: '704',
    });
    expect(
      recognized.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`),
    ).toEqual(['D 4111 6015.07', 'C 704 4970.00', 'C 4427 1045.07']);
    expect(recognized.rules.used.map((rule) => rule.id)).toContain(
      'ro.fx.rate_date.accounting/single/2024-01-01',
    );
    await s.invoke(s.owner, 'treasury.createAccount', {
      kind: 'bank',
      name: 'Cont EUR',
      iban: eurIban,
      currency: 'EUR',
      ledgerAccount: '5124',
      openedOn: '2026-01-01',
    });
    const extract = `:20:EUR042026
:25:${eurIban}
:28C:001/001
:60F:C260401EUR0,00
:61:2604150415C1210,00NTRFEXP-1//EUR-IN-01
:86:Incasare EXP-1
:62F:C260430EUR1210,00`;
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'extras-eur.sta',
      mediaType: 'text/plain',
      base64: Buffer.from(extract).toString('base64'),
    });
    await s.invoke(s.owner, 'bank.import', { evidenceId: id, financialYearId: s.year.id });
    const [movement] = await s.invoke<{ id: string }[]>(s.owner, 'bank.movements', {});
    const settled = await s.book('bank.settle', {
      movementId: movement!.id,
      allocations: [{ openItem: recognized.effect!.openItems[0]!.id, amount: '1210.00' }],
    });
    expect(
      settled.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`),
    ).toEqual(['D 5124 6037.90', 'C 4111 6015.07', 'C 7651 22.83']);
    const register = await s.invoke<Journal>(s.owner, 'pfa.journal', { year: 2026 });
    expect(register.rows).toHaveLength(1);
    expect(register.rows[0]).toMatchObject({
      receipts: { cash: null, bank: '6037.90' },
      currency: { code: 'EUR', amount: '1210.00', rate: '4.9900' },
    });
    expect(register.rows[0]!.natures.map((nature) => `${nature.nature} ${nature.amount}`)).toEqual([
      'income.activity 4992.83',
      'vat 1045.07',
    ]);
    expect(register.rows[0]!.explanation).toContain('1210.00 EUR la cursul 4.9900');
  });
});

describe('D212 from the books', () => {
  // ANAF's D212 validator (J13.0.1) runs on the SAF-T kit only; without it or Java the official
  // test is skipped, never passed.
  const saftDist = path.join(
    import.meta.dir,
    '../../../..',
    '.validators/anaf-saft/duk_SAFT_an_luna/dist',
  );
  const official =
    existsSync(path.join(saftDist, 'lib/D212Validator.jar')) && Bun.which('java')
      ? test
      : test.skip;
  const kits = () => new AnafKits({ saft: new DukIntegrator(saftDist, saftKitId) });
  /** A validator that must not be called. */
  const unused: DeclarationValidator = {
    id: 'unused',
    validate: () => Promise.reject(new Error('validated')),
    pdf: () => Promise.reject(new Error('validated')),
  };

  /**
   * The engine's register has no PIT values for 2024 or 2025 (§7.1): these test fixtures, marked
   * as such, give the year the 2026 rules with the minimum wage and CASS cap the D212 structure
   * for 2024 states (3,300 lei; 60 wages). They are test data, not sourced values.
   */
  function fixtures(year: number) {
    const base = defaultRegister();
    const current = (key: string) =>
      base.versions.find((version) => version.key === key && version.from === '2026-01-01')!.value;
    const values: Record<string, ParameterVersion['value']> = {
      'ro.pit.rate': current('ro.pit.rate'),
      'ro.pit.rounding': current('ro.pit.rounding'),
      'ro.pit.loss': current('ro.pit.loss'),
      'ro.pit.limits': current('ro.pit.limits'),
      'ro.pit.norma': current('ro.pit.norma'),
      'ro.pit.natures': current('ro.pit.natures'),
      'ro.cas.rate': current('ro.cas.rate'),
      'ro.cas.independent': current('ro.cas.independent'),
      'ro.cass.rate': current('ro.cass.rate'),
      ...(year === 2024
        ? {
            'ro.min_wage.contributions': '3300',
            'ro.cass.independent': { minimumWages: 6, maximumWages: 60 },
          }
        : {}),
    };
    const version = (key: string, value: ParameterVersion['value'], at: number) => ({
      id: `test-fixture:${key}/${at}`,
      key,
      scope: {},
      value,
      from: parseLocalDate(`${at}-01-01`),
      to: parseLocalDate(`${at}-12-31`),
      reviewedThrough: null,
      knowledgeDate: null,
      status: 'extracted' as const,
      clauses: ['test fixture, not a legal value'],
    });
    // Only what the engine's register lacks for the year: its own versions are kept.
    const has = (key: string, at: number) =>
      base.versions.some(
        (item) =>
          item.key === key && item.from <= `${at}-01-01` && (item.to ?? '9999') >= `${at}-01-01`,
      );
    const added = [
      ...Object.entries(values)
        .filter(([key]) => !has(key, year))
        .map(([key, value]) => version(key, value, year)),
      // Chapter II of the 2024 return is the option for 2025: its CASS rate.
      ...(year === 2024 && !has('ro.cass.rate', 2025)
        ? [version('ro.cass.rate', current('ro.cass.rate'), 2025)]
        : []),
    ];
    const keys = [...new Set(base.versions.map((item) => item.key))];
    return new ParameterRegister(
      keys.map((key) => base.definition(key)),
      [...base.versions, ...added],
    );
  }

  /**
   * A year of a VAT-paying PFA, every amount by hand: SALE-1 50,000 + 19% collected, INV-1
   * 4,000 + 19% paid, a 12.00 fee: net income 50,000 − 4,012 = 45,988 lei.
   */
  async function books(
    y: number,
    options: { register?: ParameterRegister; declarationValidator?: DeclarationValidator } = {},
  ) {
    const context = await pfa({ year: y, ...options });
    const { s, document, person } = context;
    const holder = await person('ro_individual', 'Popescu Ion (titular)');
    await s.invoke(s.owner, 'parties.recordCnp', { partyId: holder.id, cnp: '1781105170030' });
    const yy = String(y).slice(2);
    const statement = `:20:PFA03${yy}
:25:${iban}
:28C:001/001
:60F:C${yy}0301RON0,00
:61:${yy}03030303C1000,00NTRFAPORT//PFA-IN-01
:86:Aport titular
:61:${yy}03200320C59500,00NTRFSALE-1//PFA-IN-02
:86:Incasare SALE-1
:61:${yy}03250325D4760,00NTRFINV-1//PFA-PAY-01
:86:Plata INV-1
:61:${yy}03310331D12,00NCHGNONREF//PFA-FEE-01
:86:Comision bancar
:62F:C${yy}0331RON55728,00`;
    const item = (proposal: ProposalView) => proposal.effect!.openItems[0]!.id;
    const sale = await document({
      number: 'SALE-1',
      direction: 'sale',
      date: `${y}-03-10`,
      rate: '19',
      net: '50000.00',
      tax: '9500.00',
      gross: '59500.00',
    });
    const services = await document({
      number: 'INV-1',
      date: `${y}-03-12`,
      rate: '19',
      net: '4000.00',
      tax: '760.00',
      gross: '4760.00',
    });
    const receivable = item(
      await s.book('invoices.recognize', { documentId: sale.id, account: '704' }),
    );
    const payable = item(
      await s.book('invoices.recognize', { documentId: services.id, account: '628' }),
    );
    await s.invoke(s.owner, 'treasury.createAccount', {
      kind: 'bank',
      name: 'Cont curent',
      iban,
      currency: 'RON',
      ledgerAccount: '5121',
      openedOn: `${y}-01-01`,
    });
    const { id: extract } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: `extras-${y}.sta`,
      mediaType: 'text/plain',
      base64: Buffer.from(statement).toString('base64'),
    });
    await s.invoke(s.owner, 'bank.import', { evidenceId: extract, financialYearId: s.year.id });
    const movements = await s.invoke<{ id: string; amount: string }[]>(
      s.owner,
      'bank.movements',
      {},
    );
    const movement = (amount: string) =>
      movements.find((entry) => entry.amount.replace('-', '') === amount)!.id;
    await s.book('bank.settle', {
      movementId: movement('1000.00'),
      opens: [{ account: '4551', partyId: holder.id, amount: '1000.00' }],
    });
    await s.book('bank.settle', {
      movementId: movement('59500.00'),
      allocations: [{ openItem: receivable, amount: '59500.00' }],
    });
    await s.book('bank.settle', {
      movementId: movement('4760.00'),
      allocations: [{ openItem: payable, amount: '4760.00' }],
    });
    await s.book('bank.settle', {
      movementId: movement('12.00'),
      lines: [{ account: '627', amount: '12.00' }],
    });
    const options212 = {
      holderPartyId: holder.id,
      taxpayer: {
        lastName: 'Popescu',
        initial: 'M',
        firstName: 'Ion',
        address: 'Str. Exemplu nr. 1, Cluj-Napoca, jud. Cluj',
        email: 'ion.popescu@example.test',
      },
      iban: 'RO49AAAA1B31007593840000',
    };
    return { ...context, holder, options212 };
  }

  type Artifact = {
    id: string;
    format: string;
    state: string;
    xmlHash: string;
    steps: { state: string; actor: string | null; detail: string | null }[];
  };
  const prepare = (s: Scenario, period: string, options: Record<string, unknown>) =>
    s.invoke<Artifact>(s.owner, 'declarations.prepare', { kind: 'D212', period, options });
  const xmlOf = async (s: Scenario, artifact: Artifact) =>
    new TextDecoder().decode(await s.objects.get(s.company.id, artifact.xmlHash));
  const attribute = (xml: string, name: string) =>
    new RegExp(`\\s${name}="([^"]*)"`).exec(xml)?.[1];

  official(
    'income of 2024: from the fiscal register to ANAF’s validator; a change to the books makes it stale',
    async () => {
      const { s, options212 } = await books(2024, {
        register: fixtures(2024),
        declarationValidator: kits(),
      });
      const register = await s.invoke<{ final: boolean; tax: { real: string } }>(
        s.owner,
        'pfa.fiscalRegister',
        { year: 2024 },
      );
      expect(register).toMatchObject({ final: true, tax: { real: '3149.00' } });
      const prepared = await prepare(s, '2024', options212);
      expect(prepared.format).toBe(
        'D212 mfp:anaf:dgti:d212:declaratie:v11 an_r 2025 (D212_A1.0.3, 01.08.2025)',
      );
      expect(prepared.steps.map((step) => [step.state, step.actor])).toEqual([
        ['prepared', null],
        ['validated_official', saftKitId],
      ]);
      // 45,988 lei: CAS on 12 × 3,300 = 39,600 lei (9,900), CASS 4,599, taxable 31,489, tax 3,149.
      const xml = await xmlOf(s, prepared);
      expect(
        Object.fromEntries(
          [
            'an_r',
            'cif',
            'totalPlata_A',
            'venit_brut',
            'chelt_deduc',
            'venit_net_anual',
            'data_incep',
            'cas_baza',
            'cas_datorat',
            'baza_cass_datorat_ai',
            'cass_datorat_ai',
            'real_venit_net_impozabil_ai',
            'real_impozit_datorat_ai',
            'dif_de_plata',
            'cont_bancar',
          ].map((name) => [name, attribute(xml, name)]),
        ),
      ).toEqual({
        an_r: '2025',
        cif: '1781105170030',
        totalPlata_A: '34',
        venit_brut: '50000',
        chelt_deduc: '4012',
        venit_net_anual: '45988',
        data_incep: '01.01.2024',
        cas_baza: '39600',
        cas_datorat: '9900',
        baza_cass_datorat_ai: '45988',
        cass_datorat_ai: '4599',
        real_venit_net_impozabil_ai: '31489',
        real_impozit_datorat_ai: '3149',
        dif_de_plata: '17648',
        cont_bancar: 'RO49AAAA1B31007593840000',
      });
      // The CNP is in the XML only: not in the steps or the summary.
      expect(JSON.stringify(prepared.steps)).not.toContain('1781105170030');
      expect(JSON.parse(prepared.steps[0]!.detail!)).toMatchObject({
        anR: 2025,
        validator: 'D212Validator J13.0.1',
        tax: '3149.00',
        cas: '9900.00',
        cass: '4599.00',
      });
      // A late bank fee in 2024 changes the books the return was computed from.
      await s.book(
        'ledger.general',
        journal(
          (await s.evidence('nota-comision.pdf')).id,
          [
            { account: '627', side: 'D', amount: '5.00' },
            { account: '5121', side: 'C', amount: '5.00' },
          ],
          { date: '2024-12-30' },
        ),
      );
      const request = await s.invoke<ActionView>(s.owner, 'declarations.authorize.request', {
        artifactId: prepared.id,
      });
      expect(
        (request.preview as { findings: { code: string }[] }).findings.map((item) => item.code),
      ).toEqual(['STALE']);
    },
    180_000,
  );

  test('income of 2025: the web form’s structure, prepared, never officially validated', async () => {
    // The engine's own register: the 2025 values from the instructions of OPANAF 2736/2025.
    const { s, options212 } = await books(2025, { declarationValidator: unused });
    // 45,988 lei is under 12 × 4,050 = 48,600 lei: no CAS. CASS 4,599, taxable 41,389, tax 4,139.
    const prepared = await prepare(s, '2025', options212);
    expect(prepared.format).toBe(
      'D212 mfp:anaf:dgti:d212:declaratie:v11 an_r 2026 (formularul web V-1.8.10 / 15.05.2026)',
    );
    expect(prepared.state).toBe('prepared');
    const xml = await xmlOf(s, prepared);
    expect(
      Object.fromEntries(
        [
          'an_r',
          'bifa131',
          'bifa132',
          'nume_c',
          'initiala_c',
          'prenume_c',
          'den_venit',
          'cass_anuala_ai',
          'real_venit_net_impozabil_ai',
          'real_impozit_datorat_ai',
          'dif_de_plata',
        ].map((name) => [name, attribute(xml, name)]),
      ),
    ).toEqual({
      an_r: '2026',
      bifa131: '0',
      bifa132: '1',
      nume_c: 'Popescu',
      initiala_c: 'M',
      prenume_c: 'Ion',
      den_venit: 'Activități independente in Sistem Real ',
      cass_anuala_ai: '4599',
      real_venit_net_impozabil_ai: '41389',
      real_impozit_datorat_ai: '4139',
      dif_de_plata: '8738',
    });
    expect(
      (await s.refused(s.invoke(s.owner, 'declarations.validate', { artifactId: prepared.id })))
        ?.code,
    ).toBe('NO_OFFICIAL_VALIDATOR');
    const request = await s.invoke<ActionView>(s.owner, 'declarations.authorize.request', {
      artifactId: prepared.id,
    });
    expect(
      (request.preview as { findings: { code: string }[] }).findings.map((item) => item.code),
    ).toEqual(['NOT_VALIDATED']);
  });

  test('what is refused: a year without a structure or rules, an IF, income outside the books', async () => {
    // The engine's own register: no PIT values for 2024, no structure for 2026.
    const old = await books(2024);
    expect((await old.s.refused(prepare(old.s, '2024', old.options212)))?.code).toBe('RULE_GAP');
    expect((await old.s.refused(prepare(old.s, '2026', old.options212)))?.code).toBe('FORMAT_GAP');

    const fixed = await books(2025, { register: fixtures(2025) });
    const refused = (options: Record<string, unknown>) =>
      fixed.s.refused(prepare(fixed.s, '2025', { ...fixed.options212, ...options }));
    expect(
      (
        await refused({
          register: {
            otherIncome: { amount: '10000', evidenceId: (await fixed.s.evidence('d212.pdf')).id },
          },
        })
      )?.code,
    ).toBe('D212_OTHER_INCOME');
    // A party with no CNP recorded.
    const other = await fixed.person('ro_individual', 'Ionescu Maria');
    expect((await refused({ holderPartyId: other.id }))?.code).toBe('D212_CNP');
    // The option after a year with income: situation B needs a loss.
    expect((await refused({ cassOption: { situation: 'B' } }))?.code).toBe('D212_CASS_OPTION');
    // An IF: each member declares the income distributed to them.
    await fixed.s.invoke(fixed.s.owner, 'profile.record', {
      axis: 'entity.form',
      value: 'if',
      effectiveFrom: '2025-01-01',
      evidenceId: fixed.certificate,
    });
    expect((await refused({}))?.code).toBe('D212_IF');
  });

  test('the obligations calendar lists D212 by 25 May of the next year', async () => {
    const { s } = await pfa();
    const calendar = await s.invoke<{ kind: string; period: string; due: string | null }[]>(
      s.owner,
      'obligations.calendar',
      { from: '2026-12', to: '2026-12', today: '2026-12-31' },
    );
    expect(calendar.find((item) => item.kind === 'D212')).toMatchObject({
      period: '2026',
      due: '2027-05-25',
    });
  });
});
