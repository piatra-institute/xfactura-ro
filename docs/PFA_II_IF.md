# PFA, II and IF: sourced specification and architecture proposal

Prepared 30 October 2026 for the xFactura engine (`packages/xfactura-core`, `packages/xfactura-api/source/engine`). Sections 0–6 are the research; §7 records what was then built (phases P0–P3, including D212; the web form's structure is in [D212_WEB_FORM.md](D212_WEB_FORM.md)).

**Status of every value below: `extracted`.** An expert contabil has not reviewed any of it. Where a value comes only from a secondary source, or from an official text that disagrees with another official text, it is marked **[SECONDARY]** or **[CONFLICT]**. "Code" means Legea 227/2015 privind Codul fiscal, as consolidated by ANAF (text updated through Legea 204/2026). "Norme" means its methodological norms (HG 1/2016 as amended), from the same file.

---

## 0. Sources read

| Id (proposed) | What | URL | SHA-256 | How read |
|---|---|---|---|---|
| ANAF/Cod-fiscal-consolidat | Codul fiscal + norme, ANAF consolidation (last update Legea 204/2026) | https://static.anaf.ro/static/10/Anaf/legislatie/Cod_fiscal_norme_2023.htm | aba0c753fd326414d4327af00bc56269024a9c248857096aef7354a68013e7c1 (repo `.sources/`, same hash as register) | full text, HTML stripped locally |
| OMFP170/2015 | Reglementări contabile privind contabilitatea în partidă simplă (MO 139/24.02.2015) | https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_170_2015.pdf | 158d5ad1647f0fc613c0315bc09fd3a99494e189d717444f01b2d95f5eedfd37 | full |
| OMFP3254/2017 | Registrul de evidență fiscală (MO 10/05.01.2018) | https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_3254_2017.pdf | 4b241a874d513dce4559dfa326afc72ff355fa91306969463d78f937d3c3b0d2 | full |
| OMFP925/2017 | Nomenclatorul activităților pentru norme de venit | https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_925_2017.pdf | 42cf3241aa5aac83b8125d9a7ab302ada5013417cc0a3f570c88b2d320695172 | header only |
| OMF1960/2025 | Modifies OMFP 925/2017 for CAEN Rev. 3 (MO 1215/30.12.2025) | https://static.anaf.ro/static/10/Anaf/legislatie/OMF_1960_2025.pdf | c2b018724003861220f3f2b242d11718d8be33f307ed72c4f1efaac0d1fab10d | header; "applies from income of 2026" is [SECONDARY] (contabilul.manager.ro) |
| OMFP2634/2015 | Documentele financiar-contabile | https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_2634_2015.pdf | 295230f6e767e378fa293dff1bc5a02362e876f9dd8b4183de5e41946863c7ff | pct. 47–49 (annexes 2–3 are in MO 910 bis, not available) |
| L82/1991 | Legea contabilității (ANAF copy, old consolidation) | https://static.anaf.ro/static/10/Anaf/legislatie/Legea_82_1991.pdf | 4ba2780cc74bc427d7b5ec66edb0d83bdb92af1bd8d87e21a97955b7b486c591 | art. 1, 4 |
| OUG44/2008 | PFA, II, IF (ONRC consolidation to 17.01.2017, after Legea 182/2016) | https://www.onrc.ro/documente/legislatie/15.11.2017/OUG%20NR.%2044%20-%202008.docx | 2ff04cbad6fd4aede526d8ee706398a4ec3257ad10dc9daa46c1fbae4af496e8 | art. 15–34. Later amendments not checked. |
| L239/2025 | Măsuri de redresare (MO 15.12.2025): Code art. 67–69, 68^3, 148, 170, 174; Legea 70/2015 | https://static.anaf.ro/static/10/Anaf/legislatie/L_239_2025.pdf | 376bcec34439ffc37f2e74a83d12f828eab1ba6471e772ec6ce12dc2981ccd08 | art. II, XII pct. 3–6, 18–20, XIII |
| L141/2025 | Măsuri fiscal-bugetare | https://static.anaf.ro/static/10/Anaf/legislatie/L_141_2025.pdf | ee46f1e5164bdd0262de8707269cb83d263dadf40366f5b273e79699bbc434ef | searched only: no change to art. 148/170/174 |
| L204/2026 | Approves OG 22/2025 (last consolidation step) | https://static.anaf.ro/static/10/Anaf/legislatie/L_204_2026.pdf | a52b4fe486fba7a298c320822bf34ac53bbce187162e880da6d10d948b1d9b0a | title only |
| L70/2015 | Numerar (ANAF copy = original text) | https://static.anaf.ro/static/10/Anaf/legislatie/L_70_2015.pdf | 772976efe067b1a229291afbe7a6a430c01bad29ad3c1f9edcb4ccf6cd6f5571 | art. 3–4; art. 4^2 absent from this copy |
| HG1506/2024 | Salariul minim 4.050 lei de la 1.01.2025 | repo `.sources/HG1506_2024` | c829e477306d69e8f1e1d523baf2b6375cda7961dd34219bc36a9d6ae4d5e4f5 | via register clause |
| HG146/2026 | Salariul minim 4.325 lei de la 1.07.2026 | https://static.anaf.ro/static/10/Anaf/legislatie/HG_146_2026.pdf | 3dce4be85c2330ff6c79049014c538081c2e55de647125072e8b6937cc8f2488 | via register clause |
| OPANAF2736/2025 | Formular 212 (MO 1207 bis/29.12.2025): income 2025, CASS option 2026 | https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_2736_2025.pdf | 6d1afc4fdd317662d8982421e5df745abaf7796300cf144670f424a68ccae3f0 | form layout (annex 1) |
| ANAF/D212-instr-2736 | Instrucțiuni D212 (annex 2) | https://static.anaf.ro/static/10/Anaf/formulare/Instructiuni_D212_2736_2025.pdf | eb5609f85728d2fdaa62c244623fbe6ec37e50f461d049666be049f2a33d35ef | parts I–IV, sec. 8 |
| ANAF/D212-structura-1.0.3 | XML structure D212_A1.0.3, v11, 01.08.2025 (OPANAF 1929/2025: income 2024) | https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/structura_D212_2025_v1.0.3_01082025.pdf | b01d056ed97c9d12cc1ad4dd5f358ec2c04f539c41840a9def42b0e3e424e39d | element list, nomenclators |
| ANAF/D212Validator-J13.0.1 | DUKIntegrator package (J13.0.1, P10.0.0) | https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/D212Validator_01082025.zip | 58abef98dd0e5147dfe8c6842014d04c9595841000f8a13a0113b6b78ca61f4d | version history; not run |
| ANAF/D212-xsd-v9 | Last published XSD (namespace v9) | https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/d212_20250113.xsd | 458a9c61ad0579b50a1c42655766c900b623d94754dc259130e08dc2a7bb0fe4 | header |
| ANAF/D212-page | ANAF declaration page (fetched 30.10.2026) | https://static.anaf.ro/static/10/Anaf/Declaratii_R/declaratie_unica.html | 4b9849d266b6662752be2de48cd58815fd62194254d64b511710fabc6586d07d | full |
| ANAF/D212-web | ANAF web form "Declarație Unică 2026", V-1.8.10 / 15.05.2026 | https://www.anaf.ro/declaratii/duf | page 80dd4fc7fc1bb16ccb158da8a6d42b7740a753791de71fb17be503a2ad4763a8; bundle `0q0aa-_tiydwh.js` e93cef76053d11622890e2ad9b48505d4f42d0f377c3477135170e6ed0d10337 | sections; XML root attributes in the public JS |
| ANAF/D212-ghid-2026 | Ghid precompletare D212 2026 v1 | https://www.anaf.ro/declaratii/Ghid_Precompletare_Declaratie_Unica_D212_2026._v1.pdf | 8dee0477272d702bbef21c29bb5a5251cc119cd18f0729672f9274e95cad2808 | deadlines, bonus |
| ANAF/D212-brosura | Broșură D212 2025 | https://static.anaf.ro/static/10/Anaf/AsistentaContribuabili_r/Brosura_Declaratia_Unica_212_2025.pdf | b847c110eb4b78ae000d5d775e3352f42b81384ed8500b00e064ec82162f93c9 | grep only |
| OPANAF97/2019 | Formular 204 (associations) | https://static.anaf.ro/static/10/Anaf/legislatie/OPANAF_97_2019.pdf | d389db58065d6de85c119cca7d1aadc3fd9bf3a659f5caef83d55de76cfecdf0 | instructions pct. 1–3 (superseded by OPANAF 90/2022 per ANAF's page; 90/2022 not read) |
| ANAF/D204Validator-2026 | D204 validator package (16.01.2026) | https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/D204_16012026.zip | 5679dd855e0142f066a3715101ed803e079f3dba2416d3f43ccf529bdd541aee | listing only |

Not obtained: OMFP 1040/2004 (repealed); OPANAF 90/2022 (D204); the annual budget law that sets the 2025-income bonus; DGRFP norm publications; OMF/ANAF order on SAF-T scope for individuals; the text of Legea 70/2015 art. 4^2.

---

## 1. The legal model

### 1.1 Who and which regime

- **Forms (OUG 44/2008).** PFA (art. 16–21), II (art. 22–27), IF (art. 28–34). PFA may employ at most 3 people (art. 17 alin. (1)); II at most 8 (art. 24 alin. (2)); IF may not employ (art. 28 alin. (4)). IF: 2+ family members, written acord de constituire with each member's quota of net income/loss and a representative (art. 29); no patrimony or legal personality of its own (art. 30 alin. (1)); members liable jointly by quota (art. 31).
- **Income category.** Income from production, trade, services and liberal professions, individually or in association (Code art. 67 alin. (1)); from 2026 also accommodation services and short-term letting of more than 7 rooms (art. 67 alin. (1^1), L239/2025 art. XII pct. 3; applies from income of 2026, art. XIII alin. (2) lit. b)).
- **Three ways to determine net income:**
  1. **Sistem real** (art. 68): gross income minus deductible expenses, on single-entry books. Default; mandatory for liberal professions and for non-nomenclator activities.
  2. **Normă de venit** (art. 69): for activities in the nomenclator (OMFP 925/2017 as amended by OMF 1960/2025), except liberal professions.
  3. **Accommodation services** (art. 68^3, from 2026): 30% flat expenses, final 10% tax; only the income part of the fiscal register.
- **Tax rate:** 10% (art. 64 alin. (1) lit. a)). Amounts rounded to the leu, 50 bani down (art. 66; norme pct. 4).
- **Fiscal period:** calendar year (art. 65).

### 1.2 Sistem real: gross income (art. 68 alin. (2)–(3); norme pct. 7)

Cash basis. Gross income includes:
- amounts **collected** and the lei value of in-kind income (alin. (2) lit. a));
- interest on commercial receivables (lit. b));
- gains on transfer of business assets (lit. c));
- non-compete income (lit. d));
- cancelled or forgiven debts (lit. e));
- taxi fiscal-register income (lit. f)).

The norms add (pct. 7 alin. (1)–(2)):
- advances collected for other years;
- bank interest on business funds;
- invoices collected after cessation;
- business assets passing to the personal patrimony, valued at market price.

**Not gross income (alin. (3)):** contributions in cash or kind, loans and bank credits, compensation (despăgubiri), sponsorship, patronage and donations received.

Collected VAT is not income (OMFP 3254/2017 art. 4 alin. (3)).

### 1.3 Sistem real: deductible expenses (art. 68 alin. (4)–(7); norme pct. 7 alin. (4)–(8))

**General conditions (alin. (4)):** an expense is deductible if it is:
- incurred in the activity and documented (lit. a));
- **paid in the year** (lit. b): cash basis);
- a salary expense as defined by cap. III (lit. c));
- within the Title II depreciation rules (lit. d)).

Also deductible:
- insurance premiums on business assets, assets pledged for credit, leased goods, and professional risk (lit. f));
- travel of employees (lit. g)) and of the taxpayer (lit. h));
- contributions to own social-insurance systems and mandatory professional contributions (lit. i));
- non-depreciable assets of art. 28 alin. (4): deductible at sale (lit. k)).

Advance payments for later years are deductible when paid (norme pct. 7 alin. (5) lit. v^1)). Running costs of premises are deductible even if the documents are in the owner's name.

**Limited deductions (alin. (5)), with the base in alin. (6):** the base is gross income minus deductible expenses other than scholarships and protocol.

| Lit. | Expense | Limit |
|---|---|---|
| a) | private scholarships | 5% of base |
| b) | protocol | 2% of base |
| c) | social expenses | 5% of annual salary costs |
| d) | losses, perishables, expired goods | per specific law |
| e), f) | meal vouchers, holiday vouchers | per law |
| g), g1), g2) | voluntary, occupational and PEPP pensions (personal) | 400 EUR/year per person, each |
| h) | voluntary health insurance, medical subscriptions (personal) | 400 EUR/year per person |
| i) | mixed personal/business | business share only |
| j) | car operating costs | per alin. (7) lit. k), at most one car per person |
| k) | employer social contributions | listed without a figure: see open question 14 |
| m) | occupational safety | per law |
| n) | interest on non-bank loans | BNR reference rate at repayment (lei); art. 27 alin. (7) lit. b) rate (foreign currency) |
| o) | leasing | operational: rent; financial: depreciation and interest |
| p) | professional associations | 4,000 EUR/year |
| q) | mandatory professional contributions | 5% of gross income |
| r) | sport subscriptions (CAEN 9311–9313) | 100 EUR/year per person |
| s) | ETF purchases (personal) | 400 EUR/year per person |

EUR limits are converted at **BNR's average rate of the year of payment** (norme pct. 7 alin. (6)).

**Not deductible (alin. (7)):**
- personal and family use;
- expenses tied to non-taxable income;
- income tax;
- other insurance;
- donations;
- fines, penalties and late-payment interest owed to authorities;
- loan instalments (principal);
- **acquisition of depreciable assets in the Registrul-inventar** (lit. h): recovered through depreciation only);
- uninsured missing or degraded goods;
- tax borne for others;
- **50% of the costs of road vehicles** of at most 3.5 t and 9 seats not used exclusively for the business. Depreciation is excluded from this limit. The exceptions 1–5 are deductible in full. Exclusive use is shown by a foaie de parcurs (norme pct. 7 alin. (7), which refers to the VAT norms on art. 298);
- depreciation of personal assets used in the business (lit. k1));
- sponsorship and patronage (lit. k3));
- corruption-linked expenses (lit. k4)).

**Change of form while continuing the activity (alin. (7^1); norme pct. 7 alin. (2)–(3)), e.g. PFA → II:**
- transferred assets and uncollected receivables are not income;
- assets taken into the personal patrimony are income at market value;
- net income and loss are computed per period and added up for the year.

### 1.4 Fixed assets and depreciation

- Depreciation follows Title II art. 28 (art. 68 alin. (4) lit. d)).
- **Threshold:** a fixed asset is a tangible asset with a **fiscal entry value of at least 5,000 lei** and a useful life over one year (art. 28 alin. (2)). Assets of 2,500–5,000 lei held on 31.12.2025 keep depreciating (Title II art. 45 alin. (21^3)). That suggests 2,500 lei applied before 2026; the amending act was not identified. Whether alin. (21^3) reaches PFAs is open question 12.
- **Methods (art. 28 alin. (5)–(8)):**
  - buildings: straight-line;
  - technological equipment and computers: straight-line, degressive or accelerated;
  - other assets: straight-line or degressive;
  - super-accelerated depreciation for new subgroup 2.1 and 2.4 assets commissioned in 2026 (alin. (8^1)).
- **Registers:** all goods, rights and obligations of the business go into the Registrul-inventar (norme pct. 7 alin. (8)). Fixed assets each get a Fișa mijlocului fix 14-2-2 (OMFP 170 cap. III pct. 17).
- **Disposal:** the undepreciated value of a sold asset is deductible up to the sale proceeds (norme pct. 7 alin. (5) lit. o)).
- **Switching to a normă:** depreciation under the real system does not reduce the norm. Selling such investments increases the norm (norme pct. 8 alin. (12)).

### 1.5 Fiscal register (Registrul de evidență fiscală)

- **Who keeps it:** mandatory in the real system (art. 68 alin. (8)). Under a normă, only its income part (art. 69 alin. (8); OMFP 3254 art. 1 alin. (2)). For accommodation, only its income part (art. 68^3 alin. (7)). In an association, the designated associate keeps it (OMFP 3254 art. 1 alin. (4)).
- **Model (OMFP 3254/2017 annex 1):** header with the year, a rectification flag and the source/category of income; then rows of nr. crt., "elemente de calcul pentru stabilirea venitului net anual/pierderii nete anuale", and value in lei.
- **When and how it is filled (art. 3–9):**
  - annually, with totals, per source and per category, before the D212 is filed;
  - it must agree with D212 (or D204) and with any rectification (art. 6);
  - one page per source, no blank rows, kept on paper or electronically (art. 7–9).
- **What it leaves out:**
  - collected VAT and deducted VAT (art. 4 alin. (3), art. 5 alin. (6));
  - expenses over the limits and non-deductible expenses (art. 5 alin. (4));
  - **the owner's own CAS and CASS** (art. 5 alin. (5)). That article still refers to the repealed art. 75. The Code now deducts them in the D212 (art. 118 alin. (2) lit. b)).

### 1.6 Losses and the taxable income (art. 118, 123)

- **Recalculated net income** per source: net income minus losses carried forward (art. 118 alin. (2) lit. a)).
- **Taxable income:** the sum of the recalculated net incomes, **minus deductible CAS and CASS** (lit. b)).
  - Deductible CAS is CAS due × the share of real-system net income in the art. 148 alin. (3) total (alin. (2^2)).
  - Deductible CASS is CASS × the share in the art. 170 alin. (1) total (alin. (2^3)). The minimum-CASS difference of art. 174 alin. (6) is not deductible.
  - Neither may exceed the recalculated net income (alin. (2^4)).
- **Losses (alin. (4)–(5)):**
  - kept per source;
  - offset up to **70% of the same source's net income** in each of the **next 5 years**, oldest first;
  - personal and not transferable; whatever is left after 5 years is lost.
  - The norms (pct. 35 alin. (7): "până la al șaptelea an") and the D212 form (rd. 6 footnote: 70%) are older wording; the Code governs. **[CONFLICT, norms out of date]**
- **Tax:** 10% × taxable income (art. 123 alin. (1)), paid by the D212 deadline (alin. (7)).

### 1.7 Normă de venit (art. 69, 69^1, 69^2; norme pct. 8, 8^1)

- **Setting and floor:**
  - The DGRFP sets the norm per activity and place and publishes it with correction coefficients in Q4 of the previous year (alin. (2)).
  - **Floor: 12 × the minimum wage in force on 1 January of the income year**: 12 × 4,050 = **48,600 lei for 2026**. The 1 January rule comes from L239/2025 pct. 6, from income of 2026. In an association the floor applies per member (alin. (3)).
- **Adjustments:**
  - reduced in proportion to part-year activity: days/365 (alin. (5); norme pct. 8 alin. (8)–(10));
  - several activities or places are added up (alin. (6); norme pct. 8 alin. (2)–(3));
  - coefficients for 13 criteria; the highest increase and the highest reduction apply (alin. (10); norme pct. 8 alin. (6)–(7)).
  - Worked example, usable as an oracle: norm 23,000 lei, +25%, then −60% → net 11,500 lei, tax 1,150 lei (norme pct. 8 alin. (14)).
- **When the real system becomes mandatory:**
  - mixing a nomenclator activity with another independent activity (alin. (7); norme pct. 8 alin. (13));
  - **gross income above 25,000 EUR** in the previous year, converted at BNR's annual average rate of that year: real system from the next year (alin. (9)).
- **Books:** only the income part of the fiscal register; no accounting obligations (alin. (8)). The engine must still record receipts to test the 25,000 EUR limit.
- **Option for the real system:** made in the D212 by the art. 122 alin. (3) deadline (25 May); binding for 2 years and renewed tacitly (art. 69^1). The norms (pct. 8^1: 15 March, or 30 days after starting) predate this. **[CONFLICT, Code governs]**
- **Tax:** 10% × the adjusted norm, paid by 25 May (art. 69^2).
- **Nomenclator:** OMF 1960/2025 maps it to CAEN Rev. 2 and Rev. 3. The CAEN codes are illustrative; the norm attaches to the activity [SECONDARY on the details].

### 1.8 VAT interplay

- A PFA, II or IF is a taxable person under Title VII like an SRL. Small-enterprise exemption up to **395,000 lei** turnover (art. 310 alin. (1)). Once over it, it applies for registration under art. 316 by the date it is passed (alin. (6)). It may opt for the normal regime at any time (alin. (3)).
- **Recording:** the Registrul-jurnal records receipts and payments **including VAT** (OMFP 170 cap. V). The fiscal register excludes collected and deducted VAT (OMFP 3254 art. 4–5). Records of all operations under art. 321 (the VAT journals).
- **Consequences:**
  - a VAT payer's income and deductible expense are **net of VAT**;
  - non-deductible VAT (a non-payer, the 50% vehicle share) is part of the expense;
  - VAT paid to the state or refunded is neither expense nor income.
- **Normă:** coefficient criterion (l) uses the VAT informative return (norme pct. 8 alin. (7)).
- **Returns:** D300, D394 and D390 exactly as for an SRL. A non-payer buying services from the EU needs art. 317 registration (and D301; the form version was not checked). TVA la încasare is available on the same terms (art. 282, not re-read).

### 1.9 Payroll when it employs

- **Caps:** PFA ≤ 3, II ≤ 8, IF 0 employees (OUG 44/2008).
- **Deductibility:** salaries are deductible as defined in cap. III (art. 68 alin. (4) lit. c)) **when paid** (lit. b)). Employer contributions (alin. (5) lit. k)), meal vouchers (lit. e)) and holiday vouchers (lit. f)) are listed.
- **Unchanged from the SRL engine:** CAS, CASS, income tax and CAM calculations; D112 monthly by the 25th (art. 147).
- **Retention:** payroll registers 50 years (OMFP 170 cap. IV pct. 3).

### 1.10 Cash limits

- Legea 70/2015 covers PFAs, IIs, IFs and liberal professions (art. 1 alin. (1)). L239/2025 art. II rewrote that article from 1 January 2026 to require that their payments be made "**also** through modern payment means".
- Daily limits: art. 3 alin. (1) and art. 4 (5,000 lei per operator; 10,000 lei total payments; 10,000 lei per individual), already in the register as `ro.cash.limits`.
- The 50,000 lei end-of-day cash ceiling (art. 4^2) was not read in a current text. Whether it binds a PFA is open question 17.
- The account obligation of art. 1 alin. (12) binds legal persons only.

### 1.11 CAS and CASS of the self-employed

**Minimum wage used:** the one in force on **1 January of the income year**, even if it changes during the year (art. 135^1 alin. (3)).
- For income of 2025 and of **2026**: **4,050 lei** (HG 1506/2024, still in force on 1.01.2026).
- HG 146/2026 (4,325 lei from 1.07.2026) does **not** change the 2026 bases. It decides 2027's only if no other act sets the minimum wage by 1.01.2027 [unverified].

| | Rule | Income 2025 (D212 filed 2026) | Income 2026 (D212 by 25.05.2027) |
|---|---|---|---|
| CAS rate | 25% (art. 138 lit. a)) | | |
| CAS threshold | due if independent net income or norms, plus IP net income, reach 12 minimum wages (art. 148 alin. (1), (3)) | 48,600 | 48,600 |
| CAS base | income chosen, at least 12 wages (incomes of 12–24 wages) or at least 24 wages (incomes of 24 wages or more) (art. 148 alin. (2)) | 48,600 / 97,200 → CAS 12,150 / 24,300 | same |
| CAS below threshold | optional, at least 12 wages (art. 148 alin. (4)); not refunded (art. 151 alin. (4)) | | |
| CAS exempt | pensioners, own systems such as lawyers (art. 150 alin. (1)); part-year rule (art. 151 alin. (3)) | | |
| CASS rate | 10% (art. 156) | | |
| CASS base | net income or norms, **losses ignored** (art. 170 alin. (1)) | | |
| CASS cap | | **60** wages = 243,000 (per OPANAF 2736/2025 form) | **72** wages = **291,600** → max 29,160 (L239/2025 pct. 19, from income of 2026) |
| CASS minimum | if the base is below 6 wages, CASS up to 6 wages (art. 174 alin. (6)) unless the person had salary ≥ 6 wages, other art. 155 c)–h) income ≥ 6 wages, or a pension (alin. (7)–(8)) | 24,300 → 2,430 | 24,300 → 2,430 |
| Loss or zero income | no CASS; may opt under art. 180 (6 wages) (art. 174 alin. (2)) | | |
| Payment | by 25 May N+1 (art. 151 alin. (1), art. 174 alin. (15)); voluntary payments any time (art. 151 alin. (13), art. 174 alin. (16)) | | |

### 1.12 Anticipated payments

- **Repealed:** the estimated-income declaration and the tax prepayments based on it (art. 120 and 120^1). Which act repealed them was not identified. The D212 versions for 2023 and 2024 still had an estimated part (ANAF's page); OPANAF 1929/2025 and 2736/2025 no longer do.
- **What remains:**
  - withholding at source for some income: art. 68^2 (ANRP; taken into account under art. 123 alin. (8)), IP, sports contracts;
  - the **voluntary early payments** of CAS and CASS (art. 151 alin. (13), art. 174 alin. (16)); none is refunded if the threshold is not reached.
- **Bonus** (art. 121, 151 alin. (14), 174 alin. (17)): up to 10%, set each year by the budget law. For **income of 2025: 3% of income tax**, if the D212 is filed and income tax, CAS and CASS are paid in full **by 15 April 2026** (ANAF guide 2026; the budget-law text was not read) **[SECONDARY within ANAF]**. For income of 2026 it is unknown until the 2027 budget law.
- **For the engine:** "anticipated payments" means tracking payments made before 25 May against the year's D212 obligations, and the bonus window.

### 1.13 D212: deadlines, contents, and what changed for 2026

**Deadlines:**
- File and pay by **25 May N+1** (art. 122 alin. (3), 123 alin. (7)). The same deadline applies when activity starts, stops or is suspended (art. 122 alin. (2)–(3)).
- CASS option (Ch. II): any time in the year.
- Rectification: allowed until the reserve of later verification is cancelled (instructions I.2–I.8).
- Disability: the exempt days reduce the net income (art. 122 alin. (5)).

**Contents (OPANAF 2736/2025, annex 1):**
- **A. Identification:** CNP/NIF, address, IBAN.
- **B. Sections ticked.**
- **Chapter I, income of the year:**
  - Sec. 1, Romanian income:
    - Subsec. 1, real system: A. activity data (category 1.1 independent; net income method; individual / association / change of form; CAEN; seat; authorization number and date; start, end and suspension dates; exempt days). B. rows 1–9: venit brut, cheltuieli deductibile, venit net, pierdere, pierderi reportate, pierdere compensată (≤ 70% of rd. 3), venit net recalculat. Rows 8–9 are not used for independent real income.
    - Subsec. 2, normă: A1 form and authorization; A2 per place: CAEN, dates, interruption days, a 13-criterion coefficient table, rd. 7 norm, rd. 8 adjusted norm, rd. 9 net, rd. 9.1 taxable. B: punct gastronomic local. C: total and 10% tax.
    - Subsec. 3–4: tourist rooms, agriculture.
  - Sec. 2: foreign income.
  - Sec. 3: CAS (A.1/A.2/A.3/B; rows 1–5) and CASS (2.1 for independent income, rows 1–8; 2.2 for other categories).
  - **Sec. 4: real-system tax:** rd. 1 Σ recalculated net incomes, rd. 2 deductible CAS (4.1), rd. 3 deductible CASS (4.2), rd. 4 taxable, rd. 6 tax at 10%.
  - Sec. 5: IP.
  - Sec. 6: tax on a CASS overpayment.
  - Sec. 7: summary.
  - Sec. 8: bonus.
- **Chapter II:** the CASS option (art. 180) and dependants (art. 182^1) for the current year.

**What changed for 2026:**
1. **CASS cap 60 → 72 minimum wages** for independent income, from income of 2026 (L239/2025 art. XII pct. 19–20, art. XIII alin. (2) lit. b)).
2. Normă floor tied to the minimum wage on 1 January of the income year (pct. 6).
3. New art. 68^3 for accommodation (30% flat, final tax), and art. 67 alin. (1^1) (pct. 3–5).
4. The CAS cumulation in art. 148 alin. (3) includes art. 68^3 (pct. 18).
5. Nomenclator on CAEN Rev. 3 (OMF 1960/2025).
6. Fixed-asset threshold 5,000 lei and super-accelerated depreciation for 2026 (art. 28).
7. Legea 70/2015 art. 1 rewritten from 1.01.2026.
8. D212 for income 2025 under OPANAF 2736/2025, filed through ANAF's **web form** (see §3). 3% bonus by 15.04.2026.
9. Minimum wage 4,325 from 1.07.2026, irrelevant to the 2026 bases.

### 1.14 Microenterprise specifics

- A PFA, II or IF cannot itself be a microenterprise: Title III is for legal persons (art. 47).
- **Link to an SRL:** if a microenterprise has a shareholder holding more than 25% who also runs a PFA, II or IF, that business's revenue counts toward the micro's **100,000 EUR** limit:
  - real system: receipts entered in the Registrul-jurnal, of the art. 53 kinds;
  - normă: a quarter of the annual norm for the current year.
- Sources: art. 47 alin. (1^1) lit. d); art. 52 alin. (5^1)–(5^2); norme (Title III), "încasate și înregistrate în registrul-jurnal de încasări și plăți".
- **For the engine:** the SRL's `tax.micro` treatment needs, as a read, the linked PFA's year-to-date art. 53 receipts. If both run in xFactura this is a cross-company read; otherwise it is an input with evidence.

### 1.15 IF and association specifics

- The IF representative keeps the single-entry books (OUG 44/2008 art. 15) and the fiscal register (OMFP 3254 art. 1 alin. (4)).
- **Association rules (art. 125):**
  - written contract with quotas and a designated associate (alin. (2)); registered with the tax office within 30 days;
  - relatives up to the 4th degree must prove they contribute property they own (alin. (3));
  - **annual return D204 by the last day of February** (alin. (4)), as OPANAF 470/2021 also says (it replaced OPANAF 97/2019's 15 February from the income of 2020; OPANAF 90/2022 replaced only the form). The norms (pct. 41 alin. (4)) say 15 March. **[CONFLICT]**, see §7.8.
  - net income or loss distributed by quota (alin. (5)); each member declares the distributed amount in their own D212, with "asociere fără personalitate juridică" ticked (art. 122 alin. (4)).
- **Normă:** each member's norm has the 12-wage floor (art. 69 alin. (3)). No distribution and no D204 (art. 125 alin. (1) lit. c), (10); OPANAF 97/2019 instr. pct. 2).
- **Open:** whether an IF is an "asociere fără personalitate juridică" under art. 125. The Code does not name IF there. OMFP 170 cap. I pct. 1 a.1 and ANAF's D204 practice suggest so.

### 1.16 Single-entry or double-entry

- **Single entry:** natural persons taxed in the real system keep single-entry books (OMFP 170/2015 art. 2 lit. a); cap. I pct. 1 a.1 names PFA, II and IF; OMFP 2634/2015 pct. 48).
- **Double entry by option:**
  - allowed "except where the founding act, special laws or other acts expressly provide single entry" (OMFP 170 art. 3; L82/1991 art. 1 alin. (5));
  - switch only from the start of the next financial year, or from set-up (art. 4);
  - double-entry books run up to the trial balance, with Registrul-jurnal 14-1-1 and Registrul-inventar 14-1-2 and no annual statements; the opening balances go through 455 (art. 5).
- **[CONFLICT]** OUG 44/2008 art. 15 says the PFA, the II titular and the IF representative "**vor ține** contabilitatea în partidă simplă". Read with OMFP 170 art. 3's carve-out, that could bar PFA, II and IF from the double-entry option. Common practice assumes the option exists. This needs the expert's sign-off (open question 1).
- **Normă:** no accounting obligation at all.
- **Single-entry persons** draw up no annual financial statements (OMFP 170 cap. II pct. 11).

---

## 2. The books

### 2.1 Registrul-jurnal de încasări și plăți (14-1-1/b), OMFP 170 cap. V sec. 2

- **Columns:** 0 Nr. crt.; 1 date of the receipt or payment; 2 document (type, number); 3 explanation (the nature of the operation); 4 receipts in cash; 5 receipts by bank; 6 payments in cash; 7 payments by bank.
- **One row per receipt or payment, per supporting document;** cash and bank together; at the document amount **including VAT**.
- **Totalled monthly.**
- **Order:** with IT, chronological by the date of the receipt or payment.
- **Printing:** annually or when an inspector asks.
- **Receipts cover:** activity income; contributions; loans and credit; compensation; sponsorship and donations; grants; other receipts (tax refunds, penalties).
- **Payments cover:** activity payments; return of contributions; loan repayments; other payments (fines, penalties).
- **Foreign currency:** in lei, with the currency amount in the explanation. Rate: **BNR rate of the last banking day before the operation**, as available at the time (cap. III pct. 18).
- **Fiscal cash registers:** the daily Z report is the document (pct. 19).
- **Retention:** 10 years for the registers, 5 years for documents, 50 years for payroll (cap. IV).

### 2.2 Registrul-inventar (14-1-2/b)

- **Columns:** 1 Nr. crt.; 2 items inventoried (one by one, or group totals from inventory lists annexed); 3 inventory value.
- **Values:** entry value, or the amount left to collect or pay for receivables and payables.
- **When:** at the start of activity, at year-end and at cessation (actual count at cessation). An inventory at least yearly (cap. II pct. 8–9, under OMFP 2861/2009).
- **What it holds:** fixed assets, stock, intangibles, receivables and payables (cap. II pct. 10; norme pct. 7 alin. (8)).

### 2.3 Fișa mijlocului fix (14-2-2)

Per asset (OMFP 170 cap. III pct. 17). The model is in OMFP 2634/2015 annex 3 (MO 910 bis), which was not obtained.

### 2.4 Registrul de evidență fiscală

See §1.5: an annual table per source.

### 2.5 Fișa pentru operații diverse: not a current statutory register

- It belonged to OMFP 1040/2004 (form 14-6-22/b per [SECONDARY]), which **OMFP 170/2015 art. 7 lit. a) repealed**. OMFP 170's nomenclator (cap. V sec. 1: ten forms) does not list it.
- OMFP 170 cap. II pct. 2–4 allows using other OMFP 2634/2015 forms "în funcție de necesități", leaving the account columns blank.
- It is therefore **optional**, not mandatory. The plan's "Scope amendment" lists it as a register; that should be corrected or confirmed by the expert (open question 2).

### 2.6 What an "entry" is in single entry

- **The statutory entry** is one cash or bank receipt or payment, backed by one supporting document. For the engine it is tagged with its **nature**:
  - income: activity income, interest, asset sale, debt forgiven…;
  - not income: contribution, loan, compensation, donation, VAT refund;
  - expense, by deductibility class: full, limited (protocol, vehicle 50%, …) or none (personal, fines, loan principal, fixed asset);
  - VAT: paid to suppliers, or settled with the state.
- **Non-cash operations** never appear in the Registrul-jurnal but change the net income:
  - fiscal depreciation;
  - in-kind income;
  - assets withdrawn to the personal patrimony (market value);
  - forgiven debts;
  - undepreciated value of assets sold;
  - uninsured shortages;
  - contributions in kind (not income, but they enter the inventory).
- They are carried in the fiscal register's annual computation, and in the optional fișa if the company uses it.

---

## 3. Declarations

### 3.1 D212

- **Current order:** OPANAF 2736/2025 (income 2025, CASS option 2026).
- **Filing channels:** SPV, e-guvernare.ro with a qualified signature, or on paper (instructions III).
- **What ANAF publishes for it:** only a **web form** (https://www.anaf.ro/declaratii/duf, V-1.8.10 / 15.05.2026). Its tabs: identification, income, withholdings, CAS, CASS, tax bonus, CASS option 2026, dependants 2026. Declaration types: initial, rectification of 2025 income, of 2026 options, or both.
- **Its XML**, read from the public JS bundle: root `d212`, `xmlns="mfp:anaf:dgti:d212:declaratie:v11"`, `an_r="2026"`, `luna_r="12"`.
- **Newest published Java package:** `D212Validator_01082025.zip`:
  - J13.0.1 / P10.0.0, for OPANAF 1929/2025;
  - structure D212_A1.0.3, namespace v11;
  - it validates in practice only income of 2024 (an_r 2025). It does not itself enforce `an_r = 2025` (see §7.6): the 2026 form's XML fails its schema on new attributes. It loads only in ANAF's SAF-T kit.
- **The gap:** **no Java validator, structure or XSD is published for an_r = 2026**. The last XSD on the page is v9 (13.01.2025). For income of 2026 (filed in 2027), a new order is expected around December 2026 to January 2027.

**XML structure (D212_A1.0.3, v11):**
- `<d212>` attributes:
  - `d_rec`, `rectif1`, `rectif2`;
  - `totalPlata_A` = sum of the CIF's digits;
  - `luna_r` = 12, `an_r`;
  - identification: `nume_c`, `prenume_c`, `cif`, `cont_bancar`, address, `nerezident`, …;
  - representative: `den_i`, `cif_i`, …
- `<oblig_realizat>` 0..1: sections 3–8, e.g. `cas_total_ven`, `cas_baza`, `cas_datorat`, `cas_retinut_platitor`, `cas_dif_plus`; `cass_*`; `real_venit_net_impozabil_ai`; `real_cas_*_ai`; `real_cass_*_ai`; `real_impozit_datorat_ai`; `oblimpoz_real_total`; `dif_de_plata`; `dif_de_restituit`; bonus fields.
- `<oblig_estimat>` 0..1: Ch. II, with `situatie_optiune` A–F, `baza_optiune`, `cass_optiune`.
- `<cap11>` 0..n: real system, one per source:
  - `reg`, `categ_venit` (**1016 = activități independente**, 1003 IP, 1004/1006 rental classed as independent / tourist, 1009–1011 agriculture);
  - `det_ven_net` (1 real, 2 flat-rate), form of organization, `mod_forma_org`, `caen`, seat;
  - `nr_doc_autoriz`, `data_doc_autoriz`, `data_incep`, `data_sf`, `nr_zile_scutite`;
  - `venit_brut`, `chelt_deduc`, …, `pierdere_compensata`, `venit_redus`.
- `<cap12>` 0..n: normă, one per place: `norma_forma_org`, `norma_caen`, seat, document, dates, `real_norma_venit`, `real_ajustare`, `real_venit_net_anual`, `real_venit_impozit`, `real_impozit`.
- `<cap14>`: foreign income.
- `<coasigurat>` 0..3.
- Amounts N(15), whole lei.

### 3.2 Other returns

| Return | When for PFA/II/IF | Status in the engine |
|---|---|---|
| D204 | IF and associations in the real system: by the last day of February (Code art. 125 alin. (4)) | new; validator `D204_16012026.zip` (5679dd85…) |
| D112 | employer, monthly by the 25th | existing writer; check that the PFA employer identifies by CUI |
| D300, D394, D390 | VAT payer | existing, unchanged |
| D301 / art. 317 | non-payer buying EU services | not built (B1) |
| D100 / D205 | only if the PFA withholds tax at source (open question 6) | existing writers |
| D406 SAF-T | applicability to individuals is open question 7 | existing writer |
| S1005 | **not applicable** (OMFP 170 cap. II pct. 11) | block by `entity.form` |
| D101, micro tax, dividends | not applicable | block |

---

## 4. Architecture proposal

### 4.1 Recommendation: one kernel, with cash-basis projections

**Option A**, a parallel single-entry journal (receipt/payment rows with nature tags), would duplicate:
- evidence, proposals, approval, posting, invariants, period locks and exports;
- the treasury reconciliation;
- the VAT accrual logic a VAT-paying PFA still needs (exigibility is at invoice, not at receipt).

**Option B (recommended): keep the kernel's internal double-entry ledger and produce the statutory single-entry registers as projections.** The single-entry registers are outputs that "se editează anual sau la cererea organului de control" (OMFP 170 cap. V). The law regulates the registers, not the internal data model.

- **Internally,** the existing treatments post as for an SRL: invoices to 4111/401 with 70x/6xx and 4426/4427, `bank.settle`, `cash.record`, payroll to 421/431x/444/436, assets to 2xx. Every statutory fact (receipt, payment, document, nature) is already in lines, open items and documents.
- **Registrul-jurnal de încasări și plăți:**
  - one row per posted line on a treasury account (5121, 5124, 5311, 5314);
  - date = the movement or receipt date;
  - document = the bank movement reference or the chitanță / dispoziție number;
  - explanation = the nature;
  - columns by cash or bank and by side;
  - monthly totals.
- **Nature of each receipt or payment:**
  - a payment settling an open item takes the nature of the document that created the item, **pro rata** for partial payments, split into net and VAT by the original's lines;
  - payments on accounts without partners take the account's nature;
  - FX differences on settlement are folded into the receipt's lei amount, since cash basis measures income at the receipt rate.
- **Fiscal register:** the year's cash-basis natures by source, plus non-cash items (fiscal depreciation, in-kind, withdrawals), minus non-deductibles, with the annual limits applied. Prepared as an artifact like a declaration.
- **Registrul-inventar at a date:** the existing `ledger.inventoryRegister` (assets by inventory number, open items by partner, cash and bank), in the 14-1-2/b layout.
- **Double-entry option (OMFP 170 art. 5):** the native ledger, the trial balance and Registrul-jurnal 14-1-1, with an opening through 455 equal to the last Registrul-inventar.

### 4.2 Modules: carry over or need a PFA variant

| Module | Verdict |
|---|---|
| e-Factura issue/import, SPV, party status, evidence, documents | unchanged. The invoicer's PFA seller data (BT-30 is the CUI) is already modelled. |
| VAT recognition, settlement, D300/D394/D390, e-TVA | unchanged (accrual VAT). Rule: the fiscal register uses net amounts for payers and gross for non-payers. |
| Bank import, `bank.settle`, `cash.record`, cash register, Legea 70/2015 checks | unchanged. Add a **nature** requirement for unmatched lines on PFA books; a month does not close with a treasury line without a nature. |
| FX | rate rule differs: a new version of `ro.fx.rate_date.accounting` scoped `books=single_entry` = previous banking day (OMFP 170 pct. 18). No month-end revaluation (`fx.revalue` blocked for single entry). |
| Payroll run, D112 | unchanged; the projection classifies payments settling 421, 4315, 4316, 444 and 436 as salary or employer-contribution expense when paid. |
| Assets register | reused; **new `assets.depreciateFiscal`** (art. 28: 5,000 lei threshold, methods, super-accelerated 2026) and the Fișa mijlocului fix layout. The asset purchase is non-deductible in the projection. |
| Accruals and deferrals (408/418/471/472), `fx.revalue`, year-end close to 121, legal reserve, dividends, `tax.micro`, D100 micro, S1005 | **blocked** for `entity.form ∈ {pfa, ii, if}` with single-entry books. Cash basis makes deferrals pointless. |
| Declarations pipeline (prepare → validate → authorize → pdf → importSigned → submit) | reused for D212 and D204. `validated_official` is unavailable for D212 2026: the kind declares no official validation for that period, `declarations.validate` refuses it (`NO_OFFICIAL_VALIDATOR`), and authorization stays blocked (`NOT_VALIDATED`). |
| Obligations calendar | add D212 (25.05), D204 (end of Feb), the bonus window (by budget law), CASS option; remove S1005, D101 and micro for PFA. |
| Linked micro (SRL) | `tax.micro` reads the linked PFA's art. 53 receipts (§1.14). |

### 4.3 Data model additions

- **Profile axes** (company.ts `profileAxes`):
  - `entity.form`: srl, pfa, ii, if;
  - `books.system`: single_entry, double_entry; a change only from 1 January (OMFP 170 art. 4);
  - `pit.method`: real, norma, accommodation; per source, dated, with a 2-year lock after opting for real (art. 69^1);
  - `cas.status`: liable, pensioner, own_system; `cas.option`: yes, no per year;
  - `cass.exception`: salary ≥ 6 wages, pension, …, per year;
  - `pit.disability`, with its exempt period.
- **Sources** (a new table, or a profile fact per source): an activity source = CAEN, place, authorization number and date, start / suspension / end dates. D212 needs one `cap11` or `cap12` per source.
- **IF members:** `enterprise_members` with the party (CNP sealed in the existing `partyCnps`), quota %, representative flag, from/to and evidence (the acord de constituire). Cross-check that quotas add up to 100%.
- **Nature catalogue:** a mapping from (account or analytic, open-item kind) to (fiscal-register row, deductibility class). It is versioned in the rule register, because limits change. Limited classes are analytics, e.g. `623.PROTOCOL`, `6xx.VEH50`.
- **Loss vintages:** derived from the engine's own filed D212s (as D300 carries balances forward), plus an explicit `pit.lossOpening` memo entry with evidence for years before the engine.
- **Norm data:** the DGRFP value per county and activity, and coefficients, given by the preparer with the publication as evidence. The DGRFP publications are official but local, with no central dataset.
- **Rule register parameters** (each with its clause):
  - `ro.pit.rate` (art. 64);
  - `ro.min_wage.contributions` (axis `fiscal_year_start`, value on 1 January; art. 135^1 alin. (3));
  - `ro.cas.rate` and `ro.cas.thresholds` (art. 138, 148);
  - `ro.cass.rate` and `ro.cass.independent` {min 6, max 60 → 72 from 2026} (art. 156, 170, 174);
  - `ro.pit.loss` {70%, 5 years} (art. 118);
  - `ro.pit.limits` (art. 68 alin. (5), (7) lit. k));
  - `ro.pit.norma` {floor 12 wages, real above 25,000 EUR} (art. 69);
  - `ro.pit.accommodation` 30% (art. 68^3);
  - `ro.assets.threshold` 5,000 lei from 2026 (art. 28);
  - `ro.pit.bonus` (budget law, per year);
  - `ro.deadline.D212` (art. 122 alin. (3)), `ro.deadline.D204` (art. 125 alin. (4));
  - `ro.fx.rate_date.accounting` scoped by books system.
  - **New date axis:** `income_year`, or reuse `fiscal_year_start`.
- **Tax entries:** none needed for income tax, CAS or CASS. Those are annual computations from the projection. The resulting liabilities are booked by a `pit.d212.recognize` treatment: Dr titular's account / Cr authority (open item `tax.payable`). The owner's own taxes are personal, not business expenses (art. 68 alin. (7) lit. c); OMFP 3254 art. 5 alin. (5)). Payments are then tracked against 25 May and the bonus date.
- **Owner account:** contributions and withdrawals through a titular account (e.g. 4551.TITULAR, or a dedicated analytic); "not income" and "not expense" in the projection.

### 4.4 Build order, exit tests, oracles

| Phase | Build | Exit test | Oracle |
|---|---|---|---|
| P0 Profile and rules | `entity.form`, `books.system`, the parameters above with clauses; blocks on SRL-only treatments | `rules.parameters` lists every PFA parameter; 2027 values show `NO_VERSION`; register `check()` passes | the texts in §0 |
| P1 Registrul-jurnal and Registrul-inventar | nature tagging, the pro-rata projection, monthly totals, the 14-1-1/b and 14-1-2/b layouts | a synthetic PFA year (RON/EUR invoices, partial payments, cash, fees, contributions/withdrawals, a loan, VAT settlement): receipts − payments = change in treasury per account and month; every treasury line has a nature; no SRL treatment reachable | property tests; the bank statements |
| P2 Fiscal register | deductibility classes, annual limits (EUR at the annual BNR average), fiscal depreciation, non-cash items, losses | hand-computed cases from the expert (not by the engine); the norme examples: art. 118 (pct. 35 alin. (9): 38,750 → 3,875 lei) and normă (pct. 8 alin. (14): 11,500 → 1,150 lei) | expert fixtures FP-PFA-01… |
| P3 D212 real + CAS/CASS | the v11 writer; Sections 1/1, 3, 4, 7, 8; Ch. II option | (a) income 2024: DUKIntegrator with `D212Validator_01082025.zip` passes and rejects broken files; (b) income 2025: the same data typed into ANAF's web form gives identical totals and an XML diff equal to the engine's, a manual oracle; (c) income 2026 blocked until ANAF publishes its package | ANAF validator J13.0.1, ANAF web form |
| P4 Normă, IF, D204 | `cap12`, coefficients, the 25,000 EUR test; members and distribution; D204 | D204 passes `D204_16012026.zip`; the members' D212 sums equal the D204 distribution; a normă PFA with gross over 25,000 EUR is forced to real for the next year | ANAF D204 validator |
| P5 Shared modules with a PFA profile | run the D300/D394/D112/cash suites with `entity.form=pfa` | existing official validators pass; payroll payments classified as expense when paid; employee cap warnings (3/8/0) | existing validators |
| P6 Double-entry option | switch at 1 January with the 455 opening | the opening equals the last Registrul-inventar per item | invariant test |
| P7 Pilot replay | a real PFA year against the filed D212 and the accountant's registers | every difference explained and signed off | filed returns |

---

## 5. Open questions for the expert contabil

1. **Double-entry option:** can a PFA, II or IF opt for double entry, given OUG 44/2008 art. 15 ("vor ține contabilitatea în partidă simplă") and OMFP 170 art. 3's carve-out? Or only through L82/1991 art. 1 alin. (5)?
2. **Fișa pentru operații diverse:** required, or optional since OMFP 170 repealed OMFP 1040/2004? If used, which model?
3. **IF under art. 125:** is an IF an association for D204 and distribution, even though the Code does not name it? The D204 deadline is the last day of February (Code art. 125 alin. (4), OPANAF 470/2021) versus 15 March (norme pct. 41 alin. (4)).
4. **VAT-inclusive receipts:** allocating partial receipts and payments of invoices with VAT (pro rata to net and VAT), and rounding.
5. **Foreign currency:** income in lei at the BNR rate of the previous banking day (OMFP 170 pct. 18). Do exchanges between own currency accounts, or FX differences, create income or expense on a cash basis?
6. **Withholding at source:** is a PFA "an entity obliged to keep accounting" (art. 72, 84^1), so that it withholds on rent and IP and files D100 and D205?
7. **D406 SAF-T:** does it apply to PFA, II or IF (OPANAF 1783/2021 scope)?
8. **CASS minimum:** the art. 174 alin. (7)–(8) exceptions, applied per year in the engine; the evidence needed for salary or pension.
9. **CAS and CASS deduction:** the pro-rata deduction with several sources and with normă sources (art. 118 alin. (2^2)–(2^4)).
10. **Norm values:** the authoritative source per county; is a preparer-supplied value with the DGRFP PDF as evidence acceptable?
11. **Option deadline for the real system:** Code art. 69^1 (25 May) versus norme pct. 8^1 (15 March / 30 days). Confirm the Code governs.
12. **Fixed-asset threshold:** the 5,000 lei date of effect and the act; does Title II art. 45 alin. (21^3) apply to PFAs? The treatment of assets of 2,500–5,000 lei bought earlier.
13. **Bonus:** the legal basis of the 3% for income 2025 (budget law 2026) and the rule for 2026.
14. **Employer contributions:** what limit art. 68 alin. (5) lit. k) imposes, if any.
15. **Payroll timing:** December salaries paid in January are deductible in January. Confirm, and confirm that withheld taxes paid to ANAF count as salary expense when paid.
16. **D212 validator:** is any official validator or structure coming for an_r = 2026? Until then, is the web form an acceptable oracle, or must filing go through it?
17. **Cash ceiling:** does Legea 70/2015 art. 4^2 (the 50,000 lei ceiling) bind PFAs? Its current text was not read.
18. **Repealed estimated income:** which act repealed art. 120 and 120^1, and do transitional effects remain for older years?

## 6. Not sourced or not verified

- Exact effective dates of the 5,000 lei asset threshold and of the art. 120 / 120^1 repeal.
- D212 2026 XML: only the root attributes, read from ANAF's public JS. The element list is the 2025 structure's (v11).
- 2027 minimum wage, CAS and CASS bases.
- Legea 70/2015 consolidated text.
- OUG 44/2008 amendments after 17.01.2017.
- OMF 1960/2025 application date [SECONDARY].
- The micro-link norms example still uses an old 500,000 EUR figure; the 100,000 EUR limit is from the register (`ro.micro.revenue_limit_eur`).

---

## 7. Built: P0–P2 (30 October 2026)

Every value below is still `extracted`; nothing is reviewed. The open questions of §5 stand, and the choices made for them are listed at the end.

### 7.1 P0: profile and rules

**Profile axes** (`modules/company.ts`, helpers in core `ro/entity.ts`):

| Axis | Values | Rule enforced by `profile.record` |
|---|---|---|
| `entity.form` | `srl`, `pfa`, `ii`, `if` | no fact means `srl`; never between `srl` and `pfa`/`ii`/`if` (`ENTITY_FORM_CHANGE`); `pfa` ↔ `ii` ↔ `if` allowed (change of form, art. 68 alin. (7^1)) |
| `books.system` | `double`, `single` | no fact means the form's own (single for `pfa`/`ii`/`if`); `single` only for `pfa`/`ii`/`if`; `double` for `pfa`/`ii`/`if` refused until question 1 is answered (`BOOKS_SYSTEM_FORM`) |
| `cas.status` | `liable`, `pensioner`, `own_system` | `pfa`/`ii`/`if` only (`PROFILE_FORM`); read at 31 December of the income year |
| `cas.option` | `no`, `yes` | as above (art. 148 alin. (4)) |
| `cass.exception` | `none`, `salary`, `other_income`, `pension`, `previous_year` | as above (art. 174 alin. (7)–(8)) |
| `income_tax` | (existing) | refused for `pfa`/`ii`/`if` (`PROFILE_FORM`) |

**Income sources:** table `acc_income_sources` (migration `0012_income_sources`), one version per change: CAEN, place and county, authorization, start, suspension and end dates, liberal profession, method `sistem_real` (`required` or `option`) or `norma`, evidence. Operations `pfa.sources.record` (human approval) and `pfa.sources.list`. Checked by the module and again by the trigger `inv_income_source_guard`:

- `income_source_sequence`: versions numbered without gaps, the first from the start date, none earlier than the previous;
- `income_source_form`: only after an `entity.form` fact of `pfa`/`ii`/`if`;
- `income_source_method_date`: to a norm, or to the real system by option, only from 1 January; the real system the law requires may start mid-year (norme pct. 8 alin. (13));
- `income_source_option_lock`: back to a norm only at the start of a new 2-year period of the option (art. 69^1 alin. (2)–(3), read as tacit renewal for further 2-year periods).

CHECK constraints: CAEN four digits; `real_basis` exactly when the method is `sistem_real`; no norm for a liberal profession; dates in order.

**Parameters** (core `ro/pit/parameters.ts`, axis `fiscal_year_start`; sources and clauses in `ro/sources`):

| Key | 2025 | 2026 | Clauses |
|---|---|---|---|
| `ro.pit.rate` | gap | 10% | art. 64 alin. (1) lit. a), art. 69^2 |
| `ro.pit.rounding` | gap | leu, ≤ 50 bani dropped | art. 66 |
| `ro.pit.loss` | gap | 70%, 5 years; losses before 2024: 7 years | art. 118 alin. (4)–(5); OPANAF 2736/2025 instr. rd. 6 |
| `ro.pit.limits` | gap | 2% protocol, 5% scholarships, 5% social, 5% professional, 50% vehicles, 4,000 EUR associations, 400 EUR pensions/occupational/PEPP/health/ETF, 100 EUR sport | art. 68 alin. (5)–(7); norme pct. 7 alin. (6)–(7) |
| `ro.pit.norma` | gap | floor 12 minimum wages; real above 25,000 EUR | art. 69 alin. (3), (9); L239/2025 art. XII pct. 6, art. XIII |
| `ro.pit.natures` | gap | the nature catalogue (§7.2) | art. 68 alin. (2)–(7); OMFP 3254/2017 art. 4–5; OMFP 170/2015 cap. V |
| `ro.min_wage.contributions` | 4,050 | 4,050 (closed; 2027 is `NO_VERSION`) | HG 1506/2024 art. 1; HG 146/2026 art. 1; art. 135^1 alin. (3) |
| `ro.cas.rate` | gap | 25% | art. 138 lit. a) |
| `ro.cas.independent` | gap | threshold 12, bases 12/24 wages | art. 148 alin. (1)–(4), art. 150 alin. (1); L239/2025 pct. 18 |
| `ro.cass.rate` | gap | 10% | art. 156 |
| `ro.cass.independent` | min 6, cap 60 wages | min 6, cap 72 wages | art. 170 alin. (1), 174; L239/2025 pct. 19, art. XIII; OPANAF 2736/2025 instr. pct. 47.1 (2025) |
| `ro.fx.rate_date.accounting` | | now scoped `books`: `single` = `before` (last banking day before the operation) | OMFP 170/2015 cap. III pct. 18 |

Open-ended 2026 versions are reviewed through 2026-12-31, so 2027 is `BEYOND_HORIZON`; the minimum wage closes on 2026-12-31, so 2027 is `NO_VERSION`. New registered sources: OMFP170/2015, OMFP3254/2017, L239/2025, OPANAF2736/2025, OUG44/2008 (all with the snapshot hashes of §0).

**Blocks:** on single-entry books, proposals of `accruals.*`, `deferrals.*`, `fx.revalue`, `year.closeResult`, `year.legalReserve`, `year.transferResult`, `dividends.*` and `tax.micro` carry the blocking issue `SINGLE_ENTRY_EXCLUDED` (core `singleEntryExcluded`, checked in `Proposals.evaluate` at the entry's date). `declarations.prepare` refuses S1005 with `SINGLE_ENTRY_EXCLUDED`, and `obligations.calendar` no longer lists S1005 for such years.

### 7.2 P1: the registers as projections

**Natures** (core `ro/pit/natures.ts`): kinds `income`, `expense`, `limited`, `excluded`, `asset`, `vat`, `transfer`, `advance`. The catalogue maps account prefixes (longest wins) and analytic tags (win over prefixes: `*.PROTOCOL`, `*.VEH50`, `*.SOCIAL`, `*.BURSE`, `*.CONTRIBPROF`, `*.ASOCPROF`, `*.PENSIE`, `*.PENSIEOCUP`, `*.PEPP`, `*.SANATATE`, `*.SPORT`, `*.ETF`, `*.PERSONAL`, `*.SPONSOR`, `*.TITULAR`) to a nature, with a separate nature for money paid out where it differs (4551 contribution/withdrawal, 16x/519 loan/repayment).

**Attribution** (core `ro/pit/journal.ts`), for each posted line on 5121, 5124, 5311, 5314 (and analytics):

1. a counter-line on an invoice's open item takes the invoice's composition: the other lines of the entries in journals VANZARI/CUMPARARI that touched the item (the invoice and its credit notes), netted per account, pro rata to the amount settled (largest remainder), so net, VAT, non-deducted VAT and advances keep their accounts;
2. a realized exchange difference (765/665) in the same entry is folded into the settled income or expense parts, not the VAT (cash basis at the receipt rate);
3. an item without a document (542, 4551, 461/462, payroll 421/43x/444) takes its control account's nature; a plain line its account's;
4. treasury lines of one entry on opposite sides offset as a transfer; DESCHIDERE entries are opening balances, not rows.

A line no rule classifies is `unclassified`; an invoice whose composition cannot be read is `unattributed`. Both are reported, and the close check `pfa.natures` blocks the month (`PFA_NATURE_MISSING`).

**Operations** (`kernel/reports.ts`, defined in `engine.ts`):

- `pfa.journal` {year, month?}: rows (nr. crt., date, document, explanation, receipts and payments in cash and bank, natures; the currency amount and rate in the explanation), monthly totals, and per treasury account and month the opening, receipts, payments and closing. Single-entry books only (`SINGLE_ENTRY_ONLY`).
- `pfa.inventory` {occasion: start | year_end | cessation, year?}: fixed assets one by one at entry value (from the asset register), stocks (30x–38x), receivables and payables by partner at what is left, other class-4 balances, cash and bank. 4551, equity and depreciation are left out. `INVENTORY_ASSETS` when the 2xx balances differ from the cards.

### 7.3 P2: Registrul de evidență fiscală

Core `ro/pit/register.ts`: `realSourceIncome` (gross income; expenses in full or within art. 68's limits in the article's order, the alin. (6) base before protocol and scholarships; excluded items listed apart; totals rounded per art. 66), `adjustedNorm`, `offsetLosses`, `casDue`, `cassDue`, `deductibleContributions`, `incomeTax`.

Operation `pfa.fiscalRegister` {year, eurAnnualRate?, casIncome?, otherIncome?, openingLosses[], adjustments[], norms[]} (`modules/pit.ts`): for the year's single source, the journal's natures plus non-cash items (fiscal straight-line depreciation over the fiscal life from the asset register; expense reports against 542; adjustments with evidence); losses from `openingLosses` and from the books' earlier years, simulated year by year; CAS and CASS from the profile; deductible contributions; taxable income and tax. It returns the register rows, the excluded items, the contributions, the tax, every issue and the parameter versions used. Blocking issues mean the figures are not final.

### 7.4 Tests and oracles

- Core `test/pit.test.ts`: the norms' examples (pct. 8 alin. (14): 11,500 → 1,150 lei; pct. 35 alin. (9): 38,750 → 3,875 lei under the example's own 2018 rule), and fixtures built from the texts, marked as such (CAS bands, CASS minimum/cap/exception, the art. 118 example under the 2026 rules → 2,685 lei, loss windows, art. 68 limits, norm floor and proration), plus the projection's attribution cases.
- Engine `test/engine/pfa.integration.test.ts`: a 2026 PFA (invoices issued and received, bank and cash, a laptop as a fixed asset, a fine, fuel at 50%): the Registrul-jurnal (P1 exit test: per account and month, receipts − payments = the change, and the closing equals the trial balance), the Registrul-inventar, the fiscal register (net 45,042 lei, CASS 4,504 lei, tax 4,054 lei), an EUR receipt at the previous banking day's rate, profile and source rules, blocked treatments and S1005.
- Invariants: one attack per income-source rule.

### 7.5 Choices made for open questions

- **Q1 (double entry):** refused for `pfa`/`ii`/`if` until answered.
- **Q3 (IF):** an IF is handled as one taxpayer with one source; members, quotas and D204 are P4. Per-person euro limits count one person.
- **Q4 (partial payments):** pro rata to the invoice's composition, net and VAT.
- **Q5 (FX):** single-entry books book at the previous banking day's rate; the realized difference goes to the income or expense settled; differences without an invoice are income (`income.fx`) or a deductible expense (`expense.fx`).
- **Q9:** CAS and CASS deducted in proportion to the real-system net income within the cumulated income; the person's other income is an input (`otherIncome`), zero when not given.
- **Q14:** employer contributions deducted in full, flagged `PIT_EMPLOYER_LIMIT`.
- **Q15:** salaries, withheld contributions and tax (421, 431x, 444) are salary expense when paid; 436 an employer contribution.
- **Not modelled, reported instead:** several sources in a year (`PIT_SOURCES_MULTIPLE`), a mid-year change of method (`PIT_METHOD_CHANGE`), a norm alongside another activity (`PIT_NORMA_MIXED`), invoices settled without money (`PIT_NONCASH_SETTLEMENT`), assets disposed of (`PIT_ASSET_DISPOSED`, the undepreciated value as an adjustment), the 5,000 lei fixed-asset threshold (question 12: the asset register decides), a missing owner status (`CAS_STATUS_UNSTATED`, `CASS_EXCEPTION_UNSTATED`).
- **Interpretations to confirm:** a loss year contributes zero to the CAS and CASS cumulation; the option for the real system renews for 2-year periods, so the return to a norm is possible only at their start; inventories list cash and bank and leave out the owner's account 4551; fiscal depreciation stops the month before disposal.


### 7.6 P3: the Declarația unică (D212)

Built 30 October 2026. Every value is still `extracted`.

**What the sources said, checked by running them:**

- `D212Validator_01082025.zip` (J13.0.1 / P10.0.0) is still the newest package on ANAF's page; the URL and SHA-256 of §0 are confirmed. It is pinned in `scripts/validators/sources.json` **in the SAF-T kit** (`anaf-saft`): in the general kit (DUKIntegrator 1.4.17.3.3) it fails with `NoClassDefFoundError: dec/DECTagCtx`; only the SAF-T kit's newer `dec` library loads it. `saftKinds` now routes D212 there.
- J13.0.1 enforces the XSD (attribute names and types, the CAEN Rev. 2 list, `situatie_optiune` A–F, non-negative amounts), the CNP's control digit, the namespace by period (an_r 2024 is refused with another namespace) and the rules R1, R4 (`totalPlata_A`), R6.2, R7, R8, R10 and `Rcass_estimat`. It does **not** enforce the structure's arithmetic (a wrong CAS, CASS, tax or `dif_de_plata` passes), and it does **not** enforce `an_r = 2025`: an_r 2026 and 2027 pass in namespace v11. §3.1's "it validates income of 2024 only" holds only because the 2026 form's new attributes (`initiala_c`, `cass_anuala_ai`, `den_venit`…) are unknown to its XSD.
- The web form (V-1.8.10) writes the XML in its browser code and posts it to a server check (`actionValidare`) that is not public. Its structure for our case was read from the bundle (SHA-256 e93cef76…): root, `oblig_realizat`, `cap11` and `oblig_estimat` attribute lists and order, the zeros it writes, the weights rounded to 4 decimals and printed with 5, `impozit11` not written for 1016, `forma_org` 4 replacing `mod_forma_org`, `bifa_succesor` gone, the constants `Number("4050")`, 6/12/24/60 wages, 25%, 10%, and 70% for losses.

**Core** `ro/declarations/d212.ts`: `d212Format(year)` (2024 → an_r 2025, D212_A1.0.3, validator J13.0.1; 2025 → an_r 2026, the web form's structure, no validator; other years null), `calculateD212`, `writeD212`, `checkD212`. The model holds the fiscal register's amounts in whole lei; the writer derives only what the form derives (net or loss, recalculated income, the weights, Section 4's taxable income, Section 7). `checkD212` carries the structure's controls against the constants each structure states (minimum wage 3,300 for 2024 and 4,050 for 2025; CAS bands and bases; CASS minimum, cap and the minimum's difference; 70% of the net income for losses; Section 4; the option's 24,300 / 2,430 lei). An amount that differs only because the form rounds 50 bani up and art. 66 drops them is a warning (`D212_ROUNDING`); any other difference is an error.

**Engine** `modules/d212.ts`, kind `D212`, period = the income year: prepared from `pfa.fiscalRegister`'s computation and the profile. Options: the holder (`holderPartyId`, an individual partner whose CNP is sealed through `parties.recordCnp`), their name, initial and domicile, phone and e-mail, the IBAN for refunds, the register's own inputs (`register`, without the year), the CASS option of Chapter II (situation B after a loss, C after a zero net income; base and CASS from `ro.cass.option`, `ro.min_wage.contributions` and `ro.cass.rate` of the filing year) and `rectifies` (income, option, both). The read set is every line up to the year's end (losses come from earlier years), the profile, the asset register and the income sources' versions. `DeclarationKind.officialValidation(period)` is new: false for the 2025 income, so its return is never sent to DUKIntegrator, `declarations.validate` refuses it (`NO_OFFICIAL_VALIDATOR`) and authorization stays blocked (`NOT_VALIDATED`): it is filed through the web form. The CNP appears only in the XML.

**Refused, with the code:** a year without a structure (`FORMAT_GAP`), the register's gaps (`RULE_GAP`: the engine's register has no PIT values for 2024 or 2025, so in production both years stop here until they are sourced), an IF (`D212_IF`), a form other than PFA/II (`D212_FORM`), a change of form in the year (`D212_FORM_CHANGE`), income outside the books (`D212_OTHER_INCOME`), norms (`D212_NORMA`), more than one source or not the real system (`D212_SOURCE`, and the register's `PIT_SOURCES_MULTIPLE`…), an unstated CAS or CASS status (`CAS_STATUS_UNSTATED`, `CASS_EXCEPTION_UNSTATED`), a missing authorization (`D212_AUTHORIZATION`), a holder without a sealed CNP (`D212_CNP`), amounts with bani (`D212_BANI`), an option that does not fit the year (`D212_CASS_OPTION`), the CAS option below the threshold in the 2024 structure (`D212_CAS_OPTION`), and the checks' codes `D212_YEAR`, `D212_AMOUNT`, `D212_NAME`, `D212_ADDRESS`, `D212_IBAN`, `D212_CAEN`, `D212_SEAT`, `D212_DATE`, `D212_LOSS`, `D212_CAS`, `D212_CASS`, `D212_SECTION4`, `D212_TOTAL`, `D212_RECTIFICATION` (warnings: `D212_ROUNDING`, `D212_PHONE`, `D212_EMAIL`, `D212_SUSPENSION`, and `D212_ADDRESS` for characters the 2024 structure lists as not allowed but J13.0.1 accepts). Not written at all: non-residents, withholding at source, the disability exemption, the bonus of Section 8 (`bifa18` = 0), dependants.

**Rules:** `ro.cass.option` {6 wages} (2025: OPANAF 2.736/2025 instr. pct. 49.1.5; 2026: Code art. 180 alin. (2)); `ro.deadline.D212` = 25 May of the next year from the income of 2025 (Code art. 122 alin. (3); OPANAF 2.736/2025 instr. cap. I pct. 1; a new deadline kind `next_year_date`). `obligations.calendar` lists D212 for each income year of a PFA, II or IF.

**Tests:** core `test/d212.test.ts` (the web form's worked example attribute for attribute and in the form's order, the CASS minimum, a loss with the option, a pensioner, losses carried, the 2024 structure, the rounding conflict, the controls); `scripts/validators/official-d212.test.ts` (seven synthetic 2024 returns J13.0.1 accepts; nine mutations it rejects); `test/engine/pfa.integration.test.ts` (2024 from the books to `validated_official`, stale after a later entry; 2025 prepared and never validated; the refusals; the calendar). The two engine tests for 2024 and 2025 run on a register with **test fixtures** for those years (the 2026 rules, with the 2024 structure's 3,300 lei and 60 wages), marked as such: they test the path, not the values.

**Choices to confirm (expert contabil):**

- Rounding: the register rounds per art. 66 (50 bani dropped), the form's controls round half up; a return where they differ is written with the register's figure and a warning.
- Section 4 rows 2–3: in the 2024 structure the register's deductions, capped at the recalculated income (art. 118 alin. (2^4); the structure's rd.1 ≥ rd.2 + rd.3); in the 2025 form the weighted 4.1/4.2 amounts, uncapped, as the form writes them. The taxable income and the tax are the same.
- The 2025 form's zeros and absences for a loss, for income below 12 wages and for a pensioner (`statut` 2; `statut` 5 for an own system) are read from its code, not confirmed by ANAF: the manual oracle (typing the same data into the form and comparing the XML) is still to be run. `den_caen` (the form's CAEN title) is not written; `adresa_c` is, though the form has no field for it.
- The fiscal register's PIT parameters for 2024 and 2025 are not in the register: sourcing them (the 2024 instructions, OPANAF nr. 1929/2025, were not read) is what unblocks those years in production.

### 7.7 The 2025 income year in the rule register

- **Sourced versions for 2025** (`2025-01-01`–`2025-12-31`), from the instructions in OPANAF 2736/2025's annex:
  - `ro.pit.rate`, from rd. 9;
  - `ro.pit.loss`, from rd. 6;
  - `ro.cas.rate` and `ro.cas.independent`, from pct. 43 and 46;
  - `ro.cass.rate`, from pct. 47.1.
- **Carried from the 2026 consolidated text:** `ro.pit.rounding` (art. 66) and `ro.pit.limits` / `ro.pit.natures` (art. 68 alin. (2)–(7)). They are taken as unchanged because none of OUG 156/2024, Legea 141/2025, Legea 239/2025 (which changes only art. 68 alin. (1)) or Legea 204/2026 amends those paragraphs. The expert confirms.
- **Effect:** the D212 for 2025 income is prepared from the engine's own register, no longer from test values.
- **Still gaps:**
  - 2024 income;
  - `ro.pit.norma` for 2025. The register reads it only for a source on a norm, so a source in the real system is unaffected.


### 7.8 P4: normă de venit, the family enterprise's members, D204

Built 30 October 2026. Every value is still `extracted`; nothing is reviewed.

**Sources added** (snapshots in `.sources/`, registered in core `ro/sources`):

| Id | What | SHA-256 |
|---|---|---|
| OPANAF470/2021 | Formular 204 and its instructions (anexa 2), income from 2020 | `6e22afaee25f50f3bcf928a39992db3f3cc6a953d907d3f377fc674609393fb9` |
| OPANAF90/2022 | Replaces the form of anexa 1, income from 2022; the instructions stay 470/2021's | `d6148e2397db765f1106d4609092688a11d7a1bfdb1ae911881003896f7339bf` |
| ANAF/D204-structura-2025 | XML structure `declaratie:v3` for an >= 2018, 15.01.2026 | `1aa53edc1e1b35c5e52d042d3635b9d152690f373661c3425760a12421a44f3a` |
| OPANAF97/2019 | The earlier form 204 (income 2018–2019), kept for the deadline history | `d389db58065d6de85c119cca7d1aadc3fd9bf3a659f5caef83d55de76cfecdf0` |

`D204_16012026.zip` (J3.0.14 / P2.0.2) hashes `5679dd855e0142f066a3715101ed803e079f3dba2416d3f43ccf529bdd541aee`, as §0 says. It is pinned in `scripts/validators/sources.json` in the **general kit**: unlike D212's it loads in both kits, with the same verdicts (only the wording of structural errors differs).

**What the validators check, verified by running them:**

- **D204 J3.0.14:**
  - checks the CNP, CUI and NIF control digits, the lists (counties, CAEN by year: Rev. 2 to 2024, Rev. 2 and Rev. 3 from 2025), the dates (R40–R41.2), the loss rows (R46.1, R46.2), `totalPlata_A = 0` and empty attributes;
  - does **not** require the quotas to add up to 100%, does not tie `net3` to `venit3 − chelt3`, does not compare the shares' sum with the total or `nr_asoc` with the members, and only **warns** (R57.2, R58.2) about a share more than 1 leu from the quota.
  - `checkD204` adds those as errors (the structure's own ERR rows), and a sum of shares different from the total as a warning.
- **D212 J13.0.1 and `cap12`:** `validateCap12` is empty; only R8 (`bifa112` ⇒ `cap12`) touches it. The 2024 structure's Subsection 2 is **only for an activity started in December 2024** (its rules on `norma_data_incep`); the others' 2024 norm tax was set in the declaration filed in 2024. The writer refuses other 2024 norm returns (`D212_NORMA_START`).

**Normă de venit** (`pfa.fiscalRegister`, core `adjustedNorm`):

- The norm is the preparer's, with the DGRFP publication as evidence (`norms[]`), now with the **criterion** (01–13, as the web form codes them) of the highest increasing and reducing coefficients.
- The register returns rd. 8 (`yearly`: the norm × increase × reduction), the days of activity and of interruption, rd. 9 (`adjusted`, prorated over 365 days) and the tax.
- The floor of 12 minimum wages blocks (`PIT_NORM_FLOOR`).
- **The 25,000 EUR threshold, both ways:**
  - this year's gross income above it is a note: real system from next year (`PIT_NORMA_THRESHOLD`);
  - last year's gross income above it blocks this year's norm (`PIT_NORMA_REAL_REQUIRED`). It is read from the books, or from `previousGross` when the books do not hold that year (`PIT_NORMA_PREVIOUS_GROSS`), at last year's BNR average (`previousEurAnnualRate`, else `PIT_EUR_RATE`).
- The 2-year option lock is P0's (module and trigger).
- **`ro.pit.norma` for the income of 2025 stays a gap:**
  - OPANAF 2736/2025's instructions state neither a floor nor a threshold;
  - Legea 239/2025 rewrote art. 69 alin. (3) only from the income of 2026, and the earlier wording is not in the sources;
  - when alin. (9) (25,000 EUR) took effect cannot be read from the consolidated text.
  - A 2025 norm source therefore stops at `RULE_GAP`; the engine tests use a marked fixture.

**D212 on a norm** (core `D212Norm`, `cap12`):

- **2024 structure:** the flat `cap12` (norm, rd. 8, rd. 9, rd. 9.1, tax); `bifa111` 0 and `bifa112` 1.
- **Web form:** `cap12` with one `norma_loc` and a `corectie` per coefficient. It writes `real_ajustare` 0 when there is no coefficient, as the form does. It does **not** write the place's county, locality and street codes: they come from ANAF's nomenclators, which are not public (`D212_NORMA_PLACE` warning).
- **Both:** CAS and CASS count rd. 9. Section 4 is empty, and the norm's tax goes into Section 7.
- **Checks:** rd. 8 from the coefficients, rd. 9 from the days, and the tax at 10%. One leu off is a `D212_ROUNDING` warning; more is `D212_NORMA`.

**Family enterprise members** (table `acc_enterprise_members`, migration `0013_enterprise_members`):

- **One version per agreement** (the acord de constituire, then each addendum), recorded whole by `if.members.record` (human approval). `if.members.list` returns no CNP.
- **Each member row holds:** its position, the party (an individual with a sealed CNP), the quota in hundredths of a percent, the representative flag, from/to and the evidence.
- **The module checks** (codes `ENTERPRISE_MEMBER_*`): the form `if` on the date; at least 2 members (OUG 44/2008 art. 28); quotas adding to 100% and one representative (art. 29); CNPs sealed; distinct members; an addendum after the previous agreement.
- **The trigger `inv_enterprise_member_guard` checks again**, with one attack each in `invariants.integration.test.ts`:
  - `enterprise_member_version`: numbering of agreements and positions;
  - `enterprise_member_form`;
  - `enterprise_member_cnp`;
  - `enterprise_member_quota`: never above 100%;
  - `enterprise_member_representative`: at most one;
  - `enterprise_member_terms`: one date and evidence per agreement;
  - `enterprise_member_complete`: a new agreement only after a complete one (≥ 2 members, exactly 100%, one representative);
  - `enterprise_member_dates`.
- **The last agreement's completeness** cannot be checked by a row trigger while it is being written. The operation checks it, and so does the register (`PIT_IF_MEMBERS_INCOMPLETE`).
- The export includes the table.

**The IF's register and D204:**

- **The register:** for an IF, `pfa.fiscalRegister` returns the source and `enterprise` with each member's share of the net income or loss. Its `contributions` and `tax` are null: they are each member's.
  - **Shares:** to the leu, largest remainder, so that they add up. This is within the structure's `round(net × cota)` ±1.
  - **Blocking cases:** no agreement (`PIT_IF_MEMBERS`), a change in the year (`PIT_IF_MEMBERS_CHANGE`; the norms' interim allocation of pct. 41 alin. (6) is not built), or an incomplete agreement.
  - **On a norm:** nothing is distributed (`PIT_IF_NORMA`).
- **D204** (core `ro/declarations/d204.ts`, engine kind `D204`, period = income year):
  - Pinned for the income of 2022–2026.
  - **Filled from:** the register's totals and shares, the company's name and CUI, and the representative's name and CNP.
  - **Taken from the options:** the addresses, the contract as registered with the fiscal body (`nr_contr`, `data_contr`), the locality and the Bucharest sector.
  - It reaches `validated_official` in the general kit.
  - **Refused:** not an IF (`D204_FORM`), on a norm (`D204_NORMA`), a change of form (`D204_FORM_CHANGE`), several sources (`D204_SOURCE`), and the checks' `D204_*` codes.
- **D212 of a member (extended):**
  - `holderPartyId` is the member. `member` gives their CAS status and CASS exception (`D212_MEMBER` if missing). `association` gives the registered contract (`D212_ASSOCIATION`).
  - **cap11 is `forma_org` 2**, and only the net income or loss distributed is written:
    - web form: `nr_doc_asociere` and `data_doc_asociere`, no `venit_brut`/`chelt_deduc`;
    - 2024 structure: the contract in its single document field.
  - **The member's own figures:** the losses carried are their shares of the books' earlier years plus their declared opening losses; CAS, CASS and tax are on their share.
  - **Refused:** a non-member (`PIT_IF_MEMBER`), and members of an IF on a norm (`D212_IF_NORMA`: each member's own norm is not modelled).
  - The integration test checks that the members' D212 add up to the D204's distribution.

**D204 deadline: a conflict shown, not settled.**

| Text | Deadline |
|---|---|
| Code art. 125 alin. (4) | last day of February |
| OPANAF 470/2021 anexa 2 pct. 3.1 (in force; 90/2022 did not touch it) | last day of February |
| Norme metodologice, titlul IV pct. 41 alin. (4) (not updated) | 15 March |
| OPANAF 97/2019 pct. 3 lit. a) (income 2018–2019) | 15 February |

- `ro.deadline.D204` is a new deadline kind, `conflict`, with two readings and their clauses:
  - the last day of February: the Code and OPANAF 470/2021;
  - 15 March: the norms.
- `obligations.calendar` lists D204 for each income year of an IF in the real system. Its due date is the earliest reading. The `conflict` field gives every reading with its date and clauses.
- §1.15's "15 February" was OPANAF 97/2019's, which OPANAF 470/2021 replaced from the income of 2020.

**Choices to confirm (expert contabil):**

- **An IF is an association under art. 125.** The Code, OPANAF 470/2021 and 90/2022 never name it; norme pct. 41 alin. (1) lists "asociații familiale".
- **Shares** by largest remainder (sum exact), not each `round(net × cota)`.
- **A member's 2024 `nr_doc_autoriz`** carries the association contract ("autorizare/ contract de asociere").
- **Norm proration** over 365 days in a leap year too (norme pct. 8 alin. (10)).
- **The previous year's 25,000 EUR test** uses this year's rule.
- **Each member of an IF on a norm owes the whole norm** (art. 69 alin. (3), "stabilită pentru fiecare membru asociat"). This is read, not built.
