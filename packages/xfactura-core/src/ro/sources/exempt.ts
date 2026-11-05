import type { Clause, LegalSource } from './index';

/*
 * The sources of exempt supplies, the pro-rata and the adjustments of deductible VAT (V2): the
 * exemptions of the Fiscal Code (art. 292, 294–296) and the right of deduction they give (art.
 * 297 alin. (4)), the option to tax immovable property (art. 292 alin. (3), norme pct. 57–59),
 * the pro-rata (art. 300, norme pct. 70), the adjustments of art. 304–306 (norme pct. 78–80), the
 * invoice's mention of an exemption (art. 319 alin. (20) lit. l)), the D300 rows of OPANAF nr.
 * 174/2026, the D394 lists of OPANAF nr. 3.769/2015 and the VATEX code list of EN 16931. Read on
 * 5 November 2026 in the snapshots registered here and in the register's main list. Kept apart
 * from that list, which spreads them in.
 */

export const exemptSources: readonly LegalSource[] = [
  {
    id: 'CEN/EN16931-UBL-1.3.17',
    kind: 'standard',
    title:
      'Artefactele de validare CEN EN 16931 pentru UBL, versiunea 1.3.17 (schematron, cu listele de coduri: VATEX, motivele scutirii de TVA, BT-121)',
    issuer: 'CEN / Comisia Europeană (Connecting Europe)',
    publication: null,
    urls: [
      'https://github.com/ConnectingEurope/eInvoicing-EN16931/releases/download/validation-1.3.17/en16931-ubl-1.3.17.zip',
    ],
    // Pinned as a validator (scripts/validators/sources.json) and fetched there.
    fetch: false,
    snapshots: [
      {
        url: 'https://github.com/ConnectingEurope/eInvoicing-EN16931/releases/download/validation-1.3.17/en16931-ubl-1.3.17.zip',
        sha256: 'bf02a0e3f6cbe692a4a28e70be7bdcaded5612b4169b543e13d6cb4f33c29e92',
        retrievedOn: null,
        mediaType: 'application/zip',
      },
    ],
  },
];

const CODE = 'ANAF/Cod-fiscal-consolidat';
const fiscal = (id: string, locator: string, summary: string): Clause => ({
  id: `${CODE}:${id}`,
  source: CODE,
  locator,
  status: 'located',
  summary,
});

export const exemptClauses: readonly Clause[] = [
  fiscal(
    'art.292(1)',
    'art. 292 alin. (1)',
    'Sunt scutite de taxă operațiunile de interes general: spitalizarea și îngrijirile medicale, serviciile stomatologice, învățământul și formarea profesională autorizate, asistența și protecția socială, activitățile culturale și sportive ale organizațiilor fără scop patrimonial și celelalte enumerate la lit. a)–r).',
  ),
  fiscal(
    'art.292(2)',
    'art. 292 alin. (2)',
    'Sunt, de asemenea, scutite: serviciile financiar-bancare (lit. a)), asigurările și reasigurările cu intermedierea lor (lit. b)), pariurile și jocurile de noroc autorizate (lit. c)), timbrele la valoarea nominală (lit. d)), închirierea și leasingul de bunuri imobile, cu excepțiile cazării, parcărilor, utilajelor fixate și seifurilor (lit. e)), livrarea construcțiilor vechi și a terenurilor neconstruibile (lit. f)) și livrarea bunurilor afectate unei activități scutite fără deducere (lit. g)).',
  ),
  fiscal(
    'art.292(3)',
    'art. 292 alin. (3)',
    'Orice persoană impozabilă poate opta pentru taxarea închirierii și leasingului de bunuri imobile și a livrării de construcții și terenuri (alin. (2) lit. e) și f)), în condițiile normelor.',
  ),
  fiscal(
    'norme.art.292.pct.57-59',
    'normele metodologice, titlul VII pct. 57–59',
    'Opțiunea de taxare a închirierii unui bun imobil sau a unei părți din el se notifică organului fiscal (anexa nr. 1) și se exercită de la data din notificare, cu o copie clientului; anularea ei se notifică (anexa nr. 2); cine optează fără să fi dedus taxa bunului face o ajustare în favoarea sa după art. 305, cine revine la scutire după ce a dedus o face în favoarea statului; la fel pentru livrarea de bunuri imobile (anexa nr. 3). Fără opțiune, taxarea unei operațiuni scutite se stornează (pct. 59).',
  ),
  fiscal(
    'art.294(1)',
    'art. 294 alin. (1)',
    'Sunt scutite cu drept de deducere exportul de bunuri expediate în afara Uniunii de furnizor sau de cumpărătorul nestabilit în România (lit. a)–b)), serviciile legate direct de export sau de import, transportul internațional, operațiunile cu nave și aeronave, livrările către misiuni diplomatice și organisme internaționale (lit. c)–p)).',
  ),
  fiscal(
    'art.294(2)',
    'art. 294 alin. (2)',
    'Sunt scutite livrările intracomunitare de bunuri către o persoană care îi comunică furnizorului un cod valabil de TVA atribuit de alt stat membru (lit. a)), cu excepțiile întreprinderilor mici și ale regimului marjei, livrările de mijloace de transport noi (lit. b)), de produse accizabile (lit. c)) și transferurile (lit. d)).',
  ),
  fiscal(
    'art.295',
    'art. 295',
    'Sunt scutite livrările de bunuri plasate în regimuri vamale speciale (antrepozit, admitere temporară, zonă liberă) și serviciile aferente lor, cât timp bunurile rămân în regim.',
  ),
  fiscal(
    'art.296',
    'art. 296',
    'Sunt scutite serviciile intermediarilor care acționează în numele și în contul altei persoane, legate de operațiunile scutite de la art. 294 și 295 (cu excepția art. 294 alin. (1) lit. f) și alin. (2)) sau desfășurate în afara Uniunii.',
  ),
  fiscal(
    'art.297(4)',
    'art. 297 alin. (4)',
    'Taxa se deduce pentru achizițiile destinate operațiunilor taxabile, celor cu locul în străinătate care ar fi deductibile în România, celor scutite de art. 292^1, 294, 295 și 296 și serviciilor financiare și de asigurare scutite de art. 292 alin. (2) lit. a) pct. 1–5 și lit. b) prestate unui client din afara Uniunii sau legate direct de bunuri exportate.',
  ),
  fiscal(
    'art.300(1)-(7)',
    'art. 300 alin. (1)–(7)',
    'Persoana impozabilă cu regim mixt deduce integral taxa achizițiilor destinate exclusiv operațiunilor cu drept de deducere, deloc pe a celor destinate exclusiv operațiunilor fără drept, iar pentru cele cu destinație necunoscută sau mixtă, pe bază de pro rata: operațiunile cu drept de deducere, fără TVA, raportate la totalul lor și al celor fără drept, cu sumele de la buget pentru operațiuni scutite fără drept de deducere la numitor; se exclud livrările de bunuri de capital, livrările către sine și operațiunile financiare și imobiliare accesorii activității principale.',
  ),
  fiscal(
    'art.300(8)-(14)',
    'art. 300 alin. (8)–(14)',
    'Pro rata definitivă se determină anual, din operațiunile cu exigibilitatea în an, procentual, rotunjită la unitatea imediat următoare; pro rata provizorie a anului este cea definitivă a anului precedent sau una estimată, comunicată organului fiscal până la 25 ianuarie (pentru noii înregistrați sau cei care devin mixți, până la primul decont); taxa se deduce provizoriu la pro rata provizorie, iar la sfârșitul anului diferența față de pro rata definitivă se înscrie în decontul ultimei perioade fiscale a anului (sau ultimul decont, la anularea înregistrării), cu un document care arată calculul.',
  ),
  fiscal(
    'art.300(15)',
    'art. 300 alin. (15)',
    'Pentru bunurile de capital deduse pe bază de pro rata definitivă, în fiecare dintre următorii 4 sau 19 ani se compară o cincime (o douăzecime) din taxa deductibilă inițială înmulțită cu pro rata definitivă a anului cu o cincime (o douăzecime) din taxa dedusă inițial, iar diferența se înscrie în decontul ultimei perioade fiscale a anului.',
  ),
  fiscal(
    'art.300(16)-(20)',
    'art. 300 alin. (16)–(20)',
    'Ministerul Finanțelor poate aproba sau impune o pro rata specială, pe sectoare de activitate sau pe operațiunile din decizie; persoanele care aplică TVA la încasare determină pro rata după exigibilitatea din regulile generale; persoana cu regim mixt poate opta să nu deducă taxa achizițiilor destinate ambelor feluri de operațiuni.',
  ),
  fiscal(
    'art.304',
    'art. 304',
    'Deducerea inițială se ajustează când este mai mare sau mai mică decât cea la care persoana avea dreptul, când se modifică elementele de calcul (inclusiv cazurile art. 287) și când persoana pierde sau câștigă dreptul de deducere pentru bunurile mobile nelivrate și serviciile neutilizate; nu se ajustează pentru bunurile distruse, pierdute sau furate, dovedite.',
  ),
  fiscal(
    'art.305(4)-(5),(7)',
    'art. 305 alin. (4), (5) și (7)',
    'Taxa bunurilor de capital se ajustează când bunul e folosit în alte scopuri decât activitatea economică, pentru operațiuni fără drept de deducere sau într-o măsură diferită de deducerea inițială, când se modifică elementele calculului (pro rata), când un bun cu deducerea limitată face obiectul unei operațiuni cu drept de deducere și când își încetează existența (nu la livrarea taxabilă, pierderea dovedită, casare); pentru schimbarea destinației, o cincime (o douăzecime) pe an, în perioada evenimentului sau în ultima a anului; la trecerea la scutirea întreprinderilor mici și la livrarea scutită (art. 292), respectiv invers și la livrarea taxabilă, o singură dată pentru toată perioada rămasă; la încetarea existenței, pentru toată taxa perioadei rămase; ajustările se repetă la fiecare eveniment.',
  ),
  fiscal(
    'art.306',
    'art. 306',
    'Pentru activele corporale fixe amortizabile cu durata normală de utilizare fiscală sub 5 ani (sau cele din leasing cu limita minimă sub 5 ani), achiziționate între aderare și 31.12.2015, care nu erau bunuri de capital, taxa se ajustează proporțional cu valoarea rămasă neamortizată la eveniment.',
  ),
  fiscal(
    'art.319(20)(l)',
    'art. 319 alin. (20) lit. l)',
    'Factura pentru o operațiune scutită cuprinde trimiterea la dispozițiile din titlul VII sau din Directiva 112 ori o altă mențiune din care rezultă scutirea.',
  ),
  fiscal(
    'norme.art.300.pct.70',
    'normele metodologice, titlul VII pct. 70',
    'Achizițiile alocabile parțial fiecărui fel de operațiuni se deduc direct, nu pe bază de pro rata; investițiile cu destinație mixtă se deduc integral în cursul procesului investițional și se ajustează după art. 305; operațiunile imobiliare sunt livrarea, închirierea, leasingul, arendarea și concesionarea bunurilor imobile; o operațiune este accesorie dacă, cumulativ, cere resurse tehnice și personal limitate, nu e direct legată de activitatea principală și are achiziții și TVA nesemnificative; erorile de calcul al pro ratei definitive se regularizează în decontul perioadei în care sunt constatate.',
  ),
  fiscal(
    'norme.art.304.pct.78',
    'normele metodologice, titlul VII pct. 78',
    'Se ajustează taxa serviciilor neutilizate (imobilizările necorporale neamortizate complet, pentru valoarea rămasă; celelalte servicii se consideră utilizate în perioada achiziției), a stocurilor și a activelor corporale fixe în curs, pozitiv sau negativ, în decontul perioadei evenimentului, inclusiv la trecerea între pro rata provizorie și cea definitivă și la înregistrarea sau anularea înregistrării; ajustarea se face la cota de la data achiziției.',
  ),
  fiscal(
    'norme.art.305.pct.79(1)-(2)',
    'normele metodologice, titlul VII pct. 79 alin. (1)–(2)',
    'La schimbarea destinației unui bun de capital, modificarea se consideră produsă în anul evenimentului și în fiecare an următor cât timp se menține, ajustându-se o cincime (o douăzecime) pe an, pozitiv sau negativ, în decontul perioadei evenimentului și în decontul ultimei perioade a fiecărui an; persoana ține registrul bunurilor de capital: data achiziției, baza de impozitare, taxa deductibilă, taxa dedusă și ajustările.',
  ),
  fiscal(
    'norme.art.305.pct.79(4)',
    'normele metodologice, titlul VII pct. 79 alin. (4)',
    'În sensul art. 305 alin. (9), nu se ajustează taxa unui bun de capital dacă fiecare ajustare ar fi mai mică de 1.000 lei.',
  ),
  fiscal(
    'norme.art.306.pct.80',
    'normele metodologice, titlul VII pct. 80',
    'Pentru activele de la art. 306, ajustarea se face numai la evenimentele art. 305 alin. (4), proporțional cu valoarea rămasă neamortizată, la cota de la data achiziției; activele complet amortizate nu se mai ajustează.',
  ),
  {
    id: 'LJR/Cod-fiscal-2025:art.305(9)',
    source: 'LJR/Cod-fiscal-2025',
    locator: 'art. 305 alin. (9), cu nota de abrogare',
    status: 'located',
    summary:
      'Alineatul (9) al art. 305 este abrogat de la 01.07.2024 prin OUG nr. 78/2024 (art. I pct. 3 lit. A), publicată în Monitorul Oficial nr. 596 din 26 iunie 2024.',
  },
  {
    id: 'OPANAF174/2026:pro_rata',
    source: 'OPANAF174/2026',
    locator: 'anexa nr. 2, rubrica „Pro rata de deducere %”',
    status: 'located',
    summary: 'În rubrica „Pro rata de deducere %” se înscrie pro rata determinată după art. 300.',
  },
  {
    id: 'OPANAF174/2026:rd.1',
    source: 'OPANAF174/2026',
    locator: 'anexa nr. 2, instrucțiunile rândului 1',
    status: 'located',
    summary:
      'Rândul 1 cuprinde baza livrărilor intracomunitare de bunuri scutite după art. 294 alin. (2) lit. a) și d), cu exigibilitatea în perioadă.',
  },
  {
    id: 'OPANAF174/2026:rd.14-15',
    source: 'OPANAF174/2026',
    locator: 'anexa nr. 2, instrucțiunile rândurilor 14 și 15',
    status: 'located',
    summary:
      'Rândul 14 cuprinde baza operațiunilor scutite cu drept de deducere (art. 294 alin. (1), 295, 296; art. 292 alin. (2) lit. a) pct. 1–5 și lit. b) pentru clienți din afara Uniunii), rândul 15 baza operațiunilor scutite fără drept de deducere (art. 292).',
  },
  {
    id: 'OPANAF174/2026:rd.29',
    source: 'OPANAF174/2026',
    locator: 'anexa nr. 2, instrucțiunile rândului 29',
    status: 'located',
    summary:
      'Rândul 29 cuprinde contravaloarea achizițiilor scutite, neimpozabile sau supuse unui regim special, a celor din alte state membre fără TVA în România și a importurilor scutite; sumele care nu sunt incluse în baza impozabilă nu se înscriu obligatoriu.',
  },
  {
    id: 'OPANAF174/2026:rd.31',
    source: 'OPANAF174/2026',
    locator: 'anexa nr. 2, instrucțiunile rândului 31',
    status: 'located',
    summary:
      'Rândul 31 cuprinde taxa efectiv dedusă: pentru persoanele cu regim mixt, taxa achizițiilor destinate operațiunilor cu drept de deducere și taxa dedusă pe bază de pro rata a celor destinate ambelor feluri de operațiuni, nu și a celor fără drept de deducere.',
  },
  {
    id: 'OPANAF3769/2015:anexa2.sect2',
    source: 'OPANAF3769/2015',
    locator: 'anexa nr. 2, secțiunea a 2-a pct. 2',
    status: 'located',
    summary:
      'Listele declarației informative cuprind operațiunile taxabile pe teritoriul național, pe tipuri: L, A, AI, V, C și N, achizițiile de la persoane neînregistrate în scopuri de TVA.',
  },
  {
    id: 'CEN/EN16931-UBL-1.3.17:VATEX',
    source: 'CEN/EN16931-UBL-1.3.17',
    locator: 'schematron/codelist/EN16931-UBL-codes.sch, lista codurilor VATEX (BR-CL-22)',
    status: 'located',
    summary:
      'Codurile motivelor de scutire de TVA (BT-121): VATEX-EU-132 și 132-1A–1Q (art. 132 din Directivă, activități de interes general), VATEX-EU-135-1 (art. 135 alin. (1): financiare, asigurări, imobile), VATEX-EU-144, 146-1E, 148, 151 (exporturi și operațiuni similare), VATEX-EU-153, 159, VATEX-EU-G (export), VATEX-EU-IC (livrare intracomunitară), VATEX-EU-AE și VATEX-EU-O.',
  },
];
