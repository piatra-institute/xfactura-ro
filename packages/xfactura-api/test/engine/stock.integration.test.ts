import { afterAll, describe, expect, test } from 'bun:test';
import * as stockAgent from 'xfactura-core/ro/stock/agent';
import type { ProposalView } from '../../source/engine/kernel/views';
import { scenario, type Scenario } from './scenario';

// The stock register (G1) from the books' side. Amounts by hand:
//   FIFO: 10 pcs at 10,00 (100,00) then 10 at 12,00 (120,00); 15 out = 10 × 10 + 5 × 12 = 160,00;
//   weighted average after each receipt: 10 at 10,00 + 10 at 12,00 = 20 at 11,00; 15 out = 165,00;
//   LIFO: 15 out = 10 × 12 + 5 × 10 = 170,00.

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);

type Item = { id: string; code: string };
type Warehouse = { id: string; code: string };

export async function stockCompany(
  method: 'fifo' | 'lifo' | 'average' | 'periodic',
  extra: Record<string, string> = {},
) {
  const s = await scenario({ clock: () => Date.parse('2026-11-10T10:00:00Z') });
  open.push(s);
  for (const [axis, value] of Object.entries({
    'vat.status': 'normal_vat',
    'vat.period': 'monthly',
    'policy.stock.valuation': method,
    'policy.stock.inventory': 'permanent',
    'policy.stock.negative': 'refuse',
    ...extra,
  }))
    await s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence(`${axis}.pdf`)).id,
    });
  const item = (code: string, name: string, account = '371', unit = 'H87') =>
    s.invoke<Item>(s.owner, 'stock.items.create', { code, name, unit, account, nc8: '09012100' });
  const warehouse = (code: string, name: string) =>
    s.invoke<Warehouse>(s.owner, 'stock.warehouses.create', {
      code,
      name,
      keeper: 'Ionescu Maria',
    });
  return { s, item, warehouse };
}

describe('the stock register', () => {
  test('receives, consumes, transfers and reverses, the register equal to the ledger', async () => {
    const { s, item, warehouse } = await stockCompany('fifo');
    const coffee = await item('CAF-1', 'Cafea boabe 1 kg');
    const paper = await item('HRT-1', 'Hârtie A4', '3028');
    const shop = await warehouse('M1', 'Magazin');
    const depot = await warehouse('D1', 'Depozit');
    const supplier = await s.party('Furnizor Cafea SRL', '14399840');
    const receive = async (reference: string, date: string, quantity: string, value: string) =>
      s.book('stock.receive', {
        date,
        warehouseId: depot.id,
        supplierId: supplier.id,
        reference,
        evidenceId: (await s.evidence(`${reference}.pdf`)).id,
        lines: [
          { itemId: coffee.id, quantity, value },
          { itemId: paper.id, quantity: '5', value: '100.00' },
        ],
      });
    const first = await receive('AV-1', '2026-03-02', '10', '100.00');
    expect(first.status).toBe('posted');
    expect(lines(first)).toEqual(['D 371 100.00', 'D 3028 100.00', 'C 408 200.00']);
    expect(first.effect!.stockMoves!.map((move) => move.quantity)).toEqual(['10.000', '5.000']);
    await receive('AV-2', '2026-03-05', '10', '120.00');

    // FIFO: 15 pieces leave the first lot whole and 5 of the second.
    const transfer = await s.book('stock.transfer', {
      date: '2026-03-06',
      from: depot.id,
      to: shop.id,
      reference: 'BT-1',
      evidenceId: (await s.evidence('bt.pdf')).id,
      lines: [{ itemId: coffee.id, quantity: '15' }],
    });
    expect(transfer.effect!.journalClass).toBe('memo');
    expect(transfer.effect!.stockMoves!.map((move) => `${move.quantity} ${move.amount}`)).toEqual([
      '-10.000 -100.00',
      '-5.000 -60.00',
      '10.000 100.00',
      '5.000 60.00',
    ]);
    const consumed = await s.book('stock.consume', {
      date: '2026-03-07',
      warehouseId: depot.id,
      reference: 'BC-1',
      evidenceId: (await s.evidence('bc.pdf')).id,
      lines: [{ itemId: paper.id, quantity: '7' }],
    });
    // Paper: 5 at 20,00 then 5 at 20,00; 7 out = 140,00 onto 6028.
    expect(lines(consumed)).toEqual(['D 6028 140.00', 'C 3028 140.00']);

    const register = await s.invoke<{
      positions: { code: string; warehouse: string; quantity: string; value: string }[];
      accounts: { account: string; register: string; ledger: string; outside: string }[];
    }>(s.owner, 'stock.register', {});
    expect(
      register.positions.map((row) => `${row.code} ${row.warehouse} ${row.quantity} ${row.value}`),
    ).toEqual(['CAF-1 D1 5.000 60.00', 'CAF-1 M1 15.000 160.00', 'HRT-1 D1 3.000 60.00']);
    expect(register.accounts).toEqual([
      { account: '3028', register: '60.00', ledger: '60.00', outside: '0.00' },
      { account: '371', register: '220.00', ledger: '220.00', outside: '0.00' },
    ]);

    // A reversal returns the goods to the lots they left.
    const reversal = await s.book('ledger.reverse', {
      entryId: consumed.entry!.id,
      date: '2026-03-08',
      reason: 'Bon de consum emis din eroare',
      evidenceId: (await s.evidence('storno.pdf')).id,
      method: 'red',
    });
    expect(reversal.status).toBe('posted');
    expect(reversal.effect!.stockMoves!.map((move) => move.quantity)).toEqual(['5.000', '2.000']);
    const card = await s.invoke<{ closing: { quantity: string; value: string } }>(
      s.owner,
      'stock.card',
      { itemId: paper.id, warehouseId: depot.id },
    );
    expect(card.closing).toEqual({ quantity: '10.000', value: '200.00' });
  });

  test('values exits by FIFO, LIFO and the weighted average', async () => {
    const results: Record<string, string[] | undefined> = {};
    for (const method of ['fifo', 'lifo', 'average'] as const) {
      const { s, item, warehouse } = await stockCompany(method);
      const coffee = await item('CAF-1', 'Cafea');
      const depot = await warehouse('D1', 'Depozit');
      const supplier = await s.party('Furnizor SRL', '14399840');
      for (const [reference, value] of [
        ['AV-1', '100.00'],
        ['AV-2', '120.00'],
      ] as const)
        await s.book('stock.receive', {
          date: reference === 'AV-1' ? '2026-03-02' : '2026-03-05',
          warehouseId: depot.id,
          supplierId: supplier.id,
          reference,
          evidenceId: (await s.evidence(`${reference}.pdf`)).id,
          lines: [{ itemId: coffee.id, quantity: '10', value }],
        });
      await s.invoke(s.owner, 'stock.items.create', {
        code: 'MAT-1',
        name: 'Material',
        unit: 'KGM',
        account: '3028',
      });
      const transfer = await s.propose('stock.transfer', {
        date: '2026-03-06',
        from: depot.id,
        to: (await warehouse('M1', 'Magazin')).id,
        reference: 'BT-1',
        evidenceId: (await s.evidence('bt.pdf')).id,
        lines: [{ itemId: coffee.id, quantity: '15' }],
      });
      results[method] = transfer.effect?.stockMoves
        ?.filter((move) => move.quantity.startsWith('-'))
        .map((move) => move.amount);
    }
    expect(results).toEqual({
      fifo: ['-100.00', '-60.00'],
      lifo: ['-120.00', '-50.00'],
      average: ['-165.00'],
    });
  });

  test('refuses more than the warehouse holds, and asks for the policy', async () => {
    const { s, item, warehouse } = await stockCompany('fifo');
    const coffee = await item('CAF-1', 'Cafea');
    const depot = await warehouse('D1', 'Depozit');
    const consumed = await s.propose('stock.consume', {
      date: '2026-03-07',
      warehouseId: depot.id,
      reference: 'BC-1',
      evidenceId: (await s.evidence('bc.pdf')).id,
      lines: [{ itemId: coffee.id, quantity: '1' }],
    });
    expect(consumed.issues.map((issue) => issue.code)).toEqual(['STOCK_CONSUME_GOODS']);
    const paper = await item('HRT-1', 'Hârtie', '3028');
    const short = await s.propose('stock.consume', {
      date: '2026-03-07',
      warehouseId: depot.id,
      reference: 'BC-2',
      evidenceId: (await s.evidence('bc2.pdf')).id,
      lines: [{ itemId: paper.id, quantity: '1' }],
    });
    expect(short.issues.map((issue) => issue.code)).toEqual(['STOCK_INSUFFICIENT']);
  });

  test('a consumption another one overtook goes stale', async () => {
    const { s, item, warehouse } = await stockCompany('average');
    const paper = await item('HRT-1', 'Hârtie', '3028', 'XBX');
    const depot = await warehouse('D1', 'Depozit');
    await s.book('stock.receive', {
      date: '2026-03-02',
      warehouseId: depot.id,
      supplierId: (await s.party('Furnizor SRL', '14399840')).id,
      reference: 'AV-1',
      evidenceId: (await s.evidence('av.pdf')).id,
      lines: [{ itemId: paper.id, quantity: '3', value: '30.00' }],
    });
    const consume = async (reference: string, quantity: string) =>
      s.propose('stock.consume', {
        date: '2026-03-07',
        warehouseId: depot.id,
        reference,
        evidenceId: (await s.evidence(`${reference}.pdf`)).id,
        lines: [{ itemId: paper.id, quantity }],
      });
    const first = await consume('BC-1', '2');
    const second = await consume('BC-2', '2');
    // Each alone fits the 3 boxes; together they do not.
    expect([first.issues, second.issues]).toEqual([[], []]);
    await s.post(await s.approve(first));
    const approved = await s.approve(second);
    expect((await s.refused(s.post(approved)))?.code).toBe('STALE');
    const checked = await s.invoke<ProposalView>(s.owner, 'proposals.get', {
      id: second.id,
      recheck: true,
    });
    expect(checked.status).toBe('stale');
    expect(checked.check!.changed.map((change) => change.kind)).toContain('stock');
    const revised = await s.revise('stock.consume', checked, {
      date: '2026-03-07',
      warehouseId: depot.id,
      reference: 'BC-2',
      evidenceId: (await s.evidence('BC-2b.pdf')).id,
      lines: [{ itemId: paper.id, quantity: '2' }],
    });
    expect(revised.issues.map((issue) => issue.code)).toEqual(['STOCK_INSUFFICIENT']);
  });

  test('books a count with a shortage and a surplus, and writes stock down to its value', async () => {
    const { s, item, warehouse } = await stockCompany('fifo');
    const coffee = await s.invoke<Item>(s.owner, 'stock.items.create', {
      code: 'CAF-1',
      name: 'Cafea',
      unit: 'H87',
      account: '371',
      vatCategory: 'standard',
    });
    const tea = await item('CEA-1', 'Ceai');
    const depot = await warehouse('D1', 'Depozit');
    const supplier = await s.party('Furnizor SRL', '14399840');
    await s.book('stock.receive', {
      date: '2026-03-02',
      warehouseId: depot.id,
      supplierId: supplier.id,
      reference: 'AV-1',
      evidenceId: (await s.evidence('av.pdf')).id,
      lines: [
        { itemId: coffee.id, quantity: '10', value: '100.00' },
        { itemId: tea.id, quantity: '4', value: '40.00' },
      ],
    });
    const listFile = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'lista-stoc.txt',
      mediaType: 'text/plain',
      base64: Buffer.from('Lista de inventariere 31.12.2026 gestiunea D1').toString('base64'),
    });
    const list = await s.invoke<{ id: string }>(s.owner, 'documents.record', {
      evidenceId: listFile.id,
      kind: 'inventory.list',
      body: {
        title: 'Lista de inventariere la 31.12.2026, gestiunea D1',
        company: { name: 'Pilot SRL', taxId: '12345678' },
        date: '2026-12-31',
        commission: { decision: '45', decisionDate: '2026-12-01', members: ['Pop Ion'] },
        stock: [
          {
            account: '371',
            code: 'CAF-1',
            name: 'Cafea',
            unit: 'H87',
            quantity: '8',
            warehouse: 'D1',
          },
          {
            account: '371',
            code: 'CEA-1',
            name: 'Ceai',
            unit: 'H87',
            quantity: '5',
            warehouse: 'D1',
            value: '9.00',
          },
        ],
      },
    });
    const decision = await s.evidence('decizie-pv.pdf');
    const missing = await s.propose('inventory.stock', {
      date: '2026-12-31',
      documentIds: [list.id],
      evidenceId: decision.id,
    });
    expect(missing.issues.map((issue) => issue.code)).toEqual([
      'STOCK_SHORTAGE_CAUSE',
      'SOURCE_EXTRACTED',
    ]);
    // Coffee: 2 pieces missing, nobody answers for them: out at 20,00, their VAT (21% of the
    // lot's date) adjusted, 4,20; tea: 1 piece more, at the commission's 9,00.
    const counted = await s.revise('inventory.stock', missing, {
      date: '2026-12-31',
      documentIds: [list.id],
      evidenceId: decision.id,
      causes: [{ itemId: coffee.id, warehouseId: depot.id, cause: 'unimputable' }],
    });
    expect(counted.issues.map((issue) => issue.code)).toEqual([
      'PROFIT_SHORTAGE',
      'SOURCE_EXTRACTED',
    ]);
    expect(lines(counted)).toEqual([
      'C 371 20.00',
      'D 607 20.00',
      'D 635 4.20',
      'C 4426 4.20',
      'D 371 9.00',
      'C 607 9.00',
    ]);
    expect(counted.effect!.taxEntries.map((entry) => `${entry.code} ${entry.deductible}`)).toEqual([
      'ADJ-304 -4.20',
    ]);
    await s.post(await s.approve(counted, s.reviewer, ['PROFIT_SHORTAGE', 'SOURCE_EXTRACTED']));

    // The coffee left is worth 60,00 net of selling costs: written down by 20,00 (397).
    const nrv = await s.evidence('valoare-realizabila.pdf');
    const writeDown = await s.book('impairment.stock', {
      date: '2026-12-31',
      evidenceId: nrv.id,
      items: [{ itemId: coffee.id, value: '60.00' }],
    });
    expect(lines(writeDown)).toEqual(['D 6814 20.00', 'C 397 20.00']);
    const register = await s.invoke<{
      accounts: { account: string; register: string; ledger: string; outside: string }[];
    }>(s.owner, 'stock.register', {});
    expect(register.accounts).toEqual([
      { account: '371', register: '129.00', ledger: '129.00', outside: '0.00' },
    ]);
  });

  test('sets the stock at each count under the periodic inventory', async () => {
    const { s, item, warehouse } = await stockCompany('fifo', {
      'policy.stock.inventory': 'intermittent',
    });
    const coffee = await item('CAF-1', 'Cafea');
    await warehouse('D1', 'Depozit');
    const count = async (date: string, quantity: string, value: string) => {
      const file = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
        filename: `lista-${date}.txt`,
        mediaType: 'text/plain',
        base64: Buffer.from(`Lista de inventariere ${date}`).toString('base64'),
      });
      const list = await s.invoke<{ id: string }>(s.owner, 'documents.record', {
        evidenceId: file.id,
        kind: 'inventory.list',
        body: {
          title: `Lista de inventariere la ${date}`,
          company: { name: 'Pilot SRL', taxId: '12345678' },
          date,
          commission: { decision: '45', decisionDate: '2026-03-01', members: ['Pop Ion'] },
          stock: [
            {
              account: '371',
              code: 'CAF-1',
              name: 'Cafea',
              unit: 'H87',
              quantity,
              warehouse: 'D1',
              value,
            },
          ],
        },
      });
      return s.propose('stock.intermittent', {
        date,
        documentIds: [list.id],
        evidenceId: (await s.evidence(`aprobare-${date}.pdf`)).id,
      });
    };
    // Purchases went to 607; the first count sets 5 bags at 50,00, the next 3 at 30,00.
    const first = await count('2026-03-31', '5', '50.00');
    expect(first.issues.map((issue) => issue.code)).toEqual([
      'STOCK_COUNT_VALUES',
      'SOURCE_EXTRACTED',
    ]);
    expect(lines(first)).toEqual(['D 371 50.00', 'C 607 50.00']);
    await s.post(await s.approve(first, s.reviewer, ['STOCK_COUNT_VALUES', 'SOURCE_EXTRACTED']));
    const second = await count('2026-06-30', '3', '30.00');
    expect(lines(second)).toEqual(['C 371 50.00', 'D 371 30.00', 'D 607 20.00']);
    void coffee;
    // Other stock treatments wait for the count: the register is not kept perpetually.
    const consumed = await s.propose('stock.consume', {
      date: '2026-04-07',
      warehouseId: (
        await s.invoke<{ items: { id: string }[] }>(s.owner, 'stock.warehouses.list', {})
      ).items[0]!.id,
      reference: 'BC-1',
      evidenceId: (await s.evidence('bc.pdf')).id,
      lines: [{ itemId: (await item('HRT-1', 'Hârtie', '3028')).id, quantity: '1' }],
    });
    expect(consumed.issues.map((issue) => issue.code)).toContain('STOCK_INTERMITTENT');
  });

  test("is agent-ready: its documents, its question about a supplier's product, its detectors", async () => {
    expect(stockAgent.documentTypes.map((item) => item.id)).toEqual([
      'stock.policy',
      'stock.purchase.invoice',
      'stock.nir',
      'stock.delivery.note',
      'stock.consumption.slip',
      'stock.transfer.slip',
      'stock.inventory.list',
      'stock.shortage.proof',
      'stock.realizable.value',
    ]);
    expect(stockAgent.questions.map((item) => item.kind)).toEqual(['stock.item', 'profile.fact']);
    const { s, item } = await stockCompany('fifo');
    const coffee = await item('CAF-1', 'Cafea');
    const asked = await s.invoke<{ id: string; subject: { id: string } }>(
      s.owner,
      'questions.ask',
      {
        kind: 'stock.item',
        subject: { kind: 'supplierItem', id: '14399840 cafea  boabe' },
        params: { line: '1' },
      },
    );
    expect(asked.subject.id).toBe('14399840 CAFEA BOABE');
    const answered = await s.invoke<{ answer: { value: unknown } | null }>(
      s.owner,
      'questions.answer',
      {
        questionId: asked.id,
        value: { itemId: coffee.id, factor: '1' },
      },
    );
    expect(answered.answer?.value).toEqual({ itemId: coffee.id, factor: '1' });
    expect(s.engine.operations.get('inventory.stock.propose').agent).toBe(true);
  });
});
