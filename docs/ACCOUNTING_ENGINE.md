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
- **Outside VAT** (`vat.status` `non_vat` at the tax point, V1):
  - **Purchase:** the VAT is owed all the same (art. 307 alin. (2)), at the standard rate, and is never deducted: `deduction` must be `none` (`DEDUCTION`). It is owed to the budget through the special return (D301, art. 324), on the account `ro.vat.special.payable_account` gives (4423), as an open item of the tax authority (`authorityId`, required) due by the 25th of the next month (`ro.deadline.D301`): Dr expense net / Cr 401; Dr expense VAT (non-deductible) / Cr 4423. Its tax entries keep the codes `RC-EU-SERV` or `RC-NONEU-SERV`, without a VAT line, marked `regime: special`.
  - **Sale** to an EU business: no Romanian VAT, as for a payer (`EXP-EU-SERV`).
  - **The art. 317 code** (`vat.eu`, `special`): needed before buying services from a supplier established in another member state or supplying them to a business there (art. 317 alin. (1) lit. b)–c)). Without it the booking warns (`ART317_REQUIRED`, ack: the VAT is owed anyway); with the fact unknown it asks (`profile.fact` `vat.eu`). Services from outside the Union need no code (norme pct. 90 alin. (4)).
- **Refused:** a domestic partner, an invoice that already charges VAT, an EU customer without a VAT code, a non-payer's purchase that deducts or names no authority.
- **Open for review:** which e-Factura VAT category a Romanian supplier uses for services sold to EU businesses (ANAF's guide reserves AE for art. 331); the tax point of continuous services; the account of a non-payer's D301 VAT (4423 directly, or 4427 settled into 4423: `ro.vat.special.payable_account`'s review packet).

### `vat.lateRegistration` and `vat.capitalGoods`: a change of VAT regime (V1)

A company outside VAT that exceeds the small-enterprise threshold (395,000 lei, art. 310 alin. (1)) must ask to register by the day it exceeds it; the registration is valid from that day, whether it is asked on time, late (alin. (6^2) lit. a)) or made by ANAF (art. 316 alin. (1^1) lit. b), f)), and the normal regime applies from the transaction that exceeds it (alin. (6)). The `vat.status` determination proposes the registration from that day; `vat.registration {year}` (read) shows the crossing day and invoice, the supplies of that day before it (which may stay exempt), whether the books show the registration late (sales without VAT after the crossing day), and the VAT owed for it.

- **`vat.lateRegistration`** (art. 310 alin. (6^2)–(6^3)): the VAT the company should have collected from the crossing day to the last sale it made without VAT (`from`, `until`), less what it could have deducted, booked on the first return after registration.
  - It reads the books over the range: revenue on 70x (the supplies), less the supplies abroad (`EXP-…` bases) and the supplies of the first day booked before the transaction that exceeded the threshold, which the company leaves exempt (`excluded`, alin. (6), last sentence).
  - **The price**: the customers did not pay VAT, so the price is taken to include it (21 × 100 / 121, norme pct. 36 lit. b) pct. 4), with the company's statement that it cannot recover it (`considerationEvidenceId`). VAT added on top of the price is invoiced to customers by correction invoices (art. 330), which are not covered (`CONSIDERATION_ADDED`).
  - **The deduction**: every purchase of the range that charged VAT and was booked without deduction is listed with what may be deducted now (`full`, `limited`, `none`, art. 297–298); one left out blocks (`PURCHASE_UNDECIDED`).
  - **Booking** (`ro.vat.late_registration`): Dr 635 / Cr 4427 for the VAT collected (tax entry `REG-310`, D300 rd. 16) and Dr 4426 / Cr 7588 for the VAT deducted (rd. 33), in the posting date's VAT period; `vat.settle` settles them with the period.
  - **Refused:** a registration not recorded from `from` (`vat.status` `normal_vat`, with the certificate), an invoice with VAT inside the range (`RANGE_CHARGED`), a change of the standard rate inside it (`RATE_CHANGE`), stock or assets in progress at the crossing day (`STOCK_ADJUSTMENT`, art. 304: not covered).
  - The VAT ANAF establishes by decision (alin. (6^1)) is booked from the decision by the tax account (`tax.decision`, an assessment expensed on 635; its rd. 39 when unpaid), not here.
- **`vat.capitalGoods`** (art. 305 alin. (5) lit. a) and c)): on entering the normal regime from the exemption, or leaving it, the capital goods' VAT is adjusted once for the whole adjustment period left, the change's year included: a fifth (a twentieth for buildings) of the VAT not deducted (entering) or deducted (leaving) for each year left of the period that starts on 1 January of the acquisition's year (`ro.vat.capital_goods`).
  - **Input:** the event, the change's date, every tangible fixed asset (21x) held then with its acquisition invoice and VAT period (one left out blocks, `CAPITAL_GOOD_UNLISTED`), the inventory at the change (norme pct. 83 alin. (7), (11)).
  - **Booking:** entering, Dr 4426 / Cr 7588 in the first return after registration; leaving, Dr 635 / Cr 4426 in the last return (its tax point is the day before the cancellation), both tax entry `ADJ-305`, D300 rd. 34 (`R31_2`), signed.
  - **Not covered (UNSUPPORTED):** assets bought before 2016 (art. 306, `ART306`); on leaving, the adjustment of stock, assets in progress, unused services and advances (art. 304, norme pct. 83 alin. (7) lit. a), d)), refused while 3x, 231, 4091, 4092 or 471 hold a balance (`OTHER_ADJUSTMENTS`).
- **Leaving VAT** (art. 310 alin. (7), art. 316 alin. (11) lit. g), (13)): the cancellation is recorded as `vat.status` `non_vat` from the decision's communication, with the decision; the `vat.status` determination checks it is allowed (neither the previous year's turnover nor this year's up to it above the threshold). The last D300 covers the period up to the day before, due by the 25th after the month of the communication, and holds the adjustments; `vat.registration` shows it and the capital goods' adjustment to book.
- **Parameters** (all `extracted`, from 2026, reviewed through 2026-12-31, each with a review packet for the expert contabil, `src/ro/reviews/specs/nonpayers.ts`): `ro.vat.special.payable_account` (4423), `ro.vat.late_registration` (rd. 16 and 33; 635 and 7588), `ro.vat.registration.annualized` (days), `ro.vat.capital_goods` (5 and 20 years, rd. 34; 635 and 7588); and `ro.deadline.D301`.
- **Agent-ready** (`ro/nonpayers/agent.ts`): the documents it takes (the art. 316 and art. 317 certificates, the cancellation decision, ANAF's VAT decision, the statement that VAT cannot be recovered from customers, the inventory, the foreign suppliers' invoices), its questions (`determination.confirm` for `vat.status` and `vat.eu`, `profile.fact`), its detectors (`threshold.approaching`, `determination.missing` for a registration or a code due, `obligation.due` for D301, D390 and the last D300) and no template fields (`invoices.crossBorder` is not a template treatment yet).

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

### `tax.profit`: profit tax of a quarter or of the year (P1)

The profit tax of a Romanian legal person (Codul fiscal title II) under the quarterly system (art. 41 alin. (1)). The pure code is in `xfactura-core/src/ro/profit` (the bridge, fiscal depreciation, loss vintages, the fiscal register, `agent.ts`) and `src/ro/treatments/profit-tax.ts`.

- **Input:** the period (`2026-Q1`…`2026-Q3`, or the year `2026`: the fourth quarter is the year's), the posting date (from the quarter's end within the year; the year's last day for the year, in its own books, before the result is closed), the tax authority, a round, `determinations` (amounts no account holds apart, each with its evidence and letter of the law), `legalReserve` (the decision by which the company sets aside the legal reserve) and `rectification`.
- **Where it starts:** 1 January, or the first day of the quarter in which the recorded `income_tax` became `profit` after the company was a micro-enterprise (art. 52 alin. (1)–(4), (6), (7)); then the revenues and expenses are those from that quarter on, and the favourable FX difference of the micro months (765 − 665) is an item similar to revenue (art. 53 alin. (2) lit. b)), unless the exit was in the first quarter.
- **The system** (`profit.system`): quarterly, by law after a micro year (art. 41 alin. (6) lit. d)), otherwise the company's fact; the annual system with prepayments (alin. (2)–(3), (8)–(10^1)) is refused (`PROFIT_ANNUAL_SYSTEM`).
- **The bridge**, row by row as D101 declares it, cumulated from the start: every account of classes 6 and 7 by its nature (`profit/accounts.ts`, the longest prefix of the chart deciding; analytics take their synthetic's nature unless classified themselves):
  - by their nature: 691 not deductible (rd. 23, art. 25 alin. (4) lit. a)); book depreciation (6811) and the book value of assets disposed of (6583) added back (rd. 28) and replaced by fiscal depreciation (rd. 11, art. 28 alin. (17)); provisions and impairments (6812–6817, 6863–6864) added back (rd. 29) unless a determination states what art. 26 allows (the receivables' 30% of lit. c) computed from the stated base, guarantees, insolvent debtors, insured assets); their reversals taxed unless stated non-taxable (art. 23 lit. d), rd. 20); 641 the base of the social limit;
  - by a person's classification (`profit.account`, held until it changes) of the accounts whose treatment depends on facts (623, 642, 6456–6458, 654, 6581, 6582, 6587, 6588, 668, 698, 761, or any other account a person classifies): protocol within 2% of the accounting profit with the profit tax and the protocol added (rd. 26, art. 25 alin. (3) lit. a)), social expenses within 5% of the salaries (rd. 33, lit. b)), fines and penalties owed to authorities (rd. 25, alin. (4) lit. b)) or contractual penalties (deductible), sponsorship (rd. 27, and the credit below), a vehicle's costs (50% not deductible, the VAT kept included, when the `vehicle.use` answer limits it, lit. l) and norme pct. 16; never on a depreciation account), non-deductible with the letter of art. 25 alin. (4) (rd. 33), dividends from a Romanian company (rd. 17.1, art. 23 lit. a), which then require the allocation of their expenses as a determination, art. 25 alin. (4) lit. e), rd. 32), other non-taxable revenue with its letter (rd. 20);
  - an account that needs a classification and has none blocks with the question (`PROFIT_CLASSIFICATION`), never guessed;
  - the legal reserve, when the company sets it aside: 5% of the accounting profit with the profit tax, until a fifth of the capital (1012) less the reserve at the year's start (1061), at each quarter (norme pct. 19 alin. (1)) (rd. 13); without it an SRL with capital and a profit acknowledges `LEGAL_RESERVE`.
- **Rounding:** each row is rounded once from bani to whole lei (`ro.declaration.rounding`); the derived rows are derived from those, so the tax booked is the tax the return declares; limits (70% of the losses, the sponsorship's) are rounded down, never above the law's.
- **Losses** (art. 31): the vintages at the year's start come from the latest earlier annual computation, else from a person's answer for the books' start (`profit.losses`, with the D101s filed; `PROFIT_LOSSES` until then). Each is usable in the calendar years its version allows after its own (`ro.profit.loss_carryforward`: 5 for losses from 2024, what is left of 7 for those of 2016–2023), recovered in order at each payment within 70% of the profit, cumulated over both kinds (alin. (8)) (rd. 39, 39^1). The year's loss becomes a vintage (rd. 40^1). Whether years spent as a micro-enterprise count is an expert question.
- **Tax and credits:** 16% of the taxable profit (`ro.profit.rate`); the sponsorship credit, the least of the sponsorship, 0.75% of the turnover (70x net of 709, plus 7411) and 20% of the tax (rd. 43, art. 25 alin. (4) lit. i)), at each quarter; nothing is carried forward (rd. 43.2 is not covered). Other credits and exemptions (rd. 42, 44, 45) are not covered.
- **Scope checks:** the minimum turnover tax (art. 18^1) applies only above 50 million euro of the previous year's turnover, until 31.12.2026: with the previous year in the books it is checked (gross 70x credits against the threshold at that year's close rate) and refused above it; without it the reviewer acknowledges `PROFIT_MINIMUM_TAX`. Exceeding borrowing costs (666 − 766) above 500,000 euro at the period end's rate are refused (`PROFIT_INTEREST_LIMIT`, art. 40^2).
- **Effect:** a quarter books the cumulated tax less what the year's earlier quarters booked (Dr 691 / Cr 4411, an open item of the authority); a quarter with nothing due, and a year whose tax equals its quarters', post a memorandum (no lines) carrying the computation; a year that owes less books the difference back (Dr 4411 / Cr 691, an item to recover). A quarter after one never computed acknowledges `PROFIT_QUARTER_MISSING`.
- **The position** each posting records (`explanation.details.position`: the D101 rows, the tax cumulated, declared and due, the loss vintages before, used and after) is what the next computation, the returns and the registers read (`ReadPlan.profitPostings`: the postings that stand of `tax.profit` and `correction.priorYear`).
- **Refused:** a company not on profit tax at the period's end (`NOT_PROFIT`), a profit start that is not a quarter's first day after micro (`PROFIT_START`), a year whose result is closed (121 moved: `YEAR_CLOSED`, the year's tax is booked before the closing), a missing parameter (`RULE_GAP`: every key is read from 2026, the loss years excepted).

### `correction.priorYear`: a material error of an earlier year (FP-03)

The correction on retained earnings (1174) of a material error of an approved earlier year (OMFP nr. 1.802/2014 pct. 65–68), never through this year's classes 6 or 7: the lines (an omitted supplier invoice opens its payable), the year corrected and the change of its taxable result (`fiscalChange`, negative for a deductible expense omitted). It acknowledges `PRIOR_YEAR_D101`: the year's D101 is rectified (art. 19 alin. (3) lit. a)). `tax.profit` with `rectification` for that year then starts from the year's last position, adds the corrections posted since as items similar to revenue or expenses (rd. 8, rd. 9), recomputes the losses from the vintages the year started with and the tax, keeps the sponsorship credit within 20% of the new tax, and books the difference on 1174 (Dr 4411 / Cr 1174 for less tax), acknowledging `PROFIT_DOWNSTREAM` (the later years' loss vintages are not re-evaluated automatically). A year the books do not cover refuses (`PROFIT_YEAR_OUTSIDE`): its rectifying D101 is filed outside the engine, which the worklist asks a person to record (`obligation.filed`, D101).

### `dividends.distribute` and `dividends.withhold`: dividends

- **Distribution:** the shareholders' decision as evidence, its date, and each shareholder's gross dividend. Dr 1171 / Cr 457, an open item owed to each shareholder. The total may not exceed the retained profit on 1171 at the decision date. Interim dividends are not supported (their account, 463, is not in the chart yet).
- **Withholding,** when a dividend is paid (or on the year's last day for dividends distributed and still unpaid, art. 43 alin. (3)): the gross paid, the distribution it comes from, and the tax authority. Dr 457 / Cr 446, owed to the authority, at `ro.dividend.tax_rate` for the distribution date: 16% for individuals (art. 97 alin. (7)) and for Romanian companies (art. 43), from 2026. The net is then paid through `bank.settle` against the same 457 item.
- **Refused:** paying more than is owed or before the decision, and non-resident shareholders. For a company shareholder, the reviewer confirms that the exemption of art. 43 alin. (4) does not apply; an exempt dividend is paid gross with nothing withheld.

### `assets.depreciate`: a month's depreciation

- **Register:** `assets.register` records a fixed asset's card: inventory number, the catalogue code (HG 2139/2004, a text still to obtain), its account (20x, 21x), depreciation (28x) and expense (68x) accounts, entry value, accounting and fiscal lives in months, commissioning date with its record, and the purchase invoice. `assets.list` shows each with the depreciation booked and the value remaining.
- **Effect:** for the month, straight-line depreciation of every asset commissioned in an earlier month (OMFP 1802/2014 pct. 238): Dr 68x / Cr 28x, each asset's line carrying it as its item, so the ledger holds its accumulated depreciation. The monthly parts are rounded so they add up, and the last month reaches the full value.
- **Refused:** a month in which an asset's booked depreciation is not that of the months before (a month missed or booked twice), and a month with nothing to depreciate.
- **Disposal:** `assets.dispose` records that an asset left use, with its record; `assets.derecognize` then takes it off the books (Dr 28x depreciation booked, Dr 6583 the value not recovered / Cr its account). Whether the disposal month is depreciated is the company's policy `policy.assets.disposal_month` (included or excluded); without it, depreciation and derecognition of that asset stop. A sale is invoiced separately.
- **Fiscal depreciation (art. 28)**, kept apart from the book depreciation: `assets.recordFiscal` records an asset's fiscal basis, versioned in the append-only `acc_asset_fiscal` (guard `asset_fiscal_version`): the method (linear, degressive with the 1.5/2.0/2.5 coefficients and the switch to linear of norme pct. 25, accelerated at most 50% in the first year, superaccelerated at most 65% for new assets of subgroups 2.1 and 2.4 put into use in 2026, deducted in full when put into use for work safety, medical offices or below the 5,000 lei value, or none), the fiscal value, the normal life (the card's fiscal life unless given), the first year's share and whether it is an M1 car capped at 1,500 lei a month (alin. (14); at disposal the value left up to 1,500 lei times the months left, norme pct. 27). Fiscal depreciation runs from the month after commissioning to the month before disposal, when the fiscal value left is deducted. `assets.list` shows each asset's basis; the profit tax blocks on an asset in use without one (`ASSET_FISCAL`), and the worklist lists it (`asset.fiscalMissing`).
- Revaluation and impairment are not built yet.

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
    - F30's other chapters come from the registers (below); still given rather than read: F20 rd. 01a and chapter XIX's rows without accounts.
- **Annual statements (small entities, S1003 for 2025):** OMF nr. 2.036/2025 anexa nr. 1 pct. 2.2: the abridged balance sheet (F10, the microentities' form F10_BS, read with the same formulas), the profit and loss account in full (F20, OMFP nr. 1.802/2014 pct. 600, rows 01–70), F30 for the larger entities (anexa nr. 4 pct. 7) and F40 (the microentities' form). Core `src/ro/annual/s1003*.ts` on the statements' shared machinery (`form.ts`: identification, rule DSL, completion, checks, XML; S1005 runs on it unchanged). F20's account formulas are chapter XIX's of S1005, row for row (`s1003F20FromS1005Xix`); the rows, codes and labels are transcribed from ANAF's form and structure and checked against the schema s1003_20260210.xsd; the controls are the structure's (F20_1–42, F30_1–100, F10_F20_1–4, F10_F30_1–4, F10_F40_1–6, with F10_BS and F40 shared). The structure's null rows (F20 rd. 01b, 05, 38, 67; F30 rd. 170e, 170f, 165b col. 1) are never written. ANAF's validator J14.0.0 for 2025 checks the schema, the identification (R22a, the CAEN lists, the namespace) and the ranges, but its 2025 rule set holds none of the form's arithmetic (2024's did): the arithmetic is the writer's check alone, as errors, and the official test pins that the validator accepts what only the writer rejects. Only 2025: 2026 is a `FORMAT_GAP` until ANAF publishes its package.
- **F30 from the registers** (both statements; core `informative.ts`, engine `modules/annual.ts`): chapter I from F20; chapter II's supplier debts past their due date by days overdue (over 30, 90, 365; 401/403/408 current activity, 404/405 investment), asked when an invoice has no due date; chapter III from the employment contracts (the 12-month mean, rounded half up, and the employees on 31 December); chapter IV's overdue receivables from the open items, the state or private split asked; chapter VIII's balances on their side (gross, per partner on the accounts kept on open items), the non-resident parts from the partners' country, the "din ct." parts 0 when the accounts have no balance and asked otherwise, an SRL's capital all social parts; chapter IX from 621; chapters XV and XVI from the dividends booked (Dr 117 or 463 / Cr 457); S1003's chapter XIX (calamities) from 6587. Everything else is asked by chapter (`annual.informative`: the rows asked, or "nothing to report", with the documents), the previous year's flow rows too when that year is not kept. A chapter unanswered refuses the preparation (`F30_CHAPTER`); an answer for a row not asked is refused. Informative rows with nothing to report are left out of the XML (ANAF's parser refuses an element with more than 200 attributes); chapter I and S1005's chapter XIX keep their zeros.
- **Notes and accompanying documents** (`documents.ts`): owed with the statements are the explanatory notes (small entities; microentities the pct. 576 alin. (2) items), the administrators' report (Legea 82/1991 art. 28 alin. (7), art. 29 alin. (1); OMFP pct. 489–492, without pct. 491 alin. (1)'s non-financial items), the proposal to distribute the profit or cover the loss (art. 29 alin. (1)), the declaration of art. 30, and the audit or censors' report when the statements are audited or verified. The engine drafts the first four from the books, the accounting-policy facts (`policy.*`), F40 and a person's disclosures (`annual.disclosures`: parent company, commitments and off-balance-sheet arrangements, advances to management, exceptional items, debts after five years and secured debts, events after the balance sheet date, related-party transactions, going concern); what is a judgment (risks, the foreseeable development, the profit's destination) is left marked for the administrator. Each is owed until a person supplies the signed file (`annual.document`, tied to the draft's hash). The notes follow the stored OMFP nr. 1.802/2014, which is its 2014 text (pct. 468–469 and 471 lit. a), m), p), q), r) for small entities); the consolidated numbering is for the expert.
- **Signatures** (art. 28 alin. (10), (11), (13); OMF pct. 1.6): the prepared statement records its signature roles: the administrator, and the accountant with quality 11–13 (employed: the books must show an employment contract in the year, else `SIGNATURE_NOT_EMPLOYED`) or 21–22 (a CECCAR member, with membership number and fiscal code). Authorizing checks them (`SIGNATURE_*`) and that every owed document was supplied (`DOCUMENT_MISSING`), through the declaration framework's `authorization` hook.
- **The inactivity declaration (S1046):** a company that states it has carried out no activity since it was set up (`activity.none`, a person's fact with evidence) files S1046 instead of statements within 60 days (art. 36 alin. (2), OMF pct. 3.3); it is refused when the books show revenue or expense. Statements prepared from books with no revenue or expense ask the fact (`ACTIVITY_UNKNOWN`), never assume it. Structure A1.0.0 (an ≥ 2015), validator J1.2.0; only 2025 is written.
- **The half-year report** (`half-year.ts`, `ro.halfyear.report`): owed for 30 June 2025 by the entities whose net turnover of 2024 exceeded 1.000.000 € at the BNR rate of the year's close (OMF nr. 1.194/2025 art. 2, anexa pct. 16–17, by 18 August 2025); none for 2026 (no order, and ANAF lists no S1027–S1050 for 30 June 2026). The engine does not prepare it: when owed, the worklist shows it as a case outside the engine.
- **Agent-ready** (`ro/annual/agent.ts`): document types (the signed statements and documents, the shareholders' decision, the audit report, the shareholders' register, contracts, ANAF's statement of account), the three question kinds and `profile.fact` for `activity.none`, the `annual.input` detector (chapters, disclosures and documents a person owes; the half-year report owed), no template fields. `annual.ask {kind, year}` (agents may) opens the questions; the worklist's step is that.
- Not built yet: the physical inventory and its differences, provisions, and the statements of medium and large or audited entities (S1002, UNSUPPORTED).

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
    - **D406:** one VAT rate spans the principal (167) and the interest (666). The principal's line is the base of its part, and the lines it brings (the VAT it does not deduct on its `vatExpense`, the exchange difference on 668/768 or 6651/7651) carry no VAT. The principal leaves 167 at its carrying amount, not at the invoice's rate, so its line is written in lei. Each invoice line goes to the part whose amount it makes up, the only grouping that adds up (otherwise `D406_SPLIT`), as a service (art. 271 alin. (3) lit. a)). Passes ANAF's SAF-T validator.
- **Operating lease:** the lessor's invoices on 612, through `invoices.recognize`.
- **`fx.revalue`** revalues foreign-currency loans and their interest.
- **`loans.list`** shows each loan with its balance, schedule and the part due within 12 months. The reclassification of pct. 360 is presentation only, so it's not booked.
- **Month close:**
  - interest not accrued for an open loan blocks (`LOAN_INTEREST_DUE`; not on single-entry books);
  - a lease instalment due (`LEASE_INSTALMENT_DUE`) or an overdue loan (`LOAN_OVERDUE`) is a warning.
- **Not covered yet:**
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

An agent reads a PDF or a photo (`evidence.read`: text by line, or the image for its own vision model) and records what it read with `documents.record`: an invoice or credit note in the UBL parser's shape (`extracted-invoice-1`), a fiscal receipt (`extracted-receipt-1`), a contract (`extracted-contract-1`), or ANAF's decisions and statement of the account (`extracted-tax-decision-1`, `extracted-tax-statement-1`, [The tax account](#the-tax-account-t2)), each field citing `{ page, line, text }` of the file's text layer. The body and the checks are pure (`xfactura-core/src/documents`); the wire contract is in [AGENT_API.md](AGENT_API.md#documents-from-pdfs-and-photos).

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
3. `declarations.authorize.request` is a reviewed action on the exact XML. Its preview recomputes the inputs; if the books changed since preparation, or the return is not validated, it blocks. A kind may add what authorizing it needs (`authorization`): the annual statements' signature roles and accompanying documents. Executing it locks the tax period: from then on, an entry adding tax to that period is refused, by the proposal and by the database.
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
- the previous period's return in the engine supplies the negative balance carried forward (rd. 41) unless it requested a refund, and becomes an input: replacing it makes this return stale. Its payable still unpaid (rd. 38) is what the books have not paid of earlier periods' VAT settlements (4423, the payments matched by `tax.pay`), in whole lei and never more than its rd. 45; VAT differences established by a decision and unpaid (rd. 39) are the 4423 items `tax.decision` booked. Both read the 4423 items, so a payment booked after preparation makes the return stale. For the first period kept in the engine, the previous balances are given explicitly (`previous`). A refund is requested only for a negative balance of at least 5,000 lei, by the option `refundRequested` or a person's answer to `vat.refund` (`VAT_REFUND_CHOICE` without either). Rd. 42 (negative differences established by inspection) is not produced: a decision with negative principal is not booked.

A **change of regime** (V1): the return covers the days of the normal regime only, so the first one after a registration starts on the registration day and the last one before a cancellation ends the day before it (art. 310 alin. (7), art. 316 alin. (13)); a company registered during a period passes `NOT_VAT_PAYER`. The VAT of a late registration goes on rd. 16 (base and VAT) and rd. 33 (base and the VAT deducted), the capital goods' adjustment on rd. 34 (`R31_2`, signed), neither in rd. 31. The entries of the days a posted `vat.lateRegistration` declares are its own, not their period's; sales booked without VAT after the registration day and not declared by one block the return (`D300_LATE_REGISTRATION`). Where the late registration's amounts go (rd. 16 and 33) is an interpretation awaiting the expert's review (`ro.vat.late_registration`). The D394 of such a period lists the invoices of the days of the normal regime only, without the regularization entries, which are no invoices.

Operations without a row yet (goods across the border, domestic reverse charge, exemptions, imports) block the return rather than being left out. Monthly returns are type L and quarterly ones type T; semiannual and annual returns are not produced.

**D390 (VIES recapitulative statement)** lists a month's intra-Community operations by partner, from ANAF's structure "D390 XML 2020" (namespace v3): services supplied to EU businesses as type P and services acquired from EU suppliers as type S, each partner's bases summed and rounded to whole lei. It is monthly even for quarterly VAT payers, reads the month's entries by their tax point, and is informative: authorizing it locks no tax ledger. ANAF's validator checks every partner's VAT code against its country's algorithm. Goods (L, T, A, R) are not produced yet. Outside VAT it is the art. 317 code holder's (art. 325 alin. (1)): without `vat.eu` `special` it is refused (`D390_NO_CODE`).

**D301 (special VAT return)** is written by `xfactura-core/src/ro/declarations/d301.ts` from ANAF's structure D301_A2.0.0 (from 01.01.2016, OPANAF nr. 592/2016, schema d301_20200130.xsd, namespace v1; validator J1.2.5, still the version ANAF's page publishes) and prepared for a month from the books of a company not registered under art. 316: the services bought from suppliers not established in Romania (the `RC-…` output entries whose tax point is in the month, on a day outside VAT) in section 4, those from suppliers established in the EU again in section 4.1, one line per invoice with its number and date, its value in its currency, the BNR rate the books used for VAT, and the base and VAT rounded to whole lei by `ro.declaration.rounding` (the structure's baza = round(val_valuta × curs, 0)). `pers_inreg` is 2 for the art. 317 code holder, 1 otherwise; nr_evid and the control sum are the structure's (ANAF's validator accepts a control sum one leu off, not more). It is due by the 25th of the next month, only for the months with such VAT (art. 324 alin. (2), `ro.deadline.D301`), and authorizing it locks the month's VAT ledger. A purchase reversed in a later month is a rectification of its month's return (`D301_REVERSAL`); intra-Community acquisitions of goods (sections 1–3) are not produced. In the month a company registers, a D301 for the days before and the D300 from the registration would both lock the month: not covered.

**D394 (domestic supplies and acquisitions)** is written by `xfactura-core/src/ro/declarations/d394.ts` from ANAF's structure of 15.09.2025 (namespace v5, periods from 08/2025), with the partner counts, summaries and control sum ANAF's validator checks. From the books, for the company's VAT period (monthly L, quarterly T):
- domestic invoices of the period's VAT ledger, grouped by partner and rate: supplies (L) and acquisitions (A), with the number of invoices, and base and VAT rounded to whole lei; credit notes reduce their group;
- a partner is registered for VAT when its code on the invoice is RO followed by a valid CUI; other customers are reported with their CUI or CNP, or, without one, by the address of their invoicing details; a supplier charging VAT without a VAT code blocks the statement;
- the series are those the engine issued in the period (the range allocated and the numbers issued), the issued credit notes are listed as storno invoices, and invoices issued outside them (the previous invoicer) must be declared with their ranges and count;
- an issued invoice not yet in the VAT ledger, and a refund requested by the period's D300 without the nature of the operations (or the reverse), block it;
- the header takes the company's invoicing details and, as options, the CAEN code, phone, representative, who prepared it, and the consent and affiliated-persons answers.
Services across the border are not in it (D390 and D300 report them); simplified invoices and receipts are not produced yet.

**D112 (contributions, wage tax and the insured)** is written by `xfactura-core/src/ro/declarations/d112.ts` from ANAF's structure for months from 07/2026 (namespace v7). From the books it declares the month's posted payroll run: each employee's insured type (51 with the minimum-wage relief), contract and hours, days, bases, contributions withheld and borne by the employer (obligations 458 and 459), deductions, tax and the amount paid, the CNP opened from its seal for the declaration only; CAM is computed once on the employer's total. Amounts must be whole lei. It locks no tax ledger. The unemployment base (A_9) is declared as the salary paid in money, an interpretation awaiting the expert's review.

A **quarterly** employer (`payroll.period`, art. 80 alin. (2), art. 147 alin. (4)–(5)):
- It keeps the monthly computation and files one D112 per month, each by the 25th after the quarter.
- A month with sick leave or a contract ended is filed by the 25th after it, together with the quarter's months before it (art. 147 alin. (11); OPANAF 605/2026 anexa 6 cap. I). The text says so for the end of insurance in the second month; the engine reads sick leave the same way, an expert question (`ro.deadline.D112.quarterly`).
- The payroll posting gives the tax and contributions owed their payment day, after the month or the quarter by the year's own `payroll.period`, which alin. (11) does not move.
- The prepared D112 states its filing schedule in its summary (`filing`). The XML is the same in both regimes.
- The monthly option (art. 147 alin. (8)) is the year's determination as confirmed.

**D100 (obligations to the state budget)** is written by `xfactura-core/src/ro/declarations/d100.ts` (namespace v2, periods from 01/2026) and prepared for a month from the books: the micro-enterprise tax posted for the quarter (121, the amount on 4418, not computed again), in its last month; the profit tax of quarters I–III (103, model 8#: what the quarter's `tax.profit` booked on 4411, zero for a memorandum; the fourth quarter is D101's, refused in December); and the dividend tax withheld in the month, for individuals (604) and companies (150), with, in December, the tax on dividends unpaid at year end. The fourth quarter's micro tax is due by 25 January in ANAF's structure and by 25 June in its validator; the company chooses (`fourthQuarterDue`). A correction of a filed D100 is a separate form (D710): the worklist asks for it when the books change after filing, and a person records it filed outside the engine ([The tax account](#the-tax-account-t2)).

**D101 (annual profit tax return)** is written by `xfactura-core/src/ro/declarations/d101.ts` (OPANAF nr. 206/2025, ANAF's structure of 26.01.2026, namespace v10 as ANAF's validator J11.0.4 requires; years ending from 2024) and prepared for a year from the year's posted computation (`tax.profit` for the year, or its rectification, which makes the return rectifying, `d_rec` 1): every row as the position recorded it, never computed again; the period from the quarter of the micro exit (`trim_micro`, `Data_I`) to 31 December; the due date 25 June of the next year (`scadenta`, the structure's rule since 26.01.2026), the payment number and the control sum (the main rows P1–P53, as the validator's R19 adds them); the CAEN code is an option. `checkD101` repeats the structure's formulas and its validations V1–V8. Not written: a modified fiscal year, dissolution, the fiscal group, BNR/ASF entities, the art. 225/227 regularisation.

**D205 (tax withheld, by beneficiary)** is written by `xfactura-core/src/ro/declarations/d205.ts` (namespace v3, years 2025–2026) and prepared for a year from the posted dividend withholdings: one record per individual shareholder, with the dividends distributed, paid and unpaid at year end and their tax; companies are not declared in it. An individual's CNP is recorded once (`parties.recordCnp`, kept sealed like employees'). Whether the dividends paid are declared gross or net the instructions do not say: the company chooses (`paidAs`).

**D406 (SAF-T)** is written by `xfactura-core/src/ro/saft/d406.ts` (schema 2.4.9, periods from 07/2025) and prepared for each VAT period (L monthly, T quarterly; it must match `vat.period`), and for each financial year as the annual assets file (A, below).
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
- **Taxes other than VAT:** payroll's lines (CAS, CASS, the income tax, CAM) carry TaxType 000 and TaxCode 000000. For taxes other than VAT and those withheld at source, ANAF lets the company report either the tax's own TaxType (412, 432, 602, 480, 458, 459) with TaxCode 000000 or the generic 000, and recommends the generic one (ANAF's answers v1.2, MF.TT.2, option 2). Tax withheld at source (dividends, interest) must carry ANAF's WHT codes on the payment's line: a period with withholding is refused (`D406_WHT`) until they are written. The pinned definitions (05.02.2026) lack the code for an individual's dividends at 16% (604040, added by ANAF's workbook of 16.02.2026).
- **Lease instalments:** see [Loans and leases](#loans-and-leases-loans-leasescommence).
- **Not produced yet:** the stock file, invoices with document-level allowances, a VAT rate's lines booked on several accounts other than a lease's (`D406_SPLIT`; an invoice split by rate is reported, each line on its rate's account and with its rate's VAT), WHT codes, and invoices without UBL XML.

**D406 for assets (D406 Active)** is written by `xfactura-core/src/ro/saft/assets.ts` and prepared as D406 for a period `YYYY`: the financial year ending in it, from 2025. It is filed once a year by the statements' deadline (OPANAF 1783/2021 anexa 4 pct. 1, 7–8) as an independent declaration, HeaderComment A.
- **What it holds:** the Header; the GeneralLedgerAccounts of the fixed assets and their depreciation (20x, 21x, 280x, 281x) with the year's opening and closing balances, as ANAF's worked examples list them; every asset of the register held in the year; their movements (AssetTransactions). The other sections are written empty: ANAF's validator wants them present.
- **Each asset:** inventory number, account, description, supplier (the purchase invoice's partner, or the lessor), date of acquisition (the purchase's or the lease's entry), commissioning date, the catalogue code of HG 2139/2004 as ValuationClass, life in years (AssetLifeYear) or months, the value at the year's start and end, the year's addition and disposal, the net value at both ends, the depreciation of the year and accumulated (negative), straight-line (LINIARĂ) with its rate.
- **Movements:** a purchase (10) from its entry; a depreciation (30) per depreciation entry; a disposal by how it left (option `disposals` by inventory number: `sale` with its invoice, whose revenue on 7583 gives the gain or loss, `scrap` (50) or `other` (130), at its net value, negative). Each names the journal entry that booked it.
- **Readings** ANAF's documents disagree on are the parameter `ro.d406.assets.presentation`: the rate in percent (ANAF's answer to MF.A.26) and the disposal at its gross value (ANAF's examples). The rest follows ANAF's answers and, where they are silent, its examples. A review packet asks the expert.
- **Checks** (`checkD406Assets`): a year of twelve months (the validator refuses any other: a shorter first year is UNSUPPORTED), each asset's values add up, its movements are the year's, and the register agrees with every asset and depreciation account at both ends of the year (`D406A_REGISTER`). Refused: a disposal not yet derecognized, an asset entering without its entry, revaluation reserves (105), impairment (290x, 291x) and investment subsidies (475x).
- **Order:** ANAF takes it after the year's periodic files (its clarification of 14.11.2022). Authorizing it is blocked while a periodic D406 of the year prepared in the engine is not filed (`D406A_PERIODIC`).
- Passes ANAF's SAF-T validator, from the books and in the official tests.
- **Agent-ready** (`ro/saft/agent.ts`): the documents (ANAF's classification as a large or medium taxpayer, the disposal record or sale invoice), `profile.fact` for `taxpayer.category`, the `obligation.due` detector with the rules it enforces (`ro.deadline.D406`, `ro.deadline.D406.assets`, `ro.d406.start`), no template fields.

**Obligations calendar.** `obligations.calendar` lists the returns whose periods end in a range of months, with their deadlines and where each one stands: due, overdue, prepared, authorized, filed, accepted, rejected, or blocked. A return is blocked when its deadline isn't sourced for the period, when whether it applies depends on a fact nobody recorded (the row names the question to ask), or when the engine doesn't cover it (the row names the case). Each row gives its `basis`: the closure rule, the facts it read and the clauses.
- **Which returns apply** is the obligation closure's ([Determinations and the obligation closure](#determinations-and-the-obligation-closure)), from the recorded facts, the yearly determinations and the books:
  - VAT payers file D300 and D394 for each VAT period, and D390 for the months with services across the EU border. A company leaving VAT files its last D300 and D394 for the period up to the day before the cancellation, by the 25th (D394 the 30th) after the month the decision was communicated in, whatever its period (art. 310 alin. (7), art. 316 alin. (13)).
  - Outside VAT, D301 for each month with services bought from abroad (art. 324 alin. (1) lit. d), with the art. 317 code or without), and D390 for the months with services across the EU border when the company holds the art. 317 code (art. 325 alin. (1)); without the code that D390 is UNSUPPORTED (`EU_SERVICES_NON_VAT`).
  - Every company files D406, for each VAT period, or quarterly outside VAT; a PFA, II or IF does not (OPANAF 1783/2021 anexa 5 pct. 4). From 1 January 2025 every category files; before it, the taxpayer category (`taxpayer.category`: large, medium, small, dated from ANAF's classification) decides, by the reference dates of `ro.d406.start` (anexa 5 pct. 1.1–2, as OPANAF 407/2025 replaced it). Unknown, it is asked.
  - A company holding fixed assets files D406 for assets for each financial year its D406 covers whole.
  - Employers file D112 monthly, or, when `payroll.period` is quarterly, each month's D112 by the 25th after the quarter (`ro.deadline.D112.quarterly`, art. 147 alin. (4)), except a month with sick leave or a contract ended and the quarter's months before it, due by the 25th after that month (alin. (11)).
  - Microenterprises file D100 for each quarter; it's also due in the months with dividend tax withheld, and D205 follows for those years. A profit-tax payer files D100 for quarters I–III (`ro.deadline.D100.profit`, art. 41 alin. (1)) and D101 for the year, by 25 June of the next year (`ro.deadline.D101`, art. 42 alin. (1) as OUG nr. 8/2026 rewrote it, from the return for 2026).
  - A change of the income tax regime is declared on D700 (art. 55): entering micro by 31 March of the year, leaving it during the year by 31 March of the next, leaving it from 1 January shown with both readings of the text. The engine does not prepare D700: the company files it through ANAF's portal and a person records it (`obligation.filed`), which marks it filed.
  - Annual statements are due for each financial year kept in double entry, by the year's size category: S1005 for a microentity, S1003 for a small entity; medium, large and audited entities are not covered. A company that a person states has carried out no activity since it was set up (`activity.none`) files S1046 instead.
- **The deadlines** are cited parameters (`ro.deadline.*`, `xfactura-core/src/ro/obligations.ts`):
  - D300 (Codul fiscal art. 323), D301 (art. 324 alin. (2), OPANAF 592/2016 anexa 2 pct. II), D112 (art. 147), D100 (art. 56, 43 and 97) and D390 (OPANAF 591/2016): the 25th of the next month;
  - D406: the last day of the next month (OPANAF 1783/2021 anexa 4); D406 for assets (`ro.deadline.D406.assets`): the statements' deadline (anexa 4 pct. 1, 7), so the same two readings for 2025 and 150 days from 2026;
  - D205: the end of February (art. 132);
  - S1005 and S1003: for 2025, a `conflict` deadline: 150 days after the year (Legea 82/1991 art. 36 alin. (1) lit. a)) against 31 May (OMF nr. 2.036/2025 anexa nr. 1 pct. 3.1 alin. (1) lit. a)), both shown and the earlier to file by (2 June 2026 for both, after the weekend and 1 June); from 2026, with no order published, the law's 150 days;
  - S1046: 60 days after the year (art. 36 alin. (2); for 2025 also OMF pct. 3.3).
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
- `closure.evaluate {from, to}` (read): the obligation closure ([CONFORMANCE.md](CONFORMANCE.md#the-closure-as-built-t1-30-october-2026)), over the months the books cover: before the company's first financial year (one starting mid-month covers that month) it lists no return and asks nothing, nor the annual returns of a year before it, and the years before it are not determined. A company with no financial year at all is read from its facts alone. D212 and D204 wait for a known PFA, II or IF form; a PFA, II or IF files no D406 (OPANAF 1783/2021 anexa 5 pct. 4, as OPANAF 407/2025 replaced it). Before 2025, a company's D406 waits on its taxpayer category.

**Answering:** only a person (an owner or reviewer) answers. Confirming records the value from 1 January and each change within the year, as profile facts citing the answer, which holds the computation shown. Correcting records another value, citing the document that supports it (a D700, the registration). A recorded fact confirmed against the current computation's fingerprint is not questioned again; a fact recorded otherwise that the computation contradicts is a conflict until confirmed.

**The yearly axes** (`income_tax`, `vat.period`, `payroll.period`, `size.category`) need a fact effective within the year; one carried from an earlier year is not the year's determination. `vat.threshold`, `vat.cash`, `vat.status` and `vat.eu` are checked each year but hold until changed; for them a recorded change the computation does not make (a cancellation the law does not allow) disagrees too, and a value that starts during the year (a registration, a special code obtained) is compared from the day it starts. Two scope facts are asked of every company: `activity.goods` (goods or stock: not covered yet) and `regime.excluded` (excise, a fiscal group, IFRS: out of scope).

| Determination | Computed from | Rule (parameter) | Asked when |
|---|---|---|---|
| `income_tax`: micro or profit (SRL) | The previous year's turnover (70x net of 709) with the linked enterprises', against 100,000 € at the BNR rate valid at that year's close (art. 47 alin. (1) lit. c), alin. (1^1), art. 54); at least one full-time equivalent under contract at 31 December (lit. g), art. 51 alin. (4)); the owner's answer for lit. d), e), h), i) and alin. (3). Eligible, the previous year's regime carries (art. 48). During the year, the exit from the quarter the limit is crossed, own and linked revenue together (art. 52 alin. (1), (5^1)–(5^2), a quarter of a linked norm per quarter elapsed), from the quarter after the only employee left and was not replaced in 30 days (alin. (3)), from the quarter the statements became late (alin. (2)), and from the quarter the company started an excluded activity or its shareholders chose it to leave for holding other micro-enterprises (alin. (4), (7), dates in the owner's answer). The consulting share is no condition from 2025 (lit. f) repealed by OUG nr. 156/2024). | `ro.micro.revenue_limit_eur`, `ro.micro.employee`, `ro.micro.linked` | the owner's conditions and linked enterprises (`micro.conditions`), a previous year outside the books (`year.figures`), the option when eligible without a regime the year before (`profile.fact`) |
| `vat.period`: monthly or quarterly | The previous year's taxable, exempt-with-deduction and abroad-with-deduction supplies (the bases of the output tax entries) against 100,000 € at the rate of 31 December, and no EU goods acquisitions (art. 322 alin. (2); norme pct. 103 (2)–(3)). The year of a registration: the turnover obtained before it, recalculated for a whole year (`ro.vat.registration.annualized`: by days of activity; by months is the alternative reading), from the registration day (art. 322 alin. (4)); the year after: the turnover from the registration to 31 December, recalculated the same way (alin. (5)). An ex officio registration is monthly (norme pct. 103 alin. (1)): the decision shows it. | `ro.vat.period.limit_eur`, `ro.vat.registration.annualized` | a registration while the year is not kept from 1 January, a previous year outside the books |
| `payroll.period`: monthly or quarterly D112 | A PFA, II or IF with employees: quarterly (art. 80 alin. (2) lit. d)). An SRL: the previous year's mean headcount over the months with a D112 below 3, and for a profit-tax payer total revenues (class 7) up to 100,000 € (lit. b)–c), art. 147 alin. (6)–(7)). The option for monthly (art. 147 alin. (8)) is the confirming person's to state. | `ro.payroll.quarterly` | the year's income tax not recorded, a previous year outside the books |
| `size.category`: micro, small or medium/large | Total assets (balance sheet A–C from the year-end balances with the S1005 formulas, OMFP nr. 1.802/2014 pct. 15), net turnover (70x − 709 + 7411) and the 12-month mean headcount, for the previous and the current year. The category changes only when both years are beyond it (pct. 12–13): up to the lower, down to the higher. Medium or large, or above the audit thresholds in both years, is UNSUPPORTED. | `ro.size.thresholds` | the previous year's category, a previous year outside the books; a crossing year before the current one ends |
| `vat.threshold`: under or exceeded (non-payers) | The year's revenue on 70x, net of 709, by day, less supplies abroad (a non-payer's sales have no VAT entries; asset sales on 7583 are left out, as art. 310 alin. (2) leaves them); the day it exceeds 395,000 lei, counted while the company was outside VAT the day before (a registration valid from the crossing day does not stop the count). A company set up during the year (its first financial year starts then, Legea 82/1991 art. 27 alin. (8)) counts from its first day against the whole threshold (art. 310 alin. (5)). | `ro.vat.exemption.threshold` | the year not kept from 1 January nor started in it |
| `vat.status`: registered or not | From the status at the year's start: registered from the crossing day when the threshold is exceeded (art. 316 alin. (1^1) lit. b), f); a later recorded date is said and stays a conflict); a recorded registration before any crossing as an option (art. 310 alin. (3)); a recorded cancellation when neither the previous year's nor this year's turnover up to it exceeded the threshold (art. 310 alin. (7)), otherwise not (the recorded fact then conflicts). | `ro.vat.exemption.threshold` | the status at the start not recorded; the previous year's turnover for a cancellation |
| `vat.eu`: the art. 317 code (non-payers) | The year's invoices from suppliers established in another member state and to customers there, while outside VAT: the code is needed before the first (art. 317 alin. (1) lit. b)–c)), valid from the request (norme pct. 90 alin. (4)); held from a recorded `special` fact on or before it. Services to or from outside the Union need none. | (clauses) | — |
| `vat.cash`: eligibility (VAT payers) | The previous year's VAT bases against the ceiling in force at the year's end (art. 282 alin. (3^1), (4)); during the year, the day the ceiling is crossed: out from the day after the next VAT period (alin. (5)). | `ro.vat.cash.ceiling` | `vat.cash` not recorded |

**Figures of a year the engine does not keep** (no financial year from 1 January) come from a person's answer to `year.figures`, with the filed statements and returns as evidence; a figure the books cannot place (total assets with an account split between an asset and a liability row) is asked the same way. The BNR rate of a year's close must be imported (`fx.importBnr`).

**The worklist** shows `determination.missing` for each yearly axis without its fact or contradicted by the books (blocking when contradicted), and `threshold.approaching` for the micro-enterprise limit, the small-enterprise threshold and the VAT on collection ceiling at 80% (warning) and over 100% (blocking); 80% is a product choice, not a legal value. Both move on with `determinations.propose`.

**Agent-ready** (`agent.ts`): the documents it takes (the trade register's certificate, the fiscal registration and vector, D700, the shareholders' register, the filed annual statements), its questions and who answers them, its two detectors and the rules they enforce, and no template fields.

**Parameters** (all `extracted`, reviewed through 2026-12-31): `ro.size.thresholds` (OMF nr. 2.036/2025 anexa 1 pct. 2.1–2.3 and 2.6; OMFP nr. 1.802/2014 pct. 12–13 and 15; from 2025), `ro.vat.period.limit_eur`, `ro.vat.exemption.threshold`, `ro.payroll.quarterly`, `ro.micro.employee`, `ro.micro.linked` and `ro.deadline.D112.quarterly` (Codul fiscal in ANAF's consolidation; from 2026, earlier years are gaps). Four readings have review packets for the expert contabil: the linked norm during the year, the mean headcount of the quarterly D112, the two-year rule, and when a supply counts towards the small-enterprise threshold.

## The tax account (T2)

What the company owes the state and is owed by it, as the single treasury account (contul unic) settles it. The pure code is in `xfactura-core/src/ro/taxaccount` (`obligations.ts`, `distribution.ts`, `documents.ts`, `reconcile.ts`, `treatments.ts`, `agent.ts`); the engine module is `modules/taxaccount.ts`. Sources: the Codul de procedură fiscală in the legislative portal's consolidation of 08.08.2026 (`L207/2015`), ANAF's methodology of distribution (OPANAF nr. 1.613/2018 as OPANAF nr. 146/2025 amended it), its nomenclator (OPANAF nr. 1.612/2018, annex replaced by OPANAF nr. 551/2021), the payment record number (OMFP nr. 3.832/2015), the decision models (OPANAF nr. 967/2017, 727/2019, 352/2022) and OMFP nr. 1.802/2014.

**Obligations.** Every open item of a tax authority (a public institution) on a tax account is one obligation (`obligationOf`): its type from the account (`ro.taxaccount.obligations`: 444 salary tax, 4315 CAS, 4316 CASS, 4411 profit tax, 4418 micro tax, 4423 VAT, 436 CAM, 446 split by the treatment that booked it into dividend and interest tax), its budget (the state budget, BASS for CAS, FNUASS for CASS, Codul fiscal art. 2 alin. (2)), its category (withheld at source, other principal, accessory), whether it is paid into the single account (VAT and CAM are not in the nomenclator: each is paid into its own account, art. 163 alin. (7)), its period and due date from the posting that opened it (`OpenItemQuery.origins`: the D300 deadline for `vat.settle`, D100's for `tax.micro` and the profit tax's quarters, D101's for the year, D100's for dividend tax, the withholding day for interest tax by art. 97 alin. (2), the item's own due date for payroll and decisions) and its age (the due date; for what a decision established, its communication date, art. 165 alin. (3) lit. b)). Accessories and assessed differences carry their obligation on the line that opened them (`analytics.item` `taxaccount:<type>:<period>:<kind>`).

**`tax.pay`: a payment to the state** (or money from it), subject `movement:<id>` like `bank.settle`:
- **Input:** the movement, the authority, `to` (the single account, or the type whose own account the order paid: `vat`, `cam`), `designations` (the obligations the payer chose, with the payment record number) and `dueDates` (an obligation the books cannot date, an opening balance; acknowledged).
- **Into the single account** (`ro.taxaccount.distribution`, art. 163 alin. (3)–(5), OPANAF 1.613/2018 pct. 4–7): what the payer designated first, where the law lets them choose (obligations from an inspection, a decision's accessories, fines: art. 165 alin. (8), NEP); then the obligations due on the payment's date: all of them when the payment covers them, otherwise between budgets in proportion to what each is owed, within a budget withheld taxes and contributions, then other principal obligations, then accessories, and within a category the payment does not cover in proportion between types, each type oldest first. Shares are split by largest remainder, so they add up to the bank.
- **Beyond what is due** (`ro.taxaccount.advance`: `at_due_date`): the obligations the books hold falling due later, each due date in turn, in the same order: ANAF keeps the money in the single account and settles them as they fall due (pct. 7–9.1). What no obligation takes is a payment not yet distributed: Dr 4482, an open item of the authority (`taxaccount:undistributed`), with an info issue; no accessories are owed for a sum paid before the obligation was declared (art. 173 alin. (3)).
- **Into a type's own account:** that type's principal obligations by age, then its accessories (art. 165 alin. (1) lit. a)); the excess is paid in excess (4482). A type that is paid into the single account is refused (`TAX_SINGLE_ACCOUNT`).
- **Money received** settles the claims it repays (VAT to recover, sums paid in excess): those designated, else the one claim it equals (`TAX_REFUND_ITEM` otherwise).
- **Refused:** without the fact `tax.facilities` (a `profile.fact` question, `TAX_FACILITIES`); with payment facilities, insolvency or state aid to repay (`TAX_FACILITIES_UNSUPPORTED`: art. 163 alin. (10), art. 165 alin. (4)–(6); state aid and de minimis to recover are extinguished first, OPANAF nr. 1.613/2018 pct. 3^1 as introduced by OPANAF nr. 146/2025); a PFA, II or IF (`TAX_ACCOUNT_INDIVIDUAL`: their single account 55.04 has its own methodology, OPANAF nr. 2.937/2018); a currency other than lei; an obligation without a due date (`TAX_DUE_UNKNOWN`); a designation the law does not allow (`TAX_DESIGNATION`).
- **Reads** the authority's open items: a new obligation, or a payment of one, makes the proposal stale.
- **Templates:** `tax.pay` templates fix only `to` (scope: the authority, `movement.paid`, words of the text); the distribution is always the engine's, so a template earns autonomy like a bank match, and recurring payments to the authority are `template.candidate`s. The worklist proposes `tax.pay` for an unexplained transfer to a Treasury IBAN (bank code TREZ).

**`tax.distribute {authorityId, date, round}`:** the payments not yet distributed (4482, oldest first) over the single account's obligations due by the date, in the same order (Dr the obligations / Cr 4482): what the books show once a return filed after the payment is due. Refused with nothing to distribute or nothing due. ANAF's intermediate steps (the month-end split by budget weights into the accounts in course of distribution, pct. 8.1–9.5, and the compensation in the next 10 days, pct. 10.1–12) are not kept; the end result is compared with the statement.

**`tax.decision {documentId, authorityId, accounts}`: ANAF's decisions**, booked from a document recorded with `documents.record` (kind `tax.decision`, body `extracted-tax-decision-1`, every amount cited; subject `document:<id>`):
- **Accessories** (interest, late-payment and non-declaration penalties, OPANAF 967/2017 anexa 3–4) and **fines**: Dr 6581 / Cr 4481 (`ro.taxaccount.accounts`, the functions of accounts 658 and 448), one obligation per line, due by art. 156 alin. (1) (`ro.taxaccount.decision_due`: communicated on the 1st–15th, the 5th of the next month; otherwise the 20th), tagged with the obligation it follows (its budget, art. 173 alin. (4)). The engine recomputes interest (0.02%/day, art. 174 alin. (5)) and the late-payment penalty (0.01%/day, art. 176 alin. (2)) from the base and the days the decision's annex shows, in whole lei (OPANAF 727/2019 pct. 11); a difference of a leu or more is acknowledged (`TAX_DECISION_AMOUNT`): the decision is ANAF's act and is booked as it stands. The non-declaration penalty's 75% reduction (art. 181 alin. (2)) is noted, not computed. The profit tax asks how 6581 is classified (fines owed to authorities are not deductible).
- **Assessments** (differences of principal obligations from an inspection): Dr the expense account given per line (6xx) / Cr the tax's account, due by art. 156; a difference of an earlier year is `correction.priorYear`'s (refused: `TAX_ASSESSMENT_ACCOUNT`).
- **Refunds and offsets** (OPANAF 352/2022 anexa 2; the Decizia privind compensarea obligațiilor fiscale, OPANAF 1.613/2018 pct. 12, art. 167): each offset line extinguishes the obligation of its type and period with the claim it names (Dr the obligation / Cr 4424 of the refunded period, or 4482); a refund alone is a memorandum, the money arriving by `tax.pay`. An approved amount other than the books' VAT to recover is acknowledged (`TAX_REFUND_PARTIAL`). The engine books the offsets as the decision states them; it does not recompute art. 167 alin. (2)'s order (same budget first, then the others in proportion).

**VAT refunds.** A D300 with a negative balance of at least 5,000 lei is a refund request only if the company asks for it (Codul fiscal art. 303 alin. (7)): without `refundRequested`, the D300 reads a person's answer to `vat.refund` for the period (`VAT_REFUND_CHOICE` until then); a smaller balance is carried forward. The refund is then the decision above and a receipt.

**The statement of the account** (`documents.record` kind `tax.statement`, body `extracted-tax-statement-1`): ANAF publishes no model of it; it is requested in the SPV (Situație Sintetică, Fișă Rol, Rezumat Fișă Rol with an Excel attachment) and arrives as a PDF, which an agent transcribes with citations like `bank.recordStatement`: the day its balances are at, and per row the obligation (a type, `undistributed`, `vat_refund`, `fine`, `other`), principal or accessories, optionally the budget, the period, the opening, the debits and credits, and the balance (positive owed by the company). Its arithmetic (opening + debits − credits = balance, rows to the total) is a blocking check; the identity is the company, the SPV document and the day. `taxaccount.reconcile {documentId?, authorityId?}` compares it with what the books hold on that day for every authority, per obligation, kind and period (by period where the statement shows periods): within a leu it matches (the statement is in whole lei); otherwise each difference is explained: `ACCESSORIES_UNBOOKED` (accessories ANAF computed that no decision booked yet), `NOT_IN_BOOKS`, `NOT_ON_STATEMENT` (not declared or processed yet), `AMOUNT`, `UNDISTRIBUTED`, `OUTSIDE_BOOKS` (a fine or another obligation the books do not hold), and `DISTRIBUTION` when the single account's differences cancel out (ANAF distributed a payment otherwise). `taxaccount.position {authorityId?, date?}` lists each obligation and claim on a day with its type, period, budget, category, due date and balance.

**Close and worklist.** The month close warns `TAX_STATEMENT_DIFFERS` when the month's latest statement differs (a person may dispose of it). The worklist shows `taxaccount.differs` (the latest statement, every differing obligation in its details; disposable by a person), `taxaccount.undistributed` (payments not yet distributed while single-account obligations are due: propose `tax.distribute`) and `taxaccount.correction` (a filed D100 whose inputs changed since: a D710 is filed outside the engine and recorded with `obligation.filed`, `D710/<period>`).

**D710.** ANAF's package exists (OPANAF nr. 587/2016 as OPANAF nr. 57/2026 amended it; structure shared with D100, namespace `mfp:anaf:dgti:d710:declaratie:v2`, validator J20.0.7 in `D710_14092026.zip`; its XSD declares an inconsistent target namespace). The writer is not built: the correction is tracked as filed outside.

**Expert questions** (review packets): the proportionality within a category (between types, oldest first within a type, or between every obligation); a payment before the due date (settling the known obligations at their due dates, or kept undistributed until a distribution); the accounts (interest on 6581 or 666; a payment not yet distributed on 4482 or 473).

**Not covered:** payment facilities and insolvency; the individuals' single account; art. 167's order recomputed for offsets; a decision's reduction of the non-declaration penalty; restitution requests (OMFP nr. 1.899/2004, not read); D710's writer; the employer-borne part of CAS and CASS is treated as withheld.

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
- **profit tax** of the current year and the previous one (`modules/profit.ts`, core `ro/profit/agent.ts`): an account with turnover in the profit-tax months whose treatment depends on facts and nobody classified, or holding a vehicle's costs (a recognized invoice naming the vehicle) under another classification (`profit.unclassified`); a fixed asset in use without a fiscal basis (`asset.fiscalMissing`); a prior-year correction not yet carried into its year's rectification, or, for a year outside the books, whose rectifying D101 nobody recorded as filed (`profit.correction`);
- **tax account** (`modules/taxaccount.ts`, core `ro/taxaccount/agent.ts`): the latest statement of the account differing from the books (`taxaccount.differs`), payments not yet distributed while obligations are due (`taxaccount.undistributed`), a filed D100 whose inputs changed (`taxaccount.correction`, a D710 filed outside);
- **annual statements** (`annual.input`): for each financial year ended in the last two years, the statement its size category gives (S1005, S1003) and what it waits on a person for (F30 chapters, the disclosures, the accompanying documents of the prepared statement), with `annual.ask` as the agent's step; and the half-year report of the current year when owed (outside the engine);
- **close checks** of `Engine.closeChecks` for each month from the first with entries to the current one that is not closed, one month per call; the earliest month that ended and is not closed is itself an item, unless its close is requested;
- **documents:** groups (or single documents) without a proposal holding their subject (open, or posted by an entry that stands: a reversed booking lists the document again), contracts aside; groups whose copies disagree; open proposals whose current version reads an extracted or uploaded copy of a group with an e-Factura one;
- **bank movements** without a proposal holding them (`bank.movements` shows each movement's `state`: `unexplained`, `proposed`, `approved` by its open proposal's latest version, `settled` by a posted entry that stands; a reversed settlement makes it unexplained again, and the month close finds it so);
- **SPV messages** that differ, failed or carry an error or a buyer's message;
- **evidence** that no record names;
- **automation:** paused scopes (the system's demotions included), templates that graduated without a policy, and partners whose bookings recur without a template (at least 3 in 2 months).

A page stops at its limit or its budget (40 detector calls, 150 ms) and resumes exactly where it stopped. The indexes added for it are on evidence references (documents, statements, profile facts, SPV messages, party statuses, BNR rates' file hashes, and the `evidenceId` of proposal versions' input, an expression index) and on proposal versions' creation time. At 100,000 posted lines, every page stays under 300 ms (`work.perf.test.ts`).

**Dispositions** (`acc_dispositions`, append-only) record that a document needs no booking or an SPV message or a close warning was dealt with (`work.dispose`), with a reason and the item's fingerprint, a hash of its kind, subject and details. The item stays hidden while its fingerprint is that one, and returns when it changes. Only a person decides, except for evidence used nowhere; the database refuses an agent's disposition of anything else (`disposition_person`) and a disposition about anything but a document, an SPV message, a close finding or evidence (`disposition_subject`).

## Questions to people

The kinds (`vehicle.use`, `deferral.schedule`, `payroll.absences`, `evidence.missing`, `choice`, `profile.fact`, the determinations' `determination.confirm`, `micro.conditions` and `year.figures`, the profit tax's `profit.account`, `profit.losses` and `obligation.filed`, and the annual statements' `annual.informative`, `annual.disclosures` and `annual.document`, subject `annual`, and the tax account's `vat.refund`) and the operations are in [AGENT_API.md](AGENT_API.md#questions-to-people); the kinds' schemas, prompts and lifetimes in `xfactura-core/src/questions/kinds.ts`.

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
- `profit.register`: the Registrul de evidență fiscală of a profit taxpayer for a year, in the form of OMF nr. 808/2026 (Nr. crt., the explanation with the accounts' symbols, the value in lei), a projection of the posted computations and prior-year corrections in posting order: each bridge line with its accounts and, for them, the entries that booked the amounts in the period (at most 50 per account), then the rows of the return. Registers of periods before the order's publication (7 July 2026) use the same form; whether OMF nr. 870/2005's applies to them is not settled.
- `profit.losses`: the tax loss vintages each annual computation started from, used and left (art. 31).

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
  - Several sources are written one subsection each, and the CASS of income declared from outside the books in Section 3.2.2 (web form).
  - The 2025 values come from the instructions of OPANAF 2736/2025: tax 10%, CAS 25% in the 12- and 24-wage bands at the 4,050-lei minimum wage, CASS within 6–60 wages, losses at 70%.
    - The expense limits and natures of art. 68 are the 2026 consolidated text. No 2025–2026 act amending them was found; the expert confirms.
    - Income of 2024 is still a gap; the 2025 rules for income norms are sourced (the 2025 consolidation and OUG 128/2024).
- **Normă de venit:**
  - The preparer gives the norm, with the DGRFP publication as evidence and its coefficients.
  - The register prorates it over the days active and blocks below the 12-wage floor.
  - Gross income above 25,000 EUR in the previous year blocks the norm. Above it in the current year, it notes that the real system applies from next year.
  - D212 writes the norm chapter (`cap12`): for 2024 income only for an activity started in December, as ANAF's 2024 structure allows. For 2025 the floor counts the minimum wage of the DGRFP decision's date (`setOn`).
- **Family enterprise (IF):**
  - Its members, with their quotas and a representative, are kept append-only in `acc_enterprise_members` (`if.members.record`, `if.members.list`). Members' CNPs are sealed.
  - The register distributes the net income or loss by quota, with the largest remainder, so the shares add up exactly.
  - Each member's D212 carries their share.
  - **D204** is prepared from the register and members, and passes ANAF's validator (J3.0.14). The validator doesn't check quotas, net income or the shares' sum, so the writer's own checks do.
  - The D204 deadline is on the calendar with both readings: the end of February (Codul fiscal art. 125 alin. (4), OPANAF 470/2021) and 15 March (norme pct. 41 alin. (4)). It is shown due at the earlier.
  - An IF on a norm, and a change of agreement within the year, are refused.
- **Several sources in a year** ([PFA_II_IF.md](PFA_II_IF.md) §7.9):
  - Each amount goes to the source its account (with analytics) is attributed to, in `pfa.fiscalRegister`'s `attribution`, with the person's document.
  - An expense serving several sources is split by the person's key: by gross income or by fixed shares, the keys `ro.pit.sources` admits. No text sets one; an expert question.
  - Each source has its register and its losses. CAS and CASS count the sources together.
  - The D212 has one subsection per source.
  - Unattributed amounts block (`PIT_SOURCE_UNATTRIBUTED`). An IF with several sources is not covered.
- **A norm that becomes the real system mid-year** (norme pct. 8 alin. (13)): the norm is prorated for the days before the change, and the books count from it. The register computes it; the D212 refuses it (`D212_METHOD_CHANGE`) until the form's presentation is settled.
- **Income declared from outside the books** (rent, investments, dividends), marked `declared`:
  - It counts for the CASS of art. 170 alin. (2)–(3) (`ro.cass.other`: 6/12/24 wages) and lifts the CASS minimum (art. 174 alin. (7) lit. b)).
  - It is written in Section 3.2.2 of the web form's D212.
  - Income whose tax is not final at source needs its own subsection, which is not written (`D212_DECLARED_TAX`).
- **Norms of 2025:** the floor is 12 minimum wages in force when the DGRFP set the norm (the decision's date is asked); the 25,000 euro threshold is OUG 128/2024's.
- **D212 for 2026 income:** `FORMAT_GAP` until ANAF publishes its structure. The 2026 register (CASS capped at 72 wages) is ready.
- **D406:** PFA, II and IF do not file it (OPANAF 1783/2021 anexa 5 pct. 4, as OPANAF 407/2025 replaced it).
- **Double entry for a PFA, II or IF:** the option is recorded as the person states it. The closure reports it UNSUPPORTED (`PFA_DOUBLE_ENTRY`: OUG 44/2008 art. 15 against OMFP 170/2015 art. 3), and the registers refuse it.
- **Not built yet:**
  - an IF on a norm (`D212_IF_NORMA`: whether each member owes the whole norm is an expert question);
  - other independent income outside these books in the D212;
  - the subsections of rent and investments with their own tax.

## Not implemented

- **Not built yet:**
  - booking receipts recorded with `documents.record` (`receipts.recognize`) and their VAT;
  - verification of the Ministry's signature; B2C identification;
  - VAT categories other than S/O, domestic reverse charge, goods across the border, pro-rata; D394 for simplified invoices and receipts; reading the P300 file;
  - for non-payers (V1): VAT added on top of the price when registering late (correction invoices, art. 330); the negative VAT amount ANAF establishes (D300 rd. 42); the adjustment of stock, assets in progress, unused services and advances on a change of regime (art. 304), and of assets bought before 2016 (art. 306); intra-Community acquisitions of goods (D301 sections 1–3); D394 for the periods a late registration covers (the sales it makes taxable are not listed);
  - payroll beyond salary in money, vouchers, annual leave and sick leave for ordinary illness (other indemnity codes, benefits in kind), and corrections of a posted month;
  - asset revaluation; revolving credit lines and overdrafts;
  - VAT deducted from receipts and simplified invoices; cash payments in D406's payments section;
  - stock;
  - interim dividends, dividends to non-residents; the profit tax's annual system with prepayments, the minimum turnover tax, the interest limitation beyond its ceiling, reinvested-profit and other exemptions and credits, D107; D710's writer (tracked as filed outside);
  - the statements of small and larger entities; physical inventory and provisions.

[ROADMAP.md](ROADMAP.md) orders this work.
