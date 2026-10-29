import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { DukIntegrator } from '../../source/engine/adapters/declaration-validator';
import type { ProposalView } from '../../source/engine/kernel/views';
import { invoiceXml } from './fixtures/invoice';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

// Synthetic: the BNR rate of the previous year's end, and the quarter's revenues. Expected
// amounts by hand from Codul fiscal art. 51 and 53.
const bnr = `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher><PublishingDate>2025-12-31</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
<Cube date="2025-12-31"><Rate currency="EUR">5.0800</Rate></Cube>
</Body></DataSet>`;

const dist = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
const official = DukIntegrator.available(dist) && Bun.which('java') ? test : test.skip;

async function micro(incomeTax: 'micro' | 'profit' = 'micro', validator?: DukIntegrator) {
  const s = await scenario({
    cui: '18547290',
    ...(validator ? { declarationValidator: validator } : {}),
  });
  open.push(s);
  const record = async (axis: string, value: string) =>
    s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence(`${axis}.pdf`)).id,
    });
  await record('vat.status', 'normal_vat');
  await record('income_tax', incomeTax);
  await record('employer', 'yes');
  const { id: rates } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
    filename: 'nbrfxrates.xml',
    mediaType: 'application/xml',
    base64: Buffer.from(bnr).toString('base64'),
  });
  await s.invoke(s.owner, 'fx.importBnr', { evidenceId: rates });
  const anaf = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
    kind: 'ro_public_institution',
    country: 'RO',
    name: 'ANAF',
  });
  const sell = async (number: string, net: string, tax: string, gross: string) => {
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: `${number}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(
        invoiceXml({
          company: '18547290',
          number,
          direction: 'sale',
          date: '2026-11-10',
          net,
          tax,
          gross,
        }),
      ).toString('base64'),
    });
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId: id });
    await s.book('invoices.recognize', { documentId: document.id, account: '704' });
  };
  const note = async (lines: { account: string; side: 'D' | 'C'; amount: string }[]) =>
    s.book(
      'ledger.general',
      journal((await s.evidence('nota.pdf')).id, lines, { date: '2026-11-20' }),
    );
  const input = (extra: Record<string, unknown> = {}) => ({
    quarter: '2026-Q4',
    date: '2026-12-31',
    authorityId: anaf.id,
    ...extra,
  });
  const tax = (extra: Record<string, unknown> = {}) => s.propose('tax.micro', input(extra));
  return { s, sell, note, tax, input };
}

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);

describe('micro-enterprise tax', () => {
  test("1% of the quarter's revenues, less exclusions, plus the year's favorable FX difference in Q4", async () => {
    const { s, sell, note, tax, input } = await micro();
    await sell('V-1', '10000.00', '2100.00', '12100.00');
    await note([
      { account: '5121', side: 'D', amount: '150.00' },
      { account: '7651', side: 'C', amount: '150.00' },
    ]);
    await note([
      { account: '6651', side: 'D', amount: '50.00' },
      { account: '5121', side: 'C', amount: '50.00' },
    ]);
    await note([
      { account: '5121', side: 'D', amount: '200.00' },
      { account: '7588', side: 'C', amount: '200.00' },
    ]);
    // 7588 may hold excluded revenue: it needs a determination.
    const undetermined = await tax();
    expect(codes(undetermined)).toContain('MICRO_DETERMINATION');
    const { id: evidenceId } = await s.evidence('analiza-7588.pdf');
    const proposal = await s.revise(
      'tax.micro',
      undetermined,
      input({ determinations: [{ account: '7588', letter: null, excluded: '0', evidenceId }] }),
    );
    // 10,350 revenue − 150 FX gains (h) + 100 net FX gain of the year (Q4) = 10,300 → 103.
    expect(lines(proposal)).toEqual(['D 698 103.00', 'C 4418 103.00']);
    expect(codes(proposal)).toEqual(['MICRO_EMPLOYEE']);
    expect((await s.refused(s.approve(proposal)))?.code).toBeDefined();
    await s.post(await s.approve(proposal, s.reviewer, ['MICRO_EMPLOYEE']));
  });

  test('above 100,000 euro of turnover in the year, or without the micro regime, it is refused', async () => {
    const over = await micro();
    // 100,000 euro at 5.0800 = 508,000 lei.
    await over.sell('V-2', '508000.01', '106680.00', '614680.01');
    expect(codes(await over.tax())).toContain('MICRO_LIMIT');

    const profit = await micro('profit');
    await profit.sell('V-3', '1000.00', '210.00', '1210.00');
    expect(codes(await profit.tax())).toContain('NOT_MICRO');
  });
});

describe('D100 from the books', () => {
  official(
    "declares the quarter's micro tax in its last month and passes ANAF's validator",
    async () => {
      const { s, sell, tax } = await micro('micro', new DukIntegrator(dist));
      await s.invoke(s.owner, 'sales.seller.record', {
        details: {
          name: 'Exemplu Servicii SRL',
          vatId: 'RO18547290',
          address: {
            lines: ['Str. Lungă 10'],
            city: 'Galați',
            subdivision: 'RO-GL',
            country: 'RO',
          },
        },
      });
      await sell('V-9', '120000.00', '25200.00', '145200.00');
      const proposal = await tax();
      await s.post(await s.approve(proposal, s.reviewer, ['MICRO_EMPLOYEE']));
      const prepare = (options: Record<string, unknown>) =>
        s.invoke<{ state: string; steps: { detail: string | null }[] }>(
          s.owner,
          'declarations.prepare',
          {
            kind: 'D100',
            period: '2026-12',
            options: {
              declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
              ...options,
            },
          },
        );
      expect(JSON.stringify(await s.refused(prepare({})))).toContain('D100_DUE');
      const prepared = await prepare({ fourthQuarterDue: 'june' });
      expect(JSON.parse(prepared.steps[0]!.detail!).obligations).toEqual(['micro']);
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
    },
    120_000,
  );
});
