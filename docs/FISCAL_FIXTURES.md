# Fiscal-position oracle candidates

These five fixtures come from the supplied regulatory review and are draft, review-required oracle candidates. The arithmetic below is reproducible; legal applicability, materiality, accounting-policy choices, exact reporting fields and source versions still require independent approval. They are not five passing conformance cases.

The source baseline is [REGULATORY_BASELINE.md](REGULATORY_BASELINE.md). The review protocol and independent proof layers are in [GOVERNANCE.md](GOVERNANCE.md) and [TESTING.md](TESTING.md).

## FP-01: December service, January payment and later concession

Inputs: service/invoice 10,000 RON on 20 December 2026, payment 4,000 on 10 January 2027, genuinely new negotiated concession/credit note 2,000 on 15 January. No VAT; verified service/contract evidence.

Candidate entries: December Dr 4111 / Cr 704 10,000; January payment Dr 5121 / Cr 4111 4,000; reviewed post-invoice concession Dr 709 / Cr 4111 2,000. Remaining receivable: 4,000 RON.

Retain 2026 accrual revenue. The new 2027 concession is distinguished from evidence of a condition already existing at year-end. Add AdjustmentBasis linking original invoice/economic period, reason, negotiation/knowledge dates, document date and adjusting-event decision. A negative/alternative case changes that evidence and requires the reviewer to establish the applicable period.

Required proof: both periods' books, tax positions and applicable D406/D101 effects reconcile. Mutation: move December revenue to January because payment was late; the independent oracle must fail it. Review relevant OMFP 1802/2014 discount/subsequent-event provisions before approving the account/period treatment.

## FP-02: December service, February supplier invoice

Inputs: service evidence and acceptance 2,000 RON in December 2026; invoice received February 2027; later payment. No VAT.

Candidate entries: year-end Dr 628 / Cr 408 2,000; later invoice Dr 408 / Cr 401 2,000; payment Dr 401 / Cr 5121 2,000. Assess deductible treatment separately from accrual recognition.

Add AccrualBridge with service period, evidence, received date, original accrual, invoice links, allocated amount and remainder. The reviewed supported cardinalities must handle partial or combined invoices without recognizing the same expense twice. Absent credible December service evidence, require evidence rather than automatically backdate.

Required proof: retained 2026 recognition, later clearing, no double expense and reviewed effects on already-filed reports. Mutation: recognize the February invoice as a second expense.

## FP-03: Material error in an approved prior year

Inputs: a verified omitted 2025 supplier expense 5,000 RON discovered July 2026; prior annual approval; materiality/policy assessment and independently established deductibility.

Candidate material-error entry in 2026: Dr 1174 / Cr 401 5,000. Link the original year, discovery, approval history, policy/materiality decision and required corrective returns through PriorPeriodCorrection.

If fully deductible against sufficient prior-year taxable profit at the stated 16% fixture rate, the illustrative decrease is 800 RON. If it changes a fiscal loss instead, revise that vintage and downstream utilization. Prior approved statements/returns remain retained; no silent overwrite or universal 1174 rule for immaterial errors.

Required proof: accounting and fiscal periods differ intentionally, prior tax position/D101 correction is traceable and downstream dependencies are evaluated. Mutation: post the material prior-year error as an ordinary current operating expense. [OMFP 1802/2014, paragraphs 66–67](https://static.anaf.ro/static/25/Anaf/OMFP_1802_2014.pdf), [Fiscal Code article 19(3)](https://legislatie.just.ro/Public/FormaPrintabila/00000G0FL2U43GSO96X1Y8N79H8BBJU6)

## FP-04: Fiscal loss vintage and utilization cap

Inputs: independently documented unused 2024 fiscal loss 100,000 RON; FY2026 taxable result before relief 60,000 RON; stated candidate cap 70% and tax rate 16%; no other effects.

```text
Loss use = min(100,000, 60,000 * 0.70) = 42,000
Taxable result after relief = 18,000
Profit tax = 18,000 * 0.16 = 2,880
Remaining 2024 loss = 58,000
```

Loss utilization is a fiscal movement, not a fabricated retained-earnings entry. The final tax-expense/payable position reconciles against quarterly recognition/payments. Preserve vintage, source returns, approved opening/revisions, utilization and remaining availability; older vintages require their own transition rules.

Required proof: D101 and the prescribed fiscal register reconcile to the same approved position. Mutation: change 70% to 100%; the independent result must fail. [OUG 115/2023 amending article 31](https://legislatie.just.ro/Public/FormaPrintabila/00000G09L16CPJ68SX3399BD9MBODE0E)

## FP-05: Sponsorship adjustment plus distinct limited credit

Boundary case outside the narrow base profile: recorded sponsorship 2,000 RON; turnover 200,000; taxable profit after adding back that expense 100,000; the candidate assumes qualifying beneficiary/date evidence and stated limits of 0.75% of turnover and 20% of pre-credit tax.

Candidate accounting when recognition/payment coincide: Dr 6582 / Cr 5121 2,000. Candidate fiscal calculation:

```text
Tax before credit = 100,000 * 0.16 = 16,000
Turnover limit = 200,000 * 0.0075 = 1,500
Tax limit = 16,000 * 0.20 = 3,200
Credit used = min(2,000, 1,500, 3,200) = 1,500
Tax after credit = 14,500
```

TaxAdjustment adds back the expense; TaxCredit independently establishes and applies relief. TaxPayment is separate again. Do not invent a carry-forward for the unused 500 RON. Verify the beneficiary registry at the applicable legal date and review D107/other obligations.

With only RO-SRV-01 enabled, the expected eligibility result is UNSUPPORTED with explicit missing capabilities, not an assumed credit or omitted return. The qualified extension's numerical result remains a candidate pending fiscal review of article 25(4)(i), article 42(3), current D107 specifications and vintage rules. Do not infer that these percentage limits originated in 2024 merely because other sponsorship provisions changed then.

Mutation: deduct the expense as ordinary and also take the credit; the independent bridge/credit assertions must fail.

## Where FP-03, FP-04 and FP-05 run (4 November 2026)

The profit tax (P1) reproduces them, still as draft candidates, never as oracles:
- **FP-03:** `correction.priorYear` books Dr 1174 / Cr 401 5,000 in July of the next year (refusing the same correction through 628), and the year's rectification (`tax.profit`, `rectification`) books the 800 lei less on 1174 (Dr 4411 / Cr 1174); its rectifying D101 passes ANAF's validator (`profit.test.ts`, `profit.integration.test.ts`, `official-d101.test.ts`).
- **FP-04:** a 2024 vintage of 100,000 against 60,000: 42,000 recovered, 2,880 tax, 58,000 left (`profit.test.ts`).
- **FP-05:** 2,000 of sponsorship added back (rd. 27) and credited at 1,500, no carry-forward; with only the base profile the closure still reports `SPONSORSHIP`, for D107 (`profit.test.ts`, `official-d101.test.ts`).
- **The deadline test of OUG nr. 8/2026:** the calendar gives D101 for 2026 by 25 June 2027 (`ro.deadline.D101`).

## Promotion and mutation evidence

Before promotion, freeze company/profile/period inputs, exact legal versions and clause decisions, independently signed expected entries/positions/artifact mappings, negative variants and reporting dependencies. The fixed fixture rate/limit is an oracle input for its historical scenario, not a global application default.

Required fiscal commands include Recognize, Adjust, AllocateToPeriod, UtilizeLoss, ApplyCredit, Correct, Approve and ReconcileToFiling. Their implementation never rewrites the underlying economic fact. A correction re-evaluates downstream positions and approvals with preserved lineage.

A release report records whether each deliberately wrong variant was killed and which independent assertion caught it. A matching implementation, comparator and validator do not promote an unreviewed candidate.
