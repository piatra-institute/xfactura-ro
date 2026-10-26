# Separate fiscal positions from the ledger

Planning decision; this records intended direction and does not claim implementation.

## Decision

Economic facts feed distinct accounting and fiscal interpretations, governed by a fact-specific Evidence Authority Matrix.

## Rationale

Tax bases, adjustments, credits and carry-forwards are not fully represented by accounting balances or a D101 serializer. Source conflicts cannot be resolved by model confidence.

## Consequences

Fiscal and accounting readiness differ; artifacts retain both snapshots. [ARCHITECTURE.md](../ARCHITECTURE.md) owns records and invariants.

## Revisit condition

Revisit representations through a public RFC with independent fiscal cases; preserve historical interpretations and artifacts.
