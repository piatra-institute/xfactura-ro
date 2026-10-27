# Implemented accounting engine

This document describes executable behavior. [ROADMAP.md](ROADMAP.md) owns the full-suite target; [CONFORMANCE.md](CONFORMANCE.md) owns coverage claims. No complete fiscal profile, official declaration or annual replacement claim has passed.

## Company configuration and general ledger

The engine remains inside `packages/xfactura-api/source/accounting`, using SQLite/libSQL and Drizzle. There is no separate accounting package or PostgreSQL service.

Creating a company configures distinct calendar financial and fiscal years using its initial `year`. Additional intervals use `years.create`; intervals of the same kind cannot overlap. The original company field remains compatible with existing workflows. A general report always names its financial year; `books.summary` requires a selection when several financial years exist. The existing review screen switches years without combining their openings or movements and retains the selected financial year in the URL across reloads.

`accounts.list` returns the sourced OMFP 1802/2014 reference catalogue and company analytical accounts. The catalogue contains 584 account/group records, with source URL/hash and an explicit reference status. It is not yet a reviewed consolidation of every amendment for 2025/2026. That source/consolidation review remains a GL-01 exit requirement. Groups and the off-balance/management books cannot receive general-ledger lines. Analytical accounts inherit their parent book/balance classification and have their own effective date.

`ledger.propose` accepts an evidence ID, financial year, date, purpose, description, source reference and explicit balanced debit/credit lines. Purposes are opening, general, purchase, sale and adjustment. Amounts are decimal strings; stored posting amounts are bigint integer bani. Opening positions may contain receivables, payables, equity, bank and other supported general-ledger balances. They belong at the beginning of the configured financial year and cannot duplicate a legacy opening.

`ledger.revise` preserves the preceding fact and invalidates the old approval. Posted proposals cannot be revised. An adjustment can name `correctsJournalId`; this is a retained accounting link, not an automatic determination of prior-year fiscal treatment. `books.approve` remains human-only. `ledger.post` executes the exact version/hash and rechecks the source, year, accounts, date, lines and closed period. An old agent grant for `books.post` cannot execute general postings.

`ledger.balance` returns opening balance before the requested interval, interval debit/credit movements and closing balance within one financial year. At the start of a financial year, the opening journal itself appears among that interval's movements. Automatic annual roll-forward and a complete statutory trial-balance layout remain later work.

## Registration, policy and rule records

`regimes.record` retains human-reviewed evidence and an effective date for normal/non-VAT status, income-tax regime, special EU VAT identification and cash-VAT status. `regimes.read` returns the latest evidenced fact on each axis for the requested date. Missing status is null; the engine does not assume non-registration or profit taxation. These records are immutable; correction/supersession of an incorrectly recorded same-date registration needs a separate workflow.

`policies.record` retains an evidenced policy document with an expected preceding version. `policies.read` returns one key's effective version. This is a source/version registry; arbitrary policy JSON does not change calculations or authorize autonomous posting.

`rules.list` publishes the draft, hashed calculation references used by the first domestic invoice treatment. `obligations.catalogue` publishes official specification references with `not_implemented` status. Neither endpoint establishes applicability, obligation closure, deadlines, approved fiscal packages or generated returns. Signed interpretation/oracle releases remain required by [GOVERNANCE.md](GOVERNANCE.md).

## Invoice facts from XML

1. Retain original UTF-8 XML through `evidence.record` or the existing upload route.
2. Call `invoices.import` with its `evidenceId`.
3. Read the normalized result with `invoices.get` or bounded `invoices.list`.

The importer accepts bounded UBL `Invoice` type 380 and `CreditNote` type 381 documents. It uses expanded namespace URIs rather than trusting XML prefixes. It preserves invoice identity, parties, issue/tax-point date, currency, line amounts/categories/rates, tax breakdowns, totals, original-invoice reference and the source/parser hash/version.

Direction is derived from the company's identity in the supplier/customer fields. A document must identify the company on exactly one side. Deduplication uses company, direction, document type, supplier identity, invoice number and issue year. Identical semantic content returns the same record; a changed date/amount for that identity requires review and retains both uploaded originals. Parsed records cannot be updated or deleted. This deliberately conservative first workflow does not silently book a second copy with an altered date.

Line totals, allowances/charges, tax bases, tax totals, gross, prepayments, rounding and payable reconcile using decimal arithmetic. XML parsing rejects DTDs/entities, malformed UTF-8, ambiguous critical fields, wrong namespaces/currencies and bounded-complexity violations. It does not fetch external resources.

Parsing is not official CIUS-RO validation, ANAF acceptance/signature verification, evidence of delivery or a deductibility decision. ZIP archives, negative invoice-line patterns and additional invoice types need further import coverage. Other currencies, foreign counterparties and reduced categories can be retained when they fit this parser, while their automatic accounting remains unsupported. A bounded linked-credit workflow is described below.

## First deterministic invoice treatment

`invoices.propose` currently covers domestic RON service invoices with a single standard-VAT category or the non-VAT `O` category. Recognition, service and tax-point dates must fit the supported same-month accrual treatment. The caller explicitly supplies service/tax-point dates, treatment evidence, full/no purchase deduction, no counterparty cash VAT and the service account. This limited treatment uses 704/628 or their company analytical descendants; it does not infer that all uploaded purchases are services.

Draft standard-rate references distinguish 19% through July 2025 and 21% from August 2025 for the supported tax-point interval. They are sourced from [ANAF's rate-change notice](https://static.anaf.ro/static/10/Ploiesti/modificari_tva.pdf); category interpretation references the [official invoice-code guide](https://static.anaf.ro/static/10/Anaf/Informatii_R/Ghid%20cod%20facturi_final%20v2.9.pdf). Advances, cash VAT and transitional reduced rates need separate treatments.

| Case | Generated lines |
|---|---|
| Normal-VAT service sale | Dr 4111 gross; Cr 704 net; Cr 4427 output VAT. |
| Non-VAT service sale | Dr 4111 gross; Cr 704 gross; no output VAT. |
| Normal-VAT purchase, full deduction | Dr 628 net; Dr 4426 input VAT; Cr 401 gross. |
| Purchase with no deduction, including a non-VAT buyer | Dr 628 gross; Cr 401 gross. |

The source tax must match the declared rate and category base at two-decimal half-up precision. Missing registration evidence blocks the proposal. A normal-VAT company also needs evidenced non-cash-VAT status. Registration IDs, rule ID/hash, source hash, amounts and explicit treatment evidence form part of the approved proposal; posting recalculates and rechecks them. Later historical facts cannot silently reuse an earlier approval.

The result is a general proposal. The human reviews its original XML, treatment evidence, dates and exact lines in the existing screen. Approval and posting follow the ordinary exact-version contract. Agents can import/propose and execute an approved version under the appropriate separate scopes; they cannot approve or change company configuration.

## Linked credit notes and invoice positions

`invoices.proposeCreditNote` prepares an imported CreditNote 381 against one posted native invoice. The parties, direction, currency, original invoice number and tax category/rate must match. The caller supplies retained treatment evidence, a current-period decision date, reason and either commercial discount or cancellation. Discounts use 709/609; cancellations reverse the original service account. VAT reverses the original full/no-deduction treatment. The credit retains the original operation's tax point and rule/rate, including a 19% July 2025 invoice credited after August's rate change.

This workflow covers a documented new commercial event in the recognition month. A credit date alone cannot establish period treatment. Prior-period errors, year-end adjusting events, registration transitions and cash VAT fail closed and need separate workflows. Current-period credits can cross financial years while retaining the original journal/year/hash. A linked credit does not rewrite the original invoice or journal.

Cumulative net, VAT and gross credits cannot exceed the original amounts. The exact approval includes the prior credit state; a competing credit makes it stale. `invoices.reviseCreditNote` refreshes an unposted proposal for fresh human approval. The engine enforces one native posting per imported invoice across all financial years.

`positions.get` and bounded `positions.list` derive receivables/payables at a requested date: original gross minus posted credits minus signed settlements. A positive balance is open; a negative balance is refundable. Credits against fully paid invoices create a refund obligation. They do not create an unrelated second receivable/payable. Historical positions exclude later credits and settlements; allocation also checks later recorded events to prevent a backdated duplicate.

## Purchase accruals and later invoices

`accruals.propose` prepares domestic RON services received before their invoice. It requires retained service evidence, its date, a company-unique reference, the service period, supplier identity, estimated net amount, VAT category, deduction decision and reason. The initial treatment covers one service month and postable service-expense accounts in 611–626/628, including analytical descendants. Known imported invoice bytes cannot serve as the sole service-acceptance evidence. The accounting reference is [OMFP 1802/2014, points 53(2), 310(2) and account 408](https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_1802_2014.pdf); current consolidated interpretation and independent fiscal approval remain release gates.

For a normal-VAT purchase with full recovery, posting debits the service expense for net, credits 408 for gross, and debits 4428 for estimated VAT awaiting the invoice. It does not deduct that VAT through 4426 yet. With no deduction, including non-VAT buyers, the gross supplier charge is the original-period expense. Source bytes/hash, explicit dates, registration IDs and the VAT-rate rule form part of the exact approved proposal. The ordinary human approval and scoped `ledger.post` contracts apply; `accruals.revise` refreshes an unposted draft.

`accruals.get` and bounded `accruals.list` expose dated original, matched and remaining balances, including deferred VAT. `accruals.matchInvoice` prepares a retained purchase invoice against one or more posted accruals. The caller supplies receipt evidence/date and exact net/tax allocations. It supports partial matches and several accruals in one invoice when supplier, service account, deduction, tax category/rate and tax point agree. The allocations must explain the complete invoice. Existing matches, including later dated matches, reduce available capacity.

Invoice matching debits 408 and credits 401 for gross. For full VAT recovery it also debits 4426 and credits 4428. There is no second service-expense line. The invoice retains the original service/tax point and rate, while its reviewed receipt/recognition period determines this bounded deduction posting. Registration transitions and cash VAT are excluded. Invoice payables then use the existing native settlement/refund workflow. A later commercial credit links to the invoice and does not consume or reopen the original accrual again.

The match approval binds each original journal/year/hash, available balance, exact allocation, resulting balance and match version. A competing match invalidates it even when the proposed amount still fits. `accruals.reviseMatch` prepares a new version for human approval. Source/period facts and original journals stay immutable.

`accruals.reconcile` compares all dated unbilled purchase positions with the selected financial year's 408 and 4428 control balances. Once native accruals exist, a difference blocks monthly close. Cross-year matching therefore requires evidenced opening continuity; creating a new financial year does not carry its GL balances automatically. Other uses of deferred VAT and manual unbilled balances need separate supported classifications/continuity rather than being absorbed into this subledger.

The existing review screen shows service dates/evidence, VAT awaiting an invoice, receipt date and available/allocated/remaining accrual amounts. It follows original journals across financial years. Invoice headings show source gross rather than total debits of a reclassification. There are no additional manual-entry forms.

This is exact matching of evidenced purchase accruals. Unbilled sales in 418, estimate variances/reversals, opening-item migration, mixed accounts/tax points, pro-rata, cash VAT and prior-year error classification need further workflows. A generic manual 408 journal is not automatically imported as a native accrual.

## Bank, cash and native settlements

`treasury.accounts` reads company mappings; human-only `treasury.createAccount` maps each RON bank/cash identifier to a distinct postable 5121/5311 account or analytical descendant. The initial CSV bank can retain the compatible 5121 mapping; additional banks need explicit mappings. Legacy mappings preserve the earliest retained statement year, including years before the company's initial reporting selection. The original single-bank table remains only for upgrade compatibility. Account closure, remapping and currency accounts need separate lifecycle work.

`treasury.recordCash` retains a documented receipt/payment fact with source identity, date, amount and evidence. It does not post or initiate a payment. Repeated identical facts deduplicate; conflicting source IDs fail. Posting simulates daily cash balances, including later recorded entries, and rejects a negative balance.

`settlements.propose` explains one complete retained movement with native invoice allocations and optional documented 627 bank fees. It supports partial and grouped payments/receipts, signed refunds and separate or netted bank fees. An allocation is positive when it clears the invoice and negative for a refund; movement direction also depends on purchase/sale. Mixed-direction netting, advances, FX and ambiguous overpayments are excluded. The bank/cash ledger account comes from the retained mapping rather than a global 5121 constant.

The settlement becomes an ordinary exact-version proposal: human `books.approve`, then scoped `ledger.post`. Its snapshot binds movement evidence, mappings, open positions, fees and cash state. New payments/credits invalidate it; `settlements.revise` refreshes it. Posting inserts movement and invoice-allocation links atomically through guarded journal projections. Legacy matching and native settlement cannot reconcile the same movement twice. Neither capability authorizes moving funds.

The existing screen shows source invoices, adjustment reasons, signed VAT corrections, settlement allocations, fees and exact lines. It follows original journals across financial years and sums analytical bank accounts for the owner balance. Agents prepare through API/MCP; no new manual configuration dashboard was introduced.

## Working VAT registers

`vat.entries` provides bounded source-linked purchase/sale rows; `vat.summary` groups the same posted native treatments by direction, category and rate. Credits have signed negative amounts in their recognition period and retain the original tax-point/rate. Supplier VAT and deductible input VAT remain separate for non-VAT buyers and purchases with no deduction. Each row retains source/invoice/proposal/rule hashes, registration IDs and journal references.

The summary reconciles deductible input/output VAT to non-opening period movements in 4426/4427, including their analytical accounts. Opening balances are excluded. Unposted imported invoices, unclassified journals and VAT differences produce explicit review issues. A stable hash binds the report to the checked source/posting state. `reconciled` describes this technical working register only: the output explicitly has `officialDeclaration: false` and a bounded treatment scope. It does not establish D300/D394/D406 generation, legal applicability or full VAT coverage.

VAT deductions/pro-rata beyond full/no deduction, cash VAT, advances/global allowances, broader period treatments, FX/EU treatment, ZIP and additional statement formats remain step-2/3 work. Generic journals do not constitute a complete inventory, payroll or tax subsystem.

## Closing, preservation and upgrade

Month-close checks use one configured financial year and recognize general opening positions. Every active bank needs a covering statement; each bank reconciles to its own mapped ledger account at statement/month checkpoints. Native and legacy allocations both satisfy movement reconciliation. Cash accounts have daily nonnegative-balance checks. An unconfigured bank/cash ledger account, unmatched movement or imported invoice without its posted interpretation blocks close. A header-only statement CSV can evidence a month without movements. Closing remains a ledger lock, not a statement that all declarations or annual obligations are fulfilled.

The company export includes accounting years, chart, registration events, policies, imported invoice facts, proposals, approvals, postings, invoice/credit/settlement/accrual links, treasury mappings and original bytes. Local backup/restore retains the same data and guards.

Ordinary table/index/column SQL is generated from the Drizzle schema. `0007` temporarily detaches the journal normalizer, `0008` performs Drizzle's journal-line rebuild, and `0009` restores/enlarges the exact posting guards. `0010` adds policy/invoice tables; `0011` protects their immutability and invoice links. `0012` adds treasury/native-position tables; custom `0013` backfills existing native invoice postings and guards immutable projections, exact credits/settlements and compatible legacy payments. Generated `0014` adds accrual projections; custom `0015` protects original links, exact remaining capacity and atomic invoice consumption. Populated original-schema and `0011` upgrades preserve IDs, hashes, command results and posted lines through all these migrations. Earlier applied migrations remain untouched.

Per-Database-instance writes are queued; snapshot reads remain separate. Independent processes still use SQLite/libSQL locking, with the existing retryable BUSY response and the same idempotency key. No model call, human review wait or external submission runs inside a posting transaction.
