import type { Client } from '@libsql/client';
import { sha256Hex } from 'xfactura-core/hash';
import { stockAccountSynthetics } from 'xfactura-core/kernel';

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

/** A CNP's shape in a GLOB: 13 digits. */
const cnpDigits = '[0-9]'.repeat(13);

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
  'acc_bank_mappings',
  'acc_party_versions',
  'acc_series',
  'acc_issued_numbers',
  'acc_submissions',
  'acc_submission_events',
  'acc_spv_messages',
  'acc_spv_sync_windows',
  'acc_artifacts',
  'acc_artifact_events',
  'acc_employees',
  'acc_employment_terms',
  'acc_payroll_runs',
  'acc_payroll_run_events',
  'acc_payroll_lines',
  'acc_garnishments',
  'acc_garnishment_releases',
  'acc_reges_records',
  'acc_assets',
  'acc_asset_events',
  'acc_asset_fiscal',
  'acc_anaf_connections',
  'acc_party_cnps',
  'acc_party_status',
  'acc_income_sources',
  'acc_enterprise_members',
  'acc_questions',
  'acc_question_answers',
  'acc_question_withdrawals',
  'acc_dispositions',
  'acc_templates',
  'acc_template_revocations',
  'acc_template_predictions',
  'acc_automation_events',
  'acc_automation_criteria',
  'acc_stock_items',
  'acc_warehouses',
  'acc_stock_layers',
  'acc_stock_moves',
  'acc_cash_registers',
  'acc_cash_register_events',
  'acc_boms',
  'acc_bom_lines',
  'acc_work_orders',
  'acc_work_order_events',
  'ref_fx_rates',
];
// Tables with narrowly guarded updates (below) that are never deleted from.
const neverDeleted = ['acc_memberships', 'acc_agent_grants', 'acc_invitations', 'acc_accounts'];
/** Tables outside the invariant regime: authentication, work queues, schedules, consumers'
 * cursors, caches recomputed from the books, and bookkeeping. */
export const mutableTables = [
  'user',
  'session',
  'account',
  'verification',
  'acc_jobs',
  'acc_outbox',
  'acc_schedules',
  'acc_cursors',
  'acc_proposal_checks',
  'acc_invariants',
  '__drizzle_migrations',
];
export const guardedTables = [...appendOnly, ...neverDeleted];

// 1. Views

const views: Record<string, string> = {
  // Each posted line with its account's control and the open item it names. `control_ok`: lines
  // on open-item control accounts (4111, 401, 471, …) name a matching item; others (tax, retail
  // price, uncontrolled) name none.
  inv_line_controls: `
    SELECT l.company_id, l.entry_id, l.line_no,
      a.code IS NOT NULL AND a.postable = 1 AS postable,
      a.valid_from, a.valid_to,
      COALESCE(a.control_kind, '') = 'tax' AS tax_account,
      CASE WHEN COALESCE(a.control_kind, 'tax') IN ('tax', 'retail') THEN l.open_item_id IS NULL
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

/** A statement an agent transcribed from a PDF or a photo (`bank.recordStatement`) with a
 * citation no text layer verified: its movements are read from an image, as an extracted
 * document is, and a policy posts them only where `extracted` is allowed. */
const unverifiedTranscription = (s: string) => `(${s}.format = 'transcribed' AND (
  json_type(${s}.citations_json, '$.items') IS NOT 'array'
  OR EXISTS (SELECT 1 FROM json_each(${s}.citations_json, '$.items') c
    WHERE json_extract(c.value, '$.status') IS NOT 'verified')))`;

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
/**
 * The posted entry `entry` (an alias of acc_entries) stands: no reversal of it was posted. A
 * correction is a reversal and a new proposal, so the subject of a reversed entry is free again.
 */
const stands = (entry: string) => `NOT EXISTS (
          SELECT 1 FROM acc_proposals rv JOIN acc_entries re ON re.company_id = rv.company_id AND re.proposal_id = rv.id
          WHERE rv.company_id = ${entry}.company_id AND rv.subject_key = 'reverse:' || ${entry}.id)`;
/** The proposal `proposal` (an alias of acc_proposals) holds its subject: not withdrawn, and not
 * posted by an entry reversed since. */
const holdsSubject = (proposal: string) => `NOT EXISTS (
              SELECT 1 FROM acc_withdrawals w WHERE w.company_id = ${proposal}.company_id AND w.proposal_id = ${proposal}.id)
            AND NOT EXISTS (
              SELECT 1 FROM acc_entries he WHERE he.company_id = ${proposal}.company_id AND he.proposal_id = ${proposal}.id
                AND NOT ${stands('he')})`;
/** An active owner or reviewer whose membership has not changed since the given epoch. */
const isReviewer = (user: string, epoch: string) => `EXISTS (
      SELECT 1 FROM acc_memberships m
      WHERE m.company_id = NEW.company_id AND m.user_id = ${user}
        AND m.active = 1 AND m.role IN ('owner', 'reviewer') AND m.epoch = ${epoch})`;
/**
 * The engine's time of the row being written, in milliseconds: its `engine_at`, which the
 * application takes from the engine's clock, as every decision on time does (tests and the
 * evaluation harness run the engine at another time than the wall's). The database's own clock
 * for a row written without it.
 */
const engineNow = `COALESCE(NEW.engine_at, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))`;
/** The UTC date of the engine's time, or `offset` from it (`'+1 day'`). */
const engineDate = (offset?: string) =>
  `date(${engineNow} / 1000, 'unixepoch'${offset ? `, '${offset}'` : ''})`;
/** The segregation of duties (`controls.segregation`) in force on a date: 0 off, 1 on, 2 strict. */
const segregationOn = (date: string) => `COALESCE((
        SELECT CASE f.value WHEN 'strict' THEN 2 WHEN 'on' THEN 1 ELSE 0 END FROM acc_profile_facts f
        WHERE f.company_id = NEW.company_id AND f.axis = 'controls.segregation' AND f.effective_from <= ${date}
          AND NOT EXISTS (
            SELECT 1 FROM acc_profile_facts g WHERE g.company_id = f.company_id AND g.supersedes_id = f.id)
        ORDER BY f.effective_from DESC, f.created_at DESC, f.id DESC LIMIT 1), 0)`;
/**
 * Whether segregation forbids `person` approving work created by `creator` (through `agent`): on,
 * their own work without an agent; strict, also their agents'. The application reads the fact on
 * the engine's Bucharest date, which is the UTC date of the row's engine time or the next day; the
 * lenient of the two is applied here so the database never refuses what the application allowed.
 */
const selfApproval = (person: string, creator: string, agent: string) => `(${person} = ${creator}
      AND min(${segregationOn(engineDate())}, ${segregationOn(engineDate('+1 day'))})
        >= CASE WHEN ${agent} IS NULL THEN 1 ELSE 2 END)`;
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
/** A payroll run's read version: its result hash and latest state. */
const payrollRunVersion = (id: string) => `(
        SELECT r.result_hash || '/' || (
          SELECT state FROM acc_payroll_run_events e
          WHERE e.company_id = r.company_id AND e.run_id = r.id ORDER BY e.seq DESC LIMIT 1)
        FROM acc_payroll_runs r WHERE r.company_id = NEW.company_id AND r.id = ${id})`;
/** A party's status read for a date, as the state loader records it for `${partyId}|${date}`:
 * the number of the latest snapshot taken for exactly that date, 0 when there is none. */
const partyStatusVersion = (id: string) => `CAST(COALESCE((
        SELECT max(s.seq) FROM acc_party_status s
        WHERE s.company_id = NEW.company_id AND s.party_id = substr(${id}, 1, instr(${id}, '|') - 1)
          AND s.as_of = substr(${id}, instr(${id}, '|') + 1)), 0) AS TEXT)`;
/** Whether `date` falls in a financial year whose latest executed reviewed action of the year
 * (`years.close` or `years.reopen`, kernel actions) is a close. */
/** The financial year `y` is locked: its latest year close or reopening executed is a close. */
const closedYear = `(SELECT r.operation FROM acc_action_requests r
          JOIN acc_action_executions x ON x.company_id = r.company_id AND x.request_id = r.id
          WHERE r.company_id = y.company_id AND r.operation IN ('years.close', 'years.reopen')
            AND json_extract(r.input_json, '$.financialYearId') = y.id
          ORDER BY x.rowid DESC LIMIT 1) = 'years.close'`;
const lockedYear = (date: string) => `EXISTS (
      SELECT 1 FROM acc_fiscal_years y
      WHERE y.company_id = NEW.company_id AND y.kind = 'financial'
        AND ${date} BETWEEN y.date_from AND y.date_to
        AND ${closedYear})`;
/** A locked financial year ends on or after `date`: a date in it, or before it. */
const lockedThrough = (date: string) => `EXISTS (
      SELECT 1 FROM acc_fiscal_years y
      WHERE y.company_id = NEW.company_id AND y.kind = 'financial' AND ${date} <= y.date_to
        AND ${closedYear})`;
/** A proposal's subject reverses an entry: its entry is a storno, journal and all. */
const isStorno = (proposal: string) => `(SELECT subject_key FROM acc_proposals
        WHERE company_id = NEW.company_id AND id = ${proposal}) LIKE 'reverse:%'`;
const latest = (table: string, scope: string) =>
  `(SELECT kind FROM ${table} WHERE company_id = NEW.company_id AND ${scope} ORDER BY seq DESC LIMIT 1)`;
/** The id of a question's latest answer, NULL while it has none. */
const latestAnswer = (question: string) => `(
        SELECT a.id FROM acc_question_answers a
        WHERE a.company_id = NEW.company_id AND a.question_id = ${question} ORDER BY a.seq DESC LIMIT 1)`;
/** The media type answers are kept as evidence with. */
export const answerMediaType = 'application/vnd.xfactura.answer+json';
/** The engine's own principal (`SYSTEM_PRINCIPAL` in kernel/automation.ts): never a member. */
const systemPrincipal = `'system'`;
/** The latest pause or resume of an automation scope, 'resume' when there is none. */
const automationState = (scope: string, id: string) => `COALESCE((
        SELECT a.kind FROM acc_automation_events a
        WHERE a.company_id = NEW.company_id AND a.scope = '${scope}' AND a.scope_id IS ${id}
        ORDER BY a.seq DESC LIMIT 1), 'resume')`;
const thisEntry = `company_id = NEW.company_id AND entry_id = NEW.id`;
/**
 * Whether `column` is an account the stock register explains by quantity: a synthetic of
 * `stockAccountSynthetics` (xfactura-core/kernel), with at most one more digit and analytics,
 * as `isStockAccount` reads it.
 */
const stockAccount = (column: string) => `(substr(${column}, 1, 3) IN (${stockAccountSynthetics
  .map((code) => `'${code}'`)
  .join(', ')})
      AND (length(${column}) = 3 OR substr(${column}, 4, 1) = '.'
        OR (substr(${column}, 4, 1) GLOB '[0-9]' AND (length(${column}) = 4 OR substr(${column}, 5, 1) = '.'))))`;
/** A stock position's read version, as the state loader records it for `item|warehouse`, or for
 * the whole register (`*`): the moves posted on it, excluding the entry being posted. A position
 * is counted on its own index (`stock_move_position`), not by scanning the register. */
const stockVersion = (id: string) => `CAST(CASE WHEN ${id} = '*' THEN (
          SELECT count(*) FROM acc_stock_moves m
          WHERE m.company_id = NEW.company_id AND m.entry_id <> NEW.id)
        ELSE (
          SELECT count(*) FROM acc_stock_moves m
          WHERE m.company_id = NEW.company_id
            AND m.item_id = substr(${id}, 1, instr(${id}, '|') - 1)
            AND m.warehouse_id = substr(${id}, instr(${id}, '|') + 1)
            AND m.entry_id <> NEW.id) END AS TEXT)`;

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
const stockLayerFields: Field[] = [
  { column: 'item_id', path: '$.item' },
  { column: 'warehouse_id', path: '$.warehouse' },
  { column: 'account', path: '$.account' },
  { column: 'method', path: '$.method' },
  { column: 'date', path: '$.date' },
  { column: 'may_go_negative', path: '$.mayGoNegative' },
];
const stockMoveFields: Field[] = [
  { column: 'item_id', path: '$.item' },
  { column: 'warehouse_id', path: '$.warehouse' },
  { column: 'account', path: '$.account' },
  { column: 'layer_id', path: '$.layer' },
  { column: 'quantity', path: '$.quantity', type: 'integer' },
  { column: 'bani', path: '$.bani', type: 'integer' },
  { column: 'line_no', path: '$.line', type: 'lineIndex' },
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
    rule: 'A subject (document, movement, …) has at most one posted entry that stands: it is posted again only once every earlier entry of it was reversed.',
    violation: `EXISTS (
      SELECT 1 FROM acc_entries e
      JOIN acc_proposals p ON p.company_id = e.company_id AND p.id = e.proposal_id
      WHERE e.company_id = NEW.company_id AND p.subject_key = (
        SELECT subject_key FROM acc_proposals WHERE company_id = NEW.company_id AND id = NEW.proposal_id)
        AND ${stands('e')})`,
  },
  {
    code: 'reversal_of_reversal',
    rule: 'A reversal is never reversed in turn: a wrong storno is corrected by booking its subject again, which its reversal freed.',
    violation: `EXISTS (
      SELECT 1 FROM acc_proposals p
      JOIN acc_entries t ON t.company_id = p.company_id AND t.id = substr(p.subject_key, 9)
      JOIN acc_proposals tp ON tp.company_id = t.company_id AND tp.id = t.proposal_id
      WHERE p.company_id = NEW.company_id AND p.id = NEW.proposal_id
        AND p.subject_key LIKE 'reverse:%' AND tp.subject_key LIKE 'reverse:%')`,
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
    rule: "An entry is bound either to an approval of exactly this effect by a current reviewer, or to an active posting policy, approved by a current reviewer, that covers this treatment and rule set, acknowledges each of the version's warnings (an `acknowledges` condition names its code and no `noWarnings` condition refuses it), is not paused (nor the company, nor a template it is bound to) and posts an extracted document, or a bank movement an agent transcribed with citations no text layer verified, only when a `sourceAuthority` condition allows `extracted`.",
    // The read set's documents are found by their key (CROSS JOIN keeps json_each outermost),
    // not by scanning the company's documents for each of them.
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
          AND p.valid_from <= NEW.date AND p.expires_at > ${engineNow}
          AND m.active = 1 AND m.role IN ('owner', 'reviewer') AND m.epoch = p.approver_epoch
          AND NOT EXISTS (
            SELECT 1 FROM acc_policy_revocations r WHERE r.company_id = p.company_id AND r.policy_id = p.id)
          AND EXISTS (
            SELECT 1 FROM json_each(p.treatments_json) t, acc_proposals q
            WHERE q.company_id = NEW.company_id AND q.id = NEW.proposal_id AND t.value = q.treatment_id)
          AND EXISTS (
            SELECT 1 FROM json_each(p.rules_hashes_json) h WHERE h.value = ${version('rules_hash')})
          AND NOT EXISTS (
            SELECT 1 FROM json_each(${version('issues_json')}) i
            WHERE json_extract(i.value, '$.severity') = 'ack'
              AND (EXISTS (
                  SELECT 1 FROM json_each(p.preconditions_json) c
                  WHERE json_extract(c.value, '$.kind') = 'noWarnings')
                OR NOT EXISTS (
                  SELECT 1 FROM json_each(p.preconditions_json) c, json_each(c.value, '$.codes') k
                  WHERE json_extract(c.value, '$.kind') = 'acknowledges'
                    AND k.value = json_extract(i.value, '$.code'))))
          AND ${automationState('company', 'NULL')} = 'resume'
          AND ${automationState('policy', 'p.id')} = 'resume'
          AND NOT EXISTS (
            SELECT 1 FROM json_each(p.preconditions_json) c
            WHERE json_extract(c.value, '$.kind') = 'template'
              AND ${automationState('template', "json_extract(c.value, '$.id')")} = 'pause')
          AND NOT EXISTS (
            SELECT 1 FROM json_each(${version('read_set_json')}) r
            CROSS JOIN acc_documents d ON d.company_id = NEW.company_id AND d.id = json_extract(r.value, '$.id')
            WHERE json_extract(r.value, '$.kind') = 'document' AND d.authority = 'extracted'
              AND NOT EXISTS (
                SELECT 1 FROM json_each(p.preconditions_json) c, json_each(c.value, '$.allow') k
                WHERE json_extract(c.value, '$.kind') = 'sourceAuthority' AND k.value = 'extracted'))
          AND NOT EXISTS (
            SELECT 1 FROM json_each(${version('read_set_json')}) r
            CROSS JOIN acc_bank_movements v ON v.company_id = NEW.company_id AND v.id = json_extract(r.value, '$.id')
            JOIN acc_bank_statements s ON s.company_id = v.company_id AND s.id = v.statement_id
            WHERE json_extract(r.value, '$.kind') = 'movement' AND ${unverifiedTranscription('s')}
              AND NOT EXISTS (
                SELECT 1 FROM json_each(p.preconditions_json) c, json_each(c.value, '$.allow') k
                WHERE json_extract(c.value, '$.kind') = 'sourceAuthority' AND k.value = 'extracted')))))`,
  },
  {
    code: 'segregation',
    rule: 'Under segregation of duties, a posting policy does not post the work of the person who approved it: on, what they proposed themselves; strict, also what their agents proposed.',
    violation: `NEW.policy_id IS NOT NULL AND ${selfApproval(
      `(SELECT approved_by FROM acc_posting_policies WHERE company_id = NEW.company_id AND id = NEW.policy_id)`,
      version('created_by'),
      version('agent_id'),
    )}`,
  },
  {
    code: 'closed_period',
    rule: 'Nothing is posted into a closed month.',
    violation: `${latest('acc_period_events', 'month = NEW.period')} = 'close'`,
  },
  {
    code: 'later_period_closed',
    rule: "Nothing is posted into a month before a closed one: a close covers every earlier month, empty ones included, so its closing balances (and every later close's, built on them) hold every line up to its month's end.",
    violation: `EXISTS (
      SELECT 1 FROM acc_period_events p
      WHERE p.company_id = NEW.company_id AND p.month > NEW.period AND p.kind = 'close'
        AND p.seq = (
          SELECT max(seq) FROM acc_period_events WHERE company_id = p.company_id AND month = p.month))`,
  },
  {
    code: 'closed_year',
    rule: 'Nothing is posted into a financial year a reviewed year close locked, until a reviewed reopening.',
    violation: lockedYear('NEW.date'),
  },
  {
    code: 'opening_first_year',
    rule: 'An opening entry (DESCHIDERE) opens the books: none is posted after a financial year they keep, whose balances the ledger carries already (a storno of one keeps its journal and is no opening).',
    violation: `NEW.journal_code = 'DESCHIDERE' AND NOT ${isStorno('NEW.proposal_id')}
      AND EXISTS (
        SELECT 1 FROM acc_fiscal_years y
        WHERE y.company_id = NEW.company_id AND y.kind = 'financial' AND y.date_to < NEW.date)`,
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
    code: 'retail_line',
    rule: 'A line on an account kept at retail price (control `retail`: a warehouse’s goods at sale price, their markup, the VAT their price includes) names a warehouse of the company (`retail:<id>`) and belongs to a retail treatment, a purchase received at retail price or a reversal.',
    violation: `EXISTS (
      SELECT 1 FROM acc_lines l
      JOIN acc_accounts a ON a.company_id = l.company_id AND a.code = l.account
      WHERE l.company_id = NEW.company_id AND l.entry_id = NEW.id AND a.control_kind = 'retail'
        AND (l.item IS NULL OR substr(l.item, 1, 7) <> 'retail:'
          OR NOT EXISTS (
            SELECT 1 FROM acc_warehouses w WHERE w.company_id = l.company_id AND w.id = substr(l.item, 8))
          OR NOT EXISTS (
            SELECT 1 FROM acc_proposals p WHERE p.company_id = NEW.company_id AND p.id = NEW.proposal_id
              AND p.treatment_id IN ('invoices.recognize', 'retail.zReport', 'retail.opening',
                'retail.reprice', 'retail.discharge', 'retail.count', 'ledger.reverse'))))`,
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
    // Grouped per touched item, so the check reads only those items' lines. The items are found
    // among the entry's own lines (`+` keeps the planner off the index of every line with an item).
    violation: `EXISTS (
      SELECT 1 FROM (
        SELECT o.normal_side, o.may_reverse, o.currency,
          sum(CASE l.side WHEN 'D' THEN l.bani ELSE -l.bani END) AS bani,
          sum(CASE l.side WHEN 'D' THEN COALESCE(l.currency_minor, l.bani) ELSE -COALESCE(l.currency_minor, l.bani) END) AS minor
        FROM acc_open_items o
        JOIN acc_lines l ON l.company_id = o.company_id AND l.open_item_id = o.id
        WHERE o.company_id = NEW.company_id
          AND o.id IN (SELECT open_item_id FROM acc_lines WHERE ${thisEntry} AND +open_item_id IS NOT NULL)
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
    code: 'stock_layers_mismatch',
    rule: 'The stock layers this entry creates are exactly those of the approved effect.',
    violation: differsFromEffect({
      table: 'acc_stock_layers',
      alias: 'y',
      rows: `y.company_id = NEW.company_id AND y.origin_entry_id = NEW.id`,
      items: `json_each(${effect}, '$.stockLayers') j`,
      expectedCount: `COALESCE(json_array_length(${effect}, '$.stockLayers'), 0)`,
      key: `y.id = json_extract(j.value, '$.ref')`,
      fields: stockLayerFields,
    }),
  },
  {
    code: 'stock_moves_mismatch',
    rule: "The entry's stock moves are exactly the approved effect's (an effect@1 has none).",
    violation: differsFromEffect({
      table: 'acc_stock_moves',
      alias: 'm',
      rows: `m.company_id = NEW.company_id AND m.entry_id = NEW.id`,
      items: `json_each(${effect}, '$.stockMoves') j`,
      expectedCount: `COALESCE(json_array_length(${effect}, '$.stockMoves'), 0)`,
      key: 'm.move_no = j.key + 1',
      fields: stockMoveFields,
    }),
  },
  {
    code: 'stock_move_layer',
    rule: "Each stock move is on its layer's item, warehouse and account, and the layer is on its item's stock account, one the register explains by quantity.",
    violation: `EXISTS (
      SELECT 1 FROM acc_stock_moves m
      LEFT JOIN acc_stock_layers y ON y.company_id = m.company_id AND y.id = m.layer_id
      LEFT JOIN acc_stock_items i ON i.company_id = y.company_id AND i.id = y.item_id
      WHERE m.company_id = NEW.company_id AND m.entry_id = NEW.id
        AND (y.id IS NULL OR y.item_id IS NOT m.item_id OR y.warehouse_id IS NOT m.warehouse_id
          OR y.account IS NOT m.account OR i.account IS NOT y.account OR NOT ${stockAccount('y.account')}))`,
  },
  {
    code: 'stock_move_line',
    rule: "A stock move naming a line is on that line's account, and the moves naming a line add up to its signed amount (debit positive).",
    violation: `EXISTS (
      SELECT 1 FROM acc_stock_moves m
      LEFT JOIN acc_lines l ON l.company_id = m.company_id AND l.entry_id = m.entry_id AND l.line_no = m.line_no
      WHERE m.company_id = NEW.company_id AND m.entry_id = NEW.id AND m.line_no IS NOT NULL
        AND (l.line_no IS NULL OR l.account IS NOT m.account))
      OR EXISTS (
        SELECT 1 FROM acc_lines l
        JOIN acc_stock_moves m ON m.company_id = l.company_id AND m.entry_id = l.entry_id AND m.line_no = l.line_no
        WHERE l.company_id = NEW.company_id AND l.entry_id = NEW.id
        GROUP BY l.line_no
        HAVING sum(m.bani) <> max(CASE l.side WHEN 'D' THEN l.bani ELSE -l.bani END))`,
  },
  {
    code: 'stock_transfer',
    rule: 'Stock moves naming no line move goods between warehouses: their values net to zero on each account, their quantities on each account and item.',
    // Grouped by `+account` (the same value), so the entry's moves are read by its key rather than
    // in the order of the index on the account, which would scan the whole register.
    violation: `EXISTS (
      SELECT 1 FROM acc_stock_moves
      WHERE ${thisEntry} AND line_no IS NULL
      GROUP BY +account HAVING sum(bani) <> 0)
      OR EXISTS (
        SELECT 1 FROM acc_stock_moves
        WHERE ${thisEntry} AND line_no IS NULL
        GROUP BY +account, +item_id HAVING sum(quantity) <> 0)`,
  },
  {
    code: 'stock_layer_balance',
    rule: 'After this entry, no stock layer it touches holds less than nothing, unless its policy lets its quantity go negative, nor a value without a quantity.',
    violation: `EXISTS (
      SELECT 1 FROM (
        SELECT y.may_go_negative, sum(m.quantity) AS quantity, sum(m.bani) AS bani
        FROM acc_stock_layers y
        JOIN acc_stock_moves m ON m.company_id = y.company_id AND m.layer_id = y.id
        WHERE y.company_id = NEW.company_id
          AND y.id IN (SELECT layer_id FROM acc_stock_moves WHERE ${thisEntry})
        GROUP BY y.id)
      WHERE (may_go_negative = 0 AND (quantity < 0 OR bani < 0)) OR (quantity = 0 AND bani <> 0))`,
  },
  {
    code: 'stale_read',
    rule: "The open items, schedules, tax periods, payroll runs, party statuses, stock positions and answers the proposal read have not changed since: an open item's version is its number of lines, a schedule's its latest version, a tax period's its tax entries, settlement lines and last entry sequence, a payroll run's its result and state, a party's status for a date its latest snapshot for that date, a stock position's (or the whole register's) its moves, a question's answer its latest answer.",
    violation: `EXISTS (
      SELECT 1 FROM json_each(${version('read_set_json')}) r
      WHERE (json_extract(r.value, '$.kind') = 'stock'
          AND json_extract(r.value, '$.version') <> ${stockVersion("json_extract(r.value, '$.id')")})
        OR (json_extract(r.value, '$.kind') = 'answer'
          AND json_extract(r.value, '$.version') IS NOT ${latestAnswer("json_extract(r.value, '$.id')")})
        OR (json_extract(r.value, '$.kind') = 'taxPeriod'
          AND json_extract(r.value, '$.version') <> ${taxPeriodVersion("json_extract(r.value, '$.id')")})
        OR (json_extract(r.value, '$.kind') = 'partyStatus'
          AND json_extract(r.value, '$.version') <> ${partyStatusVersion("json_extract(r.value, '$.id')")})
        OR (json_extract(r.value, '$.kind') = 'payrollRun'
          AND json_extract(r.value, '$.version') IS NOT ${payrollRunVersion("json_extract(r.value, '$.id')")})
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
  {
    code: 'approval_person',
    rule: "Only a person approves, never an agent: an approval records the agent that gave it, which is none (a batch's are its decider's).",
    violation: 'NEW.agent_id IS NOT NULL',
  },
  {
    code: 'segregation',
    rule: 'Under segregation of duties, nobody approves a version they created themselves (on), or that an agent created under their grant (strict).',
    violation: selfApproval('NEW.approver_id', version('created_by'), version('agent_id')),
  },
  {
    code: 'batch_member',
    rule: "An approval given with a batch names a version the batch's approved preview lists as ready with this effect hash, is the decider's under the epoch they decided in, and needs no acknowledgement.",
    violation: `NEW.batch_request_id IS NOT NULL AND (NOT EXISTS (
        SELECT 1 FROM acc_action_requests r
        JOIN acc_action_decisions d ON d.company_id = r.company_id AND d.request_id = r.id
        WHERE r.company_id = NEW.company_id AND r.id = NEW.batch_request_id
          AND r.operation = 'proposals.batch' AND d.decision = 'approve'
          AND d.preview_hash = r.preview_hash
          AND d.decided_by = NEW.approver_id AND d.decided_epoch = NEW.approver_epoch
          AND EXISTS (
            SELECT 1 FROM json_each(r.preview_json, '$.members') m
            WHERE json_extract(m.value, '$.proposalId') = NEW.proposal_id
              AND json_extract(m.value, '$.version') = NEW.version
              AND json_extract(m.value, '$.effectHash') = NEW.effect_hash
              AND json_extract(m.value, '$.state') = 'ready'))
      OR EXISTS (
        SELECT 1 FROM json_each(${version('issues_json')}) i
        WHERE json_extract(i.value, '$.severity') = 'ack'))`,
  },
];

const periodEventChecks: Check[] = [
  {
    code: 'closed_year_month',
    rule: 'A month of a financial year a reviewed year close locked is not reopened, until the year is.',
    violation: `NEW.kind = 'reopen' AND ${lockedYear("NEW.month || '-01'")}`,
  },
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

/** The latest state of a declaration artifact, or NULL before its first event. */
const artifactState = (artifact: string) => `(
      SELECT state FROM acc_artifact_events
      WHERE company_id = NEW.company_id AND artifact_id = ${artifact} ORDER BY seq DESC LIMIT 1)`;
const artifactEventChecks: Check[] = [
  {
    code: 'artifact_sequence',
    rule: 'Declaration steps are numbered from 1 without gaps.',
    violation: `NEW.seq <> 1 + COALESCE((
        SELECT max(seq) FROM acc_artifact_events
        WHERE company_id = NEW.company_id AND artifact_id = NEW.artifact_id), 0)`,
  },
  {
    code: 'artifact_transition',
    rule: "A declaration is prepared, passes ANAF's validator, is authorized, exported for signing, imported signed, submitted and answered; only a validated one is authorized, one not yet submitted or already answered can be superseded, and a superseded one ends.",
    violation: `NOT CASE ${artifactState('NEW.artifact_id')}
        WHEN 'prepared' THEN NEW.state IN ('validation_failed', 'validated_official', 'superseded')
        WHEN 'validation_failed' THEN NEW.state = 'superseded'
        WHEN 'validated_official' THEN NEW.state IN ('authorized', 'superseded')
        WHEN 'authorized' THEN NEW.state IN ('exported_for_signing', 'superseded')
        WHEN 'exported_for_signing' THEN NEW.state IN ('signed_imported', 'superseded')
        WHEN 'signed_imported' THEN NEW.state IN ('submitted', 'superseded')
        WHEN 'submitted' THEN NEW.state IN ('accepted', 'rejected')
        WHEN 'rejected' THEN NEW.state = 'superseded'
        WHEN 'accepted' THEN NEW.state = 'superseded'
        ELSE ${artifactState('NEW.artifact_id')} IS NULL AND NEW.state = 'prepared' END`,
  },
];

/** A column of the latest version of the income source being versioned. */
const previousSource = (column: string) => `(
      SELECT ${column} FROM acc_income_sources
      WHERE company_id = NEW.company_id AND source_id = NEW.source_id ORDER BY seq DESC LIMIT 1)`;
/** When the source's current run of the real system by option began. */
const optionStart = `(
      SELECT min(v.effective_from) FROM acc_income_sources v
      WHERE v.company_id = NEW.company_id AND v.source_id = NEW.source_id
        AND v.method = 'sistem_real' AND v.real_basis = 'option'
        AND v.seq > COALESCE((
          SELECT max(w.seq) FROM acc_income_sources w
          WHERE w.company_id = NEW.company_id AND w.source_id = NEW.source_id
            AND NOT (w.method = 'sistem_real' AND COALESCE(w.real_basis, '') = 'option')), 0))`;
const yearsSince = (date: string) =>
  `(CAST(substr(NEW.effective_from, 1, 4) AS INTEGER) - CAST(substr(${date}, 1, 4) AS INTEGER))`;
const incomeSourceChecks: Check[] = [
  {
    code: 'income_source_sequence',
    rule: "An income source's versions are numbered from 1 without gaps, the first from the day the activity starts, each from no earlier than the previous one.",
    violation: `NEW.seq <> 1 + COALESCE((
          SELECT max(seq) FROM acc_income_sources
          WHERE company_id = NEW.company_id AND source_id = NEW.source_id), 0)
        OR (NEW.seq = 1 AND NEW.effective_from <> NEW.started_on)
        OR NEW.effective_from < COALESCE(${previousSource('effective_from')}, NEW.effective_from)`,
  },
  {
    code: 'income_source_form',
    rule: 'Only a PFA, an II or an IF has income sources: the company recorded that form (entity.form) by the version’s date.',
    violation: `NOT EXISTS (
          SELECT 1 FROM acc_profile_facts f
          WHERE f.company_id = NEW.company_id AND f.axis = 'entity.form'
            AND f.value IN ('pfa', 'ii', 'if') AND f.effective_from <= NEW.effective_from
            AND NOT EXISTS (
              SELECT 1 FROM acc_profile_facts g
              WHERE g.company_id = f.company_id AND g.supersedes_id = f.id))`,
  },
  {
    code: 'income_source_method_date',
    rule: 'A source moves to a norm, or to the real system by option, only from 1 January (Codul fiscal art. 69^1); only the real system the law requires may begin in the course of a year (norme pct. 8 alin. (13)).',
    violation: `NEW.seq > 1
        AND (NEW.method, COALESCE(NEW.real_basis, '')) IS NOT (${previousSource('method')}, ${previousSource("COALESCE(real_basis, '')")})
        AND COALESCE(NEW.real_basis, '') <> 'required'
        AND substr(NEW.effective_from, 6) <> '01-01'`,
  },
  {
    code: 'income_source_option_lock',
    rule: 'The option for the real system binds for 2 fiscal years and renews tacitly for 2 more (art. 69^1 alin. (2)–(3)): a source returns to a norm only at the start of a new 2-year period.',
    violation: `NEW.method = 'norma'
        AND ${previousSource('method')} = 'sistem_real' AND ${previousSource('real_basis')} = 'option'
        AND (${yearsSince(optionStart)} < 2 OR ${yearsSince(optionStart)} % 2 <> 0)`,
  },
];

/** An aggregate over the rows of a family enterprise's agreement version. */
const memberRows = (select: string, version: string) => `(
      SELECT ${select} FROM acc_enterprise_members
      WHERE company_id = NEW.company_id AND version = ${version})`;
const lastMemberVersion = `(
      SELECT max(version) FROM acc_enterprise_members WHERE company_id = NEW.company_id)`;
const enterpriseMemberChecks: Check[] = [
  {
    code: 'enterprise_member_version',
    rule: "A family enterprise's agreements are numbered from 1 without gaps, and each one's members from 1 in its order; members are added only to the latest agreement.",
    violation: `NEW.version NOT IN (COALESCE(${lastMemberVersion}, 1), COALESCE(${lastMemberVersion}, 0) + 1)
        OR NEW.position <> 1 + ${memberRows('count(*)', 'NEW.version')}`,
  },
  {
    code: 'enterprise_member_form',
    rule: 'Only a family enterprise has members: the entity.form in force on the agreement’s date is if.',
    violation: `COALESCE((
          SELECT f.value FROM acc_profile_facts f
          WHERE f.company_id = NEW.company_id AND f.axis = 'entity.form'
            AND f.effective_from <= NEW.effective_from
            AND NOT EXISTS (
              SELECT 1 FROM acc_profile_facts g
              WHERE g.company_id = f.company_id AND g.supersedes_id = f.id)
          ORDER BY f.effective_from DESC, f.created_at DESC, f.id DESC LIMIT 1), '') <> 'if'`,
  },
  {
    code: 'enterprise_member_cnp',
    rule: 'A member is an individual whose CNP is recorded, sealed (the D212 and the D204 carry it).',
    violation: `NOT EXISTS (
          SELECT 1 FROM acc_parties p
          JOIN acc_party_cnps c ON c.company_id = p.company_id AND c.party_id = p.id
          WHERE p.company_id = NEW.company_id AND p.id = NEW.party_id AND p.kind = 'ro_individual')`,
  },
  {
    code: 'enterprise_member_quota',
    rule: "An agreement's quotas of the net income together never exceed 100% (OUG nr. 44/2008 art. 29 alin. (1)).",
    violation: `${memberRows('COALESCE(sum(quota_bp), 0)', 'NEW.version')} + NEW.quota_bp > 10000`,
  },
  {
    code: 'enterprise_member_representative',
    rule: 'An agreement designates one representative (art. 29 alin. (1)–(2)).',
    violation: `NEW.representative AND ${memberRows('count(*)', 'NEW.version AND representative')} > 0`,
  },
  {
    code: 'enterprise_member_terms',
    rule: "An agreement's members share its dates and its evidence (the agreement itself).",
    violation: `${memberRows(
      'count(*)',
      `NEW.version AND (effective_from <> NEW.effective_from
          OR effective_to IS NOT NEW.effective_to OR evidence_id <> NEW.evidence_id)`,
    )} > 0`,
  },
  {
    code: 'enterprise_member_complete',
    rule: 'A new agreement follows only a complete one: at least 2 members (art. 28 alin. (1)), quotas adding to 100% and a representative.',
    violation: `NEW.version > 1 AND NEW.version = COALESCE(${lastMemberVersion}, 0) + 1 AND (
          ${memberRows('count(*)', 'NEW.version - 1')} < 2
          OR ${memberRows('COALESCE(sum(quota_bp), 0)', 'NEW.version - 1')} <> 10000
          OR ${memberRows('count(*)', 'NEW.version - 1 AND representative')} <> 1)`,
  },
  {
    code: 'enterprise_member_dates',
    rule: 'A new agreement applies after the previous one began, and after it ended when it has an end.',
    violation: `NEW.version > 1 AND NEW.version = COALESCE(${lastMemberVersion}, 0) + 1 AND (
          NEW.effective_from <= ${memberRows('max(effective_from)', 'NEW.version - 1')}
          OR NEW.effective_from <= COALESCE(${memberRows('max(effective_to)', 'NEW.version - 1')}, ''))`,
  },
];

const payrollChecks = {
  terms: [
    {
      code: 'terms_sequence',
      rule: "A contract's terms are numbered from 1 without gaps, for one employee, and apply from no earlier than the previous version.",
      violation: `NEW.seq <> 1 + COALESCE((
          SELECT max(seq) FROM acc_employment_terms
          WHERE company_id = NEW.company_id AND contract_id = NEW.contract_id), 0)
        OR EXISTS (
          SELECT 1 FROM acc_employment_terms t
          WHERE t.company_id = NEW.company_id AND t.contract_id = NEW.contract_id
            AND (t.employee_id <> NEW.employee_id OR t.effective_from > NEW.effective_from))`,
    },
    {
      code: 'terms_values',
      rule: 'Terms have 1 to 8 daily hours, no negative amounts or counts, and end no earlier than they start.',
      violation: `NEW.daily_hours NOT BETWEEN 1 AND 8 OR NEW.base_salary_bani < 0 OR NEW.union_dues_bani < 0
        OR NEW.dependents < 0 OR NEW.children_in_school < 0
        OR (NEW.end_date IS NOT NULL AND NEW.end_date < NEW.start_date)`,
    },
    {
      code: 'terms_kind',
      rule: "A contract is an employment contract or an administrator's mandate, the same in every version; a mandate has no exemption from the employment contract's minimum contribution.",
      violation: `NEW.kind NOT IN ('employment', 'mandate')
        OR (NEW.kind = 'mandate' AND NEW.minimum_exemption IS NOT NULL)
        OR EXISTS (
          SELECT 1 FROM acc_employment_terms t
          WHERE t.company_id = NEW.company_id AND t.contract_id = NEW.contract_id AND t.kind <> NEW.kind)`,
    },
  ] satisfies Check[],
  runs: [
    {
      code: 'payroll_run_correction',
      rule: "A month's first round corrects nothing; a later round corrects an earlier round of the same month, for a stated reason.",
      violation: `CASE WHEN NEW.round = 1
          THEN NEW.corrects_run_id IS NOT NULL OR NEW.correction_reason IS NOT NULL
          ELSE NEW.correction_reason IS NULL OR NOT EXISTS (
            SELECT 1 FROM acc_payroll_runs r
            WHERE r.company_id = NEW.company_id AND r.id = NEW.corrects_run_id
              AND r.month = NEW.month AND r.round < NEW.round) END`,
    },
  ] satisfies Check[],
  garnishments: [
    {
      code: 'garnishment_values',
      rule: 'A garnishment order is on a contract of the company, for a positive debt, and states one of a monthly amount or a share of the net pay (of at most the whole).',
      violation: `NEW.kind NOT IN ('maintenance', 'state', 'public_damage', 'other') OR NEW.total_bani <= 0
        OR NOT EXISTS (
          SELECT 1 FROM acc_employment_terms t
          WHERE t.company_id = NEW.company_id AND t.contract_id = NEW.contract_id)
        OR (NEW.monthly_bani IS NULL) = (NEW.share_numerator IS NULL)
        OR (NEW.share_numerator IS NULL) <> (NEW.share_denominator IS NULL)
        OR NEW.monthly_bani <= 0
        OR (NEW.share_numerator IS NOT NULL AND (NEW.share_numerator < 1
          OR NEW.share_numerator > NEW.share_denominator))`,
    },
  ] satisfies Check[],
  releases: [
    {
      code: 'garnishment_release',
      rule: 'A garnishment is released no earlier than it was received.',
      violation: `NEW.released_on < (
          SELECT received_on FROM acc_garnishments
          WHERE company_id = NEW.company_id AND id = NEW.garnishment_id)`,
    },
  ] satisfies Check[],
  reges: [
    {
      code: 'reges_event',
      rule: "A contract's start is registered on its first terms, a change on a later version, its end on a version that ends it.",
      violation: `CASE NEW.event
          WHEN 'start' THEN NEW.terms_seq <> 1
          WHEN 'change' THEN NEW.terms_seq < 2
          ELSE NOT EXISTS (
            SELECT 1 FROM acc_employment_terms t
            WHERE t.company_id = NEW.company_id AND t.contract_id = NEW.contract_id
              AND t.seq = NEW.terms_seq AND t.end_date IS NOT NULL) END`,
    },
  ] satisfies Check[],
  events: [
    {
      code: 'payroll_run_transition',
      rule: 'A payroll run is prepared once, and may then be superseded once.',
      violation: `NOT CASE (
          SELECT state FROM acc_payroll_run_events
          WHERE company_id = NEW.company_id AND run_id = NEW.run_id ORDER BY seq DESC LIMIT 1)
        WHEN 'prepared' THEN NEW.state = 'superseded'
        ELSE NOT EXISTS (
          SELECT 1 FROM acc_payroll_run_events WHERE company_id = NEW.company_id AND run_id = NEW.run_id)
          AND NEW.state = 'prepared' END
        OR NEW.seq <> 1 + COALESCE((
          SELECT max(seq) FROM acc_payroll_run_events
          WHERE company_id = NEW.company_id AND run_id = NEW.run_id), 0)`,
    },
  ] satisfies Check[],
  lines: [
    {
      code: 'payroll_line_sum',
      rule: 'A payroll line adds up: the net is the money earned less the contributions, tax and dues withheld.',
      violation: `NEW.net_bani <> NEW.cash_bani - NEW.cas_bani - NEW.cass_bani - NEW.tax_bani - NEW.union_dues_bani`,
    },
    {
      code: 'payroll_line_employee',
      rule: "A payroll line is the contract's employee, under the employee's party.",
      violation: `NOT EXISTS (
          SELECT 1 FROM acc_employment_terms t JOIN acc_employees m
            ON m.company_id = t.company_id AND m.id = t.employee_id
          WHERE t.company_id = NEW.company_id AND t.contract_id = NEW.contract_id AND t.seq = NEW.terms_seq
            AND t.employee_id = NEW.employee_id AND m.party_id = NEW.party_id)`,
    },
    {
      code: 'sick_sealed',
      rule: 'A payroll line keeps no sick leave in clear: each medical certificate it paid is sealed whole, each issue about one sealed with its mark, and no sick item is labelled with a certificate and its code.',
      violation: `EXISTS (
          SELECT 1 FROM json_each(NEW.input_json, '$.sick') s
          WHERE json_type(s.value, '$.sealed') IS NOT 'text'
            OR (SELECT count(*) FROM json_each(s.value)) <> 1)
        OR EXISTS (
          SELECT 1 FROM json_each(NEW.result_json, '$.issues') i
          WHERE json_extract(i.value, '$.sealed') IS NULL
            AND (json_extract(i.value, '$.health') = 1 OR json_extract(i.value, '$.code') GLOB 'SICK_*'))
        OR EXISTS (
          SELECT 1 FROM json_each(NEW.input_json, '$.items') t
          WHERE json_extract(t.value, '$.label') GLOB 'Concediu medical *, cod *')`,
    },
  ] satisfies Check[],
};

const assetChecks: Record<'cards' | 'events' | 'fiscal', Check[]> = {
  cards: [
    {
      code: 'asset_accounts',
      rule: 'A fixed asset is on a fixed-asset account (20x–21x), depreciated on 28x against a 68x expense, with a positive value and life.',
      violation: `NOT (NEW.account GLOB '2[01]*' AND NEW.depreciation_account GLOB '28*'
          AND NEW.expense_account GLOB '68*' AND NEW.value_bani > 0
          AND NEW.life_months > 0 AND NEW.fiscal_life_months > 0)`,
    },
    {
      code: 'asset_locked_year',
      rule: "No fixed asset is registered as commissioned on or before the end of a locked financial year: that year's register and its closing do not hold it.",
      violation: lockedThrough('NEW.commissioned_on'),
    },
  ],
  events: [
    {
      code: 'asset_disposal',
      rule: 'An asset is disposed of once, on or after its commissioning.',
      violation: `NEW.seq <> 1 + COALESCE((
          SELECT max(seq) FROM acc_asset_events WHERE company_id = NEW.company_id AND asset_id = NEW.asset_id), 0)
        OR EXISTS (
          SELECT 1 FROM acc_asset_events WHERE company_id = NEW.company_id AND asset_id = NEW.asset_id AND kind = 'disposed')
        OR NEW.date < (SELECT commissioned_on FROM acc_assets WHERE company_id = NEW.company_id AND id = NEW.asset_id)`,
    },
    {
      code: 'asset_locked_year',
      rule: "No fixed asset leaves use on or before the end of a locked financial year: that year's register and its closing hold it in use.",
      violation: lockedThrough('NEW.date'),
    },
  ],
  fiscal: [
    {
      code: 'asset_fiscal_version',
      rule: "An asset's fiscal bases are numbered from 1 without gaps; the latest holds.",
      violation: `NEW.version <> 1 + COALESCE((
          SELECT max(version) FROM acc_asset_fiscal WHERE company_id = NEW.company_id AND asset_id = NEW.asset_id), 0)`,
    },
  ],
};

/** Links that make a document a member of another's group: the engine's, between documents of
 * the same identity, and a person's, between near matches. */
const groupLinks = `('same_as', 'same_as_confirmed')`;
/** The root of the group of the document `id` names: the document it joined, or itself. */
const rootOf = (id: string) => `COALESCE((
          SELECT l.to_id FROM acc_document_links l
          WHERE l.company_id = NEW.company_id AND l.from_id = ${id} AND l.kind IN ${groupLinks}), ${id})`;
const subjectDocument = `substr(NEW.subject_key, 10)`;

const documentChecks: Check[] = [
  {
    code: 'document_authority',
    rule: 'A document records where its content comes from: e-Factura, the engine issuing it, an uploaded UBL file, the invoicer or an agent extracting it.',
    violation: `NEW.authority IS NULL
        OR NEW.authority NOT IN ('efactura', 'issued', 'ubl_upload', 'invoicer', 'amef', 'extracted')`,
  },
  {
    code: 'extracted_source',
    rule: 'A document an agent extracted keeps the file it was read from, under a source key naming that file’s hash and the part read (`extract:<hash>:<part>`), so that it never takes the place of a structured source; no other document uses such a key.',
    violation: `(NEW.authority = 'extracted' AND (NEW.evidence_id IS NULL
          OR NEW.source_key NOT GLOB 'extract:' || COALESCE((
            SELECT hash FROM acc_evidence WHERE company_id = NEW.company_id AND id = NEW.evidence_id), '') || ':[1-9]*'))
        OR (NEW.authority IS NOT 'extracted' AND NEW.source_key GLOB 'extract:*')`,
  },
];

const documentLinkChecks: Check[] = [
  {
    code: 'same_as_root',
    rule: 'A document joins a group (`same_as` for the same identity, `same_as_confirmed` when a person matched it) only while it belongs to no group and has no members, and only through the group’s root, a document that is no member itself; a `same_as` link joins a group holding a document with the same identity key.',
    violation: `NEW.kind IN ${groupLinks} AND (NEW.from_id = NEW.to_id
        OR EXISTS (
          SELECT 1 FROM acc_document_links l
          WHERE l.company_id = NEW.company_id AND l.kind IN ${groupLinks}
            AND (l.from_id = NEW.from_id OR l.from_id = NEW.to_id OR l.to_id = NEW.from_id))
        OR (NEW.kind = 'same_as' AND NOT EXISTS (
          SELECT 1 FROM acc_documents f
          JOIN acc_documents t ON t.company_id = f.company_id AND t.identity_key = f.identity_key
          WHERE f.company_id = NEW.company_id AND f.id = NEW.from_id AND f.identity_key IS NOT NULL
            AND (t.id = NEW.to_id OR EXISTS (
              SELECT 1 FROM acc_document_links m
              WHERE m.company_id = t.company_id AND m.from_id = t.id AND m.to_id = NEW.to_id
                AND m.kind IN ${groupLinks})))))`,
  },
  {
    code: 'supersede',
    rule: 'Only an extracted document is superseded, by another extracted document of its kind, once, and only while no posted entry that stands recognizes it or its group (whose subject is the group’s root); after posting, a correction is a reversal, then the correction of the extraction and a new proposal.',
    violation: `NEW.kind = 'supersedes' AND (
        NOT EXISTS (
          SELECT 1 FROM acc_documents f
          JOIN acc_documents t ON t.company_id = f.company_id AND t.id = NEW.to_id
          WHERE f.company_id = NEW.company_id AND f.id = NEW.from_id AND f.id <> t.id
            AND f.authority = 'extracted' AND t.authority = 'extracted' AND f.kind = t.kind)
        OR EXISTS (
          SELECT 1 FROM acc_document_links l
          WHERE l.company_id = NEW.company_id AND l.kind = 'supersedes'
            AND (l.to_id = NEW.to_id OR l.from_id = NEW.from_id))
        OR EXISTS (
          SELECT 1 FROM acc_proposals p
          JOIN acc_entries e ON e.company_id = p.company_id AND e.proposal_id = p.id
          WHERE p.company_id = NEW.company_id
            AND (p.subject_key IN ('document:' || NEW.to_id, 'document:' || ${rootOf('NEW.to_id')})
              OR p.document_id = NEW.to_id)
            AND ${stands('e')}))`,
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
      ['acc_stock_layers', 'origin_entry_id'],
      ['acc_stock_moves', 'entry_id'],
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
        rule: 'A subject has at most one proposal that holds it: not withdrawn, and not posted by an entry reversed since.',
        violation: `EXISTS (
          SELECT 1 FROM acc_proposals p
          WHERE p.company_id = NEW.company_id AND p.subject_key = NEW.subject_key
            AND ${holdsSubject('p')})`,
      },
      {
        code: 'identity_taken',
        rule: 'A document is recognized once, whatever its copies: no proposal names a document while another document of its identity (the same identity key) or of its group (the same root) has a proposal that holds its subject (open, or posted by an entry that stands).',
        violation: `NEW.subject_key LIKE 'document:%' AND EXISTS (
          SELECT 1 FROM acc_proposals p
          WHERE p.company_id = NEW.company_id AND p.subject_key <> NEW.subject_key
            AND p.subject_key IN (
              SELECT 'document:' || d.id FROM acc_documents d
              WHERE d.company_id = NEW.company_id AND d.identity_key = (
                SELECT identity_key FROM acc_documents
                WHERE company_id = NEW.company_id AND id = ${subjectDocument})
              UNION SELECT 'document:' || ${rootOf(subjectDocument)}
              UNION SELECT 'document:' || l.from_id FROM acc_document_links l
              WHERE l.company_id = NEW.company_id AND l.kind IN ${groupLinks}
                AND l.to_id = ${rootOf(subjectDocument)})
            AND ${holdsSubject('p')})`,
      },
    ],
  },
  { name: 'inv_document_guard', on: 'BEFORE INSERT ON acc_documents', checks: documentChecks },
  {
    name: 'inv_document_link_guard',
    on: 'BEFORE INSERT ON acc_document_links',
    checks: documentLinkChecks,
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
      {
        code: 'policy_person',
        rule: "Only a person grants a posting policy, never an agent: a policy records the agent that created it, which is none (one from a graduation is its decider's).",
        violation: 'NEW.agent_id IS NOT NULL',
      },
      {
        code: 'policy_scope',
        rule: 'A posting policy never posts a return or an SPV submission: it names no `declarations.*` or `spv.*` operation.',
        violation: `EXISTS (
          SELECT 1 FROM json_each(NEW.treatments_json) t
          WHERE t.value LIKE 'declarations.%' OR t.value LIKE 'spv.%')`,
      },
    ],
  },
  {
    name: 'inv_template_guard',
    on: 'BEFORE INSERT ON acc_templates',
    checks: [
      {
        code: 'template_version',
        rule: "A template's versions are numbered from 1 without gaps.",
        violation: `NEW.version <> 1 + COALESCE((
          SELECT max(version) FROM acc_templates WHERE company_id = NEW.company_id AND id = NEW.id), 0)`,
      },
      {
        code: 'template_request',
        rule: 'A template version is written by a `templates.request` that a current owner or reviewer approved, in their name and under the epoch they decided in.',
        violation: `NOT EXISTS (
          SELECT 1 FROM acc_action_requests r
          JOIN acc_action_decisions d ON d.company_id = r.company_id AND d.request_id = r.id
          WHERE r.company_id = NEW.company_id AND r.id = NEW.request_id
            AND r.operation = 'templates.request' AND d.decision = 'approve'
            AND d.decided_by = NEW.approved_by AND d.decided_epoch = NEW.approver_epoch)
          OR NOT ${isReviewer('NEW.approved_by', 'NEW.approver_epoch')}`,
      },
    ],
  },
  {
    name: 'inv_template_revocation_guard',
    on: 'BEFORE INSERT ON acc_template_revocations',
    checks: [
      {
        code: 'template_missing',
        rule: 'Only an existing template of the company is revoked.',
        violation: `NOT EXISTS (
          SELECT 1 FROM acc_templates WHERE company_id = NEW.company_id AND id = NEW.template_id)`,
      },
    ],
  },
  {
    name: 'inv_template_prediction_guard',
    on: 'BEFORE INSERT ON acc_template_predictions',
    checks: [
      {
        code: 'prediction_posted',
        rule: 'A prediction is recorded before anything is posted for its subject: a track record is never written after the fact.',
        violation: `NEW.subject_key IS NOT NULL AND EXISTS (
          SELECT 1 FROM acc_proposals q JOIN acc_entries e ON e.company_id = q.company_id AND e.proposal_id = q.id
          WHERE q.company_id = NEW.company_id AND q.subject_key = NEW.subject_key)`,
      },
    ],
  },
  {
    name: 'inv_automation_event_guard',
    on: 'BEFORE INSERT ON acc_automation_events',
    checks: [
      {
        code: 'automation_sequence',
        rule: "A company's pauses and resumes are numbered from 1 without gaps.",
        violation: `NEW.seq <> 1 + COALESCE((
          SELECT max(seq) FROM acc_automation_events WHERE company_id = NEW.company_id), 0)`,
      },
      {
        code: 'automation_actor',
        rule: 'Automation is paused by a member under their current epoch, or by the system principal; never by anyone else.',
        violation: `NEW.created_by <> ${systemPrincipal} AND NOT EXISTS (
          SELECT 1 FROM acc_memberships m
          WHERE m.company_id = NEW.company_id AND m.user_id = NEW.created_by
            AND m.active = 1 AND m.epoch = NEW.epoch)`,
      },
      {
        code: 'automation_resume',
        rule: 'Only a person who is a current owner or reviewer resumes automation: never an agent or the system.',
        violation: `NEW.kind = 'resume' AND (NEW.agent_id IS NOT NULL
          OR NOT ${isReviewer('NEW.created_by', 'NEW.epoch')})`,
      },
      {
        code: 'automation_scope',
        rule: "A pause or resume names one of the company's policies or templates, or the whole company.",
        violation: `(NEW.scope = 'policy' AND NOT EXISTS (
            SELECT 1 FROM acc_posting_policies WHERE company_id = NEW.company_id AND id = NEW.scope_id))
          OR (NEW.scope = 'template' AND NOT EXISTS (
            SELECT 1 FROM acc_templates WHERE company_id = NEW.company_id AND id = NEW.scope_id))`,
      },
    ],
  },
  {
    name: 'inv_automation_criteria_guard',
    on: 'BEFORE INSERT ON acc_automation_criteria',
    checks: [
      {
        code: 'criteria_sequence',
        rule: "A company's graduation criteria are numbered from 1 without gaps; the latest holds.",
        violation: `NEW.seq <> 1 + COALESCE((
          SELECT max(seq) FROM acc_automation_criteria WHERE company_id = NEW.company_id), 0)`,
      },
      {
        code: 'criteria_person',
        rule: 'Graduation criteria are set by a current owner or reviewer.',
        violation: `NOT ${isReviewer('NEW.created_by', 'NEW.epoch')}`,
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
      {
        code: 'decision_person',
        rule: 'Only a person approves or rejects an action, never an agent: a decision records the agent that took it, which is none.',
        violation: 'NEW.agent_id IS NOT NULL',
      },
      {
        code: 'segregation',
        rule: 'Under segregation of duties, nobody approves an action they requested themselves (on), or that an agent requested under their grant (strict); rejecting one stays open to them.',
        violation: `NEW.decision = 'approve' AND ${selfApproval(
          'NEW.decided_by',
          '(SELECT created_by FROM acc_action_requests WHERE company_id = NEW.company_id AND id = NEW.request_id)',
          '(SELECT agent_id FROM acc_action_requests WHERE company_id = NEW.company_id AND id = NEW.request_id)',
        )}`,
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
      {
        code: 'decider',
        rule: 'The approval executed was given by a person who is still a current owner or reviewer, under the membership epoch they decided in.',
        violation: `NOT EXISTS (
          SELECT 1 FROM acc_action_decisions d
          JOIN acc_memberships m ON m.company_id = d.company_id AND m.user_id = d.decided_by
          WHERE d.company_id = NEW.company_id AND d.request_id = NEW.request_id
            AND m.active = 1 AND m.role IN ('owner', 'reviewer') AND m.epoch = d.decided_epoch)`,
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
        code: 'lock_artifact',
        rule: 'A tax period is locked only by authorizing a declaration of that tax and period, and unlocked only in the name of one.',
        violation: `NOT EXISTS (
          SELECT 1 FROM acc_artifacts a
          WHERE a.company_id = NEW.company_id AND a.id = NEW.reference
            AND a.tax = NEW.tax AND a.period = NEW.period
            AND (NEW.kind = 'unlock' OR ${artifactState('a.id')} = 'authorized'))`,
      },
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
    name: 'inv_membership_insert',
    on: 'BEFORE INSERT ON acc_memberships',
    checks: [
      {
        code: 'system_member',
        rule: 'The system principal is never a member of a company, so it never approves, decides or creates a policy.',
        violation: `NEW.user_id = ${systemPrincipal}`,
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
          OR (NEW.id, NEW.company_id, NEW.name, NEW.token_hash, NEW.scopes, NEW.toolsets, NEW.membership_epoch, NEW.expires_at, NEW.created_by)
            IS NOT (OLD.id, OLD.company_id, OLD.name, OLD.token_hash, OLD.scopes, OLD.toolsets, OLD.membership_epoch, OLD.expires_at, OLD.created_by)`,
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
      {
        code: 'year_contiguous',
        rule: "A company's years of a kind follow one another without a gap: a new one starts the day after one ends, or ends the day before one starts.",
        violation: `EXISTS (
            SELECT 1 FROM acc_fiscal_years y WHERE y.company_id = NEW.company_id AND y.kind = NEW.kind)
          AND NOT EXISTS (
            SELECT 1 FROM acc_fiscal_years y
            WHERE y.company_id = NEW.company_id AND y.kind = NEW.kind
              AND (y.date_to = date(NEW.date_from, '-1 day') OR y.date_from = date(NEW.date_to, '+1 day')))`,
      },
      {
        code: 'year_before_opening',
        rule: 'No financial year is added before an opening entry (DESCHIDERE) that stands: the books open with their first year, and the earlier one would count its balances twice.',
        violation: `NEW.kind = 'financial' AND EXISTS (
          SELECT 1 FROM acc_entries e
          WHERE e.company_id = NEW.company_id AND e.journal_code = 'DESCHIDERE'
            AND e.date > NEW.date_to AND ${stands('e')} AND NOT ${isStorno('e.proposal_id')})`,
      },
    ],
  },
  {
    name: 'inv_party_guard',
    on: 'BEFORE INSERT ON acc_parties',
    checks: [
      {
        code: 'party_identity',
        rule: "An individual's identifier is the keyed hash of their CNP (`cnp:k1:` and an HMAC under the installation's secret), never the CNP itself nor an unkeyed hash of it, which a birth date makes easy to find.",
        violation: `NEW.tax_id IS NOT NULL AND (NEW.kind = 'ro_individual' OR NEW.tax_id GLOB 'cnp:*')
          AND NOT (NEW.tax_id GLOB 'cnp:k1:*' AND length(NEW.tax_id) = 71)`,
      },
      {
        code: 'party_cnp',
        rule: "A Romanian partner is never known by a CNP, whatever its kind: 13 digits (a CUI has at most 10) are an individual's code, kept only as its keyed hash. A received invoice of an individual recorded its seller as a company under the CNP in clear.",
        violation: `NEW.country = 'RO' AND NEW.tax_id IS NOT NULL
          AND (NEW.tax_id GLOB '${cnpDigits}' OR upper(NEW.tax_id) GLOB 'RO${cnpDigits}')`,
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
    name: 'inv_party_status_guard',
    on: 'BEFORE INSERT ON acc_party_status',
    checks: [
      {
        code: 'party_status_sequence',
        rule: "A party's status snapshots are numbered from 1 without gaps.",
        violation: `NEW.seq <> 1 + COALESCE((
          SELECT max(seq) FROM acc_party_status
          WHERE company_id = NEW.company_id AND party_id = NEW.party_id), 0)`,
      },
      {
        code: 'party_status_party',
        rule: "A status snapshot is about one of the company's Romanian parties, under the CUI that party holds.",
        violation: `NOT EXISTS (
          SELECT 1 FROM acc_parties p
          WHERE p.company_id = NEW.company_id AND p.id = NEW.party_id
            AND p.country = 'RO' AND p.tax_id = NEW.cui)`,
      },
    ],
  },
  {
    name: 'inv_income_source_guard',
    on: 'BEFORE INSERT ON acc_income_sources',
    checks: incomeSourceChecks,
  },
  {
    name: 'inv_enterprise_member_guard',
    on: 'BEFORE INSERT ON acc_enterprise_members',
    checks: enterpriseMemberChecks,
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
    name: 'inv_artifact_event_guard',
    on: 'BEFORE INSERT ON acc_artifact_events',
    checks: artifactEventChecks,
  },
  {
    name: 'inv_employment_terms_guard',
    on: 'BEFORE INSERT ON acc_employment_terms',
    checks: payrollChecks.terms,
  },
  {
    name: 'inv_payroll_run_event_guard',
    on: 'BEFORE INSERT ON acc_payroll_run_events',
    checks: payrollChecks.events,
  },
  {
    name: 'inv_payroll_run_guard',
    on: 'BEFORE INSERT ON acc_payroll_runs',
    checks: payrollChecks.runs,
  },
  {
    name: 'inv_garnishment_guard',
    on: 'BEFORE INSERT ON acc_garnishments',
    checks: payrollChecks.garnishments,
  },
  {
    name: 'inv_garnishment_release_guard',
    on: 'BEFORE INSERT ON acc_garnishment_releases',
    checks: payrollChecks.releases,
  },
  {
    name: 'inv_reges_record_guard',
    on: 'BEFORE INSERT ON acc_reges_records',
    checks: payrollChecks.reges,
  },
  {
    name: 'inv_asset_guard',
    on: 'BEFORE INSERT ON acc_assets',
    checks: assetChecks.cards,
  },
  {
    name: 'inv_asset_event_guard',
    on: 'BEFORE INSERT ON acc_asset_events',
    checks: assetChecks.events,
  },
  {
    name: 'inv_asset_fiscal_guard',
    on: 'BEFORE INSERT ON acc_asset_fiscal',
    checks: assetChecks.fiscal,
  },
  {
    name: 'inv_stock_item_guard',
    on: 'BEFORE INSERT ON acc_stock_items',
    checks: [
      {
        code: 'stock_item_account',
        rule: 'An item of the stock catalogue is kept on a postable account the register explains by quantity (30x–38x, without the price differences, stock in transit and adjustments).',
        violation: `NOT ${stockAccount('NEW.account')} OR NOT EXISTS (
          SELECT 1 FROM acc_accounts a
          WHERE a.company_id = NEW.company_id AND a.code = NEW.account AND a.postable = 1)`,
      },
      {
        code: 'stock_item_codes',
        rule: "An item's unit of measure is a UN/ECE Recommendation 20 code (two or three letters and digits) and its NC8 code, when given, eight digits.",
        violation: `NEW.unit NOT GLOB '[A-Z0-9][A-Z0-9]' AND NEW.unit NOT GLOB '[A-Z0-9][A-Z0-9][A-Z0-9]'
          OR (NEW.nc8 IS NOT NULL AND NEW.nc8 NOT GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]')`,
      },
    ],
  },
  {
    name: 'inv_warehouse_guard',
    on: 'BEFORE INSERT ON acc_warehouses',
    checks: [
      {
        code: 'warehouse_keeper',
        rule: 'A warehouse (gestiune) names the person responsible for it (the keeper).',
        violation: `trim(NEW.keeper) = ''`,
      },
    ],
  },
  // A fiscal cash register (G2): its identity and the events of its life, each documented.
  {
    name: 'inv_cash_register_guard',
    on: 'BEFORE INSERT ON acc_cash_registers',
    checks: [
      {
        code: 'cash_register_identity',
        rule: 'A fiscal cash register has its unique number, its fiscal series and its location.',
        violation: `trim(NEW.code) = '' OR trim(NEW.fiscal_series) = '' OR trim(NEW.location) = ''`,
      },
    ],
  },
  {
    name: 'inv_cash_register_event_guard',
    on: 'BEFORE INSERT ON acc_cash_register_events',
    checks: [
      {
        code: 'cash_register_event',
        rule: 'A register’s events are of a known kind, numbered from 1 without gaps, dated from its putting into use, and none follows its being taken out of use.',
        violation: `NEW.kind NOT IN ('anaf_registered', 'service_contract', 'memory_replaced',
            'journal_replaced', 'failure', 'repaired', 'closed')
          OR NEW.seq <> 1 + COALESCE((
            SELECT max(e.seq) FROM acc_cash_register_events e
            WHERE e.company_id = NEW.company_id AND e.register_id = NEW.register_id), 0)
          OR NEW.date < (SELECT r.active_from FROM acc_cash_registers r
            WHERE r.company_id = NEW.company_id AND r.id = NEW.register_id)
          OR EXISTS (
            SELECT 1 FROM acc_cash_register_events e
            WHERE e.company_id = NEW.company_id AND e.register_id = NEW.register_id AND e.kind = 'closed')`,
      },
    ],
  },
  // Production (G4): a product's bill of materials, versioned and dated, never changed once a work
  // order is costed on it; a work order on the version valid when it opened; its closing, final.
  {
    name: 'inv_bom_guard',
    on: 'BEFORE INSERT ON acc_boms',
    checks: [
      {
        code: 'bom_product',
        rule: 'A bill of materials describes a product of the catalogue: a semi-finished (341) or a finished product (345).',
        violation: `NOT EXISTS (
          SELECT 1 FROM acc_stock_items i
          WHERE i.company_id = NEW.company_id AND i.id = NEW.item_id
            AND (i.account LIKE '341%' OR i.account LIKE '345%'))`,
      },
      {
        code: 'bom_version',
        rule: "A product's bill of materials is numbered from 1 without gaps, each version valid after the one before, for a positive output quantity, its standard cost and hours not negative.",
        violation: `NEW.version <> 1 + COALESCE((
            SELECT max(b.version) FROM acc_boms b
            WHERE b.company_id = NEW.company_id AND b.item_id = NEW.item_id), 0)
          OR NEW.valid_from <= COALESCE((
            SELECT max(b.valid_from) FROM acc_boms b
            WHERE b.company_id = NEW.company_id AND b.item_id = NEW.item_id), '')
          OR NEW.output_quantity <= 0 OR NEW.standard_cost < 0
          OR NEW.labour_hours < 0 OR NEW.machine_hours < 0`,
      },
    ],
  },
  {
    name: 'inv_bom_line_guard',
    on: 'BEFORE INSERT ON acc_bom_lines',
    checks: [
      {
        code: 'bom_line',
        rule: "A bill of materials' lines are numbered from 1 without gaps, each a positive quantity of a material (301, 302, 303, 381).",
        violation: `NEW.line_no <> 1 + COALESCE((
            SELECT max(l.line_no) FROM acc_bom_lines l
            WHERE l.company_id = NEW.company_id AND l.bom_id = NEW.bom_id), 0)
          OR NEW.quantity <= 0
          OR NOT EXISTS (
            SELECT 1 FROM acc_stock_items i
            WHERE i.company_id = NEW.company_id AND i.id = NEW.item_id
              AND (i.account LIKE '301%' OR i.account LIKE '302%' OR i.account LIKE '303%'
                OR i.account LIKE '381%'))`,
      },
      {
        code: 'bom_sealed',
        rule: 'A bill of materials takes no line once a work order is costed on it.',
        violation: `EXISTS (
          SELECT 1 FROM acc_work_orders o
          WHERE o.company_id = NEW.company_id AND o.bom_id = NEW.bom_id)`,
      },
    ],
  },
  {
    name: 'inv_work_order_guard',
    on: 'BEFORE INSERT ON acc_work_orders',
    checks: [
      {
        code: 'work_order_bom',
        rule: "A work order has a number and a positive quantity, and is costed on its product's bill of materials valid on its opening day (the latest version from on or before it).",
        violation: `trim(NEW.number) = '' OR NEW.quantity <= 0
          OR NOT EXISTS (
            SELECT 1 FROM acc_boms b
            WHERE b.company_id = NEW.company_id AND b.id = NEW.bom_id AND b.item_id = NEW.item_id
              AND b.valid_from <= NEW.opened_on
              AND NOT EXISTS (
                SELECT 1 FROM acc_boms c
                WHERE c.company_id = b.company_id AND c.item_id = b.item_id
                  AND c.valid_from <= NEW.opened_on AND c.version > b.version))`,
      },
    ],
  },
  {
    name: 'inv_work_order_event_guard',
    on: 'BEFORE INSERT ON acc_work_order_events',
    checks: [
      {
        code: 'work_order_event',
        rule: 'A work order’s events are of a known kind, numbered from 1 without gaps, dated from its opening, and none follows its closing.',
        violation: `NEW.kind NOT IN ('closed')
          OR NEW.seq <> 1 + COALESCE((
            SELECT max(e.seq) FROM acc_work_order_events e
            WHERE e.company_id = NEW.company_id AND e.order_id = NEW.order_id), 0)
          OR NEW.date < (SELECT o.opened_on FROM acc_work_orders o
            WHERE o.company_id = NEW.company_id AND o.id = NEW.order_id)
          OR EXISTS (
            SELECT 1 FROM acc_work_order_events e
            WHERE e.company_id = NEW.company_id AND e.order_id = NEW.order_id AND e.kind = 'closed')`,
      },
    ],
  },
  {
    name: 'inv_payroll_line_guard',
    on: 'BEFORE INSERT ON acc_payroll_lines',
    checks: payrollChecks.lines,
  },
  // A statement covers its opening-balance date to its closing date. Some banks date the opening
  // balance with the previous statement's closing date (SWIFT field 60F), so consecutive
  // statements may share that one day: the later one takes over on it, reporting nothing there.
  {
    name: 'inv_bank_statement_guard',
    on: 'BEFORE INSERT ON acc_bank_statements',
    checks: [
      {
        code: 'statement_overlap',
        rule: 'Statements of one account never report a day twice. One opens on the day another closes only by taking over: at its closing balance, covering later days too, and reporting no movement that day.',
        violation: `EXISTS (
          SELECT 1 FROM acc_bank_statements s
          WHERE s.company_id = NEW.company_id AND s.treasury_account_id = NEW.treasury_account_id
            AND s.date_from <= NEW.date_to AND NEW.date_from <= s.date_to
            AND NOT (s.date_to = NEW.date_from AND NEW.date_from < NEW.date_to
              AND NEW.opening_minor = s.closing_minor)
            AND NOT (NEW.date_to = s.date_from AND s.date_from < s.date_to
              AND s.opening_minor = NEW.closing_minor
              AND NOT EXISTS (
                SELECT 1 FROM acc_bank_movements m
                WHERE m.company_id = s.company_id AND m.treasury_account_id = s.treasury_account_id
                  AND m.booking_date = s.date_from AND m.statement_id = s.id)))`,
      },
    ],
  },
  {
    name: 'inv_bank_movement_guard',
    on: 'BEFORE INSERT ON acc_bank_movements',
    checks: [
      {
        code: 'statement_overlap',
        rule: "A movement is on a day its own statement covers, on the statement's account, and not on the day that statement takes over from one closing on it.",
        violation: `NOT EXISTS (
          SELECT 1 FROM acc_bank_statements s
          WHERE s.company_id = NEW.company_id AND s.id = NEW.statement_id
            AND s.treasury_account_id = NEW.treasury_account_id
            AND NEW.booking_date BETWEEN s.date_from AND s.date_to
            AND NOT (NEW.booking_date = s.date_from AND EXISTS (
              SELECT 1 FROM acc_bank_statements e
              WHERE e.company_id = s.company_id AND e.treasury_account_id = s.treasury_account_id
                AND e.id <> s.id AND e.date_to = s.date_from)))`,
      },
    ],
  },
  {
    name: 'inv_question_guard',
    on: 'BEFORE INSERT ON acc_questions',
    checks: [
      {
        code: 'question_open',
        rule: 'A kind of question has at most one open question (unanswered, not withdrawn) about a subject.',
        violation: `EXISTS (
          SELECT 1 FROM acc_questions q
          WHERE q.company_id = NEW.company_id AND q.kind = NEW.kind
            AND q.subject_kind = NEW.subject_kind AND q.subject_id = NEW.subject_id
            AND NOT EXISTS (
              SELECT 1 FROM acc_question_answers a WHERE a.company_id = q.company_id AND a.question_id = q.id)
            AND NOT EXISTS (
              SELECT 1 FROM acc_question_withdrawals w WHERE w.company_id = q.company_id AND w.question_id = q.id))`,
      },
    ],
  },
  {
    name: 'inv_question_answer_guard',
    on: 'BEFORE INSERT ON acc_question_answers',
    checks: [
      {
        code: 'answer_sequence',
        rule: "A question's answers are numbered from 1 without gaps; the latest holds.",
        violation: `NEW.seq <> 1 + COALESCE((
          SELECT max(seq) FROM acc_question_answers
          WHERE company_id = NEW.company_id AND question_id = NEW.question_id), 0)`,
      },
      {
        code: 'answer_person',
        rule: 'Only a person answers a question, never an agent.',
        violation: 'NEW.agent_id IS NOT NULL',
      },
      {
        code: 'absence_sealed',
        rule: "An answer about a month's absences keeps each absence sealed, who and which indemnity code with it; only its medical certificate's file stays in clear, which classification reads.",
        violation: `EXISTS (
            SELECT 1 FROM acc_questions q
            WHERE q.company_id = NEW.company_id AND q.id = NEW.question_id AND q.kind = 'payroll.absences')
          AND EXISTS (
            SELECT 1 FROM json_each(NEW.value_json, '$.absences') x
            WHERE json_type(x.value, '$.sealed') IS NOT 'text'
              OR EXISTS (SELECT 1 FROM json_each(x.value) f
                WHERE f.key NOT IN ('sealed', 'certificateEvidenceId')))`,
      },
      {
        code: 'answerer',
        rule: 'The person answering is a current owner or reviewer, under the membership epoch they answered in.',
        violation: `NOT ${isReviewer('NEW.answered_by', 'NEW.epoch')}`,
      },
      {
        code: 'question_withdrawn',
        rule: 'A withdrawn question is not answered.',
        violation: `EXISTS (
          SELECT 1 FROM acc_question_withdrawals
          WHERE company_id = NEW.company_id AND question_id = NEW.question_id)`,
      },
      {
        code: 'answer_evidence',
        rule: `An answer is kept as evidence of its own kind (${answerMediaType}), which proposals and profile facts cite.`,
        violation: `(SELECT media_type FROM acc_evidence
          WHERE company_id = NEW.company_id AND id = NEW.evidence_id) IS NOT '${answerMediaType}'`,
      },
    ],
  },
  {
    name: 'inv_question_withdrawal_guard',
    on: 'BEFORE INSERT ON acc_question_withdrawals',
    checks: [
      {
        code: 'question_answered',
        rule: 'Only a question nobody answered is withdrawn; an answer is replaced by a later one.',
        violation: `EXISTS (
          SELECT 1 FROM acc_question_answers
          WHERE company_id = NEW.company_id AND question_id = NEW.question_id)`,
      },
    ],
  },
  {
    name: 'inv_disposition_guard',
    on: 'BEFORE INSERT ON acc_dispositions',
    checks: [
      {
        code: 'disposition_subject',
        rule: 'A disposition is about a document, an SPV message, a close finding or evidence used nowhere.',
        violation: `NEW.subject_kind NOT IN ('document', 'spvMessage', 'finding', 'evidence')`,
      },
      {
        code: 'disposition_person',
        rule: 'Only a person decides that a document needs no booking, an SPV message or a close finding was dealt with; an agent may dispose only of evidence used nowhere.',
        violation: `NEW.agent_id IS NOT NULL AND NEW.subject_kind <> 'evidence'`,
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
    const tables = new Set(
      (await transaction.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map(
        (row) => String(row.name),
      ),
    );
    for (const item of wanted) {
      if (current(item)) continue;
      // A table a later migration creates (a database migrated part way, as an upgrade test
      // does) gets its triggers once it exists: the installation after that migration adds them.
      const target = /^CREATE TRIGGER \w+ [^\n]*?\bON (\w+)/.exec(item.sql)?.[1];
      if (target && !tables.has(target)) continue;
      // So does a trigger whose checks read a table a later migration creates (the entry guard
      // reads the stock register's, 0027).
      const read = [...item.sql.matchAll(/\b((?:acc|ref)_[a-z_]+)\b/g)].map((match) => match[1]!);
      if (item.type === 'trigger' && read.some((table) => !tables.has(table))) continue;
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
