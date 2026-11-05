import type { Clause, LegalSource } from './index';

/*
 * The sources of the year-end in full (Y1): the annual inventory (OMF nr. 2.861/2009, its
 * original text as ANAF publishes it; amendments after 2009 are not verified, the legislative
 * portal refusing automated access), the evaluation at the inventory, impairments and provisions
 * of OMFP nr. 1.802/2014 (its 2014 text, kept in .sources/OMFP1802_2014/), and the clauses of the
 * Codul fiscal that decide the VAT and profit-tax consequences, read in ANAF's consolidated text.
 * Kept apart from the register's main list, which spreads them in.
 */

const OMFP = 'OMFP1802/2014';
const OMF = 'OMF2861/2009';
const CF = 'ANAF/Cod-fiscal-consolidat';

export const yearEndSources: readonly LegalSource[] = [
  {
    id: OMF,
    kind: 'act',
    title:
      'Ordinul ministrului finanțelor publice nr. 2.861/2009 pentru aprobarea Normelor privind organizarea și efectuarea inventarierii elementelor de natura activelor, datoriilor și capitalurilor proprii (textul inițial, publicat de ANAF)',
    issuer: 'Ministerul Finanțelor Publice',
    publication: 'Monitorul Oficial nr. 704 din 20 octombrie 2009',
    urls: ['https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_2861_2009.pdf'],
    fetch: true,
    snapshots: [
      {
        url: 'https://static.anaf.ro/static/10/Anaf/legislatie/OMFP_2861_2009.pdf',
        sha256: '68fd7d1ce53b8b2263b3f0e051e687c105b228138d7008bb6701f3deba2a2769',
        retrievedOn: '2026-11-05',
        mediaType: 'application/pdf',
      },
    ],
  }, // The norms as the legislative portal publishes them, downloaded by the owner: the portal shows
  // no amendment since 2009, so the original above is the text in force. This copy keeps the
  // Romanian diacritics the ANAF scan's text layer lacks.
  {
    id: 'OMF2861/2009-A',
    kind: 'act',
    title:
      'Normele privind organizarea și efectuarea inventarierii elementelor de natura activelor, datoriilor și capitalurilor proprii, aprobate prin OMFP nr. 2.861/2009 (portalul legislativ, fără modificări de la publicare)',
    issuer: 'Ministerul Finanțelor Publice',
    publication: 'Monitorul Oficial nr. 704 din 20 octombrie 2009',
    urls: [],
    fetch: false,
    snapshots: [
      {
        url: 'https://xfactura.invalid/owner-download/NORMA_09_10_2009.pdf',
        sha256: 'e2685102d4a20cae415a9d17de981ffec55bfe4479ad1aa6f332cd721fba7670',
        retrievedOn: '2026-11-06',
        mediaType: 'application/pdf',
      },
    ],
  },
];

const omfp = (id: string, locator: string, summary: string): Clause => ({
  id: `${OMFP}:${id}`,
  source: OMFP,
  locator,
  status: 'located',
  summary,
});
const omf = (id: string, locator: string, summary: string): Clause => ({
  id: `${OMF}:${id}`,
  source: OMF,
  locator,
  status: 'located',
  summary,
});
const fiscal = (id: string, locator: string, summary: string): Clause => ({
  id: `${CF}:${id}`,
  source: CF,
  locator,
  status: 'located',
  summary,
});

export const yearEndClauses: readonly Clause[] = [
  // The annual inventory (OMF nr. 2.861/2009, the norms in its annex).
  omf(
    'pct.1-2',
    'anexa, pct. 1 și pct. 2 alin. (1)',
    'Inventarierea constată existența tuturor elementelor de activ, de datorii și de capitaluri proprii, cantitativ-valoric sau valoric, la data efectuării ei, pentru situațiile financiare anuale; se face la începutul activității, cel puțin o dată în cursul exercițiului financiar, la fuziune sau încetare și în celelalte cazuri prevăzute.',
  ),
  omf(
    'pct.4',
    'anexa, pct. 4 alin. (1)–(2)',
    'Inventarierea anuală se face, de regulă, la încheierea exercițiului financiar; bunurile pot fi inventariate și înainte, cu condiția ca rezultatele să fie cuprinse în situațiile financiare ale exercițiului.',
  ),
  omf(
    'pct.6',
    'anexa, pct. 6 alin. (1)–(2) și (7)',
    'Inventarierea se efectuează de comisii numite prin decizie scrisă (componența, modul și metoda de inventariere, gestiunea, datele de început și de sfârșit); la entitățile cu puțini salariați, de o singură persoană; fără salariați, de administratori.',
  ),
  omf(
    'pct.28',
    'anexa, pct. 28 alin. (1)',
    'Creanțele și datoriile față de terți se verifică și se confirmă pe baza extraselor de cont ale soldurilor sau a punctajelor reciproce scrise; nerespectarea și refuzul de confirmare sunt abateri.',
  ),
  omf(
    'pct.29',
    'anexa, pct. 29 alin. (2)–(3)',
    'Disponibilitățile din bănci se inventariază confruntând soldurile din extrasele de cont din 31 decembrie (sau ultima zi bancară) cu contabilitatea; numerarul din casierie, în ultima zi lucrătoare a exercițiului, confruntând registrul de casă cu monetarul și cu contabilitatea.',
  ),
  omf(
    'pct.34-35',
    'anexa, pct. 34 alin. (2) și pct. 35 alin. (1)',
    'În listele de inventariere imobilizările și celelalte active cu ajustări se înscriu la valoarea contabilă minus ajustările, comparată cu valoarea actuală constatată; rezultatele inventarierii se stabilesc comparând datele constatate și înscrise în liste cu evidența tehnico-operativă și cu contabilitatea.',
  ),
  omf(
    'pct.37-38',
    'anexa, pct. 37 și pct. 38',
    'Valoarea de inventar se stabilește după principiul prudenței: când e mai mare decât valoarea contabilă se înscrie valoarea contabilă, când e mai mică, valoarea de inventar; pentru activele depreciate comisia propune ajustări pentru depreciere sau amortizări suplimentare, cu cauzele lor.',
  ),
  omf(
    'pct.39-40',
    'anexa, pct. 39 și pct. 40 alin. (1)–(2)',
    'Pentru plusuri, lipsuri și deprecieri comisia cere explicații scrise și propune regularizarea; plusurile se evaluează potrivit reglementărilor contabile; lipsurile imputabile se impută persoanelor vinovate la valoarea de înlocuire (costul de achiziție al unui bun similar, cu taxele nerecuperabile, inclusiv TVA, și cheltuielile de punere în stare de utilitate).',
  ),
  omf(
    'pct.42-43',
    'anexa, pct. 42 și pct. 43',
    'Rezultatele inventarierii se înscriu de comisie într-un proces-verbal (gestiunile, rezultatele, cauzele plusurilor și lipsurilor, persoanele vinovate, propunerile); propunerile se prezintă administratorului în cel mult 7 zile lucrătoare de la încheierea operațiunilor, iar acesta decide asupra lor.',
  ),
  omf(
    'pct.44-45',
    'anexa, pct. 44 alin. (1), (3) și pct. 45',
    'Registrul-inventar cuprinde rezultatele inventarierii grupate după posturile bilanțului și se completează când se stabilesc soldurile tuturor conturilor bilanțiere, impozitul pe profit și ajustările incluse; rezultatele se înregistrează în evidența tehnico-operativă în cel mult 7 zile lucrătoare de la aprobarea procesului-verbal și în contabilitate potrivit reglementărilor contabile.',
  ),
  omf(
    'pct.46(3)',
    'anexa, pct. 46 alin. (3) (în punctul privind instituțiile publice)',
    'Bunurile constatate lipsă la inventariere se evaluează și se înregistrează în contabilitate la valoarea contabilă; lipsurile imputabile se recuperează de la persoanele vinovate la valoarea de înlocuire; bunurile constatate în plus se înregistrează la costul de achiziție; pagubele imputate se urmăresc în conturi analitice distincte, pe fiecare debitor.',
  ),
  // The evaluation at the inventory, impairments and provisions (OMFP nr. 1.802/2014).
  omfp(
    'pct.82-84',
    'pct. 82–84',
    'Elementele se evaluează la valoarea contabilă pusă de acord cu rezultatele inventarierii; valoarea de inventar este cea stabilită la inventariere; potrivit principiului prudenței, diferențele în minus ale activelor evaluate la cost se înregistrează în conturi de ajustări, activele rămânând la valoarea de intrare.',
  ),
  omfp(
    'pct.85-86',
    'pct. 85–86',
    'Imobilizările se evaluează la valoarea de inventar stabilită de comisia de inventariere sau de evaluatori; corecția se face prin amortizare suplimentară pentru o depreciere ireversibilă sau prin ajustări pentru o depreciere reversibilă, cu indiciile din surse externe și interne; reluarea ajustărilor are la bază constatările comisiei.',
  ),
  omfp(
    'pct.89',
    'pct. 89',
    'Creanțele și datoriile se evaluează la valoarea probabilă de încasare sau de plată; diferențele în minus ale creanțelor se înregistrează pe seama ajustărilor pentru depreciere; pentru creanțele incerte se constituie ajustări; cele în valută se evaluează la cursul BNR valabil la încheierea exercițiului.',
  ),
  omfp(
    'pct.90',
    'pct. 90 alin. (1)–(2)',
    'Disponibilitățile bănești și valorile din casierie se prezintă potrivit legii; cele în valută se evaluează în bilanț la cursul BNR valabil la încheierea exercițiului financiar.',
  ),
  omfp(
    'pct.94',
    'pct. 94 lit. a)–c)',
    'La fiecare dată a bilanțului elementele monetare în valută (disponibilități, depozite, creanțe și datorii) se evaluează la cursul BNR valabil la încheierea exercițiului, diferențele mergând la venituri sau cheltuieli din diferențe de curs; cele în lei decontate după cursul unei valute, la alte venituri sau cheltuieli financiare; elementele nemonetare la cost rămân la cursul tranzacției.',
  ),
  omfp(
    'pct.95',
    'pct. 95 alin. (2)–(3)',
    'Activele constatate lipsă în gestiune se scot din evidență la data constatării lipsei; la scoaterea din evidență se reiau la venituri ajustările pentru depreciere aferente lor.',
  ),
  omfp(
    'pct.325',
    'pct. 325 alin. (1)–(3)',
    'La finele fiecărei luni creanțele și datoriile în valută, disponibilitățile și celelalte valori de trezorerie în valută existente în sold se evaluează la cursul BNR din ultima zi bancară a lunii; diferențele se recunosc la venituri sau cheltuieli din diferențe de curs; pentru cele în lei decontate după cursul unei valute, la alte venituri sau cheltuieli financiare.',
  ),
  omfp(
    'pct.331-332',
    'pct. 331–332',
    'Creanțele incerte se înregistrează distinct (4118 sau conturi analitice); în situațiile financiare creanțele se evaluează la valoarea probabilă de încasat, iar când se estimează că nu se vor încasa integral se înregistrează ajustări la nivelul sumei care nu se mai poate recupera.',
  ),
  omfp(
    'pct.335,338',
    'pct. 335 și pct. 338 alin. (1)–(2)',
    'Primele din profit se recunosc ca provizion când există o obligație legală sau implicită și o estimare certă, reluat la venituri în exercițiul acordării; concediile de odihnă neefectuate se înregistrează pe seama datoriilor când suma lor este comensurată pe baza statelor de salarii sau a altor documente justificative, altfel pe seama provizioanelor; la fel bonusurile acordate angajaților.',
  ),
  omfp(
    'pct.351',
    'pct. 351 alin. (1)–(2)',
    'Cheltuielile și veniturile exercițiului curent care privesc exercițiile următoare se înregistrează distinct, la cheltuieli în avans (471) sau venituri în avans (472): chirii, abonamente, asigurări și altele asemenea.',
  ),
  omfp(
    'pct.353',
    'pct. 353',
    'Pentru deprecierea creanțelor din conturile de clienți, decontări în cadrul grupului și debitori, cu ocazia inventarierii de la sfârșitul exercițiului se reflectă ajustări pentru pierdere de valoare.',
  ),
  omfp(
    'pct.369-377',
    'pct. 369–377',
    'Provizioanele acoperă datorii de natură clar definită, probabile sau certe la data bilanțului, incerte ca valoare sau dată; un provizion se recunoaște doar pentru o obligație curentă (legală sau implicită) generată de un eveniment anterior, cu o ieșire de resurse probabilă și o estimare credibilă; se constituie pentru litigii, garanții acordate clienților, restructurare, pensii, impozite, terminarea contractului de muncă, prime din profit și altele, ținute pe feluri.',
  ),
  omfp(
    'pct.387-388',
    'pct. 387 alin. (1)–(2) și pct. 388',
    'Provizionul este cea mai bună estimare la data bilanțului a costurilor necesare stingerii obligației; se revizuiește la fiecare bilanț și se ajustează, iar când ieșirea de resurse nu mai e probabilă se anulează prin reluare la venituri; se folosește doar pentru scopul inițial; se evaluează înaintea determinării impozitului pe profit.',
  ),
  omfp(
    'conturi.151',
    'funcțiunea contului 151',
    'Contul 151 se creditează cu provizioanele constituite pe seama cheltuielilor (681) și se debitează cu diminuarea sau anularea lor (781); soldul reprezintă provizioanele constituite.',
  ),
  omfp(
    'conturi.291',
    'funcțiunea contului 291',
    'Contul 291 se creditează cu constituirea sau suplimentarea ajustărilor pentru deprecierea imobilizărilor corporale (681) și se debitează cu diminuarea sau anularea lor (781).',
  ),
  omfp(
    'conturi.491',
    'funcțiunea contului 491',
    'Contul 491 se creditează cu ajustările constituite pentru clienți incerți, dubioși, rău-platnici sau în litigiu (681) și se debitează cu diminuarea sau anularea lor (781).',
  ),
  omfp(
    'conturi.461',
    'funcțiunea contului 461',
    'Contul 461 se debitează, între altele, cu valoarea bunurilor constatate lipsă sau deteriorate, imputate terților (758, 4427), și cu despăgubirile și penalitățile datorate de terți (758).',
  ),
  omfp(
    'conturi.428',
    'funcțiunea contului 428',
    'Contul 428 se debitează cu sumele datorate de personal (chirii, avansuri nejustificate, imputații și alte debite) (706, 708, 758, 4427, …) și se creditează cu sumele datorate personalului pentru care nu s-au întocmit state de plată, din activitatea exercițiului care se închide (641).',
  ),
  omfp(
    'conturi.758',
    'funcțiunea contului 758',
    'Contul 758 se creditează cu sumele datorate de personal privind debite (428), cu valoarea bunurilor constatate lipsă sau deteriorate imputate terților (461) și cu despăgubirile, amenzile și penalitățile datorate de terți.',
  ),
  omfp(
    'conturi.475',
    'funcțiunea contului 475',
    'Contul 475 se creditează cu valoarea imobilizărilor primite cu titlu gratuit sau constatate plus la inventar și se debitează cu cota-parte trecută la venituri corespunzător amortizării sau la scoaterea din evidență (758).',
  ),
  omfp(
    'conturi.658(active)',
    'funcțiunea contului 658',
    'Contul 658 se debitează, între altele, cu valoarea neamortizată a imobilizărilor necorporale sau corporale scoase din activ și cu sumele prescrise sau anulate reprezentând creanțe.',
  ),
  // The Codul fiscal's consequences, read in ANAF's consolidated text.
  fiscal(
    'art.26(1)(b),(c),(j),(n)',
    'art. 26 alin. (1) lit. b), c), j) și n)',
    'Sunt deductibile provizioanele pentru garanții de bună execuție (la cotele din convenții), ajustările pentru deprecierea creanțelor neîncasate peste 270 de zile de la scadență, negarantate, de la persoane neafiliate (30%), cele pentru creanțe asupra unei persoane juridice în faliment declarat prin hotărâre (100%), negarantate, de la persoane neafiliate, și ajustările mijloacelor fixe distruse prin calamități sau asigurate.',
  ),
  fiscal(
    'art.26(5)',
    'art. 26 alin. (5)',
    'Reducerea sau anularea unui provizion ori a unei rezerve dedusă anterior se include în rezultatul fiscal, ca venit impozabil.',
  ),
  fiscal(
    'norme.art.304.pct.78(6)',
    'normele metodologice, titlul VII pct. 78 alin. (6) lit. a)',
    'Pentru bunurile lipsă în gestiune din alte cauze decât cele de la art. 304 alin. (2) se ajustează taxa dedusă; sumele imputate pentru bunurile lipsă nu sunt contravaloarea unor operațiuni în sfera TVA.',
  ),
  fiscal(
    'norme.art.305.pct.79(10)-(11)',
    'normele metodologice, titlul VII pct. 79 alin. (10)–(11)',
    'Când un bun de capital își încetează existența ca urmare a unei lipse din gestiune, alta decât pierderea, distrugerea sau furtul dovedite, se ajustează deducerea inițială după art. 305 alin. (4) lit. d); sumele imputate nu sunt în sfera TVA; bunurile distruse, pierdute sau furate, dovedite, nu se ajustează.',
  ),
];
