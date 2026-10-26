# Conformance and verification strategy

## Independent corpus

Create an open corpus of synthetic or explicitly cleared anonymized cases. A qualified reviewer establishes expected accounting, fiscal positions, obligations, judgments and artifacts independently of the implementation. Record sources and the rights to publish each input.

Cases carry profile/composition, fiscal periods, evidence manifest, effective registrations, opening books/tax bases, expected entries/tax movements, reporting mappings and required human decisions. Store fixed expected amounts; do not compute the oracle using the engine under test. Negative eligibility/ObligationClosure cases cover foreign service purchases, VAT transition boundaries, non-VAT D406, missing tax vintages, payroll-like facts and unsupported credits. Pairwise coverage is mandatory for claimed combinations; add three-way taxation/currency/time/status cases where interactions can change the result.

Cover zero/non-VAT and exempt distinctions, inclusive/exclusive amounts, discounts, advances, accruals, prepayments, credit notes, partial/combined payments, assets, carry-forwards, owner distributions, FX, transitions and corrections only when the corresponding claim includes them. Test interaction matrices, not just isolated features: currency × VAT branch × service jurisdiction × payment timing × credit note × period boundary × registration change.

Include fiscal source/validator versions, input hashes and expected-result approval in the case manifest. A changed legal outcome creates a new revision.

## Independent proof layers and deliberate defects

Use five separately evidenced layers: (1) a reviewed effective-dated legal interpretation; (2) independently worked or separately implemented expected results; (3) implementation/unit/integration/property/fuzz/recovery tests; (4) official validators, independent comparator configuration and real-company/receipt evidence; (5) deliberate accounting/fiscal mutation failures. Agreement among correlated implementations is not independent proof.

The review's [FP-01–FP-05 candidates](FISCAL_FIXTURES.md) specify the first required known-wrong variants. An unchanged production calculation, copied comparator default, passing XML or a technically green build cannot approve them. Add blind professional review and source-to-journal/tax-position/report reconciliation. Preserve the test that detected each deliberate error and qualify surviving mutations.

## Generative and property tests

Use property-based generation (for example fast-check) within declared valid profile domains, recording seeds and minimizing failures.

| Property | Required meaning |
|---|---|
| Sum of debits equals credits | Exact RON balance at posting; this alone does not establish correct tax treatment. |
| Statement reconciliation | Opening balance plus signed movements equals closing balance. |
| Subledger reconciliation | Reviewed customer/supplier/control totals equal the corresponding general-ledger accounts. |
| Allocation conservation | Allocations cannot exceed the recorded movement or valid obligation balance; overpayment becomes an explicit advance/unallocated balance. |
| Tax availability | Utilization cannot exceed a credit/carry-forward's reviewed available amount and applicable limits. |
| Idempotency | Same accepted import/command does not add records; same key with changed input is rejected. |
| Period protection | Closed snapshots cannot mutate; corrections preserve previous versions and approvals become stale when inputs change. |
| Projection reconstruction | Rebuilding from the same frozen sources/rules reproduces the same books, tax positions and artifacts. |
| Isolation | Company and actor permutations cannot expose or mutate unauthorized records. |

Boundary generators cover zero/negative/correction amounts, precision and rounding, inclusive/exclusive date bounds, threshold equality, valid/invalid registration intervals and multi-period compositions. Validate generators too; an invalid input must not be mislabeled as a fiscal failure.

Mutation-test fiscal arithmetic, eligibility comparisons, rounding, periods and carry-forward limits. Changing a meaningful comparison or treatment branch must break a relevant test. Review surviving mutants explicitly; no universal kill percentage is asserted as a substitute for judgment.

## Fuzzing and integration failure

Fuzz XML/ZIP/PDF/image, CSV/MT940/camt.053, encodings/Unicode, decimal strings, duplicate/overlapping files and out-of-order callbacks. Require bounded resource use, no external entity/network fetch, no file escape, explicit errors and preservation of original bytes.

Test worker crashes/lease expiry, lost responses, repeated commands, stale approvals, revoked permissions/keys and ambiguous submissions. Record external attempt identity before retry decisions. Verify that provider failure or exhausted limits never disables core accounting.

## Differential references

Use [OCA/l10n-romania](https://github.com/OCA/l10n-romania) as an adversarial accounting reference. It exposes bank import, period-close, SPV, VAT and other localization modules; inspect exact module versions/licenses instead of assuming all branches provide the same coverage.

Run matching fixtures through pinned Odoo/OCA configurations and obtain consented SAGA outputs where available. Record comparator software/modules, configuration, fiscal period, evidence, input mapping and output differences. Different defaults or unsupported features require an explicit comparator qualification.

Disagreement creates a three-way discrepancy report: xFactura, the qualified comparator, and independently expected results. Investigate source interpretation, mapping/configuration, implementation defect or ambiguity; never change the oracle simply to match a trusted application. Respect licenses and confidentiality. OCA/SAGA agreement and official validator acceptance do not independently establish legal/economic correctness.

## Release evidence

Run domain/database integration tests, type/static checks, production builds and owner/accountant/portfolio browser workflows. Official XSD/semantic validators run for the exact applicable reporting period. A passing validator does not establish a correct tax position.

The parallel pilot preserves input manifests, frozen versions, reference outputs and every difference. Compare opening balances, AP/AR, bank, assets, tax bases/carry-forwards, VAT/profit-tax positions, journals, trial balances and applicable filings. Require two real monthly closes plus reviewed quarterly/year-end reference outputs before the relevant replacement claim.

Produce reproducible signed conformance reports with real executed counts, failures/skips, software/profile/package/corpus/oracle/validator hashes. Claims stay draft until their gates pass. Clean-room Compose and restoration tests prove self-hosting independence and recovery.
