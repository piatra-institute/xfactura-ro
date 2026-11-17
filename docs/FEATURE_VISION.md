# Product feature vision

This document describes target experiences and candidate enhancements. It does not announce shipped capabilities. [IMPLEMENTATION.md](IMPLEMENTATION.md) owns current coverage; [ROADMAP.md](ROADMAP.md) owns delivery order and work items. Required accounting modules take priority over these enhancements. The built-in model agent and governed automatic execution remain subject to [AI.md](AI.md).

## The experience to aim for

An owner connects or imports the company's evidence, supplies missing business facts and sees reconciled money, outstanding amounts, supported tax positions and decisions that need attention. An accountant can reconstruct every figure and finish the company's reporting cycle through the same books. Routine work uses API/MCP commands; the interface makes consequences easy to inspect.

“Give xFactura my invoices and bank statements” should eventually start a controlled workflow: retain sources → reconcile completeness → identify missing facts → propose accounting/fiscal treatment → obtain the necessary approval → post → reconcile subledgers → calculate applicable taxes → prepare validated outputs → authorize the exact filing package → track fulfillment. Opening books, tax history, service evidence, assets, payroll or stock records remain necessary when relevant; a model cannot reconstruct absent facts by guessing.

## Core product differentiators

These outcomes express the intended product direction. Each depends on the accounting coverage and authority required by the selected company; they do not broaden that coverage by themselves.

| ID | Feature | Concrete experience | Dependencies and acceptance |
|---|---|---|---|
| V01 | Every number explains itself | “Why is profit different from money in the bank?” opens the exact unpaid invoices, accruals, tax entries and other contributing records. | Deterministic reports and provenance first; an optional model explains only authorized retrieved facts. Every displayed total reconciles to its contributing rows and their as-of date. |
| V02 | One evidence inbox with completeness checks | An invoice imported from e-Factura and again from a ZIP is one economic source with both origins. A bank payment without its document becomes a specific request for evidence. | Extend existing source/deduplication primitives with expected-source coverage, missing-evidence states and connectors. “Nothing imported” must never mean “nothing happened.” |
| V03 | Reconciliation that shows its reasoning | A receipt explains which invoices it settles, the retained bank fee and the exact residual before anyone approves. Ambiguous matches remain selectable candidates. | Supported allocation/FX rules, current positions and source identity. No silent duplicate removal, guessed fee or payment initiation. Measure incorrect matches and human corrections alongside automation. |
| V04 | Continuous close with an exception queue | “Close September” prepares an exact review of supported bank, receivable/payable, accrual, asset, payroll, stock, FX and tax checks. The accountant sees the unresolved items and their financial effects. | Complete relevant modules, freshness/completeness checks and immutable close snapshots. Accounting close, tax readiness and filing acceptance remain separate states. Internal project release checklists stay in documentation. |
| V05 | One fact feeds books, tax and reporting | A reviewed asset purchase updates its accounting/fiscal bases and all applicable reporting from one retained source, without copying amounts into separate forms. | Accounting/fiscal interpretation branches, versioned mappings and reconciliation. A filing line must be traceable through the tax position or ledger to evidence. |
| V06 | Correction impact before approval | A late document shows which period, tax position, return and carried balance change, with old/new amounts and original artifact links. | Reviewed period/error rules, dependency graph, exact-version approval and immutable corrections. Never overwrite a previously approved year or silently replace an accepted filing. |
| V07 | Review routine work in safe batches | An accountant reviews a company/period batch of familiar supported transactions, then handles unusual items individually. | Governed policy and batch-review design. Approval identifies the exact members, versions, totals and effects; changed inputs invalidate the affected approval. No new items can join an approved batch unnoticed. |
| V08 | Accountant portfolio driven by real exceptions | A firm sees companies awaiting documents, unresolved bank differences, due close work or pending/rejected receipts, and opens the exact item. | Company-scoped permissions, real exception/obligation states, freshness and separate preparer/reviewer/filer authority. Revocation removes access immediately; a portfolio total never mixes companies' books. |
| V09 | Migration with a proof of continuity | The importer proposes account mappings, preserves original exports and explains every control or tax-history difference before activation. | [MIGRATION.md](MIGRATION.md), versioned legacy adapters and independently reconciled controls. Missing history blocks the affected claim. Measure accountant time and unresolved differences, without promising a fixed migration duration. |
| V10 | Reproducible filing and audit packages | An accountant can reproduce why a prior-year return contained a particular amount using retained source, ledger, tax, software, rule and validator versions. | Official outputs, archived rule packages, exact authorization, original receipts and clean-room recovery. An XML validation pass is distinct from content correctness and actual acceptance. |
| V11 | Governed automation of familiar treatments | An owner/accountant approves a bounded deterministic policy for recurring covered transactions; exceptions return to review automatically. | L2+ gates in [AI.md](AI.md): reviewed coverage, amount/counterparty/period limits, expiry, revocation, shadow evidence and a kill switch. Model confidence does not authorize posting, filing or payment. |
| V12 | Portable books and an open accounting standard | A company retrieves a complete archive and a compatible implementation can reproduce its supported records and conformance results. | Extend existing exports/restore to every new module; independently version the Accounting IR, profiles and public corpus. No paid export unlock, provider lock-in or dependence on a model to read the books. |

## Candidate enhancements

These are ideas to evaluate after their dependencies exist, rather than prerequisites for the first complete SRL profile. They must not displace missing fiscal calculations or official reporting.

| ID | Candidate | Useful outcome | Boundary |
|---|---|---|---|
| V13 | Cash forecast and tax reserve planning | Show expected receipts, payments and due tax positions over a selected horizon, with scenarios for late payment. | Distinguish actual money, approved liabilities, estimates and uncertain forecasts. Display assumptions, evidence freshness and unresolved taxes; a forecast cannot change the books. |
| V14 | Preview a business change | Explore a proposed hire, foreign purchase, asset acquisition or registration change in an isolated scenario before it becomes an actual fact. | Reviewed effective-dated rules and explicit assumptions. Identify unsupported interactions. Scenario results neither establish legal eligibility nor post or file anything. |
| V15 | Reconciliation with official external positions | Compare supported tax/filing positions with retained authority statements or e-TVA data and explain differences. | A reviewed connector/importer, exact identity/period matching and dated source authority. Never replace historical facts with a current lookup or treat an external prefilled figure as automatically correct. |
| V16 | Project, customer and product profitability | Trace margin to actual revenue, labor, purchases, stock/production costs and approved allocation policies. | Cost dimensions and reconciled payroll/stock/project subledgers. Estimates stay visible; totals reconcile to the general ledger without double allocation. |
| V17 | Receivables and payment follow-up assistance | Prioritize overdue balances and prepare a factual reminder with the correct invoice and contact references. | Evidence-backed aging, privacy and separate outbound-message authority. Drafting is distinct from sending; recipients/content must be authorized. Accounting access never grants authority to transfer funds. |
| V18 | Cross-record anomaly investigation | Surface changed payment details, unusual duplicates, missing sequences or inconsistent classifications with the records behind each signal. | Existing deterministic guards remain mandatory. New signals are questions to investigate, not unverified fraud accusations or a substitute for fiscal rules. |
| V19 | Accounting integrations and change events | Other systems and external agents consume versioned records, prepare typed commands and resume durable workflows after a human decision. | Build on the existing API/MCP. SDKs, webhooks and new connectors need compatibility, replay, idempotency and revocation proof; the API must expose only implemented coverage. |

## Product rules that apply to every feature

- Core accounting, fiscal updates, reports, collaboration, basic API access, self-hosting and complete exports follow the free product contract. A feature's deterministic accounting operation must work without a model.
- Optional AI uses a regular paid Piatra AI user key or a user-supplied provider key, including OpenAI/OpenRouter, from the backend. Provider charging follows that account. No new xFactura wallet or privileged Piatra credential is a dependency.
- Follow [DESIGN.md](DESIGN.md): direct Romanian labels, the fix shown where the problem is, accessible source links. Do not turn each accounting module into another mandatory manual-entry application. Show the precise business question or consequence; keep milestone numbers and project governance out of product copy.
- Accounting permission, provider access, professional authority, filing mandate, outbound messaging and payment authority are distinct. New integrations do not inherit them implicitly.
- Future capabilities appear in discovery and product claims only after their input, accounting/fiscal effect, approval, error, export and recovery behavior exists and has evidence.

## Measure usefulness without inventing results

Establish pilot baselines for human minutes per company/month, time to reconcile and close, missing-evidence requests, repeated data entry, corrections after approval, rejected artifacts, source-to-total traceability, migration effort and successful restoration. Record automation rates by supported workflow and exception class, with false matches and unsupported cases included.

Targets can be set after measurement; none of these metrics currently establishes a product-wide result. A high automation rate on an easy fixture cannot compensate for a missing annual return or an unsupported company obligation.
