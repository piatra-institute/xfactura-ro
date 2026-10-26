# Migration handover and production activation

## Handover manifest

Implement MIG-01 before midyear replacement activation. A balanced cutover trial balance, e-Factura and bank statements do not establish full fiscal-year continuity.

The versioned MigrationHandoverManifest binds company, cutover date, covered intervals, fiscal/profile/package versions, dataset inventory/hashes, chart mappings, policies, authority evidence, reconciliation results, unresolved/unreconstructable information, and obligation responsibility. Record the outgoing/incoming positions and accountable parties' approvals against the exact manifest hash. Preserve signatures/attestations and distinguish product approval from a qualified signature. Missing attestations are explicit gaps, not invented approvals.

For a 1 July 2026 handover, preserve the approved 1 January opening position and the first-half accounting/fiscal history, not only 30 June balances.

| Dataset | Minimum continuity evidence |
|---|---|
| Identity, policy and authority | CUI/entity, chart/mappings, dated fiscal and VAT regimes, reporting periods, materiality/accrual/correction policies, accountant/administrator and filing authority. |
| Current-year history | Approved year-opening position, journals/trial balances through cutover, subledgers, adjustments/reversals, settlements, source evidence, closed snapshots and tax-position revisions. |
| Open items | Itemized AP/AR, advances/unallocated amounts, 408/418 accruals, prepaid/deferred items, bank balances/timing items, equity/loans and tax-payable balances. |
| Fiscal history | D100/D101 positions and payments, losses by vintage, credit use, fiscal asset bases where relevant, prior declarations/receipts and pending corrections. |
| Source archive | Original exports, XML/responses, statements, register/inventory/annual evidence, hashes and retrieval paths. |
| Responsibility | Each pending/due/future obligation, covered period, preparer, reviewer, authorized submitter, deadline and acceptance/handback procedure. |

Every excluded category needs reviewed non-applicability evidence. An empty array is not proof that there are no assets, employees, foreign purchases, losses or withholding obligations.

## Reconciliation proof

Use a consistent debit-signed account convention. At cutover H, prove for every mapped account:

```text
B_a(H) = B_a(year_start) + sum(debits through H) - sum(credits through H)
sum(B_a(H)) = 0
AR control = itemized outstanding receivables
AP control = itemized outstanding payables
Bank GL = bank statement + individually evidenced timing adjustments
Loss remaining = reviewed opening + approved revisions - utilization - expiry
```

These equalities are necessary, not sufficient. Keep advances/prepayments and other controls separate; do not hide them inside AP/AR. Establish original-currency reconciliation, mappings and accounting precision. Reconcile filed figures and payments to the approved historical tax positions, with explicit discrepancies.

| Activation gate | Required proof |
|---|---|
| Financial totals | Zero unexplained differences among journals, opening/cutover balances, bank statements and mapped controls. |
| Detailed positions | Material balances have originating evidence and allocations, not just aggregate totals. |
| Fiscal continuity | Vintages, credits, bases, registers, past returns/payments and corrections independently reconcile. |
| Evidence | Original bytes, provenance, checksums and retrieval paths survive import/export and restore. |
| Responsibility | All already-due, pending and future obligations have an accountable preparer/reviewer/submitter or explicit agreed external handoff. |
| Reproducibility | Reimport is idempotent; a fresh environment reproduces the frozen snapshot and reconciliation proof. |
| Cutover and recovery | Approved outgoing/incoming positions and a controlled activation/handback procedure. |

A Q2 filing due after a 1 July cutover is assigned explicitly; accounting-period dates alone do not decide who files it. Existing receipts are imported as evidence, not regenerated as new submissions.

## Staging, activation and incomplete history

Stage imports and run reconciliations without changing official prior books. Activation approves the exact manifest, snapshots and responsibility assignment. Prior to activation, abandoning staging leaves the old system unchanged. After official activation, switching back uses a reviewed handback/correction workflow rather than deleting posted history.

If first-half journals/tax history are missing, either establish an explicit partition of old-system responsibility with proven annual continuity and qualified approval, or refuse replacement eligibility. A partition is a limited claim, not full xFactura replacement. Never synthesize a fictional historical ledger to make totals match.

Opening balances/XML/bank extracts cannot independently recover old account/period choices, uninvoiced services, transactions outside e-Factura, settlement intent, deductibility, accruals, asset bases, tax-loss vintages, prior professional judgments or filer authority. Record every such gap and its resolution path.

The existing public invoicer remains available. Browser invoices become source records, not proof of acceptance/payment/posting. Do not merge unrelated companies into one ledger or consume legacy AI entitlements to complete an accounting migration. Retain the original browser export and data until the user removes them explicitly.

[CONFORMANCE.md](CONFORMANCE.md) owns replacement eligibility; [ARCHITECTURE.md](ARCHITECTURE.md) owns immutable records; [ROADMAP.md](ROADMAP.md) owns delivery order.
