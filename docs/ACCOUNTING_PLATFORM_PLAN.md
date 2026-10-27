# xFactura implementation plan

This is the working plan, not a claim that the proposed accounting capabilities are implemented.

## Product direction

Build free, open Romanian accounting infrastructure that minimizes manual work and switching costs.
Use an owner-first verification interface and accountant-first distribution.
Agents perform routine work through the shared API and MCP; the UI reviews evidence, decisions and results.
Keep hosted accounting and self-hosting free; operate hosting as an explicitly budgeted subsidy.
Fiscal correctness, critical updates, basic APIs, collaboration, and complete exports remain free.
The €1M turnover target is marketing segmentation. Coverage is determined by versioned conformance profiles.
Details and product commitments live in [PRODUCT.md](PRODUCT.md).

## Read the specification by concern

| Document | Owns |
|---|---|
| [PRODUCT.md](PRODUCT.md) | Audience, promises, distribution, and economic boundary. |
| [CONFORMANCE.md](CONFORMANCE.md) | Coverage profiles, obligation closure, eligibility and replacement gates. |
| [REGULATORY_BASELINE.md](REGULATORY_BASELINE.md) | Dated primary-source findings and register/deadline requirements. |
| [MIGRATION.md](MIGRATION.md) | Handover manifest, continuity, reconciliation and cutover responsibility. |
| [FISCAL_FIXTURES.md](FISCAL_FIXTURES.md) | Five review-required oracle candidates and deliberate defects. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Domain records, source authority, invariants, migration, and interfaces. |
| [AI.md](AI.md) | Providers, autonomy, permissions, and managed-AI deferral. |
| [ACCOUNTING_ENGINE.md](ACCOUNTING_ENGINE.md) | Implemented general ledger, configuration and XML invoice contracts and limits. |
| [AGENT_API.md](AGENT_API.md) | Implemented capabilities, scoped credentials, MCP and approval/recovery contracts. |
| [GOVERNANCE.md](GOVERNANCE.md) | RFCs, fiscal interpretation, review, signing, and releases. |
| [OPEN_SOURCE.md](OPEN_SOURCE.md) | Licensing direction, contribution rights, and open standards. |
| [SECURITY.md](SECURITY.md) | Threat model, trust boundaries, and disclosure. |
| [TESTING.md](TESTING.md) | Independent corpus, generative/mutation tests, and comparisons. |
| [OPERATIONS.md](OPERATIONS.md) | Deployment, subsidy budgets, storage, recovery, and support. |
| [ROADMAP.md](ROADMAP.md) | Ordered delivery, first tickets, exit criteria, and launch inputs. |
| [adr/](adr/) | Reasons for the principal planning decisions. |

Each document owns its facts. Update it in place and link it from other documents.

## Core model

Evidence establishes economic facts.
Accounting interpretation produces the ledger.
Fiscal interpretation produces tax positions and obligations.
Both branches retain evidence, effective-dated rules, approvals, and provenance.

Tax positions, adjustments, bases, credits, and carry-forwards are domain objects.
They are not implementation details of a D101 generator.
Posted history remains immutable; approved corrections create explicit linked revisions.
The implementation and the Romanian Accounting Conformance specification are separate artifacts.

## Coverage and adoption

Implement the accounting engine for VAT and non-VAT SRLs, covering both profit tax and microenterprise taxation. The first verified fiscal years are 2025 and 2026; earlier opening balances and tax vintages remain importable with their evidence. Accounting micro-entity size and microenterprise income taxation are separate classifications.
Native payroll, inventory and manufacturing/production costing belong to the suite, with explicit conformance facets and independently tested interactions. They are planned engine modules rather than external-system requirements.
RO-SRV-01 remains a useful narrow regression profile. It no longer restricts the product to non-VAT companies or defers normal VAT until after a non-VAT launch.
Normal VAT and special EU VAT identification are separate branches. D406 applicability is independent of VAT registration. Annual reporting and complete obligation closure remain mandatory before a company-specific replacement claim.

Use the same command API for owners, accountants, and agents.
Offer a minimal accountant portfolio view showing real exceptions and reporting freshness.
Retain the public invoicer while companies migrate through a reviewed opening position, current-year/fiscal-history continuity and a signed handover proof.
Keep typed proposals, deterministic calculations, exact-version approvals, and the filing receipt lifecycle.

## Delivery sequence

| Order | Result |
|---|---|
| 1 | General accounting foundation: sourced chart and analytical accounts, financial/fiscal years, general opening positions and proposals, dated registrations/policies/rule and obligation catalogues; preserve existing books. |
| 2 | Document-to-ledger workflow for VAT and non-VAT: incoming/outgoing e-Factura, sales/purchases/credit notes, customer/supplier positions, bank/cash, fees, partial/grouped settlements, multiple accounts and CSV/MT940/camt imports. |
| 3 | Complete VAT and FX: cash VAT, deduction/pro-rata/adjustments, registration transitions, EU/special identification, imports/exports, exchange-rate provenance and VAT reporting registers. |
| 4 | Assets, separate accounting/fiscal depreciation, leasing, financing, owner loans and distributions. |
| 5 | Native payroll, contracts, monthly calculations/postings, corrections and D112. |
| 6 | Native inventory, valuation, stock movements, annual inventory and production costing/WIP. |
| 7 | Micro/profit-tax positions, adjustments, loss vintages, credits, withholding, year close and controlled roll-forward. |
| 8 | Complete statutory registers and filing outputs: applicable D100/D101/D112/D300/D301/D390/D394/D406 and conditional reports, annual statements and supporting package. Pin official schemas/validators; reconcile to approved source positions. |
| 9 | Migration and exact-company/year replacement proof: signed continuity, independent oracles/mutations, real closes, annual reporting and recovery. |

The capability API and manual-credential MCP already exist and grow with each engine module. Deployment changes, browser OAuth delegation and a built-in Piatra AI/BYOK agent are deferred from this accounting critical path. Every new engine capability remains available to external agents through the shared API/MCP and reviewable through the existing UI.

The first coding ticket generalizes accounts, years, opening positions and proposals, with populated-book upgrade tests and independent 2025/2026 VAT/non-VAT sales/purchase posting fixtures. These fixtures establish ledger mechanics; they do not establish complete VAT or tax-return coverage.

Filing delivery initially means a validated official package for external signing/submission, followed by import and tracking of the actual receipt. Direct ANAF automation is an optional later adapter. An unsigned export, structural validator result or monthly close is never an accepted filing.
See [ROADMAP.md](ROADMAP.md) for ordered tickets and proof gates, and [IMPLEMENTATION.md](IMPLEMENTATION.md) for what has actually passed.

## AI and infrastructure boundary

Self-hosters use a regular Piatra AI user API key or an OpenAI/OpenRouter key.
Calls go directly from their backend to that provider.
No hosted xFactura commerce relay or privileged service credential is required.
Provider billing follows the regular user's account contract.

Use small IdentityProvider, AIProvider, ObjectStore, BankProvider, and TaxAuthorityConnector boundaries.
Piatra is an adapter; the accounting kernel has no Piatra-specific dependency.
BillingProvider is a future paid-service boundary, not an early prerequisite.
Defer prepaid wallets, retail tariff engines, and new billing gateway work.
A future managed paid mode requires a separate RFC justified by measured usage economics.

The reference self-host deployment uses local SQLite/libSQL and a local document volume. Accounting stays within the existing API package; Drizzle schemas generate migrations and typed queries implement operations. Turso is an optional libSQL configuration.
S3-compatible storage remains available for hosted/multi-node operation.
Self-hostability does not promise support for arbitrary deployment environments.

## Licensing and governance

Target AGPL-3.0-only for the accounting engine, fiscal engine, and application.
Target Apache-2.0 for independently reusable specifications, schemas, SDKs, and appropriate interfaces.
Target permissive licensing for independently authored conformance fixtures.
The current MPL-2.0 license remains in force until a rights/dependency audit and boundary review authorize a transition.
This document does not relicense existing code.

Fiscal packages require interpretation, independent expected cases, engineering review, corpus/validator runs, shadow replay, impact review, and a signed release.
Artifacts retain fiscal package ID, rule-set hash, software version, and conformance/corpus versions in an internal manifest.
None of those fields may be added arbitrarily to an official declaration schema.

## Release proof

Require independent legal and expected-result oracles, official validators, property-based invariants, parser fuzzing, and fiscal mutations that reject known-wrong treatment.
Use pinned OCA/Odoo and available SAGA results as comparative signals, not automatic truth.
Reconcile two real monthly closes and reviewed quarterly/year-end reference outputs.
Verify migration, company isolation, recovery, source traceability, and unresolved-obligation handling.
Publish only claims supported by reproducible reports; no invented case counts or claims of government certification.

Free accounting release must not depend on AI, model-provider availability, payment collection, or wallet migration.
Before broader hosted rollout, fund the published service envelope and prove recovery.
Before licensing changes, complete the rights review.
Before fiscal conformance claims, appoint the required independent reviewers and sign the evidence.
