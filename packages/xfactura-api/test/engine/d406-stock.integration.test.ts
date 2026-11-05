import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { sourceXml } from 'xfactura-core/xml';
import {
  AnafKits,
  DukIntegrator,
  saftKitId,
  type DeclarationValidator,
} from '../../source/engine/adapters/declaration-validator';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

// D406's on-demand stock file (C) for March 2026, from the stock register: 10 bags of coffee
// bought on F-1 for 100,00 (supplier 14399840) into the depot, 3 of them moved to the shop.

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});
const saftDist = path.join(
  import.meta.dir,
  '../../../..',
  '.validators/anaf-saft/duk_SAFT_an_luna/dist',
);
const official = DukIntegrator.available(saftDist) && Bun.which('java') ? test : test.skip;
const kits = () => new AnafKits({ saft: new DukIntegrator(saftDist, saftKitId) });
const cui = '18547290';
const contact = { firstName: 'Ana', lastName: 'Popescu', phone: '0236000000' };
type Artifact = {
  id: string;
  state: string;
  evidenceId: string;
  steps: { state: string; actor: string | null; detail: string | null }[];
};

async function shop(validator?: DeclarationValidator) {
  const s = await scenario({
    cui,
    clock: () => Date.parse('2026-11-10T10:00:00Z'),
    ...(validator ? { declarationValidator: validator } : {}),
  });
  open.push(s);
  for (const [axis, value] of Object.entries({
    'vat.status': 'normal_vat',
    'vat.period': 'monthly',
    'policy.stock.valuation': 'fifo',
    'policy.stock.inventory': 'permanent',
    'policy.stock.negative': 'refuse',
  }))
    await s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence(`${axis}.pdf`)).id,
    });
  await s.invoke(s.owner, 'sales.seller.record', {
    details: {
      name: 'Exemplu Magazin SRL',
      vatId: `RO${cui}`,
      address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
    },
  });
  await s.invoke(s.owner, 'treasury.createAccount', {
    kind: 'bank',
    name: 'Cont curent',
    iban: 'RO49AAAA1B31007593840000',
    currency: 'RON',
    ledgerAccount: '5121',
    openedOn: '2026-01-01',
  });
  const coffee = await s.invoke<{ id: string }>(s.owner, 'stock.items.create', {
    code: 'CAF-1',
    name: 'Cafea boabe 1 kg',
    unit: 'H87',
    account: '371',
    nc8: '09012100',
    vatCategory: 'standard',
  });
  const depot = await s.invoke<{ id: string }>(s.owner, 'stock.warehouses.create', {
    code: 'D1',
    name: 'Depozit',
    keeper: 'Ionescu Maria',
  });
  const store = await s.invoke<{ id: string }>(s.owner, 'stock.warehouses.create', {
    code: 'M1',
    name: 'Magazin',
    keeper: 'Popa Ion',
  });
  const xml = invoiceXml({
    company: cui,
    counterparty: '14399840',
    number: 'F-1',
    date: '2026-03-02',
    net: '100.00',
    tax: '21.00',
    gross: '121.00',
    lines: [{ rate: '21', net: '100.00', name: 'Cafea boabe' }],
  } satisfies XmlInput);
  const { id: evidenceId } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
    filename: 'F-1.xml',
    mediaType: 'application/xml',
    base64: Buffer.from(xml).toString('base64'),
  });
  const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId });
  await s.book('invoices.recognize', {
    documentId: document.id,
    account: '371',
    stock: { warehouseId: depot.id, lines: [{ line: '1', itemId: coffee.id, quantity: '10' }] },
  });
  await s.book('stock.transfer', {
    date: '2026-03-05',
    from: depot.id,
    to: store.id,
    reference: 'BT-1',
    evidenceId: (await s.evidence('bt-1.pdf')).id,
    lines: [{ itemId: coffee.id, quantity: '3' }],
  });
  const prepare = (period: string) =>
    s.invoke<Artifact>(s.owner, 'declarations.prepare', {
      kind: 'D406',
      period,
      options: { contact },
    });
  return { s, prepare };
}

describe('D406 on request: the stock file', () => {
  test('writes the register of a month: physical stock per lot and the movements', async () => {
    const { s, prepare } = await shop();
    const prepared = await prepare('2026-03-C');
    expect(prepared.state).toBe('prepared');
    const { base64 } = await s.invoke<{ base64: string }>(s.owner, 'evidence.get', {
      id: prepared.evidenceId,
    });
    const root = sourceXml(new Uint8Array(Buffer.from(base64, 'base64')));
    const text = (name: string) =>
      root.children
        .flatMap(function find(node): typeof root.children {
          return [...(node.local === name ? [node] : []), ...node.children.flatMap(find)];
        })
        .map((node) => node.text.trim());
    expect(text('HeaderComment')).toEqual(['C']);
    expect(text('MovementType')).toEqual(['10', '80', '10', '80']);
    expect(text('ClosingStockQuantity')).toEqual(['7.000', '3.000']);
    expect(text('NumberOfMovementLines')).toEqual(['3']);
  });

  official(
    "a month's stock file passes ANAF's SAF-T validator",
    async () => {
      const { prepare } = await shop(kits());
      const prepared = await prepare('2026-03-C');
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
    },
    120_000,
  );
});
