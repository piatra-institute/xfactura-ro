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
| RO-WHT-01 (draft, O1) | Tax withheld at source on rent paid to individuals, interim dividends, and non-residents' dividends, interest, royalties (software licences determined per supplier), commissions and services, with residence certificates and treaty rates as evidence. | D100 (628, 631–636), D205 (tip 29), D207 and D406's WHT codes, each passing ANAF's validator; intellectual property (D112) remains UNSUPPORTED. |

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

The evaluator is pure, in core `src/ro/determinations/closure.ts` (`evaluateClosure`, version `ro-closure@6`, with a hash of its rule set). The engine feeds it (`modules/determinations.ts`) and exposes it as `closure.evaluate {from, to}` (at most three calendar years). Its inputs:

- the recorded profile facts (superseded ones left out);
- the **yearly determinations** of every year the range touches ([ACCOUNTING_ENGINE.md](ACCOUNTING_ENGINE.md#determinations-and-the-obligation-closure)), and which of them a person confirmed against the exact computation;
- what the books show over the range: employment contracts, sick leave and contract ends, services across the EU border, dividend tax withheld, the other taxes withheld at source (O1: interest, rent and non-residents' income, with the return that declares their beneficiaries, D205 or D207, and intellectual property, D112's), invoices from suppliers outside Romania, stock accounts, sponsorship (6582), payroll taxes without a contract, a PFA's income sources, the years a fixed asset was held (a card of the register, or a balance or movement on 21x), the financial years kept and the first day of the first one;
- the parameter `ro.d406.start` for every month of the years the range touches (from when each taxpayer category files D406), or its rule gap;
- the half-year report's decision (`ro.halfyear.report`, Y1, 6 November 2026) for each year whose June the range covers: owed, not owed, unknown with what it lacks, or a rule gap.

**Only the months the books cover.** The months before the company's first financial year (the earliest by its start; one starting mid-month covers that month) have no returns and no needs: the facts are recorded from the books' start, so nothing about an earlier month is asked. The annual returns of a year before it (D212, D205, S1005…) are not listed either, and a range wholly before the books evaluates nothing. A company that keeps no financial year at all is not restricted: every month is read from its facts.

**Rules and the fixed point.** Each rule reads named slots (`vat@2026-09`, `incomeTax@2026-12`, `size@2026`…) and fires once all of them are derived; each pass fires every ready rule, until a pass fires none. A rule left over is a named gap, `CYCLE` when what it reads is derived by another rule left over, `UNRESOLVED` otherwise; a gap makes the closure UNSUPPORTED (`CLOSURE_CYCLE`, `CLOSURE_UNRESOLVED`). Every return carries the rule that produced it, the clauses it cites and the slots it read with their basis (`vat@2026-09=non_vat (fapt vat.status)`); the trace lists every firing.

- **Fact rules**, per month: the legal form, the books system (from the form when not recorded: OUG nr. 44/2008 art. 15), whether the company's D406 has begun (`d406Begun`: from 1 January 2025 every category; before it, by the recorded `taxpayer.category`, each classification from its category's reference date or its own later date, once begun for good, OPANAF nr. 1.783/2021 anexa nr. 5 pct. 1.1–2 as OPANAF nr. 407/2025 restates it), the VAT status (V1: a registration the threshold made due from its crossing day, or a cancellation, that the recorded fact contradicts is a `DETERMINATION_CONFLICT` on `vat.status/<year>`, asked with the computation; without the year's `vat.status` determination the threshold's crossing alone asks for the registration), the VAT period, special VAT identification for non-payers (`vat.eu`: the art. 317 code the books' EU services require, compared the same way), whether the company employs (from its employment contracts, else the recorded fact), the D112 period and the income tax; per year, the size category. A **yearly determination** (`income_tax`, `vat.period`, `payroll.period`, `size.category`) counts only from a fact effective within that year: one carried from an earlier year is not the year's determination. A recorded fact the computation contradicts is a need too (`DETERMINATION_CONFLICT`), until a person confirms it against that exact computation.
- **Return rules**, per month: D300 and D394 for each VAT period; D406 for each VAT period, quarterly outside VAT, for a company (an SRL) whose D406 has begun, and none for a PFA, II or IF, which OPANAF nr. 1.783/2021 anexa nr. 5 pct. 4 lit. a)–c) exempts in every version (OPANAF nr. 407/2025 the current; [PFA_II_IF.md](PFA_II_IF.md) §7.9); per financial year, D406 for assets (Y3, 5 November 2026; `D406.assets`, by the statements' deadline, anexa nr. 4 pct. 1, 7–8) for a company that held a fixed asset in a year its D406 covers whole (a year begun before the obligation is not reported, ANAF's clarification of 14.11.2022), a first year shorter than twelve months UNSUPPORTED (`D406_ASSETS_SHORT_YEAR`: ANAF's validator takes only twelve months); the last D300 and D394 of a company leaving VAT, for the period up to the day before the cancellation and due after the cancellation's month (V1, art. 310 alin. (7), art. 316 alin. (13)); D301 for each month with services bought from abroad (`RC-…` entries) on days outside VAT, with the art. 317 code or without (art. 324 alin. (1) lit. d), OPANAF nr. 592/2016); D390 for the months with EU services or an intra-community supply of goods (V2, `EX-IC`), outside VAT only for the art. 317 code holder (art. 325 alin. (1)); D112 monthly, or each month after the quarter for a quarterly filer, except a month with sick leave or a contract ended and the quarter's months before it, due by the 25th after that month (art. 147 alin. (11), `d112Filing`; the events are read over whole quarters); D100 for each quarter of micro tax and each month with dividend tax, and for each other month with tax withheld at source (O1, 5 November 2026: `D100.withholding`, art. 84^1 alin. (6), 97 alin. (2), 224 alin. (5)); under profit tax, D100 for quarters I–III of the quarterly system (art. 41 alin. (1), `D100.profit`) and D101 for the year (`D101`, 25 June of the next year, art. 42 alin. (1) as OUG nr. 8/2026 rewrote it), the system of payment (`profit.system`) asked of a company that was not a micro-enterprise this or the previous year, quarterly by law if it was (alin. (6) lit. d)); D700 for a change of regime (P2, 4 November 2026): entering the micro-enterprise regime on 1 January (`D700.micro_entry`, by 31 March, art. 55 alin. (2)), leaving it during the year (`D700.micro_exit`, by 31 March of the next year, alin. (5)) or from 1 January (`D700.micro_exit_january`, a `conflict` of the two readings of „anul fiscal următor”), filed outside the engine and marked filed once a person records it (`obligation.filed`); a year before the books is not read for it; D205 for a year with dividends or other tax withheld from residents (art. 132 alin. (2)); D207 for a year with tax withheld from non-residents (`D207`, by the end of February, art. 231 alin. (1)); D212 and D204 for a known PFA, II or IF; the annual statements by size category: S1005 for a microentity, S1003 for a small entity (Y2, 4 November 2026; a year without ANAF's package, 2026 for now, is the declaration's `FORMAT_GAP` when prepared), medium, large and audited entities UNSUPPORTED; S1046 instead of them for a company a person states has carried out no activity since it was set up (`activity.none`; the statements' preparation asks it when the books show no revenue or expense); none in single entry, so none for a PFA, II or IF keeping it; no D100 nor D101 either, their income tax being title IV's.
- **The half-year report** (`obligation.halfyear@<year>`, Y1): for double-entry books, `SF.halfyear` of period `<year>-06`: owed by the year's order (OMF nr. 1.194/2025 for 2025), UNSUPPORTED (`HALFYEAR_REPORT`: the engine does not prepare it; it is kept outside, explicitly assigned); not knowable, NEEDS_EVIDENCE (`INPUT_UNKNOWN`, asking `year.figures` for the previous year's net turnover or `evidence.missing` for the BNR rate); a year no order is read for, `RULE_GAP`; none for 2026 (no order).
- **Scope rules:** the cases below.

**States.** Every blocker is returned. Any known uncovered case makes the closure UNSUPPORTED; otherwise any unknown material fact makes it NEEDS_EVIDENCE; only a fully known and covered range is ELIGIBLE.

- **NEEDS_EVIDENCE**, each need naming its question: `FACT_UNKNOWN` (a `profile.fact` question about the axis: `entity.form`, `vat.status`, `vat.eu`, `employer`, `activity.goods`, `regime.excluded`, `taxpayer.category` for months before 2025, and `vat.prorata/<year>` for a registered year whose books hold supplies exempt without the right of deduction: the provisional pro-rata of art. 300 alin. (9)–(10), V2), `DETERMINATION_MISSING` (the computed value to confirm, `determination.confirm`; or the input the computation lacks, `year.figures` or `micro.conditions`; or, with no computation, `profile.fact` for the year) and `DETERMINATION_CONFLICT`. A return whose applicability depends on an unknown slot is listed as `needs_evidence`, never dropped and never assumed, with one exception: the returns of individuals (D212, D204) wait for the legal form. While it is unknown they are not listed, so a company is never offered them; the form's need is (`fact.entity.form`, and D100, D406 and the statements read it, listed `needs_evidence`), so the closure stays NEEDS_EVIDENCE.
- **UNSUPPORTED**, each with its trigger, missing capabilities and evidence: `D406_ASSETS_SHORT_YEAR` (a first financial year shorter than twelve months with fixed assets), `RULE_GAP` (`ro.d406.start` not in the register for a month), `PROFIT_ANNUAL_SYSTEM` (the annual system with prepayments; D100 and D101 listed as unsupported), `MICRO_ENTRY_MIDYEAR` (micro after profit within a year, which art. 48 alin. (2^1) forbids), `SIZE_MEDIUM_LARGE`, `AUDIT_REQUIRED`, `EU_SERVICES_NON_VAT` (EU services of a non-payer recorded without the art. 317 code: its D390 cannot be filed), `FOREIGN_SERVICE_PURCHASE` (with the invoices: a foreign invoice not booked as services under the general rule, goods and the other place-of-supply rules being uncovered; or EU services bought without the art. 317 code), `GOODS_STOCK` (declared or seen on class 3), `SPONSORSHIP` (the credit is computed; D107, the beneficiaries' informative return, is not), `PAYROLL_WITHOUT_EMPLOYEES`, `D112_INTELLECTUAL_PROPERTY` (tax withheld on intellectual property, which art. 132 alin. (2) declares in D112, not written for it yet), `IF_SOURCES_MULTIPLE` (an IF with several income sources; a PFA's or II's several sources are covered), `PFA_DOUBLE_ENTRY` (a PFA, II or IF that recorded the double-entry option: OUG nr. 44/2008 art. 15 against OMFP nr. 170/2015 art. 3; no annual statements are listed for it), `PRORATA_SPECIAL` (a special pro-rata the Ministry approved or imposed, art. 300 alin. (16)–(18), V2), and `REGIME_EXCISE`, `REGIME_FISCAL_GROUP`, `REGIME_IFRS` (`regime.excluded`).

**The calendar** (`obligations.calendar`) lists the closure's returns: those that apply with their cited deadline and status; the others `blocked`, with the question to ask (`question`), the blockers and the gap in words; each with its `basis` (rule, facts, clauses). The worklist shows a blocked return with `determinations.propose` (for a yearly determination) or `questions.ask` (for a company fact) as its agent step; the months before the books list nothing, so it asks nothing about them.

**The fail-closed examples above, as fixtures** (core `test/determinations.test.ts` and `test/nonpayers.test.ts`; engine `test/engine/determinations.integration.test.ts` and `test/engine/nonpayers.integration.test.ts`):

| Example | Result |
|---|---|
| A non-VAT company's Irish software purchase | not booked yet: UNSUPPORTED `FOREIGN_SERVICE_PURCHASE` (capability `FOREIGN_PURCHASE_TREATMENT`), with the invoice; booked as services under the general rule (V1): D301 applies, and with the art. 317 code D390 too; booked without the code: the code is asked (`DETERMINATION_CONFLICT` on `vat.eu`), and once a person confirms the company has none, UNSUPPORTED `FOREIGN_SERVICE_PURCHASE` and `EU_SERVICES_NON_VAT` (capability `VAT_ART317_REGISTRATION`) |
| A VAT-ceiling transition | the small-enterprise threshold crossed (V1): NEEDS_EVIDENCE `DETERMINATION_CONFLICT` on `vat.status` until the registration from the crossing day is recorded, the returns from that day blocked meanwhile (the earlier `VAT_THRESHOLD_EXCEEDED` is covered now); the VAT on collection ceiling crossed while the recorded regime stays on it: NEEDS_EVIDENCE `DETERMINATION_CONFLICT` |
| No normal VAT, yet D406 applies | D406 quarterly applies; with the VAT status or the legal form unknown, D406 is `needs_evidence`, not absent; for a PFA, II or IF, not listed (exempt by OPANAF nr. 1.783/2021 anexa nr. 5 pct. 4) |
| Payroll-type remuneration of the administrator without employees | UNSUPPORTED `PAYROLL_WITHOUT_EMPLOYEES` |
| Sponsorship | UNSUPPORTED `SPONSORSHIP`: the credit is computed by the profit tax (P1), the informative D107 is missing |

Not yet derived: corrections of earlier periods (a prior-year correction on 1174 shows on the worklist, `profit.correction`, and a D100 changed after filing asks for its D710, `taxaccount.correction`, neither in the closure), carried balances and external-fulfillment dependencies beyond D700; the profile composition and claim scopes of the machine-readable contract below; for D406, the earlier filing a medium taxpayer of 2021 may opt for (anexa 5 pct. 1.2 lit. a)), the non-residents registered only for VAT (lit. e), not a form the engine keeps), a suspended activity (pct. 4 lit. o)) and classified information (lit. m)); the end of insurance other than a contract ended (alin. (11)).

### The tax account as an oracle (T2, 5 November 2026)

ANAF's statement of the taxpayer's account (fișa pe plătitor, situația sintetică from the SPV) is an independent oracle of what the company owes the state: it is ANAF's own record of the returns filed, the decisions communicated and the payments distributed. The engine compares it with the books on its day, per obligation, kind and period (`taxaccount.reconcile`, [ACCOUNTING_ENGINE.md](ACCOUNTING_ENGINE.md#the-tax-account-t2)), and a month whose statement differs beyond a leu is a close warning and a worklist item with each difference explained. A difference is evidence, never auto-corrected: the books follow the documents (a decision recorded, a payment's distribution regularized), and what stays unexplained is disposed of by a person with a reason.

The payment's distribution is computed by the engine from the cited order (art. 163 alin. (3)–(5), OPANAF nr. 1.613/2018), so the statement checks the engine's reading too: a `DISTRIBUTION` difference (the single account's differences cancelling out) is the case where ANAF distributed otherwise. Fail-closed: a payment is not distributed without the fact `tax.facilities`, is UNSUPPORTED with payment facilities or insolvency, and an obligation without a due date blocks it. For a release, a profile's months are expected to reconcile with a statement taken after their payments (shadow and live), every difference explained.

### The year-end in full (Y1, 6 November 2026)

What RO-SRV-06 requires of a financial year's end beyond the profit tax and the statements, and what proves it ([ACCOUNTING_ENGINE.md](ACCOUNTING_ENGINE.md#year-end-in-full-y1)):

- **The annual inventory** (Legea nr. 82/1991; OMF nr. 2.861/2009, read in its 2009 text): lists recorded as cited documents, compared with the books on their date. A year closes only when its lists cover every asset, cash desk and bank account the books hold, and the cash and fixed-asset differences are booked with the administrator's decision; a bank balance that differs from its statement blocks; a partner that did not confirm is a warning. Stock held or listed is UNSUPPORTED (`INVENTORY_STOCK`) until the stock module (G1): never compared, never booked.
- **Valuation at the year's end:** impairments of receivables under a written policy and the facts a person states (nothing defaulted: a tested customer without an answer blocks), impairments of fixed assets on an evidenced test, provisions per obligation from the year's review of obligations and the untaken leave's answer; every foreign-currency monetary item at the closing rate, the balances `fx.revalue` does not reach (5x, 267 without partners) UNSUPPORTED; the cut-off of 408/418, 471/472, the SPV's invoices and the bank.
- **The year close and the lock:** a reviewed action whose preview is the review and the itemized closing snapshot; executed, the database refuses entries dated in the year and the reopening of its months (`inv:closed_year`, `inv:closed_year_month`, each with its attack in the invariant suite), until a reviewed reopening, refused once the statements are submitted.
- **Carried balances:** the next year's opening is the recorded snapshot per account, open item, asset and carried balance (the loss vintages after the year's profit tax, the definitive pro-rata), checked at every close of the next year's months (`YEAR_OPENING_DIFFERS`), with a duplicate opening entry refused at the close (`YEAR_OPENING_DUPLICATE`). The closure itself still does not derive carried balances.
- **Proof:** core `test/yearend.test.ts` (the lists' checks, the comparison, each treatment's bookings and refusals, the snapshot's differences) and `determinations.test.ts` (the half-year in the closure); engine `test/engine/yearend.integration.test.ts` (a services SRL's FY2026 close with a fixed asset, an employee, an EUR account, an insolvent customer and a subscription deferred across the year's end: the inventory's cash shortage imputed, the impairment and its art. 26 base, the leave debt and a lawsuit's provision, the revaluation, the closing journal, the months and the year closed and locked, the 2027 opening equal to the closing, a duplicate opening caught and reversed, FY2026's statements a `FORMAT_GAP`; and a PFA's year-end on its register); the invariant suite's attacks on the two new guards. Three review specs for the expert; no record yet.

### Receipts and the domestic reverse charge (V3, 5 November 2026)

What a VAT payer of RO-SRV-02 books from fiscal receipts and under art. 331, and what proves it ([ACCOUNTING_ENGINE.md](ACCOUNTING_ENGINE.md#receiptsrecognize-a-fiscal-receipt-v3)):

- **Receipts.** A receipt deducts VAT only as a simplified invoice: the company's code printed and at most 100 euro at the BNR rate of its date (`ro.vat.simplified_invoice.limit_eur`). A receipt without the code, over the limit or of a non-payer is booked with its VAT in the expense and reaches no return. Deducted, it is a purchase at its rate in D300 (rows 24–25, 31) and D394's rezumat2 (bazaBFAI, TVABFAI), which ANAF's validator accepts (`scripts/validators/official.test.ts`, `receipts.integration.test.ts`).
- **Domestic reverse charge.** Supplies on D300 rd. 13 and D394 as V; acquisitions self-assessed on rd. 12 (by rate), repeated on rd. 26, and in D394 as C, with op11 and rezumat1's detaliu by product code; both pass ANAF's validators from the books and in the official tests.
- **Fail-closed boundaries.** 2027 is a `RULE_GAP` for the reverse charge until the December acts are read (letters c)–f) and i)–l) end with 2026); invoices mixing AE with taxed goods, their credit notes and advances, foreign currency and receipts in single-entry books are refused, never approximated. The two readings the texts leave open (a code printed without RO; the threshold counted on the invoice's phones, circuits and laptops together) are review specs with engine-computed cases.
- **Agent evaluation.** The SRL world's fuel receipt is a draft decision (`receipts.recognize`, half the VAT through the car's answer, paid by card and settled from the statement), no longer an unsupported stop.

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
