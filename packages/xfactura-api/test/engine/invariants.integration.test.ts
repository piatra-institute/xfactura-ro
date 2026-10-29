import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { canonical, derivedId } from 'xfactura-core/hash';
import type { Effect } from 'xfactura-core/kernel';
import { guardedTables, invariantRules, mutableTables } from '../../source/engine/db/invariants';
import {
  actionDecisions,
  actionExecutions,
  actionRequests,
  agentGrants,
  audit,
  bankMovements,
  bankStatements,
  commands,
  documentLinks,
  documents,
  entries,
  evidence,
  fiscalYears,
  fxRates,
  invitations,
  issuedNumbers,
  ledgerAccounts,
  lines,
  memberships,
  parties,
  partyVersions,
  periodBalances,
  policyRevocations,
  postingPolicies,
  profileFacts,
  proposals,
  series,
  taxPeriodEvents,
  treasuryAccounts,
  withdrawals,
} from '../../source/engine/db/schema';
import {
  approve,
  approvedAction,
  book,
  createWorld,
  day,
  effect,
  epoch,
  periodEvent,
  post,
  propose,
  receivable,
  refusal,
  sale,
  type World,
} from './world';

type Attack = {
  trigger: string;
  code: string;
  name: string;
  run: (world: World) => Promise<unknown>;
};

const later = Date.now() + 86_400_000;
async function policy(world: World, approver = world.reviewer) {
  const id = randomUUID();
  await world.db.write(async (tx) =>
    tx.insert(postingPolicies).values({
      id,
      companyId: world.company,
      name: 'Facturi emise',
      treatments: canonical(['test.treatment']),
      rulesHashes: canonical(['rules-1']),
      preconditions: '[]',
      approvedBy: approver,
      approverEpoch: await epoch(world, approver),
      validFrom: '2026-01-01',
      expiresAt: later,
    }),
  );
  return id;
}
const withdraw = (world: World, proposalId: string) =>
  world.db.write((tx) =>
    tx
      .insert(withdrawals)
      .values({ companyId: world.company, proposalId, reason: 'test', createdBy: world.owner }),
  );
const header = (
  world: World,
  proposalId: string,
  approvalId: string,
  numbering: { number: number; seq: number },
) =>
  world.db.write((tx) =>
    tx.insert(entries).values({
      id: randomUUID(),
      companyId: world.company,
      fiscalYearId: world.year,
      journalClass: 'general',
      journalCode: 'VANZARI',
      ...numbering,
      date: '2026-03-10',
      period: '2026-03',
      description: 'Factura test',
      proposalId,
      version: 1,
      approvalId,
      postedBy: world.owner,
    }),
  );
const approved = async (
  world: World,
  value: Effect,
  options: Parameters<typeof propose>[2] = {},
) => {
  const proposed = await propose(world, value, options);
  return { proposed, approvalId: await approve(world, proposed) };
};
const plain = (debit: bigint, credit: bigint, account = '5121') =>
  effect([
    { account, side: 'D', bani: debit },
    { account: '704', side: 'C', bani: credit },
  ]);
const receipt = (world: World, item: string, bani: bigint) =>
  effect(
    [
      { account: '5121', side: 'D', bani },
      { account: '4111', side: 'C', bani, openItem: item },
    ],
    { journalCode: 'BANCA', description: 'Încasare' },
  );
const eur = { code: 'EUR', rateId: 'bnr-2026-03-10', rate: '4.9765' };
function prepaid(world: World) {
  const asset = {
    ...receivable(world),
    kind: 'deferral.expense' as const,
    controlAccount: '471',
    partyId: world.supplier,
  };
  const payable = {
    ...receivable(world),
    kind: 'payable' as const,
    controlAccount: '401',
    partyId: world.supplier,
    normalSide: 'C' as const,
  };
  return effect(
    [
      { account: '471', side: 'D', bani: 120000n, openItem: asset.ref },
      { account: '401', side: 'C', bani: 120000n, openItem: payable.ref, partyId: world.supplier },
    ],
    {
      journalCode: 'CUMPARARI',
      openItems: [asset, payable],
      schedules: [
        {
          ref: derivedId('schedule', asset.ref),
          openItem: asset.ref,
          version: 1,
          method: 'equal-months',
          basis: null,
          rows: ['04', '05', '06'].map((month) => ({
            key: `2026-${month}`,
            due: day(`2026-${month}-30`),
            bani: 40000n,
            counterAccount: '628',
          })),
        },
      ],
    },
  );
}

/** The company's own details, the client's, series XF (invoices only) and a way to number. */
async function issuing(world: World) {
  const self = randomUUID();
  const seriesId = randomUUID();
  await world.db.write(async (tx) => {
    await tx.insert(parties).values({
      id: self,
      companyId: world.company,
      kind: 'self',
      country: 'RO',
      taxId: '12345678',
      name: 'Test SRL',
      createdBy: world.owner,
    });
    await tx.insert(partyVersions).values(
      [self, world.client].map((partyId) => ({
        companyId: world.company,
        partyId,
        version: 1,
        details: '{}',
        detailsHash: partyId,
        createdBy: world.owner,
      })),
    );
    await tx.insert(series).values({
      id: seriesId,
      companyId: world.company,
      code: 'XF',
      prefix: 'XF',
      width: 4,
      firstNumber: 1,
      typeCodes: canonical(['380']),
      revenueAccount: '704',
      createdBy: world.owner,
    });
  });
  /** A sales document numbered `text`, dated `date`, outside any series. */
  const document = async (text: string, date = '2026-03-10', kind = 'invoice.issued') => {
    const id = randomUUID();
    await world.db.write((tx) =>
      tx.insert(documents).values({
        id,
        companyId: world.company,
        kind,
        schema: 'test',
        body: '{}',
        bodyHash: id,
        sourceKey: id,
        origin: 'issued',
        docDate: date,
        partyId: world.client,
        number: text,
        createdBy: world.owner,
      }),
    );
    return id;
  };
  const issue = async (
    number: number,
    options: { text?: string; date?: string; typeCode?: string; buyerVersion?: number } = {},
  ) => {
    const date = options.date ?? '2026-03-10';
    const typeCode = options.typeCode ?? '380';
    const documentId = await document(
      options.text ?? `XF${String(number).padStart(4, '0')}`,
      date,
      typeCode === '381' ? 'creditNote.issued' : 'invoice.issued',
    );
    await world.db.write((tx) =>
      tx.insert(issuedNumbers).values({
        companyId: world.company,
        seriesId,
        number,
        typeCode,
        issueDate: date,
        documentId,
        sellerVersion: 1,
        buyerVersion: options.buyerVersion ?? 1,
        createdBy: world.owner,
      }),
    );
  };
  return { document, issue };
}

const entry = 'inv_entry_guard';
const numbering = 'inv_issued_number_guard';
const attacks: Attack[] = [
  {
    trigger: 'inv_party_version_guard',
    code: 'party_version_sequence',
    name: 'a party details version that skips a number',
    run: async (world) =>
      world.db.write((tx) =>
        tx.insert(partyVersions).values({
          companyId: world.company,
          partyId: world.client,
          version: 2,
          details: '{}',
          detailsHash: 'h',
          createdBy: world.owner,
        }),
      ),
  },
  {
    trigger: numbering,
    code: 'series_sequence',
    name: 'a gap in a series',
    run: async (world) => (await issuing(world)).issue(2),
  },
  {
    trigger: numbering,
    code: 'series_date_order',
    name: 'a later number with an earlier date',
    run: async (world) => {
      const { issue } = await issuing(world);
      await issue(1, { date: '2026-03-10' });
      await issue(2, { date: '2026-03-09' });
    },
  },
  {
    trigger: numbering,
    code: 'series_type',
    name: 'a credit note from an invoice-only series',
    run: async (world) => (await issuing(world)).issue(1, { typeCode: '381' }),
  },
  {
    trigger: numbering,
    code: 'series_document',
    name: 'a number the document does not carry',
    run: async (world) => (await issuing(world)).issue(1, { text: 'XF1' }),
  },
  {
    trigger: numbering,
    code: 'number_reused',
    name: 'issuing a number an imported sale already carries',
    run: async (world) => {
      const { document, issue } = await issuing(world);
      await document('XF0001', '2026-01-15');
      await issue(1);
    },
  },
  {
    trigger: numbering,
    code: 'party_versions',
    name: 'an invoice citing buyer details that were never recorded',
    run: async (world) => (await issuing(world)).issue(1, { buyerVersion: 5 }),
  },
  {
    trigger: entry,
    code: 'subject_posted',
    name: 'posting a subject a second time',
    run: async (world) => {
      const first = await approved(world, sale(world), { subjectKey: 'document:once' });
      await withdraw(world, first.proposed.proposalId);
      await book(world, sale(world), { subjectKey: 'document:once' });
      return post(world, first.proposed, { approvalId: first.approvalId });
    },
  },
  {
    trigger: entry,
    code: 'proposal_version_missing',
    name: 'posting a version that was never proposed',
    run: async (world) => {
      const { proposed, approvalId } = await approved(world, sale(world));
      return post(world, { ...proposed, version: 2 }, { approvalId });
    },
  },
  {
    trigger: entry,
    code: 'stale_version',
    name: 'posting an approved version after a newer one exists',
    run: async (world) => {
      const { proposed, approvalId } = await approved(world, sale(world));
      await propose(world, sale(world), { proposalId: proposed.proposalId, version: 2 });
      return post(world, proposed, { approvalId });
    },
  },
  {
    trigger: entry,
    code: 'withdrawn',
    name: 'posting a withdrawn proposal',
    run: async (world) => {
      const { proposed, approvalId } = await approved(world, sale(world));
      await withdraw(world, proposed.proposalId);
      return post(world, proposed, { approvalId });
    },
  },
  {
    trigger: entry,
    code: 'blocking_issues',
    name: 'auto-posting a version with blocking issues',
    run: async (world) => {
      const proposed = await propose(world, sale(world), { blocking: true });
      return post(world, proposed, { policyId: await policy(world) });
    },
  },
  {
    trigger: entry,
    code: 'entry_header',
    name: 'posting under a description other than the approved one',
    run: async (world) => {
      const { proposed, approvalId } = await approved(world, sale(world));
      return post(world, proposed, { approvalId }, { ...proposed.effect, description: 'Alta' });
    },
  },
  {
    trigger: entry,
    code: 'fiscal_year',
    name: 'posting outside the financial year',
    run: async (world) => {
      const { proposed, approvalId } = await approved(
        world,
        sale(world, receivable(world), day('2027-01-05')),
      );
      return post(world, proposed, { approvalId });
    },
  },
  {
    trigger: entry,
    code: 'binding',
    name: "posting after the approver's role changed",
    run: async (world) => {
      const { proposed, approvalId } = await approved(world, sale(world));
      await world.db.write((tx) =>
        tx
          .update(memberships)
          .set({ role: 'viewer', epoch: sql`${memberships.epoch} + 1` })
          .where(
            and(eq(memberships.companyId, world.company), eq(memberships.userId, world.reviewer)),
          ),
      );
      return post(world, proposed, { approvalId });
    },
  },
  {
    trigger: entry,
    code: 'binding',
    name: 'auto-posting under a revoked policy',
    run: async (world) => {
      const proposed = await propose(world, sale(world));
      const policyId = await policy(world);
      await world.db.write((tx) =>
        tx.insert(policyRevocations).values({
          companyId: world.company,
          policyId,
          reason: 'test',
          createdBy: world.owner,
        }),
      );
      return post(world, proposed, { policyId });
    },
  },
  {
    trigger: entry,
    code: 'closed_period',
    name: 'posting into a closed month',
    run: async (world) => {
      const { proposed, approvalId } = await approved(world, sale(world));
      await periodEvent(world, '2026-03');
      return post(world, proposed, { approvalId });
    },
  },
  {
    trigger: entry,
    code: 'entry_number',
    name: 'skipping a journal number',
    run: async (world) => {
      const { proposed, approvalId } = await approved(world, sale(world));
      return header(world, proposed.proposalId, approvalId, { number: 7, seq: 1 });
    },
  },
  {
    trigger: entry,
    code: 'entry_seq',
    name: 'skipping a company sequence number',
    run: async (world) => {
      const { proposed, approvalId } = await approved(world, sale(world));
      return header(world, proposed.proposalId, approvalId, { number: 1, seq: 4 });
    },
  },
  {
    trigger: entry,
    code: 'lines_mismatch',
    name: 'writing lines other than the approved ones',
    run: async (world) => {
      const { proposed, approvalId } = await approved(world, sale(world));
      const rows = structuredClone(proposed.effect);
      rows.lines[0]!.bani += 1n;
      rows.lines[1]!.bani += 1n;
      return post(world, proposed, { approvalId }, rows);
    },
  },
  {
    trigger: entry,
    code: 'lines_mismatch',
    name: 'approving an amount that is not a canonical integer',
    run: async (world) => {
      const value = sale(world);
      const effectJson = canonical(value).replace('"bani":"100000"', '"bani":"100000.0"');
      const { proposed, approvalId } = await approved(world, value, { effectJson });
      return post(world, proposed, { approvalId });
    },
  },
  {
    trigger: entry,
    code: 'line_count',
    name: 'posting a single-line general entry',
    run: async (world) => {
      const { proposed, approvalId } = await approved(
        world,
        effect([{ account: '5121', side: 'D', bani: 100n }]),
      );
      return post(world, proposed, { approvalId });
    },
  },
  {
    trigger: entry,
    code: 'unbalanced',
    name: 'posting an approved but unbalanced entry',
    run: async (world) => {
      const { proposed, approvalId } = await approved(world, plain(100n, 90n));
      return post(world, proposed, { approvalId });
    },
  },
  {
    trigger: entry,
    code: 'account',
    name: 'posting to a group account',
    run: async (world) => {
      const { proposed, approvalId } = await approved(world, plain(100n, 100n, '70'));
      return post(world, proposed, { approvalId });
    },
  },
  {
    trigger: entry,
    code: 'control_open_item',
    name: 'posting to a receivable account without an open item',
    run: async (world) => {
      const { proposed, approvalId } = await approved(world, plain(100n, 100n, '4111'));
      return post(world, proposed, { approvalId });
    },
  },
  {
    trigger: entry,
    code: 'open_items_mismatch',
    name: 'creating an open item that differs from the approved one',
    run: async (world) => {
      const { proposed, approvalId } = await approved(world, sale(world));
      const rows = structuredClone(proposed.effect);
      rows.openItems[0]!.dueDate = day('2026-04-10');
      return post(world, proposed, { approvalId }, rows);
    },
  },
  {
    trigger: entry,
    code: 'open_item_balance',
    name: 'settling more than a receivable',
    run: async (world) => {
      const item = receivable(world);
      await book(world, sale(world, item));
      const { proposed, approvalId } = await approved(world, receipt(world, item.ref, 125000n));
      return post(world, proposed, { approvalId });
    },
  },
  {
    trigger: entry,
    code: 'open_item_balance',
    name: 'closing a foreign-currency item with a RON remainder',
    run: async (world) => {
      const item = { ...receivable(world), currency: 'EUR' };
      await book(
        world,
        effect(
          [
            {
              account: '4111',
              side: 'D',
              bani: 49765n,
              openItem: item.ref,
              currency: { ...eur, minor: 10000n },
            },
            { account: '704', side: 'C', bani: 49765n },
          ],
          { openItems: [item] },
        ),
      );
      const settlement = effect([
        { account: '5124', side: 'D', bani: 50000n, currency: { ...eur, minor: 10000n } },
        {
          account: '4111',
          side: 'C',
          bani: 49000n,
          openItem: item.ref,
          currency: { ...eur, minor: 10000n },
        },
        { account: '765', side: 'C', bani: 1000n },
      ]);
      const { proposed, approvalId } = await approved(world, settlement);
      return post(world, proposed, { approvalId });
    },
  },
  {
    trigger: entry,
    code: 'tax_entries_mismatch',
    name: 'writing tax entries other than the approved ones',
    run: async (world) => {
      const { proposed, approvalId } = await approved(world, sale(world));
      const rows = structuredClone(proposed.effect);
      rows.taxEntries[0]!.attributes = { scenario: 'other' };
      return post(world, proposed, { approvalId }, rows);
    },
  },
  {
    trigger: entry,
    code: 'tax_line',
    name: 'booking output VAT without tax entries',
    run: async (world) => {
      const { proposed, approvalId } = await approved(world, { ...sale(world), taxEntries: [] });
      return post(world, proposed, { approvalId });
    },
  },
  {
    trigger: entry,
    code: 'tax_line',
    name: 'marking a revenue line as a tax settlement',
    run: async (world) => {
      const value = plain(100n, 100n);
      value.lines[1]!.taxSettlement = { tax: 'VAT', period: '2026-03' };
      const { proposed, approvalId } = await approved(world, value);
      return post(world, proposed, { approvalId });
    },
  },
  {
    trigger: entry,
    code: 'tax_period_locked',
    name: 'adding VAT to a filed period',
    run: async (world) => {
      await world.db.write((tx) =>
        tx.insert(taxPeriodEvents).values({
          companyId: world.company,
          tax: 'VAT',
          period: '2026-03',
          seq: 1,
          kind: 'lock',
          reference: 'D300 2026-03',
          createdBy: world.owner,
        }),
      );
      const { proposed, approvalId } = await approved(world, sale(world));
      return post(world, proposed, { approvalId });
    },
  },
  {
    trigger: entry,
    code: 'schedule_mismatch',
    name: 'writing schedule rows other than the approved ones',
    run: async (world) => {
      const { proposed, approvalId } = await approved(world, prepaid(world));
      const rows = structuredClone(proposed.effect);
      rows.schedules[0]!.rows[2]!.due = day('2026-07-01');
      return post(world, proposed, { approvalId }, rows);
    },
  },
  {
    trigger: entry,
    code: 'stale_read',
    name: 'posting a receipt after the receivable changed',
    run: async (world) => {
      const item = receivable(world);
      await book(world, sale(world, item));
      const first = await approved(world, receipt(world, item.ref, 50000n), {
        readSet: [{ kind: 'openItem', id: item.ref, version: '1' }],
      });
      await book(world, receipt(world, item.ref, 20000n));
      return post(world, first.proposed, { approvalId: first.approvalId });
    },
  },
  ...(['acc_lines', 'acc_tax_entries'] as const).map((table): Attack => ({
    trigger: `inv_${table}_sealed`,
    code: 'sealed_entry',
    name: `adding to ${table} after posting`,
    run: async (world) => {
      const { entry: posted } = await book(world, sale(world));
      if (table === 'acc_lines')
        return world.db.write((tx) =>
          tx.insert(lines).values({
            companyId: world.company,
            entryId: posted.id,
            lineNo: 4,
            account: '704',
            side: 'C',
            bani: 1n,
          }),
        );
      return world.db.orm
        .run(sql`INSERT INTO acc_tax_entries (company_id, entry_id, tax_no, key, tax, code, direction,
          base_bani, tax_bani, deductible_bani, ledger_bani, tax_point, attributes_json)
          VALUES (${world.company}, ${posted.id}, 2, 'extra', 'VAT', 'S-21', 'output', 0, 0, 0, 0, '2026-03-10', '{}')`);
    },
  })),
  {
    trigger: 'inv_acc_open_items_sealed',
    code: 'sealed_entry',
    name: 'creating an open item for a posted entry',
    run: async (world) => {
      const { entry: posted } = await book(world, sale(world));
      return world.db.orm
        .run(sql`INSERT INTO acc_open_items (id, company_id, kind, control_account, party_id, currency,
        normal_side, may_reverse, origin_entry_id)
        VALUES (${randomUUID()}, ${world.company}, 'receivable', '4111', ${world.client}, 'RON', 'D', 0, ${posted.id})`);
    },
  },
  {
    trigger: 'inv_acc_schedule_rows_sealed',
    code: 'sealed_entry',
    name: 'adding a schedule row to a posted entry',
    run: async (world) => {
      const posted = await book(world, prepaid(world));
      const schedule = posted.effect.schedules[0]!;
      return world.db.orm
        .run(sql`INSERT INTO acc_schedule_rows (company_id, schedule_id, version, row_key, entry_id,
        open_item_id, method, due_date, bani, counter_account)
        VALUES (${world.company}, ${schedule.ref}, 1, '2026-07', ${posted.entry.id}, ${schedule.openItem},
          'equal-months', '2026-07-31', 1, '628')`);
    },
  },
  {
    trigger: 'inv_acc_lines_no_update',
    code: 'immutable_record',
    name: 'changing a posted amount',
    run: async (world) => {
      await book(world, sale(world));
      return world.db.orm.run(
        sql`UPDATE acc_lines SET bani = bani + 1 WHERE company_id = ${world.company}`,
      );
    },
  },
  {
    trigger: 'inv_acc_entries_no_delete',
    code: 'immutable_record',
    name: 'deleting a posted entry',
    run: async (world) => {
      await book(world, sale(world));
      return world.db.orm.run(sql`DELETE FROM acc_entries WHERE company_id = ${world.company}`);
    },
  },
  ...(
    [
      ['proposal_version_missing', 'approving a version that does not exist', { version: 2 }],
      ['stale_approval', 'approving a different effect hash', { hash: 'f'.repeat(64) }],
      ['approver', 'approving as a viewer', { viewer: true }],
    ] as const
  ).map(([code, name, options]): Attack => ({
    trigger: 'inv_approval_guard',
    code,
    name,
    run: async (world) => {
      const proposed = await propose(world, sale(world));
      return approve(
        world,
        'version' in options ? { ...proposed, version: options.version } : proposed,
        'viewer' in options ? world.viewer : world.reviewer,
        'hash' in options ? options.hash : undefined,
      );
    },
  })),
  {
    trigger: 'inv_approval_guard',
    code: 'stale_version',
    name: 'approving a superseded version',
    run: async (world) => {
      const proposed = await propose(world, sale(world));
      await propose(world, sale(world), { proposalId: proposed.proposalId, version: 2 });
      return approve(world, proposed);
    },
  },
  {
    trigger: 'inv_approval_guard',
    code: 'blocking_issues',
    name: 'approving a version with blocking issues',
    run: async (world) => approve(world, await propose(world, sale(world), { blocking: true })),
  },
  {
    trigger: 'inv_approval_guard',
    code: 'withdrawn',
    name: 'approving a withdrawn proposal',
    run: async (world) => {
      const proposed = await propose(world, sale(world));
      await withdraw(world, proposed.proposalId);
      return approve(world, proposed);
    },
  },
  {
    trigger: 'inv_approval_guard',
    code: 'already_posted',
    name: 'approving after posting',
    run: async (world) => {
      const posted = await book(world, sale(world));
      return approve(world, posted, world.owner);
    },
  },
  {
    trigger: 'inv_proposal_version_guard',
    code: 'proposal_version',
    name: 'skipping a proposal version',
    run: async (world) => {
      const proposed = await propose(world, sale(world));
      return propose(world, sale(world), { proposalId: proposed.proposalId, version: 3 });
    },
  },
  {
    trigger: 'inv_proposal_version_guard',
    code: 'already_posted',
    name: 'revising a posted proposal',
    run: async (world) => {
      const posted = await book(world, sale(world));
      return propose(world, sale(world), { proposalId: posted.proposalId, version: 2 });
    },
  },
  {
    trigger: 'inv_proposal_version_guard',
    code: 'withdrawn',
    name: 'revising a withdrawn proposal',
    run: async (world) => {
      const proposed = await propose(world, sale(world));
      await withdraw(world, proposed.proposalId);
      return propose(world, sale(world), { proposalId: proposed.proposalId, version: 2 });
    },
  },
  {
    trigger: 'inv_proposal_subject',
    code: 'subject_taken',
    name: 'opening a second proposal for the same subject',
    run: async (world) =>
      world.db.write((tx) =>
        tx.insert(proposals).values(
          ['a', 'b'].map(() => ({
            id: randomUUID(),
            companyId: world.company,
            treatmentId: 'test.treatment',
            subjectKey: 'document:same',
            createdBy: world.owner,
          })),
        ),
      ),
  },
  {
    trigger: 'inv_withdrawal_guard',
    code: 'already_posted',
    name: 'withdrawing a posted proposal',
    run: async (world) => withdraw(world, (await book(world, sale(world))).proposalId),
  },
  {
    trigger: 'inv_policy_guard',
    code: 'approver',
    name: 'a viewer approving a posting policy',
    run: async (world) => policy(world, world.viewer),
  },
  {
    trigger: 'inv_action_decision_guard',
    code: 'stale_approval',
    name: 'deciding a different preview',
    run: async (world) => {
      const id = randomUUID();
      await world.db.write((tx) =>
        tx.insert(actionRequests).values({
          id,
          companyId: world.company,
          operation: 'periods.close',
          input: '{}',
          preview: '{}',
          previewHash: 'preview',
          createdBy: world.owner,
        }),
      );
      return world.db.write(async (tx) =>
        tx.insert(actionDecisions).values({
          companyId: world.company,
          requestId: id,
          decision: 'approve',
          previewHash: 'other',
          decidedBy: world.reviewer,
          decidedEpoch: await epoch(world, world.reviewer),
        }),
      );
    },
  },
  {
    trigger: 'inv_action_decision_guard',
    code: 'approver',
    name: 'a viewer deciding an action',
    run: async (world) => {
      const id = randomUUID();
      await world.db.write((tx) =>
        tx.insert(actionRequests).values({
          id,
          companyId: world.company,
          operation: 'periods.close',
          input: '{}',
          preview: '{}',
          previewHash: 'preview',
          createdBy: world.owner,
        }),
      );
      return world.db.write(async (tx) =>
        tx.insert(actionDecisions).values({
          companyId: world.company,
          requestId: id,
          decision: 'approve',
          previewHash: 'preview',
          decidedBy: world.viewer,
          decidedEpoch: await epoch(world, world.viewer),
        }),
      );
    },
  },
  {
    trigger: 'inv_action_execution_guard',
    code: 'not_approved',
    name: 'executing a rejected action',
    run: async (world) => {
      const id = randomUUID();
      await world.db.write(async (tx) => {
        await tx.insert(actionRequests).values({
          id,
          companyId: world.company,
          operation: 'periods.close',
          input: '{}',
          preview: '{}',
          previewHash: 'preview',
          createdBy: world.owner,
        });
        await tx.insert(actionDecisions).values({
          companyId: world.company,
          requestId: id,
          decision: 'reject',
          previewHash: 'preview',
          decidedBy: world.reviewer,
          decidedEpoch: await epoch(world, world.reviewer),
          reason: 'test',
        });
      });
      return world.db.write((tx) =>
        tx.insert(actionExecutions).values({
          companyId: world.company,
          requestId: id,
          result: '{}',
          executedBy: world.owner,
        }),
      );
    },
  },
  {
    trigger: 'inv_period_event_guard',
    code: 'period_sequence',
    name: 'reopening a month that was never closed',
    run: async (world) => periodEvent(world, '2026-03', 'reopen'),
  },
  {
    trigger: 'inv_period_event_guard',
    code: 'not_approved',
    name: 'closing without an approved review',
    run: async (world) => {
      const actionId = randomUUID();
      await world.db.write((tx) =>
        tx.insert(actionRequests).values({
          id: actionId,
          companyId: world.company,
          operation: 'periods.close',
          input: '{}',
          preview: '{}',
          previewHash: 'preview',
          createdBy: world.owner,
        }),
      );
      return periodEvent(world, '2026-03', 'close', { actionId });
    },
  },
  {
    trigger: 'inv_period_event_guard',
    code: 'period_order',
    name: 'closing April while March is open',
    run: async (world) => {
      await book(world, sale(world));
      return periodEvent(world, '2026-04');
    },
  },
  {
    trigger: 'inv_period_event_guard',
    code: 'period_watermark',
    name: 'closing with a wrong watermark',
    run: async (world) => periodEvent(world, '2026-03', 'close', { watermarkSeq: 7 }),
  },
  {
    trigger: 'inv_period_event_guard',
    code: 'period_chain',
    name: 'breaking the period hash chain',
    run: async (world) => {
      await periodEvent(world, '2026-01');
      return periodEvent(world, '2026-02', 'close', { prevHash: 'forged' });
    },
  },
  {
    trigger: 'inv_tax_period_event_guard',
    code: 'tax_period_sequence',
    name: 'unlocking a tax period that was never locked',
    run: async (world) =>
      world.db.write((tx) =>
        tx.insert(taxPeriodEvents).values({
          companyId: world.company,
          tax: 'VAT',
          period: '2026-03',
          seq: 1,
          kind: 'unlock',
          reference: 'test',
          createdBy: world.owner,
        }),
      ),
  },
  {
    trigger: 'inv_membership_update',
    code: 'membership_epoch',
    name: 'changing a role without a new epoch',
    run: async (world) =>
      world.db.write((tx) =>
        tx
          .update(memberships)
          .set({ role: 'owner' })
          .where(
            and(eq(memberships.companyId, world.company), eq(memberships.userId, world.viewer)),
          ),
      ),
  },
  {
    trigger: 'inv_membership_update',
    code: 'membership_epoch',
    name: 'reactivating a member without a new epoch',
    run: async (world) => {
      const member = and(
        eq(memberships.companyId, world.company),
        eq(memberships.userId, world.reviewer),
      );
      await world.db.write((tx) =>
        tx
          .update(memberships)
          .set({ active: false, epoch: sql`${memberships.epoch} + 1` })
          .where(member),
      );
      return world.db.write((tx) => tx.update(memberships).set({ active: true }).where(member));
    },
  },
  {
    trigger: 'inv_membership_update',
    code: 'immutable_record',
    name: 'moving a membership to another user',
    run: async (world) =>
      world.db.write((tx) =>
        tx
          .update(memberships)
          .set({ userId: world.owner })
          .where(
            and(eq(memberships.companyId, world.company), eq(memberships.userId, world.viewer)),
          ),
      ),
  },
  {
    trigger: 'inv_grant_insert',
    code: 'grant_epoch',
    name: 'issuing an agent grant for a stale membership',
    run: async (world) =>
      world.db.write((tx) =>
        tx.insert(agentGrants).values({
          id: randomUUID(),
          companyId: world.company,
          name: 'Agent',
          tokenHash: randomUUID(),
          scopes: ['ledger.propose'],
          membershipEpoch: 5,
          expiresAt: later,
          createdBy: world.reviewer,
        }),
      ),
  },
  {
    trigger: 'inv_grant_update',
    code: 'immutable_record',
    name: 'widening a grant after issue',
    run: async (world) => {
      const id = randomUUID();
      await world.db.write((tx) =>
        tx.insert(agentGrants).values({
          id,
          companyId: world.company,
          name: 'Agent',
          tokenHash: randomUUID(),
          scopes: ['ledger.propose'],
          membershipEpoch: 1,
          expiresAt: later,
          createdBy: world.reviewer,
        }),
      );
      return world.db.write((tx) =>
        tx
          .update(agentGrants)
          .set({ scopes: ['ledger.post'], revokedAt: Date.now() })
          .where(eq(agentGrants.id, id)),
      );
    },
  },
  {
    trigger: 'inv_invitation_update',
    code: 'immutable_record',
    name: 'retargeting an invitation',
    run: async (world) => {
      const id = randomUUID();
      await world.db.write((tx) =>
        tx.insert(invitations).values({
          id,
          companyId: world.company,
          email: 'a@example.test',
          role: 'viewer',
          tokenHash: randomUUID(),
          expiresAt: later,
          createdBy: world.owner,
        }),
      );
      return world.db.write((tx) =>
        tx
          .update(invitations)
          .set({ email: 'b@example.test', acceptedAt: Date.now() })
          .where(eq(invitations.id, id)),
      );
    },
  },
  {
    trigger: 'inv_account_update',
    code: 'immutable_record',
    name: 'renaming an account',
    run: async (world) =>
      world.db.write((tx) =>
        tx
          .update(ledgerAccounts)
          .set({ name: 'Altceva' })
          .where(and(eq(ledgerAccounts.companyId, world.company), eq(ledgerAccounts.code, '704'))),
      ),
  },
  {
    trigger: 'inv_account_update',
    code: 'account_in_use',
    name: 'closing an account before its last posting',
    run: async (world) => {
      await book(world, sale(world));
      return world.db.write((tx) =>
        tx
          .update(ledgerAccounts)
          .set({ validTo: '2026-02-28' })
          .where(and(eq(ledgerAccounts.companyId, world.company), eq(ledgerAccounts.code, '704'))),
      );
    },
  },
  {
    trigger: 'inv_fiscal_year_overlap',
    code: 'year_overlap',
    name: 'overlapping financial years',
    run: async (world) =>
      world.db.write((tx) =>
        tx.insert(fiscalYears).values({
          id: randomUUID(),
          companyId: world.company,
          kind: 'financial',
          label: 'x',
          from: '2026-06-01',
          to: '2027-05-31',
          createdBy: world.owner,
        }),
      ),
  },
  {
    trigger: 'inv_audit_chain',
    code: 'audit_chain',
    name: 'inserting an audit row out of sequence',
    run: async (world) =>
      world.db.write((tx) =>
        tx.insert(audit).values({
          companyId: world.company,
          seq: 2,
          actorId: world.owner,
          action: 'test',
          body: '{}',
          prevHash: '',
          hash: 'h',
        }),
      ),
  },
];

const worlds: World[] = [];
async function fresh() {
  const world = await createWorld();
  worlds.push(world);
  return world;
}
afterAll(async () => {
  await Promise.all(worlds.map((world) => world.close()));
});

describe('ledger writer', () => {
  test('posts approved effects and numbers them without gaps', async () => {
    const world = await fresh();
    const item = receivable(world);
    const first = await book(world, sale(world, item));
    const second = await book(world, receipt(world, item.ref, 121000n));
    expect([first.entry.number, second.entry.number]).toEqual([1, 2]);
    expect([first.entry.seq, second.entry.seq]).toEqual([1, 2]);
    const [balance] = await world.db.orm
      .select({ bani: sql<bigint>`sum(case side when 'D' then bani else -bani end)` })
      .from(lines)
      .where(and(eq(lines.companyId, world.company), eq(lines.openItemId, item.ref)));
    expect(balance?.bani).toBe(0n);
  });

  test('posts through an active policy', async () => {
    const world = await fresh();
    const proposed = await propose(world, sale(world));
    expect(await refusal(post(world, proposed, { policyId: await policy(world) }))).toBeUndefined();
  });

  test('foreign-currency items close exactly with the FX difference', async () => {
    const world = await fresh();
    const item = { ...receivable(world), currency: 'EUR' };
    await book(
      world,
      effect(
        [
          {
            account: '4111',
            side: 'D',
            bani: 49765n,
            openItem: item.ref,
            currency: { ...eur, minor: 10000n },
          },
          { account: '704', side: 'C', bani: 49765n },
        ],
        { openItems: [item] },
      ),
    );
    const settled = effect([
      { account: '5124', side: 'D', bani: 50000n, currency: { ...eur, minor: 10000n } },
      {
        account: '4111',
        side: 'C',
        bani: 49765n,
        openItem: item.ref,
        currency: { ...eur, minor: 10000n },
      },
      { account: '765', side: 'C', bani: 235n },
    ]);
    expect(await refusal(book(world, settled))).toBeUndefined();
  });

  test('VAT settlement lines need no tax entries', async () => {
    const world = await fresh();
    await book(world, sale(world));
    const settlement = effect(
      [
        {
          account: '4427',
          side: 'D',
          bani: 21000n,
          taxSettlement: { tax: 'VAT', period: '2026-03' },
        },
        {
          account: '4423',
          side: 'C',
          bani: 21000n,
          taxSettlement: { tax: 'VAT', period: '2026-03' },
        },
      ],
      { journalCode: 'DIVERSE', description: 'Decont TVA' },
    );
    expect(await refusal(book(world, settlement))).toBeUndefined();
  });

  test('writes a 5,000-line effect within the performance budget', async () => {
    const world = await fresh();
    const many = effect([
      ...Array.from({ length: 4999 }, (_, index) => ({
        account: '628',
        side: 'D' as const,
        bani: BigInt(index + 1),
      })),
      { account: '5121', side: 'C', bani: (4999n * 5000n) / 2n },
    ]);
    const { proposed, approvalId } = await approved(world, many);
    const started = performance.now();
    await post(world, proposed, { approvalId });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('database invariants', () => {
  for (const attack of attacks)
    test(`refuses ${attack.name} (${attack.code})`, async () => {
      expect(await refusal(attack.run(await fresh()))).toBe(attack.code);
    });

  test('every rule the database enforces has an attack', () => {
    const covered = new Set(attacks.map((attack) => `${attack.trigger}/${attack.code}`));
    const generic = /^inv_acc_.*_no_(update|delete)$|^inv_ref_.*_no_(update|delete)$/;
    const missing = invariantRules()
      .filter((rule) => !generic.test(rule.trigger))
      .map((rule) => `${rule.trigger}/${rule.code}`)
      .filter((rule) => !covered.has(rule));
    expect(missing).toEqual([]);
  });

  test('every table is either guarded or explicitly mutable', async () => {
    const world = await fresh();
    const tables = (
      await world.db.client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
    ).rows.map((row) => String(row.name));
    expect(tables.filter((table) => ![...guardedTables, ...mutableTables].includes(table))).toEqual(
      [],
    );
    const triggers = new Set(
      (
        await world.db.client.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      ).rows.map((row) => String(row.name)),
    );
    expect(guardedTables.filter((table) => !triggers.has(`inv_${table}_no_delete`))).toEqual([]);
  });

  test('installation is idempotent and restores a dropped invariant', async () => {
    const world = await fresh();
    await world.db.client.execute('DROP TRIGGER inv_entry_guard');
    await world.db.migrate();
    const { proposed } = await approved(world, sale(world));
    expect(await refusal(post(world, proposed, { approvalId: randomUUID() }))).toBe('binding');
  });

  test('each guard is what refuses its attacks', async () => {
    const byTrigger = Map.groupBy(attacks, (attack) => attack.trigger);
    const survived: string[] = [];
    for (const [trigger, targeted] of byTrigger)
      for (const attack of targeted) {
        const world = await fresh();
        await world.db.client.execute(`DROP TRIGGER ${trigger}`);
        if ((await refusal(attack.run(world))) === attack.code)
          survived.push(`${trigger}: ${attack.name}`);
      }
    expect(survived).toEqual([]);
  }, 120_000);
});

describe('append-only records', () => {
  test('every append-only table refuses updates and deletes', async () => {
    const world = await fresh();
    const item = receivable(world);
    await book(world, sale(world, item));
    await book(world, prepaid(world));
    await periodEvent(world, '2026-03');
    await (await issuing(world)).issue(1, { date: '2026-04-02' });
    const evidenceId = randomUUID();
    const documentIds = [randomUUID(), randomUUID()];
    await world.db.write(async (tx) => {
      await tx.insert(evidence).values({
        id: evidenceId,
        companyId: world.company,
        hash: 'a'.repeat(64),
        filename: 'f.xml',
        mediaType: 'application/xml',
        size: 1,
        createdBy: world.owner,
      });
      await tx.insert(profileFacts).values({
        id: randomUUID(),
        companyId: world.company,
        axis: 'vat.status',
        value: 'normal_vat',
        effectiveFrom: '2026-01-01',
        evidenceId,
        createdBy: world.owner,
      });
      await tx.insert(documents).values(
        documentIds.map((id) => ({
          id,
          companyId: world.company,
          kind: 'invoice.issued',
          schema: 'invoice@1',
          body: '{}',
          bodyHash: id,
          sourceKey: id,
          origin: 'test',
          docDate: '2026-03-10',
          createdBy: world.owner,
        })),
      );
      await tx.insert(documentLinks).values({
        companyId: world.company,
        fromId: documentIds[0]!,
        toId: documentIds[1]!,
        kind: 'credits',
        createdBy: world.owner,
      });
      await tx.insert(commands).values({
        companyId: world.company,
        actorId: world.owner,
        key: 'k',
        operation: 'test',
        hash: 'h',
        result: {},
      });
      await tx.insert(audit).values({
        companyId: world.company,
        seq: 1,
        actorId: world.owner,
        action: 'test',
        body: '{}',
        prevHash: '',
        hash: 'h',
      });
      await tx.insert(taxPeriodEvents).values({
        companyId: world.company,
        tax: 'VAT',
        period: '2026-03',
        seq: 1,
        kind: 'lock',
        reference: 'D300',
        createdBy: world.owner,
      });
      await tx.insert(periodBalances).values({
        companyId: world.company,
        month: '2026-03',
        closeSeq: 1,
        account: '704',
        currency: 'RON',
        debitTurnover: 0n,
        creditTurnover: 100000n,
        closingBani: -100000n,
        closingMinor: -100000n,
      });
      const treasuryId = randomUUID();
      const statementId = randomUUID();
      await tx.insert(treasuryAccounts).values({
        id: treasuryId,
        companyId: world.company,
        kind: 'bank',
        name: 'Cont curent',
        iban: 'RO49AAAA1B31007593840000',
        currency: 'RON',
        ledgerAccount: '5121',
        openedOn: '2026-01-01',
        createdBy: world.owner,
      });
      await tx.insert(bankStatements).values({
        id: statementId,
        companyId: world.company,
        treasuryAccountId: treasuryId,
        evidenceId,
        format: 'mt940',
        sourceId: 'S1',
        from: '2026-03-01',
        to: '2026-03-31',
        openingMinor: 0n,
        closingMinor: 100n,
        financialHash: 'c'.repeat(64),
        createdBy: world.owner,
      });
      await tx.insert(bankMovements).values({
        id: randomUUID(),
        companyId: world.company,
        treasuryAccountId: treasuryId,
        statementId,
        sourceId: 'bank:1',
        bookingDate: '2026-03-05',
        amountMinor: 100n,
        currency: 'RON',
        reference: 'Încasare',
        details: '{}',
      });
      await tx.insert(fxRates).values({
        source: 'BNR',
        currency: 'EUR',
        rateDate: '2026-03-10',
        revision: 1,
        rate: '4.9765',
        multiplier: 1,
        publishedAt: '2026-03-10T13:00:00Z',
        evidenceHash: 'b'.repeat(64),
      });
    });
    await world.db.write(async (tx) => {
      await tx.insert(agentGrants).values({
        id: randomUUID(),
        companyId: world.company,
        name: 'Agent',
        tokenHash: randomUUID(),
        scopes: ['ledger.propose'],
        membershipEpoch: 1,
        expiresAt: later,
        createdBy: world.reviewer,
      });
      await tx.insert(invitations).values({
        id: randomUUID(),
        companyId: world.company,
        email: 'a@example.test',
        role: 'viewer',
        tokenHash: randomUUID(),
        expiresAt: later,
        createdBy: world.owner,
      });
    });
    const proposed = await propose(world, sale(world));
    await withdraw(world, proposed.proposalId);
    const policyId = await policy(world);
    await world.db.write((tx) =>
      tx
        .insert(policyRevocations)
        .values({ companyId: world.company, policyId, reason: 'x', createdBy: world.owner }),
    );
    const actionId = await approvedAction(world);
    await world.db.write((tx) =>
      tx.insert(actionExecutions).values({
        companyId: world.company,
        requestId: actionId,
        result: '{}',
        executedBy: world.owner,
      }),
    );
    const refused: Record<string, [string | undefined, string | undefined]> = {};
    for (const table of guardedTables) {
      const count = await world.db.client.execute(`SELECT count(*) AS n FROM ${table}`);
      expect(`${table}: ${Number(count.rows[0]!.n) > 0}`).toBe(`${table}: true`);
      const update = mutableUpdate(table);
      refused[table] = [
        update ? await refusal(world.db.client.execute(update)) : 'immutable_record',
        await refusal(world.db.client.execute(`DELETE FROM ${table}`)),
      ];
    }
    expect(
      Object.entries(refused).filter(([, codes]) =>
        codes.some((code) => code !== 'immutable_record'),
      ),
    ).toEqual([]);
  });
});

// A harmless-looking update for each table: guarded-update tables refuse it as an immutable change.
function mutableUpdate(table: string) {
  const column: Record<string, string> = {
    acc_memberships: "user_id = user_id || 'x'",
    acc_agent_grants: "name = name || 'x'",
    acc_invitations: "email = email || 'x'",
    acc_accounts: "name = name || 'x'",
  };
  return `UPDATE ${table} SET ${column[table] ?? 'rowid = rowid'}`;
}
