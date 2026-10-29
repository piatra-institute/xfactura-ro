# Accounting capabilities and MCP

The implemented API covers general-ledger proposals and financial-year reports, company chart/configuration records, domestic RON service invoices/credits, purchase accruals, completed unbilled sales and later-invoice matching, uniform monthly/actual-day service allocations through 471/472, service advances through 4092/419, invoice positions, bank/cash settlements and working VAT registers. It does not calculate full tax positions, generate official declarations, submit to ANAF or establish replacement eligibility. [ACCOUNTING_ENGINE.md](ACCOUNTING_ENGINE.md) specifies the engine capabilities and their limits. The built-in accounting agent and browser OAuth delegation remain planned. External clients can already use MCP with an explicitly issued accounting credential.

## One contract

The capability catalogue lives inside `packages/xfactura-api/source/accounting`, alongside its deterministic handlers. It owns input/output schemas, operation permissions, effects and approval requirements. The existing web command routes and MCP invoke the same handlers. The browser's aggregate overview and binary downloads remain compatibility projections; they do not grant extra agent authority.

For a company ID:

| Interface | Endpoint |
|---|---|
| Authorized discovery | `GET /api/accounting/v1/companies/{companyId}/capabilities` |
| Typed invocation | `POST /api/accounting/v1/companies/{companyId}/capabilities/{capabilityId}` |
| MCP Streamable HTTP | `/api/accounting/v1/companies/{companyId}/mcp` |
| OpenAPI | `GET /api/accounting/openapi.json` |

Discovery reports only implemented capabilities available to the current principal, including their schemas. Money uses exact decimal strings. Mutations require an `Idempotency-Key` of 8–128 letters/digits/underscore/dot/colon/hyphen; a retry reuses both key and input. Reads accept empty input where specified. Domain commands recheck authority before returning a cached result.

## Implemented surface

| Capabilities | Behavior |
|---|---|
| `books.summary` | Company identity and trial balance. |
| `years.list`, `years.create`, `accounts.list`, `accounts.create` | Financial/fiscal years and company chart; configuration changes are human-only. |
| `regimes.read`, `regimes.record`, `policies.read`, `policies.record` | Evidenced effective-dated company configuration; changes are human-only. |
| `rules.list`, `obligations.catalogue` | Draft calculation/specification references; no applicability or declaration claim. |
| `ledger.propose`, `ledger.revise`, `ledger.post`, `ledger.balance` | General and opening entries, exact approved execution and year-scoped reports. |
| `invoices.import`, `invoices.list`, `invoices.get`, `invoices.propose` | Retained UBL facts and bounded domestic service treatments. |
| `invoices.importArchive`, `invoices.archive` | Atomic retained ZIP import and immutable manifest; extracted invoice/signature/supporting bytes remain distinct, with no acceptance or posting claim. |
| `invoices.sources` | Bounded archive/member provenance for an invoice, including exact XML variants. |
| `invoices.proposeCreditNote`, `invoices.reviseCreditNote` | Linked current-period commercial credits retaining the original tax treatment. |
| `positions.get`, `positions.list` | Dated invoice receivables/payables, credits, settlements and refunds. |
| `accruals.propose`, `accruals.revise` | Evidenced service purchases in 408, with estimated recoverable VAT awaiting the invoice in 4428. |
| `accruals.matchInvoice`, `accruals.reviseMatch` | Exact partial/grouped later-invoice matches; clear the unbilled liability without another expense. |
| `accruals.get`, `accruals.list`, `accruals.reconcile` | Dated unbilled positions and reconciliation to the selected year's 408/4428 balances. |
| `accruals.proposeAdjustment`, `accruals.reviseAdjustment`, `accruals.adjustments` | Evidenced current-year changes/releases of unbilled purchase estimates; immutable history and exact re-approval. |
| `unbilledSales.propose`, `unbilledSales.revise` | Evidenced completed-service revenue in 418/704, with applicable output VAT recognized at the original service tax point. |
| `unbilledSales.matchInvoice`, `unbilledSales.reviseMatch` | Exact partial/grouped issued-invoice matches, transferring 418 to 4111 without revenue/VAT duplication. |
| `unbilledSales.proposeAdjustment`, `unbilledSales.reviseAdjustment`, `unbilledSales.adjustments` | Exact new-information changes/releases of an explicitly estimated unbilled remainder; retain originals, matches and signed history. |
| `unbilledSales.get`, `unbilledSales.list`, `unbilledSales.reconcile` | Dated unbilled-service receivables and reconciliation to the selected year's 418 balance. |
| `deferrals.proposeInvoice`, `deferrals.reviseInvoice` | Contract-backed 471/472 invoices with equal-month or actual-day allocations, including partial first/last months; separate invoice VAT. |
| `deferrals.proposeSupplement`, `deferrals.reviseSupplement` | Separately invoiced additional future services, with an immutable parent link and independent amount, schedule, VAT and invoice position. |
| `deferrals.proposeRelease`, `deferrals.reviseRelease` | Month-end expense/revenue allocations; exact human approval and `ledger.post`, without repeated VAT. |
| `deferrals.proposeCreditNote`, `deferrals.reviseCreditNote` | A linked credit cancels whole future subscription months, preserving earned amounts and the original tax treatment. |
| `deferrals.proposeScopeReduction`, `deferrals.reviseScopeReduction` | A linked credit cancels part of future service scope; preserve earned amounts, dates and method, and reallocate the reduced positive future value. |
| `deferrals.proposeDiscount`, `deferrals.reviseDiscount` | Commercial subscription credits through 609/709, with unchanged services/schedule and separate agreement evidence. |
| `deferrals.proposeReschedule` | Prepare an unchanged-price future calendar as an exact action review; human approval and reviewed execution apply an immutable version without a journal. |
| `deferrals.get`, `deferrals.list`, `deferrals.reconcile` | Dated schedules/remaining amounts and year-scoped 471/472 controls, including carried prior-year subscriptions. |
| `advances.proposePayment`, `advances.revisePayment` | Explain a whole retained RON bank movement as an evidenced service advance; purchase cash alone deducts no VAT, customer receipts recognize applicable output VAT. |
| `advances.proposeInvoice`, `advances.reviseInvoice` | Interpret a retained 380/386 advance invoice, optionally matching whole earlier payments without repeating VAT. |
| `advances.proposeFinalInvoice`, `advances.reviseFinalInvoice` | Recognize the full service and consume explicitly referenced, fully settled advances through negative final-invoice lines. |
| `advances.proposeCreditNote`, `advances.reviseCreditNote` | Cancel only the unused invoiced advance; existing positions and settlements handle the resulting refund. |
| `advances.proposeRefund`, `advances.reviseRefund` | Return an entire unbilled bank advance under a separately retained current agreement. |
| `advances.getPayment`, `advances.payments`, `advances.get`, `advances.list`, `advances.reconcile` | Dated payment/invoice positions, bounded pages and year-scoped 4092/419 controls. |
| `treasury.accounts`, `treasury.createAccount`, `treasury.recordCash` | RON bank/cash mappings and documented cash facts; mapping changes are human-only. |
| `settlements.propose`, `settlements.revise` | Exact partial/grouped allocations, refunds and fees for retained movements; post with `ledger.post` after human approval. |
| `vat.entries`, `vat.unbilledSales`, `vat.unbilledSaleAdjustments`, `vat.advancePayments`, `vat.summary` | Source-linked invoice/service/advance working registers and combined ledger reconciliation; no official return. |
| `evidence.list`, `evidence.read`, `evidence.record` | Source metadata, immutable originals and content-addressed upload. |
| `proposals.list`, `proposals.get` | Exact versions, approval/posting state and deterministic posting lines. |
| `books.proposeOpening`, `books.proposePurchase`, `books.revisePurchase` | Prepare the existing opening or domestic service-purchase interpretation. |
| `books.approve`, `books.post` | Human approval, then exact approved posting. |
| `corrections.propose`, `corrections.revise`, `corrections.withdraw`, `corrections.post` | Linked current-year purchase correction/reversal mechanics. Approval uses `books.approve`. |
| `bank.importStatement`, `bank.movements`, `statements.list` | Bounded CSV import, movements and statement balances. |
| `bank.importFile`, `bank.file`, `bank.statementEntries` | Retained MT940/camt.053 imports, immutable file/statement manifests and paged booked entries with value dates, bank references and transaction details. |
| `reviews.request`, `reviews.list`, `reviews.approve`, `reviews.execute` | Prepare, inspect, approve and execute exact payment-match, month-close or subscription-calendar snapshots. |
| `reviews.reject` | Human-only rejection of a subscription-calendar review, retaining the exact hash and decision reason. |
| `journals.list`, `activity.list`, `jobs.list` | Immutable entries, attribution and durable export status. |
| `exports.request`, `exports.download` | Frozen export job and authenticated download descriptor. |
| `agents.issue`, `agents.list`, `agents.revoke` | Human management of delegated credentials. |
| `company.invite`, `company.revoke` | Human company-owner membership management. |

`bank.match` and `periods.close` preserve explicit human actions from the existing UI. Agents cannot invoke these direct actions; they prepare an action review and execute its approved hash. The engine never moves bank funds.

List inputs have `limit` (default 25, maximum 100) and optional `cursor`; outputs contain `items` and `nextCursor`. Proposals support kind, pending/approved/posted/withdrawn/superseded status and accounting-date bounds. A posted subscription cancellation or calendar amendment supersedes affected unposted releases; their sources and approvals remain retained. Calendar amendments supersede every draft bound to an earlier plan version, including drafts whose month is restored by a later amendment. Pending/approved filters exclude them. Movements support matched status and date bounds; journals support kind and date bounds. A cursor is scoped by the endpoint and company; reuse the same filters while paging. Pages are live views, not a frozen export. Evidence uploads accept canonical base64, at most 10 MiB decoded; request bodies are bounded to 15 MiB. Evidence reads inline at most 256 KiB and otherwise return an authenticated download path.

`deferrals.proposeInvoice` requires the retained invoice, separate contract evidence/date, service dates, `early_invoice`, service account and explicit deduction. Pair `basis: uniform_subscription` with `method: equal_calendar_months` for whole equal-benefit months, or `basis: uniform_service` with `method: actual_calendar_days` for inclusive actual service days and partial first/last months. The documented-monthly alternative is described below. Retain evidence for the selected benefit basis; neither invoice dates nor model confidence establish it. Mixed pairs are invalid. The invoice must precede or equal service start. Covered stable VAT rules, domestic RON, 628/704 service accounts and full/no deduction remain required.

Daily proposals retain a version-2 treatment, actual service dates/day counts and cumulative-floor bani allocation. For 100.00 from 16 January through 15 March 2026, read 59 days and 27.11/47.46/25.43. `deferrals.get`/`list` add optional `allocation` metadata (`basis`, `method`, `dayCountBasis`, `rounding`, `serviceDays`) and row-level `serviceFrom`, `serviceTo`, `days`. Top-level `serviceTo` is the actual effective service end, not its month-end posting date. Existing monthly facts, hashes and optional-field-free reads remain compatible. `deferrals.reviseInvoice` retains its existing `id`/`version` contract and requires fresh human approval; no capability ID or approval authority was added.

`deferrals.proposeRelease` names `financialYearId`, `deferralId` and the first day of the scheduled month; its journal date is month end for all three methods. Invoice VAT is not repeated. Read and approve the exact effects before `ledger.post`. `DEFERRAL_ALLOCATION_DUE` requires posting due monthly amounts; `DEFERRAL_CONTROL_DIFFERENCE` requires reconciling the carried 471/472 balance. `DEFERRAL_VAT_TRANSITION` checks changes throughout the retained registration history, including transitions reversed before month end. It and `DEFERRAL_CREDIT_TREATMENT` need separate treatments, not manual overrides of the schedule. Ordinary native settlements still pay/collect the source invoice. Neither a schedule nor a payment authorizes autonomous posting or movement of funds.

Subscription cancellation uses `deferrals.proposeCreditNote`, with the retained credit invoice, `originalInvoiceId`, financial year, recognition/decision dates, separate `treatmentEvidenceId`, `kind: cancellation`, `periodBasis: current_period_event`, reason and `cancelFrom`. It covers that entire month and the following scheduled months. Neither recognition nor issue may follow the first cancelled day. Credit cost/revenue must equal those exact schedule amounts. `STALE_DEFERRAL_CREDIT` needs revision and fresh human approval; `DEFERRAL_MONTH_CANCELLED` rejects obsolete allocations. Unaffected prepared allocations become stale until `reviseRelease` includes the cancellation journal. Position reads separate `allocated`, `cancelled` and `remaining`, and retain dated cancellation/month links. Prospective unchanged-price calendar amendments use the separate review below; price/scope changes and prior-period errors remain unsupported. Never submit the deferred original through the ordinary service-credit workflow.

Commercial subscription discounts use `deferrals.proposeDiscount` with `{invoiceId, originalInvoiceId, financialYearId, recognitionDate, decisionDate, treatmentEvidenceId, kind: "commercial_discount", periodBasis: "current_period_event", servicesUnchanged: true, reason}`. Retain a separate agreement establishing that the services and their schedule continue unchanged. The price reduction posts to 609/709 rather than changing 471/472 or the monthly plan. Irrecoverable purchase VAT belongs in the discount amount; the original rate and deduction decision remain authoritative. Read the exact lines and evidence before human approval and `ledger.post`.

`deferrals.reviseDiscount` additionally takes the draft `id` and `version`. `STALE_DEFERRAL_DISCOUNT` requires refreshed source/credit state and new approval. `DEFERRAL_DISCOUNT_EVIDENCE` needs a separately retained agreement; `DEFERRAL_EVENT_ORDER` rejects recognition before existing credits. `CLOSED_PERIOD` rejects a locked recognition month. `OVER_CREDIT` requires reviewing cumulative discounts/cancellation against original net/tax/gross. A price discount does not make a monthly release obsolete; a cancellation still can. Existing position/settlement capabilities handle any resulting refund. Neither tool moves funds or authorizes a scope/schedule amendment, annual adjusting event or prior-year correction.

## Documented monthly benefits

Use the existing `deferrals.proposeInvoice`/`reviseInvoice` or supplemental-invoice capability with `basis: "documented_monthly_benefits"`, `method: "evidenced_monthly_amounts"` and `benefits: [{month, amount, benefit}, ...]`. Supply 1–60 consecutive first-of-month rows covering the service interval in order, including zero months. Amounts must exactly total the cost/revenue basis, including irrecoverable VAT. The engine does not infer an allocation from a contract or prorate these values. For 100.00 over 16 January–15 March, documented amounts can be 20.00/50.00/30.00; the retained `schemaVersion: 3` schedule includes actual service endpoints and month-end posting dates.

For each positive `deferrals.proposeRelease`/`reviseRelease`, also supply `benefitEvidence: {evidenceId, evidenceDate}`. Retain separate evidence of performed services in the company; the invoice, original contract, applied calendar agreement, scope credit or scope agreement cannot serve as that confirmation. Its date is bounded by that row's actual service end and month-end journal date. Later confirmations and uncompleted milestones are outside this treatment. The release binds the resolved confirmation hash, original contract hash, exact amount and current calendar. Human approval remains mandatory; a replacement proof invalidates an old approval. Old allocation methods reject this extra input and preserve their existing evidence/hashes.

`DEFERRAL_BENEFITS` rejects missing, duplicate, unordered or incomplete months; `DEFERRAL_BENEFIT_AMOUNT` rejects a different total. `DEFERRAL_BENEFIT_EVIDENCE` requires a separate correctly dated confirmation. Explicit zero months remain `not_required` without a journal. `deferrals.get`/`list` expose the method and descriptions; release journals retain the confirmation source. Full future cancellation and commercial discounts preserve exact recognized amounts. `deferrals.proposeScopeReduction` now accepts an explicit smaller future plan under this method; see the scope-reduction workflow below. `DEFERRAL_SCOPE_ALLOCATION` rejects a mismatched uniform/explicit basis.

## Unbilled-sales remeasurement workflow

1. Retain completed-service evidence and identify uncertain consideration at recognition with `measurementBasis: "estimated_consideration"`. Existing unclassified/confirmed recognitions cannot be reclassified silently.
2. Retain the new measurement information separately. Invoke `unbilledSales.proposeAdjustment` with `{financialYearId, unbilledSaleId, reference, evidenceId, evidenceDate, newInformationDate, date, periodBasis: "current_year_estimate_change", changeBasis: "new_measurement_information", action: "reestimate" | "release", remainingNet, reason}`. `remainingNet` is the revised **uninvoiced remainder**, after all existing matches. Release requires zero; reestimate requires a positive value.
3. Inspect the exact previous/new remainder, signed revenue/418/VAT differences, source and original journal. A human approves through `books.approve`; the agent may execute only that version/hash through its granted `ledger.post` scope.
4. `unbilledSales.reviseAdjustment` adds the draft `id` and `version`, refreshing the snapshot and requiring new approval. `STALE_UNBILLED_SALE_ADJUSTMENT` means a match/change invalidated the older decision. A remeasurement likewise invalidates an old invoice-match approval; refresh it with `unbilledSales.reviseMatch`.
5. Read `unbilledSales.get`/`list` at the relevant date, `unbilledSales.adjustments` with `{unbilledSaleId, date, limit, cursor}`, and the selected-year 418 reconciliation. Original values remain separate from `adjusted*`, remaining amounts and actual invoiced `matchedGross`.
6. Use `vat.unbilledSaleAdjustments` for signed working-register movements. Later invoice matches retain the original tax point and latest adjustment link, with no repeated revenue/output VAT.

Supported boundaries: same financial year, retained new information in the recognition month, stable normal/non-VAT status, and no cash VAT. Non-VAT changes may follow an earlier closed month. Normal-VAT remeasurement is restricted to the original service month; `UNBILLED_SALE_ADJUSTMENT_TAX_PERIOD` requires a separately supported fiscal treatment instead of moving tax into a later month. This is an implementation boundary, not a definition of statutory reporting periodicity.

`UNBILLED_SALE_MEASUREMENT` requires an explicitly estimated source. `UNBILLED_SALE_ADJUSTMENT_EVIDENCE` requires a new separate measurement record. `UNBILLED_SALE_RESOLVED`, `CLOSED_PERIOD`, year/registration/order failures and unchanged amounts reject unsupported adjustments. Fully invoiced/released positions cannot reopen. The command does not implement discounts, contractual cancellation, bad-debt relief, original errors or annual adjusting events.

## Subscription-calendar workflow

1. Retain the new agreement separately from the invoice, original contract and previously applied amendments.
2. Invoke `deferrals.proposeReschedule` with `{financialYearId, deferralId, date, effectiveFrom, serviceTo, evidenceId, evidenceDate, method, priceUnchanged: true, reason}`. Preserve the original method: `equal_calendar_months`, `actual_calendar_days` or `evidenced_monthly_amounts`. The explicit method additionally requires future-tail `benefits` with exactly the same remaining total. The result is an action review, not a posting proposal. Generic `reviews.request` also accepts `{operation: "deferrals.reschedule", input: ...}`.
3. Inspect the exact `beforeSchedule`/`afterSchedule`, preserved recognized amount, future amount, source links and agreement. `effectiveFrom` must be an existing future first-of-month on/after the original service start; the original partial first month cannot move. Daily tails may end mid-month and retain row dates/day counts. Only the future remainder is redistributed under the original method; the prefix stays exact. Existing due positive monthly allocations must be posted first.
4. A human invokes `reviews.approve` with `{id, hash}`. The agent can then invoke `reviews.execute` under its own explicitly granted scope with the same `{id, hash}`. Applying the plan creates no journal and changes no invoice/VAT amount.
5. A human can instead invoke `reviews.reject` with `{id, hash, reason}`. `result.kind: declined` retains the decision and leaves the schedule unchanged. `executedAt` then marks the completed review, not an applied calendar; inspect `result.kind` to distinguish it from `rescheduled`.
6. Read `deferrals.get` at a date for the effective plan and `reschedule` provenance. Reprepare superseded monthly drafts through `deferrals.reviseRelease`, then approve/post each exact new version as usual. Retained discounts/cancellations must also use the current version.

`reviews.list` supports `pending`, `approved`, `executed` and `superseded`. Competing requests for an already applied sequence are derived `superseded` and leave the active queue. Other due unexecuted calendar reviews cause `DEFERRAL_RESCHEDULE_PENDING` at month close; apply or explicitly reject them. Rejected reviews do not apply on execution retry.

For the 100.00 daily example, after January 27.11 an amendment effective 1 February through 10 April preserves that prefix and redistributes only 72.89 over the new 69-day tail: 29.57/32.75/10.57. Applying it adds no journal or VAT movement. Commercial discounts preserve all three schedules; cancellation still selects entire future monthly buckets, including a partial final service month, and cannot calculate an arbitrary mid-month cutover.

`STALE_APPROVAL` requires a fresh review after any source/release/credit/registration change. `DEFERRAL_ALLOCATION_DUE` requires recognizing already-due benefits; `DEFERRAL_MONTH_ALLOCATED` rejects moving a recognized month. `DEFERRAL_RESCHEDULE_METHOD` requires retaining the original method. `CLOSED_PERIOD`, `DEFERRAL_EVENT_ORDER`, `DEFERRAL_VAT_TRANSITION` and `DEFERRAL_ALREADY_CANCELLED` require a separately supported resolution. Price/scope changes, uncompleted milestones, annual adjusting events and historical errors are not calendar amendments. Approval and rejection remain human-only, and no tool moves money.

## Supplemental service invoices

1. Identify a posted parent 471/472 invoice. Retain a separate agreement and another original invoice for additional future services. Preserve the parent; the new invoice carries only the additional amount.
2. Invoke `deferrals.proposeSupplement` with the usual `proposeInvoice` fields plus `{parentDeferralId, changeBasis: "additional_future_services"}`. Choose the new invoice's documented equal-month, actual-day or explicit-monthly basis, service dates, service account and deduction. Its issue date is its own early-invoice tax point. Parties, direction, RON currency and service account must match the parent; a supplied original-invoice reference must match too.
3. Inspect the additional invoice's exact value, VAT, benefit schedule, agreement and `deferral.supplement` parent identifiers/hash. Human `books.approve` then scoped `ledger.post` record the invoice and link atomically. `deferrals.reviseSupplement` adds `id`/`version`, invalidates the earlier approval and requires a fresh decision.
4. Read the addition through `deferrals.get`. Use `deferrals.list` with `{date, parentDeferralId, onlyOpen, limit, cursor}` for direct posted additions. The optional `supplement` output retains parent deferral/invoice/journal/financial-year IDs and proposal hash. Each returned amount belongs to that invoice; the endpoint does not recursively aggregate contracts.
5. Prepare and approve releases for every due invoice. Payments may explicitly allocate one bank movement across parent and addition. Existing credits, refunds and calendar reviews apply separately to the selected invoice. The additional invoice's VAT appears once in the working register, while its releases have none.

Example: a 30.00 + 6.30 invoice for 1 February–15 March 2026 retains 43 days and allocates 19.53/10.47. The original 100.00 plan stays unchanged. A later credit of the original does not cancel an already posted addition; a credit of the addition changes only that invoice. Parent releases alone do not invalidate its independent approval. A full parent cancellation effective by the new invoice date blocks an unposted addition.

`DEFERRAL_SUPPLEMENT_ORIGIN` requires matching parent, parties, direction, currency and service account; `DEFERRAL_SUPPLEMENT_EVIDENCE` requires a separately retained new agreement. `DEFERRAL_SUPPLEMENT_DOCUMENT` rejects advances, regularization patterns and conflicting references. `DEFERRAL_SUPPLEMENT_CANCELLED` requires resolving the cancelled parent or documenting a separate new contract. Regime changes, cash VAT, retroactive price corrections, replacements and uncompleted milestone recognition need distinct treatments. Explicit monthly additions use their own documented amounts and service confirmations. Supplemental invoices do not authorize changes to the old billed value or movement of funds.

## Future-service scope reduction

1. Retain the original 471/472 invoice, a linked CreditNote 381 and a separate new agreement reducing unprovided services. Document the remaining benefits under the original uniform or explicit-monthly basis over the same dates. Post due monthly allocations before changing future scope.
2. Invoke `deferrals.proposeScopeReduction` with `{financialYearId, invoiceId, originalInvoiceId, recognitionDate, decisionDate, treatmentEvidenceId, kind: "cancellation", periodBasis: "current_period_event", cancelFrom, changeBasis: "cancelled_future_services", remainingServices: "uniform" | "documented_monthly_benefits", reason}`. The explicit branch also requires `benefits`. `cancelFrom` is the first day of a scheduled future month. The credit must leave positive future value; use `proposeCreditNote` for full future cancellation and `proposeDiscount` for an unchanged-service commercial discount.
3. Inspect the exact financial lines, original rate/deduction, recognized prefix, changed future amounts and retained agreement. The proposal's `deferralCredit` uses version 2 for uniform benefits or version 3 for explicit monthly amounts; both include `beforeSchedule`, `afterSchedule` and the preserved `method`. Human `books.approve` authorizes its exact version/hash; scoped `ledger.post` records the credit and changed schedule atomically.
4. `deferrals.reviseScopeReduction` additionally takes `id` and `version`. A new credit, release or calendar amendment invalidates an older snapshot; revision requires fresh human approval. Reprepare affected superseded releases with `deferrals.reviseRelease` and approve/post their exact new versions.
5. Read dated `deferrals.get`/`list` and year-scoped reconciliation. `amount` remains the original basis, `cancelled` includes the scope credit, and `cancellation.kind` is `scope_reduction`. Remaining rows stay scheduled and due until posted. Working VAT and invoice positions reflect the signed credit; existing settlement tools record any eventual refund without moving bank funds.

Example: after January 27.11 in the 59-day 100.00 plan, a 20.00 net credit leaves 52.89, allocated as February 34.44 and March 18.45. VAT 4.20 reverses once at the credit; the subsequent allocations repeat no VAT. Prior timing amendments are respected, including partial final months.

The input is limited to domestic RON, full/no deduction, covered stable VAT rules and a current-period agreement. For an `evidenced_monthly_amounts` source, set `remainingServices: "documented_monthly_benefits"` and provide future-tail `benefits: [{month, amount, benefit}, ...]`. Include every existing future month, including zeros, in order. Their total must equal the old tail less the credit's cost/revenue basis, including irrecoverable VAT; no month may increase. The retained `schemaVersion: 3` credit contains both complete schedules and preserves earlier rows and service dates. For 20.00/50.00/30.00 after January, a 20.00 credit can leave 40.00/20.00. The invoice VAT credit is separate; remaining releases still need their own service evidence.

`DEFERRAL_SCOPE_ALLOCATION` requires a matching uniform/explicit source basis. `DEFERRAL_SCOPE_BENEFITS` rejects increasing a month or changing its dates; `DEFERRAL_BENEFITS` and `DEFERRAL_BENEFIT_AMOUNT` reject invalid month coverage and totals. The scope agreement must be separate from invoice bytes, original contract, applied calendar agreements and posted service confirmations. Once the credit is posted, its XML/agreement cannot become release confirmation. `reviseScopeReduction` retains the usual `id`/`version` contract and invalidates previous approval.

`DEFERRAL_CREDIT_AMOUNT` rejects a zero/complete/excess scope reduction; `DEFERRAL_CANCELLATION_EVIDENCE` requires separate evidence; `DEFERRAL_ALLOCATION_DUE` requires posting due benefits. Closed months, changed registrations and recognized target months fail closed. One full or partial scope cancellation is supported per source; subsequent changes to that reduced balance, mid-month cutovers, combined timing/scope redistributions and historical/annual corrections need distinct coverage. Separately invoiced additional services use the supplemental-invoice workflow. All approvals remain human-only.

## Bank-file workflow

1. A human configures the company's RON IBAN and distinct 5121 mapping through `treasury.createAccount`.
2. Retain the original bytes through `evidence.record`, then invoke `bank.importFile` with `{evidenceId, financialYearId, format: "mt940" | "camt.053", encoding: "utf-8"}` and a stable idempotency key. MT940 also accepts explicitly selected `windows-1250`; camt is UTF-8 only.
3. `bank.file` reads the retained file summary, original statement IDs, source hash, manifest hash and parser version. `bank.statementEntries` pages `{sourceId, limit, cursor}`; `sourceId` here is the source UUID returned in `statements[].id`, and the cursor is the last entry's zero-based ordinal. It is distinct from the original bank statement identifier in `statements[].sourceId`.
4. Inspect signed booked amounts, booking/value dates, bank/customer references, reversal flags, charges and transaction details. A camt `Ntry` is one movement; nested `TxDtls` are supporting details. Charges retain their original field `kind` and entry/transaction scope: totals and component amounts are not additive. They are informational and never create another movement or authorize a fee posting.
5. Prepare `settlements.propose` or the supported advance treatment for the resulting movement. Human `books.approve` and exact `ledger.post` remain required. Import does not post, initiate payments or grant new authority.

Limits: 2,000,000 raw bytes, 100 complete RON statements, 2,000 booked entries per file and 200 transaction details per entry. Supported variants are complete MT940 with `60F`/`62F`, and camt.053.001.02/.08 with `BOOK`, `OPBD`/`CLBD` and whole-day intervals. Provisional/paginated/fractured statements, foreign currency, timezone-changing report intervals and unknown dialects fail closed. This is bounded format support, not vendor certification or official schema validation.

Stable bank references reuse movement identities across imports/formats while preserving each original source version and its description. Changed financial content for the same bank statement ID fails. A same-date/same-amount overlap without comparable bank identities returns `AMBIGUOUS_BANK_DUPLICATE`; obtain an unambiguous retained source rather than guessing or dropping a row. Exact legacy CSV bank references can match, but arbitrary CSV IDs are not inferred aliases. All statements in a file commit together. Live authorization applies before parsing, committing and returning cached results. A new movement in a closed month fails; an additional proven source version can still be retained. Month close requires continuous statement coverage for each active bank, all movements reconciled and ledger balances matching every statement checkpoint.

## Archive workflow

1. Upload the original ZIP through `evidence.record`.
2. Invoke `invoices.importArchive` with `{evidenceId}` and a stable idempotency key.
3. Read `outcome`, `invoiceCount` and each manifest entry's `kind`, `invoiceId`, `evidenceId`, path and hash. `no_invoice` retains a response/supporting archive without creating an invoice. `signatureVerification: not_performed` never means ANAF acceptance.
4. Read invoice facts through `invoices.get`, then choose a supported accounting treatment and prepare it for exact human approval. Import never posts.
5. Use `invoices.archive` for the retained manifest and `invoices.sources` with `{invoiceId, limit, cursor}` for source origins. `evidence.read` or authenticated download retrieves the original ZIP and exact member bytes under its own scope.

Limits are 10 MiB compressed, 100 entries, 10 MiB per file, 40 MiB expanded and 200:1 per-file expansion. Unsupported/encrypted/nested archives and unsafe paths fail closed. A malformed, foreign-company or conflicting invoice rejects the whole batch. Fixing an import requires new retained source evidence; never modify original bytes or silently discard a failed member. Both repeated and concurrent identical imports preserve one manifest and the original normalized invoice identities. Every retry rechecks live authorization, including revoked grants.

## Advance workflow

For advances, retain a separate contract and expected service date. `proposePayment` names the whole bank movement, partner, direction, service account, net and S/O category. `proposeInvoice` names the imported invoice, recognition/tax-point dates, explicit deduction and optional `paymentIds`; selected payments must fully explain that invoice. A pre-invoice payment cannot currently split across invoices. Invoice-first advances use ordinary `settlements.propose` for partial/grouped payments.

`proposeFinalInvoice` names the retained final invoice and allocations `{advanceInvoiceId, lineId, net, tax}`. Each allocation identifies a negative source line and a fully settled advance. The source XML must reference each advance invoice. Partial use and multiple advances are supported; rates, partner, account and deduction must agree. `ADVANCE_UNSETTLED` requires settlement first; `STALE_ADVANCE_FINAL` requires revision and fresh human approval. Unsupported rate/registration transitions, rounding differences and separate regularization documents need distinct treatments.

Unused invoiced advances use `proposeCreditNote` with the original invoice, retained credit, current-period cancellation decision and separate agreement. Unbilled advances use `proposeRefund` with the opposite whole bank movement and current agreement. Neither can consume amounts already matched, used or refunded. `ADVANCE_CONTROL_DIFFERENCE` requires reconciling itemized 4092/419 positions, including explicit carried openings. Approval remains human `books.approve`, execution exact `ledger.post`; no capability moves funds.

## Delegate accounting access

A human owner or reviewer issues a grant through `agents.issue`, with their normal session cookie and required `Origin` header:

```json
{
  "name": "Accounting assistant",
  "scopes": ["books.summary", "proposals.list", "proposals.get", "books.proposePurchase", "books.post"],
  "expiresAt": "2026-11-15T00:00:00Z"
}
```

Choose a future expiry within 90 days and the smallest required scope list. The response includes a credential beginning `xfa_`. Send it only as `Authorization: Bearer …` to the intended xFactura instance. It is an accounting credential, separate from any Piatra AI/OpenAI/OpenRouter inference key. Agents cannot issue grants, manage membership, approve proposals or approve action reviews, even if the delegating human is an owner.

Grants are company-scoped, identify the delegating human, expire and can be revoked. Current human membership and permissions constrain every use. Owners can revoke any company grant; reviewers can manage their own grants. Scope expansion or revival requires a new grant. Human and agent command keys have separate namespaces; audit events preserve the agent ID and delegator.

Credential material is derived from the installation secret and issuance command identity so an identical issuance retry can recover a lost response. The database stores its hash, not the bearer credential; command results, ordinary exports and audits omit the credential. Revoked/expired issuance cannot be replayed to recover a working grant. Retain the installation secret across recovery. Local backups contain authentication records and grant hashes and need the same protection as the original database.

## MCP connection

MCP runs inside the existing API, using the official TypeScript SDK. It supports 2026-07-28 per-request serving and stateless 2025 compatibility. No separate accounting server or process is required. Example client code, with the accounting credential obtained separately:

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client(
  { name: 'company-accounting-agent', version: '1' },
  { versionNegotiation: { mode: 'auto' } },
);
await client.connect(new StreamableHTTPClientTransport(
  new URL(`${process.env.XFACTURA_URL}/api/accounting/v1/companies/${process.env.XFACTURA_COMPANY}/mcp`),
  { authProvider: { token: async () => process.env.XFACTURA_AGENT_TOKEN } },
));
const result = await client.callTool({
  name: 'proposals.list',
  arguments: { input: { status: 'pending', limit: 25 } },
});
await client.close();
```

Tool names match capability IDs. Arguments contain `input` and, for mutations, `idempotencyKey`. Tool discovery excludes unavailable scopes and every human-only action. Model elicitation or text saying “approved” cannot grant accounting authority. Domain failures are tool errors with stable codes such as `APPROVAL_REQUIRED` or `STALE_APPROVAL`; authentication failure rejects the HTTP request. No subscription stream or hidden MCP session carries workflow authority.

Browser cookies do not authenticate MCP. Browser OAuth consent, resource/audience-bound OAuth tokens and protected-resource discovery remain deferred work. Do not configure OAuth-only clients as though that flow already exists. This endpoint currently accepts manually issued scoped accounting credentials.

Host validation admits the configured public hostname and local loopback names for a local installation. A reverse proxy that changes `Host` needs its exact internal hostname in `ACCOUNTING_MCP_PROXY_HOSTS` (comma-separated); the reference Compose configuration supplies `api`. There is no wildcard or trust in client-supplied forwarded headers. Any supplied `Origin` must match the configured public origin; ordinary session-cookie mutations retain their mandatory Origin check.

## Approval and recovery

For a legacy purchase, prepare a proposal, read its source/effect, and retain its `id`, `version` and `hash`. A human uses `books.approve`. The agent reads approval status and calls `books.post` with that exact version/hash. Revisions invalidate old approvals; posting still rechecks closed periods and accounting constraints.

General, invoice and accrual proposals use `ledger.post`; a `books.post` grant cannot authorize them. Accrual matches retain original journal/year/hash, available balance and exact allocation. A competing match returns `STALE_ACCRUAL_MATCH`; refresh with `accruals.reviseMatch` and obtain a fresh human approval. `ACCRUAL_CONTROL_DIFFERENCE` on close requires reconciling actual 408/4428 opening/matching data. Configuration changes remain human-only. `books.summary` requires `financialYearId` when the company has several financial years; `ledger.balance` always names the year.

Purchase-estimate adjustments also use `ledger.post`. `remainingNet` names the new unbilled remainder, rather than replacing the original purchase or invoiced total. `release` requires zero; `reestimate` requires a positive remainder. Separate new-information evidence/dates and `current_year_estimate_change` are required. Original-year, open-period and event-order checks apply. `STALE_ACCRUAL_ADJUSTMENT` requires `accruals.reviseAdjustment` and fresh human approval; an intervening adjustment also invalidates prepared invoice matches. `ACCRUAL_RESOLVED` prevents reopening an invoiced/released position. `ACCRUAL_ADJUSTMENT_PERIOD` and VAT-transition errors need a distinct supported treatment. Dated position reads retain original amounts, add adjusted totals/counts and can return `released`; `accruals.adjustments` pages the immutable history. Invoice matches identify their latest adjustment journal when applicable.

Unbilled-sale proposals also use `ledger.post` after human approval. `STALE_UNBILLED_SALE_MATCH` requires `unbilledSales.reviseMatch` and a fresh approval; `UNBILLED_SALE_CONTROL_DIFFERENCE` requires reconciling 418 continuity. Invoice matches retain the original service tax point and have no new revenue/output VAT. Their `vat.entries` movements are zero and `previousRecognition` retains source amounts/position IDs; `vat.unbilledSales` exposes the original tax movements. Do not infer a later tax period from the invoice date. Unsupported tax-point bases or transitions require a separate supported treatment.

For matching or closing, call `reviews.request` with one of:

```json
{"operation":"bank.match","input":{"movementId":"…","proposalId":"…","amount":"100.00"}}
```

```json
{"operation":"periods.close","input":{"month":"2026-10-01"}}
```

The result contains the exact effect and its hash. A human inspects it and calls `reviews.approve` with `{ "id": "…", "hash": "…" }`; the agent later calls `reviews.execute` with the same pair. Both approval and execution recompute the checked state. New allocations, corrected purchase amounts or changed close inputs invalidate the corresponding review. A close snapshot conservatively binds the checked company accounting state, so unrelated new accounting work can also require a fresh close review.

All effects, approvals, execution results and retries persist in SQLite. Restarting MCP or the API does not grant authority or lose approval state. Queued exports retain agent identity and recheck live scope, expiry and membership before processing and completion. Revocation blocks cached retries, downloads and queued work. Local restore tests reproduce an approved review and execute it once without changing the original installation's books.

[IMPLEMENTATION.md](IMPLEMENTATION.md) owns executable proof. [ROADMAP.md](ROADMAP.md) owns the remaining OAuth, built-in agent, bookkeeping and fiscal milestones.
