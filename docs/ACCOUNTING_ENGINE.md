# Accounting engine

This document owns the engine's exact runtime behavior: what each implemented treatment accepts, what it books and what it refuses. [IMPLEMENTATION.md](IMPLEMENTATION.md) owns company-level coverage; [AGENT_API.md](AGENT_API.md) owns the wire contract; [ROADMAP.md](ROADMAP.md) owns remaining work.

The engine is the kernel described in [ADR 0010](adr/0010-append-only-kernel.md). Its pure parts live in `packages/xfactura-core`; persistence, commands and transports live in `packages/xfactura-api/source/engine`.

## How anything reaches the books

1. **Evidence.** An original file is kept as immutable, content-addressed bytes (`evidence.record`). Every proposal cites the evidence it relies on.
2. **Documents.** Imports turn evidence into typed, immutable documents: e-Factura invoices and credit notes (`invoices.import`), bank statements (`bank.import`), BNR rates (`fx.importBnr`).
3. **Treatment.** A pure function evaluates a typed input against the state it declares it reads: documents, open items, movements, the company profile, FX rates. It produces an **effect**: journal lines with dimensions and currency amounts, open items, tax entries and schedules, together with any issues.
4. **Proposal.** The engine validates the effect, resolves stable ids and hashes the version over its treatment, input, read-set, rules and effect. Issues are `block`, `ack` (must be acknowledged at approval) or `info`. A company has at most one open proposal per subject (`document:<id>`, `movement:<id>`, …).
5. **Binding.** A person approves the exact version and effect hash (`proposals.approve`), or a human-approved posting policy covers the treatment and rule versions (`policies.create`).
6. **Posting.** `ledger.post` reloads the read-set and re-evaluates the treatment. If anything differs it refuses with `STALE`. Otherwise it writes the rows and then the entry header. The database's invariants check the rows against the approved effect, the balance, the binding, the period and tax-period locks and the numbering, then seal the entry.

Posted records are never changed. A correction is a reversal (`ledger.reverse`) plus a new proposal.

## Money, dates and rates

- Amounts cross the API as decimal strings and are stored as signed 64-bit integer minor units (bani for RON). Lines carry a signed amount on one side; a negative amount is a red storno.
- Accounting dates are calendar dates; Europe/Bucharest is applied when an instant must become a date.
- FX rates are BNR reference rates kept with the hash of the file they came from. Which publication applies on a date is a rule parameter (`ro.fx.rate_date.accounting`, `ro.fx.rate_date.vat`), currently `on_or_before` and unreviewed. A rate older than 7 days counts as missing.

## Rules and their review status

Fiscal parameters come from the source register (`xfactura-core/src/ro/vat.ts`, `src/ro/fx.ts`, `src/ro/payroll/parameters.ts`). Resolution never defaults:

| Gap | Meaning |
|---|---|
| `NO_VERSION` | No version covers the date or scope (for example a 9% VAT category). |
| `BEYOND_HORIZON` | The open-ended version is reviewed only to an earlier date (VAT rates: 2026-12-31). |
| `INSUFFICIENT_REVIEW` | The version's review status is below what the company's mode requires. |

The company's `books.assurance` fact selects the mode:
- `preview`, the default, accepts unreviewed (`extracted`) rules;
- `shadow` requires interpreted rules;
- `live` requires signed rules.

Every current parameter is `extracted`. Each proposal lists the parameter versions it used and their status.

Each version cites clauses from the source register (`xfactura-core/src/ro/sources`). A source is an act or an official document with the hashes of the copies read. A clause is `located` when its text was read in such a copy, and `pending` when only its place in the act is known; neither is a review. `bun run sources:fetch` fetches the sources that allow it into `.sources/` and reports drift from the registered hashes; acts on sites that refuse automated access are provided by hand in `.sources/inbox/`. `rules.parameters` lists every value with its citations, and `rules.horizon` the values whose reviewed period ends within a number of days.

Accounting policies the law requires in writing are dated company facts with their evidence. `policy.storno` (red or black) decides a reversal whose method is not given; without either, the reversal is blocked. `policy.payroll.employer_share` (635 or 6458) is where contributions borne in an employee's name are expensed; a payroll that needs it is blocked without it.

The chart is OMFP 1802/2014 as published, plus the accounts later orders added, each with the clause that adds it: 4315, 4316, 436 and 646 from OMFP 1243/2018, used from 2018.

## Implemented treatments

### `ledger.general`: explicit journal entry

- **Input:** date, purpose (`opening`, `general`, `adjustment`), reference, description, evidence, and 2–2000 lines (account, side, amount, optional currency amount and rate, partner, open item or new open item, cost centre, project, memo).
- **Openings** must be dated on the first day of a financial year. The trial balance reports them as initial balance.
- **Open items:**
  - A line on an open-item control account (4111, 401, 408, 418, 419, 4092, 421, 4311–4314, 4423, 4424, 444, 457, 461, 462, 471, 472, …) must settle an existing open item or create one for a partner.
  - Other lines may not name an open item.
  - Analytical accounts inherit their synthetic parent's control.
- **VAT accounts** (4426, 4427, 4428) cannot be posted by a general entry; the line needs tax entries from a VAT treatment.
- **Subject:** `opening:<date>` or `journal:<purpose>:<reference>`.

### `ledger.reverse`: full storno

- Reverses a posted entry in full, red (same sides, negative amounts) or black (swapped sides). It needs a reason of at least 10 characters and evidence.
- Tax entries are mirrored in the reversal's own tax period and linked to their origin.
- A reversal that would push a settled open item past zero is refused.

### `invoices.recognize`: domestic service invoice

- **Document:** an imported invoice (380) issued or received by the company.
- **Input:** a revenue (70x) or expense (6xx) account; for purchases, deduction `full` or `none`; optionally the service date.
- **Supported:** one VAT category and rate on every line; category S at the register's rate for the tax point (`taxPointDate`, else issue date), or category O.
  - The company's `vat.status` on the tax-point date must be recorded.
  - A VAT payer's sale must use S; a non-payer's sale must use O.
  - A non-payer cannot deduct: a purchase with VAT books it into the expense and records a non-deductible tax entry.
- **Postings:**

  | Case | Lines |
  |---|---|
  | Sale | Dr 4111 gross / Cr revenue net / Cr 4427 VAT |
  | Purchase, deductible | Dr expense net / Dr 4426 VAT / Cr 401 gross |
  | Purchase, non-deductible | Dr expense gross / Cr 401 gross |

  The receivable or payable is an open item of the counterparty, linked to the document.
- **Foreign currency:**
  - The document must state its VAT in lei (BT-6 = RON, BT-111).
  - Revenue or expense converts at the accounting rate on the issue date. VAT in lei is the stated BT-111 amount, and a difference from the BNR VAT rate is an `ack` warning.
  - Every line records its currency amount and rate, and the open item is held in the document currency.
- **Refused:** several VAT categories or rates, other categories (AE, E, K, Z, …), prepaid amounts (advances), payable rounding and missing rates.
- **Warned (`ack`):** a service date in another month than the tax point, which may need a regularization.

### `invoices.credit`: credit note against the original

- **Document:** an imported credit note (381, or a negative 380 normalized by the parser).
- **Input:** the original document, the account it used and the deduction.
- **Rules:**
  - The credit note must reference the original's number and keep its VAT category and rate.
  - Amounts reverse the original accounts by red storno, in the credit note's own tax period, and reduce the original open item.
  - Crediting more than remains open is refused.
- **Not supported:** foreign-currency credit notes.

### `bank.settle`: explanation of a bank movement

- **Input:** the movement, allocations to open items (amount in the movement currency) and lines to accounts without partners (fees 627, interest, own transfers 581, …).
- **Rules:**
  - The explained total must equal the movement exactly.
  - Allocations must be in the open item's currency.
  - Partner accounts are settled only through open items.
- **Foreign currency:**
  - The bank line converts at the booking-date accounting rate.
  - Each allocation releases the item's RON carrying amount in proportion to the currency settled; settling the full balance releases all of it.
  - The difference is a realized exchange gain (7651) or loss (6651).
  - Paying a foreign-currency item from a RON account is not supported.

### `invoices.crossBorder`: services across the border

- **Document:** an imported invoice (not a credit note) whose counterparty is established abroad; for an EU customer, with a VAT code of its state (the general rule applies between businesses).
- **Input:** the account, `supply: services_general_rule` (services taxed where the customer is established, Cod fiscal art. 278 alin. (2); the exceptions and goods are other treatments), the deduction for purchases, and optionally the tax point when the service was provided.
- **Purchase:** expense and payable at the accounting rate; Romanian VAT self-assessed at the standard rate on the base at the BNR rate for VAT, collected (4427) and deducted (4426) at once, or added to the expense without deduction. Tax entries `RC-EU-SERV` or `RC-NONEU-SERV`, in both directions.
- **Sale:** receivable and revenue, no Romanian VAT; tax entry `EXP-EU-SERV` or `EXP-NONEU-SERV` with the base only.
- **Refused:** a domestic partner, an invoice that already charges VAT, an EU customer without a VAT code.
- **Open for review:** which e-Factura VAT category a Romanian supplier uses for services sold to EU businesses (ANAF's guide reserves AE for art. 331); the tax point of continuous services.

### `vat.settle`: VAT settlement of a period

- **Input:** the VAT period (a month, or a quarter for quarterly payers), the posting date on or after the period's end, the tax authority as a partner (a public institution), the return or worksheet as evidence, and a round number.
- **Effect:** clears what the period's tax entries booked on 4427 (output) and 4426 (deductible input), net of earlier rounds, with settlement lines; the difference is VAT payable (4423) or recoverable (4424), an open item of the authority. VAT not yet exigible (4428) stays.
- **Reads** the whole tax period as one read-set entry (its tax entries, settlement lines and last sequence). An entry reaching the period after approval makes the settlement stale, in the application and in the database. A later round settles only what arrived after the first.
- **Carried forward:** with `offsetCarried`, VAT to recover from earlier periods (open 4424 items of the authority, oldest first) is offset against this period's payable, as the return carries it. A refund is received through the bank, settling the 4424 item.
- **Refused:** a period of the wrong kind for the company's `vat.period`, a date before the period ends, a period with nothing to settle.

### `payroll.recognize`: a month's payroll

- **Input:** a prepared payroll run, its month and round, and the tax authority as a partner.
- **Effect:** salaries in money owed to each employee (641 = 421, an open item per contract under the employee's party); CAS, CASS and tax withheld from them (421 = 4315, 4316, 444); contributions the company bears in an employee's name (the part-time minimum) on the account of `policy.payroll.employer_share`; CAM (646 = 436). The contributions and the tax are open items of the authority. Meal vouchers are taxed by the run and booked when handed over.
- **Reads** the run as one read-set entry (its result hash and state): a run computed again after approval makes the posting stale, in the application and in the database.
- **Refused:** a run with unresolved problems or superseded, a company not recorded as an employer, union dues (the union is not modelled yet), and a run needing the employer-share policy without it. One posting per month; a posted month cannot be computed again until corrections are supported.

### `fx.revalue`: month-end revaluation

- **Input:** a month-end date and a round number (a later round re-revalues after further entries).
- Revalues monetary items (receivables, payables, accruals, unapplied cash) and foreign bank or cash balances at the selected rate. Each difference is booked on the item or account with a zero currency amount, against 7651 or 6651.
- Advances and deferrals are not monetary and are not revalued.

## Issuing invoices

The company's own invoices are issued through the books, so the number, the XML and the recognition come from one command.

- **Details.** The company's invoicing details (`sales.seller.record`, owners only) must carry its CUI; a partner's details (`parties.recordDetails`) must match the identifier it was created with. Both are dated versions, and each issued invoice records the versions it used.
- **Series.** `sales.series.create` fixes a code, a prefix, a counter width, the first number, the document types (380, 381) and the default revenue account. Numbers are the prefix and the padded counter, for example `XF0001`.
- **Issue.** `sales.issue` is human-only. It takes the next number at the moment of issue, writes the e-Factura with the core writer, keeps the XML as evidence and the document as an issued sale, then proposes its recognition (`invoices.recognize`, or `invoices.credit` for a credit note). A posting policy can post that recognition at once. A refusal after issue leaves the invoice issued and reports why.
- **Refusals.** `sales.preview` shows the number and every problem without issuing. An issue is refused, with no number used, when:
  - a party's details are missing;
  - the buyer is an individual (the B2C identification rules are not sourced yet);
  - the company's VAT status on the tax point is unknown or contradicts its details;
  - a standard-rated line is not at the rate the register gives for the tax point (reduced rates are not in the register yet), or the rate is a rule gap (for example after 2026-12-31);
  - the invoice fails the e-Factura checks (Romanian county and Bucharest sector, lei VAT for foreign currency, the corrected invoice of a credit note);
  - the date is earlier than the series' last issue, or the number already appears on a sales document, imported or issued.
- **Database guards.** Numbers in a series are consecutive from the first number, never go back in date, match the document's type, number and date, are never reused across sales documents, and cite recorded party details.

## Importing the invoicer's history

`invoices.importInvoicer` reads the browser invoicer's JSON export (adapter `xfactura-web-export-1`), kept as evidence, and gives every record one outcome:

| Outcome | Meaning |
|---|---|
| `imported` | A sales document now exists, known only from the export. |
| `duplicate` | The same content as an imported record with the same number. |
| `conflict` | Records share a number but differ; none of them is imported. |
| `invalid` | The record cannot be an e-Factura (for example a Bucharest address without its sector). |
| `not_seller` | The company is not the seller. |
| `existing` | An earlier import already holds the record; importing again adds nothing. |

Documents are what the export states, converted as the invoicer now writes them; the export, not regenerated XML, is their evidence. The SPV archives are the authority on what was issued: syncing the inbox confirms or contradicts each document (`spv.messages`). Individuals are recorded by a hash of their CNP, without invoicing details.

## Payroll

Payroll data is personal: employees' CNPs are encrypted at rest (AES-256-GCM under a key derived from the server secret, bound to the company) and never returned by a view; an employee's party uses the CNP's hash as its identity, the same as a buyer who is this person. Payroll operations are not open to agents.

- `payroll.employees.record` records an employee (name, CNP; the birth date comes from the CNP).
- `payroll.contracts.record` records a contract's terms, or a new version of them from a date: base salary, daily hours, main job (funcția de bază), COR code, dependents, children in school, union dues, and the reason the part-time minimum does not apply.
- `payroll.runs.prepare` computes a month from the contracts in force and what differs this month (active days, the month's amounts, the 26th-birthday decision), given the month's working days. A contract that starts, ends or changes during the month needs its days and amounts; the run keeps every line with its inputs, the calculation's steps and their clauses, or the problems that stopped it. Computing the month again supersedes the earlier run.

The calculation (`xfactura-core/src/ro/payroll`) follows the Fiscal Code articles it cites, read in ANAF's consolidated text:
- CAS 25% on salary in money, CASS 10% also on meal and holiday vouchers, tax 10% on the net income less the personal deduction and union dues at the main job, CAM 2.25% on salary in money;
- the personal deduction by the table of art. 77 (percentages of the minimum wage by 50-lei bands up to 2,000 lei above it and by dependents), 15% of the minimum wage under 26, 100 lei per child in school, limited to the net income and not reduced for part time;
- CAS and CASS at least on the minimum wage for the contract's active working days, the difference borne by the employer, except in the cases of art. 146 alin. (5^7);
- the tax base rounded to whole lei with 50 bani and less dropped (the methodological norms), contributions and tax half up (the procedure code's rule, pending its text).

The minimum wage (4,050 lei until June 2026, 4,325 lei from July 2026) and the minimum-wage relief (300 lei up to 4,300 lei gross until June 2026, 200 lei up to 4,600 lei from July) cite acts not yet obtained (HG 1506/2024, HG 146/2026, OUG 89/2025): they are known from published reports, listed by `unsourced`, and the relief is applied only where it is unambiguous (a full month of a full-time main-job contract at the minimum wage); otherwise the line is stopped. The Fiscal Code values apply from 2026-01-01, the snapshot's date; earlier months are a rule gap. Leave pay, sick leave, benefits in kind, and D112 are not built yet.

## Declarations

Tax returns are artifacts of the books:

1. `declarations.prepare` reads what the return is computed from (for example the VAT tax period) and writes its XML in ANAF's format for the reporting period. A period with no pinned format is a `FORMAT_GAP`. The XML is kept as evidence with the hash of the inputs read.
2. ANAF's own validator (DUKIntegrator with the declaration's package, pinned by `bun run validators:fetch`) runs on the exact XML: `validated_official`, or `validation_failed` with ANAF's messages.
3. `declarations.authorize.request` is a reviewed action on the exact XML. Its preview recomputes the inputs; if the books changed since preparation, or the return is not validated, it blocks. Executing it locks the tax period: from then on, an entry adding tax to that period is refused, by the proposal and by the database.
4. `declarations.pdf` produces ANAF's PDF from the authorized XML, with the XML attached.
5. `declarations.importSigned` takes the PDF the company signed. It must carry, as an attachment, exactly the authorized XML (by hash) and a signature; the signature itself is verified by ANAF when the return is filed.
6. `declarations.recordSubmission` (human only) records the filing with ANAF's registration number from the receipt, and `declarations.recordOutcome` ANAF's acceptance or rejection with the message received.

To correct a filed period, `declarations.reopen.request` is a reviewed action that unlocks it in the name of the return that locked it. Corrections are then posted, and the rectification is prepared with `supersedesId`, which marks the earlier return superseded. A return can be superseded before it is submitted or once ANAF has answered, not while an answer is pending.

**D300 (VAT return)** is the first kind. It is written by `xfactura-core/src/ro/declarations/d300.ts` from ANAF's structure 12.0.0, in namespace `v11` for 08–12/2025 and `v12` from 01/2026, and computes the totals, the settlement rows, the control sum and the payment evidence number as ANAF's validator does. From the books:
- collected VAT goes by rate to rows 9 (21%) and 10 (11%), and 9.1 (19%) for 2025 periods;
- services bought from abroad with reverse charge go to row 7, and also to its subset 7.1 when the supplier is in the EU; the return repeats them as deductible on rows 20 and 20.1;
- services supplied abroad go to row 3, and to 3.1 when the customer is in the EU;
- purchases go by rate to rows 24 and 25 (24.1 for 2025) with all their VAT, and row 31 holds the VAT actually deducted. Whether non-deductible purchases belong on rows 24–25 is an interpretation awaiting the expert's review;
- every row is rounded to whole lei by the cited rule `ro.declaration.rounding` (half up at 50 bani);
- the header comes from the company's invoicing details and the options given when preparing (declarant, CAEN, bank account; pro-rata 100 as the printed form pre-fills it, unless given);
- the previous period's return in the engine supplies the negative balance carried forward (rd. 41) unless it requested a refund, and becomes an input: replacing it makes this return stale. For the first period kept in the engine, the previous balances are given explicitly (`previous`), and the payable still unpaid at filing (rd. 38) is always given, since payments are not yet matched to returns. A refund is requested only for a negative balance of at least 5,000 lei.

Operations without a row yet (goods across the border, domestic reverse charge, exemptions, imports) block the return rather than being left out. Monthly returns are type L and quarterly ones type T; semiannual and annual returns are not produced.

**D390 (VIES recapitulative statement)** lists a month's intra-Community operations by partner, from ANAF's structure "D390 XML 2020" (namespace v3): services supplied to EU businesses as type P and services acquired from EU suppliers as type S, each partner's bases summed and rounded to whole lei. It is monthly even for quarterly VAT payers, reads the month's entries by their tax point, and is informative: authorizing it locks no tax ledger. ANAF's validator checks every partner's VAT code against its country's algorithm. Goods (L, T, A, R) are not produced yet.

**D394 (domestic supplies and acquisitions)** has its writer in `xfactura-core/src/ro/declarations/d394.ts`, from ANAF's structure of 15.09.2025 (namespace v5, periods from 08/2025), checked against ANAF's validator: partners by type and rate, individuals one record each, the summaries, invoice series and the control sum. Preparing it from the books is next.

Steps are recorded in order, and the database allows only the documented transitions; a tax period is locked only in the name of an authorized return of that tax and period. A rectification is a new return that supersedes the earlier one.

## e-Factura through the SPV

The engine talks to ANAF through an e-Factura port (upload, status, message list, download). Only a deterministic simulator implements it so far; the live client, with its OAuth authorization, is not built.

- **Submission.** `spv.submit` is human-only and sends an issued document's kept XML. Its steps are recorded in order, and `submitting` is written before the request leaves:

  | Step | Next |
  |---|---|
  | `authorized` | `submitting` |
  | `submitting` | `submitted` (with ANAF's upload index) or `uncertain` (no answer) |
  | `submitted` | `accepted` or `rejected` (with the message), from `spv.refresh` or the inbox |
  | `uncertain` | `accepted` or `rejected` when the inbox shows the upload, or `absent` |

- **Never resent.** Moving to `submitting` is a single claim, so a retried or concurrent request sends nothing. While a document's submission is neither rejected nor absent, the database refuses another. An uncertain upload becomes `absent` only when the synced windows cover it from one minute before it to three days after (ANAF's processing horizon is still to be sourced); a person may then authorize it again. An attempt interrupted in `submitting` for ten minutes becomes `uncertain`.
- **Inbox.** `spv.sync` lists a window of at most 60 days, ending no later than now, page by page, and records each message once by its ANAF identifier. Every archive is kept as evidence and read with bounds on size, expansion and paths:

  | Message | What it becomes |
  |---|---|
  | Received invoice | A purchase document, imported like an uploaded XML. |
  | Sent invoice | The end of a pending submission (matched by content or upload index); otherwise a check of the sale with the same number and date (`matched` or `differs`, with the differing fields), or a new sale known from the SPV. |
  | Error report | The rejection of a pending submission, with ANAF's messages. |
  | Buyer message | Recorded. |

  The Ministry's signature in each archive is kept but not verified yet. An archive downloaded from the SPV website is read the same way with `spv.importArchive`: its direction comes from the invoice, and it adds nothing to the synced coverage.
- **Coverage.** Once a company has synced, a month closes only when its synced windows cover the whole month (Europe/Bucharest). Submissions of the month without a final answer raise a warning.

## Treasury and statements

- A bank or cash account maps to a ledger account: 5121 or 5311 for lei, 5124 or 5314 for foreign currency.
- MT940 and camt.053 (versions 02 and 08) statements import if:
  - each balances (opening plus entries equals closing);
  - its currency matches the account;
  - its dates fall in the selected financial year.
- Each reported movement is kept once per account by its bank identity; a repeat with a different amount or date is refused. Re-importing a file adds nothing.

## Month close

Closing is a reviewed action: `periods.close.request`, then `actions.approve` on the exact preview hash, then `actions.execute`. Execution re-runs the preview and requires it to be unchanged. The preview lists every finding:

| Finding | Severity |
|---|---|
| Month already closed, or an earlier month with entries still open | block |
| Unposted, unwithdrawn proposals dated in the month | block |
| Unexplained bank movements booked in the month | block |
| Ledger balance different from a statement's closing balance, or a statement that does not continue the previous one | block |
| Foreign-currency monetary balances not revalued at month end | warn |

A close records closing balances per account and currency and joins a hash chain of period events. Reopening is reviewed the same way and requires later months to be reopened first.

## Reports

- `ledger.trialBalance`: balanța de verificare for a financial year or interval. It shows initial balance, previous and current turnover, total sums and final balance per account.
- `ledger.journal`: Registrul-jurnal in recording order.
- `vat.journal`: sales or purchase VAT journal per tax period, with totals per VAT code. These are working registers, not declarations. The tax period is the month, or the quarter (`2026-Q4`) when the company's `vat.period` fact says quarterly; a reversal is reported in its own period and records the period it corrects (`correctsTaxPeriod`).
- `openItems.list`: open receivables, payables and other items with their balances.

## Exports, backup and restore

- `exports.request` needs review permission, or an agent scope for it. The worker rechecks authority when it builds and when it stores the file.
- An export contains every company record and every original file, up to 64 MB of originals. A test fails if a guarded company table is missing from it. Downloads are rechecked on every request.
- `bun run backup <dir>` takes a consistent SQLite snapshot plus the referenced objects. `bun run restore <backup> <dir>` verifies checksums, integrity and foreign keys before activating.

## Not implemented

- **Removed in the kernel switchover, to be rebuilt as treatments:**
  - deferred revenue and expense schedules (471/472);
  - advances (4092/419);
  - purchase accruals (408);
  - unbilled sales (418);
  - invoice-level allowances and charges as separate treatments;
  - CSV bank statements.
- **Not built yet:**
  - the live ANAF client and its OAuth authorization, and verification of the Ministry's signature; reduced VAT rates in the register; B2C identification;
  - VAT categories other than S/O, TVA la încasare, domestic reverse charge, goods across the border, pro-rata; D394 from the books, e-TVA;
  - payroll beyond salary in money and vouchers (leave pay, sick leave, benefits in kind, union dues), corrections of a posted month, and D112;
  - fixed assets;
  - stock;
  - micro and profit tax;
  - year-end close;
  - statutory register layouts and official filings.

[ROADMAP.md](ROADMAP.md) orders this work.
