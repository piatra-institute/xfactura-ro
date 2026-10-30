# xFactura documentation

xFactura's goal is a free, open Romanian accounting suite operated through a shared API/MCP, with a concise interface for evidence, exceptions and approval. Start with the current coverage before reading the target architecture. A feature described in a plan is not an implemented accounting capability.

## Start with the question

| Question | Authoritative document |
|---|---|
| Can a company use xFactura as its sole accounting system today? What works, and what blocks that? | [IMPLEMENTATION.md](IMPLEMENTATION.md): product coverage, macro position and recorded verification. |
| What does each implemented accounting workflow accept and produce? | [ACCOUNTING_ENGINE.md](ACCOUNTING_ENGINE.md): supported inputs, calculations and limits. |
| What must be built, and in what order? | [ROADMAP.md](ROADMAP.md): the nine-step sequence, module backlog and completion gates. |
| What would make the product exceptional? | [FEATURE_VISION.md](FEATURE_VISION.md): concrete owner/accountant experiences, dependencies and measures. |
| What is the overall plan? | [ACCOUNTING_PLATFORM_PLAN.md](ACCOUNTING_PLATFORM_PLAN.md): concise design and delivery overview. |
| What can an external agent actually do? | [AGENT_API.md](AGENT_API.md): implemented API/MCP commands and authorization. |
| Which provider keys and autonomy levels are intended? | [AI.md](AI.md): current external-agent boundary and planned built-in agent/policies. |

## Domain and release references

| Concern | Document |
|---|---|
| Audience, free accounting, distribution and UI purpose | [PRODUCT.md](PRODUCT.md) |
| Conformance profiles, company eligibility and complete obligation coverage | [CONFORMANCE.md](CONFORMANCE.md) |
| Dated regulatory planning findings | [REGULATORY_BASELINE.md](REGULATORY_BASELINE.md) |
| PFA, II and IF: single-entry books, income tax, contributions, D212 and D204 | [PFA_II_IF.md](PFA_II_IF.md) |
| Yearly rule rollover and what stops on 1 January | [ROLLOVER.md](ROLLOVER.md) |
| Evidence, accounting/fiscal branches, invariants and architecture | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Implemented purchase corrections | [CORRECTIONS.md](CORRECTIONS.md) |
| Historical books, tax history and migration activation | [MIGRATION.md](MIGRATION.md) |
| Candidate independently reviewed fiscal calculations | [FISCAL_FIXTURES.md](FISCAL_FIXTURES.md) |
| Verification, independent oracles and known-wrong cases | [TESTING.md](TESTING.md) |
| Fiscal-rule governance and reproducible releases | [GOVERNANCE.md](GOVERNANCE.md) |
| Trust boundaries, privacy and credential controls | [SECURITY.md](SECURITY.md) |
| Self-hosting, subsidy capacity and recovery | [OPERATIONS.md](OPERATIONS.md) |
| License and contribution direction | [OPEN_SOURCE.md](OPEN_SOURCE.md) |
| Black theme, Romanian labels and verification UI | [DESIGN.md](DESIGN.md) |
| Decision rationale | [adr/](adr/) |

## Maintaining the documents

Keep implemented coverage and verification in `IMPLEMENTATION.md`, exact behavior in `ACCOUNTING_ENGINE.md`/`AGENT_API.md`, and open delivery work in `ROADMAP.md`. `FEATURE_VISION.md` owns product outcomes and candidate ideas; it is not a second implementation tracker. Update facts in place and link their owner instead of copying test counts, module status or legal values into several files.

The regulatory baseline remains a dated planning reference; a documentation update is not a new legal review or a signed fiscal release. The [chat export](../chats/agentic_accounting_romania_chat_export.md) is design background. Its examples and proposed domains do not establish implemented support, passing corpus counts or current legal requirements.
