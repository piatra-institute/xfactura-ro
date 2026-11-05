import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { bankStatements } from '../../source/engine/db/schema';
import { iban, mt940 } from './fixtures/bank';
import { pdfDocument, show } from './fixtures/pdf';
import { scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

type Imported = {
  statements: {
    statementId: string;
    from: string;
    to: string;
    opening: string;
    closing: string;
    movements: number;
    added: number;
  }[];
  mapping?: { version: number; saved: boolean };
  citations: { verified: number; unverified: string[] };
};
type Movement = {
  bookingDate: string;
  amount: string;
  reference: string;
  counterparty: string | null;
};

/** A bank account and an agent with the bank toolset and evidence intake. */
async function setup() {
  const s = await scenario();
  open.push(s);
  const account = await s.invoke<{ id: string }>(s.owner, 'treasury.createAccount', {
    kind: 'bank',
    name: 'Cont curent',
    iban,
    currency: 'RON',
    ledgerAccount: '5121',
    openedOn: '2026-01-01',
  });
  const grant = await s.invoke<{ token: string }>(s.reviewer, 'agents.issue', {
    name: 'Agent bancar',
    scopes: ['toolset:bank', 'evidence.record', 'evidence.read'],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const agent = await s.engine.agents.authenticate(grant.token, s.company.id);
  const file = (filename: string, mediaType: string, bytes: Uint8Array | string) =>
    s.invoke<{ id: string }>(agent, 'evidence.record', {
      filename,
      mediaType,
      base64: Buffer.from(bytes).toString('base64'),
    });
  return { s, agent, account: account.id, file };
}

/** Windows-1250 for the letters the exports use; the rest is ASCII. */
const cp1250: Record<string, number> = { ă: 0xe3, â: 0xe2, î: 0xee, ș: 0xba, ț: 0xfe, Î: 0xce };
const windows1250 = (text: string) =>
  new Uint8Array([...text].map((character) => cp1250[character] ?? character.charCodeAt(0)));

/** A synthetic export in a Romanian bank's layout: debit and credit columns, decimal commas,
 * the balances on lines of their own. */
const bankExport = (opening: string, rows: string[], closing: string) =>
  windows1250(
    [
      `Extras de cont;${iban};;;`,
      `Sold inițial;;;${opening};`,
      'Data;Descriere;Debit;Credit;Beneficiar / Plătitor',
      ...rows,
      `Sold final;;;${closing};`,
      '',
    ].join('\r\n'),
  );
const october = bankExport(
  '1.000,00',
  [
    '05.10.2026;"Plată factura INV-1; ref. 77";100,00;;Furnizor SRL',
    '05.10.2026;Comision bancar;2,03;;',
    '10.10.2026;Încasare client;;1.250,00;Client SRL',
  ],
  '2.147,97',
);
const november = bankExport(
  '2.147,97',
  ['03.11.2026;Chirie noiembrie;1.500,00;;Proprietar SRL'],
  '647,97',
);
const mapping = {
  separator: ';',
  encoding: 'windows-1250',
  dateFormat: 'DD.MM.YYYY',
  decimal: ',',
  headerRows: 3,
  footerRows: 1,
  columns: {
    date: 'Data',
    description: ['Descriere'],
    debit: 'Debit',
    credit: 'Credit',
    counterparty: 'Beneficiar / Plătitor',
  },
  balances: { from: 'cells', opening: { row: 2, column: 4 }, closing: { row: -1, column: 4 } },
};

describe('CSV exports', () => {
  test('a Windows-1250 export with debit and credit columns imports, and its mapping is kept', async () => {
    const { s, agent, account, file } = await setup();
    const { id: first } = await file('extras-octombrie.csv', 'text/csv', october);
    const imported = await s.invoke<Imported>(agent, 'bank.importCsv', {
      evidenceId: first,
      accountId: account,
      mapping,
      period: { from: '2026-10-01', to: '2026-10-31' },
    });
    expect(imported.statements).toEqual([
      expect.objectContaining({
        from: '2026-10-01',
        to: '2026-10-31',
        opening: '1000.00',
        closing: '2147.97',
        movements: 3,
        added: 3,
      }),
    ]);
    expect(imported.mapping).toMatchObject({ version: 1, saved: true });
    expect(
      // Movements of one day come in no particular order.
      (await s.list<Movement>(s.owner, 'bank.movements', {}))
        .map((movement) => [
          movement.bookingDate,
          movement.amount,
          movement.reference,
          movement.counterparty,
        ])
        .sort((a, b) => (`${a[0]} ${a[1]}` < `${b[0]} ${b[1]}` ? -1 : 1)),
    ).toEqual([
      ['2026-10-05', '-100.00', 'Plată factura INV-1; ref. 77', 'Furnizor SRL'],
      ['2026-10-05', '-2.03', 'Comision bancar', null],
      ['2026-10-10', '1250.00', 'Încasare client', 'Client SRL'],
    ]);

    // The next export of the same bank needs no mapping: the account's is used.
    const { id: second } = await file('extras-noiembrie.csv', 'text/csv', november);
    const next = await s.invoke<Imported>(agent, 'bank.importCsv', {
      evidenceId: second,
      accountId: account,
      period: { from: '2026-11-01', to: '2026-11-30' },
    });
    expect(next.mapping).toMatchObject({ version: 1, saved: false });
    expect(next.statements[0]).toMatchObject({ opening: '2147.97', closing: '647.97', added: 1 });
    // The same file again is the same statement: nothing is added.
    const again = await s.invoke<Imported>(agent, 'bank.importCsv', {
      evidenceId: first,
      accountId: account,
      period: { from: '2026-10-01', to: '2026-10-31' },
    });
    expect(again.statements[0]?.statementId).toBe(imported.statements[0]?.statementId);
    expect(again.statements[0]?.added).toBe(0);
  });

  test('without a mapping on the account, or read with the wrong one, the import is refused', async () => {
    const { s, agent, account, file } = await setup();
    const { id } = await file('extras.csv', 'text/csv', october);
    const csv = (input: Record<string, unknown>) =>
      s.refused(
        s.invoke(agent, 'bank.importCsv', { evidenceId: id, accountId: account, ...input }),
      );
    expect((await csv({}))?.code).toBe('BANK_MAPPING_MISSING');
    expect((await csv({ mapping: { ...mapping, encoding: 'utf-8' } }))?.code).toBe(
      'BANK_CSV_ENCODING',
    );
    expect(await csv({ mapping: { ...mapping, decimal: '.' } })).toMatchObject({
      code: 'BANK_CSV_AMOUNT',
      details: { row: 4 },
    });
    // Balances the file states are not given again.
    expect(
      (
        await csv({
          mapping,
          balances: {
            opening: { amount: '1000.00', citation: { page: 1, line: 2, text: '1.000,00' } },
            closing: { amount: '2147.97', citation: { page: 1, line: 7, text: '2.147,97' } },
          },
        })
      )?.code,
    ).toBe('BANK_BALANCES');
  });

  test('balances given with citations are checked against the file’s lines', async () => {
    const { s, agent, account, file } = await setup();
    const { id } = await file('extras.csv', 'text/csv', october);
    const given = { ...mapping, footerRows: 1, balances: { from: 'given' } };
    const input = (closing: string) => ({
      evidenceId: id,
      accountId: account,
      mapping: given,
      period: { from: '2026-10-01', to: '2026-10-31' },
      balances: {
        opening: { amount: '1000.00', citation: { page: 1, line: 2, text: '1.000,00' } },
        closing: { amount: closing, citation: { page: 1, line: 7, text: 'Sold final;;;2.147,97' } },
      },
    });
    expect(await s.refused(s.invoke(agent, 'bank.importCsv', input('2147.79')))).toMatchObject({
      code: 'BANK_CITATION',
      details: { failed: [{ what: 'closing', reason: 'value' }] },
    });
    const imported = await s.invoke<Imported>(agent, 'bank.importCsv', input('2147.97'));
    expect(imported.citations).toEqual({ verified: 2, unverified: [] });
  });

  test('an export over days another statement already reports is refused', async () => {
    const { s, agent, account, file } = await setup();
    const { id: camtLike } = await file('extras-octombrie.sta', 'text/plain', mt940);
    await s.invoke(s.owner, 'bank.import', { evidenceId: camtLike, financialYearId: s.year.id });
    const { id } = await file('extras.csv', 'text/csv', october);
    expect(
      await s.refused(
        s.invoke(agent, 'bank.importCsv', {
          evidenceId: id,
          accountId: account,
          mapping,
          period: { from: '2026-10-01', to: '2026-10-31' },
        }),
      ),
    ).toMatchObject({ code: 'BANK_STATEMENT_OVERLAP', details: { format: 'mt940' } });
    // Nothing of the refused import stays, the mapping included.
    expect(
      (
        await s.refused(
          s.invoke(agent, 'bank.importCsv', {
            evidenceId: id,
            accountId: account,
            period: { from: '2026-11-01', to: '2026-11-30' },
          }),
        )
      )?.code,
    ).toBe('BANK_MAPPING_MISSING');
  });
});

// A statement printed as a PDF: one line per show().
const statementPdf = pdfDocument([
  {
    content: [
      show(72, 790, 'EXTRAS DE CONT nr. 11/2026', 12),
      show(72, 770, `IBAN ${iban}   Perioada 01.11.2026 - 30.11.2026`),
      show(72, 740, 'Sold inițial la 01.11.2026: 1.000,00 RON'),
      show(72, 720, '03.11.2026   Plată furnizor Furnizor SRL   -150,00'),
      show(72, 700, '12.11.2026   Încasare client Client SRL   2.000,00'),
      show(72, 680, 'Sold final la 30.11.2026: 2.850,00 RON'),
    ].join('\n'),
  },
]);
const transcription = (
  overrides: { closing?: string; entries?: unknown[] } = {},
): Record<string, unknown> => ({
  number: 'EXTRAS 11/2026',
  from: '2026-11-01',
  to: '2026-11-30',
  opening: { amount: '1000.00', citation: { page: 1, line: 3, text: '1.000,00 RON' } },
  closing: {
    amount: overrides.closing ?? '2850.00',
    citation: { page: 1, line: 6, text: 'Sold final la 30.11.2026: 2.850,00' },
  },
  entries: overrides.entries ?? [
    {
      date: '2026-11-03',
      amount: '-150.00',
      description: 'Plată furnizor',
      counterparty: 'Furnizor SRL',
      citation: { page: 1, line: 4, text: '-150,00' },
    },
    {
      date: '2026-11-12',
      amount: '2000.00',
      description: 'Încasare client',
      counterparty: 'Client SRL',
      citation: { page: 1, line: 5, text: 'Client SRL 2.000,00' },
    },
  ],
});

describe('PDF statements transcribed by an agent', () => {
  test('a transcription whose citations hold is recorded like any statement', async () => {
    const { s, agent, account, file } = await setup();
    const { id } = await file('extras-noiembrie.pdf', 'application/pdf', statementPdf);
    const recorded = await s.invoke<Imported>(agent, 'bank.recordStatement', {
      evidenceId: id,
      accountId: account,
      statement: transcription(),
    });
    expect(recorded.statements[0]).toMatchObject({
      from: '2026-11-01',
      to: '2026-11-30',
      opening: '1000.00',
      closing: '2850.00',
      added: 2,
    });
    expect(recorded.citations).toEqual({ verified: 4, unverified: [] });
    const [row] = await s.db.orm
      .select({ format: bankStatements.format, citations: bankStatements.citations })
      .from(bankStatements)
      .where(eq(bankStatements.id, recorded.statements[0]!.statementId));
    expect(row?.format).toBe('transcribed');
    expect(JSON.parse(row!.citations!).items).toHaveLength(4);
    expect(
      (await s.list<Movement>(s.owner, 'bank.movements', {})).map((movement) => movement.amount),
    ).toEqual(['-150.00', '2000.00']);
  });

  test('a wrong balance is refused, whether its citation or its arithmetic gives it away', async () => {
    const { s, agent, account, file } = await setup();
    const { id } = await file('extras-noiembrie.pdf', 'application/pdf', statementPdf);
    const record = (statement: Record<string, unknown>) =>
      s.refused(
        s.invoke(agent, 'bank.recordStatement', { evidenceId: id, accountId: account, statement }),
      );
    // The closing balance misread: the cited line shows another amount.
    expect(await record(transcription({ closing: '2580.00' }))).toMatchObject({
      code: 'BANK_CITATION',
      details: { failed: [{ what: 'closing', reason: 'value' }] },
    });
    // A row left out: every citation holds, but the balances do not.
    const [first] = transcription().entries as unknown[];
    expect((await record(transcription({ entries: [first] })))?.code).toBe('STATEMENT_BALANCE');
    expect(await s.list(s.owner, 'bank.movements', {})).toEqual([]);
  });

  test('a scanned statement has nothing to check the citations against: they stay unverified', async () => {
    const { s, agent, account, file } = await setup();
    const scan = pdfDocument([{ content: '' }]);
    const { id } = await file('extras-scanat.pdf', 'application/pdf', scan);
    const recorded = await s.invoke<Imported>(agent, 'bank.recordStatement', {
      evidenceId: id,
      accountId: account,
      statement: transcription(),
    });
    expect(recorded.citations).toEqual({
      verified: 0,
      unverified: ['opening', 'closing', 'entries.0', 'entries.1'],
    });
  });

  // A movement an agent transcribed from a scan is as unchecked as an extracted document: a
  // policy posting bank.settle does not post it unless it allows extracted sources (the
  // database refuses it too, inv:binding).
  test('a policy posts a scan’s movements only where it allows extracted sources', async () => {
    const settle = async (pdf: Uint8Array, allow?: string[]) => {
      const { s, agent, account, file } = await setup();
      const { id } = await file('extras.pdf', 'application/pdf', pdf);
      await s.invoke(agent, 'bank.recordStatement', {
        evidenceId: id,
        accountId: account,
        statement: transcription(),
      });
      const [payment, receipt] = await s.list<Movement & { id: string }>(
        s.owner,
        'bank.movements',
        {},
      );
      const first = await s.propose('bank.settle', {
        movementId: payment!.id,
        lines: [{ account: '628', amount: '150.00' }],
      });
      await s.invoke(s.reviewer, 'policies.create', {
        name: 'Încasări diverse',
        treatments: ['bank.settle'],
        rulesHashes: [first.rulesHash],
        preconditions: allow ? [{ kind: 'sourceAuthority', allow }] : [],
        validFrom: '2026-01-01',
        expiresAt: s.expiresIn(30),
      });
      const second = await s.propose(
        'bank.settle',
        { movementId: receipt!.id, lines: [{ account: '7588', amount: '2000.00' }] },
        agent,
      );
      return second.entry?.policyId ? 'posted' : second.status;
    };
    const scan = pdfDocument([{ content: '' }]);
    expect(await settle(statementPdf)).toBe('posted');
    expect(await settle(scan)).toBe('proposed');
    expect(await settle(scan, ['efactura'])).toBe('proposed');
    expect(await settle(scan, ['efactura', 'extracted'])).toBe('posted');
  });
});
