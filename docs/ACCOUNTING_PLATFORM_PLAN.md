# xFactura implementation plan

This is the working plan, not a claim that the proposed accounting capabilities are implemented.

## Product direction

Build free, open Romanian accounting infrastructure that minimizes manual work and switching costs.
Use an owner-first interface and accountant-first distribution.
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

Start with domestic RON, non-VAT, profit-tax services bookkeeping.
Add normal VAT, EUR/FX, EU services, assets, and annual coverage through independently reviewed profiles.
Normal VAT and special EU VAT identification are separate branches.
Evaluate D406 applicability for non-VAT companies too.
Annual reporting and all other applicable obligations are prerequisites to replacing a company's accounting system.
RO-SRV-01-SHADOW is the early workflow scope. RO-SRV-01-FULL-YEAR additionally requires complete obligation closure, fiscal-register/annual outputs, source continuity, authority and operational proof.

Use the same command API for owners, accountants, and agents.
Offer a minimal accountant portfolio view showing real exceptions and reporting freshness.
Retain the public invoicer while companies migrate through a reviewed opening position, current-year/fiscal-history continuity and a signed handover proof.
Keep typed proposals, deterministic calculations, exact-version approvals, and the filing receipt lifecycle.

## Delivery sequence

| Milestone | Result |
|---|---|
| A1 | Ledger/evidence/bank slice with idempotency, restart recovery, and company isolation. |
| A1b | Difficult VAT fixture: partial payment, next-month credit note, bank fee, reports, close, and correction. |
| A2 | RO-SRV-01 domestic non-VAT workflow and shadow close. |
| A3 | RO-SRV-02 normal VAT, e-Factura, and applicable reporting. |
| A4 | Real-company parallel pilot, migration proof, and two monthly closes. |
| A5 | EUR/FX and reviewed EU B2B branches. |
| A6 | Assets and separate accounting/fiscal depreciation. |
| A7 | Complete profit-tax positions, annual reporting, and applicable owner distributions. |
| A8 | Portfolio refinement; the minimal accountant portfolio ships by A4. |
| B1 | Provider-key explanations, extraction, and typed proposals. |
| B2 | Governed automation with measured outcomes and revocable policies. |
| B3 | Managed AI only after measured usage economics justify it. |

A4 is a parallel-accounting gate, not permission to skip annual obligations.
A limited production replacement can launch when its exact company/profile combination satisfies every replacement gate.
See [ROADMAP.md](ROADMAP.md) for the executable tickets and dependencies.

## AI and infrastructure boundary

Self-hosters use a regular Piatra AI user API key or an OpenAI/OpenRouter key.
Calls go directly from their backend to that provider.
No hosted xFactura commerce relay or privileged service credential is required.
Provider billing follows the regular user's account contract.

Use small IdentityProvider, AIProvider, ObjectStore, BankProvider, and TaxAuthorityConnector boundaries.
Piatra is an adapter; the accounting kernel has no Piatra-specific dependency.
BillingProvider is a future paid-service boundary, not an early prerequisite.
Defer prepaid wallets, retail tariff engines, and new billing gateway work.
A future managed paid mode retains the previously selected company-prepaid direction only if approved at B3.

The reference self-host deployment uses PostgreSQL and a local document volume.
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
