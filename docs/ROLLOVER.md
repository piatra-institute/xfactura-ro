# Yearly rule rollover

Every rule version the engine uses is reviewed only up to a date (`reviewedThrough`). After that date the resolver refuses it (`BEYOND_HORIZON`). A version with an end date stops there (`NO_VERSION`). Nothing carries over into a new year by itself: each key must be checked against the acts published for that year, then either:
- given a new version, or
- reviewed again, which extends its `reviewedThrough`.

`rules.horizon` lists what expires within a window. Run the listing in [Checking](#checking) before every rollover.

## 2027 (checked 30 October 2026)

48 of the 50 keys stop on 1 January 2027:
- 46 are `BEYOND_HORIZON` because their review ends on 2026-12-31;
- 2 are `NO_VERSION` because their version ends that day.

`ro.vat.cash.ceiling` already has its 2027 version (5,500,000 lei). Whatever is decided, every key in the last column below must be reviewed again.

| Group | Keys | What decides them | Status on 30 October 2026 |
|---|---|---|---|
| Minimum wage and what depends on it | `ro.payroll.minimum_wage`, `ro.min_wage.contributions` (minimum wage on 1 January, for PFA bases), `ro.payroll.minimum_wage_relief` (**ends 2026-12-31**), `ro.sick.base_cap`, `ro.cas.independent`, `ro.cass.independent`, `ro.cass.option` | The government decision on the minimum wage; the act that would extend the relief | No decision yet. The labour minister said the wage stays 4,325 lei from 1 January 2027; that is a statement, not an act. |
| Rates and thresholds | `ro.vat.rate`, `ro.vat.rate.reduced`, `ro.micro.rate`, `ro.micro.revenue_limit_eur`, `ro.dividend.tax_rate`, `ro.interest.tax_rate`, `ro.pit.rate`, `ro.pit.loss`, `ro.pit.limits`, `ro.pit.natures`, `ro.pit.norma`, `ro.pit.rounding`, `ro.cas.rate`, `ro.cass.rate`, `ro.payroll.{cas,cass,cam,income_tax}.rate`, `ro.payroll.personal_deduction`, `ro.payroll.supplementary_deduction`, `ro.payroll.{amount,tax_base}_rounding`, `ro.sick.percent` | Fiscal measures for 2027, usually adopted in December (Codul fiscal amendments, budget laws) | Press reports mention fiscal measures for 2027, including removing the minimum turnover tax for large companies (IMCA) and the supplementary turnover tax (ICAS). Neither is used by the engine yet. No act read. |
| Determinations (added 30 October 2026) | `ro.size.thresholds`, `ro.vat.period.limit_eur`, `ro.vat.exemption.threshold`, `ro.payroll.quarterly`, `ro.micro.employee`, `ro.micro.linked`, `ro.deadline.D112.quarterly` | Codul fiscal art. 47–52, 80, 147, 310, 322; OMF 2036/2025; OMFP 1802 | Reviewed through 2026-12-31 like the rest; no 2027 act read. |
| Procedure and calendar | `ro.deadline.*` (D100, D112, D204, D205, D212, D300, D390, D394, D406, S1005), `ro.deadline.shift`, `ro.declaration.rounding`, `ro.fx.rate_date.*`, `ro.etva.significance`, `ro.cash.limits`, `ro.vat.deduction.limited` | Amendments to the Codul de procedură fiscală, OUG 59/2005 (rounding to whole lei), the declaration orders, Legea 70/2015, the e-TVA rules | Stable unless amended; review means confirming no amendment applies to 2027. |

**Declaration formats.** ANAF publishes each package as valid from a reporting period. Formats for the first 2027 periods are pinned once the packages exist. Until then a return prepared for 2027 reports `FORMAT_GAP`.

**What happens on 1 January 2027 without the rollover.** Every proposal dated 2027 that reads one of these keys is blocked with `RULE_GAP` and shows the key. The month can't close. Nothing is computed with a value that might be wrong.

## Checking

From `packages/xfactura-api`, list each key and whether it covers a date. This prints the same states the resolver would return:

```ts
import { defaultRegister } from './source/engine/engine';
const versions = (defaultRegister() as any).versions;
// For each key: does a non-withdrawn version cover 2027-01-01, and is its reviewedThrough ≥ that date?
```

The operation `rules.horizon {days}` shows the same for a running engine.
