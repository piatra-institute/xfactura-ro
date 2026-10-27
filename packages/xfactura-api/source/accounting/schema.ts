import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  customType,
  primaryKey,
  foreignKey,
  uniqueIndex,
  check,
  index,
} from 'drizzle-orm/sqlite-core';
import type { ProposalBody, StoredLine, Role } from './domain';
import type { InvoiceDocument } from './invoice-document';

// libSQL returns 64-bit integers as bigint. Only explicitly small counters use Number.
const counter = customType<{ data: number; driverData: number | bigint }>({
  dataType: () => 'integer',
  fromDriver: (value) => Number(value),
  toDriver: (value) => value,
});
const bani = customType<{ data: bigint; driverData: bigint }>({
  dataType: () => 'integer',
  fromDriver: (value) => BigInt(value),
  toDriver: (value) => value,
});
const createdAt = () =>
  text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
const companyId = () =>
  text('company_id')
    .notNull()
    .references(() => companies.id);
const author = () =>
  text('created_by')
    .notNull()
    .references(() => user.id);

// Better Auth uses its own number-mode client for millisecond timestamps.
export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('accounting_session_user').on(t.userId)],
);
export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    scope: text('scope'),
    password: text('password'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('accounting_account_user').on(t.userId)],
);
export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
export const authSchema = { user, session, account, verification };

export const companies = sqliteTable(
  'acc_companies',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    cui: text('cui').notNull(),
    year: counter('year').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [check('company_year', sql`${t.year} between 2020 and 2100`)],
);
export const accountingYears = sqliteTable(
  'acc_accounting_years',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    kind: text('kind', { enum: ['financial', 'fiscal'] }).notNull(),
    label: text('label').notNull(),
    from: text('date_from').notNull(),
    to: text('date_to').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('accounting_year_start').on(t.companyId, t.kind, t.from),
    check('accounting_year_dates', sql`${t.from} <= ${t.to}`),
  ],
);
export const ledgerAccounts = sqliteTable(
  'acc_ledger_accounts',
  {
    companyId: companyId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    parentCode: text('parent_code'),
    balance: text('balance', { enum: ['debit', 'credit', 'both'] }).notNull(),
    book: text('book', { enum: ['general', 'off_balance', 'management'] }).notNull(),
    postable: integer('postable', { mode: 'boolean' }).notNull(),
    chartVersion: text('chart_version').notNull(),
    validFrom: text('valid_from').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.code] })],
);
export const regimeEvents = sqliteTable(
  'acc_regime_events',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    axis: text('axis', { enum: ['vat', 'income_tax', 'eu_vat', 'vat_collection'] }).notNull(),
    value: text('value').notNull(),
    effectiveFrom: text('effective_from').notNull(),
    evidenceId: text('evidence_id').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('regime_effective_event').on(t.companyId, t.axis, t.effectiveFrom),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);
export const accountingPolicies = sqliteTable(
  'acc_accounting_policies',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    key: text('key').notNull(),
    version: counter('version').notNull(),
    effectiveFrom: text('effective_from').notNull(),
    title: text('title').notNull(),
    body: text('body', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    evidenceId: text('evidence_id').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('policy_version').on(t.companyId, t.key, t.version),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
    check('policy_version_positive', sql`${t.version} > 0`),
  ],
);
export const invoiceDocuments = sqliteTable(
  'acc_invoice_documents',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    evidenceId: text('evidence_id').notNull(),
    direction: text('direction', { enum: ['purchase', 'sale'] }).notNull(),
    sourceKey: text('source_key').notNull(),
    hash: text('hash').notNull(),
    body: text('body', { mode: 'json' }).$type<InvoiceDocument>().notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('invoice_source').on(t.companyId, t.sourceKey),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);
export const memberships = sqliteTable(
  'acc_memberships',
  {
    companyId: companyId(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    role: text('role', { enum: ['owner', 'reviewer', 'viewer'] })
      .$type<Role>()
      .notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.userId] }),
    check('membership_role', sql`${t.role} in ('owner','reviewer','viewer')`),
  ],
);
export const invitations = sqliteTable('acc_invitations', {
  id: text('id').primaryKey(),
  companyId: companyId(),
  email: text('email').notNull(),
  role: text('role', { enum: ['reviewer', 'viewer'] }).notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: counter('expires_at').notNull(),
  acceptedAt: counter('accepted_at'),
  createdBy: author(),
  createdAt: createdAt(),
});
export const evidence = sqliteTable(
  'acc_evidence',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    hash: text('hash').notNull(),
    filename: text('filename').notNull(),
    mediaType: text('media_type').notNull(),
    size: counter('size').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('evidence_content').on(t.companyId, t.hash),
    check('evidence_size', sql`${t.size} between 1 and 10485760`),
    check('evidence_hash', sql`length(${t.hash})=64`),
  ],
);
export const facts = sqliteTable(
  'acc_facts',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    evidenceId: text('evidence_id').notNull(),
    kind: text('kind', { enum: ['opening', 'purchase', 'correction', 'general'] }).notNull(),
    body: text('body', { mode: 'json' }).$type<ProposalBody>().notNull(),
    supersedesId: text('supersedes_id'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);
export const proposals = sqliteTable(
  'acc_proposals',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    factId: text('fact_id').notNull(),
    kind: text('kind', { enum: ['opening', 'purchase', 'correction', 'general'] }).notNull(),
    version: counter('version').notNull().default(1),
    hash: text('hash').notNull(),
    body: text('body', { mode: 'json' }).$type<ProposalBody>().notNull(),
    sourceKey: text('source_key').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('proposal_source').on(t.companyId, t.sourceKey),
    foreignKey({ columns: [t.companyId, t.factId], foreignColumns: [facts.companyId, facts.id] }),
  ],
);
export const approvals = sqliteTable(
  'acc_approvals',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    proposalId: text('proposal_id').notNull(),
    version: counter('version').notNull(),
    hash: text('hash').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('approval_version').on(t.companyId, t.proposalId, t.version),
    foreignKey({
      columns: [t.companyId, t.proposalId],
      foreignColumns: [proposals.companyId, proposals.id],
    }),
  ],
);
export const taxPositions = sqliteTable(
  'acc_tax_positions',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    periodFrom: text('period_from').notNull(),
    periodTo: text('period_to').notNull(),
    revision: counter('revision').notNull().default(1),
    status: text('status', { enum: ['PENDING_REVIEW', 'APPROVED'] })
      .notNull()
      .default('PENDING_REVIEW'),
    packageId: text('package_id').notNull().default('draft-a1'),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('tax_position_revision').on(t.companyId, t.periodFrom, t.revision),
  ],
);
export const fiscalInterpretations = sqliteTable(
  'acc_fiscal_interpretations',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    factId: text('fact_id').notNull(),
    positionId: text('position_id').notNull(),
    status: text('status', { enum: ['PENDING_REVIEW', 'APPROVED'] })
      .notNull()
      .default('PENDING_REVIEW'),
    affectsPosting: integer('affects_posting', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    foreignKey({ columns: [t.companyId, t.factId], foreignColumns: [facts.companyId, facts.id] }),
    foreignKey({
      columns: [t.companyId, t.positionId],
      foreignColumns: [taxPositions.companyId, taxPositions.id],
    }),
  ],
);
export const periods = sqliteTable(
  'acc_periods',
  {
    companyId: companyId(),
    month: text('month').notNull(),
    closedAt: text('closed_at'),
    closedBy: text('closed_by').references(() => user.id),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.month] })],
);
export const journals = sqliteTable(
  'acc_journals',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    number: counter('number').notNull(),
    date: text('date').notNull(),
    kind: text('kind', {
      enum: ['opening', 'purchase', 'payment', 'correction', 'general'],
    }).notNull(),
    sourceId: text('source_id').notNull(),
    approvalId: text('approval_id'),
    evidenceId: text('evidence_id').notNull(),
    description: text('description').notNull(),
    lines: text('lines_json', { mode: 'json' }).$type<StoredLine[]>().notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('journal_number').on(t.companyId, t.number),
    uniqueIndex('journal_source').on(t.companyId, t.kind, t.sourceId),
    foreignKey({
      columns: [t.companyId, t.approvalId],
      foreignColumns: [approvals.companyId, approvals.id],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
    check('journal_lines_json', sql`json_valid(${t.lines})`),
  ],
);
export const correctionOutcomes = sqliteTable(
  'acc_correction_outcomes',
  {
    companyId: companyId(),
    proposalId: text('proposal_id').notNull(),
    purchaseProposalId: text('purchase_proposal_id').notNull(),
    targetJournalId: text('target_journal_id').notNull(),
    status: text('status', { enum: ['posted', 'withdrawn'] }).notNull(),
    journalId: text('journal_id'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.proposalId] }),
    uniqueIndex('correction_target')
      .on(t.companyId, t.targetJournalId)
      .where(sql`${t.status}='posted'`),
    uniqueIndex('correction_journal').on(t.companyId, t.journalId),
    foreignKey({
      columns: [t.companyId, t.proposalId],
      foreignColumns: [proposals.companyId, proposals.id],
    }),
    foreignKey({
      columns: [t.companyId, t.purchaseProposalId],
      foreignColumns: [proposals.companyId, proposals.id],
    }),
    foreignKey({
      columns: [t.companyId, t.targetJournalId],
      foreignColumns: [journals.companyId, journals.id],
    }),
    foreignKey({
      columns: [t.companyId, t.journalId],
      foreignColumns: [journals.companyId, journals.id],
    }),
    check(
      'correction_outcome',
      sql`(${t.status}='posted' and ${t.journalId} is not null) or (${t.status}='withdrawn' and ${t.journalId} is null)`,
    ),
  ],
);
export const journalLines = sqliteTable(
  'acc_journal_lines',
  {
    companyId: companyId(),
    journalId: text('journal_id').notNull(),
    line: counter('line').notNull(),
    account: text('account').notNull(),
    debitBani: bani('debit_bani').notNull(),
    creditBani: bani('credit_bani').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.journalId, t.line] }),
    foreignKey({
      columns: [t.companyId, t.journalId],
      foreignColumns: [journals.companyId, journals.id],
    }),
    check(
      'integer_amounts',
      sql`typeof(${t.debitBani})='integer' and typeof(${t.creditBani})='integer'`,
    ),
    check(
      'single_sided_line',
      sql`(${t.debitBani}>0 and ${t.creditBani}=0) or (${t.creditBani}>0 and ${t.debitBani}=0)`,
    ),
  ],
);
export const bankAccounts = sqliteTable('acc_bank_accounts', {
  companyId: companyId().primaryKey(),
  identifier: text('identifier').notNull(),
});
export const treasuryAccounts = sqliteTable(
  'acc_treasury_accounts',
  {
    companyId: companyId(),
    identifier: text('identifier').notNull(),
    kind: text('kind', { enum: ['bank', 'cash'] }).notNull(),
    currency: text('currency').notNull(),
    ledgerAccount: text('ledger_account').notNull(),
    openedOn: text('opened_on').notNull(),
    evidenceId: text('evidence_id'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.identifier] }),
    uniqueIndex('treasury_ledger_account').on(t.companyId, t.ledgerAccount),
    foreignKey({
      columns: [t.companyId, t.ledgerAccount],
      foreignColumns: [ledgerAccounts.companyId, ledgerAccounts.code],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
    check('treasury_ron', sql`${t.currency}='RON'`),
  ],
);
export const statements = sqliteTable(
  'acc_statements',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    evidenceId: text('evidence_id').notNull(),
    bankAccount: text('bank_account').notNull(),
    sourceId: text('source_id').notNull(),
    periodFrom: text('period_from').notNull(),
    periodTo: text('period_to').notNull(),
    openingBani: bani('opening_bani').notNull(),
    closingBani: bani('closing_bani').notNull(),
    hash: text('hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('statement_source').on(t.companyId, t.bankAccount, t.sourceId),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);
export const movements = sqliteTable(
  'acc_movements',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    bankAccount: text('bank_account').notNull(),
    sourceId: text('source_id').notNull(),
    date: text('date').notNull(),
    amountBani: bani('amount_bani').notNull(),
    reference: text('reference').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('movement_source').on(t.companyId, t.bankAccount, t.sourceId),
  ],
);
export const statementMovements = sqliteTable(
  'acc_statement_movements',
  {
    companyId: companyId(),
    statementId: text('statement_id').notNull(),
    movementId: text('movement_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.statementId, t.movementId] }),
    foreignKey({
      columns: [t.companyId, t.statementId],
      foreignColumns: [statements.companyId, statements.id],
    }),
    foreignKey({
      columns: [t.companyId, t.movementId],
      foreignColumns: [movements.companyId, movements.id],
    }),
  ],
);
export const allocations = sqliteTable(
  'acc_allocations',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    movementId: text('movement_id').notNull(),
    proposalId: text('proposal_id').notNull(),
    amountBani: bani('amount_bani').notNull(),
    journalId: text('journal_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('movement_allocation').on(t.companyId, t.movementId),
    foreignKey({
      columns: [t.companyId, t.movementId],
      foreignColumns: [movements.companyId, movements.id],
    }),
    foreignKey({
      columns: [t.companyId, t.proposalId],
      foreignColumns: [proposals.companyId, proposals.id],
    }),
    foreignKey({
      columns: [t.companyId, t.journalId],
      foreignColumns: [journals.companyId, journals.id],
    }),
    check('positive_allocation', sql`${t.amountBani}>0 and typeof(${t.amountBani})='integer'`),
  ],
);
export const movementSources = sqliteTable(
  'acc_movement_sources',
  {
    companyId: companyId(),
    movementId: text('movement_id').notNull(),
    evidenceId: text('evidence_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.movementId, t.evidenceId] }),
    foreignKey({
      columns: [t.companyId, t.movementId],
      foreignColumns: [movements.companyId, movements.id],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);
export const movementPostings = sqliteTable(
  'acc_movement_postings',
  {
    companyId: companyId(),
    movementId: text('movement_id').notNull(),
    journalId: text('journal_id').notNull(),
    proposalId: text('proposal_id').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.movementId] }),
    uniqueIndex('movement_posting_journal').on(t.companyId, t.journalId),
    foreignKey({
      columns: [t.companyId, t.movementId],
      foreignColumns: [movements.companyId, movements.id],
    }),
    foreignKey({
      columns: [t.companyId, t.journalId],
      foreignColumns: [journals.companyId, journals.id],
    }),
    foreignKey({
      columns: [t.companyId, t.proposalId],
      foreignColumns: [proposals.companyId, proposals.id],
    }),
  ],
);
export const invoiceSettlements = sqliteTable(
  'acc_invoice_settlements',
  {
    companyId: companyId(),
    movementId: text('movement_id').notNull(),
    invoiceId: text('invoice_id').notNull(),
    clearedBani: bani('cleared_bani').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.movementId, t.invoiceId] }),
    foreignKey({
      columns: [t.companyId, t.movementId],
      foreignColumns: [movementPostings.companyId, movementPostings.movementId],
    }),
    foreignKey({
      columns: [t.companyId, t.invoiceId],
      foreignColumns: [invoiceDocuments.companyId, invoiceDocuments.id],
    }),
    check('settlement_amount', sql`typeof(${t.clearedBani})='integer' and ${t.clearedBani}<>0`),
  ],
);
export const invoicePostings = sqliteTable(
  'acc_invoice_postings',
  {
    companyId: companyId(),
    invoiceId: text('invoice_id').notNull(),
    journalId: text('journal_id').notNull(),
    proposalId: text('proposal_id').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.invoiceId] }),
    uniqueIndex('invoice_posting_journal').on(t.companyId, t.journalId),
    uniqueIndex('invoice_posting_proposal').on(t.companyId, t.proposalId),
    foreignKey({
      columns: [t.companyId, t.invoiceId],
      foreignColumns: [invoiceDocuments.companyId, invoiceDocuments.id],
    }),
    foreignKey({
      columns: [t.companyId, t.journalId],
      foreignColumns: [journals.companyId, journals.id],
    }),
    foreignKey({
      columns: [t.companyId, t.proposalId],
      foreignColumns: [proposals.companyId, proposals.id],
    }),
  ],
);
export const invoiceCredits = sqliteTable(
  'acc_invoice_credits',
  {
    companyId: companyId(),
    creditInvoiceId: text('credit_invoice_id').notNull(),
    originalInvoiceId: text('original_invoice_id').notNull(),
    journalId: text('journal_id').notNull(),
    netBani: bani('net_bani').notNull(),
    taxBani: bani('tax_bani').notNull(),
    grossBani: bani('gross_bani').notNull(),
    deductibleTaxBani: bani('deductible_tax_bani').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.creditInvoiceId] }),
    uniqueIndex('invoice_credit_journal').on(t.companyId, t.journalId),
    index('invoice_credit_original').on(t.companyId, t.originalInvoiceId),
    foreignKey({
      columns: [t.companyId, t.creditInvoiceId],
      foreignColumns: [invoiceDocuments.companyId, invoiceDocuments.id],
    }),
    foreignKey({
      columns: [t.companyId, t.originalInvoiceId],
      foreignColumns: [invoicePostings.companyId, invoicePostings.invoiceId],
    }),
    foreignKey({
      columns: [t.companyId, t.journalId],
      foreignColumns: [journals.companyId, journals.id],
    }),
    check(
      'invoice_credit_totals',
      sql`${t.netBani}>0 and ${t.taxBani}>=0 and ${t.grossBani}=${t.netBani}+${t.taxBani} and ${t.deductibleTaxBani} between 0 and ${t.taxBani}`,
    ),
  ],
);
export const accrualPostings = sqliteTable(
  'acc_accrual_postings',
  {
    companyId: companyId(),
    accrualId: text('accrual_id').notNull(),
    journalId: text('journal_id').notNull(),
    reference: text('reference').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.accrualId] }),
    uniqueIndex('accrual_posting_journal').on(t.companyId, t.journalId),
    uniqueIndex('accrual_reference').on(t.companyId, t.reference),
    foreignKey({
      columns: [t.companyId, t.accrualId],
      foreignColumns: [proposals.companyId, proposals.id],
    }),
    foreignKey({
      columns: [t.companyId, t.journalId],
      foreignColumns: [journals.companyId, journals.id],
    }),
  ],
);
export const accrualMatches = sqliteTable(
  'acc_accrual_matches',
  {
    companyId: companyId(),
    invoiceId: text('invoice_id').notNull(),
    accrualId: text('accrual_id').notNull(),
    netBani: bani('net_bani').notNull(),
    taxBani: bani('tax_bani').notNull(),
    grossBani: bani('gross_bani').notNull(),
    deductibleTaxBani: bani('deductible_tax_bani').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.invoiceId, t.accrualId] }),
    index('accrual_match_position').on(t.companyId, t.accrualId),
    foreignKey({
      columns: [t.companyId, t.invoiceId],
      foreignColumns: [invoicePostings.companyId, invoicePostings.invoiceId],
    }),
    foreignKey({
      columns: [t.companyId, t.accrualId],
      foreignColumns: [accrualPostings.companyId, accrualPostings.accrualId],
    }),
    check(
      'accrual_match_amounts',
      sql`typeof(${t.netBani})='integer' and typeof(${t.taxBani})='integer' and typeof(${t.grossBani})='integer' and typeof(${t.deductibleTaxBani})='integer' and ${t.netBani}>0 and ${t.taxBani}>=0 and ${t.grossBani}=${t.netBani}+${t.taxBani} and ${t.deductibleTaxBani} between 0 and ${t.taxBani}`,
    ),
  ],
);
export const commands = sqliteTable(
  'acc_commands',
  {
    companyId: companyId(),
    actorId: text('actor_id')
      .notNull()
      .references(() => user.id),
    key: text('key').notNull(),
    operation: text('operation').notNull(),
    hash: text('hash').notNull(),
    result: text('result', { mode: 'json' }).$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.actorId, t.key] })],
);
export const audit = sqliteTable(
  'acc_audit',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    companyId: companyId(),
    actorId: text('actor_id')
      .notNull()
      .references(() => user.id),
    action: text('action').notNull(),
    body: text('body', { mode: 'json' }).$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_company').on(t.companyId, t.id)],
);
export const agentGrants = sqliteTable(
  'acc_agent_grants',
  {
    id: text('id').primaryKey(),
    companyId: companyId(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull(),
    expiresAt: counter('expires_at').notNull(),
    revokedAt: counter('revoked_at'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [index('agent_company').on(t.companyId, t.id)],
);
export const actionReviews = sqliteTable(
  'acc_action_reviews',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    operation: text('operation', { enum: ['bank.match', 'periods.close'] }).notNull(),
    input: text('input', { mode: 'json' }).$type<unknown>().notNull(),
    effect: text('effect', { mode: 'json' }).$type<unknown>().notNull(),
    hash: text('hash').notNull(),
    approvedBy: text('approved_by').references(() => user.id),
    approvedAt: text('approved_at'),
    result: text('result', { mode: 'json' }).$type<unknown>(),
    executedAt: text('executed_at'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.id] })],
);
export type ExportSource = Pick<typeof evidence.$inferSelect, 'id' | 'hash' | 'filename' | 'size'>;
export type ExportSnapshot = {
  format: 'xfactura-a1';
  version: 1;
  requestedAt: string;
  data: Record<string, unknown>;
  evidence: ExportSource[];
};
export const jobs = sqliteTable(
  'acc_jobs',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    actorId: text('actor_id')
      .notNull()
      .references(() => user.id),
    agentId: text('agent_id').references(() => agentGrants.id),
    kind: text('kind', { enum: ['export'] }).notNull(),
    payload: text('payload', { mode: 'json' }).$type<ExportSnapshot>().notNull(),
    status: text('status', { enum: ['pending', 'running', 'done', 'failed'] })
      .notNull()
      .default('pending'),
    leaseToken: text('lease_token'),
    leaseUntil: counter('lease_until'),
    attempts: counter('attempts').notNull().default(0),
    result: text('result', { mode: 'json' }).$type<{ hash: string; size: number }>(),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    index('pending_exports').on(t.status, t.leaseUntil),
  ],
);
