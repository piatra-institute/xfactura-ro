import type { Clause, LegalSource } from './index';

/*
 * The sources of receipts and domestic reverse charge (V3): fiscal receipts as simplified
 * invoices (Codul fiscal art. 319 alin. (12), (13) and (21), the norms' pct. 69 alin. (3) and (6)
 * under art. 299), the exchange rate of the limit (art. 290), the domestic reverse charge (art.
 * 331 and the norms' pct. 109), and where the returns report them: the D300 rows 12 and 13 with
 * their header flags (ANAF's structure 12.0.0) and the D394 sections of ANAF's structure of
 * 15.09.2025. Read on 5 November 2026 in the snapshots registered here and in the register's
 * main list. Kept apart from that list, which spreads them in.
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
const PORTAL = 'LJR/Cod-fiscal-2025';
const declarations = 'https://static.anaf.ro/static/10/Anaf/Declaratii_R/AplicatiiDec';

export const receiptSources: readonly LegalSource[] = [
  {
    // An ANAF county office's reminder for the Q3 2026 return: it confirms the 30th that art. 8
    // and the instructions set, against the 25th left in the management procedure (anexa nr. 3).
    id: 'ANAF/AJFP-Ialomita-394-2026',
    kind: 'official_document',
    title:
      'AJFP Ialomița, comunicat nr. ILG-DEX 7605/25.09.2026: 30 septembrie 2026, termen limită pentru depunerea formularului 394',
    issuer: 'ANAF',
    publication: null,
    urls: [
      'https://static.anaf.ro/static/3/Ploiesti/20260925104315_comunicat-termen_formular_394_30_septembrie_2026.pdf',
    ],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/3/Ploiesti/20260925104315_comunicat-termen_formular_394_30_septembrie_2026.pdf',
        sha256: '46328ccf128a7ec405efe20c3b015d8274d8dda6e15d9dd5642144f6c3746299',
        retrievedOn: '2026-11-06',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    id: 'ANAF/D394',
    kind: 'official_document',
    title:
      'Structura fișierului XML al declarației informative D394, valabilă pentru perioadele de raportare din august 2025 (structD394_15092025)',
    issuer: 'ANAF',
    publication: null,
    urls: [`${declarations}/structD394_15092025.pdf`],
    fetch: true,
    snapshots: [
      {
        url: `${declarations}/structD394_15092025.pdf`,
        sha256: '82b49cb5a2ed3ba42a8f436537b38ee25f930c4a4a4b98f854aab285cedc237f',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  },
  {
    // The law on fiscal cash registers, which the Fiscal Code and its norms cite for receipts.
    // The owner's copy is a LEX EXPERT consolidation current to 10 September 2018: amendments
    // after that date are not verified. Kept in .sources/OUG28_1999/.
    id: 'OUG28/1999',
    kind: 'act',
    title:
      'Ordonanța de urgență a Guvernului nr. 28/1999 privind obligația operatorilor economici de a utiliza aparate de marcat electronice fiscale, republicată (text consolidat LEX EXPERT, în vigoare de la 10 septembrie 2018)',
    issuer: 'Guvernul României',
    publication: 'Monitorul Oficial nr. 75 din 21 ianuarie 2005 (republicare)',
    urls: [],
    fetch: false,
    snapshots: [
      {
        url: 'https://xfactura.invalid/owner-download/oug_28_1999.pdf',
        sha256: '804efcb004c9ac9f4a84113c00fd4da3f4e47cd1f856fbf47debd0707fad06e8',
        retrievedOn: '2026-11-06',
        mediaType: 'application/pdf',
      },
    ],
  },
];

const cf = (id: string, locator: string, summary: string): Clause => ({
  id: `${CODE}:${id}`,
  source: CODE,
  locator,
  status: 'located',
  summary,
});

export const receiptClauses: readonly Clause[] = [
  {
    id: 'ANAF/AJFP-Ialomita-394-2026:termen',
    source: 'ANAF/AJFP-Ialomita-394-2026',
    locator: 'comunicat, primul paragraf',
    status: 'located',
    summary:
      'Miercuri, 30 septembrie 2026 este termenul limită de depunere a formularului 394 pentru perioada de raportare precedentă, cea declarată pentru decontul de TVA (art. 322).',
  },
  cf(
    'art.319(10)(a)',
    'art. 319 alin. (10) lit. a)',
    'Livrările prin magazinele de comerț cu amănuntul și prestările către populație cu bon fiscal (OUG nr. 28/1999) sunt scutite de obligația emiterii facturii, afară de cazul în care beneficiarul o cere.',
  ),
  cf(
    'art.319(12)',
    'art. 319 alin. (12)',
    'Se pot emite facturi simplificate când valoarea facturii, inclusiv TVA, nu este mai mare de 100 euro, la cursul de la art. 290; pentru documentele tratate drept factură (alin. (2)); pentru persoanele care aplică regimul de scutire (art. 310 și 310^2, lit. c) adăugată de OG nr. 22/2025 de la 01.09.2025).',
  ),
  cf(
    'art.319(13)',
    'art. 319 alin. (13)',
    'Pentru facturi între 100 și 400 euro, inclusiv TVA, conținutul simplificat se aprobă doar prin ordin al ministrului finanțelor, după consultarea Comitetului TVA, la cererea persoanei impozabile.',
  ),
  cf(
    'art.319(21)',
    'art. 319 alin. (21)',
    'Factura simplificată cuprinde cel puțin data emiterii, furnizorul, felul bunurilor sau serviciilor, TVA colectată sau datele pentru calculul ei și codul de înregistrare în scopuri de TVA sau codul de identificare fiscală al beneficiarului persoană impozabilă.',
  ),
  cf(
    'art.290(2)',
    'art. 290 alin. (2)',
    'Elementele în valută se convertesc la ultimul curs comunicat de BNR (sau publicat de BCE, ori al băncii prin care se fac decontările, dacă contractul o prevede), valabil la data exigibilității taxei.',
  ),
  cf(
    'art.299(1)(a)',
    'art. 299 alin. (1) lit. a)',
    'Pentru deducerea taxei aferente achizițiilor de la o persoană impozabilă, beneficiarul deține o factură emisă potrivit art. 319 (și dovada plății, sub TVA la încasare).',
  ),
  cf(
    'norme.art.299.pct.69(3),(6)',
    'normele metodologice, titlul VII pct. 69 alin. (3) și (6)',
    'Facturile simplificate (art. 319 alin. (12), (13), (21)) justifică deducerea numai dacă înscriu codul de înregistrare în scopuri de TVA al beneficiarului; bonurile fiscale emise potrivit OUG nr. 28/1999 justifică deducerea dacă îndeplinesc condițiile unei facturi simplificate și furnizorul a înscris pe bon, prin aparatul de marcat, codul de înregistrare în scopuri de TVA al beneficiarului.',
  ),
  cf(
    'art.331(1)-(3)',
    'art. 331 alin. (1)–(3)',
    'Taxarea inversă internă: beneficiarul plătește taxa pentru operațiunile enumerate (deșeuri și materiale reciclabile, masă lemnoasă, cereale și plante tehnice, certificate de emisii, energie electrică și gaze naturale către comercianți, certificate verzi, construcții și terenuri taxate, aur, telefoane mobile, circuite integrate, console, tablete și laptopuri), dacă ambele părți sunt înregistrate în scopuri de TVA (art. 316); furnizorul nu înscrie taxa pe factură, beneficiarul o înscrie în decont ca taxă colectată și deductibilă, deducând-o potrivit art. 297–301.',
  ),
  cf(
    'art.331(4)-(7)',
    'art. 331 alin. (4)–(7)',
    'Ambele părți răspund de aplicarea taxării inverse; se aplică doar operațiunilor din țară; lit. c)–f) și i)–l) se aplică până la 31 decembrie 2026 inclusiv; telefoanele, circuitele integrate, consolele, tabletele și laptopurile intră în taxarea inversă doar dacă valoarea lor fără TVA pe o factură este de cel puțin 22.500 lei.',
  ),
  cf(
    'norme.art.331.pct.109(1)',
    'normele metodologice, titlul VII pct. 109 alin. (1)',
    'Furnizorul nu înscrie taxa, nici pe avansuri, și înscrie mențiunea „taxare inversă”; beneficiarul calculează taxa și o înregistrează ca taxă colectată și deductibilă, prin formula 4426 = 4427, în perioada fiscală a exigibilității.',
  ),
  cf(
    'norme.art.331.pct.109(4)',
    'normele metodologice, titlul VII pct. 109 alin. (4)',
    'Dacă furnizorul facturează cu TVA o operațiune de la art. 331 alin. (2) fără mențiunea „taxare inversă”, beneficiarul care deduce taxa înscrisă își pierde dreptul de deducere.',
  ),
  cf(
    'norme.art.331.pct.109(7)',
    'normele metodologice, titlul VII pct. 109 alin. (7)',
    'Codurile NC ale cerealelor, plantelor tehnice, semințelor oleaginoase și sfeclei de zahăr: 1001, 1002, 1003, 1004, 1005, 10086000, 1201, 120400, 1205, 120600, 121291.',
  ),
  cf(
    'norme.art.331.pct.109(19)',
    'normele metodologice, titlul VII pct. 109 alin. (19)',
    'Pe o factură cu bunuri de la lit. i)–k) și alte bunuri, taxarea inversă se aplică doar dacă valoarea, fără TVA, a bunurilor de la lit. i)–k) împreună este de cel puțin 22.500 lei; celelalte se taxează normal.',
  ),
  {
    id: `${PORTAL}:art.319(12)`,
    source: PORTAL,
    locator: 'art. 319 alin. (12) cu nota de modificare',
    status: 'located',
    summary:
      'Forma portalului legislativ: limita de 100 euro a facturii simplificate; alin. (12) a fost completat doar cu lit. c) (OG nr. 22/2025, de la 01.09.2025), lit. a) neschimbată.',
  },
  {
    id: `${PORTAL}:art.331(6)`,
    source: PORTAL,
    locator: 'art. 331 alin. (6) cu nota de modificare',
    status: 'located',
    summary:
      'Alin. (6), care limitează lit. c)–f) și i)–l) la operațiunile până la 31 decembrie 2026 inclusiv, a fost modificat ultima dată de OUG nr. 85/2022.',
  },
  {
    id: 'OUG28/1999:art.1',
    source: 'OUG28/1999',
    locator: 'art. 1 alin. (1)–(2)',
    status: 'located',
    summary:
      'Cine încasează de la populație folosește aparate de marcat electronice fiscale, emite bonuri fiscale și le înmânează clienților; la cerere eliberează și factura. Codul cumpărătorului pe bon nu vine din acest text (până la 10.09.2018), ci din Codul fiscal art. 319 alin. (21) și normele pct. 69.',
  },
  {
    id: 'ANAF/D300-12.0.0:rd.12-13',
    source: 'ANAF/D300-12.0.0',
    locator:
      'rândurile 12, 12.1–12.5 (R12_*, R72, R73), 13 (R13_1) și 26 (R25_*, oglindă a rd. 12)',
    status: 'located',
    summary:
      'Achizițiile cu taxare inversă internă la rd. 12, pe cote, repetate ca deductibile la rd. 26; livrările cu taxare inversă la rd. 13, doar baza.',
  },
  {
    id: 'ANAF/D300-12.0.0:bifa',
    source: 'ANAF/D300-12.0.0',
    locator: 'câmpurile bifa_cereale, bifa_mob, bifa_disp, bifa_cons',
    status: 'located',
    summary:
      'Bifele livrărilor cu taxare inversă de cereale și plante tehnice, telefoane mobile, circuite integrate și console, tablete și laptopuri, a căror exigibilitate intervine în perioadă.',
  },
  {
    id: 'ANAF/D394:rezumat2',
    source: 'ANAF/D394',
    locator: 'secțiunea rezumat2, câmpurile bazaBFAI și TVABFAI (nr. 94–95)',
    status: 'located',
    summary:
      'Baza și TVA achizițiilor cu bonuri fiscale care îndeplinesc condițiile unei facturi simplificate și înscriu codul de TVA al beneficiarului, pe cote; nu intră în op1.',
  },
  {
    id: 'ANAF/D394:op1.V-C',
    source: 'ANAF/D394',
    locator:
      'secțiunile op1 (tip V și C, tip_N), op11 (codPR) și rezumat1 (facturiV, bazaV, facturiC, bazaC, tvaC, detaliu)',
    status: 'located',
    summary:
      'Livrările cu taxare inversă (V, cota 0) și achizițiile cu taxare inversă (C, la cota taxei), pe partener, cu defalcarea pe codurile de produs ale nomenclatorului.',
  },
  // The D394 instructions as consolidated to 17.09.2025 (OPANAF nr. 3.769/2015 anexa nr. 2).
  {
    id: 'OPANAF3769/2015-A:anexa2.sect1.litI.pct.1.5',
    source: 'OPANAF3769/2015-A',
    locator: 'anexa nr. 2 secțiunea 1 lit. I pct. 1.5',
    status: 'located',
    summary:
      'Se declară, pe cote, baza achizițiilor pentru care s-au primit bonuri fiscale care îndeplinesc condițiile unei facturi simplificate și au înscris codul de TVA al beneficiarului; facturile simplificate sunt excluse din numărul și valorile facturilor primite (lit. C pct. 8–11).',
  },
  {
    id: 'OPANAF3769/2015-A:anexa2.sect1.litC.pct.14-17',
    source: 'OPANAF3769/2015-A',
    locator: 'anexa nr. 2 secțiunea 1 lit. C pct. 14–17 și secțiunea a 2-a (taxarea inversă)',
    status: 'located',
    summary:
      'Livrările și achizițiile cu taxare inversă după art. 331 se declară separat de celelalte operațiuni: numărul facturilor, baza (și, la achiziții, TVA), pe fiecare cod de TVA al partenerului, categorie de bunuri sau servicii și cotă.',
  },
];
