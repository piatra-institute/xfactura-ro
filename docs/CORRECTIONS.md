# Corrections

Posted entries never change. Corrections append new entries linked to what they correct, and the original period keeps its original entry.

## Before posting

A proposal is corrected by revising it (`<treatment>.revise`). The revision is a new version: earlier approvals no longer apply and the approver reviews the new effect. A proposal can also be withdrawn, which keeps its history and frees its subject (the document or movement) for a new proposal. Proposals dated in a month block that month's close until they are posted or withdrawn.

## After posting

`ledger.reverse` reverses a posted entry in full, with a reason and supporting evidence:

- **red storno** repeats each line on the same side with a negative amount, so turnover nets to zero;
- **black storno** repeats each line on the opposite side.

Tax entries are mirrored in the reversal's own tax period and linked to their origin. The correct treatment is then proposed again, for example with a new recognition of the document. A reversal is refused when it would push an open item past zero, such as an invoice already paid, so payments and refunds are handled first.

The reversal is dated in an open month on or after the original entry. A closed original month stays closed; nothing is unlocked or overwritten. Reopening a month is a separate reviewed action ([ACCOUNTING_ENGINE.md](ACCOUNTING_ENGINE.md#month-close)).

For example, a posted Dr 628 / Cr 401 purchase of 100.00 RON recorded instead of 80.00 RON is corrected by a red storno of the 100.00 entry followed by a new 80.00 recognition. The original month still shows 100.00; the correction month explains the change.

Which method applies, and whether an error belongs to the current or a prior year, is an accounting policy and judgment the approver makes ([OMFP 1802/2014, paragraphs 67–69](https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_1802_2014.pdf)). The engine does not infer it, and prior-year error treatment (1174, fiscal revisions, rectified returns) is not implemented. See [FISCAL_FIXTURES.md](FISCAL_FIXTURES.md) FP-03.
