# Implementation and verification

This file owns current product coverage and recorded executable evidence, checked against the source on 29 October 2026. Exact treatment behavior is in [ACCOUNTING_ENGINE.md](ACCOUNTING_ENGINE.md), the wire contract in [AGENT_API.md](AGENT_API.md), remaining work in [ROADMAP.md](ROADMAP.md) and target experiences in [FEATURE_VISION.md](FEATURE_VISION.md).

xFactura is not yet an accounting system an ordinary Romanian SRL can use as its only system. On 29 October 2026 the previous engine was replaced by a generic kernel (ADRs [0009](adr/0009-pure-core-package.md)–[0012](adr/0012-baseline-reset-and-oracles.md)). The kernel carries the general ledger, domestic and foreign-currency service invoices, credit notes, bank settlement and FX. Several workflows of the previous engine were removed in the switchover and must be rebuilt as treatments. VAT settlement and the D300 and D390 returns exist; payroll covers salary in money and vouchers without D112; no asset, stock, income tax computation or year-end close exists.

## Macro position

Delivery remains within step 2 of the nine steps in [ROADMAP.md](ROADMAP.md). The kernel is the foundation for every later step: adding a workflow now means adding a treatment and its tests, not a schema or trigger migration.

| Step | Present capability | Remaining coverage |
|---|---|---|
| 1: general foundation | OMFP 1802/2014 reference chart with kernel control accounts and analytical accounts; financial and fiscal years; dated company profile facts with evidence; explicit openings, entries, adjustments and full reversals; source register with typed rule gaps and review status. | Reviewed chart consolidation (beyond the accounts of OMFP 1243/2018, now added), signed rule packages, obligation applicability. |
| 2: document to ledger | e-Factura UBL import (380, 381, negative 380; BT-6/BT-111); recognition of single-category S/O service invoices in lei or foreign currency; credit notes; MT940/camt.053 statements in any supported currency; complete movement settlement with realized FX differences; BNR rates; month-end revaluation. | Deferrals (471/472), advances (4092/419), accruals (408), unbilled sales (418), document allowances and charges as treatments, multi-rate invoices, CSV statements, cross-currency settlement, foreign-currency credit notes, SPV inbox. |
| 3: complete VAT and FX | Working sales and purchase VAT journals from tax entries; FX conversion with rate provenance. | VAT settlement (4426/4427 → 4423/4424), TVA la încasare, reverse charge, intra-EU, exemptions, pro-rata, D300/D394/D390, e-TVA reconciliation. |
| 4–8 | Payroll: employees with encrypted CNPs, dated contract terms, monthly runs computed from cited Fiscal Code rules and ANAF's D112 structure, posted to 641/421/431x/444/646/436, paid through the bank, and declared on D112 (validated by ANAF's tool); annual leave pay; sick pay for ordinary illness (the 2026 reduced day, the employer's and the fund's parts, the claim on FNUASS), declared on D112 (sections B, D and C2). Micro-enterprise tax per quarter from the books (art. 53 base, 1%, the 100,000-euro limit). Dividends distributed from retained profit and taxed at 16% when paid. Fixed assets: register, purchase on 404, monthly straight-line depreciation, disposal. Year-end: result closed into 121, legal reserve, transfer to retained earnings; Registrul-jurnal, Cartea mare and Registrul-inventar. | Other sick-leave codes, sick leave with the minimum-wage relief or the part-time minimum, benefits in kind, payroll corrections; fiscal depreciation and financing, stock and production, profit tax; F30's other chapters from the registers. |
| 9: replacement proof | Isolated tests, export and local backup/restore. | Pilot company parallel run against filed returns and the previous accountant's books; independent fiscal review. |

## What an invoice-and-bank month does today

1. A person keeps the originals: e-Factura XML, bank statement, BNR rates file, and the VAT registration evidence.
2. They record the company's VAT status (`profile.record`), configure the bank account and import the documents. Import establishes neither ANAF acceptance nor delivery or deductibility.
3. For each invoice, a person or agent proposes a recognition with the revenue or expense account. The engine computes the effect from the rule register. Every VAT rate is currently an unreviewed parameter, so the company works in `preview` mode unless it chooses otherwise.
4. Each bank movement is explained in full, against open invoices or explicit accounts.
5. A person approves each exact effect and posts it, or a posting policy covers routine treatments.
6. The month closes when every movement is explained, the ledger equals the statements and nothing is left unposted. Foreign balances raise a warning until revalued.
7. The result is supported bookkeeping with working VAT journals, not a filed return.

## Capabilities and boundaries

| Area | Available now | Boundary |
|---|---|---|
| Ledger | Gap-free journal numbering per year; company-wide sequence; signed lines (red or black storno); open items enforced on control accounts; trial balance (balanța de verificare) and Registrul-jurnal. | Statutory layouts of the registers, Cartea mare, Registrul-inventar, year-end closing entries. |
| e-Factura documents | One EN 16931 model with CIUS-RO customization: an exact calculator (rounding once at each defined amount), a canonical UBL 2.1 writer and a reader for invoices (380) and credit notes (381), with VAT categories S, Z, E, AE, K, G and O, line and document allowances and charges, prepaid amounts, and foreign currency with lei VAT (BT-6, BT-111). The browser invoicer writes its XML with it, on the device. The books issue invoices and credit notes from series with gap-free numbering at issue (guarded by the database), keep the XML as evidence and propose recognition, which a posting policy can post at once. The invoicer's JSON export imports as past sales with one outcome per record. Issued documents are submitted to the SPV through a port with recorded, never-repeated steps; syncing the inbox imports purchases, confirms or contradicts sales and resolves uncertain uploads, and a month with unsynced inbox time does not close. A live client calls ANAF's API over OAuth with sealed per-company tokens and ANAF's call limits; tests run it over the simulator. Conversion of stored invoicer documents records every interpretation (Romanian calendar date, RO-prefixed codes as VAT identifiers, CNP buyers, net prices from VAT-inclusive prices). | The CIUS-RO schematron is not installed (published only by the Ministry of Finance). Signature verification, a first live call to confirm the API's replies, B2C identification rules, types 384/389/751/386, lei VAT for foreign-currency invoices in the invoicer, and an issuing screen in `/contabilitate`. |
| Invoices | Expenses and revenues for later months deferred to 471/472 and released monthly (a close check holds the month until released). Domestic invoices on one account or split by VAT category over several accounts, each part deductible or not (allowances and charges within the categories); advances invoiced on 419 or 4091/4092 and deducted by the final invoice's negative line; fixed assets on 404; single-category credit notes; foreign currency with BT-111 VAT and BNR rates; services bought from abroad with reverse charge and services supplied abroad, in the D300. | Credit notes on several rates, partial deduction, domestic reverse charge, exempt categories, advances in foreign currency or by prepaid amount (BT-113), accruals (408/418); D406 lines of split and advance invoices. |
| Bank and cash | Statement import with exact balance and movement identity; partial or grouped settlement; fees and transfers on explicit accounts; FX differences. | CSV statements, cash register (registru de casă) workflow, cross-currency settlement. |
| Tax | Tax entries with semantic codes, monthly or quarterly periods and lineage; working VAT journals; VAT settlement into 4423/4424, guarded against late entries; D300, D390, D394, D100, D205, D112, D406 (SAF-T) and S1005 (microentities' annual statements, 2025) prepared from the books, validated by ANAF's DUKIntegrator, authorized on its exact XML (locking the tax period), exported as ANAF's PDF, imported signed (the attached XML checked by hash), filed and answered; reviewed reopening and rectification; VAT to recover carried forward or refunded; RO e-TVA differences against the pre-filled return; legal parameters cited to a source register; an obligations calendar with each return's cited deadline (moved off non-working days and 25 December) and status. | D300 and D390 rows for goods across the border, exemptions and imports; matching VAT payments to returns; D394 for TVA la încasare and simplified invoices; D710 corrections, the D406 assets and stock files, and the other returns; profit tax. |
| Rules | Source register with one date axis per parameter, review status, horizons and attestations; visible `RULE_GAP` issues. | Sourced 2027 values; any `interpreted` or `signed` parameter (all are `extracted`). |
| Assurance | Exact-hash approval; re-evaluation at posting; database invariants; posting policies; reviewed month close. | Segregation of duties is a profile fact without enforcement in the database. |
| Agents | Scoped, expiring, epoch-bound grants; REST, MCP and OpenAPI generated from one registry. | Built-in AI agent and provider keys ([AI.md](AI.md)). |
| Operations | Complete exports with originals (review permission); local backup and restore. | Turso provider backup; streaming exports beyond 64 MB of originals. |

## Fiscal fixture coverage

The [FP-01–FP-05 candidates](FISCAL_FIXTURES.md) remain independent-review requirements. Current mechanical coverage does not promote them into approved fiscal oracles.

| Candidate | Current building block | Still needed |
|---|---|---|
| FP-01 period-spanning service, payment, concession | Invoice, credit note at the original rate, settlement. | Economic-period and adjusting-event judgment; annual tax; outputs. |
| FP-02 December service, later invoice | None in the kernel (accruals removed in the switchover). | Accrual treatment and the full candidate. |
| FP-03 material prior-year error | Linked reversal and new recognition. | Materiality decision, prior-year fiscal revision, rectified filings. |
| FP-04 carried fiscal loss | — | Loss vintages, limits and D101. |
| FP-05 sponsorship | Explicit journal only. | Non-deductible adjustment, credit limits, reporting. |

## Recorded verification

Checked on 29 October 2026 on macOS with Bun 1.4.2.

| Check | Command | Result |
|---|---|---|
| Core unit and property tests (money, hashing, dates, effect validation, rules, parsers, e-Factura calculation, writing and reading, agreement with the previous PHP generator, D300, D390, D394, D112, D100, D205 and D406 writers, the SAF-T tax-code mapping, S1005 writer and account mapping, payroll and sick-leave calculation, calendar, filing deadlines, S1005 fixed-asset statement) | `bun run test` | 312 pass |
| Official validation: 19 synthetic e-Factura documents pass the UBL 2.1 schema and every fatal CEN EN 16931 1.3.17 rule, five broken documents are rejected; D300 returns (nil, payable, recoverable, two rates, quarterly) pass ANAF's DUKIntegrator, a D300 prepared from the books passes it end to end, D394 statements (monthly, quarterly, nil, individuals, every supported section) D112 payrolls (minimum wage with the relief, part time with the employer-borne minimum, meal vouchers, medical leave split with FNUASS and a continuation, with broken ones rejected), D100 (micro tax, dividend tax, year-end, dissolution) and D205 (individual shareholders, instalments, rectification) pass it; S1005 microentity statements (a profitable company with fixed assets and staff, a first year at a loss) pass it, and broken ones are rejected with the same rules the writer's checks report; D406 files (monthly, EUR, quarterly) pass ANAF's SAF-T kit, which rejects wrong accounts, partner codes and periods but not unbalanced entries, totals or conversions (left to the writer's checks); D406 and S1005 prepared from the books pass end to end | `bun run test:official`, `bun run test:integration` | 20 pass |
| Engine integration: invariants with mutation testing; kernel scenarios; invoices; issuing and invoicer import; declarations; payroll; SPV submissions and inbox against a simulated ANAF; bank; FX; HTTP and MCP; exports and backup | `bun run test:integration` | 271 pass |
| Close at scale: 100,080 posted lines, each month closed through the full review | `bun run test:perf` | slowest month 91–148 ms across runs (target: under 1 s) |
| Browser, desktop and mobile: opening to month close; invoice and bank settlement; public invoicer | `bun run test:e2e` | 6 pass |
| Typecheck, lint, format, web build | `bun run check`, `bun run format:check` | pass |

The integration suite's expected amounts for FX are computed by hand in the test file. The invariant suite drops each database guard in turn and requires the attacks it covers to succeed without it. These tests are correlated with the implementation; they are regression evidence, not independent fiscal oracles ([ADR 0012](adr/0012-baseline-reset-and-oracles.md)).
