# Open-source strategy and licensing direction

## Shared standard, interoperable implementations

Publish the Accounting IR, profile definitions, case manifests, runner protocol and API contracts independently of the xFactura engine. Encourage other implementations, including other languages, to reproduce the same observable results.

The competitive assets are correctness, source traceability, migration, maintained conformance and reduced manual work. Publishing a standard allows compatible competitors; licensing is not a prohibition on competition or paid hosting.

## Target package licenses

| Artifact | Intended license after rights/boundary review |
|---|---|
| Accounting kernel, Romanian fiscal engine, server/application and tightly coupled engine integration | AGPL-3.0-only, subject to the rights and boundary review before application. |
| Independently authored Accounting IR/profile specifications, OpenAPI/schema definitions, standalone SDKs and suitable protocol interfaces | Apache-2.0. |
| Independent conformance runner and original interface-only adapters | Apache-2.0 where dependencies and coupling permit it. |
| Original synthetic case data and independently cleared benchmark facts | CC0-1.0 where the contributor has the rights; other material retains its explicit compatible license. |
| Existing/vendor/third-party material | Its current license and notices until a lawful reviewed transition applies. |
| Marks and branding | Separate published trademark policy, allowing truthful compatibility statements without implying affiliation. |

The existing repository is MPL-2.0. These targets do not change LICENSE files, package metadata, contributor rights or existing grants. Audit authorship, imported/vendor material, dependency licenses and package coupling; record permissions/compatibility and obtain qualified boundary review before any transition. Git authorship counts alone are not proof of exclusive rights. Resolve the licensing ADR before publishing new packages under the target policy.

MPL uses file-level copyleft and distinguishes server functionality from delivery of code to a user. AGPL section 13 adds a corresponding-source offer for users interacting remotely with covered modified software. This motivates the target direction; it does not mean every separate API client becomes AGPL or every hosted use is prohibited. Exact boundaries need review. [Mozilla MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/), [AGPL-3.0 text](https://opensource.org/license/agpl-3.0)

Do not change the license of copied code, schemas or test cases merely because their destination is a permissive specification package. Inspect module-level licenses when using OCA references or other integrations. Independent factual expected outcomes and copied implementation text are different provenance cases.

## Contributions and releases

Adopt [DCO 1.1](https://developercertificate.org/) sign-offs for original contributions with documented provenance; a sign-off does not assign copyright or silently authorize future relicensing. A contributor agreement would require a separate public decision. Record case-data rights and consent/anonymization review before publication.

Make source archives and matching build/release manifests available for released engine versions. Provide SBOMs, license notices, source links and the source-offer mechanism required by the final license policy.

Use public RFCs, named maintainers, independent fiscal reviewers, signed releases and a compatibility policy as defined in [GOVERNANCE.md](GOVERNANCE.md). Legal-text and validator artifacts retain their own redistribution rules; use pinned official downloads where redistribution is not established.

## Business boundary

Free fiscal updates, exports, basic APIs and self-hosting are durable commitments. Free hosted operation remains the chosen strategic subsidy, with the budget/support envelope in [OPERATIONS.md](OPERATIONS.md). Optional professional services can fund maintenance without making correctness proprietary.

Paid managed hosting is a possible alternative business model, not an adopted change. Any future proposal must explain effects on the existing free-hosted promise and migration/export continuity. Managed AI is deferred until measured economics justify the work. [PRODUCT.md](PRODUCT.md) and [AI.md](AI.md) own those decisions.
