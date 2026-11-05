import type { Clause, LegalSource } from './index';

/*
 * The sources of the payroll extras (W1): benefits in kind, the other medical-leave codes, payroll
 * corrections, garnishments, the administrator's mandate, REGES-ONLINE and the vouchers. Kept apart
 * from the register's main list, which spreads them in.
 *
 * What could be read in an official copy is `located`, with the copy's hash. The legislative
 * portal (legislatie.just.ro) refuses automated requests, so the consolidated acts were downloaded
 * by the owner: OUG nr. 158/2005 (01.07.2026), the Codul muncii (27.04.2026) and the Codul de
 * procedură civilă (14.12.2025), registered in the main list, and HG nr. 295/2025, Legea nr.
 * 165/2018 (01.12.2025) and Legea nr. 346/2002 (work accidents and occupational diseases,
 * 11.11.2024), here.
 */

const CF = 'ANAF/Cod-fiscal-consolidat';
const NORMS = 'ANAF/OMS15-2018';
const BRASOV = 'ANAF/Brasov-OUG158-2025';
const LABOUR = 'L53/2003-A';
const CPC = 'L134/2010-A';
const OUG158 = 'OUG158/2005-A';
const REGES = 'HG295/2025-A';
const VOUCHERS = 'L165/2018-A';
const ACCIDENTS = 'L346/2002-A';

export const payrollSources: readonly LegalSource[] = [
  {
    id: NORMS,
    kind: 'official_document',
    title:
      'Ordinul ministrului sănătății și al președintelui CNAS nr. 15/2018/1.311/2017 pentru aprobarea Normelor de aplicare a OUG nr. 158/2005 (textul inițial, publicat de ANAF; modificările din 2026 nu sunt verificate)',
    issuer: 'Ministerul Sănătății și Casa Națională de Asigurări de Sănătate',
    publication: 'Monitorul Oficial nr. 31 din 12 ianuarie 2018',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OMS_15_2018.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OMS_15_2018.pdf',
        sha256: 'd12fcbf7b90f798b79224100b56c2836131ccd6018ac61e24eb0cea05ddb4062',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: BRASOV,
    kind: 'official_document',
    title:
      'ANAF, DGRFP Brașov: Modificări aduse OUG nr. 158/2005 prin Legea nr. 141/2025, în vigoare de la 1 august 2025 (material informativ din 28.07.2025, cu textul art. 17 alin. (1) și (1^1) înainte și după modificare)',
    issuer: 'ANAF',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/Brasov/Brasov/concedii_2025.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Brasov/Brasov/concedii_2025.pdf',
        sha256: '45533d358283af2567a9ee0731b9fd52b849d506eb66d10cfb974d8a41a40173',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ITM/REGES-2026',
    kind: 'official_document',
    title:
      'Inspecția Muncii, ITM Botoșani: comunicatul nr. 1181/CRCRP din 17.02.2026 privind obligația angajatorilor de a se înrola în REGES-ONLINE (HG nr. 295/2025, Ordinul MMFTSS nr. 1107/2025)',
    issuer: 'Inspecția Muncii',
    publication: null,
    urls: [
      'https://www.inspectiamuncii.ro/documents/521316/523496/20260217_COMUNICAT+REGES.pdf/9976e57a-dc57-477c-a4fa-0849a023d54b',
    ],
    fetch: true,
    snapshots: [
      {
        url: 'https://www.inspectiamuncii.ro/documents/521316/523496/20260217_COMUNICAT+REGES.pdf/9976e57a-dc57-477c-a4fa-0849a023d54b',
        sha256: '59b3fac10754cb274a0d85baff80e48a514bc12e90a6de9bf2c39d380c77c3d9',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
  // The acts as the legislative portal consolidates them, downloaded by the owner (the portal
  // refuses automated requests). Kept in .sources/HG295_2025-A/, .sources/L165_2018-A/ and
  // .sources/L346_2002-A/.
  {
    id: 'HG295/2025-A',
    kind: 'act',
    title:
      'Hotărârea Guvernului nr. 295/2025 privind Registrul general de evidență a salariaților – REGES-ONLINE (forma consolidată a portalului legislativ, cu termenele prelungite prin OUG nr. 46/2025, Monitorul Oficial nr. 863 din 19 septembrie 2025)',
    issuer: 'Guvernul României',
    publication: 'Monitorul Oficial nr. 279 din 31 martie 2025',
    urls: ['https://legislatie.just.ro/Public/DetaliiDocument/295995'],
    fetch: false,
    snapshots: [
      {
        url: 'https://xfactura.invalid/owner-download/HOTARARE_A_295_27_03_2025.pdf',
        sha256: '4a8b0b28973042320b527cd3ede75cf063df9303c0e4438f4c9ecd46d7a06821',
        retrievedOn: '2026-11-06',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'L165/2018-A',
    kind: 'act',
    title:
      'Legea nr. 165/2018 privind acordarea biletelor de valoare (forma consolidată a portalului legislativ, actualizată până la 01.12.2025)',
    issuer: 'Parlamentul României',
    publication: 'Monitorul Oficial nr. 599 din 13 iulie 2018',
    urls: ['https://legislatie.just.ro/Public/DetaliiDocument/202627'],
    fetch: false,
    snapshots: [
      {
        url: 'https://xfactura.invalid/owner-download/LEGE_A_165_10_07_2018.pdf',
        sha256: '1c317221d4a9f56cb6a5b73ec8f2c6d237388aa0d7eb74a8ed123d0d6d856199',
        retrievedOn: '2026-11-06',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'L346/2002-A',
    kind: 'act',
    title:
      'Legea nr. 346/2002 privind asigurarea pentru accidente de muncă și boli profesionale, republicată (forma consolidată a portalului legislativ, actualizată până la 11.11.2024)',
    issuer: 'Parlamentul României',
    publication: 'Monitorul Oficial nr. 251 din 8 aprilie 2014 (republicare)',
    urls: ['https://legislatie.just.ro/Public/DetaliiDocument/36495'],
    fetch: false,
    snapshots: [
      {
        url: 'https://xfactura.invalid/owner-download/LEGE_A_346_05_06_2002.pdf',
        sha256: '5fa17ae3fa5af8ac17e8f04086db594a7ac46d4c933ac05fcdfeaf38d3353686',
        retrievedOn: '2026-11-06',
        mediaType: 'application/pdf',
      },
    ],
  },
];

const located = (id: string, source: string, locator: string, summary: string): Clause => ({
  id,
  source,
  locator,
  status: 'located',
  summary,
});

export const payrollClauses: readonly Clause[] = [
  // Benefits in kind.
  located(
    `${CF}:art.76(3)(a)`,
    CF,
    'art. 76 alin. (3) lit. a)',
    'Avantaj: folosirea în scop personal a oricărui bun, inclusiv a unui vehicul, din patrimoniul afacerii sau închiriat de la un terț, în afara deplasării dus-întors domiciliu–loc de muncă.',
  ),
  located(
    `${CF}:art.76(3)(b)`,
    CF,
    'art. 76 alin. (3) lit. b)',
    'Avantaj: cazare, hrană, îmbrăcăminte și alte bunuri sau servicii oferite gratuit ori sub prețul pieței, peste limitele alin. (4^1) lit. b) și c).',
  ),
  located(
    `${CF}:art.76(3)(g)`,
    CF,
    'art. 76 alin. (3) lit. g)',
    'Avantaj: primele de asigurare și serviciile medicale sub formă de abonament plătite de suportator, la momentul plății, altele decât cele obligatorii și cele din alin. (4^1) lit. f).',
  ),
  located(
    `${CF}:art.76(2)(s)`,
    CF,
    'art. 76 alin. (2) lit. s)',
    'Sunt asimilate salariilor orice alte sume sau avantaje în bani ori în natură.',
  ),
  located(
    `${CF}:art.76(3)`,
    CF,
    'art. 76 alin. (3)',
    'Avantajele în bani sau în natură primite în legătură cu activitatea, inclusiv de la terți, sunt venituri din salarii, cu excepția celor de la alin. (4).',
  ),
  located(
    `${CF}:art.76(4)(a)`,
    CF,
    'art. 76 alin. (4) lit. a)',
    'Nu sunt impozabile cadourile în bani sau în natură, inclusiv tichetele cadou, oferite salariaților și copiilor lor minori de Paști, Crăciun și sărbătorile similare, de 8 martie și de 1 iunie, până la 300 lei de persoană și ocazie.',
  ),
  located(
    `${CF}:art.76(4)(ț)`,
    CF,
    'art. 76 alin. (4) lit. ț)',
    'Nu sunt impozabile avantajele folosirii în scop personal a vehiculelor ale căror cheltuieli sunt deductibile 50% (art. 25 alin. (3) lit. l), art. 68 alin. (7) lit. k)).',
  ),
  located(
    `${CF}:art.76(4)(ț1)`,
    CF,
    'art. 76 alin. (4) lit. ț^1)',
    'Nu sunt impozabile avantajele folosirii în scop personal a vehiculelor de la art. 25 alin. (3) lit. l) nefolosite exclusiv în scopul activității, ale microîntreprinderilor.',
  ),
  located(
    `${CF}:art.76(4^1)`,
    CF,
    'art. 76 alin. (4^1) și (4^2)',
    'Veniturile de la lit. a)–j) nu sunt impozabile, cumulat lunar, până la 33% din salariul de bază; ordinea în care intră în plafon o stabilește angajatorul.',
  ),
  located(
    `${CF}:art.76(4^1)(c)`,
    CF,
    'art. 76 alin. (4^1) lit. c)',
    'Cazarea și chiria spațiilor puse de angajator la dispoziția salariaților, până la 20% din salariul minim pe lună și persoană, dacă salariatul nu deține locuință în localitate, spațiul este propriu sau închiriat legal și plafonul se acordă unuia dintre soți.',
  ),
  located(
    `${CF}:art.76(4^1)(f)`,
    CF,
    'art. 76 alin. (4^1) lit. f)',
    'Primele de asigurare voluntară de sănătate și serviciile medicale sub formă de abonament suportate de angajator, până la 400 euro pe an și persoană.',
  ),
  located(
    `${CF}:art.76(10)`,
    CF,
    'art. 76 alin. (10)',
    'Primele de asigurare voluntară de sănătate din alin. (4^1) lit. f) sunt venituri ale lunilor pentru care s-a efectuat plata.',
  ),
  located(
    `${CF}:norme.art.76.pct.12(5)`,
    CF,
    'normele metodologice, pct. 12 alin. (4)–(5)',
    'Avantajele în natură se evaluează la prețul pieței; folosința gratuită a vehiculului: 1,7% pe lună din valoarea de intrare, sau chiria când e închiriat de la un terț; a locuinței: chiria pentru suprafețele deținute de stat, cu cheltuielile conexe la valoarea efectivă.',
  ),
  located(
    `${CF}:norme.art.76.pct.12(6)`,
    CF,
    'normele metodologice, pct. 12 alin. (6) și (9)',
    'La folosința mixtă a vehiculului, avantajul este proporțional cu kilometrii parcurși în interes personal; deplasarea domiciliu–loc de muncă și sarcinile de serviciu nu se iau în calcul.',
  ),
  located(
    `${CF}:art.142(b)`,
    CF,
    'art. 142 lit. b)',
    'Nu intră în baza CAS cadourile oferite salariaților și copiilor minori la ocaziile de la art. 76 alin. (4) lit. a), până la 300 lei de persoană și ocazie.',
  ),
  located(
    `${CF}:art.142(s)`,
    CF,
    'art. 142 lit. s) pct. 1 și 7, lit. aa^1)',
    'Nu intră în baza CAS folosirea în scop personal a vehiculelor deductibile 50% sau, la microîntreprinderi, nefolosite exclusiv în activitate, nici veniturile art. 76 alin. (4^1) în limitele lor.',
  ),
  // Meal and holiday vouchers (Legea nr. 165/2018, consolidated on 1 December 2025).
  located(
    `${VOUCHERS}:art.12(2)`,
    VOUCHERS,
    'art. 11 alin. (1) și art. 12 alin. (2)',
    'Tichetele de masă se acordă lunar, ca alocație individuală de hrană; salariatul poate utiliza lunar un număr de tichete de masă cel mult egal cu numărul de zile lucrate.',
  ),
  located(
    `${VOUCHERS}:art.14`,
    VOUCHERS,
    'art. 14 și nota: Legea nr. 201/2025 art. II',
    'Valoarea nominală a unui tichet de masă nu poate depăși 45 de lei, de la drepturile lunii noiembrie 2025; prin derogare de la indexarea art. 32, valoarea se aplică și în semestrul I al anului 2026 și în iulie, august și septembrie 2026.',
  ),
  located(
    `${VOUCHERS}:art.24(3)`,
    VOUCHERS,
    'art. 24 alin. (1), (3) și (4)',
    'Voucherele de vacanță acoperă cheltuielile concediului de odihnă în turismul intern; unui angajat i se pot acorda într-un an fiscal cel mult 6 salarii de bază minime brute pe țară, în cel mult două tranșe.',
  ),
  located(
    `${VOUCHERS}:art.32`,
    VOUCHERS,
    'art. 32',
    'Valoarea nominală maximă a biletelor de valoare se indexează semestrial, prin ordin comun al ministrului finanțelor și al ministrului de resort (tichetele de masă cu indicele prețurilor mărfurilor alimentare); o valoare indexată mai mică decât ultima rămâne nemodificată.',
  ),
  // The other medical-leave codes, in the consolidated OUG nr. 158/2005 (01.07.2026).
  located(
    `${OUG158}:art.2(1)`,
    OUG158,
    'art. 2 alin. (1)',
    'Concediile și indemnizațiile: a) incapacitate temporară de muncă din boli obișnuite sau accidente în afara muncii; b) prevenirea îmbolnăvirilor și recuperarea capacității de muncă; c) maternitate; d) îngrijirea copilului bolnav; d^1) îngrijirea pacientului cu afecțiuni oncologice; e) risc maternal.',
  ),
  located(
    `${OUG158}:art.17(1^1)`,
    OUG158,
    'art. 17 alin. (1^1)',
    'Pentru bolile cardiovasculare stabilite în condițiile art. 13 alin. (3) lit. a), indemnizația pentru incapacitate temporară de muncă este 75% din baza de calcul stabilită conform art. 10.',
  ),
  located(
    `${OUG158}:art.17(2)`,
    OUG158,
    'art. 17 alin. (2)',
    'Indemnizația pentru incapacitate temporară de muncă determinată de tuberculoză, SIDA, neoplazii, bolile infectocontagioase din grupa A, urgențe medico-chirurgicale și unele tipuri de arsuri, inclusiv recuperarea, este 100% din baza de calcul stabilită conform art. 10.',
  ),
  located(
    `${OUG158}:art.20(3)`,
    OUG158,
    'art. 20 alin. (3)',
    'Indemnizația pentru carantină sau izolare este 100% din baza de calcul stabilită conform art. 10 și se suportă integral din FNUASS.',
  ),
  located(
    `${OUG158}:art.22`,
    OUG158,
    'art. 22 alin. (1) și (1^1)',
    'Indemnizațiile pentru reducerea timpului de muncă și pentru carantină se suportă integral din FNUASS; carantina instituită la întoarcerea dintr-o deplasare în interes personal într-o zonă cu epidemie se suportă din FNUASS pentru 5 zile.',
  ),
  located(
    `${OUG158}:art.25`,
    OUG158,
    'art. 23 alin. (1) și art. 25',
    'Concediul pentru sarcină și lăuzie este de 126 de zile calendaristice; indemnizația de maternitate este 85% din baza de calcul stabilită conform art. 10 și se suportă integral din FNUASS.',
  ),
  located(
    `${OUG158}:art.26`,
    OUG158,
    'art. 26 alin. (1), (1^1), (1^4) și (2)',
    'Concediul pentru îngrijirea copilului bolnav se acordă până la 12 ani (18 pentru copilul cu handicap, pentru afecțiunile intercurente, și pentru copilul cu afecțiuni grave), iar cel pentru supravegherea copilului în carantină sau izolare până la 18 ani; indemnizațiile de îngrijire a copilului bolnav se suportă integral din FNUASS.',
  ),
  located(
    `${OUG158}:art.30`,
    OUG158,
    'art. 30 alin. (1)–(2)',
    'Indemnizația pentru îngrijirea copilului bolnav (art. 26 alin. (1) și (1^1)) este 85% din baza de calcul stabilită conform art. 10; cea pentru supravegherea copilului în carantină sau izolare (alin. (1^4)) este 100% și se suportă integral din FNUASS.',
  ),
  located(
    `${OUG158}:art.30^3`,
    OUG158,
    'art. 30^3 alin. (1)–(2)',
    'Indemnizația pentru îngrijirea pacientului cu afecțiuni oncologice este 85% din baza de calcul stabilită conform art. 10 și se suportă integral din FNUASS.',
  ),
  located(
    `${OUG158}:art.31`,
    OUG158,
    'art. 31 alin. (2)–(4)',
    'Indemnizația de risc maternal se suportă integral din FNUASS, fără condiție de stagiu, și este 75% din baza de calcul stabilită conform art. 10.',
  ),
  // Work accidents and occupational diseases (Legea nr. 346/2002, consolidated on 11.11.2024).
  located(
    `${ACCIDENTS}:art.19`,
    ACCIDENTS,
    'art. 19 alin. (1)–(4), (6)–(7)',
    'Baza de calcul al indemnizației pentru incapacitate temporară de muncă este media veniturilor brute din salarii sau asimilate salariilor realizate lunar la angajator în ultimele 6 luni anterioare lunii concediului, fără veniturile de la alți angajatori (sub 6 luni de stagiu, media lunilor realizate; sub o lună, câștigul primei luni); se folosesc zilele lucrătoare ale lunii concediului; angajatorul calculează și plătește indemnizațiile și le recuperează de la casa teritorială de pensii după confirmarea caracterului de muncă al accidentului sau declararea bolii profesionale.',
  ),
  located(
    `${ACCIDENTS}:art.33`,
    ACCIDENTS,
    'art. 32–33 și 36^1',
    'Indemnizația pentru incapacitate temporară de muncă după un accident de muncă sau o boală profesională este 80% din media veniturilor salariale brute din ultimele 6 luni anterioare manifestării riscului, 100% pentru urgențele medico-chirurgicale și pentru arsurile grave ale art. 36^1; certificatul se vizează la direcția de sănătate publică și la casa de pensii; sumele plătite înainte de confirmare și diferențele se recuperează de la casa de pensii, indiferent de codul de indemnizație.',
  ),
  located(
    `${ACCIDENTS}:art.34`,
    ACCIDENTS,
    'art. 34',
    'Indemnizația pentru incapacitate temporară de muncă din accident de muncă sau boală profesională se suportă de angajator în primele 3 zile de incapacitate și din a 4-a zi din sumele asigurării pentru accidente de muncă și boli profesionale din bugetul asigurărilor sociale de stat.',
  ),
  located(
    `${CF}:art.141(a)`,
    CF,
    'art. 141 lit. a)',
    'Se exceptează de la plata contribuțiilor de asigurări sociale prestațiile suportate din bugetul asigurărilor sociale de stat, potrivit legii.',
  ),
  located(
    `${CF}:norme.art.141.pct.41`,
    CF,
    'normele metodologice, titlul V, pct. 41 alin. (1)',
    'Prestațiile suportate din bugetul asigurărilor sociale de stat, exceptate de la CAS potrivit art. 141 lit. a), cuprind și indemnizațiile pentru incapacitate temporară de muncă acordate în baza Legii nr. 346/2002.',
  ),
  located(
    'ANAF/D112-0726:accidente',
    'ANAF/D112-0726',
    'secțiunea B3 (B3_4, B3_8–B3_11), C3 rd. 1 și 5, C1_7 și observația la D_9',
    'Accidentul de muncă confirmat de casa de pensii nu se declară în secțiunea D: zilele lucrătoare de concediu (B3_8), zilele și suma suportate din bugetul asigurărilor sociale (B3_4, B3_9), suma suportată de angajator pentru primele 3 zile (B3_10) și totalul (B3_11) se declară în B3, cazurile, zilele și sumele în C3, iar suma de recuperat de la casele de pensii în C1_7; codurile 02–04 ale secțiunii D sunt pentru accidentele neconfirmate.',
  ),
  located(
    `${CF}:art.62(c)`,
    CF,
    'art. 62 lit. c)',
    'Nu sunt impozabile indemnizațiile pentru risc maternal, maternitate, creșterea copilului, îngrijirea copilului bolnav și îngrijirea pacientului cu afecțiuni oncologice.',
  ),
  located(
    `${CF}:art.155(1)(i)`,
    CF,
    'art. 155 alin. (1) lit. i) și art. 157 alin. (1) lit. v)',
    'CASS se datorează pe indemnizațiile de asigurări sociale de sănătate doar pentru codurile de indemnizație 01, 07 și 10.',
  ),
  located(
    `${NORMS}:art.31`,
    NORMS,
    'art. 30–31',
    'Indemnizația pentru incapacitate temporară de muncă se calculează potrivit art. 17 din OUG și se suportă potrivit art. 12, de angajator sau din FNUASS, pentru zilele lucrătoare ale concediului.',
  ),
  located(
    `${NORMS}:art.36-37`,
    NORMS,
    'art. 36–37',
    'Indemnizația pentru reducerea timpului de muncă și cea pentru carantină se suportă integral din FNUASS; cuantumul carantinei se determină potrivit art. 20 alin. (2) din OUG.',
  ),
  located(
    `${NORMS}:art.43-44`,
    NORMS,
    'art. 43–44',
    'Cuantumul indemnizației de maternitate se determină potrivit art. 25 alin. (1) din OUG; indemnizația se suportă integral din FNUASS.',
  ),
  located(
    `${NORMS}:art.47-48`,
    NORMS,
    'art. 47–48',
    'Cuantumul indemnizației pentru îngrijirea copilului bolnav se determină potrivit art. 30 din OUG; indemnizația se suportă integral din FNUASS.',
  ),
  located(
    `${NORMS}:art.51-52`,
    NORMS,
    'art. 51–53',
    'Cuantumul indemnizației de risc maternal se determină potrivit art. 31 alin. (4) din OUG; indemnizația se suportă integral din FNUASS, fără condiție de stagiu.',
  ),
  located(
    `${NORMS}:art.62`,
    NORMS,
    'art. 62 alin. (2), exemplul nr. 4',
    'Cuantumul indemnizației este media zilnică × procentul legal × zilele lucrătoare ale concediului; exemplul aplică 100% potrivit art. 17 alin. (2) din OUG și 75% potrivit art. 31 alin. (4) (risc maternal).',
  ),
  located(
    `${BRASOV}:art.17(1^1)`,
    BRASOV,
    'art. 17 alin. (1^1) din OUG nr. 158/2005, introdus prin Legea nr. 141/2025 art. IX',
    'Pentru bolile cardiovasculare stabilite în condițiile art. 13 alin. (3) lit. a), indemnizația pentru incapacitate temporară de muncă este 75% din baza de calcul.',
  ),
  located(
    'ANAF/D112-0726:exceptii-OUG91',
    'ANAF/D112-0726',
    'p. 5: OUG nr. 91/2025 și Legea nr. 64/2026, excepțiile de la diminuarea cu o zi',
    'Nu se scade o zi lucrătoare pentru certificatele de boală infectocontagioasă cu izolare (51), risc maternal (15), maternitate (08), îngrijirea pacientului oncologic (17), pacienții programelor naționale, spitalizare (D_10 = 2) și continuări; angajatorul suportă zilele 2–6, cu excepția izolării, iar FNUASS de a doua zi indemnizațiile suportate integral din fond.',
  ),
  located(
    'ANAF/D112-0726:sectiuneaD',
    'ANAF/D112-0726',
    'p. 58–62 și Nomenclatoarele 9–10 (p. 89)',
    'Codurile de indemnizație și grupele lor; D_20 = 0 pentru codurile 08, 09, 91, 92, 10, 15 și 17 (suportate doar din FNUASS); CNP-ul copilului pentru 09, 91, 92, al pacientului pentru 17; codul urgenței pentru 06 și al bolii infectocontagioase pentru 05 și 51; D_23 = RM pentru 15; D_28 doar pentru codul 01; accidentul de muncă confirmat de casa de pensii nu se declară în secțiunea D.',
  ),
  // Corrections.
  located(
    `${CF}:art.78(3)`,
    CF,
    'art. 78 alin. (3)–(4)',
    'Pentru salariile și diferențele de salarii stabilite pentru perioade anterioare, conform legii, impozitul se calculează și se reține la data plății, după regulile veniturilor în afara funcției de bază, și se plătește până la 25 a lunii următoare plății.',
  ),
  located(
    `${CF}:art.146(9^1)`,
    CF,
    'art. 146 alin. (9) și (9^1)',
    'Salariile sau diferențele de salarii stabilite prin hotărâri judecătorești sau prin lege, pentru perioade anterioare, se defalcă pe lunile la care se referă, cu cotele de CAS de atunci; contribuțiile se plătesc până la 25 a lunii următoare plății.',
  ),
  located(
    'OPANAF605/2026:anexa6.cap.II.pct.2',
    'OPANAF605/2026',
    'anexa nr. 6, cap. II pct. 2 (Rectificarea declarației)',
    'Declarația rectificativă corectează impozitul, contribuțiile, datele asiguraților și ale certificatelor medicale; se completează integral, cu toate datele, inclusiv cele neschimbate; caseta „Declarație rectificativă” se bifează pentru erori de completare ale angajatorului.',
  ),
  located(
    'OPANAF605/2026:anexa6.B',
    'OPANAF605/2026',
    'anexa nr. 6, secțiunea B rd. 4 și secțiunea C.1 rd. 6',
    'Fondul de salarii cuprinde indemnizațiile suportate de angajator, primele 5 zile pentru OUG nr. 158/2005 și primele 3 zile pentru Legea nr. 346/2002; restul indemnizațiilor de accidente de muncă se recuperează de la casele teritoriale de pensii.',
  ),
  // The administrator's mandate.
  located(
    `${CF}:art.76(2)(o)`,
    CF,
    'art. 76 alin. (2) lit. o)',
    'Remunerația administratorilor societăților, desemnați sau numiți potrivit legii, este venit asimilat salariilor.',
  ),
  located(
    `${CF}:art.139(1)(d)`,
    CF,
    'art. 139 alin. (1) lit. d) și alin. (4)',
    'Remunerația administratorilor intră în baza CAS, indiferent dacă sunt din cadrul entității, pensionari sau angajați cu contract de muncă.',
  ),
  located(
    `${CF}:art.157(1)(e)`,
    CF,
    'art. 157 alin. (1) lit. e)',
    'Remunerația administratorilor intră în baza CASS.',
  ),
  located(
    `${CF}:art.220^4(1)(d)`,
    CF,
    'art. 220^4 alin. (1) lit. d)',
    'Remunerația administratorilor intră în baza CAM.',
  ),
  located(
    `${CF}:art.78(2)(b)`,
    CF,
    'art. 78 alin. (2) lit. b)',
    'În afara funcției de bază, impozitul este 10% din venitul brut minus contribuțiile sociale obligatorii, pe fiecare loc de realizare.',
  ),
  located(
    `${CF}:norme.art.78.pct.14(9)`,
    CF,
    'normele metodologice, pct. 14 alin. (9)',
    'Funcția de bază este locul unde persoana are contractul individual de muncă „sau alte documente specifice, potrivit legii”; la mai mulți angajatori, cel declarat pe propria răspundere.',
  ),
  located(
    `${CF}:art.51(4)`,
    CF,
    'art. 51 alin. (4)',
    'Condiția salariatului microîntreprinderii: un contract individual de muncă cu normă întreagă, fracțiuni de normă însumând o normă, sau un contract de administrare sau mandat remunerat cel puțin cu salariul minim.',
  ),
  // Garnishments.
  located(
    `${CPC}:art.729`,
    CPC,
    'art. 729 și art. 730',
    'Salariile pot fi urmărite până la jumătate din venitul lunar net pentru obligații de întreținere sau alocație pentru copii și până la o treime pentru orice alte datorii; mai multe urmăriri asupra aceleiași sume nu pot depăși împreună jumătate, indiferent de natura creanțelor; veniturile mai mici decât salariul minim net pe economie se urmăresc doar asupra părții peste jumătatea lui; ajutoarele de incapacitate temporară doar pentru întreținere și despăgubiri, până la jumătate; ajutoarele de îngrijire a copilului bolnav și de maternitate deloc; urmărirea peste aceste limite este nulă de drept.',
  ),
  located(
    `${LABOUR}:art.169`,
    LABOUR,
    'art. 169',
    'Rețineri din salariu doar în cazurile legii; daunele aduse angajatorului doar pentru o datorie scadentă, lichidă și exigibilă constatată prin hotărâre judecătorească definitivă; la mai mulți creditori, ordinea: întreținere, contribuții și impozite către stat, daune aduse proprietății publice prin fapte ilicite, alte datorii; reținerile cumulate nu depășesc în fiecare lună jumătate din salariul net.',
  ),
  located(
    'L207/2015:art.236',
    'L207/2015',
    'art. 236 alin. (4) și (9) lit. a) (forma consolidată a portalului legislativ, 08.08.2026)',
    'Veniturile salariale ale unei persoane fizice se urmăresc de organul fiscal la plătitor numai în condițiile Codului de procedură civilă; terțul poprit virează suma reținută în 3 zile lucrătoare de la data la care creanța devine exigibilă.',
  ),
  // REGES-ONLINE.
  located(
    `${LABOUR}:art.16(2)`,
    LABOUR,
    'art. 16 alin. (2) și art. 34 alin. (1), (3) și (7)',
    'Anterior începerii activității, contractul individual de muncă se înregistrează în registrul general de evidență a salariaților, transmis inspectoratului teritorial de muncă cel târziu în ziua anterioară începerii activității; registrul cuprinde salariul, sporurile, suspendările, detașările și încetarea contractului, iar metodologia lui se stabilește prin hotărâre a Guvernului.',
  ),
  located(
    `${REGES}:art.4(2)`,
    REGES,
    'art. 4 alin. (2)',
    'Angajatorul transmite în Registru, între altele: datele salariatului (lit. b)), data încheierii contractului și a începerii activității (lit. d)), funcția (lit. e)), tipul și durata contractului (lit. f), g)), locul de muncă (lit. h)), durata și repartizarea timpului de muncă (lit. i)), salariul de bază, indemnizațiile și sporurile (lit. j)), suspendarea (lit. p)) și data și temeiul încetării (lit. q)).',
  ),
  located(
    `${REGES}:art.5(1)`,
    REGES,
    'art. 3 alin. (1)–(2) și art. 5 alin. (1)',
    'Datele contractului se transmit cel târziu în ziua anterioară începerii activității, în ordinea cronologică a încheierii, modificării, suspendării și încetării; transferul în 5 zile lucrătoare; suspendarea cel târziu în ziua anterioară (pentru certificatele medicale, absențe nemotivate și forță majoră în 3 zile lucrătoare); încetarea cel târziu la data încetării contractului sau la data luării la cunoștință a evenimentului care a determinat-o.',
  ),
  located(
    `${REGES}:art.5(2)-(4)`,
    REGES,
    'art. 5 alin. (2)–(4), (7) și (8)',
    'Modificarea datelor salariatului se transmite în 3 zile lucrătoare de la înregistrarea documentului; a funcției, tipului și duratei contractului, locului și timpului de muncă (lit. e)–i)) cel târziu în ziua anterioară producerii modificării; a salariului, indemnizațiilor și sporurilor (lit. j)) în 20 de zile lucrătoare de la producerea modificării; o modificare din hotărâre judecătorească în 10 zile lucrătoare de la luarea la cunoștință; corecția erorilor la data la care angajatorul a aflat de ele.',
  ),
  located(
    `${REGES}:art.15`,
    REGES,
    'art. 11 alin. (1)–(2), art. 15 și notele: OUG nr. 46/2025 art. IV',
    'Angajatorii se înregistrează în Registru și transmit contractele active, iar HG nr. 905/2017 (Revisal) se abrogă, în termenele prelungite până la 31 decembrie 2025.',
  ),
  located(
    'ITM/REGES-2026:comunicat',
    'ITM/REGES-2026',
    'comunicatul nr. 1181/CRCRP/17.02.2026',
    'Registrul este REGES-ONLINE, după HG nr. 295/2025 și Ordinul MMFTSS nr. 1107/2025; Revisal nu mai este disponibil din 1 ianuarie 2026.',
  ),
];
