# AI providers and governed autonomy

## Current boundary and planned provider path

The capability API and MCP are implemented. The built-in provider-key agent and MCP over OAuth are Phase 4 of the agent-first order in [ROADMAP.md](ROADMAP.md), after the engine plumbing for agents and the remaining regimes. [AGENT_API.md](AGENT_API.md) describes the implemented command/MCP surface and its current manual-credential connection path. The built-in accounting agent is not implemented yet. Agents may prepare work and execute exact human-approved versions; agent credentials never inherit the delegator's ability to approve.

The provider configuration, credential handling, model execution and autonomy requirements below specify that future accounting agent; they do not describe an existing accounting-agent settings screen. An external MCP client can operate current tools today. Neither external nor built-in models can supply missing VAT, payroll, tax-calculation or filing capabilities. [FEATURE_VISION.md](FEATURE_VISION.md) owns proposed grounded explanations, continuous close and governed automation experiences.

Implement company-owner configuration of provider keys, models, permitted actions and spending controls. Supported providers are Anthropic, OpenAI and any OpenAI-compatible endpoint: OpenRouter, local Ollama or vLLM, and Piatra AI, which is OpenAI-compatible. The backend calls them directly with the company's own key. Piatra's normal scopes, capabilities, limits and billing apply exactly as for other users.

No hosted xFactura commerce relay, privileged service credential, prepaid xFactura balance, or paid AI is required for accounting. Hosted company-supplied keys use the same adapters and have no xFactura AI surcharge. Provider billing remains with the provider account.

Credentials are encrypted, masked, rotatable and excluded from normal exports/logs. Unsupported model capabilities disable the action. Never silently change provider/funding source. Label usage estimates and explain that app limits cover xFactura calls, not all other use of the same key.

Disclose selected evidence sent to the provider and record evidence IDs/hashes, provider/model, time, requesting actor, purpose, action/policy ID, and configured retention/privacy settings. Raw prompt logging stays off by default. [SECURITY.md](SECURITY.md) owns input and egress controls.

## Typed actions and autonomy ladder

AI proposes facts or domain commands with source references. Arithmetic, eligibility, source authority, authorization and conformance remain deterministic/reviewed domain functions.

| Level | Capability | Required gate |
|---|---|---|
| L0 Observe | Explain books, source evidence, exceptions and readiness. | Authorized read scope; grounded citations and no invented facts. |
| L1 Propose | Create typed extraction/classification/accounting/fiscal proposals. | Schema/conformance checks; human review before consequential execution. |
| L2 Governed execution | Apply previously approved deterministic treatment policies automatically. | Explicit policy, covered scenarios, action limits, evidence and revocation. |
| L3 Continuous accounting | Run reconciliation, recurring accruals, depreciation and close checks. | Reviewed generators, freshness/completeness checks, durable jobs and exception handling. |
| L4 Continuous compliance | Keep applicable filing packages ready and cross-reconciled. | Signed fiscal packages, complete tax positions, validator and review readiness. |
| L5 Authorized external action | Submit exact approved artifacts under an applicable mandate. | Mandate, scoped authorization and artifact/policy approval; receipts tracked independently. |

The initial AI release is L0/L1. L2 follows measured shadow execution, not model confidence. L2 is earned per booking template; the engine implements it ([ACCOUNTING_ENGINE.md](ACCOUNTING_ENGINE.md#batches-templates-and-earned-autonomy)):
- every proposal a template would make is recorded next to the decision the person actually took;
- a policy can be requested only after a run of correct bookings: by default at least 6 across at least 3 months, no corrections, and unchanged rules; the owner or the accountant may tighten these criteria, never loosen them;
- a person approves the policy; it is limited by partner and amount, and expires after 90 days;
- what an agent read from a PDF or a photo never posts by itself unless the policy explicitly allows that source;
- a reversal or correction of an auto-posted entry, a new partner or an unusual amount demotes it automatically (the system pauses it until a person resumes it), and any member can pause automation.

Matching payments that already happened (`bank.settle`) can be earned this way. It records money that already moved and never moves any. L3/L4 are bounded by the company's released profile composition. Initial L5 requires per-artifact approval. Standing submission policies require a later reviewed RFC and cannot silently replace that decision.

Payments are a separate authority domain and remain outside the initial release. Permission to post an expense or submit a return never permits moving bank funds.

## Policy and risk

A policy records company/period scope, allowed commands, conformance/rule versions, counterparty and amount limits, authorized actor, expiry, review requirements, and revocation. Revalidate it at execution.

Gate autonomy on rule coverage, evidence quality/conflicts, materiality, novelty, counterparty risk and fiscal risk. Failure of a deterministic condition escalates the action even if the model is confident. Unknown treatment stays unknown; zero VAT and false/non-registration values must not be replaced by defaults.

Track proposed/executed outcomes, human corrections, policy exceptions, unexpected financial effects and reproducibility. Enable an immediate company/provider/policy kill switch. Every correction is linked; learning a company preference requires explicit review and cannot override law.

## Managed AI is deferred

A later built-in agent uses regular user/provider keys; reviewed governed policies follow measured accounting correctness. Managed AI requires a separate RFC after measured cost, support and usage show why provider keys or a simple allowance are insufficient.

A managed-AI RFC must show actual inference cost and distribution per company/action, operational/support overhead, funding, abuse limits, user demand, price transparency and failure handling. The previous prepaid-company direction is a candidate for that later decision, not a mandate to build a wallet now.

Defer retail tariff engines, micro-unit wallets, reservation ledgers, chargebacks, new billing gateways and per-request billing APIs. Do not require them for accounting or provider-key AI. If charging is approved later, use a BillingProvider adapter and require proper idempotency, reconciliation/refund tests and a reviewed merchant setup.

Preserve existing purchase/action records and honor legacy commercial obligations through an explicit fulfillment/refund path before retiring a legacy paid endpoint. They must not become an accounting-migration prerequisite or be silently converted, duplicated or discarded.

AI failure, provider budget exhaustion or billing downtime leaves free imports, bookkeeping, manual review, reporting, APIs and exports available.
