import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

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
/** Canonical JSON text written by the kernel (bigint values as decimal strings). */
const canonicalJson = (name: string) => text(name).notNull();
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
  (t) => [index('session_user').on(t.userId)],
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
  (t) => [index('account_user').on(t.userId)],
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

// Access

export const companies = sqliteTable(
  'acc_companies',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    cui: text('cui').notNull(),
    country: text('country').notNull().default('RO'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [check('company_cui', sql`${t.cui} glob '[0-9]*' and length(${t.cui}) between 2 and 10`)],
);
export const roles = ['owner', 'reviewer', 'viewer'] as const;
export type Role = (typeof roles)[number];
export const memberships = sqliteTable(
  'acc_memberships',
  {
    companyId: companyId(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    role: text('role', { enum: roles }).notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    /** Incremented on every role or status change; credentials bound to an older epoch die. */
    epoch: counter('epoch').notNull().default(1),
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
export const agentGrants = sqliteTable(
  'acc_agent_grants',
  {
    id: text('id').primaryKey(),
    companyId: companyId(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull(),
    membershipEpoch: counter('membership_epoch').notNull(),
    expiresAt: counter('expires_at').notNull(),
    revokedAt: counter('revoked_at'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    index('agent_grant_company').on(t.companyId, t.id),
    foreignKey({
      columns: [t.companyId, t.createdBy],
      foreignColumns: [memberships.companyId, memberships.userId],
    }),
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
/** Hash-chained per company: each row records the previous row's hash. */
export const audit = sqliteTable(
  'acc_audit',
  {
    companyId: companyId(),
    seq: counter('seq').notNull(),
    actorId: text('actor_id')
      .notNull()
      .references(() => user.id),
    agentId: text('agent_id'),
    action: text('action').notNull(),
    body: canonicalJson('body_json'),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.seq] })],
);

// Company configuration

export const fiscalYears = sqliteTable(
  'acc_fiscal_years',
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
    uniqueIndex('fiscal_year_start').on(t.companyId, t.kind, t.from),
    check('fiscal_year_dates', sql`${t.from} <= ${t.to}`),
  ],
);
export const accountNatures = ['debit', 'credit', 'both'] as const;
export const ledgerAccounts = sqliteTable(
  'acc_accounts',
  {
    companyId: companyId(),
    code: text('code').notNull(),
    parentCode: text('parent_code'),
    name: text('name').notNull(),
    nature: text('nature', { enum: accountNatures }).notNull(),
    book: text('book', { enum: ['general', 'off_balance', 'management'] }).notNull(),
    postable: integer('postable', { mode: 'boolean' }).notNull(),
    /** An open-item kind, `tax`, or null for an uncontrolled account. */
    controlKind: text('control_kind'),
    saftAccount: text('saft_account'),
    validFrom: text('valid_from').notNull(),
    validTo: text('valid_to'),
    chartVersion: text('chart_version').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.code] }),
    check('account_validity', sql`${t.validTo} is null or ${t.validFrom} <= ${t.validTo}`),
  ],
);
/** Dated company facts (VAT status, VAT period, income tax regime, …); append-only. */
export const profileFacts = sqliteTable(
  'acc_profile_facts',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    axis: text('axis').notNull(),
    value: text('value').notNull(),
    effectiveFrom: text('effective_from').notNull(),
    evidenceId: text('evidence_id').notNull(),
    supersedesId: text('supersedes_id'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    index('profile_axis').on(t.companyId, t.axis, t.effectiveFrom),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);
export const parties = sqliteTable(
  'acc_parties',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    kind: text('kind').notNull(),
    country: text('country').notNull(),
    /** Normalized identifier (CUI without the RO prefix, foreign VAT number, CNP hash). */
    taxId: text('tax_id'),
    name: text('name').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('party_identity').on(t.companyId, t.country, t.taxId),
  ],
);

// Evidence and documents

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
    check('evidence_size', sql`${t.size} between 1 and 67108864`),
    check('evidence_hash', sql`length(${t.hash})=64`),
  ],
);
export const documents = sqliteTable(
  'acc_documents',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    kind: text('kind').notNull(),
    schema: text('schema').notNull(),
    body: canonicalJson('body_json'),
    bodyHash: text('body_hash').notNull(),
    /** Deduplication identity: `spv:<id>`, `sha:<hash>`, `series:<id>:<n>`, … */
    sourceKey: text('source_key').notNull(),
    evidenceId: text('evidence_id'),
    origin: text('origin').notNull(),
    docDate: text('doc_date').notNull(),
    partyId: text('party_id'),
    currency: text('currency'),
    number: text('number'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('document_source').on(t.companyId, t.sourceKey),
    index('document_date').on(t.companyId, t.docDate),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
    foreignKey({
      columns: [t.companyId, t.partyId],
      foreignColumns: [parties.companyId, parties.id],
    }),
  ],
);
export const documentLinks = sqliteTable(
  'acc_document_links',
  {
    companyId: companyId(),
    fromId: text('from_id').notNull(),
    toId: text('to_id').notNull(),
    kind: text('kind').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.fromId, t.toId, t.kind] }),
    foreignKey({
      columns: [t.companyId, t.fromId],
      foreignColumns: [documents.companyId, documents.id],
    }),
    foreignKey({
      columns: [t.companyId, t.toId],
      foreignColumns: [documents.companyId, documents.id],
    }),
  ],
);

// Proposals, approvals and posting policies

export const proposals = sqliteTable(
  'acc_proposals',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    treatmentId: text('treatment_id').notNull(),
    /** What the proposal recognizes: a document, a movement, a schedule month, … At most one
     * proposal per subject is open (not withdrawn), and a subject is posted at most once. */
    subjectKey: text('subject_key').notNull(),
    documentId: text('document_id'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    index('proposal_subject').on(t.companyId, t.subjectKey),
    foreignKey({
      columns: [t.companyId, t.documentId],
      foreignColumns: [documents.companyId, documents.id],
    }),
  ],
);
export const proposalVersions = sqliteTable(
  'acc_proposal_versions',
  {
    companyId: companyId(),
    proposalId: text('proposal_id').notNull(),
    version: counter('version').notNull(),
    treatmentVersion: counter('treatment_version').notNull(),
    input: canonicalJson('input_json'),
    /** `[{kind, id, version}]` read by the treatment, rechecked at posting. */
    readSet: canonicalJson('read_set_json'),
    /** Parameter versions and register hash the treatment resolved. */
    rules: canonicalJson('rules_json'),
    rulesHash: text('rules_hash').notNull(),
    /** The resolved effect; null when evaluation produced only blocking issues. */
    effect: text('effect_json'),
    issues: canonicalJson('issues_json'),
    blocking: integer('blocking', { mode: 'boolean' }).notNull(),
    effectHash: text('effect_hash').notNull(),
    entryDate: text('entry_date'),
    createdBy: author(),
    agentId: text('agent_id'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.proposalId, t.version] }),
    foreignKey({
      columns: [t.companyId, t.proposalId],
      foreignColumns: [proposals.companyId, proposals.id],
    }),
    check('proposal_effect', sql`${t.blocking} = 1 or ${t.effect} is not null`),
  ],
);
export const approvals = sqliteTable(
  'acc_approvals',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    proposalId: text('proposal_id').notNull(),
    version: counter('version').notNull(),
    effectHash: text('effect_hash').notNull(),
    approverId: text('approver_id')
      .notNull()
      .references(() => user.id),
    approverEpoch: counter('approver_epoch').notNull(),
    acknowledgements: canonicalJson('acknowledgements_json'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('approval_version').on(t.companyId, t.proposalId, t.version),
    foreignKey({
      columns: [t.companyId, t.proposalId, t.version],
      foreignColumns: [
        proposalVersions.companyId,
        proposalVersions.proposalId,
        proposalVersions.version,
      ],
    }),
  ],
);
export const withdrawals = sqliteTable(
  'acc_withdrawals',
  {
    companyId: companyId(),
    proposalId: text('proposal_id').notNull(),
    reason: text('reason').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.proposalId] }),
    foreignKey({
      columns: [t.companyId, t.proposalId],
      foreignColumns: [proposals.companyId, proposals.id],
    }),
  ],
);
export const postingPolicies = sqliteTable(
  'acc_posting_policies',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    name: text('name').notNull(),
    treatments: canonicalJson('treatments_json'),
    rulesHashes: canonicalJson('rules_hashes_json'),
    preconditions: canonicalJson('preconditions_json'),
    approvedBy: text('approved_by')
      .notNull()
      .references(() => user.id),
    approverEpoch: counter('approver_epoch').notNull(),
    validFrom: text('valid_from').notNull(),
    expiresAt: counter('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.id] })],
);
export const policyRevocations = sqliteTable(
  'acc_policy_revocations',
  {
    companyId: companyId(),
    policyId: text('policy_id').notNull(),
    reason: text('reason').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.policyId] }),
    foreignKey({
      columns: [t.companyId, t.policyId],
      foreignColumns: [postingPolicies.companyId, postingPolicies.id],
    }),
  ],
);

// Ledger. Rows are inserted before their entry header, under deferred foreign keys; the header's
// invariant verifies them against the approved effect and seals the entry.

export const entries = sqliteTable(
  'acc_entries',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    fiscalYearId: text('fiscal_year_id').notNull(),
    journalClass: text('journal_class', { enum: ['general', 'memo'] }).notNull(),
    journalCode: text('journal_code').notNull(),
    /** Gap-free within (company, fiscal year, journal class): the Registrul-jurnal number. */
    number: counter('number').notNull(),
    /** Gap-free within the company: "as recorded at seq N" and projection watermarks. */
    seq: counter('seq').notNull(),
    date: text('date').notNull(),
    period: text('period').notNull(),
    description: text('description').notNull(),
    proposalId: text('proposal_id').notNull(),
    version: counter('version').notNull(),
    approvalId: text('approval_id'),
    policyId: text('policy_id'),
    postedBy: text('posted_by')
      .notNull()
      .references(() => user.id),
    agentId: text('agent_id'),
    postedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('entry_proposal').on(t.companyId, t.proposalId),
    uniqueIndex('entry_number').on(t.companyId, t.fiscalYearId, t.journalClass, t.number),
    uniqueIndex('entry_seq').on(t.companyId, t.seq),
    index('entry_period').on(t.companyId, t.period),
    foreignKey({
      columns: [t.companyId, t.fiscalYearId],
      foreignColumns: [fiscalYears.companyId, fiscalYears.id],
    }),
    foreignKey({
      columns: [t.companyId, t.proposalId, t.version],
      foreignColumns: [
        proposalVersions.companyId,
        proposalVersions.proposalId,
        proposalVersions.version,
      ],
    }),
    foreignKey({
      columns: [t.companyId, t.approvalId],
      foreignColumns: [approvals.companyId, approvals.id],
    }),
    foreignKey({
      columns: [t.companyId, t.policyId],
      foreignColumns: [postingPolicies.companyId, postingPolicies.id],
    }),
    check('entry_binding', sql`(${t.approvalId} is null) <> (${t.policyId} is null)`),
    check('entry_period_value', sql`${t.period} = substr(${t.date}, 1, 7)`),
  ],
);
export const openItems = sqliteTable(
  'acc_open_items',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    kind: text('kind').notNull(),
    controlAccount: text('control_account').notNull(),
    partyId: text('party_id').notNull(),
    currency: text('currency').notNull(),
    normalSide: text('normal_side', { enum: ['D', 'C'] }).notNull(),
    mayReverse: integer('may_reverse', { mode: 'boolean' }).notNull(),
    dueDate: text('due_date'),
    documentId: text('document_id'),
    originEntryId: text('origin_entry_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    index('open_item_origin').on(t.companyId, t.originEntryId),
    index('open_item_party').on(t.companyId, t.partyId, t.kind),
    index('open_item_document').on(t.companyId, t.documentId),
    foreignKey({
      columns: [t.companyId, t.originEntryId],
      foreignColumns: [entries.companyId, entries.id],
    }),
    foreignKey({
      columns: [t.companyId, t.partyId],
      foreignColumns: [parties.companyId, parties.id],
    }),
  ],
);
export const lines = sqliteTable(
  'acc_lines',
  {
    companyId: companyId(),
    entryId: text('entry_id').notNull(),
    lineNo: counter('line_no').notNull(),
    account: text('account').notNull(),
    side: text('side', { enum: ['D', 'C'] }).notNull(),
    bani: bani('bani').notNull(),
    currency: text('currency'),
    currencyMinor: bani('currency_minor'),
    fxRateId: text('fx_rate_id'),
    fxRate: text('fx_rate'),
    partyId: text('party_id'),
    openItemId: text('open_item_id'),
    taxSettlementTax: text('tax_settlement_tax'),
    taxSettlementPeriod: text('tax_settlement_period'),
    costCenter: text('cost_center'),
    project: text('project'),
    item: text('item'),
    memo: text('memo'),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.entryId, t.lineNo] }),
    index('line_account').on(t.companyId, t.account, t.entryId),
    index('line_open_item').on(t.companyId, t.openItemId),
    index('line_party').on(t.companyId, t.partyId),
    foreignKey({
      columns: [t.companyId, t.entryId],
      foreignColumns: [entries.companyId, entries.id],
    }),
    foreignKey({
      columns: [t.companyId, t.account],
      foreignColumns: [ledgerAccounts.companyId, ledgerAccounts.code],
    }),
    foreignKey({
      columns: [t.companyId, t.openItemId],
      foreignColumns: [openItems.companyId, openItems.id],
    }),
    check('line_amount', sql`${t.bani} <> 0`),
    check('line_currency', sql`(${t.currency} is null) = (${t.currencyMinor} is null)`),
  ],
);
export const scheduleRows = sqliteTable(
  'acc_schedule_rows',
  {
    companyId: companyId(),
    scheduleId: text('schedule_id').notNull(),
    version: counter('version').notNull(),
    rowKey: text('row_key').notNull(),
    entryId: text('entry_id').notNull(),
    openItemId: text('open_item_id').notNull(),
    method: text('method').notNull(),
    dueDate: text('due_date').notNull(),
    bani: bani('bani').notNull(),
    counterAccount: text('counter_account').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.scheduleId, t.version, t.rowKey] }),
    index('schedule_entry').on(t.companyId, t.entryId),
    foreignKey({
      columns: [t.companyId, t.entryId],
      foreignColumns: [entries.companyId, entries.id],
    }),
    foreignKey({
      columns: [t.companyId, t.openItemId],
      foreignColumns: [openItems.companyId, openItems.id],
    }),
    check('schedule_amount', sql`${t.bani} > 0`),
  ],
);
export const taxEntries = sqliteTable(
  'acc_tax_entries',
  {
    companyId: companyId(),
    entryId: text('entry_id').notNull(),
    taxNo: counter('tax_no').notNull(),
    key: text('key').notNull(),
    lineNo: counter('line_no'),
    tax: text('tax').notNull(),
    code: text('code').notNull(),
    direction: text('direction', { enum: ['output', 'input'] }).notNull(),
    baseBani: bani('base_bani').notNull(),
    taxBani: bani('tax_bani').notNull(),
    deductibleBani: bani('deductible_bani').notNull(),
    ledgerBani: bani('ledger_bani').notNull(),
    taxPoint: text('tax_point').notNull(),
    exigibility: text('exigibility'),
    taxPeriod: text('tax_period'),
    partyId: text('party_id'),
    documentId: text('document_id'),
    originTaxEntry: text('origin_tax_entry'),
    currency: text('currency'),
    baseMinor: bani('base_minor'),
    taxMinor: bani('tax_minor'),
    fxRateId: text('fx_rate_id'),
    fxRate: text('fx_rate'),
    attributes: canonicalJson('attributes_json'),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.entryId, t.taxNo] }),
    uniqueIndex('tax_entry_key').on(t.companyId, t.entryId, t.key),
    index('tax_entry_period').on(t.companyId, t.tax, t.taxPeriod),
    foreignKey({
      columns: [t.companyId, t.entryId],
      foreignColumns: [entries.companyId, entries.id],
    }),
    check('tax_entry_ledger', sql`${t.lineNo} is not null or ${t.ledgerBani} = 0`),
  ],
);

// Treasury

/** A bank or cash account and the ledger account its balance is kept on. */
export const treasuryAccounts = sqliteTable(
  'acc_treasury_accounts',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    kind: text('kind', { enum: ['bank', 'cash'] }).notNull(),
    name: text('name').notNull(),
    iban: text('iban'),
    currency: text('currency').notNull(),
    ledgerAccount: text('ledger_account').notNull(),
    openedOn: text('opened_on').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('treasury_iban').on(t.companyId, t.iban),
    uniqueIndex('treasury_ledger_account').on(t.companyId, t.ledgerAccount),
    foreignKey({
      columns: [t.companyId, t.ledgerAccount],
      foreignColumns: [ledgerAccounts.companyId, ledgerAccounts.code],
    }),
  ],
);
export const bankStatements = sqliteTable(
  'acc_bank_statements',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    treasuryAccountId: text('treasury_account_id').notNull(),
    evidenceId: text('evidence_id').notNull(),
    format: text('format').notNull(),
    sourceId: text('source_id').notNull(),
    from: text('date_from').notNull(),
    to: text('date_to').notNull(),
    openingMinor: bani('opening_minor').notNull(),
    closingMinor: bani('closing_minor').notNull(),
    financialHash: text('financial_hash').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('bank_statement_identity').on(t.companyId, t.treasuryAccountId, t.financialHash),
    index('bank_statement_period').on(t.companyId, t.treasuryAccountId, t.to),
    foreignKey({
      columns: [t.companyId, t.treasuryAccountId],
      foreignColumns: [treasuryAccounts.companyId, treasuryAccounts.id],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);
/** One reported bank movement, kept once however many statements report it. */
export const bankMovements = sqliteTable(
  'acc_bank_movements',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    treasuryAccountId: text('treasury_account_id').notNull(),
    statementId: text('statement_id').notNull(),
    sourceId: text('source_id').notNull(),
    bookingDate: text('booking_date').notNull(),
    valueDate: text('value_date'),
    amountMinor: bani('amount_minor').notNull(),
    currency: text('currency').notNull(),
    reference: text('reference').notNull(),
    counterparty: text('counterparty'),
    counterpartyAccount: text('counterparty_account'),
    details: canonicalJson('details_json'),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('bank_movement_identity').on(t.companyId, t.treasuryAccountId, t.sourceId),
    index('bank_movement_date').on(t.companyId, t.treasuryAccountId, t.bookingDate),
    foreignKey({
      columns: [t.companyId, t.treasuryAccountId],
      foreignColumns: [treasuryAccounts.companyId, treasuryAccounts.id],
    }),
    foreignKey({
      columns: [t.companyId, t.statementId],
      foreignColumns: [bankStatements.companyId, bankStatements.id],
    }),
    check('bank_movement_amount', sql`${t.amountMinor} <> 0`),
  ],
);

// Periods

export const periodEvents = sqliteTable(
  'acc_period_events',
  {
    companyId: companyId(),
    month: text('month').notNull(),
    seq: counter('seq').notNull(),
    kind: text('kind', { enum: ['close', 'reopen'] }).notNull(),
    actionId: text('action_id').notNull(),
    watermarkSeq: counter('watermark_seq').notNull(),
    snapshotHash: text('snapshot_hash').notNull(),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.month, t.seq] }),
    foreignKey({
      columns: [t.companyId, t.actionId],
      foreignColumns: [actionRequests.companyId, actionRequests.id],
    }),
  ],
);
/** Closing balances per account and currency, written once per close event. */
export const periodBalances = sqliteTable(
  'acc_period_balances',
  {
    companyId: companyId(),
    month: text('month').notNull(),
    closeSeq: counter('close_seq').notNull(),
    account: text('account').notNull(),
    currency: text('currency').notNull(),
    debitTurnover: bani('debit_turnover').notNull(),
    creditTurnover: bani('credit_turnover').notNull(),
    closingBani: bani('closing_bani').notNull(),
    closingMinor: bani('closing_minor').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.month, t.closeSeq, t.account, t.currency] }),
    foreignKey({
      columns: [t.companyId, t.month, t.closeSeq],
      foreignColumns: [periodEvents.companyId, periodEvents.month, periodEvents.seq],
    }),
  ],
);
export const taxPeriodEvents = sqliteTable(
  'acc_tax_period_events',
  {
    companyId: companyId(),
    tax: text('tax').notNull(),
    period: text('period').notNull(),
    seq: counter('seq').notNull(),
    kind: text('kind', { enum: ['lock', 'unlock'] }).notNull(),
    reference: text('reference').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.tax, t.period, t.seq] })],
);

// Reviewed actions without journal lines (period close and reopen, configuration changes)

export const actionRequests = sqliteTable(
  'acc_action_requests',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    operation: text('operation').notNull(),
    input: canonicalJson('input_json'),
    preview: canonicalJson('preview_json'),
    previewHash: text('preview_hash').notNull(),
    createdBy: author(),
    agentId: text('agent_id'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.id] })],
);
export const actionDecisions = sqliteTable(
  'acc_action_decisions',
  {
    companyId: companyId(),
    requestId: text('request_id').notNull(),
    decision: text('decision', { enum: ['approve', 'reject'] }).notNull(),
    previewHash: text('preview_hash').notNull(),
    decidedBy: text('decided_by')
      .notNull()
      .references(() => user.id),
    decidedEpoch: counter('decided_epoch').notNull(),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.requestId] }),
    foreignKey({
      columns: [t.companyId, t.requestId],
      foreignColumns: [actionRequests.companyId, actionRequests.id],
    }),
  ],
);
export const actionExecutions = sqliteTable(
  'acc_action_executions',
  {
    companyId: companyId(),
    requestId: text('request_id').notNull(),
    result: canonicalJson('result_json'),
    executedBy: text('executed_by')
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.requestId] }),
    foreignKey({
      columns: [t.companyId, t.requestId],
      foreignColumns: [actionDecisions.companyId, actionDecisions.requestId],
    }),
  ],
);

// Reference data

export const fxRates = sqliteTable(
  'ref_fx_rates',
  {
    source: text('source').notNull(),
    currency: text('currency').notNull(),
    rateDate: text('rate_date').notNull(),
    revision: counter('revision').notNull(),
    rate: text('rate').notNull(),
    multiplier: counter('multiplier').notNull(),
    publishedAt: text('published_at').notNull(),
    evidenceHash: text('evidence_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.source, t.currency, t.rateDate, t.revision] })],
);

// Work queues (the only mutable kernel tables)

export const jobs = sqliteTable(
  'acc_jobs',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    actorId: text('actor_id')
      .notNull()
      .references(() => user.id),
    agentId: text('agent_id'),
    kind: text('kind').notNull(),
    params: text('params', { mode: 'json' }).$type<unknown>().notNull(),
    status: text('status', { enum: ['pending', 'running', 'done', 'failed'] })
      .notNull()
      .default('pending'),
    leaseToken: text('lease_token'),
    leaseUntil: counter('lease_until'),
    attempts: counter('attempts').notNull().default(0),
    result: text('result', { mode: 'json' }).$type<unknown>(),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    index('job_pending').on(t.status, t.leaseUntil),
  ],
);
export const outbox = sqliteTable(
  'acc_outbox',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    kind: text('kind').notNull(),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    status: text('status', { enum: ['pending', 'running', 'done', 'failed', 'uncertain'] })
      .notNull()
      .default('pending'),
    attemptId: text('attempt_id'),
    leaseUntil: counter('lease_until'),
    attempts: counter('attempts').notNull().default(0),
    result: text('result', { mode: 'json' }).$type<unknown>(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    index('outbox_pending').on(t.status, t.leaseUntil),
  ],
);

/** Checksums of the installed database invariants (see invariants.ts). */
export const invariantChecksums = sqliteTable('acc_invariants', {
  name: text('name').primaryKey(),
  checksum: text('checksum').notNull(),
});
