import { describe, expect, test } from 'bun:test';
import type { PartyRecord } from 'xfactura-core/kernel';
import {
  checkMapping,
  mappingSchema,
  mappingJsonSchema,
  mappingSummary,
  proposeMapping,
  type Mapping,
  type SagaDump,
} from '../src/mapping';
import {
  mappingChart,
  mappingFiled,
  sourceAccount,
  sourceLine,
  sourcePartner,
} from './fixtures/mapping';

const existing: PartyRecord = {
  id: 'existing-party',
  kind: 'ro_legal_entity',
  country: 'RO',
  taxId: ' ro 90000002 ',
  name: 'Altă etichetă',
};
const payable = () =>
  mappingFiled({
    accounts: sourceAccount('40100002', '401.00002'),
    suppliers: sourcePartner('Supplier', '0090000002', '40100002'),
    lines: sourceLine('40100002'),
  });
const propose = (files = [mappingFiled()]) => proposeMapping(files, mappingChart, []);
const codes = (mapping: Mapping, files: ReturnType<typeof mappingFiled>[]) =>
  checkMapping(mapping, files).map((p) => p.code);

describe('mapping proposal rules', () => {
  test('synthetics use the chart, ordinary analytics preserve the full standard spelling', () => {
    const file = mappingFiled({
      accounts: sourceAccount('628', '628') + sourceAccount('512100001', '5121.00001'),
    });
    const mapping = propose([file]);
    expect(mapping.accounts.find((a) => a.sourceId === '628')).toMatchObject({
      decidedBy: 'rule:account-synthetic',
      confirmedByPerson: false,
      target: { status: 'mapped', account: { kind: 'synthetic', code: '628' } },
    });
    expect(mapping.accounts.find((a) => a.sourceId === '512100001')).toMatchObject({
      decidedBy: 'rule:account-analytic',
      target: {
        account: { kind: 'analytic', action: 'create', code: '5121.00001', name: 'Cont inventat' },
        party: null,
      },
    });
    expect(checkMapping(mapping, [file])).toEqual([]);
    const withAnalytic = proposeMapping(
      [file],
      [...mappingChart, { code: '5121.00001', name: 'Cont existent', postable: true }],
      [],
    );
    expect(withAnalytic.accounts[0]!.target).toMatchObject({ account: { action: 'existing' } });
  });

  test('control analytics bind the master-file partner and the synthetic, with an open item', () => {
    const file = payable();
    const mapping = proposeMapping([file], mappingChart, [existing]);
    expect(mapping.accounts[0]).toMatchObject({
      controlKind: 'payable',
      decidedBy: 'rule:control-master-party',
      target: {
        account: { kind: 'synthetic', code: '401' },
        requiresOpenItem: true,
        party: { kind: 'source', source: { origin: 'd406', role: 'supplier', id: '0090000002' } },
      },
    });
    expect(mapping.partners[0]).toMatchObject({
      decidedBy: 'rule:partner-fiscal-match',
      target: { party: { action: 'existing', id: existing.id } },
    });
    expect(checkMapping(mapping, [file])).toEqual([]);
  });

  test('postable off-balance synthetics map, while unsupported analytic creation blocks', () => {
    const chart = [
      ...mappingChart,
      { code: '8031', name: 'Cont extrabilanțier', postable: true, book: 'off_balance' },
    ];
    const file = mappingFiled({
      accounts: sourceAccount('OFF', '8031') + sourceAccount('OFFA', '8031.A'),
    });
    const mapping = proposeMapping([file], chart, []);
    expect(mapping.accounts[0]!.target).toMatchObject({
      account: { kind: 'synthetic', code: '8031' },
    });
    expect(mapping.accounts[1]!.target).toEqual({
      status: 'unresolved',
      reason: 'ACCOUNT_ANALYTIC_UNSUPPORTED',
    });
  });

  test('a new fiscal identity has one creation key across customer and supplier roles', () => {
    const file = mappingFiled({
      customers: sourcePartner('Customer', '0090000002', '628', { name: 'Client inventat' }),
      suppliers: sourcePartner('Supplier', '0090000002', '628', { name: 'Furnizor inventat' }),
    });
    const mapping = propose([file]);
    expect(mapping.partners).toHaveLength(2);
    expect(mapping.partners.every((p) => p.decidedBy === 'rule:partner-fiscal-create')).toBe(true);
    expect(mapping.partners[0]!.target).toEqual(mapping.partners[1]!.target);
    expect(mapping.partners[0]!.target).toMatchObject({
      party: {
        action: 'create',
        kind: 'ro_legal_entity',
        country: 'RO',
        taxId: '90000002',
        name: 'Client inventat',
      },
    });
    expect(checkMapping(mapping, [file])).toEqual([]);
  });

  test('partners without fiscal codes use scoped source IDs, even when names coincide', () => {
    const file = mappingFiled({
      customers:
        sourcePartner('Customer', '04PERSONA', '628', { name: existing.name }) +
        sourcePartner('Customer', '04PERSONB', '628', { name: existing.name }),
      suppliers: sourcePartner('Supplier', '04PERSONA', '628', { name: existing.name }),
    });
    const mapping = proposeMapping([file], mappingChart, [existing]);
    const keys = mapping.partners.map((p) => {
      expect(p.decidedBy).toBe('rule:partner-source-id');
      expect(p.target).toMatchObject({
        party: { action: 'create', kind: 'ro_individual', taxId: null },
      });
      return p.target.status === 'mapped' && p.target.party.action === 'create'
        ? p.target.party.key
        : '';
    });
    expect(new Set(keys).size).toBe(3);
    expect(checkMapping(mapping, [file])).toEqual([]);
  });

  test('foreign internal IDs are not fiscal codes; unsupported EU non-VAT kinds stay unknown', () => {
    const file = mappingFiled({
      suppliers:
        sourcePartner('Supplier', '06USVENDOR', '628', { country: 'US' }) +
        sourcePartner('Supplier', '05DEOPERATOR', '628', { country: 'DE' }),
    });
    const mapping = propose([file]);
    expect(mapping.partners.find((p) => p.source.id === '06USVENDOR')?.target).toMatchObject({
      party: { action: 'create', kind: 'non_eu', country: 'US', taxId: null },
    });
    expect(mapping.partners.find((p) => p.source.id === '05DEOPERATOR')?.target).toEqual({
      status: 'unresolved',
      reason: 'PARTNER_KIND_UNSUPPORTED',
    });
  });

  test('foreign fiscal matching is country scoped and ambiguous existing identities block', () => {
    const file = mappingFiled({
      suppliers: sourcePartner('Supplier', '01DE900002', '628', { country: 'DE' }),
    });
    const party: PartyRecord = {
      ...existing,
      country: 'DE',
      taxId: 'de 900002',
      kind: 'eu_taxable',
    };
    expect(proposeMapping([file], mappingChart, [party]).partners[0]!.target).toEqual({
      status: 'mapped',
      party: { action: 'existing', id: party.id },
    });
    expect(
      proposeMapping([file], mappingChart, [{ ...party, country: 'FR' }]).partners[0]!.decidedBy,
    ).toBe('rule:partner-fiscal-create');
    expect(
      proposeMapping([file], mappingChart, [party, { ...party, id: 'duplicate' }]).partners[0]!
        .target,
    ).toEqual({ status: 'unresolved', reason: 'PARTNER_FISCAL_CODE_AMBIGUOUS' });
  });

  test('Greece uses the ISO country with its VAT prefix, and non-EU fiscal text stays intact', () => {
    const file = mappingFiled({
      suppliers:
        sourcePartner('Supplier', '01EL900002', '628', { country: 'GR' }) +
        sourcePartner('Supplier', '02USUSCODE', '628', { country: 'US' }),
    });
    const mapping = propose([file]);
    expect(mapping.partners[0]!.target).toMatchObject({
      party: { country: 'GR', taxId: '900002' },
    });
    expect(mapping.partners[1]!.target).toMatchObject({
      party: { country: 'US', taxId: 'USCODE' },
    });
    const conflict = mappingFiled({
      suppliers: sourcePartner('Supplier', '01DE900002', '628', { country: 'FR' }),
    });
    expect(propose([conflict]).partners[0]!.target).toEqual({
      status: 'unresolved',
      reason: 'PARTNER_IDENTITY_CONFLICT',
    });
  });

  test('opaque CNP identities cannot be ruled out or matched by name', () => {
    const file = mappingFiled({ customers: sourcePartner('Customer', '031900101123457', '628') });
    for (const taxId of ['cnp:k1:' + 'a'.repeat(64), '*************']) {
      const mapping = proposeMapping([file], mappingChart, [
        { ...existing, kind: 'ro_individual', taxId },
      ]);
      expect(mapping.partners[0]!.target).toEqual({
        status: 'unresolved',
        reason: 'PARTNER_FISCAL_CODE_OPAQUE',
      });
    }
  });

  test('a shared control uses explicit per-line and inherited transaction partners', () => {
    const file = mappingFiled({
      accounts: sourceAccount('401', '401'),
      suppliers:
        sourcePartner('Supplier', '0090000002', '401') +
        sourcePartner('Supplier', '0090000003', '401'),
      transaction: '<SupplierID>0090000002</SupplierID>',
      lines: sourceLine('401') + sourceLine('401', '<SupplierID>0090000003</SupplierID>'),
    });
    const mapping = propose([file]);
    expect(mapping.accounts[0]).toMatchObject({
      decidedBy: 'rule:control-line-party',
      target: { party: { kind: 'line' } },
    });
    expect(checkMapping(mapping, [file])).toEqual([]);
    const missing = structuredClone(file);
    delete missing.generalLedgerEntries.journals[0]!.transactions[0]!.supplier;
    expect(propose([missing]).accounts[0]!.target).toEqual({
      status: 'unresolved',
      reason: 'ACCOUNT_PARTNER_AMBIGUOUS',
    });
    expect(codes(mapping, [missing])).toContain('LINE_PARTNER_MISSING');
  });

  test('SAGA exact partner/account links fill missing D406 links and preserve its source code', () => {
    const file = mappingFiled({
      accounts: sourceAccount('40100002', '401.00002'),
      lines: sourceLine('40100002'),
    });
    const saga: SagaDump = {
      accounts: [],
      partners: [
        {
          source: { origin: 'saga', role: 'supplier', id: 'SUP2' },
          account: '401.00002',
          saftId: '0090000002',
          taxId: 'RO90000002',
          name: 'Furnizor inventat',
          country: 'RO',
        },
      ],
    };
    const mapping = proposeMapping([file], mappingChart, [], undefined, { saga });
    expect(mapping.accounts[0]).toMatchObject({
      decidedBy: 'rule:control-saga-party',
      target: { party: { kind: 'source', source: { origin: 'saga', id: 'SUP2' } } },
    });
    expect(mapping.partners[0]!.target).toMatchObject({ party: { taxId: '90000002' } });
    expect(checkMapping(mapping, [file])).toEqual([]);
    const missingMaster = structuredClone(file);
    missingMaster.generalLedgerEntries.journals[0]!.transactions[0]!.lines[0]!.supplier =
      '0090000002';
    const fromSaftId = proposeMapping([missingMaster], mappingChart, [], undefined, { saga });
    expect(fromSaftId.partners).toHaveLength(1);
    expect(fromSaftId.partners[0]!.source.origin).toBe('d406');
    expect(checkMapping(fromSaftId, [missingMaster])).toEqual([]);
  });

  test('a missing standard can use an exact SAGA account alias, never a guessed integer prefix', () => {
    const file = mappingFiled({ accounts: sourceAccount('512100001', '') });
    expect(propose([file]).accounts[0]!.target).toEqual({
      status: 'unresolved',
      reason: 'ACCOUNT_STANDARD_MISSING',
    });
    const mapping = proposeMapping([file], mappingChart, [], undefined, {
      saga: { accounts: [{ code: '5121.00001', name: 'Bancă inventată' }], partners: [] },
    });
    expect(mapping.accounts[0]!.target).toMatchObject({
      account: { code: '5121.00001', kind: 'analytic' },
    });
  });

  test('a SAGA program code resembling a SAF-T identity remains an opaque source ID', () => {
    const file = mappingFiled({ accounts: sourceAccount('401A', '401.A') });
    const mapping = proposeMapping([file], mappingChart, [], undefined, {
      saga: {
        accounts: [],
        partners: [
          {
            source: { origin: 'saga', role: 'supplier', id: '0090000002' },
            account: '401.A',
            country: 'RO',
            name: 'Partener fără identitate declarată',
          },
        ],
      },
    });
    expect(mapping.partners[0]!.source.id).toBe('0090000002');
    expect(mapping.partners[0]!.target).toEqual({
      status: 'unresolved',
      reason: 'PARTNER_KIND_UNSUPPORTED',
    });
  });

  test('a coded SAF-T identity and a different declared fiscal code conflict', () => {
    const file = mappingFiled({
      suppliers: sourcePartner('Supplier', '0090000002', '628', { registration: 'RO90000003' }),
    });
    expect(propose([file]).partners[0]!.target).toEqual({
      status: 'unresolved',
      reason: 'PARTNER_IDENTITY_CONFLICT',
    });
  });

  test('one placeholder per company/source account persists, and requires a person to confirm it', () => {
    const file = mappingFiled({
      accounts: sourceAccount('42101', '421.01'),
      lines: sourceLine('42101') + sourceLine('42101', '<CustomerID>0</CustomerID>'),
    });
    const mapping = propose([file, file]);
    expect(mapping.accounts[0]).toMatchObject({
      decidedBy: 'rule:control-placeholder',
      target: { requiresOpenItem: true },
    });
    expect(mapping.placeholders).toHaveLength(1);
    expect(mapping.placeholders[0]).toMatchObject({
      placeholder: true,
      sourceAccountId: '42101',
      confirmedByPerson: false,
      party: { taxId: null, kind: 'ro_individual' },
    });
    expect(codes(mapping, [file])).toEqual(['PLACEHOLDER_UNCONFIRMED']);
    mapping.placeholders[0]!.confirmedByPerson = true;
    expect(checkMapping(mapping, [file])).toEqual([]);
    expect(proposeMapping([file, file], mappingChart, [], mapping)).toEqual(mapping);
    const otherCompany = propose([
      mappingFiled({ accounts: sourceAccount('42101', '421.01'), company: '90000009' }),
    ]);
    expect(otherCompany.placeholders[0]!.party.key).not.toBe(mapping.placeholders[0]!.party.key);
  });

  test('VAT control analytics remain synthetic and need tax explanation rather than an open item', () => {
    const mapping = propose([mappingFiled({ accounts: sourceAccount('4427A', '4427.A') })]);
    expect(mapping.accounts[0]!.target).toMatchObject({
      account: { code: '4427', kind: 'synthetic' },
      requiresOpenItem: false,
    });
  });

  test.each([
    ['', 'ACCOUNT_STANDARD_MISSING'],
    ['9999', 'ACCOUNT_SYNTHETIC_UNKNOWN'],
    ['5121.bad', 'ACCOUNT_CODE_INVALID'],
    ['41', 'ACCOUNT_NOT_POSTABLE'],
  ] as const)('an undecidable account %s records %s', (standard, reason) => {
    expect(
      propose([mappingFiled({ accounts: sourceAccount('SOURCE', standard) })]).accounts[0]!.target,
    ).toEqual({ status: 'unresolved', reason });
  });

  test('conflicting standards or fiscal identities across months never pick a latest version', () => {
    const first = payable();
    const changed = payable();
    changed.masterFiles.accounts[0]!.standard = '4111.00002';
    changed.masterFiles.suppliers[0]!.registrationNumber = '90000003';
    const mapping = propose([first, changed]);
    expect(mapping.accounts[0]!.target).toEqual({
      status: 'unresolved',
      reason: 'ACCOUNT_STANDARD_CONFLICT',
    });
    expect(mapping.partners[0]!.target).toEqual({
      status: 'unresolved',
      reason: 'PARTNER_IDENTITY_CONFLICT',
    });
  });

  test('missing names and countries remain explicit gaps', () => {
    const file = mappingFiled({ accounts: sourceAccount('5121A', '5121.A', '') });
    file.masterFiles.customers.push({ id: 'UNCODED', name: 'Consumator inventat' });
    file.masterFiles.suppliers.push({
      id: '0090000002',
      registrationNumber: '0090000002',
      address: { country: 'RO' },
    });
    const mapping = propose([file]);
    expect(mapping.accounts[0]!.target).toMatchObject({ reason: 'ACCOUNT_NAME_MISSING' });
    expect(mapping.partners.map((p) => p.target)).toContainEqual({
      status: 'unresolved',
      reason: 'PARTNER_COUNTRY_MISSING',
    });
    expect(mapping.partners.map((p) => p.target)).toContainEqual({
      status: 'unresolved',
      reason: 'PARTNER_NAME_MISSING',
    });
  });
});

describe('retained decisions and checks', () => {
  test('prior rule decisions win, a person decision survives, and new-month accounts append', () => {
    const first = payable();
    const previous = propose([first]);
    const original = structuredClone(previous);
    expect(proposeMapping([first], mappingChart, [existing], previous)).toEqual(original);
    previous.partners[0]!.decidedBy = 'person';
    previous.partners[0]!.confirmedByPerson = true;
    previous.partners[0]!.target = {
      status: 'mapped',
      party: { action: 'existing', id: 'chosen-by-person' },
    };
    previous.accounts[0]!.confirmedByPerson = true;
    const later = mappingFiled({ accounts: sourceAccount('5121NEW', '5121.NEW') });
    const updated = proposeMapping([first, later], mappingChart, [existing], previous);
    expect(updated.partners[0]).toEqual(previous.partners[0]);
    expect(updated.accounts[0]).toEqual(previous.accounts[0]);
    expect(updated.accounts[1]).toMatchObject({ sourceId: '5121NEW', confirmedByPerson: false });
    expect(checkMapping(updated, [first, later])).toEqual([]);
    expect(previous).toEqual({ ...updated, accounts: [updated.accounts[0]!] });
  });

  test('only unresolved unconfirmed rule entries can be retried with new evidence', () => {
    const file = mappingFiled({ accounts: sourceAccount('SOURCE', '') });
    const previous = propose([file]);
    const repaired = mappingFiled({ accounts: sourceAccount('SOURCE', '628') });
    expect(proposeMapping([repaired], mappingChart, [], previous).accounts[0]!.decidedBy).toBe(
      'rule:account-synthetic',
    );
    previous.accounts[0]!.decidedBy = 'person';
    previous.accounts[0]!.confirmedByPerson = true;
    expect(proposeMapping([repaired], mappingChart, [], previous).accounts[0]).toEqual(
      previous.accounts[0],
    );
  });

  test('company and source mismatches are rejected before reusing decisions', () => {
    const previous = propose();
    expect(() =>
      proposeMapping([mappingFiled({ company: '90000009' })], mappingChart, [], previous),
    ).toThrow('MAPPING_SOURCE_MISMATCH');
    expect(() =>
      proposeMapping([mappingFiled()], mappingChart, [], previous, { source: 'other' }),
    ).toThrow('MAPPING_SOURCE_MISMATCH');
    expect(() =>
      proposeMapping([mappingFiled(), mappingFiled({ company: '90000009' })], mappingChart, []),
    ).toThrow('MAPPING_COMPANY_MISMATCH');
  });

  test('all journal, invoice and payment references require mapping, including missing masters', () => {
    const file = mappingFiled({
      lines: sourceLine('UNKNOWN-JOURNAL', '<SupplierID>MISSING-JOURNAL</SupplierID>'),
      transaction: '<CustomerID>MISSING-TX</CustomerID>',
      documents: `<SalesInvoices><Invoice><CustomerInfo><CustomerID>MISSING-SALE</CustomerID></CustomerInfo>
        <AccountID>UNKNOWN-INVOICE</AccountID><InvoiceLine><AccountID>UNKNOWN-SALE-LINE</AccountID></InvoiceLine></Invoice></SalesInvoices>
        <PurchaseInvoices><Invoice><SupplierInfo><SupplierID>MISSING-PURCHASE</SupplierID></SupplierInfo>
        <InvoiceLine><AccountID>UNKNOWN-PURCHASE-LINE</AccountID></InvoiceLine></Invoice></PurchaseInvoices>
        <Payments><Payment><PaymentLine><AccountID>UNKNOWN-PAYMENT</AccountID><SupplierID>MISSING-PAYMENT</SupplierID></PaymentLine></Payment></Payments>`,
    });
    const mapping = propose([file]);
    expect(mapping.accounts).toHaveLength(6);
    expect(mapping.partners).toHaveLength(5);
    expect(
      mapping.partners.every(
        (p) => p.target.status === 'unresolved' && p.target.reason === 'PARTNER_MASTER_MISSING',
      ),
    ).toBe(true);
    const incomplete = structuredClone(mapping);
    incomplete.accounts = [];
    incomplete.partners = [];
    const problems = checkMapping(incomplete, [file]);
    for (const section of ['generalLedgerEntries', 'salesInvoices', 'purchaseInvoices', 'payments'])
      expect(problems.some((p) => p.path.includes(section))).toBe(true);
    expect(problems.every((p) => ['ACCOUNT_UNMAPPED', 'PARTNER_UNMAPPED'].includes(p.code))).toBe(
      true,
    );
  });

  test('missing line accounts and invoice partner IDs block without creating guessed identities', () => {
    const file = mappingFiled({
      documents: '<SalesInvoices><Invoice><InvoiceLine/></Invoice></SalesInvoices>',
    });
    expect(codes(propose([file]), [file])).toContain('ACCOUNT_UNMAPPED');
    expect(codes(propose([file]), [file])).toContain('SOURCE_ID_MISSING');
  });

  test('duplicate source entries and incompatible control kinds sharing an engine account are refused', () => {
    const file = mappingFiled({
      accounts: sourceAccount('PAY', '401.A') + sourceAccount('REC', '4111.B'),
    });
    const mapping = propose([file]);
    const payableTarget = mapping.accounts.find((a) => a.sourceId === 'PAY')!.target;
    const receivable = mapping.accounts.find((a) => a.sourceId === 'REC')!;
    if (payableTarget.status !== 'mapped' || receivable.target.status !== 'mapped')
      throw new Error('fixture');
    receivable.target.account = structuredClone(payableTarget.account);
    expect(codes(mapping, [file])).toContain('ACCOUNT_CONTROL_KIND_COLLISION');
    expect(codes(mapping, [file])).toContain('ACCOUNT_CONTROL_KIND_MISMATCH');
    mapping.accounts.push(structuredClone(mapping.accounts[0]!));
    expect(codes(mapping, [file])).toContain('ACCOUNT_MAPPED_TWICE');
    const partners = propose([payable()]);
    partners.partners.push(structuredClone(partners.partners[0]!));
    expect(codes(partners, [payable()])).toContain('PARTNER_MAPPED_TWICE');
  });

  test('preserved decisions do not hide new source control changes or dangling party bindings', () => {
    const file = payable();
    const mapping = propose([file]);
    file.masterFiles.accounts[0]!.standard = '4111.00002';
    expect(codes(mapping, [file])).toContain('SOURCE_CONTROL_KIND_CHANGED');
    expect(codes(mapping, [file])).toContain('SOURCE_ACCOUNT_CHANGED');
    mapping.partners = [];
    expect(codes(mapping, [file])).toContain('PARTNER_UNMAPPED');
  });

  test('person bindings retain explicit conflicts until the source identities map to the same party', () => {
    const file = mappingFiled({
      accounts: sourceAccount('421', '421'),
      customers: sourcePartner('Customer', '04PERSONA', '421'),
      suppliers: sourcePartner('Supplier', '04PERSONB', '421'),
      lines: sourceLine(
        '421',
        '<CustomerID>04PERSONA</CustomerID><SupplierID>04PERSONB</SupplierID>',
      ),
    });
    const mapping = propose([file]);
    const account = mapping.accounts[0]!;
    account.decidedBy = 'person';
    account.confirmedByPerson = true;
    account.target = {
      status: 'mapped',
      account: { kind: 'synthetic', code: '421', name: 'Personal' },
      requiresOpenItem: true,
      party: { kind: 'line' },
    };
    expect(codes(mapping, [file])).toContain('LINE_PARTNER_AMBIGUOUS');
    account.target.party = { kind: 'line', role: 'customer' };
    expect(codes(mapping, [file])).toContain('LINE_PARTNER_AMBIGUOUS');
    account.target.party = {
      kind: 'source',
      source: { origin: 'd406', role: 'supplier', id: '04PERSONB' },
    };
    expect(codes(mapping, [file])).toContain('LINE_PARTNER_AMBIGUOUS');
    for (const partner of mapping.partners) {
      partner.decidedBy = 'person';
      partner.confirmedByPerson = true;
      partner.target = { status: 'mapped', party: { action: 'existing', id: 'chosen-by-person' } };
    }
    expect(checkMapping(mapping, [file])).toEqual([]);
  });

  test('the JSON Schema is generated from the strict versioned Zod schema', async () => {
    const schema = await Bun.file(
      new URL('../src/mapping/mapping.schema.json', import.meta.url),
    ).json();
    expect(schema).toEqual(mappingJsonSchema);
    expect(mappingSchema.safeParse({ ...propose(), schemaVersion: 2 }).success).toBe(false);
    expect(mappingSchema.safeParse({ ...propose(), extra: true }).success).toBe(false);
  });

  test('summary exposes only reason/rule counts and indexed paths', () => {
    const file = mappingFiled({
      accounts: sourceAccount('PERSONAL-ID', '9999', 'Secret display label'),
    });
    const mapping = propose([file]);
    const summary = mappingSummary(mapping, checkMapping(mapping, [file]));
    expect(summary.byRule).toEqual({ 'rule:unresolved': 1 });
    expect(summary.unresolvedByReason).toEqual({ ACCOUNT_SYNTHETIC_UNKNOWN: 1 });
    expect(summary.unresolvedPathsByReason).toEqual({
      ACCOUNT_SYNTHETIC_UNKNOWN: ['accounts.0.target'],
    });
    expect(JSON.stringify(summary)).not.toContain('PERSONAL-ID');
    expect(JSON.stringify(summary)).not.toContain('Secret display label');
    expect(JSON.stringify(summary)).not.toContain('9999');
  });
});
