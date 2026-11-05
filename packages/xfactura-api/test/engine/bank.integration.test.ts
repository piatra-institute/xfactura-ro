import { afterAll, describe, expect, test } from 'bun:test';
import type { ProposalView } from '../../source/engine/kernel/views';
import { camt, camtEntry, iban, mt940 } from './fixtures/bank';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

type Movement = { id: string; amount: string; reference: string; settled: boolean };

/** A VAT-registered company with one bank account opened at 1,000.00, one purchase and one sale. */
async function books(openingAmount = '1000.00') {
  const s = await scenario();
  open.push(s);
  const { id: certificate } = await s.evidence('certificat-tva.pdf');
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
    evidenceId: certificate,
  });
  await s.invoke(s.owner, 'treasury.createAccount', {
    kind: 'bank',
    name: 'Cont curent',
    iban,
    currency: 'RON',
    ledgerAccount: '5121',
    openedOn: '2026-01-01',
  });
  const { id: evidenceId } = await s.evidence('balanta-deschidere.pdf');
  await s.book(
    'ledger.general',
    journal(
      evidenceId,
      [
        { account: '5121', side: 'D', amount: openingAmount },
        { account: '1012', side: 'C', amount: openingAmount },
      ],
      { date: '2026-01-01', purpose: 'opening' },
    ),
  );
  const invoice = async (input: XmlInput, account: string) => {
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: `${input.number}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(invoiceXml(input)).toString('base64'),
    });
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId: id });
    const posted = await s.book('invoices.recognize', { documentId: document.id, account });
    return posted.effect!.openItems[0]!.id;
  };
  const payable = await invoice({ number: 'INV-1' }, '628');
  const receivable = await invoice({ number: 'SALE-1', direction: 'sale' }, '704');
  const statement = async () => {
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'extras-octombrie.sta',
      mediaType: 'text/plain',
      base64: Buffer.from(mt940).toString('base64'),
    });
    return s.invoke<{ statements: { added: number; movements: number }[] }>(
      s.owner,
      'bank.import',
      {
        evidenceId: id,
        financialYearId: s.year.id,
      },
    );
  };
  const imported = await statement();
  const movements = await s.list<Movement>(s.owner, 'bank.movements', {});
  const find = (amount: string) => movements.find((movement) => movement.amount === amount)!;
  return {
    s,
    payable,
    receivable,
    imported,
    statement,
    payment: find('-100.00'),
    fee: find('-2.03'),
    receipt: find('50.00'),
  };
}
const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);
const findings = (action: { preview: unknown }) =>
  (action.preview as { findings: { code: string }[] }).findings.map((finding) => finding.code);

describe('statement import', () => {
  test('keeps each reported movement once however often the file is imported', async () => {
    const { s, imported, statement } = await books();
    expect(imported.statements).toEqual([
      expect.objectContaining({ movements: 3, added: 3, opening: '1000.00', closing: '947.97' }),
    ]);
    expect((await statement()).statements[0]?.added).toBe(0);
    expect(await s.list<Movement>(s.owner, 'bank.movements', {})).toHaveLength(3);
  });

  test('refuses statements for accounts that are not configured', async () => {
    const s = await scenario();
    open.push(s);
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'extras.sta',
      mediaType: 'text/plain',
      base64: Buffer.from(mt940).toString('base64'),
    });
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'bank.import', { evidenceId: id, financialYearId: s.year.id }),
        )
      )?.code,
    ).toBe('BANK_ACCOUNT');
  });
});

type Entry = { date: string; amount: string; text: string };
type Balances = [opening: string, closing: string];
const yymmdd = (date: string) => date.slice(2).replaceAll('-', '');
const comma = (amount: string) => amount.replace('-', '').replace('.', ',');
/** An MT940 statement whose entries carry no bank reference; `from` dates the opening balance. */
function mtStatement(
  number: string,
  from: string,
  to: string,
  [opening, closing]: Balances,
  entries: Entry[] = [],
) {
  return [
    `:20:${number}`,
    `:25:${iban}`,
    ':28C:001/001',
    `:60F:C${yymmdd(from)}RON${comma(opening)}`,
    ...entries.flatMap(({ date, amount, text }) => [
      `:61:${yymmdd(date)}${yymmdd(date).slice(2)}${amount.startsWith('-') ? 'D' : 'C'}${comma(amount)}NTRF${text}`,
      `:86:${text}`,
    ]),
    `:62F:C${yymmdd(to)}RON${comma(closing)}`,
  ].join('\n');
}
/** A camt.053 statement whose entries carry neither the bank's reference nor an entry reference. */
function camtStatement(
  id: string,
  from: string,
  to: string,
  [opening, closing]: Balances,
  entries: Entry[] = [],
) {
  return camt({
    id,
    from,
    to,
    opening,
    closing,
    entries: entries
      .map(({ date, amount, text }) =>
        camtEntry({
          amount: amount.replace('-', ''),
          date,
          direction: amount.startsWith('-') ? 'DBIT' : 'CRDT',
          text,
        }).replace(/<NtryRef>[^<]*<\/NtryRef>/, ''),
      )
      .join(''),
  });
}
const october: Entry[] = [
  { date: '2026-10-05', amount: '-100.00', text: 'INV-1' },
  { date: '2026-10-10', amount: '50.00', text: 'SALE-1' },
];
const octoberCamt = camtStatement(
  'OCTOBER-2026',
  '2026-10-01',
  '2026-10-31',
  ['1000.00', '950.00'],
  october,
);
type Imported = {
  statements: { statementId: string; added: number; warnings: { code: string }[] }[];
};

/** A company with one bank account in lei, and a way to import statement files into it. */
async function account() {
  const s = await scenario();
  open.push(s);
  await s.invoke(s.owner, 'treasury.createAccount', {
    kind: 'bank',
    name: 'Cont curent',
    iban,
    currency: 'RON',
    ledgerAccount: '5121',
    openedOn: '2026-01-01',
  });
  const load = async (filename: string, text: string) => {
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename,
      mediaType: filename.endsWith('.xml') ? 'application/xml' : 'text/plain',
      base64: Buffer.from(text).toString('base64'),
    });
    return s.invoke<Imported>(s.owner, 'bank.import', {
      evidenceId: id,
      financialYearId: s.year.id,
    });
  };
  const refused = (filename: string, text: string) => s.refused(load(filename, text));
  const warnings = async (filename: string, text: string) =>
    (await load(filename, text)).statements.map((item) =>
      item.warnings.map((warning) => warning.code),
    );
  const movements = async () =>
    (await s.list<Movement>(s.owner, 'bank.movements', {})).map((movement) => movement.amount);
  return { load, refused, warnings, movements };
}

describe('statements in sequence', () => {
  test('the same days as camt.053 and then as MT940, without bank references, are refused', async () => {
    const { load, refused, movements } = await account();
    const first = await load('extras-octombrie.xml', octoberCamt);
    expect(first.statements).toEqual([expect.objectContaining({ added: 2, warnings: [] })]);
    // The identical file again is the same statement: nothing is added, nothing is refused.
    expect((await load('extras-octombrie.xml', octoberCamt)).statements).toEqual([
      expect.objectContaining({ statementId: first.statements[0]!.statementId, added: 0 }),
    ]);
    const twice = await refused(
      'extras-octombrie.sta',
      mtStatement('OCT2026', '2026-10-01', '2026-10-31', ['1000.00', '950.00'], october),
    );
    expect([twice?.code, twice?.details]).toEqual([
      'BANK_STATEMENT_OVERLAP',
      expect.objectContaining({ sourceId: 'OCTOBER-2026', format: 'camt.053' }),
    ]);
    expect(twice?.message).toContain(
      'cuprinde zilele 2026-10-01 – 2026-10-31, deja acoperite de extrasul OCTOBER-2026 (camt.053, 2026-10-01 – 2026-10-31, fișierul extras-octombrie.xml)',
    );
    expect(await movements()).toEqual(['-100.00', '50.00']);
  });

  test('a monthly camt.053 after a daily MT940 of its days is refused, and so is a partial overlap', async () => {
    const { load, refused, movements } = await account();
    await load(
      'extras-2026-10-05.sta',
      mtStatement('D20261005', '2026-10-05', '2026-10-05', ['1000.00', '900.00'], [october[0]!]),
    );
    const monthly = await refused('extras-octombrie.xml', octoberCamt);
    expect([monthly?.code, monthly?.details]).toEqual([
      'BANK_STATEMENT_OVERLAP',
      expect.objectContaining({ sourceId: 'D20261005/001/001', format: 'mt940' }),
    ]);
    expect(monthly?.message).toContain(
      'cuprinde ziua 2026-10-05, deja acoperită de extrasul D20261005/001/001',
    );
    await load(
      'extras-2026-10-06-15.xml',
      camtStatement('OCT-06-15', '2026-10-06', '2026-10-15', ['900.00', '950.00'], [october[1]!]),
    );
    const partial = await refused(
      'extras-2026-10-11-31.xml',
      camtStatement('OCT-11-31', '2026-10-11', '2026-10-31', ['950.00', '950.00']),
    );
    expect([partial?.code, partial?.details]).toEqual([
      'BANK_STATEMENT_OVERLAP',
      expect.objectContaining({ sourceId: 'OCT-06-15' }),
    ]);
    expect(partial?.message).toContain('cuprinde zilele 2026-10-11 – 2026-10-15');
    expect(await movements()).toEqual(['-100.00', '50.00']);
  });

  test('adjacent statements are accepted in any order, however the bank dates the opening balance', async () => {
    const { warnings, refused, movements } = await account();
    // November first, then October, the month before it.
    const november = mtStatement(
      'NOV2026',
      '2026-11-01',
      '2026-11-30',
      ['950.00', '930.00'],
      [{ date: '2026-11-03', amount: '-20.00', text: 'COMISION' }],
    );
    expect(await warnings('extras-noiembrie.sta', november)).toEqual([[]]);
    expect(await warnings('extras-octombrie.xml', octoberCamt)).toEqual([[]]);
    // December opens on 30 November, November's closing date, as SWIFT dates field 60F. It takes
    // over on that day, so it may not report a movement on it: November does.
    const onHandover = await refused(
      'extras-decembrie.sta',
      mtStatement(
        'DEC2026',
        '2026-11-30',
        '2026-12-31',
        ['930.00', '1030.00'],
        [{ date: '2026-11-30', amount: '100.00', text: 'SALE-2' }],
      ),
    );
    expect(onHandover?.code).toBe('BANK_STATEMENT_OVERLAP');
    const december = mtStatement(
      'DEC2026',
      '2026-11-30',
      '2026-12-31',
      ['930.00', '1030.00'],
      [{ date: '2026-12-01', amount: '100.00', text: 'SALE-2' }],
    );
    expect(await warnings('extras-decembrie.sta', december)).toEqual([[]]);
    expect(await movements()).toEqual(['-100.00', '50.00', '-20.00', '100.00']);
  });

  test('a break between adjacent statements is refused; one across missing days is a warning', async () => {
    const { load, refused, warnings } = await account();
    await load('extras-octombrie.xml', octoberCamt);
    // The next day at another balance: one of the two documents is wrong.
    const next = await refused(
      'extras-noiembrie.sta',
      mtStatement('NOV2026', '2026-11-01', '2026-11-30', ['900.00', '900.00']),
    );
    expect([next?.code, next?.details]).toEqual([
      'BANK_STATEMENT_CHAIN',
      expect.objectContaining({ sourceId: 'OCTOBER-2026' }),
    ]);
    expect(next?.message).toContain(
      'Soldul inițial al extrasului NOV2026/001/001 (900.00 RON la 2026-11-01) nu continuă soldul final al extrasului OCTOBER-2026',
    );
    // The same, opening on October's closing date.
    const handover = await refused(
      'extras-noiembrie.sta',
      mtStatement('NOV2026', '2026-10-31', '2026-11-30', ['900.00', '900.00']),
    );
    expect(handover?.code).toBe('BANK_STATEMENT_CHAIN');
    // December with November missing: the difference may be November's, so it is recorded.
    expect(
      await warnings(
        'extras-decembrie.sta',
        mtStatement('DEC2026', '2026-12-01', '2026-12-31', ['900.00', '900.00']),
      ),
    ).toEqual([['STATEMENT_GAP']]);
    // November, once it comes, chains on both sides.
    const closesWrong = await refused(
      'extras-noiembrie.sta',
      mtStatement(
        'NOV2026',
        '2026-11-01',
        '2026-11-30',
        ['950.00', '880.00'],
        [{ date: '2026-11-03', amount: '-70.00', text: 'CHIRIE' }],
      ),
    );
    expect([closesWrong?.code, closesWrong?.details]).toEqual([
      'BANK_STATEMENT_CHAIN',
      expect.objectContaining({ sourceId: 'DEC2026/001/001' }),
    ]);
    expect(
      await warnings(
        'extras-noiembrie.sta',
        mtStatement(
          'NOV2026',
          '2026-11-01',
          '2026-11-30',
          ['950.00', '900.00'],
          [{ date: '2026-11-03', amount: '-50.00', text: 'CHIRIE' }],
        ),
      ),
    ).toEqual([[]]);
  });

  test('missing days the balances bridge are no warning: banks skip days without movements', async () => {
    const { load, warnings } = await account();
    await load('extras-octombrie.xml', octoberCamt);
    expect(
      await warnings(
        'extras-decembrie.sta',
        mtStatement('DEC2026', '2026-12-01', '2026-12-31', ['950.00', '950.00']),
      ),
    ).toEqual([[]]);
  });
});

describe('settlement', () => {
  test('partial payments, fees and receipts settle their items exactly', async () => {
    const { s, payable, receivable, payment, fee, receipt } = await books();
    const paid = await s.book('bank.settle', {
      movementId: payment.id,
      allocations: [{ openItem: payable, amount: '100.00' }],
    });
    expect(lines(paid)).toEqual(['C 5121 100.00', 'D 401 100.00']);
    expect(
      lines(
        await s.book('bank.settle', {
          movementId: fee.id,
          lines: [{ account: '627', amount: '2.03' }],
        }),
      ),
    ).toEqual(['C 5121 2.03', 'D 627 2.03']);
    await s.book('bank.settle', {
      movementId: receipt.id,
      allocations: [{ openItem: receivable, amount: '50.00' }],
    });
    const balance = await s.trialBalance();
    const closing = (account: string) =>
      balance.rows.find((row) => row.account === account)?.closing;
    expect([closing('401'), closing('4111'), closing('5121')]).toEqual([
      { debit: '0.00', credit: '21.00' },
      { debit: '71.00', credit: '0.00' },
      { debit: '947.97', credit: '0.00' },
    ]);
    expect((await s.list<Movement>(s.owner, 'bank.movements', { unsettled: true })).length).toBe(0);
  });

  test('a movement is explained in full, once, and never past an item balance', async () => {
    const { s, receivable, receipt } = await books();
    const short = await s.propose('bank.settle', {
      movementId: receipt.id,
      allocations: [{ openItem: receivable, amount: '40.00' }],
    });
    expect(codes(short)).toEqual(['UNEXPLAINED']);
    await s.invoke(s.owner, 'proposals.withdraw', {
      proposalId: short.id,
      reason: 'Sumă greșită introdusă',
    });
    const corrected = await s.book('bank.settle', {
      movementId: receipt.id,
      allocations: [{ openItem: receivable, amount: '50.00' }],
    });
    expect(corrected.status).toBe('posted');
    const again = await s.refused(
      s.propose('bank.settle', {
        movementId: receipt.id,
        lines: [{ account: '766', amount: '50.00' }],
      }),
    );
    expect(again?.code).toBe('SUBJECT_EXISTS');
  });

  test('a reversed settlement frees its movement and reopens what it settled, settled once again', async () => {
    const { s, payable, payment } = await books();
    const state = async () =>
      (await s.list<Movement & { state: string }>(s.owner, 'bank.movements', {})).find(
        (movement) => movement.id === payment.id,
      )!.state;
    const unexplained = async () =>
      (
        await s.invoke<{ items: { subject: { id: string } }[] }>(s.owner, 'work.list', {
          kinds: ['bank.unexplained'],
        })
      ).items.some((item) => item.subject.id === payment.id);
    const { id: note } = await s.evidence('nota-storno.pdf');
    const reverse = (entryId: string) =>
      s.book('ledger.reverse', {
        entryId,
        date: '2026-10-25',
        reason: 'Plata a fost explicată greșit: se reface explicația.',
        evidenceId: note,
        method: 'red',
      });
    const settle = {
      movementId: payment.id,
      allocations: [{ openItem: payable, amount: '100.00' }],
    };
    // Explained as a bank fee by mistake.
    const wrong = await s.book('bank.settle', {
      movementId: payment.id,
      lines: [{ account: '627', amount: '100.00' }],
    });
    expect([await state(), await unexplained()]).toEqual(['settled', false]);
    expect((await s.refused(s.propose('bank.settle', settle)))?.code).toBe('SUBJECT_EXISTS');
    await reverse(wrong.entry!.id);
    // Unexplained again: the worklist and the movements say so, and it is proposed anew.
    expect([await state(), await unexplained()]).toEqual(['unexplained', true]);
    const right = await s.book('bank.settle', settle);
    expect(lines(right)).toEqual(['C 5121 100.00', 'D 401 100.00']);
    expect(await state()).toBe('settled');
    // Its reversal reopens the invoice it paid, which the new settlement settles once.
    await reverse(right.entry!.id);
    const reopened = await s.list<{ id: string; balance: string }>(s.owner, 'openItems.list', {});
    expect(reopened.find((item) => item.id === payable)?.balance).toBe('-121.00');
    await s.book('bank.settle', settle);
    const balance = await s.trialBalance();
    const closing = (account: string) =>
      balance.rows.find((row) => row.account === account)?.closing;
    expect([closing('401'), closing('627'), closing('5121')]).toEqual([
      { debit: '0.00', credit: '21.00' },
      { debit: '0.00', credit: '0.00' },
      { debit: '900.00', credit: '0.00' },
    ]);
    expect(await state()).toBe('settled');
  });

  test('partner accounts are settled through open items, not directly', async () => {
    const { s, fee } = await books();
    const proposal = await s.propose('bank.settle', {
      movementId: fee.id,
      lines: [{ account: '401', amount: '2.03' }],
    });
    expect(codes(proposal)).toContain('CONTROL_ACCOUNT');
  });

  test('a payment is not allocated to an amount for later months (471): its schedule releases it', async () => {
    const { s, payable, payment } = await books();
    const items = await s.list<{ id: string; partyId: string; kind: string }>(
      s.owner,
      'openItems.list',
      {},
    );
    const supplier = items.find((item) => item.id === payable)!.partyId;
    await s.book('deferrals.defer', {
      date: '2026-10-01',
      account: '628',
      amount: '100.00',
      from: '2026-10',
      months: 2,
      partyId: supplier,
      evidenceId: (await s.evidence('contract-abonament.pdf')).id,
    });
    const deferral = (
      await s.list<{ id: string; kind: string }>(s.owner, 'openItems.list', {})
    ).find((item) => item.kind === 'deferral.expense')!;
    // Allocated there, the payment would expense the amount twice and leave INV-1 unpaid.
    const wrong = await s.propose('bank.settle', {
      movementId: payment.id,
      allocations: [{ openItem: deferral.id, amount: '100.00' }],
    });
    expect(codes(wrong)).toEqual(['OPEN_ITEM_KIND']);
    const right = await s.revise('bank.settle', wrong, {
      movementId: payment.id,
      allocations: [{ openItem: payable, amount: '100.00' }],
    });
    expect(lines(right)).toEqual(['C 5121 100.00', 'D 401 100.00']);
  });

  test('money from an associate opens their account (4551); an advance is opened by a payment', async () => {
    const { s, receipt } = await books();
    const associate = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_individual',
      country: 'RO',
      name: 'Popescu Ana',
    });
    const wrong = await s.propose('bank.settle', {
      movementId: receipt.id,
      opens: [{ account: '542', partyId: associate.id, amount: receipt.amount }],
    });
    expect(codes(wrong)).toEqual(['DIRECTION']);
    const loan = await s.revise('bank.settle', wrong, {
      movementId: receipt.id,
      opens: [{ account: '4551', partyId: associate.id, amount: receipt.amount }],
    });
    expect(loan.issues).toEqual([]);
    expect(loan.effect?.lines.map((line) => `${line.side} ${line.account}`)).toEqual([
      'D 5121',
      'C 4551',
    ]);
    await s.post(await s.approve(loan));
    const [item] = await s.list<{ account: string; kind: string }>(s.owner, 'openItems.list', {
      partyId: associate.id,
    });
    expect([item?.account, item?.kind]).toEqual(['4551', 'payable']);
  });

  test('a receipt cannot settle more than the receivable', async () => {
    const { s, receipt } = await books();
    const { id: evidenceId } = await s.evidence();
    const client = await s.party('Client mic');
    const small = await s.book(
      'ledger.general',
      journal(
        evidenceId,
        [
          { account: '4111', side: 'D', amount: '30.00', newItem: 'mic' },
          { account: '704', side: 'C', amount: '30.00' },
        ],
        { date: '2026-10-02', newItems: [{ ref: 'mic', partyId: client.id }] },
      ),
    );
    const proposal = await s.propose('bank.settle', {
      movementId: receipt.id,
      allocations: [{ openItem: small.effect!.openItems[0]!.id, amount: '50.00' }],
    });
    expect(codes(proposal)).toEqual(['OPEN_ITEM_REVERSED']);
  });
});

describe('month close with bank', () => {
  test('every movement must be explained and the ledger must equal the statement', async () => {
    const { s, payable, receivable, payment, fee, receipt } = await books();
    await s.closeApproved('2026-01');
    // The supplier's status at ANAF was never checked: a warning, not a block.
    expect(findings(await s.close('2026-10'))).toEqual([
      'UNEXPLAINED_MOVEMENTS',
      'BANK_BALANCE',
      'SUPPLIER_STATUS_UNCHECKED',
    ]);
    await s.book('bank.settle', {
      movementId: payment.id,
      allocations: [{ openItem: payable, amount: '100.00' }],
    });
    await s.book('bank.settle', {
      movementId: fee.id,
      lines: [{ account: '627', amount: '2.03' }],
    });
    await s.book('bank.settle', {
      movementId: receipt.id,
      allocations: [{ openItem: receivable, amount: '50.00' }],
    });
    const closed = await s.closeApproved('2026-10');
    expect(closed.status).toBe('executed');
  });

  test('a ledger that disagrees with the statement blocks the close', async () => {
    const { s, payable, receivable, payment, fee, receipt } = await books('900.00');
    await s.closeApproved('2026-01');
    await s.book('bank.settle', {
      movementId: payment.id,
      allocations: [{ openItem: payable, amount: '100.00' }],
    });
    await s.book('bank.settle', {
      movementId: fee.id,
      lines: [{ account: '627', amount: '2.03' }],
    });
    await s.book('bank.settle', {
      movementId: receipt.id,
      allocations: [{ openItem: receivable, amount: '50.00' }],
    });
    expect(findings(await s.close('2026-10'))).toEqual([
      'BANK_BALANCE',
      'SUPPLIER_STATUS_UNCHECKED',
    ]);
  });
});
