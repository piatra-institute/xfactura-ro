import type { ParameterVersion } from '../../rules';

/**
 * Where the engine's Romanian rules come from. A source is a legal act or an official
 * document; a clause is a located place in it. Every parameter version cites clauses by id.
 *
 * A clause is `located` when its text was read in a snapshot whose hash is recorded here, and
 * `pending` when only its locator is known. Neither is a review: values stay `extracted` until
 * an expert contabil reviews them (`ReviewStatus`). Snapshot bytes live outside the repository
 * in `.sources/` (fetched by `scripts/sources/fetch.ts`, or provided by the owner).
 */
export type Snapshot = {
  url: string;
  sha256: string;
  /** When the bytes were retrieved; null when that was not recorded. */
  retrievedOn: string | null;
  mediaType: string;
};

export type LegalSource = {
  id: string;
  kind: 'act' | 'official_document' | 'standard';
  title: string;
  issuer: string;
  /** The Monitorul Oficial publication; null until it has been checked. */
  publication: string | null;
  /** Where the official text can be obtained. `fetch` sources are fetched and hashed by the
   * sources script; the others are provided by the owner (the site refuses automated access). */
  urls: readonly string[];
  fetch: boolean;
  snapshots: readonly Snapshot[];
};

export type Clause = {
  id: string;
  source: string;
  locator: string;
  status: 'located' | 'pending';
  /** What the clause says, in our words; never a substitute for the text. */
  summary: string;
};

export const legalSources: readonly LegalSource[] = [
  {
    id: 'L227/2015',
    kind: 'act',
    title: 'Legea nr. 227/2015 privind Codul fiscal',
    issuer: 'Parlamentul României',
    publication: null,
    urls: ['https://legislatie.just.ro/Public/DetaliiDocument/171282'],
    fetch: false,
    snapshots: [],
  },
  {
    id: 'L207/2015',
    kind: 'act',
    title: 'Legea nr. 207/2015 privind Codul de procedură fiscală',
    issuer: 'Parlamentul României',
    publication: null,
    urls: [],
    fetch: false,
    snapshots: [],
  },
  {
    id: 'L141/2025',
    kind: 'act',
    title: 'Legea nr. 141/2025 privind unele măsuri fiscal-bugetare',
    issuer: 'Parlamentul României',
    publication: null,
    urls: [],
    fetch: false,
    snapshots: [],
  },
  {
    id: 'OMFP1802/2014',
    kind: 'act',
    title:
      'Ordinul ministrului finanțelor publice nr. 1.802/2014 pentru aprobarea Reglementărilor contabile privind situațiile financiare anuale individuale și situațiile financiare anuale consolidate',
    issuer: 'Ministerul Finanțelor Publice',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_1802_2014.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_1802_2014.pdf',
        sha256: '6e0de23520f49de718dead66462f14d624c527a87e8b27eeb5306ab9cc84ff4c',
        retrievedOn: null,
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/D300-12.0.0',
    kind: 'official_document',
    title: 'Structura fișierului XML al decontului de TVA (D300), versiunea 12.0.0',
    issuer: 'ANAF',
    publication: null,
    urls: [
      'https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/structura_D300_v12.0.0_10022026.pdf',
    ],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/structura_D300_v12.0.0_10022026.pdf',
        sha256: 'fedbf3b11b3e06e72a5f4be8be3c5b0fafd267a87d71de3261b0fd8af2a89b3e',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/ghid-coduri-facturi-2.9',
    kind: 'official_document',
    title: 'Ghid privind codurile din factura electronică, versiunea 2.9',
    issuer: 'ANAF',
    publication: null,
    urls: [
      'https://static.anaf.ro/static/10/Anaf/Informatii_R/Ghid%20cod%20facturi_final%20v2.9.pdf',
    ],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/Informatii_R/Ghid%20cod%20facturi_final%20v2.9.pdf',
        sha256: 'cbb6d05672f7baed7370c183edbb70fd79149514ed3150cad109a779f4d03cde',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/Ploiesti-modificari-tva',
    kind: 'official_document',
    title: 'Modificări privind cotele de TVA (material informativ ANAF Ploiești)',
    issuer: 'ANAF',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/Ploiesti/modificari_tva.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Ploiesti/modificari_tva.pdf',
        sha256: '2e4d2792bb1c6cae010134900141c088063c3feed56aa37397a879be59953b02',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat',
    kind: 'official_document',
    title:
      'Codul fiscal adnotat cu normele metodologice, text actualizat publicat de ANAF (ultima actualizare: Legea nr. 204/2026; norme: Hotărârea Guvernului nr. 602/2025)',
    issuer: 'ANAF',
    publication: null,
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/Cod_fiscal_norme_2023.htm'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/Cod_fiscal_norme_2023.htm',
        sha256: 'aba0c753fd326414d4327af00bc56269024a9c248857096aef7354a68013e7c1',
        retrievedOn: '2026-10-29',
        mediaType: 'text/html',
      },
    ],
  },
  {
    id: 'OMFP1243/2018',
    kind: 'act',
    title:
      'Ordinul ministrului finanțelor publice nr. 1.243/2018 privind completarea unor reglementări contabile',
    issuer: 'Ministerul Finanțelor Publice',
    publication: 'Monitorul Oficial nr. 120 din 7 februarie 2018',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_1243_2018.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_1243_2018.pdf',
        sha256: '81b0890aad08a3d47559b90521119b4ec320125cc3fd7afbb253061121dcee93',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/D112-0726',
    kind: 'official_document',
    title:
      'Structura și validările declarației 112 pentru lunile de raportare din 07/2026 (anexa validări, 07.09.2026)',
    issuer: 'ANAF',
    publication: null,
    urls: [
      'https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/structura_D112_0726_070926.pdf',
    ],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec/structura_D112_0726_070926.pdf',
        sha256: '3c7c78aee3588357da0b801aa322107071abc010ed25727eb705ca3c5b6edfce',
        retrievedOn: '2026-10-29',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'OUG156/2024',
    kind: 'act',
    title: 'Ordonanța de urgență a Guvernului nr. 156/2024',
    issuer: 'Guvernul României',
    publication: null,
    urls: [],
    fetch: false,
    snapshots: [],
  },
  {
    id: 'HG2139/2004',
    kind: 'act',
    title:
      'Hotărârea Guvernului nr. 2.139/2004 pentru aprobarea Catalogului privind clasificarea și duratele normale de funcționare a mijloacelor fixe',
    issuer: 'Guvernul României',
    publication: 'Monitorul Oficial nr. 46 din 13 ianuarie 2005',
    urls: ['https://legislatie.just.ro/Public/DetaliiDocumentAfis/58613'],
    fetch: false,
    snapshots: [],
  },
  {
    id: 'HG1506/2024',
    kind: 'act',
    title:
      'Hotărârea Guvernului nr. 1.506/2024 pentru stabilirea salariului de bază minim brut pe țară garantat în plată',
    issuer: 'Guvernul României',
    publication: null,
    urls: [],
    fetch: false,
    snapshots: [],
  },
  {
    id: 'HG146/2026',
    kind: 'act',
    title:
      'Hotărârea Guvernului nr. 146/2026 pentru stabilirea salariului de bază minim brut pe țară garantat în plată',
    issuer: 'Guvernul României',
    publication: null,
    urls: [],
    fetch: false,
    snapshots: [],
  },
  {
    id: 'OUG89/2025',
    kind: 'act',
    title: 'Ordonanța de urgență a Guvernului nr. 89/2025',
    issuer: 'Guvernul României',
    publication: null,
    urls: [],
    fetch: false,
    snapshots: [],
  },
];

export const clauses: readonly Clause[] = [
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.64(1)(b)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 64 alin. (1) lit. b)',
    status: 'located',
    summary:
      'Cota impozitului pe venit este 10% pentru veniturile din salarii și asimilate salariilor.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:norme.art.64.pct.4',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'normele metodologice, titlul IV, pct. 4 (aplicarea art. 64)',
    status: 'located',
    summary:
      'Bazele de calcul al impozitului se rotunjesc la leu: fracțiunile de până la 50 de bani inclusiv se neglijează, cele peste 50 de bani se majorează la leu.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.76(3)(h)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 76 alin. (3) lit. h)',
    status: 'located',
    summary:
      'Tichetele de masă, voucherele de vacanță și celelalte bilete de valoare acordate potrivit legii sunt venituri din salarii.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.77',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 77 alin. (1)–(4) și (10)',
    status: 'located',
    summary:
      'Deducerea personală la funcția de bază: de bază, după tabelul procentelor din salariul minim pentru venituri brute de până la salariul minim + 2.000 lei și numărul persoanelor în întreținere; suplimentară, 15% din salariul minim până la 26 de ani și 100 lei pentru fiecare copil înscris la școală.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:norme.art.77.pct.13(14)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'normele metodologice, titlul IV, pct. 13 alin. (14)',
    status: 'located',
    summary:
      'Deducerea personală nu se fracționează pentru contractele cu timp parțial la funcția de bază.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.78(2)(a)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 78 alin. (2) lit. a)',
    status: 'located',
    summary:
      'Impozitul lunar la funcția de bază: 10% din venitul net (brut minus contribuțiile sociale) minus deducerea personală și cotizația sindicală.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.138(a)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 138 lit. a)',
    status: 'located',
    summary: 'Cota contribuției de asigurări sociale datorate de angajați este 25%.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.139(1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 139 alin. (1)',
    status: 'located',
    summary: 'Baza lunară a CAS este câștigul brut din salarii și venituri asimilate.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.142(r)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 142 lit. r)',
    status: 'located',
    summary: 'Tichetele de masă și voucherele de vacanță nu intră în baza lunară a CAS.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.146(5^6)-(5^9)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 146 alin. (5^6)–(5^9)',
    status: 'located',
    summary:
      'CAS nu poate fi mai mică decât cea calculată la salariul minim pentru zilele lucrătoare în care contractul a fost activ, cu excepțiile de la alin. (5^7); diferența o suportă angajatorul.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.156',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 156',
    status: 'located',
    summary: 'Cota contribuției de asigurări sociale de sănătate este 10%.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.157',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 157 alin. (1) și (2)',
    status: 'located',
    summary:
      'Baza lunară a CASS este câștigul brut, inclusiv valoarea nominală a tichetelor de masă și a voucherelor de vacanță.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.168(6^1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 168 alin. (6^1)',
    status: 'located',
    summary: 'Minimul calculat la salariul minim (art. 146 alin. (5^6)–(5^9)) se aplică și CASS.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.220^3(1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 220^3 alin. (1)',
    status: 'located',
    summary: 'Cota contribuției asiguratorii pentru muncă este 2,25%.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.220^4',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 220^4',
    status: 'located',
    summary: 'Baza CAM este câștigul brut din salarii, fără sumele de la art. 142.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.291(1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 291 alin. (1)',
    status: 'located',
    summary: 'Cota standard de TVA este 21%.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.291(2)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 291 alin. (2)',
    status: 'located',
    summary: 'Cota redusă de TVA este 11%, pentru livrările și prestările enumerate.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.47(1)(c)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 47 alin. (1) lit. c) și art. 54 alin. (3)',
    status: 'located',
    summary:
      'Microîntreprinderea a realizat la 31 decembrie a anului precedent venituri de cel mult echivalentul a 100.000 euro (de la 1 ianuarie 2026), la cursul de la închiderea exercițiului financiar.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.47(1)(g)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 47 alin. (1) lit. g) și art. 51 alin. (4)',
    status: 'located',
    summary:
      'Microîntreprinderea are cel puțin un salariat cu normă întreagă (sau fracțiuni de normă însumând o normă, sau un contract de administrare ori mandat remunerat cel puțin cu salariul minim).',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.51(1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 51 alin. (1)',
    status: 'located',
    summary: 'Cota impozitului pe veniturile microîntreprinderilor este 1%.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.52(1),(5)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 52 alin. (1) și (5)',
    status: 'located',
    summary:
      'Peste 100.000 euro venituri în cursul anului, cumulat de la începutul anului la cursul de la închiderea exercițiului precedent, microîntreprinderea datorează impozit pe profit din trimestrul depășirii.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.53',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 53 alin. (1) și (2)',
    status: 'located',
    summary:
      'Baza impozabilă: veniturile din orice sursă, din care se scad veniturile enumerate (stocuri, producția de imobilizări, subvenții, diferențe de curs valutar, reduceri comerciale acordate, dividende de la persoane juridice române etc.) și la care se adaugă reducerile comerciale primite și, în trimestrul IV, diferența favorabilă de curs valutar a anului.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.56(1)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 56 alin. (1) și (2)',
    status: 'located',
    summary:
      'Impozitul se calculează și se plătește trimestrial, până la 25 a lunii următoare trimestrului, cu declarația aferentă.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.43(2)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 43 alin. (1)–(3)',
    status: 'located',
    summary:
      'Dividendele plătite unei persoane juridice române se impozitează cu 16% din dividendul brut; impozitul se reține la plată și se plătește până la 25 a lunii următoare, iar pentru dividendele distribuite și neplătite până la sfârșitul anului, până la 25 ianuarie.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.43(4)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 43 alin. (4)',
    status: 'located',
    summary:
      'Scutirea dividendelor între persoane juridice române: beneficiarul deține cel puțin 10% de cel puțin un an și ambele plătesc, fără opțiune, impozit pe profit sau unul care îl substituie.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.97(7)',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 97 alin. (7) și nota privind art. VII din Legea nr. 141/2025',
    status: 'located',
    summary:
      'Dividendele plătite persoanelor fizice se impozitează cu 16%, impozit final reținut la plată, pentru dividendele distribuite începând cu 1 ianuarie 2026.',
  },
  {
    id: 'ANAF/Cod-fiscal-consolidat:art.28',
    source: 'ANAF/Cod-fiscal-consolidat',
    locator: 'art. 28 alin. (2), (5), (6) și (11)',
    status: 'located',
    summary:
      'Amortizarea fiscală: metoda liniară pentru construcții, liniară, degresivă sau accelerată pentru echipamente și computere, liniară sau degresivă pentru celelalte; începe cu luna următoare punerii în funcțiune.',
  },
  {
    id: 'OMFP1802/2014:pct.238',
    source: 'OMFP1802/2014',
    locator: 'pct. 238 alin. (1)–(3)',
    status: 'located',
    summary:
      'Amortizarea se aplică valorii de intrare, începe cu luna următoare punerii în funcțiune și continuă până la recuperarea integrală; duratele contabile, stabilite prin politicile contabile, pot diferi de cele fiscale.',
  },
  {
    id: 'HG2139/2004:catalog',
    source: 'HG2139/2004',
    locator:
      'anexa: Catalogul privind clasificarea și duratele normale de funcționare a mijloacelor fixe',
    status: 'pending',
    summary:
      'Codul de clasificare și intervalul duratei normale de funcționare a fiecărui mijloc fix.',
  },
  {
    id: 'OMFP1243/2018:art.1,4',
    source: 'OMFP1243/2018',
    locator: 'art. 1 și art. 4',
    status: 'located',
    summary:
      'Introduce în planul de conturi conturile 4315, 4316, 436 (pasiv) și 646, pentru contribuțiile datorate pentru veniturile realizate de la 1 ianuarie 2018.',
  },
  {
    id: 'ANAF/D112-0726:salariul-minim',
    source: 'ANAF/D112-0726',
    locator: 'modificări: Suma300, Suma200, salMin și suma limită B2_5P',
    status: 'located',
    summary:
      'Salariul minim 4.050 lei (01–06/2026) și 4.325 lei (07–12/2026); suma care nu se include în baze 300 lei (OUG 156/2024, 01–06/2026) și 200 lei (OUG 89/2025, 07–12/2026), cu plafonul venitului de 4.300, respectiv 4.600 lei; suma limită pentru contribuția minimă: (salariul minim − suma) / zile lucrătoare × zile, la leu.',
  },
  {
    id: 'OUG156/2024:salariul-minim',
    source: 'OUG156/2024',
    locator: 'dispozițiile privind suma care nu se include în bazele de calcul (de localizat)',
    status: 'pending',
    summary:
      'Suma de 300 lei care nu se include în bazele de calcul pentru salariații plătiți cu salariul minim.',
  },
  {
    id: 'HG1506/2024:art.1',
    source: 'HG1506/2024',
    locator: 'art. 1',
    status: 'pending',
    summary: 'Salariul minim brut pe țară este 4.050 lei lunar de la 1 ianuarie 2025.',
  },
  {
    id: 'HG146/2026:art.1',
    source: 'HG146/2026',
    locator: 'art. 1',
    status: 'pending',
    summary:
      'Salariul minim brut pe țară este 4.325 lei lunar de la 1 iulie 2026 (cunoscut din presă; textul de obținut).',
  },
  {
    id: 'OUG89/2025:salariul-minim',
    source: 'OUG89/2025',
    locator: 'dispozițiile privind suma care nu se include în bazele de calcul (de localizat)',
    status: 'pending',
    summary:
      'Pentru salariații cu salariul de bază egal cu salariul minim și venitul brut până la un plafon, o sumă lunară (300 lei până în iunie 2026, plafon 4.300 lei; 200 lei din iulie 2026, plafon 4.600 lei) nu se include în bazele de calcul (cunoscut din presă; textul de obținut).',
  },
  {
    id: 'L227/2015:art.291(1)(a)',
    source: 'L227/2015',
    locator: 'art. 291 alin. (1) lit. a)',
    status: 'pending',
    summary: 'Cota standard de TVA.',
  },
  {
    id: 'L227/2015:art.291(2)',
    source: 'L227/2015',
    locator: 'art. 291 alin. (2)',
    status: 'pending',
    summary: 'Cota redusă de TVA și operațiunile cărora li se aplică.',
  },
  {
    id: 'L227/2015:art.290',
    source: 'L227/2015',
    locator: 'art. 290',
    status: 'pending',
    summary: 'Cursul de schimb pentru baza de impozitare a operațiunilor în valută.',
  },
  {
    id: 'L207/2015:rounding',
    source: 'L207/2015',
    locator: 'rotunjirea creanțelor fiscale la leu (articolul de localizat)',
    status: 'pending',
    summary:
      'Creanțele fiscale se rotunjesc la leu: sub 50 de bani prin reducere, de la 50 de bani prin majorare.',
  },
  {
    id: 'L141/2025:rates',
    source: 'L141/2025',
    locator: 'dispozițiile care modifică art. 291 din Codul fiscal, cu efect de la 01.08.2025',
    status: 'pending',
    summary: 'Cota standard devine 21% și cota redusă 11% de la 1 august 2025.',
  },
  {
    id: 'L141/2025:art.III',
    source: 'L141/2025',
    locator: 'art. III',
    status: 'pending',
    summary: 'Cota tranzitorie de 9% pentru anumite livrări de locuințe.',
  },
  {
    id: 'ANAF/D300-12.0.0:rd.9',
    source: 'ANAF/D300-12.0.0',
    locator: 'rândul 9 (R9_1, R9_2), valabil de la 01.08.2025',
    status: 'located',
    summary: 'Livrări și prestări taxabile cu cota 21%.',
  },
  {
    id: 'ANAF/D300-12.0.0:rd.10',
    source: 'ANAF/D300-12.0.0',
    locator: 'rândul 10 (R10_1, R10_2), valabil de la 01.08.2025',
    status: 'located',
    summary: 'Livrări și prestări taxabile cu cota 11%.',
  },
  {
    id: 'ANAF/D300-12.0.0:rd.11',
    source: 'ANAF/D300-12.0.0',
    locator: 'rândul 11 (R11_1, R11_2), valabil de la 01.08.2025',
    status: 'located',
    summary: 'Livrări de bunuri taxabile cu cota 9% conform art. III din Legea nr. 141/2025.',
  },
  {
    id: 'OMFP1802/2014:pct.315-316',
    source: 'OMFP1802/2014',
    locator: 'pct. 315–316 (operațiuni în valută)',
    status: 'pending',
    summary: 'Cursul de schimb pentru înregistrarea operațiunilor în valută.',
  },
  {
    id: 'ANAF/ghid-coduri-facturi-2.9:O',
    source: 'ANAF/ghid-coduri-facturi-2.9',
    locator: 'categoria de TVA "O"',
    status: 'located',
    summary: 'Categoria O se folosește pentru operațiunile efectuate de neplătitorii de TVA.',
  },
  {
    id: 'ANAF/Ploiesti-modificari-tva:cote',
    source: 'ANAF/Ploiesti-modificari-tva',
    locator: 'Cotele de TVA (începând cu 01.08.2025)',
    status: 'located',
    summary:
      'De la 01.08.2025 cota standard crește de la 19% la 21%; o singură cotă redusă, 11%, înlocuiește cotele de 9% și 5% (Legea nr. 141/2025).',
  },
];

const sourceById = new Map(legalSources.map((source) => [source.id, source]));
const clauseById = new Map(clauses.map((item) => [item.id, item]));

export function clause(id: string): Clause | undefined {
  return clauseById.get(id);
}

export function sourceOf(item: Clause): LegalSource {
  return sourceById.get(item.source)!;
}

/**
 * What keeps the citations honest: every parameter version cites at least one registered
 * clause, every clause names a registered source, and a located clause's source has a
 * snapshot whose bytes were read.
 */
export function citationProblems(versions: readonly ParameterVersion[]): string[] {
  const problems: string[] = [];
  for (const item of clauses) {
    const source = sourceById.get(item.source);
    if (!source) problems.push(`${item.id}: unknown source ${item.source}`);
    else if (item.status === 'located' && !source.snapshots.length)
      problems.push(`${item.id}: located in ${item.source}, which has no snapshot`);
  }
  for (const version of versions) {
    if (!version.clauses.length) problems.push(`${version.id}: cites nothing`);
    for (const id of version.clauses)
      if (!clauseById.has(id)) problems.push(`${version.id}: unknown clause ${id}`);
  }
  return problems;
}

/** The parameters a person still has to source: those citing only pending clauses. */
export function unsourced(versions: readonly ParameterVersion[]) {
  return versions.filter((version) =>
    version.clauses.every((id) => clauseById.get(id)?.status !== 'located'),
  );
}
