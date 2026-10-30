# Romanian Accounting Conformance

## Specification and implementation

The Romanian Accounting Conformance specification defines observable requirements, admissible inputs, expected outcomes, and reproducible case manifests. xFactura is one implementation. Another language or vendor can implement the specification and publish an independently reproducible result.

Profiles are accounting-coverage claims, not pricing tiers, government certification, or a guarantee that a particular company's evidence is complete. Every definition below is a draft until its schema, fiscal review, corpus, and release process are implemented.

## Eligibility and complexity

Evaluate entity form, accounting framework, tax regimes, dated VAT registrations, transaction categories, service jurisdictions, currencies, employment and payroll-like remuneration, stock, assets, owner transactions, and reporting periods. Evaluate observed facts and declared settings. RO-SRV-01 initially assumes one SRL under OMFP 1802/2014 with calendar financial/fiscal year, ordinary quarterly profit-tax computation, bank-based RON domestic services, and no foreign operations, cash-register activity, employees/other payroll triggers, depreciable assets or distributions. An empty data collection is not proof of non-applicability. Turnover matters only where a reviewed fiscal rule itself uses a threshold; monitor the statutory VAT basis and transition conditions continuously. Dated rule values live in [REGULATORY_BASELINE.md](REGULATORY_BASELINE.md).

Normal VAT registration, non-registration, and special EU VAT identification must be represented with their actual applicability and history. Do not encode them as one boolean or assume normal VAT and special identification form a cumulative ladder. See the official [D301](https://static.anaf.ro/static/10/Anaf/Declaratii_R/301.html) and [D390](https://static.anaf.ro/static/10/Anaf/Declaratii_R/390.html) technical resources.

## Product scope and proof horizon

The implementation roadmap covers both VAT and non-VAT SRLs, microenterprise and profit taxation, native payroll, inventory and manufacturing. The first verified fiscal years are 2025 and 2026. RO-SRV-01 is a narrow conformance fixture, not the product's scope or a reason to defer VAT.

Add explicit RO-TAX-MICRO, RO-PAY, RO-STOCK and RO-PRODUCTION facets with their required inputs, accounting/fiscal outputs and interactions. These are committed roadmap work, not implemented claims. Company eligibility still requires complete obligation closure, including the interaction of payroll with microenterprise eligibility and stock/production with VAT and SAF-T.

The first filing path produces a versioned official validation/signing/submission package and imports the actual external receipt. A direct ANAF connector is optional; the complete authorized handoff is required. Unpublished later annual packages remain gaps until checked.

## Release stages per profile

Every profile moves through three stages. `scripts/conformance/report.ts` (planned) prints each profile's stage from the rule register and the recorded proof.

| Stage | What it allows | Required |
|---|---|---|
| Preview | Books are computed and shown as drafts. | Every rule cited (`extracted`); official validators pass where they exist, and a skip doesn't count; cross-return checks green on the synthetic corpus. |
| Shadow | A real company runs in parallel with its accountant, who keeps filing from their own books. | Every parameter the profile uses is at least `interpreted`, reviewed by a partner accountant; one replay or differential comparison with every difference explained. |
| Live | The company's books and returns come from xFactura. | Every parameter is `signed` by the expert, through a signed review packet bound to its value; two real monthly closes, a quarter and a year-end; obligation closure ELIGIBLE; a restore drill passed; the company's accountant accepts. |

PFA, II and IF profiles (single-entry books, income tax in the real system or by norm, IF members) go through the same stages. Their specification and build record are in [PFA_II_IF.md](PFA_II_IF.md).

## Representative company combinations

These are coverage-design examples, not released profiles or assertions that every listed obligation applies. Use verified facts and reviewed rules to derive each company's actual closure. The [implementation matrix](IMPLEMENTATION.md) owns the current gap assessment and [ROADMAP.md](ROADMAP.md) the build backlog.

| Company example | Coverage that must be demonstrated together |
|---|---|
| Domestic RON services SRL without normal VAT, employees or stock | Complete service books/positions, its selected income-tax branch, relevant annual inventory verification, applicable periodic/annual outputs, migration history and authorized fulfillment. |
| VAT-registered service SRL with EUR and foreign suppliers/customers | The preceding general foundation plus the correct VAT branch, foreign-service/registration interactions, accounting/VAT/settlement FX and the resulting reporting set. Domestic-only sales do not establish domestic-only purchases. |
| Service SRL on the microenterprise branch with payroll and equipment | Reviewed tax eligibility/history, payroll, assets/accounting-fiscal depreciation, owner/financing facts when present and their combined periodic/annual outputs. |
| Retail or e-commerce SRL | Goods/stock/valuation/returns, sources outside e-Factura, multiple settlement channels, applicable VAT/currency/jurisdiction branches, payroll/assets when present and full-year controls. Marketplace or OSS/IOSS cases require explicit reviewed extensions. |
| Manufacturing SRL | Accounting stock plus BOM/work orders, material/labor/overhead, finished goods/WIP/variances, fixed assets/payroll where relevant and their tax/reporting interactions. |

Turnover cannot select one of these combinations by itself. A generic journal or a browser inventory list cannot satisfy a native subledger requirement. Unsupported conditional regimes and broader entity frameworks remain explicit boundaries until their own profiles, corpus, rules and outputs exist.

## Draft profiles

| ID | Coverage introduced | Reporting and claim boundary |
|---|---|---|
| RO-SRV-01 | Domestic services, RON, profit tax, non-VAT; the narrow eligibility envelope below. | RO-SRV-01-SHADOW qualifies bounded shadow use; RO-SRV-01-FULL-YEAR is the company-specific replacement gate and also requires RO-SRV-06 plus complete obligation closure. |
| RO-SRV-02 | Domestic RON services under normal VAT registration. | Alternative VAT branch using the same kernel; applicable D300/D394/D406 and e-Factura cases. It does not inherit a non-VAT eligibility predicate. |
| RO-SRV-03 | EUR accounts/transactions, RON valuation, settlement and closing FX. | Extension of an explicitly tested eligible VAT branch; original currency and rate provenance required. |
| RO-SRV-04 | Ordinary EU B2B services and validated registration/treatment branches. | Applicable D390 and D301 cases; normal-VAT and non-VAT/special-identification branches are tested separately. Currency extensions apply when needed. |
| RO-SRV-05 | Ordinary assets and separate accounting/fiscal bases and depreciation. | Explicit asset eligibility; relevant disposal and D406-assets cases. |
| RO-SRV-06 | Annual profit-tax position, supported adjustments/carry-forwards, D101, and annual financial statements. | Required for full-year replacement on every applicable base branch, even for a company without assets or dividends. |
| RO-OWN-01 | Supported owner loans and dividends to Romanian resident individuals. | Separate optional owner-transaction facet; applicable withholding/D100/D205 and annual interactions. |

Profiles compose through an explicit compatibility matrix and tested combinations. An extension changes only declared restrictions; it cannot silently erase a base exclusion. Passing separate profiles does not prove their combined interactions. Registration transitions within a period require dedicated cases, not just passing each end state.

Do not postpone a legally applicable filing because the roadmap introduces a related profile later. Periodic D406 applicability is evaluated for non-VAT companies too. D101 and annual statements are prerequisites to a full-year replacement claim, not optional product upgrades. [ANAF SAF-T resources](https://static.anaf.ro/static/10/Anaf/Informatii_R/saf_t.htm)


## Obligation closure and negative eligibility

Implement a versioned ObligationClosure evaluator over the company history, claimed interval and exact software/profile/fiscal versions. Its closure derives accounting/fiscal treatments, registrations/transitions, periodic/annual artifacts, corrections, required evidence, responsible roles and external-fulfillment dependencies, including earlier periods and carried balances.

A company is eligible only when materially relevant facts are known, the derived closure is covered, and its profile interactions have been demonstrated. Iterate deterministic dependency rules to a stable result; unresolved/cyclic applicability becomes a named gap, never a default pass. Record the rules and source facts that produced each dependency.

Use NEEDS_EVIDENCE for unknown material facts and UNSUPPORTED for known uncovered treatment/interaction. Return every blocker: if any known unsupported requirement exists, the result is UNSUPPORTED; otherwise material unknowns produce NEEDS_EVIDENCE; only a fully satisfied evaluated scope is ELIGIBLE. ELIGIBLE is not an unconditional company badge. Re-evaluate on material facts, historical-status/policy corrections, new packages and composition changes. Retain the evidence and pause affected automation/claims without disabling unrelated imports or exports.

Examples that must fail closed include a non-VAT company's Irish advertising/software purchase; a VAT-ceiling transition; no normal VAT but applicable D406; payroll-type administrator remuneration despite no employees; and sponsorship triggering a credit/reporting extension. Foreign SaaS or AI-provider bills may be company transactions even when sales remain domestic. Provider configuration does not decide their fiscal treatment.

```json
{
  "company_id": "<company>",
  "interval": ["2026-01-01", "2026-12-31"],
  "claim_scope": "company_replacement",
  "profiles": [{"id": "RO-SRV-01", "revision": 1}],
  "status": "UNSUPPORTED",
  "trigger": "EU_B2B_SERVICE_PURCHASE",
  "missing_capabilities": ["VAT_ART317", "D301", "D390"],
  "evidence_ids": ["<supplier-invoice>"],
  "resolution": "Enable reviewed coverage or retain explicitly assigned external processing",
  "conformance_manifest": "<versioned-manifest>"
}
```

The example is a draft failure result, not a general assertion that every foreign invoice has that exact treatment. Applicability must be derived from verified facts and the reviewed source catalogue.

### The closure as built (T1, 30 October 2026)

The evaluator is pure, in core `src/ro/determinations/closure.ts` (`evaluateClosure`, version `ro-closure@2`, with a hash of its rule set). The engine feeds it (`modules/determinations.ts`) and exposes it as `closure.evaluate {from, to}` (at most three calendar years). Its inputs:

- the recorded profile facts (superseded ones left out);
- the **yearly determinations** of every year the range touches ([ACCOUNTING_ENGINE.md](ACCOUNTING_ENGINE.md#determinations-and-the-obligation-closure)), and which of them a person confirmed against the exact computation;
- what the books show over the range: employment contracts, sick leave and contract ends, services across the EU border, dividend tax withheld, invoices from suppliers outside Romania, stock accounts, sponsorship (6582), payroll taxes without a contract, a PFA's income sources, the financial years kept and the first day of the first one.

**Only the months the books cover.** The months before the company's first financial year (the earliest by its start; one starting mid-month covers that month) have no returns and no needs: the facts are recorded from the books' start, so nothing about an earlier month is asked. The annual returns of a year before it (D212, D205, S1005…) are not listed either, and a range wholly before the books evaluates nothing. A company that keeps no financial year at all is not restricted: every month is read from its facts.

**Rules and the fixed point.** Each rule reads named slots (`vat@2026-09`, `incomeTax@2026-12`, `size@2026`…) and fires once all of them are derived; each pass fires every ready rule, until a pass fires none. A rule left over is a named gap, `CYCLE` when what it reads is derived by another rule left over, `UNRESOLVED` otherwise; a gap makes the closure UNSUPPORTED (`CLOSURE_CYCLE`, `CLOSURE_UNRESOLVED`). Every return carries the rule that produced it, the clauses it cites and the slots it read with their basis (`vat@2026-09=non_vat (fapt vat.status)`); the trace lists every firing.

- **Fact rules**, per month: the legal form, the books system (from the form when not recorded: OUG nr. 44/2008 art. 15), the VAT status, the VAT period, special VAT identification for non-payers (`vat.eu`), whether the company employs (from its employment contracts, else the recorded fact), the D112 period and the income tax; per year, the size category. A **yearly determination** (`income_tax`, `vat.period`, `payroll.period`, `size.category`) counts only from a fact effective within that year: one carried from an earlier year is not the year's determination. A recorded fact the computation contradicts is a need too (`DETERMINATION_CONFLICT`), until a person confirms it against that exact computation.
- **Return rules**, per month: D300 and D394 for each VAT period; D406 for each VAT period, quarterly outside VAT, for a company (an SRL); for a PFA, II or IF, D406 is UNSUPPORTED `D406_INDIVIDUAL` at the same periods, since whether OPANAF nr. 1783/2021 reaches individuals is open for the expert contabil ([PFA_II_IF.md](PFA_II_IF.md) §5, question 7), never assumed either way; D390 for the months with EU services; D112 monthly, or each month after the quarter for a quarterly filer, except a month with sick leave or a contract ended (art. 147 alin. (11)); D100 for each quarter of micro tax and each month with dividend tax; D205; D212 and D204 for a known PFA, II or IF; the annual statements by size category (none in single entry, so none for a PFA, II or IF keeping it; no D100 nor D101 either, their income tax being title IV's).
- **Scope rules:** the cases below.

**States.** Every blocker is returned. Any known uncovered case makes the closure UNSUPPORTED; otherwise any unknown material fact makes it NEEDS_EVIDENCE; only a fully known and covered range is ELIGIBLE.

- **NEEDS_EVIDENCE**, each need naming its question: `FACT_UNKNOWN` (a `profile.fact` question about the axis: `entity.form`, `vat.status`, `vat.eu`, `employer`, `activity.goods`, `regime.excluded`), `DETERMINATION_MISSING` (the computed value to confirm, `determination.confirm`; or the input the computation lacks, `year.figures` or `micro.conditions`; or, with no computation, `profile.fact` for the year) and `DETERMINATION_CONFLICT`. A return whose applicability depends on an unknown slot is listed as `needs_evidence`, never dropped and never assumed, with one exception: the returns of individuals (D212, D204) wait for the legal form. While it is unknown they are not listed, so a company is never offered them; the form's need is (`fact.entity.form`, and D100, D406 and the statements read it, listed `needs_evidence`), so the closure stays NEEDS_EVIDENCE.
- **UNSUPPORTED**, each with its trigger, missing capabilities and evidence: `PROFIT_TAX` (D101 listed as unsupported), `MICRO_PROFIT_TRANSITION`, `SMALL_ENTITY_STATEMENTS`, `SIZE_MEDIUM_LARGE`, `AUDIT_REQUIRED`, `VAT_THRESHOLD_EXCEEDED`, `VAT_ART317`, `EU_SERVICES_NON_VAT`, `FOREIGN_SERVICE_PURCHASE` (with the invoices), `GOODS_STOCK` (declared or seen on class 3), `SPONSORSHIP`, `PAYROLL_WITHOUT_EMPLOYEES`, `PFA_SOURCES_MULTIPLE`, `D406_INDIVIDUAL` (D406 of a PFA, II or IF listed as unsupported), and `REGIME_EXCISE`, `REGIME_FISCAL_GROUP`, `REGIME_IFRS` (`regime.excluded`).

**The calendar** (`obligations.calendar`) lists the closure's returns: those that apply with their cited deadline and status; the others `blocked`, with the question to ask (`question`), the blockers and the gap in words; each with its `basis` (rule, facts, clauses). The worklist shows a blocked return with `determinations.propose` (for a yearly determination) or `questions.ask` (for a company fact) as its agent step; the months before the books list nothing, so it asks nothing about them.

**The fail-closed examples above, as fixtures** (core `test/determinations.test.ts`; engine `test/engine/determinations.integration.test.ts`):

| Example | Result |
|---|---|
| A non-VAT company's Irish software purchase | UNSUPPORTED `FOREIGN_SERVICE_PURCHASE`, capabilities `VAT_ART317`, `D301`, `D390`, with the invoice |
| A VAT-ceiling transition | the small-enterprise threshold crossed: UNSUPPORTED `VAT_THRESHOLD_EXCEEDED`; the VAT on collection ceiling crossed while the recorded regime stays on it: NEEDS_EVIDENCE `DETERMINATION_CONFLICT` |
| No normal VAT, yet D406 applies | D406 quarterly applies; with the VAT status or the legal form unknown, D406 is `needs_evidence`, not absent; for a PFA, II or IF, UNSUPPORTED `D406_INDIVIDUAL` |
| Payroll-type remuneration of the administrator without employees | UNSUPPORTED `PAYROLL_WITHOUT_EMPLOYEES` |
| Sponsorship | UNSUPPORTED `SPONSORSHIP` (credit and D107) |

Not yet derived: corrections of earlier periods, carried balances and external-fulfillment dependencies; the profile composition and claim scopes of the machine-readable contract below; D406 by taxpayer category (anexa 5); the art. 147 alin. (11) months beyond sick leave and contracts ended.

## Machine-readable contract

Implement an independently versioned profile schema containing:

- ID, revision, draft/released/withdrawn lifecycle, jurisdiction, and claim scope.
- Eligibility predicates, effective reporting periods, supported facts, exclusions, and unresolved-input behavior.
- Required capabilities, obligation applicability, compatible compositions, and transitions.
- Required case manifest, oracle revisions, validator versions, and release requirements.

An illustrative draft, not an issued coverage claim:

```yaml
id: RO-SRV-01
revision: 1
status: draft
claim_scope: workflow
eligibility:
  entity: SRL
  corporate_tax: profit
  vat_branch: non_registered
  ledger_currency: RON
  transaction_currency: [RON]
  employment: none
  warehouse_stock: none
  depreciable_assets: none
  foreign_operations: none
  payroll_type_obligations: none
  financial_year: calendar
  fiscal_year: calendar
  accounting_framework: OMFP_1802_2014
replacement_requires: [RO-SRV-06]
obligation_applicability: reviewed_period_catalogue
```

An evaluated company view records its period, complexity vector, covering profile revisions/compositions, fiscal-package version, missing evidence, unsupported facts, and required manual decisions. A current company lookup is not proof of historical registration status.

## Claims and replacement

A public claim identifies implementation/software version, profile revisions and composition, fiscal package ID and rule-set hash, case-manifest hash, runner/oracle/validator versions, execution date, and signed result. Report real executed cases and every failure/skip. Never invent a passing case count.

Use separate claim scopes: workflow, periodic reporting, annual reporting, and company replacement. RO-SRV-01-SHADOW is the A2 scope. RO-SRV-01-FULL-YEAR is a company/interval-specific approval over the base profile, annual coverage and obligation closure, not a paid tier or a claim that A2 is complete.

The replacement approval requires all five independent gates: complete applicable obligation closure; signed independent fiscal/oracle/mutation evidence; the approved migration/source-integrity manifest; authorized external-fulfillment procedures and receipt tracking; and a funded restore-tested operating envelope. Any failing/unknown gate retains shadow or an explicitly partitioned limited claim. No confidence score overrides it. [MIGRATION.md](MIGRATION.md) owns handover proof.

A future filing need not already be accepted before onboarding. Its preparation/signing/submission procedure and responsible actors must be supported and tested; an unpublished future form is an explicit gap or external responsibility, not a claim of completed validation. Already-due and disputed historical obligations are recorded with ownership and resolution.

Unsupported facts remain retained evidence and named exceptions. A documented accountant treatment may resolve a company case; it does not automatically extend the general conformance claim. Data outside the defined domain must be rejected, quarantined, or escalated explicitly.

The fiscal catalogue maps each scenario to sources, dates, entries, tax-position effects, obligations, and judgment requirements. Include zero-activity periods, corrected filings, registration transitions, annual supplementary inputs, and boundaries between combined regimes. [TESTING.md](TESTING.md) owns proof methods; [GOVERNANCE.md](GOVERNANCE.md) owns release authority.
