# Romanian Accounting Conformance

## Specification and implementation

The Romanian Accounting Conformance specification defines observable requirements, admissible inputs, expected outcomes, and reproducible case manifests. xFactura is one implementation. Another language or vendor can implement the specification and publish an independently reproducible result.

Profiles are accounting-coverage claims, not pricing tiers, government certification, or a guarantee that a particular company's evidence is complete. Every definition below is a draft until its schema, fiscal review, corpus, and release process are implemented.

## Eligibility and complexity

Evaluate entity form, accounting framework, tax regimes, dated VAT registrations, transaction categories, service jurisdictions, currencies, employment and payroll-like remuneration, stock, assets, owner transactions, and reporting periods. Evaluate observed facts and declared settings. RO-SRV-01 initially assumes one SRL under OMFP 1802/2014 with calendar financial/fiscal year, ordinary quarterly profit-tax computation, bank-based RON domestic services, and no foreign operations, cash-register activity, employees/other payroll triggers, depreciable assets or distributions. An empty data collection is not proof of non-applicability. Turnover matters only where a reviewed fiscal rule itself uses a threshold; monitor the statutory VAT basis and transition conditions continuously. Dated rule values live in [REGULATORY_BASELINE.md](REGULATORY_BASELINE.md).

Normal VAT registration, non-registration, and special EU VAT identification must be represented with their actual applicability and history. Do not encode them as one boolean or assume normal VAT and special identification form a cumulative ladder. See the official [D301](https://static.anaf.ro/static/10/Anaf/Declaratii_R/301.html) and [D390](https://static.anaf.ro/static/10/Anaf/Declaratii_R/390.html) technical resources.

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
