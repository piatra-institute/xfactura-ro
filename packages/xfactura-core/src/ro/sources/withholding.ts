import type { Clause, LegalSource } from './index';

/*
 * The sources of withholding (O1): rent and intellectual property paid to individuals (Codul
 * fiscal art. 84^1, 72), interim dividends (Legea contabilității nr. 82/1991 art. 19, Legea
 * societăților nr. 31/1990 art. 67 as Legea nr. 163/2018 amended them, OMFP nr. 3.067/2018), the
 * tax on non-residents' income (art. 223–231) and the returns that declare it: D100's
 * nomenclature, D205 (the beneficiaries of residents' income) and D207 (non-residents'), and
 * ANAF's WHT codes of D406. Kept apart from the register's main list, which spreads them in.
 */

const legislation = 'https://static.anaf.ro/static/10/Anaf/legislatie';
const declarations = 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec';
const CODE = 'ANAF/Cod-fiscal-consolidat';

export const withholdingSources: readonly LegalSource[] = [
  {
    id: 'L163/2018',
    kind: 'act',
    title:
      'Legea nr. 163/2018 pentru modificarea și completarea Legii contabilității nr. 82/1991, modificarea și completarea Legii societăților nr. 31/1990, precum și modificarea Legii nr. 1/2005 (text publicat de ANAF)',
    issuer: 'Parlamentul României',
    publication: 'Monitorul Oficial nr. 595 din 12 iulie 2018',
    urls: [`${legislation}/L_163_2018.pdf`],
    fetch: true,
    snapshots: [
      {
        url: `${legislation}/L_163_2018.pdf`,
        sha256: '0abbe036541ac510c62a4f028f5f6044cb959c34d5d5b417835c32a92d3862d5',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OMFP3067/2018',
    kind: 'act',
    title:
      'Ordinul ministrului finanțelor publice nr. 3.067/2018 pentru completarea unor reglementări contabile (distribuirea de dividende în cursul exercițiului financiar; text publicat de ANAF)',
    issuer: 'Ministerul Finanțelor Publice',
    publication: 'Monitorul Oficial nr. 792 din 17 septembrie 2018',
    urls: [`${legislation}/OMFP_3067_2018.pdf`],
    fetch: true,
    snapshots: [
      {
        url: `${legislation}/OMFP_3067_2018.pdf`,
        sha256: 'e72fdcd766c7707ebe3f2916c930bb9fef80fb2c32f443564cfc8fa60c9f0fed',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/D100',
    kind: 'official_document',
    title:
      'Structura fișierului XML pentru declarațiile D100 și D710 (structura_D100-D710_0126_140926), cu nomenclatorul obligațiilor de plată',
    issuer: 'ANAF',
    publication: null,
    urls: [`${declarations}/structura_D100-D710_0126_140926.pdf`],
    fetch: true,
    snapshots: [
      {
        url: `${declarations}/structura_D100-D710_0126_140926.pdf`,
        sha256: 'e374389299342b5fbbd88ce8105b12b21d58f1d12586d5b18e1ea177553045a8',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/D205',
    kind: 'official_document',
    title:
      'Structura fișierului XML pentru declarația 205 (structura_D205_2025_120226, OPANAF nr. 102/2025), cu nomenclatorul naturii veniturilor',
    issuer: 'ANAF',
    publication: null,
    urls: [`${declarations}/structura_D205_2025_120226.pdf`],
    fetch: true,
    snapshots: [
      {
        url: `${declarations}/structura_D205_2025_120226.pdf`,
        sha256: 'ac971e3d865009194e31c491edc134f66e9f93c0021ccee4906534d2e295be92',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/D207',
    kind: 'official_document',
    title:
      'Structura fișierului XML pentru declarația 207 (structura_D207_2025_200226, OPANAF nr. 179/2022, anii de raportare din 2021), cu schema d207_20025020.xsd',
    issuer: 'ANAF',
    publication: null,
    urls: [`${declarations}/structura_D207_2025_200226.pdf`, `${declarations}/d207_20025020.xsd`],
    fetch: true,
    snapshots: [
      {
        url: `${declarations}/structura_D207_2025_200226.pdf`,
        sha256: '790b09dbf226ad95aaecd401fd8718bed8bea0927c94acb3d497cc01cb7a5e0d',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
      {
        url: `${declarations}/d207_20025020.xsd`,
        sha256: 'ff68db616af679b1734c9dbf5aa508f07db2aa2f1c7169dfa597ff92ca09d9c5',
        retrievedOn: '2026-11-05',
        mediaType: 'application/xml',
      },
    ],
  },
];

export const withholdingClauses: readonly Clause[] = [
  // Rent paid to individuals.
  {
    id: `${CODE}:art.84^1(3)-(6)`,
    source: CODE,
    locator: 'art. 84^1 alin. (1)–(6)',
    status: 'located',
    summary:
      'Pentru chiriile plătite de persoane juridice sau alte entități care conduc evidență contabilă, plătitorul stabilește la fiecare plată venitul net (venitul brut minus 20%), calculează, reține, declară și plătește impozitul de 10% din venitul net, impozit final, până la 25 a lunii următoare reținerii; chiria în valută se convertește la cursul BNR din ziua precedentă plății.',
  },
  {
    id: `${CODE}:art.84^1(8)-(9)`,
    source: CODE,
    locator: 'art. 84^1 alin. (8)–(9)',
    status: 'located',
    summary:
      'Chiria plătită exclusiv în natură și garanția folosită pentru plata chiriei: impozitul îl stabilește proprietarul prin declarația unică; plătitorul le declară în declarația informativă de la art. 132 alin. (2) (D205).',
  },
  {
    id: 'LJR/Cod-fiscal-2025:art.84^1',
    source: 'LJR/Cod-fiscal-2025',
    locator:
      'art. 84^1 și notele de consolidare (OUG nr. 115/2023, art. LIII pct. 64; OUG nr. 138/2024)',
    status: 'located',
    summary:
      'Articolul 84^1 a fost introdus de la 01.01.2024 de OUG nr. 115/2023 (art. LIII pct. 64), aplicabil veniturilor anului 2024; alin. (4) modificat și alin. (8)–(9) introduse de OUG nr. 138/2024 de la 05.12.2024.',
  },
  // Intellectual property paid to individuals.
  {
    id: `${CODE}:art.72(2)-(6)`,
    source: CODE,
    locator: 'art. 72 alin. (1)–(7)',
    status: 'located',
    summary:
      'Plătitorii persoane juridice stabilesc venitul net din drepturi de proprietate intelectuală deducând 40% din venitul brut (moștenitorii, dreptul de suită și copia privată: doar sumele organismelor de gestiune), rețin la plată 10% din venitul net, impozit final plătit până la 25 a lunii următoare; nu rețin pentru plățile către asocieri și entități cu personalitate juridică.',
  },
  {
    id: `${CODE}:art.73`,
    source: CODE,
    locator: 'art. 73',
    status: 'located',
    summary:
      'Beneficiarul veniturilor din drepturi de proprietate intelectuală poate opta, prin declarația unică, pentru venitul net în sistem real, pe doi ani fiscali consecutivi.',
  },
  {
    id: `${CODE}:art.151(5)-(8)`,
    source: CODE,
    locator: 'art. 151 alin. (5)–(8) și art. 174^1 alin. (3)–(5)',
    status: 'located',
    summary:
      'Plătitorul de drepturi de proprietate intelectuală reține CAS și CASS doar când contractul o prevede (venitul estimat de la el atinge 12, respectiv 6 salarii minime), și le declară în D112 până la 25 a lunii următoare.',
  },
  {
    id: `${CODE}:art.132(2)-exceptii`,
    source: CODE,
    locator: 'art. 132 alin. (2) (excepțiile) și alin. (3)',
    status: 'located',
    summary:
      'Plătitorii de venituri din salarii, pensii, drepturi de proprietate intelectuală, contracte de activitate sportivă, arendă și asocieri nu depun declarația pe beneficiari: declară în Declarația privind obligațiile de plată a contribuțiilor sociale, impozitului pe venit și evidența nominală a persoanelor asigurate (D112). Chiria în natură și garanția (art. 84^1 alin. (8)) se declară în D205.',
  },
  // Interim dividends.
  {
    id: 'L82/1991:art.19(3)-(3^2)',
    source: 'L82/1991',
    locator: 'art. 19 alin. (3)–(3^2) și art. 28 alin. (8^1)',
    status: 'located',
    summary:
      'Dividendele interimare se înregistrează drept creanțe față de asociați; se repartizează trimestrial, pe baza situațiilor financiare interimare aprobate, în limita profitului net realizat, plus profiturile reportate și rezervele disponibile retrase, minus pierderile reportate și rezervele legale sau statutare; se regularizează după aprobarea situațiilor anuale, iar cele plătite în plus se restituie în 60 de zile.',
  },
  {
    id: 'L163/2018:art.II.pct.1-2',
    source: 'L163/2018',
    locator: 'art. II pct. 1–2 (Legea nr. 31/1990, art. 67 alin. (2), (2^1) și (2^2))',
    status: 'located',
    summary:
      'Dividendele se pot distribui trimestrial pe baza situațiilor financiare interimare, cu regularizarea prin situațiile anuale; diferențele de plătit se plătesc, iar restituirile datorate de asociați se achită, în 60 de zile de la aprobarea situațiilor anuale.',
  },
  {
    id: 'OMFP3067/2018:pct.423^1-423^2',
    source: 'OMFP3067/2018',
    locator: 'art. I pct. 1–3 (OMFP nr. 1.802/2014, pct. 423^1–423^2 și funcțiunea contului 463)',
    status: 'located',
    summary:
      'Dividendele repartizate în cursul exercițiului se înregistrează 463 = 456 și se regularizează pe seama dividendelor anuale 457 = 463; contul 463 (activ) se creditează și cu restituirile de dividende încasate (512, 531).',
  },
  {
    id: 'OMFP3067/2018:art.III-V',
    source: 'OMFP3067/2018',
    locator: 'art. I pct. 4 (pct. 602) și art. III–V',
    status: 'located',
    summary:
      'Situațiile financiare interimare (bilanț și cont de profit și pierdere, cumulat de la începutul exercițiului) se întocmesc după inventariere și se depun la Ministerul Finanțelor în 30 de zile de la aprobarea lor.',
  },
  {
    id: `${CODE}:art.97(7)-interimare`,
    source: CODE,
    locator: 'nota 2 la art. 97 alin. (7) (art. VII alin. (2) din Legea nr. 141/2025)',
    status: 'located',
    summary:
      'Dividendele distribuite pe baza situațiilor financiare interimare din 2025 se impozitează cu 10%, fără recalcularea impozitului după regularizarea lor pe baza situațiilor anuale ale exercițiului 2025.',
  },
  // Non-residents.
  {
    id: `${CODE}:art.7.pct.36`,
    source: CODE,
    locator: 'art. 7 pct. 36',
    status: 'located',
    summary:
      'Redevența: plățile pentru folosirea sau dreptul de folosință al drepturilor de autor, brevetelor, licențelor, mărcilor, software-ului, echipamentelor, know-how-ului; nu sunt redevențe achiziția integrală, software-ul destinat exclusiv operării lui, dreptul limitat de a-l copia pentru folosire sau distribuție, drepturile de distribuție fără reproducere.',
  },
  {
    id: `${CODE}:norme.art.223.pct.2`,
    source: CODE,
    locator: 'normele metodologice, titlul VI, pct. 2 (art. 223 alin. (1) lit. d) și e))',
    status: 'located',
    summary:
      'La un transfer de software, încadrarea ca redevență depinde de drepturile transferate: dreptul de a-l reproduce, distribui public sau modifica e redevență; dreptul limitat de a-l copia pentru exploatare (inclusiv licențe de rețea) nu; contractele mixte se împart pe porțiuni.',
  },
  {
    id: `${CODE}:art.223(1)`,
    source: CODE,
    locator: 'art. 223 alin. (1)',
    status: 'located',
    summary:
      'Veniturile impozabile obținute din România de nerezidenți: dividende, dobânzi, redevențe și comisioane de la un rezident, servicii de management sau consultanță de la un rezident, servicii prestate în România, profesii independente în România, premii, lichidarea unui rezident și altele.',
  },
  {
    id: `${CODE}:art.223(2)`,
    source: CODE,
    locator: 'art. 223 alin. (2)',
    status: 'located',
    summary:
      'Nu se impun după titlul VI, ci după titlul II sau IV: veniturile unui sediu permanent, ale unei persoane juridice străine din proprietăți imobiliare din România (închirierea inclusiv), ale unei persoane fizice nerezidente din închirierea proprietăților imobiliare din România.',
  },
  {
    id: `${CODE}:art.224(4)(b)`,
    source: CODE,
    locator: 'art. 224 alin. (4) lit. b)',
    status: 'located',
    summary: 'Dividendele obținute din România de nerezidenți: 16% din venitul brut.',
  },
  {
    id: `${CODE}:art.224(4)(c)`,
    source: CODE,
    locator: 'art. 224 alin. (4) lit. c)',
    status: 'located',
    summary:
      '50% pentru veniturile de la lit. b)–g), i), k), l) și o) plătite într-un stat fără instrument de schimb de informații, ca urmare a unor tranzacții artificiale (art. 11 alin. (3)).',
  },
  {
    id: `${CODE}:art.224(4)(c^1)`,
    source: CODE,
    locator: 'art. 224 alin. (4) lit. c^1)',
    status: 'located',
    summary:
      '10% pentru veniturile de la art. 223 alin. (1) lit. b)–i) și k)–p) ale persoanelor fizice rezidente într-un stat al Uniunii Europene sau într-un stat cu convenție de evitare a dublei impuneri.',
  },
  {
    id: `${CODE}:art.224(4)(d)`,
    source: CODE,
    locator: 'art. 224 alin. (4) lit. d)',
    status: 'located',
    summary: '16% pentru orice alte venituri impozabile obținute din România de nerezidenți.',
  },
  {
    id: `${CODE}:art.224(5)`,
    source: CODE,
    locator: 'art. 224 alin. (1), (3) și (5)',
    status: 'located',
    summary:
      'Plătitorul calculează și reține impozitul la plata venitului, îl declară și îl plătește până la 25 a lunii următoare, în lei, la cursul BNR din ziua plății; pentru dividendele neplătite până la sfârșitul anului distribuirii, până la 25 ianuarie.',
  },
  {
    id: `${CODE}:art.229(1)`,
    source: CODE,
    locator: 'art. 229 alin. (1)',
    status: 'located',
    summary:
      'Scutiri: dividendele către persoane juridice din UE care dețin minimum 10% de cel puțin un an (Directiva 2011/96/UE), dobânzile și redevențele între societăți asociate din UE (cap. V), dobânzile la datoria publică, fondurile de pensii și altele.',
  },
  {
    id: `${CODE}:art.230(1)-(2)`,
    source: CODE,
    locator: 'art. 230 alin. (1), (2) și (4)',
    status: 'located',
    summary:
      'Cota din convenție nu poate fi depășită; se aplică cota mai favorabilă. Pentru convenție, nerezidentul prezintă la plată certificatul de rezidență fiscală (original sau copie legalizată, cu traducere; cel electronic e original); fără el se aplică titlul VI, iar la prezentarea lui ulterioară se regularizează în termenul de prescripție. Certificatul prezentat în anul plăților e valabil și în primele 60 de zile ale anului următor, dacă rezidența nu se schimbă.',
  },
  {
    id: `${CODE}:art.231(1)`,
    source: CODE,
    locator: 'art. 231 alin. (1) și (1^1)',
    status: 'located',
    summary:
      'Plătitorii de venituri cu reținere la sursă către nerezidenți depun, până în ultima zi a lunii februarie, declarația pe fiecare beneficiar pentru anul expirat (D207), și atunci când impozitul e suportat de plătitor.',
  },
  {
    id: `${CODE}:art.25(4)(a)-nerezidenti`,
    source: CODE,
    locator: 'art. 25 alin. (4) lit. a), a doua frază',
    status: 'located',
    summary:
      'Sunt nedeductibile cheltuielile cu impozitele nereținute la sursă în numele nerezidenților, pentru veniturile lor din România (impozitul suportat de plătitor).',
  },
  // The returns.
  {
    id: 'ANAF/D100:nomenclator.withholding',
    source: 'ANAF/D100',
    locator: 'nomenclatorul obligațiilor, pozițiile 13–18 (631–636) și 109 (628); modelul 1#',
    status: 'located',
    summary:
      'Codurile 628 (chirii plătite de persoane juridice, art. 84^1 și 132), 631 dividende, 632 dobânzi, 633 redevențe, 634 comisioane, 636 servicii ale nerezidenților (art. 223–224 sau convențiile): bugetul 5503, lunar, scadența 25 a lunii următoare, modelul 1# (suma de plată = suma datorată); poziția 611 (drepturi de proprietate intelectuală) nu mai are atribute.',
  },
  {
    id: 'ANAF/D205:tip_venit.29',
    source: 'ANAF/D205',
    locator:
      'nomenclatorul naturii veniturilor: 1.k) cod 29; câmpurile VB, GAR, baza1, imp1; „desființate”: 01',
    status: 'located',
    summary:
      'Cod 29: chiriile plătite de persoane juridice, 10%, tip_plata 2, cu baza de calcul și impozitul (col. 9–10), plus venitul în natură (VB) și garanția (GAR); rezident sau nerezident. Codul 01 (drepturi de proprietate intelectuală) e printre cele desființate.',
  },
  {
    id: 'ANAF/D207:structura',
    source: 'ANAF/D207',
    locator: 'structura declarației 207, câmpurile 1–37 și nomenclatorul naturii veniturilor',
    status: 'located',
    summary:
      'Declarația 207, luna 12, anul ≥ 2021: plătitorul, secțiunea II pe tip de venit (nrben, Tscutit, Tbaza, Timp, Timps) și câte o înregistrare pe beneficiar (tip_venit1, den1, Stat_R, cifR, cifS, baza1, imp1, imps1, Act_N 1 Codul fiscal, 2 convenția, 3 acord internațional), unică pe cifR + tip_venit1; totalPlata_A = suma nrben, Tscutit, Tbaza, Timp și Timps.',
  },
  {
    id: 'ANAF/D406:WHT-nomenclator',
    source: 'ANAF/D406',
    locator:
      'RO_SAFT_SchemaDefCod_16.02.2026.xlsx, foile „WHT - nomenclator”, „WHT - D207” și „Centralizator_Nomenclatoare” (poz. 13)',
    status: 'located',
    summary:
      'Codurile de impozit reținut la sursă (TaxCode TTTCCC: TaxType-ul din D100 și un cod pe cotă), obligatorii în D406 pentru TaxInformation; 604040 (dividende persoane fizice 16%) adăugat la 16.02.2026.',
  },
  {
    id: 'ANAF/SAFT_Ghid_2021:WHT',
    source: 'ANAF/SAFT_Ghid_2021',
    locator: 'secțiunile 2.5 (Tax Table), 3 (TaxInformation) și 4.3 (Payments)',
    status: 'located',
    summary:
      'Codurile WHT folosite se raportează în TaxTable (BaseRate 100); informațiile despre impozitele reținute la sursă se raportează pe linia relevantă bazei impozabile (plățile efectuate); în Payments raportarea WHT este obligatorie.',
  },
];
