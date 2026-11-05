import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { canonical, derivedId } from 'xfactura-core/hash';
import type { Effect } from 'xfactura-core/kernel';
import {
  answerMediaType,
  guardedTables,
  invariantRules,
  mutableTables,
} from '../../source/engine/db/invariants';
import {
  actionDecisions,
  actionExecutions,
  actionRequests,
  agentGrants,
  anafConnections,
  approvals,
  automationCriteria,
  automationEvents,
  artifactEvents,
  assetEvents,
  assetFiscal,
  assets,
  audit,
  bankMappings,
  bankMovements,
  bankStatements,
  commands,
  dispositions,
  documentLinks,
  documents,
  employees,
  enterpriseMembers,
  employmentTerms,
  entries,
  evidence,
  fiscalYears,
  fxRates,
  incomeSources,
  invitations,
  issuedNumbers,
  ledgerAccounts,
  lines,
  memberships,
  parties,
  partyCnps,
  partyStatuses,
  partyVersions,
  payrollLines,
  payrollRunEvents,
  payrollRuns,
  periodBalances,
  policyRevocations,
  postingPolicies,
  profileFacts,
  proposals,
  questionAnswers,
  questions,
  questionWithdrawals,
  series,
  spvMessages,
  spvSyncWindows,
  submissionEvents,
  submissions,
  taxPeriodEvents,
  templatePredictions,
  templateRevocations,
  templates,
  treasuryAccounts,
  withdrawals,
} from '../../source/engine/db/schema';
import { authorizedDeclaration, lockTaxPeriod } from './fixtures/locks';
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
  type Proposed,
  type World,
} from './world';

type Attack = {
  trigger: string;
  code: string;
  name: string;
  run: (world: World) => Promise<unknown>;
};

const later = Date.now() + 86_400_000;
async function policy(world: World, approver = world.reviewer, preconditions: unknown[] = []) {
  const id = randomUUID();
  await world.db.write(async (tx) =>
    tx.insert(postingPolicies).values({
      id,
      companyId: world.company,
      name: 'Facturi emise',
      treatments: canonical(['test.treatment']),
      rulesHashes: canonical(['rules-1']),
      preconditions: canonical(preconditions),
      approvedBy: approver,
      approverEpoch: await epoch(world, approver),
      validFrom: '2026-01-01',
      expiresAt: later,
    }),
  );
  return id;
}
/** Records the company's segregation of duties from 2026-01-01; returns the fact's id. */
async function segregate(world: World, value: 'off' | 'on' | 'strict', supersedesId?: string) {
  const evidenceId = randomUUID();
  const id = randomUUID();
  await world.db.write(async (tx) => {
    await tx.insert(evidence).values({
      id: evidenceId,
      companyId: world.company,
      hash: evidenceId.replaceAll('-', '').padEnd(64, '0'),
      filename: 'decizie-administrator.pdf',
      mediaType: 'application/pdf',
      size: 1,
      createdBy: world.owner,
    });
    await tx.insert(profileFacts).values({
      id,
      companyId: world.company,
      axis: 'controls.segregation',
      value,
      effectiveFrom: '2026-01-01',
      evidenceId,
      supersedesId: supersedesId ?? null,
      createdBy: world.owner,
    });
  });
  return id;
}
/** An action requested in the owner's name (through `agentId`, if given); returns its id. */
async function actionRequest(world: World, agentId?: string) {
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
      agentId: agentId ?? null,
    }),
  );
  return id;
}
const decide = async (
  world: World,
  requestId: string,
  decidedBy: string,
  decision: 'approve' | 'reject' = 'approve',
) =>
  world.db.write(async (tx) =>
    tx.insert(actionDecisions).values({
      companyId: world.company,
      requestId,
      decision,
      previewHash: 'preview',
      decidedBy,
      decidedEpoch: await epoch(world, decidedBy),
      ...(decision === 'reject' ? { reason: 'Nu este cazul' } : {}),
    }),
  );
const demote = (world: World, userId: string) =>
  world.db.write((tx) =>
    tx
      .update(memberships)
      .set({ role: 'viewer', epoch: sql`${memberships.epoch} + 1` })
      .where(and(eq(memberships.companyId, world.company), eq(memberships.userId, userId))),
  );
const warning = { code: 'VAT_FX', severity: 'ack' as const, message: 'TVA diferă de curs.' };
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
        authority: 'issued',
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

/** An issued invoice with its kept XML, and ways to submit it and record steps. */
async function submittable(world: World) {
  const evidenceId = randomUUID();
  const documentId = randomUUID();
  const hash = 'b'.repeat(64);
  await world.db.write(async (tx) => {
    await tx.insert(evidence).values({
      id: evidenceId,
      companyId: world.company,
      hash,
      filename: 'XF0001.xml',
      mediaType: 'application/xml',
      size: 1,
      createdBy: world.owner,
    });
    await tx.insert(documents).values({
      id: documentId,
      companyId: world.company,
      kind: 'invoice.issued',
      schema: 'test',
      body: '{}',
      bodyHash: documentId,
      sourceKey: documentId,
      evidenceId,
      origin: 'issued',
      authority: 'issued',
      docDate: '2026-03-10',
      number: 'XF0001',
      createdBy: world.owner,
    });
  });
  const submit = async (xmlHash = hash) => {
    const id = randomUUID();
    await world.db.write((tx) =>
      tx.insert(submissions).values({
        id,
        companyId: world.company,
        documentId,
        evidenceId,
        xmlHash,
        createdBy: world.owner,
      }),
    );
    return id;
  };
  const step = (
    submissionId: string,
    seq: number,
    state: (typeof submissionEvents.$inferInsert)['state'],
    extra: { uploadId?: string; downloadId?: string } = {},
  ) =>
    world.db.write((tx) =>
      tx.insert(submissionEvents).values({
        companyId: world.company,
        submissionId,
        seq,
        state,
        createdBy: world.owner,
        ...extra,
      }),
    );
  return { submit, step };
}

/** A fixed asset in the register, written directly; `extra` overrides its card. */
async function assetRecord(world: World, extra: Partial<typeof assets.$inferInsert> = {}) {
  const id = randomUUID();
  const evidenceId = randomUUID();
  await world.db.write(async (tx) => {
    await tx.insert(evidence).values({
      id: evidenceId,
      companyId: world.company,
      hash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      filename: 'pv.pdf',
      mediaType: 'application/pdf',
      size: 1,
      createdBy: world.owner,
    });
    await tx.insert(assets).values({
      id,
      companyId: world.company,
      number: `MF-${id.slice(0, 6)}`,
      name: 'Laptop',
      catalogCode: '2.2.9',
      account: '214',
      depreciationAccount: '2814',
      expenseAccount: '6811',
      valueBani: 600000n,
      lifeMonths: 36,
      fiscalLifeMonths: 36,
      commissionedOn: '2026-03-15',
      evidenceId,
      createdBy: world.owner,
      ...extra,
    });
  });
  const dispose = (seq: number, date: string) =>
    world.db.write((tx) =>
      tx.insert(assetEvents).values({
        companyId: world.company,
        assetId: id,
        seq,
        kind: 'disposed',
        date,
        evidenceId,
        createdBy: world.owner,
      }),
    );
  // A fiscal basis (Codul fiscal art. 28), numbered per asset.
  const fiscal = (version: number) =>
    world.db.write((tx) =>
      tx.insert(assetFiscal).values({
        companyId: world.company,
        assetId: id,
        version,
        method: 'linear',
        valueBani: 600000n,
        lifeMonths: 36,
        m1: false,
        newAsset: false,
        evidenceId,
        createdBy: world.owner,
      }),
    );
  return { id, dispose, fiscal };
}

/** A PFA's income source (its form recorded unless `form` is false), with a way to add versions. */
async function sourceRecord(world: World, { form = true } = {}) {
  const evidenceId = randomUUID();
  const sourceId = randomUUID();
  await world.db.write(async (tx) => {
    await tx.insert(evidence).values({
      id: evidenceId,
      companyId: world.company,
      hash: 'e'.repeat(64),
      filename: 'certificat.pdf',
      mediaType: 'application/pdf',
      size: 1,
      createdBy: world.owner,
    });
    if (form)
      await tx.insert(profileFacts).values({
        id: randomUUID(),
        companyId: world.company,
        axis: 'entity.form',
        value: 'pfa',
        effectiveFrom: '2026-01-01',
        evidenceId,
        createdBy: world.owner,
      });
  });
  const version = (seq: number, extra: Partial<typeof incomeSources.$inferInsert> = {}) =>
    world.db.write((tx) =>
      tx.insert(incomeSources).values({
        companyId: world.company,
        sourceId,
        seq,
        effectiveFrom: '2026-01-01',
        name: 'Servicii de programare',
        caen: '6210',
        place: 'Str. Exemplu 1, Cluj-Napoca',
        county: 'CJ',
        startedOn: '2026-01-01',
        liberal: false,
        method: 'sistem_real',
        realBasis: 'required',
        evidenceId,
        createdBy: world.owner,
        ...extra,
      }),
    );
  return { version };
}

/** A family enterprise with two individual members whose CNPs are sealed (and a third person
 * without one), and a way to record its agreements' rows. */
async function memberRecord(world: World, { form = true } = {}) {
  const evidenceId = randomUUID();
  const [first, second, unsealed] = [randomUUID(), randomUUID(), randomUUID()];
  await world.db.write(async (tx) => {
    await tx.insert(evidence).values({
      id: evidenceId,
      companyId: world.company,
      hash: '7'.repeat(64),
      filename: 'acord-constituire.pdf',
      mediaType: 'application/pdf',
      size: 1,
      createdBy: world.owner,
    });
    if (form)
      await tx.insert(profileFacts).values({
        id: randomUUID(),
        companyId: world.company,
        axis: 'entity.form',
        value: 'if',
        effectiveFrom: '2026-02-01',
        evidenceId,
        createdBy: world.owner,
      });
    for (const [id, name] of [
      [first, 'Popescu Ion'],
      [second, 'Popescu Maria'],
      [unsealed, 'Popescu Ana'],
    ] as const)
      await tx.insert(parties).values({
        id,
        companyId: world.company,
        kind: 'ro_individual',
        country: 'RO',
        name,
        createdBy: world.owner,
      });
    for (const partyId of [first, second])
      await tx.insert(partyCnps).values({
        companyId: world.company,
        partyId,
        cnpSealed: 'v1.a.b.c',
        createdBy: world.owner,
      });
  });
  const positions = new Map<number, number>();
  const member = (
    version: number,
    partyId: string,
    quotaBp: number,
    extra: Partial<typeof enterpriseMembers.$inferInsert> = {},
  ) => {
    const position = (positions.get(version) ?? 0) + 1;
    positions.set(version, position);
    return world.db.write((tx) =>
      tx.insert(enterpriseMembers).values({
        companyId: world.company,
        version,
        position,
        partyId,
        quotaBp,
        representative: false,
        effectiveFrom: '2026-02-01',
        evidenceId,
        createdBy: world.owner,
        ...extra,
      }),
    );
  };
  /** A complete first agreement: 60% to the representative, 40% to the other member. */
  const agreement = async () => {
    await member(1, first, 6000, { representative: true });
    await member(1, second, 4000);
  };
  return { member, agreement, first, second, unsealed };
}

/** A Romanian supplier with ANAF's answer kept, and a way to record its status snapshots. */
async function statusRecord(world: World) {
  const partyId = randomUUID();
  const evidenceId = randomUUID();
  await world.db.write(async (tx) => {
    await tx.insert(parties).values({
      id: partyId,
      companyId: world.company,
      kind: 'ro_legal_entity',
      country: 'RO',
      taxId: '18547290',
      name: 'Furnizor SRL',
      createdBy: world.owner,
    });
    await tx.insert(evidence).values({
      id: evidenceId,
      companyId: world.company,
      hash: 'd'.repeat(64),
      filename: 'anaf-registre.json',
      mediaType: 'application/json',
      size: 1,
      createdBy: world.owner,
    });
  });
  const snapshot = (seq: number, extra: Partial<typeof partyStatuses.$inferInsert> = {}) =>
    world.db.write((tx) =>
      tx.insert(partyStatuses).values({
        companyId: world.company,
        partyId,
        seq,
        cui: '18547290',
        asOf: '2026-03-10',
        name: 'FURNIZOR SRL',
        vatPayer: true,
        cashVat: false,
        inactive: false,
        splitVat: false,
        eInvoice: true,
        evidenceId,
        createdBy: world.owner,
        ...extra,
      }),
    );
  return { partyId, snapshot };
}

/** An employee with one contract and a prepared payroll run, written directly. */
async function payrollRecords(world: World) {
  const partyId = randomUUID();
  const employeeId = randomUUID();
  const contractId = randomUUID();
  const runId = randomUUID();
  const terms = (seq: number, extra: Partial<typeof employmentTerms.$inferInsert> = {}) =>
    world.db.write((tx) =>
      tx.insert(employmentTerms).values({
        companyId: world.company,
        contractId,
        seq,
        employeeId,
        number: 'CIM-1',
        startDate: '2026-01-05',
        effectiveFrom: '2026-01-05',
        baseSalaryBani: 500000n,
        dailyHours: 8,
        mainJob: true,
        occupation: '251201',
        dependents: 0,
        childrenInSchool: 0,
        unionDuesBani: 0n,
        createdBy: world.owner,
        ...extra,
      }),
    );
  await world.db.write(async (tx) => {
    await tx.insert(parties).values({
      id: partyId,
      companyId: world.company,
      kind: 'ro_individual',
      country: 'RO',
      taxId: `cnp:${'0'.repeat(64)}`,
      name: 'Salariat',
      createdBy: world.owner,
    });
    await tx.insert(employees).values({
      id: employeeId,
      companyId: world.company,
      partyId,
      cnpSealed: 'v1.a.b.c',
      birthDate: '1990-01-01',
      createdBy: world.owner,
    });
  });
  await terms(1);
  await world.db.write(async (tx) => {
    await tx.insert(payrollRuns).values({
      id: runId,
      companyId: world.company,
      month: '2026-03',
      round: 1,
      workingDays: 22,
      resultHash: 'h',
      issues: 0,
      createdBy: world.owner,
    });
    await tx.insert(payrollRunEvents).values({
      companyId: world.company,
      runId,
      seq: 1,
      state: 'prepared',
      createdBy: world.owner,
    });
  });
  const line = (extra: Partial<typeof payrollLines.$inferInsert> = {}) =>
    world.db.write((tx) =>
      tx.insert(payrollLines).values({
        companyId: world.company,
        runId,
        contractId,
        termsSeq: 1,
        employeeId,
        partyId,
        input: '{}',
        result: '{}',
        cash: 500000n,
        vouchers: 0n,
        cas: 125000n,
        cass: 50000n,
        casEmployer: 0n,
        cassEmployer: 0n,
        tax: 26900n,
        unionDues: 0n,
        net: 298100n,
        cam: 11300n,
        issues: 0,
        ...extra,
      }),
    );
  return { runId, terms, line };
}

/** A bank account in lei, with ways to record its statements and movements directly. */
async function bankRecords(world: World) {
  const accountId = randomUUID();
  const evidenceId = randomUUID();
  await world.db.write(async (tx) => {
    await tx.insert(evidence).values({
      id: evidenceId,
      companyId: world.company,
      hash: 'e'.repeat(64),
      filename: 'extras.xml',
      mediaType: 'application/xml',
      size: 1,
      createdBy: world.owner,
    });
    await tx.insert(treasuryAccounts).values({
      id: accountId,
      companyId: world.company,
      kind: 'bank',
      name: 'Cont curent',
      iban: 'RO49AAAA1B31007593840000',
      currency: 'RON',
      ledgerAccount: '5121',
      openedOn: '2026-01-01',
      createdBy: world.owner,
    });
  });
  const statement = async (from: string, to: string, opening: bigint, closing: bigint) => {
    const id = randomUUID();
    await world.db.write((tx) =>
      tx.insert(bankStatements).values({
        id,
        companyId: world.company,
        treasuryAccountId: accountId,
        evidenceId,
        format: 'camt.053',
        sourceId: `EXTRAS-${from}`,
        from,
        to,
        openingMinor: opening,
        closingMinor: closing,
        financialHash: id.replace(/-/g, '').padEnd(64, '0'),
        createdBy: world.owner,
      }),
    );
    return id;
  };
  const movement = (statementId: string, bookingDate: string) =>
    world.db.write((tx) =>
      tx.insert(bankMovements).values({
        id: randomUUID(),
        companyId: world.company,
        treasuryAccountId: accountId,
        statementId,
        sourceId: `entry:${randomUUID()}`,
        bookingDate,
        amountMinor: 100n,
        currency: 'RON',
        reference: 'Plată',
        details: '{}',
      }),
    );
  return { statement, movement };
}

/** A question asked in the owner's name about a vehicle: `answer` and `withdraw` it, `ask`
 * another about the same vehicle, `dispose` of a subject. */
async function questionRecords(world: World, vehicle = 'B123ABC') {
  const id = randomUUID();
  const ask = (questionId = randomUUID()) =>
    world.db.write((tx) =>
      tx.insert(questions).values({
        id: questionId,
        companyId: world.company,
        kind: 'vehicle.use',
        subjectKind: 'vehicle',
        subjectId: vehicle,
        params: '{}',
        askedBy: world.owner,
      }),
    );
  await ask(id);
  const kept = async (mediaType = answerMediaType) => {
    const evidenceId = randomUUID();
    await world.db.write((tx) =>
      tx.insert(evidence).values({
        id: evidenceId,
        companyId: world.company,
        hash: evidenceId.replaceAll('-', '').padEnd(64, 'e'),
        filename: 'raspuns.json',
        mediaType,
        size: 1,
        createdBy: world.owner,
      }),
    );
    return evidenceId;
  };
  const answer = async (
    seq: number,
    overrides: Partial<typeof questionAnswers.$inferInsert> = {},
    mediaType?: string,
  ) => {
    const answerId = randomUUID();
    const evidenceId = await kept(mediaType);
    const answerEpoch = await epoch(world, overrides.answeredBy ?? world.reviewer);
    await world.db.write((tx) =>
      tx.insert(questionAnswers).values({
        id: answerId,
        companyId: world.company,
        questionId: id,
        seq,
        value: '{"use":"mixed"}',
        evidenceId,
        answeredBy: world.reviewer,
        epoch: answerEpoch,
        ...overrides,
      }),
    );
    return answerId;
  };
  const withdraw = () =>
    world.db.write((tx) =>
      tx.insert(questionWithdrawals).values({
        companyId: world.company,
        questionId: id,
        reason: 'Nu mai este necesară',
        createdBy: world.owner,
      }),
    );
  const dispose = (subjectKind: string, agentId?: string) =>
    world.db.write((tx) =>
      tx.insert(dispositions).values({
        id: randomUUID(),
        companyId: world.company,
        subjectKind,
        subjectId: randomUUID(),
        disposition: 'no_booking',
        reason: 'Nu se înregistrează',
        fingerprint: 'f'.repeat(64),
        createdBy: world.owner,
        agentId: agentId ?? null,
      }),
    );
  return { id, ask, answer, withdraw, dispose };
}

const entry = 'inv_entry_guard';
const numbering = 'inv_issued_number_guard';
const submission = 'inv_submission_event_guard';
/** Documents written directly: `add` records one (an extracted one cites its evidence), `link`
 * joins two, `proposal` opens a proposal recognizing one. */
async function documentRecords(world: World) {
  const evidenceId = randomUUID();
  const hash = 'f'.repeat(64);
  await world.db.write((tx) =>
    tx.insert(evidence).values({
      id: evidenceId,
      companyId: world.company,
      hash,
      filename: 'factura.pdf',
      mediaType: 'application/pdf',
      size: 1,
      createdBy: world.owner,
    }),
  );
  let parts = 0;
  const add = async (
    options: {
      authority?: (typeof documents.$inferInsert)['authority'] | null;
      identityKey?: string | null;
      sourceKey?: string;
    } = {},
  ) => {
    const id = randomUUID();
    const authority = options.authority === undefined ? 'extracted' : options.authority;
    await world.db.write((tx) =>
      tx.insert(documents).values({
        id,
        companyId: world.company,
        kind: 'invoice.received',
        schema: 'test',
        body: '{}',
        bodyHash: id,
        sourceKey:
          options.sourceKey ?? (authority === 'extracted' ? `extract:${hash}:${++parts}` : id),
        evidenceId,
        origin: 'test',
        docDate: '2026-03-10',
        partyId: world.supplier,
        number: 'F-1',
        identityKey: options.identityKey === undefined ? 'identity-1' : options.identityKey,
        authority,
        createdBy: world.owner,
      }),
    );
    return id;
  };
  const link = (fromId: string, toId: string, kind: string) =>
    world.db.write((tx) =>
      tx
        .insert(documentLinks)
        .values({ companyId: world.company, fromId, toId, kind, createdBy: world.owner }),
    );
  const proposal = (documentId: string) =>
    propose(world, sale(world), { subjectKey: `document:${documentId}` });
  return { add, link, proposal };
}

/**
 * Earned autonomy's records written directly: reviewed requests approved by a decider, a
 * batch's approvals, a template version written by its request, its revocation and predictions,
 * pauses and resumes, and graduation criteria.
 */
async function autonomyRecords(world: World) {
  const reviewed = async (
    operation: string,
    preview: unknown,
    decider: string | null = world.reviewer,
  ) => {
    const id = randomUUID();
    await world.db.write(async (tx) => {
      await tx.insert(actionRequests).values({
        id,
        companyId: world.company,
        operation,
        input: '{}',
        preview: canonical(preview),
        previewHash: 'preview',
        createdBy: world.owner,
      });
      if (decider)
        await tx.insert(actionDecisions).values({
          companyId: world.company,
          requestId: id,
          decision: 'approve',
          previewHash: 'preview',
          decidedBy: decider,
          decidedEpoch: await epoch(world, decider),
        });
    });
    return id;
  };
  /** A batch whose approved preview lists these versions as ready. */
  const batch = (listed: Proposed[]) =>
    reviewed('proposals.batch', {
      members: listed.map((item) => ({
        proposalId: item.proposalId,
        version: item.version,
        effectHash: item.effectHash,
        state: 'ready',
      })),
    });
  const batchApproval = async (
    proposed: Proposed,
    requestId: string,
    approver = world.reviewer,
  ) => {
    const id = randomUUID();
    const approverEpoch = await epoch(world, approver);
    await world.db.write((tx) =>
      tx.insert(approvals).values({
        id,
        companyId: world.company,
        proposalId: proposed.proposalId,
        version: proposed.version,
        effectHash: proposed.effectHash,
        approverId: approver,
        approverEpoch,
        acknowledgements: '[]',
        batchRequestId: requestId,
      }),
    );
    return id;
  };
  const templateId = randomUUID();
  const template = async (
    version = 1,
    options: { requestId?: string; approvedBy?: string } = {},
  ) => {
    const requestId = options.requestId ?? (await reviewed('templates.request', {}));
    const approvedBy = options.approvedBy ?? world.reviewer;
    const approverEpoch = await epoch(world, approvedBy);
    await world.db.write((tx) =>
      tx.insert(templates).values({
        id: templateId,
        companyId: world.company,
        version,
        name: 'Abonament',
        treatmentId: 'test.treatment',
        documentKind: 'invoice.received',
        scope: '{}',
        mapping: '{}',
        requestId,
        approvedBy,
        approverEpoch,
        createdBy: world.owner,
      }),
    );
    return templateId;
  };
  const revoke = (id = templateId) =>
    world.db.write((tx) =>
      tx.insert(templateRevocations).values({
        companyId: world.company,
        templateId: id,
        reason: 'Nu mai este folosit',
        createdBy: world.owner,
      }),
    );
  const predict = (subjectKey: string) =>
    world.db.write((tx) =>
      tx.insert(templatePredictions).values({
        companyId: world.company,
        templateId,
        templateVersion: 1,
        sourceKey: subjectKey,
        status: 'predicted',
        subjectKey,
        input: '{}',
        fingerprint: 'f'.repeat(64),
        asOfSeq: 0,
      }),
    );
  const automation = async (
    seq: number,
    overrides: Partial<typeof automationEvents.$inferInsert> = {},
  ) => {
    const by = overrides.createdBy ?? world.owner;
    const memberEpoch = by === 'system' ? null : await epoch(world, by);
    await world.db.write((tx) =>
      tx.insert(automationEvents).values({
        companyId: world.company,
        seq,
        scope: 'company',
        scopeId: null,
        kind: 'pause',
        reason: 'Oprim contabilizarea automată',
        createdBy: by,
        epoch: memberEpoch,
        ...overrides,
      }),
    );
  };
  const criteria = async (seq: number, createdBy = world.owner) => {
    const memberEpoch = await epoch(world, createdBy);
    await world.db.write((tx) =>
      tx.insert(automationCriteria).values({
        companyId: world.company,
        seq,
        minCorrect: 8,
        minMonths: 4,
        policyDays: 60,
        reason: 'Criterii mai stricte',
        createdBy,
        epoch: memberEpoch,
      }),
    );
  };
  return { reviewed, batch, batchApproval, template, revoke, predict, automation, criteria };
}

const attacks: Attack[] = [
  {
    trigger: 'inv_question_guard',
    code: 'question_open',
    name: 'asking about a vehicle while the same question about it awaits an answer',
    run: async (world) => (await questionRecords(world)).ask(),
  },
  {
    trigger: 'inv_question_answer_guard',
    code: 'answer_sequence',
    name: "an answer numbered past the question's answers",
    run: async (world) => (await questionRecords(world)).answer(2),
  },
  {
    trigger: 'inv_question_answer_guard',
    code: 'answer_person',
    name: 'an answer given through an agent grant',
    run: async (world) => (await questionRecords(world)).answer(1, { agentId: randomUUID() }),
  },
  {
    trigger: 'inv_question_answer_guard',
    code: 'answerer',
    name: 'an answer by a viewer',
    run: async (world) => (await questionRecords(world)).answer(1, { answeredBy: world.viewer }),
  },
  {
    trigger: 'inv_question_answer_guard',
    code: 'question_withdrawn',
    name: 'answering a withdrawn question',
    run: async (world) => {
      const records = await questionRecords(world);
      await records.withdraw();
      return records.answer(1);
    },
  },
  {
    trigger: 'inv_question_answer_guard',
    code: 'answer_evidence',
    name: 'an answer citing a file that is not an answer kept as evidence',
    run: async (world) => (await questionRecords(world)).answer(1, {}, 'application/pdf'),
  },
  {
    trigger: 'inv_question_withdrawal_guard',
    code: 'question_answered',
    name: 'withdrawing a question already answered',
    run: async (world) => {
      const records = await questionRecords(world);
      await records.answer(1);
      return records.withdraw();
    },
  },
  {
    trigger: 'inv_disposition_guard',
    code: 'disposition_subject',
    name: 'disposing of a proposal instead of withdrawing it',
    run: async (world) => (await questionRecords(world)).dispose('proposal'),
  },
  {
    trigger: 'inv_disposition_guard',
    code: 'disposition_person',
    name: 'an agent deciding that a document needs no booking',
    run: async (world) => (await questionRecords(world)).dispose('document', randomUUID()),
  },
  {
    trigger: 'inv_entry_guard',
    code: 'stale_read',
    name: 'posting after a later answer replaced the one the proposal relied on',
    run: async (world) => {
      const records = await questionRecords(world);
      const first = await records.answer(1);
      const { proposed, approvalId } = await approved(world, sale(world), {
        readSet: [{ kind: 'answer', id: records.id, version: first }],
      });
      await records.answer(2);
      return post(world, proposed, { approvalId });
    },
  },
  {
    trigger: 'inv_submission_guard',
    code: 'submission_document',
    name: 'submitting XML other than the invoice kept',
    run: async (world) => (await submittable(world)).submit('c'.repeat(64)),
  },
  {
    trigger: 'inv_submission_guard',
    code: 'submission_open',
    name: 'submitting again while the first submission is unresolved',
    run: async (world) => {
      const { submit, step } = await submittable(world);
      await step(await submit(), 1, 'authorized');
      await submit();
    },
  },
  {
    trigger: submission,
    code: 'submission_sequence',
    name: 'a submission step out of sequence',
    run: async (world) => {
      const { submit, step } = await submittable(world);
      await step(await submit(), 2, 'authorized');
    },
  },
  {
    trigger: submission,
    code: 'submission_transition',
    name: 'a submission reported submitted without being marked submitting first',
    run: async (world) => {
      const { submit, step } = await submittable(world);
      const id = await submit();
      await step(id, 1, 'authorized');
      await step(id, 2, 'submitted', { uploadId: '1' });
    },
  },
  {
    trigger: submission,
    code: 'submission_receipt',
    name: "a submission reported submitted without ANAF's upload index",
    run: async (world) => {
      const { submit, step } = await submittable(world);
      const id = await submit();
      await step(id, 1, 'authorized');
      await step(id, 2, 'submitting');
      await step(id, 3, 'submitted');
    },
  },
  {
    trigger: 'inv_spv_window_guard',
    code: 'spv_window_sequence',
    name: 'a synced window out of sequence',
    run: async (world) =>
      world.db.write((tx) =>
        tx.insert(spvSyncWindows).values({
          companyId: world.company,
          seq: 2,
          from: 1,
          to: 2,
          messages: 0,
          createdBy: world.owner,
        }),
      ),
  },
  {
    trigger: 'inv_income_source_guard',
    code: 'income_source_sequence',
    name: 'an income source version that skips a number',
    run: async (world) => (await sourceRecord(world)).version(2),
  },
  {
    trigger: 'inv_income_source_guard',
    code: 'income_source_form',
    name: 'an income source of a company not recorded as a PFA, II or IF',
    run: async (world) => (await sourceRecord(world, { form: false })).version(1),
  },
  {
    trigger: 'inv_income_source_guard',
    code: 'income_source_method_date',
    name: 'opting for the real system in the course of a year',
    run: async (world) => {
      const { version } = await sourceRecord(world);
      await version(1, { method: 'norma', realBasis: null });
      await version(2, { effectiveFrom: '2026-06-01', realBasis: 'option' });
    },
  },
  {
    trigger: 'inv_income_source_guard',
    code: 'income_source_option_lock',
    name: 'returning to a norm in the second year of the option for the real system',
    run: async (world) => {
      const { version } = await sourceRecord(world);
      await version(1, { realBasis: 'option' });
      await version(2, { effectiveFrom: '2027-01-01', method: 'norma', realBasis: null });
    },
  },
  {
    trigger: 'inv_enterprise_member_guard',
    code: 'enterprise_member_version',
    name: 'a family enterprise agreement that skips a number',
    run: async (world) => {
      const { member, first } = await memberRecord(world);
      await member(2, first, 6000);
    },
  },
  {
    trigger: 'inv_enterprise_member_guard',
    code: 'enterprise_member_form',
    name: 'members of a company not recorded as a family enterprise',
    run: async (world) => {
      const { member, first } = await memberRecord(world, { form: false });
      await member(1, first, 6000);
    },
  },
  {
    trigger: 'inv_enterprise_member_guard',
    code: 'enterprise_member_cnp',
    name: 'a member whose CNP is not recorded',
    run: async (world) => {
      const { member, unsealed } = await memberRecord(world);
      await member(1, unsealed, 6000);
    },
  },
  {
    trigger: 'inv_enterprise_member_guard',
    code: 'enterprise_member_quota',
    name: 'quotas of the net income over 100%',
    run: async (world) => {
      const { member, first, second } = await memberRecord(world);
      await member(1, first, 6000);
      await member(1, second, 5000);
    },
  },
  {
    trigger: 'inv_enterprise_member_guard',
    code: 'enterprise_member_representative',
    name: 'two representatives in one agreement',
    run: async (world) => {
      const { member, first, second } = await memberRecord(world);
      await member(1, first, 6000, { representative: true });
      await member(1, second, 4000, { representative: true });
    },
  },
  {
    trigger: 'inv_enterprise_member_guard',
    code: 'enterprise_member_terms',
    name: 'a member of an agreement from another date than the agreement',
    run: async (world) => {
      const { member, first, second } = await memberRecord(world);
      await member(1, first, 6000, { representative: true });
      await member(1, second, 4000, { effectiveFrom: '2026-03-01' });
    },
  },
  {
    trigger: 'inv_enterprise_member_guard',
    code: 'enterprise_member_complete',
    name: 'an addendum after an agreement whose quotas do not add to 100%',
    run: async (world) => {
      const { member, first, second } = await memberRecord(world);
      await member(1, first, 6000, { representative: true });
      await member(1, second, 3000);
      await member(2, first, 10000, { representative: true, effectiveFrom: '2026-07-01' });
    },
  },
  {
    trigger: 'inv_enterprise_member_guard',
    code: 'enterprise_member_dates',
    name: 'an addendum from the same day as the agreement it follows',
    run: async (world) => {
      const { member, agreement, first } = await memberRecord(world);
      await agreement();
      await member(2, first, 6000, { representative: true });
    },
  },
  {
    trigger: 'inv_party_status_guard',
    code: 'party_status_sequence',
    name: 'a status snapshot that skips a number',
    run: async (world) => (await statusRecord(world)).snapshot(2),
  },
  {
    trigger: 'inv_party_status_guard',
    code: 'party_status_party',
    name: 'a status snapshot under a CUI the party does not hold',
    run: async (world) => (await statusRecord(world)).snapshot(1, { cui: '14399840' }),
  },
  {
    trigger: entry,
    code: 'stale_read',
    name: 'posting after a snapshot of the party status the proposal read',
    run: async (world) => {
      const { partyId, snapshot } = await statusRecord(world);
      const { proposed, approvalId } = await approved(world, sale(world), {
        readSet: [{ kind: 'partyStatus', id: `${partyId}|2026-03-10`, version: '0' }],
      });
      await snapshot(1, { inactive: true, inactiveSince: '2026-03-01' });
      return post(world, proposed, { approvalId });
    },
  },
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
    code: 'subject_posted',
    name: 'posting a subject again while its entry stands, its reversal only proposed',
    run: async (world) => {
      const first = await approved(world, sale(world), { subjectKey: 'document:reversing' });
      await withdraw(world, first.proposed.proposalId);
      const posted = await book(world, sale(world), { subjectKey: 'document:reversing' });
      // A reversal proposed, not posted, frees nothing: the entry still stands.
      await propose(world, sale(world), { subjectKey: `reverse:${posted.entry.id}` });
      return post(world, first.proposed, { approvalId: first.approvalId });
    },
  },
  {
    trigger: entry,
    code: 'reversal_of_reversal',
    name: 'reversing a reversal instead of booking its subject again',
    run: async (world) => {
      const original = await book(world, sale(world), { subjectKey: 'document:storno' });
      const reversal = await book(world, sale(world), {
        subjectKey: `reverse:${original.entry.id}`,
      });
      return book(world, sale(world), { subjectKey: `reverse:${reversal.entry.id}` });
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
    code: 'binding',
    name: 'auto-posting a warning the policy does not acknowledge',
    run: async (world) => {
      const proposed = await propose(world, sale(world), { issues: [warning] });
      const policyId = await policy(world, world.reviewer, [
        { kind: 'acknowledges', codes: ['PARTY_INACTIVE'] },
      ]);
      return post(world, proposed, { policyId });
    },
  },
  {
    trigger: entry,
    code: 'binding',
    name: 'auto-posting an acknowledged warning under a policy that refuses warnings',
    run: async (world) => {
      const proposed = await propose(world, sale(world), { issues: [warning] });
      const policyId = await policy(world, world.reviewer, [
        { kind: 'noWarnings' },
        { kind: 'acknowledges', codes: ['VAT_FX'] },
      ]);
      return post(world, proposed, { policyId });
    },
  },
  {
    trigger: entry,
    code: 'segregation',
    name: "auto-posting one's own proposal under one's own policy, segregation on",
    run: async (world) => {
      await segregate(world, 'on');
      const proposed = await propose(world, sale(world));
      return post(world, proposed, { policyId: await policy(world, world.owner) });
    },
  },
  {
    trigger: entry,
    code: 'segregation',
    name: "auto-posting one's agent's proposal under one's own policy, segregation strict",
    run: async (world) => {
      await segregate(world, 'strict');
      const proposed = await propose(world, sale(world), { agentId: randomUUID() });
      return post(world, proposed, { policyId: await policy(world, world.owner) });
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
      await lockTaxPeriod(world.db, world.company, world.owner, 'VAT', '2026-03');
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
  {
    trigger: entry,
    code: 'stale_read',
    name: 'posting after an entry reached the tax period the proposal read',
    run: async (world) => {
      await book(world, sale(world));
      const { proposed, approvalId } = await approved(world, sale(world), {
        readSet: [{ kind: 'taxPeriod', id: 'VAT|2026-03', version: '0/0/0' }],
      });
      return post(world, proposed, { approvalId });
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
    trigger: 'inv_approval_guard',
    code: 'segregation',
    name: "approving one's own version, segregation on",
    run: async (world) => {
      await segregate(world, 'on');
      return approve(world, await propose(world, sale(world)), world.owner);
    },
  },
  {
    trigger: 'inv_approval_guard',
    code: 'segregation',
    name: "approving one's agent's version, segregation strict",
    run: async (world) => {
      await segregate(world, 'strict');
      const proposed = await propose(world, sale(world), { agentId: randomUUID() });
      return approve(world, proposed, world.owner);
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
    code: 'identity_taken',
    name: 'recognizing a copy of a document whose identity another copy’s open proposal holds',
    run: async (world) => {
      const records = await documentRecords(world);
      const extracted = await records.add();
      const efactura = await records.add({ authority: 'efactura' });
      await records.proposal(extracted);
      return records.proposal(efactura);
    },
  },
  {
    trigger: 'inv_proposal_subject',
    code: 'identity_taken',
    name: 'recognizing a member of a group whose posted root a person matched',
    run: async (world) => {
      const records = await documentRecords(world);
      const root = await records.add({ identityKey: 'identity-1' });
      const near = await records.add({ identityKey: 'identity-2' });
      await records.link(near, root, 'same_as_confirmed');
      await book(world, sale(world), { subjectKey: `document:${root}` });
      return records.proposal(near);
    },
  },
  {
    trigger: 'inv_proposal_subject',
    code: 'identity_taken',
    name: 'recognizing a copy of a document whose booking a reversal only proposed',
    run: async (world) => {
      const records = await documentRecords(world);
      const extracted = await records.add();
      const efactura = await records.add({ authority: 'efactura' });
      const posted = await book(world, sale(world), { subjectKey: `document:${extracted}` });
      await propose(world, sale(world), { subjectKey: `reverse:${posted.entry.id}` });
      return records.proposal(efactura);
    },
  },
  {
    trigger: 'inv_document_guard',
    code: 'document_authority',
    name: 'a document that does not say where its content comes from',
    run: async (world) => (await documentRecords(world)).add({ authority: null }),
  },
  {
    trigger: 'inv_document_guard',
    code: 'extracted_source',
    name: 'an extracted document under a source key that is not its file’s',
    run: async (world) =>
      (await documentRecords(world)).add({ sourceKey: `extract:${'0'.repeat(64)}:1` }),
  },
  {
    trigger: 'inv_document_guard',
    code: 'extracted_source',
    name: 'an e-Factura document taking an extraction’s source key',
    run: async (world) =>
      (await documentRecords(world)).add({
        authority: 'efactura',
        sourceKey: `extract:${'f'.repeat(64)}:1`,
      }),
  },
  {
    trigger: 'inv_document_link_guard',
    code: 'same_as_root',
    name: 'a same_as link between documents of different identities',
    run: async (world) => {
      const records = await documentRecords(world);
      const first = await records.add({ identityKey: 'identity-1' });
      const second = await records.add({ identityKey: 'identity-2' });
      return records.link(second, first, 'same_as');
    },
  },
  {
    trigger: 'inv_document_link_guard',
    code: 'same_as_root',
    name: 'a document joining a group through a member rather than its root',
    run: async (world) => {
      const records = await documentRecords(world);
      const root = await records.add();
      const member = await records.add();
      await records.link(member, root, 'same_as');
      return records.link(await records.add(), member, 'same_as');
    },
  },
  {
    trigger: 'inv_document_link_guard',
    code: 'supersede',
    name: 'superseding an extraction a posted entry recognizes',
    run: async (world) => {
      const records = await documentRecords(world);
      const posted = await records.add();
      await book(world, sale(world), { subjectKey: `document:${posted}` });
      return records.link(await records.add({ identityKey: null }), posted, 'supersedes');
    },
  },
  {
    trigger: 'inv_document_link_guard',
    code: 'supersede',
    name: 'superseding an extraction whose booking a reversal only proposed',
    run: async (world) => {
      const records = await documentRecords(world);
      const posted = await records.add();
      const booked = await book(world, sale(world), { subjectKey: `document:${posted}` });
      await propose(world, sale(world), { subjectKey: `reverse:${booked.entry.id}` });
      return records.link(await records.add({ identityKey: null }), posted, 'supersedes');
    },
  },
  {
    trigger: 'inv_document_link_guard',
    code: 'supersede',
    name: 'superseding an e-Factura document, which is the source itself',
    run: async (world) => {
      const records = await documentRecords(world);
      const efactura = await records.add({ authority: 'efactura' });
      return records.link(await records.add(), efactura, 'supersedes');
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
    trigger: 'inv_proposal_subject',
    code: 'subject_taken',
    name: 'proposing a subject again while its posted entry stands',
    run: async (world) => {
      const posted = await book(world, sale(world), { subjectKey: 'movement:taken' });
      // Its reversal only proposed: the entry stands, and holds the subject.
      await propose(world, sale(world), { subjectKey: `reverse:${posted.entry.id}` });
      return propose(world, sale(world), { subjectKey: 'movement:taken' });
    },
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
    trigger: 'inv_action_decision_guard',
    code: 'segregation',
    name: "approving one's own action request, segregation on",
    run: async (world) => {
      await segregate(world, 'on');
      return decide(world, await actionRequest(world), world.owner);
    },
  },
  {
    trigger: 'inv_action_decision_guard',
    code: 'segregation',
    name: "approving one's agent's action request, segregation strict",
    run: async (world) => {
      await segregate(world, 'strict');
      return decide(world, await actionRequest(world, randomUUID()), world.owner);
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
    trigger: 'inv_action_execution_guard',
    code: 'decider',
    name: "executing after the approver's role changed",
    run: async (world) => {
      const id = await approvedAction(world);
      await demote(world, world.reviewer);
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
    run: async (world) => {
      const reference = await authorizedDeclaration(
        world.db,
        world.company,
        world.owner,
        'VAT',
        '2026-03',
      );
      return world.db.write((tx) =>
        tx.insert(taxPeriodEvents).values({
          companyId: world.company,
          tax: 'VAT',
          period: '2026-03',
          seq: 1,
          kind: 'unlock',
          reference,
          createdBy: world.owner,
        }),
      );
    },
  },
  {
    trigger: 'inv_tax_period_event_guard',
    code: 'lock_artifact',
    name: 'locking a tax period without an authorized return',
    run: async (world) =>
      world.db.write((tx) =>
        tx.insert(taxPeriodEvents).values({
          companyId: world.company,
          tax: 'VAT',
          period: '2026-03',
          seq: 1,
          kind: 'lock',
          reference: 'D300 2026-03',
          createdBy: world.owner,
        }),
      ),
  },
  {
    trigger: 'inv_artifact_event_guard',
    code: 'artifact_sequence',
    name: 'a declaration step out of sequence',
    run: async (world) => {
      const id = await authorizedDeclaration(
        world.db,
        world.company,
        world.owner,
        'VAT',
        '2026-03',
      );
      return world.db.write((tx) =>
        tx.insert(artifactEvents).values({
          companyId: world.company,
          artifactId: id,
          seq: 9,
          state: 'exported_for_signing',
          createdBy: world.owner,
        }),
      );
    },
  },
  {
    trigger: 'inv_artifact_event_guard',
    code: 'artifact_transition',
    name: 'authorizing a declaration that failed validation',
    run: async (world) => {
      const id = await authorizedDeclaration(
        world.db,
        world.company,
        world.owner,
        'VAT',
        '2026-03',
      );
      return world.db.write((tx) =>
        tx.insert(artifactEvents).values({
          companyId: world.company,
          artifactId: id,
          seq: 4,
          state: 'validation_failed',
          createdBy: world.owner,
        }),
      );
    },
  },
  {
    trigger: 'inv_asset_guard',
    code: 'asset_accounts',
    name: 'a fixed asset on an expense account',
    run: (world) => assetRecord(world, { account: '6028' }),
  },
  {
    trigger: 'inv_asset_fiscal_guard',
    code: 'asset_fiscal_version',
    name: "skipping a version of an asset's fiscal basis",
    run: async (world) => {
      const { fiscal } = await assetRecord(world);
      await fiscal(1);
      return fiscal(3);
    },
  },
  {
    trigger: 'inv_asset_fiscal_guard',
    code: 'asset_fiscal_version',
    name: "starting an asset's fiscal bases at a version other than 1",
    run: async (world) => (await assetRecord(world)).fiscal(2),
  },
  {
    trigger: 'inv_asset_event_guard',
    code: 'asset_disposal',
    name: 'disposing of an asset before its commissioning',
    run: async (world) => (await assetRecord(world)).dispose(1, '2026-03-01'),
  },
  {
    trigger: 'inv_asset_event_guard',
    code: 'asset_disposal',
    name: 'disposing of an asset twice',
    run: async (world) => {
      const { dispose } = await assetRecord(world);
      await dispose(1, '2026-06-30');
      return dispose(2, '2026-07-31');
    },
  },
  {
    trigger: 'inv_employment_terms_guard',
    code: 'terms_sequence',
    name: "skipping a version of a contract's terms",
    run: async (world) => (await payrollRecords(world)).terms(3),
  },
  {
    trigger: 'inv_employment_terms_guard',
    code: 'terms_sequence',
    name: 'a version of the terms applying before the previous one',
    run: async (world) => (await payrollRecords(world)).terms(2, { effectiveFrom: '2026-01-01' }),
  },
  {
    trigger: 'inv_employment_terms_guard',
    code: 'terms_values',
    name: 'a contract of nine hours a day',
    run: async (world) =>
      (await payrollRecords(world)).terms(2, { effectiveFrom: '2026-02-01', dailyHours: 9 }),
  },
  {
    trigger: 'inv_payroll_run_event_guard',
    code: 'payroll_run_transition',
    name: 'preparing a payroll run twice',
    run: async (world) => {
      const { runId } = await payrollRecords(world);
      return world.db.write((tx) =>
        tx.insert(payrollRunEvents).values({
          companyId: world.company,
          runId,
          seq: 2,
          state: 'prepared',
          createdBy: world.owner,
        }),
      );
    },
  },
  {
    trigger: 'inv_payroll_line_guard',
    code: 'payroll_line_sum',
    name: 'a payslip whose net does not add up',
    run: async (world) => (await payrollRecords(world)).line({ net: 300000n }),
  },
  {
    trigger: 'inv_payroll_line_guard',
    code: 'payroll_line_employee',
    name: "a payslip under another party than the contract's employee",
    run: async (world) => (await payrollRecords(world)).line({ partyId: randomUUID() }),
  },
  {
    trigger: entry,
    code: 'stale_read',
    name: 'posting after the payroll run the proposal read was recomputed',
    run: async (world) => {
      const { runId } = await payrollRecords(world);
      const { proposed, approvalId } = await approved(world, sale(world), {
        readSet: [{ kind: 'payrollRun', id: runId, version: 'h/prepared' }],
      });
      await world.db.write((tx) =>
        tx.insert(payrollRunEvents).values({
          companyId: world.company,
          runId,
          seq: 2,
          state: 'superseded',
          createdBy: world.owner,
        }),
      );
      return post(world, proposed, { approvalId });
    },
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
    trigger: 'inv_grant_update',
    code: 'immutable_record',
    name: 'adding a toolset to a grant when revoking it',
    run: async (world) => {
      const id = randomUUID();
      await world.db.write((tx) =>
        tx.insert(agentGrants).values({
          id,
          companyId: world.company,
          name: 'Agent',
          tokenHash: randomUUID(),
          scopes: ['proposals.get'],
          toolsets: [],
          membershipEpoch: 1,
          expiresAt: later,
          createdBy: world.reviewer,
        }),
      );
      return world.db.write((tx) =>
        tx
          .update(agentGrants)
          .set({ toolsets: ['review'], revokedAt: Date.now() })
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
    trigger: 'inv_bank_statement_guard',
    code: 'statement_overlap',
    name: 'a second statement for days another already reports',
    run: async (world) => {
      const bank = await bankRecords(world);
      await bank.statement('2026-10-01', '2026-10-31', 0n, 100n);
      return bank.statement('2026-10-15', '2026-11-15', 50n, 200n);
    },
  },
  {
    trigger: 'inv_bank_statement_guard',
    code: 'statement_overlap',
    name: 'a statement opening on the day another closes, at another balance',
    run: async (world) => {
      const bank = await bankRecords(world);
      await bank.statement('2026-10-01', '2026-10-31', 0n, 100n);
      return bank.statement('2026-10-31', '2026-11-30', 90n, 200n);
    },
  },
  {
    trigger: 'inv_bank_statement_guard',
    code: 'statement_overlap',
    name: 'an earlier statement closing on a day the later one reports movements on',
    run: async (world) => {
      const bank = await bankRecords(world);
      const november = await bank.statement('2026-10-31', '2026-11-30', 100n, 200n);
      await bank.movement(november, '2026-10-31');
      return bank.statement('2026-10-01', '2026-10-31', 0n, 100n);
    },
  },
  {
    trigger: 'inv_bank_movement_guard',
    code: 'statement_overlap',
    name: 'a movement on the day its statement takes over from the previous one',
    run: async (world) => {
      const bank = await bankRecords(world);
      const october = await bank.statement('2026-10-01', '2026-10-31', 0n, 100n);
      await bank.movement(october, '2026-10-31');
      const november = await bank.statement('2026-10-31', '2026-11-30', 100n, 200n);
      return bank.movement(november, '2026-10-31');
    },
  },
  {
    trigger: 'inv_bank_movement_guard',
    code: 'statement_overlap',
    name: 'a movement outside the days of its statement',
    run: async (world) => {
      const bank = await bankRecords(world);
      const october = await bank.statement('2026-10-01', '2026-10-31', 0n, 100n);
      return bank.movement(october, '2026-11-05');
    },
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
  {
    trigger: 'inv_approval_guard',
    code: 'batch_member',
    name: "approving in a batch's name a version its preview does not list",
    run: async (world) => {
      const records = await autonomyRecords(world);
      const listed = await propose(world, sale(world));
      const other = await propose(world, sale(world));
      return records.batchApproval(other, await records.batch([listed]));
    },
  },
  {
    trigger: 'inv_approval_guard',
    code: 'batch_member',
    name: "approving in a batch's name as someone other than its decider",
    run: async (world) => {
      const records = await autonomyRecords(world);
      const listed = await propose(world, sale(world));
      return records.batchApproval(listed, await records.batch([listed]), world.owner);
    },
  },
  {
    trigger: 'inv_approval_guard',
    code: 'batch_member',
    name: 'approving in a batch a version with a warning to acknowledge',
    run: async (world) => {
      const records = await autonomyRecords(world);
      const warned = await propose(world, sale(world), { issues: [warning] });
      return records.batchApproval(warned, await records.batch([warned]));
    },
  },
  {
    trigger: entry,
    code: 'binding',
    name: 'a policy posting while the company paused automation',
    run: async (world) => {
      const policyId = await policy(world);
      await (await autonomyRecords(world)).automation(1);
      return post(world, await propose(world, sale(world)), { policyId });
    },
  },
  {
    trigger: entry,
    code: 'binding',
    name: 'a policy posting while it is paused',
    run: async (world) => {
      const policyId = await policy(world);
      await (await autonomyRecords(world)).automation(1, { scope: 'policy', scopeId: policyId });
      return post(world, await propose(world, sale(world)), { policyId });
    },
  },
  {
    trigger: entry,
    code: 'binding',
    name: 'a policy posting while the template it is bound to is paused',
    run: async (world) => {
      const records = await autonomyRecords(world);
      const templateId = await records.template();
      const policyId = await policy(world, world.reviewer, [
        { kind: 'template', id: templateId, version: 1 },
      ]);
      await records.automation(1, { scope: 'template', scopeId: templateId });
      return post(world, await propose(world, sale(world)), { policyId });
    },
  },
  {
    trigger: entry,
    code: 'binding',
    name: 'a policy posting an extracted document without allowing extracted sources',
    run: async (world) => {
      const documentId = await (await documentRecords(world)).add();
      const policyId = await policy(world);
      const proposed = await propose(world, sale(world), {
        readSet: [{ kind: 'document', id: documentId, version: 'v' }],
      });
      return post(world, proposed, { policyId });
    },
  },
  {
    trigger: 'inv_membership_insert',
    code: 'system_member',
    name: 'admitting the system principal as a member',
    run: async (world) =>
      world.db.write((tx) =>
        tx
          .insert(memberships)
          .values({ companyId: world.company, userId: 'system', role: 'reviewer' }),
      ),
  },
  {
    trigger: 'inv_policy_guard',
    code: 'policy_scope',
    name: 'a policy posting SPV submissions',
    run: async (world) =>
      world.db.write(async (tx) =>
        tx.insert(postingPolicies).values({
          id: randomUUID(),
          companyId: world.company,
          name: 'Transmiteri',
          treatments: canonical(['spv.submit']),
          rulesHashes: canonical(['rules-1']),
          preconditions: '[]',
          approvedBy: world.reviewer,
          approverEpoch: await epoch(world, world.reviewer),
          validFrom: '2026-01-01',
          expiresAt: later,
        }),
      ),
  },
  {
    trigger: 'inv_template_guard',
    code: 'template_version',
    name: "skipping a template's first version",
    run: async (world) => (await autonomyRecords(world)).template(2),
  },
  {
    trigger: 'inv_template_guard',
    code: 'template_request',
    name: 'writing a template no person approved',
    run: async (world) => {
      const records = await autonomyRecords(world);
      return records.template(1, {
        requestId: await records.reviewed('templates.request', {}, null),
      });
    },
  },
  {
    trigger: 'inv_template_guard',
    code: 'template_request',
    name: 'writing a template in the name of someone other than its decider',
    run: async (world) => (await autonomyRecords(world)).template(1, { approvedBy: world.owner }),
  },
  {
    trigger: 'inv_template_revocation_guard',
    code: 'template_missing',
    name: 'revoking a template that does not exist',
    run: async (world) => (await autonomyRecords(world)).revoke(randomUUID()),
  },
  {
    trigger: 'inv_template_prediction_guard',
    code: 'prediction_posted',
    name: 'recording a prediction after its subject was posted',
    run: async (world) => {
      const records = await autonomyRecords(world);
      await records.template();
      await book(world, sale(world), { subjectKey: 'document:posted' });
      return records.predict('document:posted');
    },
  },
  {
    trigger: 'inv_template_prediction_guard',
    code: 'prediction_posted',
    name: 'recording a prediction for a subject posted and reversed, so after the fact',
    run: async (world) => {
      const records = await autonomyRecords(world);
      await records.template();
      const posted = await book(world, sale(world), { subjectKey: 'document:rebooked' });
      await book(world, sale(world), { subjectKey: `reverse:${posted.entry.id}` });
      return records.predict('document:rebooked');
    },
  },
  {
    trigger: 'inv_automation_event_guard',
    code: 'automation_sequence',
    name: 'a pause numbered past the company’s events',
    run: async (world) => (await autonomyRecords(world)).automation(2),
  },
  {
    trigger: 'inv_automation_event_guard',
    code: 'automation_actor',
    name: 'a pause by a member under an epoch that ended',
    run: async (world) =>
      (await autonomyRecords(world)).automation(1, { createdBy: world.viewer, epoch: 99 }),
  },
  {
    trigger: 'inv_automation_event_guard',
    code: 'automation_resume',
    name: 'a viewer resuming automation',
    run: async (world) =>
      (await autonomyRecords(world)).automation(1, { kind: 'resume', createdBy: world.viewer }),
  },
  {
    trigger: 'inv_automation_event_guard',
    code: 'automation_resume',
    name: 'the system resuming what it paused',
    run: async (world) =>
      (await autonomyRecords(world)).automation(1, { kind: 'resume', createdBy: 'system' }),
  },
  {
    trigger: 'inv_automation_event_guard',
    code: 'automation_resume',
    name: 'an agent resuming automation',
    run: async (world) =>
      (await autonomyRecords(world)).automation(1, { kind: 'resume', agentId: randomUUID() }),
  },
  {
    trigger: 'inv_automation_event_guard',
    code: 'automation_scope',
    name: 'pausing a policy the company does not have',
    run: async (world) =>
      (await autonomyRecords(world)).automation(1, { scope: 'policy', scopeId: randomUUID() }),
  },
  {
    trigger: 'inv_automation_criteria_guard',
    code: 'criteria_sequence',
    name: 'criteria numbered past the company’s',
    run: async (world) => (await autonomyRecords(world)).criteria(2),
  },
  {
    trigger: 'inv_automation_criteria_guard',
    code: 'criteria_person',
    name: 'a viewer setting the graduation criteria',
    run: async (world) => (await autonomyRecords(world)).criteria(1, world.viewer),
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

describe('approval controls', () => {
  test('a policy posts the warnings it acknowledges, and notes under noWarnings', async () => {
    const world = await fresh();
    const warned = await propose(world, sale(world), { issues: [warning] });
    const acknowledging = await policy(world, world.reviewer, [
      { kind: 'acknowledges', codes: ['VAT_FX'] },
    ]);
    expect(await refusal(post(world, warned, { policyId: acknowledging }))).toBeUndefined();
    const noted = await propose(world, sale(world), {
      issues: [{ code: 'NOTE', severity: 'info', message: 'Informativ.' }],
    });
    const strict = await policy(world, world.reviewer, [{ kind: 'noWarnings' }]);
    expect(await refusal(post(world, noted, { policyId: strict }))).toBeUndefined();
  });

  test('without a segregation fact, a person approves their own work', async () => {
    const world = await fresh();
    expect(await refusal(approve(world, await propose(world, sale(world)), world.owner))).toBe(
      undefined,
    );
    expect(await refusal(decide(world, await actionRequest(world), world.owner))).toBeUndefined();
    const own = await propose(world, sale(world));
    expect(await refusal(post(world, own, { policyId: await policy(world, world.owner) }))).toBe(
      undefined,
    );
  });

  test('segregation on leaves others, the grant issuer for agents, and rejections free', async () => {
    const world = await fresh();
    await segregate(world, 'on');
    expect(await refusal(approve(world, await propose(world, sale(world))))).toBeUndefined();
    const agents = await propose(world, sale(world), { agentId: randomUUID() });
    expect(await refusal(approve(world, agents, world.owner))).toBeUndefined();
    expect(await refusal(decide(world, await actionRequest(world), world.reviewer))).toBe(
      undefined,
    );
    expect(await refusal(decide(world, await actionRequest(world), world.owner, 'reject'))).toBe(
      undefined,
    );
    const viaAgent = await actionRequest(world, randomUUID());
    expect(await refusal(decide(world, viaAgent, world.owner))).toBeUndefined();
    const own = await propose(world, sale(world));
    expect(await refusal(post(world, own, { policyId: await policy(world) }))).toBeUndefined();
  });

  test("a batch's decider approves each version it lists; the system pauses and posts", async () => {
    const world = await fresh();
    const records = await autonomyRecords(world);
    const listed = await propose(world, sale(world));
    const approvalId = await records.batchApproval(listed, await records.batch([listed]));
    expect(await refusal(post(world, listed, { approvalId }))).toBeUndefined();
    // The system pauses and its pause stops a policy; a person resumes it.
    const policyId = await policy(world);
    await records.automation(1, { scope: 'policy', scopeId: policyId, createdBy: 'system' });
    expect(await refusal(post(world, await propose(world, sale(world)), { policyId }))).toBe(
      'binding',
    );
    await records.automation(2, { scope: 'policy', scopeId: policyId, kind: 'resume' });
    expect(
      await refusal(post(world, await propose(world, sale(world)), { policyId })),
    ).toBeUndefined();
  });

  test('a segregation fact superseded by off no longer applies', async () => {
    const world = await fresh();
    await segregate(world, 'off', await segregate(world, 'strict'));
    expect(await refusal(approve(world, await propose(world, sale(world)), world.owner))).toBe(
      undefined,
    );
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

  test('a reversed entry frees its subject: proposed, posted and superseded again', async () => {
    const world = await fresh();
    const records = await documentRecords(world);
    const extracted = await records.add();
    const efactura = await records.add({ authority: 'efactura' });
    const first = await book(world, sale(world), { subjectKey: `document:${extracted}` });
    await book(world, sale(world), { subjectKey: `reverse:${first.entry.id}` });
    // The same subject, another copy of the document and a corrected extraction: all free.
    const again = await book(world, sale(world), { subjectKey: `document:${extracted}` });
    expect(again.entry.id).toEqual(expect.any(String));
    expect(await refusal(records.proposal(efactura))).toBe('identity_taken');
    await book(world, sale(world), { subjectKey: `reverse:${again.entry.id}` });
    await records.proposal(efactura);
    await records.link(await records.add({ identityKey: null }), extracted, 'supersedes');
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
    await lockTaxPeriod(world.db, world.company, world.owner, 'VAT', '2026-03');
    const spv = await submittable(world);
    await spv.step(await spv.submit(), 1, 'authorized');
    await (await payrollRecords(world)).line();
    const asset = await assetRecord(world);
    await asset.dispose(1, '2026-06-30');
    await asset.fiscal(1);
    await (await statusRecord(world)).snapshot(1);
    await (await sourceRecord(world)).version(1);
    await (await memberRecord(world)).agreement();
    const shareholder = randomUUID();
    await world.db.write(async (tx) => {
      await tx.insert(parties).values({
        id: shareholder,
        companyId: world.company,
        kind: 'ro_individual',
        country: 'RO',
        name: 'Asociat',
        createdBy: world.owner,
      });
      await tx.insert(partyCnps).values({
        companyId: world.company,
        partyId: shareholder,
        cnpSealed: 'v1.a.b.c',
        createdBy: world.owner,
      });
    });
    await world.db.write((tx) =>
      tx.insert(anafConnections).values({
        companyId: world.company,
        seq: 1,
        environment: 'test',
        accessSealed: 'v1.a.b.c',
        refreshSealed: 'v1.a.b.c',
        accessExpiresAt: 1,
        refreshExpiresAt: 1,
        createdBy: world.owner,
      }),
    );
    await world.db.write(async (tx) => {
      await tx.insert(spvSyncWindows).values({
        companyId: world.company,
        seq: 1,
        from: 1,
        to: 2,
        messages: 1,
        createdBy: world.owner,
      });
      await tx.insert(spvMessages).values({
        companyId: world.company,
        id: '1',
        uploadId: '1',
        kind: 'buyer_message',
        createdAtAnaf: 1,
        details: 'test',
        outcome: 'recorded',
        createdBy: world.owner,
      });
    });
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
          authority: 'issued' as const,
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
      await tx.insert(bankMappings).values({
        companyId: world.company,
        treasuryAccountId: treasuryId,
        version: 1,
        format: 'csv',
        mapping: '{}',
        mappingHash: 'd'.repeat(64),
        evidenceId,
        createdBy: world.owner,
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
    const asked = await questionRecords(world);
    await asked.answer(1);
    await asked.dispose('evidence', randomUUID());
    await (await questionRecords(world, 'CJ01XYZ')).withdraw();
    const proposed = await propose(world, sale(world));
    await withdraw(world, proposed.proposalId);
    const policyId = await policy(world);
    await world.db.write((tx) =>
      tx
        .insert(policyRevocations)
        .values({ companyId: world.company, policyId, reason: 'x', createdBy: world.owner }),
    );
    const autonomy = await autonomyRecords(world);
    await autonomy.template();
    await autonomy.revoke();
    await autonomy.predict('document:predicted');
    await autonomy.automation(1);
    await autonomy.criteria(1);
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
