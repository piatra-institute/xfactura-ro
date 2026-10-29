# Resolve fiscal parameters explicitly and post semantic tax codes

## Decision

Fiscal parameters come from a source register: each parameter has one date axis, versions with effective intervals, a `reviewedThrough` date when open-ended, cited clauses and a review status. Resolution returns a value or a typed gap (`NO_VERSION`, `BEYOND_HORIZON`, `INSUFFICIENT_REVIEW`). It never falls back to a default or to the latest version. A gap blocks the dependent proposal and the period close and marks the obligation unsupported.

Tax entries record semantic attributes: tax, code, category, rate, direction, deductibility, tax point, exigibility and tax period. Declaration rows (D300, D394, D390, D406) are derived by versioned projections.

## Consequences

An invoice dated after the last reviewed period is visibly blocked instead of failing deep in a calculation. Parameters whose policy allows it may continue under an owner attestation for issuance; the period's filing still requires the signed package.

Correcting a declaration mapping produces a new projection version, not new postings.

## Rationale

The previous catalogue ended every VAT rule on 2026-12-31 and stored treatment-specific totals. Romanian rates, thresholds and forms change often; the books must survive those changes without rewriting history.
