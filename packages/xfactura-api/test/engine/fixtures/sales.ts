import type { ProposalView } from '../../../source/engine/kernel/views';
import type { Scenario } from '../scenario';

export const sellerDetails = {
  name: 'Pilot SRL',
  vatId: 'RO12345678',
  address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
};
export const buyerDetails = (taxId: string, city = 'Brașov', subdivision = 'RO-BV') => ({
  name: 'Client Test SRL',
  vatId: `RO${taxId}`,
  address: { lines: ['Bd. Unirii 5'], city, subdivision, country: 'RO' },
});
export const service = (price = '100', rate = '21') => ({
  name: 'Servicii de consultanță',
  quantity: '1',
  unitCode: 'C62',
  price,
  vat: { category: 'S', rate },
});
export type Issued = {
  documentId: string;
  number: string;
  evidenceId: string;
  totals: { payable: string };
  recognition: { proposalId: string | null; error: string | null };
};
export type Preview = { number: string; problems: { code: string }[]; xml: string | null };

/** Makes the scenario's company VAT-registered, with its invoicing details, one buyer and
 * series XF. */
export async function salesCompany(s: Scenario) {
  const { id: evidenceId } = await s.evidence('certificat-tva.pdf');
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
    evidenceId,
  });
  await s.invoke(s.owner, 'sales.seller.record', { details: sellerDetails });
  const buyer = await s.party('Client Test SRL', '14399840');
  await s.invoke(s.owner, 'parties.recordDetails', {
    partyId: buyer.id,
    details: buyerDetails('14399840'),
  });
  const series = await s.invoke<{ id: string; nextNumber: string }>(
    s.owner,
    'sales.series.create',
    {
      code: 'XF',
      prefix: 'XF',
      width: 4,
      revenueAccount: '704',
    },
  );
  const issue = (input: Record<string, unknown> = {}, key?: string, actor = s.owner) =>
    s.invoke<Issued>(
      actor,
      'sales.issue',
      {
        seriesId: series.id,
        buyerId: buyer.id,
        issueDate: '2026-03-10',
        lines: [service()],
        ...input,
      },
      key,
    );
  const preview = (input: Record<string, unknown> = {}) =>
    s.invoke<Preview>(s.owner, 'sales.preview', {
      seriesId: series.id,
      buyerId: buyer.id,
      issueDate: '2026-03-10',
      lines: [service()],
      ...input,
    });
  const proposal = (id: string) => s.invoke<ProposalView>(s.owner, 'proposals.get', { id });
  return { buyer, series, issue, preview, proposal };
}
