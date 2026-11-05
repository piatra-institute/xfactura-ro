import type { Clause, LegalSource } from './index';

/*
 * The sources of the special VAT schemes (V4): the margin scheme of travel agencies (Codul fiscal
 * art. 311, the norms' pct. 85), the margin schemes of second-hand goods, works of art,
 * collectors' items and antiques (art. 312, the norms' pct. 86), the agricultural flat rate (art.
 * 315^1, the norms' pct. 87^1), the invoice's mentions (art. 319 alin. (20) lit. k), n), o)) and
 * self-billing (art. 319 alin. (18), the norms' pct. 96); where the returns report them: the D300
 * rows 9, 27–29 and 31 (OPANAF nr. 174/2026) and the D394 operations LS and AS with the margins'
 * information fields (ANAF's structure of 15.09.2025). Every clause was read on 5 November 2026 in
 * snapshots already registered: ANAF's consolidated Fiscal Code (sha256 aba0c753…, updated to
 * Legea nr. 204/2026), OPANAF nr. 174/2026 and the D394 structure. The list of agricultural inputs
 * and services the norms' pct. 87^1 and the reduced rate (art. 291 alin. (2) lit. h)) refer to is
 * Ordinul nr. 1.155/868/2016, downloaded by the owner and kept in .sources/OMFP1155_2016/.
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
const AGRICULTURE = 'OMFP1155/2016';

export const schemeSources: readonly LegalSource[] = [
  {
    id: AGRICULTURE,
    kind: 'act',
    title:
      'Ordinul ministrului finanțelor publice și al ministrului agriculturii și dezvoltării rurale nr. 1.155/868/2016 privind aplicarea cotei reduse de TVA de 9% pentru livrarea de îngrășăminte și de pesticide utilizate în agricultură, semințe și alte produse agricole destinate însămânțării sau plantării, precum și pentru prestările de servicii de tipul celor specifice utilizate în sectorul agricol (textul publicat în Monitorul Oficial, fără modificări consolidate; aplicabil de la 1 august 2016)',
    issuer: 'Ministerul Finanțelor Publice și Ministerul Agriculturii și Dezvoltării Rurale',
    publication: 'Monitorul Oficial nr. 572 din 28 iulie 2016',
    urls: [],
    fetch: false,
    snapshots: [
      {
        url: 'https://xfactura.invalid/owner-download/OMFP_1155_2016.pdf',
        sha256: '64414a654583ae168d52cf94c224b67213e9d09bbfaafc1bb76d937aabbb6d27',
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

export const schemeClauses: readonly Clause[] = [
  // Travel agencies (art. 311).
  cf(
    'art.311(1)-(3)',
    'art. 311 alin. (1)–(3)',
    'Agenția de turism (touroperatorii incluși) care acționează în nume propriu în beneficiul direct al călătorului și folosește livrări și prestări ale altor persoane face, pentru toate operațiunile legate de călătorie, un serviciu unic, cu locul în România dacă agenția este stabilită aici și îl prestează prin sediul din România.',
  ),
  cf(
    'art.311(4)-(6)',
    'art. 311 alin. (4)–(6)',
    'Baza de impozitare a serviciului unic este marja de profit, exclusiv taxa: suma totală plătită de călător, fără taxă, minus costurile agenției, inclusiv taxa, ale livrărilor și prestărilor altor persoane impozabile în beneficiul direct al călătorului; partea realizată în afara Uniunii este scutită (serviciu de intermediar); agenția nu deduce taxa facturată pentru aceste livrări și prestări.',
  ),
  cf(
    'art.311(7)-(12)',
    'art. 311 alin. (7)–(12)',
    'Agenția ține evidențele necesare stabilirii taxei, nu înscrie taxa distinct în facturile către călător, nu aplică regimul ca intermediar (art. 286 alin. (4) lit. e)), poate opta pentru regimul normal, obligatoriu special când călătorul este persoană fizică sau serviciul are componente cu locul în afara României; în regim normal facturează fiecare componentă la cota ei, marja inclusă; operațiunile celor două regimuri se țin în evidențe separate.',
  ),
  cf(
    'norme.art.311.pct.85',
    'normele metodologice, titlul VII pct. 85',
    'Călătorul poate fi orice persoană; regimul nu se aplică serviciilor prestate cu mijloace proprii; suma plătită de călător și costurile (prețul cu TVA al transportului, cazării, mesei și celorlalte cheltuieli directe, fără cheltuielile generale ale agenției) se definesc pentru alin. (4); taxa colectată a unei perioade fiscale se calculează din jurnalele separate de vânzări și cumpărări, fără avansurile ale căror costuri nu se cunosc și fără costurile serviciilor nevândute, prin procedeul sutei mărite la cota standard aplicat diferenței; cine refacturează un serviciu cumpărat în regim special aplică la rândul lui regimul.',
  ),
  // Second-hand goods, works of art, collectors' items and antiques (art. 312).
  cf(
    'art.312(1)',
    'art. 312 alin. (1) lit. e)–h)',
    'Persoana impozabilă revânzătoare cumpără sau importă bunuri second-hand, opere de artă, obiecte de colecție sau antichități pentru revânzare; marja profitului este diferența dintre prețul de vânzare obținut de la cumpărător (cu taxele, comisioanele, ambalarea, transportul și asigurarea percepute, fără reduceri) și prețul de cumpărare; regimul special taxează aceste livrări la marja profitului.',
  ),
  cf(
    'art.312(2)-(4)',
    'art. 312 alin. (2)–(4)',
    'Revânzătorul aplică regimul special pentru bunurile cumpărate în Uniune de la o persoană neimpozabilă, de la o persoană impozabilă cu livrarea scutită după art. 292 alin. (2) lit. g), de la o întreprindere mică pentru bunuri de capital sau de la alt revânzător care a aplicat regimul special; poate opta pentru operele de artă, obiectele de colecție și antichitățile importate și pentru operele de artă cumpărate de la autori sau de la alte persoane impozabile; baza de impozitare este marja profitului, exclusiv taxa.',
  ),
  cf(
    'art.312(5)-(12)',
    'art. 312 alin. (5)–(12)',
    'Livrările în regim special sunt scutite în condițiile exportului; revânzătorul nu deduce taxa bunurilor livrate în regim special, poate aplica regimul normal oricărei livrări eligibile (cu deducerea taxei la import și a operelor de la autori, la exigibilitatea livrării), cumpărătorul nu deduce taxa livrărilor în regim special, regimul nu se aplică bunurilor scutite sau rambursate la achiziție, iar revânzătorul nu înscrie taxa distinct în facturile emise clienților.',
  ),
  cf(
    'art.312(13)-(15)',
    'art. 312 alin. (13)–(15)',
    'Revânzătorul stabilește taxa colectată în regim special pentru fiecare perioadă fiscală a decontului, ține evidența operațiunilor în regim special, separată de cea a regimului normal, iar regulile se aplică și organizatorilor de vânzări prin licitație publică.',
  ),
  cf(
    'norme.art.312.pct.86',
    'normele metodologice, titlul VII pct. 86',
    'Bunurile second-hand sunt obiectele vechi reutilizabile, fără metalele și pietrele prețioase, aurul de investiții și bunurile consumabile; opțiunea de la alin. (3) privește toate categoriile, se notifică și ține până la 31 decembrie al celui de-al doilea an; baza fiecărei livrări este marja minus taxa ei, calculată prin procedeul sutei mărite pe fiecare livrare, iar taxa perioadei este suma lor; marja negativă nu dă taxă colectată; revânzătorul ține jurnale speciale de cumpărări și vânzări și un registru al bazei pe cote și emite autofactură furnizorului care nu e obligat să emită factură (numărul și data, data achiziției, părțile, codul de TVA al revânzătorului, bunurile și prețul).',
  ),
  // The agricultural flat rate (art. 315^1).
  cf(
    'art.315^1(1)-(4)',
    'art. 315^1 alin. (1)–(4)',
    'Agricultorul este persoana fizică, PFA, II sau IF cu sediul în România care face producție agricolă sau servicii agricole și nu are alte activități sau are altele sub plafonul art. 310; procentul de compensare în cotă forfetară este 1% pentru 2017, 4% pentru 2018 și 8% din 2019, aplicat prețului fără taxă al produselor și serviciilor agricole livrate altor persoane impozabile; agricultorul nu colectează TVA, nu deduce și nu aplică pentru ele art. 310.',
  ),
  cf(
    'art.315^1(5)-(8)',
    'art. 315^1 alin. (5)–(8)',
    'Agricultorul notifică organul fiscal, care îl înscrie în Registrul agricultorilor care aplică regimul special până la data de 1 a lunii următoare; cumpărătorul ține o evidență separată a achizițiilor de la ei; agricultorul nu ține evidențe de TVA și nu depune decont și emite factură cu informațiile art. 319 alin. (20), mențiunea regimului special pentru agricultori, procentul și compensația cuvenită.',
  ),
  cf(
    'art.315^1(9)-(16)',
    'art. 315^1 alin. (9)–(16)',
    'Achizițiile intracomunitare ale agricultorului sub 10.000 euro nu sunt impozabile; operațiunile intracomunitare cer codul art. 317, decontul special și declarația recapitulativă; cel cu alte activități poate aplica art. 310 pentru ele, dar înregistrarea după art. 316 (prin opțiune sau la depășirea plafonului) încheie regimul; agricultorul poate opta oricând pentru regimul normal și nu revine timp de doi ani.',
  ),
  cf(
    'art.315^1(17)-(18)',
    'art. 315^1 alin. (17)–(18)',
    'Persoanele înregistrate în scopuri de TVA cărora agricultorul le livrează produse agricole sau le prestează servicii agricole deduc compensația în cotă forfetară achitată, în aceleași limite și condiții ca TVA (art. 297–301); cele nestabilite și neînregistrate o recuperează prin restituire.',
  ),
  cf(
    'norme.art.315^1.pct.87^1',
    'normele metodologice, titlul VII pct. 87^1',
    'Producția agricolă cuprinde cultura plantelor, creșterea animalelor, silvicultura și pescuitul, cu transformarea lor prin mijloace neindustriale; serviciile agricole sunt cele din anexa Ordinului nr. 1.155/868/2016; prețul la care se aplică procentul nu cuprinde taxa nedeductibilă a achizițiilor; regimul se aplică și fără notificare, dar compensația se înscrie în facturi numai după înscrierea în Registru; plafonul de 10.000 euro este 34.000 lei; cumpărătorul deduce compensația numai dacă agricultorul este înscris în Registru la data livrării sau prestării.',
  ),
  // The agricultural inputs and services at the reduced rate: art. 291 alin. (2) lit. e) and f), as
  // Legea nr. 141/2025 left them, and the joint order of 2016 that lists them (issued for the former
  // lit. h), at 9%), which the norms' pct. 87^1 alin. (3) also cite for the flat rate's services.
  cf(
    'art.291(2)(e)-(f)',
    'art. 291 alin. (2) lit. e) și f), alin. (3^3)',
    'Cota redusă de 11% se aplică livrării de îngrășăminte și pesticide de tipul celor utilizate în mod normal în producția agricolă (altele decât cele chimice), semințelor și altor produse agricole destinate însămânțării sau plantării, prestărilor de servicii de tipul celor utilizate în mod normal în producția agricolă (lit. e)) și livrării de îngrășăminte chimice și pesticide chimice de acest tip (lit. f), până la 31 decembrie 2031), toate „prevăzute prin ordin comun al ministrului finanțelor și al ministrului agriculturii și dezvoltării rurale”.',
  ),
  {
    id: `${AGRICULTURE}:art.1(1)-(2)`,
    source: AGRICULTURE,
    locator: 'art. 1 alin. (1)–(2) și art. 3',
    status: 'located',
    summary:
      'Bunurile la cota redusă (atunci 9%, după art. 291 alin. (2) lit. h)), de la 1 august 2016, după codul NC (art. 266 alin. (1) pct. 9): îngrășămintele NC 3101 00 00 – 3105 90 80; pesticidele NC 3808 91, 3808 92, 3808 93, 3808 99 10; semințele și alte produse agricole destinate însămânțării sau plantării, NC 0601, 0602, 0701 10 00, 0703 10 11, 0712 90 11, 0713 10 10, 0713 33 10, 1001 11 00, 1001 91, 1002 10 00, 1003 10 00, 1004 10 00, 1005 10, 1006 10 10, 1007 10, 1008 21 00, 1201 10 00, 1202 30 00, 1204 00 10, 1205 10 10, 1206 00 10, 1207 21 00, 1207 40 10, 1207 50 10, 1207 91 10, 1207 99 20, 1209.',
  },
  {
    id: `${AGRICULTURE}:anexa`,
    source: AGRICULTURE,
    locator: 'art. 1 alin. (3) și anexa',
    status: 'located',
    summary:
      'Prestările de servicii specifice sectorului agricol la cota redusă sunt cele 34 din anexă: fertilizat; arat; discuit sau grăpat; pregătit pat germinativ; semănat sau plantat; tăvălugit; stropit, prăfuit, erbicidat; tratarea semințelor; recoltat sau dislocat culturi; colectarea și balotarea materialului vegetal; tocat resturi vegetale; prășit; rigole la legume; nivelatul terenului agricol; plantatul în biloane; răritul și decoletarea sfeclei; înșirat, balotat, păpușit tutun; cosit; greblat; însilozarea și depozitarea furajelor în ferme zootehnice; scarificare; desfundat terenul; săpat gropi pentru pomi; tocat coarde și crengi; colectare, sortare, condiționare, etichetare la legume și fructe; montarea serelor și solarelor; curățarea pășunilor și fânețelor; supraînsămânțări, surse de apă și parcelarea pajiștilor; evacuarea dejecțiilor și asigurarea furajelor în ferme; dezinfecția, dezinsecția și deratizarea fermelor; tunsul oilor; sortarea, marcarea și ambalarea ouălor; curățatul copitelor; decolmatarea canalelor de irigații sau desecare.',
  },
  // Invoicing.
  cf(
    'art.319(20)(k),(n),(o)',
    'art. 319 alin. (20) lit. k), n) și o)',
    'Factura emisă de beneficiar în numele furnizorului poartă mențiunea „autofactură”; în regimul agențiilor de turism, mențiunea „regimul marjei - agenții de turism”; în regimurile bunurilor second-hand, operelor de artă, obiectelor de colecție și antichităților, una dintre mențiunile „regimul marjei - bunuri second-hand”, „regimul marjei - opere de artă” sau „regimul marjei - obiecte de colecție și antichități”.',
  ),
  cf(
    'art.319(18)',
    'art. 319 alin. (18) și normele metodologice, titlul VII pct. 96 alin. (1)',
    'Cumpărătorul poate emite factura în numele și în contul furnizorului (autofacturare) dacă părțile au încheiat un acord prealabil, există o procedură de acceptare a fiecărei facturi, factura se trimite furnizorului și are elementele art. 319 alin. (20) sau (21).',
  ),
  // Where the returns report them.
  {
    id: 'OPANAF174/2026:rd.9.special',
    source: 'OPANAF174/2026',
    locator: 'anexa nr. 2, instrucțiunile rândului 9, a doua liniuță',
    status: 'located',
    summary:
      'La rândul 9 (cota 21%) se înscriu și baza de impozitare și taxa colectată pentru operațiunile supuse regimurilor speciale de TVA, determinate pe baza situațiilor de calcul întocmite în acest scop.',
  },
  {
    id: 'OPANAF174/2026:rd.27-28',
    source: 'OPANAF174/2026',
    locator: 'anexa nr. 2, instrucțiunile rândurilor 27, 28 și 31',
    status: 'located',
    summary:
      'La rândul 27 se înscrie compensația în cotă forfetară achitată pentru achizițiile de produse și servicii agricole de la furnizorii în regim special, în limitele și condițiile deducerii TVA (art. 297–301); la rândul 28 corecțiile ei; rândul 31 cuprinde compensația dedusă potrivit art. 315^1 alin. (17).',
  },
  {
    id: 'ANAF/D394:op1.LS-AS',
    source: 'ANAF/D394',
    locator:
      'secțiunile op1 (tip LS, AS, ASI; cota 0, fără TVA) și rezumat1 (facturiLS, bazaLS, facturiAS, bazaAS)',
    status: 'located',
    summary:
      'Livrările în regim special ale agențiilor de turism și ale bunurilor second-hand, operelor de artă, obiectelor de colecție și antichităților (LS) și achizițiile de la persoane care aplică aceste regimuri (AS, ASI sub TVA la încasare) se declară pe partener, la cota 0, fără TVA; rezumatul le însumează pe tip de partener.',
  },
  {
    id: 'ANAF/D394:informatii.marja',
    source: 'ANAF/D394',
    locator:
      'secțiunea informatii, câmpurile incasari_ag, costuri_ag, marja_ag, tva_ag, pret_vanzare, pret_cumparare, marja_antic, tva_antic (nr. 147–154)',
    status: 'located',
    summary:
      'Agențiile de turism declară valoarea încasărilor, a costurilor, marja de profit și TVA regimului special; revânzătorii de bunuri second-hand, opere de artă, obiecte de colecție și antichități declară prețul de vânzare, prețul de cumpărare, marja de profit și TVA regimului special.',
  },
  // The D394 instructions as consolidated to 17.09.2025 (OPANAF nr. 3.769/2015 anexa nr. 2).
  {
    id: 'OPANAF3769/2015-A:anexa2.regim-special',
    source: 'OPANAF3769/2015-A',
    locator: 'anexa nr. 2 secțiunea 1 lit. C pct. 12–13 și secțiunea a 2-a (regimurile speciale)',
    status: 'located',
    summary:
      'Pentru regimurile speciale ale agențiilor de turism și ale bunurilor second-hand, operelor de artă, obiectelor de colecție și antichităților se declară valorile totale înscrise în facturile emise sau primite, inclusiv marja de profit și TVA aferentă; achizițiile de la persoanele care aplică aceste regimuri se numără și se însumează separat.',
  },
  {
    id: 'OPANAF3769/2015-A:anexa2.sect1.litI.pct.6',
    source: 'OPANAF3769/2015-A',
    locator: 'anexa nr. 2 secțiunea 1 lit. I pct. 6',
    status: 'located',
    summary:
      'TVA colectată aferentă marjei de profit a perioadei: agenția de turism înscrie baza serviciului unic, marja de profit exclusiv taxa (suma plătită de călător, fără taxă, minus costurile cu taxă), și TVA; revânzătorul de bunuri second-hand, opere de artă, obiecte de colecție și antichități înscrie marja ca diferență între prețul de vânzare și prețul de cumpărare, și TVA.',
  },
];
