import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import * as productionAgent from 'xfactura-core/ro/production/agent';
import { sourceXml } from 'xfactura-core/xml';
import {
  AnafKits,
  DukIntegrator,
  saftKitId,
  type DeclarationValidator,
} from '../../source/engine/adapters/declaration-validator';
import type { ProposalView } from '../../source/engine/kernel/views';
import { invoiceXml } from './fixtures/invoice';
import { buyerDetails, type Issued } from './fixtures/sales';
import { journal, scenario, type Scenario } from './scenario';

// A joinery's March 2026 (G4), at the standard cost, FIFO. Amounts by hand:
//   materials received: 100 boards (PAL) at 100,00 = 10.000,00; 20 l of lacquer at 25,00 = 500,00;
//   BOMs: a table (MASA) takes 2 boards and 0,5 l, standard 550,00; a chair (SCAUN) 1 board and
//     0,25 l, standard 300,00;
//   CP-1, 10 tables: 21 boards and 5 l (2.225,00), 1 board above the norm (100,00, stated an
//     abnormal loss); CP-2, 20 chairs: 15 boards and 4 l (1.600,00);
//   labour: one joiner, 6.000,00 lei with CAM 135,00 = 6.135,00 for 176 hours, 88 on CP-1
//     (3.067,50), 44 on CP-2 (1.533,75), 44 on neither (1.533,75 stays an expense);
//   overheads: depreciation 800,00 fixed on machine hours at a normal capacity of 100 h, the
//     orders used 20 + 16 = 36 h: absorbed 288,00 (160,00 and 128,00), 512,00 not absorbed;
//     energy 600,00 variable on labour hours 88:44 (400,00 and 200,00);
//   CP-1 hands over 10 tables (5.500,00) and closes: cost 2.225 + 3.067,50 + 160 + 400 − 100 =
//     5.752,50, an unfavourable difference of 252,50 (348 = 711);
//   CP-2 hands over 8 chairs (2.400,00) and stays open: 1.600 + 1.533,75 + 128 + 200 − 2.400 =
//     1.061,75 in progress, 12 chairs counted at 40% (331 = 711);
//   6 tables sold for 900,00 each: 711 = 345 3.300,00; the price differences on them, by the
//     year's coefficient 252,50 ÷ 7.900,00 × 3.300,00 = 105,47 (711 = 348).

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

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);

/** A synthetic CNP with a valid control digit. */
function cnp(body: string) {
  const weights = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
  const control =
    weights.reduce((sum, weight, index) => sum + weight * Number(body[index]), 0) % 11;
  return `${body}${control === 10 ? 1 : control}`;
}

async function joinery(validator?: DeclarationValidator) {
  const s = await scenario({
    cui,
    clock: () => Date.parse('2026-11-10T10:00:00Z'),
    ...(validator ? { declarationValidator: validator } : {}),
  });
  open.push(s);
  for (const [axis, value] of Object.entries({
    'vat.status': 'normal_vat',
    'vat.period': 'monthly',
    employer: 'yes',
    'policy.stock.valuation': 'fifo',
    'policy.stock.inventory': 'permanent',
    'policy.stock.negative': 'refuse',
    'policy.production.cost': 'standard',
  }))
    await s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence(`${axis}.pdf`)).id,
    });
  await s.invoke(s.owner, 'sales.seller.record', {
    details: {
      name: 'Tâmplăria Exemplu SRL',
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
  const buyer = await s.party('Client Mobilier SRL', '14399840');
  await s.invoke(s.owner, 'parties.recordDetails', {
    partyId: buyer.id,
    details: buyerDetails('14399840'),
  });
  const series = await s.invoke<{ id: string }>(s.owner, 'sales.series.create', {
    code: 'MOB',
    prefix: 'MOB',
    width: 4,
    revenueAccount: '7015',
  });
  const anaf = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
    kind: 'ro_public_institution',
    country: 'RO',
    name: 'ANAF',
  });
  const item = (code: string, name: string, account: string, unit = 'H87', nc8?: string) =>
    s.invoke<{ id: string }>(s.owner, 'stock.items.create', {
      code,
      name,
      unit,
      account,
      vatCategory: 'standard',
      ...(nc8 ? { nc8 } : {}),
    });
  const board = await item('PAL-18', 'Placă PAL 18 mm', '301');
  const lacquer = await item('LAC-1', 'Lac poliuretanic', '3021', 'LTR');
  const table = await item('MASA-1', 'Masă de bucătărie', '345', 'H87', '94036010');
  const chair = await item('SCAUN-1', 'Scaun', '345', 'H87', '94016100');
  const tablesInProgress = await item('PIC-MASA', 'Mese în curs de execuție', '331');
  const chairsInProgress = await item('PIC-SCAUN', 'Scaune în curs de execuție', '331');
  const warehouse = (code: string, name: string) =>
    s.invoke<{ id: string }>(s.owner, 'stock.warehouses.create', {
      code,
      name,
      keeper: 'Ionescu Maria',
    });
  const depot = await warehouse('D1', 'Depozit materiale');
  const shop = await warehouse('A1', 'Atelier');
  const finished = await warehouse('P1', 'Depozit produse finite');
  const supplier = await s.party('Furnizor PAL SRL', '25648378');
  const evidence = async (name: string) => (await s.evidence(name)).id;
  return {
    s,
    anaf,
    buyer,
    series,
    supplier,
    items: { board, lacquer, table, chair, tablesInProgress, chairsInProgress },
    warehouses: { depot, shop, finished },
    evidence,
  };
}
type Joinery = Awaited<ReturnType<typeof joinery>>;

/** The month's books before the costing: materials, BOMs, orders, consumption, payroll,
 * overheads, outputs, a closed order and a sale. */
async function march(j: Joinery) {
  const { s, items, warehouses, evidence } = j;
  await s.book('stock.receive', {
    date: '2026-03-02',
    warehouseId: warehouses.depot.id,
    supplierId: j.supplier.id,
    reference: 'AV-1',
    evidenceId: await evidence('aviz-1.pdf'),
    lines: [
      { itemId: items.board.id, quantity: '100', value: '10000.00' },
      { itemId: items.lacquer.id, quantity: '20', value: '500.00' },
    ],
  });
  const bomOf = async (itemId: string, standardCost: string, board: string, lacquer: string) =>
    s.invoke<{ id: string; version: number }>(s.owner, 'production.boms.record', {
      itemId,
      validFrom: '2026-03-01',
      outputQuantity: '1',
      standardCost,
      labourHours: '8',
      machineHours: '2',
      evidenceId: await evidence(`fisa-${itemId}.pdf`),
      lines: [
        { itemId: items.board.id, quantity: board },
        { itemId: items.lacquer.id, quantity: lacquer },
      ],
    });
  const tableBom = await bomOf(items.table.id, '550.00', '2', '0.5');
  await bomOf(items.chair.id, '300.00', '1', '0.25');
  expect(tableBom.version).toBe(1);
  const order = async (number: string, itemId: string, quantity: string, openedOn: string) =>
    s.invoke<{ id: string; bomId: string; closedOn: string | null }>(
      s.owner,
      'production.orders.open',
      { number, itemId, quantity, openedOn, evidenceId: await evidence(`${number}.pdf`) },
    );
  const tables = await order('CP-1', items.table.id, '10', '2026-03-02');
  const chairs = await order('CP-2', items.chair.id, '20', '2026-03-05');
  expect(tables.bomId).toBe(tableBom.id);

  const consumed = await s.book('production.consume', {
    orderId: tables.id,
    date: '2026-03-03',
    warehouseId: warehouses.depot.id,
    reference: 'BC-1',
    evidenceId: await evidence('bc-1.pdf'),
    lines: [
      { itemId: items.board.id, quantity: '21' },
      { itemId: items.lacquer.id, quantity: '5' },
    ],
  });
  expect(lines(consumed)).toEqual([
    'C 301 2100.00',
    'C 3021 125.00',
    'D 601 2100.00',
    'D 6021 125.00',
  ]);
  await s.book('production.consume', {
    orderId: chairs.id,
    date: '2026-03-06',
    warehouseId: warehouses.depot.id,
    reference: 'BC-2',
    evidenceId: await evidence('bc-2.pdf'),
    lines: [
      { itemId: items.board.id, quantity: '15' },
      { itemId: items.lacquer.id, quantity: '4' },
    ],
  });

  // The month's payroll: one joiner at 6.000,00 lei.
  const employee = await s.invoke<{ id: string }>(s.owner, 'payroll.employees.record', {
    lastName: 'Lungu',
    firstName: 'Mihai',
    cnp: cnp('180010112345'),
    healthFund: 'RO-GL',
  });
  const contract = await s.invoke<{ contractId: string }>(s.owner, 'payroll.contracts.record', {
    employeeId: employee.id,
    number: 'CIM-1',
    startDate: '2026-01-05',
    effectiveFrom: '2026-01-05',
    dailyHours: 8,
    mainJob: true,
    occupation: '752201',
    baseSalary: '6000',
  });
  const run = await s.invoke<{ id: string; lines: { cash: string; cam: string }[] }>(
    s.owner,
    'payroll.runs.prepare',
    { month: '2026-03', workingDays: 22 },
  );
  expect(run.lines.map((line) => [line.cash, line.cam])).toEqual([['6000.00', '135.00']]);
  await s.book('payroll.recognize', {
    runId: run.id,
    month: '2026-03',
    round: 1,
    authorityId: j.anaf.id,
  });

  // The overheads: the machines' depreciation and the workshop's energy.
  await s.book(
    'ledger.general',
    journal(
      await evidence('amortizare.pdf'),
      [
        { account: '6811', side: 'D', amount: '800.00' },
        { account: '2813', side: 'C', amount: '800.00' },
      ],
      { date: '2026-03-31', description: 'Amortizarea utilajelor din atelier' },
    ),
  );
  const energy = invoiceXml({
    company: cui,
    counterparty: '14399840',
    number: 'EN-3',
    date: '2026-03-20',
    net: '600.00',
    tax: '126.00',
    gross: '726.00',
    lines: [{ rate: '21', net: '600.00', name: 'Energie electrică atelier' }],
  });
  const { id: energyFile } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
    filename: 'EN-3.xml',
    mediaType: 'application/xml',
    base64: Buffer.from(energy).toString('base64'),
  });
  const energyDocument = await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
    evidenceId: energyFile,
  });
  await s.book('invoices.recognize', { documentId: energyDocument.id, account: '605' });

  // The products handed over: 10 tables, the order closes; 8 chairs, the order stays open.
  const handed = await s.book('production.output', {
    orderId: tables.id,
    date: '2026-03-25',
    warehouseId: warehouses.finished.id,
    reference: 'BP-1',
    evidenceId: await evidence('bp-1.pdf'),
    lines: [{ itemId: items.table.id, quantity: '10' }],
  });
  expect(lines(handed)).toEqual(['D 345 5500.00', 'C 711 5500.00']);
  await s.book('production.output', {
    orderId: chairs.id,
    date: '2026-03-28',
    warehouseId: warehouses.finished.id,
    reference: 'BP-2',
    evidenceId: await evidence('bp-2.pdf'),
    lines: [{ itemId: items.chair.id, quantity: '8' }],
  });
  const closed = await s.invoke<{ closedOn: string }>(s.owner, 'production.orders.close', {
    orderId: tables.id,
    date: '2026-03-25',
    evidenceId: await evidence('cp-1-inchidere.pdf'),
  });
  expect(closed.closedOn).toBe('2026-03-25');

  // Six tables sold: out of the products' warehouse at their registration price onto 711.
  const sale = await s.invoke<Issued>(s.owner, 'sales.issue', {
    seriesId: j.series.id,
    buyerId: j.buyer.id,
    issueDate: '2026-03-29',
    lines: [
      {
        name: 'Masă de bucătărie',
        quantity: '6',
        unitCode: 'H87',
        price: '900',
        vat: { category: 'S', rate: '21' },
      },
    ],
    stock: { warehouseId: warehouses.finished.id, lines: [{ index: 0, itemId: items.table.id }] },
  });
  expect(sale.recognition.error).toBe(null);
  const sold = await s.invoke<ProposalView>(s.owner, 'proposals.get', {
    id: sale.recognition.proposalId!,
  });
  expect(codes(sold)).toEqual([]);
  expect(lines(sold)).toEqual([
    'D 4111 6534.00',
    'C 7015 5400.00',
    'C 4427 1134.00',
    'C 345 3300.00',
    'D 711 3300.00',
  ]);
  const soldPosted = await s.post(await s.approve(sold));
  return { tables, chairs, run, contract, sold: soldPosted };
}

/** The month's costing input. */
const costing = (
  j: Joinery,
  month: { tables: { id: string }; chairs: { id: string }; run: { id: string } } & {
    contract: { contractId: string };
  },
  files: { timesheet: string; capacity: string; machines: string; count: string },
) => ({
  month: '2026-03',
  labour: {
    method: 'hours',
    runId: month.run.id,
    evidenceId: files.timesheet,
    contracts: [
      {
        contractId: month.contract.contractId,
        hours: '176',
        orders: [
          { orderId: month.tables.id, hours: '88' },
          { orderId: month.chairs.id, hours: '44' },
        ],
      },
    ],
  },
  overheads: [
    {
      accounts: ['6811'],
      behaviour: 'fixed',
      key: 'machine_hours',
      capacity: { normal: '100', evidenceId: files.capacity },
    },
    { accounts: ['605'], behaviour: 'variable', key: 'labour_hours' },
  ],
  machineHours: {
    evidenceId: files.machines,
    orders: [
      { orderId: month.tables.id, hours: '20' },
      { orderId: month.chairs.id, hours: '16' },
    ],
  },
  wip: {
    evidenceId: files.count,
    orders: [
      {
        orderId: month.chairs.id,
        itemId: j.items.chairsInProgress.id,
        warehouseId: j.warehouses.shop.id,
        quantity: '12',
        completion: '40',
      },
    ],
  },
});

async function costed(j: Joinery) {
  const month = await march(j);
  const { s, evidence } = j;
  const files = {
    timesheet: await evidence('pontaj-martie.pdf'),
    capacity: await evidence('capacitate-normala.pdf'),
    machines: await evidence('ore-utilaje.pdf'),
    count: await evidence('inventar-productie-in-curs.pdf'),
  };
  const input = costing(j, month, files);
  const asked = await s.propose('production.cost', input);
  const question = asked.issues.find((issue) => issue.code === 'PRODUCTION_EXCESS');
  const ask = (question!.details as { question: Record<string, unknown> }).question;
  const opened = await s.invoke<{ id: string }>(s.owner, 'questions.ask', ask);
  await s.invoke(s.owner, 'questions.answer', {
    questionId: opened.id,
    value: { treatment: 'abnormal', evidenceId: await evidence('pv-pierderi.pdf') },
  });
  const revised = await s.invoke<ProposalView>(s.owner, 'proposals.revise', {
    proposalId: asked.id,
    version: asked.version,
    input,
    basis: { answers: [opened.id] },
  });
  return { ...month, asked, question, revised, files };
}

describe('production (G4)', () => {
  test("a joinery's month: BOMs, two orders, labour and overheads, standard cost and WIP", async () => {
    const j = await joinery();
    const { s } = j;
    const findings = async (month: string) =>
      ((await s.close(month)).preview as { findings: { code: string }[] }).findings.map(
        (finding) => finding.code,
      );
    const { asked, question, revised, tables, chairs } = await costed(j);
    // Before the costing, the month close asks for it.
    expect(await findings('2026-03')).toContain('PRODUCTION_COST_MISSING');
    // A board above the norm is a person's call, never the engine's.
    expect(codes(asked)).toContain('PRODUCTION_EXCESS');
    expect(question!.message).toContain('1.000');
    expect(codes(revised)).toEqual([]);
    expect(lines(revised)).toEqual([
      'D 348 252.50',
      'C 711 252.50',
      'D 331 1061.75',
      'C 711 1061.75',
    ]);
    const details = revised.effect!.explanation.details as {
      orders: Record<string, unknown>[];
      labour: { unallocated: string };
      overheads: { absorbed: string; unallocated: string }[];
    };
    expect(details.orders).toEqual([
      expect.objectContaining({
        order: 'CP-1',
        materials: '2225.00',
        labour: '3067.50',
        fixed: '160.00',
        variable: '400.00',
        abnormal: '100.00',
        cost: '5752.50',
        outputs: '5500.00',
        variance: '252.50',
      }),
      expect.objectContaining({
        order: 'CP-2',
        materials: '1600.00',
        labour: '1533.75',
        fixed: '128.00',
        variable: '200.00',
        outputs: '2400.00',
        wip: '1061.75',
      }),
    ]);
    // What no order absorbs stays an expense of the period (pct. 8 pct. 7).
    expect(details.labour.unallocated).toBe('1533.75');
    expect(details.overheads.map((pool) => [pool.absorbed, pool.unallocated])).toEqual([
      ['288.00', '512.00'],
      ['600.00', '0.00'],
    ]);
    expect(revised.effect!.stockMoves!.map((move) => move.quantity)).toEqual(['12.000']);
    const posted = await s.post(await s.approve(revised));
    expect(posted.status).toBe('posted');
    // Then for the price differences of the products sold.
    expect(await findings('2026-03')).toContain('PRODUCTION_DIFFERENCES_MISSING');

    // The price differences of the tables sold, by the year's coefficient.
    const spread = await s.book('production.differences', { month: '2026-03' });
    expect(lines(spread)).toEqual(['D 711 105.47', 'C 348 105.47']);
    expect((await findings('2026-03')).filter((code) => code.startsWith('PRODUCTION_'))).toEqual(
      [],
    );

    // The register equals the ledger: products, work in progress, materials.
    const register = await s.invoke<{
      positions: { code: string; warehouse: string; quantity: string; value: string }[];
      accounts: { account: string; register: string; ledger: string; outside: string }[];
    }>(s.owner, 'stock.register', { date: '2026-03-31' });
    expect(
      register.positions.map((row) => `${row.code} ${row.warehouse} ${row.quantity} ${row.value}`),
    ).toEqual([
      'LAC-1 D1 11.000 275.00',
      'MASA-1 P1 4.000 2200.00',
      'PAL-18 D1 64.000 6400.00',
      'PIC-SCAUN A1 12.000 1061.75',
      'SCAUN-1 P1 8.000 2400.00',
    ]);
    expect(register.accounts.every((row) => row.outside === '0.00')).toBe(true);
    const balances = new Map(
      (await s.trialBalance()).rows.map((row) => [row.account, row.closing]),
    );
    // 711 holds the period's production cost left in stock: 4.600,00 of products, 147,03 of their
    // differences and 1.061,75 in progress.
    expect(balances.get('711')).toEqual({ debit: '0.00', credit: '5808.78' });
    expect(balances.get('348')).toEqual({ debit: '147.03', credit: '0.00' });
    expect(balances.get('331')).toEqual({ debit: '1061.75', credit: '0.00' });

    // The cost sheet of the closed order.
    const sheet = await s.invoke<{
      order: { closedOn: string | null };
      months: { month: string; labour: string | null; outputs: string; differences: string }[];
    }>(s.owner, 'production.costSheet', { orderId: tables.id });
    expect(sheet.order.closedOn).toBe('2026-03-25');
    expect(sheet.months).toEqual([
      expect.objectContaining({
        month: '2026-03',
        labour: '3067.50',
        outputs: '5500.00',
        differences: '252.50',
      }),
    ]);

    // April: the work in progress is taken back on its first day (the function of 331).
    expect(await findings('2026-04')).toContain('PRODUCTION_WIP_REVERSAL_MISSING');
    const reversed = await s.book('production.wipReverse', { month: '2026-04' });
    expect(lines(reversed)).toEqual(['C 331 1061.75', 'D 711 1061.75']);
    expect(reversed.effect!.date).toBe('2026-04-01');
    expect(await findings('2026-04')).not.toContain('PRODUCTION_WIP_REVERSAL_MISSING');
    // A closed order takes no more materials.
    const late = await s.propose('production.consume', {
      orderId: tables.id,
      date: '2026-04-02',
      warehouseId: j.warehouses.depot.id,
      reference: 'BC-9',
      evidenceId: await j.evidence('bc-9.pdf'),
      lines: [{ itemId: j.items.board.id, quantity: '1' }],
    });
    expect(codes(late)).toContain('PRODUCTION_ORDER_CLOSED');
    void chairs;
  });

  // production.differences read the exits as the credits of 345 and the entries as its debits:
  // a sale reversed in black read as six more tables entering and six leaving.
  test('a sale of products reversed by black storno leaves no exits to spread differences over', async () => {
    const j = await joinery();
    const { s } = j;
    const { revised, sold } = await costed(j);
    await s.post(await s.approve(revised));
    await s.book('ledger.reverse', {
      entryId: sold.entry!.id,
      date: '2026-03-30',
      reason: 'Factura emisă din greșeală.',
      evidenceId: await j.evidence('storno-vanzare.pdf'),
      method: 'black',
    });
    const findings = ((await s.close('2026-03')).preview as { findings: { code: string }[] })
      .findings;
    expect(findings.map((finding) => finding.code)).not.toContain('PRODUCTION_DIFFERENCES_MISSING');
    expect(codes(await s.propose('production.differences', { month: '2026-03' }))).toEqual([
      'NOTHING_TO_BOOK',
    ]);
  });

  test('refuses what the text does not allow, and asks what it does not know', async () => {
    const j = await joinery();
    const { s, items, warehouses, evidence } = j;
    // A BOM's product is a product, its materials materials; a revision starts after the last.
    const refused = await s.refused(
      s.invoke(s.owner, 'production.boms.record', {
        itemId: items.board.id,
        validFrom: '2026-03-01',
        outputQuantity: '1',
        evidenceId: await evidence('fisa.pdf'),
        lines: [{ itemId: items.lacquer.id, quantity: '1' }],
      }),
    );
    expect(refused?.code).toBe('BOM_PRODUCT');
    const record = async (validFrom: string, standardCost?: string) =>
      s.invoke<{ version: number }>(s.owner, 'production.boms.record', {
        itemId: items.table.id,
        validFrom,
        outputQuantity: '1',
        ...(standardCost ? { standardCost } : {}),
        evidenceId: await evidence(`fisa-${validFrom}.pdf`),
        lines: [{ itemId: items.board.id, quantity: '2' }],
      });
    expect((await record('2026-02-01')).version).toBe(1);
    expect((await s.refused(record('2026-01-15')))?.code).toBe('BOM_DATE');
    expect((await record('2026-04-01', '550.00')).version).toBe(2);
    // An order opened in March is costed on version 1, which has no standard cost.
    const order = await s.invoke<{ id: string; bomVersion: number }>(
      s.owner,
      'production.orders.open',
      {
        number: 'CP-7',
        itemId: items.table.id,
        quantity: '5',
        openedOn: '2026-03-10',
        evidenceId: await evidence('cp-7.pdf'),
      },
    );
    expect(order.bomVersion).toBe(1);
    const output = await s.propose('production.output', {
      orderId: order.id,
      date: '2026-03-20',
      warehouseId: warehouses.finished.id,
      reference: 'BP-7',
      evidenceId: await evidence('bp-7.pdf'),
      lines: [
        { itemId: items.table.id, quantity: '1' },
        { itemId: items.chair.id, quantity: '1' },
      ],
    });
    expect(codes(output)).toEqual(
      expect.arrayContaining(['PRODUCTION_STANDARD_MISSING', 'PRODUCTION_JOINT_PRODUCT']),
    );
    // Goods and semi-finished products are not given to an order.
    const consumed = await s.propose('production.consume', {
      orderId: order.id,
      date: '2026-03-11',
      warehouseId: warehouses.depot.id,
      reference: 'BC-7',
      evidenceId: await evidence('bc-7.pdf'),
      lines: [{ itemId: items.table.id, quantity: '1' }],
    });
    expect(codes(consumed)).toContain('STOCK_KIND_UNSUPPORTED');
    // Products are not received or consumed through the register's own treatments.
    const received = await s.propose('stock.receive', {
      date: '2026-03-02',
      warehouseId: warehouses.finished.id,
      supplierId: j.supplier.id,
      reference: 'AV-9',
      evidenceId: await evidence('av-9.pdf'),
      lines: [{ itemId: items.table.id, quantity: '1', value: '100.00' }],
    });
    expect(codes(received)).toContain('STOCK_KIND_UNSUPPORTED');
    // Without the cost method, a production treatment asks for it.
    await s.invoke(s.owner, 'profile.record', {
      axis: 'policy.production.cost',
      value: 'actual',
      effectiveFrom: '2026-03-15',
      evidenceId: await evidence('politica-cost-efectiv.pdf'),
    });
    const actual = await s.propose('production.output', {
      orderId: order.id,
      date: '2026-03-20',
      warehouseId: warehouses.finished.id,
      reference: 'BP-8',
      evidenceId: await evidence('bp-8.pdf'),
      lines: [{ itemId: items.table.id, quantity: '1' }],
    });
    expect(codes(actual)).toContain('PRODUCTION_OUTPUT_ACTUAL');
    // A fixed overhead needs the normal capacity; a pool may not take direct materials.
    const cost = await s.propose('production.cost', {
      month: '2026-03',
      labour: { method: 'none' },
      overheads: [{ accounts: ['641'], behaviour: 'fixed', key: 'materials' }],
    });
    expect(codes(cost)).toEqual(
      expect.arrayContaining([
        'PRODUCTION_OVERHEAD_ACCOUNT',
        'PRODUCTION_CAPACITY_KEY',
        'PRODUCTION_CAPACITY',
      ]),
    );
  });

  test('the actual cost: the closed order’s products enter at their cost at the month’s end', async () => {
    const j = await joinery();
    const { s, items, warehouses, evidence } = j;
    await s.invoke(s.owner, 'profile.record', {
      axis: 'policy.production.cost',
      value: 'actual',
      effectiveFrom: '2026-03-01',
      evidenceId: await evidence('politica-cost-efectiv.pdf'),
    });
    await s.book('stock.receive', {
      date: '2026-03-02',
      warehouseId: warehouses.depot.id,
      supplierId: j.supplier.id,
      reference: 'AV-1',
      evidenceId: await evidence('aviz-1.pdf'),
      lines: [{ itemId: items.board.id, quantity: '10', value: '1000.00' }],
    });
    await s.invoke(s.owner, 'production.boms.record', {
      itemId: items.table.id,
      validFrom: '2026-03-01',
      outputQuantity: '1',
      evidenceId: await evidence('fisa.pdf'),
      lines: [{ itemId: items.board.id, quantity: '2' }],
    });
    const order = await s.invoke<{ id: string }>(s.owner, 'production.orders.open', {
      number: 'CP-1',
      itemId: items.table.id,
      quantity: '4',
      openedOn: '2026-03-02',
      evidenceId: await evidence('cp-1.pdf'),
    });
    await s.book('production.consume', {
      orderId: order.id,
      date: '2026-03-03',
      warehouseId: warehouses.depot.id,
      reference: 'BC-1',
      evidenceId: await evidence('bc-1.pdf'),
      lines: [{ itemId: items.board.id, quantity: '8' }],
    });
    await s.invoke(s.owner, 'production.orders.close', {
      orderId: order.id,
      date: '2026-03-20',
      evidenceId: await evidence('inchidere.pdf'),
    });
    const cost = await s.book('production.cost', {
      month: '2026-03',
      labour: { method: 'none' },
      overheads: [],
      outputs: [
        {
          orderId: order.id,
          warehouseId: warehouses.finished.id,
          quantity: '4',
          reference: 'BP-1',
          evidenceId: await evidence('bp-1.pdf'),
        },
      ],
    });
    expect(cost.status).toBe('posted');
    expect(lines(cost)).toEqual(['D 345 800.00', 'C 711 800.00']);
    expect(cost.effect!.date).toBe('2026-03-31');
    // Nothing to spread at the actual cost.
    const spread = await s.propose('production.differences', { month: '2026-03' });
    expect(codes(spread)).toContain('PRODUCTION_NOT_STANDARD');
  });

  test('the year-end count of products and work in progress, and their write-down', async () => {
    const j = await joinery();
    const { s, items, warehouses, evidence } = j;
    await s.book('stock.receive', {
      date: '2026-12-01',
      warehouseId: warehouses.depot.id,
      supplierId: j.supplier.id,
      reference: 'AV-12',
      evidenceId: await evidence('aviz-12.pdf'),
      lines: [{ itemId: items.board.id, quantity: '20', value: '2000.00' }],
    });
    await s.invoke(s.owner, 'production.boms.record', {
      itemId: items.table.id,
      validFrom: '2026-12-01',
      outputQuantity: '1',
      standardCost: '250.00',
      evidenceId: await evidence('fisa.pdf'),
      lines: [{ itemId: items.board.id, quantity: '2' }],
    });
    const order = async (number: string, quantity: string) =>
      s.invoke<{ id: string }>(s.owner, 'production.orders.open', {
        number,
        itemId: items.table.id,
        quantity,
        openedOn: '2026-12-02',
        evidenceId: await evidence(`${number}.pdf`),
      });
    const done = await order('CP-9', '4');
    const pending = await order('CP-10', '3');
    const give = async (orderId: string, reference: string, boards: string) =>
      s.book('production.consume', {
        orderId,
        date: '2026-12-03',
        warehouseId: warehouses.depot.id,
        reference,
        evidenceId: await evidence(`${reference}.pdf`),
        lines: [{ itemId: items.board.id, quantity: boards }],
      });
    await give(done.id, 'BC-9', '8');
    await give(pending.id, 'BC-10', '4');
    await s.book('production.output', {
      orderId: done.id,
      date: '2026-12-10',
      warehouseId: warehouses.finished.id,
      reference: 'BP-9',
      evidenceId: await evidence('bp-9.pdf'),
      lines: [{ itemId: items.table.id, quantity: '4' }],
    });
    await s.invoke(s.owner, 'production.orders.close', {
      orderId: done.id,
      date: '2026-12-10',
      evidenceId: await evidence('inchidere-cp-9.pdf'),
    });
    // CP-9: 800,00 of boards for 4 tables at 250,00 = 1.000,00, a favourable 200,00; CP-10: 400,00
    // in progress, counted as 3 tables at 50%.
    const cost = await s.book('production.cost', {
      month: '2026-12',
      labour: { method: 'none' },
      overheads: [],
      wip: {
        evidenceId: await evidence('inventar-pic.pdf'),
        orders: [
          {
            orderId: pending.id,
            itemId: items.tablesInProgress.id,
            warehouseId: warehouses.shop.id,
            quantity: '3',
            completion: '50',
          },
        ],
      },
    });
    expect(lines(cost)).toEqual(['D 331 400.00', 'C 711 400.00', 'D 711 200.00', 'C 348 200.00']);

    // The annual inventory lists the products and the work in progress with the materials: one
    // table is missing.
    const listFile = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'lista-inventariere.txt',
      mediaType: 'text/plain',
      base64: Buffer.from('Lista de inventariere 31.12.2026').toString('base64'),
    });
    const row = (
      account: string,
      code: string,
      name: string,
      quantity: string,
      warehouse: string,
    ) => ({
      account,
      code,
      name,
      unit: 'H87',
      quantity,
      warehouse,
    });
    const list = await s.invoke<{ id: string }>(s.owner, 'documents.record', {
      evidenceId: listFile.id,
      kind: 'inventory.list',
      body: {
        title: 'Lista de inventariere la 31.12.2026',
        company: { name: 'Tâmplăria Exemplu SRL', taxId: cui },
        date: '2026-12-31',
        commission: { decision: '45', decisionDate: '2026-12-01', members: ['Pop Ion'] },
        stock: [
          row('301', 'PAL-18', 'Placă PAL 18 mm', '8', 'D1'),
          row('345', 'MASA-1', 'Masă de bucătărie', '3', 'P1'),
          row('331', 'PIC-MASA', 'Mese în curs de execuție', '3', 'A1'),
        ],
      },
    });
    const compared = await s.invoke<{
      differences: { kind: string; code?: string; book?: string; found?: string }[];
      unsupported?: { code: string }[];
    }>(s.owner, 'inventory.compare', { date: '2026-12-31' });
    expect((compared.unsupported ?? []).map((item) => item.code)).not.toContain('INVENTORY_STOCK');
    const counted = await s.propose('inventory.stock', {
      date: '2026-12-31',
      documentIds: [list.id],
      evidenceId: await evidence('decizie-pv.pdf'),
      causes: [
        { itemId: items.table.id, warehouseId: warehouses.finished.id, cause: 'unimputable' },
      ],
    });
    // The missing table leaves at its registration price onto 711 (the function of 345); the VAT
    // deducted on what it was made of is adjusted on its cost, acknowledged.
    expect(lines(counted)).toEqual(['C 345 250.00', 'D 711 250.00', 'D 635 52.50', 'C 4426 52.50']);
    expect(codes(counted)).toEqual(
      expect.arrayContaining(['PRODUCT_SHORTAGE_VAT', 'PROFIT_SHORTAGE']),
    );
    await s.post(
      await s.approve(counted, s.reviewer, [
        'PRODUCT_SHORTAGE_VAT',
        'PROFIT_SHORTAGE',
        'SOURCE_EXTRACTED',
      ]),
    );
    // The three tables left are worth 600,00 net of selling costs: written down by 150,00 (3945).
    const writeDown = await s.book('impairment.stock', {
      date: '2026-12-31',
      evidenceId: await evidence('valoare-realizabila.pdf'),
      items: [{ itemId: items.table.id, value: '600.00' }],
    });
    expect(lines(writeDown)).toEqual(['D 6814 150.00', 'C 3945 150.00']);
  });

  test("the D406 stock file reports production's movements", async () => {
    const j = await joinery();
    await costed(j).then(async ({ revised }) => j.s.post(await j.s.approve(revised)));
    await j.s.book('production.differences', { month: '2026-03' });
    const prepared = await j.s.invoke<{ id: string; state: string; evidenceId: string }>(
      j.s.owner,
      'declarations.prepare',
      { kind: 'D406', period: '2026-03-C', options: { contact } },
    );
    expect(prepared.state).toBe('prepared');
    const { base64 } = await j.s.invoke<{ base64: string }>(j.s.owner, 'evidence.get', {
      id: prepared.evidenceId,
    });
    const root = sourceXml(new Uint8Array(Buffer.from(base64, 'base64')));
    const text = (name: string) =>
      root.children
        .flatMap(function find(node): typeof root.children {
          return [...(node.local === name ? [node] : []), ...node.children.flatMap(find)];
        })
        .map((node) => node.text.trim());
    // Received (10), consumed by the orders (70), produced (20: the products and the work in
    // progress), sold (30).
    expect([...new Set(text('MovementType'))].sort()).toEqual(['10', '20', '30', '70']);
    expect(text('ProductType')).toEqual(
      expect.arrayContaining(['Produse finite', 'Productie in curs']),
    );
  });

  test("the month's D406 reports the tables sold on their revenue, not on 711", async () => {
    const j = await joinery();
    await costed(j).then(async ({ revised }) => j.s.post(await j.s.approve(revised)));
    await j.s.book('production.differences', { month: '2026-03' });
    await j.s.invoke(j.s.owner, 'parties.recordDetails', {
      partyId: j.supplier.id,
      details: {
        name: 'Furnizor PAL SRL',
        vatId: 'RO25648378',
        address: {
          lines: ['Str. Fabricii 2'],
          city: 'Brăila',
          subdivision: 'RO-BR',
          country: 'RO',
        },
      },
    });
    const prepared = await j.s.invoke<{ state: string }>(j.s.owner, 'declarations.prepare', {
      kind: 'D406',
      period: '2026-03',
      options: { contact, accounts: { '605': '6051', '646': '6461' } },
    });
    expect(prepared.state).toBe('prepared');
  });

  official(
    "the month's stock file with production passes ANAF's SAF-T validator",
    async () => {
      const j = await joinery(kits());
      await costed(j).then(async ({ revised }) => j.s.post(await j.s.approve(revised)));
      await j.s.book('production.differences', { month: '2026-03' });
      const prepared = await j.s.invoke<{
        state: string;
        steps: { detail: string | null }[];
      }>(j.s.owner, 'declarations.prepare', {
        kind: 'D406',
        period: '2026-03-C',
        options: { contact },
      });
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
    },
    180_000,
  );

  test('is agent-ready: documents, questions, detectors, operations', async () => {
    const j = await joinery();
    expect(productionAgent.documentTypes.map((item) => item.id)).toEqual([
      'production.policy',
      'production.bom',
      'production.order',
      'production.consumption.slip',
      'production.handover',
      'production.timesheet',
      'production.machine.log',
      'production.capacity',
      'production.wip.count',
      'production.loss.record',
    ]);
    expect(productionAgent.questions.map((item) => item.kind)).toEqual([
      'production.excess',
      'profile.fact',
    ]);
    for (const detector of productionAgent.detectors)
      for (const step of detector.next)
        expect(j.s.engine.operations.find(step.operation)).toBeDefined();
    for (const id of [
      'production.consume.propose',
      'production.output.propose',
      'production.cost.propose',
      'production.wipReverse.propose',
      'production.differences.propose',
      'production.boms.record',
      'production.orders.open',
    ])
      expect(j.s.engine.operations.get(id).agent).toBe(true);
  });
});
