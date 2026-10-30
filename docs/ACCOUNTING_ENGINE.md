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

### `invoices.recognize`: domestic invoice

- **Document:** an imported invoice (380) issued or received by the company.
- **Input:**
  - **One account** for every line: a revenue (70x) or expense (6xx) account, or for a purchase a fixed-asset account (20x, 21x), whose supplier is then held on 404. For purchases, the deduction is `full` or `none`.
  - **Or `allocations`:** each VAT category's taxable amount (`S-21`, `S-11`, `O`) split over accounts in the document's currency, each part with its own deduction. A category's parts must add up to its amount; allowances and charges are inside it.
  - **Deduction:** `full`, `none`, or `limited`.
    - `limited` deducts the register's share (`ro.vat.deduction.limited`, 50%) of a part's VAT. This applies to vehicles not used exclusively for the business and their expenses (Codul fiscal art. 298); trucks above 3.5 t or 9 seats, couriers, sales agents, taxis, rentals and the other exceptions of alin. (2)–(3) deduct in full.
    - The share is rounded half up to the ban. The rest of the VAT stays in the expense, and D300 rd. 31 holds only what was deducted.
    - Which invoices concern such vehicles is the company's choice; the engine doesn't guess.
  - **Advances:**
    - An advance invoice puts its part on 419 (received from a customer) or 4091/4092 (paid to a supplier), opening an advance of the partner.
    - The final invoice's negative line deducting the advance goes to the same account and names the advance it settles (`advance`). The negative line is in the advance's VAT category, as e-Factura writes it, so the VAT follows.
    - Only advance parts may be negative.
    - An advance can't be settled beyond what it holds (`OPEN_ITEM_REVERSED`).
    - Purchase advances are deductible in full.
    - Advances in foreign currency are not settled yet.
  - Optionally the service date.
  - **Supplier status:**
    - For a purchase from a Romanian supplier, the treatment reads the supplier's ANAF status snapshot for the invoice's tax point.
    - If the snapshot shows the supplier inactive, no part may deduct VAT (`SUPPLIER_INACTIVE`, Codul fiscal art. 11 alin. (7)). The input `inactiveException` (`forced_execution`, `bankruptcy`) allows deduction behind an acknowledgement.
    - Without a snapshot, nothing is refused, but the month's close warns (`SUPPLIER_STATUS_UNCHECKED`).
    - Snapshots come from `parties.checkStatus`. It calls ANAF's public taxpayer-status service (`PlatitorTvaRest` v9: at most 100 CUIs per request, 1 request per second), keeps the raw answer as evidence, and records one snapshot per party and date in the append-only `acc_party_status`.
    - The snapshot read is for exactly the date asked. A newer snapshot for that date makes a pending proposal stale.
    - Not covered yet: purchases already posted when a later snapshot shows the supplier inactive, advance invoices from an inactive supplier, and purchases through cash expense reports or the general journal.
- **Supported:** the categories of the document's VAT breakdown, each S at the register's standard rate for the tax point (`taxPointDate`, else issue date) or at its reduced rate, or O. The reduced rate applies only to the supplies of Codul fiscal art. 291 alin. (2), so it is an `ack` warning (`REDUCED_RATE`): the reviewer confirms the operation qualifies.
  - The company's `vat.status` on the tax-point date must be recorded.
  - A VAT payer's sale must use S; a non-payer's sale must use O.
  - A non-payer cannot deduct: a purchase with VAT books it into the expense and records a non-deductible tax entry.
- **Postings:**

  | Case | Lines |
  |---|---|
  | Sale | Dr 4111 gross / Cr revenue net / Cr 4427 VAT |
  | Purchase, deductible | Dr expense net / Dr 4426 VAT / Cr 401 gross |
  | Purchase, non-deductible | Dr expense gross / Cr 401 gross |

  - There is one line per part, one VAT line per category, and one tax entry per category (key `vat`, or `vat:S-21` and so on when there are several).
  - A non-deductible part takes its share of its category's VAT.
  - In foreign currency, the document's totals in lei are split in proportion to its own amounts, so the totals stay exact.
  - The receivable or payable is an open item of the counterparty, linked to the document.
- **Foreign currency:**
  - The document must state its VAT in lei (BT-6 = RON, BT-111).
  - Revenue or expense converts at the accounting rate on the issue date. VAT in lei is the stated BT-111 amount, and a difference from the BNR VAT rate is an `ack` warning.
  - Every line records its currency amount and rate, and the open item is held in the document currency.
- **Refused:** allocations that don't cover each category exactly, fixed assets and expenses on one invoice (404 and 401), other categories (AE, E, K, Z, …), prepaid amounts (advances), payable rounding and missing rates.
- **Warned (`ack`):** a service date in another month than the tax point, which may need a regularization.

### `invoices.credit`: credit note against the original

- **Document:** an imported credit note (381, or a negative 380 normalized by the parser).
- **Input:** the original document, and the account it used with the deduction, or `allocations` splitting each VAT category over the original's accounts (positive amounts in lei, each part with its deduction).
- **Rules:**
  - The credit note must reference the original's number. Each of its VAT categories must be one of the original's, at the rates in force on the original's tax point.
  - Each category's tax entry points to the original's entry of the same category.
  - Amounts reverse the original accounts by red storno, in the credit note's own tax period, and reduce the original open item.
  - Crediting more than remains open is refused.
- **Not supported:** foreign-currency credit notes.

### `bank.settle`: explanation of a bank movement

- **Input:**
  - the movement;
  - allocations to open items (amount in the movement currency);
  - lines to accounts without partners (fees 627, interest, own transfers 581, …);
  - new items of a person in lei (`opens`): an advance paid on 542 or another debtor (461) by a payment; an associate's money on 4551 or another creditor (462) by a receipt.
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
- **Paid** through `bank.settle`: the net salary settles the employee's 421 item, and one transfer to ANAF can settle the 4315, 4316, 444 and 436 items together.
- **Refused:** a run with unresolved problems or superseded, a company not recorded as an employer, union dues (the union is not modelled yet), and a run needing the employer-share policy without it. One posting per month; a posted month cannot be computed again until corrections are supported.

### `tax.micro`: micro-enterprise tax of a quarter

- **Input:** the quarter, a posting date on or after its end, the tax authority as a partner, a round, and determinations for accounts whose revenue the law excludes only in some cases.
- **Base** (Codul fiscal art. 53, read in ANAF's consolidated text): the quarter's revenues of any source (class 7, net of corrections and of 709), less those excluded by their nature (711, 712, 721, 722, 725, 741x, 7584 and FX gains 765), less what the determinations exclude, plus commercial discounts received (609) and, in the fourth quarter, the year's net favorable FX difference (765 less 665). Revenues on 781x, 786x, 7581, 7588, 768, 761x and 762 need a determination, with its evidence and the letter of art. 53 alin. (1) that applies, before the tax is computed. The base is rounded to whole lei and taxed at `ro.micro.rate` (1%).
- **Effect:** Dr 698 / Cr 4418, an open item of the authority.
- **Refused:** a company not recorded as micro (`income_tax`), a year's turnover (70x) above `ro.micro.revenue_limit_eur` (100,000 euro from 2026) at the BNR rate of the previous year's end, which makes the company owe profit tax from that quarter, a missing rate, and a zero tax. The reviewer acknowledges each quarter that the company had a full-time-equivalent employee (art. 47 alin. (1) lit. g)).
- **Reads** the quarter's and the year's turnover of classes 6 and 7: an entry posted in either range after approval makes the posting stale. Year-end closing entries, when built, will have to be left out of these reads.

### `dividends.distribute` and `dividends.withhold`: dividends

- **Distribution:** the shareholders' decision as evidence, its date, and each shareholder's gross dividend. Dr 1171 / Cr 457, an open item owed to each shareholder. The total may not exceed the retained profit on 1171 at the decision date. Interim dividends are not supported (their account, 463, is not in the chart yet).
- **Withholding,** when a dividend is paid (or on the year's last day for dividends distributed and still unpaid, art. 43 alin. (3)): the gross paid, the distribution it comes from, and the tax authority. Dr 457 / Cr 446, owed to the authority, at `ro.dividend.tax_rate` for the distribution date: 16% for individuals (art. 97 alin. (7)) and for Romanian companies (art. 43), from 2026. The net is then paid through `bank.settle` against the same 457 item.
- **Refused:** paying more than is owed or before the decision, and non-resident shareholders. For a company shareholder, the reviewer confirms that the exemption of art. 43 alin. (4) does not apply; an exempt dividend is paid gross with nothing withheld.

### `assets.depreciate`: a month's depreciation

- **Register:** `assets.register` records a fixed asset's card: inventory number, the catalogue code (HG 2139/2004, a text still to obtain), its account (20x, 21x), depreciation (28x) and expense (68x) accounts, entry value, accounting and fiscal lives in months, commissioning date with its record, and the purchase invoice. `assets.list` shows each with the depreciation booked and the value remaining.
- **Effect:** for the month, straight-line depreciation of every asset commissioned in an earlier month (OMFP 1802/2014 pct. 238): Dr 68x / Cr 28x, each asset's line carrying it as its item, so the ledger holds its accumulated depreciation. The monthly parts are rounded so they add up, and the last month reaches the full value.
- **Refused:** a month in which an asset's booked depreciation is not that of the months before (a month missed or booked twice), and a month with nothing to depreciate.
- **Disposal:** `assets.dispose` records that an asset left use, with its record; `assets.derecognize` then takes it off the books (Dr 28x depreciation booked, Dr 6583 the value not recovered / Cr its account). Whether the disposal month is depreciated is the company's policy `policy.assets.disposal_month` (included or excluded); without it, depreciation and derecognition of that asset stop. A sale is invoiced separately.
- Fiscal depreciation (art. 28), revaluation and impairment are not built yet.

### RO e-TVA

`vat.etva.check` compares the period's latest VAT return with the pre-filled return RO e-TVA (P300), row by row: a row differs significantly at both 20% and 1,000 lei (`ro.etva.significance`, OUG 70/2024 art. 5, still in force after OUG 89/2025), on its VAT, or its value where it has none, leaving out regularization rows. Which amount the 20% is taken of the ordinance does not say; the pre-filled one is this engine's reading. The pre-filled amounts are given by hand from the P300 until a P300 file can be read (its format is not published). It also lists the e-Factura invoices of the period that are not in its VAT ledger, and the invoices in the ledger that did not come through e-Factura.

### Year-end: `year.closeResult`, `year.legalReserve`, `year.transferResult`

- **Closing:** on the financial year's last day, every expense (6xx) and revenue (7xx) account is brought to zero against 121 in the closing journal (INCHIDERE), so the next year opens without them; the ledger is continuous, and every other balance carries over. A year's result is closed once; modified financial years are not supported yet.
- **Legal reserve:** on the same day, Dr 129 / Cr 1061 for the amount the company sets aside. Legea 31/1990 art. 183 asks for at least 5% of the profit each year until the reserve reaches a fifth of the share capital (1012), without saying whether before or after income tax: an amount below 5% of the result in 121, while under the cap, asks the reviewer to confirm.
- **Transfer:** once the shareholders approve the financial statements, the allocations already made (129) are cleared against 121 and the rest of the result goes to retained earnings (1171), from which `dividends.distribute` pays; a loss is carried there too.
- **Registers** (OMFP 2634/2015 pct. 44–47): `ledger.journal` (Registrul-jurnal) gives every entry in recording order with its justifying document's type, number and date; `ledger.generalLedger` (Cartea mare) gives, for a month, each synthetic account's opening balance, debit and credit turnover by corresponding account (`%` lists several) and closing balance; `ledger.inventoryRegister` (Registrul-inventar) gives, at a date, every asset, liability and equity account with a balance and what makes it up (open items by partner, fixed assets by inventory number), at the books' value until inventory differences are recorded.
- **Annual statements (microentities, S1005 for 2025):** the core writer produces the balance sheet (F10), the profit and loss account (F20), the informative data (F30) and the fixed-asset statement (F40), and checks the form's controls, ANAF's validator's codes included. The chart maps to F10, F20 and F30 chapter XIX by the formulas of ANAF's form and OMF 2036/2025 anexa 4. Where the form, ANAF's structure and the order differ, the choice is recorded with the formula. Only 2025 is supported; other years are a gap until ANAF publishes their package.
  - **From the books** (declaration `S1005`, period `2025`):
    - F10 is read from the closing balances, kept per partner on the accounts held on open items, so the forms' debit and credit balances are the analytic ones.
    - F20 and F30 chapter XIX are read from the year's turnover of classes 6 and 7, without the closing journal. Classes 6 and 7 still open, an unmapped balance (VAT accounts left unsettled, for example) or a 121 that differs from the result are problems.
    - The previous year's column comes from the engine's previous year when it keeps one. Otherwise its balance sheet comes from the opening entries, and the preparer gives its F20 and F30 chapter XIX rows as filed.
    - From the preparer: the identification the books don't hold, and the row of each account the form spreads over several rows (debts due within a year or later). A balance belonging to several rows is kept on analytic accounts.
    - F40 (fixed assets) is read from the same balances as F10, so it ties to F10 to the leu, plus the year's movements: increases are the debits of the fixed-asset accounts, reductions their credits, and the same for depreciation and impairment, as OMF 2036/2025 defines the columns.
      - Each row takes the accounts the order's detailed balance sheet gives the same category (for example 213 + 223, and 214 + 224).
      - The part of a reduction that was scrapping is given by the preparer.
      - 267 and the accounts the microentities' balance sheet doesn't list are problems.
    - Still given rather than read: F20 rd. 01a and F30's other chapters.
- Not built yet: the physical inventory and its differences, provisions, and the statements of small and larger entities.

### `deferrals.defer` and `deferrals.release`: amounts for later months (471, 472)

- **`deferrals.defer`** moves an expense (6xx) or revenue (70x) already booked, such as a yearly subscription or insurance, to 471 or 472.
  - The amount becomes an open item of the partner, with a schedule of equal monthly releases over `months` from the month `from`; the remainder goes to the first months.
  - Its evidence shows the period covered. Releases start in the deferral's month or later.
  - Lines: Dr 471 / Cr expense, or Dr revenue / Cr 472.
- **`deferrals.release`** books a month's share on its last day, back to the account the amount came from.
  - It releases what each open deferral's schedule has due by then, less what was already released (the schedule's total less the item's balance). A missed month is caught up, and nothing is released twice.
  - With nothing due, it is refused (`NOTHING_TO_RELEASE`). A month with a release due does not close.
- Schedules are read with their open items (an open-item query with `schedules`). They never change, so the item's version covers them.

### `accruals.record` and `accruals.settle`: invoices not yet received or issued (408, 418)

- **`accruals.record`** books a service in its month before its invoice: received from a supplier (Dr expense / Cr 408) or rendered to a customer (Dr 418 / Cr revenue).
  - The amount is net of VAT and is an open item of the partner, justified by a contract, report or timesheet.
  - The accrual keeps the account it was booked on as a one-row schedule.
- **`accruals.settle`** reverses the accrual on the invoice's day, once the invoice is booked. The invoice must be the same partner's, and the open balance is reversed in full. The difference between the invoice and the estimate falls in the invoice's month.
- **VAT:** it comes from the invoice, at the invoice's tax point. Putting VAT not yet chargeable on 4428 at the accrual is a policy the engine doesn't apply. Whether the reversal method suits the company is for the expert accountant to confirm.

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
  - a standard-rated line is at neither the standard nor the reduced rate the register gives for the tax point, a reduced-rate line has no `reducedRateBasis` (the supply of art. 291 alin. (2) it is, kept with the issue), or the rate is a rule gap (for example after 2026-12-31);
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
- `payroll.runs.prepare` computes a month from the contracts in force and what differs this month (active days, the month's amounts, leave days, the 26th-birthday decision). The month's working days are the weekdays less the public holidays of Codul muncii art. 139 (Easter, Good Friday and Pentecost by the Orthodox calendar), unless given. A contract that starts, ends or changes during the month needs its days and amounts; the run keeps every line with its inputs, the calculation's steps and their clauses, or the problems that stopped it. Computing the month again supersedes the earlier run.

The calculation (`xfactura-core/src/ro/payroll`) follows the Fiscal Code articles it cites, read in ANAF's consolidated text:
- CAS 25% on salary in money, CASS 10% also on meal and holiday vouchers, tax 10% on the net income less the personal deduction and union dues at the main job, CAM 2.25% on salary in money;
- the personal deduction, in whole lei as D112 declares it, by the table of art. 77 (percentages of the minimum wage by 50-lei bands up to 2,000 lei above it and by dependents), 15% of the minimum wage under 26, 100 lei per child in school, limited to the net income and not reduced for part time;
- CAS and CASS at least on the minimum wage less the minimum-wage relief, for the contract's active working days and in whole lei, as ANAF's D112 structure computes the limit (4,325 − 200 lei from July 2026), the difference borne by the employer, except in the cases of art. 146 alin. (5^7);
- the tax base rounded to whole lei with 50 bani and less dropped (the methodological norms), contributions and tax half up (the procedure code's rule, pending its text).

The minimum wage is 4,050 lei from 2025 (HG 1506/2024 art. 1) and 4,325 lei from July 2026 (HG 146/2026 art. 1). The minimum-wage relief (OUG 156/2024 art. LXVI for 2025, OUG 89/2025 art. III for 2026) leaves 300 lei a month (200 lei from July 2026) out of every base for a full-time contract at the main job whose base salary is the minimum wage, not lowered since the ordinance, with salary in money (vouchers excluded) up to 4,300 lei (4,600 lei from July 2026). For part of a month the ordinance lists what reduces the amount but not how, so such a month is stopped for the expert. The Fiscal Code values apply from 2026-01-01, the snapshot's date; earlier months are a rule gap.

Annual leave: a run entry gives the leave days; without the month's amounts, the run pays the worked days at the base salary and the leave at the daily average of the contract's previous three posted months (salary and leave pay, without bonuses), at least the base salary for the leave days, both in whole lei (Codul muncii art. 150, a text still to obtain). The computation is kept with the line. Benefits in kind are not built yet.

Sick leave (OUG 158/2005 as consolidated on 1 July 2026, with OUG 91/2025 art. II as amended by Legea 64/2026; all read on the portal and still pending a stored copy):

- **Input:** a run entry lists the month's medical certificates (series, number, indemnity code, issue date, first and last day, the certificate it continues, hospitalization, where it was prescribed, and the diagnosis code, which is stored sealed like the CNP). A certificate covers days of one month. Only code 01 (ordinary illness) is computed; any other code stops the line.
- **Base:** the six most recent of the twelve months before the episode, from the posted runs: each month's CAM base capped at 12 minimum wages, over its active days. When the payroll holds fewer than six, the base comes from the employee's stage certificate (`sickBase`). The daily average is truncated to the ban, as the norms' worked example does (the norms, Ordin 15/2018/1.311/2017 as amended in June 2026, were read only in a secondary source).
- **Amount:** the daily average × the certificate's percentage (55% up to 7 days, 65% for 8–14, 75% over 15), for its working days. For certificates issued from 1 February 2026 to 31 December 2027, the episode's first working day is not paid, unless the patient is hospitalized. The employer pays the next five working days and FNUASS the rest. A continuation keeps the episode's base, loses no further day and carries the employer's days over. Each part is rounded to whole lei.
- **What stops the line:** a 15-day certificate (the law's tiers skip it); a continuation whose episode reaches another percentage than its own certificate (art. 17 alin. (1^2) recalculates the earlier month from July 2026, not built); a continuation that does not follow on; sick amounts also given by hand.
- **Contributions:** both parts are salary income for the tax and in the CAS and CASS bases (code 01); the fund's part is not in the CAM base (Codul fiscal art. 76 alin. (1), 139 alin. (1) lit. o), 157 alin. (1) lit. v), 220^5). Sick pay does not count towards the minimum contribution, which is for the active days.
- **Booking:** the contract is suspended on the certificates' working days. The employer's part is on 641; the fund's part is a claim on FNUASS (Dr 4382), recovered on the employer's request (art. 38), its receipt booked by a journal entry.
- **D112:**
  - An employee with certificates is declared in section B (the days worked and those on leave, the indemnities by payer, the bases) together with section D, one record per certificate. ANAF's validator refuses section D next to section A.
  - The employer's totals are in C1, and the medical leave by percentage and the amount to recover from FNUASS are in C2.
  - Still refused: sick pay entered by hand, a certificate without its place or diagnosis, an employee on the minimum-wage relief, and a part-time employee owing the minimum contribution in a month with sick leave.

CAM is posted on the employer's total base, rounded once, as D112 declares it.

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

**D394 (domestic supplies and acquisitions)** is written by `xfactura-core/src/ro/declarations/d394.ts` from ANAF's structure of 15.09.2025 (namespace v5, periods from 08/2025), with the partner counts, summaries and control sum ANAF's validator checks. From the books, for the company's VAT period (monthly L, quarterly T):
- domestic invoices of the period's VAT ledger, grouped by partner and rate: supplies (L) and acquisitions (A), with the number of invoices, and base and VAT rounded to whole lei; credit notes reduce their group;
- a partner is registered for VAT when its code on the invoice is RO followed by a valid CUI; other customers are reported with their CUI or CNP, or, without one, by the address of their invoicing details; a supplier charging VAT without a VAT code blocks the statement;
- the series are those the engine issued in the period (the range allocated and the numbers issued), the issued credit notes are listed as storno invoices, and invoices issued outside them (the previous invoicer) must be declared with their ranges and count;
- an issued invoice not yet in the VAT ledger, a refund requested by the period's D300 without the nature of the operations (or the reverse), and TVA la încasare block it;
- the header takes the company's invoicing details and, as options, the CAEN code, phone, representative, who prepared it, and the consent and affiliated-persons answers.
Services across the border are not in it (D390 and D300 report them); acquisitions from suppliers applying TVA la încasare (AI), simplified invoices and receipts are not produced yet.

**D112 (contributions, wage tax and the insured)** is written by `xfactura-core/src/ro/declarations/d112.ts` from ANAF's structure for months from 07/2026 (namespace v7). From the books it declares the month's posted payroll run: each employee's insured type (51 with the minimum-wage relief), contract and hours, days, bases, contributions withheld and borne by the employer (obligations 458 and 459), deductions, tax and the amount paid, the CNP opened from its seal for the declaration only; CAM is computed once on the employer's total. Amounts must be whole lei. It locks no tax ledger. The unemployment base (A_9) is declared as the salary paid in money, an interpretation awaiting the expert's review.

**D100 (obligations to the state budget)** is written by `xfactura-core/src/ro/declarations/d100.ts` (namespace v2, periods from 01/2026) and prepared for a month from the books: the micro-enterprise tax posted for the quarter (121), in its last month, and the dividend tax withheld in the month, for individuals (604) and companies (150), with, in December, the tax on dividends unpaid at year end. The fourth quarter's micro tax is due by 25 January in ANAF's structure and by 25 June in its validator; the company chooses (`fourthQuarterDue`). A correction of a filed D100 is a separate form (D710), not built yet.

**D205 (tax withheld, by beneficiary)** is written by `xfactura-core/src/ro/declarations/d205.ts` (namespace v3, years 2025–2026) and prepared for a year from the posted dividend withholdings: one record per individual shareholder, with the dividends distributed, paid and unpaid at year end and their tax; companies are not declared in it. An individual's CNP is recorded once (`parties.recordCnp`, kept sealed like employees'). Whether the dividends paid are declared gross or net the instructions do not say: the company chooses (`paidAs`).

**D406 (SAF-T)** is written by `xfactura-core/src/ro/saft/d406.ts` (schema 2.4.9, periods from 07/2025) and prepared for each VAT period (L monthly, T quarterly; it must match `vat.period`).
- **What it holds:**
  - accounts with their opening balances and turnover, equal to the trial balance;
  - customers and suppliers from the open items, one entry per partner and account, equal to their open items;
  - one journal per journal code, each entry with its justifying document and its currency side;
  - the invoices from the retained UBL, with the booked account;
  - products from the invoice lines;
  - the bank entries settling partners, as payments.
- **Advances:** an advance invoice's lines are reported on 419 (or 4091/4092) and the final invoice's deduction as its negative line, with negative base and VAT. Advances paid count as goods (4091) or services (4092); what customers' advances (419) are for is the option `advances`.
- **VAT codes** go on the base line, through a mapping table (`saft/tax-codes.ts`) in which each row quotes ANAF's description. A purchase with half its VAT deducted (vehicles) takes ANAF's 50% codes (34xxxx). A code with no certain SAF-T code (`O`, 9%, 5%, other partial deductions) is a problem, never a guess.
- **Validation:** ANAF's D406 validator runs only in ANAF's SAF-T kit, pinned separately (`anaf-saft`). The engine sends D406 there and every other return to the general DUKIntegrator, and records which kit ran.
- **The validator doesn't check** that entries balance, the control totals, or currency conversion. Those are the writer's own checks (`checkD406`).
- **Not produced yet:** payroll TaxTypes (their lines carry 000), the annual assets file, the stock file, invoices with document-level allowances, a VAT rate's lines booked on several accounts (`D406_SPLIT`; an invoice split by rate is reported, each line on its rate's account and with its rate's VAT), and invoices without UBL XML.

**Obligations calendar.** `obligations.calendar` lists the returns whose periods end in a range of months, with their deadlines and where each one stands: due, overdue, prepared, authorized, filed, accepted, rejected, or blocked when its deadline isn't sourced for the period.
- **Which returns apply** is read from the profile and the books:
  - VAT payers file D300 and D394 for each VAT period, and D390 for the months with services across the EU border.
  - Every company files D406, for each VAT period, or quarterly outside VAT. The date from which its category reports isn't checked.
  - Employers file D112 monthly.
  - Microenterprises file D100 for each quarter; it's also due in the months with dividend tax withheld, and D205 follows for those years.
  - S1005 is due for each financial year. The size category isn't checked; the engine prepares only the microentities' statements.
- **The deadlines** are cited parameters (`ro.deadline.*`, `xfactura-core/src/ro/obligations.ts`):
  - D300 (Codul fiscal art. 323), D112 (art. 147), D100 (art. 56, 43 and 97) and D390 (OPANAF 591/2016): the 25th of the next month;
  - D406: the last day of the next month (OPANAF 1783/2021 anexa 4);
  - D205: the end of February (art. 132);
  - S1005: 150 days after the year (Legea 82/1991 art. 36).
- **How deadlines move:**
  - A deadline on a non-working day moves to the next working day: the procedure code's art. 75 refers to the Civil Procedure Code, whose art. 181 is still to be read.
  - What falls due on 25 December is due on 21 December, or the working day before it (procedure code art. 155(2), read in ANAF's 2019 consolidation; the text in force couldn't be read).
- **D394:** the 30th of the next month, or the end of February for January (OPANAF 3769/2015 art. 8 as rewritten by OPANAF 2328/2016; later changes to that article aren't checked).
- **Past the horizon:** the deadlines were read through 2026, so later periods show as blocked.

Steps are recorded in order, and the database allows only the documented transitions; a tax period is locked only in the name of an authorized return of that tax and period. A rectification is a new return that supersedes the earlier one.

## e-Factura through the SPV

The engine talks to ANAF through an e-Factura port (upload, status, message list, download). The live client (`adapters/anaf-efactura.ts`) calls ANAF's API over OAuth, as the Ministry's presentation of the web services documents it (the upload and status replies' attributes and the list's paging follow the services' Swagger pages and are to be confirmed against a first live response), and keeps ANAF's published call limits itself: 1,000 calls a minute, 100 status questions and 10 downloads a day per message, 100,000 paginated lists a day per CUI. A lost connection or a server error leaves an upload uncertain until the inbox is synced; ANAF's refusal carries its message. With an application registered on ANAF's portal (`ACCOUNTING_ANAF_CLIENT_ID`, `_SECRET`, `_REDIRECT_URI`, `_ENVIRONMENT`), `spv.connect.start` gives the address where the company's representative signs in on logincert.anaf.ro with their certificate, and `spv.connect.finish` keeps the tokens ANAF returns, sealed, renewing the access token before its 90 days end. The engine never sees the certificate. Without it, a deterministic simulator stands in.

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

**Cash** (in lei, on 531x):
- **`cash.record`** books a receipt or payment by its receipt (chitanță) or cash slip number. The number goes into the cash register.
  - It can settle open items (an invoice paid in cash), open a new item for the person, or book to accounts without partners.
  - New items: an advance for expenses paid on 542, other debtors on 461, an associate's money received on 4551, other creditors on 462.
  - The cash desk can't go negative.
- **Legea nr. 70/2015 limits** are cited parameters (`ro.cash.limits`) with the 2026 values of ANAF's guide.
  - A movement above one person's daily limit (5,000 lei for a company or PFA, 10,000 lei for an individual) needs acknowledging, as does cash above 50,000 lei at the end of the day.
  - Not checked yet: a day's several movements with the same person added up, and the total of 10,000 lei a day paid to companies. The law's exemptions (taxes, salaries, travel) are for the reviewer.
- **`cash.expenseReport`** (decont) books the expenses paid out of an advance against 542.
  - What is left comes back as a cash receipt settling the same advance.
  - Spending more than the advance is refused: the difference is paid first, as a further advance.
  - VAT on receipts isn't deducted yet.
- **`cash.register`** produces the cash register for a date range: for each day, the balance carried over, every receipt and payment with its document, and the day's balance.

## Month close

Closing is a reviewed action: `periods.close.request`, then `actions.approve` on the exact preview hash, then `actions.execute`. Execution re-runs the preview and requires it to be unchanged. The preview lists every finding:

| Finding | Severity |
|---|---|
| Month already closed, or an earlier month with entries still open | block |
| Unposted, unwithdrawn proposals dated in the month | block |
| Unexplained bank movements booked in the month | block |
| Ledger balance different from a statement's closing balance, or a statement that does not continue the previous one | block |
| Foreign-currency monetary balances not revalued at month end | warn |
| Amounts deferred to 471 or 472 with a release due by month end (`DEFERRAL_DUE`) | block |
| Purchase invoices whose Romanian supplier has no ANAF status snapshot for the tax point (`SUPPLIER_STATUS_UNCHECKED`) | warn |

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
  - CSV bank statements.
- **Not built yet:**
  - verification of the Ministry's signature; B2C identification;
  - VAT categories other than S/O, TVA la încasare, domestic reverse charge, goods across the border, pro-rata; D394 for TVA la încasare, simplified invoices and receipts; reading the P300 file;
  - payroll beyond salary in money, vouchers, annual leave and sick leave for ordinary illness (other indemnity codes, benefits in kind), and corrections of a posted month;
  - asset revaluation and fiscal depreciation; leasing and loans;
  - VAT deducted from receipts and simplified invoices; cash payments in D406's payments section;
  - stock;
  - profit tax, interim dividends, dividends to non-residents;
  - the statements of small and larger entities; physical inventory and provisions.

[ROADMAP.md](ROADMAP.md) orders this work.
