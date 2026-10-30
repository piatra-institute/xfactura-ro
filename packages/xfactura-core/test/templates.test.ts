import { describe, expect, test } from 'bun:test';
import {
  applyTemplate,
  conforms,
  defaultCriteria,
  effectAmount,
  effectFingerprint,
  effectParties,
  graduation,
  inScope,
  mappedVehicles,
  outcomeOf,
  outcomesByMonth,
  recognitionMapping,
  templateScope,
  type FingerprintEffect,
  type MovementSubject,
  type Outcome,
  type TemplateDefinition,
} from '../src/templates';

// Synthetic ids, amounts and texts, written by hand.
const supplier = '0b8f9e1a-3c4d-4e5f-8a6b-7c8d9e0f1a2b';
const other = '1c9a0f2b-4d5e-4f60-9b7c-8d9e0f1a2b3c';
const documentId = '2d0b1a3c-5e6f-4a71-8c8d-9e0f1a2b3c4d';
const evidenceId = '3e1c2b4d-6f70-4b82-9d9e-0f1a2b3c4d5e';
const movementId = '4f2d3c5e-7081-4c93-8eaf-1a2b3c4d5e6f';
const itemA = '5a3e4d6f-8192-4da4-9fb0-2b3c4d5e6f70';
const itemB = '6b4f5e70-92a3-4eb5-8ac1-3c4d5e6f7081';

const invoiceBody = (overrides: Record<string, unknown> = {}) => ({
  parserVersion: 'ubl-invoice-4',
  documentType: 'invoice',
  number: 'F-100',
  issueDate: '2026-05-05',
  taxPointDate: null,
  currency: 'RON',
  supplier: { name: 'Furnizor SRL', taxId: '87654321', country: 'RO' },
  customer: { name: 'Pilot SRL', taxId: '12345678', country: 'RO' },
  originalInvoiceNumber: null,
  customizationId: 'urn:cen.eu:en16931:2017',
  lines: [
    {
      id: '1',
      description: 'Abonament internet mai',
      net: '100.00',
      vatCategory: 'S',
      vatRate: '21',
    },
  ],
  taxes: [{ base: '100.00', tax: '21.00', category: 'S', rate: '21', exemptionReason: null }],
  totals: {
    lineNet: '100.00',
    net: '100.00',
    tax: '21.00',
    gross: '121.00',
    allowances: '0.00',
    charges: '0.00',
    prepaid: '0.00',
    rounding: '0.00',
    payable: '121.00',
  },
  ...overrides,
});
const document = (overrides: Partial<{ partyId: string; kind: string; body: unknown }> = {}) => ({
  kind: 'document' as const,
  document: {
    id: documentId,
    kind: 'invoice.received',
    partyId: supplier,
    evidenceId,
    body: invoiceBody(),
    ...overrides,
  },
});
const template = (scope: Record<string, unknown>, mapping: unknown): TemplateDefinition => ({
  scope: templateScope.parse(scope),
  mapping,
});
const recognition = (mapping: unknown, extra: Record<string, unknown> = {}) =>
  template(
    {
      treatment: 'invoices.recognize',
      partyId: supplier,
      documentKind: 'invoice.received',
      ...extra,
    },
    mapping,
  );

describe('scope', () => {
  test('a template applies to its partner, document kind and line words only', () => {
    const internet = recognition({ account: '626' }, { linePattern: 'ABONAMENT internet' });
    expect(inScope(internet, document())).toBe(true);
    expect(inScope(internet, document({ partyId: other }))).toBe(false);
    expect(inScope(internet, document({ kind: 'invoice.issued' }))).toBe(false);
    const lines = [
      { id: '1', description: 'Chirie', net: '100.00', vatCategory: 'S', vatRate: '21' },
    ];
    expect(inScope(internet, document({ body: invoiceBody({ lines }) }))).toBe(false);
    // Diacritics and case are ignored.
    const rent = recognition({ account: '612' }, { linePattern: 'chirie spațiu' });
    const rented = [
      {
        id: '1',
        description: 'CHIRIE SPATIU birou',
        net: '100.00',
        vatCategory: 'S',
        vatRate: '21',
      },
    ];
    expect(inScope(rent, document({ body: invoiceBody({ lines: rented }) }))).toBe(true);
  });

  test('a scope names a document kind its treatment reads', () => {
    expect(
      templateScope.safeParse({ treatment: 'bank.settle', documentKind: 'invoice.received' })
        .success,
    ).toBe(false);
    expect(
      templateScope.safeParse({ treatment: 'bank.settle', documentKind: 'movement.paid' }).success,
    ).toBe(true);
  });
});

describe('invoices', () => {
  test('one account: the input names the document, the account and the deduction', () => {
    const internet = recognition({ account: '626' });
    const applied = applyTemplate(internet, document());
    expect(applied).toEqual({
      ok: true,
      input: { documentId, account: '626', deduction: 'full' },
    });
    expect(conforms(internet, { documentId, account: '626' }, document())).toBe(true);
    expect(conforms(internet, { documentId, account: '628' }, document())).toBe(false);
    expect(conforms(internet, { documentId, account: '626', deduction: 'none' })).toBe(false);
  });

  test('shares split each VAT category over accounts, exactly', () => {
    const split = recognition({
      shares: [
        { account: '6022', share: 2 },
        { account: '6021', share: 1, deduction: 'limited' },
      ],
    });
    const applied = applyTemplate(split, document());
    expect(applied).toEqual({
      ok: true,
      input: {
        documentId,
        deduction: 'full',
        allocations: [
          { account: '6022', vat: 'S-21', amount: '66.67', deduction: 'full' },
          { account: '6021', vat: 'S-21', amount: '33.33', deduction: 'limited' },
        ],
      },
    });
    expect(conforms(split, (applied as { input: unknown }).input, document())).toBe(true);
    const moved = {
      documentId,
      allocations: [
        { account: '6022', vat: 'S-21', amount: '50.00' },
        { account: '6021', vat: 'S-21', amount: '50.00', deduction: 'limited' },
      ],
    };
    // The same accounts, other amounts: what the mapping fixes holds, the document says no.
    expect(conforms(split, moved)).toBe(true);
    expect(conforms(split, moved, document())).toBe(false);
  });

  test('a template naming a vehicle deducts what the answer that holds about it allows', () => {
    const lease = recognition({ account: '612', vehicle: 'B-123-XFA' });
    expect(lease.mapping).toEqual({ account: '612', vehicle: 'B-123-XFA' });
    // A vehicle and a fixed deduction together: the answer decides, never the template.
    expect(
      recognitionMapping.safeParse({ account: '612', vehicle: 'B-123-XFA', deduction: 'full' })
        .success,
    ).toBe(false);
    expect(mappedVehicles('invoices.recognize', lease.mapping)).toEqual(['B123XFA']);
    // Without an answer about the vehicle the template cannot say what it deducts.
    expect(applyTemplate(lease, document())).toEqual({ ok: false, reason: 'vehicle' });
    const mixed = { ...document(), vehicles: { B123XFA: 'limited' as const } };
    expect(applyTemplate(lease, mixed)).toEqual({
      ok: true,
      input: { documentId, account: '612', vehicle: 'B-123-XFA', deduction: 'limited' },
    });
    // The plate in either spelling is the same car; another deduction is not what it makes.
    expect(
      conforms(
        lease,
        { documentId, account: '612', vehicle: 'B123XFA', deduction: 'limited' },
        mixed,
      ),
    ).toBe(true);
    expect(
      conforms(lease, { documentId, account: '612', vehicle: 'B123XFA', deduction: 'full' }, mixed),
    ).toBe(false);
    expect(conforms(lease, { documentId, account: '612', deduction: 'limited' })).toBe(false);
    // The answer changed: the same template now makes the full deduction.
    expect(
      applyTemplate(lease, { ...document(), vehicles: { B123XFA: 'full' as const } }),
    ).toMatchObject({ ok: true, input: { deduction: 'full' } });
    // Shares name their vehicles one by one.
    const split = recognition({
      shares: [
        { account: '612', share: 1, vehicle: 'B-123-XFA' },
        { account: '628', share: 1 },
      ],
    });
    expect(applyTemplate(split, mixed)).toMatchObject({
      ok: true,
      input: {
        allocations: [
          {
            account: '612',
            vat: 'S-21',
            amount: '50.00',
            vehicle: 'B-123-XFA',
            deduction: 'limited',
          },
          { account: '628', vat: 'S-21', amount: '50.00', deduction: 'full' },
        ],
      },
    });
  });

  test('a deferral starts in the next month by default', () => {
    const insurance = template(
      { treatment: 'deferrals.defer', partyId: supplier, documentKind: 'invoice.received' },
      { account: '613', months: 12 },
    );
    expect(applyTemplate(insurance, document())).toEqual({
      ok: true,
      input: {
        date: '2026-05-05',
        account: '613',
        amount: '100.00',
        from: '2026-06',
        months: 12,
        partyId: supplier,
        documentId,
        evidenceId,
      },
    });
    const foreign = document({ body: invoiceBody({ currency: 'EUR' }) });
    expect(applyTemplate(insurance, foreign)).toEqual({ ok: false, reason: 'document' });
  });
});

describe('bank movements', () => {
  const movement = (text: string, amountMinor = -12100n): MovementSubject => ({
    kind: 'movement',
    movement: { id: movementId, amountMinor, currency: 'RON', text },
    openItems: [
      {
        id: itemA,
        kind: 'payable',
        partyId: supplier,
        currency: 'RON',
        outstandingMinor: 12100n,
        documentNumber: 'F 100',
      },
      {
        id: itemB,
        kind: 'payable',
        partyId: supplier,
        currency: 'RON',
        outstandingMinor: 12100n,
        documentNumber: 'F-101',
      },
    ],
  });
  const byNumber = template(
    { treatment: 'bank.settle', partyId: supplier, documentKind: 'movement.paid' },
    { settle: 'openItem', match: 'number' },
  );

  test('the invoice number in the text finds the one item it pays, for its exact amount', () => {
    expect(applyTemplate(byNumber, movement('Plata factura F100 internet'))).toEqual({
      ok: true,
      input: {
        movementId,
        allocations: [{ openItem: itemA, amount: '121.00' }],
        lines: [],
        opens: [],
      },
    });
    expect(applyTemplate(byNumber, movement('Plata F-102'))).toEqual({
      ok: false,
      reason: 'unmatched',
    });
    expect(applyTemplate(byNumber, movement('Plata F100', -10000n))).toEqual({
      ok: false,
      reason: 'unmatched',
    });
    // A receipt is not a payment.
    expect(applyTemplate(byNumber, movement('F100', 12100n))).toEqual({
      ok: false,
      reason: 'scope',
    });
    const byAmount = template(
      { treatment: 'bank.settle', documentKind: 'movement.paid' },
      { settle: 'openItem', match: 'amount' },
    );
    expect(applyTemplate(byAmount, movement('Plata'))).toEqual({
      ok: false,
      reason: 'ambiguous',
    });
  });

  test('fees go to one account; conformance needs the right open item', () => {
    const fees = template(
      { treatment: 'bank.settle', documentKind: 'movement.paid', linePattern: 'comision' },
      { settle: 'account', account: '627' },
    );
    expect(applyTemplate(fees, movement('Comision administrare cont', -500n))).toEqual({
      ok: true,
      input: {
        movementId,
        allocations: [],
        lines: [{ account: '627', amount: '5.00' }],
        opens: [],
      },
    });
    const wrong = { movementId, allocations: [{ openItem: itemB, amount: '121.00' }] };
    expect(conforms(byNumber, wrong)).toBe(true);
    expect(conforms(byNumber, wrong, movement('Plata factura F100'))).toBe(false);
  });
});

describe('fingerprints', () => {
  const effect = (
    ref: string,
    openItem = ref,
  ): FingerprintEffect & {
    openItems: { ref: string; partyId: string }[];
  } => ({
    lines: [
      { account: '626', side: 'D', bani: 10000n },
      { account: '4426', side: 'D', bani: 2100n },
      { account: '401', side: 'C', bani: 12100n, openItem },
    ],
    openItems: [{ ref, partyId: supplier }],
    taxEntries: [
      {
        tax: 'VAT',
        code: 'S-21',
        direction: 'input',
        baseBani: 10000n,
        taxBani: 2100n,
        deductibleBani: 2100n,
      },
    ],
    schedules: [],
  });

  test('the ids a proposal creates do not count; the items it settles do', () => {
    expect(effectFingerprint(effect(itemA))).toBe(effectFingerprint(effect(itemB)));
    const settling = effect(itemA, itemB);
    expect(effectFingerprint(settling)).not.toBe(effectFingerprint(effect(itemA)));
    const stored = {
      ...effect(itemA),
      lines: effect(itemA).lines.map((line) => ({ ...line, bani: String(line.bani) })),
      taxEntries: effect(itemA).taxEntries.map((entry) => ({
        ...entry,
        baseBani: '10000',
        taxBani: '2100',
        deductibleBani: '2100',
      })),
    };
    expect(effectFingerprint(stored)).toBe(effectFingerprint(effect(itemA)));
    const undeducted = effect(itemA);
    undeducted.taxEntries[0]!.deductibleBani = 0n;
    expect(effectFingerprint(undeducted)).not.toBe(effectFingerprint(effect(itemA)));
    expect(effectAmount(effect(itemA))).toBe(12100n);
    expect(
      effectParties({
        lines: [{ partyId: other }, {}],
        openItems: [{ partyId: supplier }],
        taxEntries: [{ partyId: other }],
      }),
    ).toEqual([supplier, other].sort());
  });
});

describe('track record', () => {
  const posted = (month: string, fingerprint = 'f', extra: Partial<Outcome> = {}): Outcome => ({
    ...outcomeOf(
      'f',
      { fingerprint, reversed: false, month, rulesHash: 'r1', basis: '', amount: 12100n },
      false,
    ),
    ...extra,
  });

  test('outcomes: correct, changed, reversed, withdrawn, pending', () => {
    const base = { month: '2026-05', rulesHash: 'r', basis: '', amount: 1n };
    expect(outcomeOf('f', { ...base, fingerprint: 'f', reversed: false }, false).outcome).toBe(
      'correct',
    );
    expect(outcomeOf('f', { ...base, fingerprint: 'g', reversed: false }, false)).toMatchObject({
      outcome: 'corrected',
      reason: 'changed',
    });
    expect(outcomeOf('f', { ...base, fingerprint: 'f', reversed: true }, false)).toMatchObject({
      outcome: 'corrected',
      reason: 'reversed',
    });
    expect(outcomeOf('f', null, true).outcome).toBe('rejected');
    expect(outcomeOf('f', null, false).outcome).toBe('pending');
    expect(
      outcomesByMonth([
        posted('2026-05'),
        posted('2026-05', 'g'),
        { ...outcomeOf('f', null, false) },
      ]),
    ).toEqual([
      { month: '2026-05', correct: 1, corrected: 1, rejected: 0, pending: 0 },
      { month: null, correct: 0, corrected: 0, rejected: 0, pending: 1 },
    ]);
  });

  test('graduation: six correct across three months under the same rules, no correction', () => {
    const run = ['2026-04', '2026-05', '2026-05', '2026-06', '2026-06', '2026-06'].map((month) =>
      posted(month),
    );
    expect(graduation(run, defaultCriteria)).toMatchObject({
      met: true,
      correct: 6,
      months: ['2026-04', '2026-05', '2026-06'],
      observed: { min: 12100n, max: 12100n, maxPerMonth: 3 },
    });
    expect(graduation(run.slice(0, 5), defaultCriteria)).toMatchObject({
      met: false,
      failing: ['MIN_CORRECT'],
    });
    expect(graduation([...run, posted('2026-07', 'g')], defaultCriteria)).toMatchObject({
      met: false,
      failing: ['CORRECTIONS'],
    });
    // New rules start the run again.
    expect(
      graduation([...run, posted('2026-07', 'f', { rulesHash: 'r2' })], defaultCriteria),
    ).toMatchObject({ met: false, correct: 1, failing: ['MIN_CORRECT', 'MIN_MONTHS'] });
    // So does a changed answer: the run counts only what relied on the latest one's facts.
    expect(
      graduation([...run, posted('2026-07', 'f', { basis: 'vehicle:business_only' })], {
        ...defaultCriteria,
      }),
    ).toMatchObject({
      met: false,
      correct: 1,
      basis: 'vehicle:business_only',
      failing: ['MIN_CORRECT', 'MIN_MONTHS'],
    });
    expect(graduation(run, defaultCriteria).basis).toBe('');
    expect(graduation(run, { ...defaultCriteria, minMonths: 4 }).failing).toEqual(['MIN_MONTHS']);
  });
});
