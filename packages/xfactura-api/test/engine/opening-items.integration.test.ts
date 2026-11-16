import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { entries, jobs, taxEntries, templatePredictions } from '../../source/engine/db/schema';
import type { ActionView } from '../../source/engine/kernel/actions';
import { loadState } from '../../source/engine/kernel/state';
import type { ProposalView } from '../../source/engine/kernel/views';
import type { WorkItem } from '../../source/engine/kernel/work';
import { camt, camtEntry, iban } from './fixtures/bank';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

type Document = { id: string; partyId: string };
const fresh = async () => {
  const s = await scenario();
  open.push(s);
  const { id: evidenceId } = await s.evidence('certificat.pdf');
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2025-01-01',
    evidenceId,
  });
  return s;
};
async function imported(s: Scenario, input: XmlInput, ronVat?: string) {
  let xml = invoiceXml(input);
  if (ronVat !== undefined)
    xml = xml
      .replace(
        '</cbc:DocumentCurrencyCode>',
        '</cbc:DocumentCurrencyCode><cbc:TaxCurrencyCode>RON</cbc:TaxCurrencyCode>',
      )
      .replace(
        '<cac:LegalMonetaryTotal>',
        `<cac:TaxTotal><cbc:TaxAmount currencyID="RON">${ronVat}</cbc:TaxAmount></cac:TaxTotal><cac:LegalMonetaryTotal>`,
      );
  const { id: evidenceId } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
    filename: `${input.number}.xml`,
    mediaType: 'application/xml',
    base64: Buffer.from(xml).toString('base64'),
  });
  return s.invoke<Document>(s.owner, 'invoices.import', { evidenceId });
}
const invoices = (s: Scenario, date = '2025-12-15') =>
  Promise.all([
    imported(s, { date, direction: 'sale', number: 'AR-1', counterparty: '87654321' }),
    imported(s, {
      date,
      direction: 'sale',
      number: 'AR-2',
      counterparty: '98765432',
      net: '200.00',
      tax: '42.00',
      gross: '242.00',
    }),
    imported(s, {
      date,
      number: 'AP-1',
      counterparty: '14399840',
      net: '50.00',
      tax: '10.50',
      gross: '60.50',
    }),
  ] as const);
async function openingInput(s: Scenario, docs: readonly [Document, Document, Document]) {
  const { id: evidenceId } = await s.evidence('balanta-deschidere.pdf');
  return journal(
    evidenceId,
    [
      { account: '5121', side: 'D', amount: '1000.00' },
      { account: '4111', side: 'D', amount: '121.00', newItem: 'customer-1' },
      { account: '4111', side: 'D', amount: '242.00', newItem: 'customer-2' },
      { account: '401', side: 'C', amount: '60.50', newItem: 'supplier' },
      { account: '1012', side: 'C', amount: '1302.50' },
    ],
    {
      date: '2026-01-01',
      purpose: 'opening',
      reference: 'OPENING-2026',
      newItems: docs.map((doc, index) => ({
        ref: ['customer-1', 'customer-2', 'supplier'][index]!,
        partyId: doc.partyId,
        documentId: doc.id,
      })),
    },
  );
}
const unbooked = async (s: Scenario) =>
  (await s.list<WorkItem>(s.owner, 'work.list', { kinds: ['document.unproposed'], limit: 100 }))
    .map((item) => item.subject.id)
    .sort();
const itemsFor = async (s: Scenario, documentId: string) =>
  s.db.read(async (tx) => [
    ...(
      await loadState(tx, s.company.id, {
        openItems: [{ documentId, history: true }],
      })
    ).loaded.openItems.values(),
  ]);
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);

describe('opening items and their documents', () => {
  test('templates leave opening documents out of their prediction backlog', async () => {
    const s = await fresh();
    const docs = await invoices(s);
    await s.book('ledger.general', await openingInput(s, docs));
    const pending = await imported(s, {
      date: '2026-02-01',
      number: 'AP-CONTROL',
      counterparty: '14399840',
    });
    const request = await s.invoke<ActionView>(s.owner, 'templates.request', {
      name: 'Furnizor sintetic',
      scope: {
        treatment: 'invoices.recognize',
        partyId: docs[2].partyId,
        documentKind: 'invoice.received',
      },
      mapping: { account: '628' },
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
    expect(predictions.map((prediction) => prediction.sourceKey)).toEqual([
      `document:${pending.id}`,
    ]);
    expect(predictions[0]?.status).toBe('predicted');
  });

  test('an existing opening keeps its version 1 effect hash', async () => {
    let sequence = 0;
    const s = await scenario({
      clock: () => Date.UTC(2026, 0, 1),
      ids: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    });
    open.push(s);
    const { id: evidenceId } = await s.evidence('balanta.pdf', 'Synthetic opening RB-31');
    const supplier = await s.party('Furnizor sintetic SRL', '87654321');
    const proposal = await s.propose(
      'ledger.general',
      journal(
        evidenceId,
        [
          { account: '5121', side: 'D', amount: '10000.00' },
          { account: '401', side: 'C', amount: '1500.00', newItem: 'supplier' },
          { account: '1012', side: 'C', amount: '8500.00' },
        ],
        {
          date: '2026-01-01',
          purpose: 'opening',
          reference: 'OPENING-2026',
          newItems: [{ ref: 'supplier', partyId: supplier.id, dueDate: '2026-01-31' }],
        },
      ),
    );
    expect(proposal.issues).toEqual([]);
    expect(proposal.effectHash).toBe(
      '3c5a57e86783d7138f1f915f93a58bcd81e354970ba66bb7211e194a09bdf9b5',
    );
  });

  test('carries two receivables and a payable, settles one and credits another', async () => {
    const s = await fresh();
    const docs = await invoices(s);
    expect(await unbooked(s)).toEqual(docs.map((doc) => doc.id).sort());
    const opening = await s.book('ledger.general', await openingInput(s, docs));
    expect(opening.effect?.openItems.map((item) => item.documentId).sort()).toEqual(
      docs.map((doc) => doc.id).sort(),
    );
    expect(opening.effect?.taxEntries).toEqual([]);
    const balance = await s.trialBalance();
    expect(balance.totals.opening).toEqual({ debit: '1363.00', credit: '1363.00' });
    expect(balance.rows.find((row) => row.account === '4111')?.opening).toEqual({
      debit: '363.00',
      credit: '0.00',
    });
    expect(balance.rows.find((row) => row.account === '401')?.opening).toEqual({
      debit: '0.00',
      credit: '60.50',
    });
    expect(await unbooked(s)).toEqual([]);
    for (const doc of docs) {
      const items = await itemsFor(s, doc.id);
      expect(items).toHaveLength(1);
      expect(items[0]?.documentId).toBe(doc.id);
      expect(items[0]?.originEntryId).toBe(opening.entry!.id);
    }

    await s.invoke(s.owner, 'treasury.createAccount', {
      kind: 'bank',
      name: 'Cont sintetic',
      iban,
      currency: 'RON',
      ledgerAccount: '5121',
      openedOn: '2026-01-01',
    });
    const { id: bankEvidence } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'extras.xml',
      mediaType: 'application/xml',
      base64: Buffer.from(
        camt({
          from: '2026-02-01',
          to: '2026-02-28',
          opening: '1000.00',
          closing: '1121.00',
          entries: camtEntry({
            amount: '121.00',
            date: '2026-02-10',
            direction: 'CRDT',
            bankRef: 'PAY-AR-1',
            text: 'Factura AR-1',
          }),
        }),
      ).toString('base64'),
    });
    await s.invoke(s.owner, 'bank.import', {
      evidenceId: bankEvidence,
      financialYearId: s.year.id,
    });
    const [movement] = await s.list<{ id: string }>(s.owner, 'bank.movements');
    const [item] = await itemsFor(s, docs[0].id);
    await s.book('bank.settle', {
      movementId: movement!.id,
      allocations: [{ openItem: item!.id, amount: '121.00' }],
    });
    expect((await itemsFor(s, docs[0].id))[0]?.balanceBani).toBe(0n);

    const credit = await imported(s, {
      date: '2026-02-12',
      direction: 'sale',
      number: 'CN-AR-2',
      counterparty: '98765432',
      credit: true,
      originalNumber: 'AR-2',
      net: '50.00',
      tax: '10.50',
      gross: '60.50',
    });
    const credited = await s.book('invoices.credit', {
      documentId: credit.id,
      originalDocumentId: docs[1].id,
      account: '704',
    });
    expect(credited.status).toBe('posted');
    expect((await itemsFor(s, docs[1].id))[0]?.balanceBani).toBe(18150n);
    expect(
      credited.effect?.lines.some(
        (line) =>
          line.openItem ===
          opening.effect!.openItems.find((open) => open.documentId === docs[1].id)?.id,
      ),
    ).toBe(true);
    expect(await unbooked(s)).toEqual([]);
    const refused = await s.refused(
      s.propose('invoices.recognize', { documentId: docs[0].id, account: '704' }),
    );
    expect(refused?.code).toBe('DOCUMENT_IN_OPENING');
    expect(refused?.message).toContain(opening.entry!.id);
    for (const [treatment, input] of [
      [
        'invoices.crossBorder',
        { documentId: docs[0].id, account: '704', supply: 'services_general_rule' },
      ],
      [
        'invoices.credit',
        { documentId: docs[0].id, originalDocumentId: docs[1].id, account: '704' },
      ],
    ] as const)
      expect((await s.refused(s.propose(treatment, input)))?.code).toBe('DOCUMENT_IN_OPENING');
  });

  test('opening, reversal, recognition, reversal and a new opening reclaim the documents', async () => {
    const s = await fresh();
    const docs = await invoices(s, '2026-01-01');
    const opening = await s.book('ledger.general', await openingInput(s, docs));
    const reversal = await s.propose('ledger.reverse', {
      entryId: opening.entry!.id,
      date: '2026-02-01',
      method: 'red',
      reason: 'Corectarea poziției de deschidere',
      evidenceId: (await s.evidence()).id,
    });
    expect(await unbooked(s)).toEqual([]);
    expect(
      (await s.refused(s.propose('invoices.recognize', { documentId: docs[0].id, account: '704' })))
        ?.code,
    ).toBe('DOCUMENT_IN_OPENING');
    await s.post(await s.approve(reversal));
    expect(await unbooked(s)).toEqual(docs.map((doc) => doc.id).sort());
    for (const doc of docs) expect(await itemsFor(s, doc.id)).toEqual([]);
    const recognition = await s.book('invoices.recognize', {
      documentId: docs[0].id,
      account: '704',
    });
    expect(recognition.status).toBe('posted');
    await s.book('ledger.reverse', {
      entryId: recognition.entry!.id,
      date: '2026-02-02',
      method: 'red',
      reason: 'Corectarea facturii recunoscute',
      evidenceId: (await s.evidence()).id,
    });
    expect(await unbooked(s)).toEqual(docs.map((doc) => doc.id).sort());
    const reopened = await s.book('ledger.general', await openingInput(s, docs));
    expect(reopened.entry!.id).not.toBe(opening.entry!.id);
    expect(await unbooked(s)).toEqual([]);
    for (const doc of docs) {
      const current = await itemsFor(s, doc.id);
      expect(current).toHaveLength(1);
      expect(current[0]?.originEntryId).toBe(reopened.entry!.id);
    }
  });

  test.each([true, false])(
    'a batch refuses the second booking and rolls back both (opening first: %s)',
    async (openingFirst) => {
      const s = await fresh();
      const docs = await invoices(s, '2026-01-01');
      const opening = await s.propose('ledger.general', await openingInput(s, docs));
      const recognition = await s.propose('invoices.recognize', {
        documentId: docs[0].id,
        account: '704',
      });
      const ordered = openingFirst ? [opening, recognition] : [recognition, opening];
      const batch = await s.invoke<ActionView>(s.owner, 'proposals.batch.request', {
        members: ordered.map((proposal) => ({
          proposalId: proposal.id,
          version: proposal.version,
          effectHash: proposal.effectHash,
        })),
      });
      expect(batch.preview).toMatchObject({ findings: [] });
      await s.invoke(s.reviewer, 'actions.approve', {
        id: batch.id,
        previewHash: batch.previewHash,
      });
      expect(
        await s.refused(s.invoke(s.reviewer, 'actions.execute', { id: batch.id })),
      ).toMatchObject({
        code: 'BATCH_CONFLICT',
        details: { proposalId: ordered[1]!.id },
      });
      expect(
        await s.db.read((tx) =>
          tx.select().from(entries).where(eq(entries.companyId, s.company.id)),
        ),
      ).toEqual([]);
      for (const proposal of ordered)
        expect(
          (await s.invoke<ProposalView>(s.owner, 'proposals.get', { id: proposal.id })).status,
        ).toBe('proposed');
    },
  );

  test('a policy sweep leaves an opening-carried recognition stale and posts an unrelated invoice', async () => {
    const s = await fresh();
    const docs = await invoices(s, '2026-01-01');
    const recognition = await s.propose('invoices.recognize', {
      documentId: docs[0].id,
      account: '704',
    });
    const opening = await s.book('ledger.general', await openingInput(s, docs));
    const control = await imported(s, {
      direction: 'sale',
      date: '2026-02-01',
      number: 'AR-SWEEP-CONTROL',
    });
    const unrelated = await s.propose('invoices.recognize', {
      documentId: control.id,
      account: '704',
    });
    expect(unrelated.rulesHash).toBe(recognition.rulesHash);
    const policy = await s.invoke<{ id: string }>(s.reviewer, 'policies.create', {
      name: 'Facturi sintetice',
      treatments: ['invoices.recognize'],
      rulesHashes: [recognition.rulesHash],
      preconditions: [],
      validFrom: '2026-01-01',
      expiresAt: s.expiresIn(30),
    });
    expect(await s.engine.jobs.runOne()).toBe(true);
    const [sweep] = await s.db.read((tx) =>
      tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.companyId, s.company.id), eq(jobs.kind, 'policies.sweep'))),
    );
    expect(sweep?.status).toBe('done');
    expect(sweep?.result).toEqual({ posted: 1, left: { stale: 1 } });
    expect(await s.engine.proposals.sweepOne(s.reviewer, policy.id, recognition.id)).toEqual({
      posted: false,
      reason: 'stale',
    });
    const after = await s.invoke<ProposalView>(s.owner, 'proposals.get', {
      id: recognition.id,
      recheck: true,
    });
    expect(after.status).toBe('stale');
    expect(after.check?.stale).toBe(true);
    const posted = await s.db.read((tx) =>
      tx.select().from(entries).where(eq(entries.companyId, s.company.id)),
    );
    expect(posted.map((entry) => entry.proposalId).sort()).toEqual(
      [opening.id, unrelated.id].sort(),
    );
    expect(
      (await s.invoke<ProposalView>(s.owner, 'proposals.get', { id: unrelated.id })).status,
    ).toBe('posted');
  });

  test('a foreign-currency credit uses an opening item at its carrying rate and the original VAT rate', async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'bnr.xml',
      mediaType: 'application/xml',
      base64: Buffer.from(
        `<?xml version="1.0"?>
<DataSet xmlns="http://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher><PublishingDate>2026-02-12</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
<Cube date="2025-12-15"><Rate currency="EUR">5.0000</Rate></Cube>
<Cube date="2025-12-31"><Rate currency="EUR">5.1000</Rate></Cube>
<Cube date="2026-02-12"><Rate currency="EUR">5.2000</Rate></Cube>
</Body></DataSet>`,
      ).toString('base64'),
    });
    await s.invoke(s.owner, 'fx.importBnr', { evidenceId });
    const original = await imported(
      s,
      {
        direction: 'sale',
        currency: 'EUR',
        date: '2025-12-15',
        number: 'EUR-OPENING',
        net: '1000.00',
        tax: '210.00',
        gross: '1210.00',
      },
      '1050.00',
    );
    const opening = await s.book(
      'ledger.general',
      journal(
        (await s.evidence()).id,
        [
          {
            account: '4111',
            side: 'D',
            amount: '6171.00',
            newItem: 'customer',
            currency: {
              code: 'EUR',
              amount: '1210.00',
              rate: '5.1000',
              rateId: 'BNR/EUR/2025-12-31',
            },
          },
          { account: '1012', side: 'C', amount: '6171.00' },
        ],
        {
          date: '2026-01-01',
          purpose: 'opening',
          newItems: [{ ref: 'customer', partyId: original.partyId, documentId: original.id }],
        },
      ),
    );
    expect(opening.effect?.taxEntries).toEqual([]);
    const credit = await imported(
      s,
      {
        direction: 'sale',
        currency: 'EUR',
        date: '2026-02-12',
        number: 'EUR-CREDIT',
        credit: true,
        originalNumber: 'EUR-OPENING',
        net: '200.00',
        tax: '42.00',
        gross: '242.00',
      },
      '210.00',
    );
    const credited = await s.book('invoices.credit', {
      documentId: credit.id,
      originalDocumentId: original.id,
      account: '704',
    });
    expect(credited.issues).toEqual([]);
    expect(
      credited.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`),
    ).toEqual(['D 4111 -1234.20', 'C 704 -1040.00', 'C 4427 -210.00', 'C 7651 15.80']);
    expect(credited.effect?.lines[0]).toMatchObject({
      openItem: opening.effect!.openItems[0]!.id,
      currency: { code: 'EUR', amount: '-242.00', rate: '5.1000' },
    });
    expect(credited.effect?.taxEntries[0]).toMatchObject({ base: '-1000.00', amount: '-210.00' });
    const [tax] = await s.db.read((tx) =>
      tx
        .select()
        .from(taxEntries)
        .where(
          and(eq(taxEntries.companyId, s.company.id), eq(taxEntries.entryId, credited.entry!.id)),
        ),
    );
    expect(tax).toMatchObject({
      currency: 'EUR',
      fxRate: '5.0000',
      baseMinor: -20000n,
      taxMinor: -4200n,
    });
    const [remaining] = await itemsFor(s, original.id);
    expect(remaining?.balanceBani).toBe(493680n);
    expect(remaining?.balanceMinor).toBe(96800n);
  });

  test('an approved recognition cannot post after an opening carries its document', async () => {
    const s = await fresh();
    const docs = await invoices(s, '2026-01-01');
    const recognition = await s.approve(
      await s.propose('invoices.recognize', { documentId: docs[0].id, account: '704' }),
    );
    const opening = await s.book('ledger.general', await openingInput(s, docs));
    const refused = await s.refused(s.post(recognition));
    expect(refused?.code).toBe('STALE');
    expect(refused?.details).toMatchObject({
      issues: [
        expect.objectContaining({
          code: 'DOCUMENT_IN_OPENING',
          details: { documentId: docs[0].id, entryId: opening.entry!.id },
        }),
      ],
    });
  });

  test('the treatment refuses a document already recognized, including a stale approved opening', async () => {
    const s = await fresh();
    const docs = await invoices(s, '2026-01-01');
    const input = await openingInput(s, docs);
    const opening = await s.approve(await s.propose('ledger.general', input));
    const booked = await s.book('invoices.recognize', { documentId: docs[0].id, account: '704' });
    expect((await s.refused(s.post(opening)))?.code).toBe('STALE');
    const revised = await s.revise('ledger.general', opening, input);
    expect(codes(revised)).toEqual(['DOCUMENT_BOOKED']);
    expect(revised.issues[0]?.message).toContain(booked.entry!.id);
    expect((await s.refused(s.approve(revised)))?.code).toBe('BLOCKING_ISSUES');
  });

  test.each(['missing', 'partner', 'duplicate', 'general', 'adjustment'])(
    'refuses %s document input',
    async (problem) => {
      const s = await fresh();
      const docs = await invoices(s);
      const input = await openingInput(s, docs);
      const newItems = docs.map((doc, index) => ({
        ref: ['customer-1', 'customer-2', 'supplier'][index]!,
        partyId: doc.partyId,
        documentId: doc.id,
      }));
      if (problem === 'missing') newItems[0]!.documentId = randomUUID();
      if (problem === 'partner') newItems[0]!.partyId = docs[1].partyId;
      if (problem === 'duplicate')
        newItems[1] = { ...newItems[1]!, partyId: docs[0].partyId, documentId: docs[0].id };
      const proposal = await s.propose('ledger.general', {
        ...input,
        newItems,
        ...(['general', 'adjustment'].includes(problem) ? { purpose: problem } : {}),
      });
      const expected = {
        missing: 'DOCUMENT',
        partner: 'DOCUMENT_PARTY',
        duplicate: 'DUPLICATE_DOCUMENT',
        general: 'OPENING_DOCUMENT_ONLY',
        adjustment: 'OPENING_DOCUMENT_ONLY',
      }[problem];
      expect(codes(proposal)).toContain(expected!);
      expect((await s.refused(s.approve(proposal)))?.code).toBe('BLOCKING_ISSUES');
    },
  );

  test('the booking predicate follows copies when the opening names a group member', async () => {
    const s = await fresh();
    const docs = await invoices(s);
    const copy = await imported(s, {
      date: '2025-12-16',
      direction: 'sale',
      number: 'AR-COPY',
      counterparty: '87654321',
    });
    await s.invoke(s.reviewer, 'documents.link', { documentId: copy.id, targetId: docs[0].id });
    const opening = await s.book('ledger.general', await openingInput(s, [copy, docs[1], docs[2]]));
    expect(await unbooked(s)).toEqual([]);
    for (const documentId of [docs[0].id, copy.id]) {
      const refused = await s.refused(
        s.propose('invoices.recognize', { documentId, account: '704' }),
      );
      expect(refused?.code).toBe('DOCUMENT_IN_OPENING');
      expect(refused?.message).toContain(opening.entry!.id);
    }
  });
});
