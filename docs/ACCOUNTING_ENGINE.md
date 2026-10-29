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

Fiscal parameters come from the source register (`xfactura-core/src/ro/vat.ts`, `src/ro/fx.ts`). Resolution never defaults:

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

### `fx.revalue`: month-end revaluation

- **Input:** a month-end date and a round number (a later round re-revalues after further entries).
- Revalues monetary items (receivables, payables, accruals, unapplied cash) and foreign bank or cash balances at the selected rate. Each difference is booked on the item or account with a zero currency amount, against 7651 or 6651.
- Advances and deferrals are not monetary and are not revalued.

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
- `vat.journal`: sales or purchase VAT journal per tax period, with totals per VAT code. These are working registers, not declarations.
- `openItems.list`: open receivables, payables and other items with their balances.

## Exports, backup and restore

- `exports.request` needs review permission, or an agent scope for it. The worker rechecks authority when it builds and when it stores the file.
- An export contains every company record and every original file, up to 64 MB of originals. Downloads are rechecked on every request.
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
  - VAT categories other than S/O, TVA la încasare, reverse charge, intra-EU operations, pro-rata, VAT settlement and declarations;
  - payroll;
  - fixed assets;
  - stock;
  - micro and profit tax;
  - year-end close;
  - statutory register layouts and official filings.

[ROADMAP.md](ROADMAP.md) orders this work.
