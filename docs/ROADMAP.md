# Delivery roadmap and executable gates

## Sequencing

Keep the public invoicer available. Agents perform routine work through the same typed command API used by the application. The UI primarily verifies evidence, exact effects, decisions and results; manual accounting remains available without a model. Every domain feature needs an API/tool capability and a corresponding review projection.

General-ledger primitives, bounded domestic service invoices/credits, purchase accruals, completed unbilled sales and later-invoice matching, native positions, RON bank/cash settlements and working VAT registers are implemented. Uniform subscriptions retain 471/472 schedules and future-service cancellation; post-invoice commercial discounts use separate 609/709 entries without changing the schedule; advances retain payments, invoices, final offsets and refunds through 4092/419. Retained e-Factura ZIPs preserve original/member bytes without claiming ANAF acceptance. CSV, MT940 and camt.053 now feed the same reconciliation flow with original provenance, booking/value dates and cross-format movement identity. Gap-free daily statement chains support month close. Delivery remains within step 2; scope/schedule amendments, broader period allocations, sales-estimate changes and cross-year estimate/error decisions still need distinct coverage before full service-workflow completion. Step 3 extends VAT and FX. These mechanics do not establish a complete Romanian accounting profile. [IMPLEMENTATION.md](IMPLEMENTATION.md) owns executable proof; [CONFORMANCE.md](CONFORMANCE.md) profiles remain targets until independent gates pass.

| Order | Deliverable and exit condition |
|---|---|
| 1 | General foundation: sourced/versioned chart and analytical accounts, financial years separate from the company and fiscal years, arbitrary balanced opening/general proposals, dated registrations, policies/rules and obligation catalogue. Preserve existing hashes and postings through generated Drizzle upgrades. |
| 2 | Evidence to ledger: incoming/outgoing e-Factura XML/archives; VAT and non-VAT sales, purchases and linked credit notes; counterparty positions; partial/grouped settlements, bank fees, multiple accounts, cash and CSV/MT940/camt. Proof reconciles source totals, tax amounts, ledger and open items without duplicate recognition. |
| 3 | VAT and FX: cash VAT, recoverability/pro-rata, adjustments, registration changes, EU/special-VAT branches, imports/exports and independent accounting/VAT/settlement rate dates. Prove VAT registers and their declaration mappings across transitions and periods. |
| 4 | Assets and financing: acquisitions, depreciation, disposals, separate fiscal bases, leases, loans, interest, owner loans/dividends and withholding. Prove accounting/fiscal differences and settlement controls. |
| 5 | Native payroll: contracts and effective changes, gross-to-net, employer costs, absence/leave, benefits, corrections, liabilities/payments and D112 mappings. Version every calculation input and rule; independently reconcile payroll to ledger and return. |
| 6 | Native stock and production: warehouses, quantities/units, receipts/issues/transfers/returns, approved valuation policies, inventory counts, BOM/work orders, consumed materials/labor/overheads, finished goods and work in progress. Reconcile quantity/cost subledgers to the general ledger and reporting. |
| 7 | Tax and year close: both microenterprise and profit-tax branches, fiscal adjustments, loss vintages, credits, payments, withholding, prescribed fiscal register, annual close and reviewed opening roll-forward. Execute FP-01–05 and independent regime/transition/mutation cases. |
| 8 | Reporting and official packages: required journals/ledger/inventory/trial balances, applicable D100/D101/D112/D300/D301/D390/D394/D406 and conditional reports; annual statements and supporting documents. Pin schemas and official validator/PDF tools, reconcile content, export an exact signing/submission package and track imported receipts. |
| 9 | Replacement proof: MIG-01 continuity and responsibility, independent fiscal review, quarterly/year-end reference outputs, real-company parallel closes, complete obligation closure and restore/replay. Approve only the exact covered company, interval and version combination. |

Run steps in this order, carrying forward existing evidence, API/MCP access, exact approvals and tests. Within a step, deliver bounded vertical workflows with explicit exclusions. Do not label a generic journal capability as complete support for payroll, stock, VAT or a declaration.

Initial verification covers 2025 and 2026. Historical opening balances and tax vintages need retained authority; later annual formats remain pending until published and independently checked. Both VAT and non-VAT, micro/profit taxation, payroll and manufacturing remain committed scope, not unspecified future product ideas.

The existing capability API and scoped-credential MCP are infrastructure already available to every new accounting module. Deployment, browser OAuth delegation, a built-in model agent and AI billing are outside this accounting sequence. The UI verifies actual evidence/effects; do not grow a second manual accounting application alongside the engine.

Filing fulfillment initially uses external signing/submission of the validated official package and receipt import. Reserve explicit authorization for exact artifacts and keep prepared/validated/exported/submitted/accepted states distinct. Direct submission automation is not a prerequisite.

## First coding ticket: general accounting foundation

1. Source the general chart and represent postable accounts, groups and company analytical accounts; retain source/hash/version and avoid unsupported claims of a reviewed current consolidation.
2. Separate financial/fiscal years from company identity. Require an explicit report year when several exist; never sum repeated annual opening balances.
3. Generalize evidence-backed opening/general proposals and linked adjustments to arbitrary supported general-ledger accounts. Approval binds the full exact lines, dates, source and year.
4. Preserve existing evidence, fact/proposal hashes, approved entries, idempotency and database guards through a populated-book upgrade, export and restore.
5. Run independently specified sales/purchase posting fixtures for VAT and non-VAT in both 2025 and 2026, alongside stale approvals, closed periods, cross-company access and direct balanced-tampering failures.
6. Expose configuration, proposals, exact posting effects and year reports through the shared API/MCP. Reuse the existing review screen.
7. Add effective-dated policy/rule/obligation records and move to the document-to-ledger workflow. Independent fiscal review remains required before any conformance claim.

## Ticket A1: keep the first slice small

1. Create a domestic non-VAT profit-tax services SRL. Import approved opening entries: debit bank 1,000.00 RON, credit paid-in capital 1,000.00 RON.
2. Retain a synthetic domestic supplier invoice for 100.00 RON with no VAT and its source metadata/hash.
3. Review the accounting interpretation and post debit services expense 100.00 RON, credit supplier payable 100.00 RON. Preserve the distinct fiscal interpretation/position reference.
4. Import a statement starting at 1,000.00 RON, containing the 100.00 RON payment and ending at 900.00 RON. Match and post the payment.
5. Show bank 900.00 RON, supplier payable zero, expense 100.00 RON, capital 1,000.00 RON and a balanced trial balance, with traceable evidence.
6. Reimport/retry without adding entries; restart and reproduce results. A second company/user cannot read or mutate any record.
7. Run the same domain commands from API and UI. No AI, payment collection, live ANAF authorization or global plugin framework is needed.

## Ticket A1b: deliberately difficult second fixture

Use one normal-VAT RON company with an approved source/configuration snapshot and a fixed period-specific oracle:

1. Receive supplier e-Factura XML with a conflicting rendered PDF; record a source-authority decision without erasing either source.
2. Recognize a reviewed service purchase and its accounting/fiscal/VAT treatment.
3. Import a partial bank payment and separate bank fee; preserve the payable and distinguish payment timing from VAT treatment.
4. Close the first month and create its applicable D300/D394/D406 outputs from the same ledger and tax-position snapshot.
5. Receive a linked credit note in the following month; produce the reviewed cross-period accounting/tax effects.
6. Introduce an error discovered after close. Use the approved correction procedure, preserve the old closed snapshot/artifacts, invalidate stale approvals and produce the applicable revised outputs.
7. Retry imports/jobs, inject a lost submission response and verify that the system neither duplicates records nor claims receipt acceptance.

The oracle specifies complete amounts, source/rule versions, statement/control balances and expected reporting artifacts. Official tools validate complete applicable outputs before the corresponding public reporting claim; a fragment/shape test is explicitly labeled and never presented as that proof.

## Accountant adoption and pilot

Recruit an accounting partner alongside the accounting work. Obtain consented opening balances, tax-history registers, representative statements, source documents and reference outputs. Publish only synthetic or explicitly cleared anonymized cases.

By step 9, the accountant portfolio shows companies they may access, reporting periods, freshness, missing evidence, bank differences, blocked closes and pending/rejected filings. Every count drills into actual records; revoked membership removes access immediately. Full firm billing/staff orchestration is not required.

Preserve the migration process in [ARCHITECTURE.md](ARCHITECTURE.md): reviewed opening position, separate tax-history evidence, control reconciliation, retained originals and explicit activation. Do not infer historical books from XML or require a legacy paid-AI conversion to migrate accounting.

## Priority implementation tickets

| Priority / ticket | Required proof | Delivery |
|---|---|---|
| P0 GL-01 | General chart/years/openings/proposals, preserved upgrade and VAT/non-VAT 2025/2026 posting fixtures. | Step 1 |
| P0 DOC-01 | Incoming/outgoing XML and settlements reconcile with evidence and open items; unsupported treatments block interpretation. | Step 2 |
| P0 VAT-01 | Normal/special/cash VAT, deduction, corrections and dated regime/FX interactions. | Steps 2–3 |
| P0 CONF-01 | Obligation closure; EU-service, VAT-transition, non-VAT D406 and unknown facts fail closed. | From step 1; full gate by step 9 |
| P0 FISC-01 | Effective-dated legal/calendar/register authority and independently reviewed expected outputs. | Steps 1/7/8 |
| P0 FISC-02 | Distinct adjustments, credits, losses and payments with immutable correction lineage. | Steps 4/7 |
| P0 LEDGER-01 | Accrual/later-invoice/credit-note links; FP-01/02 avoid cross-period duplicate recognition. | Step 2 |
| P0 PAY-01 | Native reviewed payroll and D112 content/validator proof. | Steps 5/8 |
| P0 STOCK-01 | Native inventory and production subledgers reconcile quantities, valuation and GL. | Step 6 |
| P0 TEST-01 | Independent legal/expected oracles and deliberate fiscal/period mutation failures. | Every step |
| P0 FILING-01 | Exact official packages, external signing/submission handoff and imported pending/rejected/accepted receipts. | Step 8 |
| P0 MIG-01 | Signed handover, current-year/tax continuity and exact controls; missing history blocks activation. | Step 9 |
| P1 UX-01 | Accountant exception portfolio drills into authorized records and actual unresolved work. | Step 9 |
| P1 CONF-02 | Independently prove combined VAT/currency/time/EU/asset/payroll/stock regimes. | Each affected step |

These are planned work items, not created external tracker issues. [FISCAL_FIXTURES.md](FISCAL_FIXTURES.md) owns the candidate cases, [MIGRATION.md](MIGRATION.md) the handover proof, and [REGULATORY_BASELINE.md](REGULATORY_BASELINE.md) the dated authority.

## Launch gates and dependencies

- Independent fiscal reviewers, a consenting pilot and signed expected outputs are required for fiscal claims.
- Profile/corpus/schema compatibility, official validators, reproducible reports, security controls and recovery evidence must pass.
- RO-SRV-01-FULL-YEAR passes complete obligation closure, independent fiscal conformance, migration/source integrity, authorized fulfillment and funded recovery/capacity gates for the exact company/interval. No single ledger-close result or confidence score substitutes.
- Every required output has the applicable format/rule, reporting period, responsible qualified/authorized actors and exercised submission/guided-handoff/receipt path. Future acceptance is tracked when due; unpublished annual formats remain explicit gaps or assigned external responsibilities.
- Free hosting has a funded admission/support envelope; exact figures are operator inputs, not invented estimates.
- Licensing targets have a rights/dependency/boundary review before relicensing or applying new package licenses.
- The maintained reference self-host deployment starts without Piatra secrets and completes install/upgrade/export/restore checks.

Track executable work in one implementation tracker when tickets begin; keep this roadmap focused on delivery gates rather than appending dated status blocks.

## Work outside this sequence

Browser OAuth delegation, the built-in Piatra AI/BYOK agent, direct ANAF submission automation, deployment expansion and managed-AI billing have separate backlog items. Existing operating/security requirements still apply to any live service. Fiscal completeness and the committed native accounting modules take priority.
