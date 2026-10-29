import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { DukIntegrator } from '../../source/engine/adapters/declaration-validator';
import type { ProposalView } from '../../source/engine/kernel/views';
import { invoiceXml } from './fixtures/invoice';
import { service, type Issued } from './fixtures/sales';
import { scenario, type Scenario } from './scenario';

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
