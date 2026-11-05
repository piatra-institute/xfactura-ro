import type { Anchor } from './types';

/*
 * The excerpts of exempt supplies', the pro-rata's and the adjustments' clauses
 * (src/ro/sources/exempt.ts), as `clauseAnchors` reads them: the Fiscal Code in ANAF's
 * consolidated HTML and the portal's 2025 consolidation, the D300 instructions in their PDF as
 * `pdftotext` gives them.
 */
const CODE = 'ANAF/Cod-fiscal-consolidat';

export const exemptAnchors: Readonly<Record<string, readonly Anchor[]>> = {
  [`${CODE}:art.292(1)`]: [
    {
      from: '(1) Următoarele operațiuni de interes general sunt scutite de taxă:',
      to: 'în scopul activităților prevăzute la lit. a), f), i) și j).',
    },
  ],
  [`${CODE}:art.292(2)`]: [
    {
      from: '(2) Următoarele operațiuni sunt, de asemenea, scutite de taxă:',
      to: 'al limitării totale a dreptului de deducere conform art. 298 .',
    },
  ],
  [`${CODE}:art.292(3)`]: [
    {
      from: '(3) Orice persoană impozabilă poate opta pentru taxarea operațiunilor prevăzute la alin. (2) lit. e) și f)',
      to: 'în condițiile stabilite prin normele metodologice.',
    },
  ],
  [`${CODE}:norme.art.292.pct.57-59`]: [
    {
      from: '57. (1) În sensul art. 292 alin. (3) din Codul fiscal',
      to: 'dar a taxat operațiunile și nu depune notificarea în timpul inspecției fiscale.',
    },
  ],
  [`${CODE}:art.294(2)`]: [
    {
      from: '(2) Sunt, de asemenea, scutite de taxă următoarele: a) livrările intracomunitare de bunuri',
      to: 'conform prevederilor art. 312;',
    },
  ],
  [`${CODE}:art.296`]: [
    {
      from: 'Sunt scutite de taxă serviciile prestate de intermediarii',
      to: 'în legătură cu operațiunile desfășurate în afara Uniunii Europene.',
    },
  ],
  [`${CODE}:art.297(4)`]: [
    {
      from: '(4) Orice persoană impozabilă are dreptul să deducă taxa aferentă achizițiilor, dacă',
      to: 'dacă taxa s-ar fi aplicat transferului respectiv.',
    },
  ],
  [`${CODE}:art.300(1)-(7)`]: [
    {
      from: '(1) Persoana impozabilă care realizează sau urmează să realizeze atât operațiuni care dau drept de deducere',
      to: 'în măsura în care acestea sunt accesorii activității principale.',
    },
  ],
  [`${CODE}:art.300(8)-(14)`]: [
    {
      from: '(8) Pro rata definitivă se determină anual',
      to: 'în cazul anulării înregistrării acesteia.',
    },
  ],
  [`${CODE}:art.300(15)`]: [
    {
      from: '(15) În cazul bunurilor de capital, definite conform art. 305 alin. (1), pentru care taxa s-a dedus pe bază de pro rata',
      to: 'aferent ultimei perioade fiscale a anului.',
    },
  ],
  [`${CODE}:art.300(16)-(20)`]: [
    {
      from: '(16) În situații speciale, când pro rata calculată',
      to: 'nu va fi dedusă.',
    },
  ],
  [`${CODE}:art.304`]: [
    {
      from: '(1) În condițiile în care regulile privind livrarea către sine sau prestarea către sine nu se aplică, deducerea inițială se ajustează',
      to: 'situațiilor prevăzute la art. 270 alin. (8) și la art. 271 alin. (5).',
    },
  ],
  [`${CODE}:art.305(4)-(5),(7)`]: [
    {
      from: '(4) Ajustarea taxei deductibile prevăzute la alin. (1) lit. d) se efectuează:',
      to: 'ori de câte ori apar respectivele evenimente.',
    },
  ],
  [`${CODE}:art.306`]: [
    {
      from: '(1) Prin excepție de la prevederile art. 305 alin. (5), se ajustează taxa deductibilă',
      to: 'la momentul la care intervin evenimentele prevăzute la art. 305 alin. (4) care generează ajustarea.',
    },
  ],
  [`${CODE}:art.319(20)(l)`]: [
    {
      from: 'l) În cazul în care este aplicabilă o scutire de taxă, trimiterea la dispozițiile aplicabile',
      to: 'face obiectul unei scutiri;',
    },
  ],
  [`${CODE}:norme.art.300.pct.70`]: [
    {
      from: '70. (1) În aplicarea art. 300 alin. (3) și (4) din Codul fiscal',
      to: 'pe perioada în care persistă situațiile speciale care au necesitat acordarea acestora.',
    },
  ],
  [`${CODE}:norme.art.304.pct.78`]: [
    {
      from: '78. (1) În situația în care intervin situațiile prevăzute la art. 304 alin. (1)',
      to: 'Serviciile de altă natură se consideră utilizate în perioada fiscală în care au fost achiziționate. Ajustarea se efectuează în cazul serviciilor neutilizate numai pentru taxa aferentă valorii rămase neamortizate.',
    },
    {
      from: '(13) Ajustarea se efectuează în funcție de cota de taxă în vigoare la data achiziției bunurilor/serviciilor',
      to: 'la data la care intervine obligația/dreptul de ajustare.',
    },
  ],
  [`${CODE}:norme.art.305.pct.79(1)-(2)`]: [
    {
      from: '79. (1) În perioada de ajustare prevăzută la art. 305 alin. (2) din Codul fiscal',
      to: 'e) ajustările efectuate conform art. 305 alin. (4) din Codul fiscal.',
    },
  ],
  [`${CODE}:norme.art.305.pct.79(4)`]: [
    {
      from: '(4) În sensul art. 305 alin. (9) din Codul fiscal, nu se efectuează ajustarea',
      to: 'este mai mică de 1.000 lei.',
    },
  ],
  [`${CODE}:norme.art.306.pct.80`]: [
    {
      from: '80. (1) Potrivit prevederilor art. 306 din Codul fiscal',
      to: 'în vigoare la data achiziției activului corporal fix.',
    },
  ],
  'LJR/Cod-fiscal-2025:art.305(9)': [
    {
      from: '(la 01-07-2024, Alineatul (9) , Articolul 305 , Capitolul X , Titlul VII a fost abrogat',
      to: 'publicată în MONITORUL OFICIAL nr. 596 din 26 iunie 2024 )',
    },
  ],
  'OPANAF174/2026:pro_rata': [
    {
      from: 'În rubrica "Pro rata de deducere %" se înscrie pro rata',
      to: 'potrivit art. 300 din Codul fiscal.',
    },
  ],
  'OPANAF174/2026:rd.1': [
    {
      from: 'Rândul 1 - se înscriu informaţiile preluate din jurnalul de vânzări',
      to: 'conform art. 282 alin. (9) din Codul fiscal.',
    },
  ],
  'OPANAF174/2026:rd.14-15': [
    {
      from: 'Rândul 14 - se înscriu informaţiile preluate din jurnalul de vânzări',
      to: 'prevăzute la art. 292 din Codul fiscal sau potrivit altor dispoziţii legale.',
    },
  ],
  'OPANAF174/2026:rd.29': [
    {
      from: 'Rândul 29 - se înscriu informaţiile din jurnalul de cumpărări',
      to: 'care nu sunt incluse în baza impozabilă.',
    },
  ],
  'OPANAF174/2026:rd.31': [
    {
      from: 'Rândul 31 - se înscriu taxa pe valoarea adăugată efectiv dedusă',
      to: 'cu excepţia celor de la rândurile 20.1, 22.1, 26.1 şi 26.2.',
    },
  ],
  // The D394 order and its instructions, consolidated to 17.09.2025.
  'OPANAF3769/2015-A:art.1': [
    {
      from: 'Persoanele impozabile înregistrate în scopuri de TVA în România sunt obligate',
      to: 'modificările și completările ulterioare.',
    },
  ],
  'OPANAF3769/2015-A:art.8': [
    {
      from: 'Declarația menționată la art. 2 se depune la organul fiscal competent',
      to: '29 februarie, după caz.',
    },
    {
      from: '2. Declarația se depune la organul fiscal competent până în data de 30',
      to: 'până la data de 28, respectiv 29 februarie.',
    },
  ],
  'OPANAF3769/2015-A:anexa3.pct.1': [
    {
      from: '1. Declarația se depune până în data de 25 inclusiv',
      to: 'la organul fiscal competent.',
    },
  ],
  'OPANAF3769/2015-A:anexa2.pct.1': [
    {
      from: '1. Declarația se completează și se depune de către:',
      to: 'dacă au înscris codul de înregistrare în scopuri de TVA al beneficiarului.',
    },
  ],
  'OPANAF3769/2015-A:anexa2.sect1.litD': [
    {
      from: 'D. Rezumatul declarației privind operațiuni desfășurate cu persoane neînregistrate',
      to: 'efectuate de la persoane neînregistrate în scopuri de TVA.',
    },
    {
      from: 'de la lit. D - se înscrie natura bunurilor/serviciilor achiziționate',
      to: 'de la persoane neînregistrate în scopuri de TVA.',
    },
  ],
  'OPANAF3769/2015-A:anexa2.sect1.litE-F': [
    {
      from: 'E. Rezumatul declarației privind operațiunile desfășurate cu persoane impozabile nestabilite',
      to: '(formular 390).',
    },
    {
      from: 'F. Rezumat declarație privind operațiunile desfășurate cu persoane impozabile neînregistrate',
      to: '(formular 390).',
    },
  ],
  'OPANAF3769/2015-A:anexa2.sect2.liste': [
    {
      from: 'Listele operațiunilor taxabile efectuate pe teritoriul național cuprind',
      to: 'exceptate de la obligația utilizării aparatelor de marcat electronice fiscale.',
    },
  ],
  'OPANAF3769/2015-A:anexa2.sect2.pct.2': [
    {
      from: 'se înscrie tipul operațiunii efectuate, și anume:',
      to: 'în fiecare lună din perioada de raportare.',
    },
  ],
  'OPANAF3769/2015-A:anexa2.sect2.pct.3': [
    {
      from: '- se înscriu, după caz:– CIF cod de identificare fiscală',
      to: 'nestabilită pe teritoriul Uniunii Europene.',
    },
  ],
  'OPANAF3769/2015-A:anexa2.sect2.pct.5': [
    {
      from: 'se înscrie numărul total al facturilor emise/primite/numărul total al borderourilor',
      to: 'valoarea 0 pentru restul operațiunilor.',
    },
  ],
};
