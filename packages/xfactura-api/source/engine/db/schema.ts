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
/**
 * The engine clock's time when the row was written, in milliseconds since the epoch: what
 * decides on time reads it, since `created_at` stays the database's wall time, an audit
 * timestamp. Tests and the evaluation harness run the engine at another time than the wall's.
 * Null on rows written before it was kept.
 */
const engineAt = () => counter('engine_at');
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
    /** The operation ids the grant allows, with every named toolset expanded when issued. */
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull(),
    /** The toolsets the issuer named; their operations are already in `scopes`. */
    toolsets: text('toolsets', { mode: 'json' }).$type<string[]>().notNull().default([]),
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
    index('profile_evidence').on(t.companyId, t.evidenceId),
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
    /** When the engine received the file (`evidence.unused` is of its month). */
    engineAt: engineAt(),
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
    /** What every copy of the same document shares, whatever its source (`documentIdentity`):
     * a later copy joins the earliest one's group (`same_as`). Null without one. */
    identityKey: text('identity_key'),
    /** Where the content comes from: `efactura`, `issued`, `ubl_upload`, `invoicer`, `amef` (a
     * fiscal cash register's export) or `extracted` (read by an agent from a PDF or a photo). */
    authority: text('authority', {
      enum: ['efactura', 'issued', 'ubl_upload', 'invoicer', 'amef', 'extracted'],
    }),
    /** An extracted document's checks (`checkDocument`), as recorded. */
    checks: text('checks_json'),
    /** An extracted document's field citations with their outcomes, as recorded. */
    citations: text('citations_json'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('document_source').on(t.companyId, t.sourceKey),
    index('document_date').on(t.companyId, t.docDate),
    index('document_number').on(t.companyId, t.number),
    index('document_identity').on(t.companyId, t.identityKey),
    index('document_evidence').on(t.companyId, t.evidenceId),
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
    index('document_link_target').on(t.companyId, t.toId),
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

// Sales: party details, series and issued numbers

/** Dated snapshots of a party's invoicing details (the core e-Factura `Party`); the latest
 * version applies to new documents, and each issued invoice keeps the one it used. */
export const partyVersions = sqliteTable(
  'acc_party_versions',
  {
    companyId: companyId(),
    partyId: text('party_id').notNull(),
    version: counter('version').notNull(),
    details: canonicalJson('details_json'),
    detailsHash: text('details_hash').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.partyId, t.version] }),
    foreignKey({
      columns: [t.companyId, t.partyId],
      foreignColumns: [parties.companyId, parties.id],
    }),
  ],
);
/** An invoice series: numbers are the prefix and the counter padded to `width` digits. */
export const series = sqliteTable(
  'acc_series',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    code: text('code').notNull(),
    prefix: text('prefix').notNull(),
    width: counter('width').notNull(),
    firstNumber: counter('first_number').notNull(),
    /** e-Factura type codes this series issues (380, 381). */
    typeCodes: canonicalJson('type_codes_json'),
    /** The revenue account issued invoices are recognized on, unless the issue names another. */
    revenueAccount: text('revenue_account').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('series_code').on(t.companyId, t.code),
    check('series_width', sql`${t.width} between 1 and 12`),
    check('series_first', sql`${t.firstNumber} >= 1`),
  ],
);
/** Every number a series has issued, without gaps, with the document it numbers. */
export const issuedNumbers = sqliteTable(
  'acc_issued_numbers',
  {
    companyId: companyId(),
    seriesId: text('series_id').notNull(),
    number: counter('number').notNull(),
    typeCode: text('type_code').notNull(),
    issueDate: text('issue_date').notNull(),
    documentId: text('document_id').notNull(),
    sellerVersion: counter('seller_version').notNull(),
    buyerVersion: counter('buyer_version').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.seriesId, t.number] }),
    uniqueIndex('issued_document').on(t.companyId, t.documentId),
    foreignKey({
      columns: [t.companyId, t.seriesId],
      foreignColumns: [series.companyId, series.id],
    }),
    foreignKey({
      columns: [t.companyId, t.documentId],
      foreignColumns: [documents.companyId, documents.id],
    }),
  ],
);

// Declarations: tax returns prepared from the books, validated, authorized and filed

/** A tax return prepared from the books: its kind, period, format version, the XML kept as
 * evidence and the hash of what it was computed from. Rectifications supersede earlier ones. */
export const artifacts = sqliteTable(
  'acc_artifacts',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    /** The declaration, e.g. D300. */
    kind: text('kind').notNull(),
    /** The tax period or year it reports, e.g. 2026-10, 2026-Q4, 2026. */
    period: text('period').notNull(),
    /** The tax ledger its authorization locks for the period (VAT for D300); none for
     * informative returns. */
    tax: text('tax'),
    /** ANAF's format the XML follows, chosen by the reporting period. */
    format: text('format').notNull(),
    /** Hash of the inputs read (tax periods, profile): a later change makes the return stale. */
    inputHash: text('input_hash').notNull(),
    evidenceId: text('evidence_id').notNull(),
    xmlHash: text('xml_hash').notNull(),
    supersedesId: text('supersedes_id'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    index('artifact_period').on(t.companyId, t.kind, t.period),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);
export const artifactStates = [
  'prepared',
  'validation_failed',
  'validated_official',
  'authorized',
  'exported_for_signing',
  'signed_imported',
  'submitted',
  'accepted',
  'rejected',
  'superseded',
] as const;
/** Each step of a return, in order, with the validator's or ANAF's answer. */
export const artifactEvents = sqliteTable(
  'acc_artifact_events',
  {
    companyId: companyId(),
    artifactId: text('artifact_id').notNull(),
    seq: counter('seq').notNull(),
    state: text('state', { enum: artifactStates }).notNull(),
    /** The validator and version that ran, or the receipt's reference. */
    actor: text('actor'),
    detail: text('detail'),
    evidenceId: text('evidence_id'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.artifactId, t.seq] }),
    foreignKey({
      columns: [t.companyId, t.artifactId],
      foreignColumns: [artifacts.companyId, artifacts.id],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);

// SPV: submissions to e-Factura, messages read from it and the windows synced

/** An authorized upload of one issued document's XML (the evidence with hash `xmlHash`). */
export const submissions = sqliteTable(
  'acc_submissions',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    documentId: text('document_id').notNull(),
    evidenceId: text('evidence_id').notNull(),
    xmlHash: text('xml_hash').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    index('submission_document').on(t.companyId, t.documentId),
    index('submission_xml').on(t.companyId, t.xmlHash),
    foreignKey({
      columns: [t.companyId, t.documentId],
      foreignColumns: [documents.companyId, documents.id],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);
export const submissionStates = [
  'authorized',
  'submitting',
  'submitted',
  'uncertain',
  'accepted',
  'rejected',
  'absent',
] as const;
/** Each step of a submission, in order; `submitting` is written before any request leaves. */
export const submissionEvents = sqliteTable(
  'acc_submission_events',
  {
    companyId: companyId(),
    submissionId: text('submission_id').notNull(),
    seq: counter('seq').notNull(),
    state: text('state', { enum: submissionStates }).notNull(),
    uploadId: text('upload_id'),
    downloadId: text('download_id'),
    detail: text('detail'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.submissionId, t.seq] }),
    index('submission_upload').on(t.companyId, t.uploadId),
    foreignKey({
      columns: [t.companyId, t.submissionId],
      foreignColumns: [submissions.companyId, submissions.id],
    }),
  ],
);
/** A message from the SPV inbox, with what its archive became in the books. */
export const spvMessages = sqliteTable(
  'acc_spv_messages',
  {
    companyId: companyId(),
    /** ANAF's message (download) identifier. */
    id: text('id').notNull(),
    uploadId: text('upload_id').notNull(),
    kind: text('kind', { enum: ['sent', 'received', 'error', 'buyer_message'] }).notNull(),
    /** When ANAF created the message, in epoch milliseconds. */
    createdAtAnaf: counter('created_at_anaf').notNull(),
    details: text('details').notNull(),
    evidenceId: text('evidence_id'),
    documentId: text('document_id'),
    outcome: text('outcome', {
      enum: ['created', 'matched', 'differs', 'reconciled', 'recorded', 'error'],
    }).notNull(),
    detail: text('detail'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    index('spv_message_upload').on(t.companyId, t.uploadId),
    index('spv_message_outcome').on(t.companyId, t.outcome),
    index('spv_message_evidence').on(t.companyId, t.evidenceId),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
    foreignKey({
      columns: [t.companyId, t.documentId],
      foreignColumns: [documents.companyId, documents.id],
    }),
  ],
);
/** A time window whose SPV messages were listed completely; their union is the coverage. */
export const spvSyncWindows = sqliteTable(
  'acc_spv_sync_windows',
  {
    companyId: companyId(),
    seq: counter('seq').notNull(),
    from: counter('from_ms').notNull(),
    to: counter('to_ms').notNull(),
    messages: counter('messages').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.seq] }),
    check('spv_window', sql`${t.from} < ${t.to}`),
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
    /** What the version relies on beyond the books: the questions whose answers it cites
     * (`{ answers }`); null without one. Hashed into `effectHash` only when present. */
    basis: text('basis_json'),
    /** What the effect books without the ids it creates (`effectFingerprint`): templates'
     * predictions and agents' first versions are compared with the posted version by it. Null
     * without an effect. */
    fingerprint: text('fingerprint'),
    createdBy: author(),
    agentId: text('agent_id'),
    /** When the engine evaluated the version (`rule.expiring` counts the rules used in the
     * last twelve months). */
    engineAt: engineAt(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.proposalId, t.version] }),
    // The evidence a version names (every treatment that reads a file names it `evidenceId`),
    // for the worklist's evidence used nowhere; and versions by the engine's time of evaluation,
    // for the rules they used. (`->>`, not json_extract: drizzle-kit splits an index expression
    // at its commas.)
    index('proposal_version_evidence').on(t.companyId, sql`${t.input} ->> '$.evidenceId'`),
    index('proposal_version_engine').on(t.companyId, t.engineAt),
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
    /** The agent that gave it: always null, as only a person approves (`inv:approval_person`).
     * An approval a batch's execution records is its decider's, whoever executes. */
    agentId: text('agent_id'),
    acknowledgements: canonicalJson('acknowledgements_json'),
    /** The reviewed batch (`proposals.batch`) whose approved preview names this version; the
     * approver is its decider (`inv:batch_member`). Null for a single approval. */
    batchRequestId: text('batch_request_id'),
    /** When the approval was given: segregation of duties is read on its day
     * (`inv:segregation`). */
    engineAt: engineAt(),
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
    /** The agent that created it: always null, as only a person grants a policy
     * (`inv:policy_person`); one from a graduation is its decider's, whoever executes. */
    agentId: text('agent_id'),
    validFrom: text('valid_from').notNull(),
    expiresAt: counter('expires_at').notNull(),
    /** The reviewed request (`policies.request`, from a template's graduation report) whose
     * execution created it; null for a policy a person created directly. */
    requestId: text('request_id'),
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
    /** When the entry was posted: a policy must be unexpired then, and segregation is read on
     * its day (`inv:binding`, `inv:segregation`). */
    engineAt: engineAt(),
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
    // A tax period's settlement lines (the state loader's and `inv:stale_read`'s tax-period read
    // version), only those lines being indexed.
    index('line_tax_settlement')
      .on(t.companyId, t.taxSettlementTax, t.taxSettlementPeriod)
      .where(sql`tax_settlement_tax is not null`),
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
    /** A transcribed statement's citations (balances and rows) with their outcomes. */
    citations: text('citations_json'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('bank_statement_identity').on(t.companyId, t.treasuryAccountId, t.financialHash),
    index('bank_statement_period').on(t.companyId, t.treasuryAccountId, t.to),
    index('bank_statement_evidence').on(t.companyId, t.evidenceId),
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
/** How an account's CSV exports read (`csvMappingSchema`), one version per change: the latest is
 * used when an import names none. */
export const bankMappings = sqliteTable(
  'acc_bank_mappings',
  {
    companyId: companyId(),
    treasuryAccountId: text('treasury_account_id').notNull(),
    version: counter('version').notNull(),
    format: text('format', { enum: ['csv'] }).notNull(),
    mapping: canonicalJson('mapping_json'),
    mappingHash: text('mapping_hash').notNull(),
    /** The file it first read. */
    evidenceId: text('evidence_id').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.treasuryAccountId, t.version] }),
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
    /** The agent that decided: always null, as only a person decides (`inv:decision_person`). */
    agentId: text('agent_id'),
    reason: text('reason'),
    /** When the decision was taken: segregation of duties is read on its day. */
    engineAt: engineAt(),
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
  (t) => [
    primaryKey({ columns: [t.source, t.currency, t.rateDate, t.revision] }),
    index('fx_rate_evidence').on(t.evidenceHash),
  ],
);

// Work queues, cursors and caches (the only mutable kernel tables)

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
/** Recurring work: each slot queues one job, whose id derives from the schedule and the slot. */
export const schedules = sqliteTable(
  'acc_schedules',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    kind: text('kind').notNull(),
    /** When it recurs (`scheduleRule` in kernel/jobs.ts). */
    rule: text('rule', { mode: 'json' }).$type<unknown>().notNull(),
    params: text('params', { mode: 'json' }).$type<unknown>().notNull(),
    /** Whose authority each run uses; it is rechecked when the run executes. */
    actorId: text('actor_id')
      .notNull()
      .references(() => user.id),
    agentId: text('agent_id'),
    /** The next slot, in epoch milliseconds. */
    nextRunAt: counter('next_run_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.id] }), index('schedule_due').on(t.nextRunAt)],
);
/** How far each consumer of a company's audit log has read it. */
export const cursors = sqliteTable(
  'acc_cursors',
  {
    companyId: companyId(),
    consumer: text('consumer').notNull(),
    /** The last audit `seq` handled. */
    seq: counter('seq').notNull(),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.consumer] })],
);
/** The latest re-evaluation of a proposal against the books: a cache, never a record. Posting
 * re-evaluates regardless. */
export const proposalChecks = sqliteTable(
  'acc_proposal_checks',
  {
    companyId: companyId(),
    proposalId: text('proposal_id').notNull(),
    version: counter('version').notNull(),
    /** The audit `seq` of the books the check read. */
    checkedSeq: counter('checked_seq').notNull(),
    stale: integer('stale', { mode: 'boolean' }).notNull(),
    /** What differs from the version's own evaluation (`ProposalChange[]`). */
    changed: text('changed_json').notNull(),
    checkedAt: text('checked_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.proposalId] }),
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

// Fixed assets: the register; the ledger holds their value and depreciation.

export const assets = sqliteTable(
  'acc_assets',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    /** Inventory number. */
    number: text('number').notNull(),
    name: text('name').notNull(),
    /** Classification code of the fixed-asset catalogue (HG 2139/2004). */
    catalogCode: text('catalog_code').notNull(),
    account: text('account').notNull(),
    depreciationAccount: text('depreciation_account').notNull(),
    expenseAccount: text('expense_account').notNull(),
    valueBani: bani('value_bani').notNull(),
    /** Accounting useful life, by the company's policies. */
    lifeMonths: counter('life_months').notNull(),
    /** Useful life for tax purposes, within the catalogue's range. */
    fiscalLifeMonths: counter('fiscal_life_months').notNull(),
    commissionedOn: text('commissioned_on').notNull(),
    /** The purchase document, when the asset was bought. */
    documentId: text('document_id'),
    /** The commissioning record (proces-verbal de punere în funcțiune). */
    evidenceId: text('evidence_id').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('asset_number').on(t.companyId, t.number),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
    foreignKey({
      columns: [t.companyId, t.documentId],
      foreignColumns: [documents.companyId, documents.id],
    }),
  ],
);

export const assetEvents = sqliteTable(
  'acc_asset_events',
  {
    companyId: companyId(),
    assetId: text('asset_id').notNull(),
    seq: counter('seq').notNull(),
    kind: text('kind', { enum: ['disposed'] }).notNull(),
    date: text('date').notNull(),
    evidenceId: text('evidence_id').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.assetId, t.seq] }),
    foreignKey({
      columns: [t.companyId, t.assetId],
      foreignColumns: [assets.companyId, assets.id],
    }),
  ],
);

/**
 * A fixed asset's fiscal basis (Codul fiscal art. 28), apart from its book depreciation: the
 * method, the fiscal value, the normal life and whether it is a capped M1 car, with the document
 * that decided them. Versioned: a later version replaces the earlier from the next computation.
 */
export const assetFiscal = sqliteTable(
  'acc_asset_fiscal',
  {
    companyId: companyId(),
    assetId: text('asset_id').notNull(),
    version: counter('version').notNull(),
    method: text('method', {
      enum: [
        'linear',
        'degressive',
        'accelerated',
        'superaccelerated',
        'full_safety',
        'full_medical',
        'full_low_value',
        'none',
      ],
    }).notNull(),
    /** The fiscal value at entry. */
    valueBani: bani('value_bani').notNull(),
    /** The normal life chosen within the catalogue's range, in months. */
    lifeMonths: counter('life_months').notNull(),
    /** The share of the value taken in the first year (the accelerated methods), a percentage. */
    firstYearPercent: text('first_year_percent'),
    /** An M1 passenger car whose depreciation art. 28 alin. (14) caps monthly. */
    m1: integer('m1', { mode: 'boolean' }).notNull(),
    /** A new asset (the superaccelerated method). */
    newAsset: integer('new_asset', { mode: 'boolean' }).notNull(),
    evidenceId: text('evidence_id').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.assetId, t.version] }),
    foreignKey({
      columns: [t.companyId, t.assetId],
      foreignColumns: [assets.companyId, assets.id],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
    check('asset_fiscal_life', sql`${t.lifeMonths} between 1 and 1200`),
    check('asset_fiscal_value', sql`${t.valueBani} >= 0`),
    check(
      'asset_fiscal_first_year',
      sql`(${t.firstYearPercent} is null) or (${t.method} in ('accelerated', 'superaccelerated'))`,
    ),
  ],
);

// The stock register (G1): the item catalogue, the warehouses (gestiuni), and the layers and
// moves the ledger's entries post, as lines are (an entry writes its layers and moves before its
// header, which seals them).

export const stockItemVatCategories = ['standard', 'reduced', 'exempt', 'outside'] as const;
export const stockItems = sqliteTable(
  'acc_stock_items',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** UN/ECE Recommendation 20 code of the unit of measure (H87 a piece, KGM a kilogram). */
    unit: text('unit').notNull(),
    /** The NC8 code of the combined nomenclature (D406 Products, Intrastat), when known. */
    nc8: text('nc8'),
    /** The stock account its layers are on (371 goods, 301 raw materials, 381 packaging). */
    account: text('account').notNull(),
    /** How it is normally taxed when sold; the rate is the register's on the sale's date. */
    vatCategory: text('vat_category', { enum: stockItemVatCategories }),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('stock_item_code').on(t.companyId, t.code),
    foreignKey({
      columns: [t.companyId, t.account],
      foreignColumns: [ledgerAccounts.companyId, ledgerAccounts.code],
    }),
  ],
);

export const warehouses = sqliteTable(
  'acc_warehouses',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** The person responsible for it (gestionarul), as the documents name them. */
    keeper: text('keeper').notNull(),
    /** The keeper as an employee or other party, when recorded. */
    keeperPartyId: text('keeper_party_id'),
    /** The keeper's appointment (decizia de numire), when recorded. */
    evidenceId: text('evidence_id'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('warehouse_code').on(t.companyId, t.code),
    foreignKey({
      columns: [t.companyId, t.keeperPartyId],
      foreignColumns: [parties.companyId, parties.id],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);

export const stockLayerMethodValues = ['fifo', 'lifo', 'average', 'periodic'] as const;
export const stockLayers = sqliteTable(
  'acc_stock_layers',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    itemId: text('item_id').notNull(),
    warehouseId: text('warehouse_id').notNull(),
    account: text('account').notNull(),
    method: text('method', { enum: stockLayerMethodValues }).notNull(),
    date: text('date').notNull(),
    mayGoNegative: integer('may_go_negative', { mode: 'boolean' }).notNull(),
    originEntryId: text('origin_entry_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    index('stock_layer_origin').on(t.companyId, t.originEntryId),
    index('stock_layer_position').on(t.companyId, t.itemId, t.warehouseId),
    foreignKey({
      columns: [t.companyId, t.originEntryId],
      foreignColumns: [entries.companyId, entries.id],
    }),
    foreignKey({
      columns: [t.companyId, t.itemId],
      foreignColumns: [stockItems.companyId, stockItems.id],
    }),
    foreignKey({
      columns: [t.companyId, t.warehouseId],
      foreignColumns: [warehouses.companyId, warehouses.id],
    }),
  ],
);

export const stockMoves = sqliteTable(
  'acc_stock_moves',
  {
    companyId: companyId(),
    entryId: text('entry_id').notNull(),
    moveNo: counter('move_no').notNull(),
    itemId: text('item_id').notNull(),
    warehouseId: text('warehouse_id').notNull(),
    account: text('account').notNull(),
    layerId: text('layer_id').notNull(),
    /** Signed thousandths of the item's unit. */
    quantity: bani('quantity').notNull(),
    bani: bani('bani').notNull(),
    /** The entry's line (one-based) whose amount the move is part of; none between warehouses. */
    lineNo: counter('line_no'),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.entryId, t.moveNo] }),
    // A position's moves counted without reading them (its read version, `inv:stale_read`), and
    // a layer's balance summed from the index alone (`inv:stock_layer_balance`, the state loader).
    index('stock_move_position').on(t.companyId, t.itemId, t.warehouseId, t.entryId),
    index('stock_move_layer').on(t.companyId, t.layerId, t.quantity, t.bani),
    index('stock_move_account').on(t.companyId, t.account),
    foreignKey({
      columns: [t.companyId, t.entryId],
      foreignColumns: [entries.companyId, entries.id],
    }),
    foreignKey({
      columns: [t.companyId, t.layerId],
      foreignColumns: [stockLayers.companyId, stockLayers.id],
    }),
    check('stock_move_amount', sql`${t.quantity} <> 0 or ${t.bani} <> 0`),
  ],
);

/**
 * A fiscal cash register (aparat de marcat electronic fiscal, OUG nr. 28/1999) the company uses:
 * tracked, never driven (G2). Its unique number (NUI, the first 10 characters of its files' ids,
 * OPANAF nr. 146/2018) identifies its Z reports; the fiscal series is printed on its receipts.
 */
export const cashRegisters = sqliteTable(
  'acc_cash_registers',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    /** The register's unique identification number (NUI). */
    code: text('code').notNull(),
    /** The fiscal series printed on its receipts and reports. */
    fiscalSeries: text('fiscal_series').notNull(),
    /** Where it is installed: the working point's address. */
    location: text('location').notNull(),
    /** The warehouse it sells goods from, when it sells goods. */
    warehouseId: text('warehouse_id'),
    /** The day it was put into use (fiscalized). */
    activeFrom: text('active_from').notNull(),
    /** The fiscalization record (bonul de fiscalizare, procesul-verbal). */
    evidenceId: text('evidence_id').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('cash_register_code').on(t.companyId, t.code),
    foreignKey({
      columns: [t.companyId, t.warehouseId],
      foreignColumns: [warehouses.companyId, warehouses.id],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);

export const cashRegisterEventKinds = [
  'anaf_registered',
  'service_contract',
  'memory_replaced',
  'journal_replaced',
  'failure',
  'repaired',
  'closed',
] as const;
/** What happened to a register, numbered per register, each with its document: its ANAF
 * registration, its service contract, a fiscal memory or journal replaced, a failure (the special
 * register of OUG nr. 28/1999 art. 1 alin. (8)) and its repair, its being taken out of use. */
export const cashRegisterEvents = sqliteTable(
  'acc_cash_register_events',
  {
    companyId: companyId(),
    registerId: text('register_id').notNull(),
    seq: counter('seq').notNull(),
    kind: text('kind', { enum: cashRegisterEventKinds }).notNull(),
    date: text('date').notNull(),
    /** The document's number (the registration's, the contract's), when it has one. */
    reference: text('reference'),
    evidenceId: text('evidence_id').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.registerId, t.seq] }),
    foreignKey({
      columns: [t.companyId, t.registerId],
      foreignColumns: [cashRegisters.companyId, cashRegisters.id],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);

/**
 * A version of a bill of materials (G4, fișa tehnică / norma de consum): what one output quantity
 * of a product (an item on 341 or 345) takes in materials, labour and machine hours, and its
 * standard cost (OMFP nr. 1.802/2014 pct. 286 alin. (2): the normal levels of consumption, revised
 * periodically). Versions are numbered per product and dated; a version is never changed, a
 * revision is the next one.
 */
export const boms = sqliteTable(
  'acc_boms',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    itemId: text('item_id').notNull(),
    version: counter('version').notNull(),
    validFrom: text('valid_from').notNull(),
    /** Thousandths of the product's unit the norms are for. */
    outputQuantity: bani('output_quantity').notNull(),
    /** The standard cost of the output quantity, in bani, when the company keeps one. */
    standardCost: bani('standard_cost'),
    /** Thousandths of an hour for the output quantity. */
    labourHours: bani('labour_hours'),
    machineHours: bani('machine_hours'),
    /** The technical sheet or the standard cost's calculation (antecalculația). */
    evidenceId: text('evidence_id').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('bom_version').on(t.companyId, t.itemId, t.version),
    foreignKey({
      columns: [t.companyId, t.itemId],
      foreignColumns: [stockItems.companyId, stockItems.id],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);

/** A material of a BOM version: an item on a materials account and its quantity, in thousandths
 * of its unit, for the version's output quantity. */
export const bomLines = sqliteTable(
  'acc_bom_lines',
  {
    companyId: companyId(),
    bomId: text('bom_id').notNull(),
    lineNo: counter('line_no').notNull(),
    itemId: text('item_id').notNull(),
    quantity: bani('quantity').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.bomId, t.lineNo] }),
    foreignKey({
      columns: [t.companyId, t.bomId],
      foreignColumns: [boms.companyId, boms.id],
    }),
    foreignKey({
      columns: [t.companyId, t.itemId],
      foreignColumns: [stockItems.companyId, stockItems.id],
    }),
  ],
);

/** A work order (comandă de producție, G4): the product it makes, the BOM version it is costed
 * on, the quantity launched and the day it opened, with its launching document. */
export const workOrders = sqliteTable(
  'acc_work_orders',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    number: text('number').notNull(),
    itemId: text('item_id').notNull(),
    bomId: text('bom_id').notNull(),
    /** Thousandths of the product's unit. */
    quantity: bani('quantity').notNull(),
    openedOn: text('opened_on').notNull(),
    evidenceId: text('evidence_id').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('work_order_number').on(t.companyId, t.number),
    foreignKey({
      columns: [t.companyId, t.itemId],
      foreignColumns: [stockItems.companyId, stockItems.id],
    }),
    foreignKey({
      columns: [t.companyId, t.bomId],
      foreignColumns: [boms.companyId, boms.id],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);

export const workOrderEventKinds = ['closed'] as const;
/** What happened to a work order, numbered per order, each with its document: its closing (the
 * last products delivered, the order completed or abandoned). */
export const workOrderEvents = sqliteTable(
  'acc_work_order_events',
  {
    companyId: companyId(),
    orderId: text('order_id').notNull(),
    seq: counter('seq').notNull(),
    kind: text('kind', { enum: workOrderEventKinds }).notNull(),
    date: text('date').notNull(),
    evidenceId: text('evidence_id').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.orderId, t.seq] }),
    foreignKey({
      columns: [t.companyId, t.orderId],
      foreignColumns: [workOrders.companyId, workOrders.id],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);

/** The CNP of an individual partner (a shareholder, a buyer), sealed, for the declarations that
 * must carry it; the party itself keeps only its hash. */
export const partyCnps = sqliteTable(
  'acc_party_cnps',
  {
    companyId: companyId(),
    partyId: text('party_id').notNull(),
    cnpSealed: text('cnp_sealed').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.partyId] }),
    foreignKey({
      columns: [t.companyId, t.partyId],
      foreignColumns: [parties.companyId, parties.id],
    }),
  ],
);

/**
 * A source of independent income of a PFA, II or IF (Codul fiscal art. 67–69; D212 cap. I sec. 1):
 * its activity, place and dates, and how its net income is set. One version per change, each from
 * its date; a change of method to a norm or to the real system by option takes effect on 1
 * January, and the option binds for 2 years, renewed tacitly (art. 69^1).
 */
export const incomeSources = sqliteTable(
  'acc_income_sources',
  {
    companyId: companyId(),
    sourceId: text('source_id').notNull(),
    seq: counter('seq').notNull(),
    effectiveFrom: text('effective_from').notNull(),
    name: text('name').notNull(),
    /** The activity's CAEN code (four digits). */
    caen: text('caen').notNull(),
    /** Where the activity is carried on, and its county (ISO 3166-2:RO). */
    place: text('place').notNull(),
    county: text('county').notNull(),
    /** The registration or authorization document. */
    authorizationNumber: text('authorization_number'),
    authorizationDate: text('authorization_date'),
    startedOn: text('started_on').notNull(),
    suspendedFrom: text('suspended_from'),
    suspendedTo: text('suspended_to'),
    endedOn: text('ended_on'),
    /** A liberal profession (art. 67 alin. (2)): its net income is never set by a norm. */
    liberal: integer('liberal', { mode: 'boolean' }).notNull(),
    method: text('method', { enum: ['sistem_real', 'norma'] }).notNull(),
    /** Why the real system applies: by law (a liberal profession, an activity outside the
     * nomenclator, income above the threshold) or by the option of art. 69^1. */
    realBasis: text('real_basis', { enum: ['required', 'option'] }),
    evidenceId: text('evidence_id').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.sourceId, t.seq] }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
    check('income_source_caen', sql`${t.caen} glob '[0-9][0-9][0-9][0-9]'`),
    check('income_source_basis', sql`(${t.method} = 'norma') = (${t.realBasis} is null)`),
    check('income_source_liberal', sql`not (${t.liberal} and ${t.method} = 'norma')`),
    check(
      'income_source_dates',
      sql`${t.startedOn} <= ${t.effectiveFrom} and (${t.endedOn} is null or ${t.startedOn} <= ${t.endedOn}) and (${t.suspendedTo} is null or (${t.suspendedFrom} is not null and ${t.suspendedFrom} <= ${t.suspendedTo}))`,
    ),
  ],
);

/**
 * The members of a family enterprise (întreprindere familială, OUG nr. 44/2008 art. 28–31) as
 * the acord de constituire, or an addendum to it, sets them: each member's quota of the net
 * income or loss and the representative. One version per agreement, complete, from its date;
 * the CNP of each member is the party's, sealed (acc_party_cnps).
 */
export const enterpriseMembers = sqliteTable(
  'acc_enterprise_members',
  {
    companyId: companyId(),
    version: counter('version').notNull(),
    /** The member's number in the agreement, from 1. */
    position: counter('position').notNull(),
    partyId: text('party_id').notNull(),
    /** The member's quota in hundredths of a percent (6000 = 60%). */
    quotaBp: counter('quota_bp').notNull(),
    /** The representative (art. 29 alin. (2) lit. c)), who keeps the books (art. 15). */
    representative: integer('representative', { mode: 'boolean' }).notNull(),
    /** The version applies from this day until the next version's, or until `effectiveTo`
     * when the enterprise ends. */
    effectiveFrom: text('effective_from').notNull(),
    effectiveTo: text('effective_to'),
    /** The acord de constituire or its addendum. */
    evidenceId: text('evidence_id').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.version, t.partyId] }),
    foreignKey({
      columns: [t.companyId, t.partyId],
      foreignColumns: [parties.companyId, parties.id],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
    check('enterprise_member_quota', sql`${t.quotaBp} between 1 and 10000`),
    check(
      'enterprise_member_dates',
      sql`${t.effectiveTo} is null or ${t.effectiveFrom} <= ${t.effectiveTo}`,
    ),
  ],
);

/** What ANAF's register of taxpayers (web service v9) answered about a Romanian party for a
 * date: one snapshot per answer, numbered per party, citing the answer kept as evidence. A later
 * check adds a snapshot; none is ever corrected. */
export const partyStatuses = sqliteTable(
  'acc_party_status',
  {
    companyId: companyId(),
    partyId: text('party_id').notNull(),
    seq: counter('seq').notNull(),
    /** The CUI asked about: the party's own. */
    cui: text('cui').notNull(),
    /** The date the status is for (the service's `data`). */
    asOf: text('as_of').notNull(),
    name: text('name').notNull(),
    vatPayer: integer('vat_payer', { mode: 'boolean' }).notNull(),
    cashVat: integer('cash_vat', { mode: 'boolean' }).notNull(),
    inactive: integer('inactive', { mode: 'boolean' }).notNull(),
    inactiveSince: text('inactive_since'),
    reactivatedOn: text('reactivated_on'),
    splitVat: integer('split_vat', { mode: 'boolean' }).notNull(),
    eInvoice: integer('e_invoice', { mode: 'boolean' }).notNull(),
    struckOffOn: text('struck_off_on'),
    evidenceId: text('evidence_id').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.partyId, t.seq] }),
    index('party_status_date').on(t.companyId, t.partyId, t.asOf),
    index('party_status_evidence').on(t.companyId, t.evidenceId),
    check('party_status_cui', sql`${t.cui} glob '[0-9]*' and length(${t.cui}) between 2 and 10`),
    foreignKey({
      columns: [t.companyId, t.partyId],
      foreignColumns: [parties.companyId, parties.id],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);

/** A company's connection to ANAF's APIs: OAuth tokens, sealed, one version per grant or
 * refresh. The certificate that obtained them never reaches the engine. */
export const anafConnections = sqliteTable(
  'acc_anaf_connections',
  {
    companyId: companyId(),
    seq: counter('seq').notNull(),
    environment: text('environment', { enum: ['test', 'prod'] }).notNull(),
    accessSealed: text('access_sealed').notNull(),
    refreshSealed: text('refresh_sealed').notNull(),
    accessExpiresAt: counter('access_expires_at').notNull(),
    refreshExpiresAt: counter('refresh_expires_at').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.seq] })],
);

// Payroll: personal data. The CNP is kept sealed (encrypted with the server's key); its hash is
// the employee's party identity, as for buyers who are individuals.

export const employees = sqliteTable(
  'acc_employees',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    partyId: text('party_id').notNull(),
    /** The CNP, encrypted; never returned by a view. */
    cnpSealed: text('cnp_sealed').notNull(),
    birthDate: text('birth_date').notNull(),
    /** As the D112 declares them; the party's name joins them. */
    lastName: text('last_name'),
    firstName: text('first_name'),
    /** The health insurance house the employee is insured with (ISO 3166-2:RO county, or
     * OPSNAJ). */
    healthFund: text('health_fund'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('employee_party').on(t.companyId, t.partyId),
    foreignKey({
      columns: [t.companyId, t.partyId],
      foreignColumns: [parties.companyId, parties.id],
    }),
  ],
);

/** An employment contract's terms, one version per change (addendum, new declaration). */
export const employmentTerms = sqliteTable(
  'acc_employment_terms',
  {
    companyId: companyId(),
    contractId: text('contract_id').notNull(),
    seq: counter('seq').notNull(),
    employeeId: text('employee_id').notNull(),
    number: text('number').notNull(),
    startDate: text('start_date').notNull(),
    endDate: text('end_date'),
    /** The date this version applies from. */
    effectiveFrom: text('effective_from').notNull(),
    baseSalaryBani: bani('base_salary_bani').notNull(),
    dailyHours: counter('daily_hours').notNull(),
    mainJob: integer('main_job', { mode: 'boolean' }).notNull(),
    /** COR occupation code. */
    occupation: text('occupation').notNull(),
    dependents: counter('dependents').notNull(),
    childrenInSchool: counter('children_in_school').notNull(),
    unionDuesBani: bani('union_dues_bani').notNull(),
    minimumExemption: text('minimum_exemption'),
    evidenceId: text('evidence_id'),
    /** `employment`: an individual employment contract; `mandate`: an administrator's
     * administration or mandate contract (Codul fiscal art. 76 alin. (2) lit. o)). */
    kind: text('kind', { enum: ['employment', 'mandate'] })
      .notNull()
      .default('employment'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.contractId, t.seq] }),
    index('terms_employee').on(t.companyId, t.employeeId),
    foreignKey({
      columns: [t.companyId, t.employeeId],
      foreignColumns: [employees.companyId, employees.id],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);

/** A month's payroll as computed: never changed, only superseded by a new computation. */
export const payrollRuns = sqliteTable(
  'acc_payroll_runs',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    month: text('month').notNull(),
    round: counter('round').notNull(),
    workingDays: counter('working_days').notNull(),
    /** Hash of the lines as computed: with the run's latest state, its version in a read-set. */
    resultHash: text('result_hash').notNull(),
    /** Lines the rules could not settle: such a run is not posted. */
    issues: counter('issues').notNull(),
    /** A correction (a round after the first): the posted run it corrects, why, and the document
     * that shows it. */
    corrects: text('corrects_run_id'),
    correctionReason: text('correction_reason', { enum: ['error', 'retroactive'] }),
    correctionEvidenceId: text('correction_evidence_id'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    index('payroll_run_month').on(t.companyId, t.month, t.round),
  ],
);

export const payrollRunStates = ['prepared', 'superseded'] as const;
export const payrollRunEvents = sqliteTable(
  'acc_payroll_run_events',
  {
    companyId: companyId(),
    runId: text('run_id').notNull(),
    seq: counter('seq').notNull(),
    state: text('state', { enum: payrollRunStates }).notNull(),
    detail: text('detail'),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.runId, t.seq] }),
    foreignKey({
      columns: [t.companyId, t.runId],
      foreignColumns: [payrollRuns.companyId, payrollRuns.id],
    }),
  ],
);

export const payrollLines = sqliteTable(
  'acc_payroll_lines',
  {
    companyId: companyId(),
    runId: text('run_id').notNull(),
    contractId: text('contract_id').notNull(),
    termsSeq: counter('terms_seq').notNull(),
    employeeId: text('employee_id').notNull(),
    partyId: text('party_id').notNull(),
    /** What was computed from: days, items and the deduction facts, as canonical JSON. */
    input: canonicalJson('input_json'),
    /** The calculation's steps and their clauses, or the issues that stopped it. */
    result: canonicalJson('result_json'),
    cash: bani('cash_bani').notNull(),
    vouchers: bani('vouchers_bani').notNull(),
    cas: bani('cas_bani').notNull(),
    cass: bani('cass_bani').notNull(),
    casEmployer: bani('cas_employer_bani').notNull(),
    cassEmployer: bani('cass_employer_bani').notNull(),
    tax: bani('tax_bani').notNull(),
    unionDues: bani('union_dues_bani').notNull(),
    net: bani('net_bani').notNull(),
    cam: bani('cam_bani').notNull(),
    issues: counter('issues').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.runId, t.contractId] }),
    foreignKey({
      columns: [t.companyId, t.runId],
      foreignColumns: [payrollRuns.companyId, payrollRuns.id],
    }),
    foreignKey({
      columns: [t.companyId, t.contractId, t.termsSeq],
      foreignColumns: [employmentTerms.companyId, employmentTerms.contractId, employmentTerms.seq],
    }),
  ],
);

/** A garnishment order (adresă de înființare a popririi) on an employee's salary, as the
 * employer received it: never changed; a release is a row of its own. */
export const garnishments = sqliteTable(
  'acc_garnishments',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    contractId: text('contract_id').notNull(),
    /** The creditor the withheld amounts are paid to (427). */
    partyId: text('party_id').notNull(),
    kind: text('kind', { enum: ['maintenance', 'state', 'public_damage', 'other'] }).notNull(),
    /** The order's number and the day the employer received it (the order within a rank). */
    reference: text('reference').notNull(),
    receivedOn: text('received_on').notNull(),
    /** The debt to recover, in bani. */
    totalBani: bani('total_bani').notNull(),
    /** What the order says to withhold each month: an amount, or a share of the net pay. */
    monthlyBani: bani('monthly_bani'),
    shareNumerator: counter('share_numerator'),
    shareDenominator: counter('share_denominator'),
    evidenceId: text('evidence_id').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    index('garnishment_contract').on(t.companyId, t.contractId),
    foreignKey({
      columns: [t.companyId, t.partyId],
      foreignColumns: [parties.companyId, parties.id],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);

/** A garnishment lifted (ridicarea popririi) from a date, with its document. */
export const garnishmentReleases = sqliteTable(
  'acc_garnishment_releases',
  {
    companyId: companyId(),
    garnishmentId: text('garnishment_id').notNull(),
    releasedOn: text('released_on').notNull(),
    evidenceId: text('evidence_id').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.garnishmentId] }),
    foreignKey({
      columns: [t.companyId, t.garnishmentId],
      foreignColumns: [garnishments.companyId, garnishments.id],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);

/** A transmission to REGES-ONLINE recorded by a person: the engine does not submit it. */
export const regesRecords = sqliteTable(
  'acc_reges_records',
  {
    companyId: companyId(),
    contractId: text('contract_id').notNull(),
    /** The terms version it registers: 1 for the contract's start, a later one for a change. */
    termsSeq: counter('terms_seq').notNull(),
    event: text('event', { enum: ['start', 'change', 'end'] }).notNull(),
    transmittedOn: text('transmitted_on').notNull(),
    /** The receipt REGES-ONLINE gave, as evidence. */
    evidenceId: text('evidence_id').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.contractId, t.termsSeq, t.event] }),
    foreignKey({
      columns: [t.companyId, t.contractId, t.termsSeq],
      foreignColumns: [employmentTerms.companyId, employmentTerms.contractId, employmentTerms.seq],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);

// Questions to people and the worklist's dispositions

/** A question asked of a person (`questions.ask`): a kind (`xfactura-core/questions/kinds`), what
 * it is about and its parameters. At most one is open (unanswered, not withdrawn) per kind and
 * subject. */
export const questions = sqliteTable(
  'acc_questions',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    kind: text('kind').notNull(),
    subjectKind: text('subject_kind').notNull(),
    subjectId: text('subject_id').notNull(),
    params: canonicalJson('params_json'),
    /** The person in whose name it was asked, through `agentId` when an agent asked it. */
    askedBy: text('asked_by')
      .notNull()
      .references(() => user.id),
    agentId: text('agent_id'),
    /** When the answer is needed by, if it is. */
    due: text('due'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    index('question_subject').on(t.companyId, t.kind, t.subjectKind, t.subjectId),
  ],
);
/** A person's answer, kept as evidence (`application/vnd.xfactura.answer+json`). A later answer
 * replaces an earlier one; proposals citing the question then become stale. */
export const questionAnswers = sqliteTable(
  'acc_question_answers',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    questionId: text('question_id').notNull(),
    /** Numbered from 1 per question; the latest holds. */
    seq: counter('seq').notNull(),
    value: canonicalJson('value_json'),
    /** The answer itself, as the evidence proposals and profile facts cite. */
    evidenceId: text('evidence_id').notNull(),
    answeredBy: text('answered_by')
      .notNull()
      .references(() => user.id),
    /** Always null: only a person answers (`inv:answer_person`). */
    agentId: text('agent_id'),
    /** The answerer's membership epoch when they answered. */
    epoch: counter('epoch').notNull(),
    /** When the engine recorded the answer: the time treatments read it as given at
     * (`AnswerRecord.answeredAt`) and the order of answers that still hold. Null for answers
     * recorded before the column existed. */
    engineAt: engineAt(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    uniqueIndex('question_answer_seq').on(t.companyId, t.questionId, t.seq),
    foreignKey({
      columns: [t.companyId, t.questionId],
      foreignColumns: [questions.companyId, questions.id],
    }),
    foreignKey({
      columns: [t.companyId, t.evidenceId],
      foreignColumns: [evidence.companyId, evidence.id],
    }),
  ],
);
/** A question no longer needed, withdrawn before anyone answered it. */
export const questionWithdrawals = sqliteTable(
  'acc_question_withdrawals',
  {
    companyId: companyId(),
    questionId: text('question_id').notNull(),
    reason: text('reason').notNull(),
    createdBy: author(),
    agentId: text('agent_id'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.questionId] }),
    foreignKey({
      columns: [t.companyId, t.questionId],
      foreignColumns: [questions.companyId, questions.id],
    }),
  ],
);
/** What was decided about a worklist item that needs no other record: a document needing no
 * booking, an SPV message dealt with. It hides the item while the item's fingerprint is the one
 * decided on; a change brings it back. */
export const dispositions = sqliteTable(
  'acc_dispositions',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    subjectKind: text('subject_kind').notNull(),
    subjectId: text('subject_id').notNull(),
    disposition: text('disposition', { enum: ['no_booking', 'dealt_with'] }).notNull(),
    reason: text('reason').notNull(),
    /** The fingerprint of the item as it was decided on. */
    fingerprint: text('fingerprint').notNull(),
    createdBy: author(),
    agentId: text('agent_id'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    index('disposition_subject').on(t.companyId, t.subjectKind, t.subjectId),
    check('disposition_value', sql`${t.disposition} in ('no_booking', 'dealt_with')`),
  ],
);

// Booking templates and their track record

/**
 * A booking template's versions (`templates.request`, a reviewed action): what it applies to
 * (treatment, partner, document kind, line words) and the part of the treatment's input it fixes
 * (`xfactura-core/templates`). A later version replaces the earlier; a revocation ends them all.
 */
export const templates = sqliteTable(
  'acc_templates',
  {
    id: text('id').notNull(),
    companyId: companyId(),
    version: counter('version').notNull(),
    name: text('name').notNull(),
    treatmentId: text('treatment_id').notNull(),
    partyId: text('party_id'),
    documentKind: text('document_kind').notNull(),
    /** The scope as `templateScope` parses it. */
    scope: canonicalJson('scope_json'),
    mapping: canonicalJson('mapping_json'),
    /** The reviewed request whose execution wrote this version. */
    requestId: text('request_id').notNull(),
    /** The person who approved that request, under the membership epoch they decided in. */
    approvedBy: text('approved_by')
      .notNull()
      .references(() => user.id),
    approverEpoch: counter('approver_epoch').notNull(),
    /** Who executed the request, through `agentId` when an agent did. */
    createdBy: author(),
    agentId: text('agent_id'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id, t.version] }),
    index('template_scope').on(t.companyId, t.treatmentId, t.partyId),
    foreignKey({
      columns: [t.companyId, t.requestId],
      foreignColumns: [actionRequests.companyId, actionRequests.id],
    }),
    foreignKey({
      columns: [t.companyId, t.partyId],
      foreignColumns: [parties.companyId, parties.id],
    }),
  ],
);
/** A template no longer used, in every version. */
export const templateRevocations = sqliteTable(
  'acc_template_revocations',
  {
    companyId: companyId(),
    templateId: text('template_id').notNull(),
    reason: text('reason').notNull(),
    createdBy: author(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.templateId] })],
);
/**
 * What a template version would book for a document or movement, recorded by the worker before
 * anything was posted for it: a shadow booking. Its outcome is read from what was posted for the
 * subject (`correct`, `corrected`, `rejected`), never stored.
 */
export const templatePredictions = sqliteTable(
  'acc_template_predictions',
  {
    companyId: companyId(),
    templateId: text('template_id').notNull(),
    templateVersion: counter('template_version').notNull(),
    /** What the template read: `document:<id>` or `movement:<id>`. */
    sourceKey: text('source_key').notNull(),
    /** `predicted`; `not_applicable` when the template made no input of it (outside its words,
     * no single open item); `blocked` when its treatment refused the input. */
    status: text('status', { enum: ['predicted', 'not_applicable', 'blocked'] }).notNull(),
    /** The proposal subject the input is for (`treatment.subject`, a document group's root). */
    subjectKey: text('subject_key'),
    input: text('input_json'),
    fingerprint: text('fingerprint'),
    /** The audit `seq` of the books the prediction read. */
    asOfSeq: counter('as_of_seq').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.templateId, t.templateVersion, t.sourceKey] }),
    index('template_prediction_subject').on(t.companyId, t.subjectKey),
    foreignKey({
      columns: [t.companyId, t.templateId, t.templateVersion],
      foreignColumns: [templates.companyId, templates.id, templates.version],
    }),
    check(
      'template_prediction_status',
      sql`${t.status} in ('predicted', 'not_applicable', 'blocked') and (${t.status} = 'predicted') = (${t.fingerprint} is not null) and (${t.status} = 'not_applicable') = (${t.subjectKey} is null)`,
    ),
  ],
);

// Earned autonomy: the kill switch and the graduation criteria

/**
 * Pauses and resumes of automatic posting, for the whole company, one posting policy or one
 * template; the latest event of a scope decides. Any member, an agent or the system (a demotion)
 * pauses; only a person who may review resumes.
 */
export const automationEvents = sqliteTable(
  'acc_automation_events',
  {
    companyId: companyId(),
    /** Numbered from 1 per company, without gaps. */
    seq: counter('seq').notNull(),
    scope: text('scope', { enum: ['company', 'policy', 'template'] }).notNull(),
    /** The policy or template; null for the company. */
    scopeId: text('scope_id'),
    kind: text('kind', { enum: ['pause', 'resume'] }).notNull(),
    reason: text('reason').notNull(),
    /** What made the system pause it (`reversal`, `correction`, `new_party`,
     * `unusual_amount`, `changed_answer`); null when a person or an agent acted. */
    trigger: text('trigger'),
    details: text('details_json'),
    createdBy: author(),
    agentId: text('agent_id'),
    /** The member's epoch when they acted; null for the system. */
    epoch: counter('epoch'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.seq] }),
    index('automation_scope').on(t.companyId, t.scope, t.scopeId, t.seq),
    check(
      'automation_event',
      sql`${t.scope} in ('company', 'policy', 'template') and ${t.kind} in ('pause', 'resume') and (${t.scope} = 'company') = (${t.scopeId} is null)`,
    ),
  ],
);
/**
 * The company's graduation criteria, one version per change; the latest holds. An owner or an
 * accountant may tighten the defaults (at least 6 correct across at least 3 months, policies of
 * at most 90 days), never loosen them.
 */
export const automationCriteria = sqliteTable(
  'acc_automation_criteria',
  {
    companyId: companyId(),
    seq: counter('seq').notNull(),
    minCorrect: counter('min_correct').notNull(),
    minMonths: counter('min_months').notNull(),
    policyDays: counter('policy_days').notNull(),
    reason: text('reason').notNull(),
    createdBy: author(),
    epoch: counter('epoch').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.seq] }),
    check(
      'automation_criteria_floor',
      sql`${t.minCorrect} between 6 and 1000 and ${t.minMonths} between 3 and 120 and ${t.policyDays} between 1 and 90`,
    ),
  ],
);

/** Checksums of the installed database invariants (see invariants.ts). */
export const invariantChecksums = sqliteTable('acc_invariants', {
  name: text('name').primaryKey(),
  checksum: text('checksum').notNull(),
});
