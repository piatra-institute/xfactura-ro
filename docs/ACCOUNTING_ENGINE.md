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

This is exact matching of evidenced purchase accruals. Same-year estimate changes and release of unbilled amounts use the separate workflow below. Opening-item migration, mixed accounts/tax points, pro-rata, cash VAT and prior-year error classification need further workflows. A generic manual 408 journal is not automatically imported as a native accrual.

## Purchase-estimate adjustments

`accruals.proposeAdjustment` prepares a change to the remaining, still-unbilled purchase estimate. It requires a unique adjustment reference, separately retained evidence, evidence/new-information/posting dates, a reason and the explicit `current_year_estimate_change` basis. `reestimate` names a positive new remaining net amount; `release` names zero. The original evidence cannot stand in for the new information. The posting month must be open and contain the new-information date. This bounded workflow stays within the original financial year; prior-year errors and year-end adjusting events require distinct decisions and workflows.

The accounting reference is [OMFP 1802/2014, point 70 on prospective changes of estimates, distinct from points 65–69 on errors and 71–74 on subsequent events](https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_1802_2014.pdf). The recorded basis is a human-reviewed assertion; independent current fiscal interpretation/package approval remains unfinished.

An increase posts the added expense, 408 liability and any recoverable VAT still awaiting an invoice in 4428. A decrease/release posts the inverse difference. With no recovery, supplier VAT remains in expense. The original tax point, rate, service account and deduction treatment remain fixed. No adjustment deducts VAT through 4426 or changes an already posted invoice/payable. Partial matches remain intact; releasing a remainder cannot cancel their invoice balances. A fully invoiced or released position cannot be reopened through this capability.

For example, 100.00 net + 21.00 VAT recognized in January can be re-estimated to 120.00 + 25.20 in February: Dr 628 20.00, Cr 408 24.20 and Dr 4428 4.20. A later 145.20 invoice clears the adjusted accrual and recognizes input VAT without another expense. If 40.00 + 8.40 has already been invoiced, releasing the remaining 80.00 + 16.80 preserves the 48.40 supplier payable and leaves total service expense 40.00. Original facts, proposals, approvals and journals remain immutable.

Approval binds the original journal/hash, preceding adjustment journal, all known matches/adjustments, prior remaining amounts, new amounts, signed deltas, evidence and rule/registration snapshot. `accruals.reviseAdjustment` refreshes a stale draft for new human approval. Matches and adjustments invalidate each other's approvals even when the requested amount still fits. New adjustments cannot precede already recorded events; an invoice match cannot consume an increase posted after its recognition date. Database guards independently enforce the state-bound amounts, exact lines, atomic projections and immutable links.

`accruals.get/list` preserve the original `net/tax/gross/deferredTax` and add dated `adjustedNet/adjustedTax/adjustedGross/adjustedDeferredTax` and `adjustmentCount`. Remaining amounts include posted changes minus matches. A zero remainder released by an adjustment has status `released`; complete invoice matching has status `matched`. Bounded `accruals.adjustments` returns the dated adjustment history and provenance. Reconciliation includes signed adjustments in 408/4428. Working VAT treats them as classified accrual movements with no additional deduction.

The review screen shows before/after/difference amounts, the new-information date/reason and the original journal link. A later invoice also links its latest adjustment. API/MCP prepares and revises; the existing exact human approval and `ledger.post` execute. No manual adjustment form was added. Sales-estimate changes, cross-year estimate/error classification, mixed regimes and opening-item migration remain separate work.

## Unbilled sales and later invoices

`unbilledSales.propose` prepares earned domestic RON service revenue before invoicing. It requires retained service evidence and its date, a unique reference, customer identity, one service month, a positive net amount, 704 or its analytical descendant, and an explicit `completed_service` tax-point basis. Recognition and tax point equal the documented service-completion date. Known imported invoice bytes cannot be the sole service evidence. `unbilledSales.revise` preserves the preceding fact and invalidates its approval.

| Case | Service recognition | Later issued invoice |
|---|---|---|
| Normal VAT, without cash VAT | Dr 418 gross; Cr 704 net; Cr 4427 output VAT at service completion | Dr 4111 gross; Cr 418 gross |
| Non-VAT, supported O category | Dr 418 net; Cr 704 net | Dr 4111 net; Cr 418 net |

The accounting reference is [OMFP 1802/2014, accrual recognition and account 418](https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_1802_2014.pdf). For this bounded non-cash-VAT service treatment, invoice absence does not postpone output VAT. [ANAF's July 2025 inspection findings, case 3](https://static.anaf.ro/static/10/Anaf/Informatii_R/inspectie_fiscala/Informare%20privind%20cazurile%20semnificative%20constatate%20de%20IF%20%C3%AEn%20luna%20iulie%202025.pdf) describe understated output VAT left in 4428 on supplied services. The implemented interpretation and draft rate references still require independent, current fiscal review; these sources do not establish an approved fiscal package.

`unbilledSales.matchInvoice` matches one retained outgoing Invoice 380 to posted services, at its issue date. It supports exact partial allocations and grouping when customer, revenue account, category/rate and original tax point agree. The invoice must retain that tax-point date (or be issued on that same date) and explain the complete allocated net/tax amounts. Matching creates the invoice receivable without another revenue or VAT posting. The invoice then uses existing collections, credit notes and refund workflows. A later commercial credit does not consume or reopen the unbilled-service position.

The exact approval retains every original journal/year/hash, available gross, allocation, resulting balance and match state. Competing matches return `STALE_UNBILLED_SALE_MATCH`; refresh through `unbilledSales.reviseMatch` and obtain a new human approval. All known matches constrain remaining capacity, including ones after a historical read date. `unbilledSales.get` and bounded `unbilledSales.list` return dated original/invoiced/remaining amounts. `unbilledSales.reconcile` compares those positions to the selected financial year's 418 control, including analytical accounts. Missing carried balances block close once native unbilled sales exist.

The existing black review screen shows customer, service/evidence dates, applicable output VAT and exact lines. A matched invoice identifies VAT collected previously and links its available/allocated/remaining service amounts to original journals across years. API/MCP prepares the work; human approval remains separate. There are no new manual-entry forms.

Continuous/milestone services with different tax points, earlier invoices or advances, estimate differences, mixed accounts/tax points, registration transitions, cash VAT, reduced/exempt/EU/FX branches and prior-period error decisions need separate treatments. Invoice deadlines/e-Factura fulfillment and official declaration mappings are still part of the unfinished obligation/reporting work. A manual 418 posting is not a native unbilled-service position.

## Subscription allocations through 471/472

`deferrals.proposeInvoice` prepares an imported domestic RON subscription invoice with a documented uniform benefit over complete calendar months. It requires contract evidence separate from the invoice, its date, a reason, service start/end, `uniform_subscription`, `equal_calendar_months` and `early_invoice`. The invoice is issued on or before the first service day; recognition and VAT tax point equal its issue date. The present workflow uses 628/704 or their analytical descendants, one standard-VAT or O category, full/no purchase deduction and stable non-cash-VAT registration. Known rate/registration transitions and dates outside the draft rule catalogue fail closed.

The accounting reference is [OMFP 1802/2014, paragraph 351 and accounts 471/472](https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_1802_2014.pdf). The early-invoice VAT basis references [Fiscal Code Article 282(2)(a)](https://static.anaf.ro/static/10/Anaf/legislatie/L_227_2015.pdf); rate-change regularization requires a separate treatment. These published references support the bounded design; they are not a signed current fiscal package or independent interpretation.

| Case | Invoice recognition | Monthly allocation |
|---|---|---|
| Purchase with full VAT deduction | Dr 471 net; Dr 4426 deductible VAT; Cr 401 gross | Dr 628; Cr 471 |
| Purchase without deduction | Dr 471 gross; Cr 401 gross | Dr 628; Cr 471 |
| Normal-VAT sale | Dr 4111 gross; Cr 472 net; Cr 4427 VAT | Dr 472; Cr 704 |
| Non-VAT sale | Dr 4111 net; Cr 472 net | Dr 472; Cr 704 |

The schedule retains 1–60 complete calendar months and exact integer-bani division. Each month receives the quotient; the final month receives the remaining bani. Thus 100.00 over three months yields 33.33, 33.33 and 33.34. Zero-value months are explicit and require no journal. Supported rule dates currently bound executable schedules to 2025/2026 even though the schedule primitive permits 60 months. Partial months, daily/nonuniform allocation and automatic contract inference are unsupported.

`deferrals.proposeRelease` names the posted deferral, month and selected financial year. It prepares a month-end release, with the exact source invoice/journal/year/proposal hash, contract hash, rule and registrations. Both the invoice and every monthly release require human `books.approve` and exact `ledger.post`; `reviseInvoice`/`reviseRelease` invalidate earlier approvals. A release never repeats invoice VAT and does not depend on payment. The invoice retains ordinary supplier/customer positions and settlement support.

`deferrals.get` and bounded `deferrals.list` return dated original/allocated/remaining amounts and schedule states (`scheduled`, `posted`, `not_required`), including carried prior-year schedules. `nextDueMonth` identifies a positive unposted amount due by the read date. `deferrals.reconcile` compares all dated native remaining amounts with 471/472 in one financial year. Explicit opening continuity is required across years. Due allocations and unexplained control differences block month close. Ordinary manual 471/472 balances are not synthesized into native schedules.

Posting rechecks source facts and the actual release month's registration/rate. A newly evidenced transition blocks affected releases; earlier valid months remain releasable. SQLite guards verify the uniform schedule, exact invoice/release lines, atomic native links, one release per month and immutable history. Exports and backup/restore include both projections. The existing black review screen shows contract period/reason, the schedule and exact effects; a monthly release links the original journal across financial years. No new entry form was added.

Advances in 409/419, price discounts, schedule amendments, partial-month benefits, mixed categories and VAT transitions need distinct supported treatments. The ordinary credit-note workflow rejects deferred source invoices; cancellation of future services uses the separate workflow below. Unsupported imported credits remain visible and block close until resolved. Annual roll-forward, fiscal deductibility/annual tax and official declaration coverage remain unfinished.

## Cancellation of future subscription services

`deferrals.proposeCreditNote` links a retained CreditNote 381 to the original subscription invoice. It requires a separate written cancellation agreement, its decision date, `cancellation`, `current_period_event` and `cancelFrom`, the first day of a scheduled month. The cancellation removes that month and every following month. Recognition and credit issue cannot follow `cancelFrom`; the agreement, invoice and recognition belong to the same current reporting month. All known releases must be dated on or before recognition, and no selected month can already have recognized amounts. The original contract, both XML sources, previously posted journals and earned expense/revenue stay immutable.

The future-service distinction references [HG 284/2017, amendment to Fiscal Code norms point 32(3)](https://static.anaf.ro/static/10/Anaf/legislatie/HG_284_2017.pdf): cancellation of services adjusts the base for services not provided. This is an interpretation reference requiring current independent fiscal review, not a signed 2025/2026 conformance package. The engine does not infer non-performance or an annual adjusting event from a credit-note date.

The credit must exactly equal the cancelled schedule's cost/revenue basis, including any irrecoverable purchase VAT. A purchase debits 401 and credits 471 plus any reversal of deductible 4426; a sale credits 4111 and debits 472 plus output-VAT reversal in 4427. The original category/rate and full/no-deduction decision apply; registration changes and cash VAT remain unsupported. This workflow supports one future-service cancellation per source subscription. Price reductions, a second amendment, retroactive cancellations, recognised-service reversals and prior-year error decisions require separate treatments.

The exact approval binds original invoice/journal/year/hash, all releases, the original credit state, agreement hash, cancelled months and before/after amounts. An intervening allocation makes the cancellation stale (`STALE_DEFERRAL_CREDIT`); use `deferrals.reviseCreditNote` and new human approval. A posted cancellation blocks releases in the cancelled months. It also invalidates earlier approvals for unaffected releases; `deferrals.reviseRelease` refreshes them. Already approved unposted releases in cancelled months become `superseded`, remain accessible through API/export and no longer appear as actionable work or block close.

`deferrals.get/list` add dated `cancelled`, a nullable cancellation reference and `cancelled` schedule/position states. `allocated` still means recognized expense/revenue; `remaining = amount - allocated - cancelled`. Each cancelled month links its cancellation journal. The existing 471/472 controls exclude cancelled amounts and due months. Native invoice positions retain the credit and may become refundable; existing documented settlements execute the accounting for a refund without moving money.

The paid purchase fixture records 121.00, recognizes January cost 33.33, then cancels February–March with credit 66.67 + 14.00 VAT. It preserves January, clears 471, leaves deductible VAT 7.00 and recognizes an 80.67 refund balance. The documented refund leaves bank 959.67 and supplier balance zero. The cross-year fixture carries a December 2025 invoice into 2026, retains the original VAT and records the credit in its current reporting period. Non-VAT and no-deduction variants retain their original cost basis.

The review screen shows the written agreement, original invoice link, cancelled months, recognized amount, deferred balance before/after and exact lines. API/MCP prepares and revises; human `books.approve` and exact `ledger.post` remain required. Generated Drizzle migration `0022` adds the cancellation projection; hand-written trigger SQL in the separately created custom migration `0023` enforces cancellation/release invariants. A populated `0021` upgrade, balanced wrong-account/month mutations, stale approvals, exports and fresh restore verify the implemented boundary.

## Bank, cash and native settlements

`treasury.accounts` reads company mappings; human-only `treasury.createAccount` maps each RON bank/cash identifier to a distinct postable 5121/5311 account or analytical descendant. The initial CSV bank can retain the compatible 5121 mapping; additional banks need explicit mappings. Legacy mappings preserve the earliest retained statement year, including years before the company's initial reporting selection. The original single-bank table remains only for upgrade compatibility. Account closure, remapping and currency accounts need separate lifecycle work.

`treasury.recordCash` retains a documented receipt/payment fact with source identity, date, amount and evidence. It does not post or initiate a payment. Repeated identical facts deduplicate; conflicting source IDs fail. Posting simulates daily cash balances, including later recorded entries, and rejects a negative balance.

`settlements.propose` explains one complete retained movement with native invoice allocations and optional documented 627 bank fees. It supports partial and grouped payments/receipts, signed refunds and separate or netted bank fees. An allocation is positive when it clears the invoice and negative for a refund; movement direction also depends on purchase/sale. Mixed-direction netting, advances, FX and ambiguous overpayments are excluded. The bank/cash ledger account comes from the retained mapping rather than a global 5121 constant.

The settlement becomes an ordinary exact-version proposal: human `books.approve`, then scoped `ledger.post`. Its snapshot binds movement evidence, mappings, open positions, fees and cash state. New payments/credits invalidate it; `settlements.revise` refreshes it. Posting inserts movement and invoice-allocation links atomically through guarded journal projections. Legacy matching and native settlement cannot reconcile the same movement twice. Neither capability authorizes moving funds.

The existing screen shows source invoices, adjustment reasons, signed VAT corrections, settlement allocations, fees and exact lines. It follows original journals across financial years and sums analytical bank accounts for the owner balance. Agents prepare through API/MCP; no new manual configuration dashboard was introduced.

## Working VAT registers

`vat.entries` provides bounded source-linked purchase/sale invoice rows; `vat.unbilledSales` separately pages the original unbilled-service recognition rows. `vat.summary` combines their movements by direction, category and rate. Credits have signed negative amounts in their recognition period and retain the original tax-point/rate. Supplier VAT and deductible input VAT remain separate for non-VAT buyers and purchases with no deduction. Rows retain source/proposal/rule hashes, registration IDs and journal references; invoice rows also retain their invoice hashes.

An invoice matched to previously recognized sales has zero additional base, tax and gross movements in `vat.entries`. Its additive `previousRecognition` object retains the invoice amounts and original unbilled-service IDs. The original base/output tax appears in `vat.unbilledSales` at service recognition. `vat.summary.entryCount` counts both kinds of rows, including the informational invoice match; `unbilledSaleEntryCount` identifies the service-recognition count. This prevents both cross-year and same-year double counting while retaining invoice provenance.

The summary reconciles deductible input/output VAT to non-opening period movements in 4426/4427, including their analytical accounts. Opening balances are excluded. Unposted imported invoices, unclassified journals and VAT differences produce explicit review issues. A stable hash binds the report to the checked source/posting state. `reconciled` describes this technical working register only: the output explicitly has `officialDeclaration: false` and a bounded treatment scope. It does not establish D300/D394/D406 generation, legal applicability or full VAT coverage.

VAT deductions/pro-rata beyond full/no deduction, cash VAT, advances/global allowances, broader period treatments, FX/EU treatment, ZIP and additional statement formats remain step-2/3 work. Generic journals do not constitute a complete inventory, payroll or tax subsystem.

## Closing, preservation and upgrade

Month-close checks use one configured financial year and recognize general opening positions. Every active bank needs a covering statement; each bank reconciles to its own mapped ledger account at statement/month checkpoints. Native and legacy allocations both satisfy movement reconciliation. Cash accounts have daily nonnegative-balance checks. An unconfigured bank/cash ledger account, unmatched movement or imported invoice without its posted interpretation blocks close. A header-only statement CSV can evidence a month without movements. Closing remains a ledger lock, not a statement that all declarations or annual obligations are fulfilled.

The company export includes accounting years, chart, registration events, policies, imported invoice facts, proposals, approvals, postings, invoice/credit/settlement/purchase-accrual/unbilled-sale links, treasury mappings and original bytes. Local backup/restore retains the same data and guards.

Ordinary table/index/column SQL is generated from the Drizzle schema. `0007` temporarily detaches the journal normalizer, `0008` performs Drizzle's journal-line rebuild, and `0009` restores/enlarges the exact posting guards. `0010` adds policy/invoice tables; `0011` protects their immutability and invoice links. `0012` adds treasury/native-position tables; custom `0013` backfills existing native invoice postings and guards immutable projections, exact credits/settlements and compatible legacy payments. Generated `0014` adds purchase-accrual projections; custom `0015` protects original links, exact remaining capacity and atomic invoice consumption. Generated `0016` adds unbilled-sale positions/matches; custom `0017` guards their origins, exact revenue/VAT/transfer lines, consumption and immutable projections. Generated `0018` adds purchase-estimate adjustments; custom `0019` protects their exact differences and extends invoice-consumption guards to adjusted capacity. Populated original-schema, `0011`, `0015` and `0017` upgrades preserve IDs, hashes, command results and posted lines through these migrations. Earlier applied migrations remain untouched.

Per-Database-instance writes are queued; snapshot reads remain separate. Independent processes still use SQLite/libSQL locking, with the existing retryable BUSY response and the same idempotency key. No model call, human review wait or external submission runs inside a posting transaction.
