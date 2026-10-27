# Implementation and verification

The accounting specifications remain in [ACCOUNTING_PLATFORM_PLAN.md](ACCOUNTING_PLATFORM_PLAN.md). This file owns executable work and verification evidence. The current increment adds evidenced purchase accruals, later-invoice matching and 408/4428 controls to the existing invoice/settlement engine. It does not establish a full Romanian accounting suite or produce official declarations. [ACCOUNTING_ENGINE.md](ACCOUNTING_ENGINE.md) owns the implemented engine contracts and boundaries.

## Macro position

The accounting-first sequence in [ROADMAP.md](ROADMAP.md) supersedes the previous agent-first ordering. Both VAT and non-VAT, micro/profit taxation, native payroll, stock and production are committed scope. Verification begins with 2025 and 2026. Deployment, browser OAuth delegation and a built-in provider-key agent are deferred.

| Step | State |
|---|---|
| 1: general foundation | Implemented mechanics: sourced reference chart, analytical accounts, financial/fiscal years, general openings/proposals/adjustments, evidenced registrations and versioned policy records. Rule/declaration references are draft metadata. Current-chart consolidation, formal applicability/obligation closure and fiscal-package approval remain unfinished. |
| 2: document-to-ledger | Implemented bounded domestic RON service workflows: invoices/credits, positions, settlements/refunds/fees, bank/cash mappings, purchase accruals and later-invoice matching with separate deferred/input VAT and control reconciliation. Unbilled sales, estimate variances, advances, prepayments, ZIP and MT940/camt remain unfinished. |
| 3: complete VAT and FX | Working native-invoice VAT registers and ledger reconciliation implemented. Complete coverage remains pending: cash VAT, reduced/exempt categories, pro-rata, regime transitions, FX and EU/import/export branches. |
| 4: assets/financing/owners | Pending. |
| 5: native payroll | Pending. |
| 6: native stock/production | Pending. |
| 7: micro/profit tax and annual close | Pending; existing tax-position references are not tax computations. |
| 8: statutory registers and official filing packages | Pending; no official declaration generator/validator or receipt import implemented. |
| 9: company/year replacement proof | Pending independent fiscal review, migration continuity and real-company annual proof. |

No full Romanian accounting conformance/replacement profile has passed. Existing scoped API/MCP access remains available and expands with the engine.

## General ledger and first invoice workflow

| Ticket | Implemented behavior | Executable proof | State |
|---|---|---|---|
| GL-01 mechanics | 584 sourced chart/group records; company analytical accounts; distinct financial/fiscal years; arbitrary balanced opening/general postings and linked adjustments | Explicit 2025/2026 VAT/non-VAT lines, year reports without doubled openings, analytical/unknown/group accounts, stale approvals, immutable lines and large integer amounts | Implemented; reviewed current chart/fiscal conformance pending |
| GL-02 continuity | Generated Drizzle journal-line rebuild with separately generated preparation/guard-restoration migrations; idempotent company initialization and complete exports | Populated original-schema upgrade preserves sources/facts/proposals/hashes/commands/posted rows; update/delete/tamper rejection and fresh restore | Implemented |
| CFG-01 | Evidenced effective-dated normal/special/cash VAT and income-tax registration facts; immutable versioned company policy records; draft rule/declaration references | Unknown status stays unknown; date changes and stale policy versions tested; human-only changes and company isolation | Implemented as records/catalogues, not an applicability engine |
| DOC-01 first treatment | Bounded namespace-aware UBL parser; original XML retained; source identity/hash conflicts; automatic purchase/sale direction; reconciled line/tax/document totals | VAT sales/purchases at 19% and 21% boundaries; non-VAT sales and irrecoverable purchase VAT; duplicated/concurrent imports/proposals/postings | Implemented bounded workflow |
| DOC-02 review | Explicit service/tax-point/recognition dates, treatment evidence and deduction decision; deterministic exact lines; registration/rule snapshot checked again at posting | Missing registrations, new historical evidence, cash VAT, wrong rate/tax and foreign/EUR/reduced treatments blocked; credit notes require the distinct linked workflow; agents cannot approve | Implemented bounded workflow |
| UX-GL | Existing review screen shows exact general/VAT lines and evidence; financial-year selector; account names come from used company accounts | Desktop/mobile invoice review, exact lines, keyboard navigation and financial-year isolation in `general-ledger.spec.ts` | Implemented and verified |
| DOC-03 credits/positions | One native posting per invoice; source-linked discounts/cancellations; preserved original tax rate; dated open/settled/refundable positions | Partial payment and following-month credit; 19% original rate after August 2025; paid-invoice refund; cross-year links; competing credits and over-allocation rejected | Implemented bounded current-period commercial treatment |
| CASH-01 settlements | Native invoice allocations and fees; exact human approval; per-account bank/cash mappings and close reconciliation | Grouped receipts with net fees, separate fees, multiple banks, missing statement, negative cash, stale approvals, direct mutation and cross-company rejection | Implemented RON mechanics; advances/FX/treasury account lifecycle pending |
| VAT-REG-01 | Signed working source registers, original/adjustment periods, category/rate totals and input/output ledger reconciliation | 19%/21% period split, irrecoverable purchase VAT, opening VAT excluded, unposted sources and unexplained postings produce issues, bounded pages and reproducible report hash | Implemented working register; no official declaration/conformance claim |
| GL-03 continuity | Generated additive treasury/position schema; guarded atomic links; old native journals backfilled without rewriting originals | Populated `0011` upgrade twice, exact preserved fact/proposal/approval/command/journal rows; export and fresh restore retain positions and guards | Implemented |
| LEDGER-01 purchase accruals | Evidenced monthly service purchases in 408; full/no VAT recovery; partial/grouped later invoices without repeating expense; original-period rate and invoice receipt evidence | December 2025 expense and February 2026 invoice/payment; non-VAT and no-deduction cases; July 19% services invoiced in August; credits do not consume an accrual twice; large exact bani | Implemented bounded purchase workflow; 418/variance/period-allocation branches pending |
| CTRL-01 accrual continuity | Dated 408/4428 subledger/GL reconciliation through API/MCP; differences block monthly close when native accruals exist | Missing carried opening positions produce exact differences and reject close; correct opening/match/payment closes successfully | Implemented; broader deferred-VAT classifications and opening-item migration pending |

The imported XML is not presumed ANAF-accepted or proof of service delivery/deductibility. Credit notes require original-invoice matching and an explicit period decision; foreign currencies and other tax categories can be retained without an automatic posting treatment. Unsupported imported invoices block monthly close until a supported resolution exists.

The difficult accounting fixture now retains a 121.00 RON VAT purchase, a 40.00 payment and 2.00 separate fee in October, closes October, then posts a November commercial discount of 20.00 + 4.20 VAT and the final 56.80 payment. November ends with bank 901.20, payable zero, original service expense 100.00, discount 20.00, deductible VAT 16.80 and bank fees 2.00. Source authority adjudication, official D300/D394/D406 artifacts and fiscal correction/receipt workflows are still needed for the complete A1b gate.

The new purchase fixture recognizes a 2,000.00 RON December 2025 service expense with gross unbilled liability 2,420.00 and 420.00 VAT awaiting its invoice. After December close and an independently supplied 2026 opening, a February invoice clears 408, moves 420.00 from 4428 to 4426 and creates the supplier payable without another expense. Payment leaves bank 2,580.00 and payable zero. Missing 408/4428 opening continuity blocks monthly close even when bank reconciliation succeeds.

Next within step 2: unbilled sales in 418 and their VAT timing, purchase estimate variances/reversals, advances and 471/472 period allocation, retained e-Factura ZIP imports and MT940/camt statement adapters. Then extend VAT treatments in step 3. Payroll, inventory/production, annual taxation and official reporting keep their macro positions; this increment does not mark them implemented.

The XML parser rejects DTDs/entities, wrong namespaces, duplicate critical fields, inconsistent currencies/totals and excessive text/depth/nodes. It does not replace official CIUS-RO validation, signature verification or fiscal review. Concurrent writes in one Database instance are queued; independent processes still rely on libSQL/SQLite arbitration and the retryable BUSY contract.

## Agent API and MCP

| Ticket | Implemented behavior | Executable proof | State |
|---|---|---|---|
| AGENT-01 | Company capability discovery and shared typed handlers for current commands, reads and deterministic effects | REST contract checks and old route workflows use the same handlers; unknown/unsupported operations are not advertised | Complete |
| AGENT-02 | Human-issued scoped grants, expiry/revocation, distinct agent attribution and command namespaces | Self-approval, membership/grant management, cross-company calls, stale retries, role downgrade and revoked queued work are rejected | Complete |
| AGENT-03 | Payment-match/month-close snapshots with separate human approval and atomic revalidation/execution | Unapproved/stale execution rejected; repeated approved execution creates one result; guarded review snapshots and grant authority cannot be rewritten/revived | Complete |
| AGENT-04 | Official SDK MCP transport inside the existing API; grant-filtered tools, no browser-cookie authority | Official 2025/2026 clients, concurrent reads, exact approval pause/resume across API recreation, replay and grant revocation | Complete |
| AGENT-05 | Additive generated Drizzle schema and custom invariant guards; export/restore continuity | Existing populated-book upgrade proof; fresh restore retains grants, exact approval and single execution while original books remain unchanged | Complete |
| AGENT-06 | Browser OAuth delegation and protected-resource authorization | Pending consent, issuer/audience/resource binding, expiry/revocation and client compatibility proof | Pending |

[AGENT_API.md](AGENT_API.md) owns the actual command surface, connection procedure, approval contract and remaining OAuth boundary. The existing UI's black theme and manual workflows remain; no agent settings or new accounting forms were added. MCP clients currently supply a manually issued scoped accounting credential, separate from provider inference keys.

## Accounting foundation

| Ticket | Implemented behavior | Executed proof | State |
|---|---|---|---|
| A1-01 | Bun 1.4.2 workspace with pinned new dependencies and one lockfile | Frozen install; original invoicer JSON import/export, persistence, PDF and XML on desktop/mobile | Complete |
| A1-02 | Existing web app upgraded to Next.js 16.4.3 / React 19 with accounting routes | Local Node 26 and container Node 24 production builds; original routes remain available | Complete |
| A1-03 | Standalone Better Auth; internal accounting module in the existing API; SQLite/libSQL and Drizzle | Authentication, scoped references, isolation, invitation replay and revocation tests | Complete |
| A1-04 | Immutable evidence/facts, exact-version approval, opening and purchase postings, separate fiscal references | Fixed independent expected balances; stale-approval/concurrent/retry failures; integer amounts beyond JS safe precision | Complete |
| A1-05 | Statement CSV import, movement deduplication, payment matching, journal and trial balance | Statement arithmetic, duplicate/concurrent allocation, closed periods and multi-month balance-difference cases | Complete |
| A1-06 | Romanian black-theme review, bank, register and document screens | Desktop/mobile workflow, reload, exact balances, one company form, no release checklist/test labels/focus rings/overflow | Complete |
| A1-07 | Leased export worker and coherent local backup/restore | Frozen export/original checksums, revoked jobs, reclaimed crashed lease, fresh restore and replay without duplicate postings | Complete |
| A1-08 | Reference Compose and operating instructions | Fresh isolated volume without provider keys; account creation, complete API flow, export, process restart, backup, restore and migration replay | Complete |

## A1b: correction and reversal mechanics

The first A1b coding ticket implements linked amount corrections and full reversals for posted domestic RON/non-VAT service purchases in the configured financial year. [CORRECTIONS.md](CORRECTIONS.md) owns the detailed behavior and boundaries. The original evidence, proposal, approval and journal remain immutable; the correction records its reason, source, date, exact approved lines and preceding journal.

| Ticket | Implemented behavior | Executed proof | State |
|---|---|---|---|
| A1b-01 | Propose, revise, withdraw, approve and post linked purchase corrections/reversals; follow the chain in the UI | API and desktop/mobile flows; stale approvals, concurrent targets, payment bounds, closed months and no duplicate posting | Complete |
| A1b-02 | Preserve original data through an additive Drizzle upgrade, exports and restore | Populated original-schema upgrade; original guards retained; frozen export and fresh restore preserve chain and retry results | Complete |

A fixed correction fixture retains a 100.00 RON October purchase and its 40.00 RON payment, closes October, then records an 80.00 RON interpretation in November. Bank stays 960.00 RON, payable becomes 40.00 RON and service expense becomes 80.00 RON. A second unpaid 50.00 RON purchase is fully reversed without removing either journal. These prove the implemented posting mechanics, not a reviewed VAT or fiscal-return treatment.

XML import, bounded standard-VAT service treatment, linked current-period credits and separate/netted bank fees now exist in the native invoice workflow. Authority-conflict adjudication, official reporting artifacts and fiscal corrections remain unfinished A1b work. Prior-financial-year error classification and reversal of posted allocations also require distinct workflows.

## Reproduce the checks

Run the commands from the repository root:

```sh
bun install --frozen-lockfile
bun run test
bun run test:integration
bun run typecheck
bun run lint
bun run format:check
bun run build:api
bun run build
bun run test:e2e
bun run db:generate
```

The current engine increment passes 96 SQLite/API integration tests, including 12 added accrual/matching/control cases. The existing 64 generated VAT-rounding/allocation scenarios still use independent integer arithmetic; all five domain/property tests pass. Official-SDK MCP clients prepare accruals and invoice matches with narrow scopes, pause for human approval and safely retry exact posting. Revocation denies cached retries at both service and HTTP authentication boundaries. Engineering verification does not imply fiscal conformance.

All fourteen desktop/mobile browser checks pass. Coverage includes reviewing an accrual, following the matched invoice to its prior-year journal, exact approval/posting and proving no second expense or horizontal overflow. The accrual flow also exercises account 611; the owner service-expense figure now includes groups 61/62 and their analytical accounts. The earlier credit/settlement flows remain: a 96.80 allocation with 2.00 fee and actual 94.80 receipt, with analytical bank totals of 1,094.80. Invoice-match headings display invoice gross rather than the sum of reclassification debits. Visual inspection retains the black theme and existing review layout.

The larger browser suite initially hit the genuine shared-local-IP login limit. `bun run test:e2e` now gives each viewport a fresh isolated server/database run, preserving production authentication limits. Targeted file/project arguments remain supported and artifacts are separated by viewport.

A compatibility test also exposed an earlier legacy purchase check that recognized only the old opening type. It now accepts the approved general opening for the same financial year. Legacy payments reconcile against their mapped analytical bank account; native and legacy posting paths cannot book the same movement twice.

Generated migrations `0007`–`0011` prepare and rebuild journal lines, restore guards and add company configuration/imported documents. `0012`–`0013` add treasury/native-position tables and their invariants. Generated `0014` and custom `0015` add guarded accrual projections and invoice matches. Populated original-schema and `0011` upgrades preserve existing books through the entire chain. Earlier applied migrations are not rewritten. Ordinary table/index/column SQL comes from Drizzle schema generation.

`bun install --frozen-lockfile`, type checking, lint, formatting, API/web production builds and `git diff --check` pass. `bun run db:generate` reports no schema drift. The new dependency is pinned `saxes@6.0.0`; the parser never fetches external entities. Browser inspection confirms the black theme, usable keyboard controls and no horizontal overflow at desktop/mobile widths. The company selector now identifies the company; the separate financial-year control owns the reporting period.

The configured local SQLite installation was backed up under `.accounting/backups/before-purchase-accruals-20261027` before applying `0014`–`0015`. It passes `integrity_check` and has zero foreign-key violations. No business entries or accounting credentials were created in that installation by this verification. Earlier backups remain retained. Docker execution and a live Turso deployment were not repeated; deployment changes are outside this accounting increment.

The earlier correction UI review identified one keyboard-navigation issue; its fix focuses the linked journal summary and tests verify subsequent Tab navigation. The bounded review disposition was `ship` for that correction change; it is not an independent fiscal or security certification of the agent API.

The independent A1 fixture posts bank/capital 1,000.00 RON, a 100.00 RON service purchase and its payment, producing bank 900.00 RON, supplier payable 0.00 RON, expense 100.00 RON and capital 1,000.00 RON. Tests retain original bytes and prove that retries, worker recreation, database reopening and fresh restore preserve the result. This proves the stated fixture, not fiscal-profile conformance.

The reference Compose check used a fresh `xfactura-a1-check` project on localhost port 3300 with synthetic data. API health, standalone account creation, exact approvals/postings, idempotency, CSV reconciliation, month close, worker export and source checksums passed. API/worker restart retained the account, three journal entries, the exact bank balance and completed export. CLI backup/restore plus migration replay reproduced the balance and all original bytes in a separate directory. The temporary project and its volume were removed after verification.

## Remaining boundaries

A live Turso service was not exercised; URL/token configuration uses the same libSQL adapter, but remote transaction, backup/export and recovery behavior still need deployment-specific proof. The backup CLI supports local SQLite only. The current ObjectStore implementation is local; S3/Garage is planned.

Standalone authentication currently falls back to a shared per-path rate-limit bucket when it cannot resolve a trusted client IP. A verified trusted-proxy/client-IP integration is required before public hosted scale; do not trust arbitrary forwarded headers. Node 26 also reports its experimental server-side localStorage warning from the existing browser-local invoicer during prerendering. Browser persistence and production builds pass.

No official fiscal artifacts or validators, independently signed fiscal oracle/package, real-company migration or external filing receipt were exercised in this increment. The initial fulfillment target is an externally signed/submitted official package and receipt import; direct ANAF submission remains deferred. Those requirements remain in [ROADMAP.md](ROADMAP.md), [CONFORMANCE.md](CONFORMANCE.md) and their domain documents; they are not generic tasks rendered in the app. A1's tax-position/fiscal-interpretation records preserve references and review state without calculating profit tax.

Keep MPL-2.0 pending the rights review in [OPEN_SOURCE.md](OPEN_SOURCE.md). The remaining A1b work is specified in [ROADMAP.md](ROADMAP.md), with independently reviewed VAT, supplier credit-note and reporting expectations.
