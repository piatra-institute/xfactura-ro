import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readInvoice, verifyInvoice } from 'xfactura-core/einvoice';
import { scenario, type Scenario } from './scenario';
import { buyerDetails, salesCompany, sellerDetails, service, type Preview } from './fixtures/sales';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

/** A VAT-registered company with its invoicing details, one buyer and series XF. */
async function company() {
  const s = await scenario();
  open.push(s);
  return { s, ...(await salesCompany(s)) };
}

const balance = async (s: Scenario, account: string) =>
  (await s.trialBalance()).rows.find((row) => row.account === account)?.closing;

describe('issuing', () => {
  test('numbers at issue, keeps the e-Factura XML and recognizes the sale', async () => {
    const { s, issue, proposal, series } = await company();
    const first = await issue();
    const second = await issue({ issueDate: '2026-03-11', lines: [service('250.50')] });
    expect([first.number, second.number]).toEqual(['XF0001', 'XF0002']);
    expect(first.totals.payable).toBe('121.00');

    const { bytes } = await s.engine.evidence.read(s.owner, first.evidenceId);
    const xml = readInvoice(bytes);
    expect(xml).toMatchObject({
      number: 'XF0001',
      issueDate: '2026-03-10',
      seller: { vatId: 'RO12345678' },
      buyer: { vatId: 'RO14399840' },
    });
    expect(verifyInvoice(xml)).toEqual([]);

    const recognized = await proposal(first.recognition.proposalId!);
    expect(recognized.status).toBe('proposed');
    await s.post(await s.approve(recognized));
    expect(await balance(s, '4111')).toEqual({ debit: '121.00', credit: '0.00' });
    expect(await balance(s, '704')).toEqual({ debit: '0.00', credit: '100.00' });
    expect(await balance(s, '4427')).toEqual({ debit: '0.00', credit: '21.00' });

    const [listed] = await s.list<{ nextNumber: string }>(s.owner, 'sales.series.list');
    expect(listed!.nextNumber).toBe('XF0003');
    expect(series.nextNumber).toBe('XF0001');
  });

  test('concurrent issues receive consecutive numbers', async () => {
    const { issue } = await company();
    const issued = await Promise.all(Array.from({ length: 6 }, () => issue()));
    expect(issued.map((item) => item.number).sort()).toEqual([
      'XF0001',
      'XF0002',
      'XF0003',
      'XF0004',
      'XF0005',
      'XF0006',
    ]);
  });

  test('a retry returns the same invoice and consumes no number', async () => {
    const { s, issue } = await company();
    const key = randomUUID();
    const first = await issue({}, key);
    expect(await issue({}, key)).toEqual(first);
    expect((await issue()).number).toBe('XF0002');
    expect((await s.refused(issue({ lines: [service('5')] }, key)))?.code).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
  });

  test('refuses an invoice that would be invalid, without using a number', async () => {
    const { s, issue, preview, buyer } = await company();
    const problems = async (input: Record<string, unknown>) =>
      (await preview(input)).problems.map((problem) => problem.code);
    // 19% stopped being the standard rate on 2025-08-01.
    expect(await problems({ lines: [service('100', '19')] })).toEqual(['VAT_RATE']);
    // The reduced rate needs the supply of art. 291 alin. (2) that justifies it.
    expect(await problems({ lines: [service('100', '11')] })).toEqual(['REDUCED_RATE_BASIS']);
    expect(
      await problems({
        lines: [service('100', '11')],
        reducedRateBasis: 'art. 291 alin. (2) lit. h): cazare în sectorul hotelier',
      }),
    ).toEqual([]);
    expect(await problems({ currency: 'EUR' })).toEqual(['VAT_CURRENCY']);
    // The VAT rates are reviewed only until the end of 2026.
    expect(await problems({ issueDate: '2027-01-04' })).toEqual(['RULE_GAP']);
    expect(await problems({ typeCode: '381' })).toEqual(['CREDIT_REFERENCE']);
    expect((await preview()).xml).toContain('<cbc:ID>XF0001</cbc:ID>');

    expect((await s.refused(issue({ lines: [service('100', '19')] })))?.code).toBe('VAT_RATE');
    await issue({ issueDate: '2026-03-20' });
    expect(await problems({ issueDate: '2026-03-19' })).toEqual(['SERIES_DATE']);

    await s.invoke(s.owner, 'parties.recordDetails', {
      partyId: buyer.id,
      details: buyerDetails('14399840', 'București', 'RO-B'),
    });
    expect(await problems({ issueDate: '2026-03-20' })).toEqual(['RO_SECTOR']);
    expect((await preview({ issueDate: '2026-03-20' })).number).toBe('XF0002');
  });

  test('requires the details of both parties and how an individual identified (B2C)', async () => {
    const { s, preview } = await company();
    const stranger = await s.party('Fără Date SRL', '18547290');
    expect((await preview({ buyerId: stranger.id })).problems.map((p) => p.code)).toEqual([
      'BUYER_DETAILS',
    ]);
    const person = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_individual',
      country: 'RO',
      name: 'Ion Popescu',
    });
    expect((await preview({ buyerId: person.id })).problems.map((p) => p.code)).toContain(
      'B2C_IDENTIFICATION',
    );
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'parties.recordDetails', {
            partyId: stranger.id,
            details: buyerDetails('99999999'),
          }),
        )
      )?.code,
    ).toBe('PARTY_IDENTITY');
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'sales.seller.record', {
            details: { ...sellerDetails, vatId: 'RO14399840' },
          }),
        )
      )?.code,
    ).toBe('SELLER_IDENTITY');
  });

  test('a credit note corrects one issued invoice and reverses its recognition', async () => {
    const { s, issue, proposal } = await company();
    const invoice = await issue();
    await s.post(await s.approve(await proposal(invoice.recognition.proposalId!)));
    const credit = await issue({
      typeCode: '381',
      issueDate: '2026-04-02',
      precedingDocumentIds: [invoice.documentId],
    });
    expect(credit.number).toBe('XF0002');
    const { bytes } = await s.engine.evidence.read(s.owner, credit.evidenceId);
    expect(readInvoice(bytes)).toMatchObject({
      typeCode: '381',
      precedingInvoices: [{ number: 'XF0001', issueDate: '2026-03-10' }],
    });
    const reversed = await proposal(credit.recognition.proposalId!);
    expect(reversed.issues.filter((issue) => issue.severity === 'block')).toEqual([]);
    await s.post(await s.approve(reversed));
    expect(await balance(s, '4111')).toEqual({ debit: '0.00', credit: '0.00' });
    expect(await balance(s, '704')).toEqual({ debit: '0.00', credit: '0.00' });
  });

  test('a posting policy posts issued invoices as they are issued', async () => {
    const { s, issue, proposal } = await company();
    const sample = await proposal((await issue()).recognition.proposalId!);
    await s.invoke(s.reviewer, 'policies.create', {
      name: 'Facturi emise din seria XF',
      treatments: ['invoices.recognize'],
      rulesHashes: [sample.rulesHash],
      preconditions: [
        { kind: 'noWarnings' },
        { kind: 'accountsWithin', prefixes: ['4111', '704', '4427'] },
      ],
      validFrom: '2026-01-01',
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const automatic = await issue({ issueDate: '2026-03-12' });
    expect((await proposal(automatic.recognition.proposalId!)).status).toBe('posted');
    expect(await balance(s, '4111')).toEqual({ debit: '121.00', credit: '0.00' });
  });

  test('only people with write permission issue; only owners configure', async () => {
    const { s, issue } = await company();
    expect((await s.refused(issue({}, undefined, s.viewer)))?.code).toBe('FORBIDDEN');
    expect((await issue({}, undefined, s.reviewer)).number).toBe('XF0001');
    expect(
      (
        await s.refused(
          s.invoke(s.reviewer, 'sales.series.create', { code: 'B', revenueAccount: '704' }),
        )
      )?.code,
    ).toBe('FORBIDDEN');
    const issueOperation = s.engine.operations.get('sales.issue');
    expect([issueOperation.agent, issueOperation.approval]).toEqual([false, 'human']);
    expect(s.engine.operations.get('sales.preview').agent).toBe(true);
  });
});

describe('invoicer export import', () => {
  const party = (vatNumber: string, extra: Record<string, unknown> = {}) => ({
    name: 'Client Export SRL',
    vatNumber,
    address: 'Str. Exemplu 2',
    city: 'Cluj-Napoca',
    county: 'Cluj',
    country: 'România',
    ...extra,
  });
  const seller = party('RO12345678', { name: 'Pilot SRL' });
  const record = (
    id: string,
    number: string,
    price: number,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    seller,
    buyer: party('RO14399840'),
    metadata: {
      number,
      currency: 'RON',
      issueDate: Date.parse('2025-09-10T09:00:00Z'),
      dueDate: Date.parse('2025-10-10T09:00:00Z'),
    },
    products: [{ name: 'Servicii', price, quantity: 1, vatRate: 21, vatIncluded: false }],
    ...extra,
  });
  const exported = {
    exportedAt: Date.parse('2026-10-26T00:00:00Z'),
    defaultSeller: 'RO12345678',
    companies: {},
    inventory: {},
    invoices: Object.fromEntries(
      [
        record('a', '20250001', 1000),
        record('a-again', '20250001', 1000),
        record('b-first', '20250002', 500),
        record('b-second', '20250002', 550),
        record('no-sector', '20250003', 100, {
          buyer: party('RO14399840', { county: 'București', city: 'București' }),
        }),
        record('person', '20250004', 200, {
          buyer: party('1800101400016', { name: 'Ion Popescu' }),
        }),
        record('other-seller', '20250005', 100, { seller: party('RO18547290') }),
      ].map((item) => [item.id, item]),
    ),
  };

  test('gives every record one outcome and imports only what it can trust', async () => {
    const { s } = await company();
    const { id: evidenceId } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'xfactura-ro-export.json',
      mediaType: 'application/json',
      base64: Buffer.from(JSON.stringify(exported)).toString('base64'),
    });
    type Report = {
      states: Record<string, number>;
      outcomes: { id: string; state: string; code?: string; documentId?: string }[];
    };
    const report = await s.invoke<Report>(s.owner, 'invoices.importInvoicer', { evidenceId });
    const state = Object.fromEntries(
      report.outcomes.map((item) => [item.id, [item.state, item.code]]),
    );
    expect(state).toEqual({
      a: ['imported', undefined],
      'a-again': ['duplicate', undefined],
      'b-first': ['conflict', 'NUMBER_CONFLICT'],
      'b-second': ['conflict', 'NUMBER_CONFLICT'],
      'no-sector': ['invalid', 'INVOICER_SECTOR'],
      person: ['imported', undefined],
      'other-seller': ['not_seller', undefined],
    });

    const documents = await s.list<{ number: string; kind: string; totals: { gross: string } }>(
      s.owner,
      'documents.list',
    );
    expect(documents.map((item) => [item.number, item.kind, item.totals.gross]).sort()).toEqual([
      ['20250001', 'invoice.issued', '1210.00'],
      ['20250004', 'invoice.issued', '242.00'],
    ]);
    const partners = await s.list<{ id: string; kind: string; taxId: string }>(
      s.owner,
      'parties.list',
    );
    const person = partners.find((item) => item.kind === 'ro_individual')!;
    // A keyed hash of the CNP, never the CNP nor its plain SHA-256.
    expect(person.taxId).toMatch(/^cnp:k1:[a-f0-9]{64}$/);
    // The export names an individual by CNP: the file is personal data.
    expect(
      (await s.list<{ id: string; dataClasses: string[] }>(s.owner, 'evidence.list')).find(
        (item) => item.id === evidenceId,
      )?.dataClasses,
    ).toEqual(['evidence', 'personal']);
    expect(
      (await s.invoke<{ details: unknown }>(s.owner, 'parties.get', { partyId: person.id }))
        .details,
    ).toBeNull();
    const client = partners.find((item) => item.taxId === '14399840')!;
    expect(
      (
        await s.invoke<{ details: { address: { subdivision: string } } }>(s.owner, 'parties.get', {
          partyId: client.id,
        })
      ).details.address.subdivision,
    ).toBe('RO-CJ');

    // Importing the same export again adds nothing.
    const again = await s.invoke<Report>(s.owner, 'invoices.importInvoicer', { evidenceId });
    expect(again.states).toEqual({
      existing: 2,
      duplicate: 1,
      conflict: 2,
      invalid: 1,
      not_seller: 1,
    });
  });

  test('a series continuing the imported numbers refuses a number already used', async () => {
    const { s, buyer } = await company();
    const { id: evidenceId } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'export.json',
      mediaType: 'application/json',
      base64: Buffer.from(JSON.stringify(exported)).toString('base64'),
    });
    await s.invoke(s.owner, 'invoices.importInvoicer', { evidenceId });
    const series = await s.invoke<{ id: string }>(s.owner, 'sales.series.create', {
      code: '2025',
      prefix: '2025',
      width: 4,
      firstNumber: 1,
      revenueAccount: '704',
    });
    const preview = await s.invoke<Preview>(s.owner, 'sales.preview', {
      seriesId: series.id,
      buyerId: buyer.id,
      issueDate: '2026-03-10',
      lines: [service()],
    });
    expect([preview.number, preview.problems.map((problem) => problem.code)]).toEqual([
      '20250001',
      ['NUMBER_USED'],
    ]);
  });
});

describe('personal data an agent reads', () => {
  /** A synthetic CNP with a valid control digit. */
  const cnpOf = (body: string) => {
    const weights = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
    const control =
      weights.reduce((sum, weight, index) => sum + weight * Number(body[index]), 0) % 11;
    return `${body}${control === 10 ? 1 : control}`;
  };
  const reader = async (s: Scenario, scopes: string[]) =>
    s.engine.agents.authenticate(
      (
        await s.invoke<{ token: string }>(s.reviewer, 'agents.issue', {
          name: 'Asistent',
          scopes,
          expiresAt: s.expiresIn(7),
        })
      ).token,
      s.company.id,
    );
  /** Whether what a call returns holds the CNP (a boolean, so that no failure prints it). */
  const holds = async (code: string, read: Promise<unknown>) =>
    JSON.stringify(await read).includes(code);

  // A B2C invoice's XML carries the buyer's CNP (BT-47): it was kept as ordinary evidence, and
  // its document and recognition carried the CNP in clear to any agent.
  test('a B2C buyer’s CNP reaches no agent: the XML is personal, the document and booking mask it', async () => {
    const { s, issue } = await company();
    const code = cnpOf('290050117002');
    const person = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_individual',
      country: 'RO',
      name: 'Maria Ionescu',
    });
    await s.invoke(s.owner, 'parties.recordDetails', {
      partyId: person.id,
      details: {
        name: 'Maria Ionescu',
        address: {
          lines: ['Str. Domnească 7'],
          city: 'Galați',
          subdivision: 'RO-GL',
          country: 'RO',
        },
      },
    });
    await s.invoke(s.owner, 'parties.recordCnp', { partyId: person.id, cnp: code });
    const issued = await issue({
      buyerId: person.id,
      issueDate: '2026-10-28',
      b2c: { identification: 'cnp' },
    });
    const agent = await reader(s, [
      'evidence.read',
      'evidence.list',
      'documents.get',
      'proposals.get',
    ]);
    expect(
      (await s.refused(s.invoke(agent, 'evidence.read', { id: issued.evidenceId, mode: 'meta' })))
        ?.code,
    ).toBe('EVIDENCE_CLASS');
    expect(
      (await s.list<{ id: string }>(agent, 'evidence.list')).find(
        (item) => item.id === issued.evidenceId,
      ),
    ).toMatchObject({ filename: null, dataClasses: ['evidence', 'personal'], redacted: true });
    const document = s.invoke<{ body: { customer: { taxId: string } } }>(agent, 'documents.get', {
      id: issued.documentId,
    });
    expect(await holds(code, document)).toBe(false);
    expect((await document).body.customer.taxId).toBe('*************');
    const recognition = s.invoke(agent, 'proposals.get', { id: issued.recognition.proposalId });
    expect(await holds(code, recognition)).toBe(false);
    // A person who may record a CNP reads it where the engine keeps it; a viewer does not.
    expect(await holds(code, s.invoke(s.owner, 'documents.get', { id: issued.documentId }))).toBe(
      true,
    );
    expect(await holds(code, s.invoke(s.viewer, 'documents.get', { id: issued.documentId }))).toBe(
      false,
    );
    expect(
      (await s.refused(s.invoke(s.viewer, 'evidence.get', { id: issued.evidenceId })))?.code,
    ).toBe('EVIDENCE_CLASS');
  });

  // parties.create with the country and code of a partner already recorded threw SQLite's raw
  // constraint error.
  test('a partner already recorded is refused by name; an individual is known by a keyed CNP hash', async () => {
    const { s, buyer } = await company();
    const create = (input: Record<string, unknown>) =>
      s.invoke<{ id: string; taxId: string | null }>(s.owner, 'parties.create', {
        country: 'RO',
        name: 'Partener',
        ...input,
      });
    expect(
      await s.refused(create({ kind: 'ro_legal_entity', taxId: 'RO 14399840' })),
    ).toMatchObject({ code: 'PARTY_EXISTS', details: { partyId: buyer.id } });
    const code = cnpOf('180010112345');
    const person = await create({ kind: 'ro_individual', taxId: code });
    expect(person.taxId).toMatch(/^cnp:k1:[0-9a-f]{64}$/);
    expect(await s.refused(create({ kind: 'ro_individual', taxId: code }))).toMatchObject({
      code: 'PARTY_EXISTS',
      details: { partyId: person.id },
    });
    expect((await s.refused(create({ kind: 'ro_individual', taxId: '1800101123456' })))?.code).toBe(
      'CNP',
    );
    // The employee who is this person is the same party.
    await s.invoke(s.owner, 'profile.record', {
      axis: 'employer',
      value: 'yes',
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence('angajator.pdf')).id,
    });
    const employee = await s.invoke<{ partyId: string }>(s.owner, 'payroll.employees.record', {
      lastName: 'Ionescu',
      firstName: 'Dan',
      cnp: code,
      healthFund: 'RO-GL',
    });
    expect(employee.partyId).toBe(person.id);
    // Agents never see an individual's identifier.
    const agent = await reader(s, ['parties.list', 'parties.get', 'parties.create']);
    expect(
      (await s.list<{ id: string; taxId: string }>(agent, 'parties.list')).find(
        (party) => party.id === person.id,
      )?.taxId,
    ).toBe('*************');
    expect(
      (await s.invoke<{ taxId: string }>(agent, 'parties.get', { partyId: person.id })).taxId,
    ).toBe('*************');
    expect(await holds(code, s.list(agent, 'parties.list'))).toBe(false);
  });
});
