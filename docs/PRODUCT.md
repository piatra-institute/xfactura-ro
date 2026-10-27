# Product contract

## Purpose and audience

xFactura should make accounting understandable and largely automatic for Romanian companies. Owners see what the company has, owes, is owed, and must do next. Accountants inspect, explain, correct, and close the same books without re-entering information.

The initial commercial audience is companies below €1M annual turnover. Revenue is not a domain eligibility rule, license restriction, or feature lock. The actual complexity vector and supported combinations live in [CONFORMANCE.md](CONFORMANCE.md).

## Durable promises

- Hosted accounting and self-hosting are free, including applicable fiscal updates, collaboration, reports, filings, basic API access, and complete exports.
- Core accounting works without AI, an AI balance, or Piatra credentials in the reference self-host deployment.
- Information entered once feeds every applicable calculation and artifact. Unknown facts and unresolved differences remain visible.
- Every total leads to contributing records and retained evidence. Cash, profit, estimated tax, approved tax, and accepted filings remain distinguishable.
- Migration is reviewable and reversible before activation. Original exports and historical evidence remain available.
- Coverage claims identify exact profiles and versions. Unsupported cases receive an explicit explanation and resolution path.

## Experience and distribution

Use an owner-first interface and accountant-first distribution. Recruit accounting partners for the parallel pilot, conformance cases, and company migrations; they are design and review partners, not merely a later sales channel.

Treat the UI primarily as a verification and decision layer. External MCP clients and the built-in Piatra AI/BYOK agent use the same capability contract to collect evidence, prepare work and execute authorized versions. People inspect sources, exact effects and exceptions; routine operation should not require re-entering data into forms. Keep professional registers and manual fallbacks available. Initially, humans authorize postings and consequential actions; agents cannot approve their own work.

Ship a minimal accountant portfolio by the first real-company pilot: company membership, reporting period, import freshness, bank differences, blocked closes, missing evidence, and rejected/pending filings. Each item opens the affected company's workbench with its own authorization check. Portfolio counts come from actual exception states; they do not invent an overall health confidence.

The owner home prioritizes actions requiring a decision, reconciled money, receivables/payables, and obligations. Every review item shows the source, proposed accounting/fiscal treatment, reason, effect, and exact decision needed. Professional journals and registers remain available beneath this interface.

## Free hosting and funding

Keep the agreed free-hosted commitment as a strategic subsidy. Define and fund its admission capacity, operating budget, support envelope, and funding horizon before broad enrollment. The controls and launch inputs are maintained in [OPERATIONS.md](OPERATIONS.md).

A subsidy limit can pause new onboarding or require a published capacity plan. It must not silently introduce charges, disable existing exports, or make fiscal correctness a paid feature. Publish storage/upload/rate constraints before users depend on the service.

Optional migration services, professional support, enterprise operation, bank aggregation, or signing services may fund the project under separate explicit offers. None is a hidden prerequisite for free accounting. Paid managed hosting would change the agreed commitment and requires a new product decision; it is not introduced by this plan. ERPNext provides a useful comparison for separating free software from paid operational services, not a decision to copy its prices. [ERPNext pricing model](https://frappe.io/erpnext/pricing)

## Optional AI

Company owners choose providers and permissions. Regular Piatra AI, OpenAI, and OpenRouter keys connect directly from the instance backend. Provider charging remains with that account. A self-hoster needs no xFactura commerce account.

Prioritize correctness, migration, and reduced human work over AI monetization. Do not justify hosting with hypothetical AI margins or treat the critique's example token cost as measured usage. [AI.md](AI.md) owns the autonomy ladder and economic gate for future managed AI.
