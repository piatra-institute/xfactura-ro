import { describe, expect, test } from 'bun:test';
import { d406CodeReadings } from 'xfactura-core/ro/saft/tax-code-readings';
import type { D406Filed, D406FiledTransaction } from 'xfactura-core/ro/saft/read';
import { migrationJournalInput } from '../src/treatments/journal';
import { applyLabAssumptions, labAssumptionsSchema } from '../src/run/assumptions';
import { blockRole } from '../src/run/taxes';
import {
  invoiceIndex,
  itemKey,
  ItemIndex,
  translateTransaction,
  type Translated,
} from '../src/run/translate';
import { ReplayMapping } from '../src/run/view';
import {
  customer,
  euSupplier,
  filed,
  line,
  marker,
  own,
  replayMapping,
  supplier,
  transaction,
  vat,
} from './fixtures/replay';

const evidenceId = '00000000-0000-4000-8000-000000000001';
const view = new ReplayMapping(replayMapping());
const partyIds = new Map(
  view.parties.map((party, index) => [
    party.key,
    `00000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
  ]),
);
const partyId = (key: string) => partyIds.get(key)!;
const supplierKey = 'create:fiscal:RO:90000033';
const customerKey = 'create:fiscal:RO:90000025';
const placeholderKey = (account: string) => `create:placeholder:${account}`;

function translate(
  books: D406Filed,
  items = new ItemIndex(),
  readings?: typeof d406CodeReadings,
): Translated {
  const journal = books.generalLedgerEntries.journals[0]!;
  return translateTransaction(journal, journal.transactions[0]!, {
    mapping: view,
    filed: books,
    periodStart: '2026-01-01',
    evidenceId,
    items,
    partyId,
    invoices: invoiceIndex([books], view),
    ...(readings ? { readings } : {}),
  });
}
const posted = (result: Translated) => {
  if (!result.ok) throw new Error(`refused: ${result.refusal.code}`);
  // Every translation is a valid treatment input.
  expect(migrationJournalInput.safeParse(result.input).success).toBe(true);
  return result;
};

const sale: D406FiledTransaction = transaction('T1', '2026-01-10', [
  line('4111', 'debit', '1210.00', { customer, supplier: '0' }),
  line('704', 'credit', '1000.00', { tax: [vat('310344', '1000.00', '210.00')] }),
  line('4427', 'credit', '210.00'),
]);

describe('D406 transactions as migration.journal inputs', () => {
  test('a sale with VAT on its base line books an output entry on the 4427 line', () => {
    const result = posted(
      translate(
        filed([sale], {
          sales: [
            {
              number: 'V-1',
              party: { id: customer },
              account: '4111',
              transaction: 'T1',
              lines: [],
            },
          ],
        }),
      ),
    );
    expect(result.reference).toBe('2026-01-01/1/T1');
    expect(result.input.lines).toEqual([
      {
        account: '4111',
        side: 'D',
        amount: '1210.00',
        partyId: partyId(customerKey),
        memo: 'Document V-1',
        newItem: 'i1',
      },
      { account: '704', side: 'C', amount: '1000.00' },
      { account: '4427', side: 'C', amount: '210.00' },
    ]);
    expect(result.input.newItems).toEqual([
      { ref: 'i1', partyId: partyId(customerKey), mayReverse: false },
    ]);
    expect(result.newItems).toEqual([
      { ref: 'i1', key: itemKey('4111', customerKey, 'V-1', 'RON') },
    ]);
    expect(result.input.taxEntries).toEqual([
      expect.objectContaining({
        code: 'S-21',
        direction: 'output',
        line: 2,
        base: '1000.00',
        amount: '210.00',
        booked: '210.00',
        deductible: '0.00',
        exigibility: '2026-01-10',
        taxPeriod: '2026-01',
        partyId: partyId(customerKey),
        attributes: expect.objectContaining({ saftTaxCode: '310344', role: 'operation' }),
      }),
    ]);
    // The comparison sees the operation with its posted deductible amount and period.
    expect(result.comparison.transaction.lines.map((item) => item.tax)).toEqual([
      [],
      [vat('310344', '1000.00', '210.00')],
      [],
    ]);
    expect(result.comparison.taxEntries).toEqual([
      { filed: { line: 1, tax: 0 }, deductible: '0.00', period: '2026-01' },
    ]);
  });

  test('a purchase with paired deductible and non-deductible blocks is one acquisition', () => {
    const purchase = transaction('T2', '2026-01-12', [
      line('628', 'debit', '100.00', { tax: [vat('301104', '100.00', '21.00')] }),
      line('401', 'credit', '100.00', { customer: '0', supplier }),
      line('4426', 'debit', '21.00'),
      line('401', 'credit', '21.00', { customer: '0', supplier }),
      line('628', 'debit', '21.00'),
      line('4426', 'credit', '21.00', { tax: [marker('351104')] }),
    ]);
    const result = posted(
      translate(
        filed([purchase], {
          purchases: [
            {
              number: 'F-2',
              party: { id: supplier },
              account: '401',
              transaction: 'T2',
              lines: [
                {
                  account: '628',
                  side: 'debit',
                  amount: { amount: '100.00' },
                  tax: [vat('301104', '100.00', '21.00'), vat('351104', '100.00', '21.00')],
                },
              ],
            },
          ],
        }),
      ),
    );
    const taxes = result.input.taxEntries;
    expect(taxes).toEqual([
      expect.objectContaining({
        code: 'S-21',
        direction: 'input',
        line: 2,
        base: '100.00',
        amount: '21.00',
        booked: '21.00',
        deductible: '21.00',
        attributes: expect.objectContaining({ saftTaxCode: '301104', role: 'operation' }),
      }),
      expect.objectContaining({
        code: 'S-21',
        direction: 'input',
        line: 5,
        base: '0.00',
        amount: '0.00',
        booked: '-21.00',
        deductible: '-21.00',
        attributes: expect.objectContaining({ saftTaxCode: '351104', role: 'marker' }),
      }),
    ]);
    // The VAT and its base count once; the reversal leaves nothing deducted.
    const total = (field: 'base' | 'amount' | 'deductible') =>
      taxes.reduce((sum, entry) => sum + Math.round(Number(entry[field]) * 100), 0);
    expect([total('base'), total('amount'), total('deductible')]).toEqual([10000, 2100, 0]);
    // Both payable lines open the invoice's single item.
    expect(result.input.lines.filter((item) => item.newItem === 'i1')).toHaveLength(2);
    expect(result.comparison.transaction.lines.flatMap((item) => item.tax)).toEqual([
      vat('301104', '100.00', '21.00'),
    ]);
  });

  test('deductible and non-deductible operations split a line or are refused, never counted twice', () => {
    const books = (lines: ReturnType<typeof line>[]) =>
      translate(filed([transaction('T2', '2026-01-12', lines)]));
    const payable = (amount: string) => line('401', 'credit', amount, { customer: '0', supplier });
    // Bases adding up to the line split it, as `readD406` reads them: two operations.
    const split = posted(
      books([
        line('628', 'debit', '100.00', {
          tax: [vat('301104', '50.00', '10.50'), vat('351104', '50.00', '10.50')],
        }),
        line('628', 'debit', '10.50'),
        line('4426', 'debit', '10.50'),
        payable('121.00'),
      ]),
    );
    expect(
      split.input.taxEntries.map(({ line, base, amount, booked, deductible }) => [
        line,
        base,
        amount,
        booked,
        deductible,
      ]),
    ).toEqual([
      [2, '50.00', '10.50', '10.50', '10.50'],
      [undefined, '50.00', '10.50', '0.00', '0.00'],
    ]);
    // One base on one line, or a non-deductible block whose base is not its own line, repeat
    // one acquisition: deciding which share was deducted needs the rate's VAT.
    for (const lines of [
      [
        line('628', 'debit', '100.00', {
          tax: [vat('301104', '100.00', '21.00'), vat('351104', '100.00', '21.00')],
        }),
        line('628', 'debit', '21.00'),
        payable('121.00'),
      ],
      [
        line('628', 'debit', '100.00', { tax: [vat('301104', '100.00', '21.00')] }),
        line('4426', 'debit', '21.00'),
        line('628', 'debit', '21.00', { tax: [vat('351104', '100.00', '21.00')] }),
        line('4426', 'credit', '21.00'),
        payable('121.00'),
      ],
    ]) {
      const refused = books(lines);
      expect(!refused.ok && refused.refusal.code).toBe('TAX_PAIR_UNDECIDED');
    }
    // An operation without a base on a VAT line would read the VAT as its base.
    const baseless = books([
      line('628', 'debit', '100.00'),
      line('4426', 'debit', '21.00', { tax: [{ type: '300', code: '301104', amount: '21.00' }] }),
      payable('121.00'),
    ]);
    expect(!baseless.ok && baseless.refusal.code).toBe('TAX_BASE_MISSING');
  });

  test('a reverse charge books its acquisition on 4426 and its collected side on 4427', () => {
    const result = posted(
      translate(
        filed([
          transaction('T3', '2026-01-14', [
            line('628', 'debit', '930.00', { tax: [vat('300704', '930.00', '195.30')] }),
            line('401', 'credit', '930.00', { customer: '0', supplier: euSupplier }),
            line('4426', 'debit', '195.30', { tax: [marker('300704')] }),
            line('4427', 'credit', '195.30', { tax: [marker('300704')] }),
          ]),
        ]),
      ),
    );
    expect(
      result.input.taxEntries.map(({ code, direction, line, booked, deductible, attributes }) => ({
        code,
        direction,
        line,
        booked,
        deductible,
        role: attributes.role,
      })),
    ).toEqual([
      {
        code: 'RC-EU-SERV',
        direction: 'input',
        line: 2,
        booked: '195.30',
        deductible: '195.30',
        role: 'operation',
      },
      {
        code: 'RC-EU-SERV',
        direction: 'output',
        line: 3,
        booked: '195.30',
        deductible: '0.00',
        role: 'collected',
      },
    ]);
  });

  test('an ambiguous code is kept where the VAT account leaves one reading, refused otherwise', () => {
    // An invented code read both ways: the transaction's 4427 line leaves the output reading.
    const output = d406CodeReadings('310344')[0]!;
    const input = d406CodeReadings('301104')[0]!;
    const readings = (code: string) =>
      code === '399999'
        ? [
            { ...output, taxCode: '399999' },
            { ...input, taxCode: '399999' },
          ]
        : d406CodeReadings(code);
    const ambiguousSale = structuredClone(sale);
    ambiguousSale.lines[1]!.tax = [vat('399999', '1000.00', '210.00')];
    const resolved = posted(translate(filed([ambiguousSale]), new ItemIndex(), readings));
    expect(resolved.input.taxEntries).toEqual([
      expect.objectContaining({ direction: 'output', line: 2, code: 'S-21' }),
    ]);
    // 308302 reads as an exempt or a non-taxable purchase; no account tells them apart.
    const exempt = translate(
      filed([
        transaction('T4', '2026-01-15', [
          line('628', 'debit', '50.00', { tax: [vat('308302', '50.00', '0.00')] }),
          line('401', 'credit', '50.00', { customer: '0', supplier }),
        ]),
      ]),
    );
    expect(exempt.ok).toBe(false);
    expect(!exempt.ok && exempt.refusal.code).toBe('TAX_CODE_AMBIGUOUS');
    expect(exempt.comparison.transaction.lines[0]!.tax).toEqual([vat('308302', '50.00', '0.00')]);
    // Without a base, SAGA's 308302 on an expense line marks no VAT line: the engine posts no
    // entry, and the comparison keeps the block a return needs, so the missing base shows.
    const marked = posted(
      translate(
        filed([
          transaction('T4', '2026-01-15', [
            line('628', 'debit', '50.00', { tax: [marker('308302')] }),
            line('401', 'credit', '50.00', { customer: '0', supplier }),
          ]),
        ]),
      ),
    );
    expect(marked.input.taxEntries).toEqual([]);
    expect(marked.comparison.transaction.lines.flatMap((item) => item.tax)).toEqual([
      marker('308302'),
    ]);
    expect(marked.comparison.taxEntries).toEqual([]);
  });

  test("an import's marker on the customs agent's line books the one uncoded 4426 line", () => {
    const imported = (vatLines: ReturnType<typeof line>[]) =>
      translate(
        filed([
          transaction('T9', '2026-01-18', [
            line('628', 'debit', '410.00'),
            line('401', 'credit', '410.00', { customer: '0', supplier }),
            ...vatLines,
            line('462', 'credit', '80.90', { tax: [marker('301201')] }),
          ]),
        ]),
      );
    const result = posted(imported([line('4426', 'debit', '80.90')]));
    expect(result.notes).toEqual(['IMPORT_MARKER_ATTACHED']);
    expect(result.input.taxEntries).toEqual([
      expect.objectContaining({
        code: 'IMP-19',
        direction: 'input',
        line: 2,
        base: '0.00',
        amount: '0.00',
        booked: '80.90',
        deductible: '80.90',
        attributes: expect.objectContaining({ role: 'marker', sourceLine: '3', attachedLine: '2' }),
      }),
    ]);
    // The import's code is a return's: the comparison keeps it.
    expect(result.comparison.transaction.lines[3]!.tax).toEqual([marker('301201')]);
    // Two uncoded 4426 lines leave the marker unplaced; the engine refuses the VAT lines.
    const unplaced = posted(
      imported([line('4426', 'debit', '44.45'), line('4426', 'debit', '36.45')]),
    );
    expect(unplaced.input.taxEntries).toEqual([]);
    expect(unplaced.notes).toEqual([]);
  });

  test('VAT on collection: a deferred purchase keeps its period; a 3801xx release books both sides', () => {
    const deferred = posted(
      translate(
        filed([
          transaction('T10', '2026-01-19', [
            line('628', 'debit', '100.00', { tax: [vat('301305', '100.00', '21.00')] }),
            line('4428', 'debit', '21.00'),
            line('401', 'credit', '121.00', { customer: '0', supplier }),
          ]),
        ]),
      ),
    );
    expect(deferred.input.taxEntries).toEqual([
      expect.objectContaining({
        line: 1,
        exigibility: null,
        taxPeriod: '2026-01',
        booked: '21.00',
      }),
    ]);
    // The release's direction comes from the transaction's single 4426 line.
    const release = posted(
      translate(
        filed([
          transaction('T11', '2026-01-25', [
            line('4426', 'debit', '25.00'),
            line('4428', 'credit', '25.00', { tax: [vat('380106', '119.05', '25.00')] }),
          ]),
        ]),
      ),
    );
    expect(
      release.input.taxEntries.map(
        ({ line, direction, base, amount, booked, exigibility, taxPeriod, attributes }) => ({
          line,
          direction,
          base,
          amount,
          booked,
          exigibility: exigibility as string | null,
          taxPeriod,
          role: attributes.role,
        }),
      ),
    ).toEqual([
      {
        line: 0,
        direction: 'input',
        base: '119.05',
        amount: '25.00',
        booked: '25.00',
        exigibility: '2026-01-25',
        taxPeriod: '2026-01',
        role: 'operation',
      },
      {
        line: 1,
        direction: 'input',
        base: '-119.05',
        amount: '-25.00',
        booked: '-25.00',
        exigibility: null,
        taxPeriod: '2026-01',
        role: 'deferred',
      },
    ]);
  });

  test('a payment settles the item of the invoice it names', () => {
    const items = new ItemIndex();
    const invoiceItem = '00000000-0000-4000-8000-000000000201';
    items.set(itemKey('401', supplierKey, 'F-1', 'RON'), invoiceItem);
    const result = posted(
      translate(
        filed(
          [
            transaction('T5', '2026-01-20', [
              line('401', 'debit', '605.00', { customer: '0', supplier }),
              line('5121', 'credit', '605.00'),
            ]),
          ],
          {
            payments: [
              {
                transaction: 'T5',
                lines: [
                  {
                    account: '401',
                    supplier,
                    customer: '0',
                    document: 'F-1',
                    side: 'credit',
                    amount: { amount: '605.00' },
                  },
                ],
              },
            ],
          },
        ),
        items,
      ),
    );
    expect(result.input.lines[0]).toEqual({
      account: '401',
      side: 'D',
      amount: '605.00',
      partyId: partyId(supplierKey),
      memo: 'Document F-1',
      openItem: invoiceItem,
    });
    expect(result.input.newItems).toEqual([]);
    expect(result.settlements).toEqual([]);
    expect(result.settledByDocument).toBe(1);
  });

  test('a payment naming no known invoice opens an unallocated item and a settlement note', () => {
    const receipt = () =>
      translate(
        filed(
          [
            transaction('T6', '2026-01-21', [
              line('5121', 'debit', '300.00'),
              line('4111', 'credit', '300.00', { customer, supplier: '0' }),
            ]),
          ],
          {
            payments: [
              {
                transaction: 'T6',
                lines: [
                  {
                    account: '4111',
                    customer,
                    supplier: '0',
                    document: 'V-0',
                    side: 'debit',
                    amount: { amount: '300.00' },
                  },
                ],
              },
            ],
          },
        ),
        items,
      );
    const items = new ItemIndex();
    const result = posted(receipt());
    expect(result.input.lines[1]).toMatchObject({ newItem: 'i1', partyId: partyId(customerKey) });
    expect(result.input.newItems).toEqual([
      { ref: 'i1', partyId: partyId(customerKey), mayReverse: true },
    ]);
    expect(result.newItems).toEqual([
      { ref: 'i1', key: itemKey('4111', customerKey, null, 'RON') },
    ]);
    expect(result.settlements).toEqual([
      {
        line: 1,
        account: '4111',
        party: customerKey,
        document: 'V-0',
        class: 'mapping',
        reason: 'SETTLEMENT_DOCUMENT_UNFILED',
      },
    ]);
    // Once the party's unallocated item exists, the next such settlement lands on it, still
    // noted, and is no settlement by document.
    const unallocated = '00000000-0000-4000-8000-000000000301';
    items.set(itemKey('4111', customerKey, null, 'RON'), unallocated);
    const again = posted(receipt());
    expect(again.input.lines[1]).toMatchObject({ openItem: unallocated });
    expect(again.settlements).toHaveLength(1);
    expect(again.settledByDocument).toBe(0);
  });

  test('a reused invoice key opens its own item and later payments naming it stay unallocated', () => {
    const items = new ItemIndex();
    const key = itemKey('401', supplierKey, 'F-2', 'RON');
    items.set(key, '00000000-0000-4000-8000-000000000401');
    const invoice = posted(
      translate(
        filed(
          [
            transaction('T12', '2026-01-26', [
              line('628', 'debit', '100.00'),
              line('401', 'credit', '100.00', { customer: '0', supplier }),
            ]),
          ],
          {
            purchases: [
              {
                number: 'F-2',
                party: { id: supplier },
                account: '401',
                transaction: 'T12',
                lines: [],
              },
            ],
          },
        ),
        items,
      ),
    );
    expect(invoice.reused).toEqual([
      { line: 1, account: '401', party: supplierKey, document: 'F-2' },
    ]);
    expect(invoice.input.lines[1]).toMatchObject({ newItem: 'i1' });
    expect(invoice.newItems).toEqual([{ ref: 'i1', key }]);
    // Posting the second item makes the key ambiguous: neither item is found by it again.
    items.set(key, '00000000-0000-4000-8000-000000000402');
    expect(items.isAmbiguous(key)).toBe(true);
    expect(items.get(key)).toBeUndefined();
    const payment = posted(
      translate(
        filed(
          [
            transaction('T13', '2026-01-28', [
              line('401', 'debit', '100.00', { customer: '0', supplier }),
              line('5121', 'credit', '100.00'),
            ]),
          ],
          {
            payments: [
              {
                transaction: 'T13',
                lines: [
                  {
                    account: '401',
                    supplier,
                    customer: '0',
                    document: 'F-2',
                    side: 'credit',
                    amount: { amount: '100.00' },
                  },
                ],
              },
            ],
          },
        ),
        items,
      ),
    );
    expect(payment.input.lines[0]).toMatchObject({ newItem: 'i1' });
    expect(payment.newItems).toEqual([
      { ref: 'i1', key: itemKey('401', supplierKey, null, 'RON') },
    ]);
    expect(payment.settlements).toEqual([
      expect.objectContaining({
        reason: 'SETTLEMENT_DOCUMENT_AMBIGUOUS',
        class: 'source-inconsistency',
      }),
    ]);
  });

  test("a partnerless control line takes the mapping's placeholder party", () => {
    const closing = transaction('T7', '2026-01-31', [
      line('4427', 'debit', '210.00', { tax: [marker('380200')] }),
      line('4426', 'credit', '105.00', { tax: [marker('380200')] }),
      line('4423', 'credit', '105.00'),
    ]);
    const result = posted(translate(filed([closing])));
    expect(closing.lines[2]!.customer).toBe(own);
    expect(result.input.lines).toEqual([
      expect.objectContaining({ taxSettlement: { tax: 'VAT', period: '2026-01' } }),
      expect.objectContaining({ taxSettlement: { tax: 'VAT', period: '2026-01' } }),
      expect.objectContaining({
        account: '4423',
        partyId: partyId(placeholderKey('4423')),
        newItem: 'i1',
      }),
    ]);
    expect(result.input.taxEntries).toEqual([]);
  });

  test('a cash-VAT release books its two marked lines without amounts of their own', () => {
    const result = posted(
      translate(
        filed([
          transaction('T8', '2026-01-22', [
            line('4426', 'debit', '25.00', { tax: [marker('301104')] }),
            line('4428', 'credit', '25.00', { tax: [marker('301305')] }),
          ]),
        ]),
      ),
    );
    expect(
      result.input.taxEntries.map(
        ({ line, booked, amount, deductible, exigibility, taxPeriod }) => ({
          line,
          booked,
          amount,
          deductible,
          exigibility: exigibility as string | null,
          taxPeriod,
        }),
      ),
    ).toEqual([
      {
        line: 0,
        booked: '25.00',
        amount: '0.00',
        deductible: '25.00',
        exigibility: '2026-01-22',
        taxPeriod: '2026-01',
      },
      {
        line: 1,
        booked: '-25.00',
        amount: '0.00',
        deductible: '-25.00',
        exigibility: null,
        taxPeriod: null,
      },
    ]);
  });

  test('SAGA placeholders and markers are not tax facts; other taxes are', () => {
    expect(blockRole({ type: '000', code: '000000', amount: '0.00' })).toBe('placeholder');
    expect(blockRole(marker('300704'))).toBe('marker');
    expect(blockRole(marker('380200'))).toBe('closing');
    expect(blockRole(vat('301104', '10.00', '2.10'))).toBe('operation');
    expect(blockRole({ type: '604', code: '604020', amount: '0.00' })).toBe('marker');
    expect(blockRole({ type: '604', code: '604020', base: '10.00', amount: '1.00' })).toBe('other');
  });
});

describe('lab assumptions', () => {
  test('an accepted placeholder clears its blocker; an unknown entry is refused', () => {
    const books = filed([sale]);
    const mapping = replayMapping(false);
    expect(applyLabAssumptions(mapping, [books]).blockers.map((p) => p.code)).toContain(
      'PLACEHOLDER_UNCONFIRMED',
    );
    const assumptions = labAssumptionsSchema.parse({
      schemaVersion: 1,
      statedBy: 'test',
      accept: ['4423', '4426', '4427', '4428'].map((sourceAccountId) => ({
        kind: 'placeholder',
        sourceAccountId,
      })),
    });
    const result = applyLabAssumptions(mapping, [books], assumptions);
    expect(result.blockers.filter((p) => p.code === 'PLACEHOLDER_UNCONFIRMED')).toEqual([]);
    expect(result.waived.map((p) => p.assumption)).toEqual([
      'accept.0',
      'accept.1',
      'accept.2',
      'accept.3',
    ]);
    expect(mapping.placeholders.every((p) => !p.confirmedByPerson)).toBe(true);
    // A placeholder's acceptance concerns the balances of the account bound to it, and is no
    // assumption about the account's mapping.
    const assumed = new ReplayMapping(result.mapping, result.applied);
    expect(assumed.placeholderAccountAssumptions('4423')).toEqual(['accept.0']);
    expect(assumed.isAccountAssumption('accept.0')).toBe(false);
    expect(() =>
      applyLabAssumptions(mapping, [books], {
        ...assumptions,
        accept: [{ kind: 'placeholder', sourceAccountId: '9999' }],
      }),
    ).toThrow('ASSUMPTION_ENTRY_UNKNOWN');
    expect(() =>
      applyLabAssumptions(mapping, [books], {
        ...assumptions,
        accounts: [
          {
            sourceId: '628',
            target: { kind: 'synthetic', code: '628', name: 'Cont 628' },
            party: null,
          },
        ],
      }),
    ).toThrow('ASSUMPTION_TARGET_NOT_UNRESOLVED');
  });
});
