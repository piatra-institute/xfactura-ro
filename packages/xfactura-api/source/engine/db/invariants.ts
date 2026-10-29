import type { Client } from '@libsql/client';
import { sha256Hex } from 'xfactura-core/hash';

/*
 * The database's own accounting invariants (ADR 0010).
 *
 * The application checks the same rules first (`validateEffect` in xfactura-core) and reports
 * them precisely. These triggers are the backstop: whatever code path writes to the database, it
 * cannot post an unapproved, unbalanced or tampered entry, change a posted record, or write into
 * a closed period. Drizzle has no notion of triggers, so they are SQL, organised as:
 *
 *   1. views that name the joins the checks need (a line with its account and open item, …);
 *   2. checks, each a plain-language rule plus the SQL condition that detects its violation;
 *   3. triggers assembled from those checks, with every rule kept as a comment in the database.
 *
 * Every abort message is `inv:<code>`. The views and triggers are installed after migrations by
 * `ensureInvariants`, not kept as migration history, so a table rebuild cannot drop one silently.
 */

// Tables whose rows never change once written.
const appendOnly = [
  'acc_companies',
  'acc_audit',
  'acc_commands',
  'acc_fiscal_years',
  'acc_profile_facts',
  'acc_parties',
  'acc_evidence',
  'acc_documents',
  'acc_document_links',
  'acc_proposals',
  'acc_proposal_versions',
  'acc_approvals',
  'acc_withdrawals',
  'acc_posting_policies',
  'acc_policy_revocations',
  'acc_entries',
  'acc_open_items',
  'acc_lines',
  'acc_schedule_rows',
  'acc_tax_entries',
  'acc_period_events',
  'acc_period_balances',
  'acc_tax_period_events',
  'acc_action_requests',
  'acc_action_decisions',
  'acc_action_executions',
  'acc_treasury_accounts',
  'acc_bank_statements',
  'acc_bank_movements',
  'acc_party_versions',
  'acc_series',
  'acc_issued_numbers',
  'acc_submissions',
  'acc_submission_events',
  'acc_spv_messages',
  'acc_spv_sync_windows',
  'ref_fx_rates',
];
// Tables with narrowly guarded updates (below) that are never deleted from.
const neverDeleted = ['acc_memberships', 'acc_agent_grants', 'acc_invitations', 'acc_accounts'];
/** Tables outside the invariant regime: authentication, work queues and bookkeeping. */
export const mutableTables = [
  'user',
  'session',
  'account',
  'verification',
  'acc_jobs',
  'acc_outbox',
  'acc_invariants',
  '__drizzle_migrations',
];
export const guardedTables = [...appendOnly, ...neverDeleted];

// 1. Views

const views: Record<string, string> = {
  // Each posted line with its account's control and the open item it names. `control_ok`: lines
  // on open-item control accounts (4111, 401, 471, …) name a matching item; others name none.
  inv_line_controls: `
    SELECT l.company_id, l.entry_id, l.line_no,
      a.code IS NOT NULL AND a.postable = 1 AS postable,
      a.valid_from, a.valid_to,
      COALESCE(a.control_kind, '') = 'tax' AS tax_account,
      CASE WHEN COALESCE(a.control_kind, 'tax') = 'tax' THEN l.open_item_id IS NULL
        ELSE o.kind IS a.control_kind
          AND o.control_account IS l.account
          AND o.currency IS COALESCE(l.currency, 'RON')
          AND (l.party_id IS NULL OR l.party_id IS o.party_id)
      END AS control_ok
    FROM acc_lines l
    LEFT JOIN acc_accounts a ON a.company_id = l.company_id AND a.code = l.account
    LEFT JOIN acc_open_items o ON o.company_id = l.company_id AND o.id = l.open_item_id`,

  // For each line, the tax entries linked to it. `booked` is the line's amount in the direction
  // of its tax (credit-positive for output tax, debit-positive for input tax).
  inv_tax_lines: `
    SELECT l.company_id, l.entry_id, l.line_no,
      l.tax_settlement_tax IS NOT NULL AS settlement,
      count(t.tax_no) AS entries,
      count(DISTINCT t.direction) AS directions,
      COALESCE(sum(t.ledger_bani), 0) AS linked,
      CASE WHEN (min(t.direction) = 'output') = (l.side = 'C') THEN l.bani ELSE -l.bani END AS booked
    FROM acc_lines l
    LEFT JOIN acc_tax_entries t
      ON t.company_id = l.company_id AND t.entry_id = l.entry_id AND t.line_no = l.line_no
    GROUP BY l.company_id, l.entry_id, l.line_no`,
};

// 2. Checks

/** A rule the database enforces. `violation` is a SQL condition that is true when it is broken. */
type Check = { code: string; rule: string; violation: string };

const raise = (code: string) => `RAISE(ABORT, 'inv:${code}')`;

/** The approved proposal version an entry or approval refers to. */
const version = (column: string) => `(
      SELECT ${column} FROM acc_proposal_versions
      WHERE company_id = NEW.company_id AND proposal_id = NEW.proposal_id AND version = NEW.version)`;
const effect = version('effect_json');
const isLatestVersion = `NOT EXISTS (
      SELECT 1 FROM acc_proposal_versions
      WHERE company_id = NEW.company_id AND proposal_id = NEW.proposal_id AND version > NEW.version)`;
const isWithdrawn = `EXISTS (
      SELECT 1 FROM acc_withdrawals WHERE company_id = NEW.company_id AND proposal_id = NEW.proposal_id)`;
const isPosted = `EXISTS (
      SELECT 1 FROM acc_entries WHERE company_id = NEW.company_id AND proposal_id = NEW.proposal_id)`;
/** An active owner or reviewer whose membership has not changed since the given epoch. */
const isReviewer = (user: string, epoch: string) => `EXISTS (
      SELECT 1 FROM acc_memberships m
      WHERE m.company_id = NEW.company_id AND m.user_id = ${user}
        AND m.active = 1 AND m.role IN ('owner', 'reviewer') AND m.epoch = ${epoch})`;
/**
 * A tax period's read version, as the state loader records it for `${tax}|${period}`: its tax
 * entries, its settlement lines and the last sequence among their entries, excluding the
 * entry being posted.
 */
const taxPeriodVersion = (id: string) => {
  const tax = `substr(${id}, 1, instr(${id}, '|') - 1)`;
  const period = `substr(${id}, instr(${id}, '|') + 1)`;
  const taxRows = `FROM acc_tax_entries t JOIN acc_entries e ON e.company_id = t.company_id AND e.id = t.entry_id
          WHERE t.company_id = NEW.company_id AND t.tax = ${tax} AND t.tax_period = ${period}`;
  const settlementRows = `FROM acc_lines l JOIN acc_entries e ON e.company_id = l.company_id AND e.id = l.entry_id
          WHERE l.company_id = NEW.company_id AND l.tax_settlement_tax = ${tax} AND l.tax_settlement_period = ${period}`;
  return `(
        (SELECT count(*) ${taxRows}) || '/' || (SELECT count(*) ${settlementRows}) || '/' ||
        max(COALESCE((SELECT max(e.seq) ${taxRows}), 0), COALESCE((SELECT max(e.seq) ${settlementRows}), 0)))`;
};
const latest = (table: string, scope: string) =>
  `(SELECT kind FROM ${table} WHERE company_id = NEW.company_id AND ${scope} ORDER BY seq DESC LIMIT 1)`;
const nowMs = `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;
const thisEntry = `company_id = NEW.company_id AND entry_id = NEW.id`;

/**
 * How a stored row mirrors one element of the approved effect JSON: its column, the JSON path,
 * and whether the JSON value is a 64-bit integer written as canonical decimal text (`integer`)
 * or a zero-based line index stored one-based (`lineIndex`).
 */
type Field = { column: string; path: string; type?: 'integer' | 'lineIndex'; source?: string };

function sameAsEffect(alias: string, fields: Field[]) {
  return fields
    .map(({ column, path, type, source = 'j.value' }) => {
      const value = `json_extract(${source}, '${path}')`;
      if (type === 'lineIndex') return `${alias}.${column} IS ${value} + 1`;
      if (type !== 'integer') return `${alias}.${column} IS ${value}`;
      // Reject non-canonical integer text (decimals, leading zeros, overflow) before comparing.
      const canonicalText = `(json_type(${source}, '${path}') IS NULL OR (json_type(${source}, '${path}') = 'text' AND CAST(CAST(${value} AS INTEGER) AS TEXT) = ${value}))`;
      return `${alias}.${column} IS CAST(${value} AS INTEGER) AND ${canonicalText}`;
    })
    .join('\n          AND ');
}

/** True when the rows of `table` for this entry are not exactly the effect's `items`. */
function differsFromEffect(options: {
  table: string;
  alias: string;
  rows: string;
  items: string;
  expectedCount: string;
  key: string;
  fields: Field[];
}) {
  const { table, alias, rows, items, expectedCount, key, fields } = options;
  return `(SELECT count(*) FROM ${table} ${alias} WHERE ${rows}) <> ${expectedCount}
      OR EXISTS (SELECT 1 FROM ${items} WHERE NOT EXISTS (
        SELECT 1 FROM ${table} ${alias} WHERE ${rows} AND ${key}
          AND ${sameAsEffect(alias, fields)}))`;
}

const lineFields: Field[] = [
  { column: 'account', path: '$.account' },
  { column: 'side', path: '$.side' },
  { column: 'bani', path: '$.bani', type: 'integer' },
  { column: 'currency', path: '$.currency.code' },
  { column: 'currency_minor', path: '$.currency.minor', type: 'integer' },
  { column: 'fx_rate_id', path: '$.currency.rateId' },
  { column: 'fx_rate', path: '$.currency.rate' },
  { column: 'party_id', path: '$.partyId' },
  { column: 'open_item_id', path: '$.openItem' },
  { column: 'tax_settlement_tax', path: '$.taxSettlement.tax' },
  { column: 'tax_settlement_period', path: '$.taxSettlement.period' },
  { column: 'cost_center', path: '$.analytics.costCenter' },
  { column: 'project', path: '$.analytics.project' },
  { column: 'item', path: '$.analytics.item' },
  { column: 'memo', path: '$.memo' },
];
const openItemFields: Field[] = [
  { column: 'kind', path: '$.kind' },
  { column: 'control_account', path: '$.controlAccount' },
  { column: 'party_id', path: '$.partyId' },
  { column: 'currency', path: '$.currency' },
  { column: 'normal_side', path: '$.normalSide' },
  { column: 'may_reverse', path: '$.mayReverse' },
  { column: 'due_date', path: '$.dueDate' },
  { column: 'document_id', path: '$.documentId' },
];
const taxEntryFields: Field[] = [
  { column: 'key', path: '$.key' },
  { column: 'line_no', path: '$.line', type: 'lineIndex' },
  { column: 'tax', path: '$.tax' },
  { column: 'code', path: '$.code' },
  { column: 'direction', path: '$.direction' },
  { column: 'base_bani', path: '$.baseBani', type: 'integer' },
  { column: 'tax_bani', path: '$.taxBani', type: 'integer' },
  { column: 'deductible_bani', path: '$.deductibleBani', type: 'integer' },
  { column: 'ledger_bani', path: '$.ledgerBani', type: 'integer' },
  { column: 'tax_point', path: '$.taxPoint' },
  { column: 'exigibility', path: '$.exigibility' },
  { column: 'tax_period', path: '$.taxPeriod' },
  { column: 'party_id', path: '$.partyId' },
  { column: 'document_id', path: '$.documentId' },
  { column: 'origin_tax_entry', path: '$.originTaxEntry' },
  { column: 'currency', path: '$.currency.code' },
  { column: 'base_minor', path: '$.currency.baseMinor', type: 'integer' },
  { column: 'tax_minor', path: '$.currency.taxMinor', type: 'integer' },
  { column: 'fx_rate_id', path: '$.currency.rateId' },
  { column: 'fx_rate', path: '$.currency.rate' },
  { column: 'attributes_json', path: '$.attributes' },
];
const scheduleRowFields: Field[] = [
  { column: 'schedule_id', path: '$.ref', source: 's.value' },
  { column: 'version', path: '$.version', source: 's.value' },
  { column: 'open_item_id', path: '$.openItem', source: 's.value' },
  { column: 'method', path: '$.method', source: 's.value' },
  { column: 'row_key', path: '$.key', source: 'r.value' },
  { column: 'due_date', path: '$.due', source: 'r.value' },
  { column: 'bani', path: '$.bani', type: 'integer', source: 'r.value' },
  { column: 'counter_account', path: '$.counterAccount', source: 'r.value' },
];

const entryChecks: Check[] = [
  {
    code: 'subject_posted',
    rule: 'A subject (document, movement, …) is posted at most once.',
    violation: `EXISTS (
      SELECT 1 FROM acc_entries e
      JOIN acc_proposals p ON p.company_id = e.company_id AND p.id = e.proposal_id
      WHERE e.company_id = NEW.company_id AND p.subject_key = (
        SELECT subject_key FROM acc_proposals WHERE company_id = NEW.company_id AND id = NEW.proposal_id))`,
  },
  {
    code: 'proposal_version_missing',
    rule: 'An entry posts an existing proposal version.',
    violation: `${version('1')} IS NULL`,
  },
  {
    code: 'stale_version',
    rule: 'Only the latest version of a proposal can be posted.',
    violation: `NOT ${isLatestVersion}`,
  },
  { code: 'withdrawn', rule: 'A withdrawn proposal cannot be posted.', violation: isWithdrawn },
  {
    code: 'blocking_issues',
    rule: 'A version with blocking issues has no postable effect.',
    violation: `${version('blocking')} <> 0 OR ${effect} IS NULL`,
  },
  {
    code: 'entry_header',
    rule: "The entry's date, journal and description are the approved effect's.",
    violation: `${version('entry_date')} IS NOT NEW.date
      OR json_extract(${effect}, '$.date') IS NOT NEW.date
      OR json_extract(${effect}, '$.journalClass') IS NOT NEW.journal_class
      OR json_extract(${effect}, '$.journalCode') IS NOT NEW.journal_code
      OR json_extract(${effect}, '$.description') IS NOT NEW.description`,
  },
  {
    code: 'fiscal_year',
    rule: 'The entry date falls in the financial year the entry is numbered in.',
    violation: `NOT EXISTS (
      SELECT 1 FROM acc_fiscal_years y
      WHERE y.company_id = NEW.company_id AND y.id = NEW.fiscal_year_id AND y.kind = 'financial'
        AND y.date_from <= NEW.date AND NEW.date <= y.date_to)`,
  },
  {
    code: 'binding',
    rule: 'An entry is bound either to an approval of exactly this effect by a current reviewer, or to an active posting policy, approved by a current reviewer, that covers this treatment and rule set.',
    violation: `NOT (
      (NEW.approval_id IS NOT NULL AND NEW.policy_id IS NULL AND EXISTS (
        SELECT 1 FROM acc_approvals a
        JOIN acc_memberships m ON m.company_id = a.company_id AND m.user_id = a.approver_id
        WHERE a.company_id = NEW.company_id AND a.id = NEW.approval_id
          AND a.proposal_id = NEW.proposal_id AND a.version = NEW.version
          AND a.effect_hash = ${version('effect_hash')}
          AND m.active = 1 AND m.role IN ('owner', 'reviewer') AND m.epoch = a.approver_epoch))
      OR (NEW.policy_id IS NOT NULL AND NEW.approval_id IS NULL AND EXISTS (
        SELECT 1 FROM acc_posting_policies p
        JOIN acc_memberships m ON m.company_id = p.company_id AND m.user_id = p.approved_by
        WHERE p.company_id = NEW.company_id AND p.id = NEW.policy_id
          AND p.valid_from <= NEW.date AND p.expires_at > ${nowMs}
          AND m.active = 1 AND m.role IN ('owner', 'reviewer') AND m.epoch = p.approver_epoch
          AND NOT EXISTS (
            SELECT 1 FROM acc_policy_revocations r WHERE r.company_id = p.company_id AND r.policy_id = p.id)
          AND EXISTS (
            SELECT 1 FROM json_each(p.treatments_json) t, acc_proposals q
            WHERE q.company_id = NEW.company_id AND q.id = NEW.proposal_id AND t.value = q.treatment_id)
          AND EXISTS (
            SELECT 1 FROM json_each(p.rules_hashes_json) h WHERE h.value = ${version('rules_hash')}))))`,
  },
  {
    code: 'closed_period',
    rule: 'Nothing is posted into a closed month.',
    violation: `${latest('acc_period_events', 'month = NEW.period')} = 'close'`,
  },
  {
    code: 'entry_number',
    rule: 'Entries are numbered without gaps within a financial year and journal class.',
    violation: `NEW.number <> 1 + COALESCE((
      SELECT max(number) FROM acc_entries
      WHERE company_id = NEW.company_id AND fiscal_year_id = NEW.fiscal_year_id
        AND journal_class = NEW.journal_class), 0)`,
  },
  {
    code: 'entry_seq',
    rule: "Entries are sequenced without gaps across the company's whole history.",
    violation: `NEW.seq <> 1 + COALESCE((SELECT max(seq) FROM acc_entries WHERE company_id = NEW.company_id), 0)`,
  },
  {
    code: 'lines_mismatch',
    rule: "The entry's lines are exactly the approved effect's lines.",
    violation: differsFromEffect({
      table: 'acc_lines',
      alias: 'l',
      rows: `l.company_id = NEW.company_id AND l.entry_id = NEW.id`,
      items: `json_each(${effect}, '$.lines') j`,
      expectedCount: `json_array_length(${effect}, '$.lines')`,
      key: 'l.line_no = j.key + 1',
      fields: lineFields,
    }),
  },
  {
    code: 'line_count',
    rule: 'A general entry has at least two lines; a memo entry has none.',
    violation: `(NEW.journal_class = 'general' AND (SELECT count(*) FROM acc_lines WHERE ${thisEntry}) < 2)
      OR (NEW.journal_class = 'memo' AND EXISTS (SELECT 1 FROM acc_lines WHERE ${thisEntry}))`,
  },
  {
    code: 'unbalanced',
    rule: 'Debits equal credits.',
    violation: `COALESCE((
      SELECT sum(CASE side WHEN 'D' THEN bani ELSE -bani END) FROM acc_lines WHERE ${thisEntry}), 0) <> 0`,
  },
  {
    code: 'account',
    rule: 'Every line uses a postable account that is valid on the entry date.',
    violation: `EXISTS (
      SELECT 1 FROM inv_line_controls WHERE ${thisEntry}
        AND NOT (postable AND valid_from <= NEW.date AND (valid_to IS NULL OR NEW.date <= valid_to)))`,
  },
  {
    code: 'control_open_item',
    rule: 'Lines on open-item control accounts name a matching open item; other lines name none.',
    violation: `EXISTS (SELECT 1 FROM inv_line_controls WHERE ${thisEntry} AND NOT control_ok)`,
  },
  {
    code: 'open_items_mismatch',
    rule: 'The open items this entry creates are exactly those of the approved effect.',
    violation: differsFromEffect({
      table: 'acc_open_items',
      alias: 'o',
      rows: `o.company_id = NEW.company_id AND o.origin_entry_id = NEW.id`,
      items: `json_each(${effect}, '$.openItems') j`,
      expectedCount: `json_array_length(${effect}, '$.openItems')`,
      key: `o.id = json_extract(j.value, '$.ref')`,
      fields: openItemFields,
    }),
  },
  {
    code: 'open_item_balance',
    rule: 'After this entry, no open item it touches has crossed to the wrong side (unless allowed), and a foreign-currency item settled in full has no RON remainder.',
    // Grouped per touched item, so the check reads only those items' lines.
    violation: `EXISTS (
      SELECT 1 FROM (
        SELECT o.normal_side, o.may_reverse, o.currency,
          sum(CASE l.side WHEN 'D' THEN l.bani ELSE -l.bani END) AS bani,
          sum(CASE l.side WHEN 'D' THEN COALESCE(l.currency_minor, l.bani) ELSE -COALESCE(l.currency_minor, l.bani) END) AS minor
        FROM acc_open_items o
        JOIN acc_lines l ON l.company_id = o.company_id AND l.open_item_id = o.id
        WHERE o.company_id = NEW.company_id
          AND o.id IN (SELECT open_item_id FROM acc_lines WHERE ${thisEntry} AND open_item_id IS NOT NULL)
        GROUP BY o.id)
      WHERE (may_reverse = 0 AND CASE normal_side WHEN 'D' THEN bani < 0 OR minor < 0 ELSE bani > 0 OR minor > 0 END)
        OR (currency <> 'RON' AND minor = 0 AND bani <> 0))`,
  },
  {
    code: 'tax_entries_mismatch',
    rule: "The entry's tax entries are exactly those of the approved effect.",
    violation: differsFromEffect({
      table: 'acc_tax_entries',
      alias: 't',
      rows: `t.company_id = NEW.company_id AND t.entry_id = NEW.id`,
      items: `json_each(${effect}, '$.taxEntries') j`,
      expectedCount: `json_array_length(${effect}, '$.taxEntries')`,
      key: 't.tax_no = j.key + 1',
      fields: taxEntryFields,
    }),
  },
  {
    code: 'tax_line',
    rule: 'A line on a tax account is either a period settlement or exactly the sum of its tax entries, all in one direction; other lines carry neither.',
    violation: `EXISTS (
      SELECT 1 FROM inv_tax_lines t
      JOIN inv_line_controls c ON c.company_id = t.company_id AND c.entry_id = t.entry_id AND c.line_no = t.line_no
      WHERE t.company_id = NEW.company_id AND t.entry_id = NEW.id
        AND CASE WHEN c.tax_account
          THEN t.settlement = (t.entries > 0) OR t.directions > 1 OR (t.entries > 0 AND t.linked <> t.booked)
          ELSE t.settlement OR t.entries > 0 END)
      OR EXISTS (
        SELECT 1 FROM acc_tax_entries t
        WHERE t.company_id = NEW.company_id AND t.entry_id = NEW.id AND t.line_no IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM acc_lines l WHERE l.company_id = t.company_id AND l.entry_id = t.entry_id AND l.line_no = t.line_no))`,
  },
  {
    code: 'tax_period_locked',
    rule: 'No tax entry is added to a tax period locked by a filed declaration.',
    violation: `EXISTS (
      SELECT 1 FROM acc_tax_entries t
      WHERE t.company_id = NEW.company_id AND t.entry_id = NEW.id AND t.tax_period IS NOT NULL
        AND (SELECT kind FROM acc_tax_period_events e
             WHERE e.company_id = t.company_id AND e.tax = t.tax AND e.period = t.tax_period
             ORDER BY e.seq DESC LIMIT 1) = 'lock')`,
  },
  {
    code: 'schedule_mismatch',
    rule: 'The schedule rows this entry writes are exactly those of the approved effect.',
    violation: differsFromEffect({
      table: 'acc_schedule_rows',
      alias: 'w',
      rows: `w.company_id = NEW.company_id AND w.entry_id = NEW.id`,
      items: `json_each(${effect}, '$.schedules') s, json_each(s.value, '$.rows') r`,
      expectedCount: `COALESCE((SELECT sum(json_array_length(s.value, '$.rows')) FROM json_each(${effect}, '$.schedules') s), 0)`,
      key: `w.schedule_id = json_extract(s.value, '$.ref') AND w.row_key = json_extract(r.value, '$.key')`,
      fields: scheduleRowFields,
    }),
  },
  {
    code: 'stale_read',
    rule: "The open items, schedules and tax periods the proposal read have not changed since: an open item's version is its number of lines, a schedule's its latest version, a tax period's its tax entries, settlement lines and last entry sequence.",
    violation: `EXISTS (
      SELECT 1 FROM json_each(${version('read_set_json')}) r
      WHERE (json_extract(r.value, '$.kind') = 'taxPeriod'
          AND json_extract(r.value, '$.version') <> ${taxPeriodVersion("json_extract(r.value, '$.id')")})
        OR (json_extract(r.value, '$.kind') = 'openItem'
          AND json_extract(r.value, '$.version') <> CAST((
            SELECT count(*) FROM acc_lines l
            WHERE l.company_id = NEW.company_id AND l.open_item_id = json_extract(r.value, '$.id')
              AND l.entry_id <> NEW.id) AS TEXT))
        OR (json_extract(r.value, '$.kind') = 'schedule'
          AND json_extract(r.value, '$.version') <> CAST(COALESCE((
            SELECT max(version) FROM acc_schedule_rows w
            WHERE w.company_id = NEW.company_id AND w.schedule_id = json_extract(r.value, '$.id')
              AND w.entry_id <> NEW.id), 0) AS TEXT)))`,
  },
];

const approvalChecks: Check[] = [
  {
    code: 'proposal_version_missing',
    rule: 'An approval names an existing proposal version.',
    violation: `${version('1')} IS NULL`,
  },
  {
    code: 'stale_version',
    rule: 'Only the latest version can be approved.',
    violation: `NOT ${isLatestVersion}`,
  },
  {
    code: 'stale_approval',
    rule: 'An approval binds the exact effect hash of that version.',
    violation: `${version('effect_hash')} <> NEW.effect_hash`,
  },
  {
    code: 'blocking_issues',
    rule: 'A version with blocking issues cannot be approved.',
    violation: `${version('blocking')} <> 0`,
  },
  { code: 'withdrawn', rule: 'A withdrawn proposal cannot be approved.', violation: isWithdrawn },
  { code: 'already_posted', rule: 'A posted proposal needs no approval.', violation: isPosted },
  {
    code: 'approver',
    rule: 'The approver is a current owner or reviewer.',
    violation: `NOT ${isReviewer('NEW.approver_id', 'NEW.approver_epoch')}`,
  },
];

const periodEventChecks: Check[] = [
  {
    code: 'period_sequence',
    rule: 'Close and reopen events of a month are numbered without gaps and alternate, starting with a close.',
    violation: `NEW.seq <> 1 + COALESCE((
        SELECT max(seq) FROM acc_period_events WHERE company_id = NEW.company_id AND month = NEW.month), 0)
      OR COALESCE(${latest('acc_period_events', 'month = NEW.month')}, 'reopen') = NEW.kind`,
  },
  {
    code: 'not_approved',
    rule: 'Every close or reopen executes an approved action review.',
    violation: `(SELECT decision FROM acc_action_decisions
      WHERE company_id = NEW.company_id AND request_id = NEW.action_id) IS NOT 'approve'`,
  },
  {
    code: 'period_order',
    rule: 'A month closes only after every earlier month with entries is closed.',
    violation: `NEW.kind = 'close' AND EXISTS (
      SELECT 1 FROM acc_entries e
      WHERE e.company_id = NEW.company_id AND e.period < NEW.month
        AND COALESCE((SELECT kind FROM acc_period_events p
          WHERE p.company_id = e.company_id AND p.month = e.period ORDER BY p.seq DESC LIMIT 1), 'reopen') <> 'close')`,
  },
  {
    code: 'period_watermark',
    rule: "A close records the company's latest entry sequence as its watermark.",
    violation: `NEW.kind = 'close' AND NEW.watermark_seq <> COALESCE((
      SELECT max(seq) FROM acc_entries WHERE company_id = NEW.company_id), 0)`,
  },
  {
    code: 'period_chain',
    rule: "Period events form a hash chain: each records the company's previous event hash.",
    violation: `NEW.prev_hash <> COALESCE((
      SELECT hash FROM acc_period_events WHERE company_id = NEW.company_id ORDER BY rowid DESC LIMIT 1), '')`,
  },
];

const issuedKind = `CASE NEW.type_code WHEN '381' THEN 'creditNote.issued' ELSE 'invoice.issued' END`;
const issuedNumberChecks: Check[] = [
  {
    code: 'series_sequence',
    rule: 'A series issues consecutive numbers from its first number, without gaps.',
    violation: `NEW.number IS NOT COALESCE(
        (SELECT max(number) + 1 FROM acc_issued_numbers
          WHERE company_id = NEW.company_id AND series_id = NEW.series_id),
        (SELECT first_number FROM acc_series WHERE company_id = NEW.company_id AND id = NEW.series_id))`,
  },
  {
    code: 'series_date_order',
    rule: 'Within a series, a later number never has an earlier issue date.',
    violation: `NEW.issue_date < COALESCE((
        SELECT max(issue_date) FROM acc_issued_numbers
        WHERE company_id = NEW.company_id AND series_id = NEW.series_id), '')`,
  },
  {
    code: 'series_type',
    rule: 'A series issues only the document types it was created for.',
    violation: `NOT EXISTS (
        SELECT 1 FROM acc_series s, json_each(s.type_codes_json) t
        WHERE s.company_id = NEW.company_id AND s.id = NEW.series_id AND t.value = NEW.type_code)`,
  },
  {
    code: 'series_document',
    rule: 'The numbered document is an issued invoice or credit note of that type, dated on the issue date and carrying the series prefix and padded number.',
    violation: `NOT EXISTS (
        SELECT 1 FROM acc_documents d
        JOIN acc_series s ON s.company_id = d.company_id AND s.id = NEW.series_id
        WHERE d.company_id = NEW.company_id AND d.id = NEW.document_id
          AND d.kind = ${issuedKind} AND d.doc_date = NEW.issue_date
          AND d.number = s.prefix || printf('%0' || s.width || 'd', NEW.number))`,
  },
  {
    code: 'number_reused',
    rule: 'No other sales document, issued or imported, carries the same number.',
    violation: `EXISTS (
        SELECT 1 FROM acc_documents d
        JOIN acc_documents numbered ON numbered.company_id = d.company_id AND numbered.id = NEW.document_id
        WHERE d.company_id = NEW.company_id AND d.id <> NEW.document_id
          AND d.kind IN ('invoice.issued', 'creditNote.issued') AND d.number = numbered.number)`,
  },
  {
    code: 'party_versions',
    rule: "The invoice records the versions of the company's own details and of the buyer's that it used.",
    violation: `NOT EXISTS (
        SELECT 1 FROM acc_party_versions v JOIN acc_parties p ON p.company_id = v.company_id AND p.id = v.party_id
        WHERE v.company_id = NEW.company_id AND p.kind = 'self' AND v.version = NEW.seller_version)
      OR NOT EXISTS (
        SELECT 1 FROM acc_party_versions v JOIN acc_documents d ON d.company_id = v.company_id AND d.party_id = v.party_id
        WHERE v.company_id = NEW.company_id AND d.id = NEW.document_id AND v.version = NEW.buyer_version)`,
  },
];

/** The latest state of a submission, or NULL before its first event. */
const submissionState = (submission: string) => `(
      SELECT state FROM acc_submission_events
      WHERE company_id = NEW.company_id AND submission_id = ${submission} ORDER BY seq DESC LIMIT 1)`;
const submissionChecks: Check[] = [
  {
    code: 'submission_document',
    rule: "A submission sends an issued invoice or credit note's own kept XML.",
    violation: `NOT EXISTS (
        SELECT 1 FROM acc_documents d JOIN acc_evidence e ON e.company_id = d.company_id AND e.id = NEW.evidence_id
        WHERE d.company_id = NEW.company_id AND d.id = NEW.document_id
          AND d.kind IN ('invoice.issued', 'creditNote.issued') AND e.hash = NEW.xml_hash)`,
  },
  {
    code: 'submission_open',
    rule: 'A document is submitted again only after its earlier submission was rejected or confirmed absent: an uncertain upload is never resent.',
    violation: `EXISTS (
        SELECT 1 FROM acc_submissions s
        WHERE s.company_id = NEW.company_id AND s.document_id = NEW.document_id AND s.id <> NEW.id
          AND COALESCE(${submissionState('s.id')}, 'authorized') NOT IN ('rejected', 'absent'))`,
  },
];
const submissionEventChecks: Check[] = [
  {
    code: 'submission_sequence',
    rule: 'Submission steps are numbered from 1 without gaps.',
    violation: `NEW.seq <> 1 + COALESCE((
        SELECT max(seq) FROM acc_submission_events
        WHERE company_id = NEW.company_id AND submission_id = NEW.submission_id), 0)`,
  },
  {
    code: 'submission_transition',
    rule: 'A submission is authorized, then marked submitting before the request leaves; it ends submitted or uncertain, then accepted or rejected; only an uncertain one can be confirmed absent.',
    violation: `NOT CASE ${submissionState('NEW.submission_id')}
        WHEN 'authorized' THEN NEW.state = 'submitting'
        WHEN 'submitting' THEN NEW.state IN ('submitted', 'uncertain')
        WHEN 'submitted' THEN NEW.state IN ('accepted', 'rejected')
        WHEN 'uncertain' THEN NEW.state IN ('accepted', 'rejected', 'absent')
        ELSE ${submissionState('NEW.submission_id')} IS NULL AND NEW.state = 'authorized' END`,
  },
  {
    code: 'submission_receipt',
    rule: "A submitted step records ANAF's upload index; an accepted or rejected one, its message.",
    violation: `(NEW.state = 'submitted' AND NEW.upload_id IS NULL)
      OR (NEW.state IN ('accepted', 'rejected') AND NEW.download_id IS NULL)`,
  },
];

// 3. Triggers

type Trigger = { name: string; on: string; checks: Check[] };

const triggers: Trigger[] = [
  ...appendOnly.flatMap((table): Trigger[] =>
    (['UPDATE', 'DELETE'] as const).map((operation) => ({
      name: `inv_${table}_no_${operation.toLowerCase()}`,
      on: `BEFORE ${operation} ON ${table}`,
      checks: [{ code: 'immutable_record', rule: 'Recorded rows never change.', violation: '1' }],
    })),
  ),
  ...neverDeleted.map((table): Trigger => ({
    name: `inv_${table}_no_delete`,
    on: `BEFORE DELETE ON ${table}`,
    checks: [{ code: 'immutable_record', rule: 'Rows are never deleted.', violation: '1' }],
  })),
  ...(
    [
      ['acc_lines', 'entry_id'],
      ['acc_open_items', 'origin_entry_id'],
      ['acc_tax_entries', 'entry_id'],
      ['acc_schedule_rows', 'entry_id'],
    ] as const
  ).map(([table, entry]): Trigger => ({
    name: `inv_${table}_sealed`,
    on: `BEFORE INSERT ON ${table}`,
    checks: [
      {
        code: 'sealed_entry',
        rule: 'Rows join an entry only before its header is written; the header seals it.',
        violation: `EXISTS (SELECT 1 FROM acc_entries WHERE company_id = NEW.company_id AND id = NEW.${entry})`,
      },
    ],
  })),
  { name: 'inv_entry_guard', on: 'BEFORE INSERT ON acc_entries', checks: entryChecks },
  { name: 'inv_approval_guard', on: 'BEFORE INSERT ON acc_approvals', checks: approvalChecks },
  {
    name: 'inv_proposal_version_guard',
    on: 'BEFORE INSERT ON acc_proposal_versions',
    checks: [
      {
        code: 'proposal_version',
        rule: 'Proposal versions are numbered without gaps.',
        violation: `NEW.version <> 1 + COALESCE((
          SELECT max(version) FROM acc_proposal_versions
          WHERE company_id = NEW.company_id AND proposal_id = NEW.proposal_id), 0)`,
      },
      { code: 'already_posted', rule: 'A posted proposal cannot be revised.', violation: isPosted },
      {
        code: 'withdrawn',
        rule: 'A withdrawn proposal cannot be revised.',
        violation: isWithdrawn,
      },
    ],
  },
  {
    name: 'inv_proposal_subject',
    on: 'BEFORE INSERT ON acc_proposals',
    checks: [
      {
        code: 'subject_taken',
        rule: 'A subject has at most one proposal that is not withdrawn.',
        violation: `EXISTS (
          SELECT 1 FROM acc_proposals p
          WHERE p.company_id = NEW.company_id AND p.subject_key = NEW.subject_key
            AND NOT EXISTS (
              SELECT 1 FROM acc_withdrawals w WHERE w.company_id = p.company_id AND w.proposal_id = p.id))`,
      },
    ],
  },
  {
    name: 'inv_withdrawal_guard',
    on: 'BEFORE INSERT ON acc_withdrawals',
    checks: [
      {
        code: 'already_posted',
        rule: 'A posted proposal cannot be withdrawn.',
        violation: isPosted,
      },
    ],
  },
  {
    name: 'inv_policy_guard',
    on: 'BEFORE INSERT ON acc_posting_policies',
    checks: [
      {
        code: 'approver',
        rule: 'A posting policy is approved by a current owner or reviewer.',
        violation: `NOT ${isReviewer('NEW.approved_by', 'NEW.approver_epoch')}`,
      },
    ],
  },
  {
    name: 'inv_action_decision_guard',
    on: 'BEFORE INSERT ON acc_action_decisions',
    checks: [
      {
        code: 'stale_approval',
        rule: 'A decision binds the exact preview it reviewed.',
        violation: `(SELECT preview_hash FROM acc_action_requests
          WHERE company_id = NEW.company_id AND id = NEW.request_id) IS NOT NEW.preview_hash`,
      },
      {
        code: 'approver',
        rule: 'Actions are decided by a current owner or reviewer.',
        violation: `NOT ${isReviewer('NEW.decided_by', 'NEW.decided_epoch')}`,
      },
    ],
  },
  {
    name: 'inv_action_execution_guard',
    on: 'BEFORE INSERT ON acc_action_executions',
    checks: [
      {
        code: 'not_approved',
        rule: 'Only an approved action is executed.',
        violation: `(SELECT decision FROM acc_action_decisions
          WHERE company_id = NEW.company_id AND request_id = NEW.request_id) IS NOT 'approve'`,
      },
    ],
  },
  {
    name: 'inv_period_event_guard',
    on: 'BEFORE INSERT ON acc_period_events',
    checks: periodEventChecks,
  },
  {
    name: 'inv_tax_period_event_guard',
    on: 'BEFORE INSERT ON acc_tax_period_events',
    checks: [
      {
        code: 'tax_period_sequence',
        rule: 'Lock and unlock events of a tax period are numbered without gaps and alternate, starting with a lock.',
        violation: `NEW.seq <> 1 + COALESCE((
            SELECT max(seq) FROM acc_tax_period_events
            WHERE company_id = NEW.company_id AND tax = NEW.tax AND period = NEW.period), 0)
          OR COALESCE(${latest('acc_tax_period_events', 'tax = NEW.tax AND period = NEW.period')}, 'unlock') = NEW.kind`,
      },
    ],
  },
  {
    name: 'inv_membership_update',
    on: 'BEFORE UPDATE ON acc_memberships',
    checks: [
      {
        code: 'immutable_record',
        rule: 'A membership keeps its company and user.',
        violation: 'NEW.company_id <> OLD.company_id OR NEW.user_id <> OLD.user_id',
      },
      {
        code: 'membership_epoch',
        rule: 'A role or status change increments the epoch by exactly one; nothing else changes it.',
        violation: `NEW.epoch <> OLD.epoch + (NEW.role <> OLD.role OR NEW.active <> OLD.active)`,
      },
    ],
  },
  {
    name: 'inv_grant_insert',
    on: 'BEFORE INSERT ON acc_agent_grants',
    checks: [
      {
        code: 'grant_epoch',
        rule: "An agent grant is bound to its issuer's current, active membership.",
        violation: `NOT EXISTS (
          SELECT 1 FROM acc_memberships m
          WHERE m.company_id = NEW.company_id AND m.user_id = NEW.created_by
            AND m.active = 1 AND m.epoch = NEW.membership_epoch)`,
      },
    ],
  },
  {
    name: 'inv_grant_update',
    on: 'BEFORE UPDATE ON acc_agent_grants',
    checks: [
      {
        code: 'immutable_record',
        rule: 'A grant can only be revoked, once; nothing else about it changes.',
        violation: `OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
          OR (NEW.id, NEW.company_id, NEW.name, NEW.token_hash, NEW.scopes, NEW.membership_epoch, NEW.expires_at, NEW.created_by)
            IS NOT (OLD.id, OLD.company_id, OLD.name, OLD.token_hash, OLD.scopes, OLD.membership_epoch, OLD.expires_at, OLD.created_by)`,
      },
    ],
  },
  {
    name: 'inv_invitation_update',
    on: 'BEFORE UPDATE ON acc_invitations',
    checks: [
      {
        code: 'immutable_record',
        rule: 'An invitation can only be accepted, once; nothing else about it changes.',
        violation: `OLD.accepted_at IS NOT NULL OR NEW.accepted_at IS NULL
          OR (NEW.id, NEW.company_id, NEW.email, NEW.role, NEW.token_hash, NEW.expires_at)
            IS NOT (OLD.id, OLD.company_id, OLD.email, OLD.role, OLD.token_hash, OLD.expires_at)`,
      },
    ],
  },
  {
    name: 'inv_account_update',
    on: 'BEFORE UPDATE ON acc_accounts',
    checks: [
      {
        code: 'immutable_record',
        rule: 'An account can only be closed (given an end date), once; nothing else about it changes.',
        violation: `OLD.valid_to IS NOT NULL OR NEW.valid_to IS NULL
          OR (NEW.company_id, NEW.code, NEW.parent_code, NEW.name, NEW.nature, NEW.book, NEW.postable,
              NEW.control_kind, NEW.saft_account, NEW.valid_from, NEW.chart_version)
            IS NOT (OLD.company_id, OLD.code, OLD.parent_code, OLD.name, OLD.nature, OLD.book, OLD.postable,
              OLD.control_kind, OLD.saft_account, OLD.valid_from, OLD.chart_version)`,
      },
      {
        code: 'account_in_use',
        rule: 'An account cannot be closed before its last posted line.',
        violation: `EXISTS (
          SELECT 1 FROM acc_lines l JOIN acc_entries e ON e.company_id = l.company_id AND e.id = l.entry_id
          WHERE l.company_id = NEW.company_id AND l.account = NEW.code AND e.date > NEW.valid_to)`,
      },
    ],
  },
  {
    name: 'inv_fiscal_year_overlap',
    on: 'BEFORE INSERT ON acc_fiscal_years',
    checks: [
      {
        code: 'year_overlap',
        rule: 'Years of the same kind do not overlap.',
        violation: `EXISTS (
          SELECT 1 FROM acc_fiscal_years y
          WHERE y.company_id = NEW.company_id AND y.kind = NEW.kind
            AND y.date_from <= NEW.date_to AND NEW.date_from <= y.date_to)`,
      },
    ],
  },
  {
    name: 'inv_party_version_guard',
    on: 'BEFORE INSERT ON acc_party_versions',
    checks: [
      {
        code: 'party_version_sequence',
        rule: "A party's detail versions are numbered from 1 without gaps.",
        violation: `NEW.version <> 1 + COALESCE((
          SELECT max(version) FROM acc_party_versions
          WHERE company_id = NEW.company_id AND party_id = NEW.party_id), 0)`,
      },
    ],
  },
  {
    name: 'inv_issued_number_guard',
    on: 'BEFORE INSERT ON acc_issued_numbers',
    checks: issuedNumberChecks,
  },
  {
    name: 'inv_submission_guard',
    on: 'BEFORE INSERT ON acc_submissions',
    checks: submissionChecks,
  },
  {
    name: 'inv_submission_event_guard',
    on: 'BEFORE INSERT ON acc_submission_events',
    checks: submissionEventChecks,
  },
  {
    name: 'inv_spv_window_guard',
    on: 'BEFORE INSERT ON acc_spv_sync_windows',
    checks: [
      {
        code: 'spv_window_sequence',
        rule: 'Synced windows are numbered from 1 without gaps.',
        violation: `NEW.seq <> 1 + COALESCE((
          SELECT max(seq) FROM acc_spv_sync_windows WHERE company_id = NEW.company_id), 0)`,
      },
    ],
  },
  {
    name: 'inv_audit_chain',
    on: 'BEFORE INSERT ON acc_audit',
    checks: [
      {
        code: 'audit_chain',
        rule: "Audit rows are numbered without gaps and each records the previous row's hash.",
        violation: `NEW.seq <> 1 + COALESCE((SELECT max(seq) FROM acc_audit WHERE company_id = NEW.company_id), 0)
          OR NEW.prev_hash <> COALESCE((
            SELECT hash FROM acc_audit WHERE company_id = NEW.company_id ORDER BY seq DESC LIMIT 1), '')`,
      },
    ],
  },
];

function triggerSql({ name, on, checks }: Trigger) {
  const body = checks
    .map(({ code, rule, violation }) =>
      violation === '1'
        ? `  -- ${rule}\n  SELECT ${raise(code)};`
        : `  -- ${rule}\n  SELECT CASE WHEN ${violation}\n  THEN ${raise(code)} END;`,
    )
    .join('\n\n');
  return `CREATE TRIGGER ${name} ${on} BEGIN\n${body}\nEND`;
}

export type Invariant = { name: string; type: 'view' | 'trigger'; sql: string; checksum: string };

/** Every view and trigger, in installation order (views first: triggers query them). */
export function invariants(): Invariant[] {
  return [
    ...Object.entries(views).map(([name, body]) => ({
      name,
      type: 'view' as const,
      sql: `CREATE VIEW ${name} AS${body}`,
    })),
    ...triggers.map((trigger) => ({
      name: trigger.name,
      type: 'trigger' as const,
      sql: triggerSql(trigger),
    })),
  ].map((item) => ({ ...item, checksum: sha256Hex(item.sql) }));
}

/** Every rule the database enforces, for documentation and for the test that covers each code. */
export function invariantRules() {
  return triggers.flatMap((trigger) =>
    trigger.checks.map(({ code, rule }) => ({ trigger: trigger.name, code, rule })),
  );
}

/** Installs missing or changed invariants and removes obsolete ones, atomically. */
export async function ensureInvariants(client: Client) {
  const wanted = invariants();
  const transaction = await client.transaction('write');
  try {
    await transaction.execute(
      'CREATE TABLE IF NOT EXISTS acc_invariants (name text PRIMARY KEY NOT NULL, checksum text NOT NULL)',
    );
    const installed = (
      await transaction.execute(
        `SELECT s.name, s.type, i.checksum FROM sqlite_master s
         LEFT JOIN acc_invariants i ON i.name = s.name
         WHERE s.type IN ('view', 'trigger') AND s.name LIKE 'inv\\_%' ESCAPE '\\'`,
      )
    ).rows.map((row) => ({
      name: String(row.name),
      type: String(row.type),
      checksum: row.checksum === null ? null : String(row.checksum),
    }));
    // Drop everything stale first: a changed view may be referenced by unchanged triggers.
    const current = (item: Invariant) =>
      installed.some((row) => row.name === item.name && row.checksum === item.checksum);
    for (const row of installed)
      if (!wanted.some((item) => item.name === row.name && current(item))) {
        await transaction.execute(`DROP ${row.type === 'view' ? 'VIEW' : 'TRIGGER'} ${row.name}`);
        await transaction.execute({
          sql: 'DELETE FROM acc_invariants WHERE name = ?',
          args: [row.name],
        });
      }
    for (const item of wanted) {
      if (current(item)) continue;
      await transaction.execute(item.sql);
      await transaction.execute({
        sql: `INSERT INTO acc_invariants (name, checksum) VALUES (?, ?)
              ON CONFLICT(name) DO UPDATE SET checksum = excluded.checksum`,
        args: [item.name, item.checksum],
      });
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
}
