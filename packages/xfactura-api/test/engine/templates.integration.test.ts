import { afterAll, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { templatePredictions } from '../../source/engine/db/schema';
import type { ActionView } from '../../source/engine/kernel/actions';
import { invoiceXml } from './fixtures/invoice';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

test('deferral templates predict recognized invoices and exclude opening-carried invoices', async () => {
  const s = await scenario();
  open.push(s);
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
    evidenceId: (await s.evidence()).id,
  });
  const imported = async (number: string) => {
    const { id: evidenceId } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: `${number}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(invoiceXml({ number, date: '2026-01-01' })).toString('base64'),
    });
    return s.invoke<{ id: string; partyId: string }>(s.owner, 'invoices.import', { evidenceId });
  };
  const recognized = await imported('RECOGNIZED-1');
  const carried = await imported('OPENING-1');
  await s.book('invoices.recognize', { documentId: recognized.id, account: '628' });
  await s.book(
    'ledger.general',
    journal(
      (await s.evidence()).id,
      [
        { account: '5121', side: 'D', amount: '121.00' },
        { account: '401', side: 'C', amount: '121.00', newItem: 'supplier' },
      ],
      {
        date: '2026-01-01',
        purpose: 'opening',
        newItems: [{ ref: 'supplier', partyId: carried.partyId, documentId: carried.id }],
      },
    ),
  );
  const request = await s.invoke<ActionView>(s.owner, 'templates.request', {
    name: 'Abonamente recunoscute',
    scope: {
      treatment: 'deferrals.defer',
      partyId: recognized.partyId,
      documentKind: 'invoice.received',
    },
    mapping: { account: '628', months: 2, start: 'issue' },
  });
  await s.invoke(s.reviewer, 'actions.approve', {
    id: request.id,
    previewHash: request.previewHash,
  });
  const executed = await s.invoke<ActionView>(s.reviewer, 'actions.execute', { id: request.id });
  const { templateId } = executed.result as { templateId: string };
  await s.engine.templates.predict(s.db, s.company.id);
  const predictions = await s.db.read((tx) =>
    tx
      .select()
      .from(templatePredictions)
      .where(
        and(
          eq(templatePredictions.companyId, s.company.id),
          eq(templatePredictions.templateId, templateId),
        ),
      ),
  );
  expect(predictions.map((row) => row.sourceKey)).toEqual([`document:${recognized.id}`]);
  expect(predictions[0]?.status).toBe('predicted');
  expect(JSON.parse(predictions[0]!.input!)).toMatchObject({
    documentId: recognized.id,
    amount: '100.00',
    account: '628',
    from: '2026-01',
    months: 2,
  });
});
