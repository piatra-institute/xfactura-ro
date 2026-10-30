# Accounting engine

This document owns the engine's exact runtime behavior: what each implemented treatment accepts, what it books and what it refuses. [IMPLEMENTATION.md](IMPLEMENTATION.md) owns company-level coverage; [AGENT_API.md](AGENT_API.md) owns the wire contract; [ROADMAP.md](ROADMAP.md) owns remaining work.

The engine is the kernel described in [ADR 0010](adr/0010-append-only-kernel.md). Its pure parts live in `packages/xfactura-core`; persistence, commands and transports live in `packages/xfactura-api/source/engine`.

## How anything reaches the books

1. **Evidence.** An original file is kept as immutable, content-addressed bytes (`evidence.record`). Every proposal cites the evidence it relies on.
2. **Documents.** Imports turn evidence into typed, immutable documents: e-Factura invoices and credit notes (`invoices.import`), bank statements (`bank.import`, `bank.importCsv`), BNR rates (`fx.importBnr`). What an agent reads from a PDF or a photo (invoices, receipts, contracts, statements) is recorded as data the engine checks against the file ([Documents from PDFs and photos](#documents-from-pdfs-and-photos)).
3. **Treatment.** A pure function evaluates a typed input against the state it declares it reads: documents, open items, movements, the company profile, FX rates. It produces an **effect**: journal lines with dimensions and currency amounts, open items, tax entries and schedules, together with any issues.
4. **Proposal.** The engine validates the effect, resolves stable ids and hashes the version over its treatment, input, read-set, rules and effect. Issues are `block`, `ack` (must be acknowledged at approval) or `info`. A company has at most one proposal holding a subject (`document:<id>`, `movement:<id>`, …): open, or posted by an entry that stands.
5. **Binding.** A person approves the exact version and effect hash (`proposals.approve`), acknowledging each `ack` issue, or approves up to 200 versions without warnings at once (a batch, below). Or a human-approved posting policy covers the treatment and rule versions (`policies.create`, or `policies.request` once a template graduated) and acknowledges each `ack` issue by code (`acknowledges`); it never posts an extracted document unless it allows that source, nor while it, its template or the company is paused. Under the company's segregation of duties (`controls.segregation`), the approver, or the policy's approver, is someone other than whoever created the version: `on` for a version a person created themselves; `strict` also for one an agent created under that person's grant. Without the fact, segregation is `off`.
6. **Posting.** `ledger.post` checks that the approver is still an active owner or reviewer under the same membership epoch (`APPROVER_INACTIVE`), reloads the read-set and re-evaluates the treatment. If anything differs it refuses with `STALE`. Otherwise it writes the rows and then the entry header. The database's invariants check the rows against the approved effect, the balance, the binding (including the policy's acknowledgements and segregation), the period and tax-period locks and the numbering, then seal the entry.

Posted records are never changed. A correction is a reversal (`ledger.reverse`) plus a new proposal: once the reversal is posted, the reversed entry no longer stands and its subject is free, so the same document or movement is proposed again (the worklist lists it again as unbooked or unexplained). A reversal proposed but not posted frees nothing. The database keeps a subject to one standing entry (`subject_posted`) and one proposal holding it (`subject_taken`, and `identity_taken` across a document's copies).

Between proposal and posting the books may move on. `Proposals.recheck` re-evaluates the latest version against the current books exactly as posting would, writing nothing; the worker caches the result in `acc_proposal_checks` and the proposal shows `stale` (see [Worker, jobs and the change feed](#worker-jobs-and-the-change-feed)). Posting still re-evaluates on its own.

A proposal that recognizes a document records the one its input names (`documentId`), else its subject's. Copies of one document share their group's root as subject ([Copies and groups](#copies-and-groups)).

A version may rely on facts a person stated rather than on the books: its **basis**, the answered questions it cites ([Questions to people](#questions-to-people)). The engine, not the treatment, adds each to the read set at its latest answer, so a later answer makes the version stale and the database refuses to post it (`stale_read`), and loads those answers, and only those, for the treatment to read (`Loaded.answers`): `invoices.recognize` reads a vehicle's use from them. The basis is hashed into the version only when there is one.

Reviewed actions (closing or reopening a month, authorizing a return, approving a batch, creating a template, granting a policy from a graduation) bind the same way: a person approves the exact preview, and under segregation `on` that person is not who requested it (`strict`: nor who issued the requesting agent's grant). Execution recomputes the preview and refuses `APPROVER_INACTIVE` when the approver lost their role since; the database checks the decider again (`inv:decider`).

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

A status rises only through a review record. The procedure is in [GOVERNANCE.md](GOVERNANCE.md#rule-review-in-two-tiers); the code is in `xfactura-core/src/ro/reviews`.
- **Tiers:** `interpreted` and `cases_approved` need a partner accountant's record; `signed` needs the expert contabil's signed packet.
- **Records:** each answers a review packet generated from a per-parameter spec: two readings, three to five cases computed by the treatments, and a multiple-choice question. Records are JSON files in `src/ro/reviews/records/` and hold the packet they answered.
- **Binding check:** `reviewProblems`, a core test over the default register, refuses a status that no record binds. A record binds while:
  - the reviewer chose the engine's reading; and
  - the version's packet item, rebuilt from today's register, spec and sources, hashes the same as the one reviewed.

  Changing the value, dates, clauses, excerpt anchors, readings or any case outcome voids the record, and the check names the change.
- **Today:** there are no records. `src/ro/register.ts` lists the same parameter families as the engine's `defaultRegister()`, and a scripts test checks the two agree.

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
- Once posted, the reversed entry no longer stands: its subject (the document or movement it booked) is free for a new proposal, its open items are cleared, and the open items it settled are open again for the new booking to settle. A document's open items, as a treatment reads them (`openItems: [{ documentId }]`, a credit note's original), are those of its bookings that stand, so a credit note reduces the new booking's receivable or payable, never the reversed one's.
- A reversal is never reversed in turn (`REVERSAL_OF_REVERSAL`; the database too, `reversal_of_reversal`): a wrong storno is corrected by booking its subject again, which it freed. So one level decides whether an entry stands.

### `invoices.recognize`: domestic invoice

- **Document:** an imported invoice (380) issued or received by the company.
- **Input:**
  - **One account** for every line: a revenue (70x) or expense (6xx) account, or for a purchase a fixed-asset account (20x, 21x), whose supplier is then held on 404. For purchases, the deduction is `full` or `none`.
  - **Or `allocations`:** each VAT category's taxable amount (`S-21`, `S-11`, `O`) split over accounts in the document's currency, each part with its own deduction. A category's parts must add up to its amount; allowances and charges are inside it.
  - **Deduction:** `full`, `none`, or `limited`.
    - `limited` deducts the register's share (`ro.vat.deduction.limited`, 50%) of a part's VAT. The share is rounded half up to the ban. The rest of the VAT stays in the expense, and D300 rd. 31 holds only what was deducted.
  - **Vehicles (Codul fiscal art. 298, norme pct. 68).** The VAT on buying, leasing or renting a motorized road vehicle of at most 3,500 kg and 9 seats (the driver's included), and on the costs directly attributable to it (fuel, repairs, upkeep, lubricants, spare parts), is limited to the share unless the vehicle is used only for the business, shown by its log (foaia de parcurs: category, purpose and place of each trip, kilometres, its own fuel norm), or the article excepts it.
    - A part names its vehicle: `vehicle` beside `account`, or `allocations[].vehicle`, the registration as written. It is read without spaces or dashes and in capitals (`B-123-XFA` is `B123XFA`), as the `vehicle.use` question names it.
    - A purchase part that deducts VAT (`full` or `limited`, standard-rated) and names a vehicle needs the owner's answer about that vehicle in the proposal's basis ([Questions to people](#questions-to-people)). Without one, or with one whose `from` is after the tax point, it is blocked by `VEHICLE_USE`, which asks `vehicle.use` about the vehicle. The answer decides: `business_only` (its log attached) or an exception deducts `full`; `mixed` deducts `limited`. Another deduction is refused (`VEHICLE_DEDUCTION`). A part deducting nothing (`none`, no VAT) needs no answer, nor does a purchase that cannot deduct (a non-payer, an inactive supplier outside the exceptions).
    - Exceptions, which the answer states with their proof (`exception`, `exceptionEvidenceId`): over 3,500 kg or more than 9 seats (alin. (2)); used by a sales or purchasing agent, for paid passenger transport, for paid services, rented out or leased, or as goods (alin. (3) lit. b)–f), where personal use is negligible, pct. 68 alin. (5)). Emergency, security and courier vehicles (lit. a)) must be used only for those services: they are `business_only`, with the log.
    - A part that deducts the limited share, or is on an account that suggests a vehicle, without naming one, is confirmed by the reviewer (`VEHICLE_UNNAMED`, ack): 6022 (fuel) and 2133 (vehicles) always; 611, 612, 6024 and 167 when a line names a vehicle (auto, autoturism, vehicul, mașină, carburant, motorină, benzină, anvelope, ITP, rovinietă, or a registration).
    - The explanation lists each vehicle with the answer that decided it and its evidence. Not covered: advances naming a vehicle (blocked), credit notes and cash receipts (their deduction stays as given), the adjustment of a vehicle bought as a capital good whose use changes (art. 305), and the profit-tax limit on vehicle costs (art. 25 alin. (3) lit. l)).
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
    - Snapshots come from `parties.checkStatus`. It calls ANAF's public taxpayer-status service (`PlatitorTvaRest` v9: at most 100 CUIs per request, 1 request per second) and records snapshots per party and date in the append-only `acc_party_status`.
    - A snapshot is recorded only when ANAF's answer differs from the latest snapshot for that party and date in some field it stores (name, VAT, cash-accounting VAT, inactive with its dates, split VAT, e-Factura, struck off). An identical answer records nothing: the standing snapshot stays the one read, and ANAF's raw answer is kept as evidence only when a snapshot is recorded from it.
    - With `month`, only the suppliers without a snapshot for their invoice's tax point are asked about; the others are reported from their snapshot, so the close warning's re-check of a month does not ask about the suppliers already checked. With `partyIds` and `date`, ANAF is always asked.
    - The snapshot read is for exactly the date asked. A newer snapshot for that date, recorded because ANAF's answer changed, makes a pending proposal stale.
    - Not covered yet: purchases already posted when a later snapshot shows the supplier inactive, advance invoices from an inactive supplier, and purchases through cash expense reports or the general journal.
- **Supported:** the categories of the document's VAT breakdown, each S at the register's standard rate for the tax point or at its reduced rate, or O. The reduced rate applies only to the supplies of Codul fiscal art. 291 alin. (2), so it is an `ack` warning (`REDUCED_RATE`): the reviewer confirms the operation qualifies.
  - **The tax point** (`chargeabilityOf`) is the date VAT becomes chargeable, so the date the rate is read on, the VAT period and the VAT exchange rate: the rate in force when the chargeable event occurs (fapt generator, art. 281), unless an invoice or an advance came first (art. 282 alin. (1)–(2), art. 291 alin. (4)–(5)). By order of evidence:
    - the supply's date the document states (BT-72), unless the issue date, or a stated tax point (BT-7, an advance collected earlier), is earlier. A July supply invoiced in August with BT-72 takes July's rate and July's VAT period; the entry is still dated on the invoice;
    - without BT-72, the stated tax point (BT-7), else the issue date, standing for the supply's date;
    - the invoiced period (BG-14) is not used: for a continuous supply the chargeable event is the payment date in the contract or the invoice (art. 281 alin. (8)), for another service its completion (alin. (12)), and the document does not say which.
  - **Warned (`ack`)** about that date:
    - `SUPPLY_DATE_ASSUMED`: the issue date stands for the supply's date and the standard rate changed since the first day of the previous month (or the invoiced period's start), so the supply may predate the change. A 19% invoice of August 2025 without BT-72 is also refused (`VAT_RATE`) until a document states the supply's date;
    - `RATE_REGULARIZATION`: the invoice or the advance came before a supply at another rate; art. 291 alin. (6) requires the regularization at the supply's rate, which the engine doesn't compute;
    - `TAX_POINT_DATES`: a stated tax point later than the supply or the issue date, which the engine doesn't follow.
  - The same date gives the rate checked when the invoicer issues an invoice (`sales.issue`) and when an extracted document is checked (`VAT_RATE`).
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
  - The credit note must reference the original's number. Each of its VAT categories must be one of the original's, at the rates in force on the original's tax point (its supply's date when it states one): a credit note after 1 August 2025 for a supply before keeps 19% (art. 282 alin. (9)). The credit note's own VAT is chargeable on its date (BT-7, else the issue date), even if it repeats the supply's date.
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

- **Input:** the quarter, a posting date on or after its end, the tax authority as a partner, a round, determinations for accounts whose revenue the law excludes only in some cases, and, once the year has revenue on 7583, the year's transfers of fixed assets (by subgroup of the catalogue, with their revenue) and of land (`assetTransfers`, with evidence).
- **Base** (Codul fiscal art. 53, read in ANAF's consolidated text): the quarter's revenues of any source (class 7, net of corrections and of 709), less those excluded by their nature (711, 712, 721, 722, 725, 741x, 7584 and FX gains 765), less what the determinations exclude, plus commercial discounts received (609) and, in the fourth quarter, the year's net favorable FX difference (765 less 665). Revenues on 781x, 786x, 7581, 7588, 768, 761x and 762 need a determination, with its evidence and the letter of art. 53 alin. (1) that applies, before the tax is computed. Revenue from selling assets (7583) stays in the base: art. 53 doesn't exclude it. The base is taxed in lei and bani at `ro.micro.rate` (1%); only the tax is set in whole lei, half up at 50 bani (`ro.declaration.rounding`, OUG nr. 59/2005 art. 1 alin. (1)). Rounding the base first is the alternative reading in the rate's review packet.
- **Effect:** Dr 698 / Cr 4418, an open item of the authority.
- **Refused:** a company not recorded as micro (`income_tax`), a year's turnover (70x) above `ro.micro.revenue_limit_eur` (100,000 euro from 2026) at the BNR rate of the previous year's end, which makes the company owe profit tax from that quarter, a missing rate, a year with revenue on 7583 and no `assetTransfers` (`MICRO_ASSET_TRANSFERS`), and a zero tax. The reviewer acknowledges each quarter that the company had a full-time-equivalent employee (art. 47 alin. (1) lit. g)).
- **Asset sales and the limit** (art. 54 alin. (1)): the turnover checked against the limit includes the year's revenue from transferring fixed assets once more than one asset of the same subgroup was transferred, and from transferring land once more than one plot was. Assets of different subgroups are the reading the text leaves open ("mai mult de un activ din oricare subgrupă"): the engine doesn't add them, and when adding them would exceed the limit the reviewer acknowledges the open question (`MICRO_LIMIT_READING`), which the limit's review packet asks the expert contabil. The asset register doesn't record whether a disposal was a sale, so the transfers are stated.
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

### VAT on collection (TVA la încasare)

The company's regime is the profile axis `vat.cash`. The ceiling is the cited parameter `ro.vat.cash.ceiling`: 5,000,000 lei from 1 March to 31 December 2026, 5,500,000 lei from 2027; earlier dates are a rule gap.
- **Deferral at recognition** (Codul fiscal art. 282 alin. (3)–(7), art. 297 alin. (2)–(3)):
  - The VAT of an invoice under the system goes on 4428, with tax entries that are not yet chargeable (no exigibility), and are marked `cashVat` (`own`, `supplier`, `own+supplier`).
  - For the company's own regime, the engine reads `vat.cash` on the earlier of the invoice's issue date and tax point.
  - **Sales:** a sale to an affiliated buyer (input `affiliated`) stays under the general rules, as alin. (6) says. The invoicer writes the mention "TVA la încasare" (BT-22) on invoices under the system.
  - **Purchases:** the deduction waits for payment if the company is in the system, the invoice carries the mention, or the supplier's ANAF snapshot shows it in the register. Only the deductible VAT waits.
  - Foreign currency and advances under the system are refused.
- **Release at settlement:**
  - `bank.settle` and `cash.record` read each settled invoice's history.
  - They release, on the statement or receipt date and in that date's period, the share of VAT now collected (Dr 4428 / Cr 4427) or paid (Dr 4426 / Cr 4428).
  - The release is rounded cumulatively, so a full settlement releases exactly what is left.
  - **Credit notes** (alin. (10)) first reduce what is deferred, and the excess reduces chargeable VAT at the note's date.
  - An offset (`items.offset`) collects and pays, and releases the VAT the same way. Settling a deferred invoice through the general journal (cession, payment in kind) is refused.
- **Returns:**
  - **D300:** releases go to rows 9–10 and 24–25. The informative fields A, A1, B and B1 hold what is still deferred.
  - **D394:** invoices under the system are listed in full in their period (L, A, AI), with the VAT collected and deducted from the releases.
  - **D406:** codes 310350/310354 for sales, 301305/301306, 341306 and 351305/351306 for purchases, and releases as 380106/380107 on the bank or cash line. All three pass ANAF's validators.
- **Month close:** warnings for deferred VAT on settled invoices (`CASH_VAT_UNRELEASED`), the ceiling exceeded (`CASH_VAT_CEILING`), and leaving the system (`CASH_VAT_EXIT`).
- **Not covered:**
  - eligibility (alin. (3^1)–(5)) is checked by the yearly determination of `vat.cash`, not by the treatments;
  - cession and payment in kind are not treatments yet;
  - one 4428 account holds both sales and purchase deferrals;
  - e-TVA's comparison will differ for a company in the system.

### `deferrals.defer` and `deferrals.release`: amounts for later months (471, 472)

- **`deferrals.defer`** moves an expense (6xx) or revenue (70x) already booked, such as a yearly subscription or insurance, to 471 or 472.
  - The amount becomes an open item of the partner, with a schedule of equal monthly releases over `months` from the month `from`; the remainder goes to the first months.
  - Its evidence shows the period covered. Releases start in the deferral's month or later.
  - When the documents don't say which months the amount covers, the input leaves out `from` and `months`: the proposal is blocked with `DEFERRAL_SCHEDULE`, whose `details.question` asks a person `deferral.schedule` about `deferral` `<evidenceId>:<account>`. It is revised with the answer's months and the question as its basis.
  - Lines: Dr 471 / Cr expense, or Dr revenue / Cr 472.
- **`deferrals.release`** books a month's share on its last day, back to the account the amount came from.
  - It releases what each open deferral's schedule has due by then, less what was already released (the schedule's total less the item's balance). A missed month is caught up, and nothing is released twice.
  - With nothing due, it is refused (`NOTHING_TO_RELEASE`). A month with a release due does not close.
- Schedules are read with their open items (an open-item query with `schedules`). They never change, so the item's version covers them.

### `items.offset`: offsetting a partner's debts (compensare)

- What a partner owes the company and what the company owes it cancel each other for the same amount, in lei, on the date of the offset document, with no money moving.
- Inputs: debit items (receivables, advances paid, debtors) against credit items (payables, advances received, creditors), all of one partner.
- An invoice under VAT on collection counts as collected or paid for the amount offset, and releases its VAT (norme pct. 26 alin. (10)).
- Not covered yet: offsets between more than two parties, and foreign-currency items.

### `accruals.record` and `accruals.settle`: invoices not yet received or issued (408, 418)

- **`accruals.record`** books a service in its month before its invoice: received from a supplier (Dr expense / Cr 408) or rendered to a customer (Dr 418 / Cr revenue).
  - The amount is net of VAT and is an open item of the partner, justified by a contract, report or timesheet.
  - The accrual keeps the account it was booked on as a one-row schedule.
- **`accruals.settle`** reverses the accrual on the invoice's day, once the invoice is booked. The invoice must be the same partner's, and the open balance is reversed in full. The difference between the invoice and the estimate falls in the invoice's month.
- **VAT:** it comes from the invoice, at the invoice's tax point. Putting VAT not yet chargeable on 4428 at the accrual is a policy the engine doesn't apply. Whether the reversal method suits the company is for the expert accountant to confirm.

### Loans and leases: `loans.*`, `leases.commence`

- **Accounts, as OMFP 1802/2014 places them:**
  - bank credits on 1621 (long term) or 5191 (short term);
  - loans from affiliated or associated companies on 1661/1663;
  - other lenders and lease liabilities on 167;
  - associates on 4551.

  The loan accounts are controlled as `loan.payable` and their interest accounts (1682, 1685–1687, 5198, 4558) as `loan.interest`, for companies created from now on.
- **A loan is an open item of the lender in its own currency, with one schedule:**
  - principal rows on the loan account, adding up to the amount borrowed;
  - interest rows on the interest account, or on 666 for a lease.
- **Treatments:**
  - **`loans.receive`** explains the bank movement that brings the loan in. The schedule is given as rows or as terms (annuity or linear, 30/360).
  - **`loans.schedule`** attaches or revises a schedule on an existing loan, for example an associate's 4551 money or an opening balance. Rows already due stay unchanged, and so does the principal.
  - **`loans.accrue`** books month-end interest (Dr 666 / Cr interest account). Each period's interest is spread over its days. The accrual is cumulative, so it never books twice and catches up a missed month.
  - **`loans.withhold`** withholds the tax on interest paid to an individual (Codul fiscal art. 97 alin. (2), 10%, parameter `ro.interest.tax_rate`): Dr interest / Cr 446. It is declared in D100 (code 605) and D205 (tip 09).
  - **Repayments** go through `bank.settle`.
- **Finance lease (lessee):**
  - **`leases.commence`** brings a registered asset in against 167 at the rate of the financing date (pct. 321). The contract is either settled in lei at the euro rate, or in its currency.
  - **Instalments** are the lessor's invoices, recognized with an allocation on 167 (`lease`, `principal`, `vatExpense`).
    - The lessor is held on 404, and 167 is released at its carrying amount.
    - The exchange difference goes to 668/768 (lei-indexed) or 6651/7651.
    - VAT comes from each invoice, a service taxed at each payment date (art. 271 alin. (3) lit. a), art. 281 alin. (8)). The 50% vehicle limit and VAT on collection apply as usual.
- **Operating lease:** the lessor's invoices on 612, through `invoices.recognize`.
- **`fx.revalue`** revalues foreign-currency loans and their interest.
- **`loans.list`** shows each loan with its balance, schedule and the part due within 12 months. The reclassification of pct. 360 is presentation only, so it's not booked.
- **Month close:**
  - interest not accrued for an open loan blocks (`LOAN_INTEREST_DUE`; not on single-entry books);
  - a lease instalment due (`LEASE_INSTALMENT_DUE`) or an overdue loan (`LOAN_OVERDUE`) is a warning.
- **Not covered yet:**
  - D406 for lease invoices (`D406_SPLIT`);
  - D100 and D205 on the calendar for interest-only months and years;
  - withholding for non-residents (art. 223) and on interest in a currency;
  - revising a lease's schedule;
  - revolving credit lines and overdrafts;
  - the off-balance records of future interest and of operating leases.

### `fx.revalue`: month-end revaluation

- **Input:** a month-end date and a round number (a later round re-revalues after further entries).
- Revalues monetary items (receivables, payables, accruals, unapplied cash) and foreign bank or cash balances at the selected rate. Each difference is booked on the item or account with a zero currency amount, against 7651 or 6651.
- Advances and deferrals are not monetary and are not revalued.

## Documents from PDFs and photos

An agent reads a PDF or a photo (`evidence.read`: text by line, or the image for its own vision model) and records what it read with `documents.record`: an invoice or credit note in the UBL parser's shape (`extracted-invoice-1`), a fiscal receipt (`extracted-receipt-1`) or a contract (`extracted-contract-1`), each field citing `{ page, line, text }` of the file's text layer. The body and the checks are pure (`xfactura-core/src/documents`); the wire contract is in [AGENT_API.md](AGENT_API.md#documents-from-pdfs-and-photos).

- **Authority.** Every document records where its content comes from: `efactura` (the SPV's XML), `issued` (`sales.issue`), `ubl_upload`, `invoicer`, or `extracted`. Extracted documents keep their file and part in their source key (`extract:<file sha256>:<part>`), so they never take the place of a structured source: the same invoice from e-Factura is a document of its own.
- **Checks**, kept with the document (`checks_json`) and its citations with their outcomes (`citations_json`):
  - refused outright: a document the company is not exactly one party of, on the side its kind says (`COUNTERPARTY`); a body that does not parse. Recording a part of a file again with other content is a conflict (`DOCUMENT_CONFLICT`).
  - blocking a treatment that reads it (`SOURCE_INCONSISTENT`): `TOTALS` (lines to net, net and VAT to gross, gross to payable, the VAT breakdown to the totals) and `VAT_CATEGORIES` (each category's VAT is its base at its rate, a receipt's its gross at its rate, within half a ban per line and at least one ban). An extraction whose amounts do not add up must be corrected, not acknowledged, as the treatment books from them.
  - to acknowledge (`SOURCE_EXTRACTED`, naming the failed and unverified ones): `VAT_RATE` (a standard-rated category at a rate in force on the tax point; unverified on a rule gap), `TAX_IDS` (control digits), `IBAN`, `DATES` (not in the future or older than ten years, the tax point within a year of issue, the due date not before it) and `CITATIONS` (each citation's line exists, carries the cited words and shows the field's value; without a text layer, unverified, never passed; the key fields must be cited).
  - Every proposal reading an extracted document carries `SOURCE_EXTRACTED`, even when every check passed: a person confirms what a model read. A posting policy posts it only when it acknowledges the code.
- **Receipts** are recorded and checked; their booking and the VAT they may deduct (Codul fiscal art. 319 limit) are not built yet.

### Copies and groups

- **Identity.** A document's `identity_key` hashes its supplier's tax id (without RO), its number normalized (compatibility forms folded, no spaces, capitals), its issue date and its type; for a number already in that form it is the hash `recordInvoice` has always deduplicated e-Factura on. A receipt is identified by seller, register and number, only when the register is known (a chain's stores share a CUI and restart their numbers); a contract by the other party, number and date, when numbered.
- **Groups.** A document recorded with the identity of an earlier one joins that one's group by a `same_as` link to the group's root, the earliest recorded. Near copies whose identities differ (same partner and gross amount, dates at most 3 days apart: a date or number read differently) are joined only by a person, `documents.link` (`same_as_confirmed`), and only while the joining document has no proposal.
- **Booked once.** `Proposals.propose` takes the group's root as the subject of any `document:<id>` proposal, so the same invoice cannot be proposed twice from two copies (`SUBJECT_EXISTS`); a revision may move between copies, keeping the subject.
- **The better source.** A proposal reading a copy other than an e-Factura one, in a group that holds an e-Factura copy, carries `BETTER_SOURCE` (to acknowledge), naming it: revise onto it. Groups and supersessions are in the read set (`documentSource`), so a copy arriving makes an open proposal stale.
- **Corrections.** `documents.supersede` records a corrected extraction of an extracted document that no posted entry recognizes (directly or through its group's subject) and links it (`supersedes`); a proposal reading the superseded one is blocked (`DOCUMENT_SUPERSEDED`). After posting, the correction is a reversal and a new proposal.
- **Database guards:**
  - `document_authority`: every new document records its authority;
  - `extracted_source`: an extracted document has its evidence and an `extract:<that file's hash>:<part>` source key, which no other document uses;
  - `same_as_root`: a document joins a group only while in none and without members, only through the root, and a `same_as` link only into a group holding its identity;
  - `supersede`: only an extracted document is superseded, by an extracted one of its kind, once, while no posted entry recognizes it or its group;
  - `identity_taken`: no proposal names a document while another document of its identity or group has an open or posted proposal.
- **Migration.** Existing documents gained their authority from their origin. An e-Factura document's identity was derived from its `invoice:` source key when its number is already in normal form; issued and invoicer documents, and numbers needing normalization, have no identity and join no group.

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
- the tax base rounded to whole lei with 50 bani and less dropped (the methodological norms), contributions and tax half up (OUG nr. 59/2005 art. 1 alin. (1), read on the legislative portal; the procedure code has no rounding article).

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
- an issued invoice not yet in the VAT ledger, and a refund requested by the period's D300 without the nature of the operations (or the reverse), block it;
- the header takes the company's invoicing details and, as options, the CAEN code, phone, representative, who prepared it, and the consent and affiliated-persons answers.
Services across the border are not in it (D390 and D300 report them); simplified invoices and receipts are not produced yet.

**D112 (contributions, wage tax and the insured)** is written by `xfactura-core/src/ro/declarations/d112.ts` from ANAF's structure for months from 07/2026 (namespace v7). From the books it declares the month's posted payroll run: each employee's insured type (51 with the minimum-wage relief), contract and hours, days, bases, contributions withheld and borne by the employer (obligations 458 and 459), deductions, tax and the amount paid, the CNP opened from its seal for the declaration only; CAM is computed once on the employer's total. Amounts must be whole lei. It locks no tax ledger. The unemployment base (A_9) is declared as the salary paid in money, an interpretation awaiting the expert's review.

**D100 (obligations to the state budget)** is written by `xfactura-core/src/ro/declarations/d100.ts` (namespace v2, periods from 01/2026) and prepared for a month from the books: the micro-enterprise tax posted for the quarter (121, the amount on 4418, not computed again), in its last month, and the dividend tax withheld in the month, for individuals (604) and companies (150), with, in December, the tax on dividends unpaid at year end. The fourth quarter's micro tax is due by 25 January in ANAF's structure and by 25 June in its validator; the company chooses (`fourthQuarterDue`). A correction of a filed D100 is a separate form (D710), not built yet.

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

**Obligations calendar.** `obligations.calendar` lists the returns whose periods end in a range of months, with their deadlines and where each one stands: due, overdue, prepared, authorized, filed, accepted, rejected, or blocked. A return is blocked when its deadline isn't sourced for the period, when whether it applies depends on a fact nobody recorded (the row names the question to ask), or when the engine doesn't cover it (the row names the case). Each row gives its `basis`: the closure rule, the facts it read and the clauses.
- **Which returns apply** is the obligation closure's ([Determinations and the obligation closure](#determinations-and-the-obligation-closure)), from the recorded facts, the yearly determinations and the books:
  - VAT payers file D300 and D394 for each VAT period, and D390 for the months with services across the EU border.
  - Every company files D406, for each VAT period, or quarterly outside VAT. The date from which its category reports isn't checked.
  - Employers file D112 monthly, or, when `payroll.period` is quarterly, each month's D112 by the 25th after the quarter (`ro.deadline.D112.quarterly`, art. 147 alin. (4)), except the months with sick leave or a contract ended (alin. (11)).
  - Microenterprises file D100 for each quarter; it's also due in the months with dividend tax withheld, and D205 follows for those years. A profit-tax payer's D101 is listed as not covered.
  - Annual statements are due for each financial year kept in double entry, by the year's size category: S1005 for a microentity; a small entity's statements are listed as not covered.
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

## Determinations and the obligation closure

Which regime a company is in is decided each year, from its books, its facts and its owner's answers, under cited rules. The pure code is in `xfactura-core/src/ro/determinations` (`determine.ts`, `closure.ts`, `agent.ts`); the engine module `modules/determinations.ts` feeds it. Nothing is defaulted: a determination is a **proposal** of a dated profile fact that a person confirms, with its computation shown, or it says what it lacks.

**Operations:**
- `determinations.evaluate {year}` (read): each determination with its status, value, changes within the year, computation (Romanian lines), inputs with their source (books, an answer), clauses, parameter versions and fingerprint; what is recorded for the year and whether it agrees; and the thresholds reached.
- `determinations.propose {year}` (agents may): opens what a person must answer. Each computed determination not recorded, or contradicted by the recorded facts, becomes a `determination.confirm` question holding the computation and its fingerprint; each unknown input, the question it names. A question still open about an older computation is withdrawn; an answer that still holds is returned.
- `closure.evaluate {from, to}` (read): the obligation closure ([CONFORMANCE.md](CONFORMANCE.md#the-closure-as-built-t1-30-october-2026)), over the months the books cover: before the company's first financial year (one starting mid-month covers that month) it lists no return and asks nothing, nor the annual returns of a year before it, and the years before it are not determined. A company with no financial year at all is read from its facts alone. D212 and D204 wait for a known PFA, II or IF form; D406 of a PFA, II or IF is UNSUPPORTED (`D406_INDIVIDUAL`) until the expert contabil says whether SAF-T reaches it.

**Answering:** only a person (an owner or reviewer) answers. Confirming records the value from 1 January and each change within the year, as profile facts citing the answer, which holds the computation shown. Correcting records another value, citing the document that supports it (a D700, the registration). A recorded fact confirmed against the current computation's fingerprint is not questioned again; a fact recorded otherwise that the computation contradicts is a conflict until confirmed.

**The yearly axes** (`income_tax`, `vat.period`, `payroll.period`, `size.category`) need a fact effective within the year; one carried from an earlier year is not the year's determination. `vat.threshold` and `vat.cash` are checked each year but hold until changed. Two scope facts are asked of every company: `activity.goods` (goods or stock: not covered yet) and `regime.excluded` (excise, a fiscal group, IFRS: out of scope).

| Determination | Computed from | Rule (parameter) | Asked when |
|---|---|---|---|
| `income_tax`: micro or profit (SRL) | The previous year's turnover (70x net of 709) with the linked enterprises', against 100,000 € at the BNR rate valid at that year's close (art. 47 alin. (1) lit. c), alin. (1^1), art. 54); at least one full-time equivalent under contract at 31 December (lit. g), art. 51 alin. (4)); the owner's answer for lit. d), e), h), i) and alin. (3). Eligible, the previous year's regime carries (art. 48). During the year, the exit from the quarter the limit is crossed, own and linked revenue together (art. 52 alin. (1), (5^1)–(5^2), a quarter of a linked norm per quarter elapsed), from the quarter after the only employee left and was not replaced in 30 days (alin. (3)), and from the quarter the statements became late (alin. (2)). The consulting share is no condition from 2025 (lit. f) repealed by OUG nr. 156/2024). | `ro.micro.revenue_limit_eur`, `ro.micro.employee`, `ro.micro.linked` | the owner's conditions and linked enterprises (`micro.conditions`), a previous year outside the books (`year.figures`), the option when eligible without a regime the year before (`profile.fact`) |
| `vat.period`: monthly or quarterly | The previous year's taxable, exempt-with-deduction and abroad-with-deduction supplies (the bases of the output tax entries) against 100,000 € at the rate of 31 December, and no EU goods acquisitions (art. 322 alin. (2); norme pct. 103 (2)–(3)). | `ro.vat.period.limit_eur` | a registration during this or the previous year (art. 322 alin. (3)–(5)), a previous year outside the books |
| `payroll.period`: monthly or quarterly D112 | A PFA, II or IF with employees: quarterly (art. 80 alin. (2) lit. d)). An SRL: the previous year's mean headcount over the months with a D112 below 3, and for a profit-tax payer total revenues (class 7) up to 100,000 € (lit. b)–c), art. 147 alin. (6)–(7)). The option for monthly (art. 147 alin. (8)) is the confirming person's to state. | `ro.payroll.quarterly` | the year's income tax not recorded, a previous year outside the books |
| `size.category`: micro, small or medium/large | Total assets (balance sheet A–C from the year-end balances with the S1005 formulas, OMFP nr. 1.802/2014 pct. 15), net turnover (70x − 709 + 7411) and the 12-month mean headcount, for the previous and the current year. The category changes only when both years are beyond it (pct. 12–13): up to the lower, down to the higher. Medium or large, or above the audit thresholds in both years, is UNSUPPORTED. | `ro.size.thresholds` | the previous year's category, a previous year outside the books; a crossing year before the current one ends |
| `vat.threshold`: under or exceeded (non-payers) | The year's revenue on 70x, net of 709, by day, less supplies abroad (a non-payer's sales have no VAT entries; asset sales on 7583 are left out, as art. 310 alin. (2) leaves them); the day it exceeds 395,000 lei. Exceeded is UNSUPPORTED (registration under art. 316 is not covered). | `ro.vat.exemption.threshold` | the year not kept from 1 January |
| `vat.cash`: eligibility (VAT payers) | The previous year's VAT bases against the ceiling in force at the year's end (art. 282 alin. (3^1), (4)); during the year, the day the ceiling is crossed: out from the day after the next VAT period (alin. (5)). | `ro.vat.cash.ceiling` | `vat.cash` not recorded |

**Figures of a year the engine does not keep** (no financial year from 1 January) come from a person's answer to `year.figures`, with the filed statements and returns as evidence; a figure the books cannot place (total assets with an account split between an asset and a liability row) is asked the same way. The BNR rate of a year's close must be imported (`fx.importBnr`).

**The worklist** shows `determination.missing` for each yearly axis without its fact or contradicted by the books (blocking when contradicted), and `threshold.approaching` for the micro-enterprise limit, the small-enterprise threshold and the VAT on collection ceiling at 80% (warning) and over 100% (blocking); 80% is a product choice, not a legal value. Both move on with `determinations.propose`.

**Agent-ready** (`agent.ts`): the documents it takes (the trade register's certificate, the fiscal registration and vector, D700, the shareholders' register, the filed annual statements), its questions and who answers them, its two detectors and the rules they enforce, and no template fields.

**Parameters** (all `extracted`, reviewed through 2026-12-31): `ro.size.thresholds` (OMF nr. 2.036/2025 anexa 1 pct. 2.1–2.3 and 2.6; OMFP nr. 1.802/2014 pct. 12–13 and 15; from 2025), `ro.vat.period.limit_eur`, `ro.vat.exemption.threshold`, `ro.payroll.quarterly`, `ro.micro.employee`, `ro.micro.linked` and `ro.deadline.D112.quarterly` (Codul fiscal in ANAF's consolidation; from 2026, earlier years are gaps). Four readings have review packets for the expert contabil: the linked norm during the year, the mean headcount of the quarterly D112, the two-year rule, and when a supply counts towards the small-enterprise threshold.

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
- Every way a statement comes in goes through one `recordStatements`: MT940 and camt.053 files, CSV exports (`bank.importCsv`) and statements transcribed from a PDF or a photo (`bank.recordStatement`). It accepts only statements `checkedStatements` passed.
- **A statement is recorded once.** A statement with the same content as a recorded one (its financial hash) is that statement: importing it again adds nothing.
- **No day is reported twice.** A statement covers the days from its opening-balance date to its closing date. It may not cover a day another statement of the account covers (`BANK_STATEMENT_OVERLAP`, naming that statement, its format, its days and its file).
  - Why: without the bank's reference, a movement is known by the statement that reports it. The same days imported again from another format (camt.053, then MT940), or a bank's dailies plus its monthly, would count the bank twice.
  - Partial overlaps are refused too: a statement's balances can't be split.
  - One exception, the **hand-over day**. Some banks date the opening balance with the previous statement's closing date (as SWIFT describes field 60F), so consecutive statements share that date. The later one may open on the day the earlier one closes when:
    - it opens at the earlier one's closing balance;
    - it covers at least one more day;
    - it reports no movement on the shared day.
- **Balances chain between neighbours.** A statement that directly follows or precedes a recorded one, with no day between them (the next day, or a hand-over), opens at its closing balance (or closes at its opening). Otherwise it is refused (`BANK_STATEMENT_CHAIN`, naming the neighbour).
  - Why refuse: one of the two documents is then wrong. Recorded statements never change, so the import is the last point where the error is cheap to fix.
  - With days missing between them, a difference may be the missing statements' movements. The statement is recorded with a `STATEMENT_GAP` warning in the import's result. Statements of older or missing periods arrive in any order, as before; the month close still blocks a statement that doesn't continue the previous one.
  - Missing days the balances bridge raise no warning: some banks issue no statement for a day without movements.
  - If the bank uses the hand-over dating and a one-day statement is missing, the next statement looks adjacent and is refused until the missing one is imported first.
- **Database guards** (`statement_overlap`):
  - a statement's days don't overlap another's except by a hand-over;
  - a movement lies within its own statement's days and account, and never on the day that statement takes over.

**CSV exports** (`bank.importCsv`, format `csv`). Banks lay their exports out differently, so a mapping says how to read one; the agent proposes it from the file's first lines and the engine parses every row deterministically (`xfactura-core/src/bank/csv.ts`):
- the mapping fixes the separator, the encoding (a byte the encoding does not define refuses the file: nothing is guessed), the date format, the decimal mark, the header and footer rows, the order, the columns (by number or title: date, value date, a signed amount or debit and credit, description, the bank's reference, counterparty, its IBAN, a running balance) and where the balances come from: the running balance column (each row's balance is checked against the previous one and the movement), two cells, or given in the call, each cited and checked against the cited file's text layer;
- the statement covers the movements' days, or the `period` given; its source is `csv:<from>:<to>`, and the bank's reference, when mapped, identifies movements across formats as camt.053's does;
- a mapping is kept per account (`acc_bank_mappings`, one version per change, written only with a successful import), and the account's latest is used when the call names none.

**Transcribed statements** (`bank.recordStatement`, format `transcribed`). For a PDF or a photo the agent transcribes the rows, each citing the line that shows its amount, and both balances with theirs. On a file with a text layer a citation that does not hold refuses the statement (`BANK_CITATION`); without one (a scan), citations stay unverified, and the balance and chain checks are the safeguard. The citations and their outcomes are kept with the statement.

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

The modules' checks (every row above but the first two, which are the kernel's own) are `Engine.closeChecks`. The worklist runs the same checks on each month not yet closed, so what blocks a close shows before anyone requests it ([The worklist](#the-worklist)).

## The worklist

`work.list` lists everything waiting on an agent or a person, computed on read (`kernel/work.ts`); the kinds, steps and wire format are in [AGENT_API.md](AGENT_API.md#the-worklist). Each detector reads one family with indexed anti-joins and a limit, and resumes at its last item:

- **proposals:** open ones (neither posted nor withdrawn) at their latest version: needing a question (to ask, to answer, or answered and to revise citing the answers), stale by the cached check, blocked, approved or awaiting approval, one item each; those blocked only by `RULE_GAP` are grouped by parameter instead, beside the parameters the company used in the last 12 months whose review horizon ends within 60 days (`rules.horizon` of the register);
- **questions** without an answer or a withdrawal, and **reviewed actions** requested or approved and not executed (a later request for the same input replaces an earlier one);
- **returns** of `obligationsCalendar` over the last 3 and next 2 months that are not filed;
- **determinations** of the current year (and the next one in December): a yearly axis without a fact for the year, or whose fact the books contradict (`determination.missing`), and the thresholds reached at 80% or crossed (`threshold.approaching`);
- **close checks** of `Engine.closeChecks` for each month from the first with entries to the current one that is not closed, one month per call; the earliest month that ended and is not closed is itself an item, unless its close is requested;
- **documents:** groups (or single documents) without a proposal holding their subject (open, or posted by an entry that stands: a reversed booking lists the document again), contracts aside; groups whose copies disagree; open proposals whose current version reads an extracted or uploaded copy of a group with an e-Factura one;
- **bank movements** without a proposal holding them (`bank.movements` shows each movement's `state`: `unexplained`, `proposed`, `approved` by its open proposal's latest version, `settled` by a posted entry that stands; a reversed settlement makes it unexplained again, and the month close finds it so);
- **SPV messages** that differ, failed or carry an error or a buyer's message;
- **evidence** that no record names;
- **automation:** paused scopes (the system's demotions included), templates that graduated without a policy, and partners whose bookings recur without a template (at least 3 in 2 months).

A page stops at its limit or its budget (40 detector calls, 150 ms) and resumes exactly where it stopped. The indexes added for it are on evidence references (documents, statements, profile facts, SPV messages, party statuses, BNR rates' file hashes, and the `evidenceId` of proposal versions' input, an expression index) and on proposal versions' creation time. At 100,000 posted lines, every page stays under 300 ms (`work.perf.test.ts`).

**Dispositions** (`acc_dispositions`, append-only) record that a document needs no booking or an SPV message or a close warning was dealt with (`work.dispose`), with a reason and the item's fingerprint, a hash of its kind, subject and details. The item stays hidden while its fingerprint is that one, and returns when it changes. Only a person decides, except for evidence used nowhere; the database refuses an agent's disposition of anything else (`disposition_person`) and a disposition about anything but a document, an SPV message, a close finding or evidence (`disposition_subject`).

## Questions to people

The kinds (`vehicle.use`, `deferral.schedule`, `payroll.absences`, `evidence.missing`, `choice`, `profile.fact`, and the determinations' `determination.confirm`, `micro.conditions` and `year.figures`) and the operations are in [AGENT_API.md](AGENT_API.md#questions-to-people); the kinds' schemas, prompts and lifetimes in `xfactura-core/src/questions/kinds.ts`.

- `acc_questions` holds each question: kind, subject, parameters, who asked (through which grant) and by when. The database keeps at most one open per kind and subject (`question_open`).
- `acc_question_answers` holds the answers, numbered per question (`answer_sequence`); the latest holds. Each keeps the engine's time it was given at (`engine_at`): when several answered questions about one subject hold, the latest by that time is the one an agent reuses and a treatment reads, never the database's wall time (an answer recorded before the column existed counts as the earliest). Each is by a person (`answer_person`) who is a current owner or reviewer under the epoch recorded (`answerer`), never for a withdrawn question (`question_withdrawn`), and is kept as evidence of type `application/vnd.xfactura.answer+json` (`answer_evidence`), which proposals and facts cite.
- `acc_question_withdrawals` withdraws a question nobody answered (`question_answered`).
- An answer to `profile.fact` records the fact with the answer as its evidence, in the same command. Other answers stay answers: a new profile fact would make every open proposal stale.
- An answer changes what proposals citing it read, so the worker rechecks open proposals after it; asking or withdrawing a question, and disposing of an item, change nothing they read.

## Batches, templates and earned autonomy

The wire contract (inputs, previews, errors) is in [AGENT_API.md](AGENT_API.md#batch-approval); this is what the books record.

**Batches** (`proposals.batch`, `kernel/batches.ts`). A reviewed action naming up to 200 exact versions. Its preview re-evaluates each as posting would and totals the ready ones per account, per tax code and in all; a member that is not the latest version, changed, posted, withdrawn, blocked, stale or carries a warning to acknowledge is a blocking finding. Execution recomputes the preview, refuses the whole batch on any change (`STALE`, naming the members), and in one transaction writes one `acc_approvals` row per member in the decider's name and epoch, with `batch_request_id`, then posts every member in order, each re-evaluated after the ones before (`BATCH_CONFLICT` when an earlier posting changes what it reads). Segregation of duties is checked for each member at approval and again by the database. Guard `batch_member`: such an approval names a version the batch's approved preview lists as ready with its effect hash, is the decider's under the epoch they decided in, and needs no acknowledgement.

**Templates** (`acc_templates`, `modules/templates.ts`, pure parts in `xfactura-core/src/templates/`). A template is a scope (treatment, partner, document kind or movement direction, line words) and a mapping (the part of the input it fixes: an account and deduction or shares per VAT category for `invoices.recognize`, a part naming a road vehicle instead of its deduction, which then follows the answer about the vehicle's use that holds (`vehicle.use`, art. 298); account, months and start for `deferrals.defer`; matching an open item by invoice number or exact amount, or one account, for `bank.settle`). Versions are append-only, numbered without gaps and each written by an approved `templates.request` in its decider's name (`template_version`, `template_request`); a revocation (`acc_template_revocations`, `template_missing`) ends every version. The request's preview backtests the template on the latest 200 postings of its scope that stand, an open item taken as it stood before the posting and a vehicle's answer as the posting cited it. A proposal citing a template that names a vehicle cites the answer about it that holds in its basis (`TemplateSource.answers`): the same answer an agent would reuse, which the person approving sees and whose replacement makes the proposal stale.

**Fingerprints and predictions.** Every proposal version stores `fingerprint`, a hash of what its effect books without the ids it creates (accounts, sides, amounts and currencies, the existing open items settled, tax codes with base, tax and deductible part, schedules). The worker's `templates.predictions` projector records, for every template's current version, what it would book for each document (a group's root, not superseded) or movement in its scope that has nothing posted yet, evaluated on the answers that hold about the vehicles its mapping names (a template naming a vehicle without an answer makes no input): `predicted` with the input and fingerprint, `blocked` when the treatment refuses the input, `not_applicable` when the template makes none. `acc_template_predictions` is append-only, and a prediction for a subject already posted is refused (`prediction_posted`), even once a reversal freed it, so a track record is never written after the fact and each prediction is decided by its subject's first posting. Outcomes are joined, never stored, from that first posting: `correct` (the posted version has the predicted fingerprint and no reversal of its entry was posted), `corrected` (another fingerprint, or reversed), `rejected` (withdrawn, nothing posted), `pending`. Agents' first versions are measured against what was posted the same way.

**Graduation.** A template version graduates with at least 6 correct outcomes across at least 3 months of posting, under the rules (`rulesHash`) of its latest correct one and on the same answers (each question its basis cited, with its answer's value: a changed answer about a car's use starts the run again), and no correction. These are company parameters in `acc_automation_criteria` (with the policy expiry, 90 days), versioned, set by an owner or reviewer (`criteria_person`), never below the defaults (a check constraint): a table rather than profile axes, because a new profile fact makes every open proposal stale. `policies.request` turns a graduation report into a policy bound to the template version and the report (`template`, `graduation`), limited to the partner (`parties`, `knownParty`), the amounts observed (`withinObserved` ×1.5, `maxDocumentAmount`, `monthlyCap`), sources other than extraction (`sourceAuthority`), the answers the run relied on (`answers`) and no warnings, valid from the month's first day for at most `policyDays`; `acc_posting_policies.request_id` names the request. Neither `policies.create` nor `policies.request` may name a return or an SPV operation (`policy_scope`) or a treatment the engine does not know.

**Sweeps.** Creating a policy, or resuming automation, queues a `policies.sweep` job: the open proposals of its treatments are re-evaluated and posted only when the effect hash is unchanged and the policy's conditions hold, each in its own transaction, in the system's name.

**The kill switch** (`acc_automation_events`). Pauses and resumes of the company, a policy or a template, numbered per company (`automation_sequence`); the latest of a scope decides. Any member, an agent or the system pauses (`automation_actor`); only a current owner or reviewer resumes (`automation_resume`); a scope names a policy or template of the company (`automation_scope`). `binding` refuses a policy's entry while the company, the policy or a template it is bound to is paused, or when the version read an extracted document the policy does not allow.

**Demotion** (`automation.demotion` projector). The system pauses a policy, with an `automation.demoted` audit row and an `automation.paused` worklist item, when a reversal of an entry it posted is proposed, when a person's revision drops the template the previous version cited or a posting differs from a template's prediction (every policy bound to that template), and when an open proposal within its template's own scope (treatment, document kind or direction, words, and the partner it names: another supplier's invoice is outside a one-supplier template's scope) meets a new partner (only for a template of any partner), an amount outside what was observed, or an answer other than the one it graduated on (`changed_answer`). Recurring bookings without a template (`template.candidate`) count only postings that stand, and the hint names the vehicle the latest posting named.

**The system principal.** The user `system` (created by the `earned_autonomy` migration) acts for the worker: it posts under policies people approved and pauses, and the audit log shows it as the system. It has no credentials and is never a member (`system_member`), so it cannot approve, decide or create a policy.

## Reports

- `ledger.trialBalance`: balanța de verificare for a financial year or interval. It shows initial balance, previous and current turnover, total sums and final balance per account.
- `ledger.journal`: Registrul-jurnal in recording order.
- `vat.journal`: sales or purchase VAT journal per tax period, with totals per VAT code. These are working registers, not declarations. The tax period is the month, or the quarter (`2026-Q4`) when the company's `vat.period` fact says quarterly; a reversal is reported in its own period and records the period it corrects (`correctsTaxPeriod`).
- `openItems.list`: open receivables, payables and other items with their balances.

## Exports, backup and restore

- `exports.request` needs review permission, or an agent scope for it. The worker rechecks authority when it builds and when it stores the file.
- An export contains every company record and every original file, up to 64 MB of originals. A test fails if a guarded company table is missing from it. Downloads are rechecked on every request.
- `bun run backup <dir>` takes a consistent SQLite snapshot plus the referenced objects. `bun run restore <backup> <dir>` verifies checksums, integrity and foreign keys before activating.

## Worker, jobs and the change feed

The API and the worker build the same engine through `createEngine` (`source/engine/runtime.ts`): the database, the object store, ANAF's validator kits, the ANAF OAuth application and ANAF's public registers, from the same configuration. `bun run worker` loops over three steps and sleeps a second when none had work:

1. **Schedules** (`acc_schedules`: company, kind, rule, parameters, the actor whose authority runs use, next slot). Each due slot queues one job whose id derives from the schedule and the slot (`scheduledJobId`), so workers racing for the same slot queue it once; the schedule moves to the first slot after now, so slots missed while no worker ran run once. The only rule today is `{ kind: "interval", minutes }`. Nothing creates schedules through the API yet; the built-in agent's runs will.
2. **Jobs** (`acc_jobs`, `kernel/jobs.ts`). A handler per kind; today `export` and `policies.sweep`. A worker claims the oldest runnable job of a kind it knows (pending, or running under an expired lease) under a 60-second lease, which the handler renews between long steps (each original file of an export). Only the lease holder stores the result or the failure; a worker that lost its lease stores neither (`LEASE_LOST`). A job interrupted on three attempts fails with its kind's reason. Handlers recheck the requester's authority when they run and in the transaction that stores the result.
3. **Consumers** of each company's audit log (`acc_cursors`: company, consumer, last `seq` handled). A consumer gets a company's next events (up to 500) and the cursor moves forward only when it handled all of them; it never moves back. The `project` consumer runs the projectors:
   - **Proposal staleness.** After an event that may change the books (anything but proposing, revising, requesting reviewed actions or exports, deciding, policies, templates' revocations, the automation switch, access, asking or withdrawing questions and disposing of worklist items; a policy's posting is its own `policies.applied` event), the latest version of every open proposal not checked since that event is rechecked, 100 per run, and cached as `{ version, checked_seq, stale, changed }`. The cursor waits until all are checked. A recheck that fails unexpectedly is cached as stale with its error, so one broken proposal neither blocks the others nor looks current.

   - **Template predictions** and **demotions** ([Batches, templates and earned autonomy](#batches-templates-and-earned-autonomy)).

The change feed is the audit log itself: one row per command with the references its result names (`refs`), plus rows for consequences recorded inside commands. `events.since` reads it for people and agents, redacting what an agent's grant may not read ([AGENT_API.md](AGENT_API.md#change-feed)); consumers read it unredacted.

`acc_jobs`, `acc_outbox`, `acc_schedules`, `acc_cursors` and `acc_proposal_checks` are the mutable tables; every other table, `acc_bank_mappings` and the templates', predictions' and automation's included, is guarded. Exports include schedules (company configuration) but not jobs, cursors or the checks cache, which is rebuilt from the books.

## PFA, II and IF (single-entry books)

The specification, sources and open questions are in [PFA_II_IF.md](PFA_II_IF.md); §7 records what is built.

- **Profile axes:**
  - `entity.form` (srl, pfa, ii, if) and `books.system` (double, single). Without a fact, a company is an SRL on double entry. A PFA, II or IF keeps single entry (OUG 44/2008 art. 15); double entry for them is refused until the expert decides.
  - `cas.status`, `cas.option` and `cass.exception`, as in force on 31 December.
- **Income sources** (`pfa.sources.record`, `pfa.sources.list`):
  - Versioned in the append-only `acc_income_sources`, with each source's CAEN code and method (`sistem_real` or `norma`).
  - The database guards the method's start dates and the 2-year lock of art. 69^1.
- **One kernel:** a PFA's operations post through the same treatments as an SRL's. Treatments meaningful only for double entry are refused (`SINGLE_ENTRY_EXCLUDED`): accruals, deferrals, FX revaluation, the year-end close, dividends, micro tax, S1005.
- **The statutory books are projections of the ledger:**
  - **`pfa.journal`, the Registrul-jurnal de încasări și plăți (OMFP 170/2015):** one row per treasury line.
    - A receipt or payment takes the nature of what it settles, pro rata to the invoice's composition: net, VAT and non-deducted VAT.
    - Payments without a document take their control account's nature.
    - Foreign currency is in lei at the rate of the previous banking day.
  - **`pfa.inventory`:** the Registrul-inventar.
  - **`pfa.fiscalRegister`:** the Registrul de evidență fiscală per source and year (OMFP 3254/2017). It holds:
    - gross income and the deductible expenses, applying art. 68's limits, vehicles at 50% and fiscal depreciation;
    - net income and losses carried forward (70%, 5 years);
    - CAS and CASS by the 2026 bands, then income tax at 10%.
  - Every value is a cited parameter (`ro.pit.*`, `ro.cas.*`, `ro.cass.*`, `ro.min_wage.contributions`).
- **Month close:** a month with a receipt or payment whose nature isn't known doesn't close (`pfa.natures`).
- **D212 (Declarația unică)** is prepared from the tax register for a resident PFA or II with one independent source in the real system.
  - For 2024 income it is written in ANAF's structure D212_A1.0.3 and passes ANAF's validator (J13.0.1, which loads only in ANAF's SAF-T kit). That validator doesn't check the arithmetic, so the writer's own checks do.
  - For 2025 income it follows ANAF's web form (V-1.8.10), which has no published validator. It stops at `prepared`, and can't be authorized while no official validation exists.
  - It's on the obligations calendar, due 25 May of the next year (art. 122 alin. (3)).
  - The 2025 values come from the instructions of OPANAF 2736/2025: tax 10%, CAS 25% in the 12- and 24-wage bands at the 4,050-lei minimum wage, CASS within 6–60 wages, losses at 70%.
    - The expense limits and natures of art. 68 are the 2026 consolidated text. No 2025–2026 act amending them was found; the expert confirms.
    - Income of 2024 and the 2025 rules for income norms are still gaps.
- **Normă de venit:**
  - The preparer gives the norm, with the DGRFP publication as evidence and its coefficients.
  - The register prorates it over the days active and blocks below the 12-wage floor.
  - Gross income above 25,000 EUR in the previous year blocks the norm. Above it in the current year, it notes that the real system applies from next year.
  - D212 writes the norm chapter (`cap12`): for 2024 income only for an activity started in December, as ANAF's 2024 structure allows. The rules for 2025 norms are still a gap.
- **Family enterprise (IF):**
  - Its members, with their quotas and a representative, are kept append-only in `acc_enterprise_members` (`if.members.record`, `if.members.list`). Members' CNPs are sealed.
  - The register distributes the net income or loss by quota, with the largest remainder, so the shares add up exactly.
  - Each member's D212 carries their share.
  - **D204** is prepared from the register and members, and passes ANAF's validator (J3.0.14). The validator doesn't check quotas, net income or the shares' sum, so the writer's own checks do.
  - The D204 deadline is on the calendar with both readings: the end of February (Codul fiscal art. 125 alin. (4), OPANAF 470/2021) and 15 March (norme pct. 41 alin. (4)). It is shown due at the earlier.
  - An IF on a norm, and a change of agreement within the year, are refused.
- **Not built yet:**
  - D212 for several sources and income outside the books;
  - several sources in one year, and a mid-year change of method;
  - double entry for PFAs.

## Not implemented

- **Not built yet:**
  - booking receipts recorded with `documents.record` (`receipts.recognize`) and their VAT;
  - verification of the Ministry's signature; B2C identification;
  - VAT categories other than S/O, domestic reverse charge, goods across the border, pro-rata; D394 for simplified invoices and receipts; reading the P300 file;
  - payroll beyond salary in money, vouchers, annual leave and sick leave for ordinary illness (other indemnity codes, benefits in kind), and corrections of a posted month;
  - asset revaluation; revolving credit lines and overdrafts;
  - VAT deducted from receipts and simplified invoices; cash payments in D406's payments section;
  - stock;
  - profit tax, interim dividends, dividends to non-residents;
  - the statements of small and larger entities; physical inventory and provisions.

[ROADMAP.md](ROADMAP.md) orders this work.
