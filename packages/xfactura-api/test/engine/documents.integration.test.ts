import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import type { Actor } from '../../source/engine/kernel/commands';
import type { ProposalView } from '../../source/engine/kernel/views';
import type { DocumentView } from '../../source/engine/modules/documents';
import { invoiceXml } from './fixtures/invoice';
import { pdfDocument, show } from './fixtures/pdf';
import { journal, scenario, type Scenario } from './scenario';

// Synthetic parties with valid control digits; amounts and texts are written by hand.
const company = '12345674';
const supplier = '87654329';
const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

type Detail = DocumentView & {
  body: Record<string, unknown>;
  citations: {
    extractor: string | null;
    items: {
      field: string;
      page: number;
      line: number;
      text: string;
      status: string;
      reason: string | null;
    }[];
  } | null;
  members: { id: string; authority: string | null; link: string }[];
  supersedes: string | null;
};

/** A VAT-registered company, an agent with the inbox toolset, and ways to file evidence. */
async function setup() {
  const s = await scenario({ cui: company, clock: () => Date.parse('2026-10-30T10:00:00Z') });
  open.push(s);
  const { id: certificate } = await s.evidence('certificat-tva.pdf');
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
    evidenceId: certificate,
  });
  const grant = await s.invoke<{ token: string }>(s.reviewer, 'agents.issue', {
    name: 'Agent contabil',
    scopes: ['toolset:inbox', 'toolset:review'],
    expiresAt: s.expiresIn(1),
  });
  const agent = await s.engine.agents.authenticate(grant.token, s.company.id);
  const file = (
    filename: string,
    mediaType: string,
    bytes: Uint8Array | string,
    actor: Actor = agent,
  ) =>
    s.invoke<{ id: string }>(actor, 'evidence.record', {
      filename,
      mediaType,
      base64: Buffer.from(bytes).toString('base64'),
    });
  const record = (input: Record<string, unknown>, actor: Actor = agent) =>
    s.invoke<Detail>(actor, 'documents.record', input);
  const get = (id: string) => s.invoke<Detail>(s.owner, 'documents.get', { id });
  return { s, agent, file, record, get };
}

/** The printed invoice, one line per show(). */
const invoicePdf = (gross = '1.452,00') =>
  pdfDocument([
    {
      content: [
        show(72, 780, 'FACTURĂ FISCALĂ', 14),
        show(72, 750, 'Seria FCT nr. 0042 din 05.10.2026'),
        show(72, 730, 'Furnizor: Furnizor SRL, CIF: RO87654329'),
        show(72, 710, 'Client: Pilot SRL, CUI: RO12345674'),
        show(72, 680, 'Servicii consultanță octombrie 2026'),
        show(72, 650, 'Total fără TVA: 1.200,00 lei'),
        show(72, 630, 'TVA 21%: 252,00 lei'),
        show(72, 610, `Total de plată: ${gross} lei`),
      ].join('\n'),
    },
  ]);
const invoiceBody = (overrides: Record<string, unknown> = {}) => ({
  number: 'FCT 0042',
  issueDate: '2026-10-05',
  currency: 'RON',
  supplier: { name: 'Furnizor SRL', taxId: `RO${supplier}`, country: 'RO' },
  customer: { name: 'Pilot SRL', taxId: `RO${company}`, country: 'RO' },
  lines: [
    {
      description: 'Servicii consultanță octombrie 2026',
      net: '1200.00',
      vatCategory: 'S',
      vatRate: '21',
    },
  ],
  taxes: [{ base: '1200.00', tax: '252.00', category: 'S', rate: '21' }],
  totals: { net: '1200.00', tax: '252.00', gross: '1452.00' },
  ...overrides,
});
const invoiceCitations = {
  number: { page: 1, line: 2, text: 'FCT nr. 0042' },
  issueDate: { page: 1, line: 2, text: '05.10.2026' },
  'supplier.taxId': { page: 1, line: 3, text: 'CIF: RO87654329' },
  'customer.taxId': { page: 1, line: 4, text: 'RO12345674' },
  'totals.net': { page: 1, line: 6, text: '1.200,00' },
  'totals.tax': { page: 1, line: 7, text: '252,00' },
  'totals.gross': { page: 1, line: 8, text: 'Total de plată: 1.452,00' },
};
const codes = (proposal: ProposalView) =>
  proposal.issues.map((issue) => `${issue.code}/${issue.severity}`);
const statuses = (detail: Detail) =>
  Object.fromEntries((detail.checks ?? []).map((check) => [check.code, check.status]));

/** The same invoice as an archive downloaded from the SPV: an e-Factura document. */
async function fromSpv(s: Scenario, overrides: Record<string, string> = {}) {
  const xml = invoiceXml({
    company,
    counterparty: supplier,
    number: 'FCT0042',
    date: '2026-10-05',
    net: '1200.00',
    tax: '252.00',
    gross: '1452.00',
    ...overrides,
  });
  const archive = zipSync({
    '5100.xml': strToU8(xml),
    'semnatura_5100.xml': strToU8('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/>'),
  });
  const { id: evidenceId } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
    filename: `${randomUUID()}.zip`,
    mediaType: 'application/zip',
    base64: Buffer.from(archive).toString('base64'),
  });
  const imported = await s.invoke<{ documentId: string; outcome: string }>(
    s.owner,
    'spv.importArchive',
    { evidenceId },
  );
  expect(imported.outcome).toBe('created');
  return imported.documentId;
}

describe('documents read from a PDF', () => {
  test('explicit document references still prevent linking without a document subject', async () => {
    const { s, file, record } = await setup();
    const { id: evidenceId } = await file('referenced.pdf', 'application/pdf', invoicePdf());
    const extracted = await record({
      evidenceId,
      kind: 'invoice.received',
      body: invoiceBody(),
      citations: invoiceCitations,
    });
    const other = await fromSpv(s, { number: 'FCT0043' });
    const proposal = await s.propose('deferrals.defer', {
      documentId: extracted.id,
      partyId: extracted.partyId,
      evidenceId,
      date: '2026-10-05',
      account: '628',
      amount: '100.00',
      from: '2026-10',
      months: 2,
    });
    const link = { documentId: extracted.id, targetId: other };
    expect((await s.refused(s.invoke(s.reviewer, 'documents.link', link)))?.code).toBe(
      'DOCUMENT_BOOKED',
    );
    await s.post(await s.approve(proposal, s.reviewer, ['SOURCE_EXTRACTED']));
    expect((await s.refused(s.invoke(s.reviewer, 'documents.link', link)))?.code).toBe(
      'DOCUMENT_BOOKED',
    );
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'documents.supersede', {
            documentId: extracted.id,
            body: invoiceBody(),
            citations: invoiceCitations,
          }),
        )
      )?.code,
    ).toBe('DOCUMENT_POSTED');
  });

  test('an opening prevents correction and linking of its extraction until reversed', async () => {
    const { s, file, record } = await setup();
    const { id: evidenceId } = await file('opening-invoice.pdf', 'application/pdf', invoicePdf());
    const extracted = await record({
      evidenceId,
      kind: 'invoice.received',
      body: invoiceBody(),
      citations: invoiceCitations,
    });
    const proposal = await s.propose(
      'ledger.general',
      journal(
        (await s.evidence()).id,
        [
          { account: '5121', side: 'D', amount: '1452.00' },
          { account: '401', side: 'C', amount: '1452.00', newItem: 'supplier' },
        ],
        {
          date: '2026-01-01',
          purpose: 'opening',
          newItems: [{ ref: 'supplier', partyId: extracted.partyId, documentId: extracted.id }],
        },
      ),
    );
    const opening = await s.post(await s.approve(proposal, s.reviewer, ['SOURCE_EXTRACTED']));
    const { id: otherEvidence } = await file(
      'other.xml',
      'application/xml',
      invoiceXml({
        company,
        counterparty: supplier,
        number: 'FCT0043',
        date: '2026-10-05',
        net: '1200.00',
        tax: '252.00',
        gross: '1452.00',
      }),
    );
    const other = await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
      evidenceId: otherEvidence,
    });
    const correction = {
      documentId: extracted.id,
      body: invoiceBody(),
      citations: invoiceCitations,
    };
    const link = { documentId: extracted.id, targetId: other.id };
    expect((await s.refused(s.invoke(s.owner, 'documents.supersede', correction)))?.code).toBe(
      'DOCUMENT_POSTED',
    );
    expect((await s.refused(s.invoke(s.reviewer, 'documents.link', link)))?.code).toBe(
      'DOCUMENT_BOOKED',
    );
    await s.book('ledger.reverse', {
      entryId: opening.entry!.id,
      date: '2026-10-10',
      method: 'red',
      reason: 'Corectarea poziției inițiale',
      evidenceId: (await s.evidence()).id,
    });
    expect(await s.refused(s.invoke(s.reviewer, 'documents.link', link))).toBeUndefined();
    expect(await s.refused(s.invoke(s.owner, 'documents.supersede', correction))).toBeUndefined();
  });

  test('the year-end cut-off recognizes an SPV invoice carried by an opening', async () => {
    const { s } = await setup();
    const id = await fromSpv(s);
    const document = await s.invoke<Detail>(s.owner, 'documents.get', { id });
    const review = () =>
      s.invoke<{ items: { id: string }[] }>(s.owner, 'yearend.review', {
        financialYearId: s.year.id,
      });
    expect((await review()).items.some((item) => item.id === 'cutoff|spv')).toBe(true);
    const opening = await s.book(
      'ledger.general',
      journal(
        (await s.evidence()).id,
        [
          { account: '5121', side: 'D', amount: '1452.00' },
          { account: '401', side: 'C', amount: '1452.00', newItem: 'supplier' },
        ],
        {
          date: '2026-01-01',
          purpose: 'opening',
          newItems: [{ ref: 'supplier', partyId: document.partyId, documentId: id }],
        },
      ),
    );
    expect((await review()).items.some((item) => item.id === 'cutoff|spv')).toBe(false);
    await s.book('ledger.reverse', {
      entryId: opening.entry!.id,
      date: '2026-10-10',
      method: 'red',
      reason: 'Corectarea poziției inițiale',
      evidenceId: (await s.evidence()).id,
    });
    expect((await review()).items.some((item) => item.id === 'cutoff|spv')).toBe(true);
  });

  test('an extracted invoice with verified citations is checked and booked like any invoice', async () => {
    const { s, agent, file, record } = await setup();
    const { id: evidenceId } = await file('factura-0042.pdf', 'application/pdf', invoicePdf());
    const recorded = await record({
      evidenceId,
      kind: 'invoice.received',
      body: invoiceBody(),
      citations: invoiceCitations,
    });
    expect(recorded).toMatchObject({
      kind: 'invoice.received',
      number: 'FCT 0042',
      date: '2026-10-05',
      authority: 'extracted',
      groupId: null,
      supersededBy: null,
      totals: { net: '1200.00', tax: '252.00', gross: '1452.00' },
      schema: 'extracted-invoice-1',
    });
    expect(statuses(recorded)).toEqual({
      COMPANY_PARTY: 'passed',
      TOTALS: 'passed',
      VAT_CATEGORIES: 'passed',
      VAT_RATE: 'passed',
      TAX_IDS: 'passed',
      IBAN: 'skipped',
      DATES: 'passed',
      CITATIONS: 'passed',
    });
    expect(recorded.citations?.items.map((item) => item.status)).toEqual(Array(7).fill('verified'));
    expect(recorded.citations?.extractor).toStartWith('pdf-text.1.');
    // Recording the same reading of the same part again is that document.
    expect(
      (
        await record({
          evidenceId,
          kind: 'invoice.received',
          body: invoiceBody(),
          citations: invoiceCitations,
        })
      ).id,
    ).toBe(recorded.id);

    // The invoice treatment reads it unchanged; a person acknowledges the extraction.
    const proposal = await s.propose(
      'invoices.recognize',
      { documentId: recorded.id, account: '628' },
      agent,
    );
    expect(codes(proposal)).toEqual(['SOURCE_EXTRACTED/ack']);
    expect(proposal.issues[0]?.details).toEqual({
      documentId: recorded.id,
      failed: [],
      unverified: [],
    });
    expect(
      proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`),
    ).toEqual(['D 628 1200.00', 'D 4426 252.00', 'C 401 1452.00']);
    expect((await s.refused(s.approve(proposal)))?.code).toBe('ACKNOWLEDGEMENT_REQUIRED');
    const posted = await s.post(await s.approve(proposal, s.reviewer, ['SOURCE_EXTRACTED']));
    expect(posted.status).toBe('posted');
  });

  test('a citation that does not hold is kept as failed and named in the proposal', async () => {
    const { s, file, record } = await setup();
    const { id: evidenceId } = await file('factura-0042.pdf', 'application/pdf', invoicePdf());
    const recorded = await record({
      evidenceId,
      kind: 'invoice.received',
      body: invoiceBody(),
      citations: {
        ...invoiceCitations,
        // The gross amount cited from the VAT line, and the number from a line not in the file.
        'totals.gross': { page: 1, line: 7, text: '252,00' },
        number: { page: 1, line: 30, text: 'FCT nr. 0042' },
      },
    });
    expect(statuses(recorded).CITATIONS).toBe('failed');
    expect(
      recorded.citations?.items
        .filter((item) => item.status !== 'verified')
        .map((item) => [item.field, item.status, item.reason]),
    ).toEqual([
      ['number', 'failed', 'line'],
      ['totals.gross', 'failed', 'value'],
    ]);
    const proposal = await s.propose('invoices.recognize', {
      documentId: recorded.id,
      account: '628',
    });
    expect(codes(proposal)).toEqual(['SOURCE_EXTRACTED/ack']);
    expect(proposal.issues[0]?.details).toMatchObject({ failed: ['CITATIONS'] });
    expect(proposal.issues[0]?.message).toContain('Verificări nereușite: CITATIONS.');
  });

  test('the same invoice from e-Factura joins its group: booked once, from the better source', async () => {
    const { s, agent, file, record, get } = await setup();
    const { id: evidenceId } = await file('factura-0042.pdf', 'application/pdf', invoicePdf());
    const extracted = await record({
      evidenceId,
      kind: 'invoice.received',
      body: invoiceBody(),
      citations: invoiceCitations,
    });
    const proposal = await s.propose(
      'invoices.recognize',
      { documentId: extracted.id, account: '628' },
      agent,
    );
    expect(codes(proposal)).toEqual(['SOURCE_EXTRACTED/ack']);

    // The e-Factura copy arrives: its identity (supplier, number without spaces, date, type)
    // joins the extraction's group, whose root stays the extraction.
    const efactura = await fromSpv(s);
    expect(await get(efactura)).toMatchObject({
      authority: 'efactura',
      groupId: extracted.id,
      members: [
        { id: extracted.id, authority: 'extracted', link: 'root' },
        { id: efactura, authority: 'efactura', link: 'same_as' },
      ],
    });
    // The pending proposal is stale, and its re-evaluation suggests the better source.
    const rechecked = await s.invoke<ProposalView>(s.owner, 'proposals.get', {
      id: proposal.id,
      recheck: true,
    });
    expect(rechecked.status).toBe('stale');
    expect(rechecked.check?.changed.map((change) => change.kind)).toEqual([
      'documentSource',
      'issues',
    ]);

    // Booking the e-Factura copy beside it is refused: its subject is the group's root.
    const twice = await s.refused(
      s.propose('invoices.recognize', { documentId: efactura, account: '628' }, agent),
    );
    expect(twice).toMatchObject({ code: 'SUBJECT_EXISTS', details: { proposalId: proposal.id } });
    const suggested = await s.revise(
      'invoices.recognize',
      proposal,
      { documentId: extracted.id, account: '628' },
      agent,
    );
    expect(codes(suggested)).toEqual(['SOURCE_EXTRACTED/ack', 'BETTER_SOURCE/ack']);
    expect(suggested.issues[1]?.details).toEqual({
      documentId: extracted.id,
      better: efactura,
      authority: 'efactura',
    });
    // Revised onto the e-Factura document, it needs no acknowledgement.
    const revised = await s.revise(
      'invoices.recognize',
      suggested,
      { documentId: efactura, account: '628' },
      agent,
    );
    expect(codes(revised)).toEqual([]);
    expect(revised.subject).toBe(`document:${extracted.id}`);
    await s.post(await s.approve(revised));
    const again = await s.refused(
      s.propose('invoices.recognize', { documentId: extracted.id, account: '6022' }),
    );
    expect(again?.code).toBe('SUBJECT_EXISTS');
  });

  test('a near copy is linked by a person, not by an agent, and then booked once', async () => {
    const { s, agent, file, record } = await setup();
    const { id: evidenceId } = await file('factura-0042.pdf', 'application/pdf', invoicePdf());
    // The date misread by a day: another identity, so no group of its own accord.
    const misread = await record({
      evidenceId,
      kind: 'invoice.received',
      body: invoiceBody({ issueDate: '2026-10-06' }),
      citations: invoiceCitations,
    });
    const efactura = await fromSpv(s);
    const documents = await s.list<DocumentView>(s.owner, 'documents.list', {});
    expect(documents.map((item) => [item.authority, item.groupId])).toEqual([
      ['efactura', null],
      ['extracted', null],
    ]);
    expect(s.engine.operations.get('documents.link').agent).toBe(false);
    expect(
      (
        await s.refused(
          s.engine.invoke(agent, 'documents.link', randomUUID(), {
            documentId: misread.id,
            targetId: efactura,
          }),
        )
      )?.code,
    ).toBe('AGENT_SCOPE');
    const linked = await s.invoke(s.reviewer, 'documents.link', {
      documentId: misread.id,
      targetId: efactura,
    });
    expect(linked).toEqual({ documentId: misread.id, rootId: efactura, kind: 'same_as_confirmed' });
    await s.book('invoices.recognize', { documentId: efactura, account: '628' });
    expect(
      (await s.refused(s.propose('invoices.recognize', { documentId: misread.id, account: '628' })))
        ?.code,
    ).toBe('SUBJECT_EXISTS');
    // Copies that differ in their partner or amount are not one document.
    const other = await record({
      evidenceId,
      part: 2,
      kind: 'invoice.received',
      body: invoiceBody({
        number: 'FCT 0043',
        totals: { net: '1200.00', tax: '252.00', gross: '1452.00' },
        lines: [{ description: 'x', net: '1000.00', vatCategory: 'S', vatRate: '21' }],
        taxes: [{ base: '1000.00', tax: '210.00', category: 'S', rate: '21' }],
      }),
    });
    expect(statuses(other)).toMatchObject({ TOTALS: 'failed', VAT_CATEGORIES: 'passed' });
    const unrelated = await fromSpv(s, {
      number: 'FCT0050',
      net: '100.00',
      tax: '21.00',
      gross: '121.00',
    });
    expect(
      (
        await s.refused(
          s.invoke(s.reviewer, 'documents.link', { documentId: other.id, targetId: unrelated }),
        )
      )?.code,
    ).toBe('DOCUMENT_MATCH');
  });
});

describe('receipts and corrections', () => {
  test('a photographed receipt is recorded with unverified citations and grouped by register', async () => {
    const { s, file, record } = await setup();
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4,
      0, 0, 0, 3, 0,
    ]);
    const { id: evidenceId } = await file('bon.png', 'image/png', png);
    const receipt = {
      seller: { name: 'Papetăria SRL', taxId: `RO${supplier}`, country: 'RO' },
      buyerTaxId: company,
      number: '0042',
      register: '4400012345',
      issueDate: '2026-10-12',
      time: '14:22',
      currency: 'RON',
      lines: [
        { description: 'Hârtie A4', gross: '24.20', vatRate: '21' },
        { description: 'Agendă', gross: '11.10', vatRate: '11' },
      ],
      taxes: [
        { rate: '21', gross: '24.20', tax: '4.20' },
        { rate: '11', gross: '11.10', tax: '1.10' },
      ],
      totals: { gross: '35.30', tax: '5.30' },
      payment: 'card',
    };
    const recorded = await record({
      evidenceId,
      kind: 'receipt.received',
      body: receipt,
      citations: { 'totals.gross': { page: 1, line: 9, text: 'TOTAL 35,30' } },
    });
    expect(recorded).toMatchObject({
      kind: 'receipt.received',
      number: '0042',
      authority: 'extracted',
      totals: { net: '30.00', tax: '5.30', gross: '35.30' },
      schema: 'extracted-receipt-1',
    });
    expect(statuses(recorded)).toEqual({
      COMPANY_PARTY: 'passed',
      TOTALS: 'passed',
      VAT_CATEGORIES: 'passed',
      VAT_RATE: 'passed',
      TAX_IDS: 'passed',
      DATES: 'passed',
      CITATIONS: 'unverified',
    });
    expect(recorded.citations?.items).toEqual([
      {
        field: 'totals.gross',
        page: 1,
        line: 9,
        text: 'TOTAL 35,30',
        status: 'unverified',
        reason: 'no_text_layer',
      },
    ]);
    // A second photo of the same receipt is a copy in its group.
    const { id: second } = await file('bon-2.png', 'image/png', new Uint8Array([...png, 0]));
    const copy = await record({ evidenceId: second, kind: 'receipt.received', body: receipt });
    expect(copy.groupId).toBe(recorded.id);
    expect(
      (await s.list<DocumentView>(s.owner, 'documents.list', { kinds: ['receipt.received'] })).map(
        (item) => item.id,
      ),
    ).toEqual([recorded.id, copy.id].sort());
    // A receipt carrying another buyer's CUI is not the company's.
    expect(
      (
        await s.refused(
          record({
            evidenceId,
            part: 2,
            kind: 'receipt.received',
            body: { ...receipt, buyerTaxId: '11111110' },
          }),
        )
      )?.code,
    ).toBe('COUNTERPARTY');
  });

  test('an extraction is superseded before posting, and only reversed after', async () => {
    const { s, agent, file, record, get } = await setup();
    const { id: evidenceId } = await file('factura-0042.pdf', 'application/pdf', invoicePdf());
    // The gross amount misread: the totals do not add up, and the treatment is blocked.
    const wrong = await record({
      evidenceId,
      kind: 'invoice.received',
      body: invoiceBody({ totals: { net: '1200.00', tax: '252.00', gross: '1425.00' } }),
      citations: invoiceCitations,
    });
    expect(statuses(wrong)).toMatchObject({ TOTALS: 'failed', CITATIONS: 'failed' });
    const blocked = await s.propose(
      'invoices.recognize',
      { documentId: wrong.id, account: '628' },
      agent,
    );
    expect(codes(blocked)).toEqual(['SOURCE_INCONSISTENT/block', 'SOURCE_EXTRACTED/ack']);
    expect(blocked.status).toBe('blocked');
    // Recording the part again with other content is a conflict: it is corrected instead.
    expect(
      (await s.refused(record({ evidenceId, kind: 'invoice.received', body: invoiceBody() })))
        ?.code,
    ).toBe('DOCUMENT_CONFLICT');
    const corrected = await s.invoke<Detail>(agent, 'documents.supersede', {
      documentId: wrong.id,
      body: invoiceBody(),
      citations: invoiceCitations,
    });
    expect(corrected).toMatchObject({ supersedes: wrong.id, authority: 'extracted' });
    expect(statuses(corrected)).toMatchObject({ TOTALS: 'passed', CITATIONS: 'passed' });
    // Both share the identity: the correction joins the original's group.
    expect(corrected.groupId).toBe(wrong.id);
    expect((await get(wrong.id)).supersededBy).toBe(corrected.id);
    const stale = await s.invoke<ProposalView>(s.owner, 'proposals.get', {
      id: blocked.id,
      recheck: true,
    });
    expect(stale.status).toBe('stale');
    const revised = await s.revise(
      'invoices.recognize',
      blocked,
      { documentId: corrected.id, account: '628' },
      agent,
    );
    expect(codes(revised)).toEqual(['SOURCE_EXTRACTED/ack']);
    // The superseded original can no longer be read by a treatment.
    expect(
      codes(
        await s.revise(
          'invoices.recognize',
          revised,
          { documentId: wrong.id, account: '628' },
          agent,
        ),
      ),
    ).toContain('DOCUMENT_SUPERSEDED/block');
    expect(
      (
        await s.refused(
          s.invoke(agent, 'documents.supersede', { documentId: wrong.id, body: invoiceBody() }),
        )
      )?.code,
    ).toBe('DOCUMENT_SUPERSEDED');
    const latest = await s.revise(
      'invoices.recognize',
      await s.invoke<ProposalView>(s.owner, 'proposals.get', { id: blocked.id }),
      { documentId: corrected.id, account: '628' },
      agent,
    );
    await s.post(await s.approve(latest, s.reviewer, ['SOURCE_EXTRACTED']));
    // After posting, a correction is a reversal and a new proposal.
    expect(
      await s.refused(
        s.invoke(agent, 'documents.supersede', { documentId: corrected.id, body: invoiceBody() }),
      ),
    ).toMatchObject({ code: 'DOCUMENT_POSTED' });
    const efactura = await fromSpv(s);
    expect(
      (
        await s.refused(
          s.invoke(agent, 'documents.supersede', { documentId: efactura, body: invoiceBody() }),
        )
      )?.code,
    ).toBe('DOCUMENT_AUTHORITY');
  });
});
