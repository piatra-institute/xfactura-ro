# Post through one append-only kernel with generic database invariants

## Decision

Every accounting effect reaches the books through one path: a typed document, a pure treatment over a declared read plan, an effect (journal lines, open items, tax entries, schedules), a hashed proposal version, a binding (an exact human approval or a human-approved posting policy), and an atomic post that rechecks the read-set and re-evaluates the treatment.

Subledgers are journal lines tagged with an open item. Control accounts therefore equal their open items by construction. Treatments do not add tables or triggers of their own.

A fixed set of database invariants backs the application checks: append-only records, entry binding and balance, materialization of approved JSON into rows, row equality, period and tax-period locks, series numbering, approver authority and membership epochs. They live in one file and are installed after migrations by a checksummed, idempotent procedure.

## Consequences

Adding a treatment means adding pure code and tests, not a migration. Triggers are no longer migration history, so a generated table rebuild cannot silently drop one; a test fails if any trigger is missing.

Membership changes increment an epoch. Agent grants and posting policies bound to an earlier epoch stop working permanently, so reactivating a member does not revive old credentials.

## Rationale

The previous engine added interpretation, state, matching and control modules plus a trigger migration for each variant. That shape could not reach full VAT, payroll, assets or declarations.

## Revisit condition

Revisit materialization by trigger if a measured effect size exceeds SQLite statement limits; the fallback is typed kernel inserts checked by the row-equality invariant.
