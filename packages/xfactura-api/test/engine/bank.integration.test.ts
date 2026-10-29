import { afterAll, describe, expect, test } from 'bun:test';
import type { ProposalView } from '../../source/engine/kernel/views';
import { iban, mt940 } from '../accounting/fixtures/bank';
import { invoiceXml, type XmlInput } from '../accounting/fixtures/invoice';
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
  const movements = await s.invoke<Movement[]>(s.owner, 'bank.movements', {});
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
    expect(await s.invoke<Movement[]>(s.owner, 'bank.movements', {})).toHaveLength(3);
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
    expect(
      (await s.invoke<Movement[]>(s.owner, 'bank.movements', { unsettled: true })).length,
    ).toBe(0);
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

  test('partner accounts are settled through open items, not directly', async () => {
    const { s, fee } = await books();
    const proposal = await s.propose('bank.settle', {
      movementId: fee.id,
      lines: [{ account: '401', amount: '2.03' }],
    });
    expect(codes(proposal)).toContain('CONTROL_ACCOUNT');
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
    expect(findings(await s.close('2026-10'))).toEqual(['UNEXPLAINED_MOVEMENTS', 'BANK_BALANCE']);
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
    expect(findings(await s.close('2026-10'))).toEqual(['BANK_BALANCE']);
  });
});
