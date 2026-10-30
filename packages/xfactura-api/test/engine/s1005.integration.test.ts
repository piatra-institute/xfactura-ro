import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { s1005Field } from 'xfactura-core/ro/annual/s1005';
import { DukIntegrator } from '../../source/engine/adapters/declaration-validator';
import { invoiceXml } from './fixtures/invoice';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

const dist = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
const official = DukIntegrator.available(dist) && Bun.which('java') ? test : test.skip;
const cui = '18547290';
const options = {
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
  // The supplier and the VAT payable are due within a year.
  rows: { '401': { F10: '13' }, '4423': { F10: '13' } },
};
type Artifact = {
  id: string;
  state: string;
  steps: { state: string; detail: string | null; evidenceId: string | null }[];
};

/** 2025, the company's first year: 10,000 lei of capital paid in, a 10,000-lei sale and a
 * 2,000-lei purchase in November with their VAT settled, the result closed and 400 lei set aside
 * as legal reserve. */
async function firstYear(validator?: DukIntegrator, opening = false) {
  const s = await scenario({
    year: 2025,
    cui,
    ...(validator ? { declarationValidator: validator } : {}),
  });
  open.push(s);
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2025-01-01',
    evidenceId: (await s.evidence('certificat.pdf')).id,
  });
  await s.invoke(s.owner, 'sales.seller.record', {
    details: {
      name: 'Exemplu Servicii SRL',
      vatId: `RO${cui}`,
      address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
    },
  });
  await s.book(
    'ledger.general',
    journal(
      (await s.evidence('capital.pdf')).id,
      [
        { account: '5121', side: 'D', amount: '10000.00' },
        { account: '1012', side: 'C', amount: '10000.00' },
      ],
      opening ? { date: '2025-01-01', purpose: 'opening' } : { date: '2025-01-15' },
    ),
  );
  const invoice = async (number: string, extra: Record<string, string>, account: string) => {
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: `${number}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(
        invoiceXml({ company: cui, number, date: '2025-11-10', ...extra }),
      ).toString('base64'),
    });
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId: id });
    await s.book('invoices.recognize', { documentId: document.id, account });
  };
  await invoice(
    'V-1',
    { direction: 'sale', net: '10000.00', tax: '2100.00', gross: '12100.00' },
    '704',
  );
  await invoice('F-1', { net: '2000.00', tax: '420.00', gross: '2420.00' }, '628');
  const anaf = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
    kind: 'ro_public_institution',
    country: 'RO',
    name: 'ANAF',
  });
  await s.post(
    await s.approve(
      await s.propose('vat.settle', {
        period: '2025-11',
        date: '2025-11-30',
        authorityId: anaf.id,
        evidenceId: (await s.evidence('decont-tva.pdf')).id,
      }),
    ),
  );
  const note = async () => (await s.evidence('nota-inchidere.pdf')).id;
  await s.post(
    await s.approve(
      await s.propose('year.closeResult', { yearEnd: '2025-12-31', evidenceId: await note() }),
    ),
  );
  await s.post(
    await s.approve(
      await s.propose('year.legalReserve', {
        yearEnd: '2025-12-31',
        amount: '400.00',
        evidenceId: await note(),
      }),
    ),
  );
  const prepare = (extra: Record<string, unknown> = {}, year = '2025') =>
    s.invoke<Artifact>(s.owner, 'declarations.prepare', {
      kind: 'S1005',
      period: year,
      options: { ...options, ...extra },
    });
  return { s, prepare };
}

/** The XML's value of a form's row and column. */
const cell = (xml: string, form: 'F10' | 'F20', row: string, column: number) =>
  new RegExp(`\\b${s1005Field(form, row, column)}="(-?\\d+)"`).exec(xml)?.[1];

describe('S1005 from the books', () => {
  test('the balance sheet from the closing balances, the profit and loss account from the year’s turnover', async () => {
    const { s, prepare } = await firstYear();
    const artifact = await prepare();
    expect(artifact.state).toBe('prepared');
    expect(JSON.parse(artifact.steps[0]!.detail!)).toMatchObject({
      year: 2025,
      previous: 'none',
    });
    const xml = Buffer.from(
      await s.objects.get(s.company.id, (artifact as unknown as { xmlHash: string }).xmlHash),
    ).toString('utf8');
    // Net turnover 10,000 lei and the profit of 8,000 lei; no previous year.
    expect(cell(xml, 'F20', '01', 2)).toBe('10000');
    expect(cell(xml, 'F20', '08', 2)).toBe('8000');
    expect(cell(xml, 'F20', '01', 1)).toBe('0');
    // Cash at bank, and the debts due within a year: the supplier and the VAT payable.
    expect(cell(xml, 'F10', '08', 2)).toBe('10000');
    expect(cell(xml, 'F10', '13', 2)).toBe('4100');
  });

  test('what the books leave open is a problem, never a default', async () => {
    const { s, prepare } = await firstYear();
    const problems = async (operation: Promise<unknown>) =>
      (
        (await s.refused(operation))?.details as { problems: { code: string }[] } | undefined
      )?.problems.map((problem) => problem.code);
    // Without the debts' maturity the form cannot place 401 and 4423.
    expect(await problems(prepare({ rows: {} }))).toEqual(['S1005_SPLIT', 'S1005_SPLIT']);
    // Rows the books give cannot be typed in.
    expect(await problems(prepare({ informative: { F20: { '01': [0, 10000] } } }))).toEqual([
      'S1005_BOOKS_ROW',
    ]);
    // The first year has no previous column to give.
    expect(await problems(prepare({ previous: { F20: { '01': 5000 } } }))).toEqual([
      'S1005_PREVIOUS',
    ]);
    // 2026 has no published format yet.
    expect((await s.refused(prepare({}, '2026')))?.code).toBe('FORMAT_GAP');
  });

  test('opened from a previous year kept elsewhere: its balance sheet from the opening entries, its result as filed', async () => {
    const { s, prepare } = await firstYear(undefined, true);
    expect(
      ((await s.refused(prepare()))?.details as { problems: { code: string }[] }).problems.map(
        (problem) => problem.code,
      ),
    ).toEqual(['S1005_PREVIOUS']);
    // 2024's 5,000 lei of services sold and bought, in F20 and in F30 chapter XIX, which ANAF's
    // rules tie to it.
    const artifact = await prepare({
      previous: { F20: { '01': 5000, '06': 5000 }, F30: { '168': 5000, '198': 5000 } },
    });
    expect(JSON.parse(artifact.steps[0]!.detail!)).toMatchObject({ previous: 'opening' });
    const xml = Buffer.from(
      await s.objects.get(s.company.id, (artifact as unknown as { xmlHash: string }).xmlHash),
    ).toString('utf8');
    expect(cell(xml, 'F10', '08', 1)).toBe('10000');
    expect(cell(xml, 'F20', '01', 1)).toBe('5000');
  });

  official(
    'ANAF’s validator accepts the statements',
    async () => {
      const { prepare } = await firstYear(new DukIntegrator(dist));
      const artifact = await prepare();
      expect(artifact.steps.map((step) => [step.state, step.detail])).toEqual([
        ['prepared', expect.any(String)],
        ['validated_official', null],
      ]);
    },
    120_000,
  );
});
