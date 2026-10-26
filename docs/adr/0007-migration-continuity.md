# Midyear migration requires fiscal-year continuity

Planning decision; this records intended direction and does not claim implementation.

## Decision

Require an approved MigrationHandoverManifest containing current-year accounting history, separate fiscal vintages/positions, original evidence, reconciliations and explicit pending-filing responsibility before midyear replacement activation.

## Rationale

A balanced cutover trial balance can conceal missing first-half classifications, accruals, tax positions or submission authority. A declaration's due date can fall after handover while its economic period precedes it.

## Consequences

Staging is abandonable without changing official books. Post-activation reversal is a controlled handback/correction. Missing history blocks full replacement or requires an explicitly reviewed responsibility partition; it cannot be replaced by a fictional reconstructed ledger. [MIGRATION.md](../MIGRATION.md) owns the contract.

## Revisit condition

A future verified import source may reduce manual handover work only when it reproduces the same source, tax-history and responsibility proof. It does not remove the proof obligation.
