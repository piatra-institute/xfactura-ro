# Delivery roadmap and executable gates

## Agent-first delivery (owner decision, 2026-10-30)

AI agents drive the engine: they gather evidence, propose bookings, ask the questions only a person can answer, and prepare returns. People check, approve and make quick corrections. The engine computes every amount from cited rules.

**Who approves.** The owner approves everyday items. The company's accountant reviews the month and signs the annual statements.
- For an SRL, Legea 82/1991 requires an employee with higher economic studies or a CECCAR member to keep the books (art. 10 alin. (2)–(4)), and that person signs the annual statements together with the administrator (art. 28 alin. (10)–(13)).
- A PFA, II or IF may keep its own books (art. 10 alin. (4^1)).

**Autonomy is earned.**
- People first approve agent proposals in batches.
- A booking template posts on its own only after a measured run of correct shadow bookings, within partner and amount limits. This includes matching payments that already happened.
- It is demoted automatically after a correction.
- Returns, submissions and money transfers always need a person.

**Order:**
1. **Phase 0:** safety fixes and the yearly rule rollover ([ROLLOVER.md](ROLLOVER.md)).
2. **Phase 1, engine plumbing for agents:**
   - intake of any document with checked extraction;
   - bank statements from CSV and PDF;
   - one worklist and a change feed;
   - questions to people;
   - batch approval;
   - booking templates with a track record;
   - earned auto-posting with a kill switch.
3. **Phase 2:** every remaining regime for SRL, PFA, II and IF under about $1M, each module agent-ready from the start: its document types, questions, worklist detectors and template fields.
4. **Phase 3, correctness machinery, running throughout:**
   - two-tier rule review: partner accountants mark rules `interpreted`, which unlocks shadow use; the expert's signed review packets unlock live use;
   - cross-return checks;
   - differential comparison with other software;
   - an agent evaluation harness;
   - release gates per profile.
5. **Phase 4:** the built-in agent on the company's own model key (Anthropic, OpenAI or any OpenAI-compatible endpoint), MCP over OAuth for external clients, and the five-view dashboard.
6. **Phase 5:** the free hosted launch in the EU, and retiring the legacy paid extraction.

PFA, II and IF are in scope ([PFA_II_IF.md](PFA_II_IF.md)). Excise, fiscal groups, IFRS and medium, large or audited entities stay explicitly unsupported.

## Agent-first backlog

The ordered work after Phase 1 and the first Phase 2 modules, as of 5 November 2026:
- built in Phase 2 so far: determinations and obligation closure, profit tax and the micro ↔ profit transitions, small-entity statements, the remaining PFA work, quarterly D112, the ANAF tax account, the D406 extras, the non-payer branch;
- what exists in detail: [IMPLEMENTATION.md](IMPLEMENTATION.md) and [ACCOUNTING_ENGINE.md](ACCOUNTING_ENGINE.md).

Sizes: S (one focused piece), M (a module), L (several modules' worth). Every module ships its `agent.ts`, cited parameters, review specs for the readings the text leaves open, database guards with attacks, and an official-validator test where ANAF publishes a validator.

### Now: inputs only the owner can supply

| Item | Why it matters |
|---|---|
| Commit the work, after re-staging (the index holds intermediate versions) | A large uncommitted change set is the biggest operational risk. |
| Send the first review packets to the expert, in `bun scripts/review/queue.ts` order. The first: `ro.vat.rate.reduced` + `ro.micro.rate`, then `ro.taxaccount.distribution`, `ro.vat.deduction.limited`, `ro.vat.exemption.threshold`, `ro.vat.rate` | Nothing can run live until rules are signed. The 26 ready packets take about 166 minutes. |
| Download by hand (legislatie.just.ro refuses automated requests): OPANAF 1612/2018, 1613/2018, 146/2025, 874/2024 and OMFP 1899/2004 | Without them, amendments to the tax-account rules after 2025 are unverified. |
| Recruit one partner accountant (CECCAR), ideally a SAGA or WinMentor user | Unlocks the `interpreted` tier and shadow use, checking the evaluation's expected answers, and the differential comparison. |
| The pilot company's SPV archives, filed returns, trial balances and bank statements (in `.private/`) | The first real replay. |
| An Anthropic API key with a budget for `bun run eval:record` | The first measurement of a real agent; today only the scripted baseline is scored. |

### Wave 1: unblock ordinary services companies (November–December 2026)

| # | Module | Content | Oracle | Size |
|---|---|---|---|---|
| 1 | V2 Exempt supplies, pro-rata, capital goods | Built 5 November 2026 ([ACCOUNTING_ENGINE.md](ACCOUNTING_ENGINE.md#exempt-supplies-the-pro-rata-and-capital-goods-v2)): purchases and sales in E, K and G with their legal basis and VATEX reason (D300 rd. 1, 14, 15, 29; D390 L), the option to tax a rent, the provisional pro-rata and its December adjustment (`vat.proRata`), capital goods adjusted on a change of use, each year, on supply and cessation, with their register, art. 304 on a change of regime, art. 306 where the period ended. Left: the special pro-rata, the pro-rata under VAT on collection, D394 type N, the D406 code of a pro-rata purchase, art. 306's proportional case and art. 332. | DUKIntegrator D300/D394/D390, e-TVA | M–L |
| 2 | V3 Receipts and domestic reverse charge | `receipts.recognize`: a fiscal receipt with the buyer's CUI as a simplified invoice up to the art. 319 limit (source it); VAT from expense reports; receipts in D394; domestic reverse charge (art. 331). Fuel and parking receipts are common to every company. | DUKIntegrator D394 | M |
| 3 | O1 Withholding | D406 withholding codes (today `D406_WHT` refuses any period with dividend or interest withholding; pin ANAF's 16.02.2026 definitions, which add 604040). Rent and IP paid to individuals. Interim dividends (463). Non-resident payees: art. 223–224, residence certificates, treaty rates, D207. | SAF-T kit, D100/D205/D207 validators | M |
| 4 | Wave-1 small fixes | Asset sales on 7583 (refused by `invoices.recognize`, so the D406 assets file can't report a sale). A first financial year starting mid-year (determinations read facts at 1 January). D101 listed for an SRL whose tax regime is unknown. The half-year report in the closure, not only the worklist. `cross-border.ts` and `etva.ts` still choose the rate by BT-7. Art. 291 alin. (6) regularisation of advances across a rate change. | existing suites | S each |

### Wave 2: the FY2026 close and the 2027 rollover (December 2026 – February 2027)

| # | Module | Content | Oracle | Size |
|---|---|---|---|---|
| 5 | Y1 Year-end in full | Annual inventory (OMF 2861/2009) and its differences; impairment on 491; provisions (untaken leave, bonuses, litigation) per policy; FX and cut-off review of 408/418/471/472; the reviewed opening roll-forward into 2027 (itemized opening equals the closing snapshot). | property tests, replay | M |
| 6 | R0 Rollover 2027 | 92 of 94 keys stop on 1 January ([ROLLOVER.md](ROLLOVER.md)). Source the December acts (minimum-wage decision, fiscal measures, budget laws) and review the stable keys again. Pin the 2027 return formats as ANAF publishes them: D300, D394, D112, D406, D100. | texts, new ANAF packages | S–M, calendar-driven |
| 7 | FY2026 forms as published | S1005 and S1003 for FY2026 (expected January–February 2027); D212 for 2026 income (due 25 May 2027); D101 for FY2026 (due 25 June 2027). Each is a `FORMAT_GAP` until pinned; nothing is inferred from 2025. | ANAF packages | S each |

### Wave 3: remaining VAT schemes, payroll, profit-tax leftovers (Q1 2027)

| # | Module | Content | Size |
|---|---|---|---|
| 8 | V4 Special VAT schemes | OSS/IOSS (distance sales to EU consumers above €10k, the OSS return); margin schemes (art. 311–312: second-hand goods, art, travel agencies); the agricultural flat rate (art. 315^1). | M ×3 |
| 9 | W1 Payroll extras | Benefits in kind; the other sick-leave codes; payroll corrections with D112 rectification; garnishments; the administrator's mandate contract; REGES tracked as an external obligation. | M |
| 10 | Profit-tax leftovers | The annual system with prepayments; sponsorship carried forward (D107 and D101 row 43.2); reinvested-profit and other exemptions and credits; the D700 and D710 writers (both tracked as filed outside today); prior-year rectifications. | M |
| 11 | PFA/IF leftovers | An IF with several sources; an IF on a norm (pending the expert); how D212 presents a method change within the year; tax not final at source on declared income. | S–M |
| 12 | Tax-account leftovers | Payment facilities and insolvency; the individuals' single account (55.04); art. 167's offset order; ANAF's month-end interim distribution; D300 row 42. | S–M |

### Wave 4: goods (Q1–Q2 2027)

| # | Module | Content | Size |
|---|---|---|---|
| 13 | G1 Stock | Items and warehouses; NIR, consumption slips, delivery notes, transfers and returns; FIFO or weighted average as a policy; the retail sale-price method (378/4428); counts and write-downs (397); `effect@2 stockMoves`; register equals 30x–37x; the D406 stock file. | L |
| 14 | G2 Retail and B2C | Z reports and receipts; card settlements (5125); B2C e-Factura; fiscal cash registers (AMEF) tracked. | M |
| 15 | G3 EU goods, imports, exports | D390 L/A/T/R; VIES and transport proof; customs declarations and the VAT deferral certificate; Intrastat watch; e-Transport tracker. | L |
| 16 | G4 Production | BOMs, work orders, WIP (331), finished goods (345/348/711), overhead allocation. | L |

### Wave 5: leftovers

| # | Module | Content | Size |
|---|---|---|---|
| 17 | F1/X1 | Overdrafts and revolving credit; the calendar for interest-only months; local taxes (rates from the local council's decision as evidence); the environment fund where it applies. | S each |
| 18 | Live e-Factura | The first live call from the owner's session; verifying the Ministry's XMLDSig against a pinned chain. | S–M |

### Correctness track (runs alongside every wave)

| Item | Content |
|---|---|
| Expert reviews | Send packets as the queue ranks them. Write specs for the 67 keys that have none, so the queue can score them. Partner accountants raise rules to `interpreted`. |
| Cross-return checks | A registry run in the `declarations.authorize.request` preview: D300↔D394, D300↔D406↔trial balance, D112↔payroll↔421/431/444, D100↔4418/446, D205↔D100s, D204↔D212s, F10↔trial balance, D101↔fiscal register. |
| Readiness report per profile | `scripts/conformance/report.ts`: preview, shadow or live per company type, from the register and the recorded proof ([CONFORMANCE.md](CONFORMANCE.md)). |
| Parameter mutation tests | `scripts/mutate-params.ts`: perturb each version; a mutant no test catches enters the review queue. |
| Differential comparison | SAGA, WinMentor or Ciel outputs from the partner accountant, compared field by field (`scripts/differential/`, kept in `.private/`). |
| Pilot replay | The pilot company's quarter and FY2025, against its filed returns and its accountant's books. |
| Agent evaluation | Record real-model runs. Add worlds for a non-payer, a profit-tax SRL, a small entity, a PFA on a norm and an IF. The partner accountant checks the expected answers. |
| Validator hygiene | ANAF publishes new validator versions often (D112 J27.0.8 on 3 November 2026). Check the packages monthly. Note that some validators don't check arithmetic (S1003 2025, D406 balances), so the engine's own checks are the only line there. |
| Test speed | Reuse one Java process in the official-validator suite; agents run only the affected tests while working and the full set once; keep the machine awake during long runs. |

### Product track: Phase 4, after Phase 2 unless the owner moves it earlier

| Item | Content | Size |
|---|---|---|
| Agent runtime | `engine/agent/`: providers for Anthropic, OpenAI and OpenAI-compatible endpoints; the `Keyring` with key ids; egress records; limits and a three-level kill switch; the run loop (intake, worklist, ask, propose, report); run records. | L |
| MCP over OAuth | An authorization server with PKCE and client ID metadata documents; a consent screen; short-lived tokens bound to grants; scopes matching toolsets; live checks from Claude.ai, Claude Code and ChatGPT. | M |
| Dashboard | Five views (De verificat, Întrebări, Termene, Registre, Setări) plus the accountant portfolio; batch approval with exact totals; evidence beside the effect; camera upload. | L |
| PDF page images | `evidence.render` for providers without PDF input: PDFium compiled to WebAssembly (MIT) or MuPDF (AGPL, which would settle ADR 0004). | S |
| Chat | Streaming chat with a per-member grant; citations checked against tool results. | M |

Phase 5 (hosting, sign-up, quotas, backups, retiring the legacy extraction) stays set aside until the owner reopens it.

### Decisions the owner still owes

1. Whether to build Phase 4 for services SRLs and PFAs before the goods wave. That would change the "all regimes first" order.
2. The PDF renderer licence (PDFium or MuPDF).
3. Whether reviewers' names and CECCAR numbers may be published in the repository (`--publish-identity`).
4. Hosted identity (standalone Better Auth or the Piatra handoff), before Phase 4.
5. Whether AMEF cash registers and e-Transport are integrated or only tracked (the recommendation is tracked first).

## Sequencing

Keep the public invoicer available. Agents perform routine work through the same typed command API used by the application. The UI primarily verifies evidence, exact effects, decisions and results; manual accounting remains available without a model. Every domain feature needs an API/tool capability and a corresponding review projection.

This file owns planned delivery and acceptance gates. [IMPLEMENTATION.md](IMPLEMENTATION.md) owns the current capability inventory and recorded proof; [ACCOUNTING_ENGINE.md](ACCOUNTING_ENGINE.md) owns exact implemented behavior. Proposed outcomes in [FEATURE_VISION.md](FEATURE_VISION.md) do not establish released coverage.

The product completion target is one company's complete applicable accounting cycle: reviewed opening books and tax history → economic facts → accounting/fiscal treatment → reconciled books and subledgers → calculated tax positions → monthly/quarterly/annual outputs → authorized external fulfillment and receipt tracking. A domestic-services SRL must be able to complete a full year on its selected VAT and income-tax branch. Broader payroll, stock and production claims require their own complete facets and interactions.

Do not infer completion from invoice variants, migrations, test counts, arbitrary balanced journals or the existence of API/MCP. A new increment must close a named coverage gap or a demonstrated correctness/security defect. The nine steps are dependency order, not equally sized percentage points.

| Order | Deliverable and exit condition |
|---|---|
| 1 | General foundation: sourced/versioned chart and analytical accounts, financial years separate from the company and fiscal years, arbitrary balanced opening/general proposals, dated registrations, policies/rules and obligation catalogue. Schema changes are generated Drizzle migrations from the kernel baseline ([ADR 0012](adr/0012-baseline-reset-and-oracles.md)); posted history and its hashes are preserved. |
| 2 | Evidence to ledger: incoming/outgoing e-Factura XML/archives; VAT and non-VAT sales, purchases and linked credit notes; counterparty positions; partial/grouped settlements, bank fees, multiple accounts, cash and CSV/MT940/camt. Deferrals, advances, accruals and unbilled sales, removed in the kernel switchover, return here as treatments. Proof reconciles source totals, tax amounts, ledger and open items without duplicate recognition. |
| 3 | VAT and FX: cash VAT, recoverability/pro-rata, adjustments, registration changes, EU/special-VAT branches, imports/exports and independent accounting/VAT/settlement rate dates. Prove VAT registers and their declaration mappings across transitions and periods. |
| 4 | Assets and financing: acquisitions, depreciation, disposals, separate fiscal bases, leases, loans, interest, owner loans/dividends and withholding. Prove accounting/fiscal differences and settlement controls. |
| 5 | Native payroll: contracts and effective changes, gross-to-net, employer costs, absence/leave, benefits, corrections, liabilities/payments and D112 mappings. Version every calculation input and rule; independently reconcile payroll to ledger and return. |
| 6 | Native stock and production: warehouses, quantities/units, receipts/issues/transfers/returns, approved valuation policies, inventory counts, BOM/work orders, consumed materials/labor/overheads, finished goods and work in progress. Reconcile quantity/cost subledgers to the general ledger and reporting. |
| 7 | Tax and year close: both microenterprise and profit-tax branches, fiscal adjustments, loss vintages, credits, payments, withholding, prescribed fiscal register, annual close and reviewed opening roll-forward. Execute FP-01–05 and independent regime/transition/mutation cases. |
| 8 | Reporting and official packages: required journals/ledger/inventory/trial balances, applicable D100/D101/D112/D300/D301/D390/D394/D406 and conditional reports; annual statements and supporting documents. Pin schemas and official validator/PDF tools, reconcile content, export an exact signing/submission package and track imported receipts. |
| 9 | Replacement proof: MIG-01 continuity and responsibility, independent fiscal review, quarterly/year-end reference outputs, real-company parallel closes, complete obligation closure and restore/replay. Approve only the exact covered company, interval and version combination. |

Run steps in this order, carrying forward existing evidence, API/MCP access, exact approvals and tests. Within a step, deliver bounded vertical workflows with explicit exclusions. Do not label a generic journal capability as complete support for payroll, stock, VAT or a declaration. Step 2 needs a finite supported-month exit fixture and an explicit register of remaining scenarios; it must not expand indefinitely through unrelated document variants while later modules remain absent.

Initial verification covers 2025 and 2026. Historical opening balances and tax vintages need retained authority; later annual formats remain pending until published and independently checked. Both VAT and non-VAT, micro/profit taxation, payroll and manufacturing remain committed scope, not unspecified future product ideas.

The existing capability API and scoped-credential MCP are infrastructure already available to every new accounting module. The built-in agent and MCP over OAuth follow the accounting modules (Phase 4 above); AI billing is outside the sequence. The UI verifies actual evidence/effects; do not grow a second manual accounting application alongside the engine.

Filing fulfillment initially uses external signing/submission of the validated official package and receipt import. Reserve explicit authorization for exact artifacts and keep prepared/validated/exported/submitted/accepted states distinct. Direct submission automation is not a prerequisite.

## Definition of a complete company cycle

For an exact company, claimed interval and profile combination, demonstrate all of the following:

1. Company identity, financial/fiscal years, dated registrations, accounting policies and relevant business facts are evidenced. Unknown facts have an owner and resolution path; absence of records does not imply non-applicability.
2. Opening books, material open items and fiscal history reconcile, including carried losses/credits/bases and responsibility for obligations spanning a migration cutover.
3. All in-scope economic facts have supported treatments and source lineage. Bank/cash, receivables/payables and every relevant accrual, asset, payroll or stock control reconcile without unexplained differences.
4. Accounting result and each applicable tax position are calculated and independently reconciled. Amounts paid, amounts declared, tax credits and outstanding liabilities remain distinct.
5. Applicable statutory records, periodic declarations, annual statements and supporting documents can be reproduced from approved snapshots, using the correct period-specific formats and official validation tools.
6. Required preparers, reviewers, management signers and authorized submitters are identified. Exact packages can be handed off for signing/submission, and pending, rejected, accepted or uncertain outcomes are retained with the actual receipts. Direct submission automation is optional.
7. Independent fiscal expectations, interaction/mutation cases, real-company parallel closes and annual comparisons support the claim. Export and fresh restore preserve every source, approved version, carry-forward and unresolved external attempt.

Even a company without employees, assets or stock must pass its applicable annual tax/reporting and inventory-verification requirements. Those exclusions do not turn a monthly bookkeeping fixture into a complete accounting system. [CONFORMANCE.md](CONFORMANCE.md) owns the formal replacement gate and [REGULATORY_BASELINE.md](REGULATORY_BASELINE.md) the dated planning findings.

## Foundation acceptance contract

These requirements define the foundation rather than a new request to rebuild working primitives. Use the current evidence in [IMPLEMENTATION.md](IMPLEMENTATION.md) and complete its remaining review/applicability gaps.

1. Source the general chart and represent postable accounts, groups and company analytical accounts; retain source/hash/version and avoid unsupported claims of a reviewed current consolidation.
2. Separate financial/fiscal years from company identity. Require an explicit report year when several exist; never sum repeated annual opening balances.
3. Generalize evidence-backed opening/general proposals and linked adjustments to arbitrary supported general-ledger accounts. Approval binds the full exact lines, dates, source and year.
4. Preserve existing evidence, fact/proposal hashes, approved entries, idempotency and database guards through a populated-book upgrade, export and restore.
5. Run independently specified sales/purchase posting fixtures for VAT and non-VAT in both 2025 and 2026, alongside stale approvals, closed periods, cross-company access and direct balanced-tampering failures.
6. Expose configuration, proposals, exact posting effects and year reports through the shared API/MCP. Reuse the existing review screen.
7. Add effective-dated policy/rule/obligation records and move to the document-to-ledger workflow. Independent fiscal review remains required before any conformance claim.

## A1 regression fixture

1. Create a domestic non-VAT profit-tax services SRL. Import approved opening entries: debit bank 1,000.00 RON, credit paid-in capital 1,000.00 RON.
2. Retain a synthetic domestic supplier invoice for 100.00 RON with no VAT and its source metadata/hash.
3. Review the accounting interpretation and post debit services expense 100.00 RON, credit supplier payable 100.00 RON. Preserve the distinct fiscal interpretation/position reference.
4. Import a statement starting at 1,000.00 RON, containing the 100.00 RON payment and ending at 900.00 RON. Match and post the payment.
5. Show bank 900.00 RON, supplier payable zero, expense 100.00 RON, capital 1,000.00 RON and a balanced trial balance, with traceable evidence.
6. Reimport/retry without adding entries; restart and reproduce results. A second company/user cannot read or mutate any record.
7. Run the same domain commands from API and UI. No AI, payment collection, live ANAF authorization or global plugin framework is needed.

## A1b full periodic fixture

This fixture spans the ledger, VAT and official-reporting steps. Passing its posting/reconciliation subset does not complete its declaration, source-authority or receipt requirements; [IMPLEMENTATION.md](IMPLEMENTATION.md) records the actual subset proved. The full fixture remains an integration exit condition as those modules arrive.

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

Deliver a minimal accountant portfolio with the first real-company parallel pilot. Show only available company/period freshness, missing evidence, bank differences and blocked work; add pending/rejected filings when fulfillment exists. Every count drills into actual authorized records, and revoked membership removes access immediately. Extend the same view for step 9 replacement proof. Full firm billing/staff orchestration is not required.

Preserve the migration process in [ARCHITECTURE.md](ARCHITECTURE.md): reviewed opening position, separate tax-history evidence, control reconciliation, retained originals and explicit activation. Do not infer historical books from XML or require a legacy paid-AI conversion to migrate accounting.

## Module backlog

This is the local delivery backlog. Work-item IDs identify required outcomes, not implemented endpoints or external tracker issues. A module's required accounting/fiscal operations remain deterministic and available without AI.

| Priority / ticket | Required proof | Delivery |
|---|---|---|
| P0 GL-01 | Retain working accounts/years/general postings; finish current chart consolidation and clause-to-control review. Generic journal access must not advertise automatic module coverage. | Step 1 |
| P0 CFG-02 | Evidenced fiscal vector, reporting periodicity, relevant activities/locations, professional authority and historical registration correction/supersession. A corrected history identifies affected interpretations and approvals. | Steps 1–3 |
| P0 DOC-01 | A complete supported domestic RON service month for VAT/non-VAT purchase/sale: sources, account classification, positions, partial/grouped payments, fees/refunds and close controls reconcile. Allocation to supported expense/revenue accounts is explicit; importing all purchases must not classify them all as 628 services. | Step 2 |
| P0 DOC-08 | Remaining document/period decisions: source-linked price corrections and correction formats, positive reversal of storno, broader line/account classification, uncompleted milestones and mid-month service changes. Scope each treatment; preserve unsupported facts and original sources. Historical tax/annual effects depend on the later fiscal/correction modules. | Steps 2/3/7 |
| P0 VAT-01 | Normal/special/cash VAT, reduced/exempt/out-of-scope distinctions, full/partial/no recovery, mixed use/pro-rata, advances, corrections and effective-dated registration transitions. Independent fixtures prove eligibility, tax point, deduction and register effects. | Step 3 |
| P0 FX-01 | Original-currency amounts, source/rate/date provenance, distinct accounting/VAT conversion, partial settlement differences, period-end revaluation and reversal/correction. Ledger, positions and reports reconcile at exact declared precision. | Step 3 |
| P0 INTL-01 | Domestic/foreign service and goods branches, EU/special identification, reverse-charge cases, imports/exports and applicable reporting mappings. A foreign SaaS invoice must trigger the correct supported branch or an explicit gap. Marketplace/OSS/IOSS or other specialized regimes require separately reviewed extensions before the corresponding company is covered. | Step 3 |
| P0 ASSET-01 | Asset acquisition/capitalization, accounting and fiscal bases, useful lives/methods, depreciation, improvements, impairment/disposal and itemized control reconciliation. Prove reporting inputs without collapsing fiscal depreciation into book value. | Step 4 |
| P0 FINANCE-01 | Loans, interest, financing fees, leasing classification/schedules, repayments and lender/counterparty controls under reviewed policies. Separate principal, interest, cash settlement and tax treatment. | Step 4 |
| P0 OWNER-01 | Capital/equity movements, shareholder loans, reviewed distributions/dividends, withholding, payment and reporting dependencies. Preserve period and recipient status and prevent distributions being treated as ordinary service costs. | Steps 4/7/8 |
| P0 PAY-01 | Native employee/contract history, gross-to-net, employer costs, leave/absence, benefits, corrections, liabilities/payments and payslips. Independently reconcile calculations to postings and D112 content; employee data has separate access/egress controls. | Steps 5/8 |
| P0 STOCK-01 | Item/unit/warehouse records, receipts/issues/transfers/returns, supported valuation policies, stock counts/differences, write-downs and cost of goods sold. Quantities, valuation layers and GL controls reconcile; browser-local invoicer inventory is not this subledger. | Step 6 |
| P0 PROD-01 | Versioned BOMs/work orders, material/labor/overhead consumption, yield/scrap, finished goods, work in progress and cost variances. Prove quantity/cost lineage to stock, payroll/purchases and the general ledger. | Step 6 |
| P0 TAX-MICRO-01 | Effective-dated microenterprise eligibility, tax base/exclusions, periods, changes of regime, liabilities/payments and return mappings. Use reviewed rules and evidence; revenue alone cannot select the regime. | Step 7 |
| P0 TAX-PROFIT-01 | Accounting-to-tax bridge, nondeductible/limited expenses, fiscal depreciation, loss vintages/utilization/expiry, credits/reliefs, quarterly/annual calculations and corrected returns. Prove the prescribed fiscal register and loss/credit/payment continuity separately. | Step 7 |
| P0 CLOSE-01 | Year-end accruals/deferrals, provisions/impairments, relevant annual inventory evidence, supported prior-period error/materiality decisions, result closing and controlled opening roll-forward. Reconcile every carried subledger and fiscal position across years. | Step 7 |
| P0 REPORT-01 | Complete period-specific Registrul-jurnal, Registrul-inventar, Cartea mare, statutory trial balance, balance sheet/P&L and applicable annual statements/disclosures/supporting documents. Generated content reconciles to approved books and tax positions. | Steps 7–8 |
| P0 CONF-01 | Obligation closure; EU-service, VAT-transition, non-VAT D406 and unknown facts fail closed. | From step 1; full gate by step 9 |
| P0 FISC-01 | Effective-dated legal/calendar/register authority, official source snapshots, statutory turnover bases, reporting periods/deadlines and independently approved expected results. Changes produce impact reports and signed fiscal-package releases. | Steps 1/3/7/8 |
| P0 FISC-02 | Calculated fiscal interpretations and distinct adjustments, bases, credits, loss vintages and actual tax payments with immutable correction lineage. Reference-only records cannot satisfy this ticket. | Steps 4/7 |
| P0 LEDGER-01 | Accrual/later-invoice/credit-note links; FP-01/02 avoid cross-period duplicate recognition. | Step 2 |
| P0 TEST-01 | Independent legal/expected oracles and deliberate fiscal/period mutation failures. | Every step |
| P0 FILING-01 | Actual official artifact generators, versioned field mappings, pinned validators, reconciled full content, required signatures/supporting files, exact external handoff and imported pending/rejected/accepted receipts. Preparation, validation, authorization, submission and acceptance are separate states. | Step 8 |
| P0 CONDITIONAL-01 | A reviewed applicability decision and complete path for each other triggering obligation, including relevant withholding/registration reports and, for later profiles, Intrastat, e-Transport, e-TVA comparison or employment-registry interfaces. Retain explicit exclusions until their independent source/format/fulfillment proof exists. | Affected module/step 8 |
| P0 MIG-01 | Signed handover, current-year/tax continuity and exact controls; missing history blocks activation. | Step 9 |
| P0 PILOT-01 | Consented real-company parallel monthly closes, reviewed quarterly/year-end outputs and exact-company replacement decision. Record failures, exceptions and unresolved historical/external responsibilities. | Parallel pilot through step 9 |
| P1 UX-01 | Minimal accountant exception portfolio with real authorized drill-down; owner views distinguish money, accounting result, estimated/approved taxes and fulfillment. | First real-company pilot; extend through step 9 |
| P1 MGMT-01 | Reconciled P&L, balance-sheet and cash/aging views; optional project/customer/product dimensions and documented allocation policies can extend them without changing statutory books. | Reporting foundation in step 8; dimensions by relevant module |
| P1 CONF-02 | Independently prove combined VAT/currency/time/EU/asset/payroll/stock regimes. | Each affected step |

Each row is refined into reviewable vertical tickets when its step starts. Keep its status/evidence in [IMPLEMENTATION.md](IMPLEMENTATION.md), including partially completed mechanics. [FISCAL_FIXTURES.md](FISCAL_FIXTURES.md) owns the candidate cases, [MIGRATION.md](MIGRATION.md) the handover proof, and [REGULATORY_BASELINE.md](REGULATORY_BASELINE.md) the dated authority.

## Official reporting delivery

The form list is a planning catalogue, not a statement that every company files every form. The applicability engine selects the actual company/period set; conditional obligations cannot be omitted because a company is below the commercial revenue target.

| Output family | Required inputs and completion proof |
|---|---|
| D100 / D101 | Approved applicable tax positions, payments, adjustments and fiscal history; independently calculated expected amounts, annual/rectifying behavior and exact official validation. |
| D300 / D301 / D390 / D394 | Supported registration, domestic/foreign transaction and timing branches; purchase/sale VAT registers, deduction/reverse-charge/correction mappings and source-to-field reconciliation. |
| D406 SAF-T | Correct covered master records, accounting transactions, document/payment and applicable asset/stock data; official schema/content checks and control-total reconciliation. Passing XML syntax alone is insufficient. |
| D112 | Reviewed payroll/recipient history, effective rules and corrected periods; reconciliation to payslips, liabilities and GL, followed by official artifact validation. |
| D205 / D207 / D107 / D700 and other triggered reports | Evidenced recipient/event/registration facts, actual applicability and period-specific mappings. Do not derive them solely from an account balance or assume non-applicability. |
| Annual statements and accompanying documents | Correct accounting category, approved closing snapshot, year-specific forms and required disclosures, inventory/management approvals and signing/supporting-file procedures. A previous year's package is not the specification for an unpublished year. |

For every applicable output: pin the legal/form version → establish independent expected content → implement deterministic mapping → reconcile source/ledger/tax totals → run official validators → review/authorize exact bytes → export a signing/submission package → import actual receipts → retain corrections and unresolved attempts. A direct connector can be added later without changing that contract.

## Turning the feature vision into releases

[FEATURE_VISION.md](FEATURE_VISION.md) owns V01–V19 outcomes and their product boundaries. Existing ledger/source/API primitives support further development; they do not make the complete outcomes implemented.

| Prerequisite | Features it enables |
|---|---|
| Reliable current sources, positions and permissions | Evidence drill-down, clearer matching and the minimal exception portfolio; grounded explanations can begin only over actual supported data. |
| Complete relevant subledgers and closing controls | Continuous-close preparation, safe review batches, project/product costs and company comparisons with explicit access. |
| Calculated fiscal positions and official mappings | Tax visibility, business-change previews, filing readiness, authority-position comparison and correction impact. |
| Migration continuity, signed versions and complete recovery | Migration assistance, reproducible filing/audit packages and portable full-company archives. |
| Demonstrated domain coverage plus reviewed policy/provider contracts | Built-in L0/L1 assistance first; governed L2+ automation later. Forecasts, outbound follow-up and new integrations remain separately scoped candidates. |

PFA, II and IF are in scope with their own single-entry books, profiles and obligations. Other entity types, such as SA or nonprofit organizations, need separate accounting frameworks, conformance profiles and reviewed obligations; they are not in scope. Do not advertise support for an entity type before its profile exists.

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

The built-in agent and MCP over OAuth are now Phase 4 of the agent-first order above. Direct ANAF submission automation, deployment expansion and managed-AI billing still have separate backlog items. Existing operating/security requirements still apply to any live service. Fiscal completeness and the committed native accounting modules take priority.
