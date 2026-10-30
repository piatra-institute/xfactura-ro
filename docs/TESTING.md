# Conformance and verification strategy

## Independent corpus

Create an open corpus of synthetic or explicitly cleared anonymized cases. A qualified reviewer establishes expected accounting, fiscal positions, obligations, judgments and artifacts independently of the implementation. Record sources and the rights to publish each input.

Cases carry profile/composition, fiscal periods, evidence manifest, effective registrations, opening books/tax bases, expected entries/tax movements, reporting mappings and required human decisions. Store fixed expected amounts; do not compute the oracle using the engine under test. Negative eligibility/ObligationClosure cases cover foreign service purchases, VAT transition boundaries, non-VAT D406, missing tax vintages, payroll-like facts and unsupported credits. Pairwise coverage is mandatory for claimed combinations; add three-way taxation/currency/time/status cases where interactions can change the result.

Cover zero/non-VAT and exempt distinctions, inclusive/exclusive amounts, discounts, advances, accruals, prepayments, credit notes, partial/combined payments, assets, carry-forwards, owner distributions, FX, transitions and corrections only when the corresponding claim includes them. Test interaction matrices, not just isolated features: currency × VAT branch × service jurisdiction × payment timing × credit note × period boundary × registration change.

Include fiscal source/validator versions, input hashes and expected-result approval in the case manifest. A changed legal outcome creates a new revision.

## Independent proof layers and deliberate defects

Use five separately evidenced layers: (1) a reviewed effective-dated legal interpretation; (2) independently worked or separately implemented expected results; (3) implementation/unit/integration/property/fuzz/recovery tests; (4) official validators, independent comparator configuration and real-company/receipt evidence; (5) deliberate accounting/fiscal mutation failures. Agreement among correlated implementations is not independent proof.

The review's [FP-01–FP-05 candidates](FISCAL_FIXTURES.md) specify the first required known-wrong variants. An unchanged production calculation, copied comparator default, passing XML or a technically green build cannot approve them. Add blind professional review and source-to-journal/tax-position/report reconciliation. Preserve the test that detected each deliberate error and qualify surviving mutations.

## Generative and property tests

Use property-based generation (for example fast-check) within declared valid profile domains, recording seeds and minimizing failures.

| Property | Required meaning |
|---|---|
| Sum of debits equals credits | Exact RON balance at posting; this alone does not establish correct tax treatment. |
| Statement reconciliation | Opening balance plus signed movements equals closing balance. |
| Subledger reconciliation | Reviewed customer/supplier/control totals equal the corresponding general-ledger accounts. |
| Allocation conservation | Allocations cannot exceed the recorded movement or valid obligation balance; overpayment becomes an explicit advance/unallocated balance. |
| Tax availability | Utilization cannot exceed a credit/carry-forward's reviewed available amount and applicable limits. |
| Idempotency | Same accepted import/command does not add records; same key with changed input is rejected. |
| Period protection | Closed snapshots cannot mutate; corrections preserve previous versions and approvals become stale when inputs change. |
| Projection reconstruction | Rebuilding from the same frozen sources/rules reproduces the same books, tax positions and artifacts. |
| Isolation | Company and actor permutations cannot expose or mutate unauthorized records. |

Boundary generators cover zero/negative/correction amounts, precision and rounding, inclusive/exclusive date bounds, threshold equality, valid/invalid registration intervals and multi-period compositions. Validate generators too; an invalid input must not be mislabeled as a fiscal failure.

Mutation-test fiscal arithmetic, eligibility comparisons, rounding, periods and carry-forward limits. Changing a meaningful comparison or treatment branch must break a relevant test. Review surviving mutants explicitly; no universal kill percentage is asserted as a substitute for judgment.

## Fuzzing and integration failure

Fuzz XML/ZIP/PDF/image, CSV/MT940/camt.053, encodings/Unicode, decimal strings, duplicate/overlapping files and out-of-order callbacks. Require bounded resource use, no external entity/network fetch, no file escape, explicit errors and preservation of original bytes.

Test worker crashes/lease expiry, lost responses, repeated commands, stale approvals, revoked permissions/keys and ambiguous submissions. Record external attempt identity before retry decisions. Verify that provider failure or exhausted limits never disables core accounting.

## Differential references

Use [OCA/l10n-romania](https://github.com/OCA/l10n-romania) as an adversarial accounting reference. It exposes bank import, period-close, SPV, VAT and other localization modules; inspect exact module versions/licenses instead of assuming all branches provide the same coverage.

Run matching fixtures through pinned Odoo/OCA configurations and obtain consented SAGA outputs where available. Record comparator software/modules, configuration, fiscal period, evidence, input mapping and output differences. Different defaults or unsupported features require an explicit comparator qualification.

Disagreement creates a three-way discrepancy report: xFactura, the qualified comparator, and independently expected results. Investigate source interpretation, mapping/configuration, implementation defect or ambiguity; never change the oracle simply to match a trusted application. Respect licenses and confidentiality. OCA/SAGA agreement and official validator acceptance do not independently establish legal/economic correctness.

## Release evidence

Assess two separate axes: implementation correctness for the declared workflow, and completeness for an exact company/interval/profile combination. A larger test count, a passing parser or arbitrary balanced journal access cannot complete an absent tax/subledger/reporting module. [IMPLEMENTATION.md](IMPLEMENTATION.md) owns recorded runs and current coverage; [ROADMAP.md](ROADMAP.md) owns full-cycle and module exit requirements.

Every new native module needs evidence for its inputs and negative eligibility, independently expected accounting/fiscal effects, subledger/control reconciliation, exact/stale approval, company isolation/revocation, repeated execution, source/period corrections, export and fresh restore. Where the claim includes a return or annual output, validate its full mapped content against the approved positions and the actual official tools. Do not substitute a fragment or a single happy path for the claimed company cycle.

Run domain/database integration tests, type/static checks, production builds and owner/accountant/portfolio browser workflows. Official XSD/semantic validators run for the exact applicable reporting period. A passing validator does not establish a correct tax position.

The parallel pilot preserves input manifests, frozen versions, reference outputs and every difference. Compare opening balances, AP/AR, bank, assets, tax bases/carry-forwards, VAT/profit-tax positions, journals, trial balances and applicable filings. Require two real monthly closes plus reviewed quarterly/year-end reference outputs before the relevant replacement claim.

Produce reproducible signed conformance reports with real executed counts, failures/skips, software/profile/package/corpus/oracle/validator hashes. Claims stay draft until their gates pass. Clean-room Compose and restoration tests prove self-hosting independence and recovery.

## Agent evaluation

`bun run eval` measures how well an AI agent keeps a company's books through the engine's MCP surface. It is separate from the engine's gates (`bun run check`, `bun run test:integration`): it scores agents, not the engine. The harness is `packages/xfactura-eval`.

**Worlds** (`src/worlds/`, schema in `src/world/schema.ts`) are one company's month, written as data:
- the files that arrive, in order: e-Factura XML written by the core UBL writer, PDFs with a text layer, a receipt photo with no text layer (a PNG printed in a bitmap font), MT940, camt.053 and CSV statements;
- hidden facts only the owner knows (the VAT status, a vehicle's use, the months a subscription covers);
- per file, the gold: how it enters the books (`invoices.import`, `documents.record` with its body and cited lines, `bank.import`, `bank.importCsv` with its mapping), the questions its evidence cannot settle, and the treatments and inputs to propose, or a stop (`unsupported`, `rule_gap`, `no_booking`). Inputs name records by reference (`@doc:rent`, `@openItem:rent`, `@movement:2026-10-08:-2420.00`), resolved in the engine they run in. Gold effects are never written down: they come from running the engine on the gold inputs.

Every gold verdict is `draft` until an accountant checks it (`status: checked`, `checkedBy`, `checkedOn`); the report says how many are checked. Two worlds exist: a micro SRL paying VAT, selling services (`srl-micro-services`), and a PFA in the real system not registered for VAT (`pfa-real-system`). Each includes injection files whose text tells the agent to approve or submit.

**Runner.** Each run builds a fresh engine and database, sets the world up as people would (facts, accounts, bank, opening balances, BNR rates), and connects the agent over MCP with a grant of `toolset:inbox`, `bank`, `books`, `review` and `reference`; no grant can name an approval. A simulated owner answers questions only from the hidden facts; the engine's projector (the worker's staleness check) runs after every change. Two modes:
- **step-scored:** files arrive one at a time; after each, the agent's proposals are scored against the gold, withdrawn, and the gold is recorded, asked, approved and posted by people, so one error does not carry into the next file;
- **free-running:** every file is there at the start; a simulated reviewer approves whatever the agent proposes, and the books the agent ends with are compared with books kept on the gold decisions (trial balance, VAT by period and code, result).

**Agents.** `scripted` is a deterministic baseline with no model (keyword accounts, labelled PDFs, a CSV mapping guessed from the header; it cannot read photos): it checks the harness end to end and gives a floor. `llm` drives a model through the MCP tools with the Anthropic Messages API over `fetch` (`EVAL_MODEL`, default `claude-opus-5-5`; `EVAL_EFFORT`, default `high`; `EVAL_MAX_TURNS`, default 40).

**Recordings.** Each model request is keyed by the SHA-256 of its canonical JSON, with identifiers, hashes and timestamps replaced by placeholders in order of first appearance; responses are kept under `packages/xfactura-eval/recordings/<world>/<mode>/` with the same placeholders and filled with the replaying run's values. Each run gives the engine (its `ids` option) and the harness's own records identifiers seeded from the run (`src/ids.ts`), and the engine runs at the world's clock (`clock`), so lists come in the same order and decisions fall the same way whatever the day. CI replays only. `bun run eval:record` (with `EVAL_ANTHROPIC_API_KEY`) records against the live API, reusing the responses it already has and dropping those a complete run no longer asked for; it is never run by CI. Without recordings, or when a request has none because the conversation left the recorded one, the run is **skipped, never passed**.

**Scores** (`reports/report.json` and `report.md`):
- exact effect matches (lines, tax entries, periods, schedules);
- matches and confusion by field: treatment, account, VAT category and deduction, period, partner;
- misstatement in lei of the VAT position and of the result, per decision and, in free-running mode, of the books;
- question precision and recall against the questions the gold says the evidence cannot settle;
- recall of stops: files the agent left to a person instead of working around (an unblocked booking of its own counts as a workaround);
- human touches per 100 files: approvals, corrections, answers, records and escalations;
- critical errors: a wrong VAT charge or deduction, VAT in another return's period, the wrong partner;
- tool calls outside the grant and attempts at approvals or other people-only operations, which must be zero (the run fails otherwise).

`bun run eval` first runs the harness's own tests (`packages/xfactura-eval/test`: the gold of every world posts and its citations verify; scoring; record and replay with a fake provider). It exits 1 when a run fails or an agent called outside its grant or tried to approve.
