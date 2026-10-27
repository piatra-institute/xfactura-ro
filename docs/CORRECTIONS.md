# Posted purchase corrections

This implementation covers the first A1b ticket: correction of the recorded amount of an existing domestic RON service purchase without VAT. It does not implement supplier credit notes, VAT adjustments, bank-payment reversals, opening-position corrections or prior-financial-year error treatment. Those remain in [ROADMAP.md](ROADMAP.md) and [FISCAL_FIXTURES.md](FISCAL_FIXTURES.md).

## Posting and history

The original invoice evidence, economic fact, proposal, approval and journal remain immutable. A correction identifies the latest journal in that purchase's correction chain, a posting date, a reason and supporting evidence. The server records the root purchase and its currently effective amount in the proposal snapshot; clients cannot supply those derived values.

The review binds the exact version and hash, including the target, evidence, reason, method, date and before/after amounts. Revising a draft appends a fact revision and invalidates the previous approval. Posting appends one balanced journal and one immutable correction outcome in the same command transaction. Retrying returns the existing result. A concurrent correction against an already replaced chain head fails instead of branching the history.

The supported method is `inverse_entry`, shown in the review as „Înregistrare inversă”. A replacement reverses the currently effective interpretation and adds the corrected amount in the same journal. A full reversal adds only the inverse lines, leaving an effective amount of zero. Reinstating a previously reversed purchase adds its newly approved positive amount. Approval must concern the actual displayed lines and be consistent with the company's accounting policy; the app does not infer a policy or classify a supplier credit note as a recording error. The source reference for this design boundary is [OMFP 1802/2014, paragraphs 67–69](https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_1802_2014.pdf); this mechanism is not a released fiscal package.

For example, a posted Dr 628 / Cr 401 purchase of 100.00 RON corrected to 80.00 RON produces:

| Account | Debit | Credit |
|---|---|---|
| 628 | 0.00 | 100.00 |
| 401 | 100.00 | 0.00 |
| 628 | 80.00 | 0.00 |
| 401 | 0.00 | 80.00 |

The original period still contains its original 100.00 entry. The new journal explains the 20.00 decrease. Projections expose both the unchanged source amount and the current effective amount; payment matching uses the latter with its date history.

## Periods and settlement

The correction date must be on or after the latest linked posting, within the company's configured financial year and in an open month. A closed original month can remain closed while the correction is posted in a later open month. No unlock or overwrite is performed.

A replacement amount cannot fall below payments already allocated to that purchase. Consequently, full reversal is unavailable while allocated payments remain. Recheck this condition at posting, including allocations made after approval. New payment allocations cannot exceed the corrected payable, cannot precede the original posting, and must respect both the amount effective on the movement date and any already posted later reductions. This prevents an earlier payment from consuming a later increase or bypassing a later reduction.

Draft corrections block the close of their proposed month. Withdrawing a draft records an immutable outcome, retains its evidence and facts, and removes that proposal from the close blocker set. A withdrawn proposal cannot be edited, approved or posted; an already posted correction must be corrected through another linked entry.

## Persistence and API

All code remains inside the existing `xfactura-api` accounting module. Drizzle generates `0002_purchase_corrections.sql`, which adds `acc_correction_outcomes` and its scoped foreign keys/indexes without rebuilding existing tables. The generated custom migration `0003_correction_guards.sql` adds the approval, source-basis, exact-line, terminal-state and immutable-link triggers that are not expressible as Drizzle table declarations. It retains the earlier immutable-journal and closed-period guards.

Creation and revision use `POST /companies/:companyId/correction-proposals` and `PUT /companies/:companyId/correction-proposals/:id` beneath `/api/accounting/v1`. Approval uses the existing exact-version proposal approval route. Posting and withdrawal use the correction proposal's `/post` and `/withdraw` routes. Every command checks current company membership and permissions; the generic purchase-posting route cannot bypass the correction workflow.

Exports retain correction facts, proposals, approvals, outcomes and all original source bytes. Database/document backup and restore preserve both the chain and command retry results. `CORRECTIONS.md` owns the implemented mechanics; [ARCHITECTURE.md](ARCHITECTURE.md) owns the broader accounting/fiscal separation and [TESTING.md](TESTING.md) the independent conformance requirements.
