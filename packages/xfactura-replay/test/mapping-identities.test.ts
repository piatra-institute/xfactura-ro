import { describe, expect, test } from 'bun:test';
import { isValidCnp } from 'xfactura-core/ro/identifiers';
import { checkMapping, mappingSchema, proposeMapping, type SagaDump } from '../src/mapping';
import { collectSources } from '../src/mapping/sources';
import {
  mappingChart,
  mappingFiled,
  sourceAccount,
  sourceLine,
  sourcePartner,
} from './fixtures/mapping';

const own = '0090000001';
const marker = `<CustomerID>${own}</CustomerID><SupplierID>${own}</SupplierID>`;
const saga: SagaDump = {
  accounts: [],
  partners: [
    {
      source: { origin: 'saga', role: 'supplier', id: 'SUP2' },
      account: '401.A',
      saftId: '0090000002',
      taxId: 'RO90000002',
      country: 'RO',
      name: 'Furnizor inventat',
    },
  ],
};

describe('source identity regressions', () => {
  test('own-company markers in journals, transactions and payments are absence, not partners', () => {
    const file = mappingFiled({
      accounts: sourceAccount('401A', '401.A') + sourceAccount('421A', '421.A'),
      transaction: marker,
      lines: sourceLine('401A', marker) + sourceLine('421A', marker),
      documents: `<Payments><Payment><PaymentLine><AccountID>401A</AccountID>${marker}</PaymentLine>
        <PaymentLine><AccountID>421A</AccountID>${marker}</PaymentLine></Payment></Payments>`,
    });
    const sources = collectSources([file]);
    expect(sources.partners.size).toBe(0);
    expect(sources.references.filter((r) => r.kind === 'partner')).toEqual([]);
    expect(sources.uses.every((use) => use.partners.length === 0)).toBe(true);
    const mapping = proposeMapping([file], mappingChart, [], undefined, { saga });
    expect(mapping.accounts.find((a) => a.sourceId === '401A')).toMatchObject({
      decidedBy: 'rule:control-saga-party',
      target: { party: { kind: 'source', source: { origin: 'saga', id: 'SUP2' } } },
    });
    expect(mapping.accounts.find((a) => a.sourceId === '421A')).toMatchObject({
      decidedBy: 'rule:control-placeholder',
      target: { party: { kind: 'placeholder' } },
    });
    expect(mapping.partners).toHaveLength(1);
    expect(mapping.placeholders).toHaveLength(1);
    expect(checkMapping(mapping, [file])).toEqual([
      { code: 'PLACEHOLDER_UNCONFIRMED', path: 'placeholders.0' },
    ]);
  });

  test('a marker-only line does not inherit a transaction counterparty', () => {
    const file = mappingFiled({
      accounts: sourceAccount('421A', '421.A') + sourceAccount('628', '628'),
      suppliers: sourcePartner('Supplier', '0090000002', '628'),
      transaction: '<SupplierID>0090000002</SupplierID>',
      lines: sourceLine('421A', marker),
    });
    expect(collectSources([file]).uses[0]!.partners).toEqual([]);
    expect(
      proposeMapping([file], mappingChart, []).accounts.find((a) => a.sourceId === '421A')
        ?.decidedBy,
    ).toBe('rule:control-placeholder');
  });

  test('an explicit customer on an associate payable wins over inherited suppliers and account fallbacks', () => {
    const chart = [...mappingChart, { code: '4551', name: 'Asociați', postable: true }];
    const file = mappingFiled({
      accounts: sourceAccount('4551A', '4551.A') + sourceAccount('628', '628'),
      customers: sourcePartner('Customer', '0090000002', '628'),
      suppliers: sourcePartner('Supplier', '0090000003', '4551A'),
      transaction: '<SupplierID>0090000003</SupplierID>',
      lines: sourceLine('4551A', '<CustomerID>0090000002</CustomerID>'),
    });
    expect(collectSources([file]).uses[0]!.partners).toEqual([
      { origin: 'd406', role: 'customer', id: '0090000002' },
    ]);
    const mapping = proposeMapping([file], chart, []);
    expect(mapping.accounts.find((a) => a.sourceId === '4551A')!.target).toMatchObject({
      party: { kind: 'line' },
    });
    expect(checkMapping(mapping, [file])).toEqual([]);
  });

  test('conflicting explicit identities block despite a supplier fallback or a person account binding', () => {
    const file = mappingFiled({
      accounts: sourceAccount('401A', '401.A') + sourceAccount('628', '628'),
      customers: sourcePartner('Customer', '0090000002', '628'),
      suppliers: sourcePartner('Supplier', '0090000003', '401A'),
      lines: sourceLine(
        '401A',
        '<CustomerID>0090000002</CustomerID><SupplierID>0090000003</SupplierID>',
      ),
    });
    const mapping = proposeMapping([file], mappingChart, []);
    expect(mapping.accounts.find((a) => a.sourceId === '401A')!.target).toEqual({
      status: 'unresolved',
      reason: 'ACCOUNT_PARTNER_AMBIGUOUS',
    });
    const account = mapping.accounts.find((a) => a.sourceId === '401A')!;
    account.decidedBy = 'person';
    account.confirmedByPerson = true;
    account.target = {
      status: 'mapped',
      account: { kind: 'synthetic', code: '401', name: 'Furnizori' },
      party: { kind: 'source', source: { origin: 'd406', role: 'supplier', id: '0090000003' } },
      requiresOpenItem: true,
    };
    expect(checkMapping(mapping, [file])).toContainEqual({
      code: 'LINE_PARTNER_AMBIGUOUS',
      path: 'filed.0.generalLedgerEntries.journals.0.transactions.0.lines.0',
    });
  });

  test('a real party beside a company marker wins over a SAGA fallback', () => {
    const file = mappingFiled({
      accounts: sourceAccount('401A', '401.A') + sourceAccount('628', '628'),
      customers: sourcePartner('Customer', '0090000003', '628'),
      lines: sourceLine(
        '401A',
        `<CustomerID>0090000003</CustomerID><SupplierID>${own}</SupplierID>`,
      ),
    });
    const mapping = proposeMapping([file], mappingChart, [], undefined, { saga });
    expect(mapping.partners).toHaveLength(1);
    expect(mapping.accounts.find((a) => a.sourceId === '401A')!.target).toMatchObject({
      party: { kind: 'line' },
    });
    expect(checkMapping(mapping, [file])).toEqual([]);
  });

  test('a SAGA C_SAFT link to a D406 party cannot hide a different COD_FISCAL', () => {
    const file = mappingFiled({
      accounts: sourceAccount('401A', '401.A') + sourceAccount('628', '628'),
      suppliers: sourcePartner('Supplier', '0090000002', '628'),
      lines: sourceLine('401A', marker),
    });
    const conflicting = structuredClone(saga);
    conflicting.partners[0]!.taxId = 'RO90000003';
    const mapping = proposeMapping([file], mappingChart, [], undefined, { saga: conflicting });
    const rejected = mapping.partners.find((p) => p.source.origin === 'saga');
    expect(rejected?.target).toEqual({ status: 'unresolved', reason: 'PARTNER_IDENTITY_CONFLICT' });
    expect(mapping.accounts.find((a) => a.sourceId === '401A')!.target).toMatchObject({
      party: { kind: 'source', source: { origin: 'saga', id: 'SUP2' } },
    });
    expect(checkMapping(mapping, [file]).some((p) => p.code === 'PARTNER_IDENTITY_CONFLICT')).toBe(
      true,
    );
  });

  test('required invoice IDs cannot use the optional 0 sentinel', () => {
    const file = mappingFiled({
      lines: sourceLine('628', '<CustomerID>0</CustomerID><SupplierID>0</SupplierID>'),
      documents: `<SalesInvoices><Invoice><CustomerInfo><CustomerID>0</CustomerID></CustomerInfo>
        <InvoiceLine><AccountID>628</AccountID></InvoiceLine></Invoice></SalesInvoices>
        <PurchaseInvoices><Invoice><SupplierInfo><SupplierID>0</SupplierID></SupplierInfo>
        <InvoiceLine><AccountID>628</AccountID></InvoiceLine></Invoice></PurchaseInvoices>
        <Payments><Payment><PaymentLine><AccountID>628</AccountID><SupplierID>0</SupplierID></PaymentLine></Payment></Payments>`,
    });
    const mapping = proposeMapping([file], mappingChart, []);
    expect(checkMapping(mapping, [file])).toEqual([
      {
        code: 'SOURCE_ID_MISSING',
        path: 'filed.0.sourceDocuments.salesInvoices.invoices.0.party.id',
      },
      {
        code: 'SOURCE_ID_MISSING',
        path: 'filed.0.sourceDocuments.purchaseInvoices.invoices.0.party.id',
      },
    ]);
    expect(mapping.partners).toEqual([]);
  });

  test('a SAF-T 09 NIF the party operation cannot create stays unresolved', () => {
    const cnp = '1900101123457';
    expect(isValidCnp(cnp)).toBe(true);
    for (const identifier of ['09' + '1900101123456', '03' + '1900101123456']) {
      const file = mappingFiled({ customers: sourcePartner('Customer', identifier, '628') });
      expect(proposeMapping([file], mappingChart, []).partners[0]!.target).toEqual({
        status: 'unresolved',
        reason: 'PARTNER_PARTIES_CREATE_REQUIRES_CNP',
      });
    }
    const foreign = mappingFiled({
      customers: sourcePartner('Customer', '09' + '1900101123456', '628', { country: 'US' }),
    });
    expect(proposeMapping([foreign], mappingChart, []).partners[0]!.target).toEqual({
      status: 'unresolved',
      reason: 'PARTNER_PARTIES_CREATE_REQUIRES_CNP',
    });
    const valid = mappingFiled({ customers: sourcePartner('Customer', '09' + cnp, '628') });
    expect(proposeMapping([valid], mappingChart, []).partners[0]!.target).toMatchObject({
      party: { action: 'create', kind: 'ro_individual', taxId: cnp },
    });
  });

  test.each(['628.A', '401.00001', '5121.A.B'])(
    'a dotted code cannot masquerade as synthetic: %s',
    (code) => {
      const mapping = proposeMapping([mappingFiled()], mappingChart, []);
      const target = mapping.accounts[0]!.target;
      if (target.status !== 'mapped') throw new Error('fixture');
      target.account = { kind: 'synthetic', code, name: 'Cont inventat' };
      expect(mappingSchema.safeParse(mapping).success).toBe(false);
    },
  );
});
