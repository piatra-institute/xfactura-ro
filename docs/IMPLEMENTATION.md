# Implementation and verification

This file owns current product coverage and recorded executable evidence, checked against the source on 29 October 2026. Exact treatment behavior is in [ACCOUNTING_ENGINE.md](ACCOUNTING_ENGINE.md), the wire contract in [AGENT_API.md](AGENT_API.md), remaining work in [ROADMAP.md](ROADMAP.md) and target experiences in [FEATURE_VISION.md](FEATURE_VISION.md).

xFactura is not yet an accounting system an ordinary Romanian SRL can use as its only system. On 29 October 2026 the previous engine was replaced by a generic kernel (ADRs [0009](adr/0009-pure-core-package.md)–[0012](adr/0012-baseline-reset-and-oracles.md)). The kernel carries the general ledger, domestic and foreign-currency service invoices, credit notes, bank settlement and FX. Several workflows of the previous engine were removed in the switchover and must be rebuilt as treatments. No official declaration, VAT settlement, payroll, asset, stock, tax computation or year-end close exists.

## Macro position

Delivery remains within step 2 of the nine steps in [ROADMAP.md](ROADMAP.md). The kernel is the foundation for every later step: adding a workflow now means adding a treatment and its tests, not a schema or trigger migration.

| Step | Present capability | Remaining coverage |
|---|---|---|
| 1: general foundation | OMFP 1802/2014 reference chart with kernel control accounts and analytical accounts; financial and fiscal years; dated company profile facts with evidence; explicit openings, entries, adjustments and full reversals; source register with typed rule gaps and review status. | Reviewed chart consolidation (accounts added after 2014, e.g. 4315/4316/436), signed rule packages, obligation applicability. |
| 2: document to ledger | e-Factura UBL import (380, 381, negative 380; BT-6/BT-111); recognition of single-category S/O service invoices in lei or foreign currency; credit notes; MT940/camt.053 statements in any supported currency; complete movement settlement with realized FX differences; BNR rates; month-end revaluation. | Deferrals (471/472), advances (4092/419), accruals (408), unbilled sales (418), document allowances and charges as treatments, multi-rate invoices, CSV statements, cross-currency settlement, foreign-currency credit notes, SPV inbox. |
| 3: complete VAT and FX | Working sales and purchase VAT journals from tax entries; FX conversion with rate provenance. | VAT settlement (4426/4427 → 4423/4424), TVA la încasare, reverse charge, intra-EU, exemptions, pro-rata, D300/D394/D390, e-TVA reconciliation. |
| 4–8 | — | Assets and financing, payroll and D112, stock and production, micro and profit tax with year-end close, statutory registers and official filings. |
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
| e-Factura documents | One EN 16931 model with CIUS-RO customization: an exact calculator (rounding once at each defined amount), a canonical UBL 2.1 writer and a reader for invoices (380) and credit notes (381), with VAT categories S, Z, E, AE, K, G and O, line and document allowances and charges, prepaid amounts, and foreign currency with lei VAT (BT-6, BT-111). The browser invoicer writes its XML with it, on the device. The books issue invoices and credit notes from series with gap-free numbering at issue (guarded by the database), keep the XML as evidence and propose recognition, which a posting policy can post at once. The invoicer's JSON export imports as past sales with one outcome per record. Issued documents are submitted to the SPV through a port with recorded, never-repeated steps; syncing the inbox imports purchases, confirms or contradicts sales and resolves uncertain uploads, and a month with unsynced inbox time does not close. Only a simulator implements the port. Conversion of stored invoicer documents records every interpretation (Romanian calendar date, RO-prefixed codes as VAT identifiers, CNP buyers, net prices from VAT-inclusive prices). | The CIUS-RO schematron is not installed (published only by the Ministry of Finance). The live ANAF client (OAuth, endpoints) and signature verification, B2C identification rules, reduced VAT rates in the register, types 384/389/751/386, lei VAT for foreign-currency invoices in the invoicer, and an issuing screen in `/contabilitate`. |
| Invoices | Single-category domestic service invoices and credit notes; foreign currency with BT-111 VAT and BNR rates. | Goods, assets, mixed rates, reverse charge, exempt categories, advances, allowances or charges as separate treatments, accruals and deferrals. |
| Bank and cash | Statement import with exact balance and movement identity; partial or grouped settlement; fees and transfers on explicit accounts; FX differences. | CSV statements, cash register (registru de casă) workflow, cross-currency settlement. |
| Tax | Tax entries with semantic codes, periods and lineage; working VAT journals; tax-period locks in the database. | VAT settlement and every declaration; micro and profit tax. |
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
| Core unit and property tests (money, hashing, dates, effect validation, rules, parsers, e-Factura calculation, writing and reading, agreement with the previous PHP generator) | `bun run test` | 76 pass |
| Official e-Factura validation: 19 synthetic documents pass the UBL 2.1 schema and every fatal CEN EN 16931 1.3.17 rule; five broken documents are rejected | `bun run test:official` | 2 pass (CIUS-RO skipped, not installed) |
| Engine integration: invariants with mutation testing; kernel scenarios; invoices; issuing and invoicer import; SPV submissions and inbox against a simulated ANAF; bank; FX; HTTP and MCP; exports and backup | `bun run test:integration` | 165 pass |
| Close at scale: 100,080 posted lines, each month closed through the full review | `bun run test:perf` | slowest month 91–148 ms across runs (target: under 1 s) |
| Browser, desktop and mobile: opening to month close; invoice and bank settlement; public invoicer | `bun run test:e2e` | 6 pass |
| Typecheck, lint, format, web build | `bun run check`, `bun run format:check` | pass |

The integration suite's expected amounts for FX are computed by hand in the test file. The invariant suite drops each database guard in turn and requires the attacks it covers to succeed without it. These tests are correlated with the implementation; they are regression evidence, not independent fiscal oracles ([ADR 0012](adr/0012-baseline-reset-and-oracles.md)).
