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

// A month under the weighted average after each receipt, paper (3028) in depot D1, with goods
// back to the supplier and a receipt's storno valued on their date. By hand:
//   F-1 of 2 March, 10 boxes at 100.00; F-2 of 5 March, 10 at 200.00 (20 at 300.00); 10 consumed
//   on 6 March at 15.00, 150.00 (10 at 150.00 left);
//   F-2's credit note of 9 March, its 10 back for 200.00 + 42.00: the pool held exactly 10 then,
//   at 150.00, which they take; the 50.00 credited beyond it lowers 6028 (a value move, 60);
//   AV-1 and AV-2 of 11 March, 10 at 300.00 and 5 at 100.00 (15 at 400.00); 5 consumed on 12
//   March at 400.00 × 5 ÷ 15 = 133.33 (10 at 266.67 left);
//   AV-1 reversed on 13 March: the pool held exactly its 10, at 266.67; the 33.33 it entered above
//   that goes against 6028 (a value move of the storno, 180).
// The products' ValuationMethod is CMP (ANAF's guide, sec. 2.9): "Cost mediu", the structure's
// wording, exceeds SAFcodeType's 9 characters and ANAF's validator refused it.
describe('D406 on request: a weighted-average register with returns and a storno', () => {
  async function average(validator?: DeclarationValidator) {
    const s = await scenario({
      cui,
      clock: () => Date.parse('2026-11-10T10:00:00Z'),
      ...(validator ? { declarationValidator: validator } : {}),
    });
    open.push(s);
    for (const [axis, value] of Object.entries({
      'vat.status': 'normal_vat',
      'vat.period': 'monthly',
      'policy.stock.valuation': 'average',
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
        name: 'Exemplu Tipografie SRL',
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
    const paper = await s.invoke<{ id: string }>(s.owner, 'stock.items.create', {
      code: 'HRT-1',
      name: 'Hârtie A4',
      unit: 'XBX',
      account: '3028',
      nc8: '48025620',
    });
    const depot = await s.invoke<{ id: string }>(s.owner, 'stock.warehouses.create', {
      code: 'D1',
      name: 'Depozit',
      keeper: 'Ionescu Maria',
    });
    const supplier = await s.party('Furnizor Hârtie SRL', '14399840');
    const stock = (quantity: string) => ({
      warehouseId: depot.id,
      lines: [{ line: '1', itemId: paper.id, quantity }],
    });
    const imported = async (input: XmlInput) => {
      const { id: evidenceId } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
        filename: `${input.number}.xml`,
        mediaType: 'application/xml',
        base64: Buffer.from(
          invoiceXml({ company: cui, counterparty: '14399840', ...input }),
        ).toString('base64'),
      });
      return s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId });
    };
    const bought = async (
      number: string,
      date: string,
      quantity: string,
      net: string,
      tax: string,
    ) => {
      const gross = (Number(net) + Number(tax)).toFixed(2);
      const document = await imported({
        number,
        date,
        net,
        tax,
        gross,
        lines: [{ rate: '21', net }],
      });
      await s.book('invoices.recognize', {
        documentId: document.id,
        account: '3028',
        stock: stock(quantity),
      });
      return document;
    };
    const receive = async (reference: string, quantity: string, value: string) =>
      s.book('stock.receive', {
        date: '2026-03-11',
        warehouseId: depot.id,
        supplierId: supplier.id,
        reference,
        evidenceId: (await s.evidence(`${reference}.pdf`)).id,
        lines: [{ itemId: paper.id, quantity, value }],
      });
    const consume = async (reference: string, date: string, quantity: string) =>
      s.book('stock.consume', {
        date,
        warehouseId: depot.id,
        reference,
        evidenceId: (await s.evidence(`${reference}.pdf`)).id,
        lines: [{ itemId: paper.id, quantity }],
      });
    await bought('F-1', '2026-03-02', '10', '100.00', '21.00');
    const second = await bought('F-2', '2026-03-05', '10', '200.00', '42.00');
    await consume('BC-1', '2026-03-06', '10');
    const note = await imported({
      number: 'NC-2',
      date: '2026-03-09',
      credit: true,
      originalNumber: 'F-2',
      net: '200.00',
      tax: '42.00',
      gross: '242.00',
      lines: [{ rate: '21', net: '200.00' }],
    });
    const back = await s.book('invoices.credit', {
      documentId: note.id,
      originalDocumentId: second.id,
      account: '3028',
      stock: stock('10'),
    });
    const wrong = await receive('AV-1', '10', '300.00');
    await receive('AV-2', '5', '100.00');
    await consume('BC-2', '2026-03-12', '5');
    const storno = await s.book('ledger.reverse', {
      entryId: wrong.entry!.id,
      date: '2026-03-13',
      reason: 'Aviz înregistrat din greșeală.',
      evidenceId: (await s.evidence('storno-av-1.pdf')).id,
      method: 'red',
    });
    const prepare = () =>
      s.invoke<Artifact>(s.owner, 'declarations.prepare', {
        kind: 'D406',
        period: '2026-03-C',
        options: { contact },
      });
    return { s, back, storno, prepare };
  }
  const lines = (proposal: {
    effect?: { lines: { side: string; account: string; amount: string }[] } | null;
  }) => proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);

  test('each return leaves at what the pool held on its date, and the file says CMP', async () => {
    const { s, back, storno, prepare } = await average();
    expect(lines(back)).toEqual([
      'D 3028 -200.00',
      'D 4426 -42.00',
      'C 401 -242.00',
      'D 3028 50.00',
      'C 6028 50.00',
    ]);
    expect(lines(storno)).toEqual([
      'D 3028 -300.00',
      'C 408 -300.00',
      'D 3028 33.33',
      'C 6028 33.33',
    ]);
    const prepared = await prepare();
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
    expect(text('ValuationMethod')).toEqual(['CMP']);
    expect(text('BookValue')).toEqual([
      '100.00',
      '200.00',
      '-150.00',
      '-200.00',
      '50.00',
      '300.00',
      '100.00',
      '-133.33',
      '-300.00',
      '33.33',
    ]);
    expect(text('MovementSubType')).toEqual([
      '10',
      '10',
      '70',
      '50',
      '60',
      '10',
      '10',
      '70',
      '180',
      '180',
    ]);
    expect(text('ClosingStockQuantity')).toEqual(['0.000']);
  });

  official(
    "its stock file passes ANAF's SAF-T validator",
    async () => {
      const { prepare } = await average(kits());
      const prepared = await prepare();
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
    },
    120_000,
  );
});
