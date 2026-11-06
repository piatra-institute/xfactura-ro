import { afterAll, describe, expect, test } from 'bun:test';
import * as stockAgent from 'xfactura-core/ro/stock/agent';
import type { ProposalView } from '../../source/engine/kernel/views';
import type { WorkItem } from '../../source/engine/kernel/work';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
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

// The review of November 2026, fixed: the weighted average
// reads what a pool held on the exit's date, a negative pool refilled past zero holds the
// receipt's cost, and the periodic average's month nets reversals and returns.
describe('valuation on the dates the moves carry', () => {
  /** Paper (3028) in one warehouse, received on delivery notes and consumed on slips. */
  async function paper(
    method: 'fifo' | 'average' | 'periodic',
    negative: 'refuse' | 'allow' = 'refuse',
  ) {
    const { s, item, warehouse } = await stockCompany(method, {
      'policy.stock.negative': negative,
    });
    const sheet = await item('HRT-1', 'Hârtie', '3028');
    const depot = await warehouse('D1', 'Depozit');
    const supplier = await s.party('Furnizor SRL', '14399840');
    const receive = async (reference: string, date: string, quantity: string, value: string) =>
      s.book('stock.receive', {
        date,
        warehouseId: depot.id,
        supplierId: supplier.id,
        reference,
        evidenceId: (await s.evidence(`${reference}.pdf`)).id,
        lines: [{ itemId: sheet.id, quantity, value }],
      });
    const consumption = async (reference: string, date: string, quantity: string) =>
      s.propose('stock.consume', {
        date,
        warehouseId: depot.id,
        reference,
        evidenceId: (await s.evidence(`${reference}.pdf`)).id,
        lines: [{ itemId: sheet.id, quantity }],
      });
    const reverse = async (entryId: string, date: string, method: 'red' | 'black') =>
      s.book('ledger.reverse', {
        entryId,
        date,
        reason: 'Document înregistrat din greșeală.',
        evidenceId: (await s.evidence(`storno-${entryId}.pdf`)).id,
        method,
      });
    const card = async () =>
      (
        await s.invoke<{ closing: { quantity: string; value: string } }>(s.owner, 'stock.card', {
          itemId: sheet.id,
          warehouseId: depot.id,
        })
      ).closing;
    const findings = async (month: string) =>
      ((await s.close(month)).preview as { findings: { code: string }[] }).findings.map(
        (finding) => finding.code,
      );
    return { s, receive, consumption, reverse, card, findings };
  }
  const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);

  // The whole pool counted as available on any date after its first receipt, valued at today's
  // average: an exit dated when the warehouse was empty was accepted, at a later purchase's price.
  test('an exit dated when the warehouse was empty is refused', async () => {
    const { s, receive, consumption } = await paper('average');
    await receive('AV-1', '2026-03-01', '10', '100.00');
    await s.post(await s.approve(await consumption('BC-1', '2026-03-02', '10')));
    await receive('AV-2', '2026-03-20', '10', '200.00');
    const late = await consumption('BC-2', '2026-03-10', '5');
    expect(codes(late)).toEqual(['STOCK_INSUFFICIENT']);
    expect(late.issues[0]!.details).toMatchObject({ available: '0.000', requested: '5.000' });
    // On the 20th, after the receipt, the 5 leave at its price.
    const after = await consumption('BC-3', '2026-03-21', '5');
    expect(lines(after)).toEqual(['D 6028 100.00', 'C 3028 100.00']);
  });

  test('an exit dated before a later receipt leaves at its date’s average', async () => {
    const { s, receive, consumption, card } = await paper('average');
    await receive('AV-1', '2026-03-01', '10', '100.00');
    await receive('AV-2', '2026-03-20', '10', '200.00');
    // On 10 March the pool held 10 at 10,00: 5 cost 50,00, not 75,00 (today's average).
    const backdated = await consumption('BC-1', '2026-03-10', '5');
    expect(lines(backdated)).toEqual(['D 6028 50.00', 'C 3028 50.00']);
    // No more than it held on that day leaves on it.
    expect(codes(await consumption('BC-2', '2026-03-10', '12'))).toEqual(['STOCK_INSUFFICIENT']);
    await s.post(await s.approve(backdated));
    expect(await card()).toEqual({ quantity: '15.000', value: '250.00' });
  });

  test('a FIFO lot emptied on the exit’s date and restored later is not available then', async () => {
    const { s, receive, consumption, reverse } = await paper('fifo');
    await receive('AV-1', '2026-03-01', '10', '100.00');
    const out = await s.post(await s.approve(await consumption('BC-1', '2026-03-05', '10')));
    // Reversed on the 25th: the lot holds 10 again from then on, not on the 10th.
    await reverse(out.entry!.id, '2026-03-25', 'red');
    expect(codes(await consumption('BC-2', '2026-03-10', '5'))).toEqual(['STOCK_INSUFFICIENT']);
    expect(lines(await consumption('BC-3', '2026-03-26', '5'))).toEqual([
      'D 6028 50.00',
      'C 3028 50.00',
    ]);
  });

  // The estimate of a negative pool's exits was corrected only by a receipt bringing it back to
  // exactly zero: one crossing zero kept the estimate in the stock.
  test('a negative pool refilled past zero holds the receipt’s cost', async () => {
    const { s, receive, consumption, card } = await paper('average', 'allow');
    await receive('AV-1', '2026-03-01', '2', '20.00');
    const out = await consumption('BC-1', '2026-03-02', '5');
    expect(lines(out)).toEqual(['D 6028 50.00', 'C 3028 50.00']);
    await s.post(
      await s.approve(
        out,
        s.reviewer,
        out.issues.filter((issue) => issue.severity === 'ack').map((issue) => issue.code),
      ),
    );
    // The 3 taken beyond the stock cost 12,00 each, not the 10,00 they left at: 6,00 more.
    const refill = await receive('AV-2', '2026-03-03', '10', '120.00');
    expect(lines(refill)).toEqual(['D 3028 120.00', 'D 6028 6.00', 'C 3028 6.00', 'C 408 120.00']);
    // 7 left of the 10 received at 12,00.
    expect(await card()).toEqual({ quantity: '7.000', value: '84.00' });
  });

  // The month's flows were split by the sign of each move's quantity: a reversed receipt counted
  // among the exits, which were brought to an average that included it.
  test('the periodic average: a receipt reversed in the month is neither an entry nor an exit', async () => {
    const { s, receive, consumption, reverse, findings } = await paper('periodic');
    await receive('AV-1', '2026-03-02', '10', '100.00');
    const wrong = await receive('AV-2', '2026-03-03', '10', '200.00');
    await reverse(wrong.entry!.id, '2026-03-04', 'red');
    const consumed = await s.post(await s.approve(await consumption('BC-1', '2026-03-05', '5')));
    expect(lines(consumed)).toEqual(['D 6028 50.00', 'C 3028 50.00']);
    // The month held 10 at 10,00: the 5 consumed cost 50,00 as booked, and the close asks for no
    // costing. Before: D 6028 −25,00 / C 3028 −25,00 (15 "exits" at 300,00 ÷ 20).
    expect(codes(await s.propose('stock.periodCost', { month: '2026-03' }))).toEqual([
      'NOTHING_TO_BOOK',
    ]);
    expect(await findings('2026-03')).not.toContain('STOCK_PERIOD_COST_MISSING');
  });

  test('the periodic average nets a black storno and a consumption reversed, and costs the rest', async () => {
    const { s, receive, consumption, reverse, findings } = await paper('periodic');
    await receive('AV-1', '2026-03-02', '10', '100.00');
    const wrong = await receive('AV-2', '2026-03-03', '10', '200.00');
    await reverse(wrong.entry!.id, '2026-03-04', 'black');
    await s.post(await s.approve(await consumption('BC-1', '2026-03-05', '5')));
    const twice = await s.post(await s.approve(await consumption('BC-2', '2026-03-06', '2')));
    await reverse(twice.entry!.id, '2026-03-07', 'red');
    await receive('AV-3', '2026-03-08', '10', '300.00');
    // Entries 20 for 400,00 (the black storno a negative entry), exits 5 at the running 10,00:
    // at the month's 20,00 they cost 100,00, 50,00 more.
    expect(await findings('2026-03')).toContain('STOCK_PERIOD_COST_MISSING');
    const costed = await s.book('stock.periodCost', { month: '2026-03' });
    expect(lines(costed)).toEqual(['D 6028 50.00', 'C 3028 50.00']);
    expect(await findings('2026-03')).not.toContain('STOCK_PERIOD_COST_MISSING');
  });
});

// A shop at retail price (G2) whose depot is kept by item at cost by its own fact
// (`policy.stock.retail.<warehouseId>`): the cost method's policies were asked by each treatment
// on the depot (POLICY_MISSING), never by the closure, which read the company's default alone.
describe('a company at retail price keeping a warehouse at cost', () => {
  test('the closure asks once for the cost policies, and the worklist lists the need', async () => {
    const s = await scenario({ clock: () => Date.parse('2026-11-10T10:00:00Z') });
    open.push(s);
    const record = async (axis: string, value: string) =>
      s.invoke(s.owner, 'profile.record', {
        axis,
        value,
        effectiveFrom: '2026-01-01',
        evidenceId: (await s.evidence(`${axis}.pdf`)).id,
      });
    for (const [axis, value] of Object.entries({
      'vat.status': 'normal_vat',
      'vat.period': 'monthly',
      'activity.goods': 'yes',
      'regime.excluded': 'none',
      'policy.stock.retail': 'retail',
      'policy.stock.inventory': 'permanent',
    }))
      await record(axis, value);
    const needs = async () =>
      (
        await s.invoke<{ needs: { id: string; message: string }[] }>(s.owner, 'closure.evaluate', {
          from: '2026-01',
          to: '2026-12',
        })
      ).needs.filter((need) => need.id.includes('policy.stock'));
    // At retail price only: nothing to ask of the stock register.
    expect(await needs()).toEqual([]);
    const depot = await s.invoke<Warehouse>(s.owner, 'stock.warehouses.create', {
      code: 'D1',
      name: 'Depozit',
      keeper: 'Ionescu Maria',
    });
    const shop = await s.invoke<Warehouse>(s.owner, 'stock.warehouses.create', {
      code: 'M1',
      name: 'Magazin',
      keeper: 'Popa Ion',
    });
    await record(`policy.stock.retail.${depot.id}`, 'cost');
    await record(`policy.stock.retail.${shop.id}`, 'retail');
    // The depot at cost: the output method and the negative stock's policy, once each.
    const asked = await needs();
    expect(asked.map((need) => need.id)).toEqual([
      'profile.fact|profile:policy.stock.valuation',
      'profile.fact|profile:policy.stock.negative',
    ]);
    expect(asked[0]!.message).toContain('o gestiune este ținută la cost');
    const work = (
      await s.invoke<{ items: WorkItem[] }>(s.owner, 'work.list', {
        kinds: ['closure.need'],
        limit: 200,
      })
    ).items;
    expect(
      work.find((item) => item.subject.id === 'profile.fact|profile:policy.stock.valuation'),
    ).toMatchObject({
      severity: 'warn',
      details: { fact: 'policy.stock.valuation' },
      next: [
        {
          operation: 'questions.ask',
          inputHint: {
            kind: 'profile.fact',
            subject: { kind: 'profile', id: 'policy.stock.valuation' },
          },
        },
      ],
    });
    // The depot's receipt asked the same, by itself.
    const coffee = await s.invoke<Item>(s.owner, 'stock.items.create', {
      code: 'CAF-1',
      name: 'Cafea',
      unit: 'H87',
      account: '371',
    });
    const supplier = await s.party('Furnizor SRL', '14399840');
    const receipt = async (reference: string) => ({
      date: '2026-03-02',
      warehouseId: depot.id,
      supplierId: supplier.id,
      reference,
      evidenceId: (await s.evidence(`${reference}.pdf`)).id,
      lines: [{ itemId: coffee.id, quantity: '10', value: '100.00' }],
    });
    const early = await s.propose('stock.receive', await receipt('AV-0'));
    expect(early.issues.map((issue) => issue.code)).toEqual(['POLICY_MISSING', 'POLICY_MISSING']);
    await s.invoke(s.owner, 'proposals.withdraw', {
      proposalId: early.id,
      reason: 'Politicile gestiunii la cost lipsesc',
    });
    await record('policy.stock.valuation', 'fifo');
    await record('policy.stock.negative', 'refuse');
    expect(await needs()).toEqual([]);
    expect((await s.book('stock.receive', await receipt('AV-1'))).status).toBe('posted');
  });
});

// Goods going back to their supplier, on its credit note or by a storno of their receipt, were
// valued on the register as it stands: one dated when the goods had already left was accepted
// once a later move brought the position back up, so it drove the position below zero on its
// date, and a pool's difference fell on the goods a later receipt brought in. They now take what
// the position held on their date (OMFP 1802/2014 pct. 95 alin. (1); `ro.stock.returns`).
describe('returns to the supplier and a receipt’s storno, on their date', () => {
  /** Paper (3028) bought on invoices or delivery notes, and consumed on slips. */
  async function paper(method: 'fifo' | 'average') {
    const { s, item, warehouse } = await stockCompany(method);
    const sheet = await item('HRT-1', 'Hârtie', '3028', 'XBX');
    const depot = await warehouse('D1', 'Depozit');
    const supplier = await s.party('Furnizor SRL', '87654321');
    const imported = async (input: XmlInput) => {
      const { id: evidenceId } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
        filename: `${input.number}.xml`,
        mediaType: 'application/xml',
        base64: Buffer.from(invoiceXml(input)).toString('base64'),
      });
      return s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId });
    };
    const stock = (quantity: string) => ({
      warehouseId: depot.id,
      lines: [{ line: '1', itemId: sheet.id, quantity }],
    });
    /** An invoice of `quantity` boxes for `net` lei at 21%, received into the depot. */
    const bought = async (number: string, date: string, quantity: string, net: string) => {
      const document = await imported({ number, date, ...amounts(net) });
      await s.book('invoices.recognize', {
        documentId: document.id,
        account: '3028',
        stock: stock(quantity),
      });
      return document;
    };
    /** The supplier's credit note on `original`, `quantity` boxes back for `net` lei. */
    const credited = async (
      original: { id: string; number: string },
      number: string,
      date: string,
      quantity: string,
      net: string,
    ) =>
      s.propose('invoices.credit', {
        documentId: (
          await imported({
            number,
            date,
            credit: true,
            originalNumber: original.number,
            ...amounts(net),
          })
        ).id,
        originalDocumentId: original.id,
        account: '3028',
        stock: stock(quantity),
      });
    const receive = async (reference: string, date: string, quantity: string, value: string) =>
      s.book('stock.receive', {
        date,
        warehouseId: depot.id,
        supplierId: supplier.id,
        reference,
        evidenceId: (await s.evidence(`${reference}.pdf`)).id,
        lines: [{ itemId: sheet.id, quantity, value }],
      });
    const consume = async (reference: string, date: string, quantity: string) =>
      s.book('stock.consume', {
        date,
        warehouseId: depot.id,
        reference,
        evidenceId: (await s.evidence(`${reference}.pdf`)).id,
        lines: [{ itemId: sheet.id, quantity }],
      });
    /** A red storno of `entryId` on `date`, or `previous` revised to that date. */
    const reverse = async (entryId: string, date: string, previous?: ProposalView) => {
      const input = {
        entryId,
        date,
        reason: 'Recepție înregistrată din greșeală.',
        evidenceId: (await s.evidence(`storno-${entryId}-${date}.pdf`)).id,
        method: 'red',
      };
      return previous
        ? s.revise('ledger.reverse', previous, input)
        : s.propose('ledger.reverse', input);
    };
    const card = async () =>
      (
        await s.invoke<{ closing: { quantity: string; value: string } }>(s.owner, 'stock.card', {
          itemId: sheet.id,
          warehouseId: depot.id,
        })
      ).closing;
    return { s, bought, credited, receive, consume, reverse, card };
  }
  const amounts = (net: string) => {
    const bani = BigInt(net.replace('.', ''));
    const tax = (bani * 21n + 50n) / 100n;
    const text = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
    return { net, tax: text(tax), gross: text(bani + tax), lines: [{ rate: '21', net }] };
  };
  const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);
  const moves = (proposal: ProposalView) =>
    proposal.effect?.stockMoves?.map((move) => `${move.quantity} ${move.amount}`);

  // The weighted average: F-1 of 2 March, 10 boxes at 100.00; F-2 of 5 March, 10 at 200.00 (20
  // at 300.00); 10 consumed on 6 March at 15.00, 150.00 (10 at 150.00 left); F-3 of 20 March, 10
  // at 300.00 (20 at 450.00). F-2's 10 go back on its credit note of 7 March, 200.00 + 42.00: on
  // that day the pool held exactly them, at 150.00, which they take, and the 50.00 the supplier
  // credits beyond it lowers 6028; F-3's boxes keep their 300.00. Before, the pool gave its
  // 200.00 today and kept 10 at 250.00.
  test('a return to the supplier empties the pool on its date: F-3’s boxes keep their cost', async () => {
    const { s, bought, credited, consume, card } = await paper('average');
    await bought('F-1', '2026-03-02', '10', '100.00');
    const second = await bought('F-2', '2026-03-05', '10', '200.00');
    expect(lines(await consume('BC-1', '2026-03-06', '10'))).toEqual([
      'D 6028 150.00',
      'C 3028 150.00',
    ]);
    await bought('F-3', '2026-03-20', '10', '300.00');
    const back = await credited(
      { id: second.id, number: 'F-2' },
      'NC-2',
      '2026-03-07',
      '10',
      '200.00',
    );
    expect(codes(back)).toEqual([]);
    expect(lines(back)).toEqual([
      'D 3028 -200.00',
      'D 4426 -42.00',
      'C 401 -242.00',
      'D 3028 50.00',
      'C 6028 50.00',
    ]);
    expect(moves(back)).toEqual(['-10.000 -200.00', '0.000 50.00']);
    await s.post(await s.approve(back));
    expect(await card()).toEqual({ quantity: '10.000', value: '300.00' });
  });

  // FIFO: F-1 of 2 March, 10 boxes at 100.00, all consumed on 3 March, the slip reversed on 25
  // March. F-1's credit note of 4 March for 2 boxes, 20.00 + 4.20: on the 4th the lot held none,
  // whatever it holds since (before: accepted, the lot at −2 from the 4th to the 25th); its note of
  // 26 March takes them out of the lot, at 20.00.
  test('a return dated when its lot was empty is refused, though the lot was restored later', async () => {
    const { bought, credited, consume, reverse, s } = await paper('fifo');
    const first = await bought('F-1', '2026-03-02', '10', '100.00');
    const slip = await consume('BC-1', '2026-03-03', '10');
    await s.post(await s.approve(await reverse(slip.entry!.id, '2026-03-25')));
    const early = await credited(
      { id: first.id, number: 'F-1' },
      'NC-1',
      '2026-03-04',
      '2',
      '20.00',
    );
    expect(codes(early)).toEqual(['STOCK_RETURN_CONSUMED']);
    expect(early.issues[0]!.details).toMatchObject({ available: '0.000', requested: '2.000' });
    const later = await credited(
      { id: first.id, number: 'F-1' },
      'NC-2',
      '2026-03-26',
      '2',
      '20.00',
    );
    expect(codes(later)).toEqual([]);
    expect(lines(later)).toEqual(['D 3028 -20.00', 'D 4426 -4.20', 'C 401 -24.20']);
    expect(moves(later)).toEqual(['-2.000 -20.00']);
  });

  // The weighted average: AV-1 of 1 March, 10 at 100.00; AV-2 of 5 March, 10 at 200.00; 15
  // consumed on 6 March at 15.00, 225.00 (5 at 75.00); AV-3 of 20 March, 10 at 300.00 (15 at
  // 375.00). AV-2 reversed on 7 March: the pool held 5 then, not its 10 (before: accepted, 5 at
  // 175.00 left, −5 on the 7th). Reversed on 21 March, at its 200.00: 5 at 175.00 left.
  test('a receipt’s storno dated when its goods had left is refused', async () => {
    const { s, receive, consume, reverse, card } = await paper('average');
    await receive('AV-1', '2026-03-01', '10', '100.00');
    const wrong = await receive('AV-2', '2026-03-05', '10', '200.00');
    expect(lines(await consume('BC-1', '2026-03-06', '15'))).toEqual([
      'D 6028 225.00',
      'C 3028 225.00',
    ]);
    await receive('AV-3', '2026-03-20', '10', '300.00');
    const early = await reverse(wrong.entry!.id, '2026-03-07');
    expect(codes(early)).toEqual(['STOCK_INSUFFICIENT']);
    expect(early.issues[0]!.details).toMatchObject({ available: '5.000', requested: '10.000' });
    const later = await reverse(wrong.entry!.id, '2026-03-21', early);
    expect(codes(later)).toEqual([]);
    expect(lines(later)).toEqual(['D 3028 -200.00', 'C 408 -200.00']);
    await s.post(await s.approve(later));
    expect(await card()).toEqual({ quantity: '5.000', value: '175.00' });
  });

  // FIFO: AV-1 of 1 March, 10 at 100.00 (lot 1); AV-2 of 2 March, 10 at 120.00 (lot 2); 15
  // consumed on 3 March, lot 1 whole and 5 of lot 2 (160.00). AV-2 reversed on 4 March: its lot
  // held 5. The slip reversed on 5 March restores the lot: reversed on 6 March, AV-2 takes its own
  // lot out, at 120.00, and lot 1 is left.
  test('FIFO: a receipt’s storno takes its own lot, as it was on the storno’s date', async () => {
    const { s, receive, consume, reverse, card } = await paper('fifo');
    await receive('AV-1', '2026-03-01', '10', '100.00');
    const wrong = await receive('AV-2', '2026-03-02', '10', '120.00');
    const slip = await consume('BC-1', '2026-03-03', '15');
    expect(lines(slip)).toEqual(['D 6028 160.00', 'C 3028 160.00']);
    const early = await reverse(wrong.entry!.id, '2026-03-04');
    expect(codes(early)).toEqual(['STOCK_INSUFFICIENT']);
    await s.post(await s.approve(await reverse(slip.entry!.id, '2026-03-05')));
    // Still refused on the 4th: the slip's storno came after it.
    const again = await reverse(wrong.entry!.id, '2026-03-04', early);
    expect(codes(again)).toEqual(['STOCK_INSUFFICIENT']);
    const later = await reverse(wrong.entry!.id, '2026-03-06', again);
    expect(codes(later)).toEqual([]);
    expect(moves(later)).toEqual(['-10.000 -120.00']);
    await s.post(await s.approve(later));
    expect(await card()).toEqual({ quantity: '10.000', value: '100.00' });
  });
});
