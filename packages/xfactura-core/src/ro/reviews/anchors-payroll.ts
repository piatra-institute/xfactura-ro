import type { Anchor } from './types';

/** Where the payroll extras' clauses (sources/payroll.ts and the Codul fiscal clauses their review
 * specs cite) start and end in their snapshots' text, each in its own spelling. */
export const payrollAnchors: Readonly<Record<string, readonly Anchor[]>> = {
  'ANAF/Cod-fiscal-consolidat:art.76(1)': [
    {
      from: '(1) Sunt considerate venituri din salarii toate veniturile în bani și/sau în natură',
      to: 'acordate persoanelor care obțin venituri din salarii și asimilate salariilor.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.76(2)(o)': [
    {
      from: 'o) remunerația administratorilor societăților',
      to: 'în consiliul de administrație;',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.77': [
    {
      from: '(1) Persoanele fizice prevăzute la art. 59 alin. (1) lit. a), alin. (2)',
      to: 'numai pentru veniturile din salarii la locul unde se află funcția de bază.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.78(2)(a)': [
    {
      from: '(2) Impozitul lunar prevăzut la alin. (1) se determină astfel:',
      to: '(ii) cotizația sindicală plătită în luna respectivă, potrivit legii;',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.78(2)(b)': [
    {
      from: 'b) pentru veniturile obținute în celelalte cazuri, prin aplicarea cotei de 10%',
      to: 'pe fiecare loc de realizare a acestora.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:norme.art.78.pct.14(9)': [
    {
      from: '(9) În scopul determinării impozitului pe veniturile salariale',
      to: 'de renunțare la funcția de bază la angajatorul ales inițial.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.78(3)': [
    {
      from: '(3) În cazul veniturilor din salarii și/sau al diferențelor de venituri din salarii',
      to: 'până la data de 25 a lunii următoare celei în care au fost plătite.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.146(9^1)': [
    {
      from: '(9) În cazul în care au fost acordate sume reprezentând salarii sau diferențe de salarii',
      to: 'stabilite prin lege, acordate pentru perioade anterioare.',
    },
  ],
  'OPANAF605/2026:anexa6.cap.II.pct.2': [
    {
      from: '2. Rectificarea declaraţiei',
      to: 'inclusiv cele care nu diferă faţă de declaraţia iniţială.',
    },
  ],
  // HG nr. 295/2025 (REGES-ONLINE), as consolidated with OUG nr. 46/2025.
  'HG295/2025-A:art.4(2)': [
    {
      from: '(2) Angajatorii prevăzuți la art. 1 completează și transmit în Registru următoarele date',
      to: 'q) data și temeiul legal al încetării contractului individual de muncă.',
    },
  ],
  'HG295/2025-A:art.5(1)': [
    {
      from: '(1) Pentru persoanele care urmează să desfășoare activitate în baza unui contract individual',
      to: 'în ordinea cronologică a încheierii, modificării, suspendării și încetării contractului individual de muncă.',
    },
    {
      from: '(1) Transmiterea în Registru a datelor prevăzute la art. 4 alin. (2) se face după cum urmează:',
      to: 'încetarea contractului individual de muncă. (2) Orice modificare',
    },
  ],
  'HG295/2025-A:art.5(2)-(4)': [
    {
      from: '(2) Orice modificare a datelor prevăzute la art. 4 alin. (2) lit. b) și c)',
      to: 'la data la care angajatorul a luat cunoștință de acestea.',
    },
  ],
  'HG295/2025-A:art.15': [
    {
      from: 'La 6 luni de la data intrării în vigoare a prezentei hotărâri se abrogă',
      to: 'se prelungesc până la data de 31 decembrie 2025.',
    },
  ],
  // Legea nr. 165/2018 as consolidated on 1 December 2025.
  'L165/2018-A:art.12(2)': [
    {
      from: '(1) Tichetele de masă sunt bilete de valoare acordate angajaților lunar',
      to: 'pentru achitarea mesei sau pentru achiziționarea de produse alimentare.',
    },
    {
      from: '(2) Salariatul poate utiliza lunar un număr de tichete de masă',
      to: 'cel mult egal cu numărul de zile lucrate.',
    },
  ],
  'L165/2018-A:art.14': [
    {
      from: 'Valoarea nominală a unui tichet de masă nu poate depăși suma de 45 lei.',
      to: 'respectiv iulie, august și septembrie 2026.',
    },
  ],
  'L165/2018-A:art.24(3)': [
    {
      from: '(3) Nivelul maxim al sumei care poate fi acordată unui angajat în decursul unui an fiscal',
      to: 'în funcție de opțiunea angajatului privind efectuarea concediului de odihnă.',
    },
  ],
  'L165/2018-A:art.32': [
    {
      from: '(1) Valoarea nominală maximă a biletelor de valoare prevăzute de prezenta lege se indexează',
      to: 'prin ordin comun al ministrului finanțelor publice și al ministrului de resort.',
    },
  ],
  // OUG nr. 158/2005 as consolidated on 1 July 2026.
  'OUG158/2005-A:art.2(1)': [
    {
      from: '(1) Concediile medicale și indemnizațiile de asigurări sociale de sănătate, la care au dreptul asigurații',
      to: 'aprobată cu modificări și completări prin Legea nr. 25/2004, cu modificările și completările ulterioare.',
    },
  ],
  'OUG158/2005-A:art.10(1)': [
    {
      from: '(1) Pentru persoanele prevăzute la art. 1 alin. (1) lit. A și B, baza de calcul al indemnizațiilor',
      to: 'pe baza cărora se calculează contribuția asiguratorie pentru muncă.',
    },
    {
      from: '(8) Din duratele de acordare a concediilor medicale, exprimate în zile calendaristice',
      to: 'se plătesc zilele lucrătoare.',
    },
  ],
  'OUG158/2005-A:art.12': [
    {
      from: 'Indemnizațiile pentru incapacitate temporară de muncă se suportă după cum urmează:',
      to: 'măsura izolării, potrivit Legii nr. 136/2020. (la 03-08-2020, Articolul 12',
    },
  ],
  'OUG158/2005-A:art.17(1)': [
    {
      from: '(1) Cuantumul brut lunar al indemnizației pentru incapacitate temporară de muncă cauzată de boli obișnuite',
      to: 'pentru o perioadă de peste 15 zile de incapacitate temporară de muncă.',
    },
    {
      from: '(1^2) Pentru situațiile în care perioada de incapacitate temporară de muncă',
      to: 'aferentă aceleiași luni.',
    },
  ],
  'OUG158/2005-A:art.17(1^1)': [
    {
      from: '(1^1) Cuantumul brut lunar al indemnizației pentru incapacitate temporară de muncă pentru bolile cardiovasculare',
      to: 'asupra bazei de calcul stabilite conform art. 10.',
    },
  ],
  'OUG158/2005-A:art.17(2)': [
    {
      from: '(2) Cuantumul brut lunar al indemnizației pentru incapacitate temporară de muncă, determinată de tuberculoză',
      to: 'este de 100% din baza de calcul stabilită conform art. 10.',
    },
  ],
  'OUG158/2005-A:art.20(3)': [
    {
      from: '(3) Cuantumul brut lunar al indemnizației pentru carantină sau izolare',
      to: 'potrivit art. 20 alin. (7) din Legea nr. 136/2020.',
    },
  ],
  'OUG158/2005-A:art.22': [
    {
      from: '(1) Indemnizațiile prevăzute la art. 18 lit. a) și b) se suportă integral',
      to: 'nr. 15/2018/1.311/2017, cu modificările și completările ulterioare. (la 01-08-2021, Articolul 22',
    },
  ],
  'OUG158/2005-A:art.25': [
    {
      from: '(1) Asiguratele au dreptul la concedii pentru sarcină și lăuzie',
      to: 'perioadă în care beneficiază de indemnizație de maternitate.',
    },
    {
      from: '(1) Cuantumul brut lunar al indemnizației de maternitate este de 85%',
      to: 'Indemnizația de maternitate se suportă integral din bugetul Fondului național unic de asigurări sociale de sănătate.',
    },
  ],
  'OUG158/2005-A:art.26': [
    {
      from: '(1) Asigurații au dreptul la concediu și indemnizație pentru îngrijirea copilului bolnav',
      to: '(2) Indemnizațiile prevăzute la alin. (1) și (1^1) se suportă integral din bugetul Fondului național unic de asigurări sociale de sănătate.',
    },
  ],
  'OUG158/2005-A:art.30': [
    {
      from: '(1) Cuantumul brut lunar al indemnizațiilor prevăzute la art. 26 alin. (1) și (1^1)',
      to: '(3) Dispozițiile art. 27 se aplică în mod corespunzător.',
    },
  ],
  'OUG158/2005-A:art.30^3': [
    {
      from: '(1) Cuantumul brut lunar al indemnizației pentru îngrijirea pacientului cu afecțiuni oncologice',
      to: 'se suportă integral din bugetul Fondului național unic de asigurări sociale de sănătate. (3) Costurile serviciilor furnizate de psiholog',
    },
  ],
  'OUG158/2005-A:art.31': [
    {
      from: '(2) Pe durata concediului de risc maternal se acordă o indemnizație',
      to: 'reprezintă 75% din baza de calcul stabilită conform prevederilor art. 10.',
    },
  ],
  'OUG158/2005-A:nota.OUG91-2025.art.II': [
    {
      from: '(1) Pentru certificatele de concediu medical eliberate în perioada 1 februarie 2026-31 decembrie 2027',
      to: 'în situația bolnavilor care beneficiază de acordarea serviciilor medicale în regim de spitalizare.',
    },
  ],
  // Legea nr. 346/2002 as consolidated on 11.11.2024.
  'L346/2002-A:art.19': [
    {
      from: '(1) Baza de calcul al indemnizațiilor pentru incapacitate temporară de muncă, pentru reducerea timpului de muncă',
      to: 'se acordă concediul medical sau, după caz, se solicită alte drepturi de asigurări sociale.',
    },
    {
      from: '(6) Indemnizațiile se calculează și se plătesc de către angajatori',
      to: 'după confirmarea caracterului de muncă al accidentului sau declararea bolii profesionale.',
    },
  ],
  'L346/2002-A:art.33': [
    {
      from: '(1) Cuantumul indemnizației pentru incapacitate temporară de muncă reprezintă 80%',
      to: 'indiferent de codul de indemnizație înscris pe certificatul medical. (la 22-07-2018, Articolul 33',
    },
  ],
  'L346/2002-A:art.34': [
    {
      from: 'Indemnizația pentru incapacitate temporară de muncă în cazul accidentului de muncă sau al bolii profesionale se',
      to: 'in bugetul asigurărilor sociale de stat.',
    },
  ],
  // The D112 structure of 07.2026 and ANAF's consolidated Codul fiscal.
  'ANAF/D112-0726:exceptii-OUG91': [
    {
      from: 'exceptii (pentru care nu se va scadea 1zi lucratoare)',
      to: 'se scade o singura zi, chiar daca sunt mai multe certificate de CM',
    },
  ],
  'ANAF/D112-0726:sectiuneaD': [
    {
      from: 'Nomenclator 9 - Cod indemnizatie boala (certificate medicale) (D_9)',
      to: 'Îngrijirea pacientului cu afecțiuni oncologice (L24/2022 si Ordin comun 1166/217//2022)',
    },
    {
      from: 'Daca D_9 = (08.09,91,92,10,15,17) atunci D_20=0',
      to: 'completeaza (D_14>0, D_20>0) si (D_15=0, D_21=0).',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.76(2)(s)': [
    {
      from: 's) orice alte sume sau avantaje în bani ori în natură.',
      to: 's) orice alte sume sau avantaje în bani ori în natură.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.76(3)(h)': [
    {
      from: 'h) bilete de valoare sub forma tichetelor cadou acordate potrivit legii',
      to: 'tichetelor de creșă și tichetelor culturale, acordate potrivit legii.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.142(r)': [
    {
      from: 'r) biletele de valoare sub forma tichetelor de masă, voucherelor de vacanță',
      to: 'tichetelor culturale, acordate potrivit legii;',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:norme.art.141.pct.41': [
    {
      from: '41. (1) În prestațiile suportate din bugetul asigurărilor sociale de stat',
      to: 'privind asigurarea pentru accidente de muncă și boli profesionale, republicată, cu modificările și completările ulterioare.',
    },
  ],
  'ANAF/D112-0726:accidente': [
    {
      from: '5.Total zile lucratoare din concediu medical pentru accidente de munca',
      to: 'de munca cu suma de prestatii suportata de angajator)',
    },
    {
      from: 'Daca asiguratul are concediu medical datorat unui accident de munca confirmat de casa de pensii',
      to: 'Acesta e decontat de casa de pensii.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.62(c)': [
    {
      from: 'c) indemnizațiile pentru: risc maternal, maternitate, creșterea copilului',
      to: 'îngrijirea pacientului cu afecțiuni oncologice, potrivit legii;',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.155(1)(i)': [
    {
      from: 'i) indemnizațiile de asigurări sociale de sănătate, acordate în baza art. 2 alin. (1) lit. a) și b)',
      to: 'pentru codurile de indemnizație 01, 07 și 10',
    },
  ],
  'L134/2010-A:art.729': [
    {
      from: 'Limitele urmăririi veniturilor bănești',
      to: 'sunt nule de drept.',
    },
  ],
  'L53/2003-A:art.169': [
    {
      from: '(1) Nicio reținere din salariu nu poate fi operată',
      to: 'jumătate din salariul net.',
    },
  ],
  'L53/2003-A:art.16(2)': [
    {
      from: '(2) Anterior începerii activității, contractul individual de muncă se înregistrează',
      to: 'cel târziu în ziua anterioară începerii activității.',
    },
  ],
  'L207/2015:art.236': [
    {
      from: 'Sumele ce reprezintă venituri bănești ale debitorului persoană fizică, realizate ca angajat',
      to: 'Codului de procedură civilă, republicat, cu modificările ulterioare.',
    },
  ],
};
