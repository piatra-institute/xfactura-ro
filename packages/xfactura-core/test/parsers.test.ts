import { describe, expect, test } from 'bun:test';
import {
  checkedStatements,
  entrySourceId,
  statementsAdjoin,
  statementsOverlap,
} from '../src/bank/statement-document';
import { parseCamt } from '../src/bank/camt';
import { parseMt940 } from '../src/bank/mt940';
import { parseInvoiceXml } from '../src/ubl/invoice-document';
import { camt, camtEntry, iban, mt940 } from './fixtures/bank';
import { invoiceXml } from './fixtures/invoice';
import { allowanceInvoiceXml } from './fixtures/invoice-allowance';
import { negativeInvoiceXml } from './fixtures/negative-invoice';

const bytes = (text: string) => new TextEncoder().encode(text);
const year = { from: '2026-01-01', to: '2026-12-31' };

describe('UBL invoices', () => {
  test('reads a domestic invoice and its totals', () => {
    const invoice = parseInvoiceXml(bytes(invoiceXml({ number: 'F-7', date: '2026-03-10' })));
    expect(invoice).toMatchObject({
      documentType: 'invoice',
      number: 'F-7',
      issueDate: '2026-03-10',
      currency: 'RON',
      supplier: { taxId: '87654321', country: 'RO' },
      customer: { taxId: '12345678', country: 'RO' },
      taxes: [{ base: '100.00', tax: '21.00', category: 'S', rate: '21' }],
      totals: { net: '100.00', tax: '21.00', gross: '121.00', payable: '121.00' },
    });
  });

  test('marks an invoice whose note (BT-22) carries the mention «TVA la încasare»', () => {
    const noted = (note: string) =>
      parseInvoiceXml(
        bytes(
          invoiceXml().replace(
            '<cbc:DocumentCurrencyCode>',
            `<cbc:Note>${note}</cbc:Note><cbc:DocumentCurrencyCode>`,
          ),
        ),
      );
    expect(noted('Plata la 30 de zile # TVA la încasare').vatOnCollection).toBe(true);
    expect(noted('Plata la 30 de zile')).not.toHaveProperty('vatOnCollection');
    expect(parseInvoiceXml(bytes(invoiceXml()))).not.toHaveProperty('vatOnCollection');
  });

  test('reads credit notes, negative invoices and document allowances', () => {
    expect(
      parseInvoiceXml(bytes(invoiceXml({ credit: true, originalNumber: 'F-1' }))),
    ).toMatchObject({
      documentType: 'credit_note',
      originalInvoiceNumber: 'F-1',
    });
    const negative = parseInvoiceXml(bytes(negativeInvoiceXml()));
    expect([negative.documentType, negative.parserVersion]).toEqual([
      'credit_note',
      'ubl-invoice-4',
    ]);
    const allowance = parseInvoiceXml(bytes(allowanceInvoiceXml()));
    expect(allowance.parserVersion).toBe('ubl-invoice-3');
    expect(allowance.documentAdjustments?.[0]?.charge).toBe(false);
  });

  test('refuses inconsistent totals, unsafe XML and other encodings', () => {
    expect(() => parseInvoiceXml(bytes(invoiceXml({ gross: '122.00' })))).toThrow();
    expect(() =>
      parseInvoiceXml(bytes(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "e">]><Invoice/>`)),
    ).toThrow();
    expect(() => parseInvoiceXml(new Uint8Array([0xff, 0xfe, 0x00]))).toThrow();
  });
});

describe('bank statements', () => {
  test('MT940 statements balance and carry stable entry identities', () => {
    const [statement] = checkedStatements(parseMt940(mt940, year), year);
    expect(statement).toMatchObject({ bankAccount: iban, opening: '1000.00', closing: '947.97' });
    expect(statement!.entries.map((entry) => entry.amount)).toEqual(['-100.00', '-2.03', '50.00']);
    const ids = statement!.entries.map((entry) => entrySourceId(statement!, entry));
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(
      checkedStatements(parseMt940(mt940, year), year)[0]!.entries.map((entry) =>
        entrySourceId(statement!, entry),
      ),
    );
  });

  test('camt.053 statements must reconcile opening, entries and closing', () => {
    const entry = camtEntry({ amount: '25.00', direction: 'CRDT', bankRef: 'INC-1' });
    expect(
      checkedStatements(parseCamt(bytes(camt({ entries: entry, closing: '1025.00' }))), year),
    ).toHaveLength(1);
    expect(() =>
      checkedStatements(parseCamt(bytes(camt({ entries: entry, closing: '1024.00' }))), year),
    ).toThrow();
  });

  test('statements of one account overlap, hand over or adjoin', () => {
    const span = (from: string, to: string, movesOnFrom = false) => ({ from, to, movesOnFrom });
    const october = span('2026-10-01', '2026-10-31');
    const followers = {
      nextDay: span('2026-11-01', '2026-11-30'),
      handOver: span('2026-10-31', '2026-11-30'),
      handOverReporting: span('2026-10-31', '2026-11-30', true),
      sameDayOnly: span('2026-10-31', '2026-10-31'),
      partial: span('2026-10-15', '2026-11-15'),
      afterGap: span('2026-11-02', '2026-11-30'),
    };
    expect(
      Object.entries(followers).map(([name, later]) => [
        name,
        statementsOverlap(october, later),
        !statementsOverlap(october, later) && statementsAdjoin(october, later),
      ]),
    ).toEqual([
      ['nextDay', false, true],
      ['handOver', false, true],
      ['handOverReporting', true, false],
      ['sameDayOnly', true, false],
      ['partial', true, false],
      ['afterGap', false, false],
    ]);
    expect(statementsOverlap(span('2026-10-05', '2026-10-05', true), october)).toBe(true);
    expect(
      statementsAdjoin(span('2026-12-01', '2026-12-31'), span('2027-01-01', '2027-01-31')),
    ).toBe(true);
  });
});
