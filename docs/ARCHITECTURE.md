# Architecture and domain contracts

## Runtime and ports

Use a TypeScript modular monolith with an API and separate worker process: Bun, Hono, PostgreSQL, Drizzle, Zod, and decimal arithmetic through `decimal.js`. Domain calculations depend on neither HTTP, React, provider SDKs, nor Piatra identity.

Retain Next.js and upgrade to a supported 16.x release, pinning tested dependencies and lockfiles. [Next.js support policy](https://nextjs.org/support-policy)

Implement small typed IdentityProvider, AIProvider, ObjectStore, BankProvider, and TaxAuthorityConnector ports as their first adapters are built. BillingProvider remains a future boundary. Avoid building a general plugin framework before the end-to-end accounting slice.

| Boundary | Core contract and initial adapter |
|---|---|
| IdentityProvider | Verified identity/session; Piatra handoff for hosted operation, standalone Better Auth for self-hosting. Company authorization stays in xFactura. |
| AIProvider | Typed proposed facts/actions, capabilities, usage, and errors; regular Piatra AI, OpenAI, and OpenRouter keys. |
| ObjectStore | Immutable content-addressed bytes, metadata and retrieval; local volume by default for reference self-hosting, S3/Garage for hosting. |
| BankProvider | Normalized statements/movements and provenance; CSV mapping, MT940, and camt.053 initially. |
| TaxAuthorityConnector | Submission attempts, status, artifacts, and receipts; ANAF official integrations or explicit guided handoff. |
| BillingProvider | Future paid operational mechanics; not a dependency of books, conformance, or provider-key AI. |

PostgreSQL owns company data, permissions, books, tax positions, workflow state, and audit records. Use database-backed leases/jobs and a transactional outbox. Storage and worker adapters avoid dependencies on unimplemented shared data/work gateways.

Hosted handoff is identity-only by default and creates an xFactura-local secure session; extend the Piatra adapter rather than implicitly minting/enabling AI credentials at sign-in. Standalone Better Auth uses invitation-based company access. Represent company membership, product action permission, professional/organizational authority and external submission mandate separately. Record evidence, scope, validity and verification for the appropriate preparer/reviewer, administrator and submitter. A UI role or owner login cannot substitute for a legally required professional qualification, management signature or qualified electronic-signature/representation procedure.

## Two interpretation branches

```text
                              ┌→ Accounting interpretation → Ledger
Evidence → Economic fact ─────┤
                              └→ Fiscal interpretation → Tax position → Obligations
```

Both branches share source authority, conformance requirements, policies, approvals, rule-package versions, and provenance. Preserve observed facts when interpretations change.

| Record | Responsibility |
|---|---|
| Evidence | Original source, content hash, origin, receipt time, company access and retention classification. |
| EconomicFact | What occurred, with source references and transaction/service/payment dates; unresolved competing assertions remain visible. |
| AccountingInterpretation / Proposal | Classification and accounting-policy reasoning, unresolved questions, approvals and links to resulting entries. |
| JournalEntry | Immutable balanced posting, original currency, RON values, actor, evidence and correction references. |
| FiscalInterpretation / TaxPosition | Treatment and company/period position for a tax, including its bridge to the ledger and underlying facts. |
| TaxAdjustment | Transaction- or period-level permanent/timing adjustment, basis, amount, source, effective rule, approval and reversal/revision links. |
| TaxBasis | Asset/item-specific accounting and fiscal bases, their changes and reconciliation. |
| TaxCarryForward | Origin/vintage, reviewed opening amount, utilization, expiry/limitations where applicable, revisions and remaining availability. |
| TaxCredit | Supported credit/relief, eligibility evidence, limit, application and remaining amount under its effective rules. |
| TaxPayment | Actual payment/settlement and allocation to declared liabilities; distinct from adjustments, credits and loss utilization. |
| FiscalRegister | Versioned prescribed register projected from the approved tax position, explanations, account/evidence references and reporting interval. |
| AdjustmentBasis / AccrualBridge | Evidence-backed original/service period, knowledge/negotiation/receipt dates, adjusting-event decision, accrual-to-invoice allocation and remaining amount. |
| PriorPeriodCorrection | Materiality/policy decision, original and recognition periods, tax impact, affected filings, dependency graph and immutable revisions. |
| ObligationClosure / MigrationHandoverManifest | Versioned applicability/dependency proof and exact handover datasets, reconciliations, responsibility and activation approvals. |
| Obligation / Artifact | Applicability, reporting period, deadline, generated version, validation, authorization, attempts and acceptance evidence. |

Accounting profit and taxable profit are reconciled by the fiscal domain. D101 is a projection of an approved tax position, not the owner of hidden adjustment calculations. VAT positions similarly represent treatment, deduction, timing and reporting independently of account balances.

Opening tax positions require their own evidence and vintage history. Do not infer usable losses, credits or fiscal asset bases from a trial balance or book-loss account. Prevent duplicate utilization across periods/corrected returns. A loss-origin correction evaluates later utilization without mutating earlier approved returns.

The prescribed fiscal register is a required profit-tax output in the applicable format, not an optional spreadsheet. Its totals reconcile with approved tax positions, D100/D101 and tax-payment allocations. Preserve effective register formats and the 2026 transition; [REGULATORY_BASELINE.md](REGULATORY_BASELINE.md) owns the dated authority and [FISCAL_FIXTURES.md](FISCAL_FIXTURES.md) owns the candidate cases.

Give fiscal operations explicit contracts: Recognize, Adjust, AllocateToPeriod, UtilizeLoss, ApplyCredit, Correct, Approve and ReconcileToFiling. Separate transaction date, service/economic period, received/knowledge date, accounting recognition period, tax point and the date used for an exchange rate; one date or fx_rate field cannot establish every treatment.

A known accounting fact can be posted while a fiscal judgment remains pending only when that uncertainty cannot change the posting itself. If recoverability or another fiscal decision changes the recognized amount/basis, block the affected posting. Pending tax judgments block tax readiness, not an unrelated banking import.

## Evidence Authority Matrix

Authority is fact-specific, dated and reviewable; there is no universal source ordering.

| Fact being established | Primary authority | Conflict handling |
|---|---|---|
| Reported bank movement/balance | Retained bank statement, then an authenticated bank correction. | User assertions/references do not overwrite reported movement; retain the dispute and correction evidence. |
| Contents transmitted/accepted through e-Factura | Retained accepted XML and its response for that transmission. | Preserve conflicting PDF/text. Acceptance does not establish delivery, payment, business purpose or correct tax treatment. |
| Historical registration | Dated retained official evidence covering the relevant date. | A current lookup cannot silently replace historical evidence. |
| Accounting policy | Approved effective-dated policy consistent with governing requirements. | Model inference or a user's draft does not replace the approved policy. |
| Fiscal interpretation | Reviewed applicable legal sources and signed rule package, plus approved case-specific judgment. | Conflicting legal sources require fiscal review; a model or simple recency rule cannot decide legal priority. |

Record the disputed fact, all assertions, chosen authority, rationale, approver, effective date and downstream effects. A human can approve an interpretation; they cannot rewrite what the original document said. Unresolved material conflicts block dependent proposals/filings.

## Invariants and interface

- Money crosses APIs as decimal strings and is stored as PostgreSQL `NUMERIC`. Define precision/rounding separately for quantity, rate, basis, tax, and totals.
- Accounting dates are dates; audit timestamps are UTC. Deadlines use Europe/Bucharest and versioned calendars. RON is the ledger currency; retain original amounts and rate/date provenance.
- Debits equal credits in RON. Balanced entries still require valid evidence and reviewed treatment; balancing is not proof of fiscal correctness.
- Posting, numbering, outbox creation, locking, tax utilization and approvals use transactions. Recheck authorization when queued work executes.
- Company IDs differ from CUIs and supplier/customer IDs. Scope queries, jobs, files, exports, credentials and audit views; enforce PostgreSQL row-level security.
- Posted records, prior approved tax-position versions and filing receipts remain immutable. Corrections link new records. Rules/policies are effective-dated and never silently rewrite history.
- Closed periods reject mutations. Any legally permitted rectification/reopening is an explicit reviewed workflow retaining prior snapshots and artifacts, not a general-purpose unlock switch.
- Rebuildable projections retain their source snapshot and versions. A changed ledger/tax position makes affected artifact approvals stale.
- Commands carry company/actor context, idempotency key, and expected record version when applicable. A repeated command returns the original result; different input with the same key is rejected.
- Approvals bind to exact hashes. Official artifacts retain a separate internal manifest containing `fiscal_package_id`, `rule_set_hash`, `software_version`, profiles, corpus and validator versions. Do not inject unsupported fields into official XML.

Expose one versioned company-scoped REST/OpenAPI interface and shared contracts for facts, interpretations, tax positions, postings, reconciliation, reports, obligations, submissions, providers and jobs. Humans and agents use the same validated commands. Open Accounting IR/schema exports must remain independently implementable.

Build a clause-to-control/test matrix for the relevant accounting-software requirements, including source traceability, period protection, reconstruction, preservation and operating documentation. Validate applicability and amendments rather than claiming certification from architectural design alone. [Romanian financial-accounting document norms, section F](https://legislatie.just.ro/Public/DetaliiDocumentAfis/173683)

## Migration, closing and filing

Migration uses a reviewed opening position plus complete relevant current-year and fiscal-history continuity, retained source files, reconciliation and an explicit activation decision. [MIGRATION.md](MIGRATION.md) owns the signed handover manifest, equations, cutover responsibility and missing-history behavior. A trial balance/XML/bank import alone cannot authorize midyear replacement.

Distinguish accounting completeness, tax readiness, and external obligation fulfillment. Closing locks the books and creates versioned outputs; it does not imply a filing was accepted or a tax payment made.

The filing lifecycle remains: prepare → validate → review → authorize exact version → submit → await receipt → accepted/rejected. An ambiguous timeout remains unresolved; do not blindly resubmit. Track preparer, approver, authorized filer, mandate reference and attempts. Guided signing/submission and receipt import cover obligations without an available official API. Use [ANAF OAuth/API documentation](https://static.anaf.ro/static/10/Anaf/Informatii_R/API/Oauth_procedura_inregistrare_aplicatii_portal_ANAF.pdf).

Preserve original documents, XML/archives, ANAF identifiers and responses. Reserve invoice numbers transactionally and distinguish draft/issued/submitted/accepted. Shared calculations drive displayed/PDF/XML/ledger values. Deduplicate stable source IDs and identical imports; overlapping movements without stable IDs become candidates, not silent deletions. Reconcile partial/combined payments, fees and FX with evidence.
