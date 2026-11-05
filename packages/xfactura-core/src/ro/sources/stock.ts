import type { Clause, LegalSource } from './index';

/*
 * The sources of the stock register (G1): OMFP nr. 1.802/2014 in its 2014 text (ANAF's copy) for
 * the account functions and the rules the 2022 consolidation leaves word for word, and the
 * consolidation (OMFP1802/2014-A) for pct. 95–96 and 272–276; the Codul fiscal's VAT and profit-
 * tax consequences of shortages, perishables and write-downs; the inventory norms' compensation
 * and allowances (OMF nr. 2.861/2009, the portal's copy); D406's stock file (OPANAF nr.
 * 1.783/2021, ANAF's guide, answers and structure); and OMFP nr. 2.634/2015, whose order and
 * annexes 1 and 4 only are available: the forms' own norms and models (annexes 2 and 3, MO 910
 * bis) were not obtained.
 */

export const stockSources: readonly LegalSource[] = [
  {
    id: 'OMFP2634/2015',
    kind: 'act',
    title:
      'Ordinul ministrului finanțelor publice nr. 2.634/2015 privind documentele financiar-contabile (ordinul și anexele nr. 1 și 4)',
    issuer: 'Ministerul Finanțelor Publice',
    publication: 'Monitorul Oficial nr. 910 din 9 decembrie 2015',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_2634_2015.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_2634_2015.pdf',
        sha256: '295230f6e767e378fa293dff1bc5a02362e876f9dd8b4183de5e41946863c7ff',
        retrievedOn: null,
        mediaType: 'application/pdf',
      },
    ],
  },
];

const clause = (source: string, id: string, locator: string, summary: string): Clause => ({
  id: `${source}:${id}`,
  source,
  locator,
  status: 'located',
  summary,
});

export const stockClauses: readonly Clause[] = [
  clause(
    'OMFP1802/2014',
    'pct.8(6)',
    'pct. 8 pct. 6',
    'Costul de achiziție este prețul datorat și cheltuielile conexe: taxele de import și celelalte taxe nerecuperabile, transportul, manipularea și celelalte cheltuieli direct atribuibile; reducerile comerciale se scad.',
  ),
  clause(
    'OMFP1802/2014',
    'pct.75(1)',
    'pct. 75 alin. (1)',
    'La intrare, bunurile se evaluează la costul de achiziție (cele cumpărate), la costul de producție (cele produse), la valoarea de aport sau la valoarea justă (cele primite cu titlu gratuit sau constatate plus la inventariere).',
  ),
  clause(
    'OMFP1802/2014',
    'pct.76',
    'pct. 76',
    'Reducerile comerciale acordate de furnizor și cuprinse în factură diminuează costul de achiziție; cele primite ulterior facturării se înregistrează distinct (609), dacă nu corectează costul stocurilor la care se referă.',
  ),
  clause(
    'OMFP1802/2014',
    'pct.88',
    'pct. 88',
    'Stocurile se evaluează la cost minus ajustările pentru depreciere; valoarea realizabilă netă este prețul de vânzare estimat minus costurile estimate pentru finalizare și cele necesare vânzării.',
  ),
  clause(
    'OMFP1802/2014-A',
    'pct.95-96',
    'pct. 95 alin. (1) și pct. 96',
    'La ieșire sau la darea în consum, bunurile se scad din gestiune la valoarea de intrare; costul stocurilor fungibile se calculează prin CMP (media calculată periodic sau după fiecare recepție, pe o perioadă nu mai lungă decât durata medie de stocare), FIFO sau LIFO.',
  ),
  clause(
    'OMFP1802/2014',
    'pct.95(2)-(3)',
    'pct. 95 alin. (2)–(3)',
    'Activele constatate lipsă se scot din evidență la data constatării; la scoaterea din evidență se reiau la venituri ajustările pentru depreciere aferente.',
  ),
  clause(
    'OMFP1802/2014-A',
    'pct.272-276',
    'pct. 272–276',
    'Stocurile sunt active circulante deținute pentru vânzare, în curs de producție sau ca materii prime și materiale; cuprind mărfurile, materiile prime, materialele consumabile, materialele de natura obiectelor de inventar, produsele, ambalajele și producția în curs.',
  ),
  clause(
    'OMFP1802/2014',
    'pct.283-284',
    'pct. 283–284',
    'Intrarea stocurilor se înregistrează la transferul riscurilor și beneficiilor; bunurile sosite fără factură se înregistrează ca intrări în gestiune pe baza recepției și a documentelor însoțitoare; bunurile livrate nefacturate ies din gestiune.',
  ),
  clause(
    'OMFP1802/2014',
    'pct.285-286',
    'pct. 285–286',
    'Costul stocurilor nefungibile se determină prin identificare specifică; pot fi folosite și costul standard, în producție, și metoda prețului cu amănuntul, în comerțul cu amănuntul, pentru articole numeroase cu mișcare rapidă și marje similare: costul bunurilor vândute este prețul de vânzare minus marja; diferențele de preț se repartizează cu un coeficient, fără TVA neexigibilă.',
  ),
  clause(
    'OMFP1802/2014',
    'pct.287',
    'pct. 287',
    'Metoda aleasă se aplică cu consecvență de la un exercițiu la altul pentru elementele similare; schimbarea ei se prezintă în note, cu motivul și efectele asupra rezultatului.',
  ),
  clause(
    'OMFP1802/2014',
    'pct.289-292',
    'pct. 289–292',
    'Stocurile se țin prin inventarul permanent (toate intrările și ieșirile, stocul cunoscut oricând) sau intermitent (intrările pe cheltuieli, ieșirile stabilite prin inventarierea de la sfârșitul perioadei, cel târziu la finele perioadei pentru care se stabilesc obligațiile fiscale); stocurile se diminuează la valoarea realizabilă netă prin ajustări pentru depreciere.',
  ),
  clause(
    'OMFP1802/2014',
    'plan.clasa3',
    'planul de conturi general, clasa 3',
    'Clasa 3: stocuri de materii prime și materiale (301–308), în curs de aprovizionare (32x), producția în curs (33x), produse (34x), stocuri la terți (35x), active biologice (36x), mărfuri (371, 378), ambalaje (381, 388), ajustări pentru depreciere (39x).',
  ),
  clause(
    'OMFP1802/2014',
    'conturi.30',
    'funcțiunile conturilor 301–308',
    'Conturile 301–303 se debitează cu intrările la preț de înregistrare și plusurile de inventar (601–603) și se creditează cu valoarea celor date în consum și a lipsurilor (601–603); la inventarul intermitent, stocul se înregistrează la sfârșitul perioadei și se reia pe cheltuieli la începutul celei următoare.',
  ),
  clause(
    'OMFP1802/2014',
    'conturi.371-378',
    'funcțiunile conturilor 371 și 378',
    'Contul 371 se debitează cu mărfurile achiziționate (401, 408), cu plusurile de inventar (607) și, la evidența la preț cu amănuntul, cu adaosul comercial și TVA neexigibilă (378, 4428); se creditează cu mărfurile vândute și lipsurile la inventar (607). Contul 378 ține adaosul comercial: creditat la intrare, debitat la ieșire.',
  ),
  clause(
    'OMFP1802/2014',
    'conturi.381-388',
    'funcțiunile conturilor 381 și 388',
    'Contul 381 se debitează cu ambalajele achiziționate și plusurile de inventar (608) și se creditează cu ambalajele consumate și lipsurile la inventar (608).',
  ),
  clause(
    'OMFP1802/2014',
    'conturi.39',
    'funcțiunile conturilor grupei 39',
    'Ajustările pentru deprecierea stocurilor (391–398) se creditează cu ajustările constituite sau majorate (681) și se debitează cu cele diminuate sau anulate (781).',
  ),
  clause(
    'OMFP1802/2014',
    'conturi.401(intermitent)',
    'funcțiunea contului 401 (inventarul intermitent)',
    'La inventarul intermitent, aprovizionările de materii prime, materiale, mărfuri și ambalaje se înregistrează direct pe cheltuieli (601, 602, 603, 607, 608).',
  ),
  clause(
    'OMFP1802/2014',
    'conturi.408',
    'funcțiunea contului 408',
    'Contul 408 se creditează cu valoarea bunurilor aprovizionate pentru care nu s-a primit factura (301, 302, 303, 361, 371, 381, 4428, …) și se debitează cu valoarea facturilor sosite (401).',
  ),
  clause(
    'OMFP1802/2014',
    'conturi.4428',
    'funcțiunea contului 4428',
    'Contul 4428 ține TVA neexigibilă: în cazurile prevăzute de lege, TVA aferentă bunurilor și serviciilor la care exigibilitatea nu a intervenit, și TVA cuprinsă în prețul cu amănuntul al mărfurilor (371).',
  ),
  clause(
    'OMFP1802/2014',
    'conturi.60',
    'funcțiunile conturilor grupei 60',
    'Conturile 601–608 se debitează cu valoarea stocurilor date în consum, vândute, constatate lipsă la inventar sau depreciate ireversibil, și, la inventarul intermitent, cu aprovizionările (401); 609 ține reducerile comerciale primite ulterior care nu corectează costul stocurilor.',
  ),
  clause(
    'OMFP1802/2014',
    'conturi.681',
    'funcțiunea contului 681',
    'Contul 681 se debitează, între altele, cu ajustările pentru deprecierea stocurilor constituite sau majorate (391 la 398).',
  ),
  clause(
    'OMFP1802/2014',
    'conturi.781',
    'funcțiunea contului 781',
    'Contul 781 se creditează, între altele, cu ajustările pentru deprecierea stocurilor diminuate sau anulate (391 la 398).',
  ),
  clause(
    'OMFP1802/2014',
    'conturi.707',
    'funcțiunea contului 707',
    'Contul 707 ține veniturile din vânzarea mărfurilor.',
  ),
  clause(
    'ANAF/Cod-fiscal-consolidat',
    'norme.art.270.pct.7(5)',
    'normele metodologice, titlul VII pct. 7 alin. (5)',
    'Bunurile constatate lipsă din gestiune nu sunt livrări de bunuri; li se aplică art. 304–306 și pct. 78–80 din norme.',
  ),
  clause(
    'ANAF/Cod-fiscal-consolidat',
    'art.304(1)-(2)',
    'art. 304 alin. (1)–(2)',
    'Deducerea inițială se ajustează, între altele, când bunurile sunt lipsă; nu se ajustează pentru bunurile distruse, pierdute sau furate, dovedite, și în situațiile art. 270 alin. (8) și art. 271 alin. (5).',
  ),
  clause(
    'ANAF/Cod-fiscal-consolidat',
    'norme.art.304.pct.78(10)-(13)',
    'normele metodologice, titlul VII pct. 78 alin. (10)–(13)',
    'Nu se ajustează taxa pentru bunurile distruse prin calamități sau forță majoră, furate dovedit, degradate calitativ distruse dovedit, pierderile tehnologice și perisabilitățile în limitele stabilite prin lege; persoana impozabilă face dovada; ajustarea se face la cota din data obligației.',
  ),
  clause(
    'ANAF/Cod-fiscal-consolidat',
    'art.25(3)(d)',
    'art. 25 alin. (3) lit. a)–d)',
    'Au deductibilitate limitată, între altele, scăzămintele, perisabilitățile și pierderile din manipulare sau depozitare, potrivit legii.',
  ),
  clause(
    'OMF2861/2009-A',
    'pct.40',
    'anexa, pct. 40',
    'Plusurile se înregistrează în gestiune; lipsurile neimputabile, ca pierderi; compensarea lipsurilor cu plusurile se admite doar pentru riscul de confuzie între sorturi, în aceeași perioadă și gestiune, pentru cantități egale, fără furt sau sustragere, cu lista sorturilor aprobată anual.',
  ),
  clause(
    'OMF2861/2009-A',
    'pct.41',
    'anexa, pct. 41',
    'Scăzămintele (perisabilitățile) se calculează numai după compensare și numai dacă rămân lipsuri, ca limite maxime, potrivit normelor legale.',
  ),
  clause(
    'OPANAF1783/2021',
    'anexa4.pct.9-10',
    'anexa nr. 4 pct. 9–10',
    'Informațiile privind stocurile și producția în curs se raportează în D406 numai la solicitarea organului fiscal, într-un termen de cel puțin 30 de zile de la solicitare.',
  ),
  clause(
    'ANAF/SAFT_Ghid_2021',
    '4.6.stocuri',
    'secțiunea 4.6 (stocuri)',
    'La cerere se raportează secțiunile privind stocurile: UOMTable, MovementTypeTable, Products, PhysicalStock, Owners și MovementOfGoods.',
  ),
  clause(
    'ANAF/SAFT_FAQ_2022',
    'MovementOfGoods',
    'întrebarea privind subsecțiunea StockMovement',
    'În StockMovement se raportează mișcările de stocuri pe baza documentelor, pentru perioada din solicitarea ANAF.',
  ),
  clause(
    'ANAF/D406',
    'S.H.11',
    'structura, câmpul S.H.11 HeaderComment',
    'HeaderComment: L lunar, T trimestrial, A anual, C pentru declarațiile la cerere.',
  ),
  clause(
    'ANAF/D406',
    'Nomenclator_stocuri',
    'foaia Nomenclator stocuri',
    'Codurile mișcărilor de stoc (MovementType): 10 achiziție, 30 vânzare, 40 retur vânzare, 50 retur achiziție, 70 consum, 80 transfer intern, 110 plus și 120 minus de inventar, 130 ajustări, 140 reluări, 180 alte tranzacții etc.',
  ),
  clause(
    'ANAF/D406',
    'xsd.PhysicalStock',
    'schema, elementul PhysicalStock',
    'PhysicalStockEntry: gestiunea, produsul, lotul, contul de stoc, tipul, stocul inițial și final în cantitate și valoare, metoda de evaluare.',
  ),
  clause(
    'ANAF/D406',
    'xsd.MovementOfGoods',
    'schema, elementul MovementOfGoods',
    'MovementOfGoods: numărul de linii, cantitățile intrate și ieșite, fiecare mișcare cu referința, data, tipul și liniile ei (produs, cantitate, unitate, valoare).',
  ),
  clause(
    'OMFP2634/2015',
    'anexa1.pct.2',
    'anexa nr. 1 pct. 2',
    'Documentele justificative cuprind: denumirea, numărul și data, entitatea, părțile, conținutul operațiunii, datele cantitative și valorice, semnăturile celor care răspund de operațiune.',
  ),
  clause(
    'OMFP2634/2015',
    'anexa4',
    'anexa nr. 4',
    'Nota de recepție și constatare de diferențe (14-3-1A), bonul de predare, transfer, restituire (14-3-3A), bonul de consum (14-3-4A), fișa de magazie (14-3-8) și lista de inventariere (14-3-12) se păstrează 5 ani.',
  ),
];
