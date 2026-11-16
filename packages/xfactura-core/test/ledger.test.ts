import { describe, expect, test } from 'bun:test';
import type { DocumentRecord, Loaded } from '../src/kernel';
import { roRegister } from '../src/ro/register';
import { emptyLoaded } from '../src/ro/reviews/specs/world';
import {
  generalJournal,
  generalJournalInput,
  type GeneralJournalInput,
} from '../src/ro/treatments/ledger';
import { RuleContext } from '../src/rules';
import { parseLocalDate } from '../src/time';

const evidenceId = '00000000-0000-4000-8000-000000000001';
const partyId = '00000000-0000-4000-8000-000000000002';
const documentId = '00000000-0000-4000-8000-000000000003';
const copyId = '00000000-0000-4000-8000-000000000004';
const entryId = '00000000-0000-4000-8000-000000000005';
const date = parseLocalDate('2026-01-01');
const input = (): GeneralJournalInput =>
  generalJournalInput.parse({
    date,
    purpose: 'opening',
    reference: 'OPENING-2026',
    description: 'Poziție sintetică de deschidere',
    evidenceId,
    lines: [
      { account: '4111', side: 'D', amount: '121.00', newItem: 'customer' },
      { account: '1012', side: 'C', amount: '121.00' },
    ],
    newItems: [{ ref: 'customer', partyId, documentId }],
  });
const document: DocumentRecord = {
  id: documentId,
  kind: 'invoice.issued',
  schema: 'invoice',
  body: {},
  bodyHash: 'synthetic',
  docDate: parseLocalDate('2025-12-01'),
  partyId,
  currency: 'RON',
  number: 'SYN-1',
  evidenceId: null,
};
function loaded(documents: DocumentRecord[] = [document]): Loaded {
  return {
    ...emptyLoaded([]),
    years: [{ id: 'year', kind: 'financial', from: date, to: parseLocalDate('2026-12-31') }],
    evidence: new Map([
      [
        evidenceId,
        {
          id: evidenceId,
          hash: 'synthetic',
          filename: 'balanta.pdf',
          mediaType: 'application/pdf',
        },
      ],
    ]),
    parties: new Map([
      [
        partyId,
        {
          id: partyId,
          kind: 'ro_legal_entity',
          country: 'RO',
          taxId: '87654321',
          name: 'Client sintetic SRL',
        },
      ],
    ]),
    documents: new Map(documents.map((record) => [record.id, record])),
  };
}
const evaluate = (value = input(), state = loaded()) =>
  generalJournal.evaluate(value, state, new RuleContext(roRegister(), 'preview'));

describe('ledger.general opening documents', () => {
  test('declares its document reads and carries the document on the item without tax entries', () => {
    const plan = generalJournal.plan(input());
    expect(plan.documents).toEqual([documentId]);
    expect(plan.documentBookings).toEqual([documentId]);
    const result = evaluate();
    expect(result.issues).toEqual([]);
    expect(result.effect?.openItems[0]).toMatchObject({ documentId, partyId, kind: 'receivable' });
    expect(result.effect?.taxEntries).toEqual([]);
    expect(generalJournal.version).toBe(1);
  });

  test('refuses a missing document or a different partner', () => {
    expect(evaluate(input(), loaded([])).issues).toMatchObject([{ code: 'DOCUMENT' }]);
    expect(evaluate(input(), loaded([{ ...document, partyId: entryId }])).issues).toMatchObject([
      { code: 'DOCUMENT_PARTY', path: 'newItems.0.documentId' },
    ]);
  });

  test.each(['general', 'adjustment'] as const)('refuses a document on a %s entry', (purpose) => {
    const result = evaluate({ ...input(), purpose });
    expect(result.issues).toMatchObject([{ code: 'OPENING_DOCUMENT_ONLY' }]);
    expect(result.effect?.openItems[0]?.documentId).toBeUndefined();
  });

  test.each([false, true])(
    'refuses two items of the same kind for a document (copy: %s)',
    (copy) => {
      const value = input();
      value.lines.push({ account: '4111', side: 'D', amount: '121.00', newItem: 'another' });
      value.lines[1]!.amount = '242.00';
      value.newItems.push({ ref: 'another', partyId, documentId: copy ? copyId : documentId });
      const result = evaluate(
        value,
        loaded([document, { ...document, id: copyId, groupId: documentId }]),
      );
      expect(result.issues).toMatchObject([{ code: 'DUPLICATE_DOCUMENT' }]);
    },
  );

  test('allows different item kinds to name the same document', () => {
    const value = input();
    value.lines[1] = { account: '401', side: 'C', amount: '121.00', newItem: 'supplier' };
    value.newItems.push({ ref: 'supplier', partyId, documentId });
    expect(evaluate(value).issues).toEqual([]);
  });

  test('refuses an already booked document and names the carrying entry', () => {
    const result = evaluate(
      input(),
      loaded([{ ...document, booking: { entryId, number: 7, opening: false } }]),
    );
    expect(result.issues).toMatchObject([
      { code: 'DOCUMENT_BOOKED', details: { documentId, entryId } },
    ]);
    expect(result.issues[0]?.message).toContain(entryId);
  });

  test('validates the optional identifier and leaves document-free plans unchanged', () => {
    const value = input();
    expect(
      generalJournalInput.safeParse({
        ...value,
        newItems: [{ ...value.newItems[0], documentId: 'invalid' }],
      }).success,
    ).toBe(false);
    delete value.newItems[0]!.documentId;
    expect(generalJournal.plan(value)).toEqual({
      evidence: [evidenceId],
      openItems: [{ ids: [] }],
      parties: [partyId],
    });
    expect(evaluate(value).effect?.openItems[0]?.documentId).toBeUndefined();
  });
});
