# D212 (an_r=2026, income 2025): XML written by the ANAF web form "duf" V-1.8.10

Scope: resident PFA, one `categ_venit=1016` source, real system (`det_ven_net=1`), `forma_org=1`, CAS and CASS on that income, Section 4 (4.1/4.2), Section 7, optional Section 8 bonus, and optional Chapter II (`oblig_estimat`). The bundle was only read as text (Python `-I` scripts in a session scratchpad, not kept). It was never executed.

## Evidence / provenance

| file | SHA-256 |
|---|---|
| `.sources/pfa-research/dl/duf/0q0aa-_tiydwh.js` (main bundle, 358,581 B; contains the XML writer and all calculations) | `e93cef76053d11622890e2ad9b48505d4f42d0f377c3477135170e6ed0d10337` |
| `.sources/pfa-research/dl/duf/10acdz8mf1-g1.js` (category list, module 68937) | `953f11c28092eac07d8cbd6fce7bb2d36c490dec5524fa1588806ddbebcb998d` |
| `.sources/pfa-research/dl/duf/0g0zug0briava.js` (CAEN list, module 65846) | `b69399b2c6330165d85c29fe73a16552c5c147051442f63b8a87ac84ebbdcfea` |
| `.sources/pfa-research/dl/duf/0kif51h45hyzl.js` (only the storage provider, key `"d212"`; no XML logic) | `df69a38324a5794d803fb5261401c45ef8ac236490ed89e8b93e6a1c177c33d6` |
| `.sources/pfa-research/dl/duf.html` | `80dd4fc7fc1bb16ccb158da8a6d42b7740a753791de71fb17be503a2ad4763a8` |
| `.sources/pfa-research/cf/struct.txt` (2025 structure D212_A1.0.3, an_r=2025) | `460038faa9394d69dbb05efb0e8ad59afc6ab243197c0b6408b20d5edccb2fff` |

The version string in the bundle is `"V-1.8.10 / 15.05.2026"`.

Every `L<n>` reference below is a line of a pretty print of the bundle (V-1.8.10, its SHA-256 recorded in the source register) made in a session scratchpad, which was not kept; re-create it to follow the references.

**Architecture.** The form keeps all its state in `secureStorage` under key `"d212"` (AES in sessionStorage). React components compute each section and write it back to storage (`CAS_data`, `CASS_data.d21/d22`, `sectiunea4.{s4,s41,s42}`, `sectiunea7.{s71..s74}`, `s8`, `optiune`, `sectiunea3`, `venituri[]`).

- The XML writer `Y()` (L537-L1260) only maps stored fields to attributes. It does not calculate anything.
- The same `Y()` string is used in two places:
  - the "Salvează fișier temporar" download, saved as `D212.xml` (L1292-1319);
  - "Generează fișier PDF pentru depunere", which posts it to the server action `actionValidare` (L6273-6348). ANAF therefore validates this exact XML on its server. That validator is not public.

---

## 0. Document skeleton and serializer

```js
// L1251-1259 (end of Y)
eT=(eM?eM+"\r\n":"")+(eO?eO+"\r\n":"")+(eI?eI+"\r\n":"")+(eF?eF+"\r\n":"")+(eD?eD+"\r\n":"")+(eP?eP+"\r\n":"")+(ek?ek+"\r\n":"")+(e$?e$+"\r\n":"");
return`<?xml version="1.0"?>\r
`+(S=String("V-1.8.10 / 15.05.2026").replace(/--/g,"—").trim(), ... z=`${N.getFullYear()}-${y(N.getMonth()+1)}-${y(N.getDate())} ${y(N.getHours())}:${y(N.getMinutes())}:${y(N.getSeconds())}`,
  A=[],S&&A.push(`<!-- VERSIUNE_DECL=${S} -->`),A.push(`<!-- DATA_GENERARE=${z} -->`),A.join("\r\n")+"\r\n")+B("d212",eE,"\r\n"+eT)
```

The output therefore looks like this (CRLF line ends; no `encoding=` in the declaration; the Blob is `application/xml;charset=utf-8`):

```
<?xml version="1.0"?>
<!-- VERSIUNE_DECL=V-1.8.10 / 15.05.2026 -->
<!-- DATA_GENERARE=YYYY-MM-DD HH:MM:SS -->        (local time)
<d212 ...root attrs...>
<oblig_realizat ... />
<oblig_estimat ... />
<cap11 ... />            (one per income, joined with \r\n)
<cap12 ...>...</cap12>
<cap14 ... />
<cap19 ...>...</cap19>
<cap23 ...>...</cap23>
<coasigurat ... />       (0..3)
</d212>
```

The child order is fixed: `oblig_realizat`, `oblig_estimat`, `cap11*`, `cap12*`, `cap14*`, `cap19*` (new), `cap23*` (new), `coasigurat*`. Empty groups are skipped.

**Generic builders** (L460-L478):

```js
function L(e){return String(e??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;")}
function B(e,a={},t=""){let i=[];for(let e of Object.keys(a)){let t=a[e];null!=t&&""!==t&&i.push(` ${e}="${L(t)}"`)}let r=i.join("");return`<${e}${r}>${t}</${e}>`}
function V(e,a){let t=`<${e}`;for(let[e,i]of Object.entries(a))t+=function(e,a){if(null==a)return"";let t=String(a);return""===t?"":` ${e}="${L(t)}"`}(e,i);return t+" />"}
function G(e,a){if(e&&null!=e[a]&&""!==String(e[a]))return e[a];let t=e?.dateIdentificare??e?.DateIdentificare;if(t&&null!=t[a]&&""!==String(t[a]))return t[a]}
```

- An attribute is dropped when its value is `undefined`, `null` or `""`. The value `"0"` is written.
- `B` (container, open/close) is used for `d212`, `cap12`, `norma_loc`, `cap19` and `cap23`. `V` (self-closing, written as `" />"` with a space) is used for `oblig_realizat`, `oblig_estimat`, `cap11`, `cap14`, `corectie`, `cap19_luna`, `produse` and `coasigurat`.
- Attributes are emitted in object-literal key order. All `oblig_realizat` keys are pre-declared with `void 0`, so their order is the literal order whatever order they are assigned in.
- Escaping covers `& < > " '`. Diacritics are written raw as UTF-8.
- `G` reads root fields from storage, or from `storage.dateIdentificare` as a fallback.

---

## 1. Root `<d212>`: attributes in emitted order (L599-L708)

```js
eE={an_r:"2026",luna_r:"12",d_rec:a,rectif1:t,rectif2:i,totalPlata_A:w,bifa_conformare:en,bifa18:el,bifa19:ei,bifa23:er,
anulare_litA:O,anulare_litB:I,bifa111:L,bifa112:Y,bifa14:Z,bifa113:q,bifa121:X,bifa15:Q,bifa122:ee,bifa131:ea,bifa132:et,
nume_c:es,initiala_c:ed,prenume_c:eo,cif:ec,cont_bancar:eu,adresa_c:e_,telefon_c:em,fax_c:ep,email_c:ef,nerezident:eg,
stat_rezidenta:eh,den_stat_rezidenta:eb,cif_str:ex,statut:ej,den_i:eS,cif_i:ey,adresa_i:eN,telefon_i:ez,fax_i:eA,email_i:eC,
"xmlns:xsi":"http://www.w3.org/2001/XMLSchema-instance","xsi:schemaLocation":e.schemaLocation??"mfp:anaf:dgti:d212:declaratie:v11",xmlns:ew}
```

| # | attr | source / formula | when empty |
|---|---|---|---|
| 1 | `an_r` | constant `"2026"` | always |
| 2 | `luna_r` | constant `"12"` | always |
| 3-5 | `d_rec`, `rectif1`, `rectif2` | from `A_drec` (default `"0"`, set on hydrate, L14079):<br>`"0"` gives 0/0/0 (initial);<br>`"1"` gives 1/1/0 ("Rectificare venituri 2025");<br>`"2"` gives 1/0/1 ("Rectificare opțiuni 2026");<br>`"3"` gives 1/1/1 ("Rectificare ambele") | always "0"/"1" |
| 6 | `totalPlata_A` | sum of the digits of `cif`: `String((a=(s||"").match(/\d/g))&&0!==a.length?a.reduce((e,a)=>e+Number(a),0):0)` (L14062) | "0" if no cif |
| 7 | `bifa_conformare` | checkbox shown only when `A_drec=="1"`; default "0", and forced to "0" for other values (L14087) | "0" |
| 8 | `bifa18` | `!0===G(C,"bifa18")?"1":"0"`. This is the "Bonificație impozit" sidebar toggle (L14797). It also shows Section 8. | "0"/"1" |
| 9 | `bifa19` | "1" if some 2020 (foreign pension) income has a country or monthly rows (that is, `cap19` exists) | "0" |
| 10 | `bifa23` | "1" if some income is `10091` (agriculture on norm, `cap23`) | "0" |
| 11-12 | `anulare_litA`, `anulare_litB` | checkboxes; null or empty gives "0" | "0" |
| 13 | `bifa111` | "1" if any `categ` is in D=`[1016,10031,1003,1006,1015,1009,1010,1011,1012,1025,1021,1022,1023,1024,1026]` | "0" |
| 14 | `bifa112` | "1" if `10161` (norm) | "0" |
| 15 | `bifa14` | "1" if any `categ=="1016"` (H("1016") is always "1"). It does **not** depend on `impozit11`, unlike the 2025 rule. | "0" |
| 16 | `bifa113` | "1" if `10061` | "0" |
| 17 | `bifa121` | "1" if any foreign category `$` (2003, 2004, ... 2016) | "0" |
| 18 | `bifa15` | "1" if `1003` | "0" |
| 19 | `bifa122` | "1" if `2016` | "0" |
| 20 | `bifa131` | `J(C)`: "1" if `CAS_data` is non-empty and (`bifa_cas=="1"` or `baza_calcul_cas>0`) | "0" |
| 21 | `bifa132` | `W(C)`: "1" if a CASS 2.1/2.2 row is filled (d22 `bifa_cass_real` 1-3, or `rd2_baza_anuala`, or d21 `rd2/rd5/rd7/rd8` non-empty) and a CASS-relevant category exists (1016 counts) | "0" |
| 22 | `nume_c` | free text, max 250 | omitted if empty |
| 23 | `initiala_c` | `trim().toUpperCase().slice(0,2)` | omitted if empty |
| 24 | `prenume_c` | free text, max 250 | omitted if empty |
| 25 | `cif` | digits only (CNP/CUI input) | omitted if empty |
| 26 | `cont_bancar` | `iban_c` verbatim (max 24, not normalized) | omitted if empty |
| 27 | `adresa_c` | built from storage `judetDen_c, localitateDen_c, stradaDen_c, "nr. X", "bl. X", "sc. X", "et. X", "ap. X"`, then `"(judet=..., localitate=..., strada=...)"` codes, all joined with `", "`. This page has **no UI for these fields** and the XML importer does not import them. They can only come from the SPV pre-completion route, whose code was not downloaded (UNKNOWN). In practice the attribute is usually **omitted**. | omitted |
| 28-30 | `telefon_c`, `fax_c`, `email_c` | phone and fax keep digits only; email characters are filtered | omitted if empty |
| 31 | `nerezident` | `nerezident_c`; null or empty gives "0" | "0" |
| 32 | `stat_rezidenta` | `tara_rezidenta_obj.numeric ?? tara_rezidenta_c`. The UI stores alpha2 in `tara_rezidenta_c`, so the value is the alpha2 code. | omitted for residents |
| 33 | `den_stat_rezidenta` | `tara_rezidenta_obj.name` (country name) | omitted for residents |
| 34 | `cif_str` | foreign TIN | omitted for residents |
| 35 | `statut` | storage `pensionar` (see the option list below) | omitted if not chosen |
| 36-41 | `den_i`, `cif_i`, `adresa_i`, `telefon_i`, `fax_i`, `email_i` | împuternicit block, shown when `bifa_imp=1`: den_i max 60, adresa_i free text max 200, phone and fax digits only | omitted |
| 42 | `xmlns:xsi` | `http://www.w3.org/2001/XMLSchema-instance` | always |
| 43 | `xsi:schemaLocation` | `mfp:anaf:dgti:d212:declaratie:v11` (namespace only, no xsd file) | always |
| 44 | `xmlns` | `mfp:anaf:dgti:d212:declaratie:v11` | always |

**`statut` values** (L7280-7298), each with its label:

- `1`: not liable for social contributions in RO under EU/bilateral social security rules
- `2`: Pensionar
- `3`: salary or assimilated income in 2025 below 6 SMB
- `4`: salary in 2025 at least 6 SMB
- `5`: insured in an own system (lawyer, notary)
- `6`: pupils or students, or under 26 coming from the child protection system

None of these fits a plain PFA, so `statut` is omitted. Effects on the form:

- `pensionar` 1, 2 or 5 hides the CAS block.
- `1` hides CASS.
- `3`/`4` restrict the categories counted for CAS.
- `6` changes CASS 2.2.

---

## 2. `oblig_realizat`: full key list in emitted order (L710-L824)

```
oblimpozit_real_bonif, str_cas_baza, str_cas_datorat, str_cass_baza, str_cass_datorat,
real_camere_inchiriere, real_venit_inchiriere, real_impozit_inchiriere,
cas_total_ven, cas_baza, cas_datorat, cas_retinut_platitor, cas_dif_plus, bifa_cas_real, bifa_cas_recalculat, bifa_cas_sub_plafon,
cass_total_ven_ai, baza_cass_datorat_ai, cass_anuala_ai, cass_datorat_art180_ai, cass_datorat_ai, cass_retinut_platitor_alin6_ai, cass_dif_plus_ai, cass_dif_minus6_ai,
cass_ven_dpi, cass_ven_asc, cass_ven_cfb, cass_ven_inv, cass_ven_asp, cass_ven_alt, cass_total_ven, cass_baza, cass_anuala, cass_datorat_art180, cass_datorat, cass_retinut, cass_dif_plus, cass_dif_minus,
bifa_cass_real, bifa_cass_datorat_dpi, bifa_cass_datorat_ai,
real_venit_net_recalculat_ai, "real_cas-deduc_ai", "real_cass-deductibil_ai", real_venit_net_impozabil_ai, real_venit_net_impozabil_redus_ai, real_impozit_datorat_ai,
real_cas_venit_net_ai, real_cas_total_ven_ai, real_cas_pondere_ai, real_cas_datorata_ai, real_cas_deductibila_ai,
real_cass_venit_net_ai, real_cass_total_ven_ai, real_cass_pondere_ai, real_cass_datorata_ai, real_cass_calculata_ai, real_cass_deductibila_ai,
real_venit_net_recalculat_dpi, real_cas_dpi, real_venit_net_impozabil_dpi, real_venit_net_impozabil_redus_dpi, real_impozit_datorat_dpi,
real_cas_venit_net_dpi, real_cas_total_ven_dpi, real_cas_pondere_dpi, real_cas_datorata_dpi, real_cas_deductibila_dpi,
real_diferenta_CASS, real_impozit_diferenta_CASS,
oblimpoz_real_total, oblimpoz_real_anticipat, oblimpoz_real_dif_deplata, oblimpoz_real_dif_restituit,
oblcas_real_difPlus, oblcas_real_str,
oblcass_real_difPlus_ai, oblcass_real_difMinus_ai, oblcass_real_difMinus_174, oblcass_real_difPlus_dpi, oblcass_real_difMinus_dpi, oblcass_real_str, oblcass_real_str_pensie,
impozit_venit_plus, impozit_venit_minus, cas_plus, cass_plus, cass_minus, dif_de_plata, dif_de_restituit,
cass_ret_dpi, cass_ret_asc, cass_ret_cfb, cass_ret_inv, cass_ret_asp, cass_ret_alt, cass_ret_ai,
cas_ret_dpi, cas_ret_asc, cas_ret_cfb, cas_ret_inv, cas_ret_asp, cas_ret_alt, cas_ret_ai,
venit_ret_dpi, venit_ret_asc, venit_ret_cfb, venit_ret_inv, venit_ret_asp, venit_ret_alt, venit_ret_ai
```

**Exact spellings:**

- `real_cas-deduc_ai` and `real_cass-deductibil_ai` contain a **hyphen**.
- `real_diferenta_CASS` and `real_impozit_diferenta_CASS` use uppercase CASS.
- `oblcas_real_difPlus`, `oblcass_real_difPlus_ai`, `oblcass_real_difMinus_ai`, `oblcass_real_difMinus_174`, `oblcass_real_difPlus_dpi` and `oblcass_real_difMinus_dpi` use camelCase `difPlus`/`difMinus`.
- No key contains a space.

**When the element exists:** `if(!x&&!S)return"";`. It is written only if some `venituri[]` row has a category, or some withholding (`venituriStopaj`) row has `tip_venit` 1-8.

### 2.1 Mapping and formulas relevant to our case

All amounts are strings. "round" means `String(Math.round(x))`, which rounds half up in IEEE doubles. Do **not** substitute Python's banker's `round()`.

**CAS (Section 3.1)** comes from `CAS_data` (component `ng`, L12928-13311). It is mapped only if `J=="1" || CAS_data.bifa_cas_recalculat=="1"` (L833-L846).

| attribute | JS source / formula |
|---|---|
| `cas_total_ven` | `CAS_data.venit_total` = `Math.round(round(Σ stopaj tip 1,2,3 .suma) + round(Σ rd3_venit_net>0 of 1016,10161(venit_net_anual),1003,10031,2027,2003,1026))`. If pensionar is 3 or 4, only stopaj 1,2 and categories 1016, 10161, 2027, 2003 count. For us this is round(rd3 of 1016). |
| `cas_baza` | `baza_calcul_cas`, entered by the user and rounded. On blur: `nc(Math.max(no(a),"0"===z?"1"===m.bifa_cas?A:0:A))`, where minBase A = 12×4050 = 48600 (z = "0" or "1") or 24×4050 = 97200 (z = "2"). If z="0" and the user did not opt: "0". If z≠"0" and nothing was entered: "" (and then no CAS block, because J="0"). With `bifa_cas_recalculat=1` the base is free: any value, no minimum. |
| `cas_datorat` | `nc(.25*no(baza))`, i.e. round(25% × base) |
| `cas_retinut_platitor` | `nc(round(Σ stopaj cas_retinut))`. This is **"0"** when there is no withholding, and it is still written. |
| `cas_dif_plus` | `nc(Math.max(cas_datorat - cas_retinut, 0))` |
| `bifa_cas_real` | `CAS_data.bifa_plafon` = `S<12*np?"0":S<24*np?"1":"2"`, with S = venit_total and np = 4050. It can be **"0"** when the user opts below the threshold (2025 allowed only 1,2). |
| `bifa_cas_recalculat` | `CAS_data.bifa_cas_recalculat`, "0"/"1" (default "0", always written in the block). Tooltip: for people who were exempt (art. 150) for part of the year and reach the recalculated minimum ceiling; it allows a manual base without the automatic minimum. |
| `bifa_cas_sub_plafon` | `String(CAS_data.bifa_cas)`, "0"/"1": "below 12 SMB, I opt to pay CAS". Default "0", always written in the block. |

**CASS 2.1, activități independente** comes from `CASS_data.d21` (function `ni`, L12352-L12387). It is mapped whenever d21 is non-empty (L847-848).

| attribute | JS source / formula |
|---|---|
| `cass_total_ven_ai` | `d21.rd1_total_venit` = `r2(Σ stopaj tip 1,2 .suma + Σ rd3_venit_net>0 of 1016,10161,2027)`, rounded |
| `baza_cass_datorat_ai` | `rd2_baza_anuala` = `"1"===exceptie_cass\|\|0===r ? Math.min(r,60*SM) : Math.max(6*SM,Math.min(r,60*SM))`, i.e. clamp(r, 24300, 243000), rounded |
| `cass_anuala_ai` | `rd3_cass_anuala` = round(max(0.1 × base, 0)) (new attribute) |
| `cass_datorat_art180_ai` | `rd4_cass_optiune_art180`; set to **"0"** if empty, so it is written as "0" (new attribute). If filled, it must equal 10% × 6 × SM = 2430. |
| `cass_datorat_ai` | `rd5_cass_datorata` = round(max(rd3 − rd4, 0)) |
| `cass_retinut_platitor_alin6_ai` | `rd6_cass_retinuta_174_10` = round(Σ stopaj tip 1 cass_retinut), **"0"** when there is none |
| `cass_dif_plus_ai` | `rd7_diferenta_plus` = round(max(rd5 − rd6, 0)) |
| `cass_dif_minus6_ai` | `rd8_diferenta_minus` = round(max(rd6 − rd5, 0)), **"0"** |

**CASS 2.2** comes from `CASS_data.d22`. For a 1016-only filer every d22 field is "" (`nn` early return), so `cass_ven_*`, `cass_total_ven`, `cass_baza`, `cass_anuala`, `cass_datorat_art180`, `cass_datorat`, `cass_retinut`, `cass_dif_plus`, `cass_dif_minus` and `bifa_cass_real` are all **omitted**.

| attribute | rule | our case |
|---|---|---|
| `bifa_cass_datorat_dpi` | `Number(d22.s17_total)` > 0 gives "1", otherwise "0". It is undefined only if s17 is empty **and** W()=="0". | written **"0"** |
| `bifa_cass_datorat_ai` | `Number(d21.rd1_total_venit)` > 0 gives "1", otherwise "0" | **"1"** |

**Section 4** comes from `sectiunea4.s4` (function `tE`, L4499-L4635). It is recomputed globally in `nU` (L13986).

| attribute | JS source / formula |
|---|---|
| `real_venit_net_recalculat_ai` | `s4.rd1_suma_venituri_nete_recalculate` = `ty(Σ_{1016} rd7_venit_impozabil)` |
| `real_cas-deduc_ai` | `s4.rd2_cas_deductibila` = `s41.rd5_cas_deductibila` (omitted if "") |
| `real_cass-deductibil_ai` | `s4.rd3_cass_deductibila` = `s42.rd6_cass_deductibila` |
| `real_venit_net_impozabil_ai` | `s4.rd4` = `i>0?Math.max(i-r-n,0):NaN`, rounded; "" (omitted) if rd1 ≤ 0 |
| `real_venit_net_impozabil_redus_ai` | `s4.rd5`, user entry; if it is greater than rd4 it is rejected (event `sectiunea4:rd5-too-big`). Omitted if not entered. |
| `real_impozit_datorat_ai` | `s4.rd6` = `ty(.1*(rd5 if finite else rd4))` |

**Section 4.1** comes from `sectiunea4.s41` (L4540-4557).

| attribute | JS source / formula |
|---|---|
| `real_cas_venit_net_ai` | `rd1_venit_net_real` = `ty(Σ_{1016} rd3_venit_net)` |
| `real_cas_total_ven_ai` | `rd2_total_venit_cumulat_148` = `ty(CAS_data.venit_total)`. This is **"0"** if CAS_data is missing, and it is still written. |
| `real_cas_pondere_ai` | `rd3_pondere` = `tC(tA(r/n))`, with `tA=e=>Math.round(1e4*e)/1e4` and `tC=e=>e.toFixed(5)`. The ratio is **rounded to 4 decimals and printed with 5**, e.g. `"0.83330"` or `"1.00000"`. It is "" if r or n is 0. |
| `real_cas_datorata_ai` | `rd4_cas_datorata` = `CAS_data.cas_datorata ? ty(cas_datorata) : ""`. The string "0" is truthy, so this gives "0". |
| `real_cas_deductibila_ai` | `rd5_cas_deductibila` = `ty(pondere4dp * rd4)` when rd4 > 0, otherwise "" (omitted) |

If `rd1_venit_net_real` parses to 0 (via `tz`, which strips "." then turns "," into "."), every s41, s42 and s4 field is "" and Section 4 is omitted completely.

**Section 4.2** comes from `sectiunea4.s42` (L4578-4592).

| attribute | JS source / formula |
|---|---|
| `real_cass_venit_net_ai` | `rd1_venit_net_real` = `ty(Σ_{1016} rd3_venit_net)` |
| `real_cass_total_ven_ai` | `rd2_total_venit_170` = `ty(d21.rd1_total_venit)` |
| `real_cass_pondere_ai` | `rd3_pondere`, same `tA` then `toFixed(5)` |
| `real_cass_datorata_ai` | `rd4_cass_datorata` = `ty(d21.rd3_cass_anuala)` (not rd5) |
| `real_cass_calculata_ai` | `rd5_cass_baza_174` = `_<=6*tw ? ty(.1*_) : ""`, where _ = rd2_total_venit_170 and tw = 4050. That is, round(10% × total) only if total ≤ 24300, otherwise "" (omitted). |
| `real_cass_deductibila_ai` | `rd6_cass_deductibila` = `ty(pondere4dp * x)`, with `x = (rd4!=="" && rd5!=="") ? rd5 : rd4` |

**Section 6**: `real_diferenta_CASS` and `real_impozit_diferenta_CASS` are written only if > 0. They come from `d21.rd8` when `d21.rd6 > 24300`. For us they are omitted.

**Section 7** comes from `sectiunea7` (function `tY`, L5697-L5770).

| attribute | JS source / formula |
|---|---|
| `oblimpoz_real_total` | `s71.rd1_impozit_anual` = `y>0?tJ(y):"0"`, where y = Σ rd9_impozit over [1003, 10031, 1015, 1006, 10061, 1009, 10091, 1010, 1011, 1012, 1021-1026] (**not 1016**) + 10161.impozit_venit + 10061.impozit_anual + 10091.impozit_venit + Σ str_rd11 over foreign categories + s4.rd6 + s5.rd5 + s6.rd2. For us this is real_impozit_datorat_ai, and "0" if none. |
| `oblimpoz_real_anticipat` | `s71.rd2_impozit_retinut` = `j>0?String(j):""`, where j = Σ venituri[].impozit_retinut (the cap11 "11. Impozit reținut" field). It is not rounded, and omitted if 0. |
| `oblimpoz_real_dif_deplata` | `tJ(d>0\|\|o>0 ? max(d-o,0) : 0)`. **"0" is written** (2025 struct said null). |
| `oblimpoz_real_dif_restituit` | `tJ(max(o-d,0))`, "0" |
| `oblcas_real_difPlus` | `CAS_data.diferenta_plus ?? "0"`, raw. This is "" (omitted) if CAS_data exists but no base was entered. |
| `oblcas_real_str` | `tJ(sectiunea2.rd2_cas_datorata_str>0?...:0)`, **"0"** |
| `oblcass_real_difPlus_ai` | `d21.rd7 ?? "0"`, then "" stays "", otherwise tJ |
| `oblcass_real_difMinus_ai` | `d21.rd8`, "0" |
| `oblcass_real_difMinus_174` | `d22.rd8_diferenta_minus` (sic, the same source as `_dpi` minus). For us this is "", so it is omitted. |
| `oblcass_real_difPlus_dpi` | `d22.rd7`, "", omitted |
| `oblcass_real_difMinus_dpi` | `d22.rd8`, "", omitted (new attribute) |
| `oblcass_real_str` | `tJ(sectiunea2.rd4_cass_datorata_str)`, "0" |
| `oblcass_real_str_pensie` | `tJ(Σ venituri.total_cass_pensii_str)`, "0" (new attribute) |
| `impozit_venit_plus` | `tJ(s71.rd3)` |
| `impozit_venit_minus` | `tJ(s71.rd4)` |
| `cas_plus` | `tJ(s72.rd1 + s72.rd2)` |
| `cass_plus` | `tJ(s73.rd1_ai_plus + rd4_alte_plus + rd6_sal_strain + rd7_pens_strain)` |
| `cass_minus` | `tJ(s73.rd2_ai_minus + rd5_alte_minus)`. Note that `rd3_ai_minus_1741` is **not** included. |
| `dif_de_plata` | `tJ(max(imp_plus + cas_plus + cass_plus − (imp_minus + cass_minus), 0))` |
| `dif_de_restituit` | `tJ(max(imp_minus + cass_minus − (imp_plus + cas_plus + cass_plus), 0))` |

Both `dif_de_plata` and `dif_de_restituit` are always written, one of them as "0". The bonus is not subtracted from `dif_de_plata`.

**Section 8**: `oblimpozit_real_bonif` = `s8.oblimpozit_real_bonif`. It exists only while the `bifa18` toggle is on (L14800: un-ticking removes `s8`).

```js
// L14445-14454
let e=nX(t.rd1_impozit_anual),a=e>0,i=a?Math.round(.03*e):0;
return{...,bonifStr:a&&i>0?nQ(i):""}
```

So the bonus is round(3% × oblimpoz_real_total), or omitted when the tax is 0. There is no `oblcas_real_bonif` or `oblcass_real_bonif` any more. The UI note says the bonus was only valid for returns filed by 15 April (this is not enforced).

`cass_ret_*`, `cas_ret_*` and `venit_ret_*` (new) come from `venituriStopaj` rows (tip 3, 4, 5, 6, 7, 8, and 1/2 for `_ai`). They are omitted for us.

---

## 3. `cap11` (L960-L1046): attribute order and sources

```js
S={scutire:e?.scutire,reg:e?.reg,categ_venit:v,den_venit:e?.A_categ_venit_den??"",
..."1"===j||"2"===j?{det_ven_net:j}:{},tip_chirie:e?.tip_chirie,forma_org:e?.forma_organizare,caen:e?.codCAEN,den_caen:e?.codCAEN_den,
descriere_sediu_bun:e?.sediu,nr_doc_autoriz:h,data_doc_autoriz:b,nr_doc_asociere:e?.nr_contract_asoc,data_doc_asociere:e?.data_contract_asoc,
data_incep:e?.data_start,data_sf:e?.data_sfarsit,data_suspendare:e?.data_suspendarii,nr_zile_scutite:x,venit_brut:e?.rd1_venit_brut,
chelt_deduc:e?.rd2_chelt_deduct,...p?{pierdere:c}:{},..."1025"!==r&&f?{venit_net_anual:o}:{},pierdere_precedenta:e?.rd5_pierderi_reportate,
..."allowed"===function(e){...["1021","1022","1023","1024","1025"].includes(a)?"forbidden":"allowed"...}(r)?{pierdere_compensata:e?.rd6_pierdere_compensata}:{},
venit_recalculat:e?.rd7_venit_impozabil,venit_redus:e?.rd8_venit_impozabil_redus,
..."1016"!==v&&"1003"!==v?{impozit11:e?.rd9_impozit}:{},impozit_retinut:e?.impozit_retinut};
```

Order: `scutire, reg, categ_venit, den_venit, det_ven_net, tip_chirie, forma_org, caen, den_caen, descriere_sediu_bun, nr_doc_autoriz, data_doc_autoriz, nr_doc_asociere, data_doc_asociere, data_incep, data_sf, data_suspendare, nr_zile_scutite, venit_brut, chelt_deduc, pierdere, venit_net_anual, pierdere_precedenta, pierdere_compensata, venit_recalculat, venit_redus, impozit11, impozit_retinut`.

Values for 1016 / individual / resident:

| attribute | value |
|---|---|
| `scutire`, `reg` | **omitted for residents**. They are only set to "0"/"1" when `nerezident_c=="1"`, and removed when switching back (L11098-11112). The 2025 struct required them whenever cap11 existed. |
| `categ_venit` | "1016" |
| `den_venit` | **new**: the category label from module 68937, verbatim, `"Activități independente in Sistem Real "`. It has a **trailing space**, "ă" is U+0103 and "ț" is U+021B (comma-below). |
| `det_ven_net` | "1" (H(): 1016, 1004, 1006, 1009, 1010, 1011 give "1"; 1015 gives "2"; 1003 gives "1"; 10031 gives "2"; 1012 and 1021-1024 have none) |
| `tip_chirie` | omitted (rentals only) |
| `forma_org` | "1". The options are 1 Individual, 2 Asociere fără personalitate juridică, 3 Entități transparență fiscală, 4 "Modificarea modalității/forme(i) de exercitare a activității" (4 is offered **only for 1016**, and 3 is not offered for 1003/10031/1009/1010/1011/1026). |
| `mod_forma_org` | **never emitted**. In 2025 it was a separate attribute; in 2026 it appears replaced by `forma_org="4"` (inference). |
| `caen` | 4-digit code from the CAEN list (year 2025 names override 2008 names) |
| `den_caen` | **new**: the CAEN denumire, trimmed |
| `descriere_sediu_bun` | `sediu`, trimmed, max 200 in the UI |
| `nr_doc_autoriz` | `doc_autorizare`, trimmed, max 120 in the UI |
| `data_doc_autoriz` | `dd.MM.yyyy` (date-fns format) |
| `nr_doc_asociere`, `data_doc_asociere` | **new**, only for forma_org 2 or 3; omitted for us |
| `data_incep`, `data_sf`, `data_suspendare` (**new**) | `dd.MM.yyyy`, optional. The start-date picker has min 2025-01-01. |
| `nr_zile_scutite` | `nr_zile`. "" or "0" gives omitted. |
| `venit_brut` | `rd1_venit_brut` as typed. The input is truncated to 2 decimals; it is **not rounded**. |
| `chelt_deduc` | `rd2_chelt_deduct` as typed (same) |
| `venit_net_anual` | `rd3_venit_net` = `rD(Math.max(0,brut-chelt))`, written when ≥ 0 and there is no loss. It is not rounded, so float artefacts such as `"499.90000000000003"` are possible if decimals are typed. |
| `pierdere` | `rd4_pierdere_anuala` = `String(chelt-brut)` if > 0; then `venit_net_anual` is omitted |
| `pierdere_precedenta` | `rd5_pierderi_reportate`, user entry; omitted if empty |
| `pierdere_compensata` | `rD(Math.round(Math.min(rd5, .7*net)))`, i.e. **"0"** when there are no previous losses (still written). Note the 70% cap. |
| `venit_recalculat` | `rd7_venit_impozabil` = `rD(Math.round(Math.max(0, net - pierdere_compensata)))` |
| `venit_redus` | `rd8` = "" for 1016, omitted |
| `impozit11` | **NOT emitted for 1016 (or 1003)**. For 1016 `rd9` is forced to 0 (`["1016","1003"].includes(...)&&(N=0)`) and the tax lives only in Section 4. This is an answer to question 4. |
| `impozit_retinut` | **new**: the "11. Impozit reținut" field, shown for 1016, 1021, and 1003 with reg=1. User entry, omitted if empty. It feeds `oblimpoz_real_anticipat`. |

---

## 4. `oblig_estimat` (Chapter II, CASS option 2026), L949-L964

```js
eO=(g=!!C?.showOptiuneCass,h=!!C?.showPersoaneIntretinere,b=C?.optiune??{},x=C?.sectiunea3??{},Object.values(j={
 bifa_optiune:g?"1":void 0,situatie_optiune:b?.opt,baza_optiune:b?.baza_cass,cass_optiune:b?.cass_datorata,
 bifa_optiune_coasigurat:h?"1":void 0,totalCassDatorat:x?.rd3,totalCassDatoratCoasigurat:x?.rd2
}).some(e=>null!=e&&""!==String(e).trim())?V("oblig_estimat",j):"")
```

Order: `bifa_optiune, situatie_optiune, baza_optiune, cass_optiune, bifa_optiune_coasigurat, totalCassDatorat, totalCassDatoratCoasigurat`.

| attribute | source |
|---|---|
| `bifa_optiune` | "1" when the "CASS prin opțiune (estimat 2026)" toggle is on, otherwise omitted |
| `situatie_optiune` | a letter: "A", "B", "C", "D", "E" or "F" (same meaning as in 2025) |
| `baza_optiune` | default `nx(6*nb("4050"))` = **"24300"**. It is editable (`readOnly` only when `bifa=="1"`, which never happens). `nx` = `Math.round(100*x)/100`, so it can have 2 decimals. |
| `cass_optiune` | `nx(.1*baza)`, i.e. **"2430"** |
| `bifa_optiune_coasigurat` | "1" if the "Persoane în întreținere" toggle is on |
| `totalCassDatorat` | `sectiunea3.rd3` = `Math.round(cass_optiune + Σ coasigurat cass)`, i.e. "2430" |
| `totalCassDatoratCoasigurat` | `sectiunea3.rd2` = `Math.round(Σ coasigurat cass)`. This is **"0"** with no dependants, and it is still written (nG(0) gives "0"). |

`coasigurat` (0..3) attributes in order: `tipCoasigurat` (1 = spouse, 2 = parent), `numeCoasigurat` (`nume + " " + prenume`), `cnpCoasigurat`, `bazaCassCoasigurat` (default `nw(6*4050)` = "24300"), `cassDatoratCoasigurat` (`nw(0.1*baza)` = "2430").

When both toggles are off, `optiune`, `sectiunea3` and `persoaneIntretinere` are removed and there is no `oblig_estimat`.

---

## 5. Constants (all inline `Number("4050")`; there is no identifier `salMin`)

| constant | where | value |
|---|---|---|
| SM for 2025 income (CAS) | `np=Number.isFinite(x=Number("4050"))&&x>0?x:1` (L12948) | 4050. Thresholds `12*np` = 48600 and `24*np` = 97200; base minimum 48600 or 97200; rate 25%. |
| SM for 2025 income (CASS) | `rQ=Number("4050")\|\|0` (L12253) | 6×SM = **24300** minimum base, 60×SM = **243000** cap (`n=i>0?60*i:1/0`), rate 10%. The 2.2 thresholds are 6/12/24 SM (24300 / 48600 / 97200). The art.180 entry must equal `Math.round(.1*6*e)` = 2430. |
| SM in Section 4.2 | `tw=Number("4050")` (L4498) | `rd5_cass_baza_174` only when total ≤ `6*tw` = 24300 |
| SM for the 2026 option | `o=nb("4050"),c=...6*o` (L13371) | the **same 4050**, so base 24300 and CASS 2430 |
| Coasigurat | `l=nw(6*Number("4050"))` (L13517) | 24300 / 2430 |
| Section 6 trigger | `nk(d21.rd6_cass_retinuta_174_10)>24300` (L13997) | 24300, hard-coded |
| Stopaj tip 2 minimum | `g=Number("4050"),h=60*g` (L11832) | 243000 |
| Bonus | `Math.round(.03*e)` | 3% |
| Tax rate | `.1*` | 10% |

Rounding helpers:

| helper | definition / effect |
|---|---|
| `ty`/`nc`/`r2`/`nm`/`n$`/`tJ` | `String(Math.round(x))` (tJ returns "0" for NaN) |
| `tA` | `e=>Math.round(1e4*e)/1e4`, 4 dp, used for the 4.1/4.2 pondere |
| `tC` | `e=>e.toFixed(5)`, printed with 5 decimals |
| Section 5 (1003) | in contrast, uses `l.toFixed(5)` without the 4-dp step (L5087+) |
| `nx`/`nw` | `Math.round(100*x)/100` (Chapter II and coasigurat) |
| Inputs | the decimal comma becomes ".", and the value is **truncated** (not rounded) to 2 decimals (`tO`/`r0`) |
| Loss carry-forward | `Math.round(Math.min(rd5, .7*net))` |

The 2025 struct says the pondere is rounded "la 5 zecimale"; the 2026 JS rounds to 4 and prints 5.

---

## 6. Worked example (hand-derived from the formulas above, not executed)

Inputs: 1016 individual, brut 150000, chelt 30000, CAS base entered as 97200, no withholding, no option, no bonus, `statut` not chosen. Derived values:

| step | values |
|---|---|
| Net and recalculated income | rd3 = 120000, rd7 = 120000, pierdere_compensata = 0 |
| CAS | venit_total = 120000 ≥ 97200, so bifa_plafon = "2"; cas = 24300 |
| CASS | base = min(120000, 243000) = 120000, so CASS = 12000 |
| Section 4.1 / 4.2 | pondere = "1.00000"; CAS deductible = 24300; CASS deductible = 12000 |
| Section 4 | taxable = 120000 − 24300 − 12000 = 83700; tax = 8370 |
| Section 7 | dif_de_plata = 8370 + 24300 + 12000 = 44670 |

```xml
<d212 an_r="2026" luna_r="12" d_rec="0" rectif1="0" rectif2="0" totalPlata_A="<digit sum of CNP>" bifa_conformare="0" bifa18="0" bifa19="0" bifa23="0" anulare_litA="0" anulare_litB="0" bifa111="1" bifa112="0" bifa14="1" bifa113="0" bifa121="0" bifa15="0" bifa122="0" bifa131="1" bifa132="1" nume_c="..." initiala_c="..." prenume_c="..." cif="..." cont_bancar="..." email_c="..." nerezident="0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="mfp:anaf:dgti:d212:declaratie:v11" xmlns="mfp:anaf:dgti:d212:declaratie:v11">
<oblig_realizat cas_total_ven="120000" cas_baza="97200" cas_datorat="24300" cas_retinut_platitor="0" cas_dif_plus="24300" bifa_cas_real="2" bifa_cas_recalculat="0" bifa_cas_sub_plafon="0" cass_total_ven_ai="120000" baza_cass_datorat_ai="120000" cass_anuala_ai="12000" cass_datorat_art180_ai="0" cass_datorat_ai="12000" cass_retinut_platitor_alin6_ai="0" cass_dif_plus_ai="12000" cass_dif_minus6_ai="0" bifa_cass_datorat_dpi="0" bifa_cass_datorat_ai="1" real_venit_net_recalculat_ai="120000" real_cas-deduc_ai="24300" real_cass-deductibil_ai="12000" real_venit_net_impozabil_ai="83700" real_impozit_datorat_ai="8370" real_cas_venit_net_ai="120000" real_cas_total_ven_ai="120000" real_cas_pondere_ai="1.00000" real_cas_datorata_ai="24300" real_cas_deductibila_ai="24300" real_cass_venit_net_ai="120000" real_cass_total_ven_ai="120000" real_cass_pondere_ai="1.00000" real_cass_datorata_ai="12000" real_cass_deductibila_ai="12000" oblimpoz_real_total="8370" oblimpoz_real_dif_deplata="8370" oblimpoz_real_dif_restituit="0" oblcas_real_difPlus="24300" oblcas_real_str="0" oblcass_real_difPlus_ai="12000" oblcass_real_difMinus_ai="0" oblcass_real_str="0" oblcass_real_str_pensie="0" impozit_venit_plus="8370" impozit_venit_minus="0" cas_plus="24300" cass_plus="12000" cass_minus="0" dif_de_plata="44670" dif_de_restituit="0" />
<cap11 categ_venit="1016" den_venit="Activități independente in Sistem Real " det_ven_net="1" forma_org="1" caen="NNNN" den_caen="..." descriere_sediu_bun="..." nr_doc_autoriz="..." data_doc_autoriz="dd.mm.yyyy" venit_brut="150000" chelt_deduc="30000" venit_net_anual="120000" pierdere_compensata="0" venit_recalculat="120000" />
</d212>
```

Variants:

- With the bonus toggle on: `bifa18="1"` and `oblimpozit_real_bonif="251"` as the first attribute of `oblig_realizat` (round(0.03 × 8370) = 251).
- With the option on: `<oblig_estimat bifa_optiune="1" situatie_optiune="X" baza_optiune="24300" cass_optiune="2430" totalCassDatorat="2430" totalCassDatoratCoasigurat="0" />` after `oblig_realizat`.

---

## 7. Differences versus the 2025 structure (struct.txt, D212_A1.0.3, v11)

Same namespace v11; `an_r` 2025 becomes 2026.

**Root**

| change | items |
|---|---|
| New | `bifa19` (cap19, foreign pension CASS); `bifa23` (cap23, 10091 agricultural norm); `initiala_c` and `prenume_c` (2025 had a single `nume_c` "Nume/Inițiala/Prenume"); `den_stat_rezidenta`; `statut` |
| Gone | `bifa_succesor` (was 1..1) and `cif_succesor` |
| Changed rule | `bifa14` no longer requires `impozit11>0` |
| Optionality | `adresa_c` (1..1 in 2025) is in practice omitted, because this UI cannot fill it |

**oblig_realizat**

| change | items |
|---|---|
| New | `cass_anuala_ai`, `cass_datorat_art180_ai`, `cass_anuala`, `cass_datorat_art180`, `cass_dif_minus`, `bifa_cas_recalculat`, `bifa_cas_sub_plafon`, `oblcass_real_difMinus_dpi`, `oblcass_real_str_pensie`, `cass_ret_{dpi,asc,cfb,inv,asp,alt,ai}`, `cas_ret_*`, `venit_ret_*` |
| Gone | `cass_retinut_platitor_alin7_ai`, `cass_dif_minus8_ai`, `oblcas_real_bonif`, `oblcass_real_bonif` |
| Value-domain changes | `bifa_cas_real` can be "0"; zero amounts are written as "0" instead of null (`oblimpoz_real_dif_*`, `dif_de_plata`/`dif_de_restituit`, `cas_retinut_platitor`, `cass_dif_minus6_ai`, ...); pondere is 4-dp rounded and printed with 5 decimals; `oblcass_real_difMinus_174` now comes from d22 rd8, not from cass_dif_minus8_ai |

**cap11**

| change | items |
|---|---|
| New | `den_venit`, `den_caen`, `tip_chirie`, `nr_doc_asociere`, `data_doc_asociere`, `data_suspendare`, `impozit_retinut` |
| Gone | `mod_forma_org` (forma_org gains value 4 for 1016) |
| Changed | `impozit11` is no longer emitted for 1016/1003; `scutire`/`reg` are omitted for residents |

**oblig_estimat**: the attributes are unchanged. **coasigurat**: unchanged. New child elements: `cap19` (+`cap19_luna`) and `cap23` (+`produse`).

---

## UNKNOWN / not determinable from these files

- The server-side validator rules (`actionValidare`), including whether it accepts the omitted `adresa_c`/`scutire`/`reg`, the hyphenated keys, the "0" values, or the trailing space in `den_venit`.
- The SPV pre-completion route (which may fill `adresa_c` / `dateIdentificare`): its chunk is not among the downloaded files.
- Whether ANAF will change SM=4050 for the 2026 option (the JS hard-codes 4050).
