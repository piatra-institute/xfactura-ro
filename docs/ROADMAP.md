# Delivery roadmap and executable gates

## Sequencing

Keep the current public invoicer available. Start with a real vertical slice and independently reviewed cases, then grow profile coverage. Profile definitions in [CONFORMANCE.md](CONFORMANCE.md) are draft planning targets, not claims that tests exist.

| Milestone | Deliverable and exit condition |
|---|---|
| A1 | Ledger/evidence/bank/kernel slice below; idempotency, company isolation and restart recovery pass. Tax-position contracts exist from the start. |
| A1b | The difficult VAT/period-boundary fixture below forces the two-interpretation model and filing/correction contracts before broad feature expansion. |
| A2 | RO-SRV-01-SHADOW domestic RON/non-VAT bookkeeping, fiscal-register contracts and obligation closure; applicable D406/annual work is identified, not assumed absent. |
| A3 | RO-SRV-02 normal VAT, e-Factura, applicable D300/D394/D406 and complete profile interaction cases; official validation and independent fiscal outputs pass. |
| A4 | Real-company parallel accounting, migration proof, two consecutive monthly closes and a minimal accountant portfolio. This is not yet a general replacement/annual-coverage claim. |
| A5 | RO-SRV-03 EUR/FX plus RO-SRV-04 ordinary EU B2B, with separately validated normal/special-identification branches and applicable D390/D301. |
| A6 | RO-SRV-05 assets, separate accounting/fiscal bases/depreciation, disposal and applicable D406-assets reporting. |
| A7 | RO-SRV-06 full profit-tax position, adjustments, tax history/carry-forwards, D101 and annual statements; RO-OWN-01 distributions when needed. |
| A8 | Refine portfolio workflows, migration efficiency and supported profile compositions using actual accounting-partner use. The minimal portfolio is already present at A4. |
| B1 | Direct regular Piatra AI/OpenAI/OpenRouter keys for grounded explanation, extraction and typed proposals. No xFactura wallet dependency. |
| B2 | Explicit reviewed policies, shadow comparison and revocable governed execution at the autonomy levels in AI.md. |
| B3 | Consider managed AI only if measured demand/cost/support economics justify a new RFC. Defer wallet/billing implementation until that decision. |

A1b is a bounded architectural stress slice, not a claim of full RO-SRV-02 coverage. Its expected outputs and exact reporting dates/rates come from an independently reviewed fiscal package; A3 expands the full supported matrix.

A company can move from shadow use to replacement only after every applicable profile/obligation and annual reference gate is satisfied. A2/A3/A4 cannot skip D101/annual statements or other applicable work because those engineering milestones appear later. Annual coverage can be delivered earlier for a smaller profile if its reviewed proof is complete.

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

Recruit an accounting partner alongside A1/A2. Obtain consented opening balances, tax-history registers, representative statements, source documents and reference outputs. Publish only synthetic or explicitly cleared anonymized cases.

By A4, the accountant portfolio shows companies they may access, reporting periods, freshness, missing evidence, bank differences, blocked closes and pending/rejected filings. Every count drills into actual records; revoked membership removes access immediately. Full firm billing/staff orchestration is not required.

Preserve the migration process in [ARCHITECTURE.md](ARCHITECTURE.md): reviewed opening position, separate tax-history evidence, control reconciliation, retained originals and explicit activation. Do not infer historical books from XML or require a legacy paid-AI conversion to migrate accounting.

## Priority implementation tickets

| Priority / ticket | Required proof | Delivery |
|---|---|---|
| P0 CONF-01 | Versioned ObligationClosure; foreign-service, VAT-transition, non-VAT D406 and unknown-fact cases fail closed. | A1–A2 |
| P0 FISC-01 | Effective-dated legal/calendar/register authority; reviewed current-register output and changed-deadline tests. | A2, completed before replacement |
| P0 FISC-02 | Separate adjustment, credit, payment and loss-vintage operations; FP-03/04/05 and corrected-return lineage. | A2–A7 |
| P0 LEDGER-01 | Accrual, later-invoice and credit-note links; FP-01/02 without duplicate recognition across periods. | A1b–A2 |
| P0 TEST-01 | Independent legal/expected oracles and deliberate fiscal/period mutation failures. | A1 onward |
| P0 MIG-01 | Signed handover manifest, current-year/tax continuity, exact reconciliation and missing-history activation refusal. | A4 |
| P0 FILING-01 | Distinct professional/action/submission authority, exact signing payload, pending/rejected receipts and replay safety. | A2–A4 |
| P0 OPS-01 | Funded horizon, measured/stress cost ledger, admission thresholds and recovery proof. | Before hosted scale |
| P1 UX-01 | Accountant portfolio counts drill into authorized, real company exceptions. | By A4 |
| P1 CONF-02 | Independently proven VAT, currency, time, EU and asset compositions/transitions. | A3–A7 |

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

## Later scope

Micro/payroll/administrator remuneration, inventory/ecommerce/returns, additional VAT regimes, non-EU transactions, complex assets, manufacturing and other entity types each require new profiles, transition/interaction cases, migration inputs and fiscal releases. Their supported claims remain free to use, not paid product tiers.
