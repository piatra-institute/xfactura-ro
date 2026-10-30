import { afterAll, describe, expect, test } from 'bun:test';
import type { ProposalView } from '../../source/engine/kernel/views';
import { invoiceXml } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

async function company() {
  const s = await scenario();
  open.push(s);
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
    evidenceId: (await s.evidence('certificat.pdf')).id,
  });
  const register = async (input: Record<string, unknown>) =>
    s.invoke<{ id: string }>(s.owner, 'assets.register', {
      catalogCode: '2.2.9',
      account: '214',
      depreciationAccount: '2814',
      commissionedOn: '2026-03-15',
      evidenceId: (await s.evidence('pv-punere-in-functiune.pdf')).id,
      ...input,
    });
  const depreciate = (month: string) => s.propose('assets.depreciate', { month });
  return { s, register, depreciate };
}

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);

describe('fixed assets', () => {
  test('bought on an invoice (404), then depreciated monthly from the month after commissioning', async () => {
    const { s, register, depreciate } = await company();
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'F-LAPTOP.xml',
      mediaType: 'application/xml',
      base64: Buffer.from(
        invoiceXml({
          number: 'F-LAPTOP',
          date: '2026-03-10',
          net: '6000.00',
          tax: '1260.00',
          gross: '7260.00',
        }),
      ).toString('base64'),
    });
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId: id });
    const bought = await s.book('invoices.recognize', { documentId: document.id, account: '214' });
    expect(lines(bought)).toEqual(['D 214 6000.00', 'D 4426 1260.00', 'C 404 7260.00']);
    await register({
      number: 'MF-001',
      name: 'Laptop',
      value: '6000.00',
      lifeMonths: 36,
      fiscalLifeMonths: 36,
      documentId: document.id,
    });

    expect(codes(await depreciate('2026-03'))).toEqual(['NOTHING_TO_DEPRECIATE']);
    // 6,000 over 36 months: the parts round so they add up (166.67, 166.66, …).
    const april = await s.propose('assets.depreciate', { month: '2026-04' });
    expect(lines(april)).toEqual(['D 6811 166.67', 'C 2814 166.67']);
    await s.post(await s.approve(april));
    expect(codes(await depreciate('2026-06'))).toEqual(['DEPRECIATION_GAP']);
    const may = await depreciate('2026-05');
    expect(lines(may)).toEqual(['D 6811 166.66', 'C 2814 166.66']);
    await s.post(await s.approve(may));
    const [asset] = await s.list<{ depreciated: string; remaining: string }>(
      s.owner,
      'assets.list',
    );
    expect(asset).toMatchObject({ depreciated: '333.33', remaining: '5666.67' });
  });

  test('a short life is recovered exactly, then nothing is left to depreciate', async () => {
    const { s, register } = await company();
    await register({
      number: 'MF-002',
      name: 'Licență',
      value: '100.00',
      lifeMonths: 3,
      fiscalLifeMonths: 3,
      account: '208',
      depreciationAccount: '2808',
    });
    const amounts: string[] = [];
    for (const month of ['2026-04', '2026-05', '2026-06']) {
      const posted = await s.book('assets.depreciate', { month });
      amounts.push(posted.effect!.lines[0]!.amount);
    }
    expect(amounts).toEqual(['33.33', '33.34', '33.33']);
    const after = await s.propose('assets.depreciate', { month: '2026-07' });
    expect(codes(after)).toEqual(['NOTHING_TO_DEPRECIATE']);
  });

  test('disposed of: depreciated through the disposal month by policy, then taken off the books', async () => {
    const { s, register } = await company();
    const { id: assetId } = await register({
      number: 'MF-005',
      name: 'Laptop',
      value: '6000.00',
      lifeMonths: 36,
      fiscalLifeMonths: 36,
    });
    await s.invoke(s.owner, 'assets.dispose', {
      assetId,
      date: '2026-06-20',
      evidenceId: (await s.evidence('pv-casare.pdf')).id,
    });
    await s.book('assets.depreciate', { month: '2026-04' });
    await s.book('assets.depreciate', { month: '2026-05' });
    // Whether June is depreciated is the company's policy; without it nothing proceeds.
    const june = await s.propose('assets.depreciate', { month: '2026-06' });
    expect(codes(june)).toEqual(['POLICY_MISSING']);
    await s.invoke(s.owner, 'profile.record', {
      axis: 'policy.assets.disposal_month',
      value: 'included',
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence('politici-contabile.pdf')).id,
    });
    const early = await s.propose('assets.derecognize', { assetId });
    expect(codes(early)).toEqual(['DEPRECIATION_DUE']);
    await s.post(await s.approve(await s.revise('assets.depreciate', june, { month: '2026-06' })));
    const derecognized = await s.revise('assets.derecognize', early, { assetId });
    expect(lines(derecognized)).toEqual(['D 2814 500.00', 'D 6583 5500.00', 'C 214 6000.00']);
    await s.post(await s.approve(derecognized));
    expect(codes(await s.propose('assets.depreciate', { month: '2026-07' }))).toEqual([
      'NOTHING_TO_DEPRECIATE',
    ]);
  });

  test('refuses an asset outside fixed-asset accounts, or a reused inventory number', async () => {
    const { s, register } = await company();
    expect(
      (
        await s.refused(
          register({
            number: 'MF-003',
            name: 'X',
            value: '10',
            lifeMonths: 12,
            fiscalLifeMonths: 12,
            account: '6028',
          }),
        )
      )?.code,
    ).toBeDefined();
    await register({
      number: 'MF-004',
      name: 'Imprimantă',
      value: '3000',
      lifeMonths: 36,
      fiscalLifeMonths: 36,
    });
    expect(
      (
        await s.refused(
          register({
            number: 'MF-004',
            name: 'Alta',
            value: '10',
            lifeMonths: 12,
            fiscalLifeMonths: 12,
          }),
        )
      )?.code,
    ).toBe('ASSET_NUMBER');
  });
});
